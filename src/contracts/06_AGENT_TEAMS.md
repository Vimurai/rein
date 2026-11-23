# Agent Teams — Parallel Execution Rules

## When to Spawn Parallel Teams

Spawn a team automatically when 2+ independent workstreams exist:

| Scenario | Spawn these agents in parallel |
| :------- | :----------------------------- |
| Security audit (Tier 3) | `security_engineer` + `identity_guardian` |
| Vibe & chaos audit | `chaos_monkey` + `vibe_sentinel` |

## How to Spawn

Use the `Agent` tool with multiple calls in a single message (they run concurrently).

Bookkeeping is not a team either (E-461, D-169 r7): `rein done`, `rein handoff` and
`rein decide` are commands, run one after the other in the session that did the work.

Review is NOT a parallel team (E-464, D-169 r8): it is sized by tier and runs in order —
`rein review <tier>` prints the agents (Tier 2: `reviewer`, then `critic_acceptance`; Tier 3:
those and one `security_engineer` round), and the DONE gate checks their stamps.

> **`src/claude/` is a provider adapter, not role logic (D-052).** It is named for the
> **provider CLI** whose artifacts it holds (Claude Code): vendor configuration, command formats,
> agent + skill templates, and the `@import` rulefile shim. The **roles** (Architect / Engineer)
> are defined in `ARCHITECT.md` / `ENGINEER.md` and bind to the provider via `.ai/roles.json` —
> they are decoupled from the directory name (D-050). The directory deliberately keeps the vendor
> name: its contents are CLI-specific, so role-naming it would conflate provider config with role
> definition. (E-188 Part 2 to rename it was cancelled for exactly this reason.)

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
7. rein review 3                 ← reviewer, critic_acceptance, security_engineer (checked at DONE)
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
