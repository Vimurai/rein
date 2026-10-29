# Blueprint: 2026 Workflow Optimizations

## Goal & Architecture
To elevate AI-OS v2 to the 2026 "Spec-Driven Hybrid Workflow" standard by introducing native Task Budgets to break infinite implementation loops, upgrading static security scans to Active Sandbox Pen-Testing, and resolving recurring `ALIGN_FAIL` false positives to eliminate commit friction.

## Core Concept
A multi-layered optimization of the AI-OS agentic workflow:
1. **Intelligent Blueprint Alignment:** The `blueprint-aligner-mcp` is refined to understand context (canonical Node ESM sibling imports) and authorship (Agy vs. Claude edits to core `.ai/` files).
2. **Task Budgets:** The `ai-debug` skill and Claude's capabilities are augmented with strict iteration caps to prevent run-away token burn, forcing an escalation via `advisor-mcp` after 3 failed attempts.
3. **Active Sandbox Pen-Testing (`@shannon` pattern):** The `security_engineer` agent is upgraded to leverage `code-execution-mcp` to run live exploit scripts against newly implemented logic, shifting from passive diff-scanning to active vulnerability validation.

## Components
1. **Aligner Context Engine (`blueprint-aligner-mcp`)**
   - **Responsibility:** Parses source code and `architect.md` edits to distinguish between malicious path traversal (`../`) and legitimate ESM imports (`import ... from "../"`). Evaluates commit context to authorize Gemini-owned documentation updates performed by Claude.
2. **Budget Monitor (`ai-debug` skill & `capabilities.md`)**
   - **Responsibility:** Injects a strict iteration limit (e.g., 3 attempts) into the debugging and implementation loops. If the budget is exhausted, it halts execution and formats an A2A (`advisor-mcp`) query to the Architect.
3. **Active Pen-Tester (`security_engineer` agent & `agents.md`)**
   - **Responsibility:** Autonomously generates and executes Python/Bash exploit payloads within the isolated `code-execution-mcp` Docker sandbox to probe for OWASP Top 10 vulnerabilities in the current PR/diff.

## Data Model
```json
// Task Budget State Extension (in local session memory)
{
  "task_id": "E-42",
  "iterations": 3,
  "status": "BUDGET_EXHAUSTED",
  "escalation_required": true
}

// Aligner Whitelist Rule
{
  "type": "regex",
  "pattern": "import.*from\\s+[\"']\\.\\./.*[\"']",
  "action": "ALLOW"
}
```

## API / Interface Contracts
- `blueprint-aligner-mcp.align_diff(diff, architect_content)`:
  - **Input:** Standard diff + context.
  - **Output:** Returns `PASS` or `FAIL`. Will now return `PASS` if the only `../` matches are within standard ES module import statements.
- `ai-debug` Skill:
  - **Input:** Failing test output.
  - **Execution Limit:** 3 internal loop iterations.
  - **Fallback:** Calls `ask_architect` via `advisor-mcp`.
- `security_engineer` Agent:
  - **Interface:** Calls `code-execution-mcp.execute_code({ language: "python", code: "<exploit_script>" })`.

## Security
- **Trust Boundaries:** The Active Pen-Tester must ONLY execute payloads within the existing `code-execution-mcp` fail-closed Docker sandbox (no network, cap-drop=ALL). It must never execute exploits directly on the host OS.
- **Threat Surface:** Exploit scripts could attempt to escape the sandbox. Rely on the D-008 fail-closed boundary. Aligner whitelist regexes must be strictly bounded to prevent actual path traversal bypasses.

## Execution Constraints
- **Performance:** Aligner regex updates must run in O(N) time to prevent ReDoS on large diffs.
- **Concurrency:** Pen-testing scripts run sequentially per endpoint/feature to avoid overwhelming the 512MB sandbox memory limit.
- **Resource Bounds:** Task Budgets explicitly bound token consumption per implementation sub-task.

## Rollback Plan
- If the new Aligner rules mask real security threats, revert the `blueprint-aligner-mcp` regexes to the previous strict literals.
- If the Active Pen-Tester causes sandbox instability, revert the `security_engineer` agent prompt to static diff analysis only.
- If Task Budgets cause premature halting of complex tasks, increase the iteration limit to 5 via `.claude/settings.json` environment variables.

## E-## Task Breakdown
- **E-42:** Update `blueprint-aligner-mcp` to whitelist `import ... from "../"` ESM patterns and support UACS stamp/authorship checks for `architect.md` edits per `workflow-optimizations.md`. | Tier: 2
- **E-43:** Update `ai-debug` skill to enforce a 3-iteration `TASK_BUDGET` and wire the `advisor-mcp` escalation path per `workflow-optimizations.md`. | Tier: 2
- **E-44:** Upgrade `security_engineer` agent prompt and allowed-tools in `agents.md` to utilize `code-execution-mcp` for active exploit payload testing per `workflow-optimizations.md`. | Tier: 3