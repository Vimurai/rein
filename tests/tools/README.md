# tests/tools — measurement tools for the test suite (D-088)

Tools that measure the suite rather than test the product. None of them runs as part of
`ai ci run`.

| Tool | Task | What it answers |
|---|---|---|
| `census.mjs` | E-297 | Per suite: assertions, task-label density, wall time, footprint. `node tests/tools/census.mjs` |
| `select-suites.mjs` | E-298 | Which suites `tests/run.sh --tier fast` / `--changed <ref>` runs |
| `mutation/probe.sh` | E-300 | Which tests detect a change in the code they cover (the mutation probe) |

`managed_agents_spike.js` (E-47) is not a measurement tool: it is the offline Managed Agents
feasibility spike, kept here as a fixture program that `tests/suites/managed_agents_test.sh` runs
(moved from `tests/` by E-302).

## The mutation probe (E-300, `.ai/blueprints/test-economics.md` §Component 5)

```bash
npm install --no-save --save-exact @stryker-mutator/core@10.0.0 @stryker-mutator/tap-runner@10.0.0
bash tests/tools/mutation/probe.sh            # hours; report → ~/.rein/ci/mutation-<date>.json + .md
```

Stryker is NOT a dependency of this repo (D-089 ruling 4 admitted it for the probe only), so a
re-run installs it with `--no-save` first and leaves `package.json` untouched.

- **Pass A** — Stryker over `src/shared`, `src/mcp/shared`, `src/mcp/safe-exec-mcp` with the
  node unit layer (`tests/unit/*.test.mjs`, tap runner, per-test coverage). The tap runner treats
  each test FILE as one test, so per-test kills are per test file.
- **Pass B** — the gate (`src/mcp/safe-exec-mcp`) is pinned by its contract tables, not by the
  unit layer. Every gate mutant pass A left alive is re-tested against the four tables
  (`secret`, `pipe-shell`, `gate-relative-home`, `arch-write` — `mutation/gate-tables.sh`). One
  V8 coverage run of the tables first decides which mutants a table executes at all; the rest
  survive without a run. A gate mutant alive after pass B is a MISSING contract-table row.
  The tables are answered in ONE process per mutant (`mutation/inproc-tables.mjs` imports the
  mutated gate and asks `runAnalysis` with `--check`'s semantics) — seconds instead of ~2 min of
  per-case `--check` spawns; mutants in `index.js`'s CLI glue (from `_gateFlags` on) take the
  spawn path, and the first `REIN_MUTATION_CROSSCHECK` (default 20) in-process mutants are
  re-run on the spawn path and any disagreement is reported.
- **Report** — per module the mutation score (unit layer alone and with the tables), every
  surviving mutant with `file:line`, per unit test file the mutants it kills, and the unit tests
  that kill none (deletion candidates for P-44's Consolidation Map).

Every test process runs with a throwaway HOME; the only write outside the temp work dir is the
report (`--out <path>` moves it). `REIN_MUTATION_CONCURRENCY` sets the worker count (pass A
default 6, pass B default 4); `--skip-a` with `REIN_MUTATION_OUT=<earlier work dir>` re-runs
pass B and the report from an existing pass-A result.

Known limits: the mint side of `role-token.mjs` is exercised only through the repo's unmutated
gate (`tests/lib/as-session.sh` mints with it), so mint-path mutants are judged by the unit layer
alone; pass B stops at the first table that fails, so a kill is credited to the first failing
table in the order `secret`, `pipe-shell`, `gate-relative-home`, `arch-write`.

## Recording a wave's gate inputs (E-301, D-113)

The subset proof (`tests/unit/consolidation-subset.test.mjs`) checks a recorded set, because the
census sees suites and lines, never the inputs a suite sends the gate. To record it, add a
throwaway worktree of the commit (`git worktree add --detach <dir> <ref>`), copy each server's
`node_modules` into it, and insert at the top of its `src/mcp/safe-exec-mcp/index.js` a few lines
that, when `--check` or `--check-path` is in argv, append `{mode, input, exit}` (the argument after
the flag, and the code `process.exit` is called with) as one JSON line to a fixed log file. Then
run each source suite from the worktree (`bash tests/run.sh <suite>_test.sh`), one log per suite.
`NODE_OPTIONS=--import` cannot do this: the hook strips `NODE_OPTIONS` (E-286.2), so every call
through the hook would go unrecorded. The instrumented `index.js` is a measuring instrument: it is
never committed, and the worktree is removed afterwards. A detached worktree is not the framework
clone, so locator_policy's E-223.01c fails there; take that suite's inputs from a run in the
checkout. Dedupe the logs on `(mode, input, exit)`, class every row `table` or
`boundary:<kept suite>` with its `context` (D-113), and check the result in as
`tests/fixtures/wave1-inputs.json`.
