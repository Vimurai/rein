---
name: arch-review
description: Use this skill when the user requests an architectural review, before a major commit, or when checking blueprint alignment. Audits the codebase against architect.md for orphaned work, deviations, and top architectural risks. (Renamed from ai-review to avoid colliding with the Engineer's tier-aware critic-review skill — E-149.)
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob
context: fork
agent: default
---

# Rein Review — Architectural Audit (Architect)

## Dynamic Context Injection
Recent changes: !git log --oneline -10 2>/dev/null || echo "(no git history)"
Open P-## tasks: !grep "^- \[ \] P-" .ai/TASKS.md 2>/dev/null || echo "(none)"
Last ARCH_AUDIT: !grep -m1 "\[ARCH_AUDIT\]" .ai/REVIEWS.md 2>/dev/null || echo "(none — first audit)"

## Preflight

1. Read `.ai/architect.md` — your blueprint (source of truth)
2. Read `.ai/DIGEST.md` — current project snapshot
3. Read `.ai/TASKS.md` — open P-## and E-## tasks
4. Scan `src/` directory structure (do NOT read individual files — structure only)

## Audit Checklist

### 1. Blueprint Alignment
For each implemented feature in `src/`, verify it has a corresponding section in `architect.md`:
- ✓ Covered by blueprint → ALIGNED
- ✗ Not mentioned in blueprint → ORPHANED (flag for Architect decision)
- ⚠ Mentioned but implementation contradicts blueprint → DEVIATED (flag as risk)

### 2. Coverage Gaps
Are any `architect.md` sections missing implementation entirely?
- Missing sections → flag as unblocked E-## candidates for the Engineer

### 3. Ambiguity Audit
Are any blueprint sections too vague to implement safely?
- "TBD" or open-ended descriptions → flag for clarification

### 4. Dependency & Security
- Are new dependencies in `package.json` covered by DECISIONS.md entries?
- Are any CAPABILITIES.md entries missing for new functionality?

### 5. Top 3 Architectural Risks
Identify the highest-impact risks based on current state.

## Audit Output

Output the full audit to the conversation in this format:

```markdown
## Architectural Audit — YYYY-MM-DD

### Alignment Summary
- ALIGNED: <N features>
- ORPHANED: <list if any>
- DEVIATED: <list if any>

### Coverage Gaps
- <missing implementations>

### Ambiguous Sections
- <unclear blueprint entries>

### Top 3 Architectural Risks
1. <risk> — <mitigation>
2. <risk> — <mitigation>
3. <risk> — <mitigation>

### Recommended P-## Tasks
- P-##: <what the Architect should blueprint next>
```

Then record the stamp via MCP — **do NOT write directly to `.ai/REVIEWS.md`** (it is a generated view, auto-overwritten by `writeState`):

```
mcp__task-synchronizer-mcp__add_stamp({
  type: "ARCH_AUDIT",
  agent: "architect",
  summary: "<one-line summary of overall finding>"
})
```

⚠️ **Domain Rule**: Do NOT write or modify `src/**`. Do NOT append directly to `.ai/REVIEWS.md`.
