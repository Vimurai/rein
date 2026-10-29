# Domain Blueprint: June 2026 Audit Remediations

## Goal & Architecture
This blueprint outlines critical fixes and alignment corrections identified during the June 2026 project-wide audit. The scope encompasses correcting database library references (from better-sqlite3 to node:sqlite), extending context-invoker-mcp search paths to include migrated Antigravity skill folders, fixing telemetry DatabaseSync readonly parameter casing, correcting path-based sovereignty validations to protect the blueprints directory, and reconciling documentation drifts.

## Core Concept
Ensure strict compliance with architectural decisions (particularly D-032 rejecting better-sqlite3 in favor of node:sqlite), resolve path resolution errors for skills, and harden the sovereignty verification checks by blocking unauthorized modifications to the `.ai/blueprints/` directory.

## Components
1. **Database & Migration prompts**: Corrects templates (`src/claude/agents/db_architect.md` and `src/shared/skills/ai-migration/SKILL.md`) to use Node 22 native `node:sqlite` API (DatabaseSync) rather than the rejected `better-sqlite3`.
2. **Context-Invoker Search Roots**: Updates `src/mcp/context-invoker-mcp/index.js` to recognize global and user-scoped `agents/skills` directories.
3. **Telemetry Read-Only Options**: Corrects `readOnly` parameter to `readonly` in `src/shared/telemetry.mjs` DatabaseSync instantiation.
4. **Sovereignty Path Filters**: Updates `src/mcp/orchestrator-mcp/index.js` and `critic_arch` to block writes to `.ai/blueprints/` directory.
5. **Documentation Sync**: Resolves legacy references in `CONTRIBUTING.md`, `src/bin/ai`, and `.ai/blueprints/agents.md`.

## Data Model
No new tables or fields are added to state.sqlite or telemetry.sqlite. The existing models remain unchanged.

## API / Interface Contracts
No new MCP API contracts are added. Existing tools function as documented, but with resolved bugs and path scopes.

## Security
- Hardens the sovereignty boundary by expanding the protected Architect-owned file filter to cover `.ai/blueprints/` files, preventing unauthorized modifications from the Engineer.
- Enforces proper read-only permissions on telemetry DB queries by using the correct native `readonly` option (lowercased), preventing unexpected write permissions on the DB socket.

## Execution Constraints
- Zero new package dependencies (re-affirms rejection of better-sqlite3).
- Zero performance overhead (removes path checks or file-system reads).

## Rollback Plan
- Revert file changes using standard `git checkout` or `git revert`.
- The fixes are fully backwards compatible and do not require database migrations.

## E-## Task Breakdown
- **E-166**: Correct `better-sqlite3` imports and pragma usage to native `node:sqlite` `DatabaseSync` in `src/claude/agents/db_architect.md` and `src/shared/skills/ai-migration/SKILL.md`.
- **E-167**: Add `~/.agents/skills/` and `~/.ai-os/agents/skills/` to `SKILL_ROOTS` in `src/mcp/context-invoker-mcp/index.js`.
- **E-168**: Fix `{ readOnly: true }` parameter to `{ readonly: true }` in `src/shared/telemetry.mjs`.
- **E-169**: Extend sovereignty validation to block writes to `.ai/blueprints/` in `src/mcp/orchestrator-mcp/index.js` and `critic_arch` template.
- **E-170**: Resolve documentation drift: (a) update `CONTRIBUTING.md` line 41 to show `agents/skills`, (b) fix `src/bin/ai` line 2397 deprecated warning to guide users to `arch-review`, and (c) update `.ai/blueprints/agents.md` to retire `gemini_tasks` and rename `ai-review` to `arch-review`.
