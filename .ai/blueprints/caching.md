# Domain Blueprint: API Optimizations & Caching

> [!IMPORTANT]
> This document specifies the implementation of API-level Explicit Context Caching (Prompt Caching) to eliminate token-burn while maintaining full architectural awareness.

## 1. Goal & Architecture
To reduce the latency and token cost of JIT (Just-In-Time) blueprint loading, AI-OS v2 leverages the native Prompt Caching features of the 2026 Claude and Gemini APIs. This guarantees that the Triad operates with 100% systemic context without incurring massive per-turn input costs.

## 2. The Cache Payload
The following core files represent the "System State" and must be permanently cached at the API layer:
- `.ai/architect.md` (The index)
- `.ai/blueprints/*.md` (All domain blueprints)
- The raw SQL schema of `.ai/state.sqlite`
- `config/registry.json` (The MCP tool registry)

## 3. Implementation Mechanism (`token-budget-mcp` extension)
The caching mechanism will be managed by an extended `token-budget-mcp` (or a dedicated `cache-manager-mcp`).

### Workflow:
1. **Cache Generation**: When an Architect (Agy) modifies a blueprint, a post-write hook triggers the cache manager to construct a single aggregated "System Context" string.
2. **API Registration**: The cache manager submits this payload to the respective API (e.g., Anthropic's Prompt Caching API) and receives a `cache_id` or relies on deterministic prefix caching.
3. **Agent Invocation**: When Claude or Gemini is invoked, the `system_prompt` must include the cached prefix block.
4. **Invalidation**: The cache is strictly invalidated and rebuilt ONLY when a file in `.ai/blueprints/` or `.ai/architect.md` is modified, matching the `mtime` of the files.

## 4. JIT Constraint Re-evaluation
Once Explicit Context Caching is implemented, the "6-File JIT Limit" defined in `architect.md` §33 applies ONLY to source code files (`src/`). The blueprints and state are exempt because they are loaded via the zero-cost cache layer.
