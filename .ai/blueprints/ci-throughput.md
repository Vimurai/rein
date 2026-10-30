# Blueprint — CI Throughput: the hosted run at the runner's width (D-135)

## Goal & Architecture
A hosted `rein ci run` on Rein takes 15.5 minutes; 50 seconds are setup, the rest is the suite
run using two of four cores and then a serial tail of 13 suites. Every remedy here is applied
in Rein's shared code (`rein ci run`, `tests/run.sh`, the `rein ci hosted` renderer) so that
every project Rein renders a hosted check for gets it, Rein included. Users: contributors
(a signal in under two minutes), the Triad (a merge gate under five), the operator (fewer
minutes on paid private runners). In one sentence: use every core the runner has, split the
work across runners, run only what the change touches first, and measure the serial tail
until it is small.

## Core Concept
Four independent levers, each a flag or a default, each rolled back alone:
- **Lane width** — the lane default follows the host: a laptop keeps `min(4, cores/2)`; a
  hosted runner (detected by its environment) uses every core, clamped by the measured memory
  cap (D-093 r3).
- **Census baseline** — the harness packs lanes by measured wall time and admits
  installer-subject suites into lanes by measured footprint; both come from the newest local
  log, which a fresh runner never has. `tests/census-baseline.tsv` is that log's census rows,
  committed with the code, read when no log exists.
- **Shards** — `tests/run.sh --shard i/N` partitions the suites deterministically by the same
  hints; `rein ci run --shard i/N` carries it; the renderer emits N legs.
- **Fast job** — the no-install job runs `--tier fast` on pull requests and trunk pushes
  alike (D-135 addendum r1: a suite beyond the fast tier needs the installed mirror,
  DEVOPS-002, and `--changed` needs a census a fresh runner never has). Change selection
  (`--changed`, E-298) stays a local tool and falls back to the committed baseline
  (addendum r2).

## Components

### Component 1 — Lane default by host (`src/bin/rein`, `rein ci run`)
- `_ci_hosted()` is true when `GITHUB_ACTIONS`, `TF_BUILD`, `GITLAB_CI` or
  `BITBUCKET_BUILD_NUMBER` is set, else when `CI=true`.
- Default lanes: hosted → `cores`; laptop → `min(4, cores/2)`; both clamped by
  `tests/run.sh`'s memory cap (never refused for a default, D-093). Explicit `--lanes N`
  unchanged. `[ci] resources lanes=` already reports the value; the `runner=` field names
  the host class (`hosted:github`, `hosted:azure`, …, `local`).
- The renderer stops passing `--lanes` (D-133's `--lanes <cores>` is withdrawn).

### Component 2 — Census baseline (`tests/run.sh`, `tests/tools/census.mjs`, `rein ci run`)
- File: `tests/census-baseline.tsv`, tab-separated, the `CENSUS_RUN`, `CENSUS_SUITE` and
  `CENSUS_FP` rows of one full unsharded PASS run, header row first. ~50 rows for Rein.
- Read order in `tests/run.sh` for wall hints (`_wall_hint`) and installer footprints
  (`installerLane()`): newest local log with `CENSUS_SUITE` rows → the baseline → none.
  The `Lane:` lines say which source was used (`hints: log <path>` / `hints: baseline` /
  `hints: none`).
- Written by `rein ci run` into the project tree after a full unsharded PASS, in the same step
  that writes the E-328 record; never from a shard, a dirty run or a FAIL. The pre-push hook
  prints `[CENSUS_BASELINE_STALE] <n> full runs since the baseline` past 30 and does not
  block.
- A project without `tests/tools/census.mjs` gets no baseline and no messages.

### Component 3 — Shards (`tests/run.sh`, `rein ci run`, `src/shared/ci-record.mjs`)
- `tests/run.sh --shard i/N` (`REIN_TEST_SHARD=i/N`; `1 ≤ i ≤ N`, else exit 2). Partition:
  shared suites sorted by hint descending then name, assigned greedily to the lightest of N
  bins; exclusive suites the same, separately; a suite with no hint counts as the median.
  The node unit layer and the fast-tier timing belong to shard 1, and bin 1 is seeded with
  the unit layer's measured seconds before suites are assigned (D-135 addendum 2 r4, E-389),
  so shard 1 is not the long pole. The run prints
  `Shard i/N: <k> shared, <m> exclusive (est. <s> s)`. `--lanes` applies inside a shard.
  `--shard` with `--tier fast` or `--changed` is refused (exit 2): the fast job is one leg.
- `rein ci run --shard i/N` passes it through, records `shard` in the `ci_runs` row and the
  E-328 record, marks the run non-certifying (`rein ci status` reports `SHARD i/N` like it
  reports dirty), runs the budget step (E-303) on shard 1 only, and never writes the
  baseline.
- `rein ci status` and `rein ci list` show the shard column; a sha with N shard PASS records and
  no full run is still "no certifying run" locally — hosted legs certify through the branch
  policy, not through records (D-103 r1f).

### Component 4 — Renderer (`src/shared/hosted-ci.mjs`, `src/templates/ci/github.yml`)
- Detection: `--tier` and `--shard` are grepped from the project's `tests/run.sh` exactly as
  `rein ci run` greps `--tier` today. No `tests/run.sh` → the single job as today.
- Jobs rendered for GitHub (every profile):
  - `fast` (when `--tier` is advertised): checkout, Node 22, no installer,
    `bash tests/run.sh --tier fast` on `pull_request` and `push` alike; `timeout-minutes: 10`
    (D-135 addendum r1).
  - `rein ci run (<os>, node <v>, <i>/<N>)`: the matrix; N = `team.json` `ci.shards`, default
    4, `1` renders the single-leg name `rein ci run (<os>, node <v>)`; `--shard` not advertised
    → N forced to 1. Team profile: `ubuntu-latest × 22`. Public profile (D-133):
    `ubuntu-latest × {22, 24}` and `macos-latest × 22` on pull requests; the nightly adds
    `macos-latest × 24` and one unsharded `ubuntu-latest × 22` leg (D-135 r5).
- `REQUIRED_CHECK` becomes `requiredChecks(root)` returning the list; `rein ci hosted` prints
  the policy line with every name; `.ai/DEVOPS.md` records the set per project.
- macOS legs (D-135 addendum 2): no `brew install tmux` — the contract stays two commands;
  tmux paths are covered on Ubuntu; tmux-dependent assertions `skip_unless_cmd tmux` with a
  host-named SKIP (harness rule 1, E-332). The macOS × 22 legs run on every pull request and
  join the required set in the pull request that closes E-388 (the bash 3.2 defect: `set -u` aborted every sourcing subshell on `${BASHPID}`, unset in bash 3.2 — not trap chaining; D-138 r4. Joined on 2026-10-30, DEVOPS-017).
- Azure (E-336) gets Component 1 for free; its shard matrix and the GitLab/Bitbucket wrappers
  land with E-337 and follow the same names.

### Component 5 — The exclusive tail (`tests/run.sh`, `rein ci status`, Rein's suites)
- `[ci] resources` gains `exclusive_seconds=`; `rein ci status` prints
  `exclusive <s> s (<p> % of suite seconds)` after the slowest suites.
- Rein: the five suites exclusive for "no measured installer footprint" are expected to join
  the lanes once the baseline exists (Component 2); the remaining eight are reviewed one by
  one and each keeps its `# REIN_EXCLUSIVE: <reason>` header or loses the status. Target: the
  exclusive phase under 25 % of a leg's suite seconds; a team project sees its share and is
  not held to it.

## Data Model
```
tests/census-baseline.tsv
  CENSUS_RUN   <iso>  <sha>  <pattern>
  CENSUS_SUITE <suite>  <wall_ms>  <lines>  <…existing columns>
  CENSUS_FP    <suite>  <count>  <bin>  <args>

ci_runs (+ column)      shard TEXT NULL        -- "i/N" or NULL
.ai/ci/<sha>.json (+)   "shard": "i/N"         -- absent on a full run
team.json               ci: { provider, rein_source?, shards?: 1..8 }   -- default 4
[ci] resources          lanes= peak_rss_mb= suite_seconds= exclusive_seconds= runner=
Required checks (public, PR): fast, privacy, CodeQL,
  rein ci run (ubuntu-latest, node 22, i/4), rein ci run (ubuntu-latest, node 24, i/4),
  rein ci run (macos-latest, node 22, i/4)                       for i in 1..4
Required checks (team):       fast, rein ci run (ubuntu-latest, node 22, i/N)
```

## API / Interface Contracts
- `tests/run.sh [--shard i/N] [--lanes N] [--tier fast|full] [--changed <ref>]` — exit 0/1
  as today; 2 on a bad shard spec or on `--shard` combined with `--tier fast`/`--changed`.
- `rein ci run [--shard i/N]` — exit 0 PASS, 1 FAIL, 2 ERROR; the log carries `[ci] shard i/N`.
- `rein ci status` — shows `SHARD i/N` runs as non-certifying; exit codes unchanged.
- `rein ci hosted <provider> [--check|--force]` — renders the job list above; `--check` fails on
  drift as today; the printed policy lists every required name.
- `rein doctor` — `[CENSUS_BASELINE_STALE] <n>` and the existing `[HOSTED_CI_OK]` line.
- Environment: `REIN_TEST_SHARD`, `REIN_TEST_LANES` (existing); no new user-facing env var.

## Security
- No secrets, no network: shards and lanes are local process partitioning; the baseline is
  census counts and suite names, nothing from the operator's machine (the census already
  excludes paths, D-129 privacy scan covers the file like any tracked file).
- The baseline is data the harness trusts for scheduling only: a malicious row can slow a
  run, not change a verdict; every suite still runs in exactly one shard (asserted).
- Hosted detection reads environment variables that the reserved list (E-343) already forbids
  in `ci.local.json`, so a project cannot spoof "hosted" to widen lanes on a laptop.
- The renderer's output stays SHA-pinned and minimal-permission (D-133); the fast job has no
  installer and no write permission.
- `ci_gate` skill before the renderer change; `.ai/DEVOPS.md` updated with the new names.

## Execution Constraints
- Lane count is still capped by free memory / 1.5 GB (D-093): `ubuntu-latest` (4 cores,
  16 GB) → 4 lanes; `macos-latest` (3 cores, 7 GB) → 3 lanes.
- Shard partition is pure and deterministic for a given baseline: the same inputs give the
  same partition on every leg (asserted by a unit test over a synthetic census).
- Baseline read adds one file read; the pre-push staleness check counts `ci_runs` rows — under
  10 ms, no network.
- Measured on Rein (E-386, hosted, unsharded): 914 s with four lanes and no baseline
  (13 exclusive suites, 508 s tail); 736 s with the baseline (9 exclusive, 300 s tail); local
  exclusive share 56 %. First sharded run (E-384, run 40906294420): `fast` 1m22s; Ubuntu
  shards 4m36s–7m07s (shard 1 the long pole, E-389); macOS shards 4m11s–13m44s with two red
  from the tmux and bash 3.2 defects (E-388); Ubuntu PR wall time ~7 min against 15.5 on
  the single job. Next levers: E-389 (shard 1 seed), E-387 (the 56 % exclusive tail).
  `rein ci status` reports the measurements; the nightly drift line (D-118 r1) reports the
  unsharded `full_seconds`.
- Private runners: four shards cost about four extra install minutes per run; `ci.shards: 1`
  restores one leg.

## Rollback Plan
Each lever alone: Component 1 is one default expression; Component 2 is the fallback branch
plus the file (delete both, `hints: none` is today's hosted behaviour); Component 3 is
`ci.shards: 1` (the renderer emits one leg) and `--shard` unused; Component 4 regenerates
the wrapper with `rein ci hosted --force`; Component 5 is a reporting line. No state outside
`tests/census-baseline.tsv`, the `ci_runs.shard` column (nullable, ignored when unused) and
the branch policy names is touched.

## E-## Task Breakdown
| Task | Tier | Scope | Depends on |
|---|---|---|---|
| E-386 | 2 | Components 1–3 and the reporting of 5: lane default by host, census baseline, `--shard` in the harness and `rein ci run`, `exclusive_seconds` | E-382 |
| E-384 (rescoped) | 2 | Component 4 inside the public CI work (D-133): fast job with `--changed`, shard matrix, required names | E-386 |
| E-387 | 2 | Component 5 on Rein's suites: the exclusive tail under 25 % | E-386 |
| E-337 (inherits) | 2 | GitLab and Bitbucket wrappers render the same job list | E-384 |
