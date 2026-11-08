# rein-app — plan handed to its Architect (from `rein`, 2026-11-08)

Read `plans/rein-ecosystem-contract.md` in the `rein` repo first; this plan assumes it.

## Decision already taken (D-150 in `rein`)
Rust is the shell, not a rewrite. The app installs, updates, supervises and draws; the Rein logic (bash CLI, Node MCP servers, hooks, gate) stays in `rein` and ships as a signed release the app consumes. Full Rust port of the logic: rejected (25,000 tested lines, POSIX security model, no user-visible gain).

## Non-goals
- Native Windows without WSL2. Windows = app on Windows, Rein inside WSL2 (the Docker Desktop / VS Code WSL shape).
- Bundling Claude Code. Detect it; offer the official installer.
- Replacing tmux in phases 1–2.

## Phase 1 — `rein-app` CLI: installer + updater (2–4 weeks, Tier 2)
Deliverable: `brew install rein` (formula or cask), a Windows installer (`.exe`/MSI via cargo-dist) that ensures WSL2 + Ubuntu then installs inside it, `.deb`/AppImage for Linux.

Components:
1. **Fetcher/verifier**: downloads `rein-X.Y.Z.tar.gz` + signature + `manifest.json` from the `rein` release, verifies signature and per-file sha256, refuses otherwise (fail closed).
2. **Layout writer**: unpacks into the Rein home directory exactly as `install-rein.sh`; then runs `rein install` and `rein doctor` from the installed tree and shows the doctor output. Never edits files in that tree itself after unpacking.
3. **Runtime check**: Node 22+, git, sqlite3, tmux, Claude Code. Phase 1 declares Node as a package dependency (brew/apt); bundling a pinned Node is phase 2 work.
4. **Profile manager**: lists Claude profiles (the default config dir, `.claude-personal`, every `config_dir` in `accounts.json`) and writes only the keys contract §2.3 allows (`hooks` via `rein install`, `enabledPlugins`, `extraKnownMarketplaces` for `rein-plugins`, `attribution`). Reads before writes, merges, never replaces, validates JSON after.
5. **Updater**: `rein-app update` checks the newest `rein` tag, shows the changelog, installs on confirm; `rein-app rollback` restores the previous tree (keep N=2).
6. **Windows path**: `rein-app` on Windows is a thin launcher: checks `wsl --status`, installs Ubuntu if absent, runs the Linux `rein-app` inside WSL, opens Windows Terminal into the project's tmux session.

Tests: a fake release server fixture (good tarball, bad signature, tampered file, missing manifest); layout equality against `install-rein.sh` on the same version; profile merge keeps every pre-existing key; Windows launcher logic unit-tested with a stubbed `wsl.exe`.

## Phase 2 — desktop app (6–10 weeks, Tier 3 at the settings/gate boundary)
Tauri (Rust core, web UI) is the recommended frame; a `ratatui` TUI is the fallback if a window is not wanted.

Components:
1. **Project list** from the Rein run directory and the sessions tmux reports; open/close/`rein start` per project.
2. **Pane view**: embeds the project's existing tmux session (attach via a pseudo-terminal, xterm.js front end). tmux stays the multiplexer; the app is the window. Role per pane comes from `rein pane`.
3. **Status**: `rein doctor --json`, `rein state health --short`, incident status, stale-server stamp (E-249) rendered live; every ✗ shows the fix line doctor prints.
4. **Settings UI** for exactly the contract §2.3 keys, per profile.
5. **Bundled Node** (pinned, 60–100 MB) so the app has no runtime dependency besides git and tmux.
6. **Signing**: Apple notarization and a Windows code-signing certificate before first public release; budget both.

Tests: Tauri e2e for the pane attach/detach cycle; snapshot tests of status rendering from recorded doctor JSON; the settings UI tested through the phase-1 profile manager, not a second code path.

## Phase 3 — later, each its own ruling
- App-drawn panes without tmux (requires a contract change in `rein`: `rein pane` must accept a pty handed in).
- Native Windows: months; only if the gate is ported, which `rein` has not decided.

## Repo bootstrap for your Engineer (first E-## tasks)
- E-1: `cargo init` workspace: `rein-app` (bin), `rein-release` (fetch/verify lib), `rein-profiles` (settings lib); cargo-dist config for mac/linux/windows; CI matrix building all three.
- E-2: `rein-release`: fetch + verify against a fixture server; fail closed on every bad input.
- E-3: layout writer + `rein install`/`doctor` invocation; equality test against `install-rein.sh`.
- E-4: `rein-profiles`: merge/validate; the four allowed keys only.
- E-5: Homebrew formula + cargo-dist release; the Windows WSL launcher.

Tier each as the contract suggests; the profile manager and anything touching hooks is Tier 3 (security_engineer review).

## Open questions for the `rein` Architect (send back, do not decide locally)
1. Signature scheme (minisign vs sigstore) — P-50 in `rein`.
2. Whether `rein doctor` gets a full `--json` mode or the app parses the text — P-50.
3. Where the `accounts.json` schema is documented so the profile manager can rely on it.
