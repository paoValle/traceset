//! `traceset` — three commands, one job: a change to an agent should be judged on
//! behaviour and price separately, and it should fail CI when it is worse.
//!
//! Everything here returns lines and an exit code instead of printing: a tool whose
//! decisions are testable without spawning a process is a tool whose exit codes are
//! actually tested.
//!
//! ```text
//! traceset summary  <traces...>                        what each run did
//! traceset baseline <traces...> [-o file]              freeze them as the baseline
//! traceset check    <traces...> [-b file] [thresholds] fail if a run regressed
//! ```
//!
//! Exit codes: `0` fine, `1` a regression, `2` usage or input error.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  DEFAULT_THRESHOLDS,
  baselineOf,
  compareAll,
  hasRegressions,
  parseBaseline,
  render,
  type Baseline,
  type Finding,
  type Thresholds,
} from './diff.js';
import { parseTrace, summarize, TraceFormatError, type Summary } from './trace.js';

/** What a command produced: what to print, and what to exit with. */
export interface Outcome {
  readonly code: number;
  readonly lines: readonly string[];
}

const USAGE = [
  'traceset — agent traces as regression tests',
  '',
  '  traceset summary  <trace.jsonl...> [--json]',
  '  traceset baseline <trace.jsonl...> [--out traceset.baseline.json]',
  '  traceset check    <trace.jsonl...> [--baseline traceset.baseline.json] [--json]',
  '                    [--max-cost-delta 0.2] [--max-token-delta 0.5] [--max-step-delta 0]',
  '                    [--require-baseline]',
  '',
  'Behaviour is compared separately from price: a run that is cheaper and worse fails.',
].join('\n');

/** Reads and reduces traces. Throws `TraceFormatError` with the offending line. */
export function readSummaries(files: readonly string[]): Summary[] {
  return files.map((file) => summarize(parseTrace(file, readFileSync(file, 'utf8')), file));
}

function thresholdsFrom(values: Record<string, unknown>): Thresholds {
  const number = (key: keyof Thresholds, raw: unknown): number => {
    if (raw === undefined) return DEFAULT_THRESHOLDS[key];
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${key}: expected a non-negative number, got ${JSON.stringify(raw)}`);
    return parsed;
  };
  return {
    maxCostDelta: number('maxCostDelta', values['max-cost-delta']),
    maxTokenDelta: number('maxTokenDelta', values['max-token-delta']),
    maxStepDelta: number('maxStepDelta', values['max-step-delta']),
  };
}

function summaryTable(summaries: readonly Summary[]): string[] {
  const header = ['run', 'steps', 'stop', 'µUSD', 'tokens', 'tools', 'behaviour', 'source'];
  const rows = summaries.map((summary) => [
    summary.runId,
    String(summary.steps),
    summary.stopReason,
    String(summary.spentMicroUsd),
    String(summary.inputTokens + summary.outputTokens),
    summary.tools.join(',') || '-',
    summary.fingerprint,
    summary.source,
  ]);
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index]?.length ?? 0)));
  const line = (row: readonly string[]): string => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();
  return [line(header), ...rows.map((row) => line(row))];
}

function jsonOf(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Runs one command. Pure except for reading the traces and the baseline: no printing, so a
 * test can assert the exit code of a regression without spawning a process.
 */
export function run(argv: readonly string[]): Outcome {
  interface Parsed {
    values: Record<string, unknown>;
    positionals: string[];
  }
  let parsed: Parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        baseline: { type: 'string', short: 'b' },
        out: { type: 'string', short: 'o' },
        'max-cost-delta': { type: 'string' },
        'max-token-delta': { type: 'string' },
        'max-step-delta': { type: 'string' },
        json: { type: 'boolean' },
        'require-baseline': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    return { code: 2, lines: [`traceset: ${String(error)}`, '', USAGE] };
  }

  const values = parsed.values;
  const command = parsed.positionals[0];
  const files = parsed.positionals.slice(1);

  if (values['help'] === true || command === undefined) return { code: command === undefined ? 2 : 0, lines: [USAGE] };
  if (!['summary', 'baseline', 'check'].includes(command)) {
    return { code: 2, lines: [`traceset: unknown command "${command}"`, '', USAGE] };
  }
  if (files.length === 0) return { code: 2, lines: [`traceset ${command}: at least one trace file is required`, '', USAGE] };

  let summaries: Summary[];
  try {
    summaries = readSummaries(files);
  } catch (error) {
    if (error instanceof TraceFormatError) return { code: 2, lines: [`traceset: ${error.message}`] };
    return { code: 2, lines: [`traceset: ${String(error)}`] };
  }

  if (command === 'summary') {
    return values['json'] === true
      ? { code: 0, lines: [jsonOf(summaries)] }
      : { code: 0, lines: summaryTable(summaries) };
  }

  if (command === 'baseline') {
    const out = typeof values['out'] === 'string' ? values['out'] : 'traceset.baseline.json';
    const baseline = baselineOf(summaries);
    writeFileSync(out, `${jsonOf(baseline)}\n`);
    return { code: 0, lines: [`wrote ${out}: ${summaries.length} run(s) — ${summaries.map((s) => s.runId).join(', ')}`] };
  }

  // --- check ---
  const path = typeof values['baseline'] === 'string' ? values['baseline'] : 'traceset.baseline.json';
  let baseline: Baseline;
  try {
    baseline = parseBaseline(readFileSync(path, 'utf8'), path);
  } catch (error) {
    return {
      code: 2,
      lines: [`traceset check: ${String(error)}`, `hint: traceset baseline ${files.join(' ')} --out ${path}`],
    };
  }

  let thresholds: Thresholds;
  try {
    thresholds = thresholdsFrom(values);
  } catch (error) {
    return { code: 2, lines: [`traceset check: ${String(error)}`] };
  }

  const findings: Finding[] = compareAll(baseline, summaries, thresholds).map((finding) =>
    finding.kind === 'no_baseline' && values['require-baseline'] === true
      ? { ...finding, severity: 'regression' as const, message: `${finding.message} (--require-baseline)` }
      : finding,
  );

  if (values['json'] === true) {
    return {
      code: hasRegressions(findings) ? 1 : 0,
      lines: [jsonOf({ baseline: path, traces: summaries.length, regressions: hasRegressions(findings), findings })],
    };
  }
  return {
    code: hasRegressions(findings) ? 1 : 0,
    lines: [`traceset check — ${summaries.length} trace(s) against ${path}`, render(findings)],
  };
}

/** CLI entry point: prints and returns the exit code. */
export function main(argv: readonly string[]): number {
  const outcome = run(argv);
  for (const line of outcome.lines) process.stdout.write(`${line}\n`);
  return outcome.code;
}

// Only when run as a program: importing this module (the tests do) must not execute the CLI.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main(process.argv.slice(2));
}
