# Getting started — the first hour

This page picks up where [Install](install.md) ends: `rein doctor` is all ✓, `rein init` has
run in your project, and `rein start` shows two panes, with the Engineer on the left and the
Architect on the right. Here is what the first hour looks like.

## 1. Give the Architect the picture

The Architect plans from `.ai/`, so the first job is to fill it.

**An existing codebase.** In the Architect pane:

> *Reverse-engineer this repository: populate `.ai/DIGEST.md`, `.ai/BRIEF.md` and seed
> `.ai/architect.md` from the real code. Read at most six files.*

The Architect reads the code map (`.ai/REPO_MAP.md`) and a handful of central files. It writes:

- `DIGEST.md` — a 20–60 line snapshot: what the product is, the stack, the current focus, known
  risks. Every later session reads it first.
- `BRIEF.md` — goals, non-goals and constraints, in a few lines. Correct it: it is the one file
  that is mostly yours.
- `architect.md` — the system blueprint: components, data, boundaries, the conventions it found.

**A new project.** Write two or three sentences into `.ai/BRIEF.md` yourself (what it is for,
what it is not), then go to step 2.

Read the three files. They are short on purpose, and everything the agents do next starts from
them. If something is wrong, say so in the Architect pane; it fixes the files.

## 2. The first blueprint

Ask for one feature, in outcomes:

> *Plan a `/health` endpoint that reports the app version and database status.*

The Architect answers with:

- a **blueprint**, `.ai/blueprints/health.md`: the goal, the components, the data, the API, the
  security notes, a rollback plan;
- a **decision** in `.ai/DECISIONS.md` if it had to choose between options, with the rejected
  alternatives and why;
- **tasks** in `.ai/TASKS.md`: `E-##` lines for the Engineer, each with a tier and acceptance
  criteria.

It may ask you questions first. Answer them in the Architect pane; it waits. When the plan is
written, the Architect wakes the Engineer.

## 3. Watch the Engineer

The Engineer pane comes alive by itself. It runs its preflight (digest, open tasks, health
checks), takes the first open `E-##`, and works through it:

- it writes the code and the tests;
- it runs the tests, and dispatches the Tester for missing ones;
- it runs the critics the task's risk tier calls for;
- it commits, gated: no review stamp, no commit;
- it runs `rein ci run` on the commit, and closes the task only when that is green.

You do not have to do anything. If it asks a question, answer it in the Engineer pane. If a
gate refuses something, the refusal names the rule and the agent reads it, as you can.

## 4. Read the handoff

When the Engineer's queue is empty, it appends a handoff to `.ai/COMM.md` and wakes the
Architect. The entry is short and always has the same sections:

- **What was built** — per task, with the files changed;
- **Decisions made** — anything decided on the way;
- **Blueprint divergence** — where the code differs from the plan, or "NONE";
- **Next action needed**;
- **Open risks**.

The divergence section is the one to read. The Architect reviews it, updates the blueprint to
match what was built (or files a task to change the code), and plans the next step.

## 5. Approve, push, repeat

The commits are local until you push. Look at them as you would a colleague's:

```bash
git log --oneline -5
git show --stat HEAD
rein ci status --short        # PASS <sha> means the commit itself was tested
```

Push when you are satisfied. The pre-push hook refuses a tip without a green local run, so a
push is never untested. Then describe the next feature to the Architect.

## Day to day

- `rein start` in the project directory reattaches, or rebuilds the panes if tmux was closed.
- `Ctrl-b` `d` detaches and leaves both agents working.
- One pane alone works: the Engineer by itself is a single agent with memory, gates, critics
  and CI, and you do the planning. Add tasks with `rein add-task "…"`.
- When `DIGEST.md` feels stale, ask for `skill: rein-digest`.

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
