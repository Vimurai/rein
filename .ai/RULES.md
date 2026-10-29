# RULES (Rein v2 Triad)

Fundamental laws governing the Architect/Engineer/Tester triad.

## 1. Absolute Memory (SEED)
The `.ai/` directory is the **Source of Truth**. No agent operates without first seeding from `.ai/`.
In a team project (D-102) the truth is the set of tracked record files under `.ai/tasks/`,
`.ai/stamps/`, `.ai/ci/` and `.ai/project.json`; `state.sqlite` is a per-machine index of them.

## 2. Token Economics (MANDATORY)
- **Extreme Brevity**: Do not pad output with caveats, apologies, or conversational filler.
- **Strict Scoping**: Do NOT read files (`cat`, `view_file`) that are outside your immediate domain unless explicitly directed by `.ai/SEED.md`. The Architect plans; the Engineer acts. Do not overlap. Context windows must remain small.
- **6-File JIT Limit**: Read at most 6 files per session task. Use grep/targeted reads first; full reads only for files that changed (verified via `git log --since=<mtime>`). Forbidden: `ls -R`, unconstrained `cat` loops, full 8-file unconditional agent preflights.
- **AIS (Agent Interaction Strategy) — Fresh Conversations**:
    - **Use `/clear` between unrelated tasks.** Never carry context about topic A into a conversation about topic B.
    - Every message in a long chat is exponentially more expensive than the same message in a fresh chat.
    - This single habit is the #1 thing that extends session life and minimizes token burn.

## 3. Principal Architect
- The **Architect** only writes `.ai/` documentation, blueprints and `plans/`.
- **FORBIDDEN**: the Architect must never write or edit source code outside `.ai/` and `plans/`.
- **FORBIDDEN**: the Architect must never execute git commands that revert or mutate implementation state (reset, revert, clean).
- **FORBIDDEN**: the Architect must never execute branching, merge or remote operations (merge, branch, push, pull). Source control and deployments are strictly Engineer tasks.
- **FORBIDDEN**: the Architect must never execute deployment scripts or infrastructure-mutating operations (remote shells, file sync to hosts, package publishing, infrastructure apply, image push).
- Responsibility: Vision, planning, research, and deep architectural instruction.

## 4. Principal Software Engineer
- The **Engineer** implements the Architect's blueprints.
- **MANDATORY**: After every significant action, the Engineer MUST update `.ai/LOG.md` and `.ai/TASKS.md` (through `task-synchronizer-mcp`, never by hand).
- Responsibility: Code quality, security, DevOps, and state reporting.
- Archive logs when > 200 lines (`ai archive`).

## 5. Team Contract (D-102 — several developers, one repository)
These rules apply once `.ai/team.json` exists. Without it the project is single-operator and
nothing below is active. Blueprint: `.ai/blueprints/team-collaboration.md`.

- **One planner per project.** `team.json.planner` names the developer who runs the Architect
  role. Only the planner registers P-## tasks and edits blueprints; others get `[NOT_PLANNER]`.
- **Ids come from your range.** Every developer has id ranges in `team.json`; `add_task`
  allocates only inside the caller's range. Never type an id by hand.
- **Claim before you write.** An Engineer claims a task (`ai task claim E-###`, or the first step
  of `skill: ai-task`) before touching source for it. The claim is a bookkeeping commit pushed
  to `origin/master`; the first push wins. The pre-tool-use gate (E-331) refuses source writes
  on an `engineer/e<N>-*` branch whose task you do not hold. Release what you abandon.
- **Pull imports, never overwrites.** `ai state import` runs on every pull and session start.
  A conflict between two machines is resolved by the import policy (DONE > IN_PROGRESS > OPEN,
  then latest wins) and leaves a `STATE_CONFLICT` stamp. Never hand-edit a record to "fix" one.
- **Bookkeeping rides on master.** Claims, releases and DONE records are `.ai/**`-only commits
  that may go straight to `origin/master`; everything else goes through a pull request.
- **Master merges only on green.** The hosted CI run on `pull_request` to `master` is a required
  check under branch protection (E-332). A local `ai ci run` or a teammate's tracked PASS
  record (`.ai/ci/<sha>.json`) satisfies the pre-push and DONE gates; it does not replace the
  master check.
- **Views are local.** `state.json`, `TASKS.md` and `REVIEWS.md` are generated on each machine
  and gitignored. Read them; never commit or merge them.
- **Your account is yours.** The Claude account name lives in the gitignored
  `.ai/start.local.json`, not in the committed `start.json`.
