// tests/unit/ci-runs.test.mjs — node:test unit suite for src/mcp/shared/ci-runs.js (E-266)
//
// D-072: "CI green" means a NON-DIRTY ci_runs row with status PASS for the commit. These
// tests pin the record that sentence depends on: the migration (up AND down), the log →
// row parse, the verdict rules (dirty never certifies), the short line the skills inject,
// the failing-section extractor and log retention.
//
// Every test uses a fresh state store in its own temp dir. Run standalone:
//   node --test tests/unit/ci-runs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { getDb } from "../../src/mcp/shared/state-db.js";
import {
  migrateCiRuns, downCiRuns, recordCiRun, latestCiRun, listCiRuns, ciRunCount, ciVerdict,
  shortLine, parseCiLog, recordCiRunFromLog, failedSections, pruneCiLogs, getCiStatus, ageOf,
  certifyingRunFor, checkCiDoneGate, recordCiSkip, certifiedBy,
} from "../../src/mcp/shared/ci-runs.js";
import { validateCiRecord, writeCiRecord, hasCiRecords } from "../../src/mcp/shared/ci-evidence.mjs";
import { mergeRecord } from "../../src/mcp/shared/record-import.mjs";
import { ATTRIBUTES } from "../../src/mcp/shared/record-migrate.mjs";

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "rein-t-cirun-"));
  return { d, done: () => rmSync(d, { recursive: true, force: true }) };
}

function freshDb() {
  const t = tmp();
  mkdirSync(join(t.d, ".ai"));
  return { ...t, db: getDb(join(t.d, ".ai")) };
}

const SHA = "a".repeat(40);
const base = (over = {}) => ({ sha: SHA, ref: "HEAD", status: "PASS", started_at: "2026-09-17T10:00:00Z", ...over });

const LOG = [
  "[ci] ai ci run — Rein 3.1.0",
  `[ci] sha=${SHA} ref=HEAD dirty=0 started_at=2026-09-17T10:00:00Z`,
  "[ci] repo=/r",
  "[ci] branch=engineer/x",
  "[ci] step=worktree status=ok /w",
  "[ci] toolchain node=v26.8.2 bash=3.2.57(1)-release patch=patch 2.0-12u11-Apple os=Darwin 27.0.0",
  "",
  "[ci] ── suite: /bin/bash tests/run.sh",
  "── Suite: good_test ──",
  "  ✓ fine",
  "  ⓘ agg: elapsed=12ms baseline=5ms limit=60ms [relative] (k=2 slack=50ms absolute=200ms)",
  "SUITE_RESULT PASS=1 FAIL=0 SKIP=0",
  "── Suite: bad_test ──",
  "  ✗ broken thing (expected exit=0, got 1)",
  "SUITE_RESULT PASS=3 FAIL=1 SKIP=0",
  "━━ Results ━━",
  "  ✓ good_test.sh (1 passed)",
  "  ✗ bad_test.sh (3 passed, 1 failed)",
  "   Total: 4 passed, 1 failed",
  "[TEST_FAILED] 1 test(s) failed ✗",
  // E-310: the census rows (the slowest ten come from them) and what the step spent.
  "CENSUS_SUITE\tgood_test.sh\t1200\t1\t0\t0\t0",
  "CENSUS_SUITE\tbad_test.sh\t93290\t3\t1\t0\t1",
  "[run] peak_sum_rss_mb=99 samples=3 sampler_cpu_ms=10",   // a nested runner's, inside a suite
  "[run] peak_sum_rss_mb=2140 samples=790 sampler_cpu_ms=6000",
  "[ci] resources lanes=4 peak_rss_mb=812 suite_seconds=790 exclusive_seconds=171 host=local runner=rein",
  "[ci] step=suite status=FAIL 4 passed, 1 failed, 0 skipped, leaked 0",
  "",
  "[ci] ── unit: /usr/bin/env UNIT_COVERAGE=1 /bin/bash tests/suites/node_unit_test.sh",
  "# all files            |  69.74 |    74.43 |   62.38 | ",
  "[ci] step=unit status=PASS node:test (coverage)",
  "[ci] result status=FAIL suite=FAIL pass=4 fail=1 skip=0 leaked=0 unit=PASS secrets=PASS",
  "[ci] finished status=FAIL duration_ms=610000 finished_at=2026-09-17T10:10:10Z",
].join("\n");

test("migration: up creates table + index; down drops both; up is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  migrateCiRuns(db);
  migrateCiRuns(db);
  const objs = () => db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'ci_runs%' ORDER BY name").all()
    .map((r) => `${r.type}:${r.name}`);
  assert.deepEqual(objs(), ["table:ci_runs", "index:ci_runs_sha"]);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  downCiRuns(db);
  assert.deepEqual(objs(), []);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  downCiRuns(db);   // the down path is idempotent too
});

test("getDb carries ci_runs on a fresh store", () => {
  const { db, done } = freshDb();
  try {
    assert.equal(ciRunCount(db), 0);
  } finally { done(); }
});

test("recordCiRun rejects malformed records", () => {
  const { db, done } = freshDb();
  try {
    assert.throws(() => recordCiRun(db, base({ sha: "" })), /sha and started_at/);
    assert.throws(() => recordCiRun(db, base({ status: "GREEN" })), /unknown status/);
    assert.throws(() => recordCiRun(db, base({ status: "SKIPPED" })), /skip_reason/);
    assert.ok(recordCiRun(db, base({ status: "SKIPPED", skip_reason: "hotfix" })) > 0);
  } finally { done(); }
});

test("parseCiLog fills every column the runner writes", () => {
  const r = parseCiLog(LOG, "/logs/x.log");
  assert.deepEqual(
    { ...r, perf_json: JSON.parse(r.perf_json) },
    {
      log_path: "/logs/x.log", sha: SHA, ref: "HEAD", dirty: false, started_at: "2026-09-17T10:00:00Z",
      branch: "engineer/x", node_version: "v26.8.2", bash_version: "3.2.57(1)-release",
      patch_version: "patch 2.0-12u11-Apple", os: "Darwin 27.0.0", unit_coverage: "69.74% lines",
      suite_pass: 4, suite_fail: 1, suite_skip: 0, leaked: 0, unit_status: "PASS", secrets_status: "PASS",
      status: "FAIL", finished_at: "2026-09-17T10:10:10Z", duration_ms: 610000,
      perf_json: { agg: { measured_ms: 12, baseline_ms: 5, budget_ms: 60 } },
      lanes: 4, peak_rss_mb: 812, suite_seconds: 790, runner: "rein", peak_sum_rss_mb: 2140, exclusive_seconds: 171,
      slowest_json: JSON.stringify([{ suite: "bad", wall_ms: 93290 }, { suite: "good", wall_ms: 1200 }]),
    });
  assert.equal(parseCiLog("no header here"), null);
});

// E-310 (D-091): extends the parse test above — the resource fields' edge cases.
test("parseCiLog: slowest is the top ten by wall time; an unmeasured RSS stays null; E-309's lanes line still reads", () => {
  const head = [`[ci] sha=${SHA} ref=HEAD dirty=0 started_at=2026-09-17T10:00:00Z`];
  const census = Array.from({ length: 12 }, (_, i) => `CENSUS_SUITE\ts${i}_test.sh\t${(i + 1) * 1000}\t1\t0\t0\t0`);
  const r = parseCiLog([...head, ...census, "[ci] resources lanes=1 peak_rss_mb=- suite_seconds=5 runner=vitest rss_skip=no /usr/bin/time"].join("\n"));
  const slow = JSON.parse(r.slowest_json);
  assert.equal(slow.length, 10);
  assert.deepEqual(slow[0], { suite: "s11", wall_ms: 12000 });
  assert.deepEqual(slow[9], { suite: "s2", wall_ms: 3000 });
  assert.equal(r.peak_rss_mb, null, "peak_rss_mb=- is not a number");
  assert.equal(r.runner, "vitest");
  assert.equal(r.exclusive_seconds, null, "a line from before E-386 has no exclusive_seconds");
  assert.equal(parseCiLog([...head, "[ci] lanes=4"].join("\n")).lanes, 4, "a log from between E-309 and E-310");
});

test("migration: a pre-E-310 ci_runs table gains the resource columns; its old rows still print", () => {
  const t = tmp();
  try {
    mkdirSync(join(t.d, ".ai"));
    const old = new DatabaseSync(join(t.d, ".ai", "state.sqlite"));
    // The table exactly as E-266 created it, holding one row.
    old.exec(`CREATE TABLE ci_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, sha TEXT NOT NULL, ref TEXT, branch TEXT,
      dirty INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
      duration_ms INTEGER, suite_pass INTEGER, suite_fail INTEGER, suite_skip INTEGER, leaked INTEGER,
      unit_status TEXT, unit_coverage TEXT, secrets_status TEXT, node_version TEXT, bash_version TEXT,
      patch_version TEXT, os TEXT, perf_json TEXT, skip_reason TEXT, log_path TEXT)`);
    old.prepare("INSERT INTO ci_runs (sha, status, started_at, suite_pass) VALUES (?, 'PASS', ?, 7)").run(SHA, "2026-09-17T10:00:00Z");
    old.close();
    const db = getDb(join(t.d, ".ai"));
    migrateCiRuns(db);   // twice: the second is a no-op
    const cols = db.prepare("PRAGMA table_info(ci_runs)").all().map((c) => c.name);
    for (const c of ["lanes", "peak_rss_mb", "suite_seconds", "runner", "slowest_json", "peak_sum_rss_mb"]) assert.ok(cols.includes(c), c);
    const cli = join(import.meta.dirname, "..", "..", "src", "shared", "ci-record.mjs");
    const st = execFileSync(process.execPath, ["--no-warnings", cli, "status", "--ai-dir", join(t.d, ".ai"), "--sha", SHA], { encoding: "utf8" });
    assert.match(st, /spent: {4}-\n {2}slowest: {2}-/);
    const ls = execFileSync(process.execPath, ["--no-warnings", cli, "list", "--ai-dir", join(t.d, ".ai")], { encoding: "utf8" });
    assert.match(ls, /L- -\/- -\s+7 passed/);
    assert.doesNotMatch(ls, /slowest:/, "an old row has no slowest line");
    recordCiRun(db, base({ sha: "b".repeat(40), started_at: "2026-09-18T10:00:00Z", lanes: 4, peak_rss_mb: 812, peak_sum_rss_mb: 2140, suite_seconds: 790,
      runner: "rein", slowest_json: [{ suite: "mirror_hygiene", wall_ms: 93290 }] }));
    const ls2 = execFileSync(process.execPath, ["--no-warnings", cli, "list", "--ai-dir", join(t.d, ".ai")], { encoding: "utf8" });
    assert.match(ls2, /L4 812MB\/2140MB 790s/);
    assert.match(ls2, /slowest: mirror_hygiene 93s/);
  } finally { t.done(); }
});

test("recordCiRunFromLog: every column populated; a truncated log records ERROR", () => {
  const { d, db, done } = freshDb();
  try {
    const p = join(d, "run.log");
    // E-303: the runner writes a budget line too; budget_ruling, like skip_reason, is set only
    // by a ruling (`ai ci budget set`), never by a run; shard (E-386) is NULL on a full run.
    writeFileSync(p, `${LOG}\n[ci] budget suites=45 test_lines=39444 fast_tier_seconds=37 full_seconds=418 peak_rss_mb=247 peak_sum_rss_mb=2140\n`);
    const row = db.prepare("SELECT * FROM ci_runs WHERE id = ?").get(recordCiRunFromLog(db, p));
    const empty = Object.entries(row).filter(([k, v]) => v === null && k !== "skip_reason" && k !== "budget_ruling" && k !== "shard").map(([k]) => k);
    assert.deepEqual(empty, [], `unpopulated columns: ${empty}`);
    assert.equal(existsSync(row.log_path), true);

    const cut = join(d, "cut.log");
    writeFileSync(cut, LOG.split("\n").slice(0, 6).join("\n"));
    const r2 = db.prepare("SELECT status FROM ci_runs WHERE id = ?").get(recordCiRunFromLog(db, cut));
    assert.equal(r2.status, "ERROR");
  } finally { done(); }
});

test("ci-record log: prints the skill-eval report filed under the sha, and nothing when none is (E-285)", () => {
  const { d, db, done } = freshDb();
  try {
    const p = join(d, "run.log");
    writeFileSync(p, LOG);
    recordCiRunFromLog(db, p);
    const cli = join(import.meta.dirname, "..", "..", "src", "shared", "ci-record.mjs");
    const evalsDir = join(d, "evals");
    mkdirSync(evalsDir);
    const log = (...extra) => execFileSync(process.execPath,
      ["--no-warnings", cli, "log", "--ai-dir", join(d, ".ai"), "--sha", SHA, "--evals-dir", evalsDir, ...extra], { encoding: "utf8" });
    assert.doesNotMatch(log(), /skill evals:/);
    assert.doesNotMatch(log("--failed"), /skill evals:/);
    writeFileSync(join(evalsDir, `${SHA}.json`), "{}");
    assert.match(log(), new RegExp(`# skill evals: .*${SHA}\\.json\\n$`));
    assert.match(log("--failed"), new RegExp(`broken thing[\\s\\S]*# skill evals: .*${SHA}\\.json\\n$`));
  } finally { done(); }
});

test("verdict: a dirty PASS never certifies; the newest certifying row wins", () => {
  const { db, done } = freshDb();
  try {
    assert.equal(ciVerdict(db, SHA).kind, "NONE");
    recordCiRun(db, base({ dirty: true, started_at: "2026-09-17T09:00:00Z" }));
    assert.equal(ciVerdict(db, SHA).kind, "DIRTY");
    recordCiRun(db, base({ status: "FAIL", started_at: "2026-09-17T09:30:00Z" }));
    assert.equal(ciVerdict(db, SHA).kind, "FAIL");
    // A later dirty PASS does not rescue the failing commit.
    recordCiRun(db, base({ dirty: true, started_at: "2026-09-17T09:45:00Z" }));
    assert.equal(ciVerdict(db, SHA).kind, "FAIL");
    recordCiRun(db, base({ started_at: "2026-09-17T10:00:00Z" }));
    assert.equal(ciVerdict(db, SHA).kind, "PASS");
    assert.equal(latestCiRun(db, SHA).started_at, "2026-09-17T10:00:00Z");
    assert.equal(listCiRuns(db, 2).length, 2);
  } finally { done(); }
});

test("shortLine: PASS, FAIL, DIRTY, NONE and SKIPPED", () => {
  const now = Date.parse("2026-09-17T10:07:00Z");
  const row = base({ suite_pass: 4744, suite_fail: 0, suite_skip: 2, unit_status: "PASS", leaked: 0 });
  assert.equal(shortLine({ kind: "PASS", row }, SHA, now), "PASS aaaaaaa 7m ago (suite 4744/0/2, unit PASS, leaked 0)");
  assert.match(shortLine({ kind: "FAIL", row: { ...row, status: "FAIL" } }, SHA, now), /^FAIL aaaaaaa 7m ago/);
  assert.match(shortLine({ kind: "DIRTY", row: { ...row, dirty: 1 } }, SHA, now), /^DIRTY .*not a certification; run: ai ci run$/);
  assert.equal(shortLine({ kind: "NONE", row: null }, SHA, now), "NONE aaaaaaa — no local CI run; run: ai ci run");
  assert.match(shortLine({ kind: "SKIPPED", row: { ...row, status: "SKIPPED", skip_reason: "hotfix" } }, SHA, now),
    /skipped: hotfix$/);
  assert.equal(ageOf("2026-09-15T10:07:00Z", now), "2d ago");
  assert.equal(ageOf("garbage", now), "?");
});

test("failedSections: only the failing suite, the summary, and nothing that passed", () => {
  const secs = failedSections(LOG).join("\n");
  assert.match(secs, /broken thing/);
  assert.match(secs, /bad_test\.sh \(3 passed, 1 failed\)/);
  assert.doesNotMatch(secs, /── Suite: good_test/);
  assert.deepEqual(failedSections(LOG.replace("  ✗ broken thing (expected exit=0, got 1)\n", "")
    .replace("PASS=3 FAIL=1", "PASS=3 FAIL=0").replace(/━━ Results[\s\S]*?\[ci\] step=suite/, "[ci] step=suite")), []);
  // A passing suite whose assertion LABEL contains the glyph is not a failure (E-267).
  const labelled = LOG.replace("── Suite: good_test ──", "── Suite: good_test ──\n  ✓ doctor reports ✗ for an untested HEAD");
  assert.doesNotMatch(failedSections(labelled).join("\n"), /good_test/);
  const errored = "[ci] sha=x\n[ci] step=deps status=ERROR npm ci failed\nnpm ERR! boom";
  assert.match(failedSections(errored).join("\n"), /npm ERR! boom/);
});

test("pruneCiLogs: newest 14 within 14 days; the fresh log is never removed", () => {
  const { d, done } = tmp();
  try {
    const now = Date.now();
    for (let i = 0; i < 16; i++) {
      const p = join(d, `sha${String(i).padStart(2, "0")}-run.log`);
      writeFileSync(p, "x");
      const t = (now - i * 60_000) / 1000;
      utimesSync(p, t, t);
    }
    const old = join(d, "old-run.log");
    writeFileSync(old, "x");
    const oldT = (now - 20 * 86400_000) / 1000;
    utimesSync(old, oldT, oldT);
    writeFileSync(join(d, "notes.txt"), "not a log");

    const removed = pruneCiLogs(d, { keep: old, now }).sort();
    assert.deepEqual(removed, ["sha14-run.log", "sha15-run.log"]);
    assert.equal(existsSync(old), true, "the kept log survives although it is old");
    assert.equal(readdirSync(d).filter((f) => f.endsWith(".log")).length, 15);
    assert.deepEqual(pruneCiLogs(d, { now }), ["old-run.log"]);
    assert.equal(existsSync(join(d, "notes.txt")), true);
    assert.deepEqual(pruneCiLogs(join(d, "absent")), []);
  } finally { done(); }
});

test("getCiStatus: HEAD default, abbreviated sha, NONE", () => {
  const { d, db, done } = freshDb();
  try {
    assert.equal(getCiStatus(db, d).status, "NONE");   // not a git repo yet
    execFileSync("git", ["init", "-q", d]);
    execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
      "commit", "-q", "--allow-empty", "-m", "x"]);
    const head = execFileSync("git", ["-C", d, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.deepEqual(getCiStatus(db, d), { status: "NONE", sha: head });
    recordCiRun(db, base({ sha: head, suite_pass: 1, suite_fail: 0, suite_skip: 0 }));
    const s = getCiStatus(db, d);
    assert.equal(s.status, "PASS");
    assert.equal(s.verdict, "PASS");
    assert.equal(s.dirty, false);
    assert.match(s.summary, /^PASS /);
    assert.equal(getCiStatus(db, d, head.slice(0, 7)).sha, head);
    assert.equal(getCiStatus(db, d, "not-a-sha").status, "NONE");
  } finally { done(); }
});

// ── E-267: the gates ─────────────────────────────────────────────────────────

function gitRepo(d) {
  const g = (...a) => execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t",
    "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  g("init", "-q");
  const commit = (path, body, msg) => {
    mkdirSync(join(d, path, ".."), { recursive: true });
    writeFileSync(join(d, path), body);
    g("add", "-A");
    g("commit", "-q", "-m", msg);
    return g("rev-parse", "HEAD");
  };
  return { g, commit };
}

test("certifyingRunFor: self, bookkeeping ancestor, code-changing ancestor", () => {
  const { d, db, done } = freshDb();
  try {
    const { commit } = gitRepo(d);
    const tested = commit("src/a.js", "1", "code");
    const book = commit(".ai/TASKS.md", "done", "bookkeeping");
    const code = commit("src/a.js", "2", "more code");

    assert.equal(certifyingRunFor(db, d, tested).ok, false, "nothing recorded yet");
    recordCiRun(db, base({ sha: tested }));
    assert.deepEqual(
      (({ ok, via }) => ({ ok, via }))(certifyingRunFor(db, d, tested)), { ok: true, via: "self" });
    const b = certifyingRunFor(db, d, book);
    assert.deepEqual({ ok: b.ok, via: b.via, sha: b.row.sha, differs: b.differs },
      { ok: true, via: "ancestor", sha: tested, differs: [".ai/TASKS.md"] });
    const c = certifyingRunFor(db, d, code);
    assert.equal(c.ok, false);
    assert.equal(c.row.sha, tested, "the nearest tested ancestor is reported");
    assert.deepEqual(c.differs, ["src/a.js"]);

    // A dirty PASS on the ancestor would not have counted either.
    const { db: db2, d: d2, done: done2 } = freshDb();
    try {
      const r2 = gitRepo(d2);
      const t2 = r2.commit("x", "1", "x");
      const b2 = r2.commit(".ai/y", "1", "y");
      recordCiRun(db2, base({ sha: t2, dirty: true }));
      assert.equal(certifyingRunFor(db2, d2, b2).ok, false);
    } finally { done2(); }
  } finally { done(); }
});

// E-386 (D-135 r3): extends the verdict and certifyingRunFor tests above — one shard of a run
// tests part of the suite, so it is recorded and listed but never certifies a commit.
test("a shard PASS never certifies: not its sha, not as an ancestor, never as a team record", (t) => {
  const { d, db, done } = freshDb();
  try {
    const { commit } = gitRepo(d);
    const tested = commit("src/a.js", "1", "code");
    const book = commit(".ai/TASKS.md", "done", "bookkeeping");
    const head = [`[ci] sha=${tested} ref=HEAD dirty=0 started_at=2026-09-17T10:00:00Z`, "[ci] shard 2/4",
      "[ci] finished status=PASS duration_ms=1000 finished_at=2026-09-17T10:00:01Z"];
    assert.equal(parseCiLog(head.join("\n")).shard, "2/4");
    assert.equal(parseCiLog(head.join("\n").replace("2/4", "5/4")).shard, undefined, "an impossible spec is not a shard");
    const id = recordCiRun(db, parseCiLog(head.join("\n")));
    const v = ciVerdict(db, tested);
    assert.equal(v.kind, "SHARD");
    assert.match(shortLine(v, tested), /^SHARD 2\/4 [0-9a-f]{7} .*shard run PASS, not a certification; run: ai ci run$/);
    assert.equal(certifyingRunFor(db, d, tested).ok, false);
    assert.equal(certifyingRunFor(db, d, book).ok, false, "a shard PASS on the ancestor does not carry a bookkeeping commit");
    assert.equal(checkCiDoneGate(db, d, {}).ok, false);
    assert.equal(writeCiRecord(join(d, ".ai"), db.prepare("SELECT * FROM ci_runs WHERE id = ?").get(id)).written, false);
    recordCiRun(db, base({ sha: tested, started_at: "2026-09-17T11:00:00Z" }));
    assert.equal(ciVerdict(db, tested).kind, "PASS", "the full run certifies");
    assert.equal(certifyingRunFor(db, d, book).via, "ancestor");
  } finally { done(); }
  // In a team project the shard is not written either (an older client would read it as a PASS).
  const { a } = teamClones(t);
  const sdb = getDb(a.ai);
  const sid = recordCiRun(sdb, base({ sha: sha40("e"), shard: "1/4" }));
  const w = writeCiRecord(a.ai, sdb.prepare("SELECT * FROM ci_runs WHERE id = ?").get(sid));
  assert.deepEqual([w.written, w.reason], [false, "shard 1/4 certifies nothing"]);
});

test("ci-record census-stale: MISSING without a committed baseline, FRESH, then STALE past 30 full runs; silent without a census", () => {
  const { d, db, done } = freshDb();
  try {
    const { commit } = gitRepo(d);
    const none = commit("src/a.js", "1", "no census");
    const cs = (sha) => execFileSync("node", ["--no-warnings", CLI, "census-stale", "--ai-dir", join(d, ".ai"), "--sha", sha], { encoding: "utf8" }).trim();
    assert.equal(cs(none), "", "a project without tests/tools/census.mjs gets no baseline and no message");
    const missing = commit("tests/tools/census.mjs", "//", "census");
    assert.equal(cs(missing), "MISSING");
    const withBase = commit("tests/census-baseline.tsv", "# h\nCENSUS_RUN\t2026-09-17T10:00:00Z\tabc\t*_test.sh\n", "baseline");
    const full = (k, over = {}) => recordCiRun(db, base({ sha: sha40(String(k % 10)), started_at: `2026-09-18T10:${String(k).padStart(2, "0")}:00Z`, ...over }));
    for (let k = 0; k < 30; k++) full(k);
    full(40, { shard: "1/4" }); full(41, { dirty: true }); full(42, { status: "FAIL" });
    recordCiRun(db, base({ started_at: "2026-09-16T10:00:00Z" }));   // before the baseline
    assert.equal(cs(withBase), "FRESH 30", "shard, dirty, FAIL and older runs do not age it");
    full(31);
    assert.equal(cs(withBase), "STALE 31");
  } finally { done(); }
});

test("certifyingRunFor: the commit's own FAIL is not rescued by an ancestor; SKIPPED only with allowSkipped", () => {
  const { d, db, done } = freshDb();
  try {
    const { commit } = gitRepo(d);
    const tested = commit("src/a.js", "1", "code");
    const book = commit(".ai/TASKS.md", "x", "book");
    recordCiRun(db, base({ sha: tested }));
    recordCiRun(db, base({ sha: book, status: "FAIL" }));
    assert.deepEqual((({ ok, kind, via }) => ({ ok, kind, via }))(certifyingRunFor(db, d, book)),
      { ok: false, kind: "FAIL", via: "self" });

    const skipped = commit("src/b.js", "1", "hotfix");
    recordCiSkip(db, { sha: skipped, ref: "refs/heads/main", reason: "prod is down" });
    assert.equal(certifyingRunFor(db, d, skipped).ok, false);
    assert.equal(certifyingRunFor(db, d, skipped, { allowSkipped: true }).ok, true);
    assert.equal(latestCiRun(db, skipped).skip_reason, "prod is down");
    assert.throws(() => recordCiSkip(db, { sha: skipped, reason: "  " }), /skip_reason/);
  } finally { done(); }
});

test("checkCiDoneGate: adoption-off, REIN_CI_GATE=0, no-row, FAIL, dirty-only, PASS", () => {
  const { d, db, done } = freshDb();
  try {
    const { commit } = gitRepo(d);
    const head = commit("src/a.js", "1", "code");
    let g = checkCiDoneGate(db, d, {});
    assert.deepEqual({ ok: g.ok, active: g.active }, { ok: true, active: false }, "no rows → inactive");

    const other = "f".repeat(40);
    recordCiRun(db, base({ sha: other }));             // adopted, but nothing for HEAD
    g = checkCiDoneGate(db, d, {});
    assert.equal(g.ok, false);
    assert.equal(g.message,
      `[CI_GATE] no green local CI run for HEAD ${head.slice(0, 7)} (no run for it or for an ancestor that differs only in .ai/) — run: ai ci run (bypass: REIN_CI_GATE=0)`);
    assert.equal(checkCiDoneGate(db, d, { REIN_CI_GATE: "0" }).ok, true);

    recordCiRun(db, base({ sha: head, dirty: true }));
    assert.equal(checkCiDoneGate(db, d, {}).ok, false, "dirty-only does not certify");

    recordCiRun(db, base({ sha: head, status: "FAIL", started_at: "2026-09-17T11:00:00Z" }));
    g = checkCiDoneGate(db, d, {});
    assert.equal(g.ok, false);
    assert.match(g.message, /its run is FAIL/);

    recordCiRun(db, base({ sha: head, started_at: "2026-09-17T12:00:00Z" }));
    g = checkCiDoneGate(db, d, {});
    assert.deepEqual({ ok: g.ok, active: g.active }, { ok: true, active: true });
  } finally { done(); }
});

// ── E-328 (D-102 §Component 5a): portable CI evidence ───────────────────────
// Extends the certifyingRunFor / checkCiDoneGate / ci-record tests above to the tracked
// .ai/ci/<sha>.json records: a member's PASS record certifies on another clone, a FAIL or
// SKIPPED one never does, a record that is not its filename's sha is ignored with a warning,
// and a project without team.json is untouched.

const CLI = join(import.meta.dirname, "..", "..", "src", "shared", "ci-record.mjs");
const cli = (...args) => {
  try {
    const stdout = execFileSync(process.execPath, ["--no-warnings", CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) { return { code: e.status, stdout: e.stdout, stderr: e.stderr }; }
};
const sha40 = (c) => c.repeat(40);
const TEAM = { schema: 1, planner: "a@x.test", claim_ttl_days: 7, shared_log: false,
  members: { "a@x.test": { ranges: { E: [[1, 10]] } }, "b@x.test": { ranges: { E: [[11, 20]] } } } };
const okRecord = (over = {}) => ({
  schema: 1, sha: SHA, verdict: "PASS", suites: 146, tests: { passed: 5732, failed: 0, skipped: 3 },
  started: "2026-10-19T11:16:53Z", finished: "2026-10-19T11:31:12Z", runner: "a@x.test", host: "h", rein_version: "4.0.0",
  ...over,
});

test("validateCiRecord follows tests/fixtures/ci-record-cases.json (one row per rule)", () => {
  const { cases } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "ci-record-cases.json"), "utf8"));
  assert.ok(cases.length >= 15, "the table is not empty");
  for (const c of cases) {
    const why = validateCiRecord(c.replace ?? { ...okRecord(), ...c.patch }, SHA, TEAM);
    if (c.valid) assert.equal(why, null, c.label);
    else assert.ok(why && why.includes(c.match), `${c.label}: got ${why}`);
  }
  assert.match(validateCiRecord(okRecord(), SHA, null), /not a member/, "no team → no member");
});

// origin + two clones of one team project; clone `b` runs CI, clone `a` does not.
function teamClones(t) {
  const root = mkdtempSync(join(tmpdir(), "rein-t-cievid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...a],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "master", origin]);
  const clone = (name, email) => {
    const d = join(root, name);
    execFileSync("git", ["clone", "-q", origin, d], { stdio: "ignore" });
    git(d, "config", "user.email", email);
    git(d, "config", "user.name", name);
    return { d, ai: join(d, ".ai"), g: (...a) => git(d, ...a) };
  };
  const b = clone("b", "b@x.test");
  mkdirSync(b.ai);
  writeFileSync(join(b.ai, "team.json"), JSON.stringify(TEAM, null, 2) + "\n");
  writeFileSync(join(b.d, ".gitignore"), ".ai/state.sqlite*\n");   // per-machine, as in a real project
  mkdirSync(join(b.d, "src"));
  writeFileSync(join(b.d, "src", "a.js"), "1\n");
  b.g("add", "-A"); b.g("commit", "-q", "-m", "code"); b.g("push", "-q", "origin", "HEAD:master");
  const a = clone("a", "a@x.test");
  return { b, a, x: b.g("rev-parse", "HEAD") };
}

test("a member's pulled PASS record lets another clone mark DONE and push the sha without running CI", (t) => {
  const { a, b, x } = teamClones(t);
  // Clone B runs CI on X: the runner records the row and writes the evidence file.
  const dbB = getDb(b.ai);
  const id = recordCiRun(dbB, base({ sha: x, suite_pass: 5732, suite_fail: 0, suite_skip: 3, finished_at: "2026-10-19T11:31:12Z" }));
  const w = writeCiRecord(b.ai, dbB.prepare("SELECT * FROM ci_runs WHERE id = ?").get(id), { suites: 146, reinVersion: "4.0.0" });
  assert.equal(w.written, true, w.reason);
  const rec = JSON.parse(readFileSync(join(b.ai, "ci", `${x}.json`), "utf8"));
  assert.deepEqual(Object.keys(rec).sort(),
    ["rein_version", "finished", "host", "runner", "schema", "sha", "started", "suites", "tests", "verdict"]);
  assert.deepEqual({ verdict: rec.verdict, runner: rec.runner, suites: rec.suites, tests: rec.tests },
    { verdict: "PASS", runner: "b@x.test", suites: 146, tests: { passed: 5732, failed: 0, skipped: 3 } });
  b.g("add", "-A"); b.g("commit", "-q", "-m", "chore(.ai): ci record"); b.g("push", "-q", "origin", "HEAD:master");

  // Clone A: nothing recorded locally.
  const dbA = getDb(a.ai);
  assert.equal(ciRunCount(dbA), 0);
  a.g("pull", "-q", "origin", "master");
  const head = a.g("rev-parse", "HEAD");
  assert.notEqual(head, x, "A is on the bookkeeping commit above X");

  // DONE gate: active (a record is evidence of adoption) and satisfied by B's run.
  const g = checkCiDoneGate(dbA, a.d, {});
  assert.deepEqual({ ok: g.ok, active: g.active }, { ok: true, active: true }, g.message);
  assert.match(g.message, /tested ancestor .* \(record from b@x\.test\), only \.ai\/ differs/);
  const self = certifyingRunFor(dbA, a.d, x, { aiDir: a.ai });
  assert.deepEqual({ ok: self.ok, via: self.via }, { ok: true, via: "record" });
  assert.equal(certifiedBy(self), "PASS record from b@x.test");

  // pre-push gate (the hook execs `ci-record.mjs gate`): X and the bookkeeping tip both leave.
  let r = cli("gate", "--ai-dir", a.ai, "--sha", x, "--ref", "refs/heads/master");
  assert.equal(r.code, 0, r.stderr);
  r = cli("gate", "--ai-dir", a.ai, "--sha", head);
  assert.equal(r.code, 0, r.stderr);
  // `ai ci status <sha>` names the source.
  r = cli("status", "--ai-dir", a.ai, "--sha", x);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /certified by the team record \.ai\/ci\/[0-9a-f]{40}\.json\n {2}runner: {3}b@x\.test/);
  r = cli("status", "--ai-dir", a.ai, "--sha", x, "--short");
  assert.match(r.stdout, /^PASS [0-9a-f]{7} .* — record from b@x\.test\n$/);

  // A code change on top of X is NOT certified by X's record.
  writeFileSync(join(a.d, "src", "a.js"), "2\n");
  a.g("commit", "-qam", "more code");
  r = cli("gate", "--ai-dir", a.ai, "--sha", a.g("rev-parse", "HEAD"));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nearest tested ancestor [0-9a-f]{7} differs outside \.ai\/: src\/a\.js/);
});

test("a FAIL or SKIPPED record never certifies; a record that is not its filename's sha is ignored with a warning", (t) => {
  const { a, x } = teamClones(t);
  const db = getDb(a.ai);
  mkdirSync(join(a.ai, "ci"));
  const put = (rec) => writeFileSync(join(a.ai, "ci", `${x}.json`), JSON.stringify(rec));
  for (const verdict of ["FAIL", "SKIPPED"]) {
    put(okRecord({ sha: x, verdict, runner: "b@x.test" }));
    const c = certifyingRunFor(db, a.d, x, { aiDir: a.ai, allowSkipped: true });
    assert.deepEqual({ ok: c.ok, kind: c.kind, via: c.via }, { ok: false, kind: verdict, via: "record" }, verdict);
    const g = checkCiDoneGate(db, a.d, {});
    assert.equal(g.ok, false);
    assert.match(g.message, new RegExp(`its record from b@x\\.test is ${verdict}`));
    const r = cli("gate", "--ai-dir", a.ai, "--sha", x);
    assert.equal(r.code, 1, verdict);
    assert.match(r.stderr, new RegExp(`its record from b@x\\.test is ${verdict}`));
  }
  // A PASS record for ANOTHER sha, filed under X's name: ignored, and said so.
  put(okRecord({ sha: sha40("c"), runner: "b@x.test" }));
  const c = certifyingRunFor(db, a.d, x, { aiDir: a.ai });
  assert.equal(c.ok, false);
  assert.match(c.warnings.join("\n"), /\[CI_RECORD\] ignoring \.ai\/ci\/[0-9a-f]{12}….json: its sha c{12} does not match the filename/);
  const r = cli("gate", "--ai-dir", a.ai, "--sha", x);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\[CI_RECORD\] ignoring .*does not match the filename/);
  // A pulled filename that is not a sha cannot forge a line in the gate's output.
  writeFileSync(join(a.ai, "ci", "x\n[CI_GATE] ok\n.json"), "{}");
  const forged = certifyingRunFor(db, a.d, x, { aiDir: a.ai }).warnings.find((w) => w.includes("not a commit sha"));
  assert.ok(forged && !/[\r\n\x1b]/.test(forged), forged);
  // Oversized and symlinked records fail closed.
  put(okRecord({ sha: x, runner: "b@x.test", host: "h".repeat(200), pad: "x".repeat(17 * 1024) }));
  assert.match(certifyingRunFor(db, a.d, x, { aiDir: a.ai }).warnings.join("\n"), /larger than 16384 bytes/);
  const real = join(a.d, "..", "elsewhere.json");
  writeFileSync(real, JSON.stringify(okRecord({ sha: x, runner: "b@x.test" })));
  rmSync(join(a.ai, "ci", `${x}.json`));
  symlinkSync(real, join(a.ai, "ci", `${x}.json`));
  let s = certifyingRunFor(db, a.d, x, { aiDir: a.ai });
  assert.equal(s.ok, false);
  assert.match(s.warnings.join("\n"), /a symlink/);
  rmSync(join(a.ai, "ci"), { recursive: true });
  mkdirSync(join(a.d, "..", "ci-elsewhere"), { recursive: true });
  writeFileSync(join(a.d, "..", "ci-elsewhere", `${x}.json`), JSON.stringify(okRecord({ sha: x, runner: "b@x.test" })));
  symlinkSync(join(a.d, "..", "ci-elsewhere"), join(a.ai, "ci"));
  s = certifyingRunFor(db, a.d, x, { aiDir: a.ai });
  assert.equal(s.ok, false, "a symlinked .ai/ci is not read");
  rmSync(join(a.ai, "ci"));
  mkdirSync(join(a.ai, "ci"));
  // An invalid team.json: no record counts; the gates fall back to the local rows.
  put(okRecord({ sha: x, runner: "b@x.test" }));
  const teamFile = join(a.ai, "team.json");
  const teamText = readFileSync(teamFile, "utf8");
  writeFileSync(teamFile, "<<<<<<< ours\n");
  s = certifyingRunFor(db, a.d, x, { aiDir: a.ai });
  assert.equal(s.ok, false);
  assert.match(s.warnings.join("\n"), /\[CI_RECORD\] ignoring \.ai\/ci\/ records: .*team\.json is not valid JSON/);
  writeFileSync(teamFile, teamText);
  // A non-member's PASS is ignored the same way.
  put(okRecord({ sha: x, runner: "mallory@evil.test" }));
  assert.equal(certifyingRunFor(db, a.d, x, { aiDir: a.ai }).ok, false);
  // A local row outranks a record for the same sha.
  put(okRecord({ sha: x, runner: "b@x.test" }));
  assert.equal(certifyingRunFor(db, a.d, x, { aiDir: a.ai }).ok, true);
  recordCiRun(db, base({ sha: x, status: "FAIL" }));
  assert.deepEqual((({ ok, via }) => ({ ok, via }))(certifyingRunFor(db, a.d, x, { aiDir: a.ai })), { ok: false, via: "self" });
});

test("without team.json: no record is written, read or counted (the E-266/E-267 behaviour)", () => {
  const { d, db, done } = freshDb();
  try {
    const { commit } = gitRepo(d);
    const head = commit("src/a.js", "1", "code");
    mkdirSync(join(d, ".ai", "ci"));
    writeFileSync(join(d, ".ai", "ci", `${head}.json`), JSON.stringify(okRecord({ sha: head })));
    assert.equal(hasCiRecords(join(d, ".ai")), false);
    const g = checkCiDoneGate(db, d, {});
    assert.deepEqual({ ok: g.ok, active: g.active }, { ok: true, active: false }, "inactive, as before");
    assert.equal(certifyingRunFor(db, d, head, { aiDir: join(d, ".ai") }).ok, false, "the file is not evidence");
    const id = recordCiRun(db, base({ sha: head }));
    const w = writeCiRecord(join(d, ".ai"), db.prepare("SELECT * FROM ci_runs WHERE id = ?").get(id));
    assert.deepEqual({ written: w.written, reason: w.reason }, { written: false, reason: "not a team project" });
    // `record` through the CLI, as `ai ci run` calls it: the row only.
    const other = sha40("e");
    const log = join(d, "run.log");
    writeFileSync(log, LOG.replaceAll(SHA, other));
    const r = cli("record", "--ai-dir", join(d, ".ai"), "--log", log, "--rein-version", "4.0.0");
    assert.equal(r.code, 0);
    assert.equal(existsSync(join(d, ".ai", "ci", `${other}.json`)), false);
  } finally { done(); }
});

test("ci-record record: a team project gets .ai/ci/<sha>.json (counts only); a dirty run and a teammate's PASS are not overwritten", (t) => {
  const { a } = teamClones(t);
  const log = join(a.d, "..", "run.log");
  writeFileSync(log, LOG);                                   // a FAIL run of SHA with two census suites
  let r = cli("record", "--ai-dir", a.ai, "--log", log, "--rein-version", "4.0.0");
  assert.equal(r.code, 0, r.stderr);
  const p = join(a.ai, "ci", `${SHA}.json`);
  const rec = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual({ ...rec, host: "-" }, {
    schema: 1, sha: SHA, verdict: "FAIL", suites: 2, tests: { passed: 4, failed: 1, skipped: 0 },
    started: "2026-09-17T10:00:00Z", finished: "2026-09-17T10:10:10Z", runner: "a@x.test", host: "-", rein_version: "4.0.0",
  });
  assert.doesNotMatch(readFileSync(p, "utf8"), /broken thing|SUITE_RESULT|engineer\/x/, "no log text");

  // A teammate's PASS for the same sha stays; this machine's FAIL does not replace it.
  writeFileSync(p, JSON.stringify(okRecord({ runner: "b@x.test" })));
  r = cli("record", "--ai-dir", a.ai, "--log", log);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).runner, "b@x.test");

  const db = getDb(a.ai);
  const dirty = sha40("d");
  const id = recordCiRun(db, base({ sha: dirty, dirty: true }));
  const w = writeCiRecord(a.ai, db.prepare("SELECT * FROM ci_runs WHERE id = ?").get(id));
  assert.equal(w.written, false);
  assert.equal(existsSync(join(a.ai, "ci", `${dirty}.json`)), false);
});

test("mergeRecord: two members' records for one sha — PASS beats FAIL either way round, else the later finish; no conflict entry", () => {
  const { d, done } = tmp();
  try {
    const side = (name, rec) => { const p = join(d, name); writeFileSync(p, JSON.stringify(rec)); return p; };
    const pass = okRecord({ runner: "b@x.test" }), fail = okRecord({ verdict: "FAIL", finished: "2026-10-20T00:00:00Z" });
    for (const [ours, theirs] of [[fail, pass], [pass, fail]]) {
      const o = side("ours.json", ours);
      assert.equal(mergeRecord(join(d, "none"), o, side("theirs.json", theirs), ".ai/ci/x.json", { cwd: d }), 0);
      assert.equal(JSON.parse(readFileSync(o, "utf8")).verdict, "PASS");
    }
    const later = okRecord({ runner: "b@x.test", finished: "2026-10-21T00:00:00Z" });
    const o = side("ours.json", okRecord());
    mergeRecord(join(d, "none"), o, side("theirs.json", later), ".ai/ci/x.json", { cwd: d });
    assert.equal(JSON.parse(readFileSync(o, "utf8")).runner, "b@x.test");
    assert.equal(existsSync(join(d, "rein-state-conflicts")), false);
    assert.ok(ATTRIBUTES.includes("ci/*.json merge=rein-record"), "migrate --team routes ci records through the driver");
  } finally { done(); }
});

test("mergeRecord: an invalid PASS (a non-member's) does not erase a member's valid FAIL for the same sha", (t) => {
  const { a } = teamClones(t);
  const side = (name, rec) => { const p = join(a.d, "..", name); writeFileSync(p, JSON.stringify(rec)); return p; };
  const fail = okRecord({ verdict: "FAIL", runner: "b@x.test" });
  const forged = okRecord({ runner: "mallory@evil.test" });
  for (const [ours, theirs] of [[fail, forged], [forged, fail]]) {
    const o = side("ours.json", ours);
    assert.equal(mergeRecord(side("none.json", null), o, side("theirs.json", theirs), `.ai/ci/${SHA}.json`, { cwd: a.d }), 0);
    assert.deepEqual((({ verdict, runner }) => ({ verdict, runner }))(JSON.parse(readFileSync(o, "utf8"))),
      { verdict: "FAIL", runner: "b@x.test" });
  }
});

// ── E-303 (D-088, test-economics.md §Component 7): the test budget ratchet ──
// Extends the ci_runs record above: a run's `[ci] budget …` line becomes budget_json, the best
// per field is the lowest a green non-dirty run recorded since the latest ruling, and only a
// D-### ruling can raise it.
import { budgetBest, budgetCheck, budgetDrift, budgetSet, budgetSummary, driftLine, DRIFT_FIELDS, parseBudgetLine, regressionLine, RATCHET } from "../../src/mcp/shared/ci-budget.js";

const BUDGET = { suites: 45, test_lines: 39444, fast_tier_seconds: 37, full_seconds: 418, peak_rss_mb: 247 };
const budgetRow = (db, b, over = {}) => recordCiRun(db, base({ sha: over.sha || "c".repeat(40), budget_json: JSON.stringify(b), ...over }));

test("E-303: parseCiLog records the run's budget line; a `-` value is left out", () => {
  const run = parseCiLog(`${LOG}\n[ci] budget suites=45 test_lines=39444 fast_tier_seconds=- full_seconds=418 peak_rss_mb=247 peak_sum_rss_mb=-\n`);
  assert.deepEqual(JSON.parse(run.budget_json), { suites: 45, test_lines: 39444, full_seconds: 418, peak_rss_mb: 247 });
  assert.equal(parseCiLog(LOG).budget_json, undefined, "no line, no budget");
  assert.deepEqual(parseBudgetLine("[ci] budget suites=3 bogus=9"), { suites: 3 });
});

test("E-303: one more suite than the recorded budget FAILS, with recorded, measured and slack on one line", () => {
  const { db, done } = freshDb();
  try {
    budgetRow(db, BUDGET);
    const regs = budgetCheck(budgetBest(db).best, { ...BUDGET, suites: 46 });
    assert.equal(regs.length, 1);
    const line = regressionLine(regs[0]);
    assert.match(line, /^\[BUDGET_REGRESSION\] suites: recorded 45, measured 46, slack \+0 \(limit 45\)/);
    assert.equal(line.split("\n").length, 1);
  } finally { done(); }
});

test("E-303: an equal or lower measurement passes and, once recorded, is the new best", () => {
  const { db, done } = freshDb();
  try {
    budgetRow(db, BUDGET);
    assert.deepEqual(budgetCheck(budgetBest(db).best, BUDGET), [], "equal passes");
    const lower = { ...BUDGET, suites: 44, test_lines: 38000 };
    assert.deepEqual(budgetCheck(budgetBest(db).best, lower), [], "lower passes");
    budgetRow(db, lower, { sha: "d".repeat(40), started_at: "2026-09-17T11:00:00Z" });
    assert.equal(budgetBest(db).best.suites, 44);
    assert.equal(budgetCheck(budgetBest(db).best, BUDGET).map((r) => r.field).join(), "suites,test_lines",
      "the old numbers are now over budget: the ratchet only moves down");
  } finally { done(); }
});

test("E-303: the slacks — test_lines +2%, fast tier +10%; full_seconds and memory are recorded, not ratcheted", () => {
  const { db, done } = freshDb();
  try {
    budgetRow(db, BUDGET);
    const best = budgetBest(db).best;
    assert.deepEqual(budgetCheck(best, { test_lines: Math.floor(39444 * 1.02) }), []);
    assert.equal(budgetCheck(best, { test_lines: Math.floor(39444 * 1.02) + 1 })[0].slack, "+2%");
    assert.deepEqual(budgetCheck(best, { fast_tier_seconds: 40 }), []);
    assert.equal(budgetCheck(best, { fast_tier_seconds: 41 })[0].field, "fast_tier_seconds");
    assert.deepEqual(budgetCheck(best, { full_seconds: 9999, peak_rss_mb: 9999 }), []);
    assert.deepEqual(Object.keys(RATCHET).sort(), ["fast_tier_seconds", "suites", "test_lines"]);
  } finally { done(); }
});

test("E-303: only dirty-free PASS rows set the budget", () => {
  const { db, done } = freshDb();
  try {
    budgetRow(db, BUDGET);
    budgetRow(db, { ...BUDGET, suites: 10 }, { sha: "e".repeat(40), dirty: 1 });
    budgetRow(db, { ...BUDGET, suites: 11 }, { sha: "f".repeat(40), status: "FAIL" });
    assert.equal(budgetBest(db).best.suites, 45);
  } finally { done(); }
});

test("E-303: raising the budget needs a D-### ruling, which is written into the record", () => {
  const { db, done } = freshDb();
  try {
    budgetRow(db, BUDGET);
    for (const bad of [undefined, "", "118", "D-1", "P-46", "D-118x"]) {
      assert.throws(() => budgetSet(db, bad, { suites: 46 }), /only by ruling/, String(bad));
    }
    assert.throws(() => budgetSet(db, "D-118", {}), /at least one/);
    assert.throws(() => budgetSet(db, "D-118", { bogus: 1 }), /unknown budget field/);
    budgetRow(db, { ...BUDGET, suites: 40 }, { sha: "9".repeat(40), started_at: "2026-09-17T12:00:00Z" });
    budgetSet(db, "D-118", { suites: 46 });
    const cur = budgetBest(db);
    assert.equal(cur.ruling, "D-118");
    assert.equal(cur.best.suites, 46, "the ruling row is the new floor; the lower rows before it no longer count");
    assert.deepEqual(budgetCheck(cur.best, { ...BUDGET, suites: 46 }), []);
    assert.match(budgetSummary(cur), /suites 46.*ruled by D-118 at 9999999/);
  } finally { done(); }
});

test("E-303: no environment variable lifts the ratchet", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "mcp", "shared", "ci-budget.js"), "utf8");
  assert.doesNotMatch(src, /process\.env/);
});

test("E-303: a fresh store has no budget yet (the first green run sets it)", () => {
  const { db, done } = freshDb();
  try {
    assert.equal(budgetSummary(budgetBest(db)), "no budget recorded yet");
    assert.deepEqual(budgetCheck(budgetBest(db).best, BUDGET), []);
    assert.throws(() => budgetSet(db, "D-118", { suites: 1 }), /no green run/);
  } finally { done(); }
});

// ── E-366 (D-118 r1): timing and RSS are recorded, never ratcheted — a drift LINE only ──
// Extends the E-303 rows: one row per drift field per side of the 25% threshold. Four green runs
// at the base value, then the latest; the median of those five is the base.
const DRIFT_BASE = { full_seconds: 400, peak_rss_mb: 200, peak_sum_rss_mb: 2000 };
const DRIFT_ROWS = DRIFT_FIELDS.flatMap((f) => [
  { field: f, latest: Math.floor(DRIFT_BASE[f] * 1.25), want: [] },                                      // +25%: at the threshold, no line
  { field: f, latest: Math.floor(DRIFT_BASE[f] * 1.25) + 1, want: [f] },                                 // just over it: a line
]);
const driftDb = (latest) => {
  const t = freshDb();
  for (let i = 0; i < 4; i++) budgetRow(t.db, { ...BUDGET, ...DRIFT_BASE }, { sha: String(i).repeat(40), started_at: `2026-10-0${i + 1}T10:00:00Z` });
  budgetRow(t.db, { ...BUDGET, ...DRIFT_BASE, ...latest }, { sha: "9".repeat(40), started_at: "2026-10-09T10:00:00Z" });
  return t;
};
for (const r of DRIFT_ROWS) {
  test(`E-366: ${r.field} latest ${r.latest} vs median ${DRIFT_BASE[r.field]} → ${r.want.length ? "[BUDGET_DRIFT]" : "no line"}`, () => {
    const { db, done } = driftDb({ [r.field]: r.latest });
    try { assert.deepEqual(budgetDrift(db).map((d) => d.field), r.want); } finally { done(); }
  });
}

test("E-366: the drift line's format; fewer than five green runs print nothing; drift never fails or rules", () => {
  const { db, done } = driftDb({ full_seconds: 600 });
  try {
    assert.deepEqual(budgetDrift(db).map(driftLine), ["[BUDGET_DRIFT] full_seconds 600 vs median-of-5 400 (+50%)"]);
    assert.deepEqual(budgetCheck(budgetBest(db).best, { ...BUDGET, ...DRIFT_BASE, full_seconds: 600 }), [], "never a FAIL");
    assert.equal(budgetBest(db).ruling, null, "never a ruling");
  } finally { done(); }
  const few = freshDb();
  try {
    for (let i = 0; i < 4; i++) budgetRow(few.db, { ...DRIFT_BASE, full_seconds: i === 3 ? 9999 : 400 }, { sha: String(i).repeat(40) });
    assert.deepEqual(budgetDrift(few.db), []);
  } finally { few.done(); }
});
