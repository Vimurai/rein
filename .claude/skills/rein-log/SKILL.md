---
name: rein-log
description: "Append a structured entry to .ai/LOG.md after any significant action. Enforces RULES §4 mandate. Captures the session id (${CLAUDE_SESSION_ID} substitution, E-284) for cryptographic audit traceability (E-49). Checks if LOG.md exceeds 200 lines and triggers rein-archive warning if so."
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash, Edit
context: default
agent: default
---

# AI-Log — LOG.md Maintenance

## Dynamic Context Injection
Log file: !rein log path 2>/dev/null || echo ".ai/LOG.md"
Log line count: !wc -l < "$(rein log path 2>/dev/null || echo .ai/LOG.md)" 2>/dev/null || echo "0"
Last 3 entries: !rein log recent -n 3 2>/dev/null || tail -3 .ai/LOG.md 2>/dev/null || echo "(empty)"
Session id: ${CLAUDE_SESSION_ID}

## Role

You are the **Log Keeper**. Your job is to append one structured entry to `.ai/LOG.md` per significant action and warn if the log is approaching the archive threshold.

## When to Invoke

- After completing any E-## task (in addition to `rein-task`)
- After any significant file modification not covered by a hook
- After a gate decision (dependency_gate, ci_gate, security_engineer)
- After a blueprint deviation or architectural decision

## Step 1 — Compose the Entry

Format (E-49):
```
YYYY-MM-DD | <Actor> | <Task-ID or action> | <one-line summary> | session=<session id|none>
```

Rules:
- Actor: `Claude` (Engineer) or `Architect`
- Task-ID: when tied to a task, use the bare ID (e.g. `E-##`, `P-##`, `D-###`). For non-task actions use the bare action name (e.g. `dependency_gate`, `ci_gate`, `hotfix`).
- Summary: what changed and why — not how. Max 120 characters.
- **Session:** Claude Code substitutes `${CLAUDE_SESSION_ID}` into this skill (E-284, D-075 §5 — no environment read). If it is empty or still the literal placeholder, write `session=none`. Otherwise, write the value verbatim — but only if it matches the regex `[A-Za-z0-9-]{1,64}`. If it doesn't (untrusted input), write `session=invalid`.
- Never duplicate an entry already in LOG.md for the same action.

Examples:
```
2026-04-14 | Claude | E-1   | Added root package.json with npm workspaces; sdk hoisted to root | session=01J9X2A1Z3
2026-04-14 | Claude | dependency_gate | Approved @modelcontextprotocol/sdk upgrade to ^1.1.0 — no CVEs | session=none
2026-04-14 | Architect | P-4   | Designed workspace blueprint in workspace.md | session=01J9X2A1Z3
```

## Step 2 — Append to LOG.md

Use Edit or Bash append — never overwrite. The recommended idiom captures the
session id once and validates it before composing the line:

```bash
sid="${CLAUDE_SESSION_ID}"   # substituted by Claude Code before you see this line
if [[ -z "$sid" ]]; then
  tag="session=none"
elif [[ "$sid" =~ ^[A-Za-z0-9-]{1,64}$ ]]; then
  tag="session=${sid}"
else
  tag="session=invalid"
fi
# E-333 (D-102 §8): with team.json shared_log true the entry goes to YOUR tracked
# .ai/log/<email-localpart>.md (commit it); otherwise the gitignored .ai/LOG.md, as before.
log="$(rein log path 2>/dev/null || echo .ai/LOG.md)"; mkdir -p "$(dirname "$log")"
echo "$(date -u +%Y-%m-%d) | Actor | Task | Summary | ${tag}" >> "$log"
```

## Step 3 — Check Archive Threshold

```bash
wc -l < "$(rein log path 2>/dev/null || echo .ai/LOG.md)"
```

If line count ≥ 200:
> "LOG.md has reached 200 lines. Run `skill: 'rein-archive'` to archive and reset before continuing."

If line count is between 180–199:
> "LOG.md is at <N> lines — approaching archive threshold (200). Consider running `rein-archive` soon."

## What NOT to Do

- Do NOT rewrite or truncate LOG.md — it is append-only
- Do NOT log trivial reads or tool calls that have no state impact
- Do NOT log the same action twice
