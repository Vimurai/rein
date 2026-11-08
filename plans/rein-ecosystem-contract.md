# Rein ecosystem — the three-repo contract (D-150, 2026-11-08)

> Handed by the `rein` Architect to the `rein-app` and `rein-plugins` Architects. Each repo's own
> Architect turns its section into that repo's `.ai/architect.md` and blueprints. This file is the
> shared contract; a change to it is a D-### in `rein` and a notice to both other repos.

## 1. Repos and the direction of dependency

| Repo | Owns | Depends on |
|---|---|---|
| `rein` (this repo, v0.4.0) | The logic: `rein` CLI (bash), 17 MCP servers (Node 22+), hooks and the safe-exec gate, the test harness, the release artifact | nothing |
| `rein-app` (Rust) | Distribution and the window: installer, updater, process supervisor, profile/settings manager, pane UI | a signed `rein` release; a registered `rein-plugins` marketplace |
| `rein-plugins` | A Claude Code plugin marketplace: skills, agents, rules, hooks that are NOT part of the gate | the `rein` release only for its tests |

Rules: `rein-app` never contains a copy of Rein logic. `rein-plugins` never contains gate or hook logic that `rein doctor` audits. Nothing in `rein` depends on either other repo.

## 2. What `rein` guarantees to the app (owed by this repo — P-50)

1. **Release artifact**: every tag `vX.Y.Z` publishes `rein-X.Y.Z.tar.gz` plus a detached signature (minisign or sigstore; decided in P-50) and a `manifest.json`: version, minimum Node, the file list with sha256 per file, and the install layout below. The tarball is exactly what `install-rein.sh` lays out today.
2. **Install layout is stable**: everything under the Rein home directory (`$HOME/.rein`) as the install-first locator (`shared/locate.sh`, E-223/E-225) expects — `bin/`, `hooks/`, `mcp/`, `shared/`, `scripts/`, `config/`, `secrets/`, `run/`, `accounts.json`, `gate-override.json`. A layout change is a major version.
3. **Settings the app may own per profile** (`<config_dir>/settings.json`): `hooks` (the gate's PreToolUse/PostToolUse/Stop/SessionStart entries, byte-identical to what `rein install` writes), `enabledPlugins`, `extraKnownMarketplaces`, `attribution`. The app never writes `autoMode`, `permissions`, `defaultMode`; those stay with `rein install` and the operator (hard-deny rule, D-132).
4. **Health is machine-readable**: `rein doctor` gains or confirms a `--json` mode (P-50) and `rein state health --short` exists today. The app renders these; it never re-implements a check.
5. **Panes**: `rein pane <role>` is the only way a role is bound to a pane. The app calls it; it never mints a role token itself.
6. **Headless entry points stay stable**: `rein install`, `rein sync`, `rein init`, `rein doctor`, `rein start`, `rein pane`, `rein account`, `rein gate on|status`. Flags may be added, never removed, inside a major version.

## 3. What the app guarantees to `rein`

- Installs the verified artifact into the Rein home directory and then runs `rein install` and `rein doctor` from it. The app does not reimplement them.
- Runs Rein inside WSL2 on Windows; tmux and the gate stay POSIX. Native Windows is out of scope (see rein-app plan §Non-goals).
- Keeps tmux underneath through phase 2 (`rein pane`, `rein start` unchanged). Replacing tmux with app-drawn panes is a later phase with its own contract change.

## 4. What the plugins repo guarantees

- A valid Claude Code marketplace at `.claude-plugin/marketplace.json`; each plugin has `.claude-plugin/plugin.json`, is installable with `claude plugin` and passes `claude plugin eval`.
- No plugin touches the Rein home directory, the gate, or any profile setting. A plugin that needs Rein state reads it through the MCP servers Rein installs (`task-synchronizer-mcp` etc.), never through files.
- Skills moved out of `rein` keep their names (D-055: `arch-*` vs `rein-*` must not collide) and `rein doctor` keeps provisioning the ones the gate depends on from `rein` itself.
