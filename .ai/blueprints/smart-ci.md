# Blueprint — Smart CI: run what the change needs, once (D-166)

## Goal & Architecture
Today every head is tested in full twice. The Engineer runs `rein ci run` (about 10 minutes)
before each push, and a pull request to the trunk repeats it on GitHub in 8 or more legs
(15–20 minutes), whatever the change touched: a README line costs the same as a gate rewrite.
The operator asked (2026-11-20) for a CI that is skipped when what already ran is sufficient,
in every project Rein renders a check for.

Users: the Triad (a push in under two minutes for a narrow change), contributors (a pull
request signal sized to the diff), the operator (fewer hosted minutes), downstream projects
(the same behaviour from the shared code, with no project-specific work).

In one sentence: one function decides, from the diff, how much must run; the local run, the
pre-push gate and the hosted workflow all obey that one answer; a result already obtained for
the same tree is not obtained again; and the nightly full run checks that nothing skipped was
needed.

This builds on `ci-throughput.md` (D-135): lanes, shards, the census baseline and
`tests/run.sh --changed` stay as they are. This blueprint decides **when** each is used.

## Core Concept
**The plan.** `ciPlan(base, head)` is a pure function of the changed paths, the commit
subjects in the range and the committed census baseline. It returns a **level** and the reason:

| Level | Runs | When |
|---|---|---|
| `none` | nothing | every changed path is bookkeeping (`.ai/**`, `plans/**`) |
| `fast` | the fast tier (`tests/run.sh --tier fast`) | the change is docs-class and no suite's census footprint touches a changed path |
| `affected` | the fast tier and the suites whose census footprint touches a changed path (`--changed`) | every changed path is known to the census and none is on the full list |
| `full` | everything, as today | anything else |

**Full is the default.** The plan returns `full` whenever it cannot prove a lower level:
a path on the full list, a path the census has never seen, a `[TIER_3]` commit in the range,
no base, a shallow clone, a missing or stale baseline, more than half of the suites selected,
or any error in the planner itself.

**Evidence belongs to a tree.** A green run is recorded against the git tree it tested, with
its level. A commit whose tree already has sufficient evidence needs no run (an amended
message, a rebase that changed nothing, a re-push, a re-run).

**One required check.** The hosted workflow ends in a job named `ci-result` that is green
when every leg the plan asked for is green. The branch policy requires that one name, so a
leg the plan skipped never leaves a pull request waiting on a check that will not report.

## Components

### Component 1 — The planner (`src/shared/ci-plan.mjs`, `rein ci plan`)
- Input: `base`, `head`, the project root. Changed paths from `git diff --name-only -M
  base...head`; commit subjects from `git log base..head`.
- **Full list** (built in, extended by `team.json` `ci.full_paths`): `tests/run.sh`,
  `tests/lib/**`, `tests/tools/**`, `tests/census-baseline.tsv`, `package.json`,
  `package-lock.json`, `**/package.json`, the installer (`install-*.sh`), `hooks/**`,
  `.github/**`, `src/templates/ci/**`, `src/shared/ci-plan.mjs`, `src/shared/hosted-ci.mjs`,
  `.ai/team.json`. A project adds its own (a schema directory, a build config).
- **Docs class** (built in, extended by `ci.docs_paths`): `**/*.md` outside `.ai/`, `docs/**`,
  `LICENSE*`, `legal/**`, image files. A docs path that a suite's footprint touches is still
  selected at level `affected` (Rein has suites that read the README).
- **Affected**: delegates to `tests/tools/select-suites.mjs` (E-298), with the committed
  baseline as the footprint source (D-135 addendum r2). The planner does not reimplement
  selection.
- A project without a census (no `tests/tools/census.mjs`) has three levels only: `none`,
  `fast` for a docs-only change (its test job is skipped when it advertises no `--tier`), and
  `full`.
- Output, one JSON object: `{ level, reason, base, head, tree, suites: [...], skipped: n,
  est_seconds, shards, platforms }`. `shards` is 1 when `est_seconds` (from the baseline) is
  under 240, else the project's `ci.shards`. `platforms` is Component 4's answer.
- `rein ci plan [--base <ref>] [--json]` prints it. Exit 0 always for a computed plan; exit 2
  on a usage error. A planner crash prints `[PLAN_FALLBACK] <reason>` and the `full` plan.

### Component 2 — The local run obeys the plan (`src/bin/rein`, `rein ci run`)
- `rein ci run` computes the plan against the trunk's merge base and runs that level. The log's
  first lines are `[ci] plan level=<l> reason=<r> suites=<k>/<n>`.
- `rein ci run --full` runs everything (today's behaviour) and is what the census baseline,
  the budget ratchet (E-303, E-443) and a release need. A run below `full` never writes the
  baseline and never lowers a recorded budget value.
- `--shard`, `--suite-only`, `--unit-only`, `--dirty` keep their meaning and stay
  non-certifying as today.
- The record (`ci_runs`, and `.ai/ci/<sha>.json` in a team project) gains `tree`, `level` and
  `base`.

### Component 3 — Sufficiency (`src/mcp/shared/ci-runs.js`, `hooks/pre-push.sh`, `rein ci status`)
- A tip is **certified** when a green, clean, unsharded record exists for its **tree** at a
  level at or above the level the plan asks for, for the same base or an ancestor of it.
  The pre-push gate (E-267) asks this question instead of "is there a full run for this sha".
- `none` certifies without a record (this is today's bookkeeping exemption, restated).
- **Where a hosted check is the merge gate** (`team.json` `ci.provider` set and
  `ci.required: true`), the pre-push gate asks for at most `affected`: the hosted run is the
  full run, and running it twice is the duplication this blueprint removes. A plan of `full`
  is then met locally by the `affected` selection plus the fast tier. Without a hosted gate
  the local run is the only gate and the plan's level stands.
- A `[TIER_3]` commit in the range is never lowered by the previous rule: local `full`.
- `rein ci status` prints the plan, what certified the tree (`this run` / `tree <t> at <sha>`)
  and how many suites were not run.

### Component 4 — The hosted workflow (`src/shared/hosted-ci.mjs`, `src/templates/ci/github.yml`)
- Job `plan` (checkout with history, Node, no installer): runs the planner and publishes
  `level`, `shards`, the matrix and `skip` as outputs. Under a minute.
- Job `fast`: as today; skipped at level `none`.
- Job `rein ci run (…)`: the matrix comes from the plan. `affected` renders one leg per
  platform running `rein ci run` at that level; `full` renders the sharded matrix as today.
- **Platforms.** A pull request runs `ubuntu-latest × node 22` only. A push to the trunk adds
  `macos-latest × node 22`. The nightly and a release run every leg (unchanged). A red
  trunk push opens or updates the same issue the nightly does.
- **Evidence on the runner.** Each leg restores a cache entry keyed by
  `<leg name>-<level>-<tree>`. A hit means this exact leg already passed on this exact tree:
  the leg prints `[ci] reused <key>` and exits 0. A green leg saves its key. The hosted run
  trusts only this cache; it never reads `.ai/ci/*.json`, which a pull request can write.
- **Trunk push after a green pull request.** When the pushed commit's tree equals the tree of
  a pull request merge ref whose `ci-result` was green, the Linux legs are reused and only
  the macOS legs run. If the lookup fails for any reason the plan stands.
- Job `ci-result` (`if: always()`, needs every job above): green when each needed job is
  `success`, or `skipped` and the plan said so. It prints the plan and one line per leg.
- `privacy` runs on `pull_request` and on a push to the trunk, not on every branch push
  (today it runs twice per pull request push).
- A pull request labelled `ci:full`, a `workflow_dispatch`, the nightly and a release force
  level `full`.
- Required checks become: `ci-result`, `privacy`, `CodeQL`. `rein ci hosted` prints that
  policy; the operator changes the ruleset.
- Azure renders the same four jobs (E-336); GitLab and Bitbucket follow with E-337.

### Component 5 — The escape audit (`.github/workflows/nightly.yml`, `src/shared/ci-plan.mjs`)
- The nightly stays full. When it is red, for each failing suite the audit walks the commits
  since the last green nightly, recomputes each commit's plan, and prints
  `[PLAN_ESCAPE] <suite> <sha> level=<l>` when a plan did not select that suite.
- The issue the nightly opens carries those lines. An escape is a planner defect: the path
  that caused it joins the full list (or the footprint is corrected) in the fix.
- `rein ci status --plans` lists, for the last 30 days, runs by level and the seconds not run.

## Data Model
```
ciPlan output      { level: "none"|"fast"|"affected"|"full", reason, base, head, tree,
                     suites: [name], skipped: n, est_seconds, shards, platforms: [os] }
ci_runs (+ columns)        tree TEXT, level TEXT, base TEXT          -- NULL on old rows = full
.ai/ci/<sha>.json (+)      "tree", "level", "base"
team.json  ci: { provider, shards?, required?: bool,
                 full_paths?: [glob], docs_paths?: [glob] }
hosted cache key           rein-ci-ok/<leg name>/<level>/<tree sha>   -- value: empty marker
Required checks (every profile): ci-result, privacy (public), CodeQL (public)
Level order                none < fast < affected < full
```
An old record without `level` is read as `full`, so nothing certified today stops being
certified.

## API / Interface Contracts
- `rein ci plan [--base <ref>] [--json]` — prints the plan; exit 0, or 2 on usage.
- `rein ci run [--full] [--base <ref>]` — runs the plan's level; exit 0 PASS, 1 FAIL, 2 ERROR
  as today. `--full` is today's run.
- `rein ci status [--plans]` — adds the plan and the certifying source; exit codes unchanged.
- `hooks/pre-push.sh` — refuses a tip that is not certified (Component 3) with
  `[PUSH_BLOCKED] <sha> needs level <l> (<reason>) — run: rein ci run`; `rein ci skip --reason`
  stays the recorded escape.
- `rein ci hosted <provider> [--check|--force]` — renders `plan`, `fast`, the matrix and
  `ci-result`; `--check` fails on drift as today.
- Messages: `[PLAN_FALLBACK] <reason>` (the planner fell back to full), `[PLAN_ESCAPE] …`
  (nightly), `[ci] reused <key>` (a leg met by evidence).
- No new environment variable. The label `ci:full` is the only new operator control.

## Security
- **The planner is a gate that can be told to skip.** Its rule is fail-full: every error,
  unknown path and missing input yields `full`. A unit table pins that for each case.
- **A pull request controls its own workflow file and planner** (true today for the workflow).
  Paths that decide the plan (`.github/**`, `src/shared/ci-plan.mjs`, the templates, the
  census baseline, `team.json`) are on the full list, so a change to them is tested in full,
  and the reviewer sees that diff. The residual is unchanged from today: a merged malicious
  workflow. CODEOWNERS and the review stay the control.
- **Evidence is not trusted across the boundary.** The hosted run reads only its own cache;
  a tracked `.ai/ci/<sha>.json` is a contributor's claim and certifies nothing on the runner.
  Cache entries are scoped by GitHub to the branch and its base, so a fork cannot seed the
  trunk's cache.
- **The gate surface is never lowered**: `hooks/**` is on the full list and a `[TIER_3]`
  commit forces a local full run. `security_engineer` reviews Component 3 (it changes what
  the pre-push gate accepts) and `critic_security` follows.
- The `plan` job needs `contents: read`; the trunk-push lookup needs `pull-requests: read`
  and `checks: read`. No write permission, no secret. `ci_gate` before the renderer change;
  `.ai/DEVOPS.md` records the new required set and the rollback.
- macOS leaves the pull request. A macOS-only break reaches the trunk before it is seen; the
  trunk push run and the issue are the control, and a release still runs every leg.

## Execution Constraints
- The planner reads one diff, one log range and one file: under 300 ms, no network.
- The `plan` job adds under a minute to every hosted run; a `none` or `fast` run then ends
  there.
- Targets on Rein: a docs or bookkeeping push — local under 1 minute, hosted under 3; an
  `affected` change touching one module — local under 3 minutes, hosted under 6; `full` — as
  today. Measured, not asserted: `rein ci status --plans` reports them after two weeks.
- An `affected` run is correct only as far as the census footprints are. The baseline must be
  fresh: `[CENSUS_BASELINE_STALE]` past 30 full runs already exists and now also forces
  `full`.
- Hosted cache entries are tiny markers; GitHub evicts them after 7 days unused, which only
  costs a re-run.
- Lanes, memory caps and shard partitioning are unchanged (D-093, D-135).

## Rollback Plan
Each part alone:
- Local: `rein ci run --full` is today's run; setting `ci.smart: false` in `team.json` makes
  the planner return `full` for everything (the one switch, read by all three callers).
- Pre-push: with `ci.smart: false` the gate asks for a full record again. Old records stay
  valid in both directions.
- Hosted: `rein ci hosted --force` on the previous version restores the old workflow; the
  operator restores the old required names in the ruleset. The `ci-result` name can stay
  required meanwhile: the old workflow does not report it, so restore the ruleset first.
- macOS on pull requests: one line in the profile's platform list.
- The new columns are nullable and ignored when unused.

## E-## Task Breakdown
| Task | Tier | Scope | Depends on |
|---|---|---|---|
| E-449 | 2 | Component 1: the planner, `rein ci plan`, the fail-full unit table | — |
| E-450 | 3 | Components 2 and 3: `rein ci run` obeys the plan, `--full`, tree and level in the record, the pre-push sufficiency rule | E-449 |
| E-451 | 2 | Component 4: `plan` and `ci-result` jobs, the plan-driven matrix, platforms, hosted evidence, privacy trigger, required names (`ci_gate`) | E-449 |
| E-452 | 2 | Component 5: the nightly escape audit and `rein ci status --plans` | E-451 |
