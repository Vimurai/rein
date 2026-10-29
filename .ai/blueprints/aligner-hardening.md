# Blueprint: Aligner Hardening Phase 2

## Goal & Architecture
To eliminate the recurring `ALIGN_FAIL` false-positive class (markdown/JSON prose matches and test-helper sibling imports) in the `blueprint-aligner-mcp` Context Engine.

## Core Concept
The aligner currently uses naive regex matching (e.g., `../` for path traversal). Phase 2 introduces contextual introspection to ignore matches inside markdown prose, JSON values, and designated test directories.

## Components
1. **Markdown Introspector**: Filters out matches that occur within markdown code blocks or inline backticks.
2. **JSON Introspector**: Ignores string-literal matches in `state.json` keys or values that do not represent code dependencies.
3. **Test Path Excluder**: Whitelists `../` and similar test-helper imports specifically when the file path matches `tests/suites/*.sh` or `tests/lib/*.sh`.

## Data Model
- `AlignerFinding`: `{ filePath, lineNumber, lineContent, isFalsePositive: boolean }`
- Contextual parser state: tracks whether the current line is inside a JSON block or markdown code block.

## API / Interface Contracts
- Extends the existing `blueprint-aligner-mcp` evaluate logic.
- Input: `git diff --staged` or specific file path.
- Output: Same aligner report, but with noise filtered out.

## Security
- **Risk**: Over-filtering might allow real path traversals or orphaned work to slip through.
- **Mitigation**: Whitelists must be strictly scoped (e.g., only `tests/` directory for sibling imports). Default behavior must remain fail-closed (flag as warning/failure if uncertain).

## Execution Constraints
- Must run quickly over large diffs. Avoid full AST parsing; use robust regex state machines.

## Rollback Plan
- Revert `src/mcp/blueprint-aligner-mcp/index.js` to the Phase 1 regex logic.

## E-## Task Breakdown
- E-55: Implement Markdown and JSON prose introspection in `blueprint-aligner-mcp` to filter false positives.
- E-56: Implement the `TestPathExcluder` whitelist rule for `tests/` sibling imports.