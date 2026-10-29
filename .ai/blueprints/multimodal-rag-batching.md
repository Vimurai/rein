---
type: blueprint
tier: 2
tags: [architecture, multimodal, rag, performance]
status: DRAFT
---

# Blueprint: Multimodal RAG Batching Queue

## Goal & Architecture
To safely scale the `memory_curator` agent to handle high-volume Multimodal RAG ingestion by introducing a parallel batch-embedding queue. This mitigates Gemini Embedding 2 API rate limits (429s) and prevents the indexer from stalling on large UI design repositories.

## Core Concept
Replacing the fragile serial request loop with a bounded concurrency worker pool. The indexer will utilize an exponential backoff strategy for API limits and maintain a persistent Dead-Letter Queue (DLQ) so failed file ingestions can be automatically retried during the next background `ai sync`.

## Components
1. **Batch Scanner:** A filesystem traverser that identifies eligible media (PNG/SVG/PDF) and computes SHA-256 hashes to skip unchanged files already present in the Memory Palace.
2. **Bounded Worker Pool:** A dispatcher using a concurrency limit (e.g., `p-limit` or a native chunking loop) that ensures no more than N (default 3) embedding requests are in-flight simultaneously.
3. **Dead-Letter Queue (DLQ):** A local JSON file (`.ai/memory/dlq.json`) that logs files failing ingestion (e.g., due to 5xx or unrecoverable 429s) so they aren't lost and can be retried.

## Data Model
```json
// DLQ Schema (.ai/memory/dlq.json)
{
  "failed_jobs": [
    {
      "file_path": "src/assets/hero-bg.png",
      "last_error": "429 Too Many Requests",
      "retry_count": 2,
      "last_attempt": "2026-05-18T10:00:00Z"
    }
  ]
}
```

## API / Interface Contracts
- **`scan_workspace(project_root)`**: Returns an array of un-indexed or modified file paths.
- **`process_batch(files, concurrency_limit)`**: Executes the embedding calls, returning `{ successes: [...], failures: [...] }`.
- **`flush_dlq()`**: Attempts to re-ingest the `failed_jobs` before processing new files.

## Security
- **Data Exclusion:** The Batch Scanner MUST strictly enforce `.gitignore` rules and explicitly ignore any `.env` directories or files flagged with a `[NO_RAG]` comment/tag to prevent leaking credentials hidden in screenshots.
- **Resource Exhaustion:** Maximum file size cap of 5MB per media file is enforced before attempting an embedding API call.

## Execution Constraints
- **Concurrency Bounds:** The default concurrency limit is 3. This can be overridden via `AI_EMBEDDING_CONCURRENCY` env var.
- **Backoff Strategy:** Minimum wait time of 1000ms after a 429 response, increasing exponentially up to 15000ms before moving the job to the DLQ.

## Rollback Plan
- Set `AI_RAG_MODE=text-only` to disable multimodal parsing completely.
- If the worker pool causes memory leaks, revert `memory_curator` back to the serial processing model by setting `AI_EMBEDDING_CONCURRENCY=1`.

## E-## Task Breakdown
- **E-74:** Implement the Batch Scanner with SHA-256 caching and `.gitignore` / `[NO_RAG]` exclusion rules in the `memory_curator` agent per `.ai/blueprints/multimodal-rag-batching.md`. | Tier: 2
- **E-75:** Build the Bounded Worker Pool with exponential backoff and Dead-Letter Queue (DLQ) tracking in `.ai/memory/dlq.json` per `.ai/blueprints/multimodal-rag-batching.md`. | Tier: 2