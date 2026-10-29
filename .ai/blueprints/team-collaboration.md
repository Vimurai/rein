# Team Collaboration — Shared `.ai/` Memory Across Developers (D-102)

> Blueprint for running one AI-OS project with several developers on several machines
> sharing one git repository. Ruled D-102 on 2026-10-18 from the team-readiness audit
> (COMM.md handoff 2026-10-18). Supersedes the single-operator assumptions in D-072
> (CI on the operator's machine — master only), D-095 (one operator, several accounts)
> and the sqlite-as-truth model of `database-integrity.md` / `drift-resolution-2026.md`.
> Amended 2026-10-19 by D-103: Component 5b is a provider-neutral hosted-check contract
> (GitHub + Azure DevOps in 4.1.0; GitLab + Bitbucket after), rendered by `ai ci hosted`.

## Goal & Architecture

**Problem.** The framework is built for one operator. Each clone's gitignored
`.ai/state.sqlite` is the only source of truth; the tracked `state.json`, `TASKS.md` and
`REVIEWS.md` are one-way projections rewritten after every mutation and never read back
after a `git pull`. With two developers this loses tasks silently, mints duplicate
E-### ids, lets two Engineers execute the same OPEN task, flips archived rows in and out
of the tracked view, and keeps CI proof on one machine (audit, COMM.md 2026-10-18 19:03).

**Who uses it.** A team of developers each running their own Triad (Architect + Engineer
panes) on their own machine, pushing to one remote. One developer is the designated
planner (Architect role) per project; everyone runs the Engineer.

**Summary.** Git is the only transport: project memory becomes one small tracked file per
record, sqlite becomes a per-machine cache rebuilt from those files, a reconciler imports
them on every pull, ids come from per-developer ranges, and a task must be claimed on
the trunk (`origin/<trunk>`) before an Engineer may touch source for it.

> **D-105 (2026-10-23).** Every `origin/master` / `master` below means the project's
> TRUNK: `team.json` `trunk` when set, else `origin/HEAD`, else the one of `main`/`master`
> that exists on origin (`src/mcp/shared/trunk.mjs`, `ai trunk`). `master` is this
> repository's trunk; no code path or template may name it as a literal (E-341).
> **D-106 (2026-10-23).** Component 2's import on pull also runs in legacy mode (no
> `team.json`), per record from `HEAD:.ai/state.json`, and view regeneration is refused
> with `[STATE_BEHIND_HEAD]` while the index is behind HEAD (E-342).
> **D-108 (2026-10-24).** An index with zero tasks and no `last_import_blob` is UNSEEDED:
> `getDbSeeded` imports `HEAD`'s document for it exactly as for a missing file, and every
> first-opener path (orchestrator `readState`, `run-handover.mjs`, archive-manager,
> context-guardian, propose-patch, `record-migrate.mjs`) opens through `getDbSeeded`. The
> ruling-4 guard treats "empty against a populated HEAD" as behind; without git the
> missing-row auto-fix is refused with `[EMPTY_STATE_DB]`. `ai doctor` recommends
> `ai state import` ahead of `ai migrate-state` whenever HEAD holds tasks (E-344).

**Decisions taken by the operator (2026-10-18, "plan them all"):** git-as-the-bus (no
shared service); hosted CI returns for `master` only; one designated planner per project.

## Core Concept

**The record store.** `.ai/` holds one JSON file per record under `.ai/tasks/`,
`.ai/stamps/`, `.ai/ci/`, plus `.ai/project.json` and `.ai/team.json`. A record carries
`rev`, `updated_at` and `origin` (the writer's git email). Git merges files that differ by
name without conflict, so two developers conflict only when they change the same record.
`state.sqlite` is an index of those files: the task-synchronizer writes the file first,
then the row, and any divergence is resolved **from the file**. `state.json`, `TASKS.md`
and `REVIEWS.md` become generated, gitignored views (still human-readable, still the
emergency fallback, never merged).

**Claims live on the trunk (`origin/<trunk>`, D-105).** A claim is a bookkeeping-only commit to
`.ai/tasks/<id>.json` pushed to the trunk. The first push wins; a non-fast-forward
rejection means someone else holds it. Reading claims needs a fetch, not a merge.

## Components

### Component 1 — Record store and single writer (E-325)
- `src/mcp/shared/record-store.mjs`: `readRecord`, `writeRecord` (atomic rename, `rev+1`,
  `updated_at`, `origin` from `git config user.email`), `listRecords(kind)`,
  `rebuildIndex(db)` (sqlite from files), `renderViews()` (state.json, TASKS.md, REVIEWS.md).
- `task-synchronizer-mcp` and `orchestrator-mcp run_handover` become the only writers and
  route every mutation through `writeRecord` → sqlite → `renderViews()`.
- Removed direct writers: `hooks/post-commit.sh` `Fixes E-##` block (now calls
  `ai task done <id>`, which calls the same library) and `src/mcp/shared/state-writer.js`.
- `ai state migrate --team` (one-shot): explodes `state.json` + `.ai/archive/state-done-*.json`
  into record files, writes `.ai/team.json`, adds the three views to `.ai/.gitignore`,
  stamps `project.json.schema = 2`. Idempotent; refuses on a dirty worktree.
- Legacy projects (no `.ai/tasks/`) keep the v1 behaviour untouched until migrated.

### Component 2 — Reconciler: import on pull (E-326)
- `ai state import`: for every record file, compare `rev`/`updated_at` with the sqlite row.
  File newer → row updated. Row newer and file unchanged since last import → file rewritten
  (local mutation not yet committed). Both changed → conflict policy: DONE beats
  IN_PROGRESS beats OPEN; otherwise latest `updated_at` wins; every resolution prints one
  `[STATE_CONFLICT] <id> kept <side>` line and writes a `STATE_CONFLICT` stamp.
- Triggered by git hooks `post-merge`, `post-checkout`, `post-rewrite` (installed by
  `ai sync` as stubs like pre-commit) and by `hooks/session-start.sh`.
- Replaces pre-commit `check_markdown_sync` (count ±2) with `record ↔ sqlite` parity and
  replaces `verify_markdown_sync` so it never deletes a pulled task from the view.
- The last import's git HEAD is stored in sqlite (`project.last_import_head`), so the
  import is a no-op when HEAD has not moved.

### Component 3 — Team registry, id ranges, planner (E-327)
- `.ai/team.json` (tracked):
  `{ "schema": 1, "planner": "<email>", "claim_ttl_days": 7, "shared_log": false,
     "members": { "<email>": { "ranges": { "E": [[325, 424]], "P": [[45, 64]] } } } }`
- `nextId(prefix)` returns the lowest unused id inside the caller's ranges (caller =
  `git config user.email`); `[ID_RANGE_MISSING]` / `[ID_RANGE_EXHAUSTED]` are rejections.
  Without `team.json` the v1 `max+1` path stays (single-operator projects unchanged).
- `ai team add <email> --range E:425-524` appends ranges without overlap (checked).
- `ai pane architect` prints a one-line warning when the git email is not the planner;
  `add_task` with prefix `P` is refused for non-planners with `[NOT_PLANNER]`.

### Component 4 — Claims and the claim gate (E-331; trunk resolution E-341, D-105)
- Trunk: every `origin/master` in this component is `origin/<trunk>` resolved by
  `resolveTrunk(root)` (`team.json` `trunk` → `origin/HEAD` → `main`|`master`); unresolvable
  → `[NO_TRUNK] <reason>` on every path, appended to `[CLAIM_REQUIRED]` so the gate is never
  a silent lock. The framework never runs `git remote set-head`; `ai doctor` prints
  `[TRUNK_UNSET]` / `[TRUNK_MISMATCH]`.
- Task fields: `assignee` (email), `claimed_at`, `claim_sha`; status gains `IN_PROGRESS`.
- MCP tools `claim_task(id)` / `release_task(id)`; CLI `ai task claim|release <id>`;
  `skill: ai-task` gains `claim` as its first step and `release` on abandon.
- Claim protocol: fetch `origin/master`; refuse `[CLAIM_HELD] <id> by <email> since <date>`
  when the record there is claimed by someone else and younger than `claim_ttl_days`;
  else write the record, commit `chore(.ai): claim <id>` on a detached bookkeeping commit
  on top of `origin/master`, push to `master`; on non-fast-forward print `[CLAIM_LOST]`,
  re-fetch, report the holder. Release and DONE clear the claim the same way.
- Visibility: `session-start.sh` fetches `origin/master` (bounded, offline-tolerant) and
  the preflight banner lists `IN_PROGRESS` tasks with their holders.
- Engineer claim gate in `hooks/pre-tool-use.sh`: a `Write`/`Edit`/`Bash` write outside
  `.ai/` on a branch named `engineer/e<N>-*` is refused with `[CLAIM_REQUIRED] E-<N>`
  unless E-<N> is claimed by this user (local record or `origin/master`). Inactive without
  `team.json`; `AI_OS_CLAIM_GATE=0` disables with a telemetry row.

### Component 5 — Portable CI evidence and hosted master CI (E-328, E-332)
- `.ai/ci/<sha>.json` (tracked): `{ sha, verdict, suites, tests, started, finished,
  runner: <email>, host, aios_version }` written by `ai ci run` beside the sqlite row.
- `checkCiDoneGate` and `hooks/pre-push.sh` accept a PASS record for the sha from any
  team member when `team.json` exists; the local sqlite row is no longer required.
- **5b — the hosted check contract (D-103, provider-neutral).** AI-OS projects ship on
  GitHub, Azure DevOps and other providers, so the hosted `master` check is a contract,
  not a GitHub workflow: (a) trigger — a pull request targeting `master` (MUST), plus a
  push to `master` touching anything outside `.ai/**` (SHOULD, an audit run that gates
  nothing); (b) exactly two run steps — bootstrap AI-OS, then `ai ci run` on the merge
  result the provider checked out; no local-recipe command is copied into the wrapper;
  (c) artefacts on every outcome — the run log and `.ai/ci/*.json`, kept ≥ 14 days;
  (d) least privilege — read-only token, no secrets; (e) Linux image with Node 22;
  (f) the runner is not a `team.json` member, so its record is reviewer evidence, not a
  PASS the local gates accept. Local `ai ci run` stays the pre-push gate; D-072's
  local-first rule stays for branches.
- **Rendered wrappers (E-335).** `src/templates/ci/<provider>.*` + `ai ci hosted
  [<provider>] [--check] [--force]` render the wrapper at the provider's canonical path
  (`.github/workflows/ci.yml`, `azure-pipelines.yml`, `.gitlab-ci.yml`,
  `bitbucket-pipelines.yml`); `--check` fails when the file differs from the rendering
  (sha256) and `ai doctor` reports it. Bootstrap variant chosen at render time: in the
  AI-OS repo `bash install-ai-os.sh` from the checked-out sha; downstream, clone
  `team.json.ci.aios_source` at the tag in `project.json.aios_version` and run its
  installer. Provider detected from the `origin` host (GitHub, Azure DevOps cloud, GitLab,
  Bitbucket) or given explicitly; unknown hosts → `[CI_PROVIDER_UNKNOWN]`. The
  equivalence test (`tests/unit/hosted-ci-workflow.test.mjs`) runs over every template.
- **Branch policy, one rule everywhere (D-103 r5).** The check is required for MERGES
  into `master`; direct pushes stay open to team members on every provider because the
  pre-push gate (D-072 §5a) limits them to `.ai/**` and claims (E-331) need them. Per
  provider: GitHub — required status check, pushes not restricted; Azure DevOps — Build
  Validation policy + "Bypass policies when pushing" for the team group; GitLab — protected
  branch, developers may push and merge, "pipelines must succeed"; Bitbucket — merge check
  "minimum one successful build", no "prevent changes without a pull request".
  `ai ci hosted` prints the setting for the chosen provider.
- **Providers.** GitHub Actions (E-332, hand-written first, adopted as the `github`
  template) and Azure Pipelines (E-336) in 4.1.0; GitLab CI and Bitbucket Pipelines
  (E-337) after a documented run exists — `[CI_PROVIDER_PLANNED]` until then.

### Component 6 — Stamps bound to a commit (E-329)
- Stamp record gains `sha` (HEAD when stamped) and `author`.
- Pre-commit Gate 2 requires a `CRITIC_STAMP` whose `sha` equals the commit's parent HEAD
  (bookkeeping-only `.ai/**` commits exempt); the seven-day window is removed.

### Component 7 — Archive in git (E-330)
- `archive_done_tasks` moves record files to `.ai/tasks/archive/<YYYY-MM>/` (tracked);
  the gitignored `.ai/archive/` keeps only LOG/SESSION rotation. `nextId` and the views'
  archive pointer read the tracked directory.

### Component 8 — Per-user overrides and shared log (E-333)
- `.ai/start.local.json` (gitignored) overrides `account`; `ai init` writes `start.json`
  without an account key; `ai pane` reads the override first.
- `team.json.shared_log: true` routes `ai-log` to `.ai/log/<email-localpart>.md`
  (tracked); default stays the gitignored `LOG.md`.
- `.ai/RULES.md` §3/§4 stale vendor text is replaced by role names (Architect-owned, P-45).

### Component 9 — Docs and release (E-334)
- README "Team setup" section (`ai state migrate --team`, `ai team add`, claim flow,
  `ai ci hosted <provider>` and the per-provider branch-policy table of Component 5b),
  CHANGELOG `4.1.0 — Team` with the migration note, blueprint index.

## Data Model

```
.ai/team.json            { schema, planner, claim_ttl_days, shared_log, members{email→ranges},
                           ci?: { provider: github|azure|gitlab|bitbucket, required_check, aios_source? } }
.ai/project.json         { schema:2, focus, current_tier, release_verdict, aios_version, rev, updated_at, origin }
.ai/tasks/E-325.json     { id, owner, status: OPEN|BLOCKED|IN_PROGRESS|DONE, tier, description,
                           depends_on[], created_at, completed_at, summary,
                           assignee, claimed_at, claim_sha, rev, updated_at, origin }
.ai/tasks/archive/2026-10/E-300.json   (same shape, DONE only)
.ai/stamps/2026-10/<sha7>-<type>-<seq>.json  { task_id, type, agent, summary, sha, author, created_at, rev, origin }
.ai/ci/<sha>.json        { sha, verdict: PASS|FAIL|SKIPPED, suites, tests, started, finished, runner, host, aios_version }
state.sqlite             tasks / stamps / ci_runs (index, rebuilt from files) + project.last_import_head
generated, gitignored    state.json, TASKS.md, REVIEWS.md
```

Invariants: a record's filename equals its `id`; `rev` is monotonic per record; `origin`
is the writer's git email; DONE records are immutable except via `reopen`; a task in
`IN_PROGRESS` has a non-empty `assignee`; `seq` (task rowid, stamp id at write time) is
monotonic per `origin`, and rebuild order is per-origin `seq` with monotone-repaired
`created_at` between origins — never wall clock first (D-111 r1, E-348; a 14 h clock jump
on 2026-10-23 reordered the regenerated view).

## API / Interface Contracts

- `claim_task({id})` → `{ id, assignee, claimed_at, claim_sha }` | `[CLAIM_HELD]` |
  `[CLAIM_LOST]` | `[OFFLINE]` (no remote reachable: claim recorded locally as
  `pending`, refused for the gate until pushed).
- `release_task({id, reason?})` → `{ id, status: OPEN }`.
- `add_task` unchanged, plus `[ID_RANGE_MISSING]`, `[ID_RANGE_EXHAUSTED]`, `[NOT_PLANNER]`.
- `update_task_status` accepts `IN_PROGRESS`; DONE clears the claim.
- `ai state import [--dry-run]` prints one line per changed record and one per conflict;
  exit 0 always (never blocks a pull), `[STATE_CONFLICT]` lines are also stamped.
- `ai state migrate --team | --legacy` one-shot, refuses on a dirty worktree.
- `ai team add <email> --range <P>:<from>-<to>`; `ai team show`.
- `ai ci run` additionally writes `.ai/ci/<sha>.json`; `ai ci status <sha>` reads either source.
- `ai ci hosted [<provider>] [--check] [--force]` → writes the wrapper + `team.json.ci`,
  prints the provider's branch-policy setting; exit 1 on `--check` mismatch;
  `[CI_PROVIDER_UNKNOWN]` (host not recognised, no argument), `[CI_PROVIDER_PLANNED]`
  (gitlab / bitbucket before E-337), `[WRAPPER_DIFFERS]` (existing file, no `--force`).
- Hooks: `post-merge`, `post-checkout`, `post-rewrite` call `ai state import`; pre-tool-use
  claim gate returns `[CLAIM_REQUIRED] <id>` through the existing SAFE_EXEC block channel.

## Security

- Trust boundary is the git remote: a record's `origin` and a CI record's `runner` are
  as trustworthy as the commit author. The provider's branch policy with the required
  hosted check on `master` is what prevents a red MERGE; a direct code push is stopped by
  the developer's own pre-push gate and recorded by the audit run (D-103 r5); local
  gates are convenience. The hosted runner has no team identity: its `.ai/ci/<sha>.json`
  is evidence for a reviewer, never a PASS a teammate's DONE or pre-push gate accepts.
- Wrappers reference no secrets and request a read-only token; a downstream project's
  bootstrap clones AI-OS at the pinned tag, never a moving branch.
- No secrets enter records: `team.json` holds emails and ranges only; `start.local.json`
  holds the account name, never a token; `.ai/ci/*.json` holds no log text, only counts.
- The role token (`role-token.mjs`, per-machine HMAC) is unchanged; it never crosses git.
- The claim gate is enforced in `pre-tool-use.sh` like the Architect write gate (E-129
  pattern) — the model's cooperation is not required.
- `git push` from `claim_task` targets `master` with a bookkeeping-only commit; the
  pre-push CI gate's `.ai/**`-only exemption (D-072 §5a) applies, nothing else is pushed.
- `critic_security` reviews E-326 (hooks running on every pull) and E-328 (gate + push).

## Execution Constraints

- `ai state import` must finish under 300 ms for 500 records (one directory read, one
  sqlite transaction); it runs on every pull and session start.
- `session-start.sh` fetch of `origin/master` is bounded to 3 s and skipped offline;
  preflight never blocks on the network.
- A claim push is one small commit; `claim_task` is bounded to 10 s end-to-end.
- Record files are written with write-temp-then-rename; concurrent local sessions
  (Architect + Engineer panes) keep sqlite WAL as the local lock.
- Views are regenerated at most once per mutation (existing `regenerateViews` cadence).
- Migration is one-shot and refuses on a dirty worktree so the before/after is one commit.

## Rollback Plan

- `ai state migrate --legacy` folds `.ai/tasks/**`, stamps and project.json back into one
  `state.json`, removes the view entries from `.ai/.gitignore`, and deletes `team.json`
  after printing it; sqlite is rebuilt from the folded file.
- Each gate has its kill switch, recorded in telemetry: `AI_OS_CLAIM_GATE=0`,
  `AI_OS_STATE_IMPORT=0` (hooks become no-ops), `AI_OS_CI_GATE=0` (existing).
- The hosted wrapper is one rendered file per project; deleting it and the provider's
  required-check policy restores D-072 exactly (D-103). Reverting E-335 leaves the
  hand-written E-332 workflow working unchanged.
- Per-component revert: components are shipped as separate commits behind the
  `schema: 2` marker in `project.json`; a v1 project (no `.ai/tasks/`) is never touched.

## E-## Task Breakdown

| Task | Component | Tier | Depends on |
|---|---|---|---|
| E-325 | 1 Record store, single writer, `ai state migrate` | 3 | — |
| E-326 | 2 Reconciler + pull hooks, sync-check replacement | 3 | E-325 |
| E-327 | 3 team.json, id ranges, planner rule | 2 | E-325 |
| E-328 | 5a Portable CI records, gates accept team PASS | 2 | E-325 |
| E-329 | 6 Stamps bound to sha, Gate 2 | 2 | E-325 |
| E-330 | 7 Archive in git | 1 | E-325 |
| E-331 | 4 Claims, IN_PROGRESS, claim gate, ai-task claim | 3 | E-326, E-327 |
| E-332 | 5b GitHub wrapper as built, equivalence test, DEVOPS-010 (D-103 r7) | 2 | E-328 |
| E-333 | 8 start.local.json, shared log opt-in | 1 | E-327 |
| E-335 | 5b Hosted check contract: templates, `ai ci hosted`, provider detection, test over all templates (D-103 r1-4) | 2 | after E-332 (sequenced in COMM, not a DAG edge) |
| E-336 | 5b Azure Pipelines template, DEVOPS-011, documented Azure DevOps run (D-103 r5-6) | 2 | E-335 |
| E-337 | 5b GitLab CI + Bitbucket Pipelines templates (after 4.1.0, D-103 r6) | 1 | E-335 |
| E-334 | 9 README Team setup (incl. `ai ci hosted` + policy table), CHANGELOG 4.1.0, release | 2 | E-329, E-330, E-331, E-332, E-333, E-335, E-336 |
| P-45 | Team Contract in RULES.md, stale vendor text (Architect) — DONE 2026-10-19 | 1 | — |

Order of value: E-325 → E-326 → E-327 → E-331 stop the overlap and the data loss;
E-328/E-332/E-335/E-336 make "green" shared on the providers the team uses; the rest are
integrity and convenience. E-337 follows 4.1.0.
