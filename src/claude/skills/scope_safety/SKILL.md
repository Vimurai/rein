---
name: scope_safety
description: Enforce filesystem and shell scope boundaries on every file/shell operation. Blocks path traversal, unauthorized writes, and commands not in CAPABILITIES.md. Mandatory — applied automatically to all operations.
disable-model-invocation: false
user-invocable: false
allowed-tools: Read, Grep, Glob
context: default
agent: default
---

# Scope Safety (Mandatory — Applied to Every Operation)

Rules:
- Never read or write outside repo root unless CAPABILITIES.md explicitly allows it.
- Reject any path containing `../` — log it as a P0 security issue in `.ai/LOG.md`.
- Shell execution: only allow commands listed in `CAPABILITIES.md` under `shell.exec`.
- Default-deny: if a path or command is not in CAPABILITIES.md, stop and propose a Capability Gate decision.
- The `.mcp.json` filesystem server enforces these restrictions at the MCP layer — align with it.
- If the PreToolUse secret scan hook blocks a write: do not bypass. Fix the content.

## Dynamic Context Injection
Current CAPABILITIES scope: !cat .ai/CAPABILITIES.md 2>/dev/null || echo "(not found — run: ai init)"
