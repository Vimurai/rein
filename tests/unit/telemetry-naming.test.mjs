// tests/unit/telemetry-naming.test.mjs — node:test unit suite for E-261 (D-070 §5,
// meta-cognition.md §Telemetry Provenance): one tool, one name; the emitting path in a
// `source` column; ISO-8601 'T' timestamps; the staleness probe counting tool rows only.
//
// Every test writes to its own temp store through `db_path`, never the operator's
// ~/.rein/telemetry.sqlite. Run standalone:
//   node --test tests/unit/telemetry-naming.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import {
  canonicalToolName, recordToolExecution, recordTaskVelocity, resetTelemetryCache, getTelemetryStats,
  SOURCE_ORDER, STATUS_SQL_IN,
} from "../../src/shared/telemetry.mjs";
import { withTelemetry } from "../../src/shared/mcp-telemetry.mjs";
import { checkInsightsStaleness } from "../../src/shared/insights-staleness.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const TELEMETRY_CLI = join(REPO, "src/shared/telemetry.mjs");

function store() {
  const d = mkdtempSync(join(tmpdir(), "rein-t-telname-"));
  const db = join(d, "telemetry.sqlite");
  return {
    d, db,
    rows: () => {
      resetTelemetryCache();
      const h = new DatabaseSync(db, { readOnly: true });
      try { return h.prepare("SELECT tool_name, source, timestamp FROM tool_executions ORDER BY rowid").all(); }
      finally { h.close(); }
    },
    done: () => { resetTelemetryCache(); rmSync(d, { recursive: true, force: true }); },
  };
}

const rec = (s, over = {}) => recordToolExecution(
  { tool_name: "Bash", execution_time_ms: 5, status: "SUCCESS", ...over },
  { sync: true, db_path: s.db });

// ── canonicalToolName ────────────────────────────────────────────────────────────────────
test("the dotted <server>.<tool> form becomes mcp__<server>__<tool>", () => {
  assert.equal(canonicalToolName("safe-exec-mcp.analyze_command"), "mcp__safe-exec-mcp__analyze_command");
  assert.equal(canonicalToolName("memory.read_graph"), "mcp__memory__read_graph");
  assert.equal(canonicalToolName("  srv.tool  "), "mcp__srv__tool");
});

test("the canonical form and built-in names pass through unchanged", () => {
  assert.equal(canonicalToolName("mcp__safe-exec-mcp__analyze_command"), "mcp__safe-exec-mcp__analyze_command");
  for (const b of ["Bash", "Read", "Edit", "WebFetch"]) assert.equal(canonicalToolName(b), b);
});

test("shapes that are not one server and one tool are never guessed at", () => {
  assert.equal(canonicalToolName("a.b.c"), "a.b.c");
  assert.equal(canonicalToolName(".tool"), ".tool");
  assert.equal(canonicalToolName("srv."), "srv.");
  assert.equal(canonicalToolName(""), "");
  assert.equal(canonicalToolName(undefined), "");
});

// ── the writer ───────────────────────────────────────────────────────────────────────────
test("a dotted name is stored canonical, so one tool is one row group", () => {
  const s = store();
  try {
    rec(s, { tool_name: "safe-exec-mcp.analyze_command", source: "hook" });
    rec(s, { tool_name: "mcp__safe-exec-mcp__analyze_command", source: "interceptor" });
    const names = new Set(s.rows().map((r) => r.tool_name));
    assert.deepEqual([...names], ["mcp__safe-exec-mcp__analyze_command"]);
  } finally { s.done(); }
});

test("source is stored for both paths; an unknown source is NULL, never a guess", () => {
  const s = store();
  try {
    rec(s, { source: "hook" });
    rec(s, { source: "interceptor" });
    rec(s, { source: "router" });
    rec(s, {});
    assert.deepEqual(s.rows().map((r) => r.source), ["hook", "interceptor", null, null]);
    assert.deepEqual(SOURCE_ORDER, ["hook", "interceptor"]);
  } finally { s.done(); }
});

test("the store's CHECK refuses a source outside the enum", () => {
  const s = store();
  try {
    rec(s);
    resetTelemetryCache();
    const h = new DatabaseSync(s.db);
    try {
      assert.throws(() => h.prepare(
        "INSERT INTO tool_executions (id, project_hash, session_id, tool_name, execution_time_ms, status, timestamp, source) " +
        "VALUES ('x', 'p', 's', 'Bash', 1, 'SUCCESS', '2026-09-29T00:00:00.000Z', 'router')").run(), /CHECK/);
    } finally { h.close(); }
  } finally { s.done(); }
});

test("timestamps are ISO-8601 'T' form (the form the aggregates' bound is written in)", () => {
  const s = store();
  try {
    rec(s);
    const [{ timestamp }] = s.rows();
    assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally { s.done(); }
});

// ── the two emitters ─────────────────────────────────────────────────────────────────────
test("the interceptor records source=interceptor under the canonical name", async () => {
  const seen = [];
  const wrapped = withTelemetry("safe-exec-mcp", async () => ({ content: [] }), { record: (p) => seen.push(p) });
  await wrapped({ params: { name: "analyze_command" } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].source, "interceptor");
  assert.equal(canonicalToolName(seen[0].tool_name), seen[0].tool_name);
});

test("the hook's CLI path (--record-tool) records source=hook", () => {
  const s = store();
  try {
    execFileSync(process.execPath, [TELEMETRY_CLI, "--record-tool"], {
      input: JSON.stringify({ tool_name: "Bash", execution_time_ms: 3, status: "SUCCESS" }),
      env: { ...process.env, AI_TELEMETRY_DB_PATH: s.db, AI_TELEMETRY_DISABLE: "" },
    });
    const rows = s.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "hook");
  } finally { s.done(); }
});

// ── migration ────────────────────────────────────────────────────────────────────────────
// A store created before E-261: the same table without `source`, holding a row.
function preE261(s, check = STATUS_SQL_IN) {
  const h = new DatabaseSync(s.db);
  h.exec(`CREATE TABLE tool_executions (id TEXT PRIMARY KEY, project_hash TEXT NOT NULL,
    session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
    execution_time_ms INTEGER NOT NULL CHECK(execution_time_ms >= 0),
    status TEXT NOT NULL CHECK(${check}), timestamp TEXT NOT NULL);
    INSERT INTO tool_executions VALUES ('old', 'p', 's', 'Bash', 1, 'SUCCESS', '2026-09-01T00:00:00.000Z');`);
  h.close();
}

test("a pre-E-261 store gains `source`; the old row reads NULL and is not rewritten", () => {
  const s = store();
  try {
    preE261(s);
    rec(s, { source: "hook" });
    const rows = s.rows();
    assert.deepEqual(rows.map((r) => r.source), [null, "hook"]);
    assert.equal(rows[0].timestamp, "2026-09-01T00:00:00.000Z");
  } finally { s.done(); }
});

test("a store on the pre-E-180 status CHECK is rebuilt AND gains `source` in one open", () => {
  const s = store();
  try {
    preE261(s, "status IN ('SUCCESS','ERROR')");
    rec(s, { status: "REJECTED", source: "interceptor" });
    resetTelemetryCache();
    const h = new DatabaseSync(s.db, { readOnly: true });
    try {
      const rows = h.prepare("SELECT id, status, source FROM tool_executions ORDER BY rowid").all();
      assert.equal(rows.length, 2, "the old row survived the rebuild");
      assert.equal(rows[1].status, "REJECTED");
      assert.equal(rows[1].source, "interceptor");
    } finally { h.close(); }
  } finally { s.done(); }
});

test("an orphaned _tool_executions_old merges into a table that already has `source`", () => {
  const s = store();
  try {
    rec(s, { source: "hook" }); // current schema, with source
    resetTelemetryCache();
    const h = new DatabaseSync(s.db);
    h.exec(`CREATE TABLE _tool_executions_old (id TEXT PRIMARY KEY, project_hash TEXT, session_id TEXT,
      tool_name TEXT, execution_time_ms INTEGER, status TEXT, timestamp TEXT);
      INSERT INTO _tool_executions_old VALUES ('stranded', 'p', 's', 'Read', 2, 'BOGUS', '2026-09-02T00:00:00.000Z');`);
    h.close();
    rec(s, { source: "interceptor" });
    resetTelemetryCache();
    const r = new DatabaseSync(s.db, { readOnly: true });
    try {
      const got = r.prepare("SELECT status, source FROM tool_executions WHERE id = 'stranded'").get();
      assert.equal(got.status, "ERROR", "unknown status coerced so the CHECK accepts it");
      assert.equal(got.source, null);
      assert.equal(r.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = '_tool_executions_old'").get().c, 0);
      assert.equal(r.prepare("SELECT COUNT(*) AS c FROM tool_executions").get().c, 3);
    } finally { r.close(); }
  } finally { s.done(); }
});

test("an ALTER refused by a busy lock at open is retried on the next open (db_architect P1)", () => {
  const s = store();
  try {
    preE261(s);
    // A real pre-E-261 store has everything else too, so the ALTER is the ONLY write the
    // open needs. Without these, CREATE TABLE IF NOT EXISTS task_velocity is itself a write,
    // the open throws on the lock, nothing is cached and the retry is never exercised.
    const pre = new DatabaseSync(s.db);
    pre.exec(`CREATE TABLE task_velocity (id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        turn_count INTEGER NOT NULL CHECK(turn_count >= 0),
        tokens_consumed INTEGER NOT NULL CHECK(tokens_consumed >= 0), timestamp TEXT NOT NULL);
      CREATE INDEX idx_tool_executions_timestamp ON tool_executions(timestamp);
      CREATE INDEX idx_task_velocity_timestamp ON task_velocity(timestamp);
      PRAGMA journal_mode = WAL;`);
    pre.close();
    // Another process holds the write lock when this one first opens the store (a read is
    // enough to open it): the ALTER cannot run, and the connection is cached without the column.
    const holder = new DatabaseSync(s.db);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const st = getTelemetryStats({ db_path: s.db });
      assert.equal(st.status, "OK", "the open itself succeeded (only the ALTER was refused)");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    // Same cached connection, lock gone: the write must re-try the ALTER, not insert into a
    // column that is not there (which failed every insert for the life of the process).
    rec(s, { source: "interceptor" });
    const rows = s.rows();
    assert.equal(rows.length, 2, "the write after the lock cleared was not lost");
    assert.deepEqual(rows.map((r) => r.source), [null, "interceptor"]);
  } finally { s.done(); }
});

test("an enum rebuild keeps the `source` values it finds (db_architect P2)", () => {
  const s = store();
  try {
    const h = new DatabaseSync(s.db);
    h.exec(`CREATE TABLE tool_executions (id TEXT PRIMARY KEY, project_hash TEXT NOT NULL,
      session_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      execution_time_ms INTEGER NOT NULL CHECK(execution_time_ms >= 0),
      status TEXT NOT NULL CHECK(status IN ('SUCCESS','ERROR')), timestamp TEXT NOT NULL,
      source TEXT);
      INSERT INTO tool_executions VALUES ('kept', 'p', 's', 'Bash', 1, 'SUCCESS', '2026-09-01T00:00:00.000Z', 'hook');`);
    h.close();
    rec(s, { status: "REJECTED", source: "interceptor" }); // forces the rebuild
    assert.deepEqual(s.rows().map((r) => r.source), ["hook", "interceptor"]);
  } finally { s.done(); }
});

// ── the staleness probe ──────────────────────────────────────────────────────────────────
test("the staleness probe counts tool_executions only, not task_velocity", async () => {
  const s = store();
  try {
    for (let i = 0; i < 3; i++) rec(s);
    for (let i = 0; i < 4; i++) {
      recordTaskVelocity({ task_id: `E-${i}`, turn_count: 1, tokens_consumed: 1 }, { sync: true, db_path: s.db });
    }
    resetTelemetryCache();
    const r = await checkInsightsStaleness({ insights_path: join(s.d, "INSIGHTS.md"), telemetry_path: s.db });
    assert.equal(r.total_rows, 3);
    assert.equal(r.new_rows_since_insights, 3);
  } finally { s.done(); }
});
