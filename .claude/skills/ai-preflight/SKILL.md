---
name: ai-preflight
description: Use this skill at the start of every session in a Rein project. Executes the DIGEST-first read order (DIGEST → TASKS.md → architect.md if needed) and stamps SESSION.md.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Glob, Bash, mcp__task-synchronizer-mcp__verify_markdown_sync
context: default
agent: default
---

# Rein Preflight — Session Bootstrap

## Dynamic Context Injection
Project root: !pwd
Rein project: !test -d .ai && echo "YES — .ai/ found" || echo "NO — run: ai init"
DIGEST freshness: !head -2 .ai/DIGEST.md 2>/dev/null || echo "(DIGEST.md missing — run skill: ai-digest)"
Recent log (E-333 — every developer's .ai/log/*.md when team.json shared_log is true): !ai log recent -n 5 2>/dev/null || tail -5 .ai/LOG.md 2>/dev/null || echo "(no log)"
COMM.md (D-104): !REIN_LOCATE_UNTRUSTED_ENV=1; unset -f rein_locate rein_locate_enable_dev_tree rein_is_framework_clone 2>/dev/null; [ -f "${HOME}/.rein/shared/locate.sh" ] && . "${HOME}/.rein/shared/locate.sh"; c="$(rein_locate shared/comm-status.sh 2>/dev/null)"; [ -n "$c" ] && . "$c" && s="$(rein_comm_status .)" && case "$s" in UNCOMMITTED*) echo "UNCOMMITTED (${s#UNCOMMITTED } lines) — commit it: git add .ai/COMM.md && git commit --only .ai/COMM.md" ;; IGNORED) echo "IGNORED — run: ai sync" ;; *) echo "$s" ;; esac || echo "(comm-status probe unavailable)"
Open tasks: !grep "^- \[ \]" .ai/TASKS.md 2>/dev/null | head -5 || echo "(none)"
State index (E-344, D-108): !REIN_LOCATE_UNTRUSTED_ENV=1; unset -f rein_locate rein_locate_enable_dev_tree rein_is_framework_clone 2>/dev/null; [ -f "${HOME}/.rein/shared/locate.sh" ] && . "${HOME}/.rein/shared/locate.sh"; c="$(rein_locate shared/cli-state.mjs 2>/dev/null)"; [ -n "$c" ] && node --no-warnings "$c" state health --short 2>/dev/null || echo "(state health unavailable)"
Claims on the trunk (E-331, E-341): !test -f .ai/team.json && { ai task claims 2>/dev/null || echo "(ai task claims unavailable)"; } || echo "(single-operator project — no claims)"
Incident status: !REIN_LOCATE_UNTRUSTED_ENV=1; unset -f rein_locate rein_locate_enable_dev_tree rein_is_framework_clone 2>/dev/null; [ -f "${HOME}/.rein/shared/locate.sh" ] && . "${HOME}/.rein/shared/locate.sh"; c="$(rein_locate shared/incident-aggregate.mjs 2>/dev/null)"; [ -n "$c" ] && node "$c" 2>/dev/null | grep -m1 '"status"' | sed -E 's/.*"status": *"([^"]+)".*/\1/' || echo "(aggregator unavailable)"
Stale MCP servers (E-249): !REIN_LOCATE_UNTRUSTED_ENV=1; unset -f rein_locate rein_locate_enable_dev_tree rein_is_framework_clone 2>/dev/null; [ -f "${HOME}/.rein/shared/locate.sh" ] && . "${HOME}/.rein/shared/locate.sh"; c="$(rein_locate shared/build-stamp.mjs 2>/dev/null)"; r=""; [ -n "$c" ] && r="$(node --no-warnings "$c" --stale 2>/dev/null)"; [ -n "$r" ] && printf '%s — restart the MCP servers before trusting their answers\n' "$r" || echo "none"

## Preflight Read Order (DIGEST-First)

Execute in strict order — stop reading a file if it contains everything needed:

### 1. Read `.ai/DIGEST.md` ← PRIMARY
The current project snapshot. If DIGEST is current (≤ 3 days old), it replaces most other reads.
Contains: product summary, stack, Triad health, current focus, known risks, recent changes.

### 2. architect.md ← BLUEPRINT (SKIPPED)
**DO NOT read `.ai/architect.md` during preflight.** It is skipped to save tokens.
Only use `filesystem.read` on `.ai/architect.md` *after* preflight, and ONLY IF your specific assigned task explicitly requires architectural details.

### 3. Read `.ai/TASKS.md` ← YOUR ASSIGNMENTS
Assigned tasks (E-## for the Engineer, P-## for the Architect). Always read.

### 4. Verify markdown ↔ state sync ← FAILSAFE (E-60, blueprint state-sync-validation)

Before trusting TASKS.md, verify the file actually agrees with state.sqlite:

```
mcp__task-synchronizer-mcp__verify_markdown_sync()
```

- `[SYNC_PASS]` — proceed normally.
- `[SYNC_FAIL] … [STATE_BEHIND_HEAD]` or `[EMPTY_STATE_DB]` (E-342/E-344, D-106/D-108) — this
  machine's index is behind what HEAD tracks, or empty. Run `ai state import` (lossless) and
  verify again. Never `ai migrate-state` here: it rebuilds from TASKS.md and drops summaries,
  stamps and dependencies. The `State index` line above carries the same verdict.
- `[SYNC_FAIL]` — read the listed anomalies. The most common failure is a
  task you completed last session that you forgot to mark `DONE`. If you
  see `E-N is [x] in TASKS.md but OPEN in state`, that's almost certainly
  the case — fix it via `update_task_status({id: "E-N", status: "DONE"})`
  before claiming any work is "done" in the new session.
- The MCP auto-regenerates the markdown when rows are missing from one
  side, so you usually need to act only on `is [x] but OPEN` /
  `is [ ] but DONE` anomalies.

### 4b. Claims ← TEAM PROJECTS ONLY (E-331, D-102 §4)
The `Claims on the trunk` line above lists every IN_PROGRESS task with its holder (from the
trunk — `origin/<trunk>`, see `ai trunk`; `master` in this repository — that the SessionStart
hook fetched). A `[NO_TRUNK]` line there means no claim can be checked: report it, and the
operator sets `"trunk"` in `.ai/team.json`. Report them. Never start a task someone
else holds; a `[CLAIM_TAKEN_OVER]` line means your expired claim now belongs to a teammate —
stop work on it. Before your first source write on a task, claim it (`skill: ai-task`, Step 0).

### 5. Check Implementation Deltas ← FEEDBACK LOOP (P-42 §29)
If `.ai/state.json` exists, check for unread implementation deltas:
```
Read .ai/state.json → look for entries in "deltas" array where "read" is false
```
If unread deltas exist, display them prominently:
```
## Unread Implementation Deltas
- E-78: Created state.json schema | Files: src/templates/state.json, src/bin/ai
- E-79: task-synchronizer-mcp v2.0 | Files: src/mcp/task-synchronizer-mcp/index.js
```
After reading, mark them as read (set `"read": true`) so they don't repeat.
**Architect**: If a delta shows divergence from your blueprint, update `architect.md` to reflect reality.

### 6. Run the Incident Aggregator ← AUTO-IMPROVEMENT (E-66/E-67, blueprint incident-tracker)

After the sync check, run the JIT aggregator to surface recurring
unpredictable events captured by the `ai-incident` skill (E-65). The
aggregator reads `~/.rein/incidents.ndjson`, groups records by
`stack_signature`, and reports counts. Budget: <50ms — the helper does a
single linear pass.

**Locator chain** (mirrors E-58 / E-65 fail-open patterns):
1. the install mirror via `rein_locate shared/incident-aggregate.mjs` (E-225)
2. `${HOME}/.rein/shared/incident-aggregate.mjs` (installed mirror)

**Invocation** (run silently, parse the JSON):
```bash
node "${AGGREGATOR}" 2>/dev/null || echo '{"status":"AGGREGATOR_UNAVAILABLE"}'
```

**Output handling** — branch on the `status` field:

- `OK` / `NO_INCIDENTS` / `DISABLED` / `AGGREGATOR_UNAVAILABLE` — silent.
  No-op; continue to the next step.
- `THRESHOLD_REACHED` — emit an inline context block to the agent. Use
  the format below verbatim so the Architect can recognise the
  signal in the next handoff:

  ```
  [INCIDENT_THRESHOLD_REACHED] N distinct signature(s) at or above the
  threshold (>=3 occurrences). Recurring failures the framework should
  address — please draft a P-## blueprint per .ai/blueprints/incident-tracker.md
  before continuing implementation work.

  Top recurring signatures:
    - <stack_signature> (count=N, agents=[...], types=[...])
      sample: "<sanitised one-line message>"
    - …

  Suggested next step: switch to the Architect and ask for a blueprint that
  resolves the highest-count signature first.
  ```

  This is **prompting**, not **doing** — the Engineer must not draft
  P-## tasks (anti-drift §35). The block is the explicit handoff cue
  for the Architect.

**Rollback**: set `AI_INCIDENT_TRACKER_DISABLE=1` to short-circuit the
aggregator (it returns `status: "DISABLED"`). Manual deletion of
`~/.rein/incidents.ndjson` is safe and stateless.

### 7. INSIGHTS.md Staleness Check ← META-COGNITION (E-86, blueprint meta-cognition)

After the incident aggregator, run the staleness probe for the
cross-project meta-cognition report (E-85). The helper compares
`~/.rein/INSIGHTS.md` mtime against telemetry rows accumulated in
`~/.rein/telemetry.sqlite` (E-84). Budget: <50ms — one stat + one
SQLite COUNT() with optional `since_iso` clause.

**Locator chain** (mirrors E-58 / E-65 / E-75 / E-83):
1. the install mirror via `rein_locate shared/insights-staleness.mjs` (E-225)
2. `${HOME}/.rein/shared/insights-staleness.mjs` (installed mirror)

**Invocation** (run silently, parse the JSON envelope):
```bash
# E-225: resolve through the shared install-first locator, never cwd-relative. The old
# chain started at src/shared/..., so running preflight inside ANY project that happened
# to contain that file executed THAT file — and preflight runs at every session start.
REIN_LOCATE_UNTRUSTED_ENV=1
# `declare -f` inside locate.sh's own fallback asks whether a NAME is defined, and bash
# imports EXPORTED functions from the environment at startup — so without this unset an
# inherited `rein_locate` is the resolver whenever locate.sh is unreachable. The hooks
# carry this guard (E-223 F13); the first cut of E-225 ported the pattern and not the
# guard, and a decoy executed at session start. Sourcing is gated on the FILE so a missing
# resolver fails CLOSED — skills may, unlike the hooks, simply report "unavailable".
unset -f rein_locate rein_locate_enable_dev_tree rein_is_framework_clone 2>/dev/null
[ -f "${HOME}/.rein/shared/locate.sh" ] && . "${HOME}/.rein/shared/locate.sh"
PROBE="$(rein_locate shared/insights-staleness.mjs 2>/dev/null)"
[ -n "${PROBE:-}" ] && node "${PROBE}" 2>/dev/null || echo '{"status":"UNAVAILABLE"}'
```

**Output handling** — branch on the `status` field:

- `FRESH` / `EMPTY` / `DISABLED` / `UNAVAILABLE` — silent. No-op;
  continue to the open-on-demand reads below.
- `STALE` — emit an inline context block to the agent. Use the format
  below verbatim so the user can convert it to a `skill: ai-insights`
  invocation:

  ```
  [INSIGHTS_STALE] N new telemetry rows since INSIGHTS.md last
  refreshed (threshold: 200). The cross-project meta-cognition
  report is out of date — recurring tool errors, latency outliers,
  and CLI-automation candidates may have shifted.

  Telemetry: <total_rows> total, <new_rows_since_insights> new since
            <insights_mtime or "(never generated)">.

  Suggested next step: run `skill: ai-insights` to regenerate
  ~/.rein/INSIGHTS.md before the next planning loop. The skill is
  on-demand and bounded — no telemetry write side-effects.
  ```

  Like the incident-aggregator hand-off (Step 6), this is **prompting**,
  not **doing** — the staleness probe never invokes the meta_analyst
  itself. The agent surfaces the block; the user decides whether to
  trigger `ai-insights`.

**Rollback**: set `AI_INSIGHTS_STALENESS_DISABLE=1` to short-circuit
the probe (it returns `status: "DISABLED"`). The wider
`AI_TELEMETRY_DISABLE=1` (E-84) also disables this check by extension.
Manual deletion of `~/.rein/INSIGHTS.md` is safe — the next probe
re-evaluates from the telemetry DB.

### 8. Load REPO_MAP.md ← ARCHITECTURE CONTEXT (E-98, blueprint ast-repository-map)

After the staleness checks, load the AST Repository Map **if it exists**:

```bash
test -f .ai/REPO_MAP.md && cat .ai/REPO_MAP.md || echo "(no REPO_MAP.md — run: ai sync)"
```

`.ai/REPO_MAP.md` is a token-compressed skeleton of the codebase —
the most central files (PageRank over the import graph) with their
exports, class/method **signatures** (bodies elided with `⋮`), and
imports. It is regenerated by `ai sync` via `ast-parser-mcp generate_map`
(E-95/E-96/E-97) within a strict token budget (default 2048).

- **If present**: read it for immediate architectural orientation —
  prefer it over blind `grep`/full-file reads when locating where a
  symbol lives. It is a *map*, not the source of truth; open the real
  file before editing.
- **If absent**: it has not been generated yet (fresh clone, or
  `REIN_DISABLE_REPO_MAP=1`). Run `ai sync` to build it, or fall back
  to `grep`/`list_directory`.

**Rollback**: `REIN_DISABLE_REPO_MAP=1` stops regeneration; deleting
`.ai/REPO_MAP.md` is safe — the next `ai sync` rebuilds it.

### Open Only When Task Touches That Domain
- `.ai/BRIEF.md` — Project rules & lore (read if onboarding or task touches product goals)
- `.ai/RULES.md` — Token economics & Triad contract
- `.ai/CAPABILITIES.md` — Allowed scope (always read for Tier 3 tasks)
- `.ai/REVIEWS.md` — Recent critic findings (read if preparing to commit)

## Session Stamp

After reading, append to `.ai/SESSION.md`:
```
---
- Time: YYYY-MM-DD HH:MM UTC
- Actor: <actor> (preflight)
- Files read: DIGEST, architect.md, TASKS.md
- Focus: <one-line summary of current task>
---
```

## Fallback — Bash Context Retrieval (§30 Bootloader Resilience)

Use this section when `task-synchronizer-mcp` is unavailable (MCP server down, node error, cold start). D-075 (E-276) retired the orchestrator's preflight tool: this skill, with its `!` injection above, is the only preflight path.

### Trigger Condition
`verify_markdown_sync()` errors OR `task-synchronizer-mcp` is not listed in active MCP servers.

### Fallback Execution

**Step 1 — Read DIGEST (primary context)**
```bash
cat .ai/DIGEST.md
```

**Step 2 — Extract structured state from state.json (Bash/jq)**
```bash
# Task counts
python3 -c "
import json
s = json.load(open('.ai/state.json'))
counts = {}
for t in s['tasks']:
    counts[t['status']] = counts.get(t['status'], 0) + 1
print('Tasks:', counts)
print('Focus:', s['project'].get('focus', '(none)'))
" 2>/dev/null || grep "^- \[ \]" .ai/TASKS.md | head -10

# Last 3 stamps
python3 -c "
import json
s = json.load(open('.ai/state.json'))
for st in s['stamps'][-3:]:
    print(f\"[{st['type']}] {st['timestamp'][:10]} | {st.get('summary','')}\")
" 2>/dev/null || tail -3 .ai/REVIEWS.md
```

**Step 3 — Read open tasks**
```bash
grep "^- \[ \]" .ai/TASKS.md | head -10
```

**Step 4 — Stamp SESSION.md manually**
```bash
echo "---" >> .ai/SESSION.md
echo "- Time: $(date -u +%Y-%m-%d\ %H:%M) UTC (Bash fallback)" >> .ai/SESSION.md
echo "- Actor: Claude (ai-preflight skill)" >> .ai/SESSION.md
echo "---" >> .ai/SESSION.md
```

### Escalation
If the Bash fallback also fails (python3/bash unavailable), read the "Emergency Recovery" section in `ENGINEER.md` (the canonical Engineer rulefile; `CLAUDE.md` is a shim that imports it).

## Token Economics Hard Rules
- Do NOT read files outside your domain unless the task explicitly requires it.
- Do NOT read `src/**` unless your task involves a specific file.
- If DIGEST is current, skip files it already summarizes.
- SESSION.md is auto-stamped by the Stop hook — manual stamp only if hook fails.
