# Getting started

From nothing to one closed task in four steps. You need Claude Code installed and logged in
(`claude --version` prints a version), plus Node.js 22+, `git`, `sqlite3`, `python3`, `tmux`
and, on Linux or WSL2, `bubblewrap` and `socat`. Starting from an empty machine:
[Install](install.md) walks through each one.

## 1. Install Rein

```bash
git clone https://github.com/Vimurai/rein.git && cd rein
bash install-rein.sh      # copies Rein to ~/.rein, runs rein install, adds ~/.rein/bin to PATH
exec "$SHELL"             # reload the shell so `rein` is found
rein doctor               # every ✗ names its fix
```

`install-rein.sh` runs `rein install`, which builds the `rein` plugin (4 agents, 5 skills, the
session hooks) and adds its marketplace to Claude Code.

## 2. Turn your project into a Rein project

```bash
cd ~/code/my-project      # any git repository, new or existing
rein init
```

It creates `.ai/` (the ledger and the record), the rulefiles `ENGINEER.md`, `ARCHITECT.md` and a
role-neutral `CLAUDE.md`, `.mcp.json`, `.claude/settings.json`, the git hooks, and the role settings
files under `~/.rein/roles/`. It enables the plugin for this project. It never overwrites a file
you wrote, so running it again is safe. Commit what it created.

## 3. Start the panes and ask for a plan

```bash
rein start
```

A tmux session opens with the **Engineer** on the left and the **Architect** on the right, each
bound to its role and its sandbox. Move to the Architect (`Ctrl-b` `o`) and ask for an outcome:

> *Plan a `/health` endpoint that reports the app version and database status.*

The Architect writes `.ai/blueprints/health.md`, adds `E-##` tasks with a tier and an acceptance
line, and wakes the Engineer. For an existing codebase, ask first: *"Reverse-engineer this
repository into `.ai/BRIEF.md` and `.ai/architect.md`."*

## 4. Let the Engineer close the task

The Engineer pane wakes by itself. For each task it writes the code and the tests, commits, runs
`rein review <tier>` and dispatches the agents it names, then closes the task:

```bash
rein done E-2 --summary "health endpoint and its tests"
```

A Tier 2 task is refused until `rein:reviewer` and `rein:critic_acceptance` have recorded a pass
for HEAD; the refusal names the missing stamp. When the queue is empty, the Engineer runs
`rein handoff --to architect` and the Architect reads what was built.

Check the result from any terminal:

```bash
rein task show E-2        # E-2 | DONE | Tier 2 | …
```

<details>
<summary>The same loop without the panes</summary>

The ledger works from the shell alone. A Tier 1 task needs no review, so this closes one in a
scratch project in four commands:

```bash
rein add-task --tier 1 "Add a README.md that names the project. Acceptance: README.md exists"
echo "# demo" > README.md && git add README.md && git commit -m "docs: README (E-2)"
rein done E-2 --summary "README added"
rein task show E-2        # E-2 | DONE | Tier 1 | …
```

`rein add-task` prints the id it gave the task (`rein init` seeds `P-1` and `E-1`, so the first is
usually `E-2`).

</details>

## Day to day

- `rein start` in the project reattaches, or rebuilds the panes if tmux was closed.
  `Ctrl-b` `d` detaches and leaves both agents working.
- `.ai/TASKS.md` lists the open tasks; `rein task show <id>` prints any task.
- `rein doctor` after anything odd; [Troubleshooting](troubleshooting.md) has the common cases.
- What Rein adds and why: [How it works](how-it-works.md). The commands: [Commands](commands.md).

## A second Claude account

Each Claude Code login is its own config directory. To keep one project on another subscription:

```bash
rein account add work          # creates ~/.claude-work, copies your settings, prompts /login
rein start --account work      # binds this project (.ai/start.json "account": "work")
```

`rein start --account default` unbinds it. See [Accounts](accounts.md).
