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
| `tmux` | Recommended: `rein start` builds the two-pane layout in it. |
| `gh` | Optional: GitHub issue ingestion (`rein sync --github`). |

```bash
# macOS
brew install node tmux sqlite
# Debian/Ubuntu
sudo apt install tmux sqlite3 python3   # and Node 22.5+ from nodejs.org or your version manager
```

## Install

```bash
git clone https://github.com/Vimurai/rein.git && cd rein
bash install-rein.sh     # copies src/ → ~/.rein, installs the MCP servers' dependencies, adds the PATH line
exec "$SHELL"             # pick up PATH=~/.rein/bin
rein install                # Claude Code settings and hooks under ~/.claude
rein doctor                 # each ✗ prints its fix
```

`rein doctor` also reports optional tools: the GitHub Copilot CLI (`gh copilot`, for the `copilot`
skill) and the Playwright Chromium browser (for the UI audits; `rein mcp-setup --browsers`). A ✗
on those only disables what they power.

The install lives in `~/.rein` (the directory name predates the product name and is kept so
existing installs keep working). Nothing is installed system-wide.

## Enable it in a project

```bash
cd ~/code/my-project
rein init
```

`rein init` creates:

- `.ai/` — the project memory (see [How it works](how-it-works.md#the-ai-directory));
- `.claude/` — agents, skills and the per-role settings overlays;
- `.mcp.json` — the MCP servers Claude Code starts for this project;
- `ENGINEER.md`, `ARCHITECT.md` and a `CLAUDE.md` shim that imports the Engineer rulefile;
- the git hooks (`pre-commit`, `pre-push`, `post-commit`).

It never overwrites `BRIEF.md`, `TASKS.md`, `LOG.md`, `DIGEST.md`, `architect.md` or your
blueprints, so it is safe on an existing project and safe to run again. `rein init --check` lists
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
rein start
```

`rein start` creates or reuses one tmux session per project (named after the project directory),
orders the panes by `pane_identifier` in `.ai/roles.json`, binds each to its role and launches
Claude Code. It is idempotent: rerunning it re-pins the pane titles and attaches.

```bash
rein start --status        # which panes exist and what each is running
rein start --kill          # tear the project window down (asks first)
rein start --kill --yes    # same, without the prompt
rein start --detach        # build the layout without attaching
rein start --dry-run       # print the tmux commands instead of running them
```

Without tmux, `rein start` exits 2 and prints the manual recipe: open two terminals and run
`rein pane engineer` in one and `rein pane architect` in the other. Each pane keeps its shell when
Claude Code exits, so you can relaunch with the same command. Use a third terminal for `rein sync`,
`rein doctor` and git.

`rein doctor` checks that the launcher can work: tmux present, roles mapped, and each role's
provider on `PATH`. A missing provider gives a pane that opens and fails at the first keystroke,
so check there first.

## A second Claude account

Each Claude Code login is its own config directory. To keep one project on another subscription:

```bash
rein account add work          # creates ~/.claude-work, copies your settings, prompts /login
rein start --account work      # binds this project (.ai/start.json "account": "work")
rein start                     # both panes now run under the work login
```

`rein start --account default` unbinds it. `rein account list | remove <name> | sync <name>` manage
the registered accounts. A pane whose account does not resolve refuses to start rather than
falling back to the default login.

## Upgrading

```bash
cd rein && git pull
bash install-rein.sh          # refresh ~/.rein
rein install                     # optional: refresh ~/.claude settings and hooks

cd ~/code/my-project
rein init                        # upgrade the project to the installed version
rein sync                        # regenerate .mcp.json, .claude/, rulefiles, hooks
rein doctor
```

What `rein sync` does:

- updates `ENGINEER.md`, `ARCHITECT.md` and the `CLAUDE.md` shim;
- regenerates `.mcp.json` — servers you added yourself are kept, retired ones removed;
- refreshes `.claude/agents/` and `.claude/skills/`;
- reinstalls the git hooks;
- never touches `architect.md`, `BRIEF.md`, `TASKS.md`, `DIGEST.md` or anything else you wrote.

Older versions leave things behind (retired servers, old hooks, stale locks). `rein clean` lists
them; `rein clean --apply` moves them to `~/.rein/trash/<date>/`, and `rein clean --restore <date>`
puts them back.

## Uninstalling

```bash
rein uninstall      # removes ~/.rein after you type "uninstall"
```

Left for you to remove by hand: each project's `.ai/`, `.mcp.json`, `.claude/` and git hooks;
`~/.claude/` (it holds your own Claude Code settings too); and the
`export PATH="$HOME/.rein/bin:$PATH"` line in your shell rc.
