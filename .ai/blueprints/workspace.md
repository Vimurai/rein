# Workspace & Monorepo Blueprint

> [!IMPORTANT]
> This document specifies the monorepo structure and dependency management for AI-OS v2. It resolves the fragmentation risk of maintaining 16 independent MCP servers.

## 1. Goal & Architecture
To eliminate duplication in `node_modules` across `src/mcp/*` directories, AI-OS employs an npm/pnpm workspace at the root directory. This unifies all dependencies while keeping the runtime isolated per MCP server.

## 2. Root Structure
A single `package.json` must be introduced at the project root (`<workspace>/ai-os-v2/package.json`).

```json
{
  "name": "ai-os-v2",
  "private": true,
  "workspaces": [
    "src/mcp/*"
  ],
  "scripts": {
    "lint": "eslint .",
    "test": "npm run test --workspaces"
  }
}
```

## 3. Shared Dependencies
The following dependencies should be hoisted to the root or shared cleanly across all MCP projects to prevent version mismatch and bloat:
- `@modelcontextprotocol/sdk`
- `zod`
- Linter and formatting configs (e.g. `eslint`, `prettier`)

## 4. Execution Constraints
Each MCP server must still be capable of booting independently from its `src/mcp/<server>/index.js` file, ensuring that the monorepo tooling does not introduce coupling at the runtime layer.

## 5. Security & Isolation
Workspaces MUST NOT expose cross-MCP secrets. Each MCP server runs in an isolated process group managed by AI-OS, preventing a compromised MCP server from exploiting sibling packages.
