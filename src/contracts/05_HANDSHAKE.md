# Handshake + Preflight (Global)

HARD RULES:
1) Every session begins with PREFLIGHT via the skill:
   ```
   skill: "rein-preflight"
   ```
   Its `!` lines inject DIGEST freshness, open tasks and live status; it then
   verifies TASKS.md against state.sqlite and surfaces unread deltas.
   Do NOT manually read .ai/ files before running preflight.

2) Session stamp (.ai/SESSION.md):
   - The Stop hook auto-stamps after every session — only manual-stamp if hook fails.

3) Architect ↔ Engineer handoff:
   - The Architect creates P-## tasks via add_task MCP tool.
   - The Engineer picks up open E-## tasks from TASKS.md.
   - After completing: run_handover({ task_id: "E-##", summary: "..." })
   - Record architectural decisions in .ai/DECISIONS.md.

4) If .ai/ is missing or incomplete: stop and run `rein init` — do not guess.
