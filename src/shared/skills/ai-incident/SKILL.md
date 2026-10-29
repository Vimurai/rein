---
name: ai-incident
description: Record an unpredictable AI-OS event (MCP crash, drift, env failure, hook regression) to ~/.ai-os/incidents.ndjson for later aggregation. Sanitises PII; rotates monthly. Triggered by the Architect or Engineer when an action surfaces unexpected behaviour the user didn't anticipate.
disable-model-invocation: false
user-invocable: true
context: default
agent: default
allowed-tools: Bash
---

# AI-Incident — Cross-Project Anomaly Recorder

## Why this skill exists

AI-OS spans many downstream projects. When one of them surfaces an
unpredictable event — a hook regression, an MCP crash, drift between
state and markdown, a misclassified task, an unexplained tool refusal —
the data is most useful when aggregated *across* projects, not buried in
one project's `LOG.md`.

This skill writes a structured NDJSON line to a single global log:

```
~/.ai-os/incidents.ndjson
```

The JIT aggregator inside `ai-preflight` (E-66/E-67) groups recurrent
incidents by `stack_signature` and prompts the Architect to draft a P-##
when a threshold is exceeded.

## When to invoke

- An MCP server crashes or returns an `isError: true` payload twice
- `verify_markdown_sync` returns SYNC_FAIL with the same anomaly class
  across multiple sessions
- A hook (`pre-commit`, `stop-hook`, `post-tool-log`) silently fails
- `ai sync` overwrites a per-project skill mirror in a way the user did
  not expect (drift between a source skill and its installed mirror)
- Any task is filed into the wrong workspace (project vs framework)
- A deterministic test starts producing flaky results

## When NOT to invoke

- A test you can fix on the spot — file the fix, don't log noise.
- A user-reported feature request — that's a P-## via `task-planner`.
- Anything containing PII the sanitiser may miss (raw production data,
  customer secrets). Strip manually first; the sanitiser is best-effort
  defence-in-depth, not a guarantee.

## Payload shape

```json
{
  "incident_type":   "MCP_CRASH",
  "message":         "task-synchronizer-mcp returned isError on add_task",
  "stack_signature": "task-synchronizer-mcp/index.js:add_task",
  "source_agent":    "Claude"
}
```

- `incident_type` — short uppercase tag. Use one of:
  `MCP_CRASH`, `DRIFT_DETECTED`, `HOOK_REGRESSION`, `MISROUTED_TASK`,
  `ENV_ERROR`, `FLAKY_TEST`, `UNEXPECTED_BEHAVIOR`.
- `message` — one sentence describing what happened. Sanitiser truncates
  at 500 chars.
- `stack_signature` — *stable grouping key*. Use the same string for the
  same root cause across sessions; the aggregator counts duplicates
  here. Pattern: `<file>:<symbol>` or `<file>:<line>`.
- `source_agent` — `Claude` or `Tester` (the headless Claude Tester, E-255). Anything else is
  normalised to `unknown`.

The helper injects `timestamp` (UTC ISO-8601) automatically — do not
pass one in.

## Sanitisation contract (incident-tracker.md §Security)

The helper redacts before write:

- `$HOME`-prefixed paths → `~`
- Email addresses → `[email]`
- Bearer prefixes (`sk_*`, `ghp_*`, `xox[bp]_*`, `AKIA*`) → `[token]`
- Hex strings of length ≥ 32 → `[hex]`

If your message would carry data outside this class (production
identifiers, internal hostnames, customer references), redact manually
before invoking the skill.

## Invocation

The skill is a thin shell wrapper around `src/shared/incident-append.mjs`.
Run from any project:

```bash
node "$(_resolve_incident_helper)" "$(jq -nc \
  --arg t MCP_CRASH \
  --arg m "task-synchronizer-mcp returned isError on add_task" \
  --arg s "task-synchronizer-mcp/index.js:add_task" \
  --arg a "Claude" \
  '{incident_type:$t, message:$m, stack_signature:$s, source_agent:$a}')"
```

Where `_resolve_incident_helper` is the same locator chain used by the
WAL flusher (E-58):

1. `src/shared/incident-append.mjs` (in-repo dev tree)
2. `${SELF_DIR}/../shared/incident-append.mjs` (relative to bin/ai)
3. `${HOME}/.ai-os/shared/incident-append.mjs` (installed mirror)

If `node` is unavailable or none of the candidates exist, log a warning
and return — fail-open, never block the calling agent.

## Rollback

Set `AI_INCIDENT_TRACKER_DISABLE=1` to short-circuit every invocation.
The helper writes a single warning to stderr and exits 0 so callers stay
fail-open.

Manually deleting `~/.ai-os/incidents.ndjson` is safe and stateless —
the file is recreated on the next call. Monthly archives live next to
it as `incidents-YYYY-MM.ndjson.archive`.

## Storage limits

`incidents.ndjson` rotates when its line count exceeds
`INCIDENT_ROTATE_LINES` (default 500). The active file is renamed to
`incidents-YYYY-MM.ndjson.archive`. If a same-month archive already
exists, lines are appended and the active file is truncated.

## What this skill is NOT

- It is not a debugger. Use `ai-debug` for that — incidents are *signals
  for later improvement*, not active triage.
- It is not LOG.md. `ai-log` records expected actions for the current
  project; ai-incident records *unexpected* events for cross-project
  improvement.
- It is not the way to file a P-## task. The aggregator decides whether
  recurrence justifies a task.
