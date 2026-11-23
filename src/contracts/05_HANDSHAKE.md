# Handshake (Global)

HARD RULES:
1) Every session begins with the session brief the SessionStart hook injects (E-460):
   the role stamp, the branch, the role's next five open tasks, the last handoff's
   heading and one line per anomaly. There is no preflight step to run; open a
   blueprint when a task names it.

2) Session stamp (.ai/SESSION.md):
   - The Stop hook auto-stamps after every session — only manual-stamp if hook fails.

3) Architect ↔ Engineer handoff:
   - The Architect creates P-## tasks via add_task MCP tool.
   - The Engineer picks up open E-## tasks from TASKS.md.
   - After completing: run_handover({ task_id: "E-##", summary: "..." })
   - Record architectural decisions in .ai/DECISIONS.md.

4) If .ai/ is missing or incomplete: stop and run `rein init` — do not guess.
