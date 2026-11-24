# SEED (session guide)

Purpose: Absolute memory synchronization via `.ai/`.

## Session start

The SessionStart hook injects a brief of at most 2 KB (E-460): the role stamp, the branch,
the role's next five open tasks, the last handoff's heading and one line per anomaly.
Nothing to run; read further files only when a task needs them.

## Token Economics (MANDATORY RULE)
- Do NOT read `.ai/architect.md` at session start — load it only when your task requires it.
- Do NOT read `src/**` unless your task involves a specific file.
- Trust DIGEST.md: it is generated from state at every session start and handover (`rein digest build`); never hand-edit it.

## Task Creation
- All tasks live in `state.sqlite` (primary) and are regenerated to `TASKS.md` / `state.json` automatically.
- To add a task: `mcp__task-synchronizer-mcp__add_task({ prefix, owner, description, tier })`
- Never hand-edit `TASKS.md` — it is overwritten on every mutation.

## Memory Rule
The `.ai/` directory is the FINAL source of truth. `state.sqlite` is the primary store.
Do not depend on session history or external context beyond this seeding.

## Session Stamp
The Stop hook auto-stamps `.ai/SESSION.md`. Manual stamp only if the hook fails.
