---
paths:
  - "src/claude/agents/**"
  - ".claude/agents/**"
---

# Agent authoring (src/claude/agents/)

Subagent frontmatter is not skill frontmatter (D-084 r3, verified in Claude Code's sub-agents
docs). `verify_compliance` enforces these; template: `src/templates/AGENT.md`.

- **`allowed-tools` does not exist for a subagent** and is silently ignored — the 21 agents'
  limits were never applied until E-295. Write `tools:`.
- **`tools` is the ALLOWLIST**: the built-ins the body actually uses, plus `mcp__<server>` (or
  `mcp__<server>__<tool>`) for each MCP server it calls. Omitting `tools` inherits every tool.
- **`mcpServers` only CONNECTS** servers; it never restricts the inherited ones. Every
  `mcp__<server>` in `tools` must be in the agent's `mcpServers` or the parent's `.mcp.json`.
- **`disallowedTools` is applied FIRST**, and a tool matched by both lists is removed — so
  `disallowedTools: mcp__*` is not scoping; it deletes the server `tools` asked for.
- **A reviewer never writes**: every `critic_*` carries `disallowedTools: Write, Edit, NotebookEdit`.
- **Scoped agents** (`critic_*`, `test_engineer`, any agent with `mcpServers:`) MUST carry `tools`.
- Keep `src/claude/agents/<name>.md` and its `.claude/agents/` mirror byte-identical (`ai sync`
  provisions it).
