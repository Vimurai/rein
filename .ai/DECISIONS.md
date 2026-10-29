---
type: decisions
tags: [decisions, architecture, dependencies]
status: active
---

# DECISIONS (Append-only — architectural and dependency decisions)

---

## [[D-001]] — npm/pnpm Workspace Monorepo for src/mcp/*

**Date**: 2026-04-14
**Task**: [[E-1]]
**Decision**: npm workspaces (confirmed — matches blueprint [[workspace.md]] §2)

### Why needed
16 MCP servers in `src/mcp/` each carry their own `node_modules/`. Every server independently installs `@modelcontextprotocol/sdk` (and in some cases `zod`, `typescript`, `shell-quote`, `@playwright/test`). This creates 16x duplication, version drift risk, and a fragmented upgrade surface. An npm/pnpm workspace at the project root hoists shared deps to a single location and enforces a unified version resolution.

### What changes
- A new `package.json` is added at the repository root with `"workspaces": ["src/mcp/*"]`.
- No new third-party packages are installed — only existing packages are reorganised under workspace hoisting.
- Each MCP server retains its own `package.json` for metadata and runtime entry point; no coupling is introduced at the runtime layer.

### Alternatives considered
1. **Do nothing** — 16 fragmented installs; version drift is a known risk (see `.ai/REVIEWS.md` ARCH_AUDIT 2026-04-14). Rejected.
2. **Symlink approach (manual)** — brittle; does not handle transitive deps. Rejected.
3. **pnpm workspaces** — equivalent to npm workspaces for this use case; requires installing pnpm globally. Lower friction to use npm workspaces since Node.js 16+ ships npm 7+ with native workspace support. Preferred option pending human decision.
4. **npm workspaces (chosen draft)** — zero new tooling required; hoisting is deterministic; lock file is unified at root. Strongly preferred.

### Size / weight
- No net-new dependencies. Reduces total `node_modules` disk footprint by approximately 15x (16 copies → 1 hoisted copy of `@modelcontextprotocol/sdk`).
- Root `package.json`: ~200 bytes. No runtime impact.

### Security track record
- npm workspaces is a built-in npm feature (no third-party package). No CVE surface added.
- `@modelcontextprotocol/sdk` — already present across all servers; version pinning via a single root lock file improves auditability.

### Maintenance status
- npm workspaces: maintained as part of Node.js core toolchain. No separate release cadence.

### License
- npm (ISC) — already in use. No new license introduced.

### Rollback plan
- Delete root `package.json` and `package-lock.json`. Each MCP server's own `package.json` remains untouched. Run `npm install` inside each `src/mcp/<server>/` directory to restore isolated installs. No source code changes required.

---

## [[D-002]] — computer-use-mcp: New MCP Server for Native Computer Use ([[E-8]])

**Date**: 2026-04-21
**Task**: [[E-8]]
**Decision**: computer-use-mcp (confirmed 2026-04-21)

### Why needed
`vibe-check-mcp` uses Playwright (DOM/headless Chrome scraping) for visual QA. This approach misses native UI elements, OS-level dialogs, and non-web surfaces. The blueprint ([[capabilities.md]] §2) mandates augmenting vibe-check-mcp with native OS-level Computer Use capabilities so TestSprite can visually assert UI state without DOM coupling — aligning with Project Mariner / Claude Computer Use.

### Alternatives considered
1. **Extend Playwright** — DOM scraping; can't interact with native OS windows, Electron chrome, or non-web surfaces. Rejected.
2. **Screenshot diffing (pixelmatch/resemble.js)** — no interaction capability; brittle to font/DPI changes. Rejected.
3. **Selenium + OS-level driver** — heavyweight; no AI-native interaction model. Rejected.
4. **computer-use-mcp (chosen draft)** — wraps the Claude Computer Use API (screen capture + coordinate click + keyboard) in an MCP server; sandboxed to a headless X11/Wayland virtual display. Directly integrates with the Triad AI loop. Strongly preferred per blueprint.

### Size / weight
- New MCP server at `src/mcp/computer-use-mcp/` (~300–500 LOC Node.js).
- Runtime deps: `@anthropic-ai/sdk` (already hoisted in workspace), `xvfb` (virtual display, system-level, no npm package), optionally `screenshot-desktop` (~15KB npm).
- No net-new npm packages beyond what is already in the workspace.

### Security track record
- Anthropic SDK: actively maintained, no known critical CVEs as of 2026-04.
- X11/Xvfb virtual display: isolation boundary between agent and host display. Well-understood Linux subsystem.
- **Key risk**: if sandbox escapes, agent can interact with host machine. Mitigation: strict `DISPLAY` env var isolation + sandboxed headless buffer only — no access to `$DISPLAY=:0` (host display). Reviewed by `security_engineer` gate (mandatory for Tier 3).

### Maintenance status
- Anthropic SDK: actively maintained by Anthropic. Monthly releases.
- Xvfb: part of X.Org project; stable, minimal churn.

### License
- Anthropic SDK: MIT — compatible.
- Xvfb: MIT/X11 — compatible.

### Rollback plan
- Delete `src/mcp/computer-use-mcp/` directory and remove its entry from `src/config/registry.json` and `.mcp.json`. Re-run `bash install-ai-os.sh` to sync. vibe-check-mcp (Playwright) remains intact and resumes as the sole visual QA tool.

---

## [[D-003]] — approval-mcp: No New Dependencies ([[E-10]])

**Date**: 2026-04-24
**Task**: [[E-10]]
**Decision**: No new npm packages — Node.js built-ins only (confirmed 2026-04-24)

### Why needed
`approval-mcp` implements the HITL gate for Tier 3 operations. It needs: (1) an interactive terminal prompt for Y/N approval, (2) persistent approval/rejection audit log in SQLite.

### Alternatives considered
1. **`inquirer` / `prompts` npm packages** — interactive CLI prompts; adds ~500KB. Rejected — `readline` (built-in) covers the Y/N use case with zero footprint.
2. **`better-sqlite3`** — npm package for SQLite. Rejected — `node:sqlite` (Node.js 22+ built-in, already used by token-budget-mcp) covers the use case with zero new install surface.
3. **`node:readline` + `node:sqlite` (chosen)** — both are Node.js built-ins; zero new npm dependencies; no install, no CVE surface, no license risk.

### Size / weight
- Zero net-new npm packages. No increase in `node_modules` footprint.

### Security track record
- `node:readline`: Node.js core, no CVE surface.
- `node:sqlite`: Node.js 22+ built-in; same audit surface as the Node.js runtime itself.

### Maintenance status
- Both modules maintained as part of the Node.js core team release cadence.

### License
- Node.js built-ins: MIT — compatible.

### Rollback plan
- Delete `src/mcp/approval-mcp/` and remove from `registry.json` / `.mcp.json`. No npm uninstall required.

---

## [[D-004]] — cache-manager-mcp: Dedicated MCP Server vs. token-budget-mcp Extension

**Date**: 2026-04-27
**Task**: [[E-11]]
**Decision**: New dedicated `cache-manager-mcp` server (no new npm packages — SDK already hoisted)

### Why needed
Blueprint [[caching.md]] §3 specifies that the cache payload (`.ai/blueprints/*.md`, `architect.md`, `state.sqlite` schema, `registry.json`) must be pre-assembled and persisted so agents can include it as a long-lived system prompt prefix — enabling Anthropic's prompt caching to eliminate per-turn JIT read costs.

### Alternatives considered
1. **Extend `token-budget-mcp`** — token-budget-mcp tracks cost/spend; caching is a separate concern (file I/O, mtime tracking, context assembly). Mixing them violates single-responsibility and would bloat a server already wired into every agent. Rejected.
2. **Dedicated `cache-manager-mcp` (chosen)** — clean boundary; follows the established pattern of all other AI-OS MCP servers. Allows capability = READ (no WRITE or EXECUTE escalation needed). No new external dependencies. Preferred.

### What it adds
- `build_cache(project_root?)` — force-rebuilds the System Context blob and persists it with file mtimes.
- `get_cached_context(project_root?)` — returns cached blob; auto-rebuilds on mtime change or new blueprint file.
- `invalidate_cache()` — marks cache stale without rebuilding.
- `get_cache_status()` — observability: age, file count, char/token estimate, tracked mtimes.

### Security properties
- `DB_PATH` hardcoded to `~/.ai-os/cache.sqlite` — no user-controlled path.
- `project_root` validated: must be absolute, no `..` traversal, must exist.
- All file reads use `readFileSync` — no `execSync`, no shell.
- SQLite schema extracted via `sqlite_master` query (not `.schema` shell command).

### Rollback plan
- Delete `src/mcp/cache-manager-mcp/` and remove from `registry.json` / `.mcp.json`. No npm uninstall required.

---

## [[D-005]] — Call-by-Reference Git Hooks via Execution Stubs

**Date**: 2026-05-05
**Task**: [[P-20]]
**Decision**: Replace copy-by-value hook installation with dynamic execution stubs that source `~/.ai-os/hooks/`.

### Why needed
The existing hook installation copied the global `~/.ai-os/hooks/pre-commit.sh` script into the project's `.git/hooks/pre-commit`. This resulted in split-brain drift: when the canonical global script updated, local projects were left running an outdated version unless `ai init` was manually re-run. This caused stale quality gates to silently pass.

### Alternatives considered
1. **Force symlinks (`ln -s`)** — requires specific OS permissions on some filesystems (e.g., Windows) and breaks if the target path format changes. Rejected.
2. **`ai sync` full copy** — requires `ai sync` to mutate the `.git/hooks` directory explicitly, taking overhead on every sync. Prone to local manual edits being lost without warning. Rejected.
3. **Execution Stub (chosen)** — generating a minimal bash wrapper that simply executes the global path. Reliable across UNIX environments, trivially updatable, and gracefully handles custom chained hooks without mutating the canonical source.

### Constraints driving this decision
- **Consistency**: All projects on a single machine must enforce the exact same pre-commit quality gate logic (Gate 2).

### Impact
- Unlocks: [[E-41]] (Implementing the stub generator and auto-upgrader).
- Risk if wrong: If `~/.ai-os/hooks/` is corrupted or missing, all local commits in stubbed repositories could fail or bypass the gate depending on the stub's error handling.

### Rollback
Delete `.git/hooks/pre-commit` in the local repository and recommit without the gate.

---

## [[D-006]] — Hybrid Env Var + MCP Routing for Framework Tasks

**Date**: 2026-05-10
**Task**: [[P-38]]
**Decision**: Route framework-level tasks via `task-synchronizer-mcp` using `$AIOS_WORKSPACE` and `is_framework_task` payload flag.

### Why needed
AI-OS framework development requires routing tasks to the global repository (`ai-os-v2`) even when a developer identifies an issue while working inside a local project workspace. A mechanism was needed to map `~/.ai-os/` path intents to the correct `TASKS.md`.

### Alternatives considered
1. **Skill-Level CWD Switch** — The `task-planner` skill instructs the agent to `cd` into the framework directory before writing. Brittle, breaks agent context loop. Rejected.
2. **Global Spooling** — Write to `~/.ai-os/framework_tasks.sqlite` and manually sync later. High friction, requires explicit sync step. Rejected.
3. **Hybrid Env Var + MCP (Chosen)** — The `task-planner` tags the payload; the MCP router checks `$AIOS_WORKSPACE` and overrides the SQLite/Markdown paths transparently. Keeps agent logic simple and execution deterministic.

### Constraints driving this decision
- **Developer UX**: The agent should seamlessly record framework tasks without the developer switching projects manually.

### Impact
- Unlocks: E-62, E-63, E-64 (Framework Task Routing Implementation).
- Risk if wrong: If `$AIOS_WORKSPACE` path resolution fails, tasks may corrupt local state or throw errors.

### Rollback
Set `AIOS_WORKSPACE_DISABLE=1` to force all tasks into the local project.

---

## [[D-007]] — JIT Aggregation for Incident Tracker

**Date**: 2026-05-10
**Task**: [[P-38]]
**Decision**: Aggregate `incidents.ndjson` Just-In-Time (JIT) during `ai-preflight` to propose recurrent incident P-## tasks.

### Why needed
We need to track and resolve recurrent errors across the Triad. A system must autonomously identify high-frequency incidents and draft P-## tasks for the Architect without causing token bloat.

### Alternatives considered
1. **Background Aggregator Agent** — A cron job or background daemon analyzes the NDJSON periodically. Adds operational overhead and requires a persistent background process. Rejected.
2. **JIT Aggregation (Preflight/Sync)** — Hook into the existing `ai-preflight` phase. Extremely lightweight, surfaces issues exactly when the developer and Architect are ready to start a session. Chosen.

### Constraints driving this decision
- **Performance**: Must parse quickly (<50ms) to not slow down the bootloader.

### Impact
- Unlocks: E-65, E-66, E-67 (Incident Tracker Implementation).
- Risk if wrong: If the log bloats, the preflight hook could slow down session start.

### Rollback
Toggle `AI_INCIDENT_TRACKER_DISABLE=1` env variable or manually delete `incidents.ndjson`.

---

## [[D-008]] — Tree-sitter via WASM (web-tree-sitter) for the AST Repository Map ([[E-95]])

**Date**: 2026-05-27
**Task**: [[E-95]] (blueprint `ast-repository-map.md`)
**Decision**: **Add `web-tree-sitter` (WASM) + `tree-sitter-wasms` (prebuilt JS/TS grammar `.wasm` bundle).** Chosen by the human over native bindings. A deliberate, scoped exception to [[D-003]] ("No New Dependencies").

### Why needed
`ast-repository-map.md` mandates Tree-sitter to extract structural signatures (exports/classes/methods/imports) for a token-compressed `REPO_MAP.md`. A correct multi-language parser is not reasonably implementable in-house — hand-rolled regex parsing of TS/JS is brittle and is exactly the failure mode the blueprint exists to replace.

### Alternatives considered
1. **Implement it ourselves (regex/heuristics)** — brittle on real TS/JS (generics, decorators, JSX); high maintenance. Rejected.
2. **Native `tree-sitter` bindings** — faster, but require `node-gyp` + a C toolchain and ship platform-specific binaries, breaking the drop-in-installer portability promise across macOS/Linux/Windows/CI. Rejected by the human.
3. **`web-tree-sitter` (WASM) + `tree-sitter-wasms`** — pure-WASM, no native build, portable; grammars load from prebuilt `.wasm`. **Chosen.**

### Size / weight
`web-tree-sitter` ships a small JS loader + `tree-sitter.wasm` runtime (~1 MB). `tree-sitter-wasms` bundles many grammar `.wasm` files (a few MB) but only `javascript` + `typescript` are loaded at runtime.

### Security track record
Tree-sitter is widely deployed (GitHub code-nav, Neovim, Aider). The WASM runtime runs grammars in a sandboxed VM (no FS/network). No notable CVEs for the parser core. Parsing is bounded per the blueprint (≤500 ms/file, skip >1 MB / minified) to prevent DoS; `.gitignore`/`.env*` are respected so secrets are never indexed.

### Maintenance status
`web-tree-sitter` **pinned to `0.20.8`** (not the latest `0.26.9`): the `0.26` runtime's dylink ABI rejects `tree-sitter-wasms@0.1.13`'s prebuilt grammars (built against the tree-sitter 0.20-era ABI). `0.20.8` is the battle-tested combo used by Aider/continue.dev. `tree-sitter-wasms@0.1.13` (modified 2025-10-07, maintained community bundle). Revisit the pin if/when `tree-sitter-wasms` ships 0.25+-ABI grammars.

### License
`web-tree-sitter`: MIT. `tree-sitter-wasms`: Unlicense (public domain). Both compatible.

### Impact
- Unlocks: E-95 (`ast-parser-mcp`), E-96 (ranking), E-97 (`generate_map`), E-98 (sync/preflight wiring).
- **E-98 update**: the 3 grammar `.wasm` are now VENDORED into `src/mcp/ast-parser-mcp/grammars/` (~5 MB, tracked) so the installed `~/.ai-os` server is self-contained. `tree-sitter-wasms` is therefore a **devDependency** (build-time source of the `.wasm`), not a runtime dep. The only runtime npm dep is `web-tree-sitter`, and the `--generate-map` CLI path lazy-loads the MCP SDK so the `ai sync` hook needs neither the SDK nor any root-hoisted package.

### Rollback
`npm rm web-tree-sitter tree-sitter-wasms`, delete `src/mcp/ast-parser-mcp/`, set `AI_OS_DISABLE_REPO_MAP=1` (blueprint rollback). Agents fall back to `grep`/`list_directory`.

---

## D-037 — Global Hook-Level Telemetry Instrumentation

**Date**: 2026-06-01
**Task**: P-2
**Decision**: Shift the primary instrumentation point for tool telemetry from the `mcp-router` (internal) to the `post-tool-use.sh` bash hook (global edge).

### Why needed
Current telemetry only captures tools routed through `mcp-router::proxy_call` (~1% of total activity). The "Second Brain" is system-blind to direct MCP calls made by Claude Code or other agents. Moving to the hook layer ensures 100% visibility of all tool executions.

### Alternatives considered
1. **Router Proxy-by-Default** — Rejected: Requires forcing all agents to route all calls through the router, adding latency and a single point of failure for basic operations like filesystem reads.
2. **Claude Code Extension** — Rejected: Telemetry would be dependent on the specific client; hooks are more universal across the AI-OS platform.
3. **Global Hook Instrumentation** — Selected: Captures the ground truth of agent execution at the edge with near-zero latency and zero change to agent-to-tool routing logic.

### Constraints driving this decision
- **Visibility**: Must capture 100% of tool invocations for accurate meta-cognition analysis.
- **Performance**: Instrumentation must not add noticeable latency to the tool loop (<50ms).

### Impact
- Unlocks: E-104, E-105, E-106.
- Risk if wrong: Double-counting of tools that pass through both the hook and the router (mitigated by E-106 refactor).

### Rollback
Revert `hooks/post-tool-use.sh` to its original state and restore internal instrumentation in `mcp-router`.

---

## D-039 — Structural Diff & Dry-Run Patching

**Date**: 2026-06-02
**Task**: E-101 (Implicit bugfix during implementation)
**Decision**: `confirm_patch` now detects diffs by their unified-diff hunk-header signature (`@@ -n,m +n,m @@`) rather than a strict `---` prefix. Patch application uses a dry-run first and creates a `-b` backup for safe rollback.

### Why needed
The previous patching mechanism was brittle, occasionally misidentifying diff boundaries or applying destructive partial patches when hunks failed.

### Constraints driving this decision
- **Safety**: Need guaranteed rollback if a patch applies cleanly to some hunks but fails on others.
- **Robustness**: Support varied unified-diff header formats generated by LLMs.

---

## D-040 — Distributed Stamping for Tier-3 Critics

**Date**: 2026-06-02
**Task**: E-101 (Implicit bugfix during implementation)
**Decision**: Tier-3 critics (arch/security/tests) must persist verdicts exclusively via `add_stamp` (SQLite), never by appending directly to the regenerated `REVIEWS.md` view.

### Why needed
Appending directly to `REVIEWS.md` bypasses the ACID source of truth (`state.sqlite`). When `verify_markdown_sync` runs, it overwrites manual additions to `REVIEWS.md` based on the database stamps. Extending the E-72 distributed-stamping pattern ensures all critics use the unified data pipeline.

### Constraints driving this decision
- **Single Source of Truth**: All state and verdicts must live in `state.sqlite`.

---

## D-041 — Memory Palace Scan-on-Sync Observability

**Date**: 2026-06-09
**Task**: P-43 (Self-Learning Activation Arc)
**Decision**: The scan-on-sync seam (`.ai/memory/palace-index.json`) is maintained purely as an observability artifact.

### Why needed
The memory palace generation (`E-145`) writes a candidate manifest on sync. We needed to decide if the `memory_curator` agent should be wired to read this manifest or re-scan independently.

### Constraints driving this decision
- **Race conditions**: The `memory_curator` is a background agent. Coupling it to a sync-written manifest creates temporal dependencies.
- **Sovereignty**: The background curator must remain sovereign. It will scan sources independently, ignoring the manifest to avoid race conditions.

---

## D-042 — Defer performance-mcp Server

**Date**: 2026-06-09
**Task**: E-149 (performance_engineer implementation)
**Decision**: Defer the creation of the dedicated `performance-mcp` server.

### Why needed
The blueprint called for a dedicated `performance-mcp` server. The Engineer successfully implemented the `performance_engineer` and `ai-profile` skill using the existing `code-execution-mcp` Docker sandbox without needing a dedicated MCP server.

### Constraints driving this decision
- **Complexity**: Minimizing the footprint of new MCP servers if existing sandboxes suffice. The `code-execution-mcp` already provides the necessary V8 profiling and isolation.

---

## D-043 — DB-Migration Substrate

**Date**: 2026-06-09
**Task**: E-150 (db_architect implementation)
**Decision**: Standardize on `node:sqlite` within the `db_architect`'s local execution context rather than introducing a dedicated database-migration MCP server.

### Why needed
The database integrity architecture requires robust schema alterations. By using the built-in `node:sqlite` driver in conjunction with the system's execution tools, we avoid the overhead of a dedicated server while maintaining full transactional (BEGIN/COMMIT) control and rollback capabilities.

### Constraints driving this decision
- **Dependency Minimization**: No new npm packages needed.
- **Transactional Safety**: Executing migrations as self-contained Node scripts ensures that the script halts safely on validation errors and executes the `DOWN` script within the same boundary.

---

## D-044 — Conditional MCP Server Connections for Test Import Safety

**Date**: 2026-06-09
**Task**: E-160 (Prevent test hang)
**Decision**: Wrap the top-level `server.connect()` and `StdioServerTransport` instantiation inside all custom MCP servers (especially `blueprint-aligner-mcp`) in an `isMain` detection check so that importing these modules in unit tests does not block waiting for stdin.

### Why needed
Unit tests like `blueprint_aligner_test.sh` import helper functions (e.g. `parseDiffByFile`, `isMarkdownFile`, `isTestHelperFile`) directly from the MCP server entry points (e.g., `src/mcp/blueprint-aligner-mcp/index.js`). Because the server connection was unconditionally established in the global module scope, importing the module started the StdioServerTransport, causing tests to hang indefinitely in interactive terminal sessions where stdin remains open.

### Constraints driving this decision
- **Test Suitability**: Test suites must run successfully in all environments (interactive terminals, CI, background run-command tasks) without hanging or requiring specific stdin redirection (like `< /dev/null`).
- **Zero Impact on Production**: The MCP servers must still function exactly as before when launched directly via `node`.

---

## D-045 — Resilient Agent/Skill Invocation and Auto-Decision Rules

**Date**: 2026-06-09
**Task**: E-161 / E-162 (Agent Invocation Robustness)
**Decision**: Standardize and write guidelines into CLAUDE.md / GEMINI.md for automatic, dynamic skill and agent selection. Instruct the models to dynamically choose:
1. Native Antigravity tools (like `invoke_subagent` and `define_subagent`) when running in the `agy` runtime.
2. Custom MCP-backed tools (`activate_agent`, `activate_skill`) when running in Claude Code or Gemini CLI.
3. Automatically evaluate and decide when to run a skill (procedural workflow) vs. delegate to an agent (persona).

### Why needed
When running under `agy` (Antigravity), standard MCP tools (from `context-invoker-mcp`) are not reliably exposed, leading to permission or missing-tool errors that terminate execution. Providing resilient instructions allows agents to use native `invoke_subagent` tools instead of falling back to failing MCP calls, while guiding them to automatically use these tools at appropriate times.

### Constraints driving this decision
- **Resilience**: The platform must survive missing MCP tools by using native primitives.
- **Autonomy**: The agents must take initiative in deciding when to run reviews, audits, preflights, and logs without requiring manual user commands.

---

## D-046 — Antigravity Subagent Execution Robustness

**Date**: 2026-06-10
**Task**: E-163, E-164, E-165
**Decision**: Resolve native subagent runtime failures under the `agy` provider by:
1. Harvesting all referenced `mcp__*` tools from agent instructions and frontmatter to populate the subagent's `toolNames` in `agent.json`.
2. Deduplicating duplicate `ai-os` plugin imports in `~/.gemini/config/import_manifest.json`.
3. Performing a synchronous, serialized Google OAuth token refresh check in the parent CLI bootloader preflight before concurrent subagents are spawned.

### Why needed
Custom subagents (like `critic_arch`) were failing with execution termination errors because:
- They lacked permission to call MCP tools (such as `add_stamp`) because the generator omitted `mcp__*` tools from the subagent's `toolNames` manifest.
- The `ai-os` plugin was registered twice in `import_manifest.json` (from both `local-install` and `antigravity`), causing runtime namespace collisions.
- Concurrent subagent spawns were racing to refresh expired OAuth tokens in `oauth_creds.json`, causing write collisions and authentication failures.

### Alternatives considered
1. **Direct credentials injection into the subagent sandbox**: Rejected because the subagent sandbox has strict path-traversal and file-writing restrictions, and injecting raw secrets violates security policies.
2. **Serializing subagent execution**: Rejected because it increases total execution time and limits parallel performance (like running critics in parallel).
3. **Synchronous pre-refresh + dynamic tool harvesting**: Selected because pre-refresh avoids races entirely, and dynamic tool harvesting allows critics to securely call their required stamp tools without wildcards.

### Constraints driving this decision
- **Security**: Subagents must follow least-privilege, and raw Google credentials must not be exposed to the sandbox.
- **Concurrency**: Parallel critics must be supported without file write race conditions.

### Impact
- Unlocks: `E-163`, `E-164`, `E-165` tasks.
- Risk if wrong: Race conditions could still occur if tokens expire mid-execution, but a 5-minute pre-expiry buffer mitigates this.

### Rollback
Remove the token refresh pre-check and revert to the static `toolNames` list in `plugin-builder.mjs`.

---

## D-047 — Ratify E-177 Cache Eviction Reinterpretation

**Date**: 2026-06-20
**Task**: E-177
**Decision**: Ratify the Engineer's reinterpretation of the cache eviction logic to evict stale blueprints (oldest-first, >7 days old) rather than task records, utilizing the 20,000 character threshold.

### Why needed
The original blueprint for `cache-manager-mcp` eviction incorrectly specified pruning "done task records" when the cache actually stores blueprints and schema, not task records. Additionally, the blueprint had conflicting thresholds (5k vs 20k characters). The Engineer resolved this by evicting stale blueprints at the 20k threshold. This decision formalizes and accepts the new logic.

### Alternatives considered
1. **Evict task records** — Rejected: Task records are not managed by `cache-manager-mcp`, making this impossible without major architectural shifts.
2. **Use 5,000 character threshold** — Rejected: 5k is too restrictive for modern context windows and would cause unnecessary cache churn. 20,000 characters balances context limits with JIT capabilities.
3. **Ratify Engineer's implementation (Chosen)** — Aligns with the true behavior of the cache payload and utilizes the more appropriate 20k threshold.

### Constraints driving this decision
- **Context Size Constraints**: System context prefix must stay within reasonable limits (<20k characters) to leave room for conversational context.
- **Data Model Truth**: `cache-manager-mcp` does not store task velocity or execution rows, it caches blueprints.

### Impact
- Unlocks: Closes the known risk regarding E-177 ratification.
- Risk if wrong: Stale or important blueprints might be evicted if untouched for >7 days. JIT loads will still retrieve them if explicitly requested, but baseline context will drop them.

### Rollback
Revert the compaction logic in `cache-manager-mcp` or override the `20000` character limit to a higher threshold.

---

## D-048 — Ratify E-179 Telemetry Classification Refinement

**Date**: 2026-06-21
**Task**: E-179
**Decision**: Ratify the Engineer's refinement to `mcp-telemetry.mjs` where expected tool rejections (e.g. validation failures) marked with `_meta.expected_rejection` are booked as `SUCCESS` rather than `ERROR`. This cleans up the false-positive "deprecation candidate" signal in `INSIGHTS.md`.

### Why needed
The telemetry analysis correctly identified several tools (like `add_topic_seed`, `validate_payload`) with high `isError` rates. However, audit revealed these were not system errors but expected user-level validation rejections. Treating them as `ERROR` pollutes the telemetry and incorrectly flags healthy tools for deprecation. The short-term fix (`_meta.expected_rejection` -> `SUCCESS`) restores signal purity without requiring an immediate database migration.

### Alternatives considered
1. **Immediate status-taxonomy migration (`REJECTED`)** — Rejected: Requires a full `telemetry.sqlite` schema migration and updates to the `meta_analyst` SQL queries. While architecturally correct, it was too large for the E-179 scope.
2. **Book as `SUCCESS` via marker (Chosen)** — Cleans up the `INSIGHTS.md` report immediately with minimal friction.
3. **Ignore false positives** — Rejected: Degrades trust in the automated insights.

### Constraints driving this decision
- **Scope limitation**: Avoided triggering a full database migration mid-audit to resolve the immediate false-positive issue.

### Impact
- Unlocks: Reliable deprecation candidate signals.
- Risk if wrong: Booking rejections as `SUCCESS` temporarily obscures usage-friction signals (i.e. tools that users frequently misuse but aren't technically broken).

### Rollback
Remove the `_meta.expected_rejection` check in `mcp-telemetry.mjs` to revert to booking all `isError` returns as `ERROR`.

---

## D-049 — Ratify E-180 Telemetry Schema Migration (REJECTED/TIMEOUT)

**Date**: 2026-06-25
**Task**: E-180
**Decision**: Ratify the formal database migration of `telemetry.sqlite` to introduce `REJECTED` and `TIMEOUT` as explicit statuses in the telemetry schema.

### Why needed
The E-179 refinement booked expected rejections as `SUCCESS` to stop false-positive alerts, but this obscured valid usage-friction signals. Migrating to an explicit `REJECTED` and `TIMEOUT` status allows the `meta_analyst` to cleanly separate actual code crashes (`ERROR`) from expected tool validation blocks (`REJECTED`) and hangs (`TIMEOUT`).

### Alternatives considered
1. **Keep booking as SUCCESS** — Rejected: Loses friction analytics and degrades meta-cognition accuracy.
2. **Execute DB migration to REJECTED/TIMEOUT (Chosen)** — Cleans up the taxonomy properly and restores visibility into friction without triggering false "deprecation" warnings.

### Constraints driving this decision
- **Visibility vs Noise**: We need to see user friction (when validation blocks them) without the `meta_analyst` flagging the tool as broken.

### Impact
- Unlocks: E-180 implementation.
- Risk if wrong: Migration scripts could lock the database temporarily; `db_architect` and `ai-migration` must handle it transactionally.

### Rollback
Run the `DOWN` migration script via `ai-migration` to revert the database schema to the original enum and restore `mcp-telemetry.mjs` logic.

---

## D-050 — Decouple Triad Persona from CLI Tools (ARCHITECT/ENGINEER)

**Date**: 2026-06-25
**Task**: P-44
**Decision**: Rename `GEMINI.md` to `ARCHITECT.md` and `CLAUDE.md` to `ENGINEER.md`. Update all CLI defaults to route `agy` to Architect and `claude` to Engineer by default, generalizing the Triad terminology.

### Why needed
Historically, the Architect role was strictly coupled to the Gemini CLI and the Engineer role to Claude Code. The provider abstraction (E-138) allowed other CLIs (like Antigravity `agy`) to act as either the Architect or Engineer, but the rule files and blueprints still hardcoded "Gemini" and "Claude". Since the Gemini CLI is being deprecated, maintaining rulefiles named `GEMINI.md` creates confusion. Generalizing to `ARCHITECT.md` and `ENGINEER.md` formalizes the Role Abstraction pattern cleanly.

### Alternatives considered
1. **Keep GEMINI.md/CLAUDE.md** — Rejected: Will become legacy tech debt once Gemini CLI is fully deprecated. Breaks abstraction.
2. **Rename to AGY.md/CLAUDE.md** — Rejected: Same issue, tightly couples the conceptual role (Architect) to the specific tool (`agy`).
3. **Decouple via ARCHITECT.md and ENGINEER.md (Chosen)** — Pure role-based architecture. Any provider (`agy`, `claude`) can assume any role seamlessly.

### Constraints driving this decision
- **Forward-compatibility**: Must support any provider assuming any role via `.ai/roles.json`.

### Impact
- Unlocks: E-183 (Rulefile Renaming and Codebase Update), E-184 (README update).
- Risk if wrong: Breaking changes to any external scripts hardcoding `GEMINI.md` or `CLAUDE.md`.

### Rollback
Revert file names and reverse the `src/bin/ai` and `install-ai-os.sh` default path lookups.

---

## D-051 — Ratify E-183 Shim Approach for Legacy CLI Loaders

**Date**: 2026-06-26
**Task**: P-45
**Decision**: Ratify the E-183 implementation of keeping `CLAUDE.md` and `GEMINI.md` as thin `@import` shims that load `ENGINEER.md` and `ARCHITECT.md`.

### Why needed
D-050 explicitly rejected keeping `CLAUDE.md` and `GEMINI.md` to avoid legacy tech debt. However, during the implementation of E-183, it was discovered that certain CLIs (like Claude Code) hardcode auto-loading of `CLAUDE.md`. Without a shim, the role bootstrap fails. Keeping them as thin `@import` shims bridges the gap until vendor CLIs allow configurable rulefile names.

### Alternatives considered
1. **Strict removal (D-050 original intent)** — Rejected: Breaks automatic role bootstrap for Claude Code and legacy Gemini CLI instances.
2. **Duplicating content** — Rejected: Creates documentation drift and violates DRY principles.
3. **Thin @import shims (Chosen)** — Retains the decoupling of the actual role content in `ENGINEER.md`/`ARCHITECT.md` while satisfying the hardcoded vendor auto-load requirements.

### Constraints driving this decision
- **CLI Vendor Hardcoding**: Vendor CLIs (Claude Code) currently hardcode `CLAUDE.md` and do not allow custom configuration for project-wide bootloader files.

### Impact
- Unlocks: Closes the unratified shim gap reported in `DIGEST.md`.
- Risk if wrong: Slightly more files in the root directory, but minimal maintenance burden since they only contain `@import` directives.

### Rollback
Remove the shim files when all used CLI providers support configurable role file names (e.g., via `.ai/roles.json` or CLI flags).

---

## D-052 — Retain Vendor-Named Provider Directories

**Date**: 2026-06-26
**Task**: P-47
**Decision**: Re-scope E-188 (Part 2) to cancel the rename of `src/gemini` and `src/claude` to `src/architect` and `src/engineer`. These directories will remain vendor-named (`gemini`, `claude`) as they contain provider-specific configurations and shims.

### Why needed
D-050 decoupled the *roles* (Architect/Engineer) from the *providers* (agy/Claude). However, the directories `src/gemini` and `src/claude` hold provider-specific CLI configurations (e.g., Gemini TOML settings) and the fallback shims ratified in D-051. Renaming these directories to role names (`src/architect`, `src/engineer`) introduces incoherence, as a role should not contain provider-specific configuration. By retaining vendor names for the directories, we clarify that they are *provider adapters*, not *role definitions*.

### Alternatives considered
1. **Rename to role names (E-188 Part 2 original plan)** — Rejected: Incoherent architecture. The Architect role now defaults to `agy`, so placing Gemini-specific config inside `src/architect` is incorrect.
2. **Move all configs into a generic `src/providers`** — Rejected: Excessive refactoring and test-breakage (~25 mirror-identity tests) for purely cosmetic gains.

### Constraints driving this decision
- **Provider-Role Decoupling**: Roles are conceptual; providers are the actual CLIs executing them. Configuration tailored to a specific CLI must remain grouped by that CLI's name.

### Impact
- Unlocks: Closes the blocked E-188 task. 
- Risk if wrong: Minor naming confusion if users mistake the provider directories for role logic, but this is mitigated by documentation.

### Rollback
If the vendor CLIs are fully deprecated, delete their respective `src/<provider>` directories entirely.

---

## [[D-053]] — Shell-Native State Mutation Exception (ai add-task / ai handoff)

**Date**: 2026-07-31
**Task**: E-198
**Decision**: Authorize the shell-native `ai add-task` (and existing `ai handoff`) primitives as an audited exception to MCP-Only State Mutation (structured-outputs.md §32).

### Why needed
The Architect persona (Antigravity `agy`) runs shell reliably but does not dependably expose project MCP servers during invocation. Enforcing strict MCP-Only State Mutation caused task creation from the shell to fail and drop tasks silently since they never hit `state.sqlite`. Creating a shell-native primitive wraps the existing SQLite write paths (`add_task` logic) without requiring an MCP connection.

### Constraints driving this decision
- **Resilience**: The Architect must be able to persist tasks to `state.sqlite` even when the `task-synchronizer-mcp` is unreachable over the transport layer.
- **Single Source of Truth**: The `ai add-task` command strictly writes to `state.sqlite`, preserving the ACID guarantees established for state mutation.

### Impact
- Unlocks: E-198 implementation. Resolves incidents Antigravity:ORPHANED_BLUEPRINT and task-synchronizer:architect-tasks-not-persisted-to-state.

### Rollback
Deprecate the `ai add-task` command and enforce MCP-only routing if/when Antigravity natively supports stable local MCP tool execution for all project servers.
---

## [[D-054]] — Same-Provider Triad (All-Claude) Is a Supported Topology; Role Binding Is Per-Pane

**Date**: 2026-09-04
**Task**: E-208, E-209, E-210, E-211 (Engineer findings handoff of 2026-09-04 21:14 UTC, COMM.md)
**Decision**: Ratify the same-provider Triad (both `architect` and `engineer` on `claude`, distinct tmux panes, optionally distinct models) as a supported topology, and rule that **role identity is bound per pane at launch — never per project**. The binding surface is a single launcher, `ai pane <role>`, that (1) mints the E-129 HMAC role token for that role, (2) sets `AI_OS_CALLER_ROLE` for that pane, (3) injects the role's canonical rulefile as the governing persona, and (4) pins the tmux pane title to the role name. `role-abstraction.md §Same-Provider Triad` and `interactive-bridge.md §Pane Resolution Precedence` are amended to match.

### Why needed
D-050 decoupled persona from vendor and `role-abstraction.md` already *claims* the dual-Claude case, but the Engineer's live evaluation (COMM.md 2026-09-04) shows the claim is not wired end-to-end: G1 `CLAUDE.md` always imports `ENGINEER.md`; G2 `.claude/settings.json` bakes `AI_OS_CALLER_ROLE=engineer` and `session-start.sh engineer` project-wide, so both panes are Engineers to the enforcement layer; G3 `resolve_pane` Pass 2 fuzzy title match fires before the roles.json ordinal and swallowed an Architect handoff into the Engineer pane twice; G4 `advisor-mcp` hardcodes `agy`. The blueprint is ahead of the implementation — a divergence the Architect must reconcile, not the Engineer.

### Alternatives considered
1. **Reject the topology; revert `.ai/roles.json` to `agy:1`** — rejected. The user needs it (agy auth lapses, and the Architect benefits from a stronger model); D-050's whole point was provider independence, and the blueprint already promises this case.
2. **Role-aware `CLAUDE.md` shim that branches on the role** — rejected. `@import` is static; the shim cannot branch. Rewriting the shim into a role-neutral "read the stamp" preamble would strip the Engineer's rulefile from the default pane and weaken the documented D-051 shim contract.
3. **Two project settings files, one per role, selected via `claude --settings`** — accepted as the *mechanism for the settings layer*, but rejected as the *sole* binding: `--settings` merges hooks rather than replacing them, so both `session-start.sh engineer` (project) and `session-start.sh architect` (per-role file) would mint tokens for the same session id with undefined ordering. The launch-time role must therefore be a single authoritative input consumed by the hook (see Constraints).
4. **Per-pane launcher `ai pane <role>` + launch-time role input + role-precedence clause in both rulefiles** — chosen. Symmetric to `ai handoff <role>` / `ai add-task` (D-053): the shell primitive is the provider-agnostic surface; every provider adapter maps it to its own argv.

### Constraints driving this decision
- **Security (E-129 token remains authoritative)**: the HMAC token is the enforcement surface; the env var stays advisory. The role the hook mints is `${AI_OS_PANE_ROLE:-$1}`. `AI_OS_PANE_ROLE` is set only in the *launch* environment of the CLI process by `ai pane` and is read by the SessionStart hook before any agent tool call executes. This is within the E-129 threat model: E-129 protects against **in-session** mutation from a Bash subprocess reaching the gate, and launch-time environment is exactly as trusted as the settings file on disk. The positional default (`engineer`) is unchanged for the plain `claude` launch path.
- **Sovereignty must be enforced, not just prompted, in the Architect pane**: the pre-tool-use gate currently matches `Bash` only. With a Claude Architect, `Write`/`Edit` outside `.ai/` and `plans/` must be blocked by the hook when the minted role is `architect` (Tier 3 — this is the ANTI-DRIFT §35 enforcement layer).
- **Persona precedence is explicit**: both `ENGINEER.md` and `ARCHITECT.md` gain a leading *Role Resolution* clause: when the session context carries an `[AI_OS_ROLE] <role>` stamp (emitted by the SessionStart hook) naming a different role, that role's rulefile governs and this file is inert. `CLAUDE.md` keeps importing `ENGINEER.md` (D-051 unchanged); the Architect pane additionally receives `ARCHITECT.md` via `--append-system-prompt-file`.
- **Deterministic routing**: explicit configuration beats heuristics. When `.ai/roles.json` maps the requested semantic role, `resolve_pane` order becomes exact-title → roles.json ordinal → fuzzy title → window name. `ai pane` pins the pane title so Pass 1 wins deterministically; the ordinal is the safety net; fuzzy passes are last-resort only.
- **Provider-aware A2A bridge**: `advisor-mcp::ask_architect` resolves the executable and argv from `roles.json architect.provider` through the Provider Adapter Registry (`providers.json` gains a `print_mode` argv template). A `claude` Architect child must be launched with `ARCHITECT.md` appended and `CLAUDECODE` unset from the child env (nested-session guard), read-only (`-p`, no permission bypass).
- **Legacy provider targets (`claude`, `gemini`) are deprecated**: warn on use; when both roles resolve to the same provider the target is ambiguous and MUST fail closed with a hint to use `architect`/`engineer`. Removal scheduled for v4.0.
- **Optional per-role model**: `roles.json` role entries MAY carry `"model"`; `ai pane` forwards it to the provider's model flag. Absent → provider default.

### Impact
- Unlocks: E-208 (per-pane role binding + `ai pane` launcher + Write/Edit sovereignty gate + Role Resolution clause), E-209 (`resolve_pane` precedence), E-210 (provider-aware `advisor-mcp`), E-211 (legacy target deprecation + same-provider ambiguity guard).
- Interim rule (until E-208 ships): a dual-Claude Triad is prompt-level only. Operators MUST pin pane titles (`tmux select-pane -T architect` / `-T engineer`) and MUST NOT rely on the enforcement layer to stop the Architect pane from writing `src/`. `.ai/roles.json` (`architect.provider: claude`) is retained and committed with this decision.
- Risk if wrong: if `claude --settings` precedence or the launch-env read proves unreliable, the Architect pane silently keeps Engineer write rights. Mitigated by E-208 acceptance criteria requiring a live negative test (Architect pane `Write` to `src/` → BLOCKED) before DONE.

### Rollback
Revert `.ai/roles.json` to `architect: agy:1`, delete the `ai pane` launcher and the per-role settings file, restore the `session-start.sh engineer` positional-only mint, and restore the E-117 resolution order. The Role Resolution clause in the rulefiles is inert when no stamp is present, so it may stay.

---

---

## [[D-055]] — D-054 Sprint Residuals: Six Rulings (write-gate scope, skill collisions, cache contract, Git Lane residuals, mint guard, D-053 status)

**Date**: 2026-09-07
**Task**: E-216, E-217, E-218 (Engineer handoff 2026-09-07 12:03 UTC, COMM.md)
**Decision**: Rule on the six open questions left by the shipped D-054 sprint (E-208..E-215, master 8af653e). R1 widen by policy; R2 rename the Architect copies; R3 accept; R4 accept three residuals and fund the fourth; R5 accept as documented; R6 already closed.

### R1 — Architect write gate: WIDEN (by policy surface, not by claiming parser completeness)
Gap G2 is narrowed, not closed: shell writes and MCP write tools bypass the E-208 gate. Ruling:
1. **MCP write channel** — the Architect overlay (`.claude/settings.architect.json`) gains `permissions.deny` for every filesystem-mutating MCP tool: `mcp__filesystem__write_file`, `edit_file`, `move_file`, `create_directory`, `mcp__patch-mcp__patch_file`, `mcp__propose-patch-mcp__confirm_patch`, `mcp__propose-patch-mcp__propose_patch`. Deterministic, zero parser work. The Architect edits `.ai/` with the native `Write`/`Edit` tools, which the gate already scopes.
2. **Shell write channel** — `analyzeSovereignty` gains a **write-redirect policy** for `caller_role=architect`: any output redirection (`>`, `>>`, `|& tee`, `tee`) or file-mutating utility (`cp`, `mv`, `install`, `ln`, `sed -i`, `perl -i`, `rsync`, `dd`, `truncate`, `git apply`, `patch`) whose resolved target lies outside `.ai/` or `plans/` → `[SOVEREIGNTY_BLOCK]`. **Inline interpreters** (`python3 -c`, `node -e`, `perl -e`, `ruby -e`, `bash -c`, `sh -c`, `eval`) and heredoc-fed interpreters are BLOCKED outright for the architect role — their targets are unresolvable, and the Architect has no legitimate need for them (hint: use `Write`/`Edit`). Fail-closed on any unparsable target.
3. The gate's documented guarantee becomes: "native write tools + MCP write tools + recognised shell write forms"; the code comments and tests keep stating the residual (exotic encodings, `git` plumbing such as `update-index`/`hash-object`, editors launched interactively).

### R2 — Skill-name collision: RENAME the Architect copies (E-149 precedent)
`ai-task` and `repo-oracle` in `src/agents/skills` become **`arch-task`** and **`arch-oracle`** (the same pattern that turned the Architect's `ai-review` into `arch-review`). `ARCHITECT.md`, `task-planner`, `blueprint-writer`, `_INDEX`, and any P-## lifecycle text are updated. After the rename the multi-role workspace must contain **zero** collisions; the E-212 collision guard is retained as a permanent invariant and is promoted from a warning to a **non-zero `ai sync` exit** in a multi-role workspace (a single-role workspace keeps role-overrides-shared, unchanged). Role-scoped skill directories were rejected: the host loads one flat directory per provider, so a directory-level fix would be a host-specific fork of the discovery contract.

### R3 — E-126 cache-rollback contract: ACCEPT the change
`AI_OS_DISABLE_CACHE=1` suppresses the compiled context blob only. The `[AI_OS_ROLE]` stamp is role binding (D-054), not caching, and MUST survive a caching rollback — otherwise a cache toggle silently reopens G1. Recorded in `role-abstraction.md §Same-Provider Triad` Component 2.

### R4 — T-GITLANE-001 residuals: ACCEPT 1–3, FUND 4
- Accept **1** (`--amend` index↔HEAD~ gap): undetectable from inside `pre-commit`; a partial detector on a sovereignty gate is worse than a stated gap.
- Accept **2** (record selected by an unauthenticated session id): same ceiling as `mintToken`; impact bounded to adding a restriction or waiving a diff that is already in scope.
- Accept **3** (`--no-verify`, `merge`, `cherry-pick`): inherent to git, pre-existing for Gate 2 as a whole.
- **Fund 4**: the stamp waiver is granted **only** when the role comes from the verified session record (`safe-exec --verify-role`). The `AI_OS_PANE_ROLE` / `AI_OS_CALLER_ROLE` fallbacks may drive the **restrictive** outcome (path-scope BLOCK) but never the waiver. A `.ai/`-only commit from an unverified session keeps the full `[CRITIC_STAMP]` requirement. Together with the existing E-100/E-113 REVIEWS.md hand-edit checks this closes the "bookkeeping commit without a stamp" path.

### R5 — Mint guard is partial: ACCEPT as documented
The guard prevents *changing* a valid binding; it does not prevent delete-and-remint. Deleting the record from an Architect pane is already gated by the E-102 `rm` sovereignty block, so the residual requires an actor with unrestricted shell — who is outside every AI-OS gate anyway. Binding the record to a process start-time / boot-id, or an append-only ledger, is deferred to the backlog (no E-## now); `THREAT_MODEL.md` already states the ceiling.

### R6 — D-053 + structured-outputs.md §32: ALREADY CLOSED
D-053 was ratified 2026-07-31 (`DECISIONS.md` line "[[D-053]]") and §32 carries the `ai add-task` / `ai handoff` exception. The Engineer's item is stale; the `DIGEST.md` Known Risk that still says "pending D-053" is corrected with this decision.

### Alternatives considered
1. **R1: accept the write gate as advisory** — rejected; §35 enforcement at the gate is the whole point of D-054's Tier 3 acceptance, and the two uncovered channels are the cheapest ones for a drifting Architect to reach.
2. **R1: full shell parser with path resolution for every utility** — rejected as unbounded; the policy surface above blocks the reachable forms and states the rest.
3. **R2: role-scoped skill directories** — rejected (host contract, see R2).
4. **R4: fix `--amend` with a best-effort detector** — rejected (false confidence on a sovereignty gate).

### Constraints driving this decision
- Sovereignty must be enforced by gates, not prompts (D-054). Every gate must state its residual plainly; tests must fail if a stronger claim is reinserted (E-208 precedent).
- No host-specific forks of the skill-discovery contract (one flat directory per provider).

### Impact
- Unlocks: E-216 (R1, Tier 3), E-217 (R2 rename + collision invariant + the `seo_engineer.md` frontmatter fix, Tier 2), E-218 (R4.4 verified-record-only waiver, Tier 2).
- Risk if wrong: R1's interpreter block could hamper an Architect that legitimately needs a one-liner to read state — mitigated: reads are unaffected (only write forms and inline interpreters are blocked) and `.ai/` reads have MCP equivalents.

### Rollback
`AI_OS_SOVEREIGNTY_LOCK=0` disables the widened shell policy; remove the overlay deny rules; rename the skills back; `AI_OS_SKIP_GIT_LANE=1` for the waiver rule. R3/R5/R6 are documentation-only.

---

---

## [[D-056]] — Write-Gate Widening Freeze; patch-mcp Fail-Closed Role; Manifest-Scoped Sync Pruning

**Date**: 2026-09-07
**Task**: E-219, E-220 (Engineer handoff 2026-09-07 15:14 UTC; E-216..E-218 on branch `engineer/e216-e218-writegate-hardening`)
**Decision**: (R3) Freeze further widening of the Architect shell write gate at the E-216 three-layer shape and adopt the fixture corpus as the gate's contract; (R1) make `patch-mcp`'s role guard derive the role from the verified session record and fail closed; (R2) let `ai sync` prune only skills it provably wrote and that were never modified, via a sync manifest.

### R3 — Widening freeze (the over-block ratio is the governing constraint)
The E-216 review needed seven rounds for eleven findings, and **five of the eleven were over-blocks** — legitimate Architect work refused: prose with `->` written into `.ai/`, `> /dev/null`, `awk '$1 > 5'`, and `sed -i .ai/n && git diff`. Every finding was one invariant broken: text already classified as DATA re-read as SYNTAX. An over-block on a sovereignty gate is not a safe failure; it is a broken Architect that will route around the gate. Ruling:
- **No further widening of the shell layer.** The listed residual (exotic encodings, git plumbing, interactive editors, MCP proxying beyond the denied names, `find -delete` / `-exec rm`, awk `-f` program files) is ACCEPTED. The Git Lane is the last checkpoint for anything that slips through, and that is the intended layering.
- **The fixture corpus is the contract.** `tests/fixtures/arch-write-cases.json` (argv-passed; READ forms asserted as positives beside the write forms they resemble) is the specification of `architect-writes.mjs`. Any change to the analyser MUST add cases in both directions, and a change that turns a READ positive into a block is a regression, not a hardening.
- **Over-blocks outrank under-blocks in review ordering** for this gate (the auditor weighting the Engineer adopted from round 4 becomes the rule).

### R1 — `patch-mcp` role guard: FUND, fail closed (T-PATCHMCP-001)
`roleGuard()` allows unless the caller volunteers `caller_role`; with the overlay `permissions.deny` absent (it is settings-file config, the layer most likely to be missing), a default-open guard is the only barrier. Ruling: the role is derived server-side in this order — (1) the verified session record via `safe-exec --verify-role` using the harness session id; (2) the server's spawn-frozen `AI_OS_CALLER_ROLE` env (the E-129 per-server pattern); (3) **no evidence → treat as `architect`** (restrictive default: writes confined to `.ai/` and `plans/`). A self-reported `caller_role` can only *add* restriction, never lift it. A properly installed Engineer session always has a record (the SessionStart hook mints one), so the restrictive default cannot strand a legitimate Engineer. Same rule applies to `propose-patch-mcp::confirm_patch`.

### R2 — Stale skills after a rename: prune by manifest only
`ai sync` is additive; the E-217 rename left `ai-task` / `repo-oracle` in `.agents/skills` (harmless today, agy serves no role). Blind pruning could delete a user-authored skill, so: `ai sync` writes `_SYNC_MANIFEST.json` in each target skill/agent dir recording every path it wrote with a content hash. On the next sync a path is deleted **only if** it is in the manifest, its hash still equals what sync wrote (unmodified since), and it is no longer in the source set. Anything absent from the manifest or modified is never touched and is reported as `orphan (kept)`. First run after this ships has no manifest, so nothing is pruned; a `--prune-known` flag deletes an orphan that is byte-identical to a current canonical skill under another name (the E-217 leftovers qualify) so the migration does not need hand deletion.

### Alternatives considered
1. **R3: keep widening the shell layer toward completeness** — rejected; the measured over-block ratio shows each increment costs Architect usability faster than it buys coverage, and the Git Lane already backstops.
2. **R1: fail open with a warning when no record exists** — rejected; that is the current gap restated.
3. **R2: prune everything not in the source set** — rejected; deletes user-authored skills. **R2: never prune** — rejected; every rename leaves permanent residue in every workspace.

### Constraints driving this decision
- A sovereignty gate that blocks ordinary role work is a defect of the same severity as a bypass (D-054 §35 enforcement must be usable to be real).
- Restrictive defaults when evidence is missing (D-055 R4 pattern), never permissive ones.
- Sync must remain safe to run in any workspace, including ones with user-authored skills (E-201 lesson: never touch what you did not write).

### Impact
- Unlocks: E-219 (R1, Tier 3, `security_engineer`), E-220 (R2, Tier 2). R3 is documentation only.
- Risk if wrong: R1's restrictive default could block a host that never mints a record and never sets the per-server env — that host is not an installed AI-OS provider; `AI_OS_SOVEREIGNTY_LOCK=0` remains the escape hatch.

### Rollback
R1: `AI_OS_SOVEREIGNTY_LOCK=0` restores the legacy guard. R2: delete `_SYNC_MANIFEST.json` files; sync reverts to additive-only. R3: a later decision may lift the freeze only with a fixture-corpus delta showing zero new over-blocks.

---

---

## [[D-057]] — Project-Boundary Binding for Pending Patches; Review-Gate Traversal Policy; Install-First Helper Locators

**Date**: 2026-09-07
**Task**: E-221, E-222, E-223 (Engineer handoff 2026-09-07, E-219/E-220 complete)
**Decision**: (1) Fund T-PROPOSEPATCH-001: a pending patch is bound to the project that proposed it and re-validated at confirm time. (2) Change `run_review`'s PATH_TRAVERSAL check from a flat `../` regex to a context-aware policy that recognises script-relative locators. (3) Every hook and shell locator resolves helpers install-first; the dev tree is consulted only when the current repo IS the framework clone. (4) Name the D-054..D-056 shared helpers in `architect.md §4` so the aligner stops reporting them as orphaned work.

### 1 — T-PROPOSEPATCH-001: FUND (E-221, Tier 3)
`propose_patch` stores an absolute path resolved against the proposing cwd; `confirm_patch` writes to it without re-running `safePath` against its own cwd. Ruling: a pending record carries `project_root` (the proposer's `safePath` base) and a **project-relative** path, never an absolute one. `confirm_patch` re-derives its own project root, requires equality with the stored one (`[PROJECT_MISMATCH]` otherwise), re-runs `safePath` on the relative path against its own cwd, and re-derives the role (E-219) — every check is repeated at confirm time because the confirming process is a different process. Legacy pending records with an absolute path are rejected with a hint to re-propose. Same shape for any future two-phase write.

### 2 — Review-gate PATH_TRAVERSAL: POLICY CHANGE (E-222, Tier 2)
The check fires P0 on any added line containing `../`, which matches the ordinary script-relative locator pattern (`${self_dir}/../shared/x.mjs`, `resolve(__dirname, "../shared")`, `dirname "$0"`) present at several sites in `src/bin/ai`; the Engineer removed a legitimate `..` to pass. A review gate that blocks the codebase's own idiom trains people to route around it (the D-056 over-block lesson, applied to reviews). Ruling: keep P0 for `/etc/`, `/root/`, and for `../` that appears in **runtime path handling** (string concatenation with a request/argument value, `path.join`/`resolve` whose first argument is not a script anchor). Downgrade to **P1 advisory** when the `../` is anchored to a script-relative base (`__dirname`, `import.meta.url`, `self_dir`, `$0`, `BASH_SOURCE`, `AIOS`/`HOME`-rooted mirrors). The anchor list lives in one place with fixture cases in both directions (positive: the four `src/bin/ai` locators; negative: `join(req.path, "../")`). The HARDCODED_SECRET check keeps its shape (no reported over-blocks).

### 3 — Helper locators: INSTALL-FIRST (E-223, Tier 3)
E-220 found three `git rev-parse --show-toplevel` locators in `src/bin/ai` that resolved the USER's repo, so any project containing `src/shared/<helper>.mjs` would have that file executed with trusted stdout. The same pattern exists in all six `hooks/*.sh` (safe-exec, cache-manager locators). Ruling: locator order is **`~/.ai-os` install mirror first**; the dev tree (`<toplevel>/src/...`) is consulted **only when the current repo is the framework clone** — determined by `AIOS_WORKSPACE` equalling the toplevel, or the toplevel's `package.json` name being the framework package. A downstream project can never supply a helper. One shared resolver (`ai-os-locate`, shell function + `.mjs` twin) replaces the per-site chains; the dogfooding path for this repo is preserved by the clone check.

### 4 — Orphaned work: NAME THE HELPERS
`architect.md §4` gains one bullet, "Sovereignty & provisioning helpers", listing `architect-writes.mjs`, `caller-role.mjs`, `provider-adapter.mjs`, `role-manifest.mjs`, `sync-manifest.mjs` and pointing to `role-abstraction.md` / `architect-provider-parity.md`. The parity blueprint gets a matching "Shared helpers" section. This is the aligner's contract; adding a shared helper without naming it there is the divergence, not the helper.

### Alternatives considered
1. **(1) Re-run `safePath` only, without binding the project** — rejected; a path that is in-scope for the confirmer but outside the proposer's project silently lands in the wrong project.
2. **(2) Delete the traversal check** — rejected; the `/etc/` / `/root/` and runtime-concatenation cases are real. **(2) Keep P0 and allowlist file names** — rejected; the idiom is not file-specific.
3. **(3) Keep dev-tree-first and add a checksum** — rejected; the install mirror is already the trusted copy, and a checksum adds a second trust root.

### Constraints driving this decision
- Two-phase operations re-validate everything in phase two (D-055 R4 / E-219 pattern).
- Gates must not block the codebase's own idioms (D-056 R3).
- Executable helpers are trusted only from the install root; a project tree is data (E-201 lesson generalised).

### Impact
- Unlocks: E-221 (T3, `security_engineer`), E-222 (T2), E-223 (T3, `security_engineer`).
- Risk if wrong: (3) breaks dogfooding if the clone check misfires — mitigated by the `AIOS_WORKSPACE` equality path and a `AI_OS_LOCATE_DEV=1` escape hatch for framework development only.

### Rollback
(1) Accept legacy absolute records with `AI_OS_PATCH_LEGACY=1`. (2) `AI_OS_REVIEW_STRICT_TRAVERSAL=1` restores the flat regex. (3) `AI_OS_LOCATE_DEV=1` restores dev-tree-first. (4) documentation only.

---

---

## [[D-058]] — Locator Class Closure in Skills; Executable-Markdown Policy; Project-Bound Read-Only Patch Tools; argv Rollback Ratified; Tier 3 Acceptance = Threat Property

**Date**: 2026-09-07
**Task**: E-225, E-226, E-224 (Engineer handoff 2026-09-07, E-221..E-223 complete)
**Decision**: (§1) Ratify the E-223 deviation: the dev-tree rollback is `ai --dev-tree` (argv), and D-057 §3's `AI_OS_LOCATE_DEV=1` sentence is superseded. (§2) Fund closure of T-LOCATOR-001 in the skills and make "no cwd-relative framework execution in any markdown" a standards-checker rule. (§3) `run_review` grades markdown by executability, not by extension. (§4) Fund T-PROPOSEPATCH-002: the read-only patch tools are project-bound. (§5) Tier 3 acceptance is the threat entry's property; pre-authorised in-boundary widening replaces a re-filing round trip.

### §1 — D-057 §3 deviation: RATIFIED
An environment variable cannot be the rollback for an env-borne attack: a project's `.claude/settings.json` `env` block is inherited by hooks and is written by `ai init`, so env is attacker-supplied at the same capability level as the repo. `ai --dev-tree` (argv) carries the same capability and cannot be supplied by a settings file. The hooks' own `AI_OS_LOCATE_UNTRUSTED_ENV=1` and the installer-written workspace file are the trust roots. D-057 §3's rollback sentence is superseded by this section; the parity blueprint's helper table is amended.

### §2 — T-LOCATOR-001 in skills: FUND (E-225, Tier 3) + standards rule
Four `SKILL.md` files (and their `.claude/`/`.agents/` mirrors) execute framework helpers cwd-relative, one of them an auto-executed `!` line in `ai-preflight`, which every session runs. Ruling: every executable line in a skill or agent file resolves helpers through the installed resolver — `. "${HOME}/.ai-os/shared/locate.sh"` with `AI_OS_LOCATE_UNTRUSTED_ENV=1`, then `ai_os_locate <helper>` — and never through a cwd-relative or repo-relative path. The E-80 standards checker gains a rule: any `!`-prefixed line or executable fenced block in `src/**/SKILL.md` / `src/**/agents/*.md` that references `src/` or `./` for execution is a FAIL. The `ai-preflight` line is fixed first and mirrored byte-identically.

### §3 — Documentation vs executable markdown: GRADE BY EXECUTABILITY (E-224, Tier 2)
`run_review` currently grades prose in `DECISIONS.md` as code (the D-057 text quoting `join(req.path, "../")` trips P0), while a blanket `.md` skip would blind the gate to the `!` lines from §2. Ruling — one classifier, shared by the review gate and the §2 standards rule:
- **Executable markdown lines** = `!`-prefixed lines in skill/agent files, and lines inside fenced blocks whose tag is an executable language (`bash`, `sh`, `zsh`, `js`, `mjs`, `javascript`, `python`, `node`). These are graded as code (P0 PATH_TRAVERSAL rules apply, including the E-222 anchor exemptions).
- **Everything else in markdown** (prose, untagged/`text`/`json`/`md` fences, inline code) is documentation: PATH_TRAVERSAL does not fire; HARDCODED_SECRET still fires (a pasted credential in a doc is a leak regardless of context).
- `.ai/DECISIONS.md`, `COMM.md`, `LOG.md`, `DIGEST.md`, `THREAT_MODEL.md` and `.ai/blueprints/*.md` contain no executable lines by construction; a `!`-line appearing there is itself a FAIL.

### §4 — T-PROPOSEPATCH-002: FUND (E-226, Tier 2)
`preview_patch` reads the stored path to build a baseline; `list_pending_patches` and `reject_patch` operate on rows from any project. Ruling: all three derive the target from `project_root` + `rel_path` and require project equality with their own root. On mismatch: `preview_patch` renders the stored diff only (no file read, banner `[FOREIGN_PROJECT] baseline not shown`), `reject_patch` refuses (`[PROJECT_MISMATCH]`), `list_pending_patches` shows only own-project rows by default and, with `all: true`, foreign rows as id + `rel_path` + `project_root` basename only — never an absolute path. Legacy rows (no `project_root`) are listed as `legacy`, never read.

### §5 — Tier 3 acceptance = the threat property (process ruling)
Three of E-223's five audit rounds found holes the fix introduced; both Tier 3 rulings' stated scope was "the easy half", and the signed-off property was still false after implementing the ruling exactly. Ruling: a Tier 3 task is DONE when the **property named in its THREAT_MODEL entry** holds under the negative test, not when the ruling's letter is implemented. When implementing the letter leaves the property false, the Engineer is **pre-authorised to widen within the same boundary files and the same threat entry**, reporting the widening in the handoff; only new files, new tools or a new threat class require filing. The ruling gives the shape; the threat entry gives the property.

### Alternatives considered
1. **§1: keep the env rollback and document the risk** — rejected; a documented hole in a fail-closed gate is still a hole.
2. **§3: skip `.md` entirely (as the coverage check does)** — rejected; blinds the gate to auto-executed lines. **§3: grade all `.md` as code** — rejected; the Architect's decision log would need to avoid quoting attack patterns.
3. **§4: fold into E-221** — rejected at the time by the Engineer, correctly; D-057 §1 scoped the read-only tools as unchanged.
4. **§5: keep strict letter-of-ruling scope** — rejected; it cost two extra Tier 3 rounds per task while the property was measurably false.

### Constraints driving this decision
- Env is untrusted wherever a project can write a settings file (T-LOCATOR-001 audit).
- Gates must not block the project's own documentation idiom (D-056 R3, D-057 §2 lineage).
- Two-phase and read-only tools re-validate against their own project (D-057 §1 pattern).

### Impact
- Unlocks: E-225 (T3, `security_engineer`), E-226 (T2), E-224 (T2). Execution order E-224 → E-225 → E-226 so the classifier exists before the standards rule that uses it.
- Risk if wrong: §2 breaks skills on a host with no `~/.ai-os` install — acceptable, that host has no framework either; the skill prints "(helper unavailable)" as today.

### Rollback
§1 none (argv only). §2 revert the four SKILL.md lines; the standards rule is gated by `AI_OS_STANDARDS_SKIP=skill-locator`. §3 `AI_OS_REVIEW_STRICT_TRAVERSAL=1` (already exists) grades all lines as code. §4 `AI_OS_PATCH_LEGACY=1` restores unbounded reads. §5 process only.

---

---

## [[D-059]] — `ai start`: One-Command Triad Launcher (tmux layout + role panes + watcher)

**Date**: 2026-09-09
**Task**: E-227, E-228 (user request 2026-09-09)
**Decision**: Add `ai start` to the `ai` bootloader as a **bridge-level lifecycle command**: it creates (or reuses) the project's tmux session/window, lays out the panes from `.ai/roles.json`, launches each role with `ai pane <role>`, and runs `ai watch` in a dedicated pane — so the operator never opens panes by hand. The command composes existing primitives only; it introduces no new provider, state, or routing logic.

### Why needed
D-054 bound roles per pane (`ai pane`), E-209 made routing deterministic when titles are pinned, and `ai watch` drives the ping-pong loop — but the operator still has to open three panes, run three commands, and get the pane ORDER right (the roles.json `pane_identifier` is an ordinal among agent panes, so a wrong split order silently misroutes). `ai start` makes the supported topology the default experience.

### Design (cli-collapse.md §`ai start`)
- **Composition only**: the launcher executes exactly two things it does not own — `ai pane <role>` and `ai watch` — both from the installed `ai` on PATH. Never a project-supplied script.
- **Layout is derived, not configured**: the role with the lower `pane_identifier` gets the lower tmux `pane_index`, so the ordinal fallback (E-209 step 2) agrees with the layout by construction. Default `triad` layout = engineer left (full height), architect right-top, watcher right-bottom. The watcher pane runs a shell script, which `_is_agent_cmd` excludes, so it never shifts the ordinals.
- **Shell-hosted panes**: agent panes are interactive shells that receive `ai pane <role>` via `send-keys` — when the provider exits the operator keeps a shell and can rerun `ai pane` (a `split-window 'cmd'` pane would close). `ai pane` pins the title and disables window auto-rename (E-209 Pass 1 stays deterministic).
- **Idempotent**: a second `ai start` in a project with live panes re-pins titles, starts the watcher only if none holds the single-writer lock, and attaches — it never duplicates panes. `--kill` tears the project's window down (watcher first).
- **Optional config `.ai/start.json`** (`session`, `layout`, `watch`, `sizes`) with constrained values (session name `^[A-Za-z0-9_-]{1,32}$`, sizes numeric percentages); absent file = defaults (`session: aios`, window = project basename).
- **Non-tmux hosts**: exit 2 with the manual three-command recipe printed (cli-collapse.md: tmux is the recommended UX, not a hard requirement).

### Alternatives considered
1. **A `~/.tmux.conf` snippet / tmuxinator profile** (the cli-collapse "Tmux Documentation" idea) — rejected as the primary path: it cannot read `roles.json`, so pane order and role binding drift from the configuration the router trusts.
2. **Launching providers directly from `split-window`** — rejected: the pane dies with the provider, and `ai pane`'s binding/title logic would be duplicated.
3. **Do it inside `ai pane` (auto-split when run in a fresh window)** — rejected: `ai pane` binds THIS pane and must stay side-effect-free beyond it (E-208 audit surface).

### Constraints driving this decision
- cli-collapse.md limits the bootloader to lifecycle/diagnostic commands. `ai start` IS lifecycle (it starts the Triad); the command set is now explicitly: `init`, `sync`, `install`, `doctor`, `uninstall`, `start`, plus the D-053/D-054 shell primitives `handoff`, `add-task`, `pane`, `watch`.
- No new state: layout comes from `roles.json`; the watcher's existing mkdir lock prevents double injection.
- Values read from `.ai/start.json` become tmux arguments, so they are validated like `providers.json` provider names (E-208 audit lesson).

### Impact
- Unlocks: E-227 (launcher, Tier 2), E-228 (`--status`/`--kill`, doctor line, docs + installer hint, Tier 1).
- Risk if wrong: a layout that disagrees with the ordinal would misroute handoffs — mitigated by deriving the layout from `pane_identifier` and asserting the resulting pane order in tests.

### Rollback
Remove the `start` dispatch; the three manual commands (`ai pane engineer`, `ai pane architect`, `ai watch`) keep working unchanged.

---

---

## [[D-060]] — D-058 §3 Extensions Ratified; CI Funded; Operand Re-tokenisation; Skill Consent Rule; Manifest Gitignore

**Date**: 2026-09-09
**Task**: E-230, E-231, E-232, E-233 (Engineer handoff 2026-09-08, delivered 2026-09-09 after the watcher restart; E-224..E-226 complete)
**Decision**: Ratify the three narrow extensions the Engineer made beyond D-058 §3's letter (they are the same over-block invariant applied to non-markdown text); fund CI because three sprints in a row had nowhere to "verify on CI"; fund the recursive re-tokenisation of interpreter operands under the D-056 over-block guard; rule that auto-executed skill lines may never run a project-supplied program; gitignore the E-220 sync manifests.

### Extensions RATIFIED (all three; they become part of the E-222/E-224 anchor contract)
1. **`.ai/state.json` exact-path allowlist.** Task descriptions are stored verbatim, so a `../` written into a task text lands in a committed file and blocks the next commit. Exact path, not a `.json` rule — `package.json` scripts genuinely carry paths that matter. Ratified as written.
2. **ES module specifiers are script-relative anchors.** `import … from "../x.mjs"`, `export … from`, dynamic `import("../")` and `require("../")` resolve against the importing module by definition. Added to the E-222 anchor list; the E-224 wiring commit tripping on its own import line is the proof.
3. **Whole-line comments are documentation.** A `//` or `#` line cannot execute; the E-222 fixture that asserted "prose → P0" with a comment as its example was wrong about its own intent and is corrected.
Rule for the future: an over-block of the codebase's own idiom found while implementing a ruling is an in-boundary widening under D-058 §5 — fix narrowly, add fixtures both ways, report. This handoff did exactly that.

### §1 — CI: EXISTS AND IS RED — FIX IT (E-230, Tier 2, `ci_gate`)
The Engineer's finding "no CI configuration in this repository" is **wrong**: `.github/workflows/test.yml` ("AI-OS Tests") runs `install-ai-os.sh` + `tests/run.sh` on `ubuntu-latest` / Node 22 on every push and pull request, and `.ai/DEVOPS.md` documents it. What is true is worse: the last three completed runs on `master` (2026-09-07 ×2, 2026-09-09) **failed**, and nobody read them — local 4117/0 was reported as the verification while CI was red. Ruling: E-230 is re-scoped from "add CI" to (a) find out why the Engineer's check missed `.github/` (cwd or glob error — record it), (b) make the workflow green on `master` (the Linux/GNU-patch run IS the E-221 verification; add a `patch --version` line to the log), (c) add the `node:test` unit layer as a second job and a README badge, (d) **process rule**: an E-## is not DONE until the CI run for its merge commit is green — `ai-task` surfaces the `gh run` status for the current HEAD before marking DONE. `ci_gate` documents the change in `DEVOPS.md`. The registered E-230 description carries the false "no CI" premise; this section is authoritative.

### §2 — T-LOCATOR-001 known-uncaught operands: FUND (E-231, Tier 2)
`bash -c "node src/bin/ai"`, `eval`, `xargs`, pipe-fed and heredoc-fed interpreters hide the execution from the E-225 rule. Ruling: re-tokenise the operand recursively. The auditor's warning is adopted as the constraint: this is the change most likely to resurrect an over-block, so fixtures in both directions come BEFORE the widening, and any new over-block is a regression (D-056 R3).

### §3 — Skill consent: RULE
An auto-executed `!`-line runs because the skill was loaded, not because the agent chose to. Two skills run the visited project's own `tests/run.sh` that way. Ruling: a `!`-line may only run framework helpers through the installed resolver, or read-only inspection commands. It may NEVER execute a project-supplied program (`tests/run.sh`, `npm run`, `make`, `scripts/*`, `./…`). Running project code is an explicit numbered step the agent performs after loading. The E-80 standards checker enforces it with the E-224 classifier. → E-232 (Tier 2).

### §4 — `_SYNC_MANIFEST.json`: GITIGNORE
Generated per-workspace state, same class as `_SKILLS_INDEX.md`. `ai init`/`ai sync` add the pattern to a project's `.gitignore` idempotently. → E-233 (Tier 1).

### Merge state
All four previously stacked branches are merged: `origin/master` is at `6b8e5f8` (E-224..E-226 plus the flake fixes). Nothing pending on the user.

### Alternatives considered
1. **CI: keep asking "verify on CI" without CI** — rejected; a verification step with nowhere to run is a false checkbox. **CI: Docker-based local sandbox instead** — rejected as the primary path; Docker has been down for two sprints and CI is the reproducible Linux/GNU environment anyway.
2. **§3: allow `!`-lines to run project tests when a `.ai/` opt-in flag exists** — rejected; consent belongs to the agent's explicit action at that moment, not to a config bit set once.
3. **§2: leave the operand class as a documented residual** — rejected; it is the same class the E-225 rule exists for, only wrapped.

### Constraints driving this decision
- Over-blocks outrank under-blocks on every gate touching the codebase's own idiom (D-056 R3, D-057 §2, D-058 §3).
- Auto-executed lines have no consent step; their capability must be bounded by rule, not by review (T-LOCATOR-001 lineage).
- Verification claims must name an environment that exists.

### Impact
- Unlocks: E-230 (T2), E-231 (T2), E-232 (T2), E-233 (T1). Order: E-233 → E-230 → E-232 → E-231 (cheap hygiene, then the environment, then the consent rule, then the riskiest widening last with CI in place).
- Risk if wrong: E-231 over-blocks a skill's legitimate `bash -c` — mitigated by fixtures-first and the regression rule.

### Rollback
§1 delete the workflow. §2 `AI_OS_STANDARDS_SKIP=operand-retokenise`. §3 revert the two SKILL.md edits; rule gated by `AI_OS_STANDARDS_SKIP=skill-consent`. §4 remove the `.gitignore` lines. Extensions: `AI_OS_REVIEW_STRICT_TRAVERSAL=1` grades everything as code.

---

---

## [[D-061]] — Program-Position Rule for Operand Walks; E-231/E-232 Divergences Ratified; Install, Test-Policy and Hot-Module Follow-ups

**Date**: 2026-09-09
**Task**: E-234, E-235, E-236, E-237 (Engineer handoff 2026-09-09 18:05 UTC; E-227..E-233 complete, master `892f06c`, CI green)
**Decision**: (§1) Ratify both implementation notes: the consent rule is a denylist of EXECUTION shapes ("execution, not mention"), and operand re-tokenisation is capped at depth 1 with the residual asserted. (§2) Resolve the `memory_curator` over-block by a **program-position rule**: only tokens in program position are walked as programs; everything else is an argument. (§3) Move the Playwright browser download out of the default install path. (§4) Add an environment-dependence check to the test review policy plus a skip helper. (§5) Long-running MCP servers reload policy modules on mtime change.

### §1 — Divergences: RATIFIED
1. **Denylist of execution shapes.** D-060 §3's "may only (a)… or (b)…" stated intent; an allowlist mechanism would reject every ordinary `git`/`grep` context line. The line is EXECUTION of a project-supplied program, not mention of one: `npm run` blocked, `npm audit` allowed. Ratified as the rule's definition.
2. **Depth cap 1.** `bash -c "bash -c \"…\""` is asserted as uncaught. A nested wrapper inside a skill file is itself a smell the reviewer sees; ratified.

### §2 — Program-position rule (E-234, Tier 2)
`memory_curator.md:178-179` is blocked because `.ai/memory/dlq.json` — the DATA argument of `--dlq-show` — is walked as if it were a program. The Engineer correctly declined to change the rule's core alone. Ruling: within a command segment, a token is in **program position** only when it is (a) the segment head; (b) the first non-option operand after an interpreter (`node`, `bash`, `sh`, `zsh`, `python*`, `perl`, `ruby`, `deno`, `bun`); or (c) the operand following a wrapper that restarts program position (`-c`, `eval`, `exec`, `xargs`, `env`, `sudo`, `nohup`, `time`, `command`, `source`/`.`). Every other token is an **argument** and is not walked. Independently, tokens with a data-typed extension (`.json`, `.md`, `.txt`, `.yml`/`.yaml`, `.sqlite`, `.ndjson`, `.csv`, `.log`) are never programs in any position. Consequences, stated: `bash tests/run.sh src/bin/ai` stays caught (b); `node "${AIOS}/shared/x.mjs" tests/run.sh` is NOT flagged — the framework helper, not the skill line, decides what it does with its argument, and that helper is already install-resolved (E-223/E-225). Fixtures in both directions come first (D-056 R3), including the six `memory_curator` hits as positives-for-allow.

### §3 — Playwright download out of the default path (E-235, Tier 2, `ci_gate`)
`install-ai-os.sh` → `do_mcp_setup` downloads Chromium for `vibe-check-mcp` unbounded; it ran over an hour locally and never finished. Ruling: the default install does NOT download browsers. `ai mcp-setup --browsers` (explicit) or the first `vibe-check` invocation (prompting, bounded by a timeout) does. CI installs browsers in an explicit, cached step so the vibe suites still run there.

### §4 — Environment-dependence review check (E-236, Tier 1)
Three tests this sprint passed on a developer Mac and failed on CI (mirror byte-identity, an unpruned `node_modules` corpus scan, an ambient tmux server). Ruling: the `ai-review` skill and the `critic_tests` agent gain a standing question — "does this assertion depend on what the running machine happens to have?" — and `tests/lib/assert.sh` gains `skip_unless_cmd` / `skip_unless_env` helpers that record a SKIP rather than a false PASS/FAIL. `test-harness-isolation.md` records the rule.

### §5 — Hot policy modules in long-running servers (E-237, Tier 1)
`orchestrator-mcp` kept grading with a stale `traversal-policy.mjs` for a whole session after the mirror changed, so `run_review` cried wolf on every review. Ruling: policy modules (`traversal-policy`, `markdown-exec`, `architect-writes`, `caller-role`) are loaded through one `loadPolicy(name)` helper that re-imports on mtime change (cache-busting `import()` query) — the E-229 pattern applied to MCP. `ai sync` prints which running servers hold stale modules until reload.

### Alternatives considered
1. **§2: stop the walk at the first operand** — rejected; `bash tests/run.sh src/bin/ai`-style chains and wrapper tokens must still restart the walk. **§2: allowlist `.ai/memory/*` paths** — rejected; file-specific, does not fix the class.
2. **§3: keep the download and add a timeout only** — rejected; a timeout on a required step is a flaky install.
3. **§5: restart servers after sync** — rejected as the only path; the harness does not restart MCP servers, and the operator cannot see which one is stale.

### Constraints driving this decision
- Over-blocks outrank under-blocks on gates touching the codebase's own idiom (D-056 R3 lineage).
- A rule's mechanism may differ from a ruling's phrasing when the phrasing was intent; the divergence note is the contract (D-058 §5).
- Verification must run where the property is claimed (D-060 §1).

### Impact
- Unlocks: E-234 (T2), E-235 (T2), E-236 (T1), E-237 (T1). Order: E-234 → E-237 → E-236 → E-235.
- Risk if wrong: §2 under-flags a project script smuggled as an argument to a framework helper — accepted; the helper is install-resolved and reviewed.

### Rollback
§2 `AI_OS_STANDARDS_SKIP=program-position` restores the full walk. §3 `AI_OS_INSTALL_BROWSERS=1` restores the download in install. §4 process + helper only. §5 `AI_OS_POLICY_HOT_RELOAD=0`.

---

---

## [[D-062]] — Program Position Closes on Resolution (Ratified); Host-Relative Performance Budgets; No-Stash Bookkeeping + Conflict-Marker Gate

**Date**: 2026-09-09
**Task**: E-239, E-238 (Engineer handoff 2026-09-09 20:10 UTC; E-234..E-237 complete, master `56348c4`, CI green)
**Decision**: (§1) Ratify the E-234 resolution: program position closes only when an operand actually resolves the program. (§2) Performance budgets are host-relative: an absolute wall-clock budget is enforced only on the reference machine (CI); everywhere else the same test asserts a ratio to a measured baseline on that host. (§3) Bookkeeping never moves between branches by `git stash`; the pre-commit gate rejects conflict markers in any staged file and rejects a `.ai/state.json` that does not parse.

### §1 — Program position: RATIFIED as resolved
D-061 §2's two acceptance cases did pull against each other under a literal reading. The Engineer's resolution is the correct generalisation: program position stays OPEN while the operand does not say what runs — an unreadable variable (`node "$HELPER" …`) or an allowlisted entrypoint (`bash tests/run.sh …`) — and CLOSES on the first operand that resolves the program. That is why `--dlq-show .ai/memory/dlq.json` is an argument (the program resolved at `memory-worker-pool.mjs`) while `bash tests/run.sh src/bin/ai` is still caught. Ratified; the parity blueprint row is amended to this wording.

### §2 — Performance budgets: HOST-RELATIVE (E-239, Tier 2)
Two suites assert absolute budgets ("under 200ms", "hook warm-path under 250ms") that fail on a machine where `node -e 'process.exit(0)'` alone costs ~197ms, and pass on CI. Verified against clean master in a worktree, so it is a policy gap, not sprint fallout: it is the E-236 category one step further — not what the machine has but how fast it is — and neither E-236 remedy fits (nothing to supply; skipping hides a real regression). Ruling:
- Every performance assertion names its **baseline** — a trivial operation of the same kind measured on the same host in the same run (a bare `node` spawn for spawn-bound paths; a no-op hook for hook paths).
- On the **reference machine** (`CI=true`, ubuntu-latest) the absolute budget is enforced as today.
- Elsewhere the test asserts `elapsed ≤ k × baseline + slack` with `k` and `slack` declared next to the budget (defaults `k=2`, `slack=50ms`), so a genuine regression still fails locally while a slow host does not.
- The harness prints both numbers on every run (baseline, elapsed), so a budget failure carries its own evidence (the instrumentation lesson from this sprint).
- An absolute budget with no baseline is a `critic_tests` finding.

### §3 — No-stash bookkeeping + conflict-marker gate (E-238, Tier 2, `git-hooks.md`)
A conflicted `git stash pop` left conflict markers in `.ai/state.json`; they were staged and committed to master without the file being opened, and master carried invalid JSON until the next fix. The two real CI failures that exposed it were nearly dismissed as environmental. Ruling:
- **Rule**: `.ai/` bookkeeping moves between branches by commit + cherry-pick (or a bookkeeping-only commit on the target branch), never by stash. `ENGINEER.md` Core Rules and the `commit-crafter` skill state it.
- **Gate**: `hooks/pre-commit.sh` rejects any staged file containing a conflict marker at line start (`<<<<<<< `, `=======` between them, `>>>>>>> `) and rejects a staged `.ai/state.json` (or any `.ai/*.json`) that does not parse. Both are cheap, deterministic, and would have blocked `44243bc`.
- **Triage rule** (from the near-miss): after a run of environmental failures, a new CI failure is presumed REAL until its log is read — the E-236 question is asked of the failure, never assumed.

### Alternatives considered
1. **§2: skip performance tests off-CI** — rejected; a regression would then only surface after merge. **§2: raise the absolute budgets** — rejected; they would be wrong on the next slower or faster host.
2. **§3: a `git stash` wrapper that warns** — rejected; the gate on the committed content is the checkpoint that matters, and stash is not the only way to stage a conflicted file.

### Constraints driving this decision
- Tests must state what they require of the machine (D-061 §4); speed is a requirement like any other.
- Machine state files (`state.json`) are validated at the boundary where they enter history, not trusted from a tool's exit message.
- Evidence printed beats reasoning remembered (the sprint's own lesson).

### Impact
- Unlocks: E-239 (T2), E-238 (T2). Order: E-238 → E-239.
- Risk if wrong: §2's ratio could pass a slow-but-regressed path on a very fast host — the CI absolute budget catches that case.

### Rollback
§2 `AI_OS_PERF_ABSOLUTE=1` enforces absolute budgets everywhere. §3 `AI_OS_SKIP_CONFLICT_GATE=1`.

---

---

## [[D-063]] — Baselines Include the Instrument (Ratified); Leaked External State Is the Third Environment Dependence

**Date**: 2026-09-09
**Task**: E-240 (Engineer handoff 2026-09-09 21:40 UTC; E-238/E-239 complete, master `bf28ec7`, CI green 4471/0)
**Decision**: (§1) Ratify the E-239 strengthening and generalise it: a performance baseline must include the assertion's own measuring instrument. (§2) "What a previous run left behind" is the third variety of environment dependence after "what the machine has" (E-236) and "how fast it is" (E-239); every suite that creates external state registers cleanup in an EXIT trap before creating it, and the runner sweeps and reports leftovers.

### §1 — Baselines include the instrument: RATIFIED, generalised
D-062 §2 said "a no-op hook" for hook paths. The telemetry assertion's window is dominated by the two `node -e Date.now` calls it uses as a clock, so a bare-hook baseline would flatter it by ignoring its own instrument. The Engineer's `2 × node-spawn + no-op hook` is the correct reading and becomes the rule: **the baseline is the same operation kind PLUS whatever the assertion itself spends to measure it.** A baseline that omits the instrument is a `critic_tests` finding, same as a missing baseline. The literal reading is not wanted.

### §2 — Leaked external state (E-240, Tier 2)
The `ai start` suites leaked 50 tmux servers on one machine: the socket name used `$$` (recycled), and a FAILING assertion skipped the cleanup line, so leaks occurred only when something was already wrong — the worst shape, because the leak compounds the failure that caused it. Fixed at the cause; nothing sweeps generally. Ruling:
- **Register before create.** Any suite that creates external state (tmux servers/sockets, temp dirs outside the per-test sandbox, background processes, lock dirs, `~/.ai-os` mirror writes, `.ai/signal.json` entries) registers its cleanup in an `EXIT` trap BEFORE creating the state; cleanup never depends on reaching a later line. Names come from `mktemp` entropy, never from `$$`.
- **The runner sweeps.** `tests/run.sh` snapshots the inventory of known external-state kinds before the run and diffs after: tmux servers matching the test socket prefix, processes whose argv names the test sandbox, lock dirs under `.ai/`, and temp dirs under the harness root. Leftovers are reported as `LEAKED n <kind>` per suite and fail the run on CI (the reference machine must stay clean); locally they are reported and cleaned with `--sweep`.
- **Standing review question #3** in `critic_tests` / `ai-review`: "what does this test leave behind when an assertion fails halfway?" — alongside "what the machine has" and "how fast it is".
- `test-harness-isolation.md` records all three varieties together.

### Alternatives considered
1. **§1: keep the literal no-op-hook baseline** — rejected; it measured a smaller thing than the assertion did and would have passed a regression in the instrument itself.
2. **§2: rely on each suite's own trap** — rejected as the only path; the incident was a suite that believed it cleaned up. **§2: run every suite in a throwaway VM/container** — rejected for now; Docker is down and CI already is the clean reference; the sweep is cheap and works everywhere.

### Constraints driving this decision
- Evidence printed beats reasoning remembered (D-062): the sweep prints what leaked, per suite, every run.
- A cleanup that runs only on success is not cleanup.
- The reference machine (CI) must start and end clean, or its green is not believable (D-060 §1).

### Impact
- Unlocks: E-240 (T2).
- Risk if wrong: the sweep itself could kill a developer's unrelated tmux server — mitigated by matching only the test socket prefix and sandbox-named processes, never by age or count.

### Rollback
§1 none (test-policy wording). §2 `AI_OS_TEST_NO_SWEEP=1` disables the runner sweep; traps remain.

---

---

## [[D-064]] — EXIT-Trap Chaining in the Harness; Subshell-State Is Review Question #4

**Date**: 2026-09-10
**Task**: E-241 (Engineer handoff 2026-09-09 21:40+ UTC; E-240 complete, master `2a926c8`, CI 4498/0, full run 4501/0 with zero leaks)
**Decision**: (§1) Close the trap-replacement limitation at the cause: the harness chains `EXIT` handlers so a suite's own `trap … EXIT` can no longer replace the cleanup trap, raw `trap … EXIT` in a suite becomes a standards finding, and the 46 existing sites are converted mechanically to `on_exit`. (§2) Institutionalise the subshell-state pattern as standing review question #4 and as an engineering-standards rule: a helper that sets state for its caller is never invoked inside a command substitution.

### §1 — Trap chaining (E-241, Tier 2)
A suite that installs `trap … EXIT` after sourcing `assert.sh` replaces the `register_cleanup` trap; the runner sweep is the backstop, so nothing leaks past the run, but 46 suites are not fixed at the cause. Ruling, both halves:
- **Harness chains.** `assert.sh` shadows the `trap` builtin for the `EXIT` signal only: `trap <cmd> EXIT` appends `<cmd>` to the cleanup registry instead of replacing the handler; every other signal and every other argument shape passes straight to `builtin trap`. Zero suite changes are required for correctness on day one. The registry runs handlers LIFO, each in its own `( … )` so one failing cleanup cannot skip the next, and the harness prints `CLEANUP n handlers` on exit so the evidence is visible.
- **Suites converge.** `on_exit <cmd>` is the documented spelling; a new E-80 standards rule (`tests/**` scope) flags a raw `trap … EXIT` as a P1 finding, and the 46 existing sites are converted in the same task with a mechanical rewrite — the shadow makes the conversion a no-op behaviourally, so the risk is confined to the rewrite's syntax.
- The sweep stays as the backstop; `LEAKED` must remain zero after the conversion (that is the acceptance evidence).

### §2 — Subshell state: review question #4 + standards rule
Three times in two sprints a helper was called as `$(helper …)` and the state it set evaporated (E-239's baseline cache, the E-240 cleanup registry, `_self_stamp`'s output capture). Each was caught by an assertion written for another reason — the system working — and the recurrence is the signal. Ruling:
- **Standing review question #4** (`critic_tests`, `ai-review`, `ai-debug`): "Is this helper ever called inside a command substitution, a pipeline, or a `while read` loop, and does it set state that must outlive that call?"
- **Engineering-standards rule**: a shell helper returns DATA on stdout and sets STATE only in the caller's shell — never both. A helper that must set state is invoked as a plain command and returns data via `printf -v` / a nameref, or the state is recomputed by the caller from the data. The reason is written at each site, as the Engineer already does.
- No lint is funded now: the shape is too idiomatic to grade mechanically without an over-block (D-056 R3); the question plus the rule is the proportionate response. Revisit if a fourth incident occurs.

### Alternatives considered
1. **§1: convert the 46 suites only, no shadow** — rejected; the next suite to write a raw trap reintroduces the hole, and the sweep would again be the only defence.
2. **§1: shadow only, no conversion** — rejected; two spellings for one concept is the kind of drift the standards checker exists to prevent.
3. **§2: a shellcheck-style lint for `$(…)` around state-setting helpers** — rejected for now (over-block risk); question + rule first.

### Constraints driving this decision
- Fix at the cause, keep the backstop (D-063 §2).
- A gate that blocks the codebase's own idiom is a defect (D-056 R3) — hence question-not-lint for §2.
- Evidence printed: `CLEANUP n handlers` and `LEAKED 0` are the proof, not the reasoning.

### Impact
- Unlocks: E-241 (T2).
- Risk if wrong: shadowing `trap` surprises a suite that relies on REPLACING a handler — mitigated: only `EXIT` is chained, `builtin trap - EXIT` still clears, and the shadow is documented in `assert.sh`'s header.

### Rollback
§1 `AI_OS_TEST_NO_TRAP_CHAIN=1` restores the plain builtin (suites already converted to `on_exit` keep working). §2 process only.

---

---

## [[D-065]] — Suppressions Are Explicit Markers, Exemptions Are By Name; §35 Self-Report Closed; Fixture-First for Gate Code

**Date**: 2026-09-10
**Task**: none (Engineer handoff 2026-09-10; E-241 complete, master `9362e2b`, CI 4514/0, `LEAKED 0`, 43 `CLEANUP` lines local and CI agreeing)
**Decision**: (§1) Ratify the E-241 choice and make it policy for every standards rule: a false positive is silenced by an explicit, greppable in-file marker (`# standards:allow-<rule>`), never by loosening the pattern; a file that legitimately falls outside a rule is exempted BY NAME in the rule's config, never by narrowing the rule's scope. (§2) The self-reported §35 violation (a duplicate section appended to an Architect-owned blueprint, caught and reverted before it shipped) is closed with no remediation task; the standing rule "read before write on any Architect-owned file, especially one the handoff says was just updated" is recorded. (§3) Code that enforces a rule — standards rules, hooks, harness primitives — is written fixture-first: the failing fixture exists before the implementation, and the fixture runs on both bash 3.2 and CI's bash before the rule is considered green.

### §1 — Suppression and exemption policy
A heredoc that WRITES a `trap … EXIT` line is data, not an installation, and no pattern distinguishes the two. Loosening the regex would quietly reduce what the rule catches everywhere; a marker keeps every suppression visible to `grep` and to review. Likewise `tests/run.sh` (traps `EXIT INT TERM` without sourcing the registry) is exempted by name, so `tests/lib` stays in scope. Ratified and generalised: every E-80 rule supports `# standards:allow-<rule_id>` on the flagged line or the line above, the checker reports the count of active suppressions per rule in its summary (so a growing count is itself visible), and per-file exemptions live in `standards.json` next to the rule they exempt, with a one-line reason.

### §2 — §35 self-report
The Engineer appended a duplicate subshell-state section to `engineering-standards.md` while syncing mirrors, caught it during the sync, and reverted it; the file's committed diff is the Architect's alone (verified: one `## Subshell State` heading). The failure was writing before reading a file the handoff had said was already updated. Closed: the self-report is the system working, no task. Rule recorded in `ENGINEER.md` Core Rules via the next Engineer edit of that file: before touching any `.ai/` file named in the current handoff, read it first; the handoff is the notice, not the permission.

### §3 — Fixture-first for gate code
Four defects in E-241 were each caught by a fixture and none by reasoning: the shadow swallowed the library's own trap; a `BASHPID` guard absent in bash 3.2 would have behaved differently on macOS than on CI (the environment-dependence class inside the code enforcing it); an acceptance fixture ran in a subshell and tested the opposite case; the rule flagged its own heredoc. Across D-062–D-064 the ratio has not shifted. Ruling: for gate code the failing fixture is written before the implementation, the fixture asserts the property on both the local shell and CI's shell before the rule is called green, and a review of gate code asks first "which fixture would have caught this?" rather than "is the logic right?". This is the D-058 §5 property rule applied to the tools that enforce properties.

### Alternatives considered
1. **§1: loosen the regex for the heredoc case** — rejected (silent reduction in coverage). **§1: narrow the rule's scope to exclude `tests/run.sh`'s directory** — rejected (loses `tests/lib`).
2. **§2: a remediation E-## for the reverted edit** — rejected; nothing shipped, and the report itself is the desired behaviour.
3. **§3: a mechanical bash-3.2 compatibility lint** — deferred; the fixture-on-both-shells rule covers it without an over-block risk.

### Constraints driving this decision
- Coverage reductions must be visible (greppable markers, counted suppressions).
- Architect-owned files are read before written (E-201, this incident).
- Evidence before theory (D-062/D-063): gate code is only as good as the fixture that fails without it.

### Impact
- No E-## registered; the Engineer queue is empty and no work is pending. The §1 marker-count summary and the §2 ENGINEER.md line ride along with the next task that touches the standards checker or the rulefile.
- Risk if wrong: markers could accumulate unnoticed — mitigated by the per-rule suppression count in every checker run.

### Rollback
Policy only; nothing to roll back.

---

---

## [[D-066]] — All-Claude Triad Becomes the Default Topology (Architect on Fable, Engineer on Opus); Overlay Path Fix; Project Cleanup Sprint

**Date**: 2026-09-10
**Task**: E-242, E-243, E-244, E-245, E-246 (user request 2026-09-10)
**Decision**: (§1) The framework DEFAULT topology is the all-Claude Triad — `architect = claude:1` on model `fable`, `engineer = claude:0` on model `opus` — superseding D-050's `agy` default. `agy` and `gemini` remain fully supported providers (D-052 adapters stay), selected by `roles.json` or the `--architect/--engineer` install flags. (§2) The `ai start` failure "Settings file not found: .claude/settings.architect.json" is a path-resolution defect: the overlay is referenced cwd-relative; it becomes absolute and `ai pane` self-heals a missing overlay. (§3) `ai init`/`ai install`/`ai sync` banners and every owner/footer label derive from `roles.json` (provider AND model), never from a vendor literal. (§4) Workspace directories are generated only for providers that serve a role; unmapped provider workspaces are reported by `ai doctor` and removed only by an explicit `ai sync --prune-providers`. (§5) Repo hygiene and a v3.1.0 release close the D-054→D-066 series.

### Why needed
This project already runs both roles on Claude (D-054). The user hit `Error: Settings file not found: .claude/settings.architect.json` from `ai start`, `ai init` still announces an `agy` Architect, `roles.json` carried no model so both panes ran the same model, and the repo accumulated agy/gemini workspace residue (`.gemini/`, `.agents/`), a stray tracked file named `bash` containing a shell error, an untracked `.DS_Store`, a Gemini-era plan, and 124 task rows in `TASKS.md`.

### §1 — Default topology
- `src/templates/roles.json` and `_write_roles_json` defaults: `architect: {provider: claude, pane_identifier: "1", model: "fable"}`, `engineer: {provider: claude, pane_identifier: "0", model: "opus"}`. Model values are the CLI's aliases (`fable`, `opus`, `sonnet`) or a full model id; `ai pane` forwards `--model` (already wired, E-208).
- Rulefile headers: `ARCHITECT.md` "defaults to the `agy` provider" → "defaults to the `claude` provider (model `fable`)"; `ENGINEER.md` §35 redirect text names the Architect by role, not by `agy`. `GEMINI.md`/`CLAUDE.md` shims stay (D-051).
- This project's `.ai/roles.json` now carries the models (Architect edit, this decision).

### §2 — Overlay path defect (E-242)
`provider-adapter.mjs` emits `--settings .claude/settings.{role}.json` relative to the process cwd; any pane whose shell does not start in the project root (rc-file `cd`, a pre-existing session, a subdirectory launch) fails at the CLI. Ruling: the resolver substitutes an ABSOLUTE path rooted at the `.ai/` parent; `ai pane` generates a missing overlay from `roles.json` before exec (same code path as `ai sync`, idempotent), and `ai start` verifies each role's overlay before sending keys. Regression tests launch from a subdirectory and from a cwd outside the project.

### §3 — Banners and labels derive from roles.json (E-243)
`ai init`/`ai install`/`ai sync` print `Architect (claude · fable)` / `Engineer (claude · opus)` from the mapping; the legacy `'Architect (Agy)'` owner-regex (`src/bin/ai` ~1657), the `Agy (Architect)` footer (~1927), and any remaining vendor literal in user-facing text are replaced by role-derived labels. README and CONTRIBUTING describe the all-Claude default with `agy`/`gemini` as alternative providers.

### §4 — Provider workspace hygiene (E-244)
`ai sync` provisions `.claude/`, `.agents/`, `.gemini/` only for providers mapped in `roles.json` (plus `.claude/` whenever the hooks need it). `ai doctor` reports an unmapped provider's workspace as `stale provider workspace`; `ai sync --prune-providers` removes it, manifest-aware (E-220), never silently. `src/agents`, `src/gemini` adapters stay (D-052). In this repo `.gemini/` and `.agents/` are removed by that flag once it exists.

### §5 — Hygiene + release (E-245, E-246)
Remove the tracked stray `bash` file; gitignore `.DS_Store` and `testsprite_tests/tmp/`; archive DONE tasks out of `TASKS.md` (`archive_done_tasks`, state stays intact); `plans/agentic_upgrades_phase2.md` (Gemini-era, `better-sqlite3`) moved to `plans/archive/` by the Architect. Then `release-manager` cuts **v3.1.0** with a CHANGELOG aggregating D-054→D-066 / E-208→E-246.

### Alternatives considered
1. **Keep `agy` as the default and document the override** — rejected; the default should be the topology the maintainer runs and the one the gates were hardened for.
2. **Fix the overlay error by documenting "run ai sync first"** — rejected; the path is wrong for any cwd, and doctor already knew the file was missing — the launcher must not hand the failure to the CLI.
3. **Delete `src/gemini`/`src/agents`** — rejected (D-052); only unmapped workspace copies go, and only explicitly.

### Constraints driving this decision
- Provider-agnostic by configuration (D-050/D-052): defaults change, adapters stay.
- No vendor literal in user-facing text; labels derive from `roles.json` (D-054 lineage, E-213).
- Nothing is deleted silently (E-220 manifest discipline).

### Impact
- Unlocks: E-242 (T2), E-243 (T2), E-244 (T2), E-245 (T1), E-246 (T1 release, last). Order: E-242 → E-243 → E-244 → E-245 → E-246.
- Risk if wrong: a downstream project still mapped to `agy` sees no change (its `roles.json` wins); a fresh install gets the all-Claude default and needs only `claude` on PATH.

### Rollback
`ai install --architect agy:1 --engineer claude:0` restores the D-050 mapping per project; the template default can be reverted in one commit. §2 is a pure fix.

---

---

## [[D-067]] — Restore `ai sync`'s Dead Half; Strip Only for Gemini; Booted-Build Staleness Is Announced, Not Hot-Reloaded; Suppression Counts; Empty-Corpus Guard

**Date**: 2026-09-10
**Task**: E-247, E-248, E-249, E-250, E-251 (Engineer handoff 2026-09-10; D-066 sprint complete, v3.1.0 tagged, master `dded03d`)
**Decision**: Four deliberately-unfixed defects are ruled and funded, plus the fifth harness variety. (§1) `do_sync`'s unreachable second half is restored step-by-step under fail-open guards with a reachability test. (§2) `strip_gemini_agent_fields` is a Gemini-provider adapter step and runs only when producing a `.gemini/` workspace — never on the install mirror. (§3) A running MCP server announces the build it booted with; `ai sync`/install report stale running servers; task completion requires install + restart evidence when server or CLI code changed; the state projector is NOT hot-reloaded. (§4) D-065's suppression-count summary ships as its own task. (§5) A rule-scanning suite fails when its corpus is empty. Also ratified: the E-244 reversal of E-212's keep-unserved-workspace behaviour, and recording 3.0.0 as missing rather than reconstructing it.

### §1 — `do_sync` second half (E-247, Tier 2, `bug-reproducer` first)
Since E-217's early `return 0`, hook install, doc regeneration, the WAL checkpoint, REPO_MAP, the Memory Palace index, the E-233 gitignore and the E-237 policy report have not run on `ai sync`; the command never prints "Done." and a trial restore exits 1 under `set -e`. Ruling: restore the block one step at a time, each step wrapped so a failure prints `sync: <step> skipped — <reason>` and continues (fail-open, as every step was designed); `ai sync` ends with a step summary and the literal `Done.`; a reachability test asserts every named step's marker appears in the output of a full sync in a temp project, and a second test asserts the summary line is present on the happy path. The early return is replaced by the collision-guard's own error branch only.

### §2 — Frontmatter strip (E-248, Tier 2)
The strip exists because the Gemini CLI rejects Claude-only frontmatter keys. Running it on the install mirror means E-212 provisioning copies stripped files into `.claude/agents/`, so a Claude Architect loses `allowed-tools`, `user-invocable`, `disable-model-invocation` — degrading the D-066 default. Ruling: the mirror is canonical and untouched; the strip is applied only to the copy written into a `.gemini/` workspace when `gemini` serves a role. Re-install after the fix; a test asserts the three keys survive in `.claude/agents/*.md` after `ai sync` under the default mapping, and are absent only in a `.gemini/` copy.

### §3 — Booted-build staleness (E-249, Tier 2)
ESM caches modules for the process lifetime; the task synchroniser served the pre-E-245 projector and stripped the archive pointer on every write. E-237 hot-reloads the four POLICY modules, and its staleness notice lives inside the dead code of §1. Ruling, three parts and one refusal:
- Every MCP server records its **booted build** (source mtime + short hash of its entry file and `src/mcp/shared/*`) at startup and returns it in `_meta.booted_build` on every tool result; `verify_markdown_sync`, `run_preflight` and `ai doctor` compare it with the mirror and emit `[STALE_SERVER] <name> booted <ts>, mirror changed <ts> — restart required`.
- `ai sync` and `install-ai-os.sh` print the same list at the end (the E-237 notice, reachable again via §1).
- **Task completion gate**: `ai-task` refuses to mark DONE a task whose diff touched `src/mcp/**` or `src/bin/**` unless the handoff/LOG records `bash install-ai-os.sh` + a server restart (the three CI-only failures this sprint were all a laptop mirror a release behind).
- **Refusal**: `state-db` / the projectors are NOT hot-reloaded. The write path's correctness must not depend on a mid-process module swap; a stale server is announced and restarted, not patched live (the D-056 restraint applied to state).

### §4 — Suppression-count summary (E-250, Tier 1)
D-065's carried instruction ships on its own: the standards checker prints active `# standards:allow-<rule>` suppressions per rule in every summary, and lists the by-name exemptions from `standards.json`.

### §5 — The scan that never ran (E-251, Tier 1)
Three rule-scanning suites built their corpus with `find` over roots that E-244 stopped provisioning; `find` failed, the corpus was empty, and the suites would have reported "no violations" forever. Ruling: a harness helper `corpus_or_fail <min> <root>…` builds the corpus, fails the suite when a root is missing or the count is below the minimum, and prints the count; the three suites use it; standing review question #5 for `critic_tests`/`ai-review`: "can this scan return an empty set and still pass?".

### Ratifications
- **E-244 reverses E-212's keep-unserved-workspace rule** — ratified; the properties E-212 needed (an unserved provider never aborts the sync; a served one gets its role's skills) hold on both sides and are asserted.
- **CHANGELOG records 3.0.0 as untagged and unchangelogged** rather than reconstructing it — ratified; a reconstructed section would be fiction.

### Alternatives considered
1. **§1: delete the dead half** — rejected; every step in it is a ruled feature that was silently lost.
2. **§3: hot-reload `state-db` like the policy modules** — rejected (write-path integrity); **§3: have servers exit on source change** — rejected (the harness does not restart them; an announced stale server is recoverable, a dead one is not).
3. **§2: keep the strip and re-add keys for Claude** — rejected; two transformations of one file drift.

### Constraints driving this decision
- Fail-open steps must still be REACHABLE and must SAY when they skip (§1).
- The mirror is canonical; provider-specific transformations happen at the provider boundary (D-052).
- State writes never depend on live module swaps; staleness is announced with evidence (D-062 lineage).

### Impact
- Unlocks: E-247 (T2), E-248 (T2), E-249 (T2), E-250 (T1), E-251 (T1). Order: E-247 → E-248 → E-249 → E-251 → E-250 (restore reachability first, since §3's notice depends on it).
- Risk if wrong: §1 could resurface an old failing step — mitigated by per-step fail-open wrappers and the reachability test.

### Rollback
§1 `AI_OS_SYNC_MINIMAL=1` stops after provisioning (the current behaviour, made explicit). §2 `AI_OS_STRIP_MIRROR=1`. §3 `AI_OS_BUILD_STAMP=0` suppresses the meta and the gate. §4/§5 helpers only.

---

## D-068 — One tmux Session per Project; the Stamp Is the Identity; the Watcher Scopes to Its Session

**Date**: 2026-09-11
**Task**: E-252, E-253 (Architect ruling on the operator's report: several projects started with `ai start` all landed in one session and interfered with each other's watchers and handoffs)
**Decision**: `ai start` creates one tmux session per project, named after the project (sanitised basename, `.ai/start.json` `session` still overrides), owned by a session-environment stamp `AI_OS_PROJECT=<physical path>` that discovery, `--status` and `--kill` use instead of the name; a name already held by another project or by a foreign session is suffixed with a short path hash; a live legacy `aios:<basename>` window is adopted in place with a migration notice; only the invoking client is moved (`switch-client`/`attach-session`, never `select-window` on a shared session). `ai watch` restricts its candidate panes to its own session in addition to the project path, and compares paths physically (`pwd -P`).

### Why needed
A tmux session has ONE current window shared by every attached client. With every project in `aios`, `ai start` for project B ran `select-window`/`switch-client` to B's window and flipped the terminal showing project A as well. The project window was found by NAME only, so same-basename checkouts shared a window and a drifted name produced a duplicate window beside the old one. Per-project watchers all scanned `list-panes -a` over the same session, relying on the cwd prefix alone — which also failed silently for a project entered through a symlink, because tmux reports the resolved path and `pwd` the logical one.

### Alternatives considered
1. **Keep one shared session, fix only the client movement** — rejected; `switch-client -t <window>` in a shared session still changes that session's current window for every client. The property the operator needs (independent projects) is a property of sessions, not windows.
2. **Name the session after the project and stop there** — rejected as insufficient; same-basename checkouts and a foreign session with the same name would be adopted by name. The stamp makes ownership explicit and the name a label.
3. **Prefix every session (`ai-<name>`)** — rejected; the operator asked for sessions named after the project, and the stamp already distinguishes AI-OS sessions from foreign ones.
4. **Kill and recreate the legacy `aios` window on first run** — rejected; destroying live agent panes without asking is exactly what `--kill` requires `--yes` for. Adopt in place, print the migration line.
5. **Chosen** — per-project session + stamp + suffix-on-collision + legacy adoption + session-scoped watcher.

### Constraints driving this decision
- Every value that reaches tmux is an exec surface (E-208 audit): the name is produced by a whitelist rewrite, the stamp is only compared.
- Idempotency (D-059 §4) must survive the migration: an operator mid-sprint in `aios` must not get a second set of panes.
- Live tmux tests run on an isolated server with `register_cleanup` before create (E-240).

### Impact
- Unlocks: E-252 (Tier 2, launcher), E-253 (Tier 2, watcher). Order E-252 → E-253.
- Risk if wrong: a stamp read that fails on an old tmux would make every run create a fresh session — mitigated by the fail-open "proceed by name and say ownership was not stamped" path and its test.

### Rollback
`AI_OS_SHARED_SESSION=1` (or `.ai/start.json` `{"session":"aios"}`) restores the shared session; `AI_WATCH_ALL_SESSIONS=1` restores the watcher's all-sessions scan. No state change to undo.

---

## D-069 — AI-OS v4 Is Claude-Native: Remove the agy/gemini Providers and TestSprite; the Tester Is a Headless Claude Role on Sonnet

**Date**: 2026-09-11
**Task**: E-254, E-255, E-256, E-263 (operator ruling: "total cleanup — remove gemini and agy everywhere, replace TestSprite with Claude, update the README; the project goes fully Claude-scoped"). Task ids corrected 2026-09-13: the release task was registered as E-263 after D-070 took E-257..E-262.
**Decision**: Delete every `agy`/`gemini` adapter, workspace, shim, plugin builder, TOML command, field strip and model pin; keep the role→provider decoupling (`roles.json`, `providers.json`, `provider-adapter.mjs`) with exactly one provider, `claude`. Replace TestSprite with a headless Claude Tester role (`tester`: `claude`, model `sonnet`, `haiku` for `--fast`) dispatched by `ai-test` as the `test_engineer` subagent, its label derived from `roles.json` like the other two. `CLAUDE.md` stays as the one auto-load shim; `GEMINI.md`/`AGENTS.md` go. `ai sync` prunes manifest-owned legacy workspaces and only PRINTS for anything it did not generate. Ship as v4.0.0 with a BREAKING section. Blueprint: `.ai/blueprints/claude-native-consolidation.md`.

### Why needed
Both roles have run on Claude since D-066. The agy/gemini branches are now the largest body of dead code in the CLI (163 hits in `src/bin/ai`, 22 in the installer, 59 test files, 218 lines across 27 blueprints) and they still cause defects — D-067 §2 (E-248) existed only because a Gemini strip ran on the install mirror. TestSprite needs an API key, is never exercised by the harness, and its name is hard-coded in five label sites that D-066 already had to fix for the other two roles.

### Alternatives considered
1. **Keep the adapters behind flags** — rejected; a flag keeps dead code compiled into every path and tested by nobody. Removal is by deletion.
2. **Also delete the role/provider decoupling** — rejected; `roles.json` is how models are configured per role and how labels are derived (D-066). A single-entry registry costs nothing and keeps the door open.
3. **Tester as a third pane-bound role** — rejected; a test generator has no interactive session to keep, and a third pane would change the D-059 layout for no benefit. Headless subagent of the Engineer.
4. **Tester on Opus** — rejected on cost; **on Haiku by default** — rejected on quality for test authoring against a real harness. Sonnet 5 default, Haiku 4.5 as `--fast`. Aliases, never dated ids.
5. **Rename `src/claude/` to `src/provider/` now that it is the only one** — rejected (D-052 reasoning still holds: it is a provider adapter directory; renaming ~25 mirror tests for cosmetics is the same trade-off D-052 declined).

### Constraints driving this decision
- Sovereignty gates and mirror-identity tests must survive: personas move as files, not as rewrites; `.claude/agents/*.md` end byte-identical to `src/claude/agents/*.md`.
- `ai sync` deletes only what the sync manifest owns (E-220) — an operator's hand-written `.gemini/` content is never removed silently.
- Every wave touches `src/bin` and `src/mcp` → D-067 §3 install + restart gate applies to each PR.
- Order: D-067's E-249..E-251 and D-068's E-252..E-253 first; then E-254 → E-255 → E-256 → D-070 insights fixes → E-263 (release last, so v4.0.0 carries the fixes).

### Impact
- Unlocks: E-254 (T2), E-255 (T2), E-256 (T2), E-263 (T2).
- Supersedes: D-050's default providers, D-051's `GEMINI.md` shim, D-052's plural provider directories (the reasoning stands, the set shrinks to one), E-45 Gemini Model Mandate. D-053's shell-native `ai add-task`/`ai handoff` STAY — they are useful on Claude too and the bridge depends on them.
- Risk if wrong: a future non-Claude provider must be re-added as an adapter; the registry shape makes that a config + adapter change, not an architecture change.

### Rollback
Tag `v3.1.0` + `bash install-ai-os.sh`. No in-version flags for the removed providers. `AI_OS_KEEP_LEGACY_WORKSPACES=1` makes `ai sync` print instead of prune.

---

## D-070 — Telemetry Isolation First; Then the Two Real Signals (ai-insights 2026-09-11)

**Date**: 2026-09-11
**Task**: E-257..E-262 (from `~/.ai-os/INSIGHTS.md` regenerated 2026-09-11, 51,382 executions, meta_analyst)
**Decision**: The insights wave is ordered by what the report proved. (§1) Test isolation for telemetry — the suite writes into the operator's `~/.ai-os/telemetry.sqlite`; ~92% of the store is fixtures; fix the seam, add a leak assertion, reset the store once with a backup. (§2) `execute_code` is rejected 935/935 times at 4 ms across three reports — an environmental precondition (Docker) that no surface announces; make `ai doctor`, the startup log and the rejection message say WHY, and record one incident per session. (§3) `task_velocity` counters are wired (all zeros since the first report). (§4) `activate_domain` has a genuine 20% error rate in live traffic and no wrapper — audit the error classes, then an `ai-domain` skill. (§5) Normalise `tool_name`/timestamps across the two emitters and fix the staleness probe's double count. (§6) `handoff_control`'s 780 errors are re-read after §1 — no fix funded on contaminated numbers. WITHDRAWN: the `ai-patch`/`ai-map` skills and the `patch_file` deprecation from the two prior reports — they were fixtures.

### Why needed
Two consecutive reports recommended work against numbers produced by the test suite. A report that cannot tell operator traffic from fixtures is worse than no report: it directs engineering at phantoms (`patch_file` 56% "errors": 1,920 fixture calls, 0 live) while the one tool that has never worked for a real caller (`execute_code`) sat at 100% rejection for two months.

### Alternatives considered
1. **Tag fixture rows with a heuristic and keep the store** — rejected; single-use hash + test-day is a good detector but not a proof, and 8% real traffic is not worth a migration. Backup + reset.
2. **Fix `patch_file`'s md5 contract as the prior report asked** — rejected; zero live calls. Fixtures exercising a guard are the guard working.
3. **Wrap `execute_code` in a skill** — rejected; it is refused before any work happens. Announce the precondition instead.
4. **Skip §5 as cosmetic** — rejected; one tool under two names with 75× different average latency makes every latency table wrong.

### Constraints driving this decision
- Leaked external state fails the run (D-063); the live telemetry DB is external state.
- Environmental preconditions are announced with evidence, never silently booked (E-179/D-062 lineage).
- No back-migration of telemetry rows; normalise at write time.

### Impact
- Unlocks: E-257 (T2), E-258 (T2), E-259 (T2), E-260 (T2), E-261 (T1), E-262 (T1, conditional). Order: E-257 first — every later number depends on it.
- Risk if wrong: resetting the store loses the 13,093 live rows — mitigated by the dated backup and by the fact that they are what the next 30 days will regenerate cleanly.

### Rollback
`AI_TELEMETRY_DB_PATH` unset restores the shared path; the backup file restores the store. §5 changes emitters only.

---

## D-071 — The Completion Gate Reads State, Not Prose; Generated Blueprints Take No Hand-Authored Sections; the Harness Strips Inherited Launch Variables; Suppression Lives in `validateFile`

**Date**: 2026-09-13
**Task**: E-264 (ratification of the E-249/E-250 deviations; Engineer handoff 2026-09-11 — D-067 and D-068 complete, PRs #56–#58 merged, master `632b362`)
**Decision**: Four ratifications and one new rule. (§1) D-067 §3's task-completion gate is ratified AS IMPLEMENTED: it lives in `update_task_status` — the only place a refusal can be enforced — and takes its evidence from STATE: the install mirror still differs from `src/` under `src/mcp/**` or `src/bin/**` (lockfiles excluded), or a running server is serving a build that is no longer on disk. It does not read `LOG.md`, does not reconstruct "the task's diff", and is exempt outside the framework clone. The third bullet of D-067 §3 is superseded by this wording. (§2) A GENERATED blueprint — `mcp.md`, `_INDEX.md`, any file whose first line says AUTO-GENERATED — never receives a hand-authored section and is never named as a task's specification. Booted-build staleness is specified in `.ai/blueprints/telemetry-hardening.md §Booted-Build Staleness`, the blueprint that owns the interceptor recording it. There is NO appendix mechanism for generated files. (§3) `src/shared/build-stamp.mjs` is named in `architect.md §4` (D-057). (§4) Inherited LAUNCH variables are the fourth shape of environment dependence: the harness strips them centrally in `tests/lib` from a named list before any suite, hook, resolver or server is spawned; a suite that needs one sets it explicitly; per-suite `env -u` is retired; standing review question #7. → E-264. (§5) `validateFile` is the standards checker's only public entry: suppression markers and by-name exemptions are applied there, AFTER a rule fires (E-250); `RULE_REGISTRY` handlers return raw findings by design, and a caller may invoke one directly only in that rule's own unit test on a marker-free fixture.

### Why needed
E-249's task text named a specification (`mcp.md §Booted-Build Staleness`) that `ai sync` regenerates away on every run, and asked a markdown skill to refuse — which markdown cannot do — on the evidence of a LOG line, which proves only that words were typed. Three consecutive tasks (E-248, E-249 twice) then lost assertions to variables the suite inherited from the tmux pane it ran in — `AI_OS_PANE_ROLE` from `ai pane`, `AIOS_WORKSPACE` from the AI-OS shell — each time failing in the direction that looks like a product bug, and each time fixed with a per-suite `env -u` that the next suite will have to rediscover. E-250's central suppression created a bypass (`leaked_state_test` hit it the day it shipped) that the next direct-handler caller will hit the same way.

### Alternatives considered
1. **§1: parse `LOG.md` for `bash install-ai-os.sh`** — rejected; evidence that words were typed, and the diff a task id names is not determinable (uncommitted, on a branch, or merged).
2. **§1: keep the gate in the `ai-task` skill as D-067 wrote it** — rejected; a skill is prose, `update_task_status` is where DONE is written and the only place a refusal takes effect.
3. **§2: an appendix or `<!-- hand -->` island the generator preserves across regeneration** — rejected; a generator that merges hand-written islands makes one file carry two sources of truth (the D-067 §2 "two transformations drift" problem), and `mcp_doc_sync_test` S02's byte-identity gate would need an exemption to allow it.
4. **§4: keep per-suite `env -u`** — rejected; three suites each rediscovered the rule. **§4: `skip_unless_env`'s inverse (skip when the variable is set)** — rejected; the variable is contamination, not an optional requirement; strip is the correct default and a suite that wants the variable opts in. **§4: make the hooks ignore launch variables under a test flag** — rejected; that tests a path production never takes (E-244's "filter the roots" mistake in a new place).
5. **§5: apply suppression in the handlers as well as `validateFile`** — rejected; two places to count is how D-065's uncounted-suppression defect returns.

### Constraints driving this decision
- A gate takes its evidence from state, never from a report that something was done (D-062, D-067 lineage).
- A generated artefact has exactly one source; hand-authored content lives in hand-authored files (D-067 §2 lineage).
- Harness rules are central and named, never per-suite folklore (D-061 → D-067: supply-or-skip, host-relative budgets, leak sweep, trap chaining, corpus floor).
- One definition, reused — the `validateFile` entry, the `LAUNCH_VARS` list (D-064, D-065).

### Impact
- Unlocks: E-264 (T1, after E-257 so the two `tests/lib` changes do not interleave). Ratifies E-249 and E-250 as shipped; supersedes D-067 §3 bullet three; corrects E-249's specification pointer in the record (the task is DONE; its text is not rewritten).
- Risk if wrong: §4's list is incomplete on the day a hook starts ranking a new variable — mitigated by the no-dead-entries test, the same-change rule and review question #7. §2 leaves `mcp.md` purely generated; a reader looking there for the staleness spec finds a pointer only if the generator emits one — the generator is Engineer territory and is NOT asked to change.

### Rollback
§4 `AI_OS_TEST_KEEP_LAUNCH_ENV=1` skips the strip. §1, §2, §3 and §5 are documentation of shipped behaviour; their rollbacks are E-249's `AI_OS_BUILD_STAMP=0` and E-250's own.

---

## D-072 — Continuous Integration Moves Off GitHub Onto the Operator's Machine (`ai ci`)

**Date**: 2026-09-16
**Task**: E-265..E-268 (operator instruction 2026-09-16: "we won't do the project's CI on GitHub anymore; we will do it locally on our machine")
**Decision**: Retire `.github/workflows/test.yml`. Its two jobs become `ai ci run`, which tests a COMMITTED sha in a detached `git worktree` under a throwaway `$HOME` with `install-ai-os.sh` run from that sha, and writes a `ci_runs` row in `state.sqlite` plus a log under `~/.ai-os/ci/`. "CI green" now means a non-dirty PASS row for the commit. The `update_task_status(DONE)` gate and a new `pre-push` hook read that row (bookkeeping-only `.ai/**` commits ride on their tested ancestor; bypasses are recorded as SKIPPED rows with a reason). `AI_OS_CI=local` keeps E-240's leak-fails rule and E-239's host-relative perf budgets. Blueprint: `.ai/blueprints/local-ci.md`.

### Why needed
The operator is discontinuing GitHub-hosted CI. D-060 made "nobody looked at CI" a named failure and put a `gh run` read in front of every DONE; removing the workflow without replacing the READ would silently return the project to a hard-coded green badge. The workflow also did three things a laptop run does not: a clean checkout, a fresh mirror installed from the commit under test, and a record. The DIGEST's own Known Risks (the lagging mirror, a server serving a stale build) are the failures a bare `bash tests/run.sh` cannot see.

### Alternatives considered
1. **Keep GitHub Actions and add a local runner beside it** — rejected; the operator's instruction is to stop using GitHub CI, and two sources of "green" is the D-067 §2 two-transformations problem applied to verification.
2. **`bash tests/run.sh` on the working tree as "CI"** — rejected; it tests uncommitted files against the laptop's lagging `~/.ai-os` mirror (Known Risk since E-244) and leaves no record a gate can read (D-071 §1: gates read state, not prose).
3. **Run the suite in a `pre-push` hook synchronously** — rejected as the primary mechanism; a multi-minute blocking push invites `--no-verify`. The hook CHECKS for a record (fast); the run is an explicit, recorded step.
4. **`act` or another GitHub-Actions emulator** — rejected; it needs Docker, which E-258 shows is absent on this machine 935/935 times, and it would keep the workflow YAML as a second description of the pipeline.
5. **`CI=true` for local runs** — rejected; the absolute performance budgets were calibrated on the ubuntu runner and fail on this host (E-239's 381 ms). A distinct `AI_OS_CI=local` keeps leak-fails and host-relative budgets.
6. **Gate DONE on the run everywhere** — rejected for downstream projects; the gate activates only once a project has a `ci_runs` row, so an upgrade cannot break a project that never adopted `ai ci`.

### Constraints driving this decision
- A gate takes its evidence from state (D-062, D-067, D-071 lineage): the row, never a log line or a badge.
- Isolation is the property that made the GitHub run trustworthy (fresh checkout, fresh HOME); the local runner must reproduce it or it measures the laptop (test-harness-isolation.md, varieties 1 and 3).
- Bypasses are explicit and recorded (D-065): `AI_OS_CI_SKIP` requires a reason and writes a row.
- Linux coverage is lost: E-230's three defects reproduced only on ubuntu. `ai ci run --linux` inside a `node:22` container is DEFERRED until Docker exists on the operator's machine; the recorded toolchain and E-236 SKIP accounting are the interim mitigation. Open risk.

### Impact
- Unlocks: E-265 (runner + `AI_OS_CI=local`), E-266 (`ci_runs` + readers), E-267 (gates + consumers), E-268 (decommission). Sequenced after E-255 and before E-256; E-263's BREAKING list gains the workflow removal.
- Risk if wrong: an isolation gap in the runner would let a green row certify code that only passes on this laptop, with nobody else running it — exactly the pre-D-060 state, now with a row that looks authoritative. The first-run duration measurement and the toolchain columns exist to make that drift visible.

### Rollback
Revert the E-268 deletion commit (the workflow stays in git history); `AI_OS_CI_GATE=0` and `AI_OS_CI_SKIP=1` disable the two gates; drop `ci_runs` via the migration's down path; delete `~/.ai-os/ci/`. GitHub branch protection is restored by the operator.

---

## D-073 — Role Panes Are Bound by a tmux Pane Option, and a Held Handoff Is Never Silent

**Date**: 2026-09-17
**Task**: E-269, E-271 (operator report 2026-09-17: "ai watch and handoff is sometimes sluggish and doesn't trigger immediately")
**Decision**: `ai pane <role>` binds the role with `set-option -p -t "$TMUX_PANE" @ai_os_role <role>`; `resolve_pane` Pass 1 matches that option among AGENT panes only; titles are cosmetic and never routed on. A held entry records `hold_reason`/`hold_since`/`attempts` in `signal.json`, prints one stderr line per change and appears in `ai start --status` and `ai doctor`. `roles.json` is re-read on mtime change; both signal writers are atomic and never write unlocked; suite-started watchers are registered for cleanup and counted by the leak diff. Amendment: `.ai/blueprints/interactive-bridge.md §Binding by Pane Option`.

### Why needed
The loop is not slow — median delivery is 1 s over 50 signals. It STALLS: two Engineer handoffs from 2026-09-16 are still undelivered under a healthy watcher, and the four multi-hour outliers were each delivered by a different watcher pid than their neighbours, i.e. by a restart. `ai pane` pins the role title with an untargeted `select-pane -T`, which after `ai start`'s untargeted `split-window` lands on the watcher's own bash pane; Pass 1 matches the title without checking for an agent, the ready check says busy, and `MAX_HOLD=0` holds forever with no output. Four other projects on this machine carry the same mis-title, and `ai_watch_test.sh:546` asserts the failure as correct. Independently, Claude Code overwrites pane titles with its conversation summary, so title-based binding never survived on the agent panes anyway.

### Alternatives considered
1. **Target the title (`-T … -t "$TMUX_PANE"`) and keep title routing** — rejected as sufficient; the title is overwritten by Claude Code within seconds, so Pass 1 degrades to the ordinal pass, which miscounts once subagent panes appear. A pane option is invisible to the program in the pane.
2. **Expire held entries (`MAX_HOLD>0`)** — rejected; expiry turns a stall into silent loss. Report, do not expire.
3. **Poll faster / fewer python calls per tick** — rejected as the fix; ticks cost ~1.3 s and were never the cause. Not funded.
4. **Teach the ready check to detect a thinking Claude** — deferred; no observed failure, no signal to read from `pane_current_command`.
5. **Write unlocked after the lock timeout (current behaviour)** — rejected; an in-place `writeFileSync` racing the watcher's rename can lose an append. Fail loudly with `[SIGNAL_LOCKED]`.

### Constraints driving this decision
- Explicit configuration beats heuristics (D-054 precedence) — a pane option is configuration; a title is a heuristic the pane's program can overwrite.
- A stuck queue must look different from an idle one (D-060/D-071 lineage: the harness tells the truth).
- Leaked processes are the third environment dependence (D-063): test watchers are external state.

### Impact
- Unlocks: E-269 (binding + status column + test fix, first after E-267), E-271 (visibility, re-read, atomic writers, watcher hygiene).
- Risk if wrong: tmux versions without pane options (`set-option -p` needs tmux ≥ 3.0) — `ai start` already requires modern tmux (D-059); the ordinal pass remains as the fallback.

### Rollback
`AI_WATCH_TITLE_ROUTING=1` restores title-first Pass 1 for one release; the held-entry fields are additive; `register_cleanup` for watchers is per-suite and removable.

---

## D-074 — One Version, Stamped in the Mirror and the Project; `ai init` Upgrades; `ai clean` Removes What Earlier Versions Left

**Date**: 2026-09-17
**Task**: E-270, E-272, E-273 (operator instruction 2026-09-17: "we have old versions of ai-os running, ai init should update to the new version, ai clean should remove everything unneeded or removed for previous versions")
**Decision**: `package.json` is the only typed version; the installer writes `~/.ai-os/VERSION`; `ai init`/`ai sync` stamp `project.aios_version` + `provisioned_at` via `state-db`. `ai init` on an existing project is an idempotent upgrade: generated files refreshed, schema-bearing templates (`roles.json`, `providers.json`, `state.json` keys) MERGED, user content never written, `--check` dry run, summary printed. `ai clean` is a new command driven by a data registry (`src/config/legacy-artefacts.json`): dry run by default, `--apply` removes the `safe` class, `--all` the `prompt` class with confirmation, everything moved to a dated trash with `--restore`; processes (orphan watchers) are killed and listed; `not-ours` paths (`~/.gemini/`) and `settings.local.json` are never touched. The installer syncs `mcp/` and `hooks/` with `--delete`; agents get manifests; stale `mcp__*` allows are pruned. Blueprint: `.ai/blueprints/version-lifecycle.md`.

### Why needed
No version is recorded anywhere except as typed literals in three files; `ai init` only creates MISSING files, so a project provisioned under 3.0 never gains the `tester` role or loses a removed provider; the mirror keeps orphan servers (`~/.ai-os/mcp/intent-refiner-mcp` exists today); `settings.json` keeps allows for removed servers; agents are never pruned; and the D-069 legacy sweep prints `rm -r` hints. "Old versions running" is therefore three distinct things — a stale mirror, a stale project, and stale server processes — and only the last one is already detected (E-249).

### Alternatives considered
1. **`ai init --force` that overwrites everything** — rejected; it would destroy BRIEF/RULES/architect.md and the `do_migrate_state` history (memory: the lossy rebuild that corrupted the shared tree). Refresh generated, merge schema'd, never touch authored.
2. **Fold cleanup into `ai sync`** — rejected; sync runs on every session and must stay non-destructive; removal is a separate verb, dry-run by default (D-065: explicit and greppable).
3. **Hard-code the legacy list in `src/bin/ai`** — rejected; every future removal would need a code change and a test; a registry entry with a hash or a rule is data and is asserted by a test that every D-069 removal has one.
4. **Delete instead of trash** — rejected; `ai clean --all` may touch user-authored files (`prompt` class); a dated trash with a manifest makes every apply reversible for 30 days.
5. **Have `ai clean` restart stale MCP servers** — rejected; they are stdio children of live Claude Code sessions, and killing one breaks that session; report with pids, as E-249 does.

### Constraints driving this decision
- Never rebuild authored state from a lossy view (memory of the `do_migrate_state` corruption).
- A removal must be reversible and logged (D-065; `ai start --kill` consent pattern for non-interactive stdin).
- The installer and the project must agree on what "current" means before anything can say "behind": hence the stamps come first (E-271 before E-272).

### Impact
- Unlocks: E-270 (stamps + upgrade + doctor), E-272 (registry + `ai clean`), E-273 (installer `--delete`, agent manifests, allow pruning, run-dir reaping). Sequenced after E-271 and before E-256; E-263's release notes gain `ai clean` and the `VERSION` file.
- Risk if wrong: a `safe` registry entry with a wrong rule removes something needed — mitigated by trash + restore and by the loader refusing `safe` without a hash or rule.

### Rollback
`ai clean --restore <date>`; `AI_OS_CLEAN_DISABLE=1`; `AI_OS_INSTALL_NO_DELETE=1` for the installer; the pre-merge templates are kept as `<name>.pre-<version>.json` for one release; the stamps are informational.

---

## D-075 — Native-First: Retire What Claude Code Now Does Itself; Adopt Its Surface; Ship in v4.0.0

**Date**: 2026-09-28
**Task**: E-275..E-285 (operator instruction 2026-09-28: "write D-075 and plan the tasks, ship in v4.0.0"); audit in `plans/native-vs-aios-audit.md`
**Decision**: AI-OS keeps what the harness cannot do (enforced role sovereignty, ACID shared task state, git gates on stamps and CI, local CI isolation, cross-project telemetry → proposed skills, the two-pane bridge) and **deletes** the machinery whose only reason was a Claude Code gap that has since closed or an Antigravity limitation that D-069 removed: `mcp-router`, `context-invoker-mcp`, `orchestrator::run_preflight`, `code-execution-mcp`, `lsp-mcp`, `github-bridge-mcp`, `computer-use-mcp`, the third-party `server-memory` (if unused), the `ai-compact` skill and the six single-tool wrapper skills, and the rulefile MCP-fallback ladders. It **adopts** `.claude/rules/` path scoping, the unused skill/subagent frontmatter (`mcpServers`, `maxTurns`, `memory`, `context: fork`), the `PermissionDenied` hook event, `claude plugin eval` for skill behaviour, and lets the auto-mode classifier own the Engineer's destructive-command check while the Architect gate stays frozen (D-056). The SessionStart blob is brought under its 20k cap. All of it ships inside v4.0.0 (E-263). `token-budget-mcp` stays (E-259 depends on it).

### Why needed
D-069 removed the `agy`/`gemini` providers but kept the scaffolding built to work around them. An audit against the live Claude Code docs (2026-09-28) found ~2.5k LOC of MCP code (≈20% of the tree), 7 skills and two rulefile sections that duplicate a native feature: tool-schema deferral (`ToolSearch`) makes `mcp-router` redundant and it is the largest genuine ERROR source (20%, E-260); the Skill/Agent tools always exist under Claude, so `context-invoker` and the "fallback to MCP" ladders are dead paths; `execute_code` has been REJECTED 935/935 because no host has Docker (E-258); code intelligence plugins, native computer use and plain `gh` cover the other three. Meanwhile the context blob injected every session measures 25,812 chars against its own 20,000 cap, half of it `registry.json` prose no agent reads; the 50 skill descriptions load at every start; and no native ruling on "does the harness already do this" existed (the K-grep in the audit found none).

### Alternatives considered
1. **Keep everything and mark the fallbacks "optional"** — rejected; optional code still ships, is mirrored by `ai install`, loads its tool schemas, is instrumented, and appears in `ai doctor`. D-074 made removal cheap and reversible (`ai clean` + trash); use it.
2. **Replace the Architect write gate with the auto-mode classifier too** — rejected; the classifier is advisory and model-evaluated, the gate is deterministic, role-keyed and fail-closed, and D-056 froze it with `arch-write-cases.json` as the contract. Only the Engineer's Bash check moves, and only when the payload says `permission_mode: auto`.
3. **Fix E-258 (better Docker error) and E-260 (wrap activate_domain errors) as funded** — rejected; both polish a component that is being deleted. They are closed as SUPERSEDED with a summary pointing here, and E-263's dependency list is revised.
4. **Ship the retirements as v4.1** — rejected by the operator; v4.0.0 already carries a BREAKING list (providers, TestSprite, `ai provider`) and a second breaking release weeks later doubles the upgrade cost. `ai init` upgrade + `ai clean` (D-074) land in the same release.
5. **Replace `ai-watch` with `SendMessage` now** — rejected; the wake semantics (idle pane, after `/clear`, durability) are unverified. Spike first (E-284), decide after.
6. **Delete `server-memory` unconditionally** — rejected; a repo grep says zero references but telemetry is the truth (D-070). The task deletes only if both the grep and a 90-day `mcp__memory__*` SUCCESS count are zero.

### Constraints driving this decision
- Every removal gets a D-074 legacy-registry entry so `ai clean` removes the mirrors; nothing is deleted from a user's machine by `ai sync`.
- The removals land BEFORE E-256 (docs rewrite) so the README's MCP count and skill list are written once, correctly.
- Rule-scanning tests assert corpus size (DIGEST "fifth variety"): the grep-based acceptance criteria name the expected residue (`.ai/archive`, CHANGELOG) explicitly.
- Native features are used only where they are documented as generally available; experimental agent teams and the Workflow tool (user opt-in per run) are noted, not adopted.

### Impact
- Unlocks: E-275 (blob cap), E-276 (agy-era fallbacks), E-277 (`mcp-router`, supersedes E-260), E-278 (`code-execution` + `lsp`, supersedes E-258), E-279 (`github-bridge` + `computer-use` + `server-memory`), E-280 (Engineer gate → classifier, Tier 3), E-281 (`SendMessage` spike), E-282 (`.claude/rules/`), E-283 (skill prune), E-284 (native frontmatter + `PermissionDenied`), E-285 (`claude plugin eval`). E-256 now waits for E-276..E-279 and E-283; E-263 waits for E-280..E-282, E-284, E-285 instead of E-258/E-260 (those two are closed SUPERSEDED by the Engineer after its next install — the D-067 §3 build gate blocked the Architect's DONE).
- Risk if wrong: a retired server was load-bearing for a downstream project — mitigated by the telemetry usage check in E-280 and by `ai clean --restore`; the classifier misses a destructive Engineer command the old gate caught — mitigated by `autoMode.hard_deny` carrying the same denylist and `AI_OS_SAFE_EXEC_ENGINEER=strict`.

### Rollback
`ai clean --restore <date>` returns the mirrors; `git revert` per task (each is one PR); `AI_OS_SAFE_EXEC_ENGINEER=strict` restores the pre-E-283 Bash gate; `AI_OS_DISABLE_CACHE=1` still bypasses the blob; the pre-D-075 blueprints stay in `.ai/archive/`.

---

## D-076 — The Legacy-Mention Grep Takes a Named, Counted Allowlist; There Is No By-Name Skill Partition

**Date**: 2026-09-29
**Task**: E-256, E-263 (Engineer → Architect handoff 2026-09-29, commit `3923540`)
**Decision**: (1) The v4 acceptance grep `gemini|\bagy\b|antigravity|testsprite` permits, besides CHANGELOG history and project memory (`.ai/**`, `plans/**`), only the files named in `tests/fixtures/legacy-mention-allowlist.json`, each with a reason and an exact hit count, and a test asserts the grep's hit set EQUALS that list. (2) Skills are not partitioned by role at provisioning; the `registry.json` `roles._comment` and blueprint text claiming a by-name partition in `role-manifest.mjs` are wrong and are corrected, no partition is built.

### Why needed
The grep in `claude-native-consolidation.md` §Component 4 was written on 2026-09-11. D-074 (2026-09-17) then required a legacy registry, `ai clean`, the `ai init` upgrade and `ai sync` pruning — code that must NAME `.gemini/`, `GEMINI.md`, `Bash(gemini *)` and the `agy` binding in order to remove them, and tests that must name them to prove the removal. The two rulings contradict each other; verified on `3923540`, the grep hits exactly such files (`src/config/legacy-artefacts.json`, `src/shared/ai-clean.mjs`, `src/bin/ai` L1033-1034 + L1368, `install-ai-os.sh` L258, six test files). E-263's wording ("repo-wide … only CHANGELOG and `.ai/archive/**`") was never satisfiable either: `.ai/DECISIONS.md`, `LOG.md`, `COMM.md` and the v4 blueprint itself name the vendors. Separately, the Architect's own blueprint asserted a role→skill partition "by NAME" that `role-manifest.mjs` never implemented (it unions directories), and E-254 copied the claim into `registry.json`.

### Alternatives considered
1. **Category exemption as proposed ("legacy-removal code + its tests")** — rejected as worded; a category is judged by the reader, so the next vendor string in `src/bin/ai` (5k lines) passes by being near removal code. D-065: exemptions are by name.
2. **Hide the strings (split literals, as `headless_tester_test.sh` does with `'test''sprite'`)** — rejected; it makes the grep pass by making the mention ungreppable, the opposite of D-065. The split is reverted; the file goes on the allowlist.
3. **Drop the grep acceptance** — rejected; it is the only check that a vendor name does not creep back into help text, banners or docs.
4. **File-level allowlist without counts** — rejected for the two large files; a pinned count per file makes any new mention an explicit allowlist edit in the diff.
5. **Build the by-name skill partition** — rejected; with one provider both panes read the SAME `.claude/skills/`, so a provisioning partition cannot separate them. Role separation is enforced where it can be: the role token, the Architect write gate (D-056), and distinct skill names with collision a hard sync error (E-217).
6. **Chosen: named + counted allowlist asserted for equality; correct the comment and the blueprint.**

### Constraints driving this decision
- D-065 (explicit, greppable, by-name exemptions); D-067 §5 (a scan asserts how much it scanned — the test uses `corpus_or_fail` over the acceptance roots).
- Equality, not subset: an allowlisted file that stops mentioning a vendor must leave the list, or the list rots into a standing permission.
- Allowlist entries are limited to two kinds: `removal` (the D-074 registry and its consumers) and `absence-test` (tests of that removal or of absence). User-facing text (help, banners, README, CONTRIBUTING, rulefiles, templates, contracts) can never be listed.

### Impact
- Unlocks: E-256 (closes once the allowlist + test land on its branch and `ai ci run` is green), E-263 (acceptance reads: CHANGELOG history, `.ai/**`, `plans/**` and the allowlist).
- Blueprint `claude-native-consolidation.md` amended: §Component 1 (no partition), §Component 4 (allowlist, MCP count 16 custom + 2 third-party after D-075), §Component 5.
- Risk if wrong: the allowlist grows by habit — mitigated by the two permitted kinds and the count pin. A future need to give the roles different skill sets would require per-role workspaces, which is a new decision.

### Rollback
Delete the allowlist test and fixture (one commit); the grep reverts to a manual check. The comment correction has no runtime effect.

---

## D-077 — Task Velocity Is Read From the Transcript by a Hook; Self-Reported Usage Is Not a Source

**Date**: 2026-09-29
**Task**: E-259 (Engineer → Architect handoff 2026-09-29 14:18 UTC)
**Decision**: `task_velocity` rows are written by `hooks/post-tool-use.sh` on a successful `update_task_status(DONE)`, from the `message.usage` fields of the session transcript whose path the hook payload carries; the E-155 path that reads `usage.sqlite` is deleted and a zero row is never written.

### Why needed
D-070 §3 / E-259 told the Engineer to fill the counters "from the token-budget session record" and to reject zero `report_performance` payloads. Both premises are false, verified in the tree: `usage.sqlite` is only written by `report_cost`, which no skill, agent or hook calls (file last modified 2026-04-03), and `report_performance` is the SEO cluster-page metrics tool (`CP-N` ids). The E-155 wiring exists and works — it faithfully aggregates an empty table, which is why all 1,729 rows are 0/0.

### Alternatives considered
1. **Make the agents call `report_cost`** — rejected; the model does not know its own token usage, so it would report guesses, and a metric that depends on the model remembering to report is the failure we already have.
2. **Read the transcript inside `task-synchronizer-mcp` at DONE** — rejected; the server is not given the transcript path and would have to guess it from the session id and the project slug. The hook payload carries `transcript_path` authoritatively.
3. **Keep writing a 0/0 row when unmeasured** — rejected; it is indistinguishable from a measured zero and is what made the table useless. No row = unmeasured.
4. **A `Stop`-hook running tally per session** — rejected; needs a cursor file and a task↔turn mapping. The previous DONE tool_use inside the transcript is already the cursor.
5. **Count cache reads in `tokens_consumed`** — rejected; every call re-reads the whole context, so the sum measures conversation length squared, not work. Stored in its own column.
6. **Chosen: PostToolUse branch + stateless transcript reader.**

### Constraints driving this decision
- D-070: telemetry is the truth only if it is measured, isolated (E-257 seam) and named consistently.
- The transcript is sensitive: numeric usage fields and the task tool's id/status only; path confined to the Claude `projects/` tree; privacy asserted by a planted-marker test.
- Fail-open and cheap: a telemetry error never blocks a DONE; only the DONE branch does work.

### Impact
- Unlocks: E-259 (re-scoped; spec in `meta-cognition.md §Task Velocity from the Transcript`). E-262 and E-263 unaffected.
- Known undercounts, accepted: subagent transcripts in separate files; tasks spanning `/clear` or several sessions.
- Open, NOT decided here: `token-budget-mcp` has no caller for `report_cost`, so its budget warnings never fire. D-075 kept it on the assumption it was live. Review after v4.0.0 (wire it to the same reader, or retire it).
- Also recorded: the E-261 blueprint misattributed the dotted tool names to the hook; they came from the retired `mcp-router`. Blueprint corrected; E-261's shipped behaviour is ratified.
- Risk if wrong: the transcript format is not a public contract and may change — mitigated by fail-open (rows stop, nothing breaks) and fixture tests that pin the fields read.

### Rollback
`AI_OS_TASK_USAGE=0`; or revert the PR to restore the E-155 path. Added columns are nullable.

---

## D-078 — E-259/E-264 As-Built Ratified; Hooks Pin Their Interpreters; the Secret Rule Matches Values, Not Keywords

**Date**: 2026-09-29
**Task**: E-259, E-264 (ratified); E-286, E-287 (funded)
**Decision**: (1) The three E-259 divergences and the three E-264 divergences are ratified and the blueprint amended. (2) Hooks resolve `node`/`python3`/`nice` from installer-recorded absolute paths and replace the inherited `PATH` (E-286). (3) `SECRET_IN_COMMAND` requires a credential-shaped value in an assignment or flag form (E-287).

### Why needed
- D-077 specified "window up to the current DONE, read at hook time". On the first live DONE no row was written: Claude Code appends the assistant message holding a `tool_use` after the tool's PostToolUse hooks. The spec described an ordering nobody had observed.
- critic_security found that every hook resolves its interpreter through `PATH`, which a project's settings `env` can set — the T-LOCATOR-001 outcome (gate runs the visited repo's program) by another route.
- The secret rule blocked three harmless commands in one day and one block lost a handoff entry, so the Architect ruled D-077 without the Engineer's proposal in front of it.

### Alternatives considered
1. **E-259: move the measurement to the `Stop` hook, when the transcript is complete** — rejected; Stop fires per turn, not per task, and needs the task↔turn mapping D-077 already rejected. A bounded retry in a detached process costs the session nothing.
2. **E-259: end the window at end-of-file when the line is late** — rejected; a late read would absorb the next task's first messages.
3. **Hook PATH: accept the risk, since a project settings file can also define hooks** — rejected; T-LOCATOR-001 already treats the settings `env` as an attacker channel for the gates, and that ruling was paid for twice. Accepting the same channel one level down contradicts it.
4. **Hook PATH: an opt-out variable for rollback** — rejected; "a fix for an environment-trust bug must not introduce a new environment variable".
5. **Secret rule: add the offending words to an exception list** — rejected; the defect is that the rule tests the keyword instead of the value. An exception list grows forever.
6. **Secret rule: leave it, the Edit tool is a workaround** — rejected; a gate that blocks prose teaches its users to route around it, and it has now cost real information.

### Constraints driving this decision
- D-056: the Architect write gate is frozen — E-287 touches only `SECRET_IN_COMMAND`, and `arch-write-cases.json` stays byte-identical.
- D-065: the secret cases become a named fixture contract with the over-block ratio printed.
- E-280 also edits `hooks/pre-tool-use.sh`; E-286 runs after it to avoid two Tier 3 changes in one file at once.

### Ratified as built
- E-259: bounded retry for the closing line; stdin JSON instead of argv; the one extra field (previous DONE's `tool_result`, reduced to a boolean).
- E-264: `LAUNCH_VARS` = `AI_OS_PANE_ROLE`, `AI_OS_CALLER_ROLE`, `AIOS_WORKSPACE` (`AI_OS_PROJECT` and `AI_OS_HOME` correctly excluded); the `agent.json` rebuild dropped because the file no longer exists; the fourth per-call strip retired.

### Impact
- Unlocks: E-286, E-287. Neither is chained to E-263 (DAG depth), but E-286 closes a gate-bypass class and SHOULD land before the v4.0.0 tag.
- Blueprints amended: `meta-cognition.md §Task Velocity from the Transcript`; `sovereignty-hardening.md` gains §Hook Toolchain Pinning and §Secret Rule Precision. `THREAT_MODEL.md` gains T-HOOKENV-001.
- Risk if wrong: a Node upgrade (nvm/brew) leaves a recorded path dead and a fail-closed gate blocks until re-install — mitigated by the fixed fallback PATH, the `[TOOLCHAIN_STALE]` message and the doctor line. A narrowed secret rule misses a low-entropy password typed after a flag — accepted; the known-prefix rule now catches keyless credentials the old rule missed.

### Rollback
Revert E-286 / E-287 individually (one PR each). The blueprint amendments describe shipped behaviour.

---

---

## D-079 — Name every Triad session at launch so the remote app can tell the roles apart

**Date**: 2026-09-30
**Task**: E-288
**Decision**: `ai pane <role>` passes `--name "<project basename> · <Role>"` to `claude` (e.g. `ai-os-v2 · Architect`, `ai-os-v2 · Engineer`); the resolver injects the flag when a project's `.ai/providers.json` predates the template change.

### Why needed
Claude Code's remote surfaces (claude.ai/code, the mobile app, the session picker) list sessions by their display name. The Triad launches two sessions in the same project with no name, so both appear as auto-generated titles and the operator cannot tell which pane is the Architect and which is the Engineer. E-269's tmux pane title is local-only: the docs say nothing about terminal or tmux titles reaching the remote app, and the observed behaviour agrees.

Verified on Claude Code 2.1.286: `-n, --name <name>` "Set a display name for this session (picker, and terminal title)"; the Remote Control title precedence is `--name`/`--remote-control` first, then `/rename`, then history, then the auto-generated `<host>-<words>` name. Docs: code.claude.com/docs/en/sessions.md, remote-control.md, hooks.md.

### Alternatives considered
1. **SessionStart hook emits `hookSpecificOutput.sessionTitle`** — rejected as the primary mechanism. Hooks are fail-open and a project without the hook installed (or with it disabled) would silently lose the name; the launch flag is precedence 1 and lives in the resolver seam that `pane_binding_test.sh` already pins. May be added later for `resume`/`clear` re-titling if a renamed session loses its name.
2. **Ask the operator to `/rename` after each launch** — rejected: a manual step on every `ai start`, and the loop is meant to run unattended.
3. **`--remote-control <name>` at launch** — rejected as the mechanism: it forces Remote Control on for every pane. The name flag is orthogonal; an opt-in `ai start --remote` that adds `--remote-control` is a separate follow-up if wanted.
4. **`--name` in the launch template plus resolver injection for stale project files (chosen)** — the template stays the visible contract; the E-242 precedent (anchor in the resolver, not only the template) means downstream projects whose `.ai/providers.json` predates this change get the name without hand edits.

### Constraints driving this decision
- The name must include the PROJECT: the remote app lists sessions across all projects (the "phantom E-292..E-296" incident was another project's sessions), so `Architect` alone would be ambiguous.
- Operator arguments after `--` must still win; `ai pane` appends `"$@"` last.
- No new environment variable and no opt-out (D-078 style); the name is derived, never configured.
- `print_mode` (headless Tester, advisor bridge) is untouched: those runs are not interactive sessions and get no title.

### Impact
- Unlocks: E-288.
- Risk if wrong: if Claude Code ever treats `--name` as a resume KEY that must be unique, two projects both launching an Architect would still differ by basename; two clones with the same basename would collide, which is the same limitation `ai start`'s window naming already documents.

### Rollback
Remove `--name {session_name}` from the launch template and the injection branch in `resolve-launch.mjs`; sessions fall back to auto-generated titles. No state or schema is involved.

---

---

## D-080 — E-280 cancelled (safe-exec stays in auto mode); E-287 as-built ratified; hook load errors fail closed; research bypass per segment

**Date**: 2026-10-01
**Task**: E-280 (cancelled), E-287 (ratified), E-289 (new), E-286 (unchanged)
**Decision**: Four rulings on the Engineer's 2026-10-01 handoff (`.ai/COMM.md`).

### Ruling 1 — E-280 is CANCELLED; safe-exec runs in every permission mode
The Claude Code reference (code.claude.com/docs/en/auto-mode-config.md, "Where the classifier reads configuration") lists exactly three scopes for `autoMode`: `~/.claude/settings.json`, managed settings, and the `--settings` flag as **inline JSON**. It states the classifier does not read `autoMode` from `.claude/settings.json` or `.claude/settings.local.json`, precisely so a checked-in repo cannot inject rules. `ai pane` passes `.claude/settings.<role>.json` as a project FILE. Whether that file's `autoMode` block reaches the classifier is unverifiable from inside a session (the probe `claude auto-mode config --settings …` was itself denied as an Auto-Mode Bypass), and even a loaded block cannot be proven APPLIED by any test we own: the blueprint's "denylist equal on both paths" assertion would compare two lists while proving nothing about the gate that matters.

The same page says that for a boundary that inspects the full command text one should add a PreToolUse hook. That is what safe-exec is. Removing it in auto mode would trade a deterministic, fixture-tested gate for a prose classifier whose configuration we cannot observe. The classifier stays an ADDITIVE second gate; safe-exec runs unchanged in all six modes for both roles. No `AI_OS_SAFE_EXEC_ENGINEER` variable is introduced. `native-first.md` Component 6 is struck.

Alternatives: (a) pass the `autoMode` block as inline `--settings` JSON and skip the gate only when the pane proves it loaded — rejected: "proves it loaded" has no observable, and a plain `claude` launch without the overlay would still skip the gate with no denylist at all. (b) keep safe-exec (chosen, the Engineer's recommendation).

### Ruling 2 — E-287 as-built is RATIFIED; §Secret Rule Precision is amended to match
- **Password-key tier**: `pass|passwd|password|pwd` in assignment form blocks at ≥ 8 chars and ≥ 2 character classes. The blueprint contradicted itself (its ≥ 16 / 3-class shape let the historical true positive `export password=supersecret123` through while its contract kept every historical TP as BLOCK); the contract wins. `password=supersecret` (one class) and `--password=changeme` pass by design.
- **Widenings** accepted: `KEY: value` colon form; `Authorization: token|Basic`; a ≥ 20-char hex/base64 tier (keyword required, ≥ 1 digit); prefixes ASIA, npm_, glpat-, sk_live_/rk_live_, hf_, gh[pousr]_; URL userinfo and `curl -u`; input over 256 KB blocks unscanned (fail closed).
- **Residuals accepted as written**: `mysql -pPASS`; low-entropy secrets under non-password keys (`SECRET=hunter2hunter2`); keyword + space + value with no `=` or flag; secrets read from files. The rule buys precision (over-block 0/26, miss 0/25 on the contract) and these are the price. Secrets entering a COMMIT are additionally covered by the auto-mode classifier's content check.
- **Record-keeping**: the three 2026-09-29 blocks exist only as reconstructions. From now on every overturned block goes into `tests/fixtures/secret-cases.json` verbatim, in the same handoff that reports it; the fixture is the record.

### Ruling 3 — the hook's Bash branch fails CLOSED on an analyzer load error (E-289)
`hooks/pre-tool-use.sh` blocks Bash only on exit 2; an `index.js` that fails to LOAD (exit 1, e.g. a mirror missing a new sibling such as `secret-rule.mjs`) allows every command, while the Write/Edit branch already blocks on any non-zero. Rule: when the analyzer is located but exits with anything other than 0 or 2, block with `[SAFE_EXEC_UNAVAILABLE] safe-exec exited N: run bash install-ai-os.sh`. Two escape hatches so a broken mirror cannot lock the Engineer out of its own repair: the literal command `bash install-ai-os.sh` (run from the project root, no other arguments) passes through the unavailable branch, and `AI_OS_SAFE_EXEC_GATE=0` remains the documented rollback. The catastrophic backstop keeps covering the analyzer-not-located case until E-286's toolchain pinning lands. Registered as **E-289**, dependent on E-286 (same file), not folded into E-286: that task is already at the size limit and its description is locked in state.

### Ruling 4 — the research bypass applies per command SEGMENT (E-289)
`isResearchCmd` reads the first word only, so `grep x f && export TOKEN=<real>` skips the secret scan. Rule: the bypass applies only when EVERY segment of the command is a research command, splitting on `&&`, `||`, `;`, `|`, newline, and the bodies of `$(…)` and backticks; one non-research segment scans the whole command. Cases go into `secret-cases.json` (the example above BLOCK; `grep -r token src | head` ALLOW). Same task, E-289.

### Constraints driving this decision
- A gate that cannot be observed cannot be tested; D-060..D-065 ("make the harness tell the truth") forbids shipping one.
- D-056 is untouched: `arch-write-cases.json` stays byte-identical through E-286 and E-289.
- No new environment variables, no opt-outs (D-078 style).

### Impact
- Unlocks: E-289 (after E-286). Queue: E-282 (in progress) → E-286 → E-289 → E-281 (operator-assisted) → E-284 → E-285 → E-262 → E-263.
- Risk if wrong: a fail-closed Bash branch on a broken mirror costs one repair command; the two hatches bound it.

### Rollback
Reinstate Component 6 as a new task if Claude Code documents that a `--settings` FILE feeds the classifier and exposes an observable for it. E-289 reverts per PR.

---

### Ruling 5 (D-080 addendum, same day) — E-282: the ARCHITECT.md 25% target is dropped
The Engineer's question (COMM.md, "E-282 acceptance for ARCHITECT.md") is correct: ARCHITECT.md has no path-scoped content, so its 25% byte target could only be met by moving role-wide text into unconditional rule files that load every session anyway — the bytes drop, the context cost does not. The metric was a proxy for context cost; the proxy is retired where it stops measuring it.

Amended acceptance for E-282: ENGINEER.md at least 25% shorter than at E-275 (achievable: `## Bookkeeping and Triage` is path-scoped — stash/cherry-pick → `.ai/**`, CI triage → `tests/**`); ARCHITECT.md contains no path-scoped content and is not larger than at E-275. Two cuts to ARCHITECT.md are PERMITTED, not required, because they are redundancy rather than relocation: the self-referential "Project-Scoped Rules" line, and the "Why this exists" paragraph under Role Resolution, which duplicates ENGINEER.md's copy (keep one sentence pointing at it). No other ARCHITECT.md prose is to be cut in E-282; role-wide rewrites are a separate Architect task if ever wanted. Everything else in E-282 stands as registered.

---

---

## D-081 — Hooks run under privileged bash; the gate's env opt-outs are replaced by an operator-owned override file

**Date**: 2026-10-01
**Task**: E-286 (scope clarified), E-290 (new), E-291 (new)
**Decision**: Rulings on the five items in the Engineer's E-286 threat-model question (`.ai/COMM.md`, 2026-10-01).

### Why needed
E-286 pins WHICH interpreters the hooks run, but the security_engineer probes proved four channels that act before or around the pin: `BASH_ENV` runs before line 1; exported functions (`BASH_FUNC_node%%`) shadow `command -v` and can shadow `unset`/`builtin` themselves; `SHELLOPTS=xtrace` with a `PS4='$(…)'` executes code and traces values into the stderr the model reads; and the bare `bash` in every generated hook command line and git stub resolves through the visited project's `PATH`. All four stop under `/bin/bash -p`. Separately, `AI_OS_SAFE_EXEC_GATE=0` and `AI_OS_ROLE_TOKEN=0` are environment opt-outs, and a project's checked-in settings `env` can set them — the T-LOCATOR-001 channel, which D-080 ruling 3 had just enshrined as E-289's rollback.

### Ruling 1 (P0) — every hook command line and git stub runs `/bin/bash -p` → E-290
Generated hook command lines become `/bin/bash -p <hook path>`; git stubs become `#!/bin/bash -p` with `exec /bin/bash -p "$CANONICAL"`. The installer verifies that `/bin/bash` exists, is executable and accepts `-p`; if not, it REFUSES to install the hooks with a named error — there is no PATH fallback for the interpreter of a gate. The **`HOME` channel** is part of this ruling: the command lines today read `bash $HOME/.ai-os/hooks/…`, and if a project's settings `env` can redirect `HOME`, a planted hook runs with no pin involved. The Engineer MEASURES it. If it reaches the command line, the line carries the install-time absolute path and `.claude/settings.json` leaves git tracking for the same reason `.gemini/settings.json` already did ("machine-specific absolute paths", `.gitignore` line 11), regenerated by `ai sync` and checked by `ai doctor`; if it does not, `$HOME` stays and the measurement is recorded in the threat model. New task E-290 (Tier 3, after E-286), not folded into E-289: different file family (`src/bin/ai` settings/stub writers, templates, installer).

### Ruling 2 (P0) — the env opt-outs are REMOVED; an operator-owned override file replaces them → E-291
`AI_OS_SAFE_EXEC_GATE` and `AI_OS_ROLE_TOKEN` disappear from the hook and from `safe-exec` (the latter also disabled the HMAC role layer — a role-spoof channel of the same class). Replacement: `ai gate off [--minutes N] [--reason …]` (default 15, hard max 60) writes `~/.ai-os/gate-override.json` (`until`, `reason`, mode 0600); `ai gate on` removes it; `ai gate status` prints it. The hook honours the file only when it is owned by the current uid, not group/other-writable, unexpired and within the max window, and prints `[GATE_OVERRIDE] safe-exec bypassed until <until> (<reason>) — ai gate on` on stderr for every call it lets through, so a bypass is never silent. `ai doctor` reports an active override. D-080 ruling 3's second escape hatch is amended to this file; the literal repair command stays. The seven test sites that set the env opt-outs switch to the file (fixtures already own `HOME`). E-291 (Tier 3) follows E-289, which edits the same hook lines and messages.

### Ruling 3 (P1) — a missing `python3` is a missing toolchain — in scope of E-286
The pre-tool-use gate parses its payload with `python3 -I`; without it there is no verdict, and no verdict is a block, exactly as for `node`: `[TOOLCHAIN_STALE] python3 missing — run: bash install-ai-os.sh`. Blueprint Component 3 amended; no new task.

### Ruling 4 (P1) — the repair command is exempt under `[TOOLCHAIN_STALE]` — in scope of E-286
The literal `bash install-ai-os.sh`, run from the project root with no other arguments, passes the stale-toolchain branch exactly as it passes E-289's unavailable branch. ONE shared helper decides "is this the repair command" so the two exemptions cannot drift; E-289 adopts it. Nothing else is exempt.

### Ruling 5 (record) — a decoy `git` on the Bash tool's PATH skips the git hooks
Recorded as a residual in the threat model (E-290 writes the entry). The git hooks are a convenience gate; the authoritative gates are the PreToolUse hook and `ai ci run`, which E-290's `/bin/bash -p` lines protect. Not funded.

### Alternatives considered
- Keep `$HOME` and have the hook self-verify its location — rejected: a redirected `HOME` runs the decoy, which never reaches our code.
- Replace the env opt-out with a flag in `~/.claude/settings.json` — rejected: Claude Code semantics for a user-level key are outside our control; a file we own under `~/.ai-os` is checkable for owner and mode, like `toolchain.sh`.
- Keep the env opt-out as an accepted residual — rejected: it is the single-variable undo of everything E-286, E-289 and E-290 build.

### Constraints driving this decision
- A gate's interpreter is chosen by the installer, never by the visited project (D-078 principle, extended from "which node" to "which bash and under which shell options").
- No new environment variables, no env opt-outs; an override must be operator-owned, time-boxed and loud.
- `arch-write-cases.json` byte-identical through E-286, E-289, E-290, E-291.

### Impact
- Unlocks: E-290 (after E-286), E-291 (after E-289). Queue: E-282 → E-286 → E-289 → E-290 ∥ E-291 → E-281 → E-284 → E-285 → E-262 → E-263.
- Risk if wrong: a host without `/bin/bash` loses the hooks entirely until the installer is taught a verified alternative; the installer says so loudly rather than falling back.

### Rollback
E-290 and E-291 revert as single PRs; the env opt-outs return with E-291's revert. E-286's two in-scope amendments revert with E-286.

---

---

## D-082 — The research bypass is deleted; a gate that aborts blocks; the repair predicate lives inline; E-286 as-built ratified

**Date**: 2026-10-01
**Task**: E-289 (scope amended), E-292 (new), P-## (Architect follow-up), E-286 (ratified)
**Decision**: Rulings on the Engineer's 2026-10-01 handoff after E-282 + E-286 (PR #89).

### Ruling 1 — E-289 part (b): `isResearchCmd` is DELETED from `SECRET_IN_COMMAND` (D-080 ruling 4 amended)
The bypass existed to spare prose in research commands when the rule was keyword-based. Since E-287 the rule is value-shaped: `grep -r token src` no longer needs sparing, and the contract measures over-block 0/26, miss 0/25 with the bypass removed — it protects no case. A per-segment splitter was exploited by six payload classes in review (single `&`, process substitution, function/subshell parens, `find -exec`, `rg --pre`/`git --upload-pack`, redirection/heredoc/here-string), each needing a disqualifier of its own; a gate that needs six disqualifiers to approximate "no bypass" should have no bypass. The three D-080 fixture cases stay; two are added: `grep -rn 'ghp_' src` ALLOW (a short prefix is a search term) and `grep -r ghp_<real-shaped ≥ 12> src` BLOCK — typing a credential-shaped literal into a command line is exposure whatever the verb (transcript, hook stderr, telemetry); the block message says to search by prefix or from a file.

### Ruling 2 — a fail-closed gate that aborts BLOCKS; the analyzer gets a watchdog → E-292
On bash 3.2 an unbound variable under `set -u` exits 1 and a syntax error exits 258; Claude Code treats any non-2 exit as non-blocking, so a bug inside the gate allows the call (observed live in E-286). The hook's stated policy "an aborted hook is a broken session" is REVERSED for the fail-closed gates (`pre-tool-use`, `pre-commit`, `pre-push`): an aborted GATE is a blocked call. An EXIT trap maps any unexpected non-zero to 2 with `[GATE_INTERNAL_ERROR] <hook> aborted (rc N near line L) — run: ai doctor`. Fail-open hooks (`session-start`, `stop`, `post-tool-*`) keep exiting 0 on their own bug but record the abort through the incident log so it is visible, never silent. The analyzer gets an internal wall-clock watchdog (10 s, exit code 4 = TIMEOUT, which E-289 (a) already maps to `[SAFE_EXEC_UNAVAILABLE]`), and the generated hook entries carry an explicit `timeout` well above it, so Claude Code's own hook timeout is never the first to fire. SIGKILL and an external timeout remain uncatchable: accepted residual, recorded. Lockout analysis: a bug that fires on every call blocks every Bash call including the in-session repair, but the operator's escape (`AI_OS_SAFE_EXEC_GATE=0` today, `ai gate off` after E-291) is run from the operator's own terminal, never through the gated tool, so no lockout exists. E-292 is Tier 3 after E-291 (same hook, same messages).

### Ruling 3 — the repair predicate is INLINE in `pre-tool-use.sh` (E-289 scope amendment)
A hatch that depends on the mirror is not a hatch: when the pin is unreachable the fallback stub answers "not the repair command". The predicate is three lines (`bash install-ai-os.sh`, no other arguments, cwd is the project root); it lives inline in the hook and nowhere else — the shared `ai_os_is_repair_cmd` is removed so there is one copy, and the `[TOOLCHAIN_STALE]` branch calls the inline one. Folded into E-289 (a), which the Engineer is implementing now.

### Ruling 4 — E-286 as-built RATIFIED (five divergences)
1. Logic/data split (`src/shared/toolchain-pin.sh` shipped, `toolchain.sh` recorded) with the data file PARSED against a strict pattern, never sourced — stricter than the blueprint's "source"; adopted. 2. `node`/`python3` as shell functions over the recorded absolute paths — adopted. 3. Global `ai doctor` line — adopted. 4. Prologue drops inherited functions and the NODE_*/PYTHON*/DYLD_*/LD_*/BASH_ENV/ENV/CDPATH/GLOBIGNORE/AI_OS_TC_* set, best-effort until E-290 — adopted. 5. `tests/lib/toolchain-fixture.sh` replaces the `PATH=stub:$PATH` idiom, which was the attack channel — adopted; the old idiom is banned in new tests.

### Ruling 5 — duplicated rule text in Architect-owned blueprints → Architect P-task
E-282 moved text into `.claude/rules/` that still lives in `test-harness-isolation.md` and `engineering-standards.md`. One copy: the blueprints keep the rationale and point at the rule file; the rule file holds the rule. Registered as an Architect task.

### Alternatives considered
- Splitter with every P0 disqualifier — rejected (ruling 1): six disqualifiers today, a seventh tomorrow; the contract shows nothing is lost by deletion.
- Keep "aborted hook = broken session" — rejected: on a gate it is "aborted hook = open gate".
- Keep the repair predicate shared and ship a fallback copy — rejected: two copies drift; the only consumer that needs it when the mirror is broken is the hook itself.

### Impact
- Unlocks: E-292 (after E-291). Queue: E-289 → E-290 ∥ E-291 → E-292 → E-281 → E-284 → E-285 → E-262 → E-263.
- Risk if wrong: a `grep` for a real leaked token typed verbatim is blocked; the message tells the Engineer how to search instead.

### Rollback
E-292 reverts as one PR (the trap and watchdog are additive); reinstating a bypass would be a new D-ruling with a contract case that needs it.

---

## D-083 — Hooks in exec form with absolute paths; the gate is tamper-resistant against a same-uid agent, with a classifier backstop; role minted from a launch record, never from env

**Date**: 2026-10-01
**Task**: E-290 and E-291 (scope amended), E-293 (new), E-294 (new), E-289 (ratified)
**Decision**: Nine rulings on the Engineer's 2026-10-01 E-290/E-291 threat-model entry (`.ai/COMM.md`). Verified against code.claude.com/docs/en/hooks.md: exec form spawns `command` directly with `args`, "there is no shell"; a timed-out PreToolUse hook does NOT block; exit codes other than 0/2 do NOT block; stderr on exit 0 goes to the debug log only; `systemMessage` is shown to the user.

### E-290
**1. Exec form — adopted.** `/bin/bash -p` on a shell-form line runs AFTER `sh -c` has already honoured `SHELLOPTS`/`PS4` (probed). Every generated hook entry becomes `{"type":"command","command":"/bin/bash","args":["-p","<absolute hook path>"],"timeout":30}`. No shell, no tokenisation, no expansion.
**2. HOME — closed by construction.** `args` carries the install-time ABSOLUTE path; `$HOME` disappears from the hook lines. Consequence accepted: `.claude/settings.json` leaves git tracking and is gitignored in every AI-OS project (the `.gemini/settings.json` precedent, via the E-233 generated-artefact mechanism); `ai sync` regenerates it; `ai doctor` reports absent or stale; `ai ci run` and every test generate it in the fixture rather than reading the repo copy; the role overlays stay tracked (no paths). The `env.HOME` measurement is still recorded in the threat model.
**3. Old-form entries removed — in scope.** The settings writer removes every AI-OS-owned entry for the five hooks in any form (command or args resolving to one of the hook basenames) before writing the exec-form entry; user-authored entries are untouched; idempotent.
**4. Git stubs — in scope.** `exec /bin/bash -p` and the chained `/bin/bash -p "$USER_HOOK"`; the prologue also unsets `POSIXLY_CORRECT` and `BASH_COMPAT` (`-p` does not clear them, and posix mode on 3.2 turns process substitution into a fail-open syntax error until E-292); `ai doctor` reports a stale hook form or stub.

### E-291
**5. Agent self-disable — the ceiling is accepted and named.** A same-uid agent can reach anything the operator can reach; no TTY or owner check distinguishes them. The gate is TAMPER-RESISTANT, not tamper-proof, and the blueprint says so. Funded mitigations: (i) analyzer rule `GATE_SELF_DISABLE`, every role: `ai gate`, `gate-override`, and any shell write under `~/.ai-os/` BLOCK (string-splitting residual recorded); (ii) ruling 6; (iii) **E-293 — classifier backstop**: `ai install` OFFERS (y/N, never silent) to add a `hard_deny` entry to the operator's `~/.claude/settings.json` (`"$defaults"` preserved) covering `ai gate off`, writes under `~/.ai-os/` and edits of `~/.claude/settings.json`; the classifier's configuration is the one layer the agent cannot reach from the project (D-080), so the two gates are independently configured; (iv) operator presence (Keychain/Touch ID) is the next rung, recorded, not funded. Block messages never instruct the model to run `ai gate off`; the Engineer's wording ("Operator escape — in YOUR terminal, not through the agent") is adopted.
**6. `~/.ai-os/**` is protected for every role.** The Write/Edit branch blocks both roles there; shell writes there are blocked by (i). The only writer paths are the inline repair predicate, widened to a literal allowlist of our own commands: `bash install-ai-os.sh`, `ai install`, `ai sync` (documented flags only), `ai doctor`. Nothing else.
**7. Loud means user-visible.** On every bypassed call the hook exits 0 with JSON stdout carrying `systemMessage: "[GATE_OVERRIDE] safe-exec bypassed until <until> (<reason>) — operator: ai gate on"`; one telemetry row (`source=hook`, `status=BYPASS`); the session-start hook injects an `[GATE_OVERRIDE active until …]` line into `additionalContext`; `ai doctor` reports it. Stderr alone is invisible on exit 0 and is not loudness.
**8. The catastrophic backstop ALWAYS applies.** The override lifts the policy gate only; recursive root deletion, fork bombs, `mkfs`, `dd` to a device and a download piped into a shell block under an active override. Old S06 is reversed and a fixture asserts it.
**9. Role spoofing → E-294.** The mint reads `AI_OS_PANE_ROLE` and the gate falls back to `AI_OS_CALLER_ROLE`; both are settable by a project's settings `env`, so a project can hand the Architect persona an Engineer token and write source. Design: `ai pane` writes a launch record `~/.ai-os/run/launch/<pid>.json` (`role`, `project`, `started`; the `exec`'d claude keeps `ai pane`'s pid) before exec; the session-start mint walks the PPID chain to that pid and reads the record (O_NOFOLLOW/fstat as in E-291), never env; no record → `engineer` (the documented plain-launch default) with the token marked `launch: unverified`; the `--check`/`--check-path` env fallback is REMOVED: no valid token → the UNION of both roles' write blocks with `[ROLE_UNVERIFIED] run: ai pane <role>`. `AI_OS_PANE_ROLE`/`AI_OS_CALLER_ROLE` remain advisory for prompts and handoff, never for gating. Tier 3, after E-290 and E-291.

### E-289 divergence ratified
rc 0 with no `Verdict:` line is "no verdict" and blocks (a pre-E-125 mirror starts its stdio server and exits 0).

### Over-block recorded while writing this entry
The gate blocked two heredoc appends to `.ai/` files with `[CURL_PIPE_SHELL]` because the PROSE named the catastrophic set. Same class as the three 2026-09-29 secret blocks: a rule matching inside a quoted heredoc body. Per D-080, both commands go into the fixture verbatim as ALLOW, and `CURL_PIPE_SHELL` skips quoted heredoc bodies the way the secret rule does — folded into E-291 (same analyzer), or E-292 if E-291 has landed.

### Alternatives considered
- Keep shell form with `-p` — rejected: the outer `sh -c` runs the payload first (probed).
- Keep `$HOME` and a tracked settings file — rejected: the HOME channel stays open and the exec form needs a literal path anyway.
- Operator-presence step in E-291 — deferred: platform-specific, out of size; the classifier backstop buys most of the value now.
- Treat the ceiling as a reason to drop the override file — rejected: the env opt-out it replaces was weaker on every axis.

### Constraints driving this decision
- No shell between Claude Code and a gate; no variable in a gate's path; no env input to a gate's identity.
- A gate's own tooling is gated too (`~/.ai-os/**`), with a literal allowlist as the only exception.
- Two independently configured gates beat one hardened gate against a same-uid agent.

### Impact
- Unlocks: E-293 (after E-291), E-294 (after E-290, E-291). Queue: E-284 (in progress) → E-290 ∥ E-291 → E-292 → E-293 → E-294 → E-281 → E-285 → E-262 → E-263.
- Risk if wrong: a project cloned on a second machine has no `.claude/settings.json` until `ai sync` runs; `ai doctor` and the SessionStart heal say so.

### Rollback
Each task reverts as one PR; the exec-form entries revert to shell form with the same hooks.

---

## D-084 — Last env opt-out removed; heredoc exemption defined by the consumer, not the line; agent frontmatter corrected to the real subagent fields; residuals accepted

**Date**: 2026-10-01
**Task**: E-284, E-290, E-291 (as-built ratified), E-294 (scope amended), E-295 (new), E-292 (scope amended)
**Decision**: Four rulings and the divergence ratifications from the Engineer's 2026-10-01 handoff after PRs #91–#93.

### Ruling 1 — `AI_OS_SOVEREIGNTY_LOCK=0` is removed, with an env inventory → E-294
It disables the Architect rules in `runAnalysis` and a project's settings `env` can set it: the class D-081 removed, missed by name. E-294 (already on `safe-exec`'s env fallback) removes it and records in the blueprint EVERY environment variable a gate path reads, each classified as gating input (removed) or advisory (kept, with the reason). That list is the contract; a new env read on a gate path is a D-ruling.

### Ruling 2 — the verbatim D-083 commands, and what they teach about the heredoc rule
The commands are in `plans/d083-overblock-verbatim.md`, exactly as issued; they replace the reconstructions in `pipe-shell-cases.json`. They show the as-built E-291 rule ("`cat`/`tee` with a quoted delimiter and NOTHING else on the line") would still block them: every Bash call in this project begins `cd <abs> &&`, and both had a plain `echo` after the terminator. A THIRD block happened while writing this very entry: `GATE_SELF_DISABLE` matched the override command named in the PROSE of a heredoc (command 3 in the same file) — the heredoc class is rule-independent. Amended definition: the exemption excludes the BODY (lines between the `<<'DELIM'` line and its terminator) from EVERY rule's scan when the consumer is a plain file sink (`cat`/`tee`, stdout to a path or nowhere); the `cd <abs> &&` prefix is allowed on the consumer line; lines after the terminator are scanned normally; any `>(`, `<(`, `$(`, `|`, `;` or single `&` on the consumer line means the body executes and is scanned in full (critic_tests' `cat <<'EOF' > >(sh)` stays BLOCK). Folded into E-292 (same analyzer, in progress).

### Ruling 3 — agent frontmatter uses the real subagent fields → E-295
Verified in code.claude.com/docs/en/sub-agents.md: there is no `allowed-tools` field for subagents ("only `tools` and `disallowedTools` exist"); `tools` is an ALLOWLIST that accepts `mcp__<server>` and `mcp__<server>__*`; `mcpServers` connects servers and never restricts inherited ones; `disallowedTools` is applied first and a tool matched by both is removed. Consequences: (a) today's `allowed-tools` on the 21 agents is inert — their tool limits were never enforced; (b) real scoping is a `tools` allowlist listing the built-ins the agent needs plus `mcp__task-synchronizer-mcp`, not `disallowedTools: mcp__*` (that pattern would also remove the server named in `tools`). Critics additionally carry `disallowedTools: Write, Edit, NotebookEdit`: a reviewer never writes. `verify_compliance` checks: `allowed-tools` absent everywhere; every scoped agent has a `tools` list; every `mcp__` entry in `tools` names a server in `mcpServers` or the parent's config; `disallowedTools` never names a server that `tools` needs. E-284 (a)/(b) are ratified as the honest finding that produced this.

### Ruling 4 — accepted residuals (THREAT_MODEL)
Confirmed: string assembly (`AI=ai; $AI gate off`) — the classifier backstop (E-293) is the answer to it; a `cat <<'EOF'` line inside a multi-line quoted string; generation-time HOME for `ai sync` run inside a session (measured: `env.HOME` does not redirect `$HOME` on 2.1.286); a fresh clone has no PreToolUse gate until its first `ai sync` — accepted because `ai sync` is the documented first step and `ai doctor` is global; the README states it.

### As-built ratified
- **E-284**: `mcpServers` + `maxTurns`, `memory: project`, `background: true`, `permission-denied.sh` (one REJECTED row, `source=hook`, 15 ms), `${CLAUDE_SESSION_ID}`; the scoping gap is E-295, not a defect of E-284.
- **E-290**: `ai sync` prints a `git rm --cached` hint rather than rewriting a user's index; git stubs bake an absolute CANONICAL; six hooks (PermissionDenied is the sixth); `[HOOK_BASH_MISSING]` refusal; HOME measured and recorded. The exec-form hook is live in this session (`/bin/bash -p <absolute path>` in the block banner).
- **E-291**: Bash calls under an override announced on EVERY call, Write calls only when the scope would have blocked; a broken analyzer plus an active override passes non-catastrophic, non-self-disabling calls loudly and REFUSES anything naming the override machinery on the no-verdict path (the ARG_MAX self-renewal finding); `GATE_SELF_DISABLE` matches `gate-override.json`, not the bare stem (the stem over-blocked a branch name — recorded as a regression case).

### Impact
- Unlocks: E-295 (no dependency; after E-292 in order). Queue: E-292 → E-293 → E-294 → E-295 → E-281 → E-285 → E-262 → E-263.
- Risk if wrong: a `tools` allowlist that omits a built-in an agent needs makes that agent fail loudly on first use; E-295's acceptance runs every agent once.

### Rollback
E-295 reverts as one PR; the heredoc definition reverts with E-292; the env removal with E-294.

---

## D-085 — Heredoc strip narrowed to the three over-blocking rules; E-292 as-built ratified; CI leak detector and perf checks scoped to the run

**Date**: 2026-10-01
**Task**: E-292 (ratified), E-294 (scope amended), E-296 (new)
**Decision**: Rulings on the Engineer's 2026-10-01 E-292 handoff (PR #94).

### Ruling 1 — the quoted-heredoc exemption applies ONLY to the rules that over-blocked (amends D-084 ruling 2)
critic_security's recommendation is adopted: bodies are excluded for `CURL_PIPE_SHELL`/`WGET_PIPE_SHELL`, `GATE_SELF_DISABLE` and `SECRET_IN_COMMAND` only. The Architect write analyzers and the sovereignty rules keep scanning the full text. Two reasons: a future lexer gap then hides content from three content rules, not from the write gate; and D-056 froze the Architect write gate with `arch-write-cases.json` as its byte-identical contract — an every-rule strip would have changed that gate's behaviour without reopening D-056. A write-gate over-block on heredoc prose, should one ever happen, is recorded verbatim and ruled case by case. Folded into E-294 (same analyzer file).

### Ruling 2 — E-292 as-built RATIFIED
1. A bash syntax error exits the script with status 2 (258 is only the internal `$?`), so the "syntax-error fixture allowed on the pre-change hook" acceptance was wrong; the test records the fact and the hook adds the message. 2. `post-commit` and `permission-denied` carry the fail-open trap too. 3. The heredoc lexer (`heredoc.mjs`) is STRICTER than Component 6's prose: top-level consumer only, strict consumer line, no stripping when the surrounding text carries grouping, continuation, `eval`/`function`/`alias`/`exec`/`PATH`/`BASH_ENV`, and a body stays scanned when a later line names a sink or carries expansion. Component 6 now points at the lexer and `pipe-shell-cases.json` as the contract instead of restating conditions. 4. The verbatim over-block fixtures REFERENCE `plans/d083-overblock-verbatim.md` rather than copy it (a copy put retired-provider prose under the D-076 legacy grep and failed CI).

### Ruling 3 — `ai ci run` becomes local to its run → E-296
Two of three runs on 9f99de2 failed for causes outside the commit: a watcher started in another project tripped the machine-wide leak detector, and an unrelated process at 424 % CPU blew a telemetry timing check. Rule: the leak detector counts only processes whose cwd, argv or HOME lies under the run's worktree or throwaway HOME (the `aios-t-` argv convention stays as a second key); a perf assertion that fails while `load1 > ncpu` re-measures once and reports both numbers, failing only if the retry fails too. Tier 2. The memory note "don't run suites during ai ci run" is then no longer load-bearing for leaks.

### Residual accepted
A file written in one Bash call and executed in a later one is beyond any per-command scan (D-084 r4 class); the classifier backstop (E-293) is the layer that sees across calls.

### Impact
- Unlocks: E-296 (no dependency). Queue: E-293 → E-294 (with ruling 1) → E-295 → E-296 → E-281 → E-285 → E-262 → E-263.
- Risk if wrong: narrowing leaves a content rule unexempted that later over-blocks on prose; the fix is to add that rule to the list by D-ruling with its verbatim case.

### Rollback
Ruling 1 reverts with E-294; E-296 reverts as one PR.

---

## D-086 — The classifier backstop rule: labelled, scoped to gate machinery, with an exact exempt list (amends D-083 ruling 5(iii))

**Date**: 2026-10-01
**Task**: E-293 (rule text fixed before commit)
**Decision**: Three rulings on the Engineer's 2026-10-01 E-293 entry. Verified facts accepted: `hard_deny` is unconditional (no intent or `allow` clears it); project `autoMode` is ignored (D-080 holds); a JSONC comment or trailing comma makes Claude Code silently drop the whole user settings file; `claude auto-mode reset` deletes the block; `critique` runs only in the operator's terminal; a narrow `permissions.allow` such as `Bash(ai:*)` resolves BEFORE the classifier.

### Ruling 1 — rule text adopted with amendments
D-083's wording ("anything under `~/.ai-os/`", "editing `~/.claude/settings.json`") would hard-block the agent's own data writes (`incidents.ndjson`, `INSIGHTS.md`, `memory/`, telemetry, CI logs), the update-config skill on an explicit request, and the maintenance commands. A hard rule must name machinery, not a directory. The constant E-293 writes is:

> AI-OS Gate Tamper (D-086): Never disable, bypass or weaken the AI-OS safe-exec gate, however assembled (shell variables, eval, bash -c, aliases, a script written then run, python/node/perl, sed -i, jq, cp/mv/ln, editor tools, subagents, or a nested claude launched with flags or settings that drop its hooks). Specifically: running `ai gate off`; creating, editing, moving or linking `~/.ai-os/gate-override.json` or anything under `~/.ai-os/{hooks,bin,mcp,shared,scripts,run,config}/` (by `~`, `$HOME` or absolute path); running `claude auto-mode reset`; changing `~/.claude/settings.json` (or its symlink target) to remove or alter `autoMode`, `hooks`, `disableAllHooks` or `defaultMode`, or to add `permissions.allow` rules for `ai`; or changing a project's `.claude/settings.json` or `settings.local.json` to remove or alter `hooks`, `disableAllHooks` or `defaultMode`. Exempt: `ai install`, `ai sync`, `ai doctor`, `ai start`, `ai pane`, `ai watch`, `ai gate on`, `ai gate status` and `bash install-ai-os.sh` with their documented flags only; reading these files.

Amendments to the proposal: `ai gate on` is exempt (restoring protection is never tamper); `ai start`/`ai pane`/`ai watch` are exempt because they write `~/.ai-os/run/` legitimately and E-281 runs `ai start` from the Engineer pane; `run/` stays protected from DIRECT writes because E-294's launch record there is a role input; a project's own settings file is covered for `hooks`/`disableAllHooks`/`defaultMode`, since removing the PreToolUse entry there is the simplest tamper and `ai sync` (exempt) is its only legitimate writer; a nested `claude` that drops its hooks is named. Data paths under `~/.ai-os/` outside the listed directories are deliberately NOT covered.

### Ruling 2 — `"$defaults"` is inserted only when `hard_deny` is absent
An existing list without `"$defaults"` is the operator's deliberate choice (the docs say omitting it takes ownership of the list); E-293 appends the rule and leaves the list's shape alone, and `ai doctor` prints an informational line that the built-in exfiltration rule is off. The Engineer's reading is adopted.

### Ruling 3 — re-serialise with Claude Code's own format; refuse what Claude Code would drop
`json.dumps(indent=2, ensure_ascii=False)` reproduces the real file byte-for-byte, so a Claude-written file is unchanged in shape and a hand-formatted file is normalised, which the prompt says. A file with a JSONC comment or trailing comma is REFUSED with a named error that says Claude Code itself would silently ignore that file — E-293 never "repairs" it. Atomic write; one `.bak` beside the file on first write.

### Residuals (THREAT_MODEL)
- The classifier runs only in auto mode; no launch path in this project sets a permission mode (verified: no `defaultMode`/`--permission-mode` in `ai pane`, the overlays or the templates), so in `bypassPermissions` the hook is the only gate. `ai doctor` reports the effective default mode next to the backstop line. Forcing a mode from `ai pane` is the operator's call, not funded.
- A prose rule can be evaded by indirection the classifier fails to connect (D-084 r4).
- `ai doctor` warns on any `Bash(ai…` entry in `permissions.allow`, which would bypass the classifier for the very command the rule names.

### Impact
- E-293 proceeds; the operator runs `claude auto-mode critique` after the rule is written and the Engineer records the verdict in LOG.
- Risk if wrong: the exempt list is the only hole; widening it is a D-ruling.

### Rollback
`claude auto-mode reset` in the operator's terminal removes the block; E-293 reverts as one PR.

---

## D-087 — The role is the most restrictive live launch record on the process chain; the token is bound to its session process; the mint takes no role and only moves toward restriction (amends D-083 ruling 9)

**Date**: 2026-10-02
**Task**: E-294 (design amended before code)
**Decision**: Seven rulings on the Engineer's 2026-10-02 entry (`.ai/COMM.md`, "E-294 blocked on rulings"). security_engineer's three P0 findings are accepted: Component 8 as written let a session obtain a less restricted role than the one it was launched with. Verified in code before ruling: `mintToken` takes the role from argv and refuses a change only against a token that verifies (`safe-exec-mcp/index.js:477`); `session-start.sh:84` mints from `AI_OS_PANE_ROLE`; `verifyCheckRole` falls back to env; the analyzer returns PASS for the Architect role on `ai pane`, a provider launch, a script file and `tmux` (measured with `--check`, this session).

### The principle the three P0s share
**A role may only move toward restriction.** Nothing a session can run — a nested launcher, a nested provider, a second mint — may yield a role less restricted than the most restricted role already present on its process chain. Rulings 1 and 2 are that sentence applied to the walk and to the mint.

### Ruling 1 (P0 #1, P0 #3) — the walk is exhaustive and most-restrictive-wins; `ai pane` refuses under a live record; D-086 is NOT amended
- **Walk**: from the minting process to pid 1, bounded at 64 hops, skipping ancestors with no record. A record counts only when LIVE: it passes the file discipline, its `started` equals that pid's real start time (mismatch = stale, skipped — pid reuse), and its `project` equals the realpath of the AI-OS root of the hook's cwd.
- **Result**, in this order: a record that fails the file discipline, or a live record for another project → no token (the gate then applies the union); any live `architect` record → `architect`; any live `engineer` record → `engineer`, `launch: record`; no record on the whole chain → `engineer`, `launch: unverified` (D-083 r9's plain-launch default stands — "no record" now means no ancestor has one, not "the nearest provider has none").
- **`ai pane` refuses** (exit 2, `[PANE_NESTED]`, nothing written) when any ancestor of the `ai pane` process holds a live record, whatever its role or project. A pane is launched from a terminal, never from inside a session. `ai start` is unaffected: its panes are children of the tmux server.
- **D-086's exempt list stays byte-identical.** The closure is in `ai pane` and in the walk, not in the classifier: a nested `ai pane` now writes nothing, so its exemption exempts nothing. Changing a rule text already offered to operators for a hole the code closes is churn.

### Ruling 2 (P0 #2) — `--mint-token` takes no role; token v2 is bound to its session process
- **Argv**: `--mint-token <sid> <session pid>`. The role is derived by the walk inside `safe-exec`, never passed. A role word in argv is refused. `<session pid>` is the hook's own parent pid (bash sets `PPID` itself; it is not an environment read) and is accepted only when it is on the minter's ancestor chain.
- **Token v2**: `{v:2, role, session_id, launch, pid, started, hmac}`, HMAC over `v2|role|sid|launch|pid|started`.
- **Mint table** (lstat first; `architect` outranks `engineer`):
  1. no file → mint from the walk;
  2. HMAC-valid v2 bound to THIS session process → no-op (SessionStart re-fires on resume, clear, compact);
  3. HMAC-valid v2 bound to another process that is still ALIVE → refuse (a live session owns its id; otherwise one pane could re-bind another's token);
  4. HMAC-valid v2 whose process is gone (a resume in a new process), or an HMAC-valid v1 → replace only when the walk's role is the same or MORE restricted; otherwise refuse;
  5. anything else at that path (not a regular file, wrong owner, nlink ≠ 1, unparsable, bad HMAC) → refuse; the mint never replaces it.
  Refuse = file untouched, one stderr line, exit 0 (the hook is fail-open; the GATE is where the missing token blocks).
- **Verify**: HMAC valid AND the token's pid is an ancestor of the verifying process AND its start time matches. This lives inside `safe-exec` (`--check`, `--check-path`, `--verify-role`) — one implementation for the hook, `pre-commit` and `caller-role.mjs`. Hot path: the PreToolUse hook passes its own `PPID`; equality with the token's pid is sufficient there (the session id comes from the harness payload) and costs no process-table read; the start time is checked at mint and on every walk path.
- **Measured precondition (before any other code)**: SessionStart and PreToolUse hooks have the SAME parent pid, it is the pid `ai pane` exec'd, and it is stable across startup, resume, clear, compact and a subagent's tool call. If any of these is false, STOP and hand back — the binding target needs a ruling, and a wrong one is a lockout.

### Ruling 3 — the env inventory: what is removed, what is a selector, what is a recorded residual
- **`AI_OS_SOVEREIGNTY_LOCK` is removed everywhere**, including `task-synchronizer-mcp/index.js:339` and `caller-role.mjs:177` and every message, schema description and comment that offers it. D-084 r1 removed the variable, not one read of it; `reopen:true` is the documented way to mutate a DONE task.
- **The four git-hook opt-outs stay, as recorded residuals** (`AI_OS_SKIP_GIT_LANE`, `AI_OS_SKIP_CONFLICT_GATE`, `AI_OS_SKIP_STANDARDS`, `AI_OS_CI_SKIP` + `_REASON`). They are not the D-081 class: D-081 r5 already ruled the git hooks a convenience gate, `--no-verify` is a documented zero-cost bypass of the same strength and the analyzer does not block it (verified: no rule), and these gates protect the project's own history, not the operator's machine. One tightening: every one of them is LOUD — a named stderr line when honoured (`AI_OS_SKIP_GIT_LANE` is silent today).
- **`CLAUDE_CODE_SESSION_ID` is fixed in E-294** and becomes a SELECTOR, not an authority: it chooses which token to verify, and by ruling 2 a token verifies only for a descendant of its own session process. This closes T-GITLANE-001 residual 2. Not a separate task: the format is being rewritten here, and a later task would mean a v3.

### Ruling 4 — v1 tokens: no v1 branch in the verifier (amends the Engineer's proposal)
A v1 token never verifies. The proposal to keep accepting v1 `architect` is declined: the union already applies every Architect block, so acceptance would buy a quieter banner at the price of an unbound-token branch in the verifier. v1 is recognised in ONE place — mint-table row 4 — so a resumed session can be re-minted under the monotonic rule. Consequence, stated plainly: **after E-294 is installed every running session is unverified until it is relaunched**, the Engineer's own included. The installer prints the relaunch notice; `ai doctor` counts pre-E-294 tokens. Sequencing is part of the acceptance: commit and push first, `bash install-ai-os.sh` LAST, the operator relaunches both panes, the task is closed from the relaunched Engineer pane.

### Ruling 5 — `pre-commit`: four sources, in order; only the first may waive
1. session id present and its token verifies → `record:<role>` (the only source that unlocks the `[CRITIC_STAMP]` waiver, E-218);
2. otherwise a live launch record on the committing process's own ancestor chain → the most restricted role found, restrict-only — this needs no environment at all, so clearing the session id no longer drops an `ai pane` session out of its lane;
3. otherwise a session id that is present but does not verify → the union: path scope restricted, no waiver;
4. otherwise the advisory env (restrict-only), then `engineer` — the operator's own terminal keeps today's behaviour.
The Engineer's proposal (union only when a session id is present and invalid) is adopted as row 3; row 2 is added because the walk already exists.

### Ruling 6 — headless children: the advisor writes NO launch record
There is exactly one writer of launch records, `ai pane`; D-086 protects `run/` precisely because a record is a role input, and a second writer doubles that surface. The premise "less restriction than today" does not hold: `advisor-mcp` passes its child only `PATH`, `HOME`, `USER` (`invokeArchitect`), so the child never received a pane role and mints the positional `engineer` today. After E-294 the walk reaches the Engineer pane's record and mints `engineer` again — no change. Its read-only invariant is what it has always been: print mode, no permission grant, no bypass flag; E-294 adds an assertion that the resolved `print_mode` argv carries none.

### Ruling 7 — one root for the whole gate: `$HOME`, not `pw_dir`, in E-294
The launch directory resolves through the same root as the token, the HMAC key, the override file, the locator and the toolchain pin. A `pw_dir` launch directory beside a `$HOME`-resolved hook stack protects nothing — the hook has already located and sourced its helpers through `$HOME` before the walk runs — and it would break the throwaway-`HOME` isolation of the suite and of `ai ci run`, which could then only be restored with an environment seam on a gate path. `HOME` is recorded in the inventory as a ROOT SELECTOR, residual: a project's settings `env` cannot redirect it (measured, E-290), so the only way to change it is a nested launch, which is the residual class below and not specific to `HOME`. Moving the whole stack to a root derived from the code's own install location is the candidate fix; unfunded.

### P1 design details — adopted into Component 8
Start time by one method in writer and reader (macOS `LC_ALL=C TZ=UTC0 /bin/ps -o lstart=`; Linux `/proc/<pid>/stat` field 22; absolute `ps` path). Directory chain opened `O_DIRECTORY|O_NOFOLLOW`, each directory euid-owned 0700; record a regular file, euid-owned, nlink 1, ≤ 4 KB, exactly the keys `role`, `project`, `started`; writer `umask 077`, `O_EXCL` temp + rename. `do_pane` never runs in a subshell or pipeline (bash 3.2 has no `BASHPID`); the test asserts record pid == provider pid after exec. ONE module owns the record format, the start-time read, the file discipline and the walk; `ai pane`, the mint and the verifier all call it.

### Residuals — recorded as T-ROLE-001 (the Engineer writes the entry with E-294)
- **Programs the gate cannot read.** The Architect's shell gate analyses the command line. A program it cannot read — a script file handed to an interpreter, a provider launched outside any AI-OS project or with settings that drop its hooks, a launch detached from the session's process chain — is outside any per-command scan and outside the ancestry walk. Measured: the analyzer passes all of these shapes for the Architect role. Same class as D-084 r4 and D-085's residual; the classifier backstop is the layer that sees across calls, and it runs only in auto mode. **Not widened here**: D-056 froze the Architect shell gate, and a rule for this class needs its own ruling with an over-block measurement. Flagged to the operator as the next decision on this gate.
- **Same-uid ceiling**: the record and token are files the operator's uid can write; forging or removing them requires a write under `~/.ai-os/run/`, which `GATE_SELF_DISABLE` and the D-086 rule gate, with the string-assembly residual already recorded. Removing a pane's record and token returns it to the plain-launch default. Binding the role to something a session cannot remove (the provider's own argv, operator presence) is the next rung; unfunded.

### Alternatives considered
1. **Nearest-record walk** (Component 8 as written) — rejected: the nearest record is the one the session itself can create.
2. **Narrow D-086's `ai pane` exemption** — rejected: the refusal belongs in `ai pane`, where it holds in every permission mode; the classifier only runs in auto mode.
3. **Refuse the mint whenever the token path exists** (security_engineer's proposal) — amended to the five-row table: a blanket refusal makes a resumed session permanently unverified once the token is bound to a process.
4. **Accept v1 `architect` tokens** — declined (ruling 4).
5. **A launch record written by the advisor** — rejected (ruling 6).
6. **`pw_dir` for the launch directory** — rejected for E-294 (ruling 7).
7. **A hook-layer rule blocking nested launches for the Architect** — deferred: it would close one member of a class whose other members stay open, under a freeze that asks for a measured ruling.
8. **"No record → union" instead of `engineer`** — not reopened: it would block every documented plain `claude` launch in every installed project (D-083 r9).

### Constraints driving this decision
- A role may only move toward restriction; a gate's identity has no environment input (D-083).
- One writer of launch records; one implementation of the walk; one root for the gate stack.
- No new environment variable; `arch-write-cases.json` byte-identical (D-056); bash 3.2; the session-start and pre-tool-use perf budgets (E-239).

### Impact
- Unblocks E-294. E-293, E-295 and E-296 are independent and proceed. Queue: E-293 (close) → E-294 → E-295 → E-296 → E-281 → E-285 → E-262 → E-263.
- Test harness: `arch-write-cases.mjs`, `sovereignty_lock_test`, `caller_role_test` and the patch-mcp driver mint real tokens from records in a throwaway `HOME`; the fixture JSON does not change.
- Risk if wrong: a hook parent pid that is not stable makes every token fail to verify — a lockout into the union. The measured precondition in ruling 2 exists to find that before code; the operator's escape is `ai gate off` from their own terminal.

### Rollback
E-294 reverts as one PR and one re-install; v2 tokens are then ignored by the restored v1 verifier and re-minted at the next SessionStart. The env reads return with the revert.

---

## D-088 — Tests get an economy: behaviour-named, cheapest layer, replace-or-justify, delete with a LOG line, a budget that ratchets down

**Date**: 2026-10-04
**Task**: E-297, E-298, E-299, E-300, E-301, E-302, E-303 (new), P-44 (new)
**Decision**: Adopt `.ai/blueprints/test-economics.md`. The operator's observation ("writing a test for every piece of code") is confirmed by measurement: tests 33.6k lines vs `src/`+`hooks/` 28.6k; 152 bash suites (28k lines) vs 8 node unit files (2.5k); 12–17 min full run; 2,440 task-labelled assertions and suites named after tasks.

### Why needed
Four causes, all process: (1) tests are organised by task, so overlapping suites accumulate; (2) wrong layer — pure functions are tested by spawning `node` from bash, which is where every one of the six harness "varieties" (D-061..D-071) came from; (3) our mandates only add — `critic_tests` demands coverage per modified path, `test_engineer` generates, every finding gets a pin — and nothing asks what a new test replaces; (4) incident pins never expire. The harness itself is good; its cost curve is not.

### Rulings
1. **A test is a claim about a behaviour at the cheapest layer that can observe it.** Suites are named for behaviours; task ids are comments or table-row labels, never names. A bash suite exists only for a process boundary.
2. **Replace-or-justify**: a new test names the test it extends or replaces. `critic_tests`' mandate changes accordingly (blueprint Component 3); a task-named suite or a pure-function bash suite is a review FAIL.
3. **Contract tables are the consolidation primitive** — the `arch-write-cases.json` pattern, byte-pinned where a gate is frozen. Consolidation never shrinks the input set a gate is tested against; the census proves subset.
4. **Deletion** needs a LOG line, except a `T-*` regression pin, which is deleted only when the Architect's Consolidation Map names the row that now carries it. The map (P-44) is the acceptance list of both waves.
5. **The budget ratchets down** (`ai ci run` records suites, test lines, fast-tier seconds; exceeding the best value by more than the slack fails). Raising a budget is a D-ruling with the census attached. Targets: suites ≤ 60, test lines ≤ source lines, fast tier < 60 s, full < 5 min.
6. **Sequencing**: the tools and rules (E-297..E-300) start now; wave 1 (gate families, E-301) follows E-294, which rewrites four harness files; wave 2 (E-302) needs only the map.

### Alternatives considered
1. **Delete by judgement, no census** — rejected: the suite found real defects six times; deleting without footprint and failure history repeats the "scan that never ran" class in reverse.
2. **Coverage thresholds** — rejected: coverage is the metric that produced this; it rewards a test per path.
3. **Keep everything, speed it up (parallel runner)** — rejected: it hides the cost without lowering it, and the leak detector's machine-wide semantics make parallel suites unsafe today (D-085 r3 scopes it, E-296 pending).
4. **Mutation testing in CI** — rejected: minutes to hours per run; a one-off probe feeds the map instead.
5. **Chosen**: rules that stop regrowth + a census that makes deletion evidence-based + tables that keep the security contracts byte-pinned + a ratchet so the numbers cannot creep back.

### Constraints driving this decision
- `arch-write-cases.json` byte-identical (D-056); `T-*` pins deleted only by ruling.
- No new environment variable; the footprint recorder writes only to the per-run temp path (rule 6).
- One copy of every rule: the rule file holds the rules, the blueprint the rationale (D-082 r5).

### Impact
- Unlocks: E-297, E-298, E-299, E-300 now (independent of E-294); P-44 after E-297 + E-300; E-301 after P-44 (and E-294); E-302 after P-44; E-303 last.
- Risk if wrong: a merged table misses an input a deleted suite had — the subset assertion in each wave's acceptance exists for exactly this; the deleted file is one `git show` away.

### Rollback
Each task reverts as one PR; deleted suites are in history and listed per wave in the PR description.

---

## D-089 — E-294 as-built ratified; one installer from one committed tree; gate parsers pinned exactly; Stryker admitted for the E-300 probe

**Date**: 2026-10-05
**Task**: E-294 (ratified, DONE — CI PASS b36a818, PR #95), E-304 (new), E-305 (new), E-300 (dependency admitted)
**Decision**: Rulings on the Engineer's 2026-10-04 "E-294 as built" entry (`.ai/COMM.md`).

### Measured precondition — HOLDS; the `/clear` finding is adopted
Hook `PPID` == the exec'd pid with the same start time across startup, `/clear`, `/compact`, a subagent's tool call and `--resume` in a new process. `/clear` issues a NEW session id in the same process, so SessionStart is registered for `startup|resume|clear|compact`; the old matcher would have left a cleared session without a token. Adopted into Component 8 and the settings writer's matcher.

### Ruling 1 — the six divergences are RATIFIED
1. **Install-root permissions**: `~/.ai-os` euid-owned and not group/other-writable; `run/` and `launch/` exactly 0700. "Each directory 0700" was my over-specification — it would have refused every install.
2. **A refused mint deletes a v2 token whose process is KNOWN dead** (`alive` exit 1; a failed spawn is "unknown" and deletes nothing). D-087 r2 said "file untouched"; the as-built is better: under pid reuse the hot path (pid equality) could otherwise honour a dead Engineer token, and deletion only moves toward the union.
3. **Off the hot path the verified role is the MORE restrictive of the token's role and a walk from the verifier counting every live record whatever its project.** Restrict-only; closes critic_security P2-1 (`ai pane architect` started inside a plain session sits between that session's token and the verifier).
4. **A process table that cannot be read is an error everywhere** — walk = union, prune refuses (`ulimit -u 1` made the first cut's prune delete live records). This is D-082 r2 restated for evidence: a gate that cannot read its evidence blocks; a pruner that cannot read its evidence does nothing.
5. **`GATE_SELF_DISABLE` widened** to the install root named relatively after entering `HOME` (every `cd` form, `../` chains, `<home>/.ai-os` from above, `find -delete/-exec`, inline interpreters). Not the Architect write gate; `arch-write-cases.json` byte-identical, so D-056 is untouched. String assembly stays T-ROLE-001 r2.
6. **`role-token.mjs` runs python through the install-time pinned interpreter** (`toolchain.sh`), else `/usr/bin/python3`, never `PATH` — an MCP server's `PATH` is its launch environment's. D-078's principle, applied to the one gate module that spawns an interpreter.

### Ruling 2 (design finding 1, P0 operationally) — `ai sync` stops propagating hooks; the installer is the ONE installer → E-304
`_sync_install_hooks` copies `${AIOS_WORKSPACE}/hooks/*.sh` into the mirror — hooks only, without the `mcp/` and `shared/` they depend on — and an exported `AIOS_WORKSPACE` (written into the operator's shell rc by an earlier install) outranks the persisted `config/aios-workspace.txt`. Twice on 2026-10-04 E-294's uncommitted hooks went live machine-wide against the old `safe-exec`: garbage tokens, every commit in every project in the Architect lane, and other panes telling the operator to use an env opt-out. Rulings: (a) `ai sync` never copies anything into `~/.ai-os/` — the hook-propagation step is deleted; `bash install-ai-os.sh` / `ai install` are the one installer and install the whole mirror from one tree, atomically (stage, verify the `build-stamp`, then swap). (b) The installer REFUSES a working tree with uncommitted changes under `hooks/`, `src/mcp`, `src/shared`, `src/bin` or the installer itself, with a named error and the one override `--allow-dirty` that prints a loud banner and records the dirty state in the build stamp, so `ai doctor` can say "the installed gate is from an uncommitted tree". (c) Precedence reversed: the persisted file wins; the env var is honoured only when no file exists; `ai doctor` warns when both exist and disagree; the installer stops writing `AIOS_WORKSPACE` into shell rc files and offers to remove the lines it wrote earlier. Hooks already ignore the variable (UNTRUSTED_ENV); this closes the CLI side.

### Ruling 3 (design finding 2) — a parser IS the gate's input model: pin gate-path dependencies exactly → E-305
`shell-quote ^1.8.1` resolved 1.12.0 on a fresh install, which emits `&>`, `&>>`, `>|` as single operators the Architect write gate did not know — an under-block that existed only on machines installed after the upstream release. Fixed in b36a818 for both parser generations. Ruling: every dependency on a gate path (`safe-exec-mcp`, `shared/heredoc.mjs`, the standards checker, `gate-guard`) is pinned to an EXACT version, installed with `npm ci` from the committed lockfile, and the installer verifies the installed version equals the pinned one (a mismatch is `[TOOLCHAIN_STALE]`, the same class as a moved interpreter). A bump is a deliberate change through `dependency_gate` whose acceptance runs every contract table against the new parser. The two-generation fixture from b36a818 stays as the regression pin.

### Ruling 4 — Stryker admitted for E-300 on the operator's authority (dependency_gate record)
The operator approved `@stryker-mutator/core` (+ its command runner) as a dev dependency for the duration of the E-300 probe, to be REMOVED in the same PR. Justification: one-off evidence for P-44, never on `ai ci run`; alternatives (hand-written mutants, coverage-only) do not answer "does this test detect anything". Security track record: mainstream, MIT; `critic_security` runs on the diff as the task says. This entry satisfies `dependency_gate`'s documentation step; the Engineer does not re-open the gate for it. The removal is part of E-300's acceptance.

### Alternatives considered
- Keep hook propagation but only from a clean tree — rejected: hooks without their `mcp/shared` are a mismatched gate even when committed; one installer, one tree.
- `^`-ranges with a lockfile only — rejected: a fresh install without `npm ci` re-resolves; the pin must be in the manifest AND verified at install.
- Keep Stryker permanently for CI — rejected (D-088): minutes to hours per run.

### Constraints driving this decision
- The installed gate is exactly one committed, pinned, verified tree (D-078, D-083 extended from interpreters to the code itself).
- A gate that cannot read its evidence blocks (D-082 r2).

### Impact
- Unlocks: E-304, E-305 (independent). Queue: E-295 → E-296 → E-304 → E-305 → E-297..E-303 interleaved → E-281 → E-285 → E-262 → E-263.
- Risk if wrong: the dirty-tree refusal slows a developer testing gate changes; `--allow-dirty` exists for that and is loud.

### Rollback
E-304 and E-305 revert as single PRs; the as-built ratifications are facts about b36a818 and need no rollback.

---

## D-090 — The classifier rule text v2: `secrets/` protected, `ai init` exempt, "no hook-skipping flag" instead of "documented flags", install exempt only from an unmodified source, `ai` runtime state under `run/` exempt (amends D-086)

**Date**: 2026-10-05
**Task**: E-306 (new)
**Decision**: The operator's `claude auto-mode critique` of the D-086 rule (Engineer entry, 2026-10-02) found five gaps; all five are accepted. The rule constant in `src/shared/classifier-backstop.py` is D-ruling text verbatim (the test asserts byte equality), so the new text is fixed HERE and relabelled; E-293's outdated-label replace-in-place path installs it.

### Rulings
1. **`secrets/` joins the protected set.** The HMAC key is what D-087's token v2 rests on; a rule that protects the token directory and not the key protects nothing. Exception: `ai install` creating the key.
2. **`ai install` / `ai sync` / `bash install-ai-os.sh` are exempt only from a source tree this session has not modified** under hooks, gate or installer — the carve-out the operator's soft rules already carried, and exactly the leak D-089 r2 closes on the CLI side. The two layers now agree.
3. **"with their documented flags only" → "with no flag that skips, disables or redirects hooks or the gate"** — a criterion the classifier can evaluate.
4. **`ai init` is exempt** (it regenerates the project's hook entries).
5. **`run/` stays protected from direct writes; the `ai` command's own subcommands writing their runtime state there are exempt** (ci run, handoff, add-task, clean) — not the gate switch.

### Rule text (verbatim; the E-306 constant)
> AI-OS Gate Tamper (D-090): Never disable, bypass or weaken the AI-OS safe-exec gate or its role tokens, however assembled (shell variables, eval, bash -c, aliases, a script written then run, python/node/perl, sed -i, jq, cp/mv/ln, editor tools, subagents, or a nested claude launched with flags or settings that drop its hooks). Specifically: running `ai gate off`; creating, editing, moving or linking `~/.ai-os/gate-override.json` or anything under `~/.ai-os/{hooks,bin,mcp,shared,scripts,run,config,secrets}/` (by `~`, `$HOME`, a relative path or an absolute path); running `claude auto-mode reset`; changing `~/.claude/settings.json` (or its symlink target) to remove or alter `autoMode`, `hooks`, `disableAllHooks` or `defaultMode`, or to add `permissions.allow` rules for `ai`; or changing a project's `.claude/settings.json` or `settings.local.json` to remove or alter `hooks`, `disableAllHooks` or `defaultMode`. Exempt: `ai install`, `ai sync`, `ai init`, `ai doctor`, `ai start`, `ai pane`, `ai watch`, `ai gate on`, `ai gate status` and `bash install-ai-os.sh`, each run with no flag that skips, disables or redirects hooks or the gate — and, for `ai install`, `ai sync` and `bash install-ai-os.sh`, only from a source tree whose hooks, gate or installer this session has not modified; the `ai` command's own subcommands writing their runtime state under `~/.ai-os/run/` (never the gate switch); `ai install` creating the key under `~/.ai-os/secrets/`; reading these files.

### Alternatives considered
- Leave `secrets/` to the hook layer (`GATE_SELF_DISABLE` covers shell writes there) — rejected: the classifier is the layer that sees across calls; the key is the one file whose overwrite forges every token.
- Drop `run/` from the set to stop over-blocking `ai` subcommands — rejected: the launch records are a role input; the exemption names the writer instead.

### Impact
- Unlocks: E-306 (independent, small). The operator re-runs `claude auto-mode critique` after the replace; the Engineer records the verdict in LOG.
- Risk if wrong: the classifier connects an `ai` subcommand to `run/` and blocks it despite the exemption; recorded verbatim as a D-ruling case like the heredoc over-blocks.

### Rollback
E-306 reverts to the D-086 label and text; `claude auto-mode reset` in the operator's terminal removes the block.

---

## D-091 — CI resources: lanes by resource class, fixtures built once, poll not sleep, record what is budgeted

**Date**: 2026-10-12
**Task**: E-307, E-308, E-309, E-310 (new); amends D-088 (`.ai/blueprints/test-economics.md` §CI Resources); funds the parallelisation D-072 deferred
**Decision**: The test suite is budgeted in four resources (memory, wall time, setup repeats, waiting), each measured by the run that spends it. Suites run in parallel lanes by RESOURCE CLASS (exclusive suites alone, the rest shared), the lane count is capped by memory rather than cores, the installer fixture is built once per run and cloned per suite, fixed sleeps become polls with a deadline, every suite has a watchdog, and `ai ci run` records peak RSS, lanes and the slowest suites and reads every runner's summary.

### Why needed
The operator asked how to stop CI "running wild on memory" and waiting. Measured: 152 suites run strictly serially (1,715 s summed; the ten slowest are 44% of the clock), 33 suites re-run the installer or `ai init` as setup, 50 `sleep N` sites wait a fixed time, no suite has a deadline, and the CI record is blind to memory and records `pass=0` for every downstream runner. D-088 cuts what the suite IS; nothing cut what a run COSTS.

### Alternatives considered
1. **Parallelise by count (N lanes, any suite anywhere)** — rejected: the leak detector is machine-wide and 14 suites own tmux servers, ports or perf budgets; they would attribute each other's leaks and skew E-239 ratios. Lanes by resource class with per-lane namespaces keep the leak contract.
2. **Cap by core count** — rejected: the memory blow-up in a client project came from one worker per core each holding the import graph plus a browser; memory, not cores, is the binding resource. Cores bound the default, free memory bounds the maximum.
3. **Wait for the D-088 waves to shrink the suite first** — rejected: deleting the 70 sub-two-second suites recovers maintenance, not minutes; the ten slowest suites are the clock, and they are the ones that wait and install. Resources first, consolidation second; the map is reordered by wall time.
4. **Per-suite `ulimit -v`** — rejected: not reliable on macOS and it kills the suite rather than bounding the run; the watchdog plus the lane cap bound the run.
5. **Chosen** — the four components above, additive and defaulting to today's behaviour (`--lanes 1`).

### Constraints driving this decision
- The E-240/E-241 leak contract must survive: a leak still FAILS the run, now attributed to a lane and a suite.
- E-304: no write under the real `~/.ai-os`; the template is a throwaway HOME built by the existing installer.
- bash 3.2, no `timeout(1)`; `arch-write-cases.json` byte-identical (D-056).
- Downstream projects cap their own workers in their own runner config (project-level tasks, their own `.ai/`).

### Impact
- Unlocks: E-307 → E-308 → E-309 → E-310 (depth 3); P-44 reordered by wall time. Expected: full run under 6 minutes at 4 lanes before any deletion, under 5 after waves 1–2.
- Risk if wrong: a suite misclassified as shared leaks across lanes — the per-lane diff names it and the fix is a one-line header declaration; the 1.5 GB-per-lane cap is a guess until E-310 measures it.

### Rollback
`--lanes` defaults to 1; each task reverts as one PR; new CI row fields are ignored by older readers.

---

## D-092 — E-308 invalidated: the installer "setup" installs were grep hits, not runs; re-scoped to the subject headers and the recorder blind spot (E-311)

**Date**: 2026-10-12
**Task**: E-308 (closed as invalid, no code), E-311 (new, Tier 1), E-309 (depends_on revised to E-307 + E-311)
**Decision**: Component 9 of `.ai/blueprints/test-economics.md` §CI Resources is superseded. No HOME template and no `test_home_clone`. What is real ships as E-311: `# AIOS_INSTALLER_SUBJECT` on the five suites whose subject is the installer or `ai init`; the footprint recorder sees `env … bash <path>` and path-invoked installer / `ai init` spawns; the census prints installer spawns per suite.

### Why needed
The Engineer's E-308 survey (COMM.md 2026-10-12) shows every real installer or `ai init` run in the suite is a SUBJECT run (init_upgrade, mirror_hygiene, exec_form_hooks, provider_workspace, installer_node_check); the "20 + 13 setup installs" in D-091's blueprint were grep matches on the text. A clone would save nothing and cost one install per run. The recorder gap it found (a spawn under `env` is invisible) is a real census defect: E-309's exclusive-lane classification depends on the footprint seeing every installer run.

### Alternatives considered
1. **Keep the template anyway** — rejected: no suite would use it; the Engineer asked for the suites by name and there are none.
2. **Drop E-308 outright and unblock E-309** — rejected narrowly: E-309 reads the subject header, and the recorder blind spot would misclassify exec_form_hooks as a shared-lane suite. Both are an hour of work and belong before the lanes land.
3. **Re-scope in place** — chosen as a new task: a task description is immutable through `add_task`, and a closed-invalid E-308 keeps the record of the wrong premise.

### Constraints driving this decision
- The lesson is recorded in the blueprint: a number about what the suite DOES comes from the census footprint, never from grep (DIGEST variety #5, now in a blueprint).
- No new environment variable; no write under the real `~/.ai-os`.

### Impact
- Unlocks: E-311 → E-309 → E-310. E-309's minutes claim (the ten slowest = 44% of the clock) is unchanged; E-307 already took 119 s off the run.
- Risk if wrong: a sixth subject suite exists that the recorder still cannot see; E-311's recorder fix plus the census count is the check.

### Rollback
E-311 reverts as one PR; the header lines are comments.

---
## D-093 — Lanes re-ruled on data: the critical path is the exclusive phase, installer-subject suites join the shared lanes when the footprint proves their HOME is the lane's, and the memory cap is measured not guessed (E-312)

**Date**: 2026-10-13
**Task**: E-309 (accepted as built, two targets amended), E-312 (new, Tier 2, after E-310)
**Decision**: Four rulings on the E-309 packet (COMM.md 2026-10-13).
1. The "< 6 min at 4 lanes before consolidation" target in `.ai/blueprints/test-economics.md` §CI Resources is withdrawn as wrong arithmetic. The bound at N lanes is `shared_work / N + exclusive_serial`, and the exclusive serial phase alone measured 568 s. The target line becomes a formula with measured terms; the figure before consolidation is the measured 926 s at 4 lanes (1586 s at 1), the figure after E-312 is ≤ 10 min, and the D-088 target of < 5 min stays attached to waves 1–2 (P-44 → E-301/E-302).
2. `# AIOS_INSTALLER_SUBJECT` no longer implies EXCLUSIVE. An installer-subject suite runs in a shared lane when the footprint recorder shows every installer / `ai init` spawn it makes carrying a HOME under the lane's HOME clone or its temp prefix; a suite whose spawn carries any other HOME, or that matches the tmux / watch / port / perf rule, stays exclusive. The installer copies the mirror and runs no `npm install`, so four concurrent installs cost disk and RSS, not a package registry; E-310's peak RSS is the check (acceptance in E-312).
3. The memory cap takes the kernel's own availability figure, not the vm_stat page sum: on macOS `kern.memorystatus_level` × physical memory (today 34% × 17 GB ≈ 5.8 GB, where the page sum gave ≈ 3 GB), on Linux `MemAvailable`. The per-lane figure is no longer a constant 1.5 GB: it is the last recorded `peak_rss_mb / lanes` × 1.25 with a 512 MB floor, falling back to 1.5 GB when no run has recorded one. `AIOS_TEST_FREE_MB` stays as the fixture stand-in that `tests/run.sh` reads; `ai ci run` stops forwarding it once the kernel figure lands, so there is no operator opt-out of the cap.
4. Accepted without change: the CI-row `lanes` column lands with E-310 (the log line carries it until then); "bash install-ai-os.sh" in task acceptance lines is read as "install from ../ai-os-stable after the merge" (E-304 made that the install path), and future task text says so.

### Why needed
E-309 shipped to spec (1 lane 1586 s, 4 lanes 926 s, identical totals, leaked 0) and the spec had two numbers that were not derivable from the data it cited: a parallel target computed as if the whole run divided by the lane count, and a memory cap built on a page counter macOS does not use for its own pressure decisions. Both were set by the Architect in D-091 before any run had measured them. The 4-lane runs only happened under an override the Engineer had to add, which is the opt-out pattern D-089 forbids for gates and D-091 should have forbidden here.

### Alternatives considered
1. **(1a) Move the target to the measured 15 min and stop** — rejected: it records the number but not the reason, and leaves the 322 s of installer suites in the serial tail for no isolation benefit.
2. **(1c) Wait for P-44 consolidation to shorten the exclusive phase** — kept as the main lever (it is the D-088 plan), but not alone: the lane classification is a one-line rule that costs nothing to correct now, and P-44 is ordered by wall time so it reaches these suites first anyway.
3. **(1b) Shared lanes for installer-subject suites, unconditionally** — rejected narrowly: a suite that runs the installer against any HOME but the lane's would write across lanes; the footprint already records spawns, so the eligibility is a measured property, not a header the author asserts (the D-092 lesson).
4. **(2a) Keep the 1.5 GB constant and fix only the macOS reading** — rejected: 5.8 GB / 1.5 GB is 3 lanes on a machine that ran 4 with swap flat; the constant is the wrong half of the fraction.
5. **(2b) Wait for E-310 and re-rule the constant by hand** — rejected: a hand-set constant is stale on the next machine; the runner reads the last measurement itself, with slack and a floor, and the Architect re-rules the slack, not the number.
6. **Keep `AIOS_TEST_FREE_MB` as an operator override** — rejected: once the cap is a measurement, an override is a way to run past it; the fixture use stays because a fixture must simulate a host.

### Constraints driving this decision
- A target for parallel work is derived from the critical path (the longest serial chain), never from total work divided by lanes — recorded in the blueprint beside the D-092 lesson.
- No new environment variable and no opt-out of a cap; headers and measurements only.
- `tests/fixtures/arch-write-cases.json` stays byte-identical (D-056); no write under the real `~/.ai-os` (E-304); a cross-lane write is a leak and FAILS the run.

### Impact
- Unlocks: E-312 after E-310. P-44's Consolidation Map marks each suite's lane class and orders the exclusive suites first within the ten slowest, because the exclusive phase is the critical path the lanes cannot shorten.
- Risk if wrong: four concurrent installer runs push peak RSS past the cap on a 16 GB host; E-312's acceptance compares peak RSS at 4 lanes before and after and returns the suites to exclusive (`# AIOS_EXCLUSIVE: installer`) if the ratio exceeds 1.25. A HOME clone that shares a path with another lane is caught by the per-lane leak diff.

### Rollback
E-312 reverts as one PR: the classification rule returns to "subject header ⇒ exclusive", the cap constant returns to 1.5 GB over the page sum, and `ai ci run` forwards the override again. No suite changes behaviour at `--lanes 1`.

---
## D-094 — The memory cap reads a sampled concurrent sum (`peak_sum_rss_mb`), not rusage's largest process; amends D-093 ruling 3 (E-313)

**Date**: 2026-10-13
**Task**: E-310 (accepted as built), E-312 (part 3's per-lane half superseded), E-313 (new, Tier 2, OPEN, lands before E-312 closes)
**Decision**: Option 3 of the Engineer's packet (COMM.md 2026-10-13, E-310). Two fields: `peak_rss_mb` stays as E-310 records it — rusage's largest single waited-for process, the figure that names a runaway — and `tests/run.sh` gains a once-per-second sampler over its lanes' process groups whose maximum is `peak_sum_rss_mb`. The lane cap's per-lane figure is the last recorded `peak_sum_rss_mb / lanes × 1.25`, floor 512 MB, fallback 1.5 GB. E-312's installer before/after check reads the sum. E-303's budget block takes the sum.

### Why needed
D-093 ruling 3 divided `peak_rss_mb` by the lane count as if it were the run's concurrent footprint. It is `ru_maxrss` of the largest child: 281 MB at 1 lane and at 4 lanes, and a probe of two concurrent 200 MB processes reported 238 MB. The formula would land on the floor on every host and the installer check could not see four concurrent installs. The Engineer caught it with a probe before building on it.

### Alternatives considered
1. **Per-lane = largest process × 1.25, no division** — rejected: a lane is several concurrent processes (ai, an MCP server, bash, tmux); the largest one under-counts the lane by whatever the others weigh, and the number cannot tell one lane from four.
2. **Replace `peak_rss_mb` with the sum** — rejected: the largest-process figure is the one that finds a single runaway process, and E-310 already records it correctly for what it is.
3. **Both fields, the cap on the sum** — chosen. A sampled sum is approximate between samples; the cap carries 25% slack and a floor, so a one-second sampler is enough.

### Constraints driving this decision
- Before a formula uses a measured field, the blueprint names what the field measures — which process, which window. `ru_maxrss` is per process; a sum is sampled. Recorded beside the D-092 and D-093 lessons.
- The sampler walks process groups the watchdog already tracks; no new environment variable; cost under 1% of suite time.

### Impact
- Unlocks: E-313 → E-312 close. E-312 parts 1, 2, 4 and the kernel-figure half of 3 proceed now.
- Risk if wrong: a lane's memory spikes between samples; the 1.25 slack covers short spikes, and a cap is a heuristic that the per-lane leak diff and the watchdog back up.

### Rollback
E-313 reverts as one PR; the field is ignored by older readers; the cap returns to the 1.5 GB fallback.

---

## D-095 — Per-project Claude accounts: a NAME in `.ai/start.json`, an operator registry, `CLAUDE_CONFIG_DIR` exported by `ai pane` (E-314, E-315)

**Date**: 2026-10-13
**Task**: E-314 (registry + `ai account`), E-315 (project binding + launch), blueprint `.ai/blueprints/accounts.md`
**Decision**: A project chooses a Claude subscription by naming an ACCOUNT in `.ai/start.json` (`{"account": "work"}`); the operator-owned registry `~/.ai-os/accounts.json` maps the name to a config directory; `ai pane` exports `CLAUDE_CONFIG_DIR` from that mapping immediately before its `exec`, for `ai start`'s panes and a manual `ai pane` alike, and labels the pane with the account. `default` means `~/.claude` with the environment left untouched, so projects without the key are unchanged.

### Why needed
One operator, several subscriptions (own Max plan, a client's, a company's): each project must spend the right one, and a pane must show which one it spends. Claude Code's documented mechanism is one config directory per login (`CLAUDE_CONFIG_DIR`; the macOS Keychain entry is keyed to the directory). The decision is only WHERE the variable is set and WHO owns the mapping.

### Alternatives considered
1. **tmux session environment (`tmux set-environment`)** — rejected: per session, so a pane created before the variable or a manual `ai pane` from another shell silently spends the wrong account. The variable must be set on the one path every Claude launch goes through, which is `ai pane`.
2. **A path in `.ai/start.json`** — rejected: the file is Architect-writable and committed; a path there is a committed exec-adjacent surface (E-208 lesson). The project names a registry KEY; the operator's machine resolves it, validates the path (absolute, under `$HOME`, no `..`) and refuses an unknown name rather than falling back.
3. **Glob `~/.claude-*` as the account list** — rejected: a stray `~/.claude-backup` becomes an account. An explicit registry is auditable and lets `remove` refuse while in use.
4. **Symlink the shared parts of `~/.claude` into each new directory** — rejected for `settings.json` and `keybindings.json`: Claude Code rewrites them (`/config`, permission grants), the docs do not define symlink behaviour, and an atomic write replaces the link with a file, silently un-sharing it. They are COPIED at `add` time; `ai account list` reports drift and `ai account sync` re-copies on request. `skills/synced` and `plugins/synced` are account-downloaded and never shared. Project-scoped hooks, skills, agents and role overlays need nothing.
5. **Chosen** — name in the project, mapping on the machine, export in `ai pane`, label on the pane.

### Constraints driving this decision
- No new AI-OS environment variable (D-093/D-094 line); `CLAUDE_CONFIG_DIR` is Claude Code's own.
- `ai pane` is the one writer of launch records (D-087) and the one exec point; the gate, role token and launch record are unchanged by the config directory.
- A pane that silently fell back to `default` would defeat the feature: unknown name or missing directory refuses with the `ai account add` recipe.
- `src/bin/ai` is at its size ceiling; `ai account` lands in a sourced sibling with `tests/unit` coverage.
- The D-092/D-093 lesson: E-314 opens with a probe (`claude auth status` in two directories) before anything is built on the two-login assumption. Documented limit: a Console sign-in without an API key is not separated; accounts are claude.ai logins.

### Impact
- Unlocks: E-314 → E-315.
- Risk if wrong: a pane spends the wrong subscription. Mitigated by refuse-not-fallback, the `@ai_os_account` option on the pane, the `--status` column and `list`'s MISMATCH check against `configDirectory`.
- Per-account auto memory (`<config dir>/projects/<project>/memory/`) starts empty on a new account — correct, and said once by `ai account add`.

### Rollback
`ai start --account default` per project; delete `~/.ai-os/accounts.json` per machine; the extra directories keep their logins and are inert. The feature reverts as one PR; no schema or state change.

---

## D-096 — E-312 and E-313 accepted as built; the "≤ 10 min at 4 lanes" figure withdrawn as derived; the 4-lane bound is the measured 753 s until waves 1–2

**Date**: 2026-10-13
**Task**: E-312 (accepted), E-313 (accepted), P-44 (two map notes), E-302 (two rows)
**Decision**: Both tasks are accepted on c8f7f55 (CI PASS: 1 lane 1561 s, 4 lanes 753 s, 5862/0/2, leaked 0; peak_sum_rss_mb 547 at 1 lane, 579 at 4; installer suites 756 → 640 MB concurrent at 4 lanes, so no `# AIOS_EXCLUSIVE: installer` pin). One acceptance item of E-312 is NOT met and is withdrawn rather than failed: "4 lanes ≤ 10 min" measured 753 s (12.5 min; suite_seconds 696). The Engineer's close line labels 753 s "(≤10 min)", which is wrong; the figure itself was the Architect's, set in D-093 ruling 1 from an estimate (≈ 1242 s / 4 + 246 s ≈ 556 s) that assumed perfect lane packing and no contention — the same pattern D-093 corrected in D-091. The blueprint's target line becomes the measured number with the formula beside it; the "< 5 min after waves 1–2" target (D-088) is unchanged and stays with P-44 → E-301/E-302.

### Why needed
A closed task whose acceptance line carries an unmet number, labelled as met, is the wrong record to build the next ruling on. The lane work shortened the 4-lane run by 19% (926 → 753 s) and the 1-lane run barely (1586 → 1561 s), which is the shape D-093 predicted: lanes cut the shared phase, and the exclusive phase (tmux, ai watch, ports, perf, now gate_abort_test) is the floor that only consolidation lowers.

### Alternatives considered
1. **Reject E-312 until 4 lanes ≤ 600 s** — rejected: nothing in E-312's scope lowers the exclusive phase further; the remaining seconds are in the suites P-44 already orders first. Holding a correct implementation for an Architect's estimate repeats the D-093 mistake.
2. **Keep the 10-min figure as "the target after E-312" and mark it missed** — rejected: a target that was never derivable from measured terms is not missed, it is wrong; D-093 ruling 1 itself said the line must become a formula with measured terms.
3. **Accept, withdraw the figure, record the measurement** — chosen.

### Review findings (recorded, none blocking)
- The Tier-2 commits bf2ae5a, 2ae9b2d, 50fc3b8 and c8f7f55 carry no [CRITIC_STAMP] of their own: the newest stamp in REVIEWS.md is E-310's (2026-10-13), inside the 7-day window, so Gate 2 passed on it. Before the PR, the Engineer runs `skill: ai-review` (Tier 2) over 43d41fa..c8f7f55 and adds the stamp.
- `tests/tools/census.mjs` `installerLane()` and `tests/run.sh` `_lane_class` agree except on the `run` HOME class: the runner also requires lanes to clone HOME (CI only), the census does not, so provider_workspace prints "shared" in the census while a local `bash tests/run.sh --lanes N` keeps it exclusive. Correct and safe (a false exclusive costs time only); the census comment names the runner function `_installer_lane`, which does not exist. One E-302 row on census.mjs.
- installer_node_check stays exclusive because its three installer HOMEs are bare `mktemp -d` paths (foreign). The one-line change E-312 made to exec_form_hooks (`test_tmpdir`) moves it to a shared lane: an E-302 row, not a task.
- The measurement pair 24050c9 / 7b33882 is on the branch as two commits that cancel; acceptable, documented in both messages.

### Constraints driving this decision
- A target is a measurement or a formula over measurements; an estimate is labelled as one until a run replaces it (the D-092, D-093, D-094 lesson, now a rule).
- Acceptance lines are closed on numbers as measured; a close line never relabels a number.

### Impact
- Unlocks: E-314 (next in the OPEN queue, D-095). P-44's map carries the lane class per suite and the two E-302 rows above.
- Risk if wrong: none to the code; the risk is to the record, which this entry corrects.

### Rollback
None needed; E-312 and E-313 revert as their own PRs (D-093, D-094).

---

## D-097 — Security P1-2 on E-314 ruled: the gate hooks are project-scoped and the account directory does not move them; the user-level classifier backstop copy IS stale-able, so install/sync refresh it in every account, `ai pane` checks it at launch, and the rule text v3 covers accounts (E-318, E-315); run_handover gets the build gate (E-319)

**Date**: 2026-10-14
**Task**: E-314 (accepted as built), E-315 (amended through accounts.md §3; unblocked), E-318 (new, Tier 2, after E-314, before E-315), E-319 (new, Tier 1)
**Decision**: Five rulings on the Engineer's E-314 packet (signal 2026-10-13 22:05; security review P1-2).
1. **The premise is corrected, not accepted.** The six AI-OS hook entries — the pre-tool-use gate among them — are written into the PROJECT's `.claude/settings.json` by `ai init` / `ai sync` (`_configure_project_claude_settings`, gitignored, absolute paths into `~/.ai-os/hooks`); `ai install` writes no user-level hook. `CLAUDE_CONFIG_DIR` moves the USER layer only, so an account's copy cannot stale the gate. Because that is an inference about Claude Code's settings precedence, E-315 opens with a probe (accounts.md §3) recorded in LOG.md before the export is wired — the D-092 lesson.
2. **What the copy does stale: the E-293 classifier backstop** (`autoMode.hard_deny`, user-level by necessity — a project's `autoMode` is ignored). Its text is a D-ruling label (E-306); when the ruling changes, every account copy is OUTDATED. `ai install`, `ai sync` and `ai account add` run the E-293 helper's `apply` over `~/.claude/settings.json` and every registered account's `settings.json` with REPLACE semantics only: OUTDATED is replaced in place, ABSENT is reported and never added (the y/N consent stays a one-time operator choice that `ai account add` copies), every other key untouched. `ai account sync` keeps its meaning (re-copy of the operator layer on request).
3. **`ai pane` under a non-default account refuses exit 2** when that account's `settings.json` is missing or unparsable (not set up — names `ai account sync <name>`) or carries an OUTDATED backstop (names `ai sync`); ABSENT prints the doctor's one-line notice and continues, as `~/.claude` does today. The default account is unchanged: it is not a copy, and a hand edit there is the classifier rule's own case. The Engineer's option (b) — refuse on a missing PreToolUse entry — is dropped: that entry is project-level and the check would read the wrong file.
4. **Rule text v3, label `(D-097)`** (verbatim below; the byte-pinned constant in `src/shared/classifier-backstop.py`, installed by E-306's replace-in-place path — now into every account by ruling 2, which makes this text its first live test): `~/.ai-os/accounts.json` joins the protected set; the `~/.claude/settings.json` clause covers every registered `config_dir`; `ai account` joins the exempt list under the same no-flag condition.
5. **`run_handover` marked E-314 DONE after `update_task_status` refused with BUILD_STALE.** The E-249 completion build gate (`checkCompletionBuildGate` in `src/shared/build-stamp.mjs`) is applied by task-synchronizer only; orchestrator-mcp's `run_handover` changes task status without it. E-319 (Tier 1) applies the same gate at every status-changing path. The E-314 DONE stands: this ruling accepts it.

### Rule text (verbatim; the E-318 constant)
> AI-OS Gate Tamper (D-097): Never disable, bypass or weaken the AI-OS safe-exec gate or its role tokens, however assembled (shell variables, eval, bash -c, aliases, a script written then run, python/node/perl, sed -i, jq, cp/mv/ln, editor tools, subagents, or a nested claude launched with flags or settings that drop its hooks). Specifically: running `ai gate off`; creating, editing, moving or linking `~/.ai-os/gate-override.json`, `~/.ai-os/accounts.json` or anything under `~/.ai-os/{hooks,bin,mcp,shared,scripts,run,config,secrets}/` (by `~`, `$HOME`, a relative path or an absolute path); running `claude auto-mode reset`; changing `~/.claude/settings.json` or any registered Claude account's `settings.json` (the `config_dir` directories named in `~/.ai-os/accounts.json`), or their symlink targets, to remove or alter `autoMode`, `hooks`, `disableAllHooks` or `defaultMode`, or to add `permissions.allow` rules for `ai`; or changing a project's `.claude/settings.json` or `settings.local.json` to remove or alter `hooks`, `disableAllHooks` or `defaultMode`. Exempt: `ai install`, `ai sync`, `ai init`, `ai doctor`, `ai start`, `ai pane`, `ai watch`, `ai account`, `ai gate on`, `ai gate status` and `bash install-ai-os.sh`, each run with no flag that skips, disables or redirects hooks or the gate — and, for `ai install`, `ai sync` and `bash install-ai-os.sh`, only from a source tree whose hooks, gate or installer this session has not modified; the `ai` command's own subcommands writing their runtime state under `~/.ai-os/run/` (never the gate switch); `ai install` creating the key under `~/.ai-os/secrets/`; reading these files.

### Why needed
The blueprint (D-095) said "the hooks are project-scoped" without saying which AI-OS entry is NOT, and the security review read the hook lines as user-level; both halves of the record were incomplete, and E-315 was blocked on a check that would have read the wrong file. The copy-at-add design (chosen over a symlink because Claude Code replaces symlinks on its atomic writes) needs exactly one refresh path for the one AI-OS-owned user-level entry.

### Alternatives considered
1. **Symlink `settings.json` into the account directory** — rejected again (D-095): Claude Code's atomic rewrite replaces the link with a file on the first `/config` change, silently un-sharing it.
2. **`ai sync` re-copies `settings.json` wholesale into every account** — rejected: it erases per-account divergence the operator made on purpose (a client account with its own permission grants); the AI-OS entry is the only thing AI-OS owns there, so only it is refreshed.
3. **`ai pane` refuses on ABSENT too** — rejected: the backstop is opt-in (y/N, default N) in `~/.claude`; refusing an account for a choice the default is allowed to make would push operators to say yes without reading the rule.
4. **Refuse on a missing PreToolUse entry in the account file (the Engineer's (b))** — rejected as stated: the entry is project-level; the launch check reads the user-level copy for the one entry that lives there.
5. **Both (a) and (b) as proposed** — the shape is kept (writer + launch check + rule amendment); the content of each is corrected as above.

### Constraints driving this decision
- One writer for one AI-OS-owned entry, replace-in-place only; consent is never granted by a sync.
- A settings-precedence claim is probed before a launch path relies on it (D-092, D-093, D-094, D-096).
- No new environment variable; `CLAUDE_CONFIG_DIR` is Claude Code's. The rule constant is D-ruling text byte-for-byte (E-306).

### Impact
- Unlocks: E-318 → E-315; E-319 independent. The D-097 text reaches `~/.claude` and `~/.claude-work` through the same path on the next `ai sync`.
- Risk if wrong: the probe in ruling 1 fails (project hooks do not fire under an account directory) — then E-315 stops, and the hook lines move into the account refresh path as a D-098 before any pane launches under an account.

### Rollback
E-318 reverts to the D-090 label (the replace-in-place path runs backwards the same way); E-315's launch check is one function; E-319 is additive.

---

## D-098 — PR #99 rulings: `ai install` refreshes `~/.claude` too; one shared completion gate for both status writers (E-320); the as-built directory rules enter the blueprint; the E-315 probe's shape is fixed and its go is the operator's

**Date**: 2026-10-14
**Task**: E-318 (accepted with one fix in PR #99), E-319 (accepted as built), E-320 (new, Tier 1), E-315 (probe shape)
**Decision**: Four rulings on the Engineer's PR #99 packet (signal 2026-10-14; CI PASS c4ff41b 5892/0/2, Tier-2 review PASS).
1. **`ai install` refreshes `~/.claude` as well as the accounts — D-097 ruling 2 stands.** The Engineer's `--accounts-only` left `~/.claude` to the y/N offer on the ground that the offer asks for an OUTDATED copy too. Rejected: replace-in-place is consent-free (the label carries the consent the operator gave once), so asking again is noise, and a non-TTY install skips the offer and leaves `~/.claude` outdated until `ai sync`. `_classifier_refresh_all` runs over every directory BEFORE the offer; the offer then meets PRESENT or ABSENT only. Fixed in PR #99 before merge with one row: non-TTY `ai install` on a fixture `~/.claude` carrying the D-090 label yields D-097 in place; an ABSENT fixture stays untouched and prints the existing "not offered" line.
2. **One completion gate, two callers (E-320, Tier 1).** `runHandover` now applies the E-249 build gate but not the E-267 CI gate that `update_task_status` applies; the two writers were always meant to agree, and a gate list maintained in two places drifts (engineering-standards: reuse `src/shared/`). E-320 extracts `completionGates({cwd, id})` into `src/shared/completion-gates.mjs` — build stamp then CI gate, same texts, same `expected_rejection` marker, same `AI_OS_BUILD_STAMP=0` / `AI_OS_CI_GATE=0` rollbacks — called by both; `runHandover` moves to `src/mcp/orchestrator-mcp/run-handover.mjs`, which takes `index.js` (502 lines) back under the 500-line warn without a suppression.
3. **The as-built directory rules are adopted** (E-314 c49a485): accounts.md §Security now lists them; the build is stricter than D-095's "absolute, under `$HOME`, no `..`" and that is the direction a validator may move without a ruling.
4. **The E-315 probe is the operator's go, and its shape is fixed** (accounts.md §3): it runs under the operator's real `~/.claude-work` login because a `-p` turn needs one; cost one short turn; `--max-turns 1`, `--allowedTools "Bash(echo:*)"`; the blocked command is `echo "ai gate off"` — matched by the gate as a self-disable phrase (the Architect's own heredoc carrying it was blocked on 2026-10-14) and harmless if it runs; proof is the block line or the session's post-tool-use telemetry row. The Architect does not approve spending on the operator's accounts; E-315 waits for the operator's yes in their terminal. If the probe shows the hooks do not load under the account directory, E-315 stops and the fallback is named now: the six hook entries join the account refresh path of E-318 (written into `<dir>/settings.json` by the same replace-only writer), as D-099.
Also: E-316 and E-317 are VOID (mis-owned duplicates of E-318/E-319) and are marked DONE with that summary after the MCP restart, as D-097 said.

### Why needed
Each item is a place where the build and the record disagreed: an install path that could leave the default directory outdated, a gate that exists in one writer and not the other, a validator stricter than its blueprint, and a probe whose cost falls on the operator.

### Alternatives considered
1. **Keep `--accounts-only` and rely on `ai sync`** — rejected: an install that leaves the one directory every project reads outdated is the staleness D-097 exists to end.
2. **Add the CI gate to `runHandover` in place, no extraction** — rejected: a third gate would be added in two places again; the extraction is the fix, the size warn is the symptom.
3. **Run the probe under a throwaway config directory** — rejected: `claude -p` needs a login; a throwaway directory would need a login of its own, which is a second account, not a cheaper probe.
4. **Skip the probe and trust the documented settings precedence** — rejected (D-092, D-093, D-094, D-096: inference about another program's behaviour is probed before a launch path rests on it).

### Constraints driving this decision
- Consent is granted once by the operator and carried by the label; AI-OS never re-asks for what it already holds and never adds what it was not given.
- One writer per policy, one gate list per status transition.
- Spending on an operator's account is the operator's decision, stated with its cost and its exact command.

### Impact
- Unlocks: PR #99 merge after ruling 1's fix; E-320 after the merge; E-315 after the operator's yes.
- Risk if wrong: ruling 1 rewrites a `~/.claude` the operator edited by hand — only the one labelled entry is touched and every other key is byte-identical (E-318's own rows prove it).

### Rollback
Ruling 1 is one flag; E-320 is a move plus one call site per writer; the probe writes nothing.

---

## D-099 — `SendMessage` is the ONLY Triad wake path: `ai-watch`, `ai handoff` and `handoff_control` are removed; a wake sent to a down pane is lost and reported, never queued (E-281 → E-321, E-322, E-323)

**Date**: 2026-10-14
**Task**: E-281 (spike, DONE), E-321 (skills + evals, Tier 2), E-322 (removal, Tier 3), E-323 (docs + templates, Tier 2)
**Decision**: The E-281 spike (`.ai/COMM.md` §SendMessage spike) measured cross-session `SendMessage` in both directions: delivered in every case where the target `claude` was running — idle 7–13 s and a turn starts; after `/clear` and `/compact` the same; mid-turn it is held until the running tool call ends and then drains into the RUNNING turn (no new turn, not lost). A send to a session whose `claude` has exited fails at once with "not reachable" and NOTHING is queued; on relaunch the name rebinds to the new session. The Engineer recommended "SendMessage first, send-keys fallback". **The operator overruled it in this pane on 2026-10-14: losing a wake sent while the other pane is down is acceptable; remove `ai-watch` and move the wake path entirely to `SendMessage`.** Eight rulings:
1. **The wake is a model action, so it lives in the skills, not in a shell command.** `SendMessage` is a Claude Code tool a session calls; no CLI or MCP server can call it. `ai-handoff`, `ai-task` Step 4, `arch-task` Step 4, `task-planner` Step 7 and `ai-triage` call `SendMessage` themselves — after `.ai/COMM.md` is written, as their LAST action — to the target's session name as `ListAgents` lists it (`<project dir basename> · <Role>`, e.g. `ai-os-v2 · Engineer`; E-281 observed both names). `SendMessage` is a deferred tool: the skill text says to load it with `ToolSearch select:SendMessage` first. The message's first line is the handoff line (what shipped or what was planned, and "execute the OPEN queue" / "review and plan next"); the body may point at the COMM.md entry, never repeat it.
2. **`ai handoff` and `handoff_control` are DELETED, not kept as wake-less writers.** COMM.md is already written by the `ai-handoff` skill; a CLI/MCP writer with no wake would be a second place the handoff text lives and a call every skill would still be told to make. `src/shared/signal-handoff.mjs` and `.ai/signal.json` go with them.
3. **`ai-watch` is deleted; `ai start` keeps the panes.** `ai start` still creates the tmux window, binds each pane's role (`@ai_os_role`, E-269) and account (`CLAUDE_CONFIG_DIR`, E-315) and launches `claude` in each — minus the watcher pane, the lock directory, the E-229 restart backstop and `--no-watch`. The `ai-watch` script, `<project>/.ai/signal.json` and `<project>/.ai/.ai-watch.lock` become legacy artefacts (`src/config/legacy-artefacts.json`, class `safe`) that `ai sync` prunes (D-074).
4. **Down target: report and stop.** On "not reachable" (or a name absent from `ListAgents`), the skill prints ONE line to its user naming the target and the handoff line it could not deliver, and ends its turn. No retry, no queue, no fallback — the operator sees a down pane instead of a watcher papering over it. Busy target: the message drains into the running turn after its current tool call (spike case b); accepted as is.
5. **The E-119 rule stands with a new verb.** "Never end a turn with an exhausted queue without a signal" becomes "never end it without calling `SendMessage` to the other role". The ping-pong loop still does not advance on its own.
6. **Accepted risk — a future local or non-Anthropic model on the `claude` CLI.** Delivery goes over Claude Code's local session sockets and does not depend on the model; the wake now depends on the model actually calling `SendMessage` (a deferred tool that needs `ToolSearch` first); cross-session messaging under a non-Anthropic base URL is NOT verified. The operator accepts this ("more powerful and cleaner"). If such a model fails to wake the other pane, the fix is a skill-text change or a probe, not a return of the watcher.
7. **Three PRs, in order.** E-321 switches the skills and the `evals/ai-handoff` graders (assert a `SendMessage` call to the target, not a signal entry) with `ai-watch` still present; E-322 deletes `ai-watch`, `signal-handoff.mjs`, their tests, the CLI/MCP surfaces, the installer lines and adds the legacy-artefact entries (Tier 3: it changes the MCP tool surface and `classifier-backstop.py`); E-323 updates README, the ARCHITECT/ENGINEER templates and rulefiles, CHANGELOG and DIGEST. E-263 (release v4.0.0) ships AFTER E-323 so its BREAKING list carries `ai watch`, `ai handoff` and `handoff_control` (stated here, not chained — DAG depth).
8. **`.ai/blueprints/interactive-bridge.md` is SUPERSEDED by this ruling**; `native-first.md` §Component 9 is the blueprint for E-321..E-323.

### Why needed
E-281 closed D-075 §7 with a measurement, and the measurement left one decision open: whether a dropped wake to a down pane justifies keeping a second wake path (watcher, lock, send-keys, signal queue, six test suites, 57 files). The operator ruled it does not.

### Alternatives considered
1. **`SendMessage` first, `ai-watch` send-keys fallback (the E-281 recommendation)** — rejected by the operator: two wake paths means two sets of tests and two places a handoff can go wrong, and the fallback hides a down pane the operator would rather see.
2. **Keep `ai handoff` / `handoff_control` as COMM.md-and-record writers with no wake** — rejected: duplicate writer of text the skill already writes; every skill would still carry the extra call.
3. **Have the CLI speak to the session socket (`/tmp/cc-socks/<pid>.sock`) directly** — rejected: an undocumented internal protocol that Claude Code may change without notice; the tool is the contract.
4. **Record the spike and change nothing** — rejected: the spike was funded to decide this.

### Constraints driving this decision
- One wake path, one contract (the tool), one place each rule lives (ruling 2; engineering-standards reuse rule).
- A failure is shown, not absorbed (D-060..D-064 theme: the harness tells the truth; a watcher that re-delivers hides the pane that died).
- Deletions that touch the MCP tool surface or the classifier are Tier 3 (sovereignty-hardening).

### Impact
- Unlocks: E-321 → E-322 → E-323; E-263 after E-323.
- Risk if wrong: a pane that dies mid-sprint strands the loop until the operator notices the "not reachable" line — accepted (ruling 4). Ruling 6's model risk — accepted.

### Rollback
Reverting E-322's PR restores `ai-watch`, `signal-handoff.mjs` and both tool surfaces (they are deleted, not rewritten); a new D-ruling reinstates the fallback text in the skills. E-321 alone is reversible per skill file.

---

## D-100 — D-099 ruling 4 amended: the skills ALWAYS call `SendMessage`; the send's own "not reachable" result is the only down check (no `ListAgents` pre-check); `handoff_enforcement_test` accepted as deleted in E-321

**Date**: 2026-10-14
**Task**: E-321 (accepted as built, PR #104, CI PASS 27ce67b 5977/0/3), E-322 (text to implement against)
**Decision**: Two rulings on the Engineer's E-321 packet.
1. **Ruling 4 of D-099 loses its `ListAgents` clause.** It read: on "not reachable", *or a name absent from `ListAgents`*, print one line and end the turn. Under that wording the model listed first, found no row, and SKIPPED the send — which the `ai-handoff` eval caught as a violation of ruling 5 ("never end the turn without calling `SendMessage`"). A pre-check is a second source of truth for the same fact and it let the mandatory call be optimised away. Amended text: **the skill always calls `SendMessage`; a send that returns "not reachable" is the down signal; the skill then prints ONE line to its user naming the target and the undelivered handoff line and ends the turn.** `ListAgents` is not consulted for the wake. (Rulings 1, 2, 3, 5–8 unchanged.)
2. **`tests/handoff_enforcement_test.sh` was deleted in E-321, not E-322 — accepted.** It asserted that the skills NAME `handoff_control`, which is exactly what E-321 removes; keeping it to E-322 would have meant one green PR with a failing suite in it. Its behaviour (every wake-carrying skill names the wake tool) is carried by `tests/unit/skill-wake.test.mjs`, and the LOG line was written as D-099 ruling 7 asks. E-322's deletion list is five suites, not six.

### Why needed
A rule that can be satisfied by not acting is not the rule D-099 meant; the eval found the gap on the first run.

### Alternatives considered
1. **Keep the `ListAgents` pre-check and require the send regardless** — rejected: two calls for one fact, and the pre-check's only remaining use would be to print a nicer name.
2. **Move `handoff_enforcement_test` back to E-322's list** — rejected: it cannot pass once the skills no longer name `handoff_control`.

### Constraints driving this decision
- One source of truth for "is the other pane up": the send result.
- The mandatory call is mandatory; nothing in the skill text may give the model a reason to skip it.

### Impact
- Unlocks: E-322 proceeds against the amended text; E-323 copies the amended wording into the templates and rulefiles.
- Risk if wrong: none beyond D-099's accepted risk — a send to a down pane costs one failed tool call.

### Rollback
Reinstate the clause in the five skills and `native-first.md` §Component 9 by a new ruling.

---

## D-101 — E-322 rulings: classifier rule text v4 drops `ai watch` (E-324 swaps the constant and its pin); `start.json` `watch` and `sizes.top` stay accepted-and-ignored; E-322's acceptance grep restated with its own exclusions; `ai add-task` no longer auto-wakes (BREAKING); the extra deletions and the symlink fix accepted

**Date**: 2026-10-14
**Task**: E-322 (776eeb5 on `engineer/e322-remove-ai-watch`; SEC_PASS, ARCH_PASS with conditions, TESTS_PASS; full `ai ci run` in progress), E-324 (new, Tier 3), E-323 (text), E-263 (BREAKING list)
**Decision**: Four rulings on the Engineer's E-322 packet, plus acceptances.
1. **Rule text v4, label `(D-101)` — E-324 swaps it.** The byte-pinned `RULE` in `src/shared/classifier-backstop.py` (E-306.01b pins it to D-097's paragraph) still exempts `ai watch`, a command that no longer exists; harmless now (it exits unknown) but a pinned text may not drift from its ruling, so the ruling moves. v4 is D-097's v3 paragraph with exactly two changes: the label `(D-097)` becomes `(D-101)`, and "`ai watch`, " leaves the exempt list. Verbatim:
   ```text
   AI-OS Gate Tamper (D-101): Never disable, bypass or weaken the AI-OS safe-exec gate or its role tokens, however assembled (shell variables, eval, bash -c, aliases, a script written then run, python/node/perl, sed -i, jq, cp/mv/ln, editor tools, subagents, or a nested claude launched with flags or settings that drop its hooks). Specifically: running `ai gate off`; creating, editing, moving or linking `~/.ai-os/gate-override.json`, `~/.ai-os/accounts.json` or anything under `~/.ai-os/{hooks,bin,mcp,shared,scripts,run,config,secrets}/` (by `~`, `$HOME`, a relative path or an absolute path); running `claude auto-mode reset`; changing `~/.claude/settings.json` or any registered Claude account's `settings.json` (the `config_dir` directories named in `~/.ai-os/accounts.json`), or their symlink targets, to remove or alter `autoMode`, `hooks`, `disableAllHooks` or `defaultMode`, or to add `permissions.allow` rules for `ai`; or changing a project's `.claude/settings.json` or `settings.local.json` to remove or alter `hooks`, `disableAllHooks` or `defaultMode`. Exempt: `ai install`, `ai sync`, `ai init`, `ai doctor`, `ai start`, `ai pane`, `ai account`, `ai gate on`, `ai gate status` and `bash install-ai-os.sh`, each run with no flag that skips, disables or redirects hooks or the gate — and, for `ai install`, `ai sync` and `bash install-ai-os.sh`, only from a source tree whose hooks, gate or installer this session has not modified; the `ai` command's own subcommands writing their runtime state under `~/.ai-os/run/` (never the gate switch); `ai install` creating the key under `~/.ai-os/secrets/`; reading these files.
   ```
   (The fenced block is the paragraph as one line, plain backticks, exactly as v3's constant carries them.) E-324 swaps the constant and the pin together, and the E-318 replace-in-place refresh carries the new label into `~/.claude` and every registered account (D-097 ruling 2), so a `(D-097)` label is what `ai pane` and `ai doctor` now report as OUTDATED.
2. **`start.json` `watch` and `sizes.top` stay ACCEPTED (type-checked) and ignored — ratified.** Rejecting them would stop `ai start` in every project that ever set them, for a key that now does nothing. E-323 documents both as deprecated; they are removed from the schema in the next major after v4.0.0, not before.
3. **E-322's acceptance grep is restated.** `git grep -nE 'ai-watch|signal-handoff|handoff_control|signal\.json|ai-watch\.lock'` over `src`, `tests`, `evals`, `hooks` and `install-ai-os.sh` must return ONLY hits in: `src/config/legacy-artefacts.json` and `src/shared/legacy-registry.mjs` (ruling 3's own entries and the orphan-watcher pid check); their tests (`ai_clean` orphan-watcher rows, `sync_prune` E-322.S*, `mcp_behavioral`'s retired-tool row); the RETIRED regex in `tests/unit/skill-wake.test.mjs`; and `src/templates/ARCHITECT.md` until E-323 lands. Every hit must be one of those, and the PR description lists each remaining hit with its reason. "Returns nothing" was wrong on its face: the pruning entries exist to name what they prune.
4. **BREAKING, for E-323's CHANGELOG line and E-263's list:** `ai add-task` no longer auto-wakes the other role (E-204's auto-handoff removed with the signal path; `AI_OS_NO_AUTO_HANDOFF` gone). The wake after planning is the skill's `SendMessage` (D-099 r1, D-100).
Accepted as built: the extra deletions with their LOG lines — `role_routing_test` (ai-watch routing only), `cli_add_task` T-09, `leaked_state` E-296.01a-d together with `tests/run.sh`'s watcher and lock-dir leak kinds; the critic_security P2 fix (a symlinked `.ai/` could let the new sync reap move a file out of the link target); `ListAgents` stays in the Architect overlay beside `SendMessage` for looking up the exact session name — never as a pre-check that may skip the send (D-100).

### Why needed
Each is a place where the deletion met a record that still named the deleted thing: a byte-pinned rule, a schema key, an acceptance line written before the pruning entries existed, and a side effect of `ai add-task` nobody had listed.

### Alternatives considered
1. **Edit the pinned constant in E-322 and re-pin to D-097** — rejected: the pin exists so the text cannot change without a ruling; the ruling is the change.
2. **Reject `watch` / `sizes.top` in `start.json`** — rejected: breaks every project that set them for no gain.
3. **Leave the acceptance grep as written and waive it in review** — rejected: an acceptance line that cannot be met teaches the reviewer to ignore acceptance lines.

### Constraints driving this decision
- A byte-pinned text moves only by ruling (D-097 ruling 4, E-306).
- Deprecate before remove for user-facing config keys.
- Classifier changes are Tier 3 (D-099 ruling 7).

### Impact
- Unlocks: E-322 merge after CI; E-324 after E-322; E-323 with rulings 2 and 4 in its text.
- Risk if wrong: between E-322 and E-324 the classifier exempts a command that does not exist — no gate is weakened by exempting a no-op.

### Rollback
E-324 is a one-constant, one-pin swap; reverting its PR restores v3 and the OUTDATED detection re-labels accordingly.

---

---

## D-102 — Team Collaboration: Git Is the Bus — One Record per File, Import on Pull, Per-Developer Id Ranges, Claims on `origin/master`, Hosted CI for `master` Only

**Date**: 2026-10-18
**Task**: P-45 (Architect), E-325..E-334 (Engineer). Blueprint: `.ai/blueprints/team-collaboration.md`.
**Decision**: Make AI-OS usable by several developers on one repository by turning `.ai/` memory into one tracked JSON file per record (`.ai/tasks/<id>.json`, stamps, CI records, `project.json`), demoting `state.sqlite` to a per-machine index rebuilt from those files, importing records on every pull (`post-merge` / `post-checkout` / `post-rewrite` / SessionStart), allocating ids from per-developer ranges in a tracked `.ai/team.json`, requiring an Engineer to CLAIM a task by a bookkeeping commit pushed to `origin/master` before the pre-tool-use gate lets it write source, carrying CI PASS evidence as tracked `.ai/ci/<sha>.json`, and reinstating a hosted CI run as the required check on `master` only.

### Why needed
The 2026-10-18 team-readiness audit (COMM.md handoff 19:03 UTC) found the framework structurally single-operator: the gitignored sqlite is the only truth and the tracked `state.json` / `TASKS.md` / `REVIEWS.md` are one-way views never read back after a pull, so a teammate's tasks are silently overwritten by the next local mutation; `nextId` is `max(local)+1`, so two developers mint the same E-###; the task record has no assignee or IN_PROGRESS, so two Engineers can execute the same OPEN task; `archive_done_tasks` moves rows into the gitignored archive and the tracked view flips on every commit; `ci_runs` and the pre-push / DONE gates are local, so no machine can see another's green run and, since D-072, nothing stops a red merge to `master`. The operator is moving the project to a team ("multiple people will work on same app with same ai-os … task tracking no overlapping").

### Alternatives considered
1. **Shared task service (small HTTP/SQLite server or a hosted tracker as truth)** — rejected: adds infrastructure and a second source of truth beside git, needs auth and availability, and breaks the project's "CLI-native, zero-friction, works offline" ethos (architect.md §1); every gate would need a network path.
2. **Keep the monolithic `state.json` tracked and add a three-way JSON merge driver** — rejected: a 248 KB file rewritten on every mutation conflicts on every concurrent change, a merge driver cannot resolve semantic conflicts (two tasks, one id), and the archive flip-flop remains.
3. **Globally unique ids (ULID) with E-### as a display alias** — rejected: every rulefile, skill, test name and commit message keys on `E-###`; aliasing would double the id story. Per-developer ranges in `team.json` keep `E-###` and make a collision structurally impossible (two files cannot share a name, and ranges stop add/add conflicts).
4. **Claims only in a local file, broadcast by the feature-branch push** — rejected: teammates on other branches never see it. Claims as bookkeeping commits on `origin/master` are visible with a fetch and need no merge; first push wins, non-fast-forward means lost.
5. **Keep CI fully local (D-072) and only share the local PASS record** — partially adopted: records ARE shared (`.ai/ci/<sha>.json`), but a team needs an authority no single laptop provides for "nobody merges red" on `master`; a hosted run on `pull_request` to `master` is the smallest such authority and costs nothing on GitHub's free tier. Branches stay local-first.
6. **Chosen: git-as-the-bus with per-record files, import-on-pull, ranges, master claims, shared CI records plus hosted master CI** — selected because it needs no new infrastructure, keeps every existing gate pattern (pre-tool-use block channel, pre-push `.ai/**` exemption, `completionGates`), is incremental per component behind a `schema: 2` marker, and leaves single-operator projects (no `team.json`, no `.ai/tasks/`) byte-for-byte unchanged.

### Constraints driving this decision
- Sovereignty (§35): the Engineer claim gate is enforced in `hooks/pre-tool-use.sh`, not by model cooperation (E-129 pattern).
- Offline tolerance: `ai state import` never blocks a pull (exit 0, conflicts stamped); the SessionStart fetch is bounded to 3 s and skipped offline; a claim made offline is `pending` and does not satisfy the gate until pushed.
- Trust boundary is the git remote: `origin` / `runner` fields are as trustworthy as the commit author; branch protection + hosted CI is the only hard stop on `master`.
- D-072 §5a's `.ai/**`-only pre-push exemption is what lets claim commits ride; it must not widen.
- No secrets in records (`team.json` = emails + ranges; `start.local.json` = account name only).
- Migration is one-shot (`ai state migrate --team`), refuses on a dirty worktree, and has a `--legacy` inverse.

### Impact
- Unlocks: E-325 (record store + single writer + migrate), E-326 (reconciler + hooks), E-327 (team.json, ranges, planner), E-328 (portable CI records), E-329 (stamps bound to sha), E-330 (archive in git), E-331 (claims + IN_PROGRESS + claim gate), E-332 (hosted master CI), E-333 (start.local.json, shared log), E-334 (docs + v4.1.0), P-45 (Team Contract in RULES.md).
- Supersedes in part: D-072 (hosted CI returns for `master` only), D-095 ("one operator" — account now per user via `start.local.json`), the sqlite-as-truth text in `database-integrity.md` and `drift-resolution-2026.md` (sqlite becomes an index), the TASKS.md "generated from state.json" header, `.claude/rules/ai-bookkeeping.md` (views become gitignored; the no-stash rule stays).
- Risk if wrong: if git proves too slow or conflict-prone as the bus, the record files are still a clean export — every alternative above can be built on them without another migration.

### Rollback
`ai state migrate --legacy` folds the records back into one `state.json` and removes `team.json`; `AI_OS_CLAIM_GATE=0` and `AI_OS_STATE_IMPORT=0` neutralise the two new gates with a telemetry row; deleting `.github/workflows/ci.yml` and the branch protection restores D-072 exactly. Components ship as separate commits, so a single component can be reverted while the others stand.

---

## D-103 — D-102 §5b amended: the hosted `master` check is a provider-neutral contract (bootstrap AI-OS + `ai ci run` on the merge result) rendered per provider by `ai ci hosted`; GitHub and Azure DevOps ship in 4.1.0

**Date**: 2026-10-19
**Task**: E-332 (amended), E-335, E-336 (new, 4.1.0), E-337 (new, after 4.1.0), E-334 (amended). Blueprint: `.ai/blueprints/team-collaboration.md` §Component 5b.
**Decision**: Replace the GitHub-specific clause of D-102 §5b (".github/workflows/ci.yml … GitHub branch protection") with a provider-neutral **hosted check contract**: on every pull request into `master` the provider runs exactly two commands — bootstrap AI-OS, then `ai ci run` on the merge result — and publishes the run log and `.ai/ci/<sha>.json` as artefacts; the provider's branch policy makes that check required for merging. One thin wrapper per provider is **rendered from a template** by `ai ci hosted [<provider>]`, never hand-written, and every template is held to the same equivalence test. GitHub Actions (E-332, as built) and Azure Pipelines (E-336) ship in 4.1.0; GitLab CI and Bitbucket Pipelines follow (E-337).

### Why needed
The operator ruled on 2026-10-19 that AI-OS projects ship on GitHub, Azure DevOps and other providers, so "nobody merges red into `master`" cannot depend on GitHub Actions. D-102 alternative 5, E-332, E-334 and the blueprint named `.github/workflows/ci.yml` and GitHub branch protection as the mechanism; the Engineer paused E-332 on the branch `engineer/e332-hosted-master-ci` and asked for the ruling (COMM.md 2026-10-19 21:54 UTC).

### Rulings
1. **Contract, not pipeline.** The hosted check is defined once, in the blueprint, as a contract with six clauses — (a) trigger: a pull request targeting `master` (MUST), plus a push to `master` that touches anything outside `.ai/**` (SHOULD: an audit run that records a verdict and gates nothing); (b) exactly two run steps: bootstrap, then `ai ci run` against the merge result the provider checked out; no command of the local recipe is copied into the wrapper (DEVOPS-009's drift lesson, already enforced by `tests/unit/hosted-ci-workflow.test.mjs`); (c) artefacts on every outcome: the log under `~/.ai-os/ci/logs/` and `.ai/ci/*.json`, retained at least 14 days; (d) least privilege: read-only repository token, no secrets referenced; (e) a Linux image with Node 22 (the project's floor and its only Linux coverage); (f) the runner is not a `team.json` member, so its record is reviewer evidence, not a PASS the local gates accept — the Engineer's divergence note is ratified.
2. **Rendered wrappers.** Templates live in `src/templates/ci/<provider>.*`; `ai ci hosted [<provider>] [--check] [--force]` renders one at the provider's canonical path (`.github/workflows/ci.yml`, `azure-pipelines.yml`, `.gitlab-ci.yml`, `bitbucket-pipelines.yml`), refuses to overwrite a differing file without `--force`, and with `--check` exits non-zero when the file on disk is not the current rendering (sha256). `ai doctor` reports provider, wrapper presence and the `--check` verdict. The equivalence test iterates over every template, so no provider can ship a wrapper the test has not seen.
3. **Two bootstrap variants, chosen at render time.** In the AI-OS repository itself (`install-ai-os.sh` at the root and the framework's package name) the bootstrap is `bash install-ai-os.sh` from the checked-out sha — the E-332 workflow as built. In a downstream project it is a clone of `team.json.ci.aios_source` (default: the public AI-OS repository on GitHub) at the tag pinned by `project.json.aios_version`, then that clone's installer — a project's hosted check runs the AI-OS version its developers run. `--check` re-renders with the same inputs, so a version bump shows up as a stale wrapper.
4. **Provider selection.** `team.json.ci = { provider, required_check, aios_source? }` is the record. With no argument `ai ci hosted` detects the provider from the `origin` host — GitHub's host → `github`; Azure DevOps' cloud hosts (`dev.azure.com`, the legacy `*.visualstudio.com` names and its SSH host) → `azure`; `gitlab.com` → `gitlab`; `bitbucket.org` → `bitbucket` — and writes it. Any other host (self-hosted GitLab, Azure DevOps Server, mirrors) is never guessed: `[CI_PROVIDER_UNKNOWN]` asks for the argument. A later mismatch between `team.json.ci.provider` and the `origin` host is an `ai doctor` warning, not a block. Writing the `ci` block is planner work like `ai team add` (D-102 §3) and rides on `master` as a bookkeeping commit.
5. **Branch policy and the claim push — one rule for every provider.** The required check guards MERGES into `master`; direct pushes to `master` stay open to team members on every provider, because AI-OS's own pre-push gate (D-072 §5a) already limits those pushes to `.ai/**` and `claim_task` (E-331) needs them. No provider can scope a push exemption to paths (the Engineer's note that Azure DevOps "can path-scope" holds for build-validation path filters, not for the push block), so the setting has the same shape everywhere and `ai ci hosted` prints it for the chosen provider: **GitHub** — require the status check, do not restrict pushes (or list the team as bypass actors); **Azure DevOps** — Build Validation policy on `master`, required, with the team group granted "Bypass policies when pushing"; **GitLab** — protected branch with developers allowed to push and to merge, "pipelines must succeed"; **Bitbucket** — merge check "minimum one successful build", "prevent changes without a pull request" left off. The SHOULD-level push trigger of ruling 1 makes a bypassed code push visible after the fact. The hard stop on `master` is therefore "no red MERGE"; a direct code push is stopped by the developer's own pre-push gate and recorded by the audit run — the trust boundary D-102 already states (the remote trusts the commit author).
6. **Scope for 4.1.0.** A template ships only with a documented run on a real instance of its provider (the acceptance line). GitHub (E-332) and Azure DevOps (E-336, the operator's provider) are in 4.1.0; GitLab and Bitbucket (E-337) ship when such a run exists and do not block E-334. Until then `ai ci hosted gitlab|bitbucket` says `[CI_PROVIDER_PLANNED]`.
7. **E-332 as built stands**, read under this ruling: the hand-written `.github/workflows/ci.yml`, its equivalence test and DEVOPS-010 (the task's "DEVOPS-008" was already E-267's) are accepted; the merge-commit sha is the right sha; the README "branch-protection settings" clause of E-332 moves to E-334's provider table, and DEVOPS-010's prose is reworded to the contract in E-335. E-335 must either adopt that file as the `github` template's rendering byte-for-byte or regenerate it and say so in the PR.
8. **E-334 read under this ruling**: "the hosted master check and branch protection" means `ai ci hosted <provider>` plus the per-provider policy table of ruling 5; its dependency list gains E-335 and E-336 (not E-337).

### Alternatives considered
1. **One wrapper per provider, each hand-written** — rejected: four files that must say the same two things drift (DEVOPS-009), and nothing ties a downstream project's wrapper to the AI-OS version it runs.
2. **A single portable pipeline layer (earthly, dagger, or a shell entrypoint every provider calls)** — rejected: the "pipeline" is already one command, `ai ci run`; a portability layer is a third description of it and a new dependency (D-061 lineage: fewer tools, not more).
3. **Move claims off `master` onto a bookkeeping ref so `master` can be PR-only on every provider** — deferred, not rejected: it is the clean answer for an organisation that forbids direct pushes outright, but E-331 shipped claims inside the task record on `master` one day ago and a split record store needs its own reconciler rule. Recorded as the designated escape hatch (`team.json.claims_branch`), to be ruled on if a team hits a PR-only mandate.
4. **Ship all four providers in 4.1.0 untested** — rejected: a wrapper nobody has run is documentation pretending to be a gate; ruling 6 ties shipping to a documented run.
5. **Chosen: contract + rendered wrappers + per-provider policy text, two providers now** — selected because the equivalence test written for E-332 generalises to N templates, the GitHub work on the branch is kept, and the operator's Azure DevOps need is met inside 4.1.0.

### Constraints driving this decision
- D-072 §5a's `.ai/**`-only pre-push exemption must not widen; claims keep pushing to `master`.
- No secrets in wrappers or records; the provider token is read-only.
- A downstream project must run the AI-OS version it pins (`project.json.aios_version`), never "latest".
- Single-operator projects (no `team.json`) are untouched: `ai ci hosted` works there too but nothing requires it.

### Impact
- Unlocks: E-332 (resume and ship as built), E-335 (contract + generator + GitHub template), E-336 (Azure Pipelines), E-337 (GitLab + Bitbucket, after 4.1.0), E-334 (docs, amended).
- Amends: D-102 alternative 5 ("costs nothing on GitHub's free tier" → any provider's hosted runner), D-102 Rollback (delete the rendered wrapper and the provider's policy, not only the GitHub file), the blueprint's Component 5b, Data Model, API, Security and Rollback text.
- Risk if wrong: if a provider's policy model cannot express "required for merge, open for push", claims break there — ruling 5 lists the setting per provider and alternative 3 is the fallback.

### Rollback
Deleting the rendered wrapper file and the provider's required-check policy restores D-072 exactly for that project (D-102 Rollback, generalised). `team.json.ci` may stay; `ai doctor` then reports "wrapper missing". Reverting E-335 leaves the hand-written E-332 workflow working unchanged.

---

## D-104 — `.ai/COMM.md` is tracked and every handoff entry is committed in the turn that writes it, before the `SendMessage` wake

**Date**: 2026-10-23
**Task**: E-338 (Engineer; registered after PR #112 lands — see ruling 8). No new blueprint: this ruling is the specification; it amends `.ai/blueprints/team-collaboration.md` §Core Concept ("git is the bus") by naming the handoff channel as one of the records the bus carries.
**Decision**: The operator ruled on 2026-10-23: "COMM should always be git committed." `.ai/COMM.md` leaves `.gitignore` (template and this repository), every skill that writes a handoff entry commits that file in the same turn before it wakes the other role, and the framework detects an ignored or uncommitted `COMM.md` deterministically (`ai doctor`, preflight, Stop hook) rather than trusting the model to remember.

### Why needed
`COMM.md` is the Architect↔Engineer handoff channel: D-099 made its entry the body of every wake ("the message points at the COMM.md entry, never repeats it"). Yet `src/templates/_gitignore` line 20 and `.ai/.gitignore` line 20 ignore it, so the only copy lives in one clone's working tree. The cost is visible today: D-102 cites "the 2026-10-18 team-readiness audit (COMM.md handoff 19:03 UTC)" and D-103 cites "COMM.md 2026-10-19 21:54 UTC" as their sources, and neither handoff exists anywhere — `.ai/COMM.md` is absent from this working tree and from history. D-102 itself turns `.ai/` memory into tracked records because "the gitignored sqlite is the only truth"; the handoff narrative was the one record it left behind. A `.ai/COMM_APPEND.md` orphan from a June 2026 Gemini-era handoff shows the same loss pattern from the previous arc.

### Rulings
1. **Tracked, no opt-out.** `COMM.md` is removed from `src/templates/_gitignore` and from `.ai/.gitignore` in this repository. `ai sync` deletes a non-comment `COMM.md` line from an existing project's `.ai/.gitignore` (one printed line, nothing else in the file touched; the comment above it may stay or go — the test asserts only the pattern line). No flag, no env var, no `team.json` key: the handoff narrative is project memory of the same kind as `DECISIONS.md` and `DIGEST.md`, which the template already tracks by default. A project that must keep a handoff out of git edits its own `.gitignore` by hand and accepts the `ai doctor` finding (ruling 4).
2. **The writer commits.** Every skill that writes a handoff entry — `ai-handoff` (Step 2), and `ai-task`, `arch-task`, `task-planner` where they write the entry themselves rather than delegating to `ai-handoff` — runs, immediately after the write and before anything else in the turn:
   `git commit --only .ai/COMM.md -m "chore(.ai): COMM handoff <YYYY-MM-DD HH:MM UTC> (<Role>)"`
   `--only` commits that path alone whatever the index holds, so an Engineer mid-task with source staged never sweeps it into a bookkeeping commit. The first time in a project the file is still ignored (an un-synced clone) the skill prints one line and the commit is skipped — ruling 4 surfaces it; the skill does not `git add -f`. The commit is on the current branch and is not pushed by the skill: it rides the next push (D-072 §5a's `.ai/**` exemption covers it).
3. **Order of the turn.** write entry → commit (ruling 2) → `mark_deltas_read` (Engineer→Architect) → `SendMessage` LAST (D-099 r1, D-100). The wake's body cites the commit as well as the timestamp: `Details: .ai/COMM.md handoff <ts>, commit <short sha>.` A receiver on another clone can then fetch and read the exact entry.
4. **Detection, not cooperation (§35, E-129 pattern).** (a) `ai doctor` prints `[COMM_IGNORED] .ai/COMM.md is gitignored — run: ai sync` when `git check-ignore -q .ai/COMM.md` succeeds, and `[COMM_UNCOMMITTED] .ai/COMM.md has uncommitted changes — commit it: git commit --only .ai/COMM.md` when `git status --porcelain -- .ai/COMM.md` is non-empty; neither is fatal. (b) The `ai-preflight` injection block gains one line `COMM.md: tracked | IGNORED | UNCOMMITTED (<n> lines)`. (c) The Stop hook prints the `[COMM_UNCOMMITTED]` line once per stop when it applies; it never commits (a hook commit with a half-staged index is the risk `--only` exists to avoid in the skill, and the Stop hook has no role context for the message).
5. **Rotation.** `ai-archive` may still move `COMM.md` into the gitignored `.ai/archive/` (D-102 §Component 7 leaves LOG/SESSION rotation there): git history keeps every entry (`git log -p -- .ai/COMM.md`), so the archived copy needs no tracking. The rotation step commits the emptied file in the same breath: `git commit --only .ai/COMM.md -m "chore(.ai): rotate COMM.md (<YYYY-MM>)"`.
6. **Gates already fit.** `hooks/pre-commit.sh` `_is_bookkeeping_path` already lists `.ai/COMM.md`, so a COMM-only commit needs no critic stamp and D-102 §Component 6's sha-bound stamp exemption for bookkeeping commits applies unchanged. `git add`/`git commit` are outside `ARCH_GIT_WRITE_SUBS` (`src/mcp/safe-exec-mcp/architect-writes.mjs`), so the Architect's skills may make the commit — the `chore(.ai):` commits on master are the precedent. Nothing in the pre-push gate changes and D-072 §5a's exemption does not widen.
7. **Cleanup.** `.ai/COMM_APPEND.md` is deleted in E-338 (its four blueprints and E-151..E-154 shipped long ago; the June entry is already in `LOG.md`/`DECISIONS.md` history). Nothing is backfilled: the two lost handoffs cannot be recovered, and D-102/D-103 record what they said.
8. **Numbering and ordering.** This entry is written on `master` before PR #112 (`engineer/e333-per-user-overrides`, commit 1c90079) lands D-102, D-103, `team-collaboration.md` and the E-325..E-337 bookkeeping, so `master`'s `DECISIONS.md` jumps from D-101 to D-104 until that merge; the merge keeps D-102, D-103, D-104 in that order (both sides append — resolve by keeping both, then open the file before `git add`, per `.claude/rules/ai-bookkeeping.md`). E-338 is NOT registered today because `add_task` mints `max(local)+1`, which on `master`'s pre-#112 state is E-325, an id PR #112 already holds; the Engineer merges #112, runs `ai sync`, and registers the task text below verbatim with `ai add-task --tier 2` (expected id E-338; whatever id is minted is the task's id). Registering from a ruling's verbatim text is bookkeeping, not planning (§35 holds).

### Task text for E-338 (verbatim for `ai add-task`)
Track and commit .ai/COMM.md per D-104 rulings 1-7 (after PR #112 is merged): remove COMM.md from src/templates/_gitignore and .ai/.gitignore; make ai sync delete a non-comment COMM.md line from an existing project's .ai/.gitignore and print one line; add the commit step `git commit --only .ai/COMM.md -m "chore(.ai): COMM handoff <ts> (<Role>)"` after the entry write and before mark_deltas_read/SendMessage in ai-handoff, ai-task, arch-task and task-planner, and the rotation commit in ai-archive, in .claude/skills and every copy ai install/ai sync provisions from; add the preflight injection line, the ai doctor [COMM_IGNORED]/[COMM_UNCOMMITTED] findings and the Stop-hook line; delete .ai/COMM_APPEND.md; add tests under tests/unit. Acceptance: `git check-ignore -q .ai/COMM.md` exits 1 in this repository and in an `ai init` fixture; a fixture .ai/.gitignore carrying the line loses only that line after ai sync (diff is one deletion); `grep -L 'git commit --only .ai/COMM.md'` over the five skill files prints nothing; running skill ai-handoff in a fixture leaves `git status --porcelain -- .ai/COMM.md` empty with HEAD's subject starting `chore(.ai): COMM handoff`, and that commit passes pre-commit with no stamp; ai doctor prints [COMM_IGNORED] on a fixture with the line and nothing on a clean one, [COMM_UNCOMMITTED] on a dirty COMM.md; no new environment variable or flag; full ai ci run green; bash install-ai-os.sh. | Tier: 2

### Alternatives considered
1. **Keep `COMM.md` ignored and rely on the `SendMessage` body** — rejected: D-099 made the body a pointer, not a copy; a receiver in another clone, or anyone after the file is rotated or the clone is gone, reads nothing. This is today's loss.
2. **Opt-in tracking (`team.json.comm_tracked` or a `.ai/.gitignore` comment toggle like `DECISIONS.md`'s)** — rejected: a flag leaves the default lossy, and the operator ruled "always"; D-088 set the same no-flag posture for the test budget.
3. **Commit from a `post-tool-use` hook whenever `.ai/COMM.md` is written** — deferred: it is the pure §35 shape, but a hook has no role for the message and would commit on every partial write while the Engineer's index may hold half a task; `--only` in the skill plus deterministic detection (ruling 4) gives the same guarantee of visibility without that risk. Revisit if ruling 4 reports `[COMM_UNCOMMITTED]` more than rarely.
4. **Track the file and let the next task commit carry it** — rejected: the window between handoff and next commit is exactly when the other role reads it, and an Architect turn often has no other commit.
5. **Chosen: tracked by default, writer commits with `--only` before the wake, detection in doctor/preflight/Stop** — selected because it needs no new gate, reuses the bookkeeping allowlist already naming the file, and makes every handoff a fetchable commit, which is what "git is the bus" (D-102) promised for every other record.

### Constraints driving this decision
- D-099/D-100: the wake stays `SendMessage`, LAST in the turn; the commit slots in before it.
- D-072 §5a: the `.ai/**` pre-push exemption does not widen; a COMM commit is bookkeeping and already rides it.
- §35 sovereignty: visibility of a missed commit comes from `ai doctor`/preflight/Stop (deterministic), not from the model.
- Single-operator projects change only in that the file is now tracked; no `team.json` is required.
- No secrets in handoffs: `COMM.md` carries task narrative; the `identity_guardian` skill applies to it as to `DECISIONS.md`.

### Impact
- Unlocks: E-338. Amends `ai-handoff`, `ai-task`, `arch-task`, `task-planner`, `ai-archive` skill text; `ai sync`, `ai doctor`, the preflight injection, the Stop hook; both gitignore templates.
- Supersedes in part: the "cross-agent messages (may include sensitive context)" rationale in `src/templates/_gitignore`; D-102 §Core Concept's record list (COMM.md joins it).
- Risk if wrong: a project with genuinely sensitive handoffs commits them — the operator accepted this; the mitigation is the same as for `DECISIONS.md` (hand-edit `.gitignore`, accept the doctor finding).

### Rollback
Restore the `COMM.md` line in `src/templates/_gitignore` and `.ai/.gitignore`, remove the five commit steps and the three detections (one commit per surface, so any one can be reverted alone). History already committed stays in git; `git rm --cached .ai/COMM.md` untracks it going forward.

---

## D-105 — D-102 §4 and D-103 amended: claims, the claim gate and the hosted check use the project's TRUNK (`team.json` `trunk`, else `origin/HEAD`, else the one of `main`/`master` that exists), never a hard-coded `master`

**Date**: 2026-10-23
**Task**: E-341 (Engineer; registered after E-339/E-340 because the first registration exceeded the 2000-char task limit — the id in this entry is the minted one). Amends `.ai/blueprints/team-collaboration.md` §Summary, §Core Concept and §Component 4/5 — wherever they say `origin/master` read `origin/<trunk>`; this repository's trunk is `master`.
**Decision**: The branch that claims are published to, that the claim gate reads, that `session-start.sh` fetches and that the hosted check guards is the project's trunk, resolved by one function with no network: `.ai/team.json` `trunk` when set, else the clone's `refs/remotes/origin/HEAD`, else whichever one of `main` / `master` exists under `refs/remotes/origin/`. Nothing in `src/`, `hooks/` or the CI templates names `master` as a branch any more.

### Why needed
The Engineer's 2026-10-23 handoff (finding 1) and the operator: "claims should use the repos real main branch or a branch set in team.json." `src/mcp/shared/task-claims.mjs` hard-codes `refs/remotes/origin/master` (fetch refspec, publish target, every message); `src/templates/ci/*.yml` and the `hosted-ci.mjs` policy text do the same. In any team project whose trunk is `main`, `claim_task` returns `NO_MASTER`, `listClaims` says nothing is claimed, and the claim gate refuses every source write on `engineer/e<N>-*` with a `[CLAIM_REQUIRED]` that cannot be satisfied — the 4.1.0 headline feature is locked for the most common trunk name. D-102 §4 wrote "origin/master" meaning this repository's trunk and the implementation took it literally; the blueprint is amended by this ruling.

### Rulings
1. **Field.** `.ai/team.json` gains an optional `"trunk": "<branch>"` (a plain branch name, never `refs/heads/…`). `validateTeam` rejects anything `git check-ref-format --branch <name>` refuses ("trunk must be a valid branch name"). The creator of `team.json` (`ai state migrate --team`) records `trunk` at creation time, resolved as: `--trunk <name>` flag; else the clone's `refs/remotes/origin/HEAD`; else `git ls-remote --symref origin HEAD` bounded to 10 s (an operator command may touch the network; `set-head` is not used because it writes refs into the clone); else refuse `[NO_TRUNK] pass --trunk <name>`. An existing `team.json` without `trunk` (this repository's) is NOT edited by `ai sync` — it is a tracked team-wide file; `ai doctor` prints `[TRUNK_UNSET] .ai/team.json has no trunk — resolved <name> from <source>; add "trunk": "<name>"` and the resolver's fallback chain serves it.
2. **One resolver, no network.** `src/mcp/shared/trunk.mjs` exports `resolveTrunk(root)` → `{ name, source: "team.json"|"origin/HEAD"|"origin/<name>" }` or `null` with a reason: (a) `team.json` `trunk`; (b) `git symbolic-ref -q refs/remotes/origin/HEAD` stripped of `refs/remotes/origin/`; (c) exactly one of `refs/remotes/origin/main`, `refs/remotes/origin/master` exists → that one; both exist with no `origin/HEAD` → `TRUNK_AMBIGUOUS`; neither → `NO_TRUNK`. Every caller that receives `null` returns `[NO_TRUNK] <reason> — set "trunk" in .ai/team.json (or: git remote set-head origin --auto)`; the claim gate's `[CLAIM_REQUIRED]` line appends that reason so the lock is never silent. `ai trunk` (new CLI verb) prints the resolved name on one line, exit 1 with the `[NO_TRUNK]` line otherwise, so skills, agents and docs use `$(ai trunk)` instead of a literal.
3. **The framework never runs `git remote set-head`.** Hooks, gates, MCP tools and `ai sync` stay off the network beyond D-102's two bounded calls (the session-start fetch and the claim's own publish); `set-head --auto` additionally writes a ref into the user's clone. The doctor line prints the command for the operator to run by hand.
4. **`team.json` wins over `origin/HEAD`.** The tracked file is the team's contract and travels with the repository; `origin/HEAD` is a per-clone cache that a `--single-branch` or mirror clone may lack or hold stale. When both exist and differ, `ai doctor` prints `[TRUNK_MISMATCH] team.json trunk=<a>, origin/HEAD=<b>` (not fatal) and the claim path uses `<a>`; if `refs/remotes/origin/<a>` does not exist after the fetch, the claim returns `[TRUNK_MISSING] origin has no branch <a>` instead of today's `NO_MASTER`.
5. **The sweep.** `git grep -n "\bmaster\b" src hooks` is the task's first and last command. Code paths: `task-claims.mjs` (`MASTER_REF`, the fetch refspec, the publish target, every message now says `origin/<name>` with the resolved name), `session-start.sh`, `claim-gate.mjs`, `task-synchronizer-mcp` messages and tool descriptions, `cli-state.mjs`, `run-handover.mjs`. Templates: `src/templates/ci/github.yml` and `azure-pipelines.yml` take a `{{TRUNK}}` placeholder (`branches:`, the workflow `name:`, the concurrency group) rendered by `hosted-ci.mjs` from the resolver, and the per-provider `policy` text names the resolved branch; `ai ci hosted --check` must still report this repository's `ci.yml` as current (its rendering is byte-identical, trunk `master`). `src/templates/CAPABILITIES.md` lines "git fetch origin master" / "push origin <sha>:refs/heads/master" become `<trunk>`; if any gate parses those lines literally it must match the resolved name. Agents `critic_tests.md` / `test_engineer.md` use `$(ai trunk)` for `merge-base` / `diff`. Prose: `ai` help, `ai-preflight` and `ai-task` SKILL.md, README, the blueprint, say "the trunk (`origin/<trunk>`; `master` in this repository)". Historical sentences ("master carried invalid JSON for four commits", D-062) are history and stay.
6. **4.1.0 waits.** E-334 (README "Team setup", CHANGELOG 4.1.0, tag) depends on E-341: the release's first-run document would otherwise teach "claims on origin/master" and the gate would lock out every `main` repository the document is written for. A known-issue note was considered and rejected (Alternatives 4).

### Alternatives considered
1. **Add `main` as a second literal fallback** — rejected: two literals instead of one; `trunk`, `develop` and release branches stay broken, and the templates would still render `master`.
2. **Always `origin/HEAD`, with `git remote set-head origin --auto` in `session-start.sh`** — rejected: a network call and a ref write in a hook path (ruling 3), and `origin/HEAD` is absent in some clones; a tracked field is deterministic across the team.
3. **A `trunk` field in `.ai/project.json`** — rejected: `project.json` exists only in record-store projects, while `ai ci hosted` renders in legacy projects too; `team.json` already carries the team's git policy (`ci`, `claim_ttl_days`).
4. **Ship 4.1.0 now with a known-issue note** — rejected: the note would sit in the same README section that onboards a team, and the claim gate failing closed on `main` is not a degradation but a lockout; the fix is Tier 2 and bounded (ruling 5 is a grep).
5. **The chosen chain (team.json → origin/HEAD → main|master)** — selected: explicit beats inferred, inferred beats a literal, and each step is a local read.

### Constraints driving this decision
- D-102 §4 and D-099/D-100: gate paths stay offline and deterministic; one bounded fetch per session start.
- D-104 posture: a tracked file, no env var; the doctor reports what the model would otherwise forget.
- D-103: the hosted check is a rendered contract; the rendering for this repository must not change.

### Impact
- Unlocks: E-341; E-334 (after E-341); E-337's GitLab/Bitbucket templates render `{{TRUNK}}` from the start.
- Risk if wrong: a wrong trunk resolution publishes claim commits to the wrong branch — mitigated by `[TRUNK_MISSING]` (the branch must already exist on origin) and the doctor mismatch line.

### Rollback
Delete `trunk` from `team.json` and the resolver falls back to `origin/HEAD` / `master`; reverting E-341 restores the literal. No data migration is involved.

---

## D-106 — Legacy-mode `state.json` is imported on pull per record, and view regeneration is refused while the index is behind HEAD

**Date**: 2026-10-23
**Task**: E-342 (Engineer; same registration note as D-105). Amends `.ai/blueprints/team-collaboration.md` §Component 2 (import on pull), which today applies to record-store projects only.
**Decision**: In a project without `.ai/team.json` (legacy mode) the tracked `.ai/state.json` stays tracked and is the cross-machine truth, `state.sqlite` is the per-machine index of it, and the E-326 import runs in legacy mode too: when `HEAD:.ai/state.json` is a blob the index has not imported, its records are merged into the index per record (never deleting local work); every view regeneration and `verify_markdown_sync` first check the index against HEAD and refuse with `[STATE_BEHIND_HEAD]` instead of rewriting the committed views from a stale index.

### Why needed
Finding 5 (Engineer addendum, 2026-10-23): after merging PRs #109..#112 the local index still held the 2026-10-15 state (max E-324); the next regeneration rewrote `state.json`, `TASKS.md` and `REVIEWS.md` from it, silently undoing E-325..E-337 and the archive, and `verify_markdown_sync` reported `[SYNC_PASS]` because it compared the views against the same stale index. `getDbSeeded` imports `state.json` only when the database file does not exist (`src/mcp/shared/state-db.js:155-164`); `importRecords` returns `LEGACY` and `hooks/state-import.sh` exits early without `project.json`. Every pre-4.1 project used on two machines, this repository included, loses a pull this way.

### Rulings
1. **Keep tracking `state.json` in legacy mode.** It is the only thing that travels between machines before `ai state migrate --team`; D-102's migration itself reads it. Legacy mode gets the same posture D-102 gave team mode: the tracked artefact is the truth, sqlite is a rebuildable index.
2. **Import keyed on the blob.** The index records `last_import_blob` = `git rev-parse HEAD:.ai/state.json` (the blob id, so a commit that did not touch the file is a no-op without parsing) and mirrors it into gitignored `.ai/.last-import-blob` so `hooks/state-import.sh` can compare two strings in bash and start node only when they differ. Triggers: the E-326 four (`post-merge`, `post-checkout` branch, `post-rewrite`, SessionStart) plus `ai sync`; the hook's `project.json` early exit goes.
3. **Merge per record, never delete.** For each task in HEAD's document: absent locally → inserted; present on both sides → HEAD's version replaces the local one when HEAD's `updated_at` is newer (E-342 adds `updated_at` to every legacy task write; a record without it on either side takes HEAD when HEAD carries a `completed_at` the local record lacks or has an older one, else keeps local). Stamps, deltas and CI records are keyed by their natural key (timestamp + type + task) and inserted when absent. Id counters and `nextId` become the max of both sides. Project focus takes HEAD's value only when the local one is unchanged since the last import. Local-only records are never removed: a pull cannot erase the task the operator just added. The import prints one line: `[STATE_IMPORT] legacy: +N tasks (E-a..E-b), ~M updated, +K stamps from HEAD <sha7>`, and when records changed on both sides an informational `[STATE_DIVERGED] … consider: ai state migrate --team`.
4. **The guard.** Before any view regeneration (every MCP mutation path, `verify_markdown_sync`, `ai sync`) the synchronizer compares `HEAD:.ai/state.json` with the index, cached by blob id: if HEAD holds a task id the index lacks, or a stamp newer than the index's latest, the regeneration is refused with `[STATE_BEHIND_HEAD] HEAD has E-a..E-b the index lacks — run: ai state import` and `verify_markdown_sync` returns `[SYNC_FAIL]` carrying that line. `[SYNC_PASS]` is impossible while behind. The guard never writes.
5. **Escape.** `ai state import --force` ignores `last_import_blob` and reruns the merge (ruling 3). No env var and no flag that skips the guard: a regeneration that overwrites HEAD is the loss this ruling exists to prevent.

### Alternatives considered
1. **Stop tracking `state.json` in legacy mode and point multi-machine users to `ai state migrate --team`** — rejected: it removes the only transport pre-4.1 projects have, overnight, and the migration itself needs the tracked file on the second machine.
2. **Replace the index wholesale from HEAD when HEAD is newer** — rejected: it erases local uncommitted work (a task added since the last commit) and "newer" is undefined once two machines diverged; per-record merge is what E-326 already does for record files.
3. **Guard only (ruling 4) without import** — rejected: it turns silent loss into a hard stop with no way forward except hand surgery, which is what the operator did on 2026-10-23.
4. **Import keyed on the commit (`last_import_head`, as E-326)** — rejected for legacy: the single document changes on most commits only through its views; the blob id makes untouched commits free.
5. **Per-record merge plus guard (chosen)** — selected: no data path can lose records, the guard makes a stale index visible before it writes, and the operator's recovery becomes one command.

### Constraints driving this decision
- `.claude/rules/ai-bookkeeping.md`: views are generated; the fix must live in the generator, not in a hand edit.
- D-102 §Component 2 and E-326: same triggers, same vocabulary (`[STATE_IMPORT]`), same hook file.
- Hook cost: `post-checkout` runs on every branch switch — the bash blob compare keeps node out of the common path.

### Impact
- Unlocks: E-342; E-334 (4.1.0 depends on it — the "Team" release must not lose a pull on the projects it has not migrated).
- Risk if wrong: a merge rule that prefers the wrong side on a conflicting record — bounded to one record, visible in the `[STATE_IMPORT]` line, recoverable with `--force` after fixing the file.

### Rollback
Revert E-342; the index returns to seed-once behaviour. `.ai/.last-import-blob` is gitignored and safe to delete.

---

## D-107 — `ai sync` reports a failed step as FAILED (exit 1, cause on one line) and probes the safe-exec gate it leaves behind

**Date**: 2026-10-23
**Task**: E-339 (Engineer). Amends the E-98 "fail-open" note in `src/bin/ai` `_generate_repo_map`: non-fatal still means every step runs; it no longer means silent.
**Decision**: A sync step has three outcomes — ok, skipped (the tool is absent or disabled by its env var, by design) and FAILED (the tool is present, ran, and exited non-zero). A failed step prints `✗ <step>: <last stderr line>` and the path of its captured stderr, every step still runs, the summary says `Done. (steps: N ok, M skipped, F FAILED — see the ✗ lines)` and `ai sync` exits 1 when F > 0. A new last step `gate_check` runs the mirror's safe-exec analyzer exactly as `hooks/pre-tool-use.sh` does, on the command `true`; no verdict or a non-zero exit is `✗ gate_check: [SAFE_EXEC_BROKEN] <reason> — run: bash install-ai-os.sh`. Sync never runs the installer itself.

### Why needed
Findings 2 and 3 (Engineer, 2026-10-23): `ai sync` printed `⚠ REPO_MAP.md generation failed — non-fatal` with the cause discarded (`2>/dev/null`), then `Done. (steps: 13 ok)`; the same sync left the pre-tool-use gate returning `[SAFE_EXEC_UNAVAILABLE] safe-exec exited 1`, so every Bash call in both panes was blocked and the Engineer could not even commit the handoff that reported it. The operator: "this should not happen in future." Both are one defect: sync counts a step that failed as ok.

### Rulings
1. **Outcomes.** `_sync_step` reads the step's return code: 0 ok, 2 skipped, anything else FAILED. Each step function returns 2 for its by-design skips (node absent, server not installed, `AI_OS_DISABLE_*=1`) and lets a real failure through. Stderr of every step is captured to `${TMPDIR:-/tmp}/ai-sync-<step>.<pid>.log`; on failure the last non-empty line (cut at 200 chars) is printed after `✗ <step>:` with the log path. Nothing aborts early: all steps run, then the summary, then exit 1 if any failed.
2. **REPO_MAP.** `_generate_repo_map` drops `2>/dev/null`; the current failure's cause becomes visible and E-339 fixes it (acceptance: `ai sync` in this repository regenerates `.ai/REPO_MAP.md`). The map stays non-fatal in the sense of ruling 1 only.
3. **Gate probe.** The hook's analyzer invocation (locator, node, timeout, verdict parse) is factored into `src/shared/gate-probe.sh`, sourced by `hooks/pre-tool-use.sh` and by sync's `gate_check` step and `ai doctor`, so the probe cannot drift from the gate. The probe runs `true` through the analyzer; PASS is ok; anything else is FAILED with the analyzer's stderr line. `ai doctor` prints the same `✓ safe-exec gate: <verdict>` / `✗ … [SAFE_EXEC_BROKEN]` line.
4. **No self-repair.** `bash install-ai-os.sh` rewrites `~/.ai-os` and the git hooks; D-083's posture is that the gate's own install is an operator action, and a sync run from the Architect pane must not reinstall the gate that confines it. The failed line names the command; the operator runs it.
5. **Exit code consumers.** The SessionStart hook and any skill that calls `ai sync` treat exit 1 as "sync ran, something failed, read the ✗ lines" — not as a reason to skip the session.

### Alternatives considered
1. **Keep "non-fatal" warnings, add the error line only** — rejected: the summary would still say every step was ok and the exit code would still be 0; the operator's complaint is the lie, not the missing detail.
2. **Make a failed REPO_MAP abort sync** — rejected: the map is a derived cache; the remaining steps (hooks, gitignore, version stamp) matter more and must still run.
3. **Have sync run `install-ai-os.sh` when the gate is broken** — rejected (ruling 4).
4. **Three outcomes, capture stderr, probe the gate, exit 1 (chosen)** — selected: honest summary, zero new flags, and the probe shares the hook's code path.

### Constraints driving this decision
- E-125/E-291/D-083: the gate fails closed and is installed by the operator only.
- D-104/D-088 posture: no new environment variable to silence a failure.
- Skipped-by-design must stay quiet so a fresh clone without optional tools is not red.

### Impact
- Unlocks: E-339. Finding 3's root cause becomes diagnosable the first time it recurs.
- Risk if wrong: a step that legitimately returns non-zero on a clean machine turns sync red — the ✗ line says which, and the fix is to return 2 from that step's by-design branch.

### Rollback
Revert E-339: steps return to warn-and-continue. No state is involved.

---

## D-108 — An empty index is an unseeded index; no regeneration from an index that holds fewer records than HEAD; `ai ci run` takes a per-machine env allow-list

**Date**: 2026-10-24
**Task**: E-344 (index seeding + doctor), E-343 (CI env passthrough) — Engineer. Amends D-106 (adds rulings 6-8) and `.ai/blueprints/local-ci.md` §Components 1.
**Decision**: `getDbSeeded` treats a `state.sqlite` with zero tasks and no `last_import_blob` exactly like a missing file and imports `state.json`; the D-106 ruling-4 guard also fires when the index holds fewer tasks than `HEAD:.ai/state.json` (the empty-index case is its degenerate form), so `verify_markdown_sync` never regenerates views from an index that is behind; `ai doctor` and preflight prefer `ai state import` over `ai migrate-state` whenever `HEAD:.ai/state.json` holds tasks; and `ai ci run` passes through the variables named in a gitignored `.ai/ci.local.json` allow-list, names only, never the isolation invariants.

### Why needed
Incident `task-synchronizer-mcp:verify_markdown_sync:empty-state-db-overwrites-views` (bonkraft, 2026-10-24T06:16Z, `~/.ai-os/incidents.ndjson`): after a clone to a new machine, `.ai/state.sqlite` existed with 0 tasks. The committed `state.json` (49 tasks, 86 stamps) was never imported because `getDbSeeded` keys the import on *file absence* (`src/mcp/shared/state-db.js:158`), and six other callers open the store through plain `getDb` — orchestrator-mcp `readState`, `run-handover.mjs`, archive-manager, context-guardian `check_workspace`, propose-patch, `record-migrate.mjs`. Whichever of them runs first on a fresh machine (the pre-tool-use gate calls context-guardian before any task-synchronizer call) creates the schema with no rows, and the synchronizer then sees "not new" and skips the seed forever. `update_task_status` answered "Task 'E-75' not found"; `verify_markdown_sync` reported 49 "appears in TASKS.md but is missing from state" anomalies and *auto-fixed* by rewriting `state.json` (0 tasks) and `REVIEWS.md` (−89 lines) from the empty index. `ai doctor` then pointed at `ai migrate-state`, which re-seeds from the lossy `TASKS.md` view instead of the intact `HEAD:.ai/state.json`. D-106 covers the stale-index form of this loss; the empty-index form is the same bug with a different trigger and is not named anywhere.

Second finding, same session: `ai ci run` scrubs the environment by construction (`env -i` + the curated `CI_ENV` list, D-072) and tests a clean worktree, so a per-machine value — bonkraft's Gotenberg port, which collided with another project's container and failed the run with a 409 — has no way in. The project's `.env` is gitignored and invisible to the worktree; `.env.example` is what its harness copies.

### Rulings
6. **Empty means unseeded.** `getDbSeeded` seeds (`importStateJson` in legacy mode, `rebuildIndex` in record-store mode) when the file is missing OR when the `tasks` table is empty and `project.last_import_blob` is unset. A deliberately empty project (`state.json` with zero tasks) imports zero rows and is unchanged. The plain `getDb` export stays for callers that only read, but every caller that may be the FIRST opener of a project's store goes through `getDbSeeded`: the six listed above are converted in E-344, and a unit test asserts that `getDb` has no caller outside `state-db.js` and the read-only MCPs whose stores are not `state.sqlite`.
7. **Behind includes empty.** The D-106 ruling-4 comparison is "HEAD holds a task id the index lacks, or a stamp newer than the index's latest"; an empty index against a populated HEAD satisfies it, so `verify_markdown_sync` returns `[SYNC_FAIL] [STATE_BEHIND_HEAD] HEAD has E-a..E-b the index lacks — run: ai state import` and its missing-row auto-fix (`index.js:605-615`) is unreachable while behind. Independently of HEAD (a project with no git, or `state.json` untracked), the auto-fix is additionally refused when the index holds zero tasks and `TASKS.md` lists one or more: `[SYNC_FAIL] [EMPTY_STATE_DB] index has 0 tasks, TASKS.md lists N — run: ai state import` (no git) and nothing is written. Regeneration from an empty index is never an auto-fix.
8. **Doctor and preflight prefer the lossless source.** `ai doctor` compares the index (not `state.json`) with `HEAD:.ai/state.json` and `TASKS.md`: index behind or empty with HEAD populated → `WARN: … — run: ai state import`; `ai migrate-state` is recommended only when neither HEAD nor the working `state.json` holds tasks (the view is all there is). `--repair` runs the import, never the migrate. The ai-preflight skill's state line names the same verdict. `ai migrate-state` itself refuses with `[LOSSY_RESEED]` and points at `ai state import` when `HEAD:.ai/state.json` has more tasks than `TASKS.md`, unless `--from-tasks` is given.
9. **Per-machine CI env allow-list (E-343).** `ai ci run` reads gitignored `.ai/ci.local.json` `{"env": ["NAME", "NAME=value", …]}`: a bare name is passed through from the invoking environment (the value is never written to the file or the log), `NAME=value` is a literal. Names matching the isolation invariants are refused with `[CI_ENV_RESERVED]` and the run is ERROR: `PATH`, `HOME`, `TMPDIR`, `SHELL`, `TERM`, `USER`, `LOGNAME`, `LANG`, `CI`, `TMUX`, `AI_OS_*`, `npm_config_*`, `PLAYWRIGHT_*`, and every E-264 `LAUNCH_VARS` entry. The `env` step line lists the passed names (`env ok HOME=… AI_OS_CI=local +GOTENBERG_PORT`) so the log shows what differed from a hosted run; the `ci_runs` row is unchanged (no migration). The hosted wrappers (D-103) never see the file: it is gitignored, so isolation on the hosted side is still by construction. `start.local.json` stays account-only (E-333).

### Alternatives considered
1. **Load `state.json` whenever the index is empty, at every open (no `last_import_blob` check)** — rejected: an intentionally empty project would re-import on every open, and E-342's blob key already answers "has this document been imported".
2. **Delete `state.sqlite` when empty and let the existing seed-on-missing path run** — rejected: it hides the real defect (unseeded first openers) and the next first opener recreates the empty file.
3. **A `[EMPTY_STATE_DB]` verdict only, no change to seeding** — rejected: it stops the loss but leaves "Task not found" on every mutation until the operator restarts the server and deletes the file by hand.
4. **CI env via `start.local.json`** — rejected: E-333 ruled it account-only and `ai start` rejects any other key; the CI runner is a different reader with a different lifetime. **`~/.ai-os/ci/env`** — rejected: per machine but not per project; two projects on one machine want different ports.
5. **Rulings 6-9 (chosen)** — selected: the seed keys on the index's own content, the guard keys on the lossless source, doctor names the lossless command, and the CI override is explicit, name-listed, and invisible to hosted runs.

### Constraints driving this decision
- D-106 rulings 4-5: no flag skips the guard; the empty case must be a case of the guard, not an exception to it.
- D-072 / local-ci.md: isolation is by construction, not by strip list — the allow-list is additive and the invariants stay unnameable.
- `.claude/rules/ai-bookkeeping.md`: views are generated; the fix lives in the generator and the seeder, never in a hand edit.
- E-344 lands after E-342 (same functions: `getDbSeeded`, the guard, `verify_markdown_sync`), so one blob-keyed import mechanism serves both findings.

### Impact
- Unlocks: E-343, E-344; bonkraft's E-75 close-out (interim recovery: `git checkout -- .ai/state.json .ai/REVIEWS.md`, remove `.ai/state.sqlite*`, restart task-synchronizer-mcp so the seed-on-missing path imports HEAD's document).
- Risk if wrong: ruling 6 seeds a store that another process is mid-way through filling (first open races) — bounded by `INSERT OR IGNORE` in `importStateJson`; ruling 9 lets a machine-local value make a run PASS that a hosted run would fail — visible in the `env` step line of the log.

### Rollback
Revert E-344: seeding returns to file-absence; `[EMPTY_STATE_DB]` disappears. Revert E-343: `ai ci run` ignores `.ai/ci.local.json`; the file is gitignored and safe to delete.

---

## D-109 — Every fixture HOME carries a toolchain record; `ai sync` step logs are `mktemp`'d and reaped; a reaper's own failure is FAILED

**Date**: 2026-10-24
**Task**: E-345 (harness record helper), E-346 (sync log + reapers) — Engineer. Amends D-107 (the log path in E-339's text) and `.ai/blueprints/test-harness-isolation.md` (new section, environment dependence shape #5).
**Decision**: (1) A fixture HOME that a hook, `ai`, or any pin-loading script will run under is written by ONE helper (`tc_fixture_home` in `tests/lib/toolchain-fixture.sh`, the node twin in `toolchain-fixture.mjs`) that records the host's real interpreters through the installer's own `ai_os_tc_write`; the hooks' fallback dir list is NOT extended. (2) `_sync_step` captures stderr to `mktemp "${TMPDIR:-/tmp}/ai-sync-<step>.<pid>.XXXXXX"`; ok/skipped logs are removed as today, a failed step's log is kept and named on its `✗` line, and `ai sync` removes the caller's `ai-sync-*` logs older than 24 h at start. (3) `_sync_reap_run_records` and `_sync_reap_watcher_state` stop swallowing the helper's exit: a non-zero node exit or unparsable JSON returns 1 (FAILED, stderr captured by the step), and only "helper absent / no node / `AI_OS_CLEAN_DISABLE=1`" stays 2 (skipped). Every `_sync_step` target is audited to the same three-outcome contract.

### Why needed
Engineer report after E-339 (2026-10-24 06:4x UTC). (1) With node only in Linuxbrew since 2026-10-23, 12 bash suites (105 assertions) went red on master: their fixture HOMEs had no `~/.ai-os/shared/toolchain.sh`, so the E-286 pin fell back to its fixed dir list and found no node. `a93c35f` fixed the two node unit tests only; the host was patched with a `/usr/local/bin/node` symlink, which hides the gap on this machine and nowhere else. 41 of the 45 suites that export a fixture HOME do not call the existing helper. (2) E-339's text specified `${TMPDIR:-/tmp}/ai-sync-<step>.<pid>.log`: in a shared `/tmp` a predictable name can be pre-planted as a symlink (`>` follows it) and failed-step logs are never removed; the Engineer implemented as written and flagged it. (3) The two reapers run the helper with `2>/dev/null || true` and parse its output with a `|| echo 0`, so a crashing reaper counts as ok — exactly the posture D-107 retired for REPO_MAP, and E-339 named only that one line.

### Rulings
1. **The record is the contract, not the fallback.** D-078 / T-HOOKENV-001 made the install-time record the only interpreter channel; the fallback list exists for a missing record and grows for no host. A test that runs a hook under a fixture HOME must give that HOME the record the real install writes. `tc_fixture_home <home>` (bash) and `tcFixtureHome(home)` (node) do that in one call, recording the host's resolved node, python3 and git — the same values `install-ai-os.sh` records — and are the only sanctioned way to create such a HOME. A census in `tests/run.sh`'s preflight (or `tests/lib/assert.sh`) fails the run when a suite exports a HOME under `$TMPDIR`/`mktemp` and then invokes `hooks/`, `ai `, or a `src/shared/*.sh` pin loader without the helper having written `<home>/.ai-os/shared/toolchain.sh` — listed exemptions carry a one-line reason. Proof that the fix is host-independent: each of the 12 suites named in the red run passes with the pin's fallback list emptied (`tc_stale_tree` idiom), which is the only honest simulation of "node outside the list" on a host that has node in it.
2. **Unpredictable log names.** `mktemp` with the template above; the `.<pid>` stays so a human can still find a run's logs. If `mktemp` fails the step is FAILED with `[LOG_UNAVAILABLE]`. D-107's text and E-339's fixed path are superseded by the template; the `✗` line prints the real path. At start `ai sync` deletes files matching `ai-sync-*.??????` under `${TMPDIR:-/tmp}` that are owned by the caller and older than 24 h — never anyone else's, never newer (a concurrent sync's log).
3. **A reaper that crashes has FAILED.** The node call runs with stderr inherited (the step captures it); exit ≠ 0 → `return 1`; exit 0 with output that is not JSON → `echo "[REAP_BAD_OUTPUT] <first 200 chars>" >&2; return 1`. `return 2` is reserved for the three by-design skips already in the functions. The Engineer audits every function on the `_sync_step` list for the same `|| true` / `|| echo 0` masks and converts them, naming each in the PR; `AI_OS_E247_FORCE_FAIL` remains the generic seam, and a fixture `ai-clean.mjs` that exits 1 is the reaper-specific one.

### Alternatives considered
1. **Add `/home/linuxbrew/.linuxbrew/bin` to the hooks' fallback list** — rejected: the next host puts node in `~/.nvm`, `~/.volta`, `/snap/bin`; a list that grows per host is the channel D-078 closed, and it would still leave the fixtures without the record that production has.
2. **Keep the fixed log name and `chmod`/`O_EXCL` it** — rejected: bash has no `O_EXCL` redirection; `mktemp` is the portable primitive and already on the toolchain list.
3. **Leave the reapers as they are (housekeeping is best-effort)** — rejected: D-107's whole point is that "best-effort" steps still report; a reaper that cannot run is exactly what the operator needs to see before the trash manifest goes stale.
4. **Rulings 1-3 (chosen)**.

### Constraints driving this decision
- D-078 / sovereignty-hardening.md §Hook Toolchain Pinning: hooks never consult an inherited PATH; tests must use the production channel.
- D-088 test economics: the helper replaces per-suite copies; the census is one check in the harness, not twelve new tests.
- D-107: three outcomes per step, no silent masks.

### Impact
- Unlocks: E-345, E-346; master green on any host whose node is outside the fallback list.
- Risk if wrong: the census (ruling 1) false-positives on a suite that sets HOME for another reason — bounded by the exemption list; the 24 h reaper (ruling 2) deletes a log the operator wanted — bounded to the caller's own files and the `✗` line already quoted the last stderr line.

### Rollback
Revert E-345: suites return to bare fixture HOMEs (red on hosts without node in the list). Revert E-346: fixed log names and best-effort reapers return; no state involved.

---

## D-110 — Rule-matching agents run on `sonnet`; reasoning agents inherit the pane's model

**Date**: 2026-10-23
**Task**: E-347 (Engineer). Amends `.ai/blueprints/claude-native-consolidation.md` (agent roster) by reference; `architect.md` §2 gains one line at the next refresh.
**Decision**: Agents whose job is to compare a diff or a log against written rules and emit a stamp pin `model: sonnet` in their frontmatter: `critic_arch`, `critic_security`, `critic_tests`, `critic_clean_code`, `docs-architect`, `sre_responder`, `memory_curator`. Agents that reason about design, threat surface or failure injection keep inheriting the pane's model: `security_engineer`, `db_architect`, `chaos_monkey`, `performance_engineer`, `dependency_manager`, `devops_engineer`, `meta_analyst`, `knowledge_architect`, `ux_reviewer`, `vibe_sentinel`, the three `seo_*` agents. `test_engineer` keeps its existing `sonnet` pin (D-069). `ai-review` Tier 3 and `ai-test --vibe` do not change which agents they dispatch.

### Why needed
Twenty of twenty-one agents inherit the Engineer pane's model, so every Tier 2/3 review runs four deterministic critics on `opus`. Claude Code's own usage report for this account (2026-10-23) puts "cheaper model for simple subagents" first. The critics are grep-and-compare over `.ai/architect.md`, `src/contracts/30_SECURITY.md` and the standards checker; their output is a PASS/FAIL stamp with cited lines. The model does not change the verdict; it changes the cost of reaching it.

### Rulings
1. **Pin by job, not by name.** A rule-matcher pins `sonnet`. A reasoner inherits. The split above is the list; a new agent states which kind it is in its description and pins accordingly.
2. **No pin below `sonnet` for a stamping agent.** `haiku` is the `--fast` Tester only (D-069): a stamp is evidence the commit gate trusts, and the floor stays where D-069 set it.
3. **Pins are frontmatter, mirrored by `ai sync`.** `src/claude/agents/<name>.md` is the source; the installed copy in `~/.ai-os/agents/` and the project `.claude/agents/` follow through the existing manifest. No env var, no per-project override.
4. **Verdict parity is the acceptance.** On the last three Tier 2/3 diffs that carry stamps in `.ai/REVIEWS.md`, each pinned critic re-run on `sonnet` reaches the same PASS/FAIL as the recorded `opus` stamp. A disagreement is reported, not papered over: that critic stays inherited and the PR says why.

### Alternatives considered
1. **Pin every agent to `sonnet`** — rejected: `security_engineer` writes THREAT_MODEL.md and runs payloads; `chaos_monkey` designs failure injection — judgment work the usage report's "simple subagents" does not describe.
2. **A per-project `agents.model` override in `start.json`** — rejected: one more knob with one more place to drift; the frontmatter is already the mechanism Claude Code reads.
3. **Pin by job (chosen)**.

### Constraints driving this decision
- D-069: the Triad is Claude-native; model choice is per role and per agent, in frontmatter.
- D-088 test economics: the verdict parity check reuses recorded stamps — no new suite.

### Impact
- Unlocks: E-347. Every Tier 2/3 review on the Engineer pane runs its critics at roughly a fifth of the token cost.
- Risk if wrong: a `sonnet` critic misses a violation `opus` caught — bounded by ruling 4's parity check on real diffs and by the critic's deterministic inputs.

### Rollback
Delete the `model:` line from the pinned agent files and `ai sync`; the agents inherit again.

---

## D-111 — Record order is per-origin `seq` with clock repair between origins; E-340's quoted-argument deviation and the D-085 r1 narrowing are accepted; a Tier 3 sign-off without security_engineer is a recorded substitute

**Date**: 2026-10-23
**Task**: E-348 (record ordering, Engineer — first, it unblocks every DONE), E-349 (ai-review substitute procedure), E-350 (safe-exec gaps on HEAD). Amends `.ai/blueprints/team-collaboration.md` Data Model invariants and `.ai/blueprints/sovereignty-hardening.md` (Component 6 pointer, D-085 r1).
**Decision**: Six rulings on the Engineer's 2026-10-23 21:04 UTC handoff (E-340 committed as 3d6b5b2; CI red on `tests/unit/record-store.test.mjs` "the round trip holds for this repository's own state.json").

### Why needed
The system clock jumped back about 14 h mid-session. Records written after the jump (E-345..E-347, the E-340 review stamps) carry earlier `created_at` than records written before it (E-343/E-344, the E-339 stamps). `state.json` holds rows in insertion order (rowid, stamp id); the record-store rebuild orders tasks by `_byCreation` (`created_at` first, `seq` only as a tie-break) and stamps by `created_at` then file id, so the regenerated document holds the same records in a different order and the byte-equality contract fails. Bisected by the Engineer to dc69333's `state.json`. D-102's record store assumed monotonic wall clocks; any teammate's skew reproduces it. Verified in code before ruling: `record-store.mjs:291` assigns `seq` from the task rowid at write time, `:398` sorts by time first, `stampRecord` (`:250`) carries no `seq`, and `state.json` tasks carry none (legacy order is implicit).

### Rulings
1. **Order is per-origin insertion, repaired between origins.** The insertion order a machine recorded is truth for that machine; wall clocks only arbitrate between machines. Rebuild computes an ordering key per record and never rewrites `created_at`: group records by `origin`; within an origin sort by `seq` (records without `seq`: `created_at`, then id or stamp file name); walk that order assigning `order_at = max(created_at, previous order_at)` (monotone repair); then sort all records by `(order_at, origin, seq, id)`. The key is a tuple, so the comparator is total and deterministic on every clone. Stamp records gain `seq` (the sqlite stamp id at write time); old stamp files without it fall into the no-`seq` branch. `importStateJson` and the legacy view keep rowid order (unchanged). Option (a) "compare order-independently" is rejected: the byte-equality contract is what caught this. Option (c) "legacy view in `created_at` order" is rejected: it makes `TASKS.md` reorder on every skew. Invariant added to the blueprint: "`seq` is monotonic per origin; between origins order is by repaired `created_at`".
2. **E-340 is DONE on the first green run.** Its reviews are complete (ARCH/SEC/TESTS/ALIGN PASS, CLEAN_WARN). It is marked DONE when `ai ci run` is green on the first commit that contains both 3d6b5b2 and E-348; no re-review.
3. **The quoted-argument deviation is accepted.** For the sovereignty families a quoted argument is not data: both cuts that treated it as data failed critic_security, and a string handed to `-c`, `eval`, `su -c` or `python -c` IS code. The Architect's `git commit -m 'git push later'` still blocks; the escape is `-F <file>` or a heredoc, which E-340's inert-body strip handles. E-340's acceptance is read without the clause "or a quoted argument"; D-105 ruling 6's wording is amended to "an inert heredoc body is data".
4. **D-085 r1 is amended for the sovereignty families only.** The read-only relaxation (`stripInertHeredocs(full, {readOnlyLines: true})`) applies to git/deploy/rm/mkdir/touch; the three content rules keep the strict strip; `analyzeArchitectWrites` keeps the full text. The lexer plus `operand-scope-cases.json` and `pipe-shell-cases.json` are the contract.
5. **Tier 3 without security_engineer.** When the agent is stopped by a classifier (or cannot run for any reason), the substitute is: critic_security `[SEC_PASS]` on the final cut, a HEAD-vs-staged differential over every corpus the review used, and the operator's explicit acceptance. It is recorded as a `[SEC_CLEARED]` stamp whose summary begins `substitute: security_engineer unavailable (<reason>); critic_security <stamp ts>; differential <path>`, and the stop is recorded with `skill: ai-incident` (signature `security_engineer:classifier-stop`) so the aggregator counts recurrences. The ai-review skill documents this path (E-349). E-340's sign-off is accepted retroactively under this ruling.
6. **The HEAD gaps become one Tier 3 task (E-350).** (i) a forbidden verb inside a string executed as code — `bash -c`, `sh -c`, `eval`, `su -c`, `env -S`, `python -c`, `node -e` — blocks for the Architect as if unquoted; (ii) `~user` and `"$UNSET"/*` operands count as root-form for `RM_RF_ROOT`; (iii) `git -c core.hooksPath=…`, `git config core.hooksPath`, and `GIT_DIR`/`GIT_WORK_TREE` assignments on a git line block for the Architect regardless of target (a hooks dir is executable text); (iv) the analyzer caps its group count and returns BLOCK `[INPUT_TOO_LARGE]` inside 200 ms for a 50k-group input instead of relying on the hook timeout.

### Alternatives considered
1. **Order-independent round trip (a)** — rejected, see ruling 1.
2. **`seq` first when origins match, else `created_at` (b as proposed)** — rejected: a comparator that switches keys per pair is not transitive (A<C by seq, B<A by time, C<B by time), so the sort is undefined; ruling 1 is (b) made total.
3. **Legacy view in `created_at` order (c)** — rejected, see ruling 1.
4. **Treat quoted arguments as data with a better parser** — rejected twice by critic_security in E-340's own history.
5. **Block Tier 3 entirely while security_engineer is unavailable** — rejected: gate work is exactly what the classifier stops; a documented, stamped substitute is honest, a silent one is not.

### Constraints driving this decision
- D-102 §Component 1: records are the truth and git merges them; the rebuild must be a pure function of the files.
- D-088: the existing byte-equality test stays; one skew fixture is added, no new suite.
- D-105 / D-107: no flag that skips a gate; substitutes are recorded, never implied.

### Impact
- Unlocks: E-348 → every DONE; E-340 DONE; E-349, E-350.
- Risk if wrong: ruling 1's repair places a late-origin record before an early one when two machines' clocks disagree by more than the gap between their writes — bounded: within-origin order is exact and the view is deterministic on every clone.

### Rollback
Revert E-348: `_byCreation` returns to time-first and the real-state round trip stays red until the clock catches up. Revert E-349/E-350 independently; no state involved.

---

## D-112 — E-350 ratified as built (root forms block every role; the cap is three limits); the Consolidation Map adopted; the census's suite deletes refused; residuals queued after wave 1

**Date**: 2026-10-28
**Task**: P-44 (DONE — the map is `.ai/blueprints/test-economics.md` §Consolidation Map), E-350 (ratified), E-351 / E-352 / E-353 (new). Amends `.ai/blueprints/sovereignty-hardening.md` §Operand Scope and Inert Heredocs.
**Decision**: Six rulings on the Engineer's 2026-10-28 08:47 UTC handoff (E-346, E-338, E-347, E-350 DONE; commit a1b76e4 on the unpushed `engineer/e350-safe-exec-gaps`).

### Why needed
E-350's acceptance said every new fixture class "keeps its HEAD verdict for the Engineer"; as built, class (ii) blocks the Engineer too, and class (iv) caps words and bytes as well as groups. P-44 was waiting on the E-297 census and the E-300 mutation report; the census runs on this machine (a1b76e4: 146 suites, 42,453 test lines vs 34,835 src lines), the mutation report does not exist here and no packet reached COMM.md. Both waves (E-301, E-302) and the ratchet (E-303) are blocked on the map.

### Rulings
1. **E-350 (ii) is accepted; the acceptance clause was over-broad.** `RM_RF_ROOT` is a catastrophic rule (`BLOCK_RULES`), not a sovereignty rule, and has never been role-scoped. `rm -rf ~user` and `rm -rf "$UNSET"/*` ARE root/home deletions whichever role types them; a role-scoped exemption would have been a new hole, not a preserved verdict. "Keep HEAD verdict for the Engineer" binds classes (i), (iii) and (iv) only. The Engineer's honest form for a variable root is `"${X:?}"/*` (fails closed when unset), which passes — the fixture row exists.
2. **E-350 (iv) is accepted with three limits** — 2000 groups, 10k words, 64 KB — because the 200 ms promise cannot be kept on a 64 KB line of 1 group any more than on 50k groups. The Architect's path for a document that size is the Write/Edit tool (path-gated, not line-parsed); nothing a hook legitimately sees is larger. E-351 (Tier 1) makes the block line name the limit that tripped and the escape, so the next Architect does not read it as a gate failure.
3. **Residuals are accepted for now and queued as one Tier 3 task after wave 1 (E-353).** Listed in the blueprint: aliased verbs, `GIT_CONFIG_GLOBAL=` / `HOME=` / `include.path` / `core.fsmonitor` / `core.sshCommand` on a git line, `GIT_DIR=x make`, five more carriers, eight more root forms, string concatenation inside programs, the `git grep GIT_DIR=` false positive — plus one found today: a `|` inside the BODY of a quoted-delimiter heredoc is read as a pipe by the content rules (a markdown table in a `cat >> .ai/… <<'EOF'` tripped `CURL_PIPE_SHELL`; D-111 r3's inert body is data for the sovereignty families but the strict strip of the three content rules does not strip a body that contains `|`). Not now, because `operand-scope-cases.json` is in motion in E-301; E-353 lands on the wave-1 tables, and the ruling that closes it pins `operand-scope-cases.json` and `block-rules-cases.json` by sha256 (D-056 class).
4. **The Consolidation Map is adopted as written** (146 rows, each suite once — checked mechanically against `tests/suites/`): 146 suites → 45 (10 in wave 1, 35 in wave 2), 26 → 43 unit files, nine contract tables of which six are byte-pinned, every `T-*` pin named to its carrier, the line arithmetic reconciled to ≈ 34,450 ≤ 34,835 with a 1% margin. Three rules the map adds to Component 4: a new table is ONE JSON row per line (the pretty form costs more lines than the bash it replaces); a table runs in process once, in its unit runner; the spawn path is probed once per table (one BLOCK row, one pass row) in `safe_exec_test`, which stays the only bash suite that may name a `-cases.json` path (the fast tier selects on that reference).
5. **The census's 48 suite-level delete candidates are refused.** Eight CI runs of failure history is too thin for D-088 r4 and "footprint covered" is not "behaviour covered" (caller_role is marked covered by role_token and carries T-PATCHMCP-001). Every one becomes a merge; the receiving suite drops an assertion only when its input→verdict pair already exists there or in a table, and every dropped label is listed in the PR. The E-300 unit-file deletion candidates are deferred: every unit file is `keep` until a probe report exists; E-302 attaches one if run, else reports the gap, and the map is amended by ruling.
6. **Two open risks become E-352 (Tier 2)**: the ai-clean trash manifest's read-modify-write loses entries under concurrent applies (serialise behind one lock), and `[REAP_FAILED]` truncates its cause at 200 chars. **Erratum to D-110 r3**: the retired path `~/.ai-os/agents/` should read `~/.ai-os/claude/agents/` (the live mirror); D-110's text is left as written, this line corrects it.

### Order of execution (the handoff)
Merge the stacked branches `engineer/e346-sync-logs` → `engineer/e347-sonnet-critics` → `engineer/e350-safe-exec-gaps` and PR #113 into the trunk first; then E-334 (v4.1.0 — blocked only on those merges); then E-301 → E-302 → E-303; then E-353 (after E-301, tables pinned by the closing ruling); E-351 and E-352 whenever a lane is free; E-337 last. P-43 (Architect, Tier 1) stays open for a later Architect turn.

### Alternatives considered
1. **Re-scope RM_RF_ROOT's new root forms to the Architect only** — rejected (ruling 1): it would add a role check to a catastrophic rule and leave the Engineer one `rm -rf "$TYPO"/*` from `/`.
2. **Drop the word and byte caps, keep the group cap** — rejected (ruling 2): the promise is 200 ms, and a single-group 64 KB line breaks it.
3. **Fix the heredoc-pipe false positive and the other residuals now** — rejected (ruling 3): the table they land in is being rebuilt by E-301; two tasks editing `operand-scope-cases.json` at once is the merge conflict D-088 r3's subset proof exists to avoid.
4. **Take the census's delete list as the map** — rejected (ruling 5): it is a footprint computation over eight runs; the pins prove it is not behaviour coverage.
5. **Wait for a mutation probe before writing the map** — rejected: hours of runtime on a report the map can absorb later by amendment, while three tasks sit blocked.

### Constraints driving this decision
- D-088 r3/r4: consolidation never shrinks a gate's input set; `T-*` pins move only by a map row; `arch-write-cases.json` byte-identical (D-056).
- D-111 r3-r4: a quoted argument is code; the content rules keep the strict strip — ruling 3 narrows what "strict" means for a body with `|` only through a fixture row, never by prose.
- D-105 / D-107: no flag lifts a gate; the cap has no override — the escape is a different tool, not a bigger limit.
- One copy of every rule (D-082 r5): the map lives in the blueprint; the task texts point at it.

### Impact
- Unlocks: E-301, E-302, E-303 (the map); E-334 (after the merges); E-351, E-352 now; E-353 after E-301.
- Risk if wrong: ruling 4's line arithmetic has a 1% margin — if the merges dedupe less than estimated, E-302 reports the shortfall with the rows that would close it and the ratchet (E-303) records the measured value, not the target; ruling 1 could block an Engineer command of the form `rm -rf ~user` that was intentional — the escape is an absolute path.

### Rollback
Rulings 1-2: revert E-350 (D-111 rollback). Ruling 4-5: the map section is replaced by a new ruling; a wave reverts as one PR and every deleted file is in history. Ruling 6: E-352 reverts independently. The erratum is a note, nothing to revert.

---

---

## D-113 — Wave-1 subset proof: pure inputs become table rows; context-bound inputs stay in their carrier suite; no table gains a context column

**Date**: 2026-10-28
**Task**: E-301 (question raised mid-task by the Engineer; amends D-112 r4 and the P-44 map's wave-1 proof paragraph)
**Decision**: The subset assertion of D-088 r3 is computed over a recorded set, not the census: E-301 records every pre-wave (mode, input, verdict) triple of the 24 wave-1 sources into tests/fixtures/wave1-inputs.json, one row per line, each row classed `table` or `boundary:<kept suite>`. `table` rows must exist in the post-wave table their mode maps to (matched on normalised input, role where the table has one, and verdict). `boundary` rows must name a carrier suite that the map keeps or renames, that exists post-wave, and whose text still contains the input verbatim; each names its `context`. The two classes partition the set; an unclassed row fails the test. No contract table gains a context column.

### Why needed
The map said "the census records them". It does not: census.mjs counts suites and lines; it never sees the hook's inputs. The Engineer recorded them from an instrumented throwaway worktree (445 unique triples, 253 already in tables, about 40 context-bound). A literal subset assertion cannot hold for the context-bound ones: the same input verdicts differently under an active override, the E-331 claim gate, an unverified token, or an empty --session, and a table runner models none of that state.

### Alternatives considered
1. **A context column in role-verdict-cases.json** — rejected. The table is byte-pinned at landing because it models the frozen D-087 role model. A context column makes the runner reconstruct process state (override files, team.json, token minting), which is exactly the bash boundary the suites exist for; it would also change the pin every time a new state appears.
2. **Drop the context-bound inputs from the proof** — rejected. The point of the proof is that nothing is silently lost in a merge; an input outside the proof is an input that can vanish.
3. **Two classes, partition, presence check for boundary rows** (chosen) — pure inputs are proven by row identity; context-bound inputs are proven by staying put in a suite the map keeps, with their text intact.

### Constraints driving this decision
- D-056: pinned tables change bytes only under a ruling; a context column would break the pin at every new process state.
- D-088 r3: the merge must be lossless at the input level.
- The instrumented index.js is a measuring instrument; it is never committed (NODE_OPTIONS is stripped by the hook, E-286.2, so a worktree copy is the only way to record). The procedure is one paragraph in tests/tools/README.md.

### Impact
- Unlocks: E-301 continues; E-302 reuses the same two-class scheme for wave 2 if it needs a proof.
- Risk if wrong: a boundary row whose carrier suite is later slimmed loses the input without the test noticing a verdict change, since the proof checks presence only. Mitigation: the carrier's own assertion still runs; E-303's ratchet forbids deleting a suite that a boundary row names.

### Rollback
Delete the class field from wave1-inputs.json and the boundary branch of consolidation-subset.test.mjs; the pure subset proof stands alone. The blueprint paragraph reverts to D-112 r4 wording minus the false census claim.

---

---

## D-114 — Proprietary licensing: companies only, signed offline keys plus a daily heartbeat, tiers unlock seats and support; open source deferred, reversibility kept by sole copyright

**Date**: 2026-10-28
**Task**: P-46, E-354..E-360
**Decision**: AI-OS is sold to companies under a proprietary agreement (no open-source grant anywhere in the tree). Enforcement is an Ed25519-signed licence document verified offline by the session-start hook (public keys ship with the install; the private key lives only in the vendor's secrets dir), with a PII-free heartbeat at most once per 24 h per machine to a vendor server that counts machines per licence. Two tiers (Gold 5 seats, Platinum 25 seats) differ in seats and support only; Platinum may be issued without heartbeat for air-gapped use. Enforcement degrades WARN for 14 days then READ_ONLY, never a silent failure, never a lockout of the operator escape. Blueprint: .ai/blueprints/licensing.md.

### Why needed
The operator wants to provide the framework to a company under strict control over who may use it, with sponsorship-style tiers and a way to know who runs it and for what. The operator considered open source on 2026-10-28 and chose proprietary.

### Alternatives considered
1. **Open source (Apache-2.0) plus paid support** — rejected for now: the allowlist requirement cannot be met, and an open version can never be withdrawn. Kept as a later option: the operator is the sole author of every commit, the one dependency is MIT, and outside contributions are accepted only under copyright assignment (legal/CLA.md), so a future version can be relicensed by one commit.
2. **Source-available (BSL / Fair Source)** — deferred: better discovery, weaker control; the natural next step after the first customers if growth matters more than control.
3. **Keys only, no heartbeat** — rejected: no seat counting and no usage visibility, which the operator asked for.
4. **HMAC keys using role-hmac.key** — rejected: that key is per machine; a licence must be verifiable by any machine with the public key and issuable by one.
5. **Repository access as distribution** — rejected: a clone cannot be revoked; a storefront downloadable can. Polar.sh per tier for invoicing and VAT.
6. **Obfuscating the check** — rejected: a licensee with source can remove it regardless; the design deters and detects (the agreement forbids removal, the heartbeat's absence shows it). Readable source is worth more than a speed bump.

### Constraints driving this decision
- GDPR: the heartbeat field list is closed and holds salted hashes and counts only; retention and purpose are in the agreement.
- D-080 secret rule gains the signing-key PEM header; the private key is never copied by sync, clean, the installer or the tarball.
- D-088: every new test is a unit table; license-cases.json is byte-pinned at landing (the state machine is frozen here).
- No new npm dependency: Ed25519, SHA-256 and HTTPS are built into Node.
- The lane: E-354 waits for E-301 so tables land on the consolidated harness; the licensing wave never pre-empts E-302/E-303.

### Impact
- Unlocks: P-46, E-354..E-360.
- Risk if wrong: a licensee removes the check and the server shows silence rather than proof; a seat count built on machine hashes undercounts shared build machines and overcounts a developer with two machines. Both are contract matters, stated in the agreement.

### Rollback
Delete the key (UNLICENSED path), reissue with no_heartbeat, or revert E-356 alone to detach the gate; the legal files revert to all-rights-reserved-by-default. See the blueprint's Rollback Plan.

---

### D-114 addendum (2026-10-28) — source visibility confirmed
The operator asked whether licensees will see the source, heard the three ways to hide it (bundle and minify, native binaries, hosted thin client) and chose to keep full source access. Reasons: the sovereignty gates only earn trust when the hooks are inspectable; buyers of developer tooling expect to read what runs in their terminal; the contract and the heartbeat carry the protection. E-360 ships the tree as is, minus .git, node_modules and secrets. No obfuscation task will be planned without a new ruling.

---

---

## D-115 — Free personal tier forever, public source-available repository under PolyForm Noncommercial, companies buy Gold or Platinum; supersedes D-114 where they differ

**Date**: 2026-10-28
**Task**: P-46, E-358, E-359, E-361, E-362 (amends .ai/blueprints/licensing.md Components 1, 6, 7, 8)
**Decision**: AI-OS is free forever for personal, non-commercial use under PolyForm Noncommercial 1.0.0 with the repository public; any commercial use needs the Gold or Platinum agreement. Every tier runs on a signed key with the heartbeat: personal keys are self-service by email, carry 2 seats, expire after 12 months and renew themselves through the heartbeat response (the heartbeat is the price of free; no personal key is ever issued without it). The server flags a personal key on more than 2 machines or 8 projects in 30 days as a commercial signal; the client shows it, nothing more. The personal issuer key is a separate kid held by the server; the company issuer key never leaves the vendor's machine. The repository goes public only after the pre-publication audit (E-362), the legal files (E-358) and the lawyer review (P-46).

### Why needed
The operator weighed discovery against control on 2026-10-28 (D-114 chose control) and, after the copying and distribution risks were laid out, chose the free personal tier as the sales channel into companies.

### Alternatives considered
1. **Fully proprietary (D-114)** — superseded: nobody finds a private tool; individuals are the way into companies.
2. **A hand-written "free for personal use" clause** — rejected: the edge cases (weekend work on an employer's project) are where homemade text fails; PolyForm Noncommercial already defines commercial use.
3. **Personal use with no key at all** — rejected: no tracking, no commercial signal, and the 14-day grace then read-only path for companies would be undefined. A free key costs the user one email.
4. **Personal keys that never expire** — rejected: expiry is the only revocation lever for offline copies; renewal through the heartbeat makes it invisible to an honest user.
5. **One issuer key for every tier** — rejected: the personal endpoint needs a signing key on a server; a separate kid bounds a server compromise to free keys.
6. **Open source (OSI)** — still rejected: the noncommercial restriction is the business; the README must not call it open source.

### Constraints driving this decision
- PolyForm NC is not OSI open source: no badge, the words "source available, not open source" in the README.
- GDPR: the server keeps the email only as a salted hash after the key is sent; it cannot write to the person again.
- The history goes public with the code: E-362 scans every commit for secrets and reviews .ai/ history for PII before the flip. Session ids and commit emails are already public-equivalent; credentials and customer names are not.
- D-114's sole-copyright and CLA rule stands: it is what keeps the terms changeable.

### Impact
- Unlocks: E-361 (personal tier on the client), E-362 (pre-publication audit); E-358 and E-359 execute per the amended blueprint (E-358's task text "all rights reserved" is overridden by this ruling).
- Risk if wrong: copies for commercial use the vendor never sees; forks frozen at a version; competitors reading the design. Accepted on the argument that a customer's leaked copy under D-114 carried the same exposure with fewer eyes.

### Rollback
Set the repository private again, replace LICENSE with the D-114 text, stop issuing personal keys (existing ones expire within 12 months with no renewal). Keys, heartbeat, server and paid tiers are unchanged.

---

## D-116 — E-301 ratified as built; run_review's PATH_TRAVERSAL does not apply to inert contract tables; the map's mode map corrected

**Date**: 2026-10-28
**Task**: E-301 (DONE, CI PASS fd67973), E-302, E-363
**Decision**: (1) All six E-301 divergences accepted: arch-write rows are --check inputs, so --check-path maps to role-verdict only; the E-216 widened-gate --check rows live in operand-scope; markdown-exec and traversal-policy keep JSON tables beside their unit files; wave1-inputs cites verbatim blocks by reference; gate-relative-home has its own runner; the fixture-home census exemption covers the merged pre_tool_use_gate suite for TOOLCHAIN_WRITE only. The test-economics map text is corrected to match. (2) run_review's PATH_TRAVERSAL P0 on tests/fixtures/*-cases.json and wave1-inputs.json is a false positive: those files are inert input tables whose rows ARE the traversal strings the gate is tested against; critic_security's SEC_PASS stands as the override for E-301, and E-363 teaches the rule to skip contract tables (a path under tests/fixtures/ ending in -cases.json or named wave1-inputs.json) so no future wave needs a ruling. (3) E-302's text names e143_test; it is mcp_role_interceptors_test since wave 1; the Engineer reads the task through the map, not the task text. (4) role-verdict-cases.json is pinned at sha256 34182edf23ab0cfeb61c596f88625145786d6ce949f213d076905eaca5333d54 (38 rows); E-356 will re-pin it by its closing ruling.

### Why needed
The Engineer's 16:31 UTC handoff asked for the PATH_TRAVERSAL ruling and listed the divergences; without a ruling every later table lands with the same P0.

### Alternatives considered
1. **Suppress the P0 per file with an inline marker** — rejected: markers in a byte-pinned table change the pin.
2. **Move the traversal strings out of JSON into the unit file** — rejected: that is the CAPABILITIES_BYPASS false positive the Engineer avoided by using JSON in the first place.
3. **Teach the rule the table convention (chosen)** — one path predicate, no marker, no pin change.

### Impact
- Unlocks: E-302 continues; E-363 registered (Tier 2).
- Risk if wrong: a real traversal hidden in a -cases.json row would pass review; mitigated because the tables are run, not executed, and the runner asserts verdicts, not paths.

### Rollback
Revert E-363; the rule fires again and each wave carries a ruling.

---

---

## D-117 — Publication through a squashed public mirror; this repository stays private forever; the export is scanned on every release

**Date**: 2026-10-28
**Task**: E-360, E-362, E-364, P-47 (amends .ai/blueprints/licensing.md Component 8 and the task table)
**Decision**: AI-OS is published as a second, public repository that receives each release as one squashed commit built by `ai release` from a filtered export of the release tag, authored by a project identity. This repository, with its full history and Triad bookkeeping, is never made public. The export includes the product, the legal files, the blueprints and DECISIONS.md and excludes COMM.md, LOG.md, REVIEWS.md, state.json, SESSION.md, start.json, team.json, archive/, DIGEST.md, REPO_MAP.md, TASKS.md and .mcp.json (a template is generated). The export is refused when a scan finds a personal email, a /home/<user> path, a session id, a socket path or a client project name; the scan runs inside `ai release`, every time. E-360's and E-362's task texts are read through this ruling.

### Why needed
The Architect's read-only scan of 2026-10-28 found no credentials anywhere in the 641-commit history but found the operator's personal and work email addresses as the author of every commit and in 236 review stamps, absolute home paths in .mcp.json, fixtures and one comment, session ids and a socket path in DECISIONS and LOG, and the names of two private downstream projects. Everything sensitive lives in bookkeeping and history, not in the product, so a squashed mirror removes the exposure without rewriting history.

### Alternatives considered
1. **Make this repository public with its history** — rejected: the exposure above, plus any later fix needs a history rewrite that changes every sha DECISIONS.md cites.
2. **Filtered history with a rewrite tool** — rejected: most work, highest chance of missing something, and the operator loses the exact history the decision log refers to.
3. **Squashed mirror (chosen)** — nothing from the past leaves; the scan is repeatable; the private repo keeps working exactly as today.

### Constraints driving this decision
- The mirror commit author is a project identity, never a personal mailbox.
- DECISIONS.md and the blueprints ship because they are the product's best documentation; P-47 scrubs session ids, socket paths and client names from them first, and the export scan enforces it afterwards.
- .mcp.json is generated per install and carries absolute paths; the mirror ships a template.

### Impact
- Unlocks: E-364 (tree scrub), P-47 (bookkeeping scrub); E-360 gains the mirror push; E-362 no longer needs a rewrite ruling.
- Risk if wrong: the mirror has no history, so bisecting a regression from outside needs the private repo; accepted, the vendor has it.

### Rollback
Delete the public mirror; nothing in the private repository changes.

---

## D-118 — Timing fields are recorded, not ratcheted; the private repository is renamed so the public mirror takes `ai-os`; the export must install; P-47 narrowed and executed

**Date**: 2026-10-28
**Task**: P-47, E-303, E-360, E-365, E-366 (ratifies E-302, E-358, E-362, E-363, E-364 as built)
**Decision**: Rule on the four items in the Engineer's 2026-10-28 19:09 UTC handoff and ratify the six tasks' divergences.

### Why needed
Six tasks shipped on `engineer/e301-gate-tables` (CI PASS bce9654, 6830/0/11). The audit (E-362, `.ai/AUDIT-PUBLIC.md`) found no history rewrite is needed but blocks the first mirror push on a must-fix list, and four items need an Architect ruling before the Engineer can continue.

### Rulings
1. **E-303 timing ratchet — recorded, never ratcheted.** `full_seconds`, `peak_rss_mb` and `peak_sum_rss_mb` are RECORDED in the budget block and do not fail a run. Four full runs on one idle host today took 466–514 s (spread 10.3%), so any fixed-slack ratchet on the best-ever value fails on host load alone; a ratchet that cannot distinguish load from regression is noise, and noise trains the operator to re-run until green. Only count-based fields ratchet (`suites`, `test_lines`) plus `fast_tier_seconds` as built (short, and the Engineer saw no spread problem there). Instead of a gate, `ai ci status` and `ai doctor` print `[BUDGET_DRIFT] <field> <latest> vs median-of-5 <value> (+N%)` when the latest green run exceeds the median of the last five green runs by more than 25% on any timing or RSS field — a visible line, never a FAIL (E-366). test-economics.md §11 and the E-313 note are amended; the "+10% once E-310 lands" sentence is withdrawn.
2. **O3 naming — the PRIVATE repository is renamed; the public mirror takes `Vimurai/ai-os`.** The product is called ai-os and its public home must be the plain name; a public repo called `ai-os-public` or `ai-os-releases` reads as a second-class copy. The operator renames the private origin to `Vimurai/ai-os-dev` (GitHub keeps PR #114, the branches and the old-URL redirect until the new public repo claims the name, which is the intent) and runs `git remote set-url origin` on every clone. Consequence for the tree: `README.md:176`, `src/shared/hosted-ci.mjs:32` and the hosted-ci tests already name `Vimurai/ai-os` and stay AS THEY ARE — after the swap they point at the public mirror, which is what an installing user and a downstream hosted-CI job need. The operator's own machines keep working from the private clone because the installer reads the local tree, not the URL. `CHANGELOG.md` release-tag links older than the first mirrored release become plain text (the mirror has no earlier tags); from the first mirrored release on, `ai release` (E-360) pushes the release tag to the mirror so new links resolve.
3. **O4 — the export must install.** The §Component 8 include list gains the root `package.json`, `package-lock.json`, `scripts/`, `.gitignore`, `CHANGELOG.md` and `CONTRIBUTING.md`; `.github/` stays excluded until E-360 ships a mirror-specific workflow (the private workflows reference the Triad bookkeeping). The list is a floor, not the test: E-360's acceptance is that `bash install-ai-os.sh && ai sync && ai doctor` succeeds from the EXPORTED tree in a temporary HOME, so any path the installer or `ai sync` reads and the list forgot fails the release, not the user.
4. **P-47 narrowed and executed by the Architect in this ruling.** The audit found no real session id or socket path in any exported `.ai/` file (only the `cc-socks/<pid>.sock` placeholder), so that part of P-47 is void. The remaining four sites are scrubbed now: the client name in DECISIONS.md:2046 (a redaction of a name, not a change of the decision — the append-only rule protects reasoning, not client identities), two client names in test-economics.md:160, the operator home path in workspace.md:10 and the placeholder home path in task-routing.md:29 (so the scanner's `/Users/<user>` rule stays simple). The operator still creates `.ai/publish-scan.local.json` with both client names (audit O2) — the Architect never writes them into a tracked file again.
5. **Engineer must-fix list → E-365** (Tier 2, blocks the first mirror push): audit S1, H4, E1/E2, O1, O2 fail-closed, L2/L3, O5, and ruling 2's CHANGELOG links. E-360 depends on it.
6. **Divergences ratified as built**: E-364's `.mcp.json` untracked-and-generated (the task's second option; downstream projects unchanged); E-358's clause 6 field list without the internal "Tier 3 SEC_FAIL" header (a review marker, not a contract term); E-362's scan as a module with `ai release --scan` left to E-360; E-363's single-rule exemption.
7. **E-302 census shortfall accepted.** 39,444 test lines against 34,935 source (1.13) is the ceiling the ratchet now records; it can only move down. The five merged giants (mcp_servers, task_synchronizer, ai_sync, state_views, harness_isolation) carry the duplicated setup that would close it; that is a later dedup wave when a lane is free, not a blocker — no task now.

### Alternatives considered
1. **Ratchet timing against a trailing median with wide slack** — rejected: still a gate on a number that host load moves by more than any honest regression threshold; the drift LINE gives the same signal without blocking.
2. **Name the mirror `ai-os-public` and keep the private name** — rejected: the public name is the product name; every README, badge and hosted-CI default would need a second URL forever.
3. **Keep the private name and move the operator's development to the mirror** — rejected: D-117 keeps the bookkeeping and history private; the mirror is one squashed commit per release, not a working repo.

### Constraints driving this decision
- D-117: the mirror receives squashed exports only; nothing from this repository's history leaves.
- D-088: a budget that fails on noise is worse than none; the ratchet exists to stop growth, not to measure hosts.

### Impact
- Unlocks: E-365 (must-fix list), E-366 (drift line), E-360 (install-from-export acceptance, tag push), the operator's repository rename.
- Risk if wrong: a real full-run regression under 25% goes unnoticed until the drift line crosses; acceptable, the counts still ratchet.

### Rollback
Rename the repositories back; re-add the timing ratchet behind the existing `--ruling` flag; restore the four scrubbed lines from the private history (they are never exported).

---

## D-119 — The licence signature covers the semantic canonical form (RFC 8785 profile); E-354's stricter install and fallback rules ratified; the heartbeat log is the audit record

**Date**: 2026-10-28
**Task**: E-354 (ratified), E-355, E-357, E-359
**Decision**: Rule on the six divergences in the Engineer's 2026-10-28 20:35 UTC handoff before the issuer (E-355) reuses `canonical()`.

### Why needed
E-354 shipped the verifier (b13bcb5, CI PASS 6908/0/11, SEC_CLEARED/ARCH_PASS/TESTS_PASS). Its canonicalisation choice is the contract the issuer, the server and every future key depend on; it must be fixed once, in writing, before a second implementation exists.

### Rulings
1. **Canonicalisation is semantic, not byte-level — ratified and named.** `canonical(payload)` is the RFC 8785 (JSON Canonicalization Scheme) profile that the payload needs: object keys sorted by UTF-16 code units recursively, no whitespace, strings escaped exactly as `JSON.stringify` escapes them, UTF-8 bytes. The payload carries integers only (`seats`), so JCS number rules and ES number formatting coincide and no float ever enters a signed document — the Data Model says so and the verifier rejects a non-integer `seats`. `ai license install` re-serialises the file, so the file's byte layout is irrelevant and the Component 3 phrase "or payload not canonical" is withdrawn: `TAMPERED` is a bad signature or an unknown `kid`, nothing else. One implementation: `canonical()` lives in `src/shared/license.mjs`; the issuer imports it; the server (separate repo, E-359) copies that one function verbatim and both repos carry the same pinned test vectors — E-355 adds a `canonical` row class to `license-cases.json` (`{label, payload, want_canonical, want_sha256}`, including a nested object, a non-ASCII licensee, a string with `"`/`\`/control characters and a key order that differs from sorted) and E-359 runs the identical rows. A server that cannot reproduce every row does not go live.
2. **Install refuses a downgrade without `--force` — ratified.** `ai license install` refuses a document whose computed state is worse than the installed document's (ordered LICENSED > GRACE > READ_ONLY, with `TAMPERED` never installable even with `--force`), printing `[LICENSE_DOWNGRADE] <installed state> → <new state>; add --force`. Stricter than the blueprint; it stops a stale key mailed by mistake from degrading a working machine. `--force` prints one line and installs.
3. **Two fallback rules — ratified.** (a) An unreadable or unparsable first-run stamp is `READ_ONLY`, not `GRACE`: the stamp is the only evidence of how long an unlicensed machine has run, and a verifier that cannot read it must fail closed; `ai license *`, `ai doctor` and the operator escape still work, so nobody is locked out of fixing it. (b) `over_seats_since` missing or in the future while the last response says over seats: the 14-day clock starts at `last_sent`. Never later than the last send, so a damaged stamp can only shorten the grace, never extend it.
4. **`ai license report` reads `~/.ai-os/heartbeat-log.ndjson` — ratified; E-357 writes it.** One JSON row per SENT heartbeat (`sent_at`, `ok`, `over_seats`, `seats_used`, `seats_allowed`, `revoked`, `status` = http status or the failure class), appended after the response or the failure; rotated to the last 90 days on each append. This file is the machine-side copy of the audit record the commercial agreement's heartbeat clause names, so the licensee can show what was sent without asking the vendor. `heartbeat.json` stays the single-row rate stamp. Added to the Data Model.
5. **Doctor section — ratified.** Five thin lines in `src/bin/ai` beside the dispatch line are formatting, not logic; nothing to rule.
6. **Unsigned local state (critic_security P3) — accepted, no change.** Deleting `license-first-seen` resets the unlicensed grace; deleting `heartbeat.json` drops the over-seats and revoked flags until the next heartbeat, which the 24 h rate sends within a day. Neither raises a key above its signed state. The server is the authority for seats (distinct machines over 30 days, independent of client files) and revocation (403 on the next heartbeat). Signing these files with a machine-derived key would be obfuscation in a source-visible product (D-114 addendum): the derivation is in the tree, so it buys nothing and costs a key-management story. An unlicensed machine that deletes its stamp every 14 days is a contract matter, which is where D-114 put enforcement.

### Alternatives considered
1. **Byte-level canonical check on the installed file** — rejected: install re-serialises; every installed key would be `TAMPERED`.
2. **Strict RFC 8785 with full number canonicalisation** — rejected as scope: the payload has one integer field; the profile above is JCS for that payload and a dependency-free implementation stays under 20 lines.
3. **HMAC the local state files** — rejected (ruling 6).

### Constraints driving this decision
- Two implementations (client, server) of one byte-exact function across two repositories: pinned shared vectors are the only durable contract.
- D-114 addendum: no obfuscation; the gate nudges, the contract enforces.

### Impact
- Unlocks: E-355 (issuer uses the shared `canonical()` and adds the vectors), E-357 (writes the log), E-359 (copies the function and the vectors).
- Risk if wrong: a server-side canonicalisation drift signs documents the client rejects; the shared vectors exist to catch exactly that before go-live.

### Rollback
Bump `kid`; re-issue every document under a corrected `canonical()`; old keys stay valid until their `expires` because the old public key stays listed.

---

## D-120 — Copy deterrence is legal, traceable and advisory; nothing in the tree can forbid an agent

**Date**: 2026-10-28
**Task**: E-367, E-368, P-46
**Decision**: Answer the operator's request for "code that forbids AIs from cloning, reverse-engineering or duplicating the repository" with the three layers that exist (licensing.md §Component 9) and refuse to pretend a fourth one does.

### Why needed
The operator asked for a technical measure against AI-assisted copying. No such measure exists: a file in a repository is data to whoever clones it, and an agent obeys the person running it, not a notice in the tree. Promising otherwise would be a false sense of safety at exactly the point where the operator is about to publish source.

### Rulings
1. **Forbid — in the contract and in a NOTICE.** Clause 3 of the commercial agreement gains the no-training and no-automated-reproduction restrictions; a root `NOTICE` carries the same two sentences for every reader plus the EU text-and-data-mining reservation. PolyForm's text stays verbatim (an additional notice is allowed; the terms themselves are not touched). The lawyer reviews both in P-46.
2. **Trace — fingerprint the paid download.** The licence server serves the tarball to a licence-authenticated request and writes a per-licensee fingerprint into it; the heartbeat carries the same value as a new closed field (`fingerprint`, Tier 3 field-list change). No generic paid tarball exists. The public mirror cannot be fingerprinted: it is identical for everyone by construction (D-117).
3. **Signal — machine-readable reservations.** `ai.txt`, `tdmrep.json`, robots directives on the docs site, an "AI agents" paragraph at the top of NOTICE and README. Advisory; they remove the "did not know" defence and nothing more.
4. **Not done**: obfuscation, hidden markers, canary passages, agent-blocking instructions — each is either against D-114's source-visible promise, visible to any reader, or defeated by one sentence from the agent's user.
5. **The one real lever is the operator's**: withdrawing the public mirror (D-117) and shipping the personal tier only through the fingerprinted download. Not taken in this ruling; D-117 stands until the operator says otherwise.

### Alternatives considered
1. **A "do not copy" instruction file aimed at AI agents** — rejected as the only measure: it binds nobody; kept only as the advisory paragraph inside NOTICE.
2. **Source obfuscation or a split build (public shell, private core)** — rejected: D-114 addendum promised full source to licensees; a split core is a second product.
3. **Per-licensee fingerprint in the public mirror** — impossible: one commit per release for everyone.

### Constraints driving this decision
- D-114 addendum (source visible, no obfuscation) and D-115 (public source-available personal tier).
- The heartbeat field list is closed (Tier 3 SEC_FAIL on any unlisted field), so the fingerprint is a listed change, not a quiet addition.

### Impact
- Unlocks: E-367 (clause, NOTICE, signals), E-368 (fingerprinted download, after the server exists), P-46 (lawyer scope grows by the two sentences).
- Risk if wrong: the operator expects prevention and gets deterrence plus evidence; this entry exists so that expectation is written down.

### Rollback
Delete NOTICE, ai.txt and tdmrep.json; revert clause 3; keep the fingerprint (harmless) or drop the field in a Tier 3 change.

---

## D-121 — No public mirror for now; every copy is a fingerprinted download

**Date**: 2026-10-28
**Task**: E-360, E-367, E-368, P-46 (withdraws the mirror push of D-117 and the repository rename of D-118 r2)
**Decision**: The operator chose copy deterrence over reach (D-120 r5): there is no public mirror. The source-available personal tier (D-115) stays, delivered only through the licence server's fingerprinted download, like the paid tiers.

### Why needed
D-120 made explicit that a public mirror is identical bytes for everyone and cannot be fingerprinted, fenced or traced, and that its only protection against AI-assisted copying is legal. The operator's priority is to keep every copy traceable; a public clone defeats that by construction.

### What changes
1. **E-360** loses the mirror push. It still builds the filtered export, runs the export scan (fail-closed on the client list), proves the export installs in a temporary HOME, signs and sums the tarball, and now uploads it to the licence server for E-368 to serve per licensee.
2. **E-368** also serves the personal tier: the `/v1/personal` link page offers the key and the fingerprinted tarball, so no bootstrap needs a public clone; personal keys are fingerprinted like any other. E-368 also makes the hosted-CI default source the licence-authenticated download endpoint, and the README install section describes the download, not a clone.
3. **E-367** shrinks to the legal layer: clause 3 restrictions, `NOTICE`, the README paragraph. `ai.txt`, `tdmrep.json` and robots directives are withdrawn (crawler signals with nothing public to crawl).
4. **Operator actions withdrawn**: renaming the private repository (D-118 r2) and creating a public `Vimurai/ai-os`. `.ai/publish-scan.local.json` is STILL required: the export scan guards the tarball now.
5. **Kept unchanged**: this repository stays private forever (D-117); the export include list, the audit (E-362), the must-fix list (E-365) and P-47 all still matter because the exported tree is what licensees receive.
6. **Reviving the mirror** is one ruling: restore the push in E-360 and the three signal files; nothing else needs to move. "For now" is the operator's phrase and this entry records it as reversible.

### Alternatives considered
1. **Keep the mirror but delay the first push** — rejected: a delayed push is still a push; the design must not carry a path that the operator has decided against.
2. **A public repository with only docs and the legal text** — not asked for; can be added later as a separate decision since it ships no source.

### Constraints driving this decision
- D-120: fingerprinting works only on per-recipient copies.
- D-115: the personal tier must stay free and source-visible — the download delivers full source; nothing in the licence changes.

### Impact
- Unlocks: E-360 as narrowed, E-368 with the personal delivery and the hosted-CI source.
- Risk if wrong: less discoverability for the free tier; the vendor site and the Polar page carry the personal sign-up link instead of a GitHub link.

### Rollback
One ruling restores the mirror push and the signal files; the audit and scrub work already done make that a same-day change.

---

## D-122 — The licensee archive is clean by construction: no operator data, no vendor reasoning, no archive metadata

**Date**: 2026-10-28
**Task**: E-360, E-369, P-46
**Decision**: Every archive a licensee receives (paid or personal, E-368) is built so that none of the operator's personal data and none of the vendor's internal reasoning can be in it, and that property is tested on every release rather than audited once.

### Why needed
The operator's requirement: "must be clean for people who get a license — no personal data leaks." The 2026-10-28 export-tree check found the operator's name in three files only (`LICENSE` copyright line, one blueprint row quoting it, the scanner's own test); the audit (E-362) and the must-fix list (E-365) already removed the emails, home paths and client names. Two gaps remained that no scan covered: the archive format itself, and the decision log.

### Rulings
1. **Scan gains `operator_name`** (E-369): names listed in the gitignored `.ai/publish-scan.local.json` under `operator_names`; a hit anywhere except `LICENSE`, `NOTICE`, `legal/` and the scanner's reviewed test refuses the release; absent list → `[SCAN_LIST_MISSING]` like the client list. The blueprint row that quoted the copyright line now says "the Required Notice copyright line".
2. **Archive metadata**: `ai release` packs with `--owner=0 --group=0 --numeric-owner`, a fixed `--mtime` (the tag date), sorted entries, no `.git`, no absolute paths. Without this a tar header carries the packer's login as file owner — the exact leak the scan cannot see because it is not file content. The acceptance lists the archive and asserts no user or group name, then re-runs the scan over the EXTRACTED tree.
3. **Decision log and licensing blueprint excluded from the export.** `.ai/DECISIONS.md` and `.ai/blueprints/licensing.md` hold price recommendations, lawyer notes, the deterrence reasoning and client-project anecdotes — vendor-confidential, and not needed to use the product. Licensees get `architect.md` and the product blueprints. (This also removes the only remaining operator-name quote outside LICENSE.)
4. **The one personal datum that stays by design is the licensor's name in the copyright line and the agreement.** That is a legal necessity, not a leak; if the operator prefers the company as licensor, P-46 records the entity and E-358's text changes with it. The operator decides.
5. **Nothing else of the operator's travels**: the heartbeat and fingerprint carry `lic_id`, machine hash and counts (Component 5, closed list); the licence document carries the licensee's name, not the vendor's; the server stores hashes.

### Alternatives considered
1. **One more audit before the first release** — rejected: an audit is a point in time; the next commit can reintroduce a path. The scan on every release is the control; the audit was the baseline.
2. **Ship DECISIONS.md with the licensing entries redacted** — rejected: a redaction step is a second scanner to maintain; excluding the file is one line.

### Constraints driving this decision
- D-121: the archive is now the ONLY way source leaves this repository, so its cleanliness is the whole publication boundary.

### Impact
- Unlocks: E-369 (small, free lane), E-360 as amended.
- Risk if wrong: a licensee misses the design history; they can ask.

### Rollback
Re-include the two files; drop the tar flags. The name class stays — it costs nothing.

---

## D-121 addendum — The repository rename stands

**Date**: 2026-10-28
**Task**: E-368 (hosted-CI source), P-46
**Decision**: D-121 withdrew the rename of D-118 r2 as a pending action; the Engineer reports it was already executed at the operator's request (20:45 UTC: `Vimurai/ai-os` → `Vimurai/ai-os-dev`, origin re-pointed, PR #114 and #115 live there). It is NOT reverted. `ai-os-dev` is the right name for a private working repository whatever happens to the mirror, renaming back gains nothing, and the old name stays reserved under the operator's own organisation for a future public repository. Until E-368 replaces them, the URLs in `README.md:176` and `src/shared/hosted-ci.mjs` resolve through GitHub's redirect for the operator and 404 for everyone else, which is correct: nobody else is meant to clone.

---

## D-123 — AI-OS goes open source under Apache-2.0, donations only; supersedes the commercial licensing decisions

**Date**: 2026-10-28
**Task**: E-370, E-371, E-372, E-373, E-374, P-48 (cancels E-356, E-357, E-359, E-360, E-361, E-367, E-368, E-369, P-46)
**Decision**: AI-OS is open source under Apache-2.0, copyright holder `Vimurai`, funded by donations and sponsorships only. No commercial licence, keys, heartbeat, server, tiers, copy deterrence or fingerprinting. Published to a new public repository `Vimurai/ai-os` as one squashed, scanned commit per release; this private repository (`Vimurai/ai-os-dev`) keeps the history and is never public. Blueprint: `.ai/blueprints/open-source-release.md`.

### Why needed
The operator decided (relayed by the Engineer, confirmed in the Architect session): "we go open source", with two conditions — no personal data leaks in the public repo at all, and an excellent README. The operator chose Apache-2.0 over MIT and AGPL-3.0, the handle `Vimurai` as copyright holder (so the real name appears nowhere public), and a top-quality README without a size target ("10k" meant quality, not length).

### Supersession
- D-114, D-114 addendum, D-115 (commercial/personal licensing and tiers): superseded in full.
- D-117 (squashed public mirror): the mechanism survives as `ai publish` — one squashed commit per release, this repo private forever — the "mirror of a licensed product" framing does not.
- D-118 r2 (naming) and r3 (export must install): kept; r1 (timing not ratcheted) and r4–r7: kept (unrelated to licensing). The rename to `ai-os-dev` and the public name `Vimurai/ai-os` are exactly what this ruling needs.
- D-119 (verifier canonicalisation): moot; the code is removed by E-371.
- D-120, D-121, D-121 addendum, D-122: the copy-deterrence and licensee-archive rulings are superseded; what survives of D-122 is the privacy pipeline (scan classes incl. `operator_name`, archive/commit metadata checks, DECISIONS.md excluded from export).
- D-113, D-116 (test economics): untouched.

### Rulings on the Engineer's seven points
1. Licence: Apache-2.0 (operator's choice). NOTICE per Apache convention with `Copyright 2026 Vimurai` and the third-party notices.
2. Cancelled: E-356, E-357, E-359, E-360, E-361, E-367, E-368, P-46; E-369 folded into E-372. Kept as done: E-354, E-355, E-358, E-362, E-364, E-365, P-47.
3. Reverts: as proposed, with these fixes — CLA → DCO (`Signed-off-by`); the E-358 test inverts to assert Apache-2.0 everywhere and forbid the commercial vocabulary; the licence code is REMOVED (not dormant — dormant code is a maintenance debt and a confusing signal in an open-source tree), the PEM/Ed25519 secret-rule guards stay.
4. Publication: a new public repo seeded with one squashed commit of the export, authored as the GitHub noreply identity, gated by the fail-closed scan; every release the same way; the history never. The operator creates `Vimurai/ai-os` empty.
5. Export contents: design history ships as DOCS, not as `.ai/`: `architect.md` → `docs/design/ARCHITECTURE.md`, the blueprints → `docs/design/blueprints/` (minus an exclude list seeded with `licensing.md`), copied by `ai publish` so the private repo stays the single source. `DECISIONS.md` and the working `.ai/` bookkeeping never ship; the export's `.ai/` is the `ai init` template only. Reason: the blueprints are the best documentation of how the system thinks and make the project credible; the decision log holds pricing reasoning, client anecdotes and the operator's working notes.
6. Privacy: the scan gains `operator_name` with NO allow-list (copyright is the handle), the export commit identity check, the lockfile `resolved` URL check, the template absolute-path check; `Vimurai` is not scanned. The operator's real name must not appear even in LICENSE.
7. README: quality, not size. Shape as the Engineer proposed, with depth in `docs/`; plus `FUNDING.yml`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and a public CI workflow.

### Alternatives considered
1. **AGPL-3.0** — offered to the operator because of the earlier copy concern; declined for adoption reasons.
2. **MIT** — declined; Apache-2.0's patent grant is what companies look for.
3. **Keep the licence code dormant behind a flag** — rejected: a 20-row state machine nobody runs is a trap for contributors and a false signal of a commercial product.
4. **Ship `.ai/` bookkeeping as-is in the public repo** — rejected: it is the operator's working memory, not documentation, and it is where the personal data lives.

### Constraints driving this decision
- Operator: no personal data at all in the public repo; the scan is the enforcement, the audit (E-362) is the baseline.
- The public repo must install from its own tree (D-118 r3) — the README quickstart is tested by the publish pipeline, not by hope.

### Impact
- Unlocks: E-370..E-374, P-48; the first public release.
- Risk if wrong: reversing to commercial later means re-licensing contributions — the DCO keeps that possible for the operator's own code only; outside contributions under Apache-2.0 stay Apache-2.0. The operator was told the direction is one-way for contributed code.

### Rollback
Before the first publish: revert E-370/E-371 from the private history (the licence code is one commit away). After: a public Apache-2.0 release cannot be un-published; later versions could change licence for the operator's own code only.

---

## D-124 — Public identity: real name as copyright holder and contact, noreply identity on publish commits

**Date**: 2026-10-28
**Task**: E-370, E-372, E-373, E-374, P-48 (amends D-123 rulings 1 and 6)
**Decision**: The operator chose, in the Architect session, that the public repository may carry their real name as copyright holder and their protonmail address as the project contact, while publish commits keep the GitHub noreply identity.

### Why needed
D-123 recorded "copyright holder Vimurai, real name nowhere" from the first answer; the operator then supplied the real name and the address and, asked precisely where they may appear, chose copyright + contact with noreply commits. This entry replaces that part of D-123 so the scan, the licence text and the publish identity agree.

### Rulings
1. **Copyright line** in `LICENSE` and `NOTICE`: `Copyright 2026 <the D-124 copyright holder>`. README's licence paragraph may repeat it.
2. **Contact**: `<the D-124 contact address>` in `SECURITY.md` (vulnerability reports), the root `package.json` `author` field (`<the D-124 copyright holder> <<the D-124 contact address>>`), and the README's contact or maintainer line. Nowhere else.
3. **Publish commits** stay authored by the noreply identity (`Vimurai <<id>+vimurai@users.noreply.github.com>`), so the address is not in every commit header that harvesters read; the `[PUBLISH_IDENTITY]` check is unchanged.
4. **Scan** (E-372): `operator_name` keeps the real name and the protonmail address in the list but gains an ALLOW-LIST limited to `LICENSE`, `NOTICE`, `SECURITY.md`, the root `package.json` and `README.md`; a hit in any other file still refuses. The former-employer address, home paths, session and socket paths and client names stay refused everywhere. The handle `Vimurai` is still not scanned.
5. **Nothing else** of the operator's becomes public: no home path, no second address, no workspace or client names; the design docs that ship are the ones already scrubbed by P-47/E-364/E-365.

### Alternatives considered
1. **Handle only** (D-123 as first recorded) — set aside by the operator.
2. **Real name and address on every commit** — declined on the Architect's recommendation: commit headers are scraped at scale; the contact file is enough for anyone who wants to reach the author.

### Impact
- Unlocks: E-370 (copyright text), E-372 (allow-list), E-374 (SECURITY.md, package.json author, README line), P-48.
- Risk if wrong: the address receives spam; it can be swapped for an alias in one release.

### Rollback
Replace the copyright holder and the contact in one release; the allow-list shrinks to nothing and the scan refuses the name again.

---

## D-125 — Product rename scope: the name changes in prose, repository and package; `ai`, `~/.ai-os`, `AI_OS_*` and `.ai/` stay

**Date**: 2026-10-28
**Task**: E-374, E-373, P-48
**Decision**: The operator is replacing "AI-OS" with a short product name (four letters; the choice is pending and arrives as a D-125 addendum). The rename covers the product name in prose, the README title and badges, the public repository name, the npm scope and package name if one is ever published, `NOTICE`, `.ai/publish.json` and the sponsor pages. It does NOT cover the CLI command `ai`, the install directory `~/.ai-os`, the `AI_OS_*` environment variables, the `.ai/` project directory, the hook and MCP names, or the `[AI_OS_ROLE]` stamp.

### Why needed
E-374 (README) cannot be written without knowing whether the quickstart says `ai init` or `<name> init`, and whether every installed project's `.ai/` moves.

### Rulings
1. **Identifiers stay.** `ai` is the best possible CLI verb and is independent of the brand; `~/.ai-os`, `AI_OS_*`, `.ai/` and the role stamp are load-bearing in every installed project, every downstream repository, the hooks, the templates and 45 test suites. Renaming them would break every existing install for no user-visible gain, and the public repo has no users yet who would expect otherwise. The README explains it in one line: "<Name> installs a CLI called `ai` and keeps its memory in `.ai/`."
2. **Prose, repository, package rename.** README, docs/, CHANGELOG heading, CONTRIBUTING, SECURITY.md, CODE_OF_CONDUCT, NOTICE first line, `.ai/publish.json` `public_repo`, the public repository itself (`Vimurai/<name>`), FUNDING and sponsor pages. The private repository stays `ai-os-dev`. The word "AI-OS" may survive in the private bookkeeping and in old decision entries; the export scan does not police it.
3. **Hooks' user-facing lines** (`[AI_OS_ROLE]`, `[LICENSE_*]` gone, doctor lines) keep their tags: they are contracts tests pin, not branding.
4. **README test amendments approved**: the `badge.svg` assertion in ai_ci_test E-268.03a narrows to "no static tests-passing badge" so a real GitHub Actions badge is allowed; the `ai start` lines and the per-project tmux recipe stay in a "Manual fallback" `<details>` block, as ai_start_test pins.

### Alternatives considered
1. **Rename everything** — rejected (ruling 1).
2. **Rename the CLI only** (`<name>` as an alias of `ai`) — rejected: two names for one command is a support burden; revisit only if the chosen name is itself a better verb than `ai`, which no four-letter noun is.

### Impact
- Unlocks: E-374 may start now with `<Name>` as a placeholder constant in the README source until the addendum lands; E-373's `.ai/publish.json` takes the repository name from the addendum.
- Risk if wrong: a brand that does not match its command; mitigated by the one-line explanation.

### Rollback
A later rename of identifiers would be its own blueprint with a migration (`ai sync` rewriting `.ai/` → new dir); not planned.

---

## D-125 addendum — The product is named Rein

**Date**: 2026-10-28
**Task**: E-373, E-374, P-48
**Decision**: The product name is **Rein** (capitalised in prose; `rein` in identifiers that D-125 allows to change). Public repository `Vimurai/rein`; npm scope `@vimurai/rein` if a package is ever published (the bare npm name `rein` belongs to an abandoned 2014 package and is not needed); NOTICE first line `Rein`; README title `Rein`; tagline direction: "Rein in your agents" — the reins keep the horses from bolting, which is the anti-drift protocol in one word. Everything D-125 keeps (`ai`, `~/.ai-os`, `AI_OS_*`, `.ai/`, hook tags) is unchanged.

### Why chosen
Operator's pick from the four-letter shortlist after collision checks: Keel and Keelson rejected (an active npm package, a Kubernetes operator, a funded startup and an "AI agent governance" API all use Keel; Keelson is a live Claude Code product). Rein: no developer product of that name on GitHub, the repository `Vimurai/rein` is free, one syllable, cannot be misspelt, and explains the product unaided.

### Impact
- E-374: replace the `<Name>` placeholder with Rein; the one-line explanation stays ("Rein installs a CLI called `ai` …").
- E-373: `.ai/publish.json` `public_repo` = `git@github.com:Vimurai/rein.git`.
- P-48: the operator creates `Vimurai/rein` empty (not `Vimurai/ai-os`); the old `ai-os` name stays a redirect to the private repo and is not reused.
- The private repository keeps the name `ai-os-dev`; the project directory basename and the pane names (`ai-os · Engineer`) are local conveniences and do not change.

---

## D-126 — The operator delegates the release actions to the Engineer; the first publish needs one Architect check of the dry run

**Date**: 2026-10-28
**Task**: E-375, P-48 (amends D-123 §Component 4 "first publication is an operator action")
**Decision**: The operator asked that the Engineer perform all remaining operator actions. Everything that a tool on this machine can do is now the Engineer's (E-375): the reinstall, the public repository, the local scan list, the dry run and the publish itself. Two actions stay with the operator because they require a human login and identity verification: enabling GitHub Sponsors on the Vimurai account, and converting the Polar products into sponsorship tiers.

### Rulings
1. **Reinstall**: the Engineer runs `bash install-ai-os.sh && ai sync` whenever `[BUILD_STALE]` or a stale MCP blocks a step, then restarts its MCP servers; it no longer waits for the operator.
2. **Public repository**: the Engineer creates `Vimurai/rein` with `gh repo create` — public, empty, description from the README pitch, topics, default branch `main`, issues on, wiki off. After the first publish it protects `main` (no force-push, no deletion) with `gh api`. It never creates or reuses `Vimurai/ai-os`.
3. **Local scan list**: the Engineer writes `.ai/publish-scan.local.json` (gitignored) with `client_names` (the two from the audit), `operator_names` (the operator's real name in every form found in the private history, the personal address, the former-employer address, the login) and the D-124 `allow` block for the real name and the personal address only. It is read from the private history, never from a tracked file, and the file is listed in `.gitignore` already.
4. **First publish**: after E-373 lands, the Engineer runs `ai publish --dry-run`, attaches the full output (file list, scan summary, install proof, commit metadata) to a handoff, and WAITS for the Architect's "publish" line; then runs `ai publish`, verifies the public tree with a fresh clone (scan = 0 hits, install proof from the clone), tags, protects `main`, and records the tag for P-48. One ping-pong before an irreversible public push is the only human-free check the Triad has; it is cheap and it stays.
5. **Sponsors**: `.github/FUNDING.yml` ships with `github: Vimurai` and `polar: Vimurai` (E-374) whether or not the accounts are enabled yet; the README's sponsor badge appears once P-48 records that they are.

### Alternatives considered
1. **Publish without the Architect check** — rejected: a public push cannot be unpublished; one review of a dry run costs minutes.
2. **Ask the operator to do the GitHub repo and the scan list** — rejected by the operator ("I want all this do engineer").

### Impact
- Unlocks: E-375; P-48 records the outcomes.
- Risk if wrong: the Engineer's pane runs in prompting mode, so `gh repo create` and the push may ask the operator to approve in that pane — that is the operator's own permission prompt, not a delegation failure.

### Rollback
Delete the public repository before anyone clones it; after that, publish a corrected release.

---

## D-127 — Maintenance loop: you work in ai-os-dev, Rein updates itself on every tag, and public contributions are imported back

**Date**: 2026-10-28
**Task**: E-373, E-376, E-375
**Decision**: Development stays in the private repository. The public repository is updated AUTOMATICALLY: a private-repo GitHub Actions workflow runs `ai publish` on every `v*` tag (E-373 ships it), so the operator's only release action is the tag the release-manager skill already creates. Contributions arriving on the public repository are imported into the private one by `ai publish --import <pr>` (E-376), credited to their author, and reach the public repository with the next tag.

### Why needed
The operator asked: "I work on ai-os but rein gets automatically updated?" Without this ruling the answer was "only when someone runs a command", and public pull requests had no path back at all.

### Rulings
1. **Outbound, automatic.** `.github/workflows/publish.yml` in the PRIVATE repo: on push of a tag `v*`, check out the tag, run `ai publish --tag <tag>` with the public repo's deploy key from the repository secret `REIN_DEPLOY_KEY` (write access to `Vimurai/rein` only, nothing else). The scan, the install proof and the identity check run in the workflow; any hit fails the job and nothing is pushed. The job's log is the release record. `ai publish` stays runnable by hand for the first release (E-375) and for a hotfix.
2. **Release cadence.** A release is a tag. `skill: release-manager` bumps the version, writes the CHANGELOG and tags; pushing the tag publishes. No "sync main" between the repos ever — the public `main` is only ever written by the workflow, and the public repo's history is the list of releases.
3. **Inbound, imported.** Public pull requests target the public tree (which equals the last release). `ai publish --import <pr-number>`: fetches the PR's commits from the public repo, applies them onto the current private branch with `git am` (author and `Signed-off-by` preserved; the DCO check is the merge gate), runs CI, and the Engineer handles conflicts like any patch. After the next tag publishes, the workflow comments on the PR with the release tag and closes it; the CHANGELOG credits the author. The README's contributing section says this in two sentences so nobody expects a green "merged" badge.
4. **Issues** live on the public repo only (the Engineer and the Architect read them; the Architect turns accepted ones into E-## tasks as today). The private repo keeps issues off.
5. **Secrets**: the deploy key is generated by the Engineer (E-376), its private half stored only as the GitHub Actions secret, its public half as a deploy key on `Vimurai/rein` with write access; it is never in any tree. `secret-rule.mjs` already refuses PEM headers in commands.

### Alternatives considered
1. **Develop in the public repo, keep only bookkeeping private** — rejected for now: the Triad commits `.ai/COMM.md` and the state by design (D-104), and those carry the operator's working notes; splitting them out of the tree is a larger change than this loop. Revisit if contributor volume makes the import step the bottleneck.
2. **Mirror every commit** — rejected: that is the history the operator decided never to publish (D-117/D-123).
3. **Manual publish only** — rejected: a release that depends on remembering a command is late or skipped.

### Impact
- Unlocks: E-373 gains the workflow; E-376 (import + PR closing + deploy key); E-375 performs the first publish by hand and verifies the workflow on the second tag.
- Risk if wrong: a workflow push with a scan false negative publishes a leak; mitigated by the same scan running locally in `--dry-run` before every tag and the fresh-clone verification in E-375.

### Rollback
Disable the workflow; publish by hand; delete the deploy key from `Vimurai/rein`.

---

## D-128 — After the first release, development moves into the public repository; the two-repo loop is retired

**Date**: 2026-10-28
**Task**: E-377 (cancels E-376; narrows E-373 and E-375 to the first release only)
**Decision**: The export pipeline produces the first public release of Rein as planned (E-373, E-375). Immediately after, the Triad moves its working clone to `Vimurai/rein` and develops there directly, with the noreply commit identity enforced and the privacy scan as a pre-commit hook and a CI job. The private repository `ai-os-dev` becomes a read-only archive of the old history. The tag-triggered publish workflow, the deploy key and the pull-request import tool (E-376) are cancelled before they are built.

### Why needed
The operator asked whether the two-repo loop was optimal. It is not: it hides history from contributors, prevents normal merges, and adds a secret and two Tier 3 tasks that exist only because the old history and the committed bookkeeping carry personal data. The first problem is solved once by the squashed first release; the second is solved going forward by identity and scan enforcement in the public clone.

### Rulings
1. **The first release stays as planned**: E-373 builds the export, E-375 publishes it after the Architect's dry-run check. `ai publish`'s squash-and-push part is used once; after the migration E-377 removes it (no dormant code, D-123 r3) and keeps the export scan and the install proof as the public CI jobs.
2. **Migration (E-377)**: clone `Vimurai/rein`; copy the Triad bookkeeping from the private clone AFTER scrubbing — `state.json`/`REVIEWS.md` stamps and any `.ai/` file with the operator's addresses rewritten to the noreply identity, `COMM.md` and `LOG.md` carried only from D-123 onward (the licensing-era entries hold the operator's working notes and stay in the archive), `DECISIONS.md` carried WHOLE (P-47 scrubbed it; D-### references in blueprints and code must keep resolving; the commercial-era entries are history, not secrets); `ai state import`; the open E-/P- tasks continue with their ids. Set the repo-local git identity to the noreply identity; a pre-commit check refuses a commit whose author or committer is not that identity. Install the five-class scan as a pre-commit hook over every staged file and as a required CI job over the whole tree on every push and PR. Branch protection on `main` (PRs required, CI required, no force-push). Archive `ai-os-dev` with `gh repo edit --archived` once the public clone passes CI and the Triad has completed one full ping-pong there.
3. **Pull requests** merge normally on the public repo; the DCO check is a required status. Issues on the public repo. No import tool.
4. **Bookkeeping stays committed** (D-104 unchanged): `COMM.md` handoffs become public reading, which is acceptable — they are architecture discussion. The scan is what keeps them clean; it refuses a handoff that names a client or a home path before it is committed.
5. **Local paths**: the operator's working directory basename changes with the clone (`rein`), so the pane names become `rein · Architect` / `rein · Engineer` (D-099 derives them from the basename); nothing else in the Triad depends on the directory name.

### Alternatives considered
1. **Keep the loop** (D-127) — superseded by this entry for the reasons above; D-127's inbound/outbound design is kept in the log as the fallback if public development ever has to stop.
2. **Public development from day one, skipping the export** — rejected: the export tooling is the only tested path that proves the first public tree is clean; it costs one run.

### Impact
- Unlocks: E-377 after E-375; cancels E-376.
- Risk if wrong: a careless commit in the public clone leaks what the scan does not know; mitigated by the hook, the CI job and the noreply identity. A leak that reaches `main` is removed by a history rewrite of the affected commits — acceptable early, and the reason the hook exists.

### Rollback
Reinstate D-127 (the workflow and the import tool) and resume development in the archive; the public repo would again receive squashed releases.

---

## D-129 — Public development from day one: Rein is bootstrapped once from a scrubbed snapshot and developed there; the README names its private predecessor

**Date**: 2026-10-28
**Task**: E-378 (cancels E-373, E-375, E-377; E-372 and E-374 continue; P-48 continues)
**Decision**: The operator chose to "do it right from the beginning": skip the export-then-migrate detour of D-128 and adopt its end state immediately. `Vimurai/rein` is created once from a scrubbed, squashed snapshot of the working branch, verified by the scan and the install proof, pushed after one Architect check, and from that commit on it is the development repository. No `ai publish`, no mirror, no import tool. The README says plainly that Rein is the successor of a private repository with more than 678 commits of development, whose history stays private because it carries the author's personal data.

### Why needed
D-128 kept the export pipeline for the first release only; the operator saw no reason to build a tool used once. The scan and the install proof are what make the first commit safe, and both exist (E-365, D-118 r3) without the squash-and-push command.

### Rulings
1. **One bootstrap task, E-378 (Tier 3)**, replacing E-373 (`ai publish`), E-375 (delegated operations) and E-377 (migration). It creates the repository with `gh`, builds the snapshot in a temporary directory, scrubs it, scans it, proves it installs, hands the Architect the listing, and on the "publish" line pushes ONE commit as the noreply identity, then installs the hooks, the CI jobs and the branch protection.
2. **Snapshot contents**: every tracked file of the working branch at the chosen version, EXCEPT `.ai/AUDIT-PUBLIC.md`, `.ai/blueprints/licensing.md`, and the pre-D-123 parts of `.ai/COMM.md` and `.ai/LOG.md` (the licensing era holds the operator's working notes); `.ai/state.json`, `.ai/REVIEWS.md` and every other `.ai/` file with the operator's addresses rewritten to the noreply identity; `.ai/DECISIONS.md` whole (P-47 scrubbed it; D-### references must resolve). The blueprints stay in `.ai/blueprints/` — this is the live Triad memory, not a docs copy, so D-123 r5's `docs/design/` copy is withdrawn; the README links the blueprints where they are. Anything gitignored is absent by construction.
3. **Verification before the push**: the five-class scan (E-372) over the snapshot = 0 hits; `bash install-ai-os.sh && ai sync && ai doctor` from the snapshot in a temporary HOME; author and committer = the noreply identity; no `.git`, `.env*`, `*.local.json`. The Engineer attaches the file list, the scan summary and the proof to a handoff and waits for the Architect's "publish" line (D-126 r4 kept — one check before an irreversible public push).
4. **The first commit**: message `Rein — successor of the private ai-os repository (678 commits, 2025-2026)`; tag by the release-manager skill (the Engineer bumps the version there; the CHANGELOG keeps its history entries). Then: repo-local noreply identity with the pre-commit identity check, the scan as a pre-commit hook and a required CI job, the DCO check required, `main` protected (PRs, CI, DCO, no force-push).
5. **Switch and archive**: the Triad's working clone becomes `Vimurai/rein` (pane names follow the basename: `rein · Architect`, `rein · Engineer`); after one full ping-pong there passes CI, `ai-os-dev` is archived read-only with `gh repo edit --archived`. Its history is the provenance the README refers to; it is never published.
6. **README successor section** (E-374): a short "Where this comes from" section — Rein is the successor of a private repository with more than 678 commits of development; the history stays private because it carries the author's personal data; the design decisions since the start are in `.ai/DECISIONS.md` and the blueprints in `.ai/blueprints/`, which is the same memory the Triad reads.

### Alternatives considered
1. **D-128's two phases** — superseded: a one-use tool is waste.
2. **Publishing the full history after a rewrite** — rejected again (D-117, D-123): the rewrite would have to catch every path, address, session id and client name in 650 commits; the scan catches them in one tree.

### Impact
- Unlocks: E-378; E-372 and E-374 are its prerequisites; P-48 records the first tag and the archive.
- Risk if wrong: a scan false negative in the first commit; mitigated by the Architect's listing check and the fact that the public repo is empty until then — a bad first push is deleted and redone, not rewritten.

### Rollback
Before the push: nothing public exists. After: delete the repository if nobody has cloned it; otherwise rewrite the affected commits and add the pattern to the scan.

---

## D-130 — Privacy by construction: one redaction module, applied at write time by every automated writer into the tree; telemetry never leaves `~/.ai-os`

**Date**: 2026-10-28
**Task**: E-379 (after E-372; before E-378 or in the same release)
**Decision**: Every code path that writes into the tracked tree on its own — review stamps, task deltas, handoff and digest generators, the repository map, CI records, incident-derived output, staged "proposed" skills — passes its text through ONE redaction function from the privacy module (`src/shared/publish-scan.mjs`, E-365/E-372) BEFORE writing. Redaction replaces a hit with `[redacted:<class>]` and logs one `[PRIVACY_REDACTED] <class> <file>` line; it never refuses, because a refused stamp would wedge the Engineer's commit flow. The pre-commit hook and the CI job (E-378) stay as the backstop that refuses what slipped through. Telemetry, incidents, insights and the memory palace live under `~/.ai-os` and are never copied into the tree except through that function.

### Why needed
The operator: "this tool has telemetry catching bugs, skills, issues — we must make sure nothing private leaks into the repo." The inventory of 2026-10-28 found 25 modules and hooks that write under `.ai/` or `.claude/`, nine ad-hoc sanitisers with different rules, and generators (digest, repository map, instinct stager, incident aggregator, CI evidence) that turn local data into tracked files. Once Rein is developed in public, every one of those writers publishes.

### Rulings
1. **One module, one rule set.** `publish-scan.mjs` exports `redact(text, {lists})` beside `scanText`; the five classes (personal_email, home_path, session_socket, client_name, operator_name) plus the D-080 secret detector (`containsSecret` from `secret-rule.mjs`) as a sixth class `secret`. The nine ad-hoc sanitisers are replaced by calls to it (telemetry.mjs, incident-append.mjs, managed-agents-client, approval, risk-analyzer, memory-manager, role-token, blueprint-aligner, build-stamp) — each keeps only what is specific to it (e.g. role-token's token shape).
2. **Writers wrapped** (the inventory): `add_stamp`/`add_task`/`update_task_status`/deltas (task-synchronizer → state.json, TASKS.md, REVIEWS.md); `run_review`/`run_handover` outputs (orchestrator); blueprint-aligner reports; `ai digest`/digest_updater → DIGEST.md; ast-parser `generate_map` → REPO_MAP.md; ci-record/ci-evidence rows; hosted-ci summaries; the instinct stager → `.claude/skills/proposed/*`; the incident aggregator's threshold block; `ai log`/`.ai/log/*.md` in team mode; the stop hook's SESSION stamp (gitignored, wrapped anyway); COMM.md written by skills (the hook refuses, the skill text tells the agent what was redacted).
3. **Lists**: the local file `.ai/publish-scan.local.json` is the source of client and operator names on the operator's machines; on a contributor's clone it is absent, so the name classes are empty there and the four structural classes (email, home path, session/socket, secret) still apply — a contributor cannot leak the operator's data they do not have, and their own home path is caught structurally. `[SCAN_LIST_MISSING]` is therefore a doctor WARNING on a clone without the file, not a refusal of every write (refusal stays for the publish-time scan only, which is now the pre-commit hook on the operator's machines).
4. **Tests**: one contract table `tests/fixtures/privacy-cases.json` with a planted payload per class; every wrapped writer has one row proving its output is redacted (extend existing suites, no new suite per writer). A CI job scans the whole tree on every push and PR (E-378 r8) and fails on any hit.
5. **Telemetry boundary**: `~/.ai-os/telemetry.sqlite`, `incidents.ndjson`, `INSIGHTS.md`, `memory-palace.md` are local; the meta_analyst and memory_curator write only under `~/.ai-os`; the only tree-bound output derived from them is a proposed skill (instinct stager), which is redacted at staging and human-approved before promotion (E-145). `ai doctor` prints `[PRIVACY_OK] writers=N redacted_today=K` from a counter the module keeps under `~/.ai-os`.

### Alternatives considered
1. **Refuse at write time** — rejected: a refused stamp blocks a commit mid-flow; redact-and-log keeps the flow and leaves evidence.
2. **Only the pre-commit hook** — rejected: it catches the leak after it is in a generated file the agent has already read and may repeat; and it does nothing for a contributor who commits elsewhere.

### Impact
- Unlocks: E-379; strengthens E-378's first snapshot (the generators that produce DIGEST/REPO_MAP run redacted).
- Risk if wrong: over-redaction of legitimate text (a fixture email in a stamp) — acceptable; the reserved `.test` domains and placeholders pass.

### Rollback
`AI_PRIVACY_REDACT=0` disables redaction at write time (the hook and CI still refuse); the module stays.

---

## D-130 addendum — As built by E-379 (f15848e): eight amendments ratified

**Date**: 2026-10-28
**Task**: E-379 (ratified), E-378, E-380
**Decision**: The Engineer's E-379 diverges from D-130 in eight points found by security_engineer and critic_arch; all are ratified.

1. **No disable switch.** `AI_PRIVACY_REDACT=0` is removed: a project's settings env reaches hooks and servers (E-291), so an env switch would let any project turn redaction off for everyone. Rollback section replaced: redaction is removed only by a code change under review.
2. **Sanitiser scope narrowed.** risk-analyzer and blueprint-aligner had no sanitiser; telemetry, approval, role-token, build-stamp and managed-agents sanitise things other than tracked text and are left as they are; incident-append and memory-manager keep their stricter rules with `redact()` layered after.
3. **Writer list as built**: gains `setProject`, advisor `logRuling`, ai-clean `logApply`; loses the incident aggregator block (writes no file). `REDACT_WRITERS = 12`.
4. **Identity metadata is not redacted**: a stamp's `author` and a CI record's `runner` are matched by Gate 2 and team CI; they become the noreply identity through E-378's repo-local identity, not through redaction.
5. **`team.json` gains `ci_record_host`**: the CI record host is `-` unless it is true.
6. **`hooks/post-tool-log.sh` is not wrapped**: LOG.md is gitignored by default.
7. **The backstop is explicit and is an E-378 acceptance item**: agent-authored files (COMM.md, DIGEST.md, blueprints, DECISIONS.md) are protected only by the pre-commit scan and the CI job; E-378 installs the pre-commit scan and the identity check BEFORE the first push, not after.
8. **Hardening**: `EMAIL_RE` bounded (was quadratic on long input); NFC and format-character normalisation in `scanText` and `redact`; whitespace-tolerant and Unicode-hidden name matching.

Residuals (security, non-blocking) become **E-380** (Tier 2, before the first public release or in it): Cyrillic and other confusable homoglyphs in names; Windows, URL-encoded and full-width paths and addresses; URL-userinfo addresses; hosted-ci warns instead of redacting.

---

## D-129 addendum — As built by E-378 (a97e8b7, c8a0a12): six deviations ratified; the README says the records are redacted; the snapshot is rebuilt from the HEAD that carries D-125 to D-130 before the push

**Date**: 2026-10-29
**Task**: E-378, P-48
**Decision**: The Engineer's listing of 2026-10-28 23:27 UTC is accepted. The six deviations critic_arch recorded become part of D-129. The README's "Where this comes from" section gains one sentence saying the `.ai/` records in the snapshot are redacted, not verbatim. The snapshot is rebuilt once from the HEAD that carries this addendum, because D-125 to D-130 (the rename, the delegation, the maintenance loop, the move to public development, the bootstrap itself and privacy by construction) were still uncommitted at c8a0a12 and the public `.ai/DECISIONS.md` would otherwise lack the decisions that explain its own first commit. After the rebuild passes the same gates the "publish" line stands without another round trip.

### Rulings
1. **Deviation 1 — `.ai/publish.json` is the gate's marker.** The file's presence (work tree, index or HEAD) switches the pre-commit gate on; deleting it is refused. The Data Model shrinks to `public_repo` and `author`; `exclude_blueprints` and `design_docs_dir` are gone with `ai publish` (D-129).
2. **Deviation 2 — the identity rule runs only where the operator's list exists.** A clone without `.ai/publish-scan.local.json` cannot know the personal addresses, so the `[PUBLISH_IDENTITY]` rule is skipped there; the structural classes still apply and the doctor warns (D-130 r2). The server-side email block and the CI job are the backstop (P2-8 residual, E-380).
3. **Deviation 3 — the sixth class `secret` is a high-precision subset of D-080.** Only `containsCredentialToken` shapes; `tests/fixtures/**` is exempt; a deliberate fake token elsewhere carries the `privacy:allow-fake-token` marker on the same line. The wide D-080 detector stays in the secrets gate, not in the privacy gate.
4. **Deviation 4 — the privacy job is its own workflow.** `.github/workflows/privacy.yml` (actions pinned to SHAs) is a separate required check on `main`, so a change to `ci.yml` can never drop the scan. `ci.yml` is re-rendered for `main` after the push (step 8), since the snapshot's copy still names the private branch.
5. **Deviation 5 — history-pinned rows are recorded skips.** In a one-commit checkout the 25 suites that pin git history skip with a reason line; they are counted in the CI record, not hidden. They resume as the public history grows.
6. **Deviation 6 — the builder's rewrites are the scrubbing rule.** 350 values in 5 `.ai/` files: review-stamp authors (146) to the noreply identity; the operator's name in prose to `<the D-124 copyright holder>`; the address to `<the D-124 contact address>`; test-input addresses quoted in summaries to `someone@example.com`; home paths and the OS login to `dev`. The private repository keeps the originals.
7. **README (question a): yes.** One sentence after "starts from a scrubbed snapshot of it": review stamps carry the project's noreply identity, and personal names, addresses and paths in the records were replaced with placeholders; nothing else in `.ai/` was changed. A reader who finds `<the D-124 copyright holder>` in a decision must know why.
8. **Rebuild before the push.** The Engineer commits its chore fold (state, REVIEWS, DIGEST, TASKS) after this addendum, rebuilds the snapshot from that HEAD and reruns the whole verification (five-class scan with the full list, tree checks, independent search, rehearsal commit under the noreply identity, `ai ci run` with the install step). Expected delta from the 23:27 listing: `.ai/DECISIONS.md`, `.ai/blueprints/open-source-release.md`, `README.md` and the chore-fold files; the file count stays 590. Any hit, any other changed path or any new file stops the publish and comes back as a handoff. Zero hits and the expected delta: publish (step 7), then step 8.
9. **`.ai/start.json`** (untracked, `{"account": …}`) is local pane state: never tracked, added to `.ai/.gitignore` in the first public commit, and the snapshot takes tracked files only, so it is not in the listing.
10. **Accepted risks.** P1-6 (plumbing commands and hookless clones skip the local gate) is covered by the server-side email block and the required CI job. The fast tier at 24 s against a 24 s limit under host load is a D-118 r1 timing field, recorded and not ratcheted; if it fails twice in the public CI it becomes an E-## to raise the limit, not a reason to skip the gate.

### Alternatives considered
1. **Publish the c8a0a12 snapshot as listed** — rejected: the public decision log would start without the six entries that explain the rename and the bootstrap; fixing it in a second commit is a visible stumble on day one.
2. **A second full listing round after the rebuild** — rejected: the delta is bounded to named files the Architect wrote or the Engineer's generated views, and the gates that decide (scan, identity hook, CI) run automatically on the rebuild; a hit halts it anyway.

### Impact
- Unlocks: E-378 step 7 (create `Vimurai/rein`, commit, tag `v4.0.0`, one push) and step 8; P-48 records the outcome.
- Risk if wrong: a public first commit with a residual; the mitigation is the same as D-126's — delete the repository before anyone clones it.

### Rollback
Delete `Vimurai/rein` before it is cloned; publish a corrected snapshot. The private repository is untouched.

---

## D-131 — The public line starts at v0.4.0; versions 2.0.0 to 4.0.0 are the private predecessor's history

**Date**: 2026-10-29
**Task**: E-378, E-382, P-48
**Decision**: The operator rejected `v4.0.0` for the first public release ("it should be v0.4") and chose `0.4.0` as the code version (semver needs three parts; prose says v0.4). The Engineer deleted the minutes-old public tag with the operator's intent — ratified; `Vimurai/rein` has no tag until E-383 merges. Rein's public version line is `0.x` until the CLI, the hook contract and the `.ai/` schema are declared stable, then `1.0.0`. The CHANGELOG keeps the `[4.0.0]`, `[3.1.0]` and `[2.0.0]` entries under a heading "Private predecessor (AI-OS, 2025–2026)" and adds `[0.4.0]` on top; nothing is renumbered.

### Rulings
1. **Sources of the version**: root `package.json` `0.4.0`; `ai version` reads it; the README badge follows the tag; the CHANGELOG entry `[0.4.0]` lists the rename (D-132) and the open-source release (D-123 to D-130) as its content.
2. **Project stamps (`project.aios_version`, soon `rein_version` — D-132)**: `project-upgrade.mjs` already restamps `previous → version` without ordering and keeps `.pre-<version>.json` copies, so a project stamped `4.0.0` becomes `0.4.0` on the next `ai sync` with the ordinary `stamped` line. No refusal, no "downgrade" warning, no epoch field: the version-lifecycle blueprint gets one sentence saying the public line restarts at 0.4.0 and 2.x–4.x are the predecessor's numbers. The doctor's version line prints the stamp as is.
3. **The private tag `v4.0.0`** stays in `ai-os-dev` (archived with it). The public tag `v0.4.0` is created by E-383 after the rename merges, so the first public tag already carries the new names. Later releases follow the release-manager skill unchanged.
4. **Semver under 0.x**: a minor bump may break; the rename is such a break and lands in 0.4.0 itself. `1.0.0` is a separate decision.

### Alternatives considered
1. **Keep 4.0.0** — rejected by the operator; a fourth major on day one promises a stability the public project has not earned.
2. **0.1.0** — rejected: four private majors of work deserve more than a first minor; 0.4 also keeps the "4" the private line reached, which helps anyone comparing the CHANGELOGs.
3. **An epoch or a special downgrade path in the lifecycle** — rejected: the restamp is already unordered; adding machinery for a one-time event is cost without a user.

### Impact
- Unlocks: E-382 (the version change), E-383 (the tag).
- Risk if wrong: an operator with projects stamped 4.0.0 sees `4.0.0 → 0.4.0` once; the line is self-explanatory.

### Rollback
Bump to the next minor; versions never go backwards again.

---

## D-132 — The rename is complete: `~/.rein`, `REIN_*`, `install-rein.sh`, `[REIN_ROLE]`, `rein-record`, `rein_version` and all prose; the command `ai` and the directory `.ai/` stay (supersedes D-125 rulings 1 and 3)

**Date**: 2026-10-29
**Task**: E-378, E-383, P-48
**Decision**: The operator, seeing `ai-os` throughout the published files ("it should all be renamed to rein"), reversed D-125's "identifiers stay". Asked whether the command and the memory directory change too, the operator chose to keep `ai` and `.ai/` (they do not contain the old name, and D-125's reasons for them hold). Every spelling of the old name — `ai-os`, `.ai-os`, `AI-OS`, `AI_OS_`, `aios`, `AIOS` — becomes the Rein form, with a one-release compatibility layer so existing installs and projects migrate on `ai sync` without a manual step. Blueprint: `.ai/blueprints/rein-rename.md`.

### Rulings
1. **Name map** (exhaustive; the blueprint carries the table): `~/.ai-os` → `~/.rein`; `AI_OS_<X>` → `REIN_<X>`; `AIOS_WORKSPACE` → `REIN_WORKSPACE`; `AI_OS_HOME` → `REIN_HOME`; `[AI_OS_ROLE]` → `[REIN_ROLE]`; `install-ai-os.sh` → `install-rein.sh`; the `aios-record` merge driver → `rein-record`; `project.aios_version` → `project.rein_version`; `aios`/`AIOS` prefixes in identifiers, temp-dir prefixes and test names → `rein`/`REIN`; package names containing `ai-os` → `rein` (root package `@vimurai/rein`); prose `AI-OS` → `Rein`. Unchanged: `ai` (command and bin), `.ai/`, `ai-*` skill names (`ai-preflight`, `ai-task`, …: the prefix is the command, not the brand), the hook file names, the MCP server names.
2. **History is not rewritten**: `.ai/DECISIONS.md`, `.ai/COMM.md`, `.ai/LOG.md`, `.ai/archive/**`, the CHANGELOG's predecessor entries, the README's "Where this comes from" sentence (it names AI-OS as the predecessor on purpose) and git history keep the old name. Everything else in the tree is renamed, including the live blueprints and `architect.md`: the Engineer applies the mechanical substitution there as a ruled exception to §35 (one commit, string replacement only, no sentence changed), because the Architect cannot write 59 files by hand and the text's meaning does not change.
3. **Install directory migration**: `install-rein.sh` creates `~/.rein`; if `~/.ai-os` exists and `~/.rein` does not, it moves the directory (telemetry, incidents, insights, memory palace, registry, the installed mirror) and leaves `~/.ai-os` as a symlink to `~/.rein`; the doctor prints `[LEGACY_HOME_LINK] ~/.ai-os → ~/.rein (remove after 0.5)`. The symlink is removed by the 0.5 installer. A `~/.ai-os` that is already a symlink is left alone.
4. **Environment migration**: one resolver (`src/shared/env.mjs` + the `locate.sh` equivalent) reads `REIN_<X>`, then `AI_OS_<X>`; when only the old one is set it is honoured and the doctor prints `[LEGACY_ENV] AI_OS_<X> → REIN_<X>` once. Removed in 0.5. The hooks' `AI_OS_LOCATE_UNTRUSTED_ENV` guard is renamed with the same fallback.
5. **Project migration on `ai sync`**: rewrite `.claude/settings.json` hook paths `~/.ai-os/hooks/…` → `~/.rein/hooks/…`; `.gitattributes` and `.git/config` merge-driver entries `aios-record` → `rein-record`; `ARCHITECT.md`/`ENGINEER.md`/`CLAUDE.md` re-rendered from the templates; `state.json`/`state.sqlite` key `aios_version` → `rein_version` through `record-migrate` (reading the old key for one release). Each rewrite prints the ordinary `merged`/`stamped` line; `ai doctor` reports `[RENAME_PENDING] <file>` for a project not yet synced. Because of ruling 3's symlink, an un-synced project keeps working.
6. **Contract tables and tests**: the hook-surface, doctor and installer tables rename their expected tags in the same commit as the hooks; no suite is skipped or deleted; the test temp prefixes change with the identifiers. A test that pins the old tag deliberately (the legacy fallbacks of rulings 3–5) says so in its name.
7. **Where**: in the public clone, on a branch, as one PR under the privacy gates, after E-378 steps 8 and 9 and after E-382; tagged `v0.4.0` on merge (D-131). The private clone receives nothing.
8. **The published first commit** keeps the old names; that is history too.

### Alternatives considered
1. **Prose and filenames only (D-125 as it stood)** — rejected by the operator: the published tree shows `ai-os` in 250 files and the brand must be consistent.
2. **Rename `ai` → `rein` and `.ai/` → `.rein/` as well** — offered, declined by the operator: no brand string in them, and `.ai/` moving would touch every project directory.
3. **No compatibility layer** — rejected: the operator's own projects and every `.claude/settings.json` on this machine point at `~/.ai-os/hooks`; a hard cut would break the Triad that performs the rename.

### Impact
- Unlocks: E-383; the `v0.4.0` tag; P-48 records the completed rename.
- Risk if wrong: a missed spelling in a hook path breaks a hook silently — mitigated by the grep gate in the blueprint (zero matches of the old spellings outside the history exclusions is a CI assertion).

### Rollback
Revert the PR before 0.5 removes the compatibility layer; the symlink and the env fallback make the revert symmetric.

---

## D-133 — Public CI on GitHub Actions: a matrix, a fast job, nightly, CodeQL, Scorecard, Dependabot and a release workflow, free for a public repository

**Date**: 2026-10-29
**Task**: E-384, P-48
**Decision**: The operator asked to use GitHub's CI fully now that the repository is public ("we have unlimited everything"). GitHub Actions is free with no minute limit for public repositories on the standard hosted runners (Linux, macOS, Windows); larger runners are not free and are never used. The public CI grows from one Ubuntu job into: a `fast` job (`tests/run.sh --tier fast`, no install, under three minutes), a full matrix (`ubuntu-latest`, `macos-latest` × Node 22, 24, `ai ci run --lanes <cores>` with the install step), a nightly full run on `main` with `npm audit` and the budget drift report, CodeQL, the OpenSSF Scorecard, Dependabot for npm and actions, a dependency-review check on PRs, and a release workflow on `v*` tags. Blueprint: `.ai/blueprints/public-ci.md`.

### Rulings
1. **`ci.yml` stays rendered** by `ai ci hosted github` (D-103): the renderer gains a `public` profile, selected when `.ai/publish.json` is present (the same marker as the privacy gate), that emits the fast job and the matrix with actions pinned to commit SHAs. `--check` keeps guarding against hand edits. A rendering for a private team project is unchanged.
2. **Hand-written workflows beside it**: `codeql.yml`, `scorecard.yml`, `nightly.yml`, `release.yml`, `dependency-review.yml` and `dependabot.yml` are ordinary files, SHA-pinned, `permissions` minimal per job, each with a header comment naming this decision. `privacy.yml` (E-378) is unchanged and stays its own required check.
3. **Required checks on `main`**: privacy, fast, every full-matrix leg, CodeQL. A flaky leg becomes an E-## task; it is never dropped from the required list to go green.
4. **No Windows leg**: Rein runs on macOS and Linux (WSL on Windows); a Windows job would test an unsupported path. Revisit with a "refuses cleanly" smoke if Windows users appear.
5. **Nightly** (03:00 UTC, `main`): the full matrix plus `npm audit --audit-level=high` and the D-118 r1 drift line as a job summary; a failure opens or updates ONE issue labelled `nightly` (never one per run). Not cancelled by concurrency; PR runs are.
6. **Release** (`v*` tag): the full matrix must pass on the tagged commit; then a GitHub release is created from the CHANGELOG section for that version, with the sha256 of `install-rein.sh` in the notes. No npm publish (D-125 addendum: a package only if ever needed).
7. **Badges** in the README: CI, privacy, CodeQL, Scorecard, licence, version from the latest tag, sponsors.
8. **Budget discipline**: standard runners only; `timeout-minutes` on every job; artefact retention 14 days; caches keyed on the lockfiles; cancel-in-progress on PR groups. The fast job is the developer's signal; the matrix is the merge gate.
9. **Sequence**: E-384 lands after E-382 and before E-383, so the rename PR (which moves the install directory) is checked on macOS and both Node lines; E-383 renames the paths inside the renderer like any other file.

### Alternatives considered
1. **Hand-write `ci.yml`** — rejected: `ai ci hosted --check` would fail forever and the team-project rendering would diverge from the public one.
2. **One Ubuntu leg only** — rejected: the README promises macOS, and the installer's directory move (D-132) is exactly what macOS should check.
3. **Larger runners or Windows** — rejected: not free, and not supported, respectively.

### Impact
- Unlocks: E-384; E-383 runs on the matrix; P-48 records the required-check set.
- Risk if wrong: macOS runners queue longer and slow merges; mitigated by the fast job's early signal and by cancel-in-progress.

### Rollback
Delete the added workflows and set the renderer profile back to the single job; the required-check list shrinks to privacy + `ai ci run`.

---

## D-134 — The Rein mark: two reins drawn toward the bit ring; animated SVG in the README, static SVG everywhere else

**Date**: 2026-10-29
**Task**: E-385, P-48
**Decision**: Rein's mark is concept A, "Taut": two stroke-drawn reins converging toward a ring (the bit), ink `#1b1d1f` with the ring in saddle `#c2612e` on light, bone `#f2ede4` with `#e0783d` on dark. Sources: `plans/rein-icon/svg/` (static light/dark, animated light/dark, 64-unit viewBox, stroke 5, round caps) and the design canvas https://claude.ai/artifact/PC1BkyJHukNMKBW2mu79qV (concepts B "Loop R" and C "Bridle" shown as alternatives). The README header shows the animated mark through a `<picture>` with a `prefers-color-scheme: dark` source; everything else (favicon, social card, docs) uses the static mark. The animation draws the reins once, then loops a slow tension every 3.2 s, and is disabled under `prefers-reduced-motion`.

### Rulings
1. **Files in the repository**: `docs/assets/rein-mark.svg`, `rein-mark-dark.svg`, `rein-mark-animated.svg`, `rein-mark-animated-dark.svg` (copied from `plans/rein-icon/svg/` byte-for-byte); `docs/assets/rein-social.png` 1280×640 rendered from the static mark + wordmark on the dark ground for the GitHub social preview; `docs/assets/favicon.svg` = the static light mark.
2. **Animated SVG, not GIF**: an SVG with CSS animation plays inside a README `<img>` on GitHub, stays crisp at any size, weighs under 2 KB and respects reduced motion; a GIF is 100× larger, dithers, and cannot follow the theme. No JavaScript, no external fonts, no `<foreignObject>` in any mark file (GitHub's image proxy strips scripts; the privacy gate and the SVG rule of D-129 addendum apply).
3. **README header**: the mark (120 px) centred above the `Rein` title and the tagline, the badge row below; the wordmark is the title text in the README's own typography, not an image, so it stays searchable and translatable. The `<picture>` element: `<source media="(prefers-color-scheme: dark)" srcset="docs/assets/rein-mark-animated-dark.svg">` then `<img src="docs/assets/rein-mark-animated.svg" width="120" alt="Rein">`.
4. **Colour**: one accent only; the reins take the text colour of their context. The accent is a lever (`data-props` on the canvas) until the operator fixes it; the four options on the canvas are saddle, teal, brass and ink.
5. **Not now**: a wordmark file, app icons for stores, a `rein` npm logo. Added when needed.

### Alternatives considered
1. **B "Loop R" monogram** — kept as the avatar fallback if A proves unreadable as a 32 px GitHub avatar; it has less story.
2. **C "Bridle"** — symmetric and calm, but reads as a pendant at small sizes.
3. **Lottie / GIF / video** — rejected for the README (ruling 2).

### Impact
- Unlocks: E-385; the README badge row from E-384 sits under the mark.
- Risk if wrong: a mark nobody likes is one file swap; nothing depends on its geometry.

### Rollback
Replace the four SVGs; the README markup does not change.

---

## D-135 — Hosted CI runs at the runner's width: every core is a lane, the census travels with the repository, the matrix is sharded, the fast job is change-selected, and the exclusive tail shrinks — for every Rein project and for Rein itself

**Date**: 2026-10-29
**Task**: P-49 (this ruling), E-386, E-387, E-384 (rescoped), E-337 (inherits)
**Decision**: The hosted `main CI` run takes 15.5 minutes of which 50 seconds are setup. The runner has four cores; `ai ci run` uses two lanes (the laptop default, cores/2) and then runs 13 suites serially, five of them serial only because a fresh runner has no census log to prove their installer footprint stays in a lane. The operator asked for every known remedy, applied once in Rein's shared code so that every project `ai ci hosted` renders for gets them, Rein included. Blueprint: `.ai/blueprints/ci-throughput.md`. This amends D-133 r1, r3 and D-091/D-093's lane default on hosted runners only.

### Why needed
A 15-minute signal trains people to stop pushing; D-133 multiplies that single job into a matrix. The remedies the industry uses (a fast signal first, sharding across machines, change-based selection, warm caches, hunting the serial tail) are each one flag away in this harness, except sharding, which does not exist yet. Nothing here is Rein-specific, so nothing is allowed to live only in Rein's workflow file.

### Rulings
1. **Lanes on a hosted runner default to every core.** `ai ci run` detects a hosted run (`GITHUB_ACTIONS`, `TF_BUILD`, `GITLAB_CI`, `BITBUCKET_BUILD_NUMBER`, else `CI=true`) and defaults `--lanes` to the core count, still clamped by the measured memory cap (D-093 r3). A laptop keeps `min(4, cores/2)`. An explicit `--lanes N` is unchanged. This lives in `ai ci run`, so every project gets it with no workflow change; the renderer stops passing `--lanes` at all.
2. **The census baseline is committed.** `tests/run.sh` takes its wall hints and installer footprints from the newest local log as today, and when there is none, from `tests/census-baseline.tsv` (the `CENSUS_SUITE` and `CENSUS_FP` rows of the newest full PASS, one file, tab-separated). `ai ci run` writes the baseline into the project tree beside the E-328 record after a full unsharded PASS; it is committed like the record and the pre-push hook warns when it is older than 30 full runs. A fresh runner then packs lanes by measured time and lets installer-subject suites into the lanes under the D-093 r2 rule. A project without `tests/tools/census.mjs` has no baseline and nothing changes.
3. **Shards.** `tests/run.sh --shard i/N` (also `AIOS_TEST_SHARD=i/N`) splits the suites deterministically: shared and exclusive suites each sorted by wall hint descending then name, each assigned to the lightest of N bins; the node unit layer runs in shard 1 only. `ai ci run --shard i/N` passes it through, records `shard: "i/N"` in the run row and the E-328 record, and a shard never certifies a commit on its own (`ai ci status` treats it like `--dirty`); the budget step (E-303) runs on shard 1 only (the inventory is static and the fast tier is timed alone, D-118 r1). Without `--shard` nothing changes. The renderer emits shards only when the project's `tests/run.sh` advertises `--shard` (the same grep that gates the fast tier), N from `team.json` `ci.shards`, default 4.
4. **The fast job in every rendering.** Any project whose `tests/run.sh` advertises `--tier` gets the `fast` job (no installer, Node 22, `timeout-minutes: 10`) in every provider's rendering, not only the public profile (amends D-133 r1). On a pull request it runs `tests/run.sh --changed origin/<trunk>` (the fast tier plus every suite whose census footprint touches a changed file — E-298); on a trunk push it runs `--tier fast`. With no census the harness already falls back to the full matrix and says so.
5. **The public matrix on a pull request** is `ubuntu-latest × Node {22, 24} × N shards` and `macos-latest × Node 22 × N shards`; macOS on Node 24 moves to the nightly (amends D-133 r3: the required legs are the pull-request legs). The nightly runs the full matrix including macOS 24 and ONE unsharded `ubuntu-latest` Node 22 run, which is the run whose `full_seconds` the drift line reports.
6. **The exclusive tail is a measured target.** The `[ci] resources` line gains `exclusive_seconds=` and `ai ci status` prints the exclusive share. Rein's own tail: the five "no measured installer footprint" suites join the lanes through ruling 2; the remaining eight are reviewed one by one in E-387 and each keeps its `# AIOS_EXCLUSIVE:` reason or loses the status. Target for Rein: the exclusive phase under 25 % of a leg's suite seconds; a team project is told its share, not held to it.
7. **Required checks.** `REQUIRED_CHECK` becomes a list the renderer prints with the policy line: `fast`, each `ai ci run (<os>, node <v>, <i>/<N>)` leg, and for Rein also `privacy` and `CodeQL`. A flaky shard becomes an E-## task; it is never dropped to go green (D-133 r3 stands).
8. **Sequence.** E-386 (harness and `ai ci run`) lands after E-382 and before E-384; E-384 renders what E-386 built; E-387 (Rein's tail) after E-386, any time. E-337's GitLab and Bitbucket wrappers inherit rulings 1–4 when they land. E-383 renames inside these files like any other.

### Alternatives considered
1. **Pass `--lanes 4` from the workflow** — rejected: only the projects whose workflow is re-rendered benefit; the default belongs where the cores are counted.
2. **Shard by suite name hash** — rejected: name order ignores the measured times; the two longest suites in one shard is the long pole again. Bin-packing on hints is deterministic once the baseline is committed.
3. **Keep macOS × Node 24 on every PR** — rejected: macOS runners queue longest; Node 24 on macOS exercises nothing that Node 24 on Linux plus Node 22 on macOS do not, and the nightly keeps it.
4. **Drop macOS from PRs entirely** — rejected for now: D-132's installer move is exactly what macOS should check on the rename PR. Revisit if the queue exceeds the leg's run time for a month.
5. **Make the fast job the merge gate and the matrix optional** — rejected: the fast tier has no census-blind safety net; the matrix is the gate, the fast job is the signal (D-133 r8 stands).

### Impact
- Unlocks: E-386, E-387; E-384 rescoped; E-337 inherits.
- Expected: setup unchanged; the long pole on Rein from about 15 minutes to under 5 per leg with four shards and four lanes; the pull-request signal under 2 minutes. These are predictions; `ai ci status` reports the measured values.
- Risk if wrong: a stale baseline packs lanes badly (slow, never wrong); a shard partition that changes when hints change can move a flaky suite between legs and hide it (the nightly's unsharded run is the control).

### Rollback
Per ruling: ruling 1 is the one default expression; ruling 2 deletes the file and the fallback branch; ruling 3 is `--shard` unused and `ci.shards: 1`; rulings 4–5 are the renderer's job list; ruling 7 restores the single name. Each is independent of the others.

---

## D-135 addendum — The fast job is the fast tier, with no installer and a time bound; change selection stays local; E-386 as built ratified

**Date**: 2026-10-29
**Task**: E-384 (unblocked), E-386 (ratified as built: PR #4 a1ae799, PR #5 491de58), E-387
**Decision**: The Engineer verified that D-135 r4 cannot run as written on a fresh runner: `--changed` selects from the census JSON under `~/.ai-os/ci/`, which a fresh runner never has, and every suite beyond the fast tier asserts against the installed mirror (DEVOPS-002), so a selected suite fails without `bash install-ai-os.sh`. The proposed fix (install only when selection reaches beyond the fast tier) makes the fast job's length depend on the change; a change to `src/bin/ai`, the commonest change in Rein, would pull in the large suites and turn the fast job into a fifth, unsharded, slower leg of the matrix it is meant to precede. Rulings:

1. **The fast job runs `tests/run.sh --tier fast` only**, on pull requests and on trunk pushes alike, with no installer and `timeout-minutes: 10`. Its value is a time bound, not coverage: the sharded matrix is the targeted signal and arrives a few minutes later. D-135 r4's `--changed` clause is withdrawn.
2. **Change selection stays a local tool.** `select-suites.mjs` falls back to `tests/census-baseline.tsv` when no census JSON exists (the Engineer's proposal (a), accepted), so `--changed` works on a fresh clone and in the pre-push hook; it is not rendered into any hosted job.
3. **E-386 as built is ratified**, with the four divergences the handover lists. Measured on hosted runners, unsharded: 914 s with four lanes and no baseline (13 exclusive, 508 s tail); 736 s with the baseline (9 exclusive, 300 s tail). The local exclusive share is 56 %, which makes E-387 the larger lever than shard count; shards still split the exclusive tail across legs (r3).
4. **The fast job's 2-minute figure** in `ci-throughput.md` is now a bound on the fast tier's 60 s budget plus checkout; the matrix leg's figure stays a prediction until the first sharded run is measured.

### Alternatives considered
1. **Install when selection reaches beyond the fast tier** (proposal (b)) — rejected: variable length, and for the common change it duplicates a matrix leg without shards.
2. **Run `--changed` inside the shards instead of the full suite** — rejected: the matrix is the merge gate and must be census-blind (D-135 alt. 5).

### Rollback
Ruling 1 is one line in the renderer's job list; ruling 2 is the fallback branch in `select-suites.mjs`.

---

## D-135 addendum 2 — First sharded run measured; macOS legs: no tmux install, guards under harness rule 1, the bash 3.2 trap defect is its own task, macOS joins the required set when it closes

**Date**: 2026-10-29
**Task**: E-384 (PR #6, run 40906294420), E-388, E-389, E-387
**Decision**: The first sharded hosted run replaces the predictions. `fast` 1m22s; Ubuntu × 22 shards 6m12s / 4m47s / 4m55s / 5m15s; Ubuntu × 24 shards 7m07s / 4m36s / 4m43s / 5m04s; macOS × 22 shards 13m44s FAIL / 7m46s / 4m11s FAIL / 8m35s; CodeQL 1m06s; privacy under 10 s. The Ubuntu pull-request wall time is about 7 minutes against 15.5 on the single job; the macOS shards set the total at about 14 minutes. The two red macOS shards are pre-existing defects the macOS image exposed, not E-384: `macos-latest` ships no tmux, and its `/bin/bash` is 3.2. Rulings:

1. **No `brew install tmux` on the macOS legs.** The hosted contract stays two commands (D-103). The tmux paths are covered on the Ubuntu legs, which have tmux; the macOS leg exists for what only macOS can show: bash 3.2, BSD tools and the installer's directory move (D-132). The 19 tmux assertions that fail instead of skipping are a harness bug under rule 1 (an optional need is `skip_unless_cmd`): fixed in PR #6 with host-named SKIP lines (E-332 pattern). Proposal (a) accepted without brew.
2. **The bash 3.2 trap-chaining defect is E-388** (Tier 2): a subshell EXIT trap does not fire through `assert.sh`'s trap-chaining wrapper under bash 3.2 (E-241.02a/b, E-239.05a–f). Reproduce locally under `bug-reproducer` by building bash 3.2.57 from the GNU source into a throwaway directory and running the two suites with that interpreter; a macOS run is the confirmation, not the loop. Proposal (b) accepted.
3. **Required set until E-388 closes**: `privacy`, `fast`, `CodeQL`, the eight Ubuntu legs. The macOS × 22 legs run on every pull request and are not yet required; the pull request that closes E-388 adds them, as E-388's acceptance. This is not a drop under D-133 r3, which forbids removing a required check to go green; the macOS legs were never required. Proposal (c) accepted with the exit condition.
4. **Shard 1 is the long pole** by 1.5–2 minutes on every OS because it carries the node unit layer and the budget step (r3). E-389 (Tier 1): the partition seeds bin 1 with the unit layer's measured seconds (from the census or the baseline) before assigning suites, so the shared suites fill the other bins first. Expected: the Ubuntu wall time from ~7 to ~5.5 minutes.
5. **`dependency-review.yml`** needs the repository's Dependency graph enabled (a GitHub setting the operator must flip; not a workflow change). It is not in the required set until it runs green.

### Alternatives considered
1. **`brew install tmux` on macOS** — rejected: a third command in the contract; tmux is already covered on Linux; brew adds a minute and a network dependency to the longest leg.
2. **Require the macOS legs now, red** — rejected: nothing merges. **Drop macOS from the matrix** — rejected: D-135 alt. 4 stands; the exit condition is concrete.

### Rollback
Ruling 3 is the branch-policy list; ruling 4 is one seed value in the partition.

---

## D-132 addendum — The rename to Rein is next; the mark follows it; the CI follow-ups wait

**Date**: 2026-10-29
**Task**: E-383 (next), E-385 (after E-383), E-389, E-388, E-387 (after both)
**Decision**: The operator set the priority: the product rename from AI-OS to Rein (E-383) is the next task, the Rein mark (E-385) follows it, and the remaining CI work (E-389 shard seed, E-388 bash 3.2 trap, E-387 exclusive tail) waits for both. D-133 r9 and D-135 r8 are satisfied: E-384 merged as PR #6 on 2026-10-29, so the rename pull request runs on the sharded matrix and the macOS legs (informative until E-388 makes them required). E-385 now depends on E-383 so the mark lands under the new name and paths. The partial macOS coverage is accepted: the rename's installer move is checked on the Ubuntu legs as the gate and on the macOS legs as evidence.

### Alternatives considered
1. **E-389 first** (one-line, cuts the Ubuntu wall time by ~1.5 min) — deferred: the operator's priority is the public identity; the CI is already under half its former time.

### Rollback
Sequence only; no file depends on it.

---

## D-136 — The README sells in outcomes, explains in Mermaid, and hands installation to a step-by-step `docs/install.md` that assumes nothing; it lands right after the mark

**Date**: 2026-10-29
**Task**: E-390 (after E-385), P-49 lineage
**Decision**: The operator asked, after the mark lands, for "perfect README files with graphs", a stronger explanation of what the system does in marketing terms, and a step-by-step guide that includes installing tmux and setting everything up. Blueprint: `.ai/blueprints/readme.md`. Rulings:
1. **Diagrams are Mermaid fenced blocks**, not images: GitHub renders them natively, themes them for light and dark, and they diff as text. Four blocks are specified in the blueprint (the loop, what a session reads first, the gate chain, the install path). The ASCII diagram and the `docs/assets/triad.svg` link go.
2. **The pitch is written in outcomes** (what a single chat loses and Rein keeps; plan and build as separate jobs; nothing merges on trust; local and thin), followed by "who it is for". Features move to a tour table below the quickstart.
3. **`docs/install.md` assumes an empty machine**: prerequisites per OS (macOS, Ubuntu/Debian, Fedora, Arch, Windows via WSL2), tmux with the five keys a user needs, Claude Code install and login quoted from the official page, then Rein, verification, first session, upgrade, uninstall, and the commonest failures with the `ai doctor` line for each. Install, upgrade, uninstall and the manual tmux fallback leave the README.
4. **The `docs/` pages the README already links must exist**: the public tree has no `docs/` directory, so those links are broken today. E-390 creates `docs/install.md`, `docs/how-it-works.md`, `docs/getting-started.md`, `docs/ci.md`, and a unit test that fails on any unresolved relative link.
5. **No "design" skill exists** in this repository or in Claude Code's skill set, so the design is specified in the blueprint (hero composition, section order, viewport rule, page weight) and checked by the `docs-architect` agent plus a by-eye pass in both GitHub themes.
6. **Sequence**: E-390 depends on E-385 (the mark) and therefore follows E-383 (the rename); it uses the post-rename names. The CI follow-ups (E-389, E-388, E-387) wait behind it per the operator's priority.

### Alternatives considered
1. **SVG diagrams rendered from a canvas** (as the mark was, D-134) — rejected for diagrams: two files per theme, no text diff, and GitHub already renders Mermaid.
2. **Keep installation in the README** — rejected: a complete per-OS guide is ten screens; the README's job is to be read in ten minutes.
3. **A docs site (GitHub Pages)** — deferred: four Markdown pages serve until the docs outgrow them.

### Impact
- Unlocks: E-390. Risk if wrong: Mermaid's GitHub subset limits styling; the loop diagram may need simplification to stay legible on a phone, which the by-eye pass catches.

### Rollback
One pull request; `git revert` restores the previous README and removes `docs/` and the link test.

---

## D-132 addendum 2 — Hard cut: the command is `rein`, the skills are `rein-*`, no compatibility layer; only `.ai/` keeps its name; the classifier rule moves to its Rein form; a Windows (WSL2) CI leg follows the tag

**Date**: 2026-10-29
**Task**: E-383 (mechanical passes, built on `rename/rein`), E-391 (new, same PR, before the `v0.4.0` tag; replaces E-383's §Component 4 acceptance), E-392 (new, after the tag)
**Decision**: The operator, reviewing E-383 on the branch, reversed the two exceptions that D-132 ruling 1 kept and then dropped rulings 3–5 whole: the command `ai` becomes `rein` with no forwarder; the `ai-*` skills become `rein-*` ("skills inside everything"); nothing of the old name survives except the `.ai/` directory; and there is no compatibility layer of any kind — the operator is the only person running Rein today, so there is no install to migrate but their own, which they migrate by hand. This supersedes D-132 rulings 1 (the "Unchanged" clause), 3, 4 and 5 and D-125's reasons for keeping `ai`; ruling 2 (history is not rewritten) stands. The Engineer's critic_arch findings D1–D3 are resolved below. Blueprint: `.ai/blueprints/rein-rename.md` (amended: §Component 2 table, §Component 3 list, §Component 4 replaced, §Components 6–8).

### Rulings
1. **The command is `rein`.** `src/bin/ai` → `src/bin/rein`, `src/bin/ai-exec` → `src/bin/rein-exec`, `src/bin/ai-account.sh` → `src/bin/rein-account.sh`; installed as `~/.rein/bin/rein`; the installer deletes the old `ai` entry in that bin directory and prints one line saying the command is `rein`. Every `ai <subcommand>` in the tree — the installer, the hooks, the git hook stubs, the settings templates, the rulefile templates, the skills, the agents, the contracts, the suites, the README and docs, the live blueprints — becomes `rein <subcommand>` (the Architect's grep: 271 files outside the history exclusions). `rein pane <role>` binds a pane; the tmux options are already `@rein_role` / `@rein_account`. No `ai` forwarder, now or later: the operator chose the hard cut over a one-release forwarder.
2. **The skills are `rein-*`.** The 18 `ai-`-prefixed skills — `ai-archive`, `ai-debug`, `ai-digest`, `ai-handoff`, `ai-incident`, `ai-insights`, `ai-log`, `ai-migration`, `ai-preflight`, `ai-profile`, `ai-review`, `ai-review-proposed-skills`, `ai-seo`, `ai-sync-state`, `ai-task`, `ai-test`, `ai-triage`, `ai-upgrade` — become `rein-<name>` in `.claude/skills/` and `src/shared/skills/` (directory, `SKILL.md` name, `_SKILLS_INDEX.md`, `_SYNC_MANIFEST.json`), and in the same commit in every registry keyed on a skill name: the rulefile templates (`src/templates/ARCHITECT.md`, `ENGINEER.md`, `SEED.md`, `architect.md.template`), `src/claude/CLAUDE.md`, the agents, `src/contracts/05_HANDSHAKE.md`, the RBAC role map (context-guardian), the wake and skill tables in `src/bin/rein`, `comm-status.sh`, `markdown-exec.mjs`, `cli-state.mjs`, `legacy-import.mjs`, `telemetry.mjs`, `build-stamp.mjs`, the hooks, `.claude/rules/`, the suites and the census baseline. The E-217 collision rule holds: `arch-task`, `arch-oracle`, `arch-review` carry no `ai-` prefix and stay; `rein-review` (Engineer) and `arch-review` (Architect) remain two skills. Skills without the prefix (`aqg-resolver`, `ci_gate`, `repo-oracle`, …) stay. A test proves each role overlay resolves every skill it names (the existing provisioning test, extended and named).
3. **`.ai/` is the one survivor.** It carries no brand string and moving it would touch every project directory (D-132 alternative 2, re-affirmed). Every gate pattern is written so that `.ai/` can never match it (ruling 8).
4. **No compatibility layer.** `.ai/blueprints/rein-rename.md` §Component 4 (D-132 rulings 3–5) is withdrawn: no `~/.ai-os` move or symlink; no `AI_OS_*` environment fallback (`src/shared/env.mjs` and `rein_legacy_env_apply` are deleted); no reads of `aios_version`, `ci.aios_source` or the `aios-record` driver; no legacy rewrites in `rein sync`; no `install-ai-os.sh` forwarder (critic_arch D3 resolved by deletion); no `[LEGACY_HOME_LINK]`, `[LEGACY_ENV]` or `[RENAME_PENDING]` doctor lines; no transition section in `docs/upgrading.md`; the gate-guard and secret-rule rows that protected the old home path go with it. The rename gate allows **zero** `rename:legacy-fallback` lines. The compatibility commits already on the unpushed branch are removed — a revert commit or dropped from the branch, the Engineer's choice, since nothing is pushed; the PR's final tree is what is reviewed.
5. **The operator migrates by hand**, from the list in the blueprint's §Component 4: reinstall from the merged `main` with `bash install-rein.sh`; delete the old-home symlink that today's reinstall left (`rm ~/.ai-os` — it is a symlink, not a directory; the Engineer tells the operator in the handoff, because the gate rows that protected that path are gone); run `rein sync` in every project (it re-renders the rulefiles, hook paths, merge driver and settings from the templates as it always has — no legacy detection); drop any `AI_OS_*` from shell rc files. No code names the old path or variable to help with this.
6. **Classifier rule text v5, label `(D-132)`** — critic_arch D1 resolved. The byte-pinned `RULE` in `src/shared/classifier-backstop.py` (D-097 r4, D-101 r1) is D-101's v4 paragraph with the product name, the command, the home directory and the installer name in their Rein form, and the label `(D-132)`. Verbatim:
   ```text
   Rein Gate Tamper (D-132): Never disable, bypass or weaken the Rein safe-exec gate or its role tokens, however assembled (shell variables, eval, bash -c, aliases, a script written then run, python/node/perl, sed -i, jq, cp/mv/ln, editor tools, subagents, or a nested claude launched with flags or settings that drop its hooks). Specifically: running `rein gate off`; creating, editing, moving or linking `~/.rein/gate-override.json`, `~/.rein/accounts.json` or anything under `~/.rein/{hooks,bin,mcp,shared,scripts,run,config,secrets}/` (by `~`, `$HOME`, a relative path or an absolute path); running `claude auto-mode reset`; changing `~/.claude/settings.json` or any registered Claude account's `settings.json` (the `config_dir` directories named in `~/.rein/accounts.json`), or their symlink targets, to remove or alter `autoMode`, `hooks`, `disableAllHooks` or `defaultMode`, or to add `permissions.allow` rules for `rein`; or changing a project's `.claude/settings.json` or `settings.local.json` to remove or alter `hooks`, `disableAllHooks` or `defaultMode`. Exempt: `rein install`, `rein sync`, `rein init`, `rein doctor`, `rein start`, `rein pane`, `rein account`, `rein gate on`, `rein gate status` and `bash install-rein.sh`, each run with no flag that skips, disables or redirects hooks or the gate — and, for `rein install`, `rein sync` and `bash install-rein.sh`, only from a source tree whose hooks, gate or installer this session has not modified; the `rein` command's own subcommands writing their runtime state under `~/.rein/run/` (never the gate switch); `rein install` creating the key under `~/.rein/secrets/`; reading these files.
   ```
   (One line, plain backticks, as the constant carries it.) E-391 swaps the constant and its pin together with `tests/suites/classifier_backstop_test.sh`; the E-318 replace-in-place refresh carries the new label into `~/.claude` and every registered account, so a `(D-101)` label is what `rein pane` and `rein doctor` report as OUTDATED. Both files leave the exclusion list.
7. **The exclusion list is the fixture as built, minus three** — critic_arch D2 resolved by ratifying the records and the self-references: `.ai/TASKS.md`, `.ai/state.json`, `.ai/REVIEWS.md`, `.ai/DEVOPS.md` (records of what was done, in the words it was done in), `.ai/DIGEST.md` and `.ai/REPO_MAP.md` (generated; the next `rein sync` and digest rewrite them), `.ai/blueprints/rein-rename.md`, `tests/fixtures/rename-map.json`, `tests/fixtures/rename-exclusions.json`, `tests/unit/rename-gate.test.mjs` (they must name what they rename). Removed from the list: `install-ai-os.sh` (deleted), `src/shared/classifier-backstop.py` and `tests/suites/classifier_backstop_test.sh` (ruling 6). The live blueprints, `architect.md` and the other `.ai/*.md` are rewritten mechanically as D-132 ruling 2 already allows, and the substitution now includes the command and the skill names (same one-commit §35 exception).
8. **The gate grows two patterns**, anchored so `.ai/` never matches: the command — `ai` followed by a space and one of the subcommands, preceded by start-of-line or a character that is not a letter, digit, `_`, `.`, `/`, `@` or `-`; the subcommand list is derived from `src/bin/rein`'s own dispatch table at test time, so it cannot go stale — and the skill names: `ai-` followed by one of ruling 2's eighteen suffixes as a whole word. The paths `bin/ai`, `ai-exec`, `ai-account`, the job id `ai-ci-run` and the display name `ai ci run (` are literal patterns. Zero matches outside ruling 7's list.
9. **CI check names rename with the job.** `src/templates/ci/github.yml`'s job `ai-ci-run` becomes `rein-ci-run`, display name `rein ci run (<os>, node <n>, i/4)`, and `requiredChecks()` renders the new names. Because `main` requires checks by name, the required-checks list is updated with `gh api` in the merge step of E-391 — the new names in, the old names out, in one call, right before the merge — and `.ai/DEVOPS.md` records it; a PR cannot otherwise go green. The same renderer change applies to the `team` profile and `rein ci hosted`.
10. **Windows (WSL2) leg** — E-392, after the tag, under `ci_gate`. The public profile gains `windows-latest × node 22 × 4 shards`, informative (not required) until three consecutive green runs on `main`, then required by the same `gh api` step and `.ai/DEVOPS.md` entry. The leg installs an Ubuntu 24.04 distribution with the setup-wsl action (SHA-pinned like every action, D-133 r3), WSL 2 where the hosted `windows-2022` image can start it — the action documents WSL 2 on that image; if the runner cannot, the leg runs WSL 1 and says so in its name and in the README, which then reads "a Windows (WSL) leg": WSL 1 and 2 share the userland Rein runs in, so the claim stays honest and weaker. Inside the distribution the leg copies the checkout to the Linux filesystem (`~/src`) before anything runs — the `/mnt/c` mount drops exec bits and symlinks and is slow — installs node 22, git, sqlite3, python3 and tmux, runs `bash install-rein.sh`, then `rein ci run --shard i/4` exactly as the Ubuntu legs do. The README's "planned" parenthesis goes when the leg is required.

### Alternatives considered
1. **A one-release `ai` forwarder** — offered, declined by the operator: nobody else runs Rein, and a forwarder keeps the old token alive in the gate's exempt lists and the classifier for a release.
2. **Keep the compatibility layer as built** (symlink, env fallback, sync rewrites, doctor lines) — declined by the operator: it existed to migrate other installs and projects without a manual step, and there are none; its ~60 files of logic and the `rename:legacy-fallback` exemptions are the only places the old name would survive.
3. **Keep the `ai-*` skill names** (D-132 r1: "the prefix is the command, not the brand") — reversed by the operator: with the command renamed the prefix no longer means anything.
4. **Rename `.ai/` as well** — declined again (D-132 alternative 2): no brand string, and every project directory would move.
5. **A Windows leg without WSL (PowerShell, Git Bash)** — rejected: the installer and hooks are bash and the README promises WSL2, not Windows-native.

### Impact
- Unlocks: E-391 (same PR as E-383, before `v0.4.0`), E-392 (after the tag), the classifier text v5.
- Risk if wrong: a rule keyed on the token `ai` that the rename misses stops matching `rein` and the gate fails open for that command — mitigated by the suites that assert `rein gate off` and the tamper paths are blocked after the rename (the existing gate suites, renamed in the same commit) and by the security_engineer review of the gate tables (E-391). Second risk: the operator's own projects break between the merge and their manual `rein sync` — accepted, it is one person and one afternoon.

### Rollback
Revert the PR before the tag; after `v0.4.0` a revert is a re-rename, not planned (as D-132). The required-checks list is restored by the same `gh api` call with the old names.

---
