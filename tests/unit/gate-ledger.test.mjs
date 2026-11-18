// gate-ledger.test.mjs — the control ledger (E-432, D-159 r8, A2A 2026-11-18 15:10 Q2-Q3). New: no
// earlier test reads telemetry by rule. Stores are created by telemetry.mjs's writer (its schema).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { recordToolExecution, resetTelemetryCache } from "../../src/shared/telemetry.mjs";
import { buildLedger, renderLedger } from "../../src/shared/gate-ledger.mjs";

const NOW = new Date("2026-11-18T12:00:00Z"), at = (min) => new Date(NOW - min * 60000).toISOString();
const dir = mkdtempSync(join(tmpdir(), "rein-t-ledger-")), proj = join(dir, "proj");
test.after(() => { resetTelemetryCache(); rmSync(dir, { recursive: true, force: true }); });
mkdirSync(join(proj, ".ai"), { recursive: true });
writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { "task-synchronizer-mcp": {}, "idle-mcp": {}, "bad\u001b]0;t\u0007name": {} } }));
writeFileSync(join(proj, ".ai", "state.json"), JSON.stringify({ stamps: [{ type: "TESTS_FAIL", task_id: "E-1", timestamp: at(300) },
  { type: "TESTS_PASS", task_id: "E-1", timestamp: at(200) }, { type: "SEC_PASS", task_id: "E-2", timestamp: at(100) }] }));
let n = 0;
function store(name) {
  const p = join(dir, name);
  recordToolExecution({ tool_name: "Read", session_id: "s0" }, { sync: true, db_path: p });
  resetTelemetryCache();
  const db = new DatabaseSync(p), ins = db.prepare("INSERT INTO tool_executions VALUES (?, 'p', ?, ?, ?, ?, ?, 'hook', ?)");
  return { p, db, add: (o) => ins.run(`r${n++}`, o.s ?? "s1", o.tool ?? "Bash", o.ms ?? 0, o.st ?? "REJECTED", o.t, o.rule ?? null) };
}

test("fires by rule; an override pairs only within 10 min in one real session; QUIET, NOISY, critics, servers", () => {
  const f = store("a.sqlite"), RM = "SAFE_EXEC_BLOCK:RM_RF", CURL = "SAFE_EXEC_BLOCK:CURL_PIPE_SHELL";
  for (let i = 0; i < 4; i++) { f.add({ rule: RM, s: `n${i}`, t: at(100 - i) }); if (i < 2) f.add({ st: "BYPASS", s: `n${i}`, t: at(95 - i) }); }
  f.add({ rule: CURL, s: "unknown", t: at(50) }); f.add({ st: "BYPASS", s: "unknown", t: at(49) });   // not a real session
  f.add({ rule: CURL, s: "x", t: at(40) }); f.add({ st: "BYPASS", s: "x", t: at(29) });               // 11 minutes later
  f.add({ rule: "UNLISTED", t: at(30) }); f.add({ t: at(20) });                                       // NULL rule: a denial
  f.add({ rule: "SAFE_EXEC_BLOCK:RM_RF_ROOT", t: at(60 * 24 * 100) });                                 // outside 90 days
  for (const [ms, st] of [[10, "SUCCESS"], [30, "ERROR"], [20, "SUCCESS"]]) f.add({ st, tool: "mcp__task-synchronizer-mcp__x", ms, t: at(10) });
  f.add({ st: "SUCCESS", tool: "mcp__x\u001b[2J [CONTROL_QUIET] retire__y", t: at(10) });            // P2-2: never printed raw
  f.add({ rule: "SAFE_EXEC_BLOCK:MKFS", t: "9\u001b[8m\u001b]0;x\u0007" });                                // P3-6: nor a date
  const l = buildLedger({ dbPath: f.p, projectRoot: proj, now: NOW }), out = renderLedger(l);
  const get = (id, ...k) => k.map((x) => l.rows.find((r) => r.id === id)[x]);
  assert.deepEqual(get(RM, "fires", "overridden", "flags"), [4, 2, ["CONTROL_NOISY"]]);
  assert.deepEqual(get(CURL, "fires", "overridden", "flags"), [2, 0, []]);
  assert.deepEqual([get("SAFE_EXEC_BLOCK:RM_RF_ROOT", "flags"), get("UNLISTED", "fires"), l.unattributed], [[["CONTROL_QUIET"]], [1], 1]);
  assert.deepEqual([get("TESTS", "calls", "fails", "fails_then_pass"), get("SEC", "flags")], [[1, 1, 1], [["CONTROL_QUIET"]]]);
  assert.deepEqual([get("task-synchronizer-mcp", "calls", "p50_ms", "error_rate"), get("idle-mcp", "flags"), get("INVALID", "calls")],
    [[3, 20, 0.333], [["CONTROL_QUIET"]], [1]]);
  assert.match(out, /not gate rows \(permission denials\) or pre-E-432: 1/);
  assert.doesNotMatch(out, /\u001b|QUIET\] retire/);
});

test("[LEDGER_EMPTY] on an absent or empty store; the CLI's --json; exit 2 on a bad option", () => {
  assert.match(renderLedger(buildLedger({ dbPath: join(dir, "none.sqlite") })), /^\[LEDGER_EMPTY\]/);
  const f = store("b.sqlite");
  f.db.exec("DELETE FROM tool_executions");
  const cli = (...a) => execFileSync("node", ["--no-warnings", new URL("../../src/shared/gate-ledger.mjs", import.meta.url).pathname,
    "--db", f.p, "--project", proj, ...a], { encoding: "utf8" });
  assert.match(cli(), /^\[LEDGER_EMPTY\]/);
  f.add({ rule: "SAFE_EXEC_BLOCK:MKFS", t: new Date().toISOString() });
  assert.equal(JSON.parse(cli("--json", "--days", "7")).find((r) => r.id === "SAFE_EXEC_BLOCK:MKFS").fires, 1);
  assert.throws(() => cli("--days", "x"), (e) => e.status === 2);
});

test("100,000 rows: within 4× a full read of the window on this host (rule 2); the 500 ms contract is printed", () => {
  const f = store("c.sqlite");
  f.db.exec("BEGIN");
  for (let i = 0; i < 100000; i++) {
    const s = `s${i % 97}`, t = at(i % 5000);
    f.add(i % 4 === 0 ? { rule: "SAFE_EXEC_BLOCK:RM_RF", s, t } : i % 4 === 1 ? { st: "BYPASS", s, t } : { st: "SUCCESS", tool: `mcp__s${i % 9}__x`, ms: i % 300, t });
  }
  f.db.exec("COMMIT");
  let t0 = performance.now();
  f.db.prepare("SELECT * FROM tool_executions WHERE timestamp >= ?").all(at(60 * 24 * 90));
  const base = performance.now() - t0;
  t0 = performance.now();
  assert.equal(buildLedger({ dbPath: f.p, projectRoot: proj, now: NOW }).rows.find((r) => r.id === "SAFE_EXEC_BLOCK:RM_RF").fires, 25000);
  const ms = performance.now() - t0;
  console.log(`ledger over 100,000 rows: ${ms.toFixed(0)} ms; baseline full read ${base.toFixed(0)} ms (contract: 500 ms)`);
  assert.ok(ms <= 4 * base + 150, `${ms.toFixed(0)} ms > 4 × ${base.toFixed(0)} + 150`);
});
