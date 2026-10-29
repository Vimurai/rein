# TASKS (Generated from state.json)

Rules:
- Architect adds tasks with prefix P-## via add_task MCP tool
- Engineer adds tasks with prefix E-## via add_task MCP tool
- Tester (headless Claude role, skill: ai-test) adds tasks with prefix T-## via add_task MCP tool
- **MANDATE**: Never hand-edit this file — it is regenerated from state.sqlite after every mutation.
- To add a task: mcp__task-synchronizer-mcp__add_task({ prefix, owner, description, tier })

## Architect
- [ ] P-1: Define initial blueprint in architect.md

## Engineer
- [ ] E-1: Implement first feature (wait for P-1)
