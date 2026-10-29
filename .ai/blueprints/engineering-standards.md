# Domain Blueprint: Engineering Standards

> [!IMPORTANT]
> Proactive architectural enforcement of clean code, reusability, and maintainability in the AI-OS codebase.

## Goal & Architecture
Establish an automated quality-control layer that prevents "architectural drift" and sub-standard code, ensuring all engineering work follows strict reuse and cleanliness principles.

## Core Concept
- **Architectural Friction**: Introducing automated gates in the commit pipeline (CI/pre-commit) that demand structural compliance before code is accepted.
- **Delegated Architecture**: Mandatory reuse of `src/shared/` components for common logic.

## Components
1. **Standards-Checker**: CLI tool (`node scripts/standards.mjs`) that parses `standards.json` and validates staged changes.
2. **Critic-Clean-Code**: An agent persona specialized in heuristic-based code structure analysis (heavier than linter, lighter than manual review).
3. **Standards-Registry**: `src/shared/standards.json` defining the formal rules (complexity thresholds, naming patterns, file-size limits).

## Data Model
- `StandardRule`: `{ rule_id, severity, threshold, description, auto_fix_available }`.
- `ComplianceReport`: `{ file_path, status, violated_rules: [] }`.

## API / Interface Contracts
- `validateStandards(diff_path: string) -> ComplianceReport`: Invoked by pre-commit hook.
- `reportDrift(report: ComplianceReport)`: Emits structured warnings to `ai-review` synthesizers.

## Security
- **Trust Boundaries**: The `standards-checker` only introspects code structure; it MUST NOT evaluate business logic or secrets.
- **Integrity**: `standards.json` is immutable without a Tier 3 Architect ruling.

## Execution Constraints
- **Performance**: Standard validation must complete in < 200ms per commit.
- **Concurrency**: Standards checker runs in parallel with existing linting/test gates.

## Rollback Plan
- Disable the pre-commit hook via `hooks/pre-commit.sh` (flag `AI_OS_SKIP_STANDARDS=1`).
- Revert the `registry.json` change that registers the new `critic_clean_code` agent.

## E-## Task Breakdown
- E-83: Create `src/shared/standards.json` and implement the `standards-checker` CLI utility.
- E-84: Develop the `critic_clean_code` persona and integrate it into the `ai-review` flow.
- E-85: Update `hooks/pre-commit.sh` to enforce the new standards gate.

## Subshell State (D-064 §2, 2026-09-10) — review question #4
Three incidents in two sprints had the same shape: a helper was called as `$(helper …)` and the state it set evaporated with the subshell (a baseline cache, the cleanup registry, an output-capture stamp). Rule: a shell helper returns DATA on stdout **or** sets STATE in the caller's shell — never both. A helper that must set state is invoked as a plain command and hands data back via `printf -v` or a nameref, or the caller recomputes the state from the returned data. Write the reason at the site. Standing review question #4 (`critic_tests`, `ai-review`, `ai-debug`): "Is this helper ever called inside a command substitution, a pipeline, or a `while read` loop, and does it set state that must outlive that call?" No mechanical lint is funded (the pattern is too idiomatic to grade without over-blocks — D-056 R3); revisit on a fourth incident.


## `validateFile` Is the Only Public Entry (D-071 §5, 2026-09-13)
E-250 moved marker suppression and by-name exemption OUT of the rule handlers and INTO
`validateFile`, applied after a rule has produced its finding — that ordering is the whole
mechanism, because a marker consumed inside a handler leaves nothing to count (D-065). The
consequence is a sharp edge: `RULE_REGISTRY` handlers now return RAW findings, so a caller that
invokes one directly sees findings the shipped gate does not. `leaked_state_test` E-241.04a hit
this on the day E-250 shipped — it called a handler with a fabricated `{rule_id}` literal, lost
both the suppression and the `suppression_aliases`, and went red against a repo the real checker
calls clean. Rule: every production caller and every test that asserts "clean" or a finding
count goes through `validateFile`; a handler may be invoked directly ONLY in that rule's own unit
test, on a marker-free fixture, to test detection. Suppression is never re-added inside a
handler — two places to apply it is two places to count, which is how the D-065 defect returns.

## Suppressions and Exemptions (D-065, 2026-09-10)
A false positive is silenced by an explicit, greppable marker — `# standards:allow-<rule_id>` on the flagged line or the line above — never by loosening the rule's pattern (a loosened pattern silently reduces coverage everywhere). A file that legitimately falls outside a rule is exempted BY NAME in `standards.json` next to the rule, with a one-line reason — never by narrowing the rule's scope (which drops files that should stay covered). The checker summary reports active suppressions per rule so a growing count is itself visible. **Fixture-first for gate code**: standards rules, hooks and harness primitives are written with the failing fixture before the implementation, and the fixture runs on both bash 3.2 and CI's shell before the rule is called green — the review question for gate code is "which fixture would have caught this?".
