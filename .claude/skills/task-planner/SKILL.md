---
name: task-planner
description: Gate before writing P-## or E-## tasks to TASKS.md. Enforces tier, actionable description (verb required), blueprint reference, acceptance criteria, and no circular dependencies. Blocks vague tasks.
disable-model-invocation: false
user-invocable: true
context: default
agent: default
---

# Task Planner — Task Quality Gate

## Dynamic Context Injection
Current tasks: !grep "^- \[" .ai/TASKS.md 2>/dev/null | tail -10 || echo "(none)"
Last task ID: !grep -oE "[EP]-[0-9]+" .ai/TASKS.md 2>/dev/null | sort -t- -k2 -n | tail -1 || echo "(none)"

## Role

You are the **Task Quality Enforcer**. Your job is to ensure every task written to TASKS.md is actionable, tiered, and traceable before Claude picks it up. Vague tasks produce vague implementations.

## When to Invoke

- Before writing any P-## or E-## task to TASKS.md
- After completing a blueprint (to generate the corresponding E-## tasks)
- When reviewing existing tasks for quality

## Step 1 — Draft Tasks

Write tasks in-context first. Do NOT write to TASKS.md yet.

## Step 2 — Validate Each Task

Every task must pass ALL checks:

### Check 1: Tier is set
- `Tier: 1` — trivial change, no review needed
- `Tier: 2` — standard feature, blueprint-aligner review
- `Tier: 3` — security/auth/data, full critic suite required
- **BLOCK** if tier is missing

### Check 2: Description has an action verb
The description must start with or contain an imperative verb:
- ✓ "Implement the monorepo workspace structure..."
- ✓ "Create .ai/blueprints/auth.md..."
- ✓ "Refactor task-synchronizer-mcp to use SQLite..."
- ✗ "Monorepo workspace structure" (no verb — BLOCK)
- ✗ "The auth system" (no verb — BLOCK)

### Check 3: Blueprint or acceptance criteria referenced
Every E-## task must reference where Claude should look for details:
- ✓ `per .ai/blueprints/workspace.md`
- ✓ `per .ai/architect.md §4`
- ✓ `Acceptance: all tests pass, TASKS.md synced`
- **BLOCK** if E-## task has no reference and no acceptance criteria

### Check 4: No circular dependencies
If task A says "Unblocks: B" and task B says "Unblocks: A" → circular. **BLOCK**.
Maximum dependency chain depth: 5 hops.

### Check 5: No duplicate task
Search TASKS.md for a task covering the same scope. If one exists:
- If it's OPEN → do not create a duplicate, reuse it
- If it's DONE → proceed with the new task

## Step 3 — Assign IDs

Read current TASKS.md and increment:
- P-## for Architect tasks
- E-## for Engineer tasks

Never reuse a completed task ID.

## Step 4 — Classify the Workspace (E-64 — Framework Routing)

Before writing the task, decide *where* it belongs. Rein framework changes
must not pollute downstream project queues (the misclassification class
captured in `.ai/blueprints/task-routing.md`).

A task is **framework-level** (`is_framework_task: true`) if any of the
following is true:

- It mutates files under `~/.rein/` or any path inside the canonical
  `@vimurai/rein/src/**` clone (MCP servers, shared skills, agents, scripts,
  installer, hooks, registry, schemas).
- It edits `.ai/blueprints/*.md` *for the framework itself* — i.e. the
  blueprint sits inside the Rein clone, not the consuming project.
- The task description names a framework component without a project-
  specific feature (e.g. "Update task-synchronizer-mcp", "Fix bin/ai
  locator chain", "Add new skill to shared/skills").

A task is **project-level** (`is_framework_task` omitted/false) if it
touches `<project>/src/**`, application code, or anything outside the
framework clone — even if it imports a Rein skill or MCP.

**Ambiguous?** Default to project-level and note the ambiguity in the
description. Mis-routing a project task into the framework workspace is a
worse failure than the reverse (it pollutes the source-of-truth).

## Step 5 — Write to TASKS.md

Format:
```markdown
- [ ] E-##: <Imperative description> per <blueprint reference>. | Tier: N
- [ ] P-##: <Imperative description> | Tier: N
```

Append under the correct section (`## Engineer` or `## Architect`).

Also call `add_task` with the routing flag set per Step 4:
```
mcp__task-synchronizer-mcp__add_task({
  owner:             "Engineer (Claude)",
  description:       "...",
  tier:              N,
  prefix:            "E",
  is_framework_task: true   // ← omit or set false for project-level work
})
```

When `is_framework_task: true`, the MCP redirects the row into
`$REIN_WORKSPACE/.ai/state.sqlite` instead of the local `.ai/`. If the env
is unset or invalid the call returns `[WORKSPACE_NOT_FOUND]` — do not
retry without the flag; surface the error so the user can re-run
`install-rein.sh` from the framework clone.

## Step 6 — Confirm

Report:
> "N tasks written to TASKS.md: [E-## list]. All passed quality gate.
>  Framework-routed: [E-## list, or 'none']."

## Step 7 — Hand Off to the Engineer (MANDATORY — and LAST)

Creating tasks is only half the loop — the Engineer is **not** polling the queue;
it must be *woken*. After the tasks are registered (Step 5), ALWAYS send the wake so
control routes to the Engineer. This is **non-optional** and mirrors the Engineer's
mandatory hand-back (`skill: arch-task` Step 4): the autonomous ping-pong loop only
advances if each side hands off when its turn ends. Registering tasks without handing
off is the failure that strands a planned sprint (and leaves the Engineer idle).

**COMPLETION BARRIER (critical).** The handoff must be your **FINAL** action — sent
only after **every** task has been fully written to `state.sqlite`. Every `add_task` call
must have returned; if you register tasks with an async/batch script (e.g. a JSON-RPC
insertion loop), run it in the foreground and let it fully exit — a wake sent
mid-insertion lands the Engineer on a **half-empty queue**, and it plans against the
tasks that haven't landed yet. Before sending, confirm `verify_markdown_sync` returns
`[SYNC_PASS]` and the OPEN queue contains every task you drafted in Step 1.

Write the `.ai/COMM.md` handoff entry, then commit it before the wake (D-104):
```
git add -- .ai/COMM.md && git commit --only .ai/COMM.md -m "chore(.ai): COMM handoff <YYYY-MM-DD HH:MM UTC> (<Role>)"
```
`--only` commits that one path whatever else the index holds, so source staged mid-task
never rides a bookkeeping commit (no critic stamp needed — `.ai/COMM.md` is bookkeeping).
The commit stays on the current branch and is not pushed here. If `git add` refuses
because `.ai/COMM.md` is still gitignored (an un-synced clone), print that one line and
skip the commit — never `git add -f`; `ai sync` removes the pattern and `ai doctor`
reports `[COMM_IGNORED]` (D-104 r2/r4).

Then wake the Engineer with `SendMessage` (D-099). It is a deferred tool — load it first:
```
ToolSearch({ query: "select:SendMessage" })
SendMessage({
  to: "<project dir basename> · Engineer",   // as ListAgents lists it, e.g. "@vimurai/rein · Engineer"
  message: "Planned E-##..E-## (<one-line scope>) — execute the OPEN queue.\nDetails: .ai/COMM.md handoff <YYYY-MM-DD HH:MM UTC>, commit <short sha>."
})
```
The first line is the handoff line; the body points at the COMM.md entry, never repeats
it. **Target down** (the send fails with "not reachable" — always make the call, even
when `ListAgents` does not show the target; the send's own result is the check): print ONE line
naming the target and the undelivered handoff line, then end the turn — no retry, no
queue, no fallback (D-099 ruling 4). Never end the turn without calling `SendMessage`.

Then report: "Planned N tasks and handed control to the Engineer."

## What NOT to Do

- Do NOT write tasks without a tier
- Do NOT write E-## tasks without a blueprint reference
- Do NOT write tasks in passive voice ("should be done", "needs to be")
- Do NOT skip the circular dependency check for chains > 2 hops
- Do NOT file framework-level tasks (changes to `~/.rein/` or
  `@vimurai/rein/src/**`) into a downstream project's queue — set
  `is_framework_task: true` per Step 4 so the MCP routes them to the
  canonical Rein clone.
- Do NOT end a planning turn WITHOUT handing off to the Engineer (Step 7).
  Registered-but-un-handed-off tasks strand the loop — the Engineer never wakes.
- Do NOT hand off WHILE still creating or updating tasks. The `SendMessage` wake is
  your LAST action, after every `add_task` has returned and `verify_markdown_sync`
  passes (Step 7). A premature wake lands the Engineer on a half-empty queue and it
  plans against missing tasks (the failure this barrier exists to prevent).
- Do NOT hand-edit `TASKS.md`. `add_task` is the source of truth and regenerates
  the file from `state.sqlite`; lines you type directly are silently wiped by
  `verify_markdown_sync` on the next sync (the "lost tasks after state-sync drift"
  failure). Always create tasks through `add_task`.
