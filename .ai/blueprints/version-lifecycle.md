# Version Lifecycle Blueprint — stamp, `ai init` upgrade, `ai clean`

> D-074 (2026-09-17). Gives AI-OS a version that is recorded where it is installed and where it
> is provisioned, makes `ai init` an idempotent UPGRADE on an existing project, and adds
> `ai clean`, the one command that removes what earlier versions left behind. Extends
> `workspace.md` (provisioning), `git-hooks.md` (stub upgrade), `claude-native-consolidation.md`
> (D-069 legacy pruning, which today mostly PRINTS) and `local-ci.md` (log retention).

## Goal & Architecture
Operators run several AI-OS projects on one machine and re-run `ai init` expecting it to bring
a project to the installed version. Today nothing records which version provisioned a project
(`.ai/state.json`'s `version` is the state schema), `ai init` only creates files that are
MISSING (so `roles.json` never gains the `tester` role and `providers.json` keeps a removed
provider), the install mirror copies `mcp/` and `hooks/` without deleting (an orphan
`~/.ai-os/mcp/intent-refiner-mcp` exists now), `.claude/settings.json` keeps `mcp__*` allows
for servers that no longer exist, agents are never pruned, and the D-069 legacy sweep prints
`rm -r` hints instead of acting. Users: the operator (`ai init`, `ai clean`, `ai doctor`),
`install-ai-os.sh`, and the completion gate (`BUILD_STALE`, E-249).

## Core Concept
**One version, stamped twice, compared everywhere.** `package.json` is the only place the
version is typed. The installer writes it to `~/.ai-os/VERSION`; `ai init`/`ai sync` write it
into the project as `project.aios_version` (+ `provisioned_at`) through `state-db`. Every
lifecycle command compares the three (clone, mirror, project) and says which is behind.
**Generated files are refreshed, templates with a schema are merged, user content is never
touched, and removal is a separate, explicit, reversible command.**

## Components
1. **Version source and stamps.** `src/bin/ai`'s `VERSION=` literal and the installer's
   literals go; the installer reads `package.json` and writes `~/.ai-os/VERSION`; `ai
   --version` reads the mirror file (falls back to the clone's `package.json` in the dev
   tree). `ai init` and `ai sync` stamp `project.aios_version` / `provisioned_at` via a
   `state-db` helper (never by editing `state.json`). A unit test asserts `package.json`,
   the CHANGELOG top entry and `~/.ai-os/VERSION` agree after install.
2. **`ai init` as upgrade (idempotent).** On an existing project `ai init` (a) prints
   `project 3.0.0 → installed 3.1.0`; (b) REFRESHES everything generated: the three
   bootloaders, `.mcp.json`, `.claude/` skills/agents/overlays/settings hooks and env,
   git hook stubs including `pre-push`; (c) MERGES schema-bearing templates:
   `roles.json` gains missing roles (e.g. `tester`) and loses roles whose provider no longer
   exists, `providers.json` drops removed providers, `state.json` gains missing
   `project.*` keys — existing values and unknown keys are preserved; (d) never writes
   BRIEF, RULES, SEED, DIGEST, TASKS, LOG, architect.md or blueprints; (e) ends with an
   upgrade summary (`N refreshed, M merged, K legacy items — run: ai clean`) and the stamp.
   `ai init --check` is the dry run (exit 1 when anything would change). `ai sync` keeps
   its current scope and calls the same stamp helper.
   **`.mcp.json` is generated but partly user-owned**: `generate_mcp_json` rebuilds it from
   the registry on every init/sync and, despite its comment, drops servers the user added
   and any `env` they set. Rule: servers whose name is in `registry.json` or in the legacy
   registry's `registry_history` are OWNED (regenerated, removed when retired); every other
   entry is USER-ADDED and is carried over byte-for-byte, as is a user `env` block on an
   owned server. A test adds a foreign server and asserts it survives init and sync (E-274).
3. **Legacy-artefact registry** — `src/config/legacy-artefacts.json`, the single list of
   what earlier versions created and no longer do. Each entry: `path` (glob, project- or
   HOME-relative), `kind` (file|dir|setting|process), `class` (`safe` = reproducible from
   `src/` or provably ours by hash; `prompt` = may hold user content), `since` (version
   that stopped shipping it), `known_hashes` (sha256 of every template version ever
   shipped, for files), `note`. Seed entries: `.gemini/`, `.agents/`, `GEMINI.md`,
   `AGENTS.md`, `testsprite_tests/`, nested `.claude/.claude/`, `.ai/legacy/`,
   `.git/hooks/*.pre-aios`, `~/.ai-os/mcp/<not in registry>`, `~/.ai-os/hooks/<not in
   src/hooks>`, the six orphaned v2 contracts, `~/install-ai-os.sh` (old full installer),
   `~/.ai-os/run/role-*.lock` (dead pid), `~/.ai-os/run/build-*.json` (dead pid),
   `settings.json` `mcp__<server>__*` allows for servers absent from `registry.json`,
   `.claude/agents/<not in role manifest>`, orphan `ai-watch` processes (ppid 1, cwd under
   the temp dir). A test asserts every D-069 removal has an entry. `~/.gemini/` is NOT ours
   (Antigravity user data with OAuth) and is listed as `not-ours`: printed, never touched.
4. **`ai clean`** — dry run by default. `ai clean` lists every registry match in the
   current project and in HOME, grouped `safe` / `prompt` / `not-ours`, with the reason and
   the action it would take. `ai clean --apply` removes the `safe` class. `ai clean --apply
   --all` also removes the `prompt` class after an interactive confirmation per group
   (`--yes` answers them; a non-interactive stdin without `--yes` refuses, as `ai start
   --kill` does). Nothing is deleted: removed paths are MOVED to
   `~/.ai-os/trash/<ISO date>/<origin>/…` with a `manifest.json` (origin path, class,
   registry entry, sha256) and kept 30 days; `ai clean --restore <date>` moves them back;
   `ai clean --purge` empties trash older than 30 days. Processes (`process` kind) are
   signalled TERM then KILL and listed, not trashed. Every apply appends one LOG line and
   one `~/.ai-os/clean.log` line. `settings.local.json` is user-owned: `ai clean` prints
   the offending lines and never edits it.
5. **Mirror hygiene in the installer.** `src/mcp/` and `hooks/` are synced with `--delete`
   like the other trees (the cp fallback gets an explicit orphan pass); `purge_orphans`
   covers every mirrored tree, not three; the installer's "Next steps" text stops naming
   deprecated commands. Agents get the same `_SYNC_MANIFEST.json` treatment as skills so
   `_prune_workspace_dir` can prune them; `_configure_project_claude_settings` removes
   `mcp__<server>__*` allows whose server is not in `registry.json` (user-added servers,
   i.e. names never in any registry version, are kept — the registry history list in the
   legacy registry decides). `~/.ai-os/run/` locks and build records with dead pids are
   reaped by `ai sync` and `ai clean`.
6. **`ai doctor` lines.** `version: clone 3.1.0 · mirror 3.1.0 · project 3.0.0 — run: ai
   init`; `mirror orphans: N — run: ai clean`; `legacy artefacts: N safe / M prompt — run:
   ai clean`; `watchers: 1 live, 17 orphaned — run: ai clean --apply`; `ai on PATH:
   ~/.ai-os/bin/ai (shadowed by /usr/local/bin/ai)` from `which -a`. Stale MCP servers stay
   a report with pids (E-249): nothing kills a live session's stdio child; the operator
   restarts via `/mcp` or the session, as today.

## Data Model
```
~/.ai-os/VERSION                      "3.1.0\n"  (written by install-ai-os.sh from package.json)
.ai/state.json  project: { current_tier, release_verdict, focus,
                           aios_version: "3.1.0", provisioned_at: "2026-09-17T10:00:00Z" }
src/config/legacy-artefacts.json
  { "version": 1,
    "registry_history": ["TestSprite", "intent-refiner-mcp", …],   # server names ever shipped
    "entries": [ { "id": "gemini-workspace", "path": ".gemini/", "kind": "dir",
                   "class": "prompt", "since": "4.0.0", "known_hashes": [], "note": "D-069" },
                 { "id": "mirror-orphan-mcp", "path": "~/.ai-os/mcp/*", "kind": "dir",
                   "class": "safe", "since": "*", "rule": "not-in-registry" }, … ] }
~/.ai-os/trash/<date>/manifest.json   [{ origin, class, entry_id, sha256|null, moved_at }]
~/.ai-os/clean.log                     ISO ts | project | action | count | ids
```

## API / Interface Contracts
- `ai --version` → `ai-os <VERSION>`; exit 0. `ai init --check` → exit 0 nothing to do,
  1 changes pending (listed). `ai init` on an existing project never exits non-zero for a
  legacy finding — it lists and points at `ai clean`.
- `ai clean [--apply] [--all] [--yes] [--project-only|--home-only] [--json]`; exit 0 when
  nothing (more) to do, 1 when findings remain (dry run with findings, or `prompt` items
  left without `--all`), 2 on refusal (non-interactive without `--yes`) or trash failure.
  `ai clean --restore <date> [--yes]`, `ai clean --purge [--older-than 30d]`.
- `AI_OS_CLEAN_DISABLE=1` makes `ai clean` a no-op that prints the findings only.
- The legacy registry is data: adding an entry needs no code change; a `class` of `safe`
  requires either `known_hashes` or a `rule` (`not-in-registry`, `dead-pid`,
  `not-in-manifest`, `orphan-process`) — a bare `safe` path is rejected by the loader.

## Security
- `ai clean` operates only under the project root (via `pwd -P`) and `$HOME`, only on
  registry matches, and never follows symlinks out of either root. `~/.gemini/` and any
  `not-ours` entry are never touched. `settings.local.json` is never edited.
- Trash keeps sha256 per item; `--restore` refuses when a restored path now exists.
- Killing processes is limited to `ai-watch` orphans identified by ppid 1 + cwd under the
  temp dir + the watcher script path; MCP server children of live sessions are reported
  with pids, never signalled.
- Version stamps are written through `state-db` (ACID); no hand edits of `state.json`.

## Execution Constraints
- `ai init` on an existing project stays under 5 s (it already regenerates `.mcp.json`
  and re-provisions `.claude/`; the merge adds a JSON read/write per template).
- `ai clean` dry run under 3 s on this machine: registry globs, one `which -a`, one `ps`
  scan, no network. Trash moves are `mv` within the same filesystem (HOME); a cross-device
  origin falls back to copy + verify + delete.
- Trash retention 30 days; `--purge` is manual, never automatic.

## Rollback Plan
- `ai clean --restore <date>` reverses any apply (trash is the audit trail). Entries in
  the legacy registry can be removed or downgraded to `prompt` without code.
- `AI_OS_CLEAN_DISABLE=1`; the installer's `--delete` on `mcp/` and `hooks/` is guarded
  by `AI_OS_INSTALL_NO_DELETE=1` for one release.
- The merge in `ai init` is additive; the pre-merge `roles.json`/`providers.json` are kept
  as `<name>.pre-<version>.json` beside them for one release.
- Version stamps are informational until `ai doctor` reads them; removing the keys is safe.

## E-## Task Breakdown
- **E-270** — Components 1, 2, 6: version source + stamps, `ai init` upgrade/merge/`--check`,
  doctor lines. (Runs after E-271, the bridge visibility task; its own text's "after E-270"
  is a self-reference from ID assignment — read it as "after E-271".)
- **E-272** — Components 3, 4: legacy-artefact registry, `ai clean` with trash/restore/purge.
- **E-273** — Component 5: installer `--delete` for `mcp/` and `hooks/`, agent manifests
  and pruning, `mcp__*` allow pruning, `run/` reaping, orphan-watcher process kind.
