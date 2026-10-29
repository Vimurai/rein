# Domain Blueprint: Framework Task Routing

## Goal & Architecture
Enables autonomous routing of framework-level changes (affecting `~/.rein/` or `@vimurai/rein/src/**`) directly to the central Rein repository (`@vimurai/rein/.ai/TASKS.md`) regardless of the developer's current local project workspace.

## Core Concept
A hybrid approach combining the `task-planner` skill with environment variables and `task-synchronizer-mcp`. When the `task-planner` skill identifies that an intent targets framework paths, it signals `task-synchronizer-mcp` using an `is_framework_task` flag. The MCP router checks for the `$REIN_WORKSPACE` environment variable and redirects the SQLite task creation and Markdown synchronization to the central workspace.

## Components
1. **task-planner skill**: Responsible for parsing the task description and file paths. If `~/.rein/` or `@vimurai/rein/src/` are detected, it applies a `framework` tag and `is_framework_task: true` payload property.
2. **task-synchronizer-mcp**: Receives task payloads. If `is_framework_task` is true, it overrides the default `.ai/state.sqlite` and `.ai/TASKS.md` paths using the `$REIN_WORKSPACE` value.
3. **Environment Injector (Bootloader)**: Ensures `$REIN_WORKSPACE` is exported globally during `rein init` or installation, pointing to the canonical framework clone.

## Data Model
```json
{
  "description": "Task Routing Payload Additions",
  "task_create": {
    "owner": "Engineer (Claude)",
    "description": "Fix bug in task-synchronizer-mcp",
    "tier": 2,
    "is_framework_task": true
  }
}
```

## API / Interface Contracts
- **Input**: The `add_task` MCP tool payload will optionally accept a boolean `is_framework_task`.
- **Environment**: Process must provide `REIN_WORKSPACE` (e.g., `<workspace>/@vimurai/rein`).
- **Errors**: If `is_framework_task` is true but `REIN_WORKSPACE` is unset or invalid, the MCP throws a `[WORKSPACE_NOT_FOUND]` error to halt creation.

## Security
Tasks routed to the framework workspace must undergo the same RBAC and `[SEC_CLEARED]` validation as local tasks. The path resolution must ensure no path traversal (e.g., `$REIN_WORKSPACE` must not resolve outside the user's intended framework clone).

## Execution Constraints
Writing tasks cross-workspace requires atomic filesystem writes to avoid corrupting the remote SQLite database. File locks on `$REIN_WORKSPACE/.ai/state.sqlite` must be respected. Performance impact should be <10ms overhead for path resolution.

## Rollback Plan
If cross-workspace routing fails or corrupts state, developers can set `REIN_WORKSPACE_DISABLE=1` to force all tasks into the local project until the MCP logic is patched.

## E-## Task Breakdown
- E-##: Implement `$REIN_WORKSPACE` injection in `install-rein.sh` and `bin/rein`.
- E-##: Update `task-synchronizer-mcp` schema and logic to support `is_framework_task` and cross-workspace SQLite/Markdown operations.
- E-##: Update `task-planner` skill to analyze paths and pass `is_framework_task` when appropriate.