# Lean Core — enforcement by the platform, bookkeeping by commands, review by tier

> Blueprint for D-169 (2026-11-23). Operator's request: fix the four weaknesses in the core,
> with no overhead, and bring every axis to 8/10 or better.

## Goal & Architecture
Rein's strengths are enforcement that does not depend on the model, a durable record, and two
roles that hold. Four things cost more than they return. The numbers are from the inventory of
2026-11-23.

1. **The harness polices itself.** 16 of 61 open tasks are about the command gate and 6 more
   about its test budget. The gate is 3,497 lines in 18 files, with about 1,240 table rows and
   about 5,500 test lines (12% of `tests/`).
2. **The command gate reads shell text.** It decides what a command will do from how it is
   spelled. D-167 and D-168 both say the list cannot be finished. Claude Code's own
   documentation says the same of its Bash deny rules and points to the sandbox.
3. **Ceremony.** A session starts with a rulefile (about 6.5 KB), up to 20,000 characters of
   blueprint text from `cache-manager-mcp --emit-context`, 42 skill descriptions and 18 MCP
   servers. A review-and-rule turn loads a preflight skill and three more skills. Six finished
   branches wait for the operator to push, merge and install.
4. **Platform drift.** Claude Code now has a Bash sandbox, path rules for the file tools,
   settings per session, cross-session messages and a review command. Rein keeps its own
   version of several.

Users: the operator (less waiting, fewer rulings), both roles (less to load, fewer steps), a
new user (install, start, first task). In one sentence: the platform enforces, commands keep
the books, and review is as heavy as the task's tier.

## Core Concept
**Rein keeps only what the platform does not do.** Three tests decide every part:

- A boundary is enforced by the operating system or by the harness, never by reading a
  command's text.
- A step whose result can be computed is one command. A skill is kept only where a model must
  judge.
- A control that costs time on every task must show what it caught, or it goes.

What stays Rein's own: the `.ai/` record (tasks, decisions, handoffs, stamps), the two roles
and their wake loop, the acceptance evaluator, `rein ci run`, and the install.

## Components

### Component 1 — Enforcement by sandbox and path rules
`rein pane <role>` already starts each session with `claude --settings <role file>`. The role
file becomes the boundary.

- **Architect.** Bash runs in the sandbox with `failIfUnavailable: true` and
  `allowUnsandboxedCommands: false`. The project is read-only for Bash except `.ai/`, `plans/`
  and what a commit writes under `.git/`. The file tools are denied outside `.ai/` and
  `plans/` by `Edit(...)` rules. No network domain is allowed, so a push fails. The Architect's
  MCP list holds only the state server.
- **Engineer.** Bash runs in the sandbox with the project and the temp directory writable. The
  install tree (`~/.rein`) is write-denied. The sandbox already write-protects `.git/hooks`,
  `.git/config`, the `.claude` settings files and `.mcp.json`. Network: the domains CI and the
  package registry need.
- **Both.** `disableBypassPermissionsMode` is set. The role is the settings file the session
  was started with; the role token (`role-token.mjs`) is retired with the gate.
- **What this does to the git rules.** A program git is made to run (`-c`, a pager, a hook) runs
  inside the same sandbox. It cannot write source for the Architect, whatever the spelling.
- **Not known yet, measured first (E-458).** The documentation does not say whether a narrower
  `allowWrite` wins over a broader `denyWrite`, nor shows the `Edit(!…)` carve-out for this
  shape. If the narrow rule does not win, the deny list is generated at launch from the
  project's top-level entries other than `.ai`, `plans` and `.git`.
- **Native Windows** has no sandbox. Rein supports Linux and WSL2 (operator's ruling,
  2026-11-23).

### Component 2 — The seatbelt (what is left of the text gate)
After Component 1 is live and its escape tests pass, the text gate is deleted (operator's
ruling). What remains is advice, and it is labelled so:

- one file, at most 300 lines, one table of at most 40 rows;
- three classes only: `rm -rf` of home, root or the project root; a download piped into a
  shell; a secret pattern in a command;
- it is not a security boundary. It gets no pen-test round and no new spellings. A miss is
  recorded as a miss, not as a finding.

`hooks/pre-tool-use.sh` shrinks to the seatbelt call and the waiting signal.

### Component 3 — A lean session
- **Session start** injects one brief of at most 2 KB, computed by the hook: role, branch, the
  five next open tasks for that role, the heading of the last handoff, and any anomaly (state
  behind HEAD, stale build, uncommitted COMM). No blueprint text is injected. A blueprint is
  read when a task names it.
- **Rulefiles.** `ARCHITECT.md` and `ENGINEER.md` are at most 2 KB each: the role, where its
  orders are, the three commands of Component 4, the tier rule of Component 5. The write scope
  is one line, because Component 1 enforces it.
- **The preflight skill is removed.** Its checks are deterministic and run in the hook. They
  print only when something is wrong.
- **Skills**: at most 12 are provisioned in a project by default. The rest are installed on
  request (`rein skill add <name>`).

### Component 4 — Bookkeeping by command
Three commands replace seven skills (`rein-task`, `arch-task`, `rein-handoff`, `task-planner`,
`decision-recorder`, `blueprint-writer`, `rein-log`):

- `rein done <id> --summary <text>` marks the task, records the log line, rebuilds the digest.
- `rein handoff --to <role> --file <entry>` appends the entry to `COMM.md`, commits the dirty
  tracked `.ai/` paths (D-104, D-147), and prints the commit and the wake line. The model then
  sends that line with `SendMessage`.
- `rein decide --file <entry>` assigns the next D-number, checks the entry has a decision, a
  reason and a rollback, and appends it.
- `add_task` itself refuses a task with no tier, no verb, or an acceptance clause that names
  nothing to run or look at. These are the task-planner checks, moved into the tool.
- **Merges are delegated** (operator's ruling). The Engineer pushes, opens the pull request,
  merges on green CI with `[ACCEPT_PASS]` recorded, and runs the install. Release tags and
  anything that publishes a version stay with the operator.
- A task closes on its acceptance. `[BUILD_STALE]` no longer refuses DONE; it prints a line and
  the Engineer installs.

### Component 5 — Review by tier
| Tier | What it is | Review |
|---|---|---|
| 1 | no behaviour change (docs, text, renames) | none |
| 2 | everything else | one `reviewer` agent, then `critic_acceptance` |
| 3 | the boundary of Component 1, the install, hooks, secrets, release signing | Tier 2 plus one `security_engineer` round |

- `reviewer` replaces `critic_arch`, `critic_tests`, `critic_clean_code`, `critic_security`,
  the aligner and the synthesizer. It reads the diff against the task and the blueprint and
  records one stamp, `[REVIEW_PASS]` or `[REVIEW_FAIL]`. The deterministic checks (standards,
  secrets, markers) stay in `pre-commit.sh`, where they cost nothing.
- Tier 3 gets one security round. A second needs the Architect (D-164 r6, unchanged).
- **The `test_lines` ratchet is retired.** It asked for five rulings in seven weeks. The time
  budgets (`fast_tier_seconds`, `full_seconds`) stay: time is the cost. "One test per
  behaviour at the cheapest layer" (D-088) stays as a rule the reviewer applies.

### Component 6 — Native first, measured
- **MCP servers.** Target: at most 2 (the state server; the orchestrator only if the census
  shows a tool no command replaces). E-465 counts calls per server over 30 days from
  `~/.rein/telemetry.sqlite`. The default verdict is retire. The Architect rules on the table.
  The two third-party servers (`filesystem`, `memory`) are removed without a census: the file
  tools and auto-memory are native.
- **Deprecated CLI stubs** (`provider`, `update`, `onboard`, `preflight`, `archive`, `review`,
  `test`, `where`) are removed. One operator runs Rein; no shim is needed.
- **The scorecard** (`rein doctor --fitness`) prints the numbers of the table below, so the
  bar is checked by a command.

### Component 7 — Record hygiene
`TASKS.md` shows open tasks only. `COMM.md` keeps the last ten handoffs. `SECURITY.md` and
`REVIEWS.md` keep 90 days. Older text moves to `.ai/archive/` by `rein archive`, run by
`rein handoff`. A decision entry needs three parts: the decision, why, the rollback.
Alternatives are written when one was seriously weighed.

## Data Model
**The scorecard** — the bar for 8/10 on every axis. "Today" is measured where a number exists.

| Axis | Measure | Today | Target |
|---|---|---|---|
| Overhead | bytes Rein adds to a session at start | rulefile 6.5 KB + up to 20 KB | ≤ 4 KB |
| Overhead | skills provisioned by default | 42 | ≤ 12 |
| Overhead | MCP servers per session | 18 | ≤ 2 |
| Overhead | bookkeeping tool calls to close and hand off a Tier 1–2 task | not measured | ≤ 3 |
| Overhead | agent runs to review a Tier 2 task | 2 to 3 | 2 |
| Enforcement | role guarantees held by sandbox or path rule | 0 of 5 | 5 of 5 |
| Enforcement | lines of command-text rules | 3,497 | ≤ 300 |
| Self-policing | open tasks about Rein's own controls | 22 of 61 | ≤ 10% |
| Self-policing | share of `tests/` that tests the gate | 12% | ≤ 3% |
| Waiting | finished branches waiting for the operator | 6 | 0 |
| Adoptability | steps from install to a first closed task | not measured | ≤ 4, nothing to read first |

**Role settings** (generated; sketch, key names from the Claude Code settings reference):

```
architect: sandbox { enabled, failIfUnavailable, allowUnsandboxedCommands: false,
                     filesystem { denyWrite: [project…], allowWrite: [.ai, plans, .git] },
                     network { allowedDomains: [] } }
           permissions.deny: Edit outside .ai/ and plans/ ; role settings files
engineer:  sandbox { enabled, failIfUnavailable, allowUnsandboxedCommands: false,
                     filesystem { denyWrite: [~/.rein] }, network { allowedDomains: [ci, registry] } }
```

The exact shape is what E-458 measures.

## API / Interface Contracts
- `rein done <id> --summary <text>` → exit 0 and one line; exit 1 with the missing stamp named.
- `rein handoff --to architect|engineer --file <path>` → exit 0, prints `<sha>` and the wake
  line; exit 1 if the entry lacks "Next action needed".
- `rein decide --file <path>` → prints `D-###`; exit 1 naming the missing part.
- `rein doctor --fitness [--json]` → the scorecard rows with measure, value, target, PASS/FAIL.
- `rein doctor` → `[SANDBOX_MISSING]` when `bubblewrap` or `socat` is absent, with the install
  line for the distribution.
- `rein pane <role>` refuses to start a role session when the sandbox is unavailable.

## Security
The five guarantees, and what holds each after this change:

| Guarantee | Today | After |
|---|---|---|
| The Architect writes only `.ai/` and `plans/` (file tools) | hook on Write/Edit | `Edit(...)` deny rules in the role settings |
| The Architect writes only `.ai/` and `plans/` (Bash, any child process) | text rules | sandbox write list |
| The Architect does not push or merge | text rules on git verbs | no network domain; source tree read-only |
| Neither role changes the controls (hooks, settings, install tree) | gate-self-disable table | sandbox protected paths; `~/.rein` write-denied |
| Neither role leaves the sandbox | — | `allowUnsandboxedCommands: false`, bypass mode disabled |

- **The escape suite** proves these by running commands in the real sandbox and observing the
  file system: at most 30 cases, one per guarantee and route (file tool, Bash, child of git,
  MCP tool). It replaces the tables that assert how a command is spelled.
- **MCP servers are not sandboxed.** That is why the Architect's MCP list is cut to the state
  server, and why the third-party `filesystem` server goes.
- **Trust boundary**: the role settings are generated from the install tree at launch. A
  session cannot edit them (protected path, plus an `Edit` deny).
- **Accepted**: the Engineer can delete the project directory. Git and the remote recover
  committed work; the seatbelt warns. The Architect can create a branch that changes only
  `.ai/` unless E-458 shows `.git/HEAD` can be write-denied without breaking a commit.
- **The order protects the change**: the text gate is deleted only after the escape suite passes
  on this machine, in a separate task.

## Execution Constraints
- The sandbox must not slow a Bash call by more than 100 ms (E-458 measures it). `rein ci run`
  must pass inside the Engineer's sandbox within the recorded `full_seconds`.
- The session-start hook stays under 500 ms.
- Hosted CI may lack user namespaces for `bubblewrap`. The escape suite then reports SKIP with
  that reason, and it must run on the operator's machine before a release.
- One Engineer pane: the tasks run in the order of the breakdown.

## Rollback Plan
- Components 3 to 7 are each one commit and revert alone.
- Component 1: remove the `sandbox` block from the generated role settings; the text gate is
  still in place until E-463.
- Component 2 (the deletion, E-463) is one commit. Reverting it restores the gate, its tables
  and the role token. v0.5.0 is the last tag that carries them.

## E-## Task Breakdown
In order. Tiers follow Component 5.

| Task | What | Tier |
|---|---|---|
| E-457 | Land the built stack under the delegation; close what is accepted | 2 |
| E-458 | Measure the sandbox and the path rules (ten questions) | 2 |
| E-459 | The scorecard, `rein doctor --fitness`, with today's values | 2 |
| E-460 | Lean session: the brief, the rulefiles, preflight removed | 2 |
| E-461 | Bookkeeping commands; the checks move into `add_task` | 2 |
| E-462 | Role settings with the sandbox; the escape suite | 3 |
| E-463 | Delete the text gate; the seatbelt | 3 |
| E-464 | Review by tier; `reviewer`; retire the `test_lines` ratchet | 2 |
| E-465 | MCP census; remove the third-party servers and the CLI stubs | 2 |
| E-466 | Record hygiene and `rein archive` | 2 |

Not executed, and closed as superseded when E-463 lands: E-455, E-456. Held until then and
ruled again: E-394, E-395, E-410, P-52. After E-463: E-450, E-451, E-452.

## Revision 2 — Bones (D-170, 2026-11-23)

D-170 amends this blueprint. Where it differs from the text above, D-170 wins.

**Keep list** (D-170 r4). Ledger: `state.sqlite`, `task-synchronizer-mcp` (the only MCP server),
generated views, tiers, acceptance text. Acceptance: `critic_acceptance` and the DONE refusal.
Record: DECISIONS.md, COMM.md, blueprints, `rein decide`. Roles: role settings with the sandbox,
`rein start`, `rein pane`, rulefiles, `rein handoff`, the waiting signal, `docs/app-contract.md`.
CLI: `init`, `start`, `pane`, `sync`, `doctor`, `done`, `handoff`, `decide`, `review`, `ci run`,
`state import`, `digest build`, `archive`. Agents: `reviewer`, `critic_acceptance`,
`security_engineer`, `test_engineer`. Skills: `blueprint-writer`, `rein-test`, `rein-debug`,
`release-manager`. Hooks: session start, waiting signal, state import, pre-commit, pre-push, seatbelt.

**Everything else goes** (D-170 r5). Not in scope: team mode, `rein ci run`, release and signing.

**Scorecard changes**: MCP servers ≤ 1 · default skills ≤ 6 · agents ≤ 4 · hook lines ≤ 900.
`rein skill add` is not built; removed units belong to the plugin marketplace
(`plans/rein-plugins-plan.md`).

**Batch rules** (D-170 r9): one branch `lean-core`, one commit per task, no push, no CI, no
critics and no handoff between tasks; tasks close in E-470. Kept: the probe of E-458 and the
escape suite of E-462 before E-463.

**Packaging** (E-469). The kept agents, skills and hooks ship as one Claude Code plugin; `rein`
stays as the CLI for the ledger and the commands, and `rein init` writes the role settings files,
which a plugin cannot carry. The Engineer reads the current plugin documentation before building;
if a kept hook cannot be declared by a plugin, it stays with the installer and the handoff says so.

| Order | Task | What | Tier |
|---|---|---|---|
| parallel | E-457 | One pull request from the top of the stack; one hosted CI run | 2 |
| 1 | E-464 | Review by tier; the stamp check moves from commit to task close | 2 |
| 2 | E-458 | Measure the sandbox | 2 |
| 3 | E-460 | Lean session | 2 |
| 4 | E-461 | Bookkeeping commands | 2 |
| 5 | E-462 | Role sandbox and the escape suite | 3 |
| 6 | E-463 | Delete the text gate | 3 |
| 7 | E-467 | Strip to the keep list | 3 |
| 8 | E-466 | Record hygiene | 2 |
| 9 | E-459 | The scorecard, measuring the stripped tree | 2 |
| 10 | E-469 | Package as a Claude Code plugin | 2 |
| 11 | E-468 | Rewrite the documentation | 2 |
| 12 | E-470 | Close the batch: one CI run, one review, acceptance, merge | 3 |

E-465 is superseded by D-170. P-53: the Architect rewrites `.ai/architect.md` after E-470.
