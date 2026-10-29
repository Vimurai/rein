---
name: ai-digest
description: Use this skill when DIGEST.md is stale (>3 days old), after a major sprint, or after running skill: ai-archive. Reads all .ai/ files and produces a concise 20-60 line project snapshot.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash, Write, Edit
context: default
agent: default
---

# AI-OS Digest — Regenerate DIGEST.md

## Dynamic Context Injection
Current DIGEST age: !stat -f "%Sm" .ai/DIGEST.md 2>/dev/null || stat -c "%y" .ai/DIGEST.md 2>/dev/null || echo "(unknown)"
Last LOG entry: !tail -5 .ai/LOG.md 2>/dev/null || echo "(LOG.md empty)"
Open tasks: !grep "^- \[ \]" .ai/TASKS.md 2>/dev/null | wc -l | tr -d ' '

## When to Run
- DIGEST is flagged as stale (> 3 days old, or last entry doesn't match recent changes)
- After a major sprint with many file changes
- After running `skill: ai-archive` (clean state needs new snapshot)
- After parallel critic review adds content to `REVIEWS.md`

## Preflight — Read Everything

1. Read `.ai/BRIEF.md` — product goals + constraints
2. Read `.ai/TASKS.md` — current open E-## and P-## tasks
3. Read `.ai/architect.md` (first 40 lines only) — architecture summary
4. Read `.ai/REVIEWS.md` (last 20 lines) — recent P0/P1 findings
5. Read `.ai/LOG.md` (last 30 lines) — recent changes
6. Read `.mcp.json` — active MCP servers

## Produce DIGEST.md

Keep it **20–60 lines. Bullets only. No prose.**

Required sections:
```markdown
# DIGEST — AI-OS v2 (Updated: YYYY-MM-DD)

## Product
- <one-line product description>

## Stack
- <one-line tech stack>

## Triad Health
- Architect: <status — last P-## task>
- Engineer: <status — last E-## task>
- Tester (headless, skill: ai-test): <status — last test run>

## Current Focus
- <top 3 open E-## tasks with status>

## Key Decisions
- <D-### or recent decisions with status>

## Known Risks
- <P0 items from REVIEWS.md or THREAT_MODEL.md>

## MCP Servers
- <active servers from .mcp.json>

## Recent Changes (last 10)
- YYYY-MM-DD: <what> (<file>)
```

## After Writing
Append to `.ai/LOG.md`:
```
YYYY-MM-DD | <actor> (ai-digest) | Write | .ai/DIGEST.md regenerated
```
