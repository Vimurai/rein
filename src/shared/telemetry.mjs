#!/usr/bin/env node
// E-84: telemetry.mjs — fire-and-forget writer for ~/.ai-os/telemetry.sqlite.
//
// Stateless helper that records anonymized tool-invocation metadata into the
// global telemetry database described in .ai/blueprints/meta-cognition.md
// §Components 1 + §Data Model + §Security. Used by the mcp-telemetry interceptor
// (E-153) and the post-tool-use hook to capture { tool_name, execution_time_ms, status }
// without ever exposing project source, secrets, or absolute paths.
//
// Public API:
//   recordToolExecution({ project_root, session_id, tool_name,
//                         execution_time_ms, status })
//   recordTaskVelocity({ task_id, turn_count, tokens_consumed })
//   getTelemetryStats({ since_iso? })
//   resetTelemetryCache()   — test hook only; closes the cached handle.
//   TELEMETRY_DB_PATH       — the active store: AI_TELEMETRY_DB_PATH when set (E-257),
//                             else LIVE_TELEMETRY_DB_PATH (~/.ai-os/telemetry.sqlite).
//   resetTelemetryStore()   — operator-only: move the store to a dated .bak, recreate.
//   TELEMETRY_SERVICE       — service tag for structured logs.
//
// Privacy contract (blueprint §Security):
//   - project_root is hashed (sha256, 12 hex chars) before insertion. The
//     raw path NEVER reaches the DB.
//   - tool_name is the canonical "mcp__<server>__<tool>" identifier for MCP tools (built-ins
//     keep their bare name: "Bash", "Read") — no args, no payload bodies. canonicalToolName()
//     normalises at WRITE time (E-261).
//   - source records the emitting path: "hook" (post-tool-use.sh → --record-tool) or
//     "interceptor" (mcp-telemetry.mjs). NULL on rows written before E-261.
//   - session_id is sanitised by the same /^[A-Za-z0-9-]{1,64}$/ regex used
//     in approval-mcp (E-49 contract).
//   - Status is constrained to {"SUCCESS","ERROR","TIMEOUT","REJECTED"} (E-154/E-180).
//
// Failure mode:
//   - All write paths swallow exceptions (telemetry must NEVER break the
//     calling MCP). Errors emit a single NDJSON line to stderr and return.
//   - AI_TELEMETRY_DISABLE=1 short-circuits every write (rollback flag).
//
// Performance:
//   - DB handle cached at module scope. CREATE TABLE statements run once
//     on first use (IF NOT EXISTS, idempotent).
//   - Single INSERT per call. Budget: <5ms per call on warm cache.

import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, accessSync, renameSync, constants as fsConstants } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const TELEMETRY_SERVICE = "telemetry";
// The operator's store. Every consumer that means "the live store" names this one.
export const LIVE_TELEMETRY_DB_PATH = resolve(homedir(), ".ai-os", "telemetry.sqlite");

// E-257 (D-070 §1, test-harness-isolation.md §The Sixth Variety): AI_TELEMETRY_DB_PATH
// redirects EVERY writer in the process (this module, the mcp-telemetry interceptor that
// calls it, and the post-tool-use hook that pipes into its CLI) to another file. The test
// harness sets it to a per-run temp file so the suite stops being recorded as operator
// behaviour — 47,391 of 51,382 in-window rows were fixtures on 2026-09-11.
//
// The environment reaching this module is untrusted (E-223: a project's settings.json can
// supply it), so the override is accepted only in a narrow shape: an absolute path to a
// `*.sqlite` file whose directory ALREADY EXISTS. It never creates directories and never
// accepts a relative path; anything else falls back to the live store with one warning.
export function resolveTelemetryDbPath(env = process.env) {
  const raw = typeof env.AI_TELEMETRY_DB_PATH === "string" ? env.AI_TELEMETRY_DB_PATH.trim() : "";
  if (!raw) return LIVE_TELEMETRY_DB_PATH;
  // …and its REAL directory must sit under the temp dir or ~/.ai-os (critic_security P2,
  // E-257): anywhere else a hostile project env could point every hook's CREATE/INSERT at a
  // foreign database, e.g. another project's .ai/state.sqlite. Both sides are realpath'd
  // (macOS: /var → /private/var). The final component is not followed here; SQLite refuses
  // to write into a file that is not a database.
  const ok = raw.startsWith("/") && raw.endsWith(".sqlite") && !raw.includes("\0") &&
    (() => {
      try {
        const dir = realpathSync(dirname(resolve(raw)));
        // Fixed temp roots as well as tmpdir(): a server spawned with a hand-built env has
        // no TMPDIR, so tmpdir() says /tmp while the harness's store is under macOS's
        // per-user /var/folders — found by the live-store check (E-257).
        const roots = [tmpdir(), "/tmp", "/var/folders", resolve(homedir(), ".ai-os")]
          .map((r) => { try { return realpathSync(r); } catch { return null; } })
          .filter(Boolean);
        return roots.some((r) => dir === r || dir.startsWith(r + "/"));
      } catch { return false; }
    })();
  if (!ok) {
    process.stderr.write(JSON.stringify({
      timestamp: new Date().toISOString(), level: "warn", service: "telemetry",
      code: "telemetry-path-override-rejected",
      detail: "AI_TELEMETRY_DB_PATH must be an absolute *.sqlite path in an existing directory under the temp dir or ~/.ai-os — using the live store",
    }) + "\n");
    return LIVE_TELEMETRY_DB_PATH;
  }
  return resolve(raw);
}

export const TELEMETRY_DB_PATH = resolveTelemetryDbPath();

const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
// ── Telemetry status enum — SINGLE DRY SOURCE OF TRUTH (E-185) ───────────────────────────────
// E-154 (telemetry-hardening.md §Data Model): the status enum explicitly captures SUCCESS,
// ERROR, and TIMEOUT so the global interceptor (E-153) can record an accurate failure dimension
// (the INSIGHTS report found it was previously 100% SUCCESS).
// E-180 (D-049, meta-cognition.md §Data Model): + REJECTED — an EXPECTED rejection (bad input /
// not-found / schema-fail) that E-179 had folded into SUCCESS. Booking it as a distinct status
// restores usage-friction visibility for the meta_analyst WITHOUT re-polluting the ERROR
// (broken-tool) dimension.
// E-185 (flaw-remediation): STATUS_ORDER is the ONLY place the enum is written. The membership
// Set, the SQL CHECK clause (shared verbatim by the CREATE TABLE, the migration rebuild, and the
// orphan-merge coercion), and the migration sentinel are all DERIVED below — so growing the enum
// is a one-line edit here and the previously-coupled sites can never desync. ORDER MATTERS:
// append new statuses to the END so STATUS_MIGRATION_SENTINEL tracks the newest token.
// E-291 (D-083 r7): + BYPASS — a tool call the pre-tool-use gate let through ONLY because an
// operator override (~/.ai-os/gate-override.json) was active. Neither success nor failure of the
// tool: an audit row, kept out of every error-rate denominator (those name their statuses).
export const STATUS_ORDER = ["SUCCESS", "ERROR", "TIMEOUT", "REJECTED", "BYPASS"];
// Membership test for the writer's input validation.
export const STATUS_VALUES = new Set(STATUS_ORDER);
// SQL predicate `status IN ('SUCCESS',…,'BYPASS')` — embedded verbatim in the
// CREATE TABLE CHECK, the migration-rebuild CHECK, and the orphan-merge CASE WHEN coercion.
export const STATUS_SQL_IN = `status IN (${STATUS_ORDER.map((s) => `'${s}'`).join(",")})`;
// Migration sentinel: the NEWEST token. A stored DDL lacking it predates the current enum and is
// rebuilt — so this one check covers every hop (a 2-value DB jumps straight to the full schema).
export const STATUS_MIGRATION_SENTINEL = STATUS_ORDER[STATUS_ORDER.length - 1];

// ── E-261 (D-070 §5, meta-cognition.md §Telemetry Provenance): one tool, one name ────────────
// The store split one tool in two: the retired mcp-router wrote `safe-exec-mcp.analyze_command`
// (782 rows, avg 149 ms through the proxy) beside the interceptor's
// `mcp__safe-exec-mcp__analyze_command` (2 ms in-process), so every per-tool aggregate halved
// the tool and compared timings from two different paths. The name is canonicalised HERE, at
// write time, so no emitter — present or future — can reintroduce the dotted form; `source`
// keeps the path distinguishable instead of the name.
export const SOURCE_ORDER = ["hook", "interceptor"];
export const SOURCE_VALUES = new Set(SOURCE_ORDER);
// NULL is allowed: rows written before E-261 have no source, and D-070 ruled out back-migration.
export const SOURCE_SQL_CHECK = `source IS NULL OR source IN (${SOURCE_ORDER.map((s) => `'${s}'`).join(",")})`;
// The columns every INSERT … SELECT names explicitly. Positional copies broke the moment the
// table gained a column; naming them keeps the E-154/E-180 rebuild valid across schema growth.
const TE_BASE_COLS = "id, project_hash, session_id, tool_name, execution_time_ms, status, timestamp";

// ── E-259 (D-077, meta-cognition.md §Task Velocity from the Transcript) ─────────────────────
// task_velocity is measured from the Claude Code transcript (src/shared/task-usage.mjs) and
// carries where the numbers came from. The four columns are additive and nullable; the rows
// written before them (all 0/0 — the token-budget store they read was never written) read NULL.
const VELOCITY_SOURCE_CHECK = "source IS NULL OR source IN ('transcript')";
export const VELOCITY_EXTRA_COLUMNS = [
  ["output_tokens", "INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0)"],
  ["cache_read_tokens", "INTEGER CHECK(cache_read_tokens IS NULL OR cache_read_tokens >= 0)"],
  ["source", `TEXT CHECK(${VELOCITY_SOURCE_CHECK})`],
  ["session_id", "TEXT"],
];

const MCP_CANONICAL_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
// `<server>.<tool>` — a server id (letters, digits, dashes) and a tool id, nothing else.
const MCP_DOTTED_RE = /^([A-Za-z0-9][A-Za-z0-9-]*)\.([A-Za-z0-9_-]+)$/;

/**
 * Canonical tool name: `mcp__<server>__<tool>` for MCP tools, the bare name for built-ins.
 * Accepts the dotted `<server>.<tool>` form and rewrites it; anything else is returned trimmed
 * and unchanged (a built-in, or a shape we do not recognise — never guessed at).
 */
export function canonicalToolName(name) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n || MCP_CANONICAL_RE.test(n)) return n;
  const m = MCP_DOTTED_RE.exec(n);
  return m ? `mcp__${m[1]}__${m[2]}` : n;
}

let _cachedDb = null;
// E-261 (db_architect P1): whether the cached connection's table is known to carry `source`.
// A busy ALTER (another server holding the write lock past busy_timeout) must not leave a
// long-running process inserting into a column that does not exist for the rest of its life;
// every open re-tries until this is true.
let _sourceReady = false;
let _velocityReady = false; // E-259: same contract for the task_velocity columns
let _cachedPath = null;

function _isDisabled() {
  return process.env.AI_TELEMETRY_DISABLE === "1";
}

function _logErr(code, detail) {
  process.stderr.write(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      service: TELEMETRY_SERVICE,
      code,
      detail,
    }) + "\n"
  );
}

function _hashProjectRoot(raw) {
  // Empty / non-string project_root → fixed "unknown" sentinel. We hash the
  // string regardless so the value space is uniform.
  const s = typeof raw === "string" && raw.length > 0 ? raw : "unknown";
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function _sanitiseSessionId(raw) {
  if (typeof raw !== "string") return "unknown";
  const trimmed = raw.trim();
  if (!trimmed) return "unknown";
  if (!SESSION_ID_RE.test(trimmed)) return "unknown";
  return trimmed;
}

function _ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// E-173 (June 2026 audit follow-up): preflight writability probe for telemetry.sqlite.
// If ~/.ai-os/ (or an already-existing telemetry.sqlite) is not writable — read-only
// mount, hostile perms, full/locked volume — emit ONE structured warning instead of
// letting DatabaseSync surface an opaque error deep inside a record() call. FAIL-OPEN:
// telemetry is best-effort instrumentation, so a non-writable path must NEVER block the
// host agent; this only improves the diagnostic and returns a boolean for the caller.
function _checkWritable(targetPath) {
  try {
    // Probe the db file itself if it exists (need W_OK to write rows), otherwise the
    // parent dir (need W_OK to create the file). _ensureDir() already tried to mkdir it.
    const probe = existsSync(targetPath) ? targetPath : dirname(targetPath);
    accessSync(probe, fsConstants.W_OK);
    return true;
  } catch (e) {
    _logErr("telemetry-db-not-writable", `${targetPath}: ${e.code || e.message}`);
    return false;
  }
}

function _hasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

// E-261: add `source` to a store created before it existed. Additive and nullable — old rows
// read NULL, nothing is rewritten. Every in-house MCP server opens this file, so two processes
// can race here; the loser's "duplicate column" is the winner's success. Returns whether the
// column is present afterwards; a failure (e.g. SQLITE_BUSY past busy_timeout) is logged and
// retried on the next open rather than cached (db_architect P1). `inTxn` rethrows instead, so
// a caller inside BEGIN IMMEDIATE rolls back rather than committing a half-migrated table.
function _ensureSourceColumn(db, { inTxn = false } = {}) {
  try {
    if (_hasColumn(db, "tool_executions", "source")) return true;
    try {
      db.exec(`ALTER TABLE tool_executions ADD COLUMN source TEXT CHECK(${SOURCE_SQL_CHECK})`);
    } catch (e) {
      if (!/duplicate column/i.test(e.message)) throw e;
    }
    return true;
  } catch (e) {
    if (inTxn) throw e;
    _logErr("source-column-migration-failed", e.message);
    return false;
  }
}

// E-259: add the task_velocity columns to a store created before them — the E-261 pattern:
// additive, race-safe ("duplicate column" is the other process's success), retried on the
// next open when refused (a busy lock), never cached as done while one is missing.
function _ensureVelocityColumns(db) {
  try {
    for (const [name, decl] of VELOCITY_EXTRA_COLUMNS) {
      if (_hasColumn(db, "task_velocity", name)) continue;
      try { db.exec(`ALTER TABLE task_velocity ADD COLUMN ${name} ${decl}`); }
      catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
    }
    return true;
  } catch (e) {
    _logErr("velocity-column-migration-failed", e.message);
    return false;
  }
}

/**
 * E-259 down-migration (skill: ai-migration): drop the four task_velocity columns from the
 * store at `dbPath` (SQLite >= 3.35). Operator-only — stop the MCP servers first, or a
 * running one re-adds them on its next open. Returns { ok, dropped } and never throws.
 */
export function downTaskVelocityColumns(dbPath = TELEMETRY_DB_PATH) {
  const dropped = [];
  try {
    resetTelemetryCache();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const [name] of [...VELOCITY_EXTRA_COLUMNS].reverse()) {
        if (_hasColumn(db, "task_velocity", name)) {
          db.exec(`ALTER TABLE task_velocity DROP COLUMN ${name}`);
          dropped.push(name);
        }
      }
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
      throw e;
    } finally { db.close(); }
    return { ok: true, dropped };
  } catch (e) {
    return { ok: false, dropped: [], error: e.message };
  }
}

function _openDb(pathOverride) {
  // Path override exists so tests can point the helper at a sandbox file
  // without HOME hacks. Production callers leave pathOverride undefined
  // and the module-scope cache reuses one handle for the lifetime of the
  // process.
  const targetPath = pathOverride || TELEMETRY_DB_PATH;
  if (_cachedDb && _cachedPath === targetPath) {
    if (!_sourceReady) _sourceReady = _ensureSourceColumn(_cachedDb);
    if (!_velocityReady) _velocityReady = _ensureVelocityColumns(_cachedDb);
    return _cachedDb;
  }
  if (_cachedDb && _cachedPath !== targetPath) {
    try { _cachedDb.close(); } catch { /* ignore */ }
    _cachedDb = null;
    _cachedPath = null;
    _sourceReady = false;
    _velocityReady = false;
  }
  // E-173: best-effort dir creation + writability preflight. Both are FAIL-OPEN — a
  // read-only/unwritable path logs a clear warning but does not throw here; the
  // DatabaseSync open below is already wrapped by every caller's try/catch.
  try { _ensureDir(targetPath); } catch (e) { _logErr("telemetry-dir-create-failed", e.message); }
  _checkWritable(targetPath);
  const db = new DatabaseSync(targetPath);
  // E-153/E-154 (Tier-3 review): WAL + busy_timeout (matching state-db.js) so the now-23
  // in-house MCP servers writing this single shared DB don't serialise on a global lock or
  // hit SQLITE_BUSY — which also de-risks the migration window below. NORMAL sync keeps the
  // off-hot-path deferred write cheap. Best-effort: a pragma failure must not break telemetry.
  try { db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;"); } catch { /* pragma best-effort */ }
  // Per blueprint §Components 1 — two tables, idempotent CREATE.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_executions (
      id TEXT PRIMARY KEY,
      project_hash TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      execution_time_ms INTEGER NOT NULL CHECK(execution_time_ms >= 0),
      status TEXT NOT NULL CHECK(${STATUS_SQL_IN}),
      timestamp TEXT NOT NULL,
      source TEXT CHECK(${SOURCE_SQL_CHECK})
    );
    CREATE TABLE IF NOT EXISTS task_velocity (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      turn_count INTEGER NOT NULL CHECK(turn_count >= 0),
      tokens_consumed INTEGER NOT NULL CHECK(tokens_consumed >= 0),
      timestamp TEXT NOT NULL,
      output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
      cache_read_tokens INTEGER CHECK(cache_read_tokens IS NULL OR cache_read_tokens >= 0),
      source TEXT CHECK(${VELOCITY_SOURCE_CHECK}),
      session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_executions_timestamp
      ON tool_executions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_task_velocity_timestamp
      ON task_velocity(timestamp);
  `);
  // E-154/E-180 migration → newest-enum-capable schema. Existing DBs carry an older CHECK
  // (2-value SUCCESS/ERROR pre-E-154, or 3-value +TIMEOUT pre-E-180), which `CREATE TABLE IF
  // NOT EXISTS` cannot update — a REJECTED (or TIMEOUT) insert would fail the stale CHECK.
  // The detector keys on the NEWEST status token ('REJECTED'): any DDL lacking it predates the
  // current enum and is rebuilt, so this one block covers both the +TIMEOUT and the +REJECTED
  // hops (a 2-value DB jumps straight to the 4-value schema). The sentinel is DERIVED from
  // STATUS_ORDER (E-185), so appending a new enum value updates the detector automatically.
  // ATOMICITY (Tier-3 review P1): db.exec() autocommits PER statement, so a crash AFTER the
  // RENAME would strand rows in _tool_executions_old while the leading CREATE IF NOT EXISTS
  // resurrects an empty table the guard then reads as already-migrated → silent data loss.
  // Fixes: (a) the whole migration runs inside BEGIN IMMEDIATE/COMMIT so a mid-sequence failure
  // rolls the RENAME back atomically; (b) any _tool_executions_old stranded by a crash under the
  // OLD (pre-fix) code is recovered and merged back. Idempotent + fail-open.
  try {
    const orphan = db.prepare(
      "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='_tool_executions_old'"
    ).get();
    const meta = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='tool_executions'"
    ).get();
    const ddl = meta && typeof meta.sql === "string" ? meta.sql : "";
    const needsMigration = ddl && !ddl.includes(STATUS_MIGRATION_SENTINEL);
    if (orphan || needsMigration) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (orphan) {
          // Prior crash left rows behind in _tool_executions_old. Merge them back into the live
          // table (coerce any unknown status to ERROR so the CHECK accepts them; dedupe by PK),
          // then drop the orphan. The live table may be the empty one the leading CREATE IF NOT
          // EXISTS just made, OR a pre-existing table that still carries a STALE CHECK — the
          // rebuild below handles the latter, so this merge never assumes a fresh 4-value table.
          // E-261: carry `source` when both sides have it (db_architect P2) — a stranded table
          // written by E-261+ code holds values a positional or base-column copy would null.
          _ensureSourceColumn(db, { inTxn: true });
          const src = _hasColumn(db, "_tool_executions_old", "source") ? ", source" : "";
          db.exec(
            `INSERT OR IGNORE INTO tool_executions (${TE_BASE_COLS}${src}) ` +
            "SELECT id, project_hash, session_id, tool_name, execution_time_ms, " +
            `CASE WHEN ${STATUS_SQL_IN} THEN status ELSE 'ERROR' END, timestamp${src} ` +
            "FROM _tool_executions_old; " +
            "DROP TABLE _tool_executions_old;"
          );
        }
        // E-180 (db_architect P1): orphan-recovery and CHECK-migration are NOT mutually exclusive.
        // A crashed DB can carry BOTH a stranded orphan AND a live table whose CHECK predates the
        // current enum; the old `if/else` ran only the merge, leaving the stale CHECK in place so
        // the triggering REJECTED insert failed it and was dropped until the next open self-healed.
        // Run the rebuild whenever the live DDL lacks the newest token — after any orphan merge,
        // inside this same transaction. `needsMigration` was read from the live table's DDL, which
        // the orphan merge only inserts rows into (never alters its schema), so it still reflects
        // CHECK-staleness here. The full-table rebuild holds the write lock for the row copy, so its
        // cost scales with telemetry.sqlite size — acceptable as a one-time, fail-open migration.
        if (needsMigration) {
          // E-261 (db_architect P2): the rebuilt table carries `source` from the start, inside
          // this transaction, so no other writer ever sees a table without it; and a table
          // that already holds `source` values keeps them across the next enum hop.
          const src = _hasColumn(db, "tool_executions", "source") ? ", source" : "";
          db.exec(
            "ALTER TABLE tool_executions RENAME TO _tool_executions_old; " +
            "CREATE TABLE tool_executions (" +
            "id TEXT PRIMARY KEY, project_hash TEXT NOT NULL, session_id TEXT NOT NULL, " +
            "tool_name TEXT NOT NULL, execution_time_ms INTEGER NOT NULL CHECK(execution_time_ms >= 0), " +
            `status TEXT NOT NULL CHECK(${STATUS_SQL_IN}), timestamp TEXT NOT NULL, ` +
            `source TEXT CHECK(${SOURCE_SQL_CHECK})); ` +
            `INSERT INTO tool_executions (${TE_BASE_COLS}${src}) ` +
            `SELECT ${TE_BASE_COLS}${src} FROM _tool_executions_old; ` +
            "DROP TABLE _tool_executions_old; " +
            "CREATE INDEX IF NOT EXISTS idx_tool_executions_timestamp ON tool_executions(timestamp);"
          );
        }
        db.exec("COMMIT");
      } catch (inner) {
        try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
        throw inner;
      }
    }
  } catch (e) {
    _logErr("status-enum-migration-failed", e.message);
  }
  _sourceReady = _ensureSourceColumn(db);
  _velocityReady = _ensureVelocityColumns(db);
  _cachedDb = db;
  _cachedPath = targetPath;
  return db;
}

function _doRecordToolExecution(payload, opts) {
  if (_isDisabled()) return;
  const tool_name = canonicalToolName(payload?.tool_name);
  if (!tool_name) { _logErr("missing-tool-name", null); return; }
  const source = SOURCE_VALUES.has(payload?.source) ? payload.source : null;
  const exec_ms = Number.isFinite(payload?.execution_time_ms)
    ? Math.max(0, Math.floor(payload.execution_time_ms))
    : 0;
  const status = STATUS_VALUES.has(payload?.status) ? payload.status : "SUCCESS";
  const project_hash = _hashProjectRoot(payload?.project_root);
  const session_id = _sanitiseSessionId(payload?.session_id);

  try {
    const db = _openDb(opts?.db_path);
    const row = [randomUUID(), project_hash, session_id, tool_name, exec_ms, status, new Date().toISOString()];
    if (_sourceReady) {
      db.prepare(`INSERT INTO tool_executions (${TE_BASE_COLS}, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...row, source);
    } else {
      // The ALTER has not succeeded yet (retried on the next open). Keep the row, lose only
      // its provenance — a missing row would skew every count; a NULL source skews nothing.
      db.prepare(`INSERT INTO tool_executions (${TE_BASE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(...row);
    }
  } catch (e) {
    _logErr("insert-tool-execution-failed", e.message);
  }
}

function _doRecordTaskVelocity(payload, opts) {
  if (_isDisabled()) return;
  const task_id = typeof payload?.task_id === "string" ? payload.task_id.trim() : "";
  if (!task_id) { _logErr("missing-task-id", null); return; }
  const turn_count = Number.isFinite(payload?.turn_count)
    ? Math.max(0, Math.floor(payload.turn_count))
    : 0;
  const tokens_consumed = Number.isFinite(payload?.tokens_consumed)
    ? Math.max(0, Math.floor(payload.tokens_consumed))
    : 0;
  const _opt = (v) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : null);
  const output_tokens = _opt(payload?.output_tokens);
  const cache_read_tokens = _opt(payload?.cache_read_tokens);
  // E-259 (D-077): a row whose counters are all zero measured nothing — it is NOT written.
  // Absence means "unmeasured"; 1,729 zero rows taught the aggregate nothing but a false 0.
  if (turn_count === 0 && tokens_consumed === 0 && !cache_read_tokens) {
    _logErr("zero-task-velocity-refused", "turn_count, tokens_consumed and cache_read_tokens are all 0");
    return;
  }
  const source = payload?.source === "transcript" ? "transcript" : null;
  const session_id = typeof payload?.session_id === "string" && SESSION_ID_RE.test(payload.session_id)
    ? payload.session_id : null;

  try {
    const db = _openDb(opts?.db_path);
    const row = [randomUUID(), task_id, turn_count, tokens_consumed, new Date().toISOString()];
    if (_velocityReady) {
      db.prepare(
        "INSERT INTO task_velocity (id, task_id, turn_count, tokens_consumed, timestamp, " +
        "output_tokens, cache_read_tokens, source, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(...row, output_tokens, cache_read_tokens, source, session_id);
    } else {
      // Columns not there yet (retried on the next open): keep the measurement, lose the extras.
      db.prepare(
        "INSERT INTO task_velocity (id, task_id, turn_count, tokens_consumed, timestamp) VALUES (?, ?, ?, ?, ?)"
      ).run(...row);
    }
  } catch (e) {
    _logErr("insert-task-velocity-failed", e.message);
  }
}

// Public entry — fire-and-forget. The wrapper defers the actual sync write
// to the next macrotask so the calling MCP returns its response immediately.
// All errors are swallowed inside _doRecord*.
export function recordToolExecution(payload, opts) {
  if (_isDisabled()) return;
  if (opts?.sync === true) {
    _doRecordToolExecution(payload, opts);
    return;
  }
  setImmediate(() => _doRecordToolExecution(payload, opts));
}

export function recordTaskVelocity(payload, opts) {
  if (_isDisabled()) return;
  if (opts?.sync === true) {
    _doRecordTaskVelocity(payload, opts);
    return;
  }
  setImmediate(() => _doRecordTaskVelocity(payload, opts));
}

// Read-side: SQL aggregates for the meta_analyst agent (E-85) and the
// ai-preflight staleness check (E-86). Returns counts + last-write
// timestamps. Bounded by the optional `since_iso` window.
export function getTelemetryStats(opts = {}) {
  const path = opts.db_path || TELEMETRY_DB_PATH;
  if (!existsSync(path)) {
    return {
      status: "EMPTY",
      tool_executions: { count: 0, last_ts: null },
      task_velocity:   { count: 0, last_ts: null },
    };
  }
  try {
    const db = _openDb(path);
    const sinceClause = typeof opts.since_iso === "string"
      ? "WHERE timestamp >= ?"
      : "";
    const params = typeof opts.since_iso === "string" ? [opts.since_iso] : [];

    const teRow = db
      .prepare(`SELECT COUNT(*) AS c, MAX(timestamp) AS ts FROM tool_executions ${sinceClause}`)
      .get(...params);
    const tvRow = db
      .prepare(`SELECT COUNT(*) AS c, MAX(timestamp) AS ts FROM task_velocity ${sinceClause}`)
      .get(...params);
    return {
      status: "OK",
      tool_executions: { count: teRow?.c ?? 0, last_ts: teRow?.ts || null },
      task_velocity:   { count: tvRow?.c ?? 0, last_ts: tvRow?.ts || null },
    };
  } catch (e) {
    return {
      status: "READ_ERROR",
      error: e.message,
      tool_executions: { count: 0, last_ts: null },
      task_velocity:   { count: 0, last_ts: null },
    };
  }
}

// E-257 (D-070 §1): the operator's one-time reset. The store accumulated months of test
// fixtures (8% real traffic in the window measured) and D-070 ruled out a heuristic
// migration: the store is MOVED aside with a dated name and recreated empty. Never called
// automatically — only by `telemetry.mjs --reset --backup`.
//
// Running MCP servers keep a cached handle to the old file (now the .bak) until they
// restart, so their rows land in the backup — the CLI says so.
//
// @returns {{ok:true, backup:string|null, path:string} | {ok:false, error:string}}
// The default is the LIVE store, never the env override (critic_security P2): an operator
// running the reset inside a session whose env redirects telemetry must not move aside
// whatever file that variable names.
export function resetTelemetryStore({ path = LIVE_TELEMETRY_DB_PATH, now = new Date() } = {}) {
  try {
    resetTelemetryCache();
    let backup = null;
    if (existsSync(path)) {
      // Fold the WAL into the main file first so the backup is complete on its own.
      try {
        const db = new DatabaseSync(path);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
        db.close();
      } catch (e) {
        return { ok: false, error: `cannot checkpoint ${path}: ${e.message} — nothing was moved` };
      }
      const day = now.toISOString().slice(0, 10);
      backup = `${path}.${day}.bak`;
      for (let n = 1; existsSync(backup); n++) backup = `${path}.${day}.${n}.bak`;
      renameSync(path, backup);
      // A WAL left beside the new store could be replayed INTO it (a writer that appended
      // after the checkpoint): if it cannot be moved with the backup, undo and abort.
      if (existsSync(path + "-wal")) {
        try { renameSync(path + "-wal", backup + "-wal"); }
        catch (e) {
          try { renameSync(backup, path); } catch { /* reported below */ }
          return { ok: false, error: `cannot move ${path}-wal (${e.message}) — reset undone, nothing changed` };
        }
      }
      if (existsSync(path + "-shm")) { try { renameSync(path + "-shm", backup + "-shm"); } catch { /* shm is rebuilt */ } }
    }
    _openDb(path);                         // recreates the schema (idempotent CREATE)
    resetTelemetryCache();
    return { ok: true, backup, path };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Test-only hook. Closes the cached handle and forces the next call to
// re-open against a (possibly different) path.
export function resetTelemetryCache() {
  if (_cachedDb) {
    try { _cachedDb.close(); } catch { /* ignore */ }
  }
  _cachedDb = null;
  _cachedPath = null;
  _sourceReady = false;
  _velocityReady = false;
}

// Pure-node project-root resolver — walks parents looking for a .git entry.
// Used by --record-tool / --record-task so the hook layer (E-105) can pipe
// raw tool JSON without pre-computing the project root. Capped at 32 hops
// so a malformed path can't loop. Returns startDir on miss; the hasher
// then maps every non-repo cwd to a stable "no-git" bucket per directory.
function _findProjectRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 32; i++) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

async function _readStdinJson() {
  try {
    let buf = "";
    for await (const chunk of process.stdin) buf += chunk;
    const trimmed = buf.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (e) {
    _logErr("stdin-parse-failed", e.message);
    return null;
  }
}

// CLI smoke for sysadmins and hook callers.
//   --stats         → JSON envelope of getTelemetryStats() (read-side).
//   --path          → the active TELEMETRY_DB_PATH (honours AI_TELEMETRY_DB_PATH).
//   --reset --backup → operator-only (E-257): move the store to <path>.<date>.bak and
//                     recreate it empty.
//   --record-tool   → consume one tool execution from stdin JSON
//                     ({tool_name, execution_time_ms, status, ...}) and
//                     write a tool_executions row. Used by E-105
//                     post-tool-use.sh to capture every Claude Code tool
//                     invocation (built-ins; the interceptor owns mcp__*).
//   --record-task   → consume one task velocity event from stdin JSON
//                     ({task_id, turn_count, tokens_consumed}) and write
//                     a task_velocity row (none when every counter is 0 — E-259).
//                     The measured path is task-usage.mjs --record (D-077).
// Both record subcommands exit 0 on every path (fail-open per blueprint
// §Security). project_hash is derived from process.cwd() walked up to
// .git; session_id is read from CLAUDE_CODE_SESSION_ID (E-49 contract).
async function _runCli() {
  const argv = process.argv.slice(2);
  if (argv.includes("--stats")) {
    process.stdout.write(JSON.stringify(getTelemetryStats(), null, 2) + "\n");
    return;
  }
  if (argv.includes("--path")) {
    process.stdout.write(TELEMETRY_DB_PATH + "\n");
    return;
  }
  if (argv.includes("--reset")) {
    // Both flags, on purpose: a reset that could run without saying "backup" would be one
    // mistyped hook argument away from an unrecoverable delete.
    if (!argv.includes("--backup")) {
      process.stderr.write("telemetry --reset requires --backup (the store is moved aside, never deleted)\n");
      process.exit(2);
    }
    const r = resetTelemetryStore();
    if (!r.ok) { process.stderr.write(`telemetry --reset: ${r.error}\n`); process.exit(1); }
    process.stdout.write(
      (r.backup ? `moved ${r.path} → ${r.backup}\n` : `no store at ${r.path} — nothing to back up\n`) +
      `recreated an empty store at ${r.path}\n` +
      "Restart the MCP servers (or the sessions): running servers keep writing to the backup until they do.\n");
    return;
  }
  if (argv.includes("--record-tool")) {
    const payload = await _readStdinJson();
    if (payload && typeof payload === "object") {
      const project_root = _findProjectRoot(process.cwd());
      const session_id = process.env.CLAUDE_CODE_SESSION_ID || "unknown";
      recordToolExecution({
        project_root,
        session_id,
        tool_name: payload.tool_name,
        execution_time_ms: payload.execution_time_ms,
        status: payload.status,
        // The CLI is the hook's path (post-tool-use.sh pipes into it); an explicit, valid
        // source in the payload wins so another caller can say what it is.
        source: SOURCE_VALUES.has(payload.source) ? payload.source : "hook",
      }, { sync: true });
    }
    return;
  }
  if (argv.includes("--record-task")) {
    const payload = await _readStdinJson();
    if (payload && typeof payload === "object") {
      recordTaskVelocity({
        task_id: payload.task_id,
        turn_count: payload.turn_count,
        tokens_consumed: payload.tokens_consumed,
      }, { sync: true });
    }
    return;
  }
  process.stderr.write(
    "usage: telemetry.mjs [--stats | --path | --record-tool | --record-task | --reset --backup]\n"
  );
  process.exit(2);
}

// _isMain compares resolved real paths because macOS routes ${TMPDIR} (and
// any mktemp -d sandbox) through /var → /private/var symlinks. The naive
// `import.meta.url === file://${process.argv[1]}` check fails there — the
// CLI silently no-ops, with no way to detect the misfire. realpathSync on
// both sides normalises the comparison; missing argv[1] or unreadable paths
// fall through to false.
function _detectMain() {
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    const argv = process.argv[1] ? realpathSync(process.argv[1]) : "";
    return argv === here;
  } catch {
    return false;
  }
}

if (_detectMain()) {
  _runCli().catch((e) => {
    process.stderr.write(`telemetry crashed: ${e.message}\n`);
    process.exit(1);
  });
}
