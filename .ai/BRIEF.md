# BRIEF (Living product brief)

## Product Summary
- **What is this?** AI-OS is an autonomous operating system for AI coding agents. It coordinates a strict Triad — Architect (Gemini 3.1 Pro), Engineer (Claude Opus 4.7), and Tester (TestSprite) — through a shared, ACID-backed `.ai/` memory layer, 25 MCP servers, RBAC-gated skills, and JIT context caching.
- **Who is it for?** Developers shipping non-trivial software with LLM assistance who need (1) deterministic agent role separation, (2) full audit trail of decisions/stamps, and (3) safety gates that survive context loss. Not a chatbot, not a copilot — an opinionated framework that imposes structure on multi-agent workflows.
- **What problem does it solve?** Single-agent coding loops drift, hallucinate tool names, leak secrets, and forget across sessions. AI-OS enforces blueprint-first design (Architect writes blueprints → Engineer implements → Tester verifies), pins state to a SQLite-backed WAL, and re-injects context on every preflight so context bloat does not erase prior decisions.

## Goals
- Make agent coordination explicit and auditable: every E-##/P-## task lives in state.sqlite, every commit carries a `[CRITIC]` stamp.
- Token economy by construction: DIGEST-first reads, mtime-invalidated context cache, no full-file dumps when a summary suffices.
- Fail-closed safety boundaries: sandboxed code execution, scope-gated filesystem, RBAC on tool access, HITL approvals for Tier 3.
- Drop-in installer (`./install-ai-os.sh` → ~/.ai-os/) that works across any project via `ai init`.

## Non-goals
- Not a foundation-model trainer or fine-tuning platform.
- Not a replacement for the host IDE — AI-OS layers onto Claude Code / Gemini CLI, it does not fork them.
- Not multi-tenant or cloud-hosted; designed for a single developer machine plus optional managed-agents API offload.

## Constraints
- Security: capability boundaries declared in CAPABILITIES.md; secrets never persisted to state.json; code execution constrained to Docker sandbox (network=none, read-only, cap-drop=ALL).
- Performance: preflight under 200ms cold; WAL checkpoint under 100ms via node:sqlite; aggregator pass over incidents.ndjson under 50ms for 100 records.
- Compliance: no GDPR-relevant PII ever written to `.ai/`; PII sanitiser strips emails/tokens/HOME paths from incident logs.
- Deployment: macOS + Linux dev boxes (Node 22+, Docker for code-exec); Windows unsupported.

## UX Notes (Gemini via /gemini skill)
- Target platforms: terminal-first (Claude Code, Gemini CLI, tmux split-pane).
- Key flows: `ai init` → blueprint authoring (Architect) → implementation (Engineer) → critic review → commit gate.
- Accessibility: structured Markdown outputs, NDJSON logs, no ANSI escape dependence on critical paths.
- Performance budgets (frontend): n/a — no GUI; CLI output budget ~80 cols / response.

## SEO/Content Notes (Gemini via /gemini skill)
- Target queries: "autonomous AI agent OS", "Claude Gemini coordination framework", "MCP server template".
- Information architecture: README → install → quickstart → blueprints → MCP registry (`.ai/blueprints/mcp.md` auto-generated).
- Content types: blueprints, decisions log, RULES/CAPABILITIES contracts, test reports.
- Schema/structured data: state.json schema versioned; NDJSON for all telemetry.

## Frontend Notes (Gemini via /gemini skill)
- Framework: none (CLI tool).
- State approach: SQLite (WAL) authoritative + JSON projections for Markdown rendering.
- Routing: skills addressed by name (`skill: ai-preflight`); MCP tools by qualified path (`mcp__server__tool`).
- UI patterns: deterministic Markdown blocks, structured-output JSON tails (`__SYNC_RESULT__`, `__INCIDENT_REPORT__`) for programmatic consumers.

## Architecture Notes (Claude-owned)
- Modules/boundaries: `src/mcp/` (25 servers), `src/shared/` (libs: logger, wal-flusher, incident-append/aggregate), `src/bin/ai` (bootloader CLI), `src/claude/` + `src/gemini/` + `src/shared/skills/` (agent skills).
- Data model: `.ai/state.sqlite` (tasks/stamps/deltas), `.ai/state.json` (regenerated projection), `.ai/TASKS.md` + `.ai/REVIEWS.md` (human-rendered views), `~/.ai-os/incidents.ndjson` (rolling telemetry).
- Integration points: stdio JSON-RPC to MCP servers, NDJSON to stderr for logs, Docker socket-less for code-exec, fetch() to managed-agents API (optional, E-70).
- API contracts (high level): MCP tool schemas in each server, registry.json as single source of truth, mcp.md auto-derived.

## Security/DevOps Notes (Claude-owned)
- Threat model: prompt injection (mitigated by capability gates), secret exfiltration (sanitisers + capability-bypass gate in aligner), supply-chain (dependency_gate skill before any npm install).
- Secrets: env-only — `AI_MANAGED_AGENT_KEY`, `CLAUDE_CODE_SESSION_ID`, never written to state.json. Aligner CI gate blocks accidental commits.
- CI/CD: pre-commit hooks (~/.ai-os/hooks/pre-commit.sh) run MCP stdout purity check + blueprint aligner + test suite; behavioral tests over stdio JSON-RPC.
- Observability: NDJSON structured logs (service=<name>), incident aggregator with stack-signature grouping (E-66/E-67), token-budget-mcp for cost tracking.
