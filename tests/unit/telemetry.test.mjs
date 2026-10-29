// tests/unit/telemetry.test.mjs — node:test unit suite for src/shared/telemetry.mjs and
// src/shared/mcp-telemetry.mjs, in process (E-302, D-088 r2 "cheapest layer").
//
// EXTENDS tests/unit/telemetry-naming.test.mjs (E-261: naming, source column, timestamps) and
// REPLACES the rows that needed no process:
//   * telemetry_test.sh T-TEL-S01..S07 and S18 (E-84 module contract, E-173 writability probe)
//     — the CLI, hook and mirror rows stay in tests/suites/telemetry_test.sh;
//   * telemetry_migration_test.sh (E-154 TIMEOUT migration, E-180 REJECTED, E-185 enum DRY);
//   * mcp_telemetry_test.sh (E-153/E-154 withTelemetry, E-179/E-180 rejection, E-277 coverage).
// Labels are the bash assertions' own. Every write goes to a temp db_path, never ~/.rein.
// Run standalone:  node --test tests/unit/telemetry.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as T from "../../src/shared/telemetry.mjs";
import {
  withTelemetry, toolNameFor, statusForResult, rejection, markRejection, instrument,
} from "../../src/shared/mcp-telemetry.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const TELEMETRY = join(REPO, "src/shared/telemetry.mjs");
const SRC = readFileSync(TELEMETRY, "utf8");

const ROOT = mkdtempSync(join(tmpdir(), "rein-t-telemetry-"));
after(() => { T.resetTelemetryCache(); try { chmodSync(join(ROOT, "ro", "locked"), 0o755); } catch { /* absent */ } rmSync(ROOT, { recursive: true, force: true }); });
let _n = 0;
const dbIn = () => { const d = join(ROOT, `s${++_n}`); mkdirSync(d); return join(d, "t.sqlite"); };
const all = (db, sql) => { const h = new DatabaseSync(db); try { return h.prepare(sql).all(); } finally { h.close(); } };
const tool = (o, db) => T.recordToolExecution(
  { project_root: "/p", session_id: "s", tool_name: "srv.tool", execution_time_ms: 1, status: "SUCCESS", ...o },
  { sync: true, db_path: db });

// ── T-TEL-S01: telemetry.mjs source contract ─────────────────────────────────
test("telemetry.mjs exists", () => assert.ok(existsSync(TELEMETRY)));
test("uses node:sqlite (DatabaseSync)", () => assert.match(SRC, /from "node:sqlite"/));
test("uses createHash from node:crypto for project_hash", () => assert.match(SRC, /createHash, randomUUID/));
test("exports recordToolExecution", () => assert.match(SRC, /export function recordToolExecution/));
test("exports recordTaskVelocity", () => assert.match(SRC, /export function recordTaskVelocity/));
test("exports getTelemetryStats", () => assert.match(SRC, /export function getTelemetryStats/));
test("TELEMETRY_DB_PATH constant published", () => assert.match(SRC, /export const TELEMETRY_DB_PATH/));
test("fire-and-forget via setImmediate", () => assert.match(SRC, /setImmediate\(/));
// E-154 TIMEOUT, E-180 REJECTED, E-291 BYPASS joined the blueprint §Data Model enum.
test("STATUS_ORDER carries SUCCESS/ERROR/TIMEOUT/REJECTED/BYPASS (E-291)", () =>
  assert.ok(SRC.includes('STATUS_ORDER = ["SUCCESS", "ERROR", "TIMEOUT", "REJECTED", "BYPASS"]')));
test("tool_executions table", () => assert.match(SRC, /CREATE TABLE IF NOT EXISTS tool_executions/));
test("task_velocity table", () => assert.match(SRC, /CREATE TABLE IF NOT EXISTS task_velocity/));
test("no child_process / spawn / exec", () => assert.doesNotMatch(SRC, /child_process|spawnSync|spawn\(|execSync/));
test("AI_TELEMETRY_DISABLE env flag recognised", () => assert.match(SRC, /AI_TELEMETRY_DISABLE/));

// ── T-TEL-S02: schema bootstrap + writes both tables ─────────────────────────
const S02 = (() => {
  const db = dbIn();
  T.recordToolExecution({ project_root: "/Users/example/project", session_id: "abc-123-XYZ",
    tool_name: "task-synchronizer-mcp.add_task", execution_time_ms: 42, status: "SUCCESS" }, { sync: true, db_path: db });
  T.recordTaskVelocity({ task_id: "E-84", turn_count: 3, tokens_consumed: 1500 }, { sync: true, db_path: db });
  T.resetTelemetryCache();
  return {
    db,
    te: JSON.stringify(all(db, "SELECT project_hash, session_id, tool_name, execution_time_ms, status FROM tool_executions")),
    tv: JSON.stringify(all(db, "SELECT task_id, turn_count, tokens_consumed FROM task_velocity")),
  };
})();
test("DB file created on first write", () => assert.ok(existsSync(S02.db)));
// E-261: a dotted <server>.<tool> name is canonicalised at write time.
test("tool_executions row written (canonical name)", () => assert.ok(S02.te.includes("mcp__task-synchronizer-mcp__add_task")));
test("session_id sanitised + persisted", () => assert.ok(S02.te.includes("abc-123-XYZ")));
test("status=SUCCESS persisted", () => assert.ok(S02.te.includes("SUCCESS")));
test("execution_time_ms persisted", () => assert.ok(S02.te.includes('"execution_time_ms":42')));
test("raw absolute path not leaked", () => assert.ok(!S02.te.includes("/Users/example/project")));
test("raw 'project' token not leaked", () => assert.ok(!S02.te.includes("/Users/example")));
test("project_hash is 12 hex chars", () => assert.match(S02.te, /"project_hash":"[0-9a-f]{12}"/));
test("task_velocity row written", () => assert.ok(S02.tv.includes("E-84")));
test("turn_count persisted", () => assert.ok(S02.tv.includes('"turn_count":3')));
test("tokens_consumed persisted", () => assert.ok(S02.tv.includes('"tokens_consumed":1500')));

// ── T-TEL-S03: session_id sanitiser rejects malformed → 'unknown' ─────────────
const S03 = (() => {
  const db = dbIn();
  for (const sid of ["", "  ", "spaces in id", "has;semi", "with\nnewline", "a".repeat(65)]) tool({ session_id: sid }, db);
  T.resetTelemetryCache();
  return JSON.stringify(all(db, "SELECT DISTINCT session_id FROM tool_executions"));
})();
test("all malformed inputs collapse to 'unknown'", () => assert.ok(S03.includes("unknown")));
test("no malformed session_id leaked verbatim", () => assert.equal(S03, '[{"session_id":"unknown"}]'));

// ── T-TEL-S04: status enum constrained — invalid → SUCCESS default ────────────
test("invalid status falls back to SUCCESS", () => {
  const db = dbIn();
  tool({ session_id: "sid-1", status: "WAT" }, db);
  T.resetTelemetryCache();
  assert.equal(all(db, "SELECT status FROM tool_executions")[0].status, "SUCCESS");
});

// ── T-TEL-S05: AI_TELEMETRY_DISABLE=1 short-circuits — no DB created ──────────
test("DB file NOT created when telemetry disabled", () => {
  const db = dbIn();
  process.env.AI_TELEMETRY_DISABLE = "1";
  try { tool({ tool_name: "t.t", execution_time_ms: 0 }, db); } finally { delete process.env.AI_TELEMETRY_DISABLE; }
  assert.ok(!existsSync(db));
});

// ── T-TEL-S06: getTelemetryStats returns the blueprint envelope ───────────────
const S06db = dbIn();
test("EMPTY status when DB absent", () => assert.ok(JSON.stringify(T.getTelemetryStats({ db_path: S06db })).includes('"status":"EMPTY"')));
test("EMPTY tool_executions.count = 0", () => assert.ok(JSON.stringify(T.getTelemetryStats({ db_path: S06db })).includes('"tool_executions":{"count":0')));
const S06ok = () => {
  if (!existsSync(S06db)) { tool({ session_id: "s-1" }, S06db); T.resetTelemetryCache(); }
  const s = JSON.stringify(T.getTelemetryStats({ db_path: S06db })); T.resetTelemetryCache(); return s;
};
test("OK status when DB populated", () => assert.ok(S06ok().includes('"status":"OK"')));
test("tool_executions.count = 1", () => assert.ok(S06ok().includes('"tool_executions":{"count":1')));

// ── T-TEL-S07: the default (non-sync) path defers the write until the next tick ──
let S07;
const race = async () => {
  if (S07) return S07;
  const db = dbIn();
  T.recordToolExecution({ project_root: "/p", session_id: "s-immediate", tool_name: "srv.tool",
    execution_time_ms: 1, status: "SUCCESS" }, { db_path: db });
  const beforeExists = existsSync(db);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  S07 = { beforeExists, afterExists: existsSync(db) };
  T.resetTelemetryCache();
  return S07;
};
test("DB absent synchronously", async () => assert.equal((await race()).beforeExists, false));
test("DB present after setImmediate tick", async () => assert.equal((await race()).afterExists, true));

// ── T-TEL-S18 (E-173): non-writable telemetry path → structured warning + fail-open ──
test("imports accessSync from node:fs", () => assert.match(SRC, /accessSync/));
test("writability probe checks W_OK", () => assert.match(SRC, /fsConstants\.W_OK|constants\.W_OK|W_OK/));
test("emits telemetry-db-not-writable warning code", () => assert.ok(SRC.includes("telemetry-db-not-writable")));
// Perm bits are ignored for root, so the behavioural probe needs a dir this user cannot write.
const RO = join(ROOT, "ro", "locked");
mkdirSync(RO, { recursive: true });
chmodSync(RO, 0o000);
let roWritable = false;
try { writeFileSync(join(RO, ".wtest"), ""); roWritable = true; } catch { /* expected */ }
const roSkip = process.getuid?.() === 0 || roWritable ? "running as root or the dir is writable" : false;
let S18;
const roProbe = () => {
  if (S18) return S18;
  const orig = process.stderr.write.bind(process.stderr);
  let stderr = ""; let threw = "";
  process.stderr.write = (c, ...a) => { stderr += String(c); return true; };
  try { tool({ session_id: "s-ro" }, join(RO, "telemetry.sqlite")); T.resetTelemetryCache(); }
  catch (e) { threw = "THREW:" + e.message; }
  finally { process.stderr.write = orig; }
  S18 = { stderr: stderr + threw, threw };
  return S18;
};
test("record call fails open (rc 0) on read-only path", { skip: roSkip }, () => assert.equal(roProbe().threw, ""));
test("structured warning logged for non-writable path", { skip: roSkip }, () => assert.ok(roProbe().stderr.includes("telemetry-db-not-writable")));
test("no unhandled throw propagated to caller", { skip: roSkip }, () => assert.ok(!roProbe().stderr.includes("THREW:")));

// ── E-154 / E-180 (from telemetry_migration_test.sh): the status-CHECK migration in _openDb() ──
// (1) an old 2-value CHECK DB migrates, rows preserved, TIMEOUT insertable; (2) re-open is
// idempotent; (3) a _tool_executions_old stranded by a crash is merged back; (4) a 3-value
// DB migrates forward to REJECTED; (5) an orphan AND a stale-CHECK live table both resolve.
const COLS = "id TEXT PRIMARY KEY, project_hash TEXT NOT NULL, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, execution_time_ms INTEGER NOT NULL CHECK(execution_time_ms >= 0), status TEXT NOT NULL CHECK(status IN (%S)), timestamp TEXT NOT NULL";
const OLD = COLS.replace("%S", "'SUCCESS','ERROR'");
const MID = COLS.replace("%S", "'SUCCESS','ERROR','TIMEOUT'");
const rows = (p) => {
  const d = new DatabaseSync(p);
  try {
    return {
      r: d.prepare("SELECT id,status,tool_name FROM tool_executions ORDER BY timestamp").all(),
      orphan: d.prepare("SELECT count(*) c FROM sqlite_master WHERE name='_tool_executions_old'").get().c,
      ddl: d.prepare("SELECT sql FROM sqlite_master WHERE name='tool_executions'").get().sql,
    };
  } finally { d.close(); }
};
const seed = (p, stmts) => {
  const s = new DatabaseSync(p);
  for (const [table, schema, vals] of stmts) {
    s.exec(`CREATE TABLE IF NOT EXISTS ${table} (${schema});`);
    for (const v of vals) s.prepare(`INSERT INTO ${table} VALUES (?,?,?,?,?,?,?)`).run(...v);
  }
  s.close();
};
const rec = (p, name, status) => { T.resetTelemetryCache(); T.recordToolExecution({ tool_name: name, execution_time_ms: 1, status }, { db_path: p, sync: true }); };
const M = (() => {
  const DB1 = dbIn(), DB2 = dbIn(), DB3 = dbIn(), DB4 = dbIn();
  seed(DB1, [["tool_executions", OLD, [["a", "h", "s", "Bash", 5, "SUCCESS", "2026-01-01T00:00:00Z"], ["b", "h", "s", "Read", 3, "ERROR", "2026-01-02T00:00:00Z"]]]]);
  rec(DB1, "mcp__x-mcp__y", "TIMEOUT");
  const a = rows(DB1);
  rec(DB1, "mcp__x-mcp__z", "ERROR");
  const b = rows(DB1);
  seed(DB2, [["_tool_executions_old", OLD, [["orphan1", "h", "s", "Bash", 5, "SUCCESS", "2026-01-01T00:00:00Z"], ["orphan2", "h", "s", "Edit", 2, "ERROR", "2026-01-02T00:00:00Z"]]]]);
  rec(DB2, "mcp__x-mcp__new", "SUCCESS");
  const c = rows(DB2);
  seed(DB3, [["tool_executions", MID, [["m1", "h", "s", "Bash", 5, "SUCCESS", "2026-01-01T00:00:00Z"], ["m2", "h", "s", "Grep", 4, "TIMEOUT", "2026-01-02T00:00:00Z"]]]]);
  rec(DB3, "mcp__x-mcp__rej", "REJECTED");
  const d = rows(DB3);
  seed(DB4, [["tool_executions", MID, [["live1", "h", "s", "Bash", 5, "SUCCESS", "2026-01-01T00:00:00Z"]]],
    ["_tool_executions_old", MID, [["strand1", "h", "s", "Edit", 2, "TIMEOUT", "2026-01-02T00:00:00Z"]]]]);
  rec(DB4, "mcp__x-mcp__rej2", "REJECTED");
  const e = rows(DB4);
  T.resetTelemetryCache();
  return { a, b, c, d, e };
})();
const has = (r, id, status) => r.some((x) => x.id === id && (!status || x.status === status));
test("154.M01: migrated DDL accepts TIMEOUT", () => assert.ok(M.a.ddl.includes("TIMEOUT")));
test("154.M02: pre-existing rows preserved", () => assert.ok(has(M.a.r, "a", "SUCCESS") && has(M.a.r, "b", "ERROR")));
test("154.M03: TIMEOUT row now insertable", () => assert.ok(M.a.r.some((x) => x.status === "TIMEOUT")));
test("154.M04: no _tool_executions_old residue", () => assert.equal(M.a.orphan, 0));
test("154.M05: row count after migrate (2 old + 1 new)", () => assert.equal(M.a.r.length, 3));
test("154.M06: re-open is idempotent (no orphan)", () => assert.equal(M.b.orphan, 0));
test("154.M07: re-open preserves rows", () => assert.ok(has(M.b.r, "a")));
test("154.M08: orphan rows recovered (no data loss)", () => assert.ok(has(M.c.r, "orphan1") && has(M.c.r, "orphan2")));
test("154.M09: orphan table cleaned up", () => assert.equal(M.c.orphan, 0));
test("154.M10: new row co-exists with recovered", () => assert.ok(M.c.r.some((x) => x.tool_name === "mcp__x-mcp__new")));
test("180.M11: 2-value DB migrates straight to REJECTED-capable", () => assert.ok(M.a.ddl.includes("REJECTED")));
test("180.M12: 3-value (TIMEOUT) DDL migrates to accept REJECTED", () => assert.ok(M.d.ddl.includes("REJECTED")));
test("180.M13: rows preserved across +REJECTED migration", () => assert.ok(has(M.d.r, "m1", "SUCCESS") && has(M.d.r, "m2", "TIMEOUT")));
test("180.M14: REJECTED row now insertable", () => assert.ok(M.d.r.some((x) => x.status === "REJECTED")));
test("180.M15: no _tool_executions_old residue after +REJECTED", () => assert.equal(M.d.orphan, 0));
test("180.M16: row count after +REJECTED migrate (2 old + 1 new)", () => assert.equal(M.d.r.length, 3));
// E-180 db_architect P1: the old `if (orphan) {merge} else {migrate}` dropped the REJECTED row.
test("180.M17: orphan+stale-live still refreshes CHECK to 4-value", () => assert.ok(M.e.ddl.includes("REJECTED")));
test("180.M18: REJECTED survives orphan+stale-live (P1 regression)", () => assert.ok(M.e.r.some((x) => x.status === "REJECTED")));
test("180.M19: live rows preserved through merge+rebuild", () => assert.ok(has(M.e.r, "live1", "SUCCESS")));
test("180.M20: orphan rows recovered through merge+rebuild", () => assert.ok(has(M.e.r, "strand1", "TIMEOUT")));
test("180.M21: no _tool_executions_old residue (P1 path)", () => assert.equal(M.e.orphan, 0));
test("180.M22: row count (live + orphan + new = 3)", () => assert.equal(M.e.r.length, 3));

// ── E-185: the status enum is declared once; the Set, the SQL CHECK and the sentinel derive ──
test("185.D01: STATUS_ORDER is the ordered source array", () => assert.ok(Array.isArray(T.STATUS_ORDER)));
test("185.D02: STATUS_VALUES Set is derived from STATUS_ORDER", () =>
  assert.ok(T.STATUS_ORDER.length === T.STATUS_VALUES.size && T.STATUS_ORDER.every((s) => T.STATUS_VALUES.has(s))));
test("185.D03: SQL CHECK clause is derived from STATUS_ORDER", () =>
  assert.equal(T.STATUS_SQL_IN, "status IN (" + T.STATUS_ORDER.map((s) => `'${s}'`).join(",") + ")"));
test("185.D04: migration sentinel is the newest enum value", () => assert.equal(T.STATUS_MIGRATION_SENTINEL, T.STATUS_ORDER.at(-1)));
test("185.D05: enum still covers SUCCESS/ERROR/TIMEOUT/REJECTED", () =>
  assert.ok(["SUCCESS", "ERROR", "TIMEOUT", "REJECTED"].every((s) => T.STATUS_VALUES.has(s))));

// ── E-153 / E-154 (from mcp_telemetry_test.sh): withTelemetry() with an INJECTED recorder ──
// Canonical naming, SUCCESS/ERROR classification (a throw OR {isError:true} is ERROR), result
// pass-through, exception propagation, latency, and a telemetry failure never breaks the tool.
const reqFor = (name) => ({ params: { name } });
const I = await (async () => {
  let captured = null;
  const rec1 = (p) => { captured = p; };
  const o = {};
  const okRes = await withTelemetry("task-synchronizer-mcp", async () => ({ content: [{ type: "text", text: "ok" }] }), { record: rec1 })(reqFor("add_task"));
  Object.assign(o, { ok: captured, okRes });
  captured = null;
  const errRes = await withTelemetry("safe-exec-mcp", async () => ({ content: [], isError: true }), { record: rec1 })(reqFor("analyze_command"));
  Object.assign(o, { err: captured, errRes });
  captured = null;
  let propagated = false;
  try { await withTelemetry("db-architect-mcp", async () => { throw new Error("boom"); }, { record: rec1 })(reqFor("migrate")); }
  catch (e) { propagated = e.message === "boom"; }
  Object.assign(o, { thr: captured, propagated });
  let robustOk = false;
  try {
    const r = await withTelemetry("orchestrator-mcp", async () => ({ content: [{ type: "text", text: "fine" }] }),
      { record: () => { throw new Error("telemetry down"); } })(reqFor("run_review"));
    robustOk = !!(r && r.content);
  } catch { robustOk = false; }
  o.robustOk = robustOk;
  // instrument(): CallTool handlers get wrapped (recorder fires), others pass through.
  const calls = [];
  const fake = { _h: new Map(), setRequestHandler(schema, h) { this._h.set(schema, h); } };
  const CALLTOOL = { kind: "CallTool" }, LISTTOOLS = { kind: "ListTools" };
  instrument(fake, "demo-mcp", CALLTOOL, { record: (p) => calls.push(p) });
  fake.setRequestHandler(CALLTOOL, async (req) => ({ content: [], isError: req.params.name === "boom" }));
  fake.setRequestHandler(LISTTOOLS, async () => ({ tools: ["passthrough"] }));
  await fake._h.get(CALLTOOL)({ params: { name: "ok" } });
  await fake._h.get(CALLTOOL)({ params: { name: "boom" } });
  Object.assign(o, { calls, listRes: await fake._h.get(LISTTOOLS)() });
  captured = null;
  const rejRes = await withTelemetry("task-synchronizer-mcp", async () => rejection("✗ [SEED_NOT_FOUND] TS-9"), { record: rec1 })(reqFor("get_topic_cluster"));
  Object.assign(o, { rejE2e: captured, rejRes });
  return o;
})();
test("153.01: canonical mcp__server__tool name", () => assert.equal(I.ok.tool_name, "mcp__task-synchronizer-mcp__add_task"));
test("153.02: normal result records SUCCESS", () => assert.equal(I.ok.status, "SUCCESS"));
test("153.03: result passed through unchanged", () => assert.ok(I.okRes && I.okRes.content));
test("153.04: latency is a non-negative integer", () => assert.ok(Number.isInteger(I.ok.execution_time_ms) && I.ok.execution_time_ms >= 0));
test("154.01: {isError:true} result records ERROR", () => assert.equal(I.err.status, "ERROR"));
test("154.01b: error result still returned to caller", () => assert.ok(I.errRes && I.errRes.isError));
test("154.02: thrown handler records ERROR", () => assert.equal(I.thr ? I.thr.status : "NONE", "ERROR"));
test("154.02b: thrown exception propagates unchanged", () => assert.equal(I.propagated, true));
test("153.05: telemetry failure never breaks the tool", () => assert.equal(I.robustOk, true));
test("153.06: missing tool name → __unknown", () => assert.equal(toolNameFor("x-mcp", {}), "mcp__x-mcp__unknown"));
test("153.07: statusForResult(ok)=SUCCESS", () => assert.equal(statusForResult({ content: [] }), "SUCCESS"));
test("153.07b: statusForResult(isError)=ERROR", () => assert.equal(statusForResult({ isError: true }), "ERROR"));
test("153.08: instrument() wraps both CallTool calls", () => assert.equal(I.calls.length, 2));
test("153.08b: instrument() names both tools", () => assert.equal(I.calls.map((c) => c.tool_name).join(","), "mcp__demo-mcp__ok,mcp__demo-mcp__boom"));
test("153.08c: instrument() classifies SUCCESS+ERROR", () => assert.equal(I.calls.map((c) => c.status).join(","), "SUCCESS,ERROR"));
test("153.08d: instrument() leaves ListTools untouched", () => assert.equal(I.listRes.tools[0], "passthrough"));
// E-179/E-180: an EXPECTED rejection books REJECTED (not SUCCESS, not ERROR); the model still sees isError.
const REJ = rejection("✗ [INVALID_X] bad input");
test("179.01: rejection() sets isError:true (model still reacts)", () => assert.equal(REJ.isError, true));
test("179.02: rejection() stamps _meta.expected_rejection", () => assert.equal(REJ._meta && REJ._meta.expected_rejection, true));
test("180.03: marked isError result classifies REJECTED", () => assert.equal(statusForResult(REJ), "REJECTED"));
test("180.04: markRejection() also yields REJECTED", () => assert.equal(statusForResult(markRejection({ content: [], isError: true })), "REJECTED"));
test("179.05: UNMARKED isError still classifies ERROR", () => assert.equal(statusForResult({ isError: true, _meta: {} }), "ERROR"));
test("180.04b: REJECTED is distinct from SUCCESS and ERROR", () => assert.ok(!["SUCCESS", "ERROR"].includes(statusForResult(REJ))));
test("180.06: wrapped rejection() records REJECTED telemetry", () => assert.equal(I.rejE2e.status, "REJECTED"));
test("179.07: wrapped rejection() still returns isError to model", () => assert.equal(I.rejRes && I.rejRes.isError, true));
test("179.08: statusForResult(null) MALFORMED → ERROR", () => assert.equal(statusForResult(null), "ERROR"));
test("179.09: markRejection(null) is a safe no-op (no throw)", () => assert.equal(markRejection(null), null));

// ── E-277 (D-075): every registry server instruments its CallTool handler ────
// Enumerated from the registry, not a literal list; the count guards an empty enumeration.
const REG = JSON.parse(readFileSync(join(REPO, "src/config/registry.json"), "utf8"));
const SERVERS = Object.entries(REG.mcp_servers).filter(([, v]) => v.path).map(([n]) => n);
test(`E-277: the registry enumerates at least 10 custom servers (got ${SERVERS.length})`, () => assert.ok(SERVERS.length >= 10));
test("E-277: every registry server calls instrument() on its CallTool handler", () => {
  const unwrapped = SERVERS.filter((s) => {
    try { return !readFileSync(join(REPO, "src/mcp", s, "index.js"), "utf8").includes(`instrument(server, "${s}"`); }
    catch { return true; }
  });
  assert.deepEqual(unwrapped, []);
});
test("E-277: the retired router is not in the registry", () =>
  assert.ok(!readFileSync(join(REPO, "src/config/registry.json"), "utf8").includes('"mcp-router"')));
