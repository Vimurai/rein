# Blueprint: System Hardening Phase 3 (May 2026)

## Goal & Architecture
Address critical structural and security flaws identified in the May 17, 2026 system audit. This blueprint resolves the compliance gate "Ghost Tool" failure, mitigates the fail-open SQLite WAL bloat risk by hardening environment checks, finalizes the Managed Agents production wiring, and fleshes out the skeletal `BRIEF.md` for better JIT framing.

## Core Concept
Strengthen the resilience of the Triad (Architect, Engineer, QA) by closing environment loop-holes, strict tool aliasing validation at the registry level, and safely connecting offline managed-agent spikes to production endpoints.

## Components
1. **Tool Alias Normalizer (`verification-mcp`)**: A pre-processing step in the `verify_compliance` tool that maps common shell aliases (like `Bash`) to their canonical built-in registry names (e.g., `run_shell_command`).
2. **Hardened Pre-flight Installer (`install-ai-os.sh`)**: Enforces a strict fail-closed check for Node.js (v22+) during the bootloader installation sequence, ensuring `wal-flusher.mjs` and `generate_mcp_docs.mjs` never fail silently on degraded systems.
3. **Managed Agents Production Connector**: Wires the offline `managed-agents-spike` (E-47) into the live API. Implements a feature flag (`AI_MANAGED_AGENTS_ENABLE`), provisions secure API key injection, and updates payloads to the `steps` API schema.
4. **Enhanced Product Brief (`BRIEF.md`)**: Replaces the skeletal template with a comprehensive 20-line product vision, removing the Architect's over-reliance on reading the full `architect.md` during JIT `ai-preflight`.

## Data Model
- **Tool Mapping Schema (in `verification-mcp`)**: `{ "Bash": "run_shell_command", "Grep": "grep_search", "Read": "read_file" }`
- **Managed Agent Payload**: Converts from legacy `outputs` to `{ steps: [ { text: "...", tool_calls: [...] } ] }`.

## API / Interface Contracts
- `verify_compliance()`: Before throwing a `[CRITICAL]` Ghost Tool error, check the alias map.
- `install-ai-os.sh`: `command -v node || { echo "[ERROR] Node 22+ required"; exit 1; }`
- Managed Agents: HTTP POST to the managed agent endpoint with `Authorization: Bearer $AI_MANAGED_AGENT_KEY`.

## Security
- **Managed Agents API Key**: Must never be logged or persisted in `state.json`. Passed strictly via environment variable `$AI_MANAGED_AGENT_KEY`.
- **Node Fail-closed**: Prevents systems without Node from accumulating gigabytes of SQLite WAL bloat, protecting disk I/O and maintaining ACID bounds.

## Execution Constraints
- Tool mapping lookup in `verification-mcp` must add <5ms overhead.
- `install-ai-os.sh` checks must run before any files are copied or environment lines are appended.

## Rollback Plan
- If Tool Alias Normalizer causes false negatives, revert the regex checks and manually patch YAML frontmatters.
- If Managed Agents API fails, toggle `AI_MANAGED_AGENTS_ENABLE=0` to fallback to local state-only execution.

## E-## Task Breakdown
- **E-68**: Update `verification-mcp` to support tool name aliasing (e.g., `Bash` -> `run_shell_command`) to resolve the Ghost Tool compliance failure.
- **E-69**: Update `install-ai-os.sh` to enforce a strict `node` availability check (fail-closed) before installation.
- **E-70**: Implement Managed Agents live API wiring with `AI_MANAGED_AGENTS_ENABLE` feature flag and `steps` schema migration.
- **E-71**: Expand `.ai/BRIEF.md` from a template into a substantive product summary, reflecting the AI-OS autonomous agent triad framework.
