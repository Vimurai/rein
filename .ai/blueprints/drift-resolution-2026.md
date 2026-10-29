---
type: blueprint
tier: 2
tags: [architecture, sqlite, documentation, drift]
---
# Blueprint: Drift Resolution & Debt Retirement

## Goal & Architecture
To eliminate documentation drift in our MCP Nervous System definitions and resolve latent state fragmentation (SQLite WAL bloat) identified during the May 2026 reviews.

## Core Concept
1. **Auto-Generated Documentation (P-31):** The `.ai/blueprints/mcp.md` file will no longer be edited manually. It will be generated natively from `src/config/registry.json` by a new script invoked during `ai sync`.
2. **State Singularity (P-34 Rule):** We will **not** retire `.ai/state.sqlite` in favor of pure JSON. The ACID properties are essential. Instead, we mandate a `PRAGMA wal_checkpoint(TRUNCATE)` hook inside `ai sync` to periodically flush the WAL back to the main DB, preventing unbounded `.sqlite-wal` growth.

## Components
1. **MCP Registry Generator (`scripts/generate_mcp_docs.js`)**
   - **Responsibility:** Reads `src/config/registry.json`. Iterates over domains. Emits Markdown grouped by domain (e.g., `## State`, `## Code`) listing server names and capabilities. Writes to `.ai/blueprints/mcp.md`.
2. **Compliance Verification CI (`tests/suites/mcp_doc_sync_test.sh`)**
   - **Responsibility:** A new CI check that runs the generator script to memory and diffs it against the committed `.ai/blueprints/mcp.md`. Fails if they differ (enforcing the auto-generation contract).
3. **SQLite WAL Checkpoint Hook (`bin/ai`)**
   - **Responsibility:** Modifies the `do_sync()` and `do_doctor()` bash functions to natively execute `sqlite3 .ai/state.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"` to force-flush pending writes.

## Data Model
*(No new data models. Derives from existing `registry.json` schema).*

## API / Interface Contracts
- **Generator Execution:** Called silently via `node scripts/generate_mcp_docs.js` at the end of the `install_git_hooks` / `do_sync` lifecycle.
- **SQLite Pragma:** `sqlite3 .ai/state.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"`

## Security
- **Trust Boundaries:** The SQLite pragma execution operates strictly on `.ai/state.sqlite` and must not accept arbitrary file paths from user input.
- **Threat Surface:** A malformed `registry.json` could cause the documentation generator to crash during a bootloader step. Ensure `try/catch` wrapping and fail-open behavior (print warning, continue sync) in the generator script.

## Execution Constraints
- **Performance:** `PRAGMA wal_checkpoint` blocks concurrent writers briefly. Ensure it is executed outside of the critical path of JIT agent reads.
- **Rollback Plan:** If the auto-generator fails edge cases, revert to manual edits and document the manual process in `mcp.md`. If WAL truncation causes DB lockouts, revert to default WAL behavior and track bloat limits manually.

## E-## Task Breakdown
- **E-52:** Implement MCP Registry Auto-Generation: Build `generate_mcp_docs.js`, wire it into `bin/ai`, and create `mcp_doc_sync_test.sh` per `drift-resolution-2026.md`. | Tier: 2
- **E-53:** Implement SQLite WAL Flush Hook: Add the `PRAGMA wal_checkpoint(TRUNCATE)` execution to `do_sync()` and `do_doctor()` inside `src/bin/ai` per `drift-resolution-2026.md`. | Tier: 1