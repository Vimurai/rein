# Configuration

## Project files

| File | Tracked | Purpose |
| :--- | :--- | :--- |
| `.ai/roles.json` | yes | Role → provider, model and pane. |
| `.ai/providers.json` | yes | Provider definitions (Claude Code). |
| `.ai/start.json` | yes | `rein start` options; `"account"` binds the project to a Claude account. |
| `.ai/team.json` | yes | Team mode — see [Team mode](team-mode.md). Its presence turns team mode on. |
| `.ai/BRIEF.md`, `.ai/RULES.md` | yes | Product goals; token and role rules. Yours to edit. |
| `.ai/CAPABILITIES.md` | yes | Paths and commands the agents may use; the `security_engineer` reads it. |
| `.ai/ci.local.json` | no | This machine's extra CI environment — see [CI](ci.md#machine-specific-environment). |
| `.mcp.json` | generated | The ledger's MCP server; `rein sync` regenerates it and keeps servers you added. |
| `.claude/settings.json`, `.claude/rules/` | generated | Project settings (the command gate's hook entry, the plugin enabled at project scope) and path-scoped rules. |
| `ENGINEER.md`, `ARCHITECT.md`, `CLAUDE.md` | generated | Role rulefiles (at most 2 KB each; `rein pane` appends the role's) and a role-neutral `CLAUDE.md` that imports neither; refreshed by `rein sync`. |

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
| `~/.rein/bin/rein` | The CLI. |
| `~/.rein/mcp/`, `hooks/`, `shared/`, `templates/`, `config/` | The installed framework. |
| `~/.rein/plugin/` | The `rein` Claude Code plugin, built by `rein install`. |
| `~/.rein/roles/<project>-<hash>/` | The role settings files ([The role sandbox](role-sandbox.md)). |
| `~/.rein/accounts.json` | Registered Claude accounts ([Accounts](accounts.md)). |
| `~/.rein/ci/logs/` | CI run logs. |
| `~/.rein/trash/<date>/` | What `rein clean --apply` moved. |

## Environment variables

| Variable | Effect |
| :--- | :--- |
| `REIN_CI_GATE=0` | Close tasks without green CI. Say so when you use it. |
| `REIN_CI_SKIP=1` + `REIN_CI_SKIP_REASON="…"` | Push once without green CI; recorded with the reason. |
| `REIN_PLUGIN_INSTALL=0` | `rein install`, `rein init` and `rein sync` make no `claude plugin` call (the test suites set it). |
| `REIN_NO_PRUNE=1` | `rein sync` removes no file it wrote earlier. |
| `REIN_KEEP_LEGACY_WORKSPACES=1` | `rein sync` lists old provider workspaces but deletes nothing. |
| `REIN_STATE_IMPORT=0` | The state-import git hook does nothing. |
