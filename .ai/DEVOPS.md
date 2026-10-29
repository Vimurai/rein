# DEVOPS (Append-only — CI/CD and pipeline change log)

---

## DEVOPS-001 — Bootloader Fallback CI Validation (E-2)

**Date**: 2026-04-14
**Task**: E-2
**Status**: PENDING IMPLEMENTATION

### What is changing and why
A new test suite `tests/suites/resilience_test.sh` will be created to validate the Bootloader's three-layer degradation mechanism (per `.ai/blueprints/bootloader.md` §3):

1. **Simulated Node Failure test** — Temporarily renames/chmods `src/mcp/orchestrator-mcp/index.js` to simulate a crash, then asserts the system falls back to the `ai-exec` CLI layer reading `.ai/state.json`.
2. **Fallback Verification test** — Asserts JIT read requests successfully return data via the secondary fallback path (Python/Bash parsing of `state.json`).
3. **State Integrity test** — After simulated crash + recovery, runs `PRAGMA integrity_check;` against `.ai/state.sqlite` and diffs against `state.json` to assert zero corruption.

No existing CI workflow files are being created or modified at this time. The test suite is a standalone shell script; wiring into a GitHub Actions workflow is a separate future task.

### Security implications
- **No new secrets required.** Tests operate on local filesystem only; no network access.
- **No new permissions.** The `chmod` in the simulated-failure test is scoped to a non-sensitive test fixture and must be reverted by the test teardown.
- **SQLite access is read-only** in the fallback path per the blueprint constraint (§2): fallback scripts MUST only execute read-only queries unless using `BEGIN EXCLUSIVE TRANSACTION` with `PRAGMA synchronous = FULL`.
- **No CI secrets exposure.** Test output must be scrubbed of any file paths that could leak internal directory structure before being logged to CI artifacts.

### Pipeline order enforced
The resilience test suite will be positioned after `lint` and `typecheck` but before `build`:
1. `lint`
2. `typecheck` (if applicable)
3. `test` (unit + **resilience**)
4. `build`
5. `deploy` (protected branches only)

### Rollback plan
- Delete `tests/suites/resilience_test.sh`. No other files are modified by E-2.
- If the test is later wired into CI, remove the workflow step referencing it. The test is additive-only and has no side effects on production code.

### Branch strategy
- Implement and validate on the current branch (`master`) before merging. Run `bash tests/suites/resilience_test.sh` locally to confirm PASS before any commit.

---

## DEVOPS-002 — Install framework in CI before tests

**Date**: 2026-05-27
**Status**: IN PROGRESS

### What is changing and why
`.github/workflows/test.yml` runs `bash tests/run.sh` against a bare checkout
with **no framework install**, so `~/.ai-os/` never exists in CI. ~12 assertions
across 5 suites (telemetry, insights_staleness, meta_analyst,
multi_variation_state_tracker, standards_checker) assert byte-identity via
`diff -q "$SRC" "${HOME}/.ai-os/..."` and fail with exit 2 (file missing). A
further ~16 assertions (managed_agents_sync_hook, state_projector_sync,
installer_node_check) depend on the installed/dev environment. CI has been
chronically red on every push as a result. **All 28 failures pass locally**
where `~/.ai-os/` is present.

**Fix:** add an `Install AI-OS framework` step that runs `bash install-ai-os.sh`
**before** `Run tests`, populating `~/.ai-os/` from `src/` so the mirror +
install-dependent suites have their expected environment. The installer is a
non-interactive thin copier; `install_global()`'s failure-prone parts
(`gh copilot`, `do_mcp_setup`) are guarded with `|| true`/`|| echo`, so it does
not abort under `set -e`.

### Security implications
- **No new secrets.** Installer is local file copy + npm install (deps already
  installed by the existing CI step). No network beyond npm (already present).
- **No new permissions.** Runs as the unprivileged GitHub runner user; writes
  only under `$HOME` (ephemeral runner).
- **No CI secrets exposure.** Installer output is build log only; no tokens.

### Pipeline order enforced
1. deps (`npm ci` + per-MCP `npm install`)
2. **install (`bash install-ai-os.sh`)** ← new, before tests
3. `test` (`bash tests/run.sh`)
4. secret-gitignore check (unchanged)

### Rollback plan
- Revert the single added step in `.github/workflows/test.yml` (delete the
  `Install AI-OS framework` step or `git revert` the commit). The change is
  additive and isolated to the workflow file — no source or test changes.
- If the installer step itself breaks CI, removing the step returns the suite
  to its prior (red mirror) baseline with no other regression.

### Branch strategy
- Validate on branch `ci/install-framework-before-tests` first (never modify
  master CI blindly). Push, watch the Actions run on the branch, iterate on any
  residual failures (notably the `bash --posix` installer re-exec assertion,
  which may be a separate ubuntu-bash portability issue), then merge to master.

---

## DEVOPS-003 — Bump GitHub Actions to v5

**Date**: 2026-05-27
**Status**: IN PROGRESS

### What is changing and why
`actions/checkout@v4` and `actions/setup-node@v4` run on Node.js 20, which
GitHub flagged as deprecated. The runner will force Node.js 24 by default
from **2026-06-02**, after which the v4 actions emit warnings (and risk
forward-compat issues). v5 of both actions ships native Node 24 support
and is a drop-in replacement — same inputs, same behaviour. Bump to:

- `actions/checkout@v4` → `actions/checkout@v5`
- `actions/setup-node@v4` → `actions/setup-node@v5`

### Security implications
- **No new secrets.** No new permissions. Both actions are first-party
  (`actions/*`) and pinned by major version, consistent with the existing
  pinning style.
- Both v5 releases are official GitHub Actions releases; no supply-chain
  posture change vs the prior v4 pin.

### Pipeline order enforced
Unchanged — only the action versions are bumped:
1. deps (`npm ci` + per-MCP `npm install`)
2. install (`bash install-ai-os.sh`)
3. test (`bash tests/run.sh`)
4. secret-gitignore check

### Rollback plan
- One-line revert of the two `uses:` pins back to `@v4`, or `git revert`
  the commit. Additive-equivalent change; no other files touched.

### Branch strategy
- Validate on branch `ci/bump-actions-v5`; merge only after the branch's
  PR run is fully green.

---

## DEVOPS-004 — Universal Telemetry Hook Wiring (E-105)

**Date**: 2026-06-02
**Task**: E-105
**Status**: IN PROGRESS

### What is changing and why
`hooks/post-tool-use.sh` currently does AQG-only (re-runs `tests/run.sh`
when Write/Edit touches `src/**`). Per `.ai/blueprints/universal-telemetry.md`
§Components 2, it must also record every tool execution into
`~/.ai-os/telemetry.sqlite` via the new `telemetry.mjs --record-tool` CLI
shipped in E-104. Today telemetry sees ~1% of tool activity because only
`mcp-router::proxy_call` is instrumented (incident logged 2026-06-01,
signature `src/mcp/mcp-router/index.js:proxy_call_only_instrumentation`).

**Change**: append a backgrounded telemetry block to `post-tool-use.sh`.
The block translates Claude Code's PostToolUse JSON (`tool_name` + nested
`tool_response.isError` / `tool_response.duration_ms`) into the
blueprint's flat CLI schema and pipes it to
`telemetry.mjs --record-tool`. Spawned with `&` + `disown` + stderr/stdout
redirected to `/dev/null` so the hook returns within budget even when
telemetry is slow.

### Security implications
- **No new secrets.** No new network access. Helper writes only to
  `~/.ai-os/telemetry.sqlite` (already in scope per E-84).
- **No new permissions.** `node` invocation only; locator chain mirrors
  E-58 (`src/shared/telemetry.mjs` → `${HOME}/.ai-os/shared/telemetry.mjs`).
- **PII**: `telemetry.mjs` already hashes `project_root` (sha256, 12 hex)
  and the hook never forwards `tool_input`/`tool_response` payload bodies
  — only the three blueprint fields (`tool_name`, `execution_time_ms`,
  `status`).
- **Fail-open**: `AI_TELEMETRY_DISABLE=1` short-circuits the helper.
  Hook continues even if `node` is absent or the helper is missing.

### Pipeline order enforced
Hook-level change; CI pipeline order unchanged.
1. deps (`npm ci`)
2. install (`bash install-ai-os.sh`)
3. test (`bash tests/run.sh`)  ← telemetry_test.sh extended with hook-integration assertions
4. secret-gitignore check

### Execution constraints
- Hook overhead budget: **<50ms** (blueprint §Execution Constraints).
  Achieved by background detach — telemetry write happens off the hot path.
- AQG behavior preserved verbatim: telemetry block is appended AFTER the
  existing AQG logic, never replacing or short-circuiting it.

### Rollback plan
- **Per blueprint §Rollback**: revert `~/.ai-os/hooks/post-tool-use.sh` to
  the AQG-only version (`git checkout HEAD~1 -- hooks/post-tool-use.sh`
  then re-install).
- Set `AI_TELEMETRY_DISABLE=1` system-wide to pause data collection
  without touching the hook.
- The change is additive — the AQG block is byte-identical to its
  pre-E-105 form. Hook-level removal of the telemetry block restores the
  prior behavior.

### Branch strategy
- Local validation on `master`: run extended `tests/suites/telemetry_test.sh`
  + `tests/run.sh` to verify (a) hook-integration assertions pass and (b)
  AQG still locks on test failures unchanged. Hook overhead measured via
  `time` wrapper around a sample invocation.

---

---

## DEVOPS-005 — Make master green again + node:test job (E-230, D-060 §1)

**Date**: 2026-09-09
**Task**: E-230
**Status**: IN PROGRESS (validated on branch `engineer/e230-ci-green` via PR before master)

### Correction to the record

E-230's task text says "this repo has NO CI configuration". That is **false**, and so was
my own earlier statement to the same effect (repeated three times, including in commit
`1257fa6`). `.github/workflows/test.yml` has existed and run since at least 2026-08-04.
D-060 corrected me. Root cause of my error: `ls .github/workflows/` failed because `ls` is
aliased to `eza`, which rejected the trailing slash, and my `|| echo "(no …)"` fallback
printed the negative — I read a **tool error** as a **negative result**. The lesson is
recorded here because it caused three sprints to "verify on CI" against a CI nobody looked
at, while master was red.

### What is changing and why

Master has been RED since 2026-09-07 (first failure: the D-054 merge; last green:
2026-08-04, PR #35). Five suites failed. None of them was a product bug — all five were
defects in the tests or in test observability:

1. `meta_analyst`, `seo_manager`, `seo_content_generator` — asserted that
   `~/.ai-os/gemini/agents/*.md` is **byte-identical** to `src/`. It is not, by design:
   `strip_gemini_agent_fields` removes `disable-model-invocation`, `user-invocable` and
   `allowed-tools`, which Gemini CLI v0.37+ does not support. The assertion passed only on
   a developer machine whose `~/.ai-os` predated the strip. Replaced with
   "identical modulo the stripped keys" plus a check that the strip actually ran, so the
   weaker assertion cannot pass on an untransformed copy.
2. `pane_binding` E-208.08i — asserted `ls` exits **1** for a missing path. GNU coreutils
   exits **2**; BSD/macOS exits 1. The test encoded the mac value and had therefore never
   passed on Linux. Replaced with `compgen -G` (a bash builtin, same result everywhere)
   and the fixture was made hermetic: it previously globbed the shared system temp dir two
   levels up, where an unrelated suite's stray file could fail this **security** assertion
   or mask a real escape.
3. `propose_patch_apply` — failed with "0 passed, 1 failed" and **no output at all**, so it
   was undiagnosable from the CI log. Two masking defects: `tests/lib/mcp-client.sh` sent
   the MCP server's stderr to `DEVNULL`, and `extract_id`'s `grep` exited 1 under
   `set -euo pipefail`, killing the suite mid-assignment before any assertion could report
   the server's reply. Both fixed; the client now prints the server's stderr tail and the
   exit reason. The underlying Linux-only cause is not yet known and will be named by the
   next CI run rather than guessed at.

Additions per D-060 §1: a second job running the `node:test` unit layer with
`UNIT_COVERAGE=1`; `patch --version` printed in the log so the E-221 patch driver modes are
evidenced under GNU patch 2.7; the run log uploaded as an artifact; a README badge.

### Security implications

None. No new secrets, no new network access, no new permissions. The workflow keeps
`--ignore-scripts` on all installs. `actions/upload-artifact` publishes the test log, which
contains only test output — no credentials are echoed by the suite. Both jobs remain
read-only with respect to the repository and run under the default `GITHUB_TOKEN`.

### Rollback plan

Revert the workflow file to its previous revision; the second job is additive and can be
deleted independently of the fixes to the test suites. The test-suite corrections are
independent of the workflow and stand on their own. `git revert` of this branch's merge
restores the prior (red) state exactly.

### Branch-first validation

Per this gate, the change is NOT pushed to master directly. It goes to
`engineer/e230-ci-green` and is opened as a PR; `on: pull_request: branches: [master]`
runs the full workflow there. Master is only updated once that run is green.

---

## DEVOPS-006 — Playwright browsers out of the default install (E-235, D-061 §3)

**Date**: 2026-09-09
**Task**: E-235
**Status**: IN PROGRESS (validated on branch `engineer/e235-browsers-out-of-install` via PR)

### What is changing and why

`ai mcp-setup` ran `npx playwright install chromium` unconditionally, inside the path that
`install-ai-os.sh` — and therefore every user install and every CI run — depends on. It is
an unbounded ~150MB network fetch. On 2026-09-09 it ran for **over an hour** on a developer
machine without finishing.

The `|| true` that wrapped it gave no protection at all: the failure mode is **hanging**,
not erroring, and you cannot `|| true` your way out of a process that never returns. That
is the specific reason this needed a real change rather than better error handling.

Three parts:

1. The download leaves the default path. Opt in with `ai mcp-setup --browsers`, or
   `AI_OS_INSTALL_BROWSERS=1` to restore the old behaviour exactly.
2. When it does run, it is **bounded and visible** — a watchdog enforces
   `AI_OS_BROWSER_TIMEOUT` (default 600s) and progress is no longer swallowed by
   `tail -2`. `timeout(1)` is not present on macOS by default, so the limit is enforced
   with a watchdog rather than assumed: a timeout that silently is not applied is worse
   than none, because it is believed.
3. Missing browsers now fail FAST at first use with `[BROWSER_MISSING]` and the one command
   that fixes it, instead of Playwright's installation essay or a hang.

### CI

The workflow installs browsers in an **explicit, cached** step so the vibe suites still
run. Cached on the Playwright version from the lockfile, so it is a download once per
version rather than once per run. The step is `continue-on-error: false` — if browsers are
meant to be there, a failure to install them should be visible rather than surface later as
a puzzling suite failure.

### Security implications

None new. No new secrets, no new permissions. The change REDUCES what the default install
fetches from the network: the Playwright CDN is no longer contacted during `ai install`,
which is a strict reduction in install-time network surface and makes an air-gapped or
proxied install viable where it previously stalled.

### Rollback plan

`AI_OS_INSTALL_BROWSERS=1` restores the old install-time download. `ai mcp-setup
--browsers` performs it on demand. `AI_OS_SKIP_BROWSER_CHECK=1` bypasses the first-use
probe for an operator whose browser lives somewhere unusual. Reverting the workflow hunk
restores the previous CI behaviour independently of the CLI change.

### Branch-first validation

Per this gate, not pushed to master directly: the change goes up as a PR so
`on: pull_request` exercises the new cached browser step before master moves.

---

## DEVOPS-007 — Local CI runner `ai ci run` (E-265, D-072)

Blueprint: `.ai/blueprints/local-ci.md` §Components 1-2. First task of the D-072 arc.

### What is changing and why

The operator is retiring GitHub-hosted CI (D-072). This task adds the local replacement
**beside** the workflow; the workflow itself is deleted later, in E-268, so there is never
a window with no CI at all.

- `ai ci run [--ref <sha>|HEAD] [--dirty] [--suite-only|--unit-only] [--keep]` tests a
  COMMITTED sha in a detached `git worktree` under a private temp dir, with a throwaway
  `HOME` and `TMPDIR`, in an `env -i` environment (so `CI`, `TMUX` and every inherited
  launch variable are absent by construction). `--dirty` checks out HEAD and overlays the
  working tree's changes, so the operator's own checkout is only ever read.
- Steps mirror the workflow: worktree → env → deps → browsers → install → toolchain →
  suite → unit → secrets. Setup steps that fail are ERROR (exit 2); a failing suite, unit
  layer or secrets check is FAIL (exit 1); PASS is exit 0.
- `AI_OS_CI=local` (set only by the runner): a leak fails the run as under `CI=true`;
  performance budgets stay host-relative.
- Caches (`npm`, Playwright browsers) and logs live under `~/.ai-os/ci/`; a per-project
  lock there refuses a concurrent run with exit 2.

### Security implications

No new secrets, no new permissions and no network access beyond what the workflow already
used (npm registry, Playwright CDN). The run executes the repository's own tests, the same
trust boundary as the workflow. The throwaway `HOME` keeps a run from writing the
operator's real `~/.ai-os/` (mirror, telemetry, incidents) or shell rc files.

### Rollback plan

The command is additive: nothing calls it yet (gates arrive in E-267), and the GitHub
workflow is untouched by this task. Reverting the commit removes it; `rm -rf ~/.ai-os/ci`
removes its caches, logs and locks. `AI_OS_CI=local` semantics are inert when the variable
is unset.

### Branch-first validation

Built on `engineer/e265-local-ci-runner` and exercised by the still-present GitHub workflow
on the PR, plus a first real `ai ci run` on the branch head whose duration is recorded in
LOG.md.

---

## DEVOPS-008 — Local CI gates: DONE and pre-push (E-267, D-072)

Blueprint: `.ai/blueprints/local-ci.md` §Components 5-6a.

### What is changing and why

The `ci_runs` record (E-266) becomes evidence two gates act on:

- `update_task_status(DONE)` refuses with `[CI_GATE]` unless HEAD has a green non-dirty run,
  or descends from one and differs from it only under `.ai/`. Active only once the project
  has recorded a run. **Deviation, flagged for the Architect:** §5a names HEAD strictly; the
  ancestor rule from §5b is applied here too, because `ai-task` marks DONE on the merge or
  bookkeeping commit, which is never CI'd on its own — HEAD-only would refuse every DONE.
- `hooks/pre-push.sh` (installed by `install_git_hooks` as a fail-closed stub, chained to
  any existing hook with stdin preserved) applies the same rule per pushed tip.
  `AI_OS_CI_SKIP=1` + `AI_OS_CI_SKIP_REASON` bypasses one push and records a SKIPPED row.
- `ai-task` Step 2.5 reads `ai ci status --ref HEAD --short` instead of `gh run list`;
  ENGINEER.md triage reads `ai ci log --failed`.

### Security implications

No new secrets or network access. The bypass variables are environment variables, and the
project's `.claude/settings.json` `env` block reaches a hook's environment (E-223): a
project could pre-set a permanent skip. The mitigation is that every skip is written as a
SKIPPED row with its reason and printed on every push, and a SKIPPED row never satisfies the
DONE gate. Flagged for review. A missing canonical, helper or node fails the push closed.

### Rollback plan

`AI_OS_CI_GATE=0` disables the DONE gate; `rm .git/hooks/pre-push` removes the push gate
(`ai uninstall` now says so — the stub fails closed once `~/.ai-os` is gone); reverting the
commit restores `gh run` in `ai-task`.

### Branch-first validation

`engineer/e267-ci-gates`; the push of this branch is itself the first live pre-push check.

---

## DEVOPS-009 — GitHub Actions decommissioned (E-268, D-072)

Blueprint: `.ai/blueprints/local-ci.md` §Component 6b. Last task of the runner arc.

### What is changing and why

`.github/workflows/test.yml` is deleted. Its two jobs have been reproduced by `ai ci run`
since E-265, its record by `ci_runs` since E-266, and its "nobody may merge red" rule by the
E-267 gates — so the workflow was the second description of a pipeline nobody would read.
Every surface that pointed at a hosted run now points at `ai ci`: README (badge removed, a
Local CI section added), CONTRIBUTING, the `ci_gate` skill (its injected context is the local
verdict, not a workflow `find`), `src/contracts/40_DEVOPS.md`, the `devops_engineer` agent,
the copilot brief, and `browser_optin_test` (the browser-cache assertions now read the
runner's `browsers` step). The CHANGELOG carries the BREAKING line for E-263.

### Security implications

None new. One capability is LOST rather than added: the hosted runner was the only thing
testing on Linux, and `ai ci run --linux` is deferred until Docker exists on this machine
(D-072 open risk). The recorded toolchain per run and the E-236 SKIP accounting are the
interim mitigation — and a Node-22-only defect (E-266's `ExperimentalWarning`) already proved
the gap is real: it surfaced ONLY on the hosted runner, because local CI runs Node 26.

### Rollback plan

`git revert` of this commit restores the workflow unchanged (the file stays in git history).
Branch protection on GitHub is an operator setting; it must be removed by the operator, or a
required check that can never report will block merges.

### Branch-first validation

`engineer/e268-decommission-actions`. This is the LAST branch whose PR a hosted run can
check; from here on the evidence is `ai ci run` and the `pre-push` gate.

---

## DEVOPS-010 — The hosted master check (E-332, E-335; D-102 §5b as amended by D-103)

Blueprint: `.ai/blueprints/team-collaboration.md` §Component 5b. Partially reverses D-072 /
DEVOPS-009 for `master`; branches stay local-first. (E-332's task text said "DEVOPS-008";
that id was already E-267's gate entry — D-103 r7 ratified this one.)

### What is changing and why

A team needs one authority for "nobody merges red into `master`" that no single laptop
provides (D-102 alternative 5), and AI-OS projects live on GitHub, Azure DevOps and other
providers (D-103). So the hosted check is a **contract**, not a pipeline:

- (a) trigger: a pull request into `master` (MUST); a push to `master` touching anything
  outside `.ai/**` gets an audit run that gates nothing (SHOULD);
- (b) exactly two run steps: bootstrap AI-OS, then `ai ci run` on the merge result the
  provider checked out — no command of the local recipe is copied into a wrapper;
- (c) artefacts on every outcome: the run log (`~/.ai-os/ci/logs/`) and `.ai/ci/*.json`,
  kept ≥ 14 days;
- (d) read-only repository token, no secrets referenced;
- (e) a Linux image with Node 22 — the floor, and the project's only Linux coverage;
- (f) the runner is not a `team.json` member, so its record is reviewer evidence, not a
  PASS the local gates accept.

Each provider's wrapper is **rendered** by `ai ci hosted [<provider>] [--check] [--force]`
from `src/templates/ci/<provider>.*` (E-335) — `.github/workflows/ci.yml` in this repository
is the `github` rendering, byte for byte. The bootstrap is chosen at render time: here,
`bash install-ai-os.sh` from the checked-out sha (the code under test); downstream, a clone of
`team.json.ci.aios_source` at the tag in `project.json` `aios_version`, then its installer.
`tests/unit/hosted-ci-workflow.test.mjs` holds every template to (a)-(e) in both variants and
diffs its run steps against `_ci_run`'s command list (DEVOPS-009's drift lesson).
Providers: GitHub (E-332, E-335) and Azure Pipelines (E-336) in 4.1.0; GitLab and Bitbucket
(E-337) once a documented run exists — `[CI_PROVIDER_PLANNED]` until then.

### Branch policy — one rule for every provider (D-103 r5)

The check is required for MERGES into `master`; direct pushes stay open to team members,
because the pre-push gate (D-072 §5a) already limits those pushes to `.ai/**` and
`claim_task` (E-331) needs them. No provider can scope a push exemption to paths, so the
setting has the same shape everywhere; `ai ci hosted` prints it for the chosen provider, and
E-334's README carries the per-provider table. The audit run (a) makes a bypassed code push
visible after the fact.

### Security implications

No secrets in any wrapper (asserted for every template); read-only token; `pull_request`, never
`pull_request_target`; the GitHub checkout does not persist credentials. The run executes the
PR's own code — the same trust boundary as `ai ci run` on a reviewer's machine, minus the
reviewer's HOME. A downstream bootstrap clones a pinned TAG of a plain-https source
(`team.json` validates it; the renderer refuses anything else), never "latest". New network
access: hosted runner → npm registry, the Playwright CDN, and (downstream) the AI-OS source.

### Rollback plan

Delete the rendered wrapper and the provider's required-check policy — that restores D-072
exactly for that project (D-103 Rollback). Removing the file without the policy leaves a
required check that never reports and blocks every merge, so the operator does both.
`team.json.ci` may stay; `ai doctor` then reports the wrapper missing. Reverting E-335 leaves
E-332's hand-written workflow working unchanged.

### Branch-first validation

`engineer/e332-hosted-master-ci`, PR #109: the first hosted run failed 36 Linux-only rows
(none had run on Linux since E-268); after the fixes, run 39466256224 PASSED on merge commit
69abc8f (5795/0/11). A Docker container (`node:22-bookworm` + procps/time/rsync/sqlite3,
`LANG=C.UTF-8`, `--cpus 2`) reproduced the runner closely enough to iterate on single suites.

---

## DEVOPS-011 — Azure Pipelines wrapper, shipped UNVERIFIED (E-336, D-103 r5-r6)

Blueprint: `.ai/blueprints/team-collaboration.md` §Component 5b. Second provider of the
DEVOPS-010 contract.

### What is changing and why

AI-OS projects ship on Azure DevOps (operator, 2026-10-19). `ai ci hosted azure` renders
`azure-pipelines.yml` from `src/templates/ci/azure-pipelines.yml` — the same two commands as
the GitHub wrapper (bootstrap, then `ai ci run` on the merge result), held to the same contract
test with Azure-specific clauses:

- `pr: master` — the PR trigger for GitHub- or Bitbucket-hosted repositories. **For Azure
  Repos, YAML `pr:` is ignored**: PR validation comes only from the branch policy below.
- `trigger: master` with `paths: exclude: ['.ai/*']` — the audit run (contract a, SHOULD).
- `pool: vmImage: ubuntu-latest`, `NodeTool@0` 22.x — Linux + Node 22 (contract e).
- `checkout: self` with `fetchDepth: 0` (suites pin past commits) and no persisted credentials.
- Two `PublishPipelineArtifact@1` steps with `condition: always()` — the run log and
  `.ai/ci` (contract c; the second is `continueOnError`, since a non-team project has no
  `.ai/ci`). Azure does not expand `$HOME` in a task input, so `ai ci run` prints
  `##vso[task.setvariable variable=AI_OS_CI_LOG_DIR]<dir>` when `TF_BUILD=True` (Azure's own
  marker; inert elsewhere) and the artefact step reads `$(AI_OS_CI_LOG_DIR)`. The wrapper keeps
  exactly two commands.

The operator has no Azure DevOps project available before 4.1.0 (2026-10-22), so per the
task's fallback the template ships and `ai ci hosted azure` writes it but prints
`[CI_PROVIDER_UNVERIFIED]`, until a documented run flips it to ready.

### Branch policy (D-103 r5 — the same rule as every provider)

Project settings → Repositories → the repo → Policies → Branch policies → `master`:
**Build Validation** with this pipeline, *Required* (this is what makes it the merge gate on
Azure Repos); the team's group granted **"Bypass policies when pushing"** on the repository so
claim commits (`.ai/**`, E-331) can push to `master`. An optional Build Validation path filter
`!/.ai/*` skips bookkeeping-only PRs. Trade-off, as on GitHub: a bypassing push of code is
stopped only by the developer's pre-push gate (D-072 §5a) and made visible by the audit run.

### Security implications

No secrets and no `$(System.AccessToken)` in the wrapper (asserted). Azure's job token scope is
a PROJECT setting, not YAML: the operator should keep "Limit job authorization scope to current
project" on and grant the build service read on the repository only — documented here because
the wrapper cannot enforce it. Keep "Protect access to repositories in YAML pipelines" on;
for a GitHub-hosted repository keep "Make fork builds have the same permissions as regular
builds" off. Fork PRs do not receive secrets by default. A step's output can issue `##vso`
logging commands (the suite's own output included), so the wrapper sets
`target: settableVariables`: none for the bootstrap, only `AI_OS_CI_LOG_DIR` for the run.
The `##vso` line carries a path derived from `$HOME` with `\r`/`\n` stripped; it sets one
variable the wrapper reads.

### Rollback plan

Delete `azure-pipelines.yml`, the pipeline and the Build Validation policy (D-103 Rollback).
The `TF_BUILD` line in `ai ci run` is inert outside Azure; reverting E-336 removes it.

### Branch-first validation

`engineer/e336-azure-pipelines`: the contract test, mutants and a dev.azure.com fixture run
locally. **No hosted Azure run yet** — this entry and LOG.md get the pipeline URL and verdict
when one exists; until then the provider is UNVERIFIED by design.

## DEVOPS-012 — Per-machine environment allow-list for `ai ci run` (E-343, D-108 r9)

### What changes and why

`ai ci run` starts its steps from `env -i` with a curated environment (DEVOPS-007), so a
project whose suite needs one machine's differences — bonkraft's Gotenberg on :3101 instead of
:3000 (409 on 2026-10-24) — had no place to say so except the isolation itself. The run now
reads gitignored `.ai/ci.local.json` `{"env": ["NAME", "NAME=value", …]}` from the operator's
checkout **before the worktree is created**: `NAME=value` is a literal, a bare `NAME` passes the
invoking shell's value through (absent = skipped with a note). The env step line lists the
added names (`env ok HOME=… AI_OS_CI=local +GOTENBERG_PORT`). The `ci_runs` row and schema are
unchanged; the hosted wrappers (D-103) never see the file. The secrets step additionally checks
that an AI-OS project (one whose worktree carries `.ai/`) ignores `.ai/ci.local.json`;
`ai sync`'s generated-artefact block adds the line.

### Security implications

- Reserved names are refused with `[CI_ENV_RESERVED] <name>` and the run is ERROR (exit 2):
  `PATH HOME TMPDIR SHELL TERM USER LOGNAME LANG CI TMUX`, `AI_OS_*`, `npm_config_*`,
  `PLAYWRIGHT_*` and every E-264 launch variable (`ai_ci_run_test.sh` fails when the two lists
  drift). The allow-list can add variables, never weaken the run's isolation.
- A pass-through value is never written to the file or the log (asserted); only names are
  printed. A literal may hold a value the operator chose to write — hence the gitignore line
  and the secrets-step check.
- No new network access, permissions or environment variable of AI-OS's own.

### Rollback plan

Delete `.ai/ci.local.json` (the run returns to the curated environment). Reverting E-343
removes `_ci_local_env`, the env-step note and the secrets-step line; no record changes.

### Branch-first validation

`engineer/e343-ci-env`: `ai_ci_run_test.sh` E-343.* (literal and pass-through reach
tests/run.sh under `env -i`, the value never in the log, reserved names ERROR before the
worktree, malformed JSON / non-array ERROR, the secrets step), `sync_prune_test.sh` E-343.01;
`ai ci hosted github --check` still current; a real `ai ci run` on the branch tip.

## E-378 (D-129) — the public repository's privacy gates — 2026-10-28

**What changes and why.** Vimurai/rein is developed in public from its first commit, so two
gates keep the operator's personal data out of it:
1. `hooks/pre-commit.sh` gains a privacy step that runs only where `.ai/publish.json` exists
   (the public repository; the private clone has none). It scans the STAGED blobs with
   `publish-scan.mjs precommit` — the five classes with the operator's gitignored list, the
   structural ones without it — and, on the operator's machine, requires the commit author and
   committer to be the public identity in `publish.json`. No env opt-out (E-291); fail closed
   when node or the helper is missing.
2. `.github/workflows/privacy.yml` (template `src/templates/public/privacy.yml`, placed by the
   bootstrap): `node src/shared/publish-scan.mjs scan-tree .` on every push and pull request.
   The hosted master check (`ci.yml`, D-103) is unchanged; it is re-rendered for `main` after
   the first push (`ai ci hosted github --force`).

**Security implications.** No secrets, no new tokens: `permissions: contents: read`,
`persist-credentials: false`, actions limited to `actions/checkout@v5` and
`actions/setup-node@v4`. The CI job never sees the operator's list (it is gitignored); it
checks the structural classes and the tree. Findings print class and file:line, never values.

**Rollback.** Delete `.github/workflows/privacy.yml` (and its required-check entry in the
branch protection); the pre-commit step is inert without `.ai/publish.json`.

**Proof.** Unit rows in `tests/unit/publish-scan.test.mjs` (E-378: staged blobs through the
real git boundary, identity refusal, contributor mode, fail-closed list, placement outside the
opt-out); `ai_ci_test` E-268.01a admits `privacy.yml` only where `publish.json` exists; a real
`ai ci run` inside a one-commit copy of the bootstrap snapshot.

## DEVOPS-013 — Hosted CI at the runner's width: lanes by host, census baseline, shards (E-386, D-135 r1–r3, r6) — 2026-10-29

**What changes and why.** A hosted `ai ci run` on Rein took 15.5 min using 2 of 4 cores, then a
serial tail of 13 suites (5 of them only for "no measured installer footprint": a fresh runner
has no census log). Changed (`.ai/blueprints/ci-throughput.md` §Components 1–3, 5):
1. `ai ci run` lane default: every core on a hosted runner (`GITHUB_ACTIONS`, `TF_BUILD`,
   `GITLAB_CI`, `BITBUCKET_BUILD_NUMBER`, else `CI=true`), `min(4, cores/2)` on a laptop; both
   still clamped by `tests/run.sh`'s memory cap; an explicit `--lanes` unchanged.
2. `tests/census-baseline.tsv` (committed): `tests/run.sh` reads wall hints and installer
   footprints from the newest local CI log, else the baseline, else none, and prints which
   (`Lane: hints: …`). `ai ci run` writes it into the project tree after a full, unsharded,
   committed PASS when the committed one is missing or older than 30 full runs (not after every
   run — a constantly rewritten tracked file would keep the tree dirty and each commit of it
   would need a run of its own). The pre-push hook and `ai doctor` print
   `[CENSUS_BASELINE_STALE] <n>`; never a block.
3. `tests/run.sh --shard i/N` / `ai ci run --shard i/N`: a deterministic partition
   (`tests/tools/shard-plan.mjs`); the unit layer and the budget on shard 1 (its full_seconds
   and peaks recorded as `-`); `ci_runs.shard` (nullable) — a shard row never certifies, is
   reported `SHARD i/N`, and is never written as a team record `.ai/ci/<sha>.json`.
4. `[ci] resources` gains `exclusive_seconds=` (the serial tail) and `host=` (`local` /
   `hosted:<provider>`); `ai ci status` prints the exclusive share. `runner=` keeps its meaning
   (the summary format), since recorded rows and three suites parse it.

**Security implications.** No secrets, no network, no permissions. The hosted markers are read
from the invoking environment before `env -i`; they are in the E-343 reserved set, so
`.ai/ci.local.json` cannot claim "hosted". The baseline is scheduling data: a hostile row can
slow a run, never change a verdict — every suite still runs in exactly one shard (asserted).
The writer drops rows naming an absolute path and reduces `foreign:<path>` to `foreign`, so the
file carries no host paths; the privacy scan covers it like any tracked file.

**Rollback.** Each lever alone: the lane default is one expression in `_ci_run`; delete
`tests/census-baseline.tsv` (and the fallback branch in `_wall_hints_load`) for `hints: none`;
`--shard` is unused unless passed; the `shard` / `exclusive_seconds` columns are nullable and
ignored when unused.

**Proof.** `tests/unit/shard-plan.test.mjs` (synthetic census: every suite in exactly one shard
for N = 1..20, deterministic, unit layer pinned); `census.test.mjs` (baseline writer);
`ci-runs.test.mjs` (a shard never certifies — self, ancestor, team record; `census-stale`);
`harness_isolation_test` E-386.B/S/X (hint sources, shards 1..3 = one full run's totals,
refusals); `ai_ci_test` E-386.H (host lanes, `host=`); a real `ai ci run` on the branch tip.
