# CLI Collapse & Tmux Workflow

## Goal & Architecture
The goal is to minimize the footprint of the `rein` bash CLI by collapsing it down to essential lifecycle and diagnostic commands (`init`, `sync`, `install`, `doctor`, `uninstall`). All other commands (e.g., `update`, `preflight`, `review`, `test`, `archive`, `digest`, `migrate-state`) will be migrated into conversational prompts or tool calls executed directly within the Claude or Gemini CLI environments. Furthermore, a `tmux` split-pane workflow will be formally recommended as the standard operating environment for the Rein Triad to improve visibility and concurrent execution.

## Core Concept
The `rein` script transitions from a multi-purpose orchestrator into a strict bootloader/installer. Operational commands become part of the agentic workflow (e.g., asking Claude "run a vibe test" instead of typing `rein test --vibe` in the terminal). The user's interface to the system becomes entirely conversational within the agent CLIs, facilitated by a persistent tmux layout.

## Components
1. **Bootloader CLI (`bin/rein`)**: Stripped down to `init`, `sync`, `install`, `doctor`, `uninstall`. Removes bash implementations for `update`, `preflight`, `review`, `test`, `mcp-setup`, `archive`, `digest`, `migrate-state`.
2. **Conversational Prompts/Skills**: The functionality of removed CLI commands is converted into corresponding agent skills or prompt templates in the documentation/bootloader files.
3. **Tmux Workflow Setup → `rein start` (D-059, 2026-09-09)**: superseded the "helper script" idea. See §`rein start` below.

## `rein start` — Triad Launcher (D-059)
**Lifecycle command set (explicit)**: `init`, `sync`, `install`, `doctor`, `uninstall`, **`start`**, plus the D-053/D-054 shell primitives `handoff`, `add-task`, `pane`, `watch`. Nothing else belongs in `bin/rein`.

**Contract** — `rein start [--no-watch] [--detach] [--dry-run] [--status] [--kill [--yes]]`:
1. **Composition only.** The launcher runs exactly two things it does not own — `rein pane <role>` and `ai watch`, both from the installed `rein` on PATH. Never a project-supplied script, never a provider binary directly (`rein pane` owns binding, title pinning and the launch argv).
2. **Layout is derived from `.ai/roles.json`.** The role with the lower `pane_identifier` receives the lower tmux `pane_index`, so the E-209 ordinal fallback agrees with the layout by construction. Default layout `triad`: engineer left (full height), architect right-top, watcher right-bottom. The watcher pane's foreground is a shell script, which `_is_agent_cmd` excludes — it never shifts the agent ordinals. Tests assert the resulting pane order for BOTH role orders.
3. **Shell-hosted agent panes.** Each agent pane is an interactive shell; `rein start` waits for the prompt (`pane_current_command` is a shell) and then `send-keys` `rein pane <role>`. When the provider exits the operator keeps a shell and can rerun `rein pane`. `rein pane` pins the title and sets `allow-rename off`.
4. **Idempotent.** In a project with live panes a re-run re-pins titles, starts the watcher only if no process holds the `ai watch` single-writer lock, and attaches — never duplicates panes. `--kill` tears the project window down, watcher first (confirm unless `--yes`). `--status` lists project panes (role, title, command) and the watcher lock holder.
5. **Optional `.ai/start.json`**: `session` (`^[A-Za-z0-9_-]{1,32}$`), `layout` (`triad` only until another is blueprinted), `watch` (bool), `sizes` (numeric percentages). Values become tmux arguments, so anything outside these shapes is rejected (E-208 audit lesson: Architect-writable config is an exec surface). Defaults: `session=rein`, window = project basename. D-095 adds one optional key, `account` (a registry NAME, never a path) — see `accounts.md`.
6. **Non-tmux hosts**: exit 2 and print the manual recipe (`rein pane engineer`, `rein pane architect`, `ai watch`) — tmux remains the recommended UX, not a requirement.

**Reference layout** (the operator's live session, 2026-09-09): `rein:1`, engineer `104x49` left, architect `103x32` right-top, watcher/shell `103x16` right-bottom.

**Rollback**: remove the `start` dispatch; the three manual commands keep working unchanged.

## Data Model
No new SQLite state tables are required. The state model remains driven by `TASKS.md` and `state.json` via MCP.

## API / Interface Contracts
- **CLI Commands**:
  - `rein init`: Scaffolds the `.ai` directory.
  - `rein sync`: Synchronizes skills and agents.
  - `rein install`: Installs global config.
  - `rein doctor`: Validates health.
  - `rein uninstall`: Cleans up Rein.
- All removed commands will display a deprecation notice guiding the user to the equivalent agent command.

## Security
- By moving execution from bash scripts into the agent environment, commands that mutate state will now pass through the standard `safe-exec-mcp` and `approval-mcp` (HITL) gates, improving the security posture.

## Execution Constraints
- Agents must be equipped to handle the migrated commands efficiently.
- `tmux` recommendation must be documented clearly in `README.md` and `CONTRIBUTING.md` as the optimal UX, not a hard requirement that breaks non-tmux users.

## Rollback Plan
- Revert the `bin/rein` bash script from git history.
- Restore the legacy documentation.

## E-## Task Breakdown
- E-## (CLI Reduction): Remove logic for `update`, `preflight`, `review`, `test`, `archive`, `digest`, `migrate-state` from `src/bin/rein`. Replace them with deprecation echo statements guiding users to the agent prompts.
- E-## (Agent Skills Migration): Ensure all removed CLI functions have a 1:1 mapping to an agent skill (e.g., `rein-review`, `rein-test`, `rein-archive`, `rein-digest`, `rein-preflight`).
- E-## (Tmux Documentation): Update `README.md`, `CONTRIBUTING.md`, and `docs` to strongly recommend the tmux split-pane workflow, including a snippet for `~/.tmux.conf` or an automated setup script. → closed by **E-228** (docs point at `rein start`).
- **E-227** (Tier 2, D-059): `rein start` launcher core — session/window reuse, layout derived from `roles.json`, shell-hosted panes + `send-keys rein pane <role>`, watcher pane, idempotency, `--no-watch`/`--detach`/`--dry-run`, constrained `.ai/start.json`, non-tmux exit 2 + recipe.
- **E-228** (Tier 1, dep E-227): `--status`/`--kill`, `rein doctor` start-readiness line, README/CONTRIBUTING docs, `rein install`/`rein init` hint.

## Per-Project tmux Sessions (D-068 Amendment, 2026-09-11)

### Goal & Architecture
`rein start` puts every project into ONE shared tmux session (`rein`), one window per project.
Live use with several projects showed why that is wrong: a tmux session has a single
*current window* shared by every attached client, so `rein start` in project B (which runs
`select-window`/`switch-client` to B's window) flips the terminal that was showing project A
too; and the project window is located by NAME ONLY (`_start_window_id session basename`), so
two checkouts with the same basename share one window, and a window whose name drifted is
recreated beside the old one. Per-project watchers then compete over panes that all sit in
one session. Ruling: **one tmux session per project, named after the project, owned via a
session-level stamp; the watcher scopes to its own session as well as to the project path.**
Operators launch and attach to projects independently; nothing one project does moves
another project's client or panes.

### Core Concept
**The stamp is the identity; the name is a label.** Each session `rein start` creates carries
the tmux session environment variable `REIN_PROJECT=<physical absolute project path>`
(`tmux set-environment -t <session> REIN_PROJECT <path>`). Discovery reads the stamp back
(`tmux show-environment -t <session> REIN_PROJECT`) across `tmux list-sessions`, so reuse,
`--status` and `--kill` find the project's session even when the *name* had to be suffixed.

### Components
1. **`_start_session_name <project> <start.json session|"">`** (in `src/bin/rein`) — derives
   the default: explicit `.ai/start.json` `session` wins verbatim (it is already validated
   against `^[A-Za-z0-9_-]{1,32}$`); otherwise `basename(project)` with every character
   outside `[A-Za-z0-9_-]` replaced by `-`, leading `-`/`_` dropped (a leading `-` would
   parse as a tmux flag; tmux itself rewrites `.`/`:`), truncated to 32, and `rein` only if
   the result is empty. Pure function, unit-tested on `my.app`, `-weird`, `über`, a
   40-character name.
2. **`_start_find_session <project>`** — the discovery pass. Returns the name of the session
   whose `REIN_PROJECT` stamp equals the project's physical path, else empty. Runs before
   any name derivation so a project whose name was suffixed last time is found again.
3. **Collision policy** — when no stamped session exists and the derived name is already a
   live session (stamped to a *different* path, or unstamped = a foreign session the
   operator owns), the name becomes `<first 25 chars>-<6 hex of sha1(path)>`. Never reuse a
   session this project does not own. The chosen name is printed once at creation.
4. **Legacy adoption** — when no stamped session exists but the shared `rein` session has a
   window named `basename` with at least one pane whose `pane_current_path` is inside the
   project, `rein start` reuses that window in place (idempotency for an operator mid-sprint)
   and prints one line: `rein start: reusing legacy shared window rein:<w> — run 'rein start
   --kill' then 'rein start' to move this project to its own session '<name>'`. `--status` and
   `--kill` follow the same lookup order (stamp → legacy window) so they act on what the
   operator sees.
5. **Client movement** — from outside tmux: `attach-session -t <session>`; from inside tmux:
   `switch-client -t <session>` — which moves ONLY the invoking client. `select-window`
   against a shared session is no longer composed anywhere in the launcher.
6. **Watcher session scope** (`src/bin/ai-watch`, see `interactive-bridge.md §Security`) —
   `_project_panes` lists panes of the watcher's OWN session (`tmux list-panes -s -t
   <session_name>`) when the watcher runs inside tmux, and keeps the `pane_current_path`
   filter; the path is compared against `pwd -P` (tmux reports the process's physical cwd, so
   a project entered through a symlink previously matched zero panes and dropped every
   signal). `AI_WATCH_ALL_SESSIONS=1` restores the `-a` scan (for a watcher started from a
   different session on purpose). The startup banner names the session it is scoped to.

### Data Model
No SQLite change. New tmux-side state, per session:
```
REIN_PROJECT = /Users/me/dev/<project>      # physical path, set at new-session time
window        = basename(project)            # unchanged
```
`.ai/start.json` is unchanged in shape; the `session` key's meaning changes from "the shared
session name" to "override the derived per-project name". Its default is no longer a literal.

### API / Interface Contracts
- `rein start` — creates `<derived>` (or reuses the stamped/legacy match) and moves only the
  invoking client. Exit codes unchanged (0 ok, 2 config/tmux-missing).
- `rein start --dry-run` — prints `tmux new-session -d -s <derived> -n <basename> -c <path>` and
  `tmux set-environment -t <derived> REIN_PROJECT <path>`; never inspects or writes tmux.
- `rein start --status` — first line names the session and how it was found:
  `rein start --status: <session>:<window> (@id) [owned|legacy]`.
- `rein start --kill` — `kill-window`, watcher first, unchanged; when the window was the
  session's last, tmux destroys the session and the command says so.
- `ai watch` — banner `ai-watch: watching <signal> (poll Ns, scoped to <dir> in session <s>)`.
  Resolution order (`§Pane Resolution Precedence`) is unchanged; only the candidate set shrinks.

### Security
- The session name and the stamp value are tmux arguments (E-208 audit lesson): the name is
  derived by a whitelist rewrite, never passed through from the environment; the stamp is the
  `pwd -P` of the project, quoted, and only ever *compared*, never executed.
- Reuse requires stamp equality; a foreign session with a matching name is never adopted
  (collision policy suffixes instead). This closes the "wrong project's panes" injection path
  from the launcher side; the watcher's session scope closes it from the bridge side.
- Legacy adoption additionally requires a pane rooted in the project — a name alone is not
  enough.

### Execution Constraints
- Discovery is O(sessions): one `list-sessions` plus one `show-environment` per session; on an
  operator's machine that is single-digit. Budget < 200 ms host-relative (D-062 rule: print
  both numbers).
- Fail-open: if `set-environment`/`show-environment` are unavailable (very old tmux) the
  launcher proceeds by name and prints that ownership could not be stamped.
- Tests: composition via `--dry-run` for the derived name, the stamp command and the
  suffixing; live behaviour on an isolated tmux server (`-L`, `register_cleanup` BEFORE
  create, E-240) for: two fixture projects → two sessions, same basename → suffix, foreign
  same-name session → suffix, legacy window adopted, `--status`/`--kill` find the stamped
  session, a client attached to session A stays on A when `rein start` runs for B.

### Rollback Plan
`REIN_SHARED_SESSION=1` restores the single `rein` session (today's behaviour, made
explicit); an operator can also pin `.ai/start.json` `{"session":"rein"}` per project.
`AI_WATCH_ALL_SESSIONS=1` restores the watcher's all-sessions scan. Neither touches state.

### E-## Task Breakdown (D-068)
- **E-252** (Tier 2): per-project session derivation, stamp, discovery, collision suffix,
  legacy adoption, client movement, `--status`/`--kill` lookup, docs (README recipe still
  says `tmux new-session -s rein`; the reference layout above says `rein:1`).
- **E-253** (Tier 2): watcher session scope + physical-path comparison + banner + opt-out.
