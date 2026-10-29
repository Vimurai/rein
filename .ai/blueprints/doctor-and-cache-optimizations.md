# Domain Blueprint: Doctor and Cache Optimizations

## Goal & Architecture
**Goal:** Enhance the system diagnostic utility (`ai doctor`) to perform deep environmental and connection checks, and optimize the Context Cache to prune redundant token overhead.
**Architecture:** Implements Node.js filesystem and process checks inside the bootloader (`src/bin/ai`) and the `cache-manager-mcp` server.

## Core Concept
1. **Deep Environment Check (`ai doctor --env`)**:
   - Verify Docker socket permissions and container startup capability.
   - Verify Node version (22+) and essential global binaries (`gh`, `git`, `tmux`).
   - Spawn-check all 25 MCP servers defined in the active `mcp_config.json` to verify they start without throwing stdout errors or immediate exits.
   - Validate read/write permission bits on `~/.ai-os/` and `.ai/` files.
2. **Context Cache Compaction**:
   - Introduce a token-size threshold check. If the compiled cache exceeds `5,000` characters/tokens, prune done tasks older than 7 days, maintaining a clean hot path.

## Components
1. **Diagnostic Runner (`src/bin/ai` --env)**: Spawns validation probes for environment libraries, permissions, and Docker.
2. **MCP Connection Tester (`src/shared/mcp-tester.mjs`)**: Programmatically launches each registered MCP server in stdio mode, sends a basic `tools/list` handshake, and reports any failures.
3. **Cache Compactor (`src/mcp/cache-manager-mcp/index.js`)**: Prunes old history from the compiled context database if it exceeds the token limit.

## Data Model
No schema changes. The cache table in `state.sqlite` already supports arbitrary text blobs.

## API / Interface Contracts
- `ai doctor --env` will print a clean check-list:
  ```
  [OK] node version (v22.2.0)
  [OK] docker execution (sandbox active)
  [OK] state database write access
  [FAIL] ast-parser-mcp failed to boot (missing tree-sitter-wasms hoisting)
  ```
- Exits 1 if any critical checks (like database access or script paths) fail.

## Security
- All spawned diagnostic subprocesses must be launched with restricted env variables to prevent token exposure.
- `mcp-tester` must only invoke standard `tools/list` checks and never call execution tools.

## Execution Constraints
- Diagnostic suite must complete in `< 2.0s` overall when running all checks.

## Rollback Plan
- Revert modifications to `src/bin/ai` and `cache-manager-mcp`.

## E-## Task Breakdown
- **E-175**: Implement deep environment and permission validation in `src/bin/ai doctor --env`, checking Node version, global binaries, and directory read/write bits. | Tier: 2
- **E-176**: Implement the MCP Connection Tester (`src/shared/mcp-tester.mjs`) to spawn each registered MCP server, test `tools/list` connectivity, and integrate it into `ai doctor`. | Tier: 2
- **E-177**: Refactor the context cache assembler in `cache-manager-mcp` to automatically compact/prune done task records older than 7 days when the total character count exceeds `20,000` characters. | Tier: 2
