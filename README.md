<div align="center">
  <h1>Rein</h1>
  <p><b>Rein in your agents.</b></p>
  <p>Claude Code as a small engineering team that plans, builds, reviews and remembers.</p>

  [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
  [![CI][ci-badge]][ci]
  [![Sponsor][sponsor-badge]][sponsor]
  [![Version](https://img.shields.io/badge/version-v4.0.0-blue.svg)](CHANGELOG.md)
</div>

Rein runs two Claude Code sessions side by side — an **Architect** that plans and an
**Engineer** that builds — and gives them what a single chat lacks: a shared, crash-safe project
memory in `.ai/`, hard role boundaries, and quality gates that a commit has to pass. The Architect
writes a blueprint and a task list; the Engineer implements it, has independent critics review the
diff, runs your tests in a clean worktree, and only then commits; each wakes the other when its turn
is done. It is a thin layer on your machine — no proxy, no cloud service, no account beyond Claude
Code itself.

> **Licence.** Rein is open source under the [Apache License 2.0](LICENSE). Use it, change it and
> ship it, personally or commercially; keep the [NOTICE](NOTICE). It is funded by donations and
> sponsorships.

---

## Contents

- [Quickstart (60 seconds)](#quickstart-60-seconds)
- [How it works](#how-it-works)
- [Feature tour](#feature-tour)
- [Install and uninstall](#install-and-uninstall)
- [Command reference](#command-reference)
- [Gates, critics and budgets](#gates-critics-and-budgets)
- [Local CI — `ai ci`](#local-ci--ai-ci)
- [Configuration](#configuration)
- [FAQ](#faq)
- [Troubleshooting](#troubleshooting)
- [Where this comes from](#where-this-comes-from)
- [Contributing](#contributing) · [Security](#security) · [Sponsoring](#sponsoring) · [Licence](#licence)

Deeper guides live in [`docs/`](docs/README.md).

---

## Quickstart (60 seconds)

You need macOS or Linux, **Node.js 22.5+**, Python 3.10+, `sqlite3`, `git`, `tmux` and
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) logged in.

```bash
# 1. Install once per machine
git clone https://github.com/Vimurai/rein.git && cd rein
bash install-ai-os.sh          # copies the framework to ~/.ai-os and adds it to PATH
exec "$SHELL"                  # reload the shell so `ai` is found
ai install                     # Claude Code settings + hooks
ai doctor                      # each ✗ names its fix; Copilot and Chromium are optional

# 2. Enable it in a project (new or existing)
cd ~/code/my-project
ai init                        # creates .ai/, .claude/, .mcp.json; never overwrites your files

# 3. Launch the team
ai start                       # tmux: Engineer pane (left) + Architect pane (right)
```

Then type your first request into the **Architect** pane:

> *Plan a `/health` endpoint that reports the app version and database status.*

The Architect writes `.ai/blueprints/health.md` and adds `E-##` tasks to `.ai/TASKS.md`, then
wakes the Engineer. The Engineer implements them, runs the tests and the critics, commits, and hands
back. You watch, answer questions, and approve. For an existing codebase, start with
*"Reverse-engineer this repository into `.ai/DIGEST.md`, `.ai/BRIEF.md` and `.ai/architect.md`."*

No tmux? Open two terminals and run `ai pane engineer` in one and `ai pane architect` in the other
(see the manual fallback under [Starting a session](#starting-a-session)).

---

## How it works

```
        you
         │  "plan X"                               "looks good" / answers
         ▼                                                  ▲
┌────────────────────────┐   SendMessage (wake)   ┌────────────────────────┐
│  ARCHITECT  (pane 1)   │ ─────────────────────▶ │  ENGINEER  (pane 0)    │
│  claude · fable        │ ◀───────────────────── │  claude · opus         │
│                        │                        │                        │
│  blueprints, tasks,    │                        │  code, tests, review,  │
│  decisions, rulings    │                        │  commits               │
│  ✗ cannot edit source  │                        │  ✗ cannot edit plans   │
└───────────┬────────────┘                        └───────────┬────────────┘
            │            ┌─────────────────────────────┐      │  dispatches
            └──────────▶ │  .ai/  — shared memory      │ ◀────┤
                         │  state.sqlite  (ACID, WAL)  │      ▼
                         │  TASKS · DIGEST · COMM      │  ┌────────────────────────┐
                         │  architect.md · blueprints/ │  │  critics + tester      │
                         │  DECISIONS · LOG · REVIEWS  │  │  arch · security ·     │
                         └─────────────────────────────┘  │  tests · test_engineer │
                                                          └────────────────────────┘
                 git commit ──▶ pre-commit gate ──▶ ai ci run ──▶ pre-push gate
```

A picture version is in [docs/assets/triad.svg](docs/assets/triad.svg).

**Two roles, one memory.** Each pane is Claude Code bound to a role by `ai pane <role>`: the
Architect (model `fable`) owns `.ai/architect.md`, `.ai/blueprints/` and the task list; the
Engineer (model `opus`) owns the source and the tests. A third role, the **Tester**
(`test_engineer`, model `sonnet`), has no pane — the Engineer dispatches it to write tests.
Bindings live in `.ai/roles.json`.

**Memory that survives the chat.** Tasks, review stamps and handoff notes live in
`.ai/state.sqlite` (WAL mode, so two sessions never corrupt it) and are mirrored to readable
Markdown. Every session starts by reading the project snapshot (`DIGEST.md`) and its open
tasks — not by re-reading your whole repository.

**Ping-pong, not copy-paste.** When a role finishes, its skill writes a short handoff to
`.ai/COMM.md` and wakes the other pane with Claude Code's `SendMessage`. A pane that is closed gets
one "not reachable" line; nothing is queued behind your back.

**Boundaries are enforced, not requested.** Hooks check every tool call: the Architect cannot
write source, a destructive or secret-bearing shell command is refused, and a commit without a
fresh review stamp is rejected. See [docs/how-it-works.md](docs/how-it-works.md).

---

## Feature tour

| Feature | What you get | Read more |
| :--- | :--- | :--- |
| **Roles** | Architect and Engineer panes with their own model, rulefile (`ARCHITECT.md`, `ENGINEER.md`) and permissions; a headless Tester. | [How it works](docs/how-it-works.md) |
| **Project memory** | `.ai/` holds the blueprint, tasks, decisions, digest, log and review stamps; ACID SQLite underneath. | [The `.ai/` directory](docs/how-it-works.md#the-ai-directory) |
| **Gates** | Tool-call gate (role boundaries, destructive commands, secrets), pre-commit review gate, pre-push CI gate. | [Gates and review](docs/gates-and-review.md) |
| **Critics** | Independent reviewers for architecture, security, tests and clean code, each in its own context, stamping `PASS`/`FAIL`. | [Gates and review](docs/gates-and-review.md#critics) |
| **Skills** | 40+ procedures the agents run on cue — preflight, task close-out, handoff, debugging, release, dependency and CI gates. | [Agents and skills](docs/agents-and-skills.md) |
| **Subagents** | 21 specialists — critics, Tester, security, database, DevOps, performance, chaos, UX, SEO, docs. | [Agents and skills](docs/agents-and-skills.md#subagents) |
| **MCP servers** | 16 local MCP servers (task store, orchestration, safe exec, patching, risk tiers, blueprint alignment, approval, memory…) wired by `ai sync`. | [MCP servers](docs/mcp-servers.md) |
| **Local CI + ratchet** | `ai ci run` tests a commit in a clean worktree; a test budget that only moves down. | [Local CI](docs/local-ci.md) |
| **Team mode** | Several developers on one repo: task claims on the trunk, per-developer id ranges, shared logs. | [Team mode](docs/team-mode.md) |
| **Accounts** | Run one project on a second Claude subscription with `ai account` and `ai start --account`. | [Getting started](docs/getting-started.md#a-second-claude-account) |

---

## Install and uninstall

| Requirement | Why |
| :--- | :--- |
| macOS or Linux (bash/zsh) | The installer and hooks are bash. On Windows, use WSL2. |
| **Node.js 22.5+** | The MCP servers use the built-in `node:sqlite`. |
| Python 3.10+ | Generates `.mcp.json` and runs state fallbacks. |
| `sqlite3`, `git` | Hooks read `.ai/state.sqlite`; everything is git-aware. |
| **Claude Code** (`claude`) | Runs every role. |
| `tmux` (recommended) | `ai start` builds the two-pane layout in tmux. |
| `gh` (optional) | GitHub issue ingestion (`ai sync --github`). |

**Install** — once per machine:

```bash
git clone https://github.com/Vimurai/rein.git && cd rein
bash install-ai-os.sh     # copies src/ → ~/.ai-os, installs MCP dependencies, adds ~/.ai-os/bin to PATH
exec "$SHELL"             # reload the shell so `ai` is found
ai install                # ~/.claude settings and hooks
ai doctor
```

**Upgrade** — pull, reinstall, then sync each project:

```bash
cd rein && git pull && bash install-ai-os.sh
cd ~/code/my-project && ai init && ai sync && ai doctor
```

`ai sync` refreshes the rulefiles, `.mcp.json`, `.claude/agents/`, `.claude/skills/` and the git
hooks. It never touches what you wrote: `BRIEF.md`, `TASKS.md`, `DIGEST.md`, `architect.md` and
your blueprints stay yours. `ai clean` lists what older versions left behind (dry run by default).

**Uninstall** — `ai uninstall` removes `~/.ai-os` after you type `uninstall`. Your projects'
`.ai/` directories, `~/.claude/` and the PATH line in your shell rc are left for you to remove.

### Starting a session

```bash
cd /path/to/your-project
ai start
```

`ai start` creates or reuses the project's tmux session, binds each pane to its role and launches
Claude Code in both. It is idempotent — run it whenever you come back to a project.

```bash
ai start --status        # which panes exist and what each is running
ai start --kill          # tear the project window down (asks first; --yes skips the prompt)
ai start --detach        # build the layout without attaching
ai start --dry-run       # print the tmux commands instead of running them
```

<details>
<summary>Manual fallback — the layout by hand</summary>

Without `ai start` (or without tmux), the layout is two panes and two commands. Use one tmux
session **per project**, named after it — one session has one current window shared by every
attached client, so two projects in one session flip each other's terminal:

```bash
tmux new-session -s "$(basename "$PWD")"
# Then, in two panes (split with prefix + %):
ai pane engineer      # pane 0 — Claude Code bound to the Engineer (opus)
ai pane architect     # pane 1 — Claude Code bound to the Architect (fable)
```

Each pane keeps its shell when Claude Code exits, so you can rerun the command. Use another
terminal for `ai sync`, `ai doctor` and git.

</details>

More: [docs/getting-started.md](docs/getting-started.md) (tmux layout, accounts, upgrading from v3).

---

## Command reference

The `ai` CLI sets things up and keeps them healthy; the day-to-day work happens as prompts and
skills inside the two Claude Code panes.

| Command | What it does |
| :--- | :--- |
| `ai install` | Write Claude Code settings and hooks under `~/.claude`; run once after `install-ai-os.sh`. |
| `ai init [--check]` | Create `.ai/` in a project, or upgrade an existing one; `--check` is a dry run. |
| `ai sync [--github] [--prune-providers]` | Refresh rulefiles, agents, skills, `.mcp.json` and hooks in the project. |
| `ai start [--status\|--kill\|--detach\|--dry-run\|--account <name>]` | Build or reattach the project's two-pane tmux layout. |
| `ai pane <architect\|engineer>` | Launch Claude Code in this pane, bound to a role. |
| `ai doctor [--repair] [--compliance] [--env]` | Diagnose PATH, hooks, MCP servers, roles, state, CI; `--repair` fixes what it can. |
| `ai add-task <description>` | Add a task from the shell. |
| `ai task done <id>` | Close a task through the same gates the agents use. |
| `ai task claim\|release\|claims` | Team mode: claim a task on the trunk before working on it. |
| `ai team add\|show`, `ai trunk` | Team mode: per-developer id ranges; which branch is the trunk. |
| `ai state import\|migrate` | Bring this machine's task index up to what git tracks. |
| `ai ci run\|status\|list\|log\|budget` | Local CI — see [below](#local-ci--ai-ci). |
| `ai account list\|add\|remove\|sync` | Extra Claude Code accounts (one config directory per login). |
| `ai clean [--apply] [--restore <date>]` | List, then move to a dated trash, what older versions left behind. |
| `ai gate off [--minutes N]\|on\|status` | Operator-only, time-boxed escape from the tool-call gate (run it in your own terminal). |
| `ai uninstall` | Remove `~/.ai-os`. |
| `ai version`, `ai --help` | Version; full help. |

Inside Claude Code, the commonly used skills are:

| Skill | When |
| :--- | :--- |
| `ai-preflight` | Runs at every session start: snapshot, open tasks, state checks. |
| `ai-task` | After a task: mark it done (CI must be green), hand over, show the next one. |
| `ai-handoff` | Write the COMM.md note and wake the other pane. |
| `ai-test` | Run your tests; `--generate` dispatches the Tester to write new ones. |
| `ai-review` | Tier-aware review: critics in parallel for risky changes. |
| `ai-debug` | Hypothesis → test → observe loop; commits stay locked until green. |
| `ai-digest`, `ai-archive` | Refresh the project snapshot; rotate long logs. |

The full list is in [docs/agents-and-skills.md](docs/agents-and-skills.md).

---

## Gates, critics and budgets

Every change is classified into a **risk tier**, and the tier decides how much review it needs:

| Tier | Typical change | Review before commit |
| :--- | :--- | :--- |
| 1 | Docs, config, comments | None |
| 2 | Ordinary code | Blueprint alignment check |
| 3 | Security, state, hooks, removals | Critics in parallel — architecture, security, tests — plus a security engineer for auth or secrets |

Three gates enforce it, all as git or Claude Code hooks — not as instructions the model may forget:

1. **Tool-call gate** (every tool call): role boundaries (the Architect cannot write source),
   destructive shell commands, secrets and private keys in commands, writes outside the project.
2. **Pre-commit gate**: the commit needs a review stamp bound to its parent; bookkeeping-only commits
   are exempt. Conflict markers and broken `.ai/*.json` are refused.
3. **Pre-push gate**: the tip must have a green `ai ci run`.

**Critics** are subagents with a fixed brief and their own context: `critic_arch` compares the
diff with the blueprint, `critic_security` audits it for OWASP-class issues and leaked secrets,
`critic_tests` checks that each changed behaviour has one test at the cheapest layer, and
`critic_clean_code` applies the engineering standards. They record `[ARCH_PASS]`, `[SEC_FAIL]`
and so on as stamps; nobody edits `REVIEWS.md` by hand.

**Budgets** keep the test suite honest: every green CI run records the number of suites, test
lines and fast-tier seconds, and the next run fails if any of them grows past a small slack. The
budget only moves down; raising it is a recorded decision. Details:
[docs/gates-and-review.md](docs/gates-and-review.md) and [docs/local-ci.md](docs/local-ci.md).

---

## Local CI — `ai ci`

CI runs on your machine; no hosted pipeline is needed. `ai ci run` checks out a **committed** sha
in a detached `git worktree` under a throwaway `HOME`, installs the framework from that commit,
and runs the test suites, the unit tests and a secrets check. The verdict is stored in
`.ai/state.sqlite`; logs go to `~/.ai-os/ci/logs/`.

```bash
ai ci run                 # test HEAD; exit 0 PASS / 1 FAIL / 2 ERROR
ai ci run --dirty         # include uncommitted changes (never certifies a commit)
ai ci status --short      # the recorded verdict for HEAD
ai ci list -n 10          # recent runs
ai ci log --failed        # only the failing suites of the last run
ai ci budget              # the test budget the next run is held to
```

"CI green" means a non-dirty PASS for that exact commit. Two things read it: closing a task
(`ai-task` refuses until HEAD is green) and the `pre-push` hook, which refuses to push an untested
tip. A commit that only adds `.ai/` bookkeeping on top of a tested one needs no new run. To push in
an emergency, skip once — it is recorded, and a reason is mandatory:

```bash
AI_OS_CI_SKIP=1 AI_OS_CI_SKIP_REASON="prod outage hotfix" git push
```

Machine-specific environment (a local port, a URL only your laptop has) goes in the gitignored
`.ai/ci.local.json`. More: [docs/local-ci.md](docs/local-ci.md).

---

## Configuration

| File | Tracked | Purpose |
| :--- | :--- | :--- |
| `.ai/roles.json` | yes | Role → provider, model and pane (`engineer` 0 · `opus`, `architect` 1 · `fable`). |
| `.ai/providers.json` | yes | Provider definitions (Claude Code). |
| `.ai/start.json` | yes | `ai start` options, including the bound Claude account. |
| `.ai/team.json` | yes | Team mode: trunk, developer id ranges, claim expiry, shared log. |
| `.ai/CAPABILITIES.md` | yes | Paths and commands the agents may read, write and run. |
| `.ai/ci.local.json` | no | This machine's extra CI environment. |
| `.mcp.json`, `.claude/` | generated | Regenerated by `ai sync`; edit the sources, not these. |

Useful environment variables: `AI_OS_CI_GATE=0` (close tasks without green CI — say so when you
do), `AI_OS_KEEP_LEGACY_WORKSPACES=1` (sync lists old files but deletes nothing),
`AI_OS_DISABLE_REPO_MAP=1` (skip the code map), `AI_TELEMETRY_DISABLE=1` (no local telemetry).
Full reference: [docs/configuration.md](docs/configuration.md).

---

## FAQ

**Does my code leave my machine?** Only through Claude Code itself, exactly as when you use it
alone. Rein has no server and sends nothing anywhere; telemetry is a local SQLite file you can
disable.

**Do I need two Claude subscriptions?** No. Both panes run on your one Claude Code login. A second
account is optional, for keeping one project on another subscription.

**Can I use it on an existing project?** Yes. `ai init` adds `.ai/` and `.claude/` and never
overwrites your files; ask the Architect to reverse-engineer the codebase first.

**Can I use only one pane?** Yes — the Engineer alone is a disciplined single agent with memory,
gates and critics. You lose the planning half and the automatic handoff.

**Why are there so many rules?** Because each one replaced a failure that actually happened —
a red master nobody noticed, a role editing the other's plan, a secret in a command line. They
are hooks, so they cost you nothing until they save you.

**How do I turn a gate off?** In your own terminal, `ai gate off --minutes 15 --reason "…"`.
Catastrophic commands still block, and every bypassed call is announced. An agent cannot do this
for you.

More questions: [docs/troubleshooting.md](docs/troubleshooting.md#faq).

---

## Troubleshooting

| Symptom | First check | Then |
| :--- | :--- | :--- |
| `ai: command not found` | Is `~/.ai-os/bin` on `PATH`? | Open a new shell; `ai doctor` prints the export line. |
| MCP servers fail to start | `node --version` is 22.5+? | `ai mcp-setup`, then `ai doctor --env`. |
| A pane opens and then fails | `ai doctor` — is `claude` on PATH, are roles mapped? | `ai start --status`. |
| Commit refused by the pre-commit gate | Was the change reviewed? | Run `skill: ai-review` in the Engineer pane. |
| Push refused | `ai ci status --short` | `ai ci run`, fix what fails, push again. |
| Tasks differ between machines | `ai doctor` state health | `ai state import`. |
| The other pane never wakes | Is it open? A closed pane gets "not reachable". | Relaunch it with `ai start` or `ai pane <role>`. |

More: [docs/troubleshooting.md](docs/troubleshooting.md).

---

## Where this comes from

Rein is the successor of a private repository, AI-OS, developed over 678 commits in 2025–2026.
That history stays private because it carries the author's personal data; this repository
starts from a scrubbed snapshot of it and is developed in public from its first commit. Review
stamps carry the project's noreply identity, and personal names, addresses and paths in the
records were replaced with placeholders; nothing else in `.ai/` was changed. Nothing
of substance was lost: every design decision and blueprint is in [`.ai/`](.ai/) — the same
memory the agents read, and the best place to see how Rein builds itself.

---

## Contributing

Contributions are welcome under the Apache License 2.0; sign off each commit (`git commit -s`, the
[Developer Certificate of Origin](CONTRIBUTING.md#sign-your-commits-developer-certificate-of-origin)).
[CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup, writing skills and MCP servers,
the test layers and the commit conventions. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open a public
issue for them.

## Sponsoring

Rein is free and funded by its users. If it saves you time, please consider
[sponsoring the work][sponsor]; sponsor tiers and what they include are on the sponsor page.

## Licence

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The bundled tree-sitter
grammars are MIT-licensed; their notices are in `NOTICE`.

[ci]: https://github.com/Vimurai/rein/actions/workflows/ci.yml
[ci-badge]: https://github.com/Vimurai/rein/actions/workflows/ci.yml/badge.svg
[sponsor]: https://github.com/sponsors/Vimurai
[sponsor-badge]: https://img.shields.io/badge/sponsor-%E2%9D%A4-ea4aaa.svg
