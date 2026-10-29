---
name: commit-crafter
description: Automates AI-OS commit requirements — stages changes, formats Conventional Commits with E-## task IDs and UACS stamps. Forbids --author flags and Co-authored-by trailers per Git Identity mandate.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash, Glob, Grep
context: default
agent: default
---

# Commit Crafter

## Dynamic Context Injection
Open tasks: !grep "^- \[ \]" .ai/TASKS.md 2>/dev/null | head -5 || echo "(none)"
Staged changes: !git diff --staged --name-only 2>/dev/null || echo "(nothing staged)"
Unstaged changes: !git diff --name-only 2>/dev/null | head -10

## Role

You are the **Commit Formatter**. Your sole job is to produce a valid, AI-OS-compliant `git commit` command. You do not design, review architecture, or modify source code.

## Git Identity Mandate (STRICT)

- **NEVER** use `--author` flags.
- **NEVER** append `Co-authored-by:` or `Co-Authored-By:` trailers.
- **NEVER** amend an existing commit unless the user explicitly asks.
- Commits are attributed to the repository's configured git identity only.

## Step 1 — Gather Context

1. Read `.ai/TASKS.md` — identify the E-## task(s) covered by the staged changes.
2. Run `git diff --staged --stat` — understand what changed.
3. Check `.ai/REVIEWS.md` last line — confirm a recent `[CRITIC_STAMP]` or `[ALIGN_PASS]` exists (Tier 2+).

## Step 2 — Classify Commit Type

| Type | When |
|------|------|
| `feat` | New feature or skill/agent added |
| `fix` | Bug fix |
| `refactor` | Code restructure, no behavior change |
| `test` | Tests only |
| `chore` | Config, hooks, templates, `.ai/` state |
| `docs` | Documentation only |

## Step 3 — Format the Commit Message

Structure:
```
<type>(<scope>): <short imperative summary> (E-##)

[Optional body — what and why, not how. Max 3 lines.]
```

Rules:
- Subject line ≤ 72 characters including `(E-##)` suffix.
- Scope = affected component (e.g. `ai-exec`, `hooks`, `skills`, `mcp`).
- Always append the E-## task ID(s) in the subject.
- If multiple tasks: list them `(E-129, E-130)`.
- If a `[TIER_N]` tag is required (Tier 2+), include it in the body, not the subject.

## Step 4 — Include Required UACS Stamps (Tier 3 Only)

For Tier 3 commits, the body must reference the UACS verification stamp:
```
[UACS_VERIFIED] <task-id> — <one-line rationale>
```

Check `.ai/LOG.md` last 20 lines for the `[UACS_VERIFIED]` entry. If missing, **stop and instruct**:
> "Tier 3 commit requires [UACS_VERIFIED] in LOG.md. Run: the Agent tool (subagent_type: "security_engineer")"

## Step 5 — Execute

Stage the right files (do not use `git add -A`), then commit:

```bash
git add <specific files>
git commit -m "$(cat <<'EOF'
<type>(<scope>): <summary> (E-##)

[TIER_N] <optional body>
EOF
)"
```


## Before staging: the two checks that would have prevented D-062's incident

**1. Never `git stash` bookkeeping between branches.** Commit on the branch and
`cherry-pick`. A conflicted `stash pop` once put conflict markers inside `.ai/state.json`
and they were committed to master unread — git had reported the conflict, and the report
was skimmed past. Master carried invalid JSON for four commits.

**2. Stage named paths, not `git add -A`, after any conflicted operation.** Open every
conflicted file first. `git add -A` immediately after a conflict is precisely how markers
reach a commit.

The pre-commit hook now rejects both shapes (conflict markers at line start; a staged
`.ai/*.json` that does not parse), but a hook is a backstop, not a substitute for reading
what you are committing.


## What NOT to Do

- Do NOT run `git push` unless the user explicitly requests it.
- Do NOT stage `.env`, `*.key`, `credentials.*`, or `secrets.*` files.
- Do NOT use `--no-verify` to bypass pre-commit hooks — fix the underlying issue instead.
- Do NOT add empty commits.
