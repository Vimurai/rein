---
name: ai-triage
description: Runs daily or when incidents.ndjson crosses a size threshold. Invokes sre_responder agent to analyze recurring failures, draft post-mortems, and queue remediation tasks.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash, Read, mcp__task-synchronizer-mcp__get_state, ToolSearch, ListAgents, SendMessage
context: default
agent: default
---

# AI-Triage — Automated Incident Analysis

## Dynamic Context Injection
Incidents file: !test -f ~/.ai-os/incidents.ndjson && wc -l < ~/.ai-os/incidents.ndjson || echo "(not found)"
File size: !test -f ~/.ai-os/incidents.ndjson && du -h ~/.ai-os/incidents.ndjson | cut -f1 || echo "(not found)"
Last incident timestamp: !test -f ~/.ai-os/incidents.ndjson && tail -1 ~/.ai-os/incidents.ndjson | jq -r '.timestamp // "(no timestamp)"' 2>/dev/null || echo "(file unavailable)"
Open E-## tasks: !grep "^- \[ \]" .ai/TASKS.md 2>/dev/null | wc -l | tr -d ' '

## When to Invoke

This skill is triggered in two scenarios:

### 1. Scheduled (Daily Batch)
- Part of a scheduled job runner (e.g. `/loop` or a cron routine)
- Run once per day during off-peak hours
- Analyze all incidents accumulated since last run

### 2. On-Demand (Manual Threshold Check)
- User suspects recurring issues and wants a review
- After running `skill: ai-incident` multiple times in a session
- When `.ai/DIGEST.md` warns of high incident count

### File Size Threshold
If `~/.ai-os/incidents.ndjson` exceeds **10 KB** (approximately 200+ lines):
- Trigger an immediate triage run
- This prevents the file from growing unbounded
- The aggregator rotation (max 500 lines) provides a hard cap

## Preflight — Context Load

1. Check if `incidents.ndjson` exists at `~/.ai-os/incidents.ndjson`.
   - If not found: emit "No incidents file; skipping triage." and exit.
   - If found: proceed.

2. Count lines in the file:
   ```bash
   wc -l < ~/.ai-os/incidents.ndjson
   ```
   - If **≤ 2 lines** (empty or nearly empty): log and skip (no pattern yet).
   - If **≥ 3 lines**: proceed to Phase 1.

3. Read `.ai/DIGEST.md` for project context.

4. Verify `sre_responder` agent exists:
   ```bash
   test -f src/claude/agents/sre_responder.md && echo "YES" || echo "NO — sre_responder not found"
   ```

## Phase 1 — Invoke sre_responder Agent

Call the SRE responder agent to perform incident analysis, draft post-mortems, and queue tasks:

```
Agent({ subagent_type: "sre_responder", description: "<3-5 words>", prompt: "<what to analyse>" })
```

The agent will:
- Analyze `~/.ai-os/incidents.ndjson`
- Group by `stack_signature` and count duplicates
- Draft postmortem entries for signatures with ≥ 3 occurrences
- Create new E-## tasks in TASKS.md via task-synchronizer-mcp
- Stamp the review with [SRE_PASS] or [SRE_FAIL]

## Phase 2 — Verify Output

After sre_responder completes, check the result:

1. **Verify POSTMORTEM.md was created**:
   ```bash
   test -f .ai/POSTMORTEM.md && echo "Created" || echo "Skipped"
   ```

2. **Check task creation via get_state**:
   ```
   mcp__task-synchronizer-mcp__get_state()
   ```
   Filter for tasks created with `source_agent: "sre_responder"` in the last hour.

3. **Read recent stamps**:
   ```bash
   tail -3 .ai/LOG.md | grep -i "SRE_PASS\|SRE_FAIL"
   ```

## Phase 3 — Notify, Log, and Rollback Handler

After triage completes:

1. **If tasks were created**: Report summary to stdout:
   ```
   [AI_TRIAGE] Analyzed incidents.ndjson | <N> signature(s) identified | <M> tasks queued
   <task IDs and titles>
   ```

2. **If no recurring incidents found**: Report:
   ```
   [AI_TRIAGE] Incident log analyzed | <count> total lines | No patterns ≥3 yet — continue monitoring
   ```

3. **Append to `.ai/LOG.md`**:
   ```
   YYYY-MM-DD HH:MM | ai-triage (skill) | <action> | <incident summary>
   ```

4. **If a task is marked as false-positive** (user dispute or validation failure):
   Escalate to the Architect for review with `SendMessage` (D-099) — load it with
   `ToolSearch select:SendMessage` first, and send as the LAST action of the turn to
   `<project dir basename> · Architect` as `ListAgents` lists it:
   ```
   SendMessage({
     to: "ai-os-v2 · Architect",
     message: "False-positive task rejection from ai-triage: <task_id> — review root cause and plan next.\nPOSTMORTEM: <postmortem_section>. Confirm whether the incident threshold should be adjusted."
   })
   ```
   Always make the call, even when `ListAgents` does not show the Architect — the send's
   own result is the check. If it fails with "not reachable", print ONE line
   naming it and the undelivered line, then end the turn — no retry, no queue, no fallback.
   Never end the turn without calling `SendMessage` once an escalation is due.
   This initiates a handoff to the Architect for policy review rather than Engineer remediation.

## Rollback & Escalation

### If sre_responder agent not found
Log a warning to stderr and exit:
```
WARN: sre_responder agent not found — please verify src/claude/agents/sre_responder.md
```
Do NOT attempt to inline the agent logic.

### If incidents.ndjson is corrupted
Try to parse the first valid NDJSON line:
```bash
head -1 ~/.ai-os/incidents.ndjson | jq . 2>/dev/null
```
If parsing fails, report:
```
[AI_TRIAGE] ERROR: incidents.ndjson is malformed — manual recovery needed
```
Do NOT attempt to repair the file automatically. Surface to the user for manual deletion or recovery.

### If task-synchronizer-mcp is unavailable
Check MCP status:
```bash
test -d .mcp && grep -q "task-synchronizer-mcp" .mcp.json || echo "MCP unavailable"
```
If unavailable, log the incident to `.ai/LOG.md` for later recovery and exit gracefully.

## Token Economics Hard Rules
- Do NOT read `src/**` files unless sre_responder explicitly requires them.
- Do NOT load full .ai/architect.md unless the incident points to an architectural root cause.
- DIGEST.md context is sufficient for 90% of triages.
- If the incidents.ndjson file is empty, skip all phases and exit.

## Rules
- Run this skill at least once per day (via schedule or watch loop).
- Run immediately if incidents.ndjson exceeds 10 KB.
- Never block execution due to a single missing file — fail-open with a warning.
- Do NOT manually modify incidents.ndjson — it is read-only.
- Do NOT create duplicate tasks for the same postmortem entry — check TASKS.md first.
