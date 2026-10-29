# SEED (Preflight guide)

Purpose: Absolute memory synchronization via `.ai/`.

## Preflight (MANDATORY — every session)

Run the preflight skill at session start — do NOT manually read files:
```
skill: "ai-preflight"
```
The skill calls `orchestrator-mcp::run_preflight()` which reads DIGEST.md + TASKS.md
and queries state.sqlite for task counts, focus, and unread deltas.

## Token Economics (MANDATORY RULE)
- Do NOT read `.ai/architect.md` during preflight — load it only when your task requires it.
- Do NOT read `src/**` unless your task involves a specific file.
- Trust DIGEST.md. If it is stale (preflight will warn you), run `skill: "ai-digest"` first.

## Task Creation
- All tasks live in `state.sqlite` (primary) and are regenerated to `TASKS.md` / `state.json` automatically.
- To add a task: `mcp__task-synchronizer-mcp__add_task({ prefix, owner, description, tier })`
- Never hand-edit `TASKS.md` — it is overwritten on every mutation.

## Memory Rule
The `.ai/` directory is the FINAL source of truth. `state.sqlite` is the primary store.
Do not depend on session history or external context beyond this seeding.

## Session Stamp
The Stop hook auto-stamps `.ai/SESSION.md`. Manual stamp only if the hook fails.
