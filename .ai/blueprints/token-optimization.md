# Blueprint: Token Optimization & State Hygiene

## Goal & Architecture
**Goal**: Proactively manage the token footprint of the AI-OS hot-path by capping redundant task data and implementing automated rotation for audit stamps.
**Architecture**: Transition from an "unbounded-accumulation" state model to a "capped-summary + rotating-stamps" model in the `task-synchronizer-mcp`.

## Core Concept
The `state.json` file is read on nearly every tool call. As the project grows, historical summaries and stamps create "dead weight" that consumes thousands of tokens per turn. This blueprint introduces structural limits to keep the active context under 10KB.

## Components
1. **Summary Capper (`task-synchronizer-mcp`)**
   - Responsibility: Enforce a 200-character limit on task `summary` fields during `update_task_status(status=DONE)`. If the provided summary is longer, truncate it and append a reference to `LOG.md` for the full narrative.
2. **Stamp Rotator (`task-synchronizer-mcp`)**
   - Responsibility: Extend `archive_done_tasks()` to also rotate `stamps` from `state.sqlite` to `archive/stamps-YYYY-MM.json` when the count exceeds 50, keeping only the 10 most recent stamps in the active state.
3. **Subagent Audit Pattern (`agents.md`)**
   - Responsibility: Update the documentation in `agents.md` (and `GEMINI.md`) to prefer `invoke_agent` (forked context) for large audit tasks over `activate_skill` (main-thread context), minimizing the loading of heavy skill frontmatter.

## Data Model
- **`tasks.summary`**: `VARCHAR(200)` (enforced at the MCP layer).
- **`stamps_archive`**: JSON projection of rotated rows from the `stamps` table.

## API / Interface Contracts
- **`task-synchronizer-mcp::update_task_status(id, status, summary)`**:
  - If `summary.length > 200`, truncate and emit a warning: `[SUMMARY_TRUNCATED]`.
- **`task-synchronizer-mcp::archive_done_tasks()`**:
  - Now returns `{ archived_tasks: N, archived_stamps: M, archivePath: P }`.

## Security
- **Data Integrity**: Full summaries must be preserved in `LOG.md` (managed by the Engineer) before being capped in the state DB.
- **Auditability**: Archived stamps must be stored in standard JSON format in the `.ai/archive/` folder to remain discoverable by the `repo-oracle` skill.

## Execution Constraints
- **State Size**: Aim for `state.json` < 15KB for a "clean" project.
- **Latency**: Truncation and rotation logic must add <20ms to the status update path.

## Rollback Plan
- Increase the summary cap to 2000 characters.
- Restore the `stamps` table from the latest JSON archive.

## E-## Task Breakdown
- **E-107**: Implement task summary truncation (200 chars) in `task-synchronizer-mcp::update_task_status`.
- **E-108**: Extend `archive_done_tasks` in `task-synchronizer-mcp` to rotate historical audit stamps.
- **E-109**: Update `GEMINI.md` and `agents.md` to establish the "Subagent-Audit-First" pattern for token conservation.
