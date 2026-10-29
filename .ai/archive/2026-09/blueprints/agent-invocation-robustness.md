# Agent Invocation Robustness Blueprint

## Goal & Architecture
**Goal:** Enable both the Architect (Agy) and the Engineer (Claude) to dynamically detect the execution environment (standard MCP vs. native Antigravity `agy`) and automatically decide when to invoke a skill or subagent, preventing execution termination errors due to missing or unauthenticated tools.
**Architecture:** Update the main system bootloader instructions (`CLAUDE.md` and `GEMINI.md`, along with their templates) to explicitly guide the models on:
1. When it is proper to run a skill (procedural task) vs. invoke a subagent (specialist persona).
2. How to dynamically detect the presence of native Antigravity subagent tools (`invoke_subagent`, `define_subagent`) vs. standard MCP tools (`activate_agent`, `activate_skill`) and choose the correct API.

## Core Concept
In the AI-OS v3 environment:
- **Skills** (e.g., `ai-preflight`, `ai-task`, `ai-handoff`, `ai-debug`) run in-context. They are procedural workflows.
- **Agents** (e.g., `critic_arch`, `critic_security`, `ux_reviewer`, `db_architect`) are specialized personas that run in forked/isolated sub-sessions.
- In **Antigravity (`agy`)**, agents must be invoked via the native `invoke_subagent` tool.
- In **Claude Code / Gemini CLI**, agents must be invoked via `activate_agent` (via `context-invoker-mcp`).
- If an agent tries to invoke a tool that is not exposed (e.g. calling `activate_agent` in `agy` without MCP, or calling `invoke_subagent` outside `agy`), it fails. The models must check their tool declarations dynamically and use the correct path.

## Components
1. **Claude Instruction Set (`CLAUDE.md` / `src/templates/CLAUDE.md`):** Updated with explicit auto-selection rules for skills/agents and resilient tool selection (native vs. MCP).
2. **Gemini Instruction Set (`GEMINI.md` / `src/templates/GEMINI.md`):** Updated with identical auto-selection rules and resilient tool selection.

## Data Model
No database schema changes. The configuration files `roles.json` and `providers.json` remain unchanged.

## API / Interface Contracts
The models must dynamically inspect their available tools:
- If `invoke_subagent` is present in the toolset: use it for subagent delegation (e.g., `critic_arch`, `critic_security`, `ux_reviewer`).
- If `activate_agent` or `skill` MCP tools are present: use them as the primary invocation method.
- If both are missing: fall back to executing command-line scripts or displaying manual instructions.

## Security
Native subagents spawned via `invoke_subagent` are automatically subject to Antigravity's workspace isolation, aligning with our sovereignty constraints.

## Execution Constraints
- **Zero latency:** Tool selection must be done in the model's pre-computation/thinking step with zero additional overhead.

## Rollback Plan
Revert `CLAUDE.md`, `GEMINI.md`, and their templates in `src/templates/` to their pre-sprint states.

## E-## Task Breakdown
- **E-161**: Update `src/templates/CLAUDE.md` and `CLAUDE.md` to instruct the Engineer on auto-deciding when to invoke skills or agents, with environment-aware tool selection (native `invoke_subagent` vs. MCP).
- **E-162**: Update `src/templates/GEMINI.md` and `GEMINI.md` to instruct the Architect on auto-deciding when to invoke skills or agents, with environment-aware tool selection (native `invoke_subagent` vs. MCP).
