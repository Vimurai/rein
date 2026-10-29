# Local CI Blueprint — `ai ci`

> D-072 (2026-09-16). Retires the GitHub Actions workflow (`.github/workflows/test.yml`) and
> moves continuous integration onto the operator's machine. Supersedes D-060 §1's `gh run`
> reading in `ai-task` Step 2.5 and the E-240 "on CI a leak fails" wording (the rule stays,
> the trigger changes). Everything the workflow did is reproduced locally; everything the
> gates read from GitHub is read from a run record in `state.sqlite` instead.

## Goal & Architecture
The project no longer runs CI on GitHub. The two workflow jobs (`test`: bash suite on a fresh
framework install; `unit`: node:test with coverage) become one command, **`ai ci run`**,
that executes the COMMITTED tree in an isolated worktree with a throwaway `$HOME`, records
the outcome as a row the gates can read, and keeps the log. The three things GitHub gave us
that a laptop does not — a clean checkout, a fresh `~/.rein` installed from the commit under
test, and a record nobody can forget to look at — are the three things the runner must
provide. Users: the Engineer (before DONE and before push), the operator (`ai ci status`,
`ai doctor`), and the `update_task_status` completion gate.

## Core Concept
**A CI run is a record about a commit, not a feeling about a working tree.** `ai ci run`
tests a SHA in a `git worktree` (uncommitted files are invisible to it, exactly as
`actions/checkout` was), under `HOME=<tmp>` with `install-rein.sh` run from that SHA, and
writes a `ci_runs` row keyed by the SHA. "CI green" from D-072 on means: *a non-dirty
`ci_runs` row with status PASS exists for this commit.* Unknown is still not green (D-060).

## Components
1. **Runner — `ai ci run [--ref <sha>|HEAD] [--dirty] [--suite-only|--unit-only] [--keep]`**
   (`src/bin/ai`, new `do_ci`). Steps, in order, each printed with its status:
   `worktree` (detached checkout of the ref under `$TMPDIR/rein-ci.<pid>/wt`; `--dirty`
   uses the working tree instead and marks the row `dirty=1`), `env` (curated environment:
   `PATH`, `TMPDIR`, `LANG`, throwaway `HOME`, `REIN_CI=local`; `CI`, `TMUX` and every
   E-264 `LAUNCH_VARS` entry unset; `PLAYWRIGHT_BROWSERS_PATH` and `npm_config_cache`
   pointed at persistent `~/.rein/ci/` caches so isolation does not mean re-downloading),
   `deps` (`npm ci --ignore-scripts` at the root, then the per-server `npm install` loop the
   workflow ran), `browsers` (Chromium via Playwright, cache-hit skip), `install`
   (`bash install-rein.sh` into the throwaway HOME — the mirror under test is built from
   the commit under test, never from the laptop's lagging mirror), `toolchain` (records
   `node --version`, `bash --version`, `patch --version`, `uname`), `suite`
   (`/bin/bash tests/run.sh`, teed to the log), `unit` (`UNIT_COVERAGE=1 bash
   tests/suites/node_unit_test.sh`), `secrets` (`git check-ignore .env node_modules`).
   Overall status PASS only when suite, unit and secrets all pass; any step that cannot
   start is ERROR, not FAIL. The worktree and HOME are removed on exit (`--keep` retains
   them for debugging); the E-240 leak diff runs in the throwaway HOME so a leak there is
   still reported.
   **Per-machine env allow-list (D-108 ruling 9, E-343).** The `env` step also reads
   gitignored `.ai/ci.local.json` `{"env": ["NAME", "NAME=value", …]}`: a bare name is
   passed through from the invoking environment (value never written to file or log), a
   `NAME=value` entry is a literal. Isolation invariants are refused with
   `[CI_ENV_RESERVED]` → ERROR: `PATH`, `HOME`, `TMPDIR`, `SHELL`, `TERM`, `USER`,
   `LOGNAME`, `LANG`, `CI`, `TMUX`, `REIN_*`, `npm_config_*`, `PLAYWRIGHT_*` and every
   E-264 `LAUNCH_VARS` name. The step line lists passed names (`+GOTENBERG_PORT`); the
   `ci_runs` row is unchanged. Hosted wrappers never see the file (gitignored), so hosted
   isolation stays by construction. Origin: bonkraft's Gotenberg port collision, 2026-10-24.
2. **`REIN_CI=local` harness semantics** (`tests/run.sh`, `tests/lib/assert.sh`). A leak
   FAILS the run under `REIN_CI=local` exactly as under `CI=true` (no operator sweeps an
   unattended run). Performance budgets stay HOST-RELATIVE (E-239 ratio, both numbers
   printed): this Mac is not the ubuntu reference host and the absolute budgets were
   calibrated there. `CI=true` and `REIN_PERF_ABSOLUTE=1` keep their current meaning for
   anyone who still has a reference host. The measured numbers are kept in the run record
   so an absolute re-baseline can be decided on data later (deferred, see Constraints).
3. **Run record — `ci_runs`** (`state.sqlite`, via the shared `state-db` owner; migration
   through `skill: ai-migration`). One row per run; the log at
   `~/.rein/ci/logs/<sha>-<started_at>.log`, pruned to the newest 14 runs or 14 days
   (the workflow's artifact retention). Written only by the runner.
4. **Readers — `ai ci status [--ref <sha>] [--short]`, `ai ci list [-n]`, `ai ci log [<sha>]
   [--failed]`, `get_ci_status` (task-synchronizer-mcp), `ai doctor` line.** `status` prints
   the latest row for the ref (default HEAD) and exits 0 on PASS, 1 on FAIL/ERROR/SKIPPED,
   2 when no row exists. `log --failed` prints the failing suites' sections and replaces
   `gh run view <id> --log-failed` in the ENGINEER.md triage rule. `ai doctor` prints
   `✓ local CI: HEAD <sha7> PASS <age>` or `✗ local CI: no run for HEAD — run: ai ci run`.
5. **Gates.** (a) `update_task_status(DONE)` refuses with
   `[CI_GATE] no green local CI run for HEAD <sha7> — run: ai ci run` when the latest
   non-dirty row for HEAD is missing or not PASS. The gate is ACTIVE only in a project that
   has adopted `ai ci` (its `ci_runs` table has at least one row), so a downstream project
   that never ran it is not broken by an upgrade; `REIN_CI_GATE=0` disables it with the
   bypass named in the refusal-free response. (b) `hooks/pre-push.sh`, installed by
   `install_git_hooks` with the same fail-closed stub pattern as `pre-commit` (git-hooks.md
   already reserves `pre-push` and preserves stdin/`"$@"`): for every pushed ref, the tip
   needs a green non-dirty row, OR a green row for an ancestor such that
   `git diff --name-only <tested>..<tip>` touches only `.ai/**` — the bookkeeping commits
   `ai-task` makes after a DONE are never CI'd on their own and must not block a push.
   `REIN_CI_SKIP=1` with `REIN_CI_SKIP_REASON="<text>"` bypasses ONE push and writes a
   `ci_runs` row with status SKIPPED carrying the reason — a skip is recorded, never silent;
   a skip without a reason is refused.
6. **Consumers rewritten.** `ai-task` Step 2.5 injects `ai ci status --ref HEAD --short`
   instead of `gh run list`; the four outcomes (PASS / FAIL / no run / dirty-only) map onto
   the existing "success / failure / pending / unavailable" guidance. ENGINEER.md's triage
   section reads `ai ci log --failed` before forming a theory. `ai-review`, `critic_tests`
   and the `ci_gate` skill name `ai ci` where they named CI. The `devops_engineer` agent,
   `src/contracts/40_DEVOPS.md`, README (badge removed; a "Local CI" section added),
   CONTRIBUTING and the copilot instructions follow. `.github/workflows/test.yml` is deleted;
   the directory goes with it.

## Data Model
```
ci_runs (state.sqlite)
  id            INTEGER PK
  sha           TEXT NOT NULL          -- full commit hash tested (worktree) or HEAD at start (dirty)
  ref           TEXT                   -- what the operator asked for (HEAD, master, a branch)
  branch        TEXT
  dirty         INTEGER NOT NULL DEFAULT 0   -- 1 = working tree; never satisfies a gate
  status        TEXT NOT NULL          -- PASS | FAIL | ERROR | SKIPPED
  started_at    TEXT NOT NULL          -- ISO-8601 T-form (E-261 convention)
  finished_at   TEXT
  duration_ms   INTEGER
  suite_pass / suite_fail / suite_skip / leaked   INTEGER
  unit_status   TEXT                   -- PASS | FAIL | SKIPPED
  unit_coverage TEXT                   -- "83.1% lines" as node:test prints it
  secrets_status TEXT
  node_version / bash_version / patch_version / os   TEXT
  perf_json     TEXT                   -- {suite: {measured_ms, baseline_ms, budget_ms}} from E-239 prints
  skip_reason   TEXT                   -- only for SKIPPED
  log_path      TEXT
INDEX ci_runs_sha ON ci_runs(sha, started_at DESC)
```
`get_ci_status({ sha? })` → the newest row for that sha (default HEAD of the project's
repo) or `{ status: "NONE" }`. TASKS.md is NOT projected from this table; `ai ci status`
is the human view.

## API / Interface Contracts
- `ai ci run` exit codes: 0 PASS, 1 FAIL, 2 ERROR (a step could not start: not a git repo,
  ref unknown, node < 22.5, worktree add failed). A non-zero exit still writes the row.
- `ai ci status` exit codes: 0 PASS, 1 FAIL/ERROR/SKIPPED, 2 no row. `--short` prints one
  line `PASS <sha7> <age> (suite p/f/s, unit PASS, leaked 0)` for injection into skills.
- `update_task_status({status:"DONE"})` new refusal `[CI_GATE] …`; response unchanged
  otherwise. Exempt when `ci_runs` is empty for the project or `REIN_CI_GATE=0`.
- `hooks/pre-push.sh`: stdin `<local ref> <local sha> <remote ref> <remote sha>` lines;
  exit 1 with `[CI_GATE] <ref>: no green local CI run for <sha7> (nearest tested ancestor
  <sha7> differs outside .ai/) — run: ai ci run, or REIN_CI_SKIP=1 REIN_CI_SKIP_REASON=…`.
- `REIN_CI=local` is set ONLY by the runner. A suite may read it; nothing else sets it.

## Security
- The runner executes the repository's own tests — the trust boundary is unchanged from
  the workflow. The throwaway HOME means a run cannot write the operator's real
  `~/.rein/` (telemetry store, mirror, incidents): the E-257 goal holds for CI runs by
  construction, and the mirror byte-identity suites diff against a mirror built from the
  commit under test.
- No credentials are involved; `gh` is no longer required by any gate. The `secrets` step
  keeps the workflow's `.gitignore` check for `.env` and `node_modules`.
- Bypasses are explicit and recorded (`REIN_CI_SKIP` writes a SKIPPED row with a reason;
  `REIN_CI_GATE=0` is named in the refusal). The pre-push stub fails closed when the
  canonical hook is missing, as `pre-commit` does.
- The runner never runs `git push`, `git commit` or touches the operator's working tree
  except to read it under `--dirty`.

## Execution Constraints
- Wall clock: the full suite is 4,690 assertions across 135 files; the Engineer measures the
  first real `ai ci run` and records the duration in LOG and the row. If it exceeds ten
  minutes, a follow-up task (not this arc) parallelises suites — D-072 does not fund it.
- Persistent caches under `~/.rein/ci/` (npm, Playwright browsers) keep repeat runs to
  suite time; the first run downloads Chromium once per Playwright version.
- One run at a time per project: a lock file in `~/.rein/ci/` refuses a concurrent run
  with exit 2 (two runs would race on tmux sockets and ports the suite binds).
- The runner uses `/bin/bash` (3.2 on macOS) for the suite, the shell users have; the
  recorded `bash_version` makes any divergence from the old 5.2 runner visible.
- Linux coverage is LOST: three real defects (E-230) reproduced only on ubuntu. Mitigations
  are the E-236 `skip_unless_*` helpers (an unmet requirement is a SKIP, never a pass) and
  the recorded toolchain. `ai ci run --linux` (the same runner inside a `node:22` Docker
  container) is DEFERRED until Docker is available on the operator's machine — E-258 shows
  the sandbox probe failing 935/935 times, so funding it now would ship a mode nobody can
  run. Recorded as an open risk in D-072.

## Rollback Plan
- The workflow file stays in git history; `git revert` of E-268's deletion commit restores
  GitHub CI unchanged. Branch protection on GitHub is an operator setting and is removed by
  the operator, not by code.
- `REIN_CI_GATE=0` disables the DONE gate; `REIN_CI_SKIP=1` + reason bypasses one push;
  removing `.git/hooks/pre-push` disables the push gate entirely.
- `ci_runs` has a down-migration (drop table + index); the runner writes nowhere else than
  `~/.rein/ci/` and that table. Deleting `~/.rein/ci/` is safe and stateless.
- `REIN_CI=local` semantics are additive: with the variable unset, `run.sh` and `assert.sh`
  behave exactly as today.

## E-## Task Breakdown
- **E-265** — Runner + harness semantics (Component 1, 2). `ci_gate` skill first (DEVOPS.md
  entry), then `ai ci run`.
- **E-266** — Run record and readers (Component 3, 4): migration, `state-db` helpers,
  `ai ci status/list/log`, `get_ci_status`, doctor line, log retention.
- **E-267** — Gates and consumers (Component 5, 6a): DONE gate, `pre-push.sh` with the
  bookkeeping-ancestor rule and recorded skips, `ai-task` Step 2.5, ENGINEER.md triage,
  `ai-review`/`critic_tests` wording, derived `agent.json` rebuilt.
- **E-268** — Decommission GitHub Actions (Component 6b): delete the workflow, README,
  CONTRIBUTING, `ci_gate`, `devops_engineer`, contracts, copilot docs, template mirrors.
  Acceptance grep: `gh run|GITHUB_ACTIONS|actions/workflows|workflows/test.yml` returns
  nothing under `src tests hooks .claude README.md CONTRIBUTING.md ENGINEER.md ARCHITECT.md`.

Queue position: after E-255 merges and BEFORE E-256 (E-256's README rewrite lands on the
badge-free README). E-263's BREAKING list gains "GitHub Actions workflow removed; CI runs
locally via `ai ci`". From D-072 on, the phrase "CI green" in E-256..E-264's acceptance
means a green non-dirty `ai ci run` row for the commit; until E-266 lands it means a green
`ai ci run` (E-265) and, before that, a green `bash tests/run.sh` with `LEAKED 0`.
