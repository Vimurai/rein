# Bootloader Resilience & CI Strategy

> [!IMPORTANT]
> This document specifies the fallback mechanics, execution constraints, and CI validation strategy for the Bootloader layer (Section 30), guaranteeing SQLite state validity.

## 1. Bootloader Fallback Mechanism
The primary `orchestrator-mcp` connects to the `.ai/state.sqlite` database to manage ACID-compliant task and memory coordination. If this MCP server fails to boot (e.g. due to node execution errors, missing dependencies), the system must gracefully degrade to a secondary fallback script.

### Layered Degradation:
1. **Primary**: `orchestrator-mcp` (Node.js) via MCP STDIO.
2. **Secondary**: Local CLI execution fallback (e.g. `ai-exec` running directly on `.ai/state.json`).
3. **Emergency**: Shell-level `cat .ai/TASKS.md` with manual instructions to the LLM.

## 2. Execution Constraints (SQLite Validity)
When operating in Secondary or Emergency mode:
- Fallback tools (Python/Bash) MUST only execute read-only queries against `.ai/state.sqlite` to prevent transaction locks or data corruption when Node is struggling.
- If writing is strictly necessary, it MUST use `sqlite3` CLI with immediate `PRAGMA synchronous = FULL;` and `BEGIN EXCLUSIVE TRANSACTION;` to simulate ACID guarantees.
- `state.json` serves as a read-only mirror updated by hooks; fallback scripts should parse this JSON instead of risking DB corruption if possible.

## 3. CI Testing Strategy
`tests/suites/resilience_test.sh` must explicitly cover:
- **Simulated Node Failure**: Rename or chmod `orchestrator-mcp/index.js` to simulate a crash.
- **Fallback Verification**: Assert that JIT read requests successfully fallback to `ai-exec` or shell `cat`.
- **State Check**: Ensure that after a simulated crash and recovery sequence, the `.ai/state.json` and SQLite database match with 0 corruption errors (using `PRAGMA integrity_check;`).
