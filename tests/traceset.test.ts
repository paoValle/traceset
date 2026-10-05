import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  hasRegressions,
  baselineOf,
  compare,
  compareAll,
  parseBaseline,
  render,
  type Thresholds,
} from '../src/diff.js';
import { firstDivergence, parseTrace, summarize, TraceFormatError } from '../src/trace.js';
import { run } from '../src/cli.js';

const read = (name: string): string => readFileSync(new URL(`../fixtures/${name}.jsonl`, import.meta.url), 'utf8');
const summaryOf = (name: string) => summarize(parseTrace(name, read(name)), name);

const baseline = summaryOf('baseline');
const pricier = summaryOf('pricier');
const worse = summaryOf('worse');

describe('reading a trace', () => {
  it('reduces a run to steps, money, tokens, tools and decisions', () => {
    expect(baseline.runId).toBe('flight-agent');
    expect(baseline.steps).toBe(2);
    expect(baseline.stopReason).toBe('end_turn');
    expect(baseline.spentMicroUsd).toBe(10);
    expect(baseline.inputTokens).toBe(20_000);
    expect(baseline.outputTokens).toBe(10_000);
    expect(baseline.tools).toEqual(['search_flights']);
    expect(baseline.toolCalls).toBe(1);
    expect(baseline.answered).toBe(true);
    expect(baseline.decisions).toEqual([
      { step: 0, kind: 'tool', detail: 'search_flights' },
      { step: 1, kind: 'message', detail: 'message' },
    ]);
  });

  it('refuses a malformed line, and says which line it is', () => {
    const broken = `${read('baseline')}\n{oops`;
    expect(() => parseTrace('broken.jsonl', broken)).toThrow(TraceFormatError);
    expect(() => parseTrace('broken.jsonl', broken)).toThrow(/broken\.jsonl:13/);
  });

  it('refuses something that is not a run, instead of comparing a truncated trace', () => {
    const events = parseTrace('t.jsonl', read('baseline')).filter((event) => event.type !== 'run.end');
    expect(() => summarize(events, 't.jsonl')).toThrow(/no run\.start or run\.end/);
    expect(() => parseTrace('t.jsonl', '')).toThrow(/empty/);
  });
});

describe('behaviour is not price', () => {
  it('two runs that decide the same thing share a fingerprint, whatever they cost', () => {
    expect(pricier.fingerprint).toBe(baseline.fingerprint);
    expect(pricier.spentMicroUsd).toBe(18);
    expect(baseline.spentMicroUsd).toBe(10);
  });

  it('a run that loops has a different fingerprint', () => {
    expect(worse.fingerprint).not.toBe(baseline.fingerprint);
    expect(firstDivergence(baseline.decisions, worse.decisions)).toBe(1);
    expect(worse.stopReason).toBe('max_steps');
    expect(worse.answered).toBe(false);
  });
});

describe('comparing against a baseline', () => {
  it('says nothing when nothing moved', () => {
    expect(compare(baseline, baseline)).toEqual([]);
  });

  it('catches the pricing regression: same behaviour, +80% money and +100% tokens', () => {
    const findings = compare(baseline, pricier);
    expect(findings.map((f) => f.kind).sort()).toEqual(['cost_increase', 'token_increase']);
    expect(findings.every((f) => f.severity === 'regression')).toBe(true);
    expect(findings.find((f) => f.kind === 'cost_increase')?.message).toMatch(/\+80\.0%/);
    expect(findings.some((f) => f.kind === 'behaviour_changed')).toBe(false);
  });

  it('catches the behaviour regression even though the run is cheaper', () => {
    const findings = compare(baseline, worse);
    expect(worse.spentMicroUsd).toBeLessThan(baseline.spentMicroUsd);
    expect(hasRegressions(findings)).toBe(true);
    expect(findings.map((f) => f.kind)).toEqual(
      expect.arrayContaining(['behaviour_changed', 'stop_reason_changed', 'answer_lost']),
    );
    const cost = findings.find((f) => f.kind === 'cost_increase');
    expect(cost?.severity).toBe('improvement');
  });

  it('thresholds make a tolerated price increase stop shouting', () => {
    const generous: Thresholds = { maxCostDelta: 1, maxTokenDelta: 2, maxStepDelta: 0 };
    expect(compare(baseline, pricier, generous)).toEqual([]);
    // but behaviour is not negotiable: no threshold makes a changed decision acceptable
    expect(hasRegressions(compare(baseline, worse, generous))).toBe(true);
  });

  it('reports a run with no baseline instead of pretending it passed', () => {
    const unseen = { ...pricier, runId: 'never-seen' };
    const findings = compareAll(baselineOf([baseline]), [unseen]);
    expect(findings).toEqual([{ trace: 'never-seen', kind: 'no_baseline', severity: 'note', message: expect.stringContaining('no baseline') }]);
    expect(hasRegressions(findings)).toBe(false);
  });

  it('refuses a file that is not a baseline', () => {
    expect(() => parseBaseline('{}', 'b.json')).toThrow(/version 1 baseline/);
    expect(() => parseBaseline('nope', 'b.json')).toThrow(/not valid JSON/);
  });

  it('renders regressions before improvements', () => {
    const text = render(compare(baseline, worse));
    expect(text.indexOf('REGRESSION')).toBeLessThan(text.indexOf('improvement'));
  });
});

describe('the CLI', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'traceset-'));
  const fixture = (name: string): string => new URL(`../fixtures/${name}.jsonl`, import.meta.url).pathname;

  it('summarizes and prints a table', () => {
    const outcome = run(['summary', fixture('baseline'), fixture('pricier')]);
    expect(outcome.code).toBe(0);
    expect(outcome.lines.join('\n')).toContain('behaviour');
    expect(outcome.lines.join('\n')).toContain('baseline');
  });

  it('freezes a baseline and fails a run that is worse, not just more expensive', () => {
    const baselinePath = join(workspace, 'traceset.baseline.json');
    const frozen = run(['baseline', fixture('baseline'), '--out', baselinePath]);
    expect(frozen.code).toBe(0);

    const regressed = run(['check', fixture('worse'), '--baseline', baselinePath]);
    expect(regressed.code).toBe(1);
    expect(regressed.lines.join('\n')).toContain('REGRESSION');

    const untouched = run(['check', fixture('baseline'), '--baseline', baselinePath]);
    expect(untouched.code).toBe(0);
    expect(untouched.lines.join('\n')).toContain('no change');
  });

  it('uses the committed baseline when none is given', () => {
    // traceset.baseline.json is an input of this repo, not an artifact: running `check`
    // with no flags in a fresh clone must work
    expect(run(['check', fixture('baseline')]).code).toBe(0);
    expect(run(['check', fixture('worse')]).code).toBe(1);
  });

  it('exits 2, not 1, when the input is wrong: a broken tool is not a regression', () => {
    expect(run(['check', fixture('baseline'), '--baseline', join(workspace, 'missing.json')]).code).toBe(2);
    expect(run(['check', fixture('baseline'), '--max-cost-delta', 'nope']).code).toBe(2);
    expect(run([]).code).toBe(2);
    expect(run(['what']).code).toBe(2);
  });

  it('--json is machine-readable and carries the same verdict', () => {
    const baselinePath = join(workspace, 'for-json.json');
    run(['baseline', fixture('baseline'), '--out', baselinePath]);
    const outcome = run(['check', fixture('pricier'), '--baseline', baselinePath, '--json']);
    expect(outcome.code).toBe(1);
    const parsed = JSON.parse(outcome.lines.join('\n')) as { regressions: boolean; findings: { kind: string }[] };
    expect(parsed.regressions).toBe(true);
    expect(parsed.findings.map((f) => f.kind)).toContain('cost_increase');
  });

  it('--require-baseline turns "never seen" into a failure, for a gate in CI', () => {
    const baselinePath = join(workspace, 'partial.json');
    // a baseline that knows a different scenario, so this run is genuinely unseen
    writeFileSync(baselinePath, JSON.stringify(baselineOf([{ ...baseline, runId: 'another-scenario' }])));
    expect(run(['check', fixture('pricier'), '--baseline', baselinePath]).code).toBe(0);
    expect(run(['check', fixture('pricier'), '--baseline', baselinePath, '--require-baseline']).code).toBe(1);
  });
});
