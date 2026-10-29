---
name: ai-insights
description: "Trigger the meta_analyst (E-85) to regenerate ~/.rein/INSIGHTS.md from cross-project telemetry recorded in ~/.rein/telemetry.sqlite (E-84). Use when prompted by ai-preflight staleness check (E-86) or on demand before a planning session. Read-only over telemetry; write-only over INSIGHTS.md."
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash, mcp__task-synchronizer-mcp__add_stamp
context: default
agent: meta_analyst
---

# AI-Insights — Meta-Cognition Report Generator

## Dynamic Context Injection
Telemetry path:   !REIN_LOCATE_UNTRUSTED_ENV=1; unset -f ai_os_locate ai_os_locate_enable_dev_tree ai_os_is_framework_clone 2>/dev/null; [ -f "${HOME}/.rein/shared/locate.sh" ] && . "${HOME}/.rein/shared/locate.sh"; h="$(ai_os_locate shared/telemetry.mjs 2>/dev/null)"; [ -n "$h" ] && node -e "import(process.argv[1]).then(m => process.stdout.write(m.TELEMETRY_DB_PATH))" "$h" 2>/dev/null || echo "(helper unavailable)"
Insights freshness: !test -f ~/.rein/INSIGHTS.md && head -3 ~/.rein/INSIGHTS.md || echo "(INSIGHTS.md absent — first run)"
Telemetry stats:  !REIN_LOCATE_UNTRUSTED_ENV=1; unset -f ai_os_locate ai_os_locate_enable_dev_tree ai_os_is_framework_clone 2>/dev/null; [ -f "${HOME}/.rein/shared/locate.sh" ] && . "${HOME}/.rein/shared/locate.sh"; h="$(ai_os_locate shared/telemetry.mjs 2>/dev/null)"; [ -n "$h" ] && node -e "import(process.argv[1]).then(m => process.stdout.write(JSON.stringify(m.getTelemetryStats())))" "$h" 2>/dev/null || echo "(stats unavailable)"

## Why this skill exists

The `meta_analyst` agent (E-85) reads `~/.rein/telemetry.sqlite`
(E-84) and writes optimization suggestions to `~/.rein/INSIGHTS.md`.
The report identifies CLI automation candidates, tool deprecation
candidates, and latency hardening candidates — but only when explicitly
triggered, so it never runs in the hot chat loop.

This skill is the single trigger point. It does NOT itself read
telemetry — it delegates entirely to `meta_analyst`.

## When to invoke

- `ai-preflight` (E-86) emitted `[INSIGHTS_STALE]` at session start.
- You are about to plan a sprint and want to see which tools are
  failing or slow before the planning conversation.
- A monthly hygiene pass on `~/.rein/` (run after `skill: ai-digest`
  and `skill: ai-archive`).

## When NOT to invoke

- The Engineer is mid-implementation — the report can wait until the
  next planning loop.
- Telemetry is freshly empty (the dynamic stats line above reports
  `count:0`) — there is nothing to analyse yet.
- You are running inside an `ai-debug` cycle — wait until the failing
  test is green; meta-analysis after a debug detour is noisy.

## Step 1 — Verify Telemetry Is Reachable

Before invoking `meta_analyst`, run the helper's `--stats` smoke:

```bash
# E-225: install-first via the shared locator. The old chain started cwd-relative, so a
# visited project containing src/shared/telemetry.mjs had THAT file executed.
REIN_LOCATE_UNTRUSTED_ENV=1
# `declare -f` inside locate.sh's own fallback asks whether a NAME is defined, and bash
# imports EXPORTED functions from the environment at startup — so without this unset an
# inherited `ai_os_locate` is the resolver whenever locate.sh is unreachable. The hooks
# carry this guard (E-223 F13); the first cut of E-225 ported the pattern and not the
# guard, and a decoy executed at session start. Sourcing is gated on the FILE so a missing
# resolver fails CLOSED — skills may, unlike the hooks, simply report "unavailable".
unset -f ai_os_locate ai_os_locate_enable_dev_tree ai_os_is_framework_clone 2>/dev/null
[ -f "${HOME}/.rein/shared/locate.sh" ] && . "${HOME}/.rein/shared/locate.sh"
HELPER="$(ai_os_locate shared/telemetry.mjs 2>/dev/null)"
[ -n "${HELPER:-}" ] || { echo "[INSIGHTS_NO_HELPER] telemetry.mjs not found"; exit 1; }

node "$HELPER" --stats
```

Output is the structured envelope from `getTelemetryStats()`. If
`status` is `EMPTY` and `tool_executions.count` is `0`, write
`[INSIGHTS_EMPTY]` to `~/.rein/INSIGHTS.md` and exit — no analysis is
warranted yet.

## Step 2 — Activate the meta_analyst Agent

Run the `meta_analyst` agent with the Agent tool (its own context). The agent's contract is enumerated in
`src/claude/agents/meta_analyst.md` (E-85) — it runs the five canonical
aggregate queries, classifies findings, and writes `INSIGHTS.md`.

```
the Agent tool (subagent_type: "meta_analyst")
```

After the agent returns, verify `~/.rein/INSIGHTS.md` exists and was
updated within the last minute. If the file is older, surface a
`[INSIGHTS_NOT_REFRESHED]` warning so the user can investigate.

## Step 3 — Stamp the Run

After `INSIGHTS.md` is written, append a single stamp via
`task-synchronizer-mcp::add_stamp` so the Architect can correlate
report cycles with sprint deltas:

```json
{
  "type":    "INSIGHTS_GENERATED",
  "summary": "INSIGHTS.md refreshed — N rows analysed, M recommendations"
}
```

The `meta_analyst` is expected to emit this stamp itself; the skill
re-emits ONLY if the agent failed to. Duplicate stamps are harmless
but undesirable — check `tail -5 .ai/REVIEWS.md` before re-stamping.

## Step 4 — Surface Top-Line Findings

Echo the **Summary** + the **CLI Automation Candidates** table to the
chat. Do NOT echo the full file. The user reads `~/.rein/INSIGHTS.md`
when they want details.

If `INSIGHTS.md` contains the `**No actionable signals — telemetry
steady.**` sentinel, say so in one short sentence and exit — the
report was generated, just devoid of recommendations.

## Rollback Plan

- `rm ~/.rein/INSIGHTS.md` — the next invocation regenerates it from
  scratch. The telemetry DB is untouched.
- `AI_TELEMETRY_DISABLE=1` (E-84) — pauses data collection at the
  router. The agent will detect this and emit `[INSIGHTS_PAUSED]`.
- Revert `~/.rein/telemetry.sqlite` deletion: simply delete the file
  and the next router invocation re-bootstraps the schema.

## What NOT to do

- Do NOT modify `~/.rein/INSIGHTS.md` outside this skill. The agent
  is the sole writer; manual edits will be overwritten on next run.
- Do NOT pass `project_root` arguments to the agent or aggregates.
  `project_hash` is the cross-project identifier — raw paths must
  never enter the analysis surface.
- Do NOT bypass the meta_analyst by querying the DB directly. The
  agent enforces the read-only / aggregate-only contract; ad-hoc
  queries leak `tool_name`+`session_id` correlations the agent
  scrubs.
- Do NOT chain this skill in a loop. It is on-demand; the preflight
  staleness check (E-86) is the only automated trigger.
