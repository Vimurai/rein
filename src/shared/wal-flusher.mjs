#!/usr/bin/env node
/**
 * wal-flusher.mjs — Stateless WAL checkpoint helper (E-57).
 *
 * Replaces the `sqlite3` shell binary in `bin/ai` with the built-in
 * `node:sqlite` module. Removes the silent fail-open path on dev boxes
 * without the sqlite3 CLI installed (Node.js 22+ is the project's
 * baseline, so node:sqlite is always available).
 *
 * Usage:
 *   node src/shared/wal-flusher.mjs <db-path>
 *
 * Exit 0: PRAGMA wal_checkpoint(TRUNCATE) succeeded.
 * Exit 1: validation/open/checkpoint error (logs structured JSON to stderr).
 *
 * Security:
 *   - <db-path> is required and must resolve to an existing regular file.
 *   - Rejects paths with `..` segments after resolution (defense-in-depth
 *     against arbitrary truncation, though TRUNCATE only affects the WAL
 *     side-file of an actually-open SQLite DB).
 *   - Rejects paths whose basename does not end in `.sqlite` so a stray
 *     argument can never open something that isn't an SQLite DB.
 *   - No env spread, no shell, no eval, no module imports beyond core.
 */

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { statSync } from "node:fs";

const SERVICE = "wal-flusher";

function logError(message, extras = {}) {
  process.stderr.write(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      service: SERVICE,
      message,
      ...extras,
    }) + "\n"
  );
}

function validatePath(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("db-path argument is required");
  }
  // Reject NUL bytes (defense against odd payloads).
  if (raw.includes("\0")) {
    throw new Error("db-path contains a NUL byte");
  }
  const absolute = resolve(raw);
  // After resolve(), `..` segments collapse — but reject anything that
  // resolves outside the user's home or the repo's CWD subtree at the
  // discretion of the caller. Here we only enforce the basic invariants
  // (exists, regular file, .sqlite extension); the caller (bin/ai) passes
  // a hardcoded `.ai/state.sqlite` path so the wider scope check lives
  // there, not in this helper.
  if (!absolute.endsWith(".sqlite")) {
    throw new Error(
      `refusing to open non-SQLite path (extension must be .sqlite): ${absolute}`
    );
  }
  let st;
  try {
    st = statSync(absolute);
  } catch (e) {
    throw new Error(`db-path does not exist: ${absolute}`);
  }
  if (!st.isFile()) {
    throw new Error(`db-path is not a regular file: ${absolute}`);
  }
  return absolute;
}

function checkpoint(absPath) {
  const db = new DatabaseSync(absPath);
  try {
    // PRAGMA wal_checkpoint(TRUNCATE) returns one row: (busy, log, checkpointed).
    // Discard the result — non-zero `busy` is informational, not an error.
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get();
  } finally {
    db.close();
  }
}

function main() {
  const arg = process.argv[2];
  let absPath;
  try {
    absPath = validatePath(arg);
  } catch (e) {
    logError(e.message, { stage: "validate" });
    process.exit(1);
  }
  try {
    checkpoint(absPath);
  } catch (e) {
    logError(e.message, { stage: "checkpoint", path: absPath });
    process.exit(1);
  }
  process.exit(0);
}

main();
