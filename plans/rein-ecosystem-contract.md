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

> Amended 2026-11-09 by D-153 and D-155. The normative text for items 1–4 is
> `.ai/blueprints/release-artifact.md` in `rein` (published for readers as `docs/app-contract.md`
> by E-422); this section is the summary.

1. **Release artifact**: every tag `vX.Y.Z` publishes `rein-X.Y.Z.tar.gz`, `rein-X.Y.Z.tar.gz.minisig` (minisign, prehashed form; the public key is baked into the app and committed here as `docs/contract/release-key.pub`) and `manifest.json` (schema 1: version, minimum Node, `key_id`, the layout, and path, sha256, size and mode per file). The tarball is the installer's own staged tree: `manifest.json` first, then regular files only. The manifest beside the tarball is an untrusted copy of the one inside.
2. **Install layout is stable**: the Rein home directory (`$HOME/.rein`) holds ten mirrored directories — `bin/`, `hooks/`, `mcp/`, `shared/`, `claude/`, `contracts/`, `templates/`, `copilot/`, `scripts/`, `config/` — plus `VERSION` and `manifest.json`. An installer writes nowhere else. Inside a mirrored directory a shipped path is written, and an unshipped path is deleted unless it matches `layout.operator_owned`; a shipped path wins over a pattern. A layout change is a major version (the minor, before 1.0.0).
3. **Settings the app may write in a profile** (`<config_dir>/settings.json`): `enabledPlugins`, `extraKnownMarketplaces`, `attribution`. Never `autoMode`, `permissions`, `defaultMode` (hard-deny rule, D-132), and never `hooks`: the gate's hook entries are not in a profile, they are in each project's `.claude/settings.json`, written only by `rein init` and `rein sync`. The app writes no file inside a project.
4. **Health is machine-readable**: `rein doctor --json` (schema 1: `version`, `status`, `checks[]` of `id`, `subject`, `status`, `line`, `fix`) and `rein state health --short`. The app renders these; it never re-implements a check. Doctor is not a polling probe; `state health` is.
5. **Panes**: `rein pane <role>` is the only way a role is bound to a pane. The app calls it; it never mints a role token itself.
6. **Headless entry points stay stable**: `rein install`, `rein sync`, `rein init`, `rein doctor`, `rein start`, `rein pane`, `rein account`, `rein gate on|status`. Flags may be added, never removed, inside a major version.

## 3. What the app guarantees to `rein`

- Installs the verified artifact into the Rein home directory (unpacked `manifest.json` included, `VERSION` written last) and then runs `rein install` and `rein doctor` from it. The app does not reimplement them. `rein install` recognises the unpacked artifact and performs every post-copy step itself: tree check against the manifest, toolchain pin, install stamp, shell profile lines, removal of retired server mirrors (D-155 r4 and addendum). A `manifest.json` that disagrees with `VERSION` is refused (`[INSTALL_INCOMPLETE]`, exit 3); a layout comparison with a clone install is taken after `rein install` on both sides.
- Runs Rein inside WSL2 on Windows; tmux and the gate stay POSIX. Native Windows is out of scope (see rein-app plan §Non-goals).
- Keeps tmux underneath through phase 2 (`rein pane`, `rein start` unchanged). Replacing tmux with app-drawn panes is a later phase with its own contract change.

## 4. What the plugins repo guarantees

- A valid Claude Code marketplace at `.claude-plugin/marketplace.json`; each plugin has `.claude-plugin/plugin.json`, is installable with `claude plugin` and passes `claude plugin eval`.
- No plugin touches the Rein home directory, the gate, or any profile setting. A plugin that needs Rein state reads it through the MCP servers Rein installs (`task-synchronizer-mcp` etc.), never through files.
- Skills moved out of `rein` keep their names (D-055: `arch-*` vs `rein-*` must not collide) and `rein doctor` keeps provisioning the ones the gate depends on from `rein` itself.
