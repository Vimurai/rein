---
name: bug-reproducer
description: Enforces empirical validation for Tier 2/3 bug fixes. Forces creation of an isolated repro.sh or failing test that proves the bug exists before any source modification is allowed.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Write, Bash, Grep, Glob
context: default
agent: default
---

# Bug Reproducer

## Dynamic Context Injection
Current branch: !git rev-parse --abbrev-ref HEAD 2>/dev/null

> **Consent rule (D-060 §3, E-232).** This block must never auto-run a program the
> visited project supplies. A `!`-line executes the moment the skill LOADS — before the
> agent has decided anything and before the operator has been asked — so a project's own
> `tests/run.sh` or `package.json` script would execute merely because someone opened a
> skill. Read-only inspection stays here; anything that runs project code is a numbered
> step the agent performs deliberately, below.

## Step 0 — Collect recent failures (do this FIRST, after loading)

1. Run the project's test command (`bash tests/run.sh` here) and keep the `✗` lines:
   `bash tests/run.sh 2>&1 | grep "✗" | head -5`.
2. If there are none, ask which behaviour to reproduce rather than guessing.

## Role

You are the **Empirical Validator**. Before any source file is touched, you must prove the bug exists with a reproducible artifact. This eliminates phantom fixes and regression blind spots.

## Applicability

Apply this skill for **Tier 2 and Tier 3 bug fixes only**. Skip for:
- Tier 1 changes (config, docs, templates).
- New feature work with no existing broken behavior.

## Step 1 — Understand the Bug Report

Read the bug description from the current task in `TASKS.md` or conversation context:
```bash
grep "^- \[ \]" .ai/TASKS.md | head -3
```

Extract:
- **Symptom**: what the user observes.
- **Expected behavior**: what should happen.
- **Affected component**: file/function/command.

## Step 2 — Create the Reproduction Artifact

Choose ONE of:

### Option A — `repro.sh` (for CLI/Bash bugs)

Create `repro.sh` at the project root:
```bash
#!/usr/bin/env bash
# repro.sh — reproduces: <bug summary>
# Expected: <expected output>
# Actual:   <actual output>
set -euo pipefail

# Setup minimal environment
# ...

# Trigger the bug
<command that demonstrates the failure>

echo "BUG REPRODUCED ✓"
```

Run it: `bash repro.sh` — it must **fail** (or produce wrong output) before the fix.

### Option B — Failing Unit Test (for function/module bugs)

Add a failing test assertion to the relevant suite in `tests/suites/`:
```bash
assert_equals "expected value" "$(actual_command)" "T-XX: <bug description>"
```

Run: `bash tests/run.sh` — the new assertion must **fail** before the fix.

## Step 3 — Confirm Reproduction

The artifact must demonstrate the bug on the **current unmodified code**:
```bash
bash repro.sh && echo "BUG NOT REPRODUCED — recheck description" || echo "BUG CONFIRMED ✓"
# or
bash tests/run.sh 2>&1 | grep "✗.*T-XX"
```

**Do NOT proceed to Step 4 until reproduction is confirmed.**

## Step 4 — Log the Reproduction

Append to `.ai/LOG.md`:
```
- <date> | Claude | [BUG_REPRO] <E-## task-id> | repro.sh created — confirms: <symptom>
```

Or use the task-synchronizer stamp:
```
mcp__task-synchronizer-mcp__add_stamp({ type: "BUG_REPRO", agent: "claude", summary: "<E-##>: <symptom confirmed>" })
```

## Step 5 — Proceed to Fix

Now you may modify source files. After the fix:
1. Re-run `bash repro.sh` — must **pass** (or exit 0).
2. Re-run `bash tests/run.sh` — all suites must pass.
3. Delete or commit `repro.sh` as appropriate (delete if a proper test was added instead).

## Forbidden Actions

- Do NOT modify `src/` before Step 3 is complete.
- Do NOT delete `repro.sh` before the fix is verified.
- Do NOT skip this skill for Tier 2/3 bugs — it is a mandatory gate.
