---
paths:
  - ".ai/**"
---

# .ai/ bookkeeping (D-062 / E-238)

- **Never move bookkeeping with `git stash`.** To carry `.ai/state.json`, `TASKS.md` or
  `REVIEWS.md` between branches, commit on the branch, then `git cherry-pick`. On 2026-09-09 a
  conflicted `stash pop` left conflict markers in `.ai/state.json`; the file was staged
  without being opened and master carried invalid JSON for four commits.
- **After ANY conflicted operation, open every conflicted file before `git add`.** Stage named
  paths — `git add -A` after a conflict is how markers reach a commit.
- **`TASKS.md` and `REVIEWS.md` are generated views.** Change tasks through
  `task-synchronizer-mcp` (`add_task`, `update_task_status` via `skill: rein-task`) or
  `rein add-task`, and stamps through `add_stamp` — a hand edit is overwritten by the next
  regeneration.
- **Read any `.ai/` file a handoff names before touching it** (D-065). Blueprints,
  `architect.md` and `DECISIONS.md` are Architect-owned.
