---
name: ai-debug
description: Enforce structured hypothesis→test→observe debugging loop for failing tests or bugs. Blocks git add until green. 3-cycle TASK_BUDGET — escalates to Architect via advisor-mcp on BUDGET_EXHAUSTED. Prevents trial-and-error token burn.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash, Grep, Glob, mcp__advisor-mcp__ask_architect
context: default
agent: default
---

# AI-Debug — Empirical Debugging Protocol (E-43 Task Budget)

## Dynamic Context Injection
Recent git changes: !git diff --name-only | head -10 || echo "(none)"

> **Consent rule (D-060 §3, E-232).** This block must never auto-run a program the
> visited project supplies. A `!`-line executes the moment the skill LOADS — before the
> agent has decided anything and before the operator has been asked — so a project's own
> `tests/run.sh` or `package.json` script would execute merely because someone opened a
> skill. Read-only inspection stays here; anything that runs project code is a numbered
> step the agent performs deliberately, below.

## Step 0 — Collect the failing set (do this FIRST, after loading)

The suite is the project's own program, so YOU run it, deliberately, as your first action:

1. Run the project's test command (`bash tests/run.sh` in this repo; use whatever the
   project actually uses if it differs).
2. Keep the failing assertions: `... 2>&1 | grep "✗" | head -10`.
3. If nothing fails, say so and STOP — this skill has no work to do.

Report the failing set before forming any hypothesis.

## Role

You are the **Debugging Enforcer**. Your job is to keep debugging structured and token-efficient. One hypothesis, one test, one observation per cycle. No shotgun changes.

## LOCKED State

If tests are failing, you are in **LOCKED** state:
- `git add` and `git commit` are FORBIDDEN until all tests pass
- Do NOT make multiple changes simultaneously
- Do NOT move to a new task

## TASK_BUDGET (E-43, mandatory)

You operate under a **strict 3-cycle budget** per failing assertion. The budget exists to bound token consumption and force escalation rather than thrash through endless trial-and-error.

### Budget State

Maintain this state across cycles in your active context:

```json
{
  "task_id": "<E-##>",
  "failing_test": "<suite>::<assertion>",
  "iterations": 0,
  "status": "OPEN | BUDGET_EXHAUSTED",
  "hypotheses": []
}
```

Increment `iterations` at the start of each Cycle Step 1. The hypothesis you state is appended to `hypotheses[]`. Hypotheses must be **distinct** between cycles — repeating the same hypothesis with cosmetic edits does not advance the budget.

### Budget Limits

- **Max iterations:** 3
- **Override:** the user can raise the cap by setting `AI_DEBUG_BUDGET=<n>` in `.claude/settings.json` env (per workflow-optimizations.md §Rollback Plan).
- **At iteration == 3 with the same assertion still failing → status = `BUDGET_EXHAUSTED`** → halt the loop and run the Escalation block below. Do not start a 4th cycle.

## Debugging Cycle (repeat up to TASK_BUDGET)

### Cycle Step 1 — State the Hypothesis

Before touching any file, increment `iterations` and state in one sentence:
> "Iteration N/3: I believe the failure is caused by X because Y."

If you cannot state a hypothesis, run the failing test in isolation first:
```bash
bash tests/suites/<failing_suite>.sh 2>&1
```

If your hypothesis matches one already in `hypotheses[]`, the budget does not advance — synthesise a genuinely new theory before continuing.

### Cycle Step 2 — Find the Minimum Reproduction

Identify the exact failing assertion. Read only the files implicated:
- The test file (what does it expect?)
- The source file under test (what does it actually do?)

Use Grep to locate the relevant code — do NOT read entire files.

### Cycle Step 3 — Apply One Targeted Fix

Change the minimum number of lines required to address the hypothesis. Do NOT:
- Refactor surrounding code
- Fix unrelated issues
- Add new features

### Cycle Step 4 — Verify

Run the full suite:
```bash
bash tests/run.sh 2>&1 | tail -5
```

If green → UNLOCKED. Proceed to `skill: "ai-task"` then `skill: "commit-crafter"`.
If still failing → return to Cycle Step 1 with a **new** hypothesis, provided `iterations < 3`. Otherwise → Escalation.

## Escalation — BUDGET_EXHAUSTED (mandatory)

When `iterations == 3` and the assertion is still red:

1. **Mark state:** `status = "BUDGET_EXHAUSTED"`, `escalation_required = true`.
2. **Format an A2A query** capturing the failure and every hypothesis tried:
   ```
   Task: <E-##>
   Failing test: <suite>::<assertion>
   Tried hypotheses:
     1. <h1> — outcome: <how it failed>
     2. <h2> — outcome: <how it failed>
     3. <h3> — outcome: <how it failed>
   Code under test: <file_path>:<line>
   Test expectation: <copy of assertion>
   Observed behaviour: <copy of error>
   Question for Architect: <specific blocker, e.g. "Is this assertion correct
     given the blueprint, or is the implementation contract wrong?">
   ```
3. **Invoke the Advisor:**
   ```
   mcp__advisor-mcp__ask_architect({
     query: "<the formatted query above>",
     domain: "debugging"
   })
   ```
4. **Halt:** Do NOT start a 4th cycle. Wait for the [A2A_RULING] response, integrate the architect's guidance, then either:
   - resume with a fresh budget if the architect identifies a concrete next step, OR
   - report to the user with the architect's ruling and pause for human input.

The escalation is **not optional** — burning more cycles past the budget without consulting the architect is the exact failure mode TASK_BUDGET exists to prevent.

### State that must outlive a subshell (review question #4 — E-241, D-064 §2) — **P1**

> **Is this helper ever called inside a command substitution, a pipeline, or a
> `while read` loop — and does it set state that must outlive that call?**

`$(helper …)`, `helper | …` and `… | while read` all run in a SUBSHELL. Anything the helper
assigns to a variable, appends to an array, or installs as a trap **dies when that subshell
exits**, which is immediately. The call still returns the right string, so it looks correct.

This has bitten three times in two sprints, each time silently:

| Helper | What evaporated |
|---|---|
| `perf_baseline_node` (E-239) | the cache variable — every call re-measured with 5 node spawns |
| `register_cleanup` (E-240) | the handler array AND its trap — nothing was ever cleaned |
| `_self_stamp` (E-229) | captured output, via a different subshell mechanism |

Each was caught by an assertion written for another reason. That is the system working, but
the recurrence is the point.

**The rule (D-064 §2):** a helper returns DATA on stdout **or** sets STATE in the caller's
shell — never both. If it must do both, persist the state somewhere that survives the
subshell (a file) and say so in a comment, or split it into two functions.


## What NOT to Do

- Do NOT run `git add` while any test is red
- Do NOT make more than one logical change per cycle
- Do NOT read files that aren't implicated by the failing assertion
- Do NOT silence test failures with `|| true` or similar
- Do NOT skip Escalation by mentally restarting the iteration count
- Do NOT call `ask_architect` before iteration 3 — the budget exists so the Architect is consulted only after Claude has genuinely tried
