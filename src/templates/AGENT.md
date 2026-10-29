---
name: <agent_name>
description: <one sentence — when to dispatch this agent and what it returns>
# The ALLOWLIST (E-295, D-084 r3): exactly the built-ins the body uses, plus mcp__<server> for each
# MCP server it calls. Subagents have NO `allowed-tools` field — it is silently ignored.
tools: Read, Grep, Glob
# Applied BEFORE `tools`; a tool in both is removed. Reviewers: Write, Edit, NotebookEdit.
# Never `mcp__*` — that removes the servers `tools` names.
# disallowedTools: Write, Edit, NotebookEdit
# Connects servers (does not restrict inherited ones); every mcp__<server> in `tools` needs one
# here or in the parent's .mcp.json.
# mcpServers:
#   - task-synchronizer-mcp
maxTurns: 30
---

ROLE: <AGENT_NAME>

## Pre-flight (mandatory reads)
1. <what to read first>

## Procedure
1. <steps>

## Report back
<what the caller receives>
