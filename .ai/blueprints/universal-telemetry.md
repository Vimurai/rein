# Blueprint: Universal Telemetry Instrumentation

## Goal & Architecture
**Goal**: Resolve "System Blindness" by ensuring 100% of tool invocations are recorded in `telemetry.sqlite`, regardless of whether they pass through the `mcp-router`.
**Architecture**: Shift primary instrumentation from the `mcp-router` (Internal Instrumentation) to the `post-tool-use.sh` hook (Global Edge Instrumentation).

## Core Concept
The "Second Brain" currently only sees tools routed via `proxy_call`. By moving instrumentation to the shell hook layer, we capture the "ground truth" of what the agent actually executes, including direct MCP calls and filesystem operations.

## Components
1. **`telemetry.mjs` CLI Upgrade**
   - Responsibility: Implement `--record-tool` and `--record-task` flags. The CLI must accept a JSON payload via `stdin`, derive the `project_hash` from the current working directory, and record the event asynchronously.
2. **Universal Hook Wrapper (`post-tool-use.sh`)**
   - Responsibility: Update the global hook (installed to `~/.ai-os/hooks/`) to pipe the tool execution JSON to `telemetry.mjs --record-tool`.
3. **Session ID Propagation**
   - Responsibility: Ensure `CLAUDE_CODE_SESSION_ID` is correctly captured from the environment in the hook layer to maintain session-linked task velocity metrics.

## Data Model
- **Input (Hook JSON)**: `{ tool_name, tool_input, tool_output, execution_time_ms, status }`.
- **Derivation Logic**: 
  - `project_root` = `git rev-parse --show-toplevel` or `pwd`.
  - `session_id` = `$CLAUDE_CODE_SESSION_ID`.

## API / Interface Contracts
- **`node telemetry.mjs --record-tool`**:
  - Reads JSON from `stdin`.
  - Derives metadata.
  - Returns `rc=0` (always fail-open).
- **`node telemetry.mjs --record-task`**:
  - Reads JSON from `stdin`.
  - Records task velocity metrics.

## Security
- **PII Stripping**: The CLI must sanitize the `tool_input` before deriving the project hash (already implemented in `telemetry.mjs`).
- **Fail-Open**: Telemetry recording must never block or crash the hook; use `2>/dev/null` and background execution where possible.

## Execution Constraints
- Hook overhead must remain `<50ms`.
- DB contention handled by `node:sqlite`'s internal locking (WAL mode).

## Rollback Plan
- Revert `~/.ai-os/hooks/post-tool-use.sh` to the previous version (AQG-only).
- If deduplication fails, selectively disable hook-level recording via environment variable.

## E-## Task Breakdown
- **E-104**: Implement `--record-tool` and `--record-task` CLI handlers in `src/shared/telemetry.mjs`.
- **E-105**: Update `hooks/post-tool-use.sh` to call `telemetry.mjs --record-tool` on every tool execution.
- **E-106**: Refactor telemetry instrumentation: retain `mcp-router` for granular `<server>.<tool>` data (as the hook only sees the coarse `proxy_call`), and implement deduplication in `telemetry.sqlite` (or the writer) to prevent double-counting of routed calls.
