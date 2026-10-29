# Antigravity CLI Migration

## Goal & Architecture
Migrate the AI-OS v2 framework from the legacy Gemini CLI toolchain to the modern Antigravity CLI, leveraging the **Provider Adapter System** (E-138) to ensure a modular, CLI-agnostic transition that preserves all workspace rules and automation loops.

## Core Concept
The Antigravity CLI introduces a new file structure and standalone configuration mechanism. Instead of hardcoded folder moves, this migration uses the Provider Adapter System to register `agy` as a valid provider. The migration focuses on relocating legacy `.gemini/` skills to the `.agents/` directory and utilizing the `ai provider add` CLI to bootstrap the Antigravity environment.

## Components
1. **Skill Relocation:** Move workspace-specific skills from the legacy `.gemini/skills/` to the new `.agents/skills/` directory. This aligns with the Antigravity provider's expected structure.
2. **Provider Registration:** Use `ai provider add agy --config-path .agents/mcp_config.json --mcp-key mcpServers` to register the Antigravity CLI. This automatically handles the transition of legacy `httpUrl` keys to the modern `serverUrl` during the configuration sync.
3. **Role Re-assignment:** Update `.ai/roles.json` to map the `architect` (or desired role) to the `agy` provider.
4. **Auto-Conversion Pipeline:** Execution of the `agy` interactive auto-conversion command and the manual importation of legacy plugins (`agy plugin import gemini`).

## Data Model
- **Skill Path:** `.agents/skills/<name>/SKILL.md` — AI-OS **Skills** = in-context procedural workflows (`context: default` / `type: skill`); invoked via `activate_skill`. NOT shown as native subagents.
- **Agent Path:** `.agents/agents/<name>/agent.json` — AI-OS **Agents** = autonomous personas (`context: fork`) mapped to native Antigravity subagents by `ai sync --agents` (E-140/E-142). See `native-subagents.md` §Taxonomy for authoring rules.
- **Provider Identity:** `agy`
- **Config Target:** `.agents/mcp_config.json` (Managed by the Provider Adapter)

## API / Interface Contracts
- **Command Line:** 
  - `ai provider add agy --config-path .agents/mcp_config.json --mcp-key mcpServers`
  - `agy` (initial bootstrap)
  - `agy plugin import gemini`
- **Documentation:** `.gemini/GEMINI.md` remains compliant.

## Security
- `ai provider add` ensures that the newly created `.agents/mcp_config.json` respects existing repository boundaries.
- Ensure `.agents/mcp_config.json` is added to `.gitignore`.

## Execution Constraints
- `agy` interactive commands must be handled with care to prevent hanging the terminal.
- MCP servers must be verified online after the provider swap.

## Rollback Plan
- Restore `.ai/roles.json` to use `gemini` provider.
- Revert skill relocation via `git checkout .gemini/skills/`.
- Purge `.agents/` directory.

## E-## Task Breakdown
- **E-132**: Relocate workspace skills from `.gemini/skills/` to `.agents/skills/` and ensure compatibility with the `agy` provider structure.
- **E-133**: Register the `agy` provider using `ai provider add agy --config-path .agents/mcp_config.json --mcp-key mcpServers` and verify that legacy MCP configurations are correctly transitioned.
- **E-134**: Run the `agy` interactive conversion and import legacy plugins (`agy plugin import gemini`). Verify end-to-end handoff to the `agy` provider.