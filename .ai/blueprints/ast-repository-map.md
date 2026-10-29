# AST Repository Map (Context Compression)

## Goal & Architecture
This blueprint defines the integration of an AST-based Repository Map (inspired by Aider) into the AI-OS framework. The goal is to provide Claude and Agy with a highly compressed, token-efficient view of the entire codebase's architecture (files, classes, function signatures) without the overhead of full file reads or blind `grep` searches. This solves the problem of context window exhaustion in large repositories while improving architectural awareness.

## Core Concept
The system uses Tree-sitter to parse source files and extract structural signatures. It constructs a dependency graph to rank files and symbols by importance (e.g., using a PageRank-style algorithm or simple import counting). Finally, it serializes the top N ranked signatures into a concise `REPO_MAP.md` that is injected into the session context via the `cache-manager-mcp` or read on demand by the `token-miser` skill.

## Components
1. **`ast-parser-mcp` (New Server):** An MCP server encapsulating Tree-sitter language bindings (e.g., JS/TS, Python). It is responsible for parsing raw file contents and emitting structured symbol data (classes, methods, exports, imports).
2. **`repo-mapper` (Core Service):** A Node.js background service that orchestrates the AST parser across the workspace. It builds the dependency graph, scores node centrality, and applies a token budget cap to select the most relevant signatures.
3. **Context Injector (Update):** An update to the `cache-manager-mcp` or `orchestrator-mcp` to append the generated `REPO_MAP.md` content into the preflight read order, ensuring agents possess immediate architectural context upon session start.

## Data Model
**Extracted Symbol Schema:**
```json
{
  "file_path": "src/mcp/router/index.js",
  "exports": ["routeRequest", "registerServer"],
  "classes": [
    {
      "name": "Router",
      "methods": [
        { "name": "dispatch", "signature": "dispatch(request, timeoutMs)" }
      ]
    }
  ],
  "imports": ["fs", "path", "../config/registry.json"],
  "centrality_score": 0.85
}
```

## API / Interface Contracts
- **`mcp_ast-parser_parse_workspace`:** Scans the `dir_path`, applies ignore rules (respecting `.gitignore` and `.ai-osignore`), and returns a ranked JSON array of workspace symbols.
- **`mcp_ast-parser_generate_map`:** Calls `parse_workspace`, serializes the output into a markdown skeleton representation (e.g., showing `⋮` for elided function bodies), and writes it to `.ai/REPO_MAP.md`. Accepts a `max_tokens` argument.

## Security
- **Path Traversal & Secrets:** The parser MUST strictly respect `.gitignore` and `.env*` ignore rules to prevent parsing and indexing secret files or large node_modules directories. The `repo-mapper` component must only operate within allowed workspace boundaries enforced by `context-guardian-mcp`.
- **Denial of Service (Parsing):** Tree-sitter parsing can be CPU intensive. The parsing process must be bounded by a timeout per file (e.g., 500ms) and skip minified or abnormally large files (>1MB) to prevent parser hangs.

## Execution Constraints
- **Token Budget:** The generated `REPO_MAP.md` must strictly adhere to a configurable token limit (default: 2048 tokens). The ranking algorithm must aggressively trim low-scoring nodes to fit this constraint.
- **Background Execution:** Full workspace parsing should run asynchronously during `ai sync` or in the background to avoid blocking the synchronous `ai init` or preflight loops.

## Rollback Plan
- **Map Deletion:** If the generated map causes context confusion or exceeds token limits, delete `.ai/REPO_MAP.md` and disable the `repo-mapper` invocation from the `ai sync` lifecycle hook via an environment variable (`AI_OS_DISABLE_REPO_MAP=1`).
- **Revert to Search:** Agents fall back to standard `grep_search` and `list_directory` strategies if the AST map is unavailable.

## E-## Task Breakdown
- `E-210`: Create `ast-parser-mcp` using Node.js Tree-sitter bindings for TS/JS, implementing `parse_workspace` API.
- `E-211`: Implement the dependency graph and ranking algorithm within the `repo-mapper` service to score symbol importance.
- `E-212`: Implement `generate_map` API to serialize ranked symbols into `.ai/REPO_MAP.md` within a strict token budget.
- `E-213`: Wire the `repo-mapper` execution into the `ai sync` lifecycle and update `ai-preflight` to load `REPO_MAP.md` if available.
