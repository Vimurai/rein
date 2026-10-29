---
type: blueprint
tier: 2
tags: [architecture, state-management, managed-agents]
status: DRAFT
---

# Blueprint: Managed Agents State Reconciliation

## Goal & Architecture
To establish a definitive reconciliation protocol between the local ACID SQLite store (`task-synchronizer-mcp`) and Claude's Managed Agents cloud memory. This prevents split-brain state drift when the feature-flagged Managed Agents client is enabled.

## Core Concept
A unidirectional sync model where the local `.ai/state.sqlite` remains the absolute, irrefutable source of truth. Managed Agents cloud memory is treated strictly as an ephemeral, read-only projection of the local state. All task mutations must be routed through the local `task-synchronizer-mcp`, which then broadcasts updates to the cloud.

## Components
1. **State Projector:** A helper module that reads the current open and blocked tasks from `.ai/state.sqlite` and formats a lightweight JSON snapshot (stripping out detailed logs or reviews to save bandwidth).
2. **Managed Agents Sync Hook:** A non-blocking asynchronous dispatcher in `src/shared/managed-agents-client.mjs` that pushes the State Projector's payload to Claude's webhook API whenever a task transitions to DONE or OPEN.
3. **Reconciliation Engine:** A startup check within `ai-preflight` that calculates a hash of the local task state. If the cloud state reports a mismatch, it forces a fresh push of the entire state snapshot to the cloud to resolve the drift.

## Data Model
```json
// Cloud Projection Payload
{
  "local_timestamp": "2026-05-18T12:00:00Z",
  "state_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "active_tasks": [
    { "id": "E-72", "status": "OPEN", "owner": "Engineer" }
  ]
}
```

## API / Interface Contracts
- **`project_state()`**: Returns the `Cloud Projection Payload`.
- **`sync_to_cloud(payload)`**: An asynchronous, fire-and-forget `fetch` call inside `managed-agents-client.mjs` that updates Anthropic's memory. It must swallow and log HTTP errors without crashing the local MCP process.

## Security
- **Trust Boundaries:** The cloud state is untrusted for writes. If the cloud attempts to modify state, the request is rejected unless it calls the explicit local MCP `update_task_status` tool. 
- **Data Privacy:** Only task IDs, statuses, and owners are synced. Descriptions, code snippets, and review notes are excluded from the projection payload to ensure proprietary context never unnecessarily leaves the local machine.

## Execution Constraints
- **Performance:** Network calls via `sync_to_cloud` must be non-blocking. A slow internet connection must not pause the execution of local shell commands or commits.
- **Rate Limiting:** Implement a debouncer (e.g., 2000ms) on the Sync Hook to prevent hammering the Anthropic API during rapid task creation.

## Rollback Plan
- Disable the sync by setting `AI_MANAGED_AGENTS_ENABLE=0`.
- The system will immediately fall back to pure local SQLite operations, ignoring any stale state left in the cloud.

## E-## Task Breakdown
- **E-72:** Implement the State Projector helper and the debounced `sync_to_cloud` dispatcher in `src/shared/managed-agents-client.mjs` per `.ai/blueprints/managed-agents-state-reconciliation.md`. | Tier: 2
- **E-73:** Wire the Managed Agents Sync Hook into `task-synchronizer-mcp` so it triggers on task mutations (status changes/additions) per `.ai/blueprints/managed-agents-state-reconciliation.md`. | Tier: 2