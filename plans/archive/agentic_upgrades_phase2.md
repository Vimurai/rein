# Plan: Agentic Upgrades Phase 2 — Architectural Design

## Overview
This plan defines the architectural specifications for Token Budgeting, GitHub Integration, and JIT Skill Loading (Tasks P-57, P-58, P-59).

## 1. Token Budget MCP (`token-budget-mcp`)
- **Location**: `src/mcp/token-budget-mcp/`
- **Engine**: Node.js + `better-sqlite3`.
- **Logic**:
    - Centralized SQLite database in `~/.ai-os/usage.sqlite` to track cross-project spend.
    - `report_usage` tool: Must be idempotent; called by `stop-hook.sh` after every agent turn.
    - `get_budget_status` tool: Used by Gemini Architect during the Strategy phase to decide if a "Low-Context" or "High-Context" approach is required.

## 2. GitHub Bridge MCP (`github-bridge-mcp`)
- **Location**: `src/mcp/github-bridge-mcp/`
- **Engine**: Node.js wrapping `gh` CLI commands.
- **Security**: Relies on the user's existing `gh` authentication; does not store its own tokens.
- **Logic**:
    - `sync_issue` tool: Downloads an issue and its comments, then uses `intent-refiner-mcp` logic to populate `UPDATE.md`.

## 3. JIT Skill Loading (Skill 2.1)
- **Target**: `src/mcp/context-invoker-mcp/index.js`
- **Update**:
    - Add `list_skills_metadata()`: Returns an array of `{ name, description, tools }` extracted from all `SKILL.md` files in `SKILL_ROOTS`.
    - Modify `activate_skill()`: Optimize for sequential loading.
- **Token Efficiency**: Reduces the "Pre-Turn" context size by ~1.5k tokens per session.

## Implementation Tasks (Engineer - Claude)
- **E-140**: Implement `token-budget-mcp` and initialize `usage.sqlite`.
- **E-141**: Implement `github-bridge-mcp` and `ai sync --github` bash integration.
- **E-142**: Refactor `context-invoker-mcp` to support Level 2 (Metadata) discovery.
