// tests/unit/insights-staleness.test.mjs — node:test unit suite for E-86
// src/shared/insights-staleness.mjs (meta-cognition.md §Components 4), in process.
//
// REPLACES the probe rows of insights_staleness_test.sh (T-INS-S01 source contract, S03..S07
// the EMPTY / FRESH / STALE envelope) — E-302, D-088 r2. EXTENDS the staleness case in
// tests/unit/telemetry-naming.test.mjs (E-261: tool rows only). The CLI rows (S02 rollback
// flags, S08 envelope + --quiet), the ai-preflight Step 7 wiring and the mirrors stay in
// tests/suites/meta_cognition_test.sh. Labels are the bash assertions' own; every store is a
// temp db_path, never ~/.rein. Run standalone:  node --test tests/unit/insights-staleness.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkInsightsStaleness } from "../../src/shared/insights-staleness.mjs";
import { recordToolExecution, resetTelemetryCache } from "../../src/shared/telemetry.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const PROBE = join(REPO, "src/shared/insights-staleness.mjs");
const SRC = readFileSync(PROBE, "utf8");

const ROOT = mkdtempSync(join(tmpdir(), "rein-t-insights-"));
after(() => { resetTelemetryCache(); rmSync(ROOT, { recursive: true, force: true }); });
let _n = 0;
const sbox = () => { const d = join(ROOT, `s${++_n}`); mkdirSync(d); return d; };
const write = (db, n) => {
  for (let i = 0; i < n; i++) {
    recordToolExecution({ project_root: "/p", session_id: "s-" + i, tool_name: "srv.tool", execution_time_ms: 1, status: "SUCCESS" },
      { sync: true, db_path: db });
  }
  resetTelemetryCache();
};
const probe = async (opts) => JSON.stringify(await checkInsightsStaleness(opts));

// ── T-INS-S01: insights-staleness.mjs source contract ───────────────────────
test("probe file exists", () => assert.ok(existsSync(PROBE)));
test("exports checkInsightsStaleness", () => assert.match(SRC, /export async function checkInsightsStaleness/));
test("exports DEFAULT_INSIGHTS_PATH", () => assert.match(SRC, /export const DEFAULT_INSIGHTS_PATH/));
test("exports DEFAULT_TELEMETRY_PATH", () => assert.match(SRC, /export const DEFAULT_TELEMETRY_PATH/));
test("DEFAULT_THRESHOLD = 200", () => assert.match(SRC, /DEFAULT_THRESHOLD = 200/));
test("recognises AI_TELEMETRY_DISABLE", () => assert.match(SRC, /AI_TELEMETRY_DISABLE/));
test("recognises AI_INSIGHTS_STALENESS_DISABLE", () => assert.match(SRC, /AI_INSIGHTS_STALENESS_DISABLE/));
test("no child_process / spawn / exec", () => assert.doesNotMatch(SRC, /child_process|spawnSync|spawn\(|execSync/));
test("locator chain references in-repo helper", () => assert.match(SRC, /telemetry\.mjs/));
for (const st of ["FRESH", "STALE", "EMPTY", "DISABLED", "UNAVAILABLE"]) {
  test(`status enum includes ${st}`, () => assert.ok(SRC.includes(`status: "${st}"`)));
}
test("CLI exits 0 unconditionally", () => assert.match(SRC, /process\.exit\(0\)/));

// ── T-INS-S03: telemetry absent → EMPTY ─────────────────────────────────────
test("telemetry absent → EMPTY", async () => {
  const d = sbox();
  assert.ok((await probe({ insights_path: join(d, "INSIGHTS.md"), telemetry_path: join(d, "telemetry.sqlite") })).includes('"status":"EMPTY"'));
});

// ── T-INS-S04: telemetry present, no INSIGHTS.md, < threshold (200) → FRESH ──
let S04;
const fresh = async () => {
  if (S04) return S04;
  const d = sbox(); const db = join(d, "telemetry.sqlite");
  write(db, 5);
  S04 = await probe({ insights_path: join(d, "INSIGHTS.md"), telemetry_path: db });
  return S04;
};
test("< threshold → FRESH", async () => assert.ok((await fresh()).includes('"status":"FRESH"')));
test("total_rows reflects 5 writes", async () => assert.ok((await fresh()).includes('"total_rows":5')));

// ── T-INS-S05: telemetry ≥ threshold, no INSIGHTS.md → STALE (threshold lowered to 5) ──
let S05;
const stale = async () => {
  if (S05) return S05;
  const d = sbox(); const db = join(d, "telemetry.sqlite");
  write(db, 6);
  S05 = await probe({ insights_path: join(d, "INSIGHTS.md"), telemetry_path: db, threshold: 5 });
  return S05;
};
test("≥ threshold + no INSIGHTS → STALE", async () => assert.ok((await stale()).includes('"status":"STALE"')));
test("reason names threshold", async () => assert.ok((await stale()).includes("(>= 5)")));

// ── T-INS-S06: INSIGHTS.md fresher than every telemetry row → FRESH ──────────
let S06;
const after6 = async () => {
  if (S06) return S06;
  const d = sbox(); const db = join(d, "telemetry.sqlite"); const ins = join(d, "INSIGHTS.md");
  write(db, 10);
  writeFileSync(ins, "# INSIGHTS.md\n");
  const future = new Date(Date.now() + 3600 * 1000);   // forward-dated: every row pre-dates it
  utimesSync(ins, future, future);
  S06 = await probe({ insights_path: ins, telemetry_path: db, threshold: 1 });
  return S06;
};
test("no new rows since INSIGHTS.md → FRESH", async () => assert.ok((await after6()).includes('"status":"FRESH"')));
test("new_rows_since_insights = 0", async () => assert.ok((await after6()).includes('"new_rows_since_insights":0')));

// ── T-INS-S07: INSIGHTS.md older than the telemetry growth → STALE ───────────
let S07;
const older = async () => {
  if (S07) return S07;
  const d = sbox(); const db = join(d, "telemetry.sqlite"); const ins = join(d, "INSIGHTS.md");
  writeFileSync(ins, "# INSIGHTS.md (pre-existing)\n");
  const past = new Date(Date.now() - 3600 * 1000);
  utimesSync(ins, past, past);
  write(db, 8);
  S07 = await probe({ insights_path: ins, telemetry_path: db, threshold: 5 });
  return S07;
};
test("rows newer than mtime → STALE", async () => assert.ok((await older()).includes('"status":"STALE"')));
test("new_rows_since_insights >= 5", async () => assert.ok((await older()).includes('"new_rows_since_insights":8')));
