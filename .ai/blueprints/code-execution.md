# Sandboxed Code Execution MCP (code-execution-mcp)

## Goal & Architecture
Provide the Triad (Engineer) with a secure, ephemeral execution environment (REPL) for Python and TypeScript scripts. This prevents context bloat from massive tool schemas and allows the agent to iteratively process data, run math, or parse structures before returning the final summary to the context window.

## Core Concept
A new MCP server (`code-execution-mcp`) that spins up a sandboxed Docker container or WASM runtime per session. It exposes an `execute_code` tool that accepts code strings, runs them, and returns stdout/stderr, replacing the need for unsafe bare metal `run_shell_command` usage for logic.

## Components
1. **Execution Engine**: The sandbox boundary (Docker container with network=none, read-only, cap-drop=ALL).
2. **Language Runtime**: Ephemeral Python 3.12-slim and node:22-alpine environments. No heavy pre-installed data processing libraries; standard library only unless manually provided via script setup.
3. **Dispatcher**: The MCP tool interface (`execute_code`) that routes the payload, captures output, and imposes timeouts.

## Data Model
- **Request**: `{ "language": "python|typescript", "code": "print('hello')", "timeout_ms": 5000 }`
- **Response**: `{ "stdout": "hello\n", "stderr": "", "exit_code": 0, "execution_time_ms": 120 }`

## API / Interface Contracts
- `execute_code(language, code, timeout_ms)`: Runs the script and returns the result. Limits output to max 4096 chars per stream to prevent buffer overflows.

## Security
- **Network Isolation**: The sandbox MUST NOT have outbound internet access.
- **Host Isolation**: No host filesystem mounts allowed. The environment is entirely ephemeral.
- **Resource Quotas**: Hard limit of 512MB RAM and 5000ms timeout per execution.

## Execution Constraints
- Fails closed with `[SANDBOX_UNAVAILABLE]` when Docker is not running.

## Rollback Plan
- If `code-execution-mcp` fails or crashes the system, remove it from `registry.json` and `.mcp.json`, and the Engineer falls back to standard shell tools.

## E-## Task Breakdown
- E-## (Claude): Implement Sandboxed Code Execution MCP server and tests.