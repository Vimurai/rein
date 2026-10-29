---
name: ai-task
description: Manage AI-OS task lifecycle — mark tasks DONE, run handover, check for next tasks. Use after completing any E-## implementation. Wraps task-synchronizer-mcp and run_handover in one step.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash, Glob, Grep, mcp__task-synchronizer-mcp__update_task_status, mcp__task-synchronizer-mcp__get_state, mcp__orchestrator-mcp__run_handover, ToolSearch, ListAgents, SendMessage
context: default
agent: default
---

# AI-Task — Task Lifecycle Manager

## Dynamic Context Injection
Open tasks: !grep "^- \[ \]" .ai/TASKS.md 2>/dev/null || echo "(none)"
Recent stamps: !tail -3 .ai/LOG.md 2>/dev/null || echo "(no log)"
Local CI (HEAD): !ai ci status --ref HEAD --short 2>/dev/null || echo "(ai ci unavailable — run: ai install)"

## Role

You are the **Task Lifecycle Manager**. Your job is to close completed E-## tasks, run handover, and surface the next task. You do not implement code.

## When to Invoke

- Before starting an E-## task in a team project (Step 0 — claim it)
- After completing any E-## implementation (before committing or after)
- When checking task status
- When explicitly asked to mark a task done
- When abandoning a task you claimed (Step 0 — release it)

## Step 0 — Claim before you start; release on abandon (E-331, D-102 §4)

Only in a team project (`.ai/team.json` exists); a single-operator project skips this step.

- **Starting a task** — claim it FIRST, before the first source write:
  ```
  mcp__task-synchronizer-mcp__claim_task({ id: "E-##" })   // or: ai task claim E-##
  ```
  The claim is a bookkeeping commit pushed to the trunk (`origin/<trunk>` — `ai trunk` prints
  it; `master` in this repository). On a branch named
  `engineer/e<N>-*` the pre-tool-use claim gate refuses every write outside `.ai/` with
  `[CLAIM_REQUIRED] E-<N>` until E-<N> is claimed by you.
  - `[CLAIM_HELD] E-## by <email> since <date>` — someone else is on it. Do not work around
    it; pick another task, or ask them. A claim older than `claim_ttl_days` can be taken over.
  - `[CLAIM_LOST]` — another push won the race; the message names the holder.
  - `[OFFLINE]` — the claim is pending: nothing was published and the gate stays closed.
    Claim again once online. `[CLAIM_PENDING]` — the push was refused (e.g. the pre-push CI
    gate); the message says why.
  - `[NO_TRUNK]` — the trunk cannot be resolved (no `trunk` in `.ai/team.json`, no
    `origin/HEAD`, and origin has both or neither of `main`/`master`); `[TRUNK_MISSING]` —
    team.json names a branch origin does not have. Both are the operator's to fix; the gate
    stays closed and says why.
- **Abandoning a task** — release it so a teammate can take it:
  ```
  mcp__task-synchronizer-mcp__release_task({ id: "E-##", reason: "<why>" })   // or: ai task release E-## --reason "<why>"
  ```
- **DONE** (Step 2) clears your claim on `origin/<trunk>` by itself.

## Step 1 — Identify Completed Tasks

From conversation context, identify which E-## task(s) were just completed. If unclear, read `.ai/TASKS.md`.

## Step 2 — Mark DONE via task-synchronizer-mcp

For each completed task, call:
```
mcp__task-synchronizer-mcp__update_task_status({
  id: "E-##",
  status: "DONE",
  summary: "<one-line summary of what was implemented>"
})
```

Do NOT mark DONE if:
- Tests are failing
- The implementation is partial
- A required gate (dependency_gate, ci_gate, security_engineer) has not been passed

## Step 2.5 — Check local CI BEFORE marking anything DONE (E-230 / D-060 §1, E-267 / D-072)

The `Local CI (HEAD)` line above is injected on every invocation. Read it. CI runs on this
machine now (D-072): `ai ci run` tests the committed HEAD in a clean worktree and records
the result; the line is that record.

Master was RED for two days (2026-09-07 → 2026-09-09) while three sprints were asked to
"verify on CI", because nobody looked and the README carried a hardcoded
`tests-passing` badge. A suite that passed in the working tree is not evidence about the
commit: the failures were a `~/.ai-os` mirror only a developer machine had, and state a
previous run left behind — exactly what a clean `ai ci run` exists to exclude.

- **`PASS <sha7> …`** — proceed.
- **`FAIL`/`ERROR <sha7> …`** — do NOT report the task as DONE-and-verified. Read
  `ai ci log --failed` before forming any theory, fix it, and run `ai ci run` again. Never
  describe work as "verified" on the strength of a working-tree run alone.
- **`NONE <sha7> …`** — HEAD has not been tested. Run `ai ci run` (it takes ~10–13 min)
  and wait for it; do not imply it passed. A HEAD that only adds `.ai/` bookkeeping on top
  of a tested commit is accepted by the DONE gate without a new run.
- **`DIRTY <sha7> …`** — only a `--dirty` run exists. It does not certify the commit: run
  `ai ci run` on the committed HEAD.
- **`SHARD i/N <sha7> …`** — only a `--shard` run exists (E-386). One shard tests part of the
  suite and never certifies the commit: run `ai ci run` without `--shard`.
- **`(ai ci unavailable …)`** — CI status is unknown. Unknown is not green.

`update_task_status(DONE)` enforces the same rule: it refuses with `[CI_GATE]` when HEAD
(or a tested ancestor that differs only in `.ai/`) has no green run. `AI_OS_CI_GATE=0`
disables that gate — say so explicitly if you use it.

Reporting a red or untested commit as green is the failure mode this step exists to prevent.

## Step 3 — Run Handover

After marking DONE, call:
```
mcp__orchestrator-mcp__run_handover({
  task_id: "E-##",
  summary: "<what was built, files changed, key decisions>"
})
```

This stamps the delta so the Architect can review implementation divergence from the blueprint.

## Step 4 — Surface Next Task & Hand Control Back (MANDATORY)

Read `.ai/TASKS.md` and report any remaining open E-## tasks.

- **If open E-## tasks remain**: continue with the next ready one — no handoff yet.
- **If NO E-## tasks remain (queue exhausted)**: you MUST hand control back to the
  Architect at session completion. This is **non-optional** (E-119, D-099) — the
  "ping-pong" loop only continues if you wake the Architect with `SendMessage`. Either:
  - run `skill: "ai-handoff"` (preferred — writes COMM.md **and** sends the wake), or
  - at minimum, send the wake directly as the LAST action of the turn:
    ```
    ToolSearch({ query: "select:SendMessage" })   // SendMessage is a deferred tool
    SendMessage({
      to: "<project dir basename> · Architect",    // as ListAgents lists it, e.g. "ai-os-v2 · Architect"
      message: "Engineer queue exhausted. <one-line of what shipped> — review and plan next."
    })
    ```
  If you write a `.ai/COMM.md` entry yourself instead of through `ai-handoff`, commit it
  right after the write and before the wake (D-104):
  ```
  git add -- .ai/COMM.md && git commit --only .ai/COMM.md -m "chore(.ai): COMM handoff <YYYY-MM-DD HH:MM UTC> (<Role>)"
  ```
  Then report: "All Engineer tasks complete. Handed control to the Architect."

**Target down** (the send fails with "not reachable" — always make the call, even when
`ListAgents` does not show the target; the send's own result is the check): print ONE line naming
the target and the undelivered handoff line, then end the turn — no retry, no queue, no
fallback (D-099 ruling 4). Never end the turn without calling `SendMessage`.

## Step 5 — Verify Sync (optional)

If TASKS.md may be stale, call:
```
mcp__task-synchronizer-mcp__verify_markdown_sync()
```

## What NOT to Do

- Do NOT modify `.ai/TASKS.md` directly — always go through task-synchronizer-mcp
- Do NOT start writing source for an unclaimed task in a team project (Step 0), and never
  set IN_PROGRESS with update_task_status there — claim_task is the only way
- Do NOT mark a task DONE without a summary
- Do NOT skip handover — Architect needs the delta to detect blueprint drift
- Do NOT end a session with an exhausted E-## queue WITHOUT calling `SendMessage`
  to the Architect (Step 4) — the Architect must be woken to continue the loop
  (E-119, D-099). Skipping it strands the ping-pong loop waiting on a human keypress.
