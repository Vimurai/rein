# Instinct Extraction and DAG Orchestration Integration

## Goal & Architecture
This blueprint outlines the integration of two high-value features inspired by the ECC system into AI-OS: 
1. **Instinct Extraction Pipeline:** An automated mechanism to analyze session logs (`LOG.md`, `REVIEWS.md`) and telemetry to extract recurring, successful patterns ("instincts") and promote them into formal `.gemini/skills/*.md` definitions.
2. **DAG Task Orchestration:** An enhancement to the `state.json` schema and `task-synchronizer-mcp` to support explicit dependencies between `E-##` tasks (`depends_on: []`), enabling the Orchestrator to dispatch parallel, multi-step workflows automatically.

These features transition AI-OS from a strictly sequential, manually-skilled system into an adaptive, parallel-capable autonomous harness.

## Core Concept
- **Instinct Extractor:** A background or scheduled agent (an evolution of `meta_analyst`) that acts as a "pattern recognition engine." It identifies sequences of tool calls or debugging loops that consistently lead to a `[DONE]` state and drafts new Skills.
- **DAG Engine:** A directed acyclic graph implementation within the `mcp_task-synchronizer` that calculates task readiness. A task is `BLOCKED` until all tasks in its `depends_on` array are `DONE`.

## Components
1. **`meta_analyst` (Enhanced):** Upgraded subagent responsible for scanning SQLite telemetry and markdown logs to propose new Skills based on high-confidence "instinct" clusters.
2. **Skill Proposal Gate:** A review mechanism where proposed Skills are written to a staging area (`.gemini/skills/proposed/`) pending Human-in-the-Loop (HITL) approval via `approval-mcp` before being activated.
3. **`task-synchronizer-mcp` (DAG Upgrade):** Modified to accept and validate a `depends_on` array in the `task_create` and `task_update` schemas. Includes cycle-detection logic to prevent circular dependencies.
4. **Orchestrator Dispatcher:** The main loop logic that queries the `task-synchronizer` for the next available `OPEN` tasks whose dependencies are resolved, dispatching them to Claude or appropriate subagents.

## Data Model
**Task Schema Update (`state.json`):**
```json
{
  "id": "E-99",
  "status": "OPEN",
  "depends_on": ["E-98", "E-97"], // NEW FIELD
  "owner": "Engineer (Claude)",
  ...
}
```

**Instinct Schema (Staged Skill):**
```json
{
  "pattern_id": "INST-01",
  "confidence_score": 0.85,
  "trigger_condition": "When resolving React hydration errors",
  "proposed_skill_content": "# SKILL.md content..."
}
```

## API / Interface Contracts
- **`mcp_task-synchronizer_add_task`:** Updated to accept optional `depends_on: string[]` parameter. Returns `[DAG_FAIL]` if a circular dependency is detected.
- **`mcp_task-synchronizer_update_task_status`:** When an `E-##` task is marked `DONE`, the system triggers an evaluation of dependent tasks to change their status from `BLOCKED` to `OPEN`.
- **`meta_analyst_extract_instincts`:** Internal subagent prompt that outputs a JSON payload containing proposed skill structures based on recent successful `E-##` completions.

## Security
- **Skill Injection Surface:** Automatically generated Skills pose a risk of injecting malicious or unsafe instructions. ALL proposed skills MUST be reviewed by the `approval-mcp` (Tier 3 HITL gate) before being moved from `.gemini/skills/proposed/` to `.gemini/skills/`.
- **Cycle Detection:** The DAG engine must robustly detect circular dependencies (`A -> B -> A`) to prevent infinite blocking or stack overflows in the Orchestrator.

## Execution Constraints
- **Telemetry Limits:** The `meta_analyst` should only run its extraction pipeline off-band (e.g., during `ai archive` or explicit invocation) to avoid high token burn during standard planning cycles.
- **DAG Depth:** Maximum dependency depth is limited to 5 levels to prevent overly complex state trees that confuse the LLM context.

## Rollback Plan
- **DAG Reversion:** If task routing fails, revert the `task_create` schema to ignore `depends_on` and manually update all `BLOCKED` tasks in `state.json` to `OPEN`.
- **Instinct Reversion:** Delete the `.gemini/skills/proposed/` directory and any generated `.md` files. Disable the scheduled invocation of the `meta_analyst` extraction prompt.

## E-## Task Breakdown
- `E-200`: Update `task-synchronizer-mcp` schemas to include `depends_on`, implement cycle detection, and modify `get_state` to return readiness flags.
- `E-201`: Upgrade Orchestrator to respect DAG readiness and dispatch parallel subagents (or sequential Claude runs) based on dependency resolution.
- `E-202`: Implement the `meta_analyst` Instinct Extraction prompt and staging logic for `.gemini/skills/proposed/`.
- `E-203`: Integrate `approval-mcp` to gate the promotion of proposed skills to active skills.
