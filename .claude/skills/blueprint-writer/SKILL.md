---
name: blueprint-writer
description: Enforce blueprint structure before writing to .ai/blueprints/. Validates required sections (Core Concept, Data Model, API Contracts, Security, Rollback Plan, 3+ components) before any write. Blocks lazy blueprints.
disable-model-invocation: false
user-invocable: true
context: default
agent: default
---

# Blueprint Writer — Structure Enforcement Gate

## Dynamic Context Injection
Existing blueprints: !ls .ai/blueprints/*.md 2>/dev/null || echo "(none)"
architect.md version: !head -1 .ai/architect.md 2>/dev/null || echo "(missing)"

## Role

You are the **Blueprint Enforcer**. Your job is to ensure every blueprint written to `.ai/blueprints/` is complete, actionable, and free of template boilerplate before it reaches Claude. Lazy blueprints waste implementation cycles.

## When to Invoke

- Before writing any new file to `.ai/blueprints/`
- Before updating an existing blueprint with significant changes
- When asked to design a new domain, feature, or system component

## Step 1 — Draft the Blueprint

Write the blueprint in-context first. Do NOT write to disk yet.

Required sections (all must be non-empty, non-boilerplate):

| Section | Minimum content |
|---|---|
| **Goal & Architecture** | What problem this solves, who uses it, 1-sentence summary |
| **Core Concept** | The central abstraction — what is the thing being built? |
| **Components** | At least 3 named components with responsibilities |
| **Data Model** | Key entities, relationships, schema sketch |
| **API / Interface Contracts** | How this component is called — inputs, outputs, errors |
| **Security** | Auth, secrets handling, trust boundaries, threat surface |
| **Execution Constraints** | Performance limits, concurrency, resource bounds |
| **Rollback Plan** | How to undo this if it goes wrong |
| **E-## Task Breakdown** | At least 1 E-## task for Claude per major component |

## Step 2 — Validate Before Writing

Check each required section:
- Is it present? (not just a heading with no content)
- Is it specific to this domain? (no generic placeholder text)
- Does it have enough detail for Claude to implement without guessing?

If ANY section is missing or contains boilerplate → **STOP**. Fill it before proceeding.

Minimum length check: blueprint must be ≥ 20 lines. Shorter = lazy.

## Step 3 — Write to Disk

Only after validation passes:
```
Write to: .ai/blueprints/<domain>.md
```

File naming:
- Use lowercase, hyphen-separated: `auth.md`, `workspace.md`, `mcp-server.md`
- Never overwrite without reading existing content first

## Step 4 — Register E-## Tasks

After writing the blueprint, use `task-planner` skill to write the corresponding E-## tasks to TASKS.md:
```
skill: "task-planner"
```

## Step 5 — Confirm

Report:
> "Blueprint written to .ai/blueprints/<domain>.md — <N> sections validated, <N> E-## tasks created."

## What NOT to Do

- Do NOT write a blueprint shorter than 20 lines
- Do NOT leave Security or Rollback Plan empty
- Do NOT write "TBD" or "TODO" in any required section — fill it or ask the user
- Do NOT write source code in the blueprint (pseudo-code in Data Model is permitted)
