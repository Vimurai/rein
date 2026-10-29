---
name: ai-handoff
description: Produce a structured handoff packet for Architect↔Engineer transitions. Reads unread deltas from state, formats blueprint divergence and decisions into .ai/COMM.md. Use before switching agents.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash, Edit, mcp__task-synchronizer-mcp__get_state, mcp__task-synchronizer-mcp__mark_deltas_read, mcp__task-synchronizer-mcp__verify_markdown_sync, ToolSearch, ListAgents, SendMessage
context: default
agent: default
---

# AI-Handoff — Architect↔Engineer Context Bridge

## Dynamic Context Injection
Unread deltas: !python3 -c "import json; s=json.load(open('.ai/state.json')); [print(d['task_id'],':',d['summary']) for d in s.get('deltas',[]) if not d.get('read')]" 2>/dev/null || echo "(none)"
Last COMM.md entry: !tail -5 .ai/COMM.md 2>/dev/null || echo "(no COMM.md)"

## Role

You are the **Handoff Coordinator**. Your job is to produce a clear, structured transition message so the receiving agent (Architect or Engineer) can orient immediately without re-reading the entire conversation.

## When to Invoke

- Engineer → Architect: after completing E-## work, before asking the Architect to review or plan next
- Architect → Engineer: after writing new blueprints or P-## tasks, before the Engineer starts implementing
- Any time context may be stale between agents

## Step 0 — Verify state is consistent before packaging the handoff

Never hand off an inconsistent state to the receiving agent. Run:

```
mcp__task-synchronizer-mcp__verify_markdown_sync()
```

- `[SYNC_PASS]` — continue to Step 1.
- `[SYNC_FAIL]` — the anomalies almost always mean a task was implemented
  but never marked `DONE`. Resolve every `is [x] but OPEN in state` /
  `is [ ] but DONE in state` anomaly **first** — either mark the task
  `DONE` via `update_task_status` (if the work is genuinely complete) or
  flip the checkbox back to `[ ]` in your COMM.md narrative (if the
  receiving agent should pick it up).

Rationale: COMM.md is the receiving agent's source of truth for "what
just happened." If state and markdown disagree, the next agent will plan
against a fiction. Catch it here.

## Step 1 — Gather Handoff Data

Read:
1. `.ai/TASKS.md` — what was just completed, what's next
2. `.ai/state.json` → `deltas` array — unread implementation deltas
3. `.ai/DECISIONS.md` last entry — key decisions made
4. `git log --oneline -5` — recent commits

## Step 2 — Write COMM.md Entry

Append to `.ai/COMM.md` (create if missing):

```markdown
---
## Handoff — YYYY-MM-DD HH:MM UTC
**From**: Engineer → Architect   [or reverse]
**Trigger**: E-## complete / P-## written / [reason]

### What was built
- <bullet per task completed, with files changed>

### Decisions made
- <any D-### from DECISIONS.md not yet in architect.md>

### Blueprint divergence (if any)
- <list any implementation detail that differs from the blueprint>
- NONE — implementation matched blueprint exactly

### Next action needed
- <what the receiving agent should do: review delta / write P-## / implement E-## / etc.>

### Open risks
- <any unresolved risks the receiving agent should know about>
---
```

## Step 2b — Commit the Entry (MANDATORY — D-104)

Immediately after the write, before anything else in the turn, commit the entry:
```
git add -- .ai/COMM.md && git commit --only .ai/COMM.md -m "chore(.ai): COMM handoff <YYYY-MM-DD HH:MM UTC> (<Role>)"
```
`--only` commits that one path whatever else the index holds, so source staged mid-task
never rides a bookkeeping commit (no critic stamp needed — `.ai/COMM.md` is bookkeeping).
The commit stays on the current branch and is not pushed here. If `git add` refuses
because `.ai/COMM.md` is still gitignored (an un-synced clone), print that one line and
skip the commit — never `git add -f`; `ai sync` removes the pattern and `ai doctor`
reports `[COMM_IGNORED]` (D-104 r2/r4).

## Step 3 — Mark Deltas Read (Engineer→Architect only)

After writing COMM.md, if handing off to the Architect, mark deltas read so they don't repeat:
```
mcp__task-synchronizer-mcp__mark_deltas_read()
```

## Step 4 — Wake the Other Role with SendMessage (MANDATORY — E-119, D-099)

Writing COMM.md only **records** context — it does NOT wake the other agent. The wake
is a `SendMessage` call to the receiving role's Claude session, and it is the **LAST
action of your turn**, after COMM.md is written and committed (and, Architect→Engineer, after every
`add_task` call has returned — the queue must be complete before the Engineer wakes).

1. `SendMessage` is a deferred tool. Load it first:
   ```
   ToolSearch({ query: "select:SendMessage" })
   ```
2. The target is the receiving role's session name as `ListAgents` lists it:
   `<project dir basename> · <Role>` — e.g. `@vimurai/rein · Architect` (Engineer→Architect)
   or `@vimurai/rein · Engineer` (Architect→Engineer).
3. Send. The FIRST line is the handoff line — what shipped or what was planned, then
   "review and plan next" (to the Architect) or "execute the OPEN queue" (to the
   Engineer). The body points at the COMM.md entry and its commit (Step 2b) so a receiver
   on another clone can fetch it; it never repeats it:
   ```
   SendMessage({
     to: "@vimurai/rein · Architect",
     message: "E-321 shipped (skills wake via SendMessage) — review and plan next.\nDetails: .ai/COMM.md handoff <YYYY-MM-DD HH:MM UTC>, commit <short sha>."
   })
   ```

**Target down** — the send fails with "not reachable". ALWAYS make the call — never
skip it because `ListAgents` does not show the target; the send's own result is the
check. On that failure print ONE line to your user naming the target and the handoff line you
could not deliver, then end the turn. No retry, no queue, no fallback (D-099 ruling 4).
```
✗ @vimurai/rein · Architect not reachable — undelivered: "E-321 shipped — review and plan next."
```
**Target busy** — nothing to do: the message drains into its running turn after its
current tool call (E-281 case b).

This is **non-optional at session completion**: never end the turn without calling
`SendMessage` to the other role.

## Step 5 — Confirm

Report:
> "Handoff written to .ai/COMM.md and sent to `<project> · <Role>` via SendMessage."
(or the single "not reachable" line from Step 4).

## What NOT to Do

- Do NOT overwrite COMM.md — always append
- Do NOT skip divergence section — even "NONE" must be stated explicitly
- Do NOT call mark_deltas_read when handing off TO the Engineer (the Architect should review them first)
- Do NOT skip the `SendMessage` wake (Step 4) — COMM.md records context but only
  `SendMessage` wakes the other agent (E-119, D-099). Never end the turn without
  calling it when your task/plan queue is exhausted.
- Do NOT retry or queue a wake to a down target — report it in one line and stop.
