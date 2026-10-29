# Antigravity Subagent Robustness

## Goal & Architecture
**Goal:** Address runtime failures of custom subagents in the Antigravity (`agy`) provider by resolving OAuth token races, deduplicating plugin registrations, and dynamically granting necessary `mcp__*` tools in `agent.json`.
**Architecture:**
1. **OAuth Pre-refresh Hook:** A serialized preflight check in `src/bin/ai` that verifies `~/.gemini/oauth_creds.json` and refreshes the token before concurrent subagents are spawned, preventing file collisions and lapses.
2. **Plugin Deduplicator:** A clean-up routine in `src/shared/plugin-builder.mjs` or `src/bin/ai` to safely purge duplicate `ai-os` entries in `import_manifest.json`.
3. **Dynamic MCP Tool Harvester:** An regex scanner in `plugin-builder.mjs` that extracts all referenced `mcp__*` tools from the frontmatter and body of agent files, populating `toolNames` in `agent.json`.

## Core Concept
Native subagents are run in isolated sandbox contexts by the `agy` runtime. To execute successfully, they require:
- A valid, non-expired Google OAuth token in `~/.gemini/oauth_creds.json`.
- A single, valid plugin import registration in `~/.gemini/config/import_manifest.json` to avoid namespace collisions.
- Explicit permissions for any MCP tools they invoke (which are mapped by the runtime under the `mcp__<serverName>__<toolName>` pattern).

## Components
1. **Pre-flight Token Serializer (CLI Bootloader):**
   - Responsible for scanning `~/.gemini/oauth_creds.json`.
   - If the token is expired or expiring within 5 minutes, it invokes a serialized, non-interactive command to refresh the token, writing it back before any parallel subagents execute.
2. **Manifest Cleaner (Sync/Install Layer):**
   - Parses `~/.gemini/config/import_manifest.json`.
   - Cleans duplicate `ai-os` registrations (retaining only one valid plugin source) to prevent command collision.
3. **MCP Tool Scraper (Plugin Builder):**
   - Inspects `src/claude/agents/*.md` and `src/gemini/agents/*.md`.
   - Extracts all occurrences of `/mcp__[a-zA-Z0-9_-]+/g` from frontmatter `allowed-tools` and instructions body.
   - Dynamically injects them into the compiled `toolNames` array in `agent.json`.

## Data Model
- **Token Check Schema:**
  - File: `~/.gemini/oauth_creds.json`
  - Keys: `expiry_date` (integer ms timestamp), `refresh_token` (string)
- **Plugin Manifest Schema:**
  - File: `~/.gemini/config/import_manifest.json`
  - Deduplicated format:
    ```json
    {
      "imports": [
        {
          "name": "ai-os",
          "source": "local-install",
          "importedAt": "2026-06-09T21:43:30Z",
          "components": ["installed"]
        }
      ]
    }
    ```
- **Subagent Manifest (`agent.json`):**
  - File: `src/agents/plugin/agents/<name>/agent.json`
  - Output format:
    ```json
    {
      "name": "critic_arch",
      "description": "...",
      "config": {
        "customAgent": {
          "toolNames": [
            "send_message", "find_by_name", "grep_search", "view_file", "list_dir",
            "mcp__task-synchronizer-mcp__add_stamp"
          ],
          "systemPromptSections": [...]
        }
      }
    }
    ```

## Taxonomy: Skills vs Agents
We enforce a strict separation of execution scopes for AI-OS modules:
- **Skills (In-Context Workflows)**:
  - **Definition**: Multi-step procedural scripts executed directly within the parent agent's context.
  - **Path**: Located in `.agents/skills/<name>/SKILL.md` (or `src/agents/skills/<name>/SKILL.md`).
  - **Configuration**: `context: default` or `type: skill` in frontmatter.
  - **Invocation**: Loaded JIT and executed by the active agent using `activate_skill(...)` or `context-invoker-mcp::activate_skill`.
  - **Visualization**: Not registered in `agy`'s native subagents list.
- **Agents (Autonomous Personas / Out-of-Context Subagents)**:
  - **Definition**: Autonomous personas that run in a forked context to isolate their token/system prompt footprint from the parent conversation.
  - **Path**: Located in `src/claude/agents/*.md` and `src/gemini/agents/*.md`.
  - **Configuration**: `context: fork` in frontmatter.
  - **Invocation**: Spawned in `agy` via `invoke_subagent` (or `context-invoker-mcp::activate_agent` in MCP mode).
  - **Visualization**: Mapped to a native Antigravity plugin and registered under `~/.gemini/config/plugins/ai-os/agents/<name>/agent.json`.

## API / Interface Contracts
- **`src/shared/plugin-builder.mjs` (Exported Functions):**
  - `toSubagent(fm, body, base)`:
    - Input: `fm` (frontmatter object), `body` (instructions string), `base` (default name string).
    - Logic: Match all instances of `/mcp__[a-zA-Z0-9_-]+/g` in `fm['allowed-tools']` and `body`. Add them to `toolNames`.
    - Output: Standard `agent.json` configuration object.
  - `deduplicateImports(manifestPath)`:
    - Input: `manifestPath` (absolute path to `import_manifest.json`).
    - Logic: Read, parse, filter out duplicates for `name: "ai-os"`, preferring `source: "local-install"`, and write back.
- **`src/bin/ai` (Sync/Handoff Hooks):**
  - `verify_auth_token()`:
    - Run during `ai sync` or pre-flight.
    - If `expiry_date` is close to current time, trigger a single synchronous background command to refresh the token, or print warning if token cannot be refreshed.

## Security
- **Least-Privilege Enforcement:** Subagents are only granted the specific `mcp__*` tools they actually declare or use in their files. Broad wildcards (like granting all `mcp__*` tools to every agent) are forbidden.
- **Role Verification:** Subagents must still run subject to their configured capability boundaries (e.g. critics cannot push/merge, database architects cannot bypass transactions).

## Execution Constraints
- **Subagent Timeout:** 60-second limit is enforced by the `agy` runtime. Critic subagents must execute standard checks fast by using targeted `git diff` and reading only `.ai/architect.md` and `.ai/TASKS.md` JIT.
- **File Locks:** Manifest writing and token checks must use file-system locks if they risk colliding with parallel processes.

## Rollback Plan
- If deduplication or token checks fail, the bootloader degrades gracefully, writing a warning to stderr and logging to `.ai/LOG.md` without halting the main CLI thread.
- `ai sync --clear-agents` removes the compiled plugin directories, resetting the state to a clean slate.

## E-## Task Breakdown
- [ ] **E-163**: Implement dynamic `mcp__*` tool harvesting in `src/shared/plugin-builder.mjs` by scanning agent markdown files (allowed-tools and body) for `mcp__` prefixes, adding them to the generated `agent.json` `toolNames`. | Tier: 2
- [ ] **E-164**: Implement `import_manifest.json` deduplication in `src/shared/plugin-builder.mjs` (or during `ai sync`), ensuring only a single, unified `ai-os` plugin import is registered. | Tier: 2
- [ ] **E-165**: Implement serialized OAuth token pre-refresh check in `src/bin/ai` preflight to serialize and execute token refresh before parallel subagents are spawned, preventing write races. | Tier: 2
