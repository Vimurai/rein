# Antigravity Native Subagents

## Goal & Architecture
**Goal:** Map the existing AI-OS framework specialized agents (e.g., `critic_arch`, `chaos_monkey`) to native Antigravity subagents so they are visible and invokable directly from the Antigravity CLI's native agent UI.
**Architecture:** Create a plugin builder (`src/shared/plugin-builder.mjs`) that reads the AI-OS agent registry (markdown personas) and compiles them into a native Antigravity plugin (`src/agents/plugin`). This plugin is then installed to the user's global plugin directory (`~/.gemini/config/plugins/ai-os/`).

## Core Concept
While AI-OS provides 20 specialized agents, users running the Antigravity (`agy`) provider see an empty "agents" list if they rely on loose files. Antigravity expects custom subagents to be natively defined in its own plugin format. This integration bridges that gap by systematically mapping AI-OS agents to an Antigravity plugin via `src/shared/plugin-builder.mjs`.

## Components
1. **Plugin Builder:** Extracts the name, description, and system prompt for each agent from the AI-OS source directories (`src/claude/agents/*.md` and `src/gemini/agents/*.md`).
2. **Antigravity Definition Mapper:** Translates the extracted data into a unified `ai-os` plugin containing the subagents as `agent.json` manifests.
3. **Sync Trigger Hook:** Injects the plugin installation step into the `ai install` or `ai sync` workflows so the plugin is automatically built and registered.

## Data Model
- **AI-OS Source (agents only):** `src/claude/agents/*.md` + `src/gemini/agents/*.md` — autonomous personas. Procedural workflows are NOT here (see §Taxonomy); they live in `src/agents/skills/`.
- **Antigravity Target:** An installed Antigravity plugin located at `~/.gemini/config/plugins/ai-os/`. The `plugin-builder.mjs` compiles agents into subdirectories under `agents/<name>/agent.json` within the plugin structure.
Mapping logic format (agent.json payload):
```json
{
  "name": "ai-os-critic-arch",
  "description": "Deterministic architecture reviewer. Compares git diff against .ai/architect.md",
  "system_prompt": "You are the critic_arch agent. Your job is to invoke `activate_agent({ agent_name: 'critic_arch' })` and follow the instructions.",
  "enable_mcp_tools": true
}
```

## Taxonomy: Skills vs Agents (E-141 / E-142)
AI-OS has two distinct unit types; **only Agents** map to native Antigravity subagents:

- **Skills** — in-context procedural workflows (e.g. `digest_updater`, `ai-migration`,
  `identity_guardian`, `aqg-resolver`, `review_synthesizer`). They run in the main
  conversation, carry `context: default` (and/or `type: skill`) in frontmatter, live in
  **`src/agents/skills/<name>/SKILL.md`**, and are invoked via `activate_skill(...)`. They are
  **NOT** mapped to native subagents and never appear in the `agy` agents list.
- **Agents** — autonomous personas (e.g. `devops_engineer`, the `critic_*` reviewers,
  `chaos_monkey`, `db_architect`, `dependency_manager`). They fork their own context
  (`context: fork`), live in **`src/claude/agents/` / `src/gemini/agents/`**, are invoked via
  `activate_agent(...)`, and ARE mapped → `~/.gemini/config/plugins/ai-os/agents/<name>/agent.json`.

`plugin-builder.mjs` enforces the split: it reads only the agent dirs and skips any file
whose frontmatter has `context: default` or `type: skill`.

### Authoring for `agy`
- **New agent (persona):** add `src/claude/agents/<name>.md` with `context: fork`, then run
  `ai sync --agents` → it appears as a native subagent in the plugin.
- **New skill (procedural):** add `src/agents/skills/<name>/SKILL.md` with `context: default`
  (or `type: skill`); it stays in-context and is never shown as a native subagent.

## API / Interface Contracts
- **Input:** Execution of `ai sync --agents` or similar bootloader command.
- **Action:** A node script maps the registry and outputs Antigravity subagent manifests.
- **Output:** The Antigravity UI correctly displays the AI-OS agents.

## Security
- Subagents must be confined to the project workspace.
- The `system_prompt` injected must explicitly command the subagent to respect the standard AI-OS boundaries (e.g., capability limits, safe-exec-mcp).

## Execution Constraints
- **Performance:** Registration should be fast (< 500ms) to not slow down `ai sync`.
- **Duplication:** Ensure idempotent definitions so agents aren't duplicated across syncs.

## Rollback Plan
- Provide a command `ai sync --clear-agents` to remove the native definitions.
- If the integration fails, users can continue invoking agents manually via `context-invoker-mcp` with no loss of functionality.

## E-## Task Breakdown
- **E-140**: Implement the `ai sync --agents` mapper to extract AI-OS agent metadata and register them as native Antigravity subagents.
