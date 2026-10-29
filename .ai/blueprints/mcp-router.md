# MCP Router/Proxy (mcp-router)

## Goal & Architecture
Solve context window saturation ("prompt bloat") caused by loading 23+ MCP tool schemas into the LLM on every turn. The router acts as a dynamic gateway that only exposes the tools relevant to the agent's current Intent or domain.

## Core Concept
Instead of connecting Claude/Gemini directly to all 21 MCP servers via `registry.json`, the agents connect to ONE master `mcp-router`. The router implements Progressive Discovery: it first exposes only high-level "intent" tools, and based on the agent's selection, dynamically injects the specific tool schemas for that domain.

## Components
1. **Router Core**: The primary MCP server that acts as a proxy for the LLM.
2. **Domain Switcher**: A tool (`switch_domain(domain: string)`) that updates the active session state.
3. **Proxy Tunnel**: Transparently forwards JSON-RPC calls from the LLM to the underlying, dynamically-loaded MCP servers.

## Data Model
- **Domain Registry**: A mapping of intents to servers (e.g., `Domain: Code` -> `filesystem`, `lsp-mcp`, `patch-mcp`).
- **Session State**: In-memory map of `SessionID -> ActiveDomain`.

## API / Interface Contracts
- `list_domains()`: Returns available categories (State, Code, Safety, Intelligence, Quality).
- `activate_domain(domain)`: Unloads current tool schemas and loads the schemas for the requested domain.
- (All other proxy calls are forwarded).

## Security
- The router must enforce the same Role-Based Access Control (RBAC) defined in `registry.json` per agent persona. It cannot bypass `.claude/settings.json` permissions.

## Execution Constraints
- Introduces an extra hop (latency) for all JSON-RPC calls. Performance profiling is required to ensure standard deviation stays under 50ms overhead.

## Rollback Plan
- Revert `.mcp.json` to directly list all individual MCP servers, bypassing the router proxy.

## E-## Task Breakdown
- E-## (Claude): Implement MCP Router/Proxy server and dynamically load tool schemas.