# Blueprint: May 2026 API Upgrades

## Goal & Architecture
To upgrade the AI-OS v2 Triad to leverage the latest May 2026 capabilities from Anthropic and Google, specifically migrating to `gemini-3.1-pro`, introducing Multimodal RAG to the Memory Palace, and preparing a spike for Claude Managed Agents to offload state orchestration.

## Core Concept
A multi-domain upgrade focusing on:
1. **Model Fleet Upgrade:** Ensuring all Gemini references point to `gemini-3.1-pro` before the June 1 shutdown of the 2.0 series, and adapting to the new Interactions API schema.
2. **Visual Memory (Multimodal RAG):** Expanding the Memory Palace from text-only indexing to multimodal ingestion (images, PDFs) utilizing Gemini Embedding 2 with metadata filtering.
3. **Agent Harvesting (Managed Agents):** Evaluating the offloading of local orchestrator loops (like `task-synchronizer-mcp`) to Claude's native Managed Agents framework.

## Components
1. **Model Router (`registry.json` & `bin/ai`)**
   - **Responsibility:** Bootstraps the environment variables and default model strings for both Claude and Gemini. Must update to `gemini-3.1-pro`.
   - **Responsibility:** Adapts any raw API payload construction from `outputs` array to `steps` array to prevent May 20 breakage.
2. **Multimodal Memory Curator (`memory_curator` agent)**
   - **Responsibility:** Scans not just `DIGEST.md` but also local UI mockups and architecture diagrams (PNG/SVG/PDF). Attaches `department: Architecture` or `department: UX` metadata to embeddings.
3. **Managed Agents Integration Spike (`src/mcp/orchestrator-mcp`)**
   - **Responsibility:** A Tier 3 architectural spike to determine if local SQLite state can be synchronized natively with Claude's built-in filesystem memory and webhook lifecycle events (`managed-agents-2026-04-01`).

## Data Model
```json
// Multimodal RAG Payload Example
{
  "file_uri": "gs://...",
  "metadata": {
    "department": "UX",
    "project": "AI-OS v2"
  }
}

// Interactions API Update (Effective May 20)
{
  "steps": [
    { "role": "user", "parts": [...] },
    { "role": "model", "parts": [...] }
  ]
}
```

## API / Interface Contracts
- `knowledge_architect`: 
  - **Inputs:** Natural language queries.
  - **Outputs:** Text summaries combined with relevant page-level citations from ingested PDFs and retrieved visual diagrams.
- `Gemini Interactions API`:
  - **Contract Update:** All payload builders in `bin/ai` or custom scripts must shift from `{"outputs": []}` to `{"steps": []}`.

## Security
- **Trust Boundaries:** Managed Agents execute in Anthropic's cloud. We must ensure local `.ai/` files containing secrets (if any exist) are NEVER synced to Claude's native filesystem memory without explicit sanitization.
- **Threat Surface:** Multimodal RAG could ingest sensitive images (e.g., screenshots containing API keys). `memory_curator` must exclude any images found in `.env` directories or flagged as sensitive.

## Execution Constraints
- **Performance:** Multimodal embedding generation is slower than text. The Memory Palace indexer should run in the background (e.g., via a post-commit hook or explicit `ai sync` command) rather than synchronously on every `ai init`.
- **Resource Bounds:** Limit visual ingestion to diagrams under 5MB to prevent API timeout.

## Rollback Plan
- If `gemini-3.1-pro` exhibits prompt drift, rollback to `gemini-2.5-pro` (assuming availability) via environment variable override.
- If Multimodal RAG breaks existing memory recall, disable image parsing in `memory_curator` config.
- If the Managed Agents spike proves insecure or brittle, abandon the integration and maintain our local `task-synchronizer-mcp` + SQLite architecture.

## E-## Task Breakdown
- **E-45:** Update `registry.json`, `bin/ai`, and `GEMINI.md` to mandate `gemini-3.1-pro` and refactor API interactions from `outputs` to `steps` per `may-2026-upgrades.md`. | Tier: 1
- **E-46:** Upgrade `memory_curator` and `knowledge_architect` agents to support image ingestion and metadata filtering via Gemini Embedding 2 per `may-2026-upgrades.md`. | Tier: 2
- **E-47:** Create an architectural spike script (`tests/managed_agents_spike.js`) to test the feasibility of offloading state tracking to Claude's `managed-agents-2026-04-01` API per `may-2026-upgrades.md`. | Tier: 3