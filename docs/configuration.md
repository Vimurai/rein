# Configuration

## Project files

| File | Tracked | Purpose |
| :--- | :--- | :--- |
| `.ai/roles.json` | yes | Role → provider, model and pane. |
| `.ai/providers.json` | yes | Provider definitions (Claude Code). |
| `.ai/start.json` | yes | `ai start` options; `"account"` binds the project to a Claude account. |
| `.ai/team.json` | yes | Team mode — see [Team mode](team-mode.md). Its presence turns team mode on. |
| `.ai/CAPABILITIES.md` | yes | The paths and commands agents may read, write and run; an input to the security gate. |
| `.ai/BRIEF.md`, `.ai/RULES.md` | yes | Product goals; token and role rules. Yours to edit. |
| `.ai/ci.local.json` | no | This machine's extra CI environment — see [Local CI](local-ci.md#machine-specific-environment). |
| `.mcp.json` | generated | MCP servers for the project; `ai sync` regenerates it and keeps servers you added. |
| `.claude/agents/`, `.claude/skills/` | generated | Copied from the install by `ai sync`. |
| `.claude/settings.engineer.json`, `.claude/settings.architect.json` | generated | Per-role permission overlays used by `ai pane`. |
| `ENGINEER.md`, `ARCHITECT.md`, `CLAUDE.md` | generated | Role rulefiles and the auto-load shim; refreshed by `ai sync`. |

`roles.json`:

```json
{
  "roles": {
    "architect": { "provider": "claude", "pane_identifier": "1", "model": "fable" },
    "engineer":  { "provider": "claude", "pane_identifier": "0", "model": "opus" }
  }
}
```

## Machine files (`~/.rein`)

| Path | Purpose |
| :--- | :--- |
| `~/.rein/bin/ai` | The CLI. |
| `~/.rein/mcp/`, `hooks/`, `templates/`, `config/` | The installed framework. |
| `~/.rein/accounts.json` | Registered Claude accounts. |
| `~/.rein/ci/logs/` | CI run logs. |
| `~/.rein/telemetry.sqlite`, `incidents.ndjson`, `INSIGHTS.md` | Local telemetry and incident records; never sent anywhere. |
| `~/.rein/trash/<date>/` | What `ai clean --apply` moved. |

## Environment variables

| Variable | Effect |
| :--- | :--- |
| `REIN_CI_GATE=0` | Close tasks without green CI. Say so when you use it. |
| `REIN_CI_SKIP=1` + `REIN_CI_SKIP_REASON="…"` | Push once without green CI; recorded with the reason. |
| `REIN_KEEP_LEGACY_WORKSPACES=1` | `ai sync` lists old provider workspaces but deletes nothing. |
| `REIN_DISABLE_REPO_MAP=1` | Do not generate `.ai/REPO_MAP.md`. |
| `REIN_BROWSER_TIMEOUT=<s>` | Time budget for the Playwright browser download (default 600). |
| `AI_TELEMETRY_DISABLE=1` | No local telemetry. |
| `AI_INCIDENT_TRACKER_DISABLE=1` | No incident aggregation at preflight. |
| `AI_INSIGHTS_STALENESS_DISABLE=1` | No "insights are stale" prompt at preflight. |

The `REIN_` prefix and the `~/.rein` directory keep their original names so existing installs
and scripts keep working.
