# Changelog

Format [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-05

First version: agent traces as regression tests, with behaviour and price judged separately.

### Added
- `summary`, `baseline` and `check`, with exit codes a CI can gate on: `0` fine, `1` a regression,
  `2` the tool or its input is broken.
- A behaviour fingerprint over the decisions alone, so a run that costs double and decides the same
  thing reads as a price change and not as a behaviour change.
- Findings: cost and token increase, step increase, stop reason change, behaviour change, answer
  lost, budget exhaustion, tools added or removed, model change, and a run with no baseline.
- Thresholds (`--max-cost-delta`, `--max-token-delta`, `--max-step-delta`) and `--require-baseline`,
  plus `--json` for a machine-readable verdict.
- Three fixtures from real `agentloop` runs, including one that is 70% cheaper and worse — the case
  a money-only gate would wave through.
- A truncated or malformed trace is refused with its line number instead of being compared.

### Notes
- Zero runtime dependencies: `node:util`, `node:crypto`, `node:fs`.
