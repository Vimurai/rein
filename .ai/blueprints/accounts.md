# Per-Project Claude Accounts (`CLAUDE_CONFIG_DIR`)

> Blueprint for D-095. Owner: Principal Architect. Extends `cli-collapse.md` (`.ai/start.json`,
> `rein start`) and `role-abstraction.md` (`rein pane`). Status: E-314 DONE (2026-10-14); E-318 and
E-315 OPEN (D-097 amendment: the user-level backstop copy and the launch check).

## Goal & Architecture

An operator with more than one Claude subscription (their own Max plan, a client's plan, a
company plan) needs each PROJECT to spend a chosen subscription, and needs to SEE which one a
pane is spending. Claude Code keeps login, settings and history in one config directory
(`~/.claude` by default) and honours `CLAUDE_CONFIG_DIR` to use another one, so one directory
per subscription gives one login per subscription. The only question is which directory a
project's panes start with — and the one place every Rein Claude launch goes through is
`rein pane`, which `exec`s the provider. That is where the variable is set, immediately before
the exec, for `rein start`'s panes and for a manual `rein pane` alike.

Not tmux: tmux environment variables are per session, so a pane created before the variable
was set, or a manual `rein pane` from another shell, would quietly spend the wrong account.

Summary: a project names an ACCOUNT in `.ai/start.json`; the operator's registry maps the name
to a config directory; `rein pane` exports `CLAUDE_CONFIG_DIR` from that mapping before exec and
labels the pane with the account.

## Core Concept

**An account is a NAME that the operator's machine resolves to a directory.** The project
holds only the name (`{"account": "work"}`); the mapping name → directory lives in the
operator-owned registry `~/.rein/accounts.json`; the directory holds the login. Three trust
levels, three places:

| What | Where | Owner | Contains |
|---|---|---|---|
| the choice | `.ai/start.json` `account` | project (Architect-writable, committed) | a name |
| the mapping | `~/.rein/accounts.json` | operator | name → absolute config dir |
| the login | `<config dir>` (e.g. `~/.claude-work`) | Claude Code | credentials, settings, history |

The reserved name **`default`** means `~/.claude` with `CLAUDE_CONFIG_DIR` left exactly as the
operator's shell had it — a project without an `account` key behaves as today, so nothing
changes for existing projects.

## Components

### 1. Account registry — `~/.rein/accounts.json` and `rein account`

- Shape: `{"accounts": {"work": {"config_dir": "/Users/me/.claude-work", "added": "2026-10-13"}}}`.
  `default` is never stored; it is implied.
- `rein account list` — one row per account: name, config dir, whether the directory exists,
  the login state, and whether `settings.json` matches the default directory's copy (`same` /
  `differs` / `missing`). `default` is always the first row. The login state comes from
  `CLAUDE_CONFIG_DIR=<dir> claude auth status`, whose JSON carries `configDirectory` and
  `authMethod` (Claude Code ≥ 2.1.268, documented on the CLI reference page); the row prints
  the method and asserts the reported directory IS the registered one — a mismatch is printed
  as `MISMATCH`, never silently accepted. The probe never prints a credential and falls back
  to "unknown (claude < 2.1.268)" on an older CLI.
- `rein account add <name> [--dir <path>]` — validates the name, refuses a registered name,
  creates the directory (default `~/.claude-<name>`), SEEDS it (Component 4), registers it, then
  launches `claude` under `CLAUDE_CONFIG_DIR=<dir>` in the foreground so the operator completes
  `/login` at once. Printing "now run /login" without launching is acceptable when stdin is
  not a TTY.
- `rein account remove <name>` — unregisters only; it never deletes the directory (the login
  inside it is the operator's). Refuses when any project in the launch records or the
  operator's tmux session is running under that account.
- The registry is read through one shell helper (`_account_dir <name>`) that `rein pane`,
  `rein start`, `rein doctor` and the E-293 backstop check all call — one resolver, one validation.

### 2. Project binding — `.ai/start.json` `account` and `rein start --account`

- `.ai/start.json` gains one optional key, `account`, matching `^[a-z][a-z0-9-]{0,23}$`. The
  `_start_config` validator's allowed-key set grows by exactly this key; everything else about
  the file (`cli-collapse.md` §Components 5) is unchanged, and an unknown name is rejected the
  same way an unknown key is (the file is an exec surface — E-208 lesson).
- `rein start --account <name>` writes or replaces the key, preserving every other key verbatim,
  then continues the launch. `--account default` removes the key. An unregistered name exits 2
  with `run: rein account add <name>` — `rein start` never creates accounts.
- **The pick**: when the project has NO `account` key, the registry has at least one account,
  and stdin is a TTY, `rein start` prints a numbered list (`default` first) and reads one choice,
  then writes it. When stdin is not a TTY it uses `default`, prints one notice line, and does not
  block — a pipeline or a hook must never wait on a prompt (the `_start_kill` precedent).
  `--dry-run` describes the pick it would make and writes nothing.
- The chosen account is printed on the launch banner: `rein start: account work (~/.claude-work)`.

### 3. Launch — `rein pane` exports `CLAUDE_CONFIG_DIR`

- `rein pane <role>` reads the project's account through `_start_config` (the same validator;
  no second parser), resolves it through `_account_dir`, and — only when the resolved provider
  is `claude` and the account is not `default` — `export CLAUDE_CONFIG_DIR=<dir>` immediately
  before the `exec` line, after the launch record is written. A missing directory or an
  unregistered name refuses the launch with exit 2 and the `rein account add` recipe: a pane
  that silently fell back to `default` would spend the wrong subscription, which is the one
  thing this feature exists to prevent.
- The pane is labelled: `@rein_account <name>` is set beside `@rein_role`, and the pane
  title becomes `<role> · <name>` (`architect · work`). `ai-watch` keeps routing by
  `@rein_role` (D-073); the account option is for humans and for `--status`.
- `rein start --status` gains an account column read from `@rein_account`; `rein doctor` prints
  the project's account, its directory and the login marker on one line.
- `tests/run.sh` and the harness's inherited-environment strip treat `CLAUDE_CONFIG_DIR` as a
  launch variable: a suite run from an account-bound pane must not inherit the operator's
  account (test-harness-isolation.md, the E-236 environment-dependence rule).
- **Probe first (D-097, the D-092 lesson; shape fixed by D-098).** Before the export is
  wired, E-315 records in LOG.md that the project-scoped gate fires under an account
  directory. The probe runs under a REAL login (a `-p` turn needs one), so it costs one short
  turn on that account and the OPERATOR approves it in their own terminal; the blocked command
  must be HARMLESS IF IT EXECUTES — never the real switch:
  `cd <project whose .claude/settings.json rein init wrote>` then
  `CLAUDE_CONFIG_DIR=$HOME/.claude-work claude -p --max-turns 1 --allowedTools "Bash(echo:*)" 'Run exactly this shell command and report its output verbatim: echo "rein gate off"'`.
  Proof is EITHER the `[SAFE_EXEC_BLOCK]` line from the pre-tool-use hook OR, if the phrase is
  not matched in an echo, the E-105 post-tool-use telemetry row for that session id (the hook
  ran). Neither → the hooks did not load under the account directory → E-315 STOPS and the
  Architect rules (D-098 names the fallback: the hook lines join the account refresh path).
- **The account's user-level copy is checked at launch (D-097).** For a non-default account,
  `rein pane` reads `<dir>/settings.json` through the E-293 helper's `plan` state and: refuses
  with exit 2 naming `rein sync` when the classifier backstop is OUTDATED (a stale copy only
  Rein can refresh) or the file is missing or unparsable (the account is not set up — name
  `rein account sync <name>`); prints the `rein doctor` one-line notice and continues when it is
  ABSENT (the backstop is the operator's y/N choice, exactly as in `~/.claude`). The default
  account keeps today's behaviour: `~/.claude` cannot be a stale copy, and a hand edit there is
  the D-090/D-097 classifier rule's own case.

### 4. Seeding a new config directory — what is shared and what is not

A new config directory starts EMPTY: no user settings, no permissions, no keybindings. The
Rein hooks, skills, agents and role overlays are PROJECT-scoped: the six hook entries are
written into the project's `.claude/settings.json` by `rein init` / `rein sync`
(`_configure_project_claude_settings`; gitignored, absolute paths into `~/.rein/hooks`), the
skills and agents under `.claude/`, so they work under any config directory without copying
(E-315 proves it with the probe in Component 3). What the config directory DOES move is the
USER layer, and one Rein-owned entry lives there: the E-293 classifier backstop in
`autoMode.hard_deny` (a project's `autoMode` is ignored by Claude Code, so it can live nowhere
else). A copy of it goes stale when its D-ruling text changes (E-306's label mechanism); D-097
makes `rein install` / `rein sync` refresh it in every registered account directory (below). What
`rein account add` seeds is the OPERATOR layer only:

| Item | Treatment | Why |
|---|---|---|
| `settings.json` (permissions, model, autoMode incl. the E-293 backstop, tui, theme) | COPY at add time | Claude Code rewrites this file (`/config`, permission grants); a symlink would be replaced by a plain file on the first atomic write, silently un-sharing it |
| `keybindings.json`, user-level `CLAUDE.md` (when present) | COPY | same |
| `skills/synced`, `plugins/synced` | NOT copied | downloaded from the logged-in claude.ai account on sign-in (documented on the skills and plugin-loading pages); the new account syncs its own |
| `.credentials.json`, `history.jsonl`, `projects/`, `sessions/`, `file-history/`, `shell-snapshots/`, `tasks/`, `teams/` | NEVER copied | login, history and per-account state |

Consequence to state in `rein account add`'s output: Claude Code's auto memory lives under
`<config dir>/projects/<project>/memory/`, so a project moved to a new account starts with an
EMPTY memory for that account. That is correct (memory is per login) and must be said once,
not discovered.

`rein account list` reports `settings: differs` when the copy has drifted from `~/.claude`, and
`rein account sync <name>` re-copies the two files on request (never automatically — the copy may
have diverged on purpose). The E-293 classifier-backstop check (`_cb_settings`, today hard-wired
to `~/.claude/settings.json`) iterates every registered account directory, so a missing
`hard_deny` rule in `~/.claude-work` is reported like one in `~/.claude`.

**The Rein-owned entry never goes stale (D-097, E-318).** `rein install` and `rein sync` run the
E-293 helper's `apply` over `~/.claude/settings.json` AND every registered account's
`settings.json` with REPLACE semantics only: an OUTDATED labelled copy is replaced in place
(E-306's path — the label carries the operator's earlier consent); ABSENT is reported, never
added (adding is the one-time y/N at `rein install`, and `rein account add` copies that choice);
every other key is untouched, so a copy that diverged on purpose keeps its divergence.
`rein account add` runs the same `apply` on the new directory after seeding (a no-op when
`~/.claude` is current). The D-097 rule text is the first entry refreshed this way.

### 5. Documentation and help

`ai help` lists `rein account` and `rein start --account`; README's launcher section gains the
three-line recipe (add an account, bind a project, see the label); `cli-collapse.md` §5 points
here for the `account` key (Architect edit, this blueprint's PR).

## Data Model

```
~/.rein/accounts.json          (operator, 0600 not required — it holds no secret)
{ "accounts": { "<name>": { "config_dir": "<absolute path under $HOME>", "added": "YYYY-MM-DD" } } }

.ai/start.json                  (project; existing keys unchanged)
{ "session": "...", "layout": "triad", "watch": true, "sizes": {...}, "account": "work" }

tmux pane options               (set by rein pane, read by --status)
@rein_role     = architect | engineer
@rein_account  = <name>            (absent = default)

name   := ^[a-z][a-z0-9-]{0,23}$    ("default" reserved, never stored)
dir    := absolute, under $HOME, no ".." component, not equal to ~/.claude
```

`_start_config` keeps its `"session|layout|watch|main|top"` print contract and appends a
sixth field, `account` (empty = default), so existing readers that split on `|` by position
are unaffected.

## API / Interface Contracts

| Command | Input | Output | Exit |
|---|---|---|---|
| `rein account list` | — | table: name, dir, exists, login, settings | 0 |
| `rein account add <name> [--dir p]` | valid name, unregistered | dir created, seeded, registered; `claude` launched for `/login` | 0; 2 invalid/duplicate; 3 dir creation failed |
| `rein account remove <name>` | registered name | registry row removed; dir untouched | 0; 2 unknown; 3 in use |
| `rein account sync <name>` | registered name | `settings.json` + `keybindings.json` re-copied | 0; 2 unknown |
| `rein start --account <name>` | registered or `default` | `start.json` updated, launch proceeds | 0; 2 unregistered |
| `rein start` (no key, TTY, ≥1 account) | choice from a numbered list | key written | as `rein start` |
| `rein pane <role>` | project with `account` | `CLAUDE_CONFIG_DIR` exported before exec; `@rein_account` + title set | 2 unregistered or missing dir |
| `rein start --status` | — | existing rows + account column | 0 |
| `rein doctor` | — | one `account:` line | as today |

Error text names the command that fixes the state (`rein account add work`), never the
credential or the directory contents.

## Security

- **The project cannot choose a directory.** `start.json` is Architect-writable and committed;
  a path there would be a committed exec surface (E-208). It names a registry KEY; the registry
  under `~/.rein` is operator-owned; the resolved path is validated before it is exported. An
  unknown name refuses, never falls back.
- **Directory rules as built (E-314 c49a485, adopted by D-098 — stricter than D-095's three).**
  `src/shared/accounts.py` is the ONE validator (`resolve|list|check|add|remove`); a directory
  is refused (`BADDIR`, exit 5) when it is empty or carries a control character; is not
  absolute; has a `.` or `..` component; is not under `$HOME`; is inside `~/.claude` (the
  default account) or `~/.rein` (the installed framework); is inside a git working tree; or
  when any component is not owned by the operator or is group- or world-writable. Registry
  rows are strict (`fullmatch` names, `{config_dir, added}` only, `added` as YYYY-MM-DD, no
  unknown keys; a duplicate key is a parse error); `default` is never a row. Seeding never
  writes through a symlink (no-follow copy of the three files). Inherited shell functions are
  cleared before the sourced library loads (the E-223 F13 guard, as in the hooks).
- **No credential is ever copied, printed, or read.** Seeding copies two settings files by
  name; the login probe is `CLAUDE_CONFIG_DIR=<dir> claude auth status`, whose JSON names the
  method and the directory and never a credential (E-314 as built; the earlier "tests
  existence only" wording was wrong). `rein account remove` never deletes.
- **The registry and every account's `settings.json` are under the classifier rule (D-097).**
  `~/.rein/accounts.json` joins the protected set; the rule's `~/.claude/settings.json` clause
  covers each registered `config_dir`; `rein account` is exempt like the other `rein` subcommands.
- **Same gate, same records.** `CLAUDE_CONFIG_DIR` changes where Claude Code keeps its state,
  not which hooks run: the role token (E-129), the launch record (E-294) and the pre-tool-use
  gate are project/`~/.rein`-scoped and unchanged. The authentication page documents that
  with `CLAUDE_CONFIG_DIR` set, Claude Code keeps `.credentials.json` under that directory
  and keys the macOS Keychain entry to it, so two directories hold two claude.ai logins.
  E-314 still opens with a probe proving it on this machine and this CLI version (two
  directories, two `claude auth status` outputs naming two `configDirectory` values) BEFORE
  anything is built on it — the D-092/D-093 lesson. Documented limit: a Console sign-in
  WITHOUT an API key is stored outside the config directory and is not separated; accounts
  are claude.ai logins (Pro/Max/Team), and `rein account add` says so.
- **The watcher and handoffs** do not read the account; `signal.json` and `ai-watch` are
  untouched. A handoff never crosses accounts because it never leaves the project's panes.
- Threat accepted: an operator who runs `rein pane` outside `rein start` in a shell that already
  exports `CLAUDE_CONFIG_DIR` for a `default` project keeps that export — `default` means
  "inherit", by design, and `--status` shows `(default)` so the inheritance is visible.

## Execution Constraints

- `rein pane` adds one registry read (python3, < 30 ms) on the launch path; no new node process.
- No new environment variable of Rein's own: `CLAUDE_CONFIG_DIR` is Claude Code's. No new
  dependency. The registry and `start.json` are read once per command, never cached.
- Bash 3.2-safe (macOS `/bin/bash`), as the rest of `src/bin/rein`.
- `src/bin/rein` is near its size ceiling (5953 lines, standard ≤ 1000 per file with the script
  exempted by name); `rein account` lands in a sibling file beside `rein` that `rein` sources, the
  split the engineering standard asks for, with its own unit coverage in `tests/unit`.

## Rollback Plan

- Per project: `rein start --account default` (removes the key) — the next `rein pane` launches as
  today. Per machine: delete `~/.rein/accounts.json`; the extra config directories keep their
  logins and are inert until re-registered.
- The feature reverts as one PR (E-314 + E-315); `start.json` files carrying `account` are then
  rejected by the old validator with the existing "unknown key" message, which names the key —
  the operator removes one line.
- No schema, no state.sqlite change, no migration.

## E-## Task Breakdown

- **E-314** (Tier 2): the registry and `rein account list|add|remove|sync` in a sourced sibling
  of `src/bin/rein`; seeding per Component 4; the E-293 backstop check over every account; the
  macOS two-login probe recorded in LOG.md before the command is built.
- **E-318** (Tier 2, after E-314, BEFORE E-315 — D-097): the classifier backstop `apply` over
  every registered account in `rein install` / `rein sync` / `rein account add` (replace-in-place
  only); the D-097 rule text as the byte-pinned constant and its pin test; `accounts.json` and
  the account directories in the rule.
- **E-320** (Tier 1, D-098): one shared completion gate in `src/shared` (the E-249 build gate
  AND the E-267 CI gate) called by `update_task_status` and `runHandover`, which moves to
  `orchestrator-mcp/run-handover.mjs` (index.js back under the 500-line warn).
- **E-315** (Tier 2, after E-314 and E-318): `account` in `_start_config`; `rein start --account`
  and the TTY pick; the Component 3 probe LOG line; `rein pane` export + launch check +
  `@rein_account` + title; `--status` column; `rein doctor` line; harness strip of
  `CLAUDE_CONFIG_DIR`; README + `ai help`.

Tests: the `rein_start_test`/`pane_binding_test` families and the `_start_config` validator cases
grow rows; the registry resolver gets a `tests/unit` table (valid name, reserved name, bad
dir, missing dir). No suite is named for a task (D-088).
