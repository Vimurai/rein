# Changelog

All notable changes to **ai-os-v2** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); this project adheres to [Semantic Versioning](https://semver.org/).

## [0.4.0] — First public release

The first release of **Rein** in its public repository. The version line restarts at
0.4.0 (D-131): the private predecessor AI-OS shipped 2.0.0 to 4.0.0, listed below under
"Private predecessor", and a project stamped `4.0.0` is restamped `4.0.0 → 0.4.0` by
`ai sync` like any other version change.

### Changed

- **Open source under Apache-2.0, funded by donations (D-123, D-124).** `LICENSE` and
  `NOTICE` set the terms; the paid-distribution code planned before D-123 was removed
  before it shipped. Contributions are accepted under the DCO (`git commit -s`, see
  `CONTRIBUTING.md`).
- **Public development from day one (D-129).** `Vimurai/rein` was bootstrapped once from a
  scrubbed snapshot of the private repository (678 commits, 2025–2026) and is the
  development repository from its first commit; the predecessor's history stays private
  because it carries personal data. The export pipeline, mirror and import tool planned by
  D-126..D-128 were cancelled before they were built.
- **The product is named Rein (D-125 addendum, D-132).** Every spelling of the old name
  becomes the Rein form, with a one-release compatibility layer so existing installs and
  projects migrate on `ai sync`; the command `ai` and the `.ai/` directory keep their names.

### Added

- **Privacy by construction (D-130).** One redaction module (`src/shared/publish-scan.mjs`)
  is applied at write time by every automated writer into the tracked tree; a hit becomes
  `[redacted:<class>]` and is logged, never refused. Telemetry, incidents and insights never
  leave the home directory.
- **Privacy gates (D-129, D-130).** The pre-commit hook refuses a commit whose author is not
  the public identity in `.ai/publish.json` and a staged file the five-class scan flags; the
  `privacy scan` job runs the same scan on every push and pull request. Both are required
  for merge on `main`, beside `ai ci run`.
- **Hosted CI for `master` (E-332, D-102 §5b, D-103).** `.github/workflows/ci.yml` runs on
  pull requests to `master`: it installs AI-OS from the merge commit and runs `ai ci run` —
  the local recipe, not a copy of it (`tests/unit/hosted-ci-workflow.test.mjs` refuses a
  copied step). Read-only token, no secrets, log and `.ai/ci/*.json` uploaded on every
  outcome. **Partial reversal of D-072:** hosted CI returns for `master` only; branches stay
  local-first and `ai ci run` remains the pre-push gate. Other providers follow via
  `ai ci hosted` (D-103).
- **`ai ci hosted [<provider>] [--check] [--force]` (E-335, D-103).** Renders the hosted
  check for the provider from `src/templates/ci/` — the provider is the argument, else
  `.ai/team.json` `ci`, else the `origin` host (an unrecognised host is never guessed:
  `[CI_PROVIDER_UNKNOWN]`). In the AI-OS repository the bootstrap is `install-ai-os.sh` from
  the commit; in any other project it clones the AI-OS tag the project pins. `--check` exits
  1 when the file is not the current rendering, a differing file needs `--force`
  (`[WRAPPER_DIFFERS]`), and the planner's run records `team.json` `ci`. It prints the branch
  policy: required for merge, pushes left open for claims. `ai doctor` reports the wrapper.
  GitHub ships now; Azure DevOps (E-336), GitLab and Bitbucket (E-337) are
  `[CI_PROVIDER_PLANNED]`. `.github/workflows/ci.yml` is regenerated from the template and
  gains the contract's audit run on pushes to `master` outside `.ai/**`.
- **Azure Pipelines wrapper — UNVERIFIED (E-336, D-103).** `ai ci hosted azure` (or no
  argument on a `dev.azure.com` / `*.visualstudio.com` origin) renders `azure-pipelines.yml`:
  the same two commands, `pr:`/`trigger:` on `master` (the audit run excludes `.ai/*`),
  ubuntu + Node 22, and the run log and `.ai/ci` published with `condition: always()`. On
  Azure Repos the merge gate is a required Build Validation branch policy, which the command
  prints. It also prints `[CI_PROVIDER_UNVERIFIED]` until a documented run on a real Azure
  DevOps project is recorded (DEVOPS-011). Under Azure (`TF_BUILD=True`) `ai ci run` sets
  `AI_OS_CI_LOG_DIR` for the artefact step, since a task input cannot expand `$HOME`.
- **Per-developer account and the shared log (E-333, D-102 §8).** A gitignored
  `.ai/start.local.json` (`{"account": …}` only) overrides `start.json`'s account for this
  checkout; `ai account use <name|default>` writes it, and in a team project `ai start
  --account` and its first-run pick write it too (a single-operator project still writes
  `start.json`). `ai init` / `ai sync` add `.ai/start.local.json` to `.gitignore`. With
  `team.json` `shared_log: true`, `skill: ai-log` and `run_handover` append to the tracked
  `.ai/log/<email-localpart>.md`, and `ai-preflight` shows the newest entries across every
  developer's file (`ai log path|recent`); the default stays `LOG.md`.

## Private predecessor (AI-OS, 2025–2026)

Releases of the private repository Rein grew out of. Their numbers are the predecessor's and
are not renumbered; the public line starts at 0.4.0.

## [4.0.0] — Claude-Native — 2026-10-18

The **Claude-Native** arc (D-067 through D-101). AI-OS now targets a single vendor: the
Architect and the Engineer are both Claude Code sessions, the Tester is a headless Claude
agent, and any machinery that only existed to make up for a missing Claude Code capability is
removed. CI runs locally, an upgrade is `ai init`, and `ai clean` removes what earlier
versions left behind. Upgrading from 3.x: run `bash install-ai-os.sh`, then `ai init` in each
project, then `ai clean` (a dry run until `--apply`), and restart the MCP servers.

### Added

- **Per-project Claude accounts (E-314, E-315, D-095).** `ai account list|add|remove|sync`
  keeps a registry in `~/.ai-os/accounts.json`. `.ai/start.json` gains an `account` key,
  which `ai start --account <name>` writes. `ai pane` exports `CLAUDE_CONFIG_DIR` for a
  non-default account, and refuses to launch on an unregistered name, a missing directory,
  or an outdated classifier backstop. `ai start --status` and `ai doctor` print the account.
- **Auto-mode classifier backstop (E-293, E-306, E-318, E-324, D-086, D-097, D-101).**
  `ai install` offers (y/N) to put one `autoMode` hard-deny rule, "AI-OS Gate Tamper", in the
  operator's `~/.claude/settings.json`. Projects cannot override that file. The rule is a
  second, independently configured gate in front of safe-exec. `ai install`, `ai sync` and
  `ai account add` replace an outdated copy in place; the current rule text is v4 (D-101).
- **Operator-owned gate override (E-291, D-081, D-083).** `ai gate off [--minutes N]
  [--reason …]` (15 minutes by default, 60 at most), `ai gate on` and `ai gate status`. The
  override is a file the operator owns. While it is active, the analyzer still blocks the
  catastrophic set and any attempt to disable the gate, and every bypassed call is reported
  as a message, a `BYPASS` telemetry row and an `ai doctor` line.
- **Telemetry corrections (E-259, E-261, D-070 §5, D-077).** A tool is recorded under one
  canonical name (`mcp__<server>__<tool>`). Rows carry a `source` column (`hook` |
  `interceptor`). The `meta_analyst` 30-day windows compare ISO timestamps. The
  INSIGHTS staleness check counts tool executions only. Task velocity is measured from the
  session transcript.

- **One version, stamped twice; `ai init` is an idempotent upgrade (E-270, D-074).**
  `package.json` is now the only place the version is typed: the `VERSION=` literal in
  `src/bin/ai` and the installer's banners are gone, the installer writes
  `~/.ai-os/VERSION`, and `ai --version` reads it. `ai init` and `ai sync` stamp
  `project.aios_version` / `provisioned_at` through state-db. On an existing project
  `ai init` prints `project <old> → installed <new>`, refreshes every generated file
  (bootloaders, `.mcp.json`, `.claude/`, and git hook stubs an older version wrote),
  MERGES `.ai/roles.json` and `.ai/providers.json` with the template — missing roles such as
  `tester` are added, providers the framework retired (`provider_history` in the legacy
  registry: `agy`, `gemini`) and the roles bound to them are dropped and rebound to the
  template default, user-added providers, custom values and unknown keys are kept, and the
  originals are saved as `<name>.pre-<version>.json` — and ends with
  `N refreshed, M merged, K legacy items`. It never writes BRIEF, RULES, SEED, DIGEST, TASKS,
  LOG, architect.md or blueprints. `ai init --check` is the dry run (exit 1 when anything
  would change). `ai doctor` gains `version: clone · mirror · project` and
  `ai on PATH` (reports another `ai` shadowing `~/.ai-os/bin/ai`).
- **The install mirror and provisioning follow the same hygiene (E-273, D-074).** The
  installer now mirrors `src/mcp/` and `hooks/` with `--delete` (npm's `node_modules/` and
  `package-lock.json` are protected), removes the mirror directory of a retired MCP server,
  and cleans nested orphans in every mirrored tree on the `cp` fallback path;
  `AI_OS_INSTALL_NO_DELETE=1` restores the additive copy for one release. Its "Next steps"
  no longer name the deprecated `ai preflight` / `ai update`. `.claude/agents/` is pruned by
  the same evidence rule as skills, `settings.json` loses `mcp__<server>__*` allows for
  servers AI-OS retired (a server name it never shipped is yours and kept;
  `settings.local.json` is never edited), `ai sync` reaps dead-pid build records and
  week-old role locks into the `ai clean` trash, and `ai doctor` prints
  `mirror orphans: N — run: ai clean`.
- **Fixed: `ai sync` deleted user-authored skills on its second run (E-273).** The sync
  manifest recorded every entry present in a workspace, including skills the user had
  added, so the next sync saw them as "written by sync, unmodified, gone upstream" and
  pruned them. It now records only what sync itself provided. The trade-off: a skill an
  older version wrote before any manifest existed is now reported as `orphan (kept)`
  rather than pruned (`--prune-known` still removes byte-identical leftovers).
- **Fixed: `ai init` / `ai sync` no longer delete MCP servers you added (E-274, D-074).**
  `.mcp.json` is generated but partly user-owned: a server named in `registry.json` or in
  the legacy registry's `registry_history` is AI-OS's (regenerated, and removed once
  retired); every other entry is yours and is carried over byte-for-byte, as is an `env`
  block you set on one of ours and any other top-level key. An unparsable `.mcp.json` is
  kept as `.mcp.json.unparsable.bak` instead of being overwritten. Previously the file was
  rebuilt from the registry alone on every run, despite a comment saying otherwise.
- **Fixed: re-running `ai init` on a populated project exited 1 halfway through.** The state
  re-seed declined with `exit`, not `return`, which ended the script before anything after
  it ran.

- **`ai clean` removes what earlier versions left behind (E-272, D-074).** A new registry,
  `src/config/legacy-artefacts.json`, is the single list of artefacts AI-OS used to create
  and no longer does — the D-069 provider workspaces and shims, TestSprite's generated
  tests, mirror directories `src/` no longer ships, dead `~/.ai-os/run/` locks and build
  records, abandoned `ai ci run` work dirs, orphaned `ai-watch` processes, retired
  `mcp__<server>__*` allows — each with the evidence that makes it removable. `ai clean` is
  a DRY RUN by default, grouped `safe` / `prompt` / `not ours` with the reason and the
  action per finding. `--apply` removes the safe class; `--all` adds the prompt class after
  a confirmation (`--yes` answers it; a non-interactive stdin without `--yes` refuses).
  Nothing is deleted: removals MOVE to `~/.ai-os/trash/<date>/` beside a manifest recording
  origin, class, entry and sha256, so `ai clean --restore <date>` is a real rollback;
  `ai clean --purge [--older-than 30d]` empties old trash. Processes are signalled TERM then
  KILL and never trashed; `~/.gemini/` (Antigravity's own OAuth data) and
  `settings.local.json` are printed and never touched. `ai doctor` gains
  `legacy artefacts: N safe / M prompt` and `watchers: N live, M orphaned`. Rollback:
  `AI_OS_CLEAN_DISABLE=1` makes every form a report.
- **The test suite no longer records itself as operator behaviour (E-257, D-070 §1).**
  `telemetry.mjs` honours `AI_TELEMETRY_DB_PATH` (absolute `*.sqlite` path in an existing
  directory; anything else falls back to the live store with a warning), and every writer —
  the MCP interceptor, the post-tool-use hook, task velocity — goes through it.
  `tests/run.sh` points the whole run at a per-run temp store, and `tests/lib` does the same
  for a suite run on its own. The run also marks every process with a per-run session id
  and FAILS (`[TELEMETRY_LEAKED]`) if a marked row reaches `~/.ai-os/telemetry.sqlite`,
  printing the live row counts at start and end. It checks the marker rather than whether
  the store grew, because other sessions write to it throughout a run. New operator command:
  `node ~/.ai-os/shared/telemetry.mjs --reset --backup` moves the store to
  `telemetry.sqlite.<date>.bak` and recreates it (restart the MCP servers afterwards).
  `critic_tests` and `ai-review` gain review question #6: "does this test write under
  `~/.ai-os/` other than a per-run temp path?"

### Changed — BREAKING

- **The `agy` and `gemini` providers are removed (E-254, D-069).** AI-OS ships for Claude
  Code only. The role/provider split remains, with one entry. Removed: `src/gemini/`,
  `src/agents/` (the Antigravity plugin and skill mirror), the `GEMINI.md` and `AGENTS.md`
  rulefile shims, Gemini settings generation, the Antigravity OAuth preflight, the
  provider branches in `ai doctor`, and the `~/.ai-os/gemini` / `~/.ai-os/agents` install
  mirrors (the installer deletes a v3 copy). The Architect's agents and skills now live in
  `src/claude/`. The aligner rule `GEMINI_FILE_MODIFIED` is renamed
  `ARCHITECT_FILE_MODIFIED`.
- **`ai provider` is removed (E-254).** It exits 2. Providers are configured in
  `.ai/providers.json`. `ai init` rebinds any role bound to a retired provider to the
  template default and keeps a `.pre-<version>.json` copy (E-270).
- **`ai sync` prunes the legacy provider workspaces (E-254, E-273).** `.gemini/`,
  `.agents/`, `GEMINI.md` and `AGENTS.md` are removed only if a sync manifest proves AI-OS
  wrote them and they are unmodified. Anything else is reported as a legacy leftover and
  is `ai clean`'s to handle. A legacy `settings.json` is never deleted.
  `AI_OS_KEEP_LEGACY_WORKSPACES=1` reports without removing.
- **TestSprite is replaced by a headless Claude Tester (E-255, D-069).** TestSprite is gone
  from `registry.json`, the generated `.mcp.json`, the Quality domain and `ai doctor`, and
  its `TESTSPRITE_API_KEY` slot is gone from `.env.example`. `.ai/roles.json` gains the role
  `tester {provider: claude, model: sonnet, headless: true}`. `ai start` builds no pane for
  it, and `ai pane tester` exits 2. `skill: ai-test` runs the project's own test command;
  `--generate` dispatches the new `test_engineer` agent, and `--fast` runs it on haiku.
- **Six MCP servers and the `run_preflight` tool are retired; Claude Code does their jobs
  natively (E-276..E-279, D-075).** `context-invoker-mcp` and orchestrator `run_preflight` (skills load through the
  Skill tool, agents through the Agent tool); `mcp-router` (`list_domains`,
  `activate_domain`, `proxy_call`); `code-execution-mcp` (`execute_code`); `lsp-mcp`;
  `github-bridge-mcp` (`gh` runs under Bash, with read verbs allowed and write verbs left on
  the prompt); and `computer-use-mcp`. Their registry, `.mcp.json` and `settings.json`
  allow entries are dropped. `ai clean` finds stale mirror copies.
- **No environment variable can switch off a gate (E-291, E-294, D-083, D-087).** The
  `AI_OS_SAFE_EXEC_GATE` and `AI_OS_ROLE_TOKEN` opt-outs and `AI_OS_SOVEREIGNTY_LOCK` are
  removed, because a project's settings `env` could set them. `AI_OS_CALLER_ROLE` and
  `AI_OS_PANE_ROLE` no longer set a role on any gate path; the pre-commit hook still reads
  them, but only to make the role more restrictive. The escape is now `ai gate off`. A session's
  role comes from the most restrictive live launch record. The role token is v2: it is
  bound to the session process's pid and start time, and v1 tokens no longer verify.
  Hooks run in exec form under `/bin/bash`, using interpreters pinned at install time
  (E-286, E-290).
- **One tmux session per project (E-252, E-253, D-068).** `ai start` no longer opens one
  window per project in a shared `aios` session, where starting project B switched the
  terminal that was showing project A. Each project gets its own session, identified by
  an `AI_OS_PROJECT=<physical path>` stamp. The name is a label, and a name collision gets
  a stable hashed suffix. Panes are named `<project> · <Role>` (E-288).
- **The test suite records to its own telemetry store (E-257, D-070 §1).** The test harness
  sets `AI_TELEMETRY_DB_PATH`, and a run fails with `[TELEMETRY_LEAKED]` if any of its rows
  reach `~/.ai-os/telemetry.sqlite`. Insights computed from a 3.x store include test
  traffic. Reset the store once with
  `node ~/.ai-os/shared/telemetry.mjs --reset --backup`.
- **`SendMessage` is the only Triad wake path; the watcher is gone (E-321..E-323, D-099,
  D-100, D-101).** The skills that end a turn — `ai-handoff`, `ai-task`, `arch-task`,
  `task-planner`, `ai-triage` — write `.ai/COMM.md` and then call Claude Code's
  `SendMessage` to the other role's session (`<project> · Engineer` / `<project> · Architect`).
  A send to a pane whose `claude` has exited fails with "not reachable"; the skill prints
  one line and stops. Nothing is queued and nothing retries. Removed:
  - `ai watch` (and the `ai-watch` script). `ai start` now builds two panes, Engineer and
    Architect; `--no-watch`, the watcher lock and the E-229 restart backstop went with it.
  - `ai handoff <role> [message]`.
  - The `handoff_control` MCP tool (`task-synchronizer-mcp`).
  - `.ai/signal.json` and `.ai/.ai-watch.lock`. `ai sync` moves leftovers into the
    `ai clean` trash.
  - The auto-wake in `ai add-task` (E-204), along with `AI_OS_NO_AUTO_HANDOFF`. After
    planning, the wake comes from the skill's `SendMessage` call.

  Deprecated: the `.ai/start.json` keys `watch` and `sizes.top` are still accepted but
  ignored. They leave the schema in the next major release after 4.0.0. Accepted risk: the
  wake now depends on the model calling `SendMessage`, and cross-session messaging under a
  non-Anthropic base URL is unverified (D-099 ruling 6).
- **Seven skills retired (E-283, D-075).** `ai-compact` duplicated Claude Code's `/compact`
  and auto-compact; its SESSION.md carry-over (a ≤30-line Active Context) now happens in
  `ai-archive`. `ai-analyze`, `ai-cluster`, `ai-context-check`, `ai-dispatch`,
  `ai-sync-verify` and `ai-topic` each wrapped one MCP tool, which is directly callable,
  while every wrapper's description loaded at every session start. 43 canonical skills
  remain. The rulefiles point the Ephemeral Skill Pattern at `/compact` and the context
  check at `mcp__archive-manager-mcp__check_context_health`. Provisioned copies are removed
  by `ai sync` pruning or, for copies that no manifest proves sync wrote, by `ai clean`: the
  legacy registry lists each one, safe only while byte-identical to a shipped version.
- **GitHub Actions workflow removed; CI runs locally via `ai ci` (D-072).** `.github/workflows/test.yml`
  is deleted. `ai ci run` tests a committed sha in a detached worktree under a throwaway
  `HOME`, records the outcome in `.ai/state.sqlite` (`ci_runs`) and keeps the log under
  `~/.ai-os/ci/logs/`. "CI green" now means a non-dirty PASS row for the commit, read by
  `ai ci status`, `ai ci list`, `ai ci log [--failed]`, `get_ci_status` and `ai doctor`.
  Two gates enforce it: `update_task_status(DONE)` (`AI_OS_CI_GATE=0` disables) and a new
  `pre-push` hook (`AI_OS_CI_SKIP=1` + `AI_OS_CI_SKIP_REASON` bypasses one push and records
  a SKIPPED run). A commit that only adds `.ai/` bookkeeping above a tested commit is
  accepted without a new run. `ai uninstall` now tells you to remove `.git/hooks/pre-push`.
  Linux coverage is lost with the hosted runner: `ai ci run --linux` is deferred until
  Docker is available (E-265..E-268).

### Fixed

- **Role panes are bound by the `@ai_os_role` tmux pane option, not the pane title** (E-269,
  D-073). `ai pane <role>` targeted no pane, so the role title landed on the active pane —
  after `ai start`, the watcher's shell — and `ai-watch` held that role's handoffs
  indefinitely without output. Routing now matches the pane option on agent panes only;
  `AI_WATCH_TITLE_ROUTING=1` restores the old order for one release. (Moot since D-099
  removed `ai-watch`; `@ai_os_role` still binds each pane's role.)

---

## [3.1.0] — 2026-09-10

The **Same-Provider Triad** arc: one vendor can now hold both roles, the Architect is a
first-class runtime rather than a second CLI, and the harness stopped reporting work it had
not actually done. 38 tasks (E-208–E-245) closing D-054 through D-066.

> **Note on 3.0.0.** `package.json` has carried `3.0.0` since the v3.0 hardening sweep, but
> that version was never tagged and never changelogged. This entry covers E-208 onward only;
> the 2.0.0 → 3.0.0 range remains undocumented here, and its record is in `.ai/LOG.md`.

### Added

- **Per-pane role binding** (E-208, Tier 3) — `ai pane <role>` binds a pane to a role, the
  SessionStart hook stamps `[AI_OS_ROLE]`, and the rulefiles resolve the resulting conflict
  deterministically. Closes gap G1: a second Claude pane bound to the Architect no longer
  boots the Engineer persona out of `CLAUDE.md`.
- **`ai start`** (E-227, E-228) — creates or reuses the project's tmux session and opens the
  Triad layout, with `--status` (panes, roles, watcher state), `--kill`, `--detach` and
  `--dry-run`.
- **All-Claude Triad as the default** (E-243) — `architect = claude:1` on `fable`,
  `engineer = claude:0` on `opus`. `agy` and `gemini` remain fully selectable. Role labels
  are now **derived from `roles.json`** in the init banner, the task-owner regex and the
  review footer, all three of which previously hard-coded a vendor name.
- **Mapped-only provider workspaces** (E-244) — `ai sync` provisions `.claude/`, `.gemini/`
  and `.agents/` only for providers a role is bound to; `ai doctor` reports the others as
  stale; `ai sync --prune-providers` removes them under manifest and byte-identity evidence,
  keeping and listing anything it cannot prove disposable. `.claude/` is never pruned.
- **Continuous integration** (E-230) — the repository had none, while `DIGEST.md` claimed
  "CI pins Node 22" and the README carried a hardcoded passing badge. Adds the `test` and
  `unit` jobs, a log artifact, and a cached Playwright step.
- **Policy hot-reload** (E-237) — `loadPolicy()` re-imports a policy module when its mtime
  changes, so a long-running MCP server stops serving verdicts from the version it booted
  with. `ai sync` names servers older than the mirror.
- **Test-harness hygiene** — SKIP as a distinct outcome with its own accounting (E-236),
  host-relative performance budgets (E-239), leaked-state detection and `--sweep` (E-240),
  and EXIT-trap chaining so a suite's own `trap` no longer silently disables cleanup (E-241).
- **Archive pointer** (E-245) — rotated task history stays findable from the generated
  `TASKS.md` view.

### Changed

- **Role-aware provisioning** (E-212, E-213, E-215) — source directories are selected by the
  roles a provider serves rather than by vendor name, so a single-vendor Triad gets both
  roles' skills and agents. `ARCHITECT.md` is runtime-aware and `ai doctor` reports per-role
  provisioning.
- **Architect-scoped Git Lane** (E-214, E-218, Tier 3) — the Architect may commit its own
  `.ai/` and `plans/` work, with the stamp waiver restricted to that lane.
- **Write-gate coverage widened** (E-216, Tier 3) — the Architect gate now covers every write
  path, not only `Write` and `Edit`.
- **Server-side role derivation** (E-219, E-221, E-226, Tier 3) — `patch-mcp`,
  `propose-patch-mcp` and their callers derive the caller's role server-side and fail closed
  to `architect` instead of trusting a client-supplied value; `propose_patch` records its own
  project root.
- **Install-first helper locators** (E-223, E-225) — one shared resolver, so a helper is
  found relative to the install rather than the current working directory.
- **Executable-markdown classifier** (E-224) and the **program-position rule** (E-234) — a
  token counts as a program only in program position; data extensions never do.
- **Skill consent** (E-232) — an auto-executed line in a skill or agent file may no longer
  invoke a project program without consent.
- **Manifest-scoped pruning** (E-220) — `ai sync` removes only what it wrote and nobody has
  edited, and reports everything else as an orphan it kept.
- **Playwright out of the default install** (E-235) — opt-in via `ai mcp-setup --browsers`,
  bounded by a watchdog, with `[BROWSER_MISSING]` surfaced at first use.
- **`ai-watch` survives `ai sync`** (E-229) — a watcher no longer keeps running a script that
  has been rewritten underneath it.

### Fixed

- **`ai start` could not find an overlay that existed** (E-242) — the adapter emitted
  project-relative settings paths, which resolved only when the CLI's cwd happened to be the
  project root. Worse silently: a relative rulefile flag produced the **wrong persona**
  rather than an error. Paths are now absolute at the seam, and a missing overlay self-heals.
- **`ai init` exited 128 in a non-git directory** (E-244) — a plain assignment carried
  `git rev-parse`'s exit status under `set -e` and killed the script three lines above the
  branch written to handle exactly that case.
- **Conflict markers and unparseable `.ai/*.json` could reach a commit** (E-238) — a
  pre-commit gate now blocks both, without rejecting prose that quotes a marker or a Markdown
  setext underline.
- **Context-aware path-traversal check** (E-222) — `run_review` stopped reporting P0s for
  legitimate paths.
- **Deprecated legacy provider targets** in `ai-watch` pane resolution (E-209, E-211) and
  **provider-aware `ask_architect`** (E-210).
- **Skill-name collisions** between role variants resolved by renaming (E-217: `arch-task`,
  `arch-oracle`, `arch-review`).
- **Sync manifests gitignored** (E-233).

## [2.0.0] — 2026-06-05

First formal tagged release. Marks completion of the **Sovereignty Hardening** and
**Interactive Bridge** arcs. The major version reflects breaking, fail-closed
changes to `safe-exec` command enforcement (see **Changed → BREAKING**).

### Added
- **Interactive Bridge — smart delivery** (E-124): persistent `delivered`-flag
  consumption, startup backlog drain, per-target independent FIFOs, single-writer
  lock, and delivered-aware queue eviction so Architect⇄Engineer handoffs are
  never dropped or replayed across restarts.
- **safe-exec fail-closed pre-execution gate** (E-125, Tier 3): a `PreToolUse`
  hook routes every Bash command through `safe-exec --check` and blocks (exit 2)
  any `BLOCK` verdict — turning analysis from advisory into enforcing
  (THREAT_MODEL T-HITL-004), with a pure-bash backstop when node is unavailable.
- **Context Cache prompt-prefix injection** (E-126): a `SessionStart` hook injects
  the compiled System Context blob as session context (`caching.md` §3).
- **Bootloader `caller_role` injection** (E-127): `ai install` writes the Triad
  role into each agent's settings; `safe-exec` trusts it over the agent-supplied
  argument (anti-impersonation).
- **Tamper-resistant role token** (E-129, Tier 3): the gate resolves the role from
  an HMAC-signed per-session token, so an in-session `unset/export
  AI_OS_CALLER_ROLE` can no longer self-downgrade.
- New CLIs/flags: `safe-exec --check` / `--mint-token`, `ai watch --clear`,
  `cache-manager --emit-context`, `AI_WATCH_SUBMIT_DELAY`.

### Changed
- **BREAKING (E-123):** for the Architect role, `safe-exec` now blocks
  branch/remote git ops (`merge`, `rebase`, `push`, `pull`, `branch`) and
  deployment commands (`ssh`, `rsync`, `scp`, `npm publish`, `docker push`) —
  merge and deployment are strictly Engineer tasks.
- **BREAKING (E-125):** catastrophic commands (`rm -rf /`, `curl … | bash`,
  fork bombs, `mkfs`, `dd … of=/dev/*`) are now prevented at the gate, not merely
  flagged.
- **BREAKING (E-128):** the `--check` analyzer-error path is fail-closed — an
  internal analyzer crash blocks execution (exit 2) instead of allowing it.
- Hardened `rm -rf` detection: split `rm -r -f`, and `$HOME`/`${HOME}`/`~`/`/*`
  targets (E-125).
- Formalized the ai-watch busy-gate version-string heuristic and made the
  pre-Enter submit delay configurable (E-122).

### Fixed
- ai-watch `Ctrl-C` now reliably terminates the watcher (trap regression) (E-124).
- Dropped / stale Interactive Bridge handoffs resolved by the smart delivery model
  (E-122, E-124).
- Workflow task lifecycle and ai-watch pane routing verified end-to-end
  (E-120, E-121).

### Rollbacks
Every new enforcement layer is reversible via environment flags:
`AI_OS_SAFE_EXEC_GATE=0`, `AI_OS_ROLE_TOKEN=0`, `AI_OS_SOVEREIGNTY_LOCK=0`,
`AI_WATCH_CURSOR_MODE=legacy`, `AI_OS_DISABLE_CACHE=1`.

### Activation
The gate, role injection, and session hooks activate on `ai install`
(idempotent registration into the agent settings).

---

### Foundation (pre-2.0.0, untagged)
The 2.0.0 baseline already includes the framework built across E-1…E-119: the
Triad architecture (Architect / Engineer / Tester) over ACID SQLite state, 25 MCP
servers, RBAC-gated skills, a JIT context cache, NDJSON observability with a
cross-project meta-cognition telemetry loop, the drop-in installer, Managed Agents
cloud reconciliation, a Multimodal RAG batch pipeline, the SEO Topic Cluster
Engine, the AST Repository Map, and the earlier Sovereignty Hardening primitives
(DONE-task lock, Architect git/file blocks).
