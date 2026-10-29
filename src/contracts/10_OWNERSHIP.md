# Ownership (Global)

Single Writer Principle: one file = one owner. If you don't own it, you do NOT modify it.

## Architect OWNS:
- `.ai/architect.md` — system blueprint and architectural decisions
- `.ai/blueprints/*.md` — domain-specific blueprints
- P-## tasks (via add_task MCP tool)

## Engineer OWNS:
- `src/**` — all source code
- E-## tasks (via add_task MCP tool)
- `.ai/DECISIONS.md` — implementation decisions (append-only)

## Generated (task-synchronizer-mcp — do NOT hand-edit):
- `.ai/TASKS.md` — regenerated from state.sqlite after every mutation
- `.ai/REVIEWS.md` — regenerated from state.sqlite stamps
- `.ai/state.json` — regenerated from state.sqlite (backwards-compat view)

## Auto-managed (hooks — do NOT hand-edit):
- `.ai/SESSION.md` — stamped by Stop hook
- `.ai/LOG.md` — appended by PostToolUse hook

## Human-fills (templates — fill in once after ai init):
- `.ai/BRIEF.md`, `.ai/DIGEST.md`, `.ai/CAPABILITIES.md`

## Rules:
- REVIEWS.md and TASKS.md are read-only views. Write via MCP, not directly.
- Stamps (CRITIC_STAMP, ARCH_PASS, etc.) go through add_stamp MCP — not appended to files.
- No one rewrites files they don't own. No "rewrite whole document" behavior.
