# Blueprint: SQLite WAL Checkpoint Node.js Migration

## Goal & Architecture
Replace the `sqlite3` bash binary dependency in `bin/ai` with a deterministic `node:sqlite` helper script. This guarantees WAL checkpoints succeed across all environments (preventing silent DB bloat), as Node.js 22+ is a hard requirement for AI-OS.

## Core Concept
Currently, `_wal_checkpoint_state_db()` in `bin/ai` uses `command -v sqlite3` (E-53), failing open if the binary is missing. We will migrate this to a stateless Node.js script using the built-in `node:sqlite` module.

## Components
1. **wal-flusher.mjs**: A minimal `src/shared/wal-flusher.mjs` script that opens the DB and executes `PRAGMA wal_checkpoint(TRUNCATE)`.
2. **bin/ai hook**: The bash hook in `src/bin/ai` will invoke `node src/shared/wal-flusher.mjs ~/.ai-os/state.sqlite` instead of the sqlite3 CLI.

## Data Model
- Stateless execution against the existing `state.sqlite` database.

## API / Interface Contracts
- `wal-flusher.mjs <db-path>`
- Exit `0`: Checkpoint successful.
- Exit `1`: Error (logs to stderr).

## Security
- DB path must be validated to prevent arbitrary file truncation.
- No new npm packages required (`node:sqlite` is core).

## Execution Constraints
- Must boot and execute in < 50ms to avoid slowing down `ai sync`.

## Rollback Plan
- Revert `src/bin/ai` to use the legacy bash `sqlite3` fallback hook.

## E-## Task Breakdown
- E-57: Create `src/shared/wal-flusher.mjs` using `node:sqlite` to execute the TRUNCATE pragma.
- E-58: Update `src/bin/ai`'s `_wal_checkpoint_state_db` to invoke the Node script instead of the bash binary.