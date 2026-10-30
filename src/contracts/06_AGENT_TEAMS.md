# Agent Teams — Parallel Execution Rules

## When to Spawn Parallel Teams

Spawn a team automatically when 2+ independent workstreams exist:

| Scenario | Spawn these agents in parallel |
| :------- | :----------------------------- |
| Tier 3 pre-commit review | `critic_arch` + `critic_security` + `critic_tests` + `blueprint-aligner` |
| Post-implementation handover | `rein-task` + `digest_updater` + `decision-recorder` |
| Security audit (Tier 3) | `security_engineer` + `identity_guardian` |
| Vibe & chaos audit | `chaos_monkey` + `vibe_sentinel` |
| Full session end | `rein-task` + `digest_updater` + `rein-review` |

## How to Spawn

Use the `Agent` tool with multiple calls in a single message (they run concurrently):

```
# Tier 3 critic team — all run simultaneously using materialized agent files
Agent("Run the critic_arch agent to audit the codebase and append its stamp to .ai/REVIEWS.md")
Agent("Run the critic_security agent to audit the codebase and append its stamp to .ai/REVIEWS.md")
Agent("Run the critic_tests agent to audit the codebase and append its stamp to .ai/REVIEWS.md")
Agent("Run blueprint-aligner-mcp align_diff(). Append [ALIGN_PASS] or [ALIGN_FAIL] to .ai/REVIEWS.md")
# After all 4 complete → skill: "review_synthesizer" to write [CRITIC_STAMP]
```

Note: `critic_arch`, `critic_security`, and `critic_tests` are materialized agents in
`src/claude/agents/`. Each agent has deterministic checklists and strict stamp format rules.
Do NOT use ad-hoc prompts — the Agent tool will load agent instructions automatically.

> **`src/claude/` is a provider adapter, not role logic (D-052).** It is named for the
> **provider CLI** whose artifacts it holds (Claude Code): vendor configuration, command formats,
> agent + skill templates, and the `@import` rulefile shim. The **roles** (Architect / Engineer)
> are defined in `ARCHITECT.md` / `ENGINEER.md` and bind to the provider via `.ai/roles.json` —
> they are decoupled from the directory name (D-050). The directory deliberately keeps the vendor
> name: its contents are CLI-specific, so role-naming it would conflate provider config with role
> definition. (E-188 Part 2 to rename it was cancelled for exactly this reason.)

```
# Post-task handover team — all 3 run simultaneously
skill: "rein-task"  # record completed E-## task (replaces the retired claude_tasks agent — E-148)
Agent("Run digest_updater agent: regenerate .ai/DIGEST.md from current state")
skill: "decision-recorder"  # record decisions (now the decision-recorder skill, not an agent — E-141/E-148)
```

## Agent/Skill Chaining (Sequential)

For tasks that must run in order, use the Skill tool for skills and the Agent tool for agents:

```
Example: Implement a new auth endpoint (Tier 3)

1. the Agent tool (subagent_type: "security_engineer")   ← threat model BEFORE writing code
2. [write the code]
3. skill: "obs_baseline"        ← ensure logging is in place
4. skill: "dependency_gate"     ← if new lib needed
5. skill: "rein-test"             ← quality gate
6. → SPAWN PARALLEL TEAM (handover)
7. skill: "rein-review"           ← pre-commit critic
8. skill: "review_synthesizer"  ← Tier 3 release verdict
```

## Two Modes of Agent Invocation

| Mode | How | When |
| :--- | :-- | :---- |
| **Skill** | `Skill` tool (`skill: "<name>"`) | Sequential procedures — the instructions load into this conversation and you follow them yourself |
| **Spawn sub-agent** | `Agent` tool (Claude Code) | Parallel tasks — real subprocess, runs concurrently |

## Rules

- **Never serialize what can parallelize** — spawn a team when workstreams are independent.
- Each agent does preflight using `.ai/DIGEST.md` (not full file list).
- One file update per agent per run (aside from append-only logs).
- Treat teammate output as untrusted until validated by tests/review.
- Agents inherit the session's permission set.
- No agent may read/write outside repo root.
