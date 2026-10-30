# How it works

Rein turns Claude Code into a small team: an **Architect** that plans, an **Engineer** that
builds, a **Tester** and **critics** that check. One memory, `.ai/`, lives in your repository.
Hooks enforce the rules between them, so the rules hold even when the model forgets them.

```mermaid
flowchart LR
    You(["You<br/>ask, answer, approve"])
    subgraph A["Architect pane · claude fable"]
        A1["blueprint · tasks · decisions"]
    end
    subgraph E["Engineer pane · claude opus"]
        E1["code · tests · commit"]
    end
    subgraph M[".ai/ shared memory"]
        M1[("state.sqlite<br/>ACID · WAL")]
        M2["TASKS · DIGEST · COMM<br/>blueprints · DECISIONS"]
    end
    C["critics + tester<br/>arch · security · tests"]
    You -->|"plan X"| A
    A -->|"writes"| M
    A -->|"wake"| E
    E -->|"reads"| M
    E -->|"dispatches"| C
    C -->|"stamps"| M
    E -->|"hands back"| A
    E -->|"commit, gated"| G["git · pre-commit · rein ci run · pre-push"]
    G -->|"PR"| H["hosted CI · fast + shards"]
```

![Rein: the Architect plans and hands off, the gate holds, the Engineer builds, tests and commits — a real run, 80 seconds](assets/demo.gif)

## The roles

| Role | Rulefile | Model (default) | Owns | Cannot |
| :--- | :--- | :--- | :--- | :--- |
| **Architect** | `ARCHITECT.md` | `fable`, pane 1 | `.ai/architect.md`, `.ai/blueprints/`, decisions, planning tasks | write source code |
| **Engineer** | `ENGINEER.md` | `opus`, pane 0 | `src/`, `tests/`, implementation tasks, commits | rewrite the blueprint |
| **Tester** | `test_engineer` agent | `sonnet`, headless | tests under `tests/`, test stamps | write outside `tests/` |

`rein pane <role>` launches Claude Code with the role's model and permission overlay
(`.claude/settings.<role>.json`) and stamps the session with its role. The SessionStart hook reads
that stamp, so the right rulefile governs even though `CLAUDE.md` statically imports the Engineer
one. The Tester has no pane: the Engineer dispatches it with `skill: rein-test --generate`.

Role bindings are data, in `.ai/roles.json`. To give the Architect a different model, change it
there and relaunch the pane.

## A task's life

1. **Plan.** You describe the intent to the Architect. It reads the snapshot, writes or amends a
   blueprint under `.ai/blueprints/`, records any decision in `.ai/DECISIONS.md`, and adds
   implementation tasks (`E-##`) with acceptance criteria. Its last action is to wake the
   Engineer.
2. **Implement.** The Engineer's session starts with `skill: rein-preflight`: the digest, the open
   tasks, sync and health checks. It implements the next task, under the gates.
3. **Validate.** `skill: rein-test` runs the project's own test command; `--generate` has the Tester
   write missing tests.
4. **Review.** `skill: rein-review` classifies the change's risk tier and runs the matching critics.
5. **Commit.** The pre-commit gate checks for a review stamp; `rein ci run` tests the commit in a
   clean worktree.
6. **Close.** `skill: rein-task` marks the task done, but only once CI is green. It records the
   delta for the Architect and moves on. When the queue is empty, it wakes the Architect.

## Memory that survives the chat

A session never re-reads your repository to find its place. It reads a short snapshot, then its
open tasks, then a blueprint only when a task names one. Everything it does is written back as
it goes.

```mermaid
flowchart TD
    S["session start<br/>rein-preflight"] --> D["DIGEST.md<br/>20–60 lines, the snapshot"]
    D --> T["TASKS.md<br/>open E-## / P-##"]
    T --> B{"task names a blueprint?"}
    B -->|yes| BP[".ai/blueprints/&lt;name&gt;.md"]
    B -->|no| W["work"]
    BP --> W
    W --> L["LOG · COMM · stamps<br/>written as it goes"]
    L --> M[("state.sqlite ⇄ Markdown mirrors")]
```

### The `.ai/` directory

```
.ai/
  state.sqlite       ACID task store (WAL mode). Never hand-edit.
  state.json         Readable mirror of it, tracked in git.
  DIGEST.md          The 20–60 line project snapshot every session reads first.
  TASKS.md           Planning (P-##) and implementation (E-##) tasks — a generated view.
  architect.md       The system blueprint. Architect-owned.
  blueprints/        One blueprint per domain or feature.
  DECISIONS.md       Decisions (D-###): context, rulings, rejected alternatives.
  BRIEF.md           Product goals, non-goals, constraints.
  RULES.md           Token economics and the role contract.
  CAPABILITIES.md    Paths and commands the agents may use (an input to the security gate).
  REVIEWS.md         Review stamps ([ARCH_PASS], [SEC_FAIL], …) — a generated view.
  LOG.md             Append-only action log; rotated past 200 lines.
  COMM.md            Handoff notes between the roles.
  SESSION.md         Per-session preflight stamps.
  REPO_MAP.md        A token-budgeted map of the code (most central files, signatures only).
  roles.json, providers.json, start.json, team.json   Configuration.
  archive/YYYY-MM/   Rotated LOG, COMM and REVIEWS.
```

`TASKS.md` and `REVIEWS.md` are regenerated from the store: change tasks through the agents'
tools or `rein add-task` / `rein task done`, never by hand. `.ai/` is primary memory: when the chat
and the files disagree, the files win.

### Context economy

Skills load their full text only when invoked; until then only a one-line description is in
context. Subagents (critics, specialists) run in their own context and return a short report, so
their file reads never land in the main session. `REPO_MAP.md` gives orientation without opening
files.

## The wake

When a role finishes, its skill appends a structured entry to `.ai/COMM.md`: what was built,
decisions, divergence from the blueprint, the next action, open risks. It commits the entry.
Then, as the last action of the turn, it calls Claude Code's `SendMessage` to the other pane's
session, named `<project directory> · <Role>`.

- A busy pane receives the message when its current tool call ends.
- If the other pane is closed, the send fails with "not reachable". The skill prints one line
  naming the undelivered handoff and stops: no retry, no queue. Relaunch the pane and carry on;
  the note is waiting in `.ai/COMM.md`.

## The hooks and the gates

Every change gets a **risk tier**: 1 for docs and config, 2 for ordinary code, 3 for security,
state, hooks and removals. The tier decides how much review the change needs before its commit.
Hooks enforce the rest at three points:

```mermaid
flowchart LR
    T["tool call"] --> H{"hook"}
    H -->|"Architect writes source?"| X1["refused"]
    H -->|"destructive shell?"| X2["refused"]
    H -->|ok| R["runs"]
    R --> C["git commit"]
    C --> P{"pre-commit<br/>fresh review stamp?"}
    P -->|no| X3["refused"]
    P -->|yes| CI["rein ci run<br/>clean worktree, lanes, budget"]
    CI --> PP{"pre-push"} --> HC["hosted CI<br/>fast · shards · CodeQL · privacy"]
```

1. **Tool-call gate** (Claude Code's PreToolUse hook, on every tool call): role boundaries,
   destructive shell commands, secrets in a command line, writes outside the project.
2. **Pre-commit gate** (git): the commit needs a review stamp bound to its parent. A commit
   that only touches `.ai/` bookkeeping is exempt. Conflict markers and broken `.ai/*.json`
   are refused.
3. **Pre-push gate** (git): the tip needs a green `rein ci run`.

What the critics check and how each gate decides: [Gates and review](gates-and-review.md). The
CI side: [CI](ci.md).
