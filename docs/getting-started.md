# Getting started

## Requirements

| Requirement | Why |
| :--- | :--- |
| macOS or Linux (bash/zsh) | The installer and hooks are bash. On Windows, use WSL2. |
| **Node.js 22.5+** | The MCP servers use the built-in `node:sqlite`; Node 20 starts some servers but not the SQLite-backed ones. |
| Python 3.10+ | Generates `.mcp.json`; a bash/jq fallback exists. |
| `sqlite3` CLI | The hooks read `.ai/state.sqlite`. |
| `git` | Everything is git-aware: gates are git hooks, CI tests commits. |
| **Claude Code** (`claude`) | Runs every role. One login is enough. |
| `tmux` | Recommended: `ai start` builds the two-pane layout in it. |
| `gh` | Optional: GitHub issue ingestion (`ai sync --github`). |

```bash
# macOS
brew install node tmux sqlite
# Debian/Ubuntu
sudo apt install tmux sqlite3 python3   # and Node 22.5+ from nodejs.org or your version manager
```

## Install

```bash
git clone https://github.com/Vimurai/rein.git && cd rein
bash install-ai-os.sh     # copies src/ → ~/.ai-os, installs the MCP servers' dependencies, adds the PATH line
exec "$SHELL"             # pick up PATH=~/.ai-os/bin
ai install                # Claude Code settings and hooks under ~/.claude
ai doctor                 # each ✗ prints its fix
```

`ai doctor` also reports optional tools: the GitHub Copilot CLI (`gh copilot`, for the `copilot`
skill) and the Playwright Chromium browser (for the UI audits; `ai mcp-setup --browsers`). A ✗
on those only disables what they power.

The install lives in `~/.ai-os` (the directory name predates the product name and is kept so
existing installs keep working). Nothing is installed system-wide.

## Enable it in a project

```bash
cd ~/code/my-project
ai init
```

`ai init` creates:

- `.ai/` — the project memory (see [How it works](how-it-works.md#the-ai-directory));
- `.claude/` — agents, skills and the per-role settings overlays;
- `.mcp.json` — the MCP servers Claude Code starts for this project;
- `ENGINEER.md`, `ARCHITECT.md` and a `CLAUDE.md` shim that imports the Engineer rulefile;
- the git hooks (`pre-commit`, `pre-push`, `post-commit`).

It never overwrites `BRIEF.md`, `TASKS.md`, `LOG.md`, `DIGEST.md`, `architect.md` or your
blueprints, so it is safe on an existing project and safe to run again. `ai init --check` lists
what it would change.

**New project:** fill in `.ai/BRIEF.md` (goals and non-goals) in a sentence or two, then ask the
Architect to plan the first feature.

**Existing project:** ask the Architect: *"Reverse-engineer this repository — populate
`.ai/DIGEST.md`, `.ai/BRIEF.md` and seed `.ai/architect.md` from the real code. Read at most six
files."*

## The two-pane layout

```
┌─────────────────────────┬─────────────────────────┐
│  Engineer               │  Architect              │
│  claude · opus  (0)     │  claude · fable  (1)    │
│                         │                         │
│  - implements tasks     │  - blueprints, tasks    │
│  - runs skills, tests   │  - decisions, rulings   │
│  - commits              │  - reviews              │
└─────────────────────────┴─────────────────────────┘
        ◀──────── SendMessage (wake) ────────▶
```

```bash
cd /path/to/your-project
ai start
```

`ai start` creates or reuses one tmux session per project (named after the project directory),
orders the panes by `pane_identifier` in `.ai/roles.json`, binds each to its role and launches
Claude Code. It is idempotent: rerunning it re-pins the pane titles and attaches.

```bash
ai start --status        # which panes exist and what each is running
ai start --kill          # tear the project window down (asks first)
ai start --kill --yes    # same, without the prompt
ai start --detach        # build the layout without attaching
ai start --dry-run       # print the tmux commands instead of running them
```

Without tmux, `ai start` exits 2 and prints the manual recipe: open two terminals and run
`ai pane engineer` in one and `ai pane architect` in the other. Each pane keeps its shell when
Claude Code exits, so you can relaunch with the same command. Use a third terminal for `ai sync`,
`ai doctor` and git.

`ai doctor` checks that the launcher can work: tmux present, roles mapped, and each role's
provider on `PATH`. A missing provider gives a pane that opens and fails at the first keystroke,
so check there first.

## A second Claude account

Each Claude Code login is its own config directory. To keep one project on another subscription:

```bash
ai account add work          # creates ~/.claude-work, copies your settings, prompts /login
ai start --account work      # binds this project (.ai/start.json "account": "work")
ai start                     # both panes now run under the work login
```

`ai start --account default` unbinds it. `ai account list | remove <name> | sync <name>` manage
the registered accounts. A pane whose account does not resolve refuses to start rather than
falling back to the default login.

## Upgrading

```bash
cd rein && git pull
bash install-ai-os.sh          # refresh ~/.ai-os
ai install                     # optional: refresh ~/.claude settings and hooks

cd ~/code/my-project
ai init                        # upgrade the project to the installed version
ai sync                        # regenerate .mcp.json, .claude/, rulefiles, hooks
ai doctor
```

What `ai sync` does:

- updates `ENGINEER.md`, `ARCHITECT.md` and the `CLAUDE.md` shim;
- regenerates `.mcp.json` — servers you added yourself are kept, retired ones removed;
- refreshes `.claude/agents/` and `.claude/skills/`;
- reinstalls the git hooks;
- never touches `architect.md`, `BRIEF.md`, `TASKS.md`, `DIGEST.md` or anything else you wrote.

Older versions leave things behind (retired servers, old hooks, stale locks). `ai clean` lists
them; `ai clean --apply` moves them to `~/.ai-os/trash/<date>/`, and `ai clean --restore <date>`
puts them back.

## Uninstalling

```bash
ai uninstall      # removes ~/.ai-os after you type "uninstall"
```

Left for you to remove by hand: each project's `.ai/`, `.mcp.json`, `.claude/` and git hooks;
`~/.claude/` (it holds your own Claude Code settings too); and the
`export PATH="$HOME/.ai-os/bin:$PATH"` line in your shell rc.
