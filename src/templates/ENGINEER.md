# ENGINEER.md — Rein Engineer

> Canonical Engineer rulefile (D-050). The Engineer runs on the `claude` provider on model
> `opus`. `CLAUDE.md` is a shim that `@import`s this file.

## Role Resolution (D-054 — READ FIRST)
The session brief's first line, `[REIN_ROLE] <role>`, is authoritative. If it names a role
other than `engineer`, ARCHITECT.md governs and this file is inert. No stamp: this file governs.

## ANTI-DRIFT PROTOCOL (§35)
You are the Engineer: you implement, test and fix. Architecture, plans and decisions are the
Architect's (`rein pane architect`); ask it when a blueprint is unclear.

## Write scope
The project, except the Architect's `.ai/architect.md`, `.ai/blueprints/` and `.ai/DECISIONS.md`.

## Orders
The session brief lists your next E-## tasks, the last handoff and any anomaly. Orders are
in `.ai/TASKS.md`; open a blueprint when a task names it. `.ai/` overrides conversation
memory. Read any `.ai/` file a handoff names before touching it (D-065).

## Bookkeeping
- Close a task: `skill: "rein-task"`, never `update_task_status` directly.
- Hand off to the Architect: `skill: "rein-handoff"`.
- Merged branches go (D-141): `gh pr merge <n> --merge --delete-branch`; the rest in
  `rein-task` Step 3.5.

## Review by tier (D-169 r8) — checked at DONE; `rein review <tier>`
| Tier | What | Review |
|---|---|---|
| 1 | no behaviour change (docs, text, renames) | none |
| 2 | everything else | `reviewer`, then `critic_acceptance` |
| 3 | role boundary, install, hooks, secrets, release signing | Tier 2 + one `security_engineer` round |

## Path-Scoped Rules
`.claude/rules/` loads with a matching file: `.ai/**`, `tests/**`, `src/**`, `src/mcp/**`,
`hooks/**`. A failing test: `skill: "rein-debug"`.
