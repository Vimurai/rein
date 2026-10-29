# Domain Blueprint: Structured Outputs & Deterministic State

> [!IMPORTANT]
> This document specifies the transition from Markdown-based payload parsing to 100% deterministic Structured Outputs (JSON Schema) for Triad communication.

## 1. The "Brittle Markdown" Problem
Historically, the Architect (Agy) and Engineer (Claude) communicated via markdown files (`TASKS.md`, `REVIEWS.md`). Parsing these files via regex to update the SQLite state is brittle, prone to formatting errors, and lacks type safety.

## 2. Native Structured Outputs
AI-OS v2 leverages the 2026 API features for native Structured Outputs. When an agent needs to transition the system state (e.g., adding P-## tasks, marking E-## tasks done, or emitting an Audit Stamp), it MUST do so by invoking MCP tools with strictly typed JSON payloads, bypassing raw markdown generation.

### Schema Definition
All state transitions are governed by the JSON Schemas defined in `src/shared/schemas/state.json`.

Example Schema for a Task creation:
```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "description": { "type": "string" },
    "tier": { "type": "integer", "enum": [1, 2, 3] },
    "owner": { "type": "string" }
  },
  "required": ["id", "description", "tier", "owner"],
  "additionalProperties": false
}
```

## 3. Workflow Migration
1. **Deprecation of Manual Markdown Editing**: Agents are strictly forbidden from manually using `write_file` or `replace` to edit `.ai/TASKS.md` or `.ai/REVIEWS.md`.
2. **MCP-Only State Mutation**: To alter state, the agent must call the `task-synchronizer-mcp` tools (e.g., `add_task`, `update_task_status`). **Exception (D-053)**: If MCP is unreachable (e.g., in native shell environments), agents may use audited shell primitives like `ai add-task` or `ai handoff` which wrap the same SQLite transaction path.
3. **Runtime Enforcement**: The MCP server (`task-synchronizer-mcp`) will enforce JSON Schema adherence at runtime using the `validate_payload` tool and `_assertSchema` guards to guarantee that the agent's payload precisely matches the required schema before any SQLite mutation occurs.
4. **Auto-Generation**: `TASKS.md` and `REVIEWS.md` become read-only, auto-generated projections of the SQLite database, created by the `task-synchronizer-mcp` immediately after any state change.
