//! Reading an `agentloop` trace: what a run did, and what it cost.
//!
//! The trace format is a **contract**, not an implementation detail: `traceset` reads the
//! JSONL that `agentloop` writes, and nothing else. That is why this file parses the events
//! itself instead of importing the runtime: a tool that can only read traces produced by one
//! install of one library is a tool nobody can use in CI.
//!
//! Two things are deliberately kept apart, because the whole point of the tool depends on it:
//!
//! - **behaviour** — which decisions were taken, in which order (`decisions`, `fingerprint`);
//! - **price** — tokens, money, steps (`inputTokens`, `outputTokens`, `spentMicroUsd`).
//!
//! A run that behaves the same and costs double is a pricing regression; a run that costs
//! half and behaves differently is a behaviour regression. Mixing the two into one number is
//! how a "cheaper and worse" change gets merged.

import { createHash } from 'node:crypto';

/** A trace event, as `agentloop` writes it. Unknown fields are ignored, not rejected. */
export interface TraceEvent {
  readonly type: string;
  readonly seq?: number;
  readonly ts?: number;
  readonly [key: string]: unknown;
}

/** What the runtime did at one step: the unit behaviour is compared on. */
export interface DecisionSignature {
  /** Zero-based step index. */
  readonly step: number;
  /** `tool`, `message` or `stop`. */
  readonly kind: string;
  /** The tool name, the stop reason, or `message` for text. **Not** the text itself. */
  readonly detail: string;
}

/** A run, reduced to what a regression test can compare. */
export interface Summary {
  /** The run id the runtime wrote. */
  readonly runId: string;
  /** Where it was read from, for the report. */
  readonly source: string;
  /** Steps executed. */
  readonly steps: number;
  /** Why it stopped. */
  readonly stopReason: string;
  /** Money spent, in micro-dollars, exactly as the trace recorded it. */
  readonly spentMicroUsd: number;
  /** Total input tokens the provider reported. */
  readonly inputTokens: number;
  /** Total output tokens the provider reported. */
  readonly outputTokens: number;
  /** Models that answered, sorted and unique. */
  readonly models: readonly string[];
  /** Tools actually called, sorted and unique. */
  readonly tools: readonly string[];
  /** How many tool calls were made, repeats included. */
  readonly toolCalls: number;
  /** The decision taken at every step, in order. */
  readonly decisions: readonly DecisionSignature[];
  /** Short hash of `decisions` alone: **behaviour**, with no price in it. */
  readonly fingerprint: string;
  /** Whether the run produced a final answer. */
  readonly answered: boolean;
}

/** A trace that cannot be read. Carries the line number, because that is what one needs. */
export class TraceFormatError extends Error {
  constructor(
    readonly source: string,
    readonly line: number,
    message: string,
  ) {
    super(`${source}:${line}: ${message}`);
    this.name = 'TraceFormatError';
  }
}

/**
 * Parses JSONL into events, and refuses anything that is not a run.
 *
 * Refusing matters: a truncated trace would otherwise look like a run that stopped early,
 * and every comparison against it would be quietly wrong.
 */
export function parseTrace(source: string, text: string): TraceEvent[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new TraceFormatError(source, 1, 'the trace is empty');

  const events: TraceEvent[] = [];
  lines.forEach((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new TraceFormatError(source, index + 1, `not valid JSON: ${String(error)}`);
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as TraceEvent).type !== 'string') {
      throw new TraceFormatError(source, index + 1, 'an event without a type is not an event');
    }
    events.push(parsed as TraceEvent);
  });

  const types = new Set(events.map((event) => event.type));
  for (const required of ['run.start', 'run.end']) {
    if (!types.has(required)) {
      throw new TraceFormatError(source, 1, `not a run trace: no ${required} event`);
    }
  }
  return events;
}

/** Reduces a trace to a comparable summary. */
export function summarize(events: readonly TraceEvent[], source: string): Summary {
  const start = events.find((event) => event.type === 'run.start');
  const end = [...events].reverse().find((event) => event.type === 'run.end');
  if (start === undefined || end === undefined) {
    throw new TraceFormatError(source, 1, 'not a run trace: no run.start or run.end');
  }

  const decisions: DecisionSignature[] = [];
  const models = new Set<string>();
  const tools = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;

  for (const event of events) {
    if (event.type === 'policy.response') {
      const step = numberField(event, 'step');
      if (typeof event['model'] === 'string') models.add(event['model']);
      const usage = event['usage'];
      if (isRecord(usage)) {
        inputTokens += numberField(usage, 'inputTokens');
        outputTokens += numberField(usage, 'outputTokens');
      }
      decisions.push(decisionOf(step, event['decision']));
      continue;
    }
    if (event.type === 'tool.call') {
      toolCalls += 1;
      const call = event['call'];
      if (isRecord(call) && typeof call['name'] === 'string') tools.add(call['name']);
    }
  }

  return {
    runId: typeof start['runId'] === 'string' ? start['runId'] : 'run',
    source,
    steps: numberField(end, 'steps'),
    stopReason: typeof end['stopReason'] === 'string' ? end['stopReason'] : 'unknown',
    spentMicroUsd: numberField(end, 'spent'),
    inputTokens,
    outputTokens,
    models: [...models].sort(),
    tools: [...tools].sort(),
    toolCalls,
    decisions,
    fingerprint: fingerprint(decisions),
    answered: decisions.at(-1)?.kind === 'message',
  };
}

function decisionOf(step: number, decision: unknown): DecisionSignature {
  if (!isRecord(decision)) return { step, kind: 'unknown', detail: 'unknown' };
  const type = typeof decision['type'] === 'string' ? decision['type'] : 'unknown';
  if (type === 'tool') {
    const call = decision['call'];
    const name = isRecord(call) && typeof call['name'] === 'string' ? call['name'] : 'unnamed';
    // the arguments are deliberately not part of the signature: a prompt change that alters
    // an argument is a behaviour change, but hashing the values would make every run with a
    // timestamp or an id in its arguments look different
    return { step, kind: 'tool', detail: name };
  }
  if (type === 'stop') {
    const reason = typeof decision['reason'] === 'string' ? decision['reason'] : 'unknown';
    return { step, kind: 'stop', detail: reason };
  }
  return { step, kind: 'message', detail: 'message' };
}

/** Behaviour fingerprint: 8 hex characters over the decisions, price excluded on purpose. */
export function fingerprint(decisions: readonly DecisionSignature[]): string {
  const shape = decisions.map((decision) => `${decision.step}:${decision.kind}:${decision.detail}`).join('|');
  return createHash('sha256').update(shape).digest('hex').slice(0, 8);
}

/** Index of the first decision that differs, or -1 if the two runs behaved identically. */
export function firstDivergence(a: readonly DecisionSignature[], b: readonly DecisionSignature[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined) return index;
    if (left.kind !== right.kind || left.detail !== right.detail) return index;
  }
  return -1;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
