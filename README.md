# traceset

> Turn agent traces into regression tests. **Did my change make the agent worse, or just
> more expensive?**

An agent changes for two different reasons, and the two get confused all the time: a prompt
or model change that alters *behaviour*, and a change that alters only the *price*. A gate
that looks at money alone passes a run that became cheaper by looping forever. A gate that
looks at output text alone passes a run that answers the same thing for four times the tokens.

`traceset` compares a trace against a recorded baseline and keeps the two axes apart.

## What it prints

Real output, from the fixtures in this repo (`make check`):

```console
$ npm run traceset -- summary fixtures/*.jsonl
run           steps  stop       µUSD  tokens  tools           behaviour  source
flight-agent  2      end_turn   10    30000   search_flights  b91a763c   fixtures/baseline.jsonl
flight-agent  2      end_turn   18    60000   search_flights  b91a763c   fixtures/pricier.jsonl
flight-agent  3      max_steps  3     90      search_flights  589e7bb9   fixtures/worse.jsonl
```

Two runs behave **identically** (`b91a763c`) and differ only in price: same decisions, 18 µUSD
against 10. The third one costs a third as much and behaves differently (`589e7bb9`).

```console
$ npm run traceset -- baseline fixtures/baseline.jsonl --out traceset.baseline.json
wrote traceset.baseline.json: 1 run(s) — flight-agent

$ npm run traceset -- check fixtures/pricier.jsonl fixtures/worse.jsonl   # exit code 1
traceset check — 2 trace(s) against traceset.baseline.json
  flight-agent         cost +80.0% (18 µUSD vs 10)                                 REGRESSION
  flight-agent         tokens +100.0% (60000 vs 30000)                             REGRESSION
  flight-agent         behaviour changed at step 1: message → tool:search_flights   REGRESSION
  flight-agent         stop reason end_turn → max_steps                            REGRESSION
  flight-agent         the baseline ended with an answer, this run did not          REGRESSION
  flight-agent         steps 2 → 3                                                 REGRESSION
  flight-agent         cost -70.0% (3 µUSD vs 10)                                  improvement
6 regressions, 1 improvement, 0 notes
```

**The last two lines are the point.** One run is 70% cheaper and still fails, because it
stopped answering. A cheap failure is not an improvement, and no threshold can average that
away: money is compared against a budget, behaviour is compared against the baseline.

## How it works

```
trace.jsonl ──► parse ──► summary ──┬──► behaviour: the decisions, hashed (fingerprint)
   (contract)                       └──► price: money, tokens, steps
                                           │
                       baseline.json ──────┴──► compare ──► findings ──► exit code
```

- **The trace format is a contract.** `traceset` reads the JSONL that
  [`agentloop`](https://github.com/paoValle/agentloop) writes, and parses it itself rather than
  importing the runtime: a tool that only works with one install of one library cannot gate
  anything in CI. Any runtime that writes the same events works.
- **A baseline is keyed by the identity of the scenario**, not by file name: `flight-agent` is
  compared with `flight-agent`, across versions. The file name says which version it is.
- **A truncated trace is refused**, not compared. A trace without `run.end` would otherwise look
  like a run that stopped early, and every comparison against it would be quietly wrong.
- **Exit codes mean what CI needs**: `0` fine, `1` a regression, `2` the tool or its input is
  broken. A broken tool must never look like a regression, and a regression must never look
  like a broken tool.
- **Zero runtime dependencies.** Node's `parseArgs`, `node:crypto` and `node:fs`: that is all
  it needs, so it installs in a second and cannot rot.

## The fixtures are real runs, not hand-written JSON

`fixtures/*.jsonl` came out of `agentloop`'s `run()` with a scripted policy, a fake tool and no
network: the same scenario, three versions of it, written with `Trace.toJSONL()`. That is why
they contain the whole event stream — `run.start`, `policy.response`, `budget.settle`,
`tool.result`, `run.end` — and not only the fields this tool happens to read today:

| fixture | what changed | behaviour | money |
|---|---|---|---|
| `baseline.jsonl` | — | `b91a763c` | 10 µUSD |
| `pricier.jsonl` | twice the tokens, same decisions | `b91a763c` | 18 µUSD |
| `worse.jsonl` | the agent loops and never answers | `589e7bb9` | 3 µUSD |

The generator lived in the `agentloop` working tree for one run and was deleted; what stayed
here is its output, which is the part that has to be reproducible.

## Usage

```bash
make setup     # npm ci
make summary   # what each fixture run did
make baseline  # freeze the baseline (writes traceset.baseline.json, committed on purpose)
make check     # the gate: exit 1 if a run got worse
make ci        # typecheck + lint + 17 tests
```

In CI, on the traces your agent produced in the job:

```yaml
- run: npm run traceset -- check traces/*.jsonl --require-baseline
```

`--require-baseline` makes an unseen scenario a failure instead of a note: without it, a new
run that was never baselined passes silently, which is the most comfortable way to have no
regression tests at all.

| flag | default | meaning |
|---|---|---|
| `--max-cost-delta` | `0.2` | tolerated relative cost increase |
| `--max-token-delta` | `0.5` | tolerated relative token increase |
| `--max-step-delta` | `0` | tolerated extra steps |
| `--require-baseline` | off | a run with no baseline fails |
| `--update-baseline` | off | write these runs into the baseline: accepting a change on purpose, with the findings still printed |
| `--json` | off | machine-readable findings, same verdict |

## Scope, declared

Not here, and not claimed:

- **it does not re-run anything.** It judges traces someone else produced. Re-executing a run
  to check it is still reproducible is a different job, and `agentloop`'s `replay()` already
  does it — the natural next step is a command that replays a trace and then compares the two
  summaries, which turns "it is reproducible" and "it is not worse" into one gate.
- **no latency.** The trace has timestamps, but a wall-clock measurement of a scripted policy
  measures the test, not the system.
- **no prompt diffing.** It reports that step 1 changed from `message` to
  `tool:search_flights`; it does not tell you which word of the prompt did it. That needs the
  prompt, which the trace deliberately does not carry.
- **no statistical gate.** Thresholds are per run, not over a distribution: five runs that each
  cost 15% more pass. Averages hide exactly the tail this tool exists to catch.

## What I would do differently

- Behaviour is a hash of the decision sequence, so any change is "a regression" until someone
  looks. A per-step classification (`same`, `reordered`, `extra step`, `different tool`) would
  say *what* changed, and a hash cannot. The hash is a good sentinel and a poor explanation.
- The comparison is between one baseline and one run. Keeping the last N summaries per scenario
  would let it answer "when did this start getting worse", which is the second question anybody
  asks.
- `--require-baseline` should probably be the default: the safe behaviour is the one that
  refuses to pass something it does not know.

## Development

```bash
git clone git@github.com:paoValle/traceset.git
cd traceset
make setup && make ci
```

## License

MIT © Paolo Valletta
