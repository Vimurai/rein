---
name: ci_gate
description: Gate required before changing any CI/CD pipeline or deployment config. Documents the change, security implications, and rollback plan in .ai/DEVOPS.md before any edits are made.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob, Edit, Write
context: default
agent: default
---

# CI Gate (Required Before Changing the CI Runner, Its Gates, or Deployment Config)

In THIS project CI runs locally (D-072): there is no hosted pipeline. The config files this
gate protects are `hooks/pre-push.sh`, the `ai ci` subcommands in `src/bin/ai`, the
`ci_runs` record in `src/mcp/shared/ci-runs.js`, and any deployment script. A downstream
project may still have a hosted pipeline — the same gate applies to it.

Before altering any of them, document in `.ai/DEVOPS.md`:
- What is changing and why
- Security implications: new secrets needed? new network access? new permissions?
- Rollback plan: how to revert if the pipeline breaks
- Test the change on a branch first — never modify the gate on the trunk blindly, and prove the
  new behaviour with a real `ai ci run`, not only with unit tests of the gate

## Step Order (Always Enforce)
Setup before measurement, and nothing measured in the operator's own environment:
`worktree → env → deps → browsers → install → toolchain → suite → unit → secrets`
(`ai ci run`). A step that cannot start is an ERROR, not a FAIL. For a project with a
hosted pipeline the equivalent order is `lint → typecheck → test → build → deploy`, with
deploy only on protected branches.

Never merge or push a commit without a green `ai ci run` (`ai ci status`). Never skip it with
`--no-verify` or equivalent; a deliberate skip is `AI_OS_CI_SKIP=1 AI_OS_CI_SKIP_REASON="<why>"`,
and it is recorded (D-072).

## Dynamic Context Injection
Local CI (HEAD): !ai ci status --ref HEAD --short 2>/dev/null || echo "(ai ci unavailable)"
Recent runs: !ai ci list -n 3 2>/dev/null || echo "(none recorded)"
Deployment config present: !ls -1 Dockerfile docker-compose*.yml fly.toml Procfile 2>/dev/null | head -5 || echo "(none)"
