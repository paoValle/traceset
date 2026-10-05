//! Comparing a run against its baseline.
//!
//! Every finding is one of three severities, and the distinction is the point:
//!
//! - **regression** — the agent got worse, or more expensive past the threshold;
//! - **improvement** — cheaper or fewer steps while behaving the same;
//! - **note** — something changed that is neither: a different model, a new tool, a trace
//!   with no baseline yet.
//!
//! The headline case this file exists for: a change that makes the run **cheaper and
//! worse**. A gate that only looks at money passes it. Here it fails, because behaviour is
//! compared separately and cannot be averaged away by a lower bill.

import { firstDivergence, type Summary } from './trace.js';

/** How much change is tolerated before it counts. */
export interface Thresholds {
  /** Relative cost increase tolerated, `0.2` = +20%. */
  readonly maxCostDelta: number;
  /** Relative token increase tolerated. */
  readonly maxTokenDelta: number;
  /** Extra steps tolerated. */
  readonly maxStepDelta: number;
}

/** The default thresholds: 20% more money or tokens, zero extra steps. */
export const DEFAULT_THRESHOLDS: Thresholds = {
  maxCostDelta: 0.2,
  maxTokenDelta: 0.5,
  maxStepDelta: 0,
};

/** What kind of finding this is, for the machine-readable output. */
export type FindingKind =
  | 'cost_increase'
  | 'token_increase'
  | 'step_increase'
  | 'stop_reason_changed'
  | 'behaviour_changed'
  | 'answer_lost'
  | 'budget_exhausted'
  | 'tools_added'
  | 'tools_removed'
  | 'model_changed'
  | 'no_baseline';

/** A single thing the comparison noticed. */
export interface Finding {
  readonly trace: string;
  readonly kind: FindingKind;
  readonly severity: 'regression' | 'improvement' | 'note';
  readonly message: string;
}

/** A baseline file: run id to summary. */
export interface Baseline {
  readonly version: 1;
  readonly entries: Record<string, Summary>;
}

/** Builds a baseline out of summaries. */
export function baselineOf(summaries: readonly Summary[]): Baseline {
  const entries: Record<string, Summary> = {};
  for (const summary of summaries) entries[summary.runId] = summary;
  return { version: 1, entries };
}

/** Parses a baseline file, refusing anything that is not one. */
export function parseBaseline(text: string, source: string): Baseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: not valid JSON: ${String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${source}: not a baseline object`);
  const record = parsed as Record<string, unknown>;
  const version = record['version'];
  const entries = record['entries'];
  if (version !== 1 || typeof entries !== 'object' || entries === null) {
    throw new Error(`${source}: not a version 1 baseline (expected { version: 1, entries: {...} })`);
  }
  return { version: 1, entries: entries as Record<string, Summary> };
}

function percent(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

/** Compares one run against its baseline. Returns an empty list when nothing moved. */
export function compare(baseline: Summary, current: Summary, thresholds: Thresholds = DEFAULT_THRESHOLDS): Finding[] {
  const findings: Finding[] = [];
  const at = (kind: FindingKind, severity: Finding['severity'], message: string): void => {
    findings.push({ trace: current.runId, kind, severity, message });
  };

  // --- behaviour first: it is the reason the tool exists, and it never averages out ---
  const divergence = firstDivergence(baseline.decisions, current.decisions);
  if (divergence >= 0) {
    const before = baseline.decisions[divergence];
    const after = current.decisions[divergence];
    const describe = (decision: typeof before): string =>
      decision === undefined ? '(no decision)' : `${decision.kind}${decision.kind === 'message' ? '' : `:${decision.detail}`}`;
    at(
      'behaviour_changed',
      'regression',
      `behaviour changed at step ${divergence}: ${describe(before)} → ${describe(after)}`,
    );
  }
  if (baseline.stopReason !== current.stopReason) {
    const better = current.stopReason === 'end_turn';
    at(
      'stop_reason_changed',
      better ? 'improvement' : 'regression',
      `stop reason ${baseline.stopReason} → ${current.stopReason}`,
    );
  }
  if (baseline.answered && !current.answered) {
    at('answer_lost', 'regression', 'the baseline ended with an answer, this run did not');
  }
  if (current.stopReason === 'budget') {
    at('budget_exhausted', 'regression', 'the run was stopped by the spending cap');
  }

  // --- price ---
  const costDelta = baseline.spentMicroUsd === 0 ? 0 : (current.spentMicroUsd - baseline.spentMicroUsd) / baseline.spentMicroUsd;
  if (costDelta > thresholds.maxCostDelta) {
    at('cost_increase', 'regression', `cost ${percent(costDelta)} (${current.spentMicroUsd} µUSD vs ${baseline.spentMicroUsd})`);
  } else if (costDelta < 0) {
    at('cost_increase', 'improvement', `cost ${percent(costDelta)} (${current.spentMicroUsd} µUSD vs ${baseline.spentMicroUsd})`);
  }
  const baselineTokens = baseline.inputTokens + baseline.outputTokens;
  const currentTokens = current.inputTokens + current.outputTokens;
  const tokenDelta = baselineTokens === 0 ? 0 : (currentTokens - baselineTokens) / baselineTokens;
  if (tokenDelta > thresholds.maxTokenDelta) {
    at('token_increase', 'regression', `tokens ${percent(tokenDelta)} (${currentTokens} vs ${baselineTokens})`);
  }
  if (current.steps > baseline.steps + thresholds.maxStepDelta) {
    at('step_increase', 'regression', `steps ${baseline.steps} → ${current.steps}`);
  }

  // --- notes: changed, but not a verdict on its own ---
  const added = current.tools.filter((tool) => !baseline.tools.includes(tool));
  const removed = baseline.tools.filter((tool) => !current.tools.includes(tool));
  if (added.length > 0) at('tools_added', 'note', `tools used that the baseline did not: ${added.join(', ')}`);
  if (removed.length > 0) at('tools_removed', 'note', `tools no longer used: ${removed.join(', ')}`);
  if (baseline.models.join() !== current.models.join()) {
    at('model_changed', 'note', `models ${baseline.models.join(', ') || '(none)'} → ${current.models.join(', ') || '(none)'}`);
  }

  return findings;
}

/** Compares a set of summaries against a baseline. A run with no baseline entry is a note. */
export function compareAll(
  baseline: Baseline,
  summaries: readonly Summary[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Finding[] {
  const findings: Finding[] = [];
  for (const summary of summaries) {
    const entry = baseline.entries[summary.runId];
    if (entry === undefined) {
      findings.push({
        trace: summary.runId,
        kind: 'no_baseline',
        severity: 'note',
        message: 'no baseline for this run: it cannot be compared',
      });
      continue;
    }
    findings.push(...compare(entry, summary, thresholds));
  }
  return findings;
}

/** True if any finding is a regression: the single thing the exit code depends on. */
export function hasRegressions(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.severity === 'regression');
}

const MARK: Record<Finding['severity'], string> = {
  regression: 'REGRESSION',
  improvement: 'improvement',
  note: 'note',
};

/** Human-readable report: one line per finding, grouped by trace, regressions first. */
export function render(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'no change: every run matches its baseline';
  const order: Finding['severity'][] = ['regression', 'improvement', 'note'];
  const lines: string[] = [];
  for (const severity of order) {
    for (const finding of findings.filter((f) => f.severity === severity)) {
      lines.push(`  ${finding.trace.padEnd(20)} ${finding.message.padEnd(72)} ${MARK[severity]}`);
    }
  }
  const regressions = findings.filter((f) => f.severity === 'regression').length;
  const improvements = findings.filter((f) => f.severity === 'improvement').length;
  lines.push(
    `${regressions} regression${regressions === 1 ? '' : 's'}, ${improvements} improvement${improvements === 1 ? '' : 's'}, ` +
      `${findings.length - regressions - improvements} note${findings.length - regressions - improvements === 1 ? '' : 's'}`,
  );
  return lines.join('\n');
}
