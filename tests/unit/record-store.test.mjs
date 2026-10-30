// tests/unit/record-store.test.mjs — the single writer and `rein state migrate` (E-325, D-102 §1)
//
// Extends tests/unit/state-db.test.mjs (which covers addTask/nextId/DAG on a legacy store) to
// the record store: file-before-row ordering, crash repair by rebuildIndex, the --team/--legacy
// round trip, and the MCP write path. git is the process boundary of the migration, so the
// fixtures are real throwaway repositories; no test touches ~/.rein (HOME is a temp dir for
// the spawned server).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { getDb, getDbSeeded, addTask, completeTask, regenerateViews, archiveDoneTasks, DONE_ARCHIVE_THRESHOLD, DONE_KEEP_RECENT } from "../../src/mcp/shared/state-db.js";
import {
  isRecordStore, readRecord, writeRecord, recordPath, listRecords, insertTask, updateTask,
  insertStamp, setProject, rebuildIndex, orderRecords,
} from "../../src/mcp/shared/record-store.mjs";
import { migrateTeam, migrateLegacy, IGNORE_BEGIN, ATTRIBUTES } from "../../src/mcp/shared/record-migrate.mjs";
import { runTaskDone, main as cliMain, GATE_ROLLBACK_VARS } from "../../src/shared/cli-state.mjs";
import { stampForParent } from "../../src/shared/stamp-gate.mjs";
import { tcFixtureHome } from "../lib/toolchain-fixture.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SYNC_SERVER = join(REPO, "src/mcp/task-synchronizer-mcp/index.js");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function tmp(t, tag) {
  const d = mkdtempSync(join(tmpdir(), `rein-rs-${tag}-`));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// A git repo with .ai/ (.gitignore keeps the sqlite out, as `rein init` does).
function repo(t, tag) {
  const root = tmp(t, tag);
  git(root, "init", "-q", "-b", "master");
  git(root, "config", "user.email", "dev-a@example.com");
  git(root, "config", "user.name", "Dev A");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, ".ai"));
  writeFileSync(join(root, ".ai/.gitignore"), "state.sqlite\nstate.sqlite-shm\nstate.sqlite-wal\n");
  return { root, ai: join(root, ".ai") };
}

const commitAll = (root, msg) => { git(root, "add", "-A"); git(root, "commit", "-q", "-m", msg); };

// A legacy project with every shape the views carry: deps, BLOCKED, DONE, stamps, project fields.
function seedLegacy(ai) {
  const db = getDb(ai);
  addTask(ai, db, { owner: "Architect (Claude)", description: "plan it", prefix: "P", tier: 1 });
  addTask(ai, db, { owner: "Engineer (Claude)", description: "build it", tier: 2 });
  addTask(ai, db, { owner: "Engineer (Claude)", description: "ship it", tier: 3, depends_on: ["E-1"] });
  completeTask(ai, db, "P-1", "planned");
  insertStamp(ai, db, { type: "ARCH_PASS", agent: "critic_arch", task_id: "E-1", timestamp: "2026-10-18T10:00:00.000Z", summary: "ok" });
  insertStamp(ai, db, { type: "SEC_PASS", agent: "critic_security", task_id: null, timestamp: "2026-10-18T11:00:00.000Z", summary: "clean" });
  setProject(ai, db, { focus: "E-1 build", current_tier: 2 });
  regenerateViews(ai, db);
  return db;
}

// JSON with keys sorted at every depth — "byte-identical modulo key order".
const canon = (v) => JSON.stringify(v, (_k, x) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);
// A legacy task's updated_at (E-342) is bookkeeping, like a record's rev and origin: a team
// record carries its own, so it is not part of what a migration must restore.
const stateOf = (ai) => {
  const s = JSON.parse(readFileSync(join(ai, "state.json"), "utf8"));
  for (const t of s.tasks || []) delete t.updated_at;
  return canon(s);
};

// A db handle whose task-row writes throw: the crash between the file and the row.
function crashingDb(db, onCrash = () => {}) {
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      if (!/^\s*(INSERT INTO|INSERT OR REPLACE INTO|UPDATE) (tasks|stamps|project)\b/i.test(sql)) return st;
      return { run: () => { onCrash(); throw new Error("simulated crash"); }, get: (...a) => st.get(...a), all: (...a) => st.all(...a) };
    },
    exec: (s) => db.exec(s),
  };
}

// ── legacy projects are untouched ────────────────────────────────────────────

test("a legacy project gets no record files from any mutation", (t) => {
  const { ai } = repo(t, "v1");
  seedLegacy(ai);
  assert.equal(isRecordStore(ai), false);
  for (const p of ["tasks", "stamps", "project.json"]) assert.equal(existsSync(join(ai, p)), false, p);
  assert.match(readFileSync(join(ai, "TASKS.md"), "utf8"), /^# TASKS \(Generated from state\.json\)/);
});

// ── record files ─────────────────────────────────────────────────────────────

test("writeRecord bumps rev, stamps updated_at and origin, and leaves no temp file", (t) => {
  const { ai } = repo(t, "rev");
  mkdirSync(join(ai, "tasks"));
  const a = writeRecord(ai, "task", "E-7", { id: "E-7", status: "OPEN" });
  const b = writeRecord(ai, "task", "E-7", { id: "E-7", status: "DONE" });
  assert.equal(a.rev, 1);
  assert.equal(b.rev, 2);
  assert.equal(b.origin, "dev-a@example.com");
  assert.match(b.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(readdirSync(join(ai, "tasks")), ["E-7.json"]);
});

test("record ids that could leave the store are refused", () => {
  for (const [kind, id] of [["task", "../x"], ["task", "E-1/../../y"], ["stamp", "2026-10/../../z"], ["task-archive", "2026-10/../E-1"]]) {
    assert.throws(() => recordPath("/tmp/x/.ai", kind, id), /invalid/, `${kind} ${id}`);
  }
});

// ── file first, then row; rebuildIndex repairs the gap ───────────────────────

test("insertTask writes the record before the row, and rebuildIndex restores a crashed row", (t) => {
  const { root, ai } = repo(t, "crash-ins");
  seedLegacy(ai); commitAll(root, "seed");
  assert.equal(migrateTeam(ai, { trunk: "master" }).ok, true);
  const db = getDb(ai);
  const task = { id: "E-9", owner: "Engineer (Claude)", status: "OPEN", tier: 1, description: "late", created_at: new Date().toISOString(), depends_on: [] };
  let fileAtCrash = null;
  assert.throws(() => insertTask(ai, crashingDb(db, () => { fileAtCrash = readRecord(ai, "task", "E-9"); }), task), /simulated crash/);
  assert.equal(fileAtCrash?.status, "OPEN", "the record existed when the row write ran");
  assert.equal(db.prepare("SELECT id FROM tasks WHERE id = 'E-9'").get(), undefined);
  rebuildIndex(ai, db);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'E-9'").get().status, "OPEN");
});

test("updateTask writes the record before the row, and rebuildIndex repairs the status", (t) => {
  const { root, ai } = repo(t, "crash-upd");
  seedLegacy(ai); commitAll(root, "seed");
  migrateTeam(ai, { trunk: "master" });
  const db = getDb(ai);
  let fileAtCrash = null;
  assert.throws(() => updateTask(ai, crashingDb(db, () => { fileAtCrash = readRecord(ai, "task", "E-1"); }), "E-1", { status: "BLOCKED" }));
  assert.equal(fileAtCrash.status, "BLOCKED");
  assert.equal(fileAtCrash.rev, 2);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'E-1'").get().status, "OPEN");
  rebuildIndex(ai, db);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'E-1'").get().status, "BLOCKED");
});

test("insertStamp and setProject write the record before the row, and rebuildIndex repairs both", (t) => {
  const { root, ai } = repo(t, "crash-sp");
  seedLegacy(ai); commitAll(root, "seed");
  migrateTeam(ai, { trunk: "master" });
  const db = getDb(ai);
  const stamp = { type: "TESTS_PASS", agent: "critic_tests", task_id: "E-1", timestamp: "2026-10-18T12:00:00.000Z", summary: "green" };
  assert.throws(() => insertStamp(ai, crashingDb(db), stamp), /simulated crash/);
  assert.ok(listRecords(ai, "stamp").some((e) => e.record.type === "TESTS_PASS"), "the stamp record was written first");
  assert.throws(() => setProject(ai, crashingDb(db), { focus: "after crash" }), /simulated crash/);
  assert.equal(readRecord(ai, "project", null).focus, "after crash");
  rebuildIndex(ai, db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stamps WHERE type = 'TESTS_PASS'").get().n, 1);
  assert.equal(db.prepare("SELECT value FROM project WHERE key = 'focus'").get().value, "after crash");
});

test("rebuildIndex refuses a corrupt record and leaves the index as it was", (t) => {
  const { root, ai } = repo(t, "corrupt");
  seedLegacy(ai); commitAll(root, "seed");
  migrateTeam(ai, { trunk: "master" });
  const db = getDb(ai);
  writeFileSync(join(ai, "tasks/E-2.json"), "<<<<<<< HEAD\n{");
  assert.throws(() => rebuildIndex(ai, db), /corrupt record/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 3);
});

// ── migrate --team / --legacy ────────────────────────────────────────────────

test("migrate --team writes one record per task and stamp, project.json last, views untracked", (t) => {
  const { root, ai } = repo(t, "team");
  seedLegacy(ai); commitAll(root, "seed");
  const res = migrateTeam(ai, { trunk: "master" });
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(listRecords(ai, "task").map((e) => e.id).sort(), ["E-1", "E-2", "P-1"]);
  assert.equal(listRecords(ai, "stamp").length, 2);
  assert.match(listRecords(ai, "stamp")[0].id, /^2026-10\/0000000-ARCH_PASS-1$/);
  const project = readRecord(ai, "project", null);
  assert.equal(project.schema, 2);
  assert.equal(project.focus, "E-1 build");
  assert.equal(project.current_tier, 2);
  assert.ok(readFileSync(join(ai, ".gitignore"), "utf8").includes(IGNORE_BEGIN));
  const tracked = git(root, "ls-files", ".ai");
  for (const v of ["state.json", "TASKS.md", "REVIEWS.md"]) assert.ok(!tracked.includes(`.ai/${v}`), `${v} untracked`);
  assert.equal(migrateTeam(ai, { trunk: "master" }).code, "ALREADY_TEAM", "idempotent");
});

test("migrate refuses on a dirty worktree and changes nothing", (t) => {
  const { root, ai } = repo(t, "dirty");
  seedLegacy(ai); commitAll(root, "seed");
  writeFileSync(join(ai, "TASKS.md"), "hand edit\n");
  const res = migrateTeam(ai, { trunk: "master" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "DIRTY_WORKTREE");
  assert.equal(existsSync(join(ai, "project.json")), false);
  assert.equal(existsSync(join(ai, "tasks")), false);
});

// E-341 (D-105 r1): a NEW team.json needs a trunk; with no flag, no origin/HEAD and no origin
// to ask, migrate refuses naming --trunk, before anything is written (same shape as above).
test("migrate refuses [NO_TRUNK] when no trunk can be determined and changes nothing", (t) => {
  const { root, ai } = repo(t, "notrunk");
  seedLegacy(ai); commitAll(root, "seed");
  const res = migrateTeam(ai);
  assert.equal(res.code, "NO_TRUNK");
  assert.equal(res.message, "[NO_TRUNK] origin's default branch could not be determined — pass --trunk <name>");
  for (const f of ["project.json", "tasks", "team.json"]) assert.equal(existsSync(join(ai, f)), false, f);
  assert.equal(migrateTeam(ai, { trunk: "a..b" }).code, "NO_TRUNK", "an invalid --trunk is refused too");
});

test("--team then --legacy restores state.json, key order aside (same clone, deltas kept)", (t) => {
  const { root, ai } = repo(t, "rt");
  const db = seedLegacy(ai);
  db.prepare("INSERT INTO deltas(task_id, summary, files, read) VALUES ('P-1', 'planned', '[]', 0)").run();
  regenerateViews(ai, db);
  commitAll(root, "seed");
  const before = stateOf(ai);
  assert.equal(migrateTeam(ai, { trunk: "master" }).ok, true);
  assert.equal(stateOf(ai), before, "the view is unchanged by --team");
  commitAll(root, "team");
  const res = migrateLegacy(ai);
  assert.equal(res.ok, true, res.message);
  assert.equal(stateOf(ai), before);
  assert.equal(isRecordStore(ai), false);
  assert.ok(!readFileSync(join(ai, ".gitignore"), "utf8").includes(IGNORE_BEGIN));
  assert.equal(migrateLegacy(ai).code, "ALREADY_LEGACY", "idempotent");
});

// A fresh clone has the records and nothing else; its index is built from them.
function roundTripThroughClone(t, tag, seed) {
  const { root, ai } = repo(t, tag);
  seed(ai);
  commitAll(root, "seed");
  const before = stateOf(ai);
  assert.equal(migrateTeam(ai, { trunk: "master" }).ok, true);
  commitAll(root, "team");
  const clone = join(tmp(t, `${tag}-clone`), "c");
  git(dirname(clone), "clone", "-q", root, clone);
  git(clone, "config", "user.email", "dev-b@example.com");
  const cai = join(clone, ".ai");
  assert.equal(existsSync(join(cai, "state.json")), false, "views are not in the clone");
  const cdb = getDbSeeded(cai);
  assert.equal(cdb.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, JSON.parse(before).tasks.length);
  assert.equal(migrateLegacy(cai).ok, true);
  assert.equal(stateOf(cai), before);
}

test("--team then --legacy in a fresh clone restores state.json from the records alone", (t) => {
  roundTripThroughClone(t, "clone", seedLegacy);
});

test("the round trip holds for this repository's own state.json", (t) => {
  const real = join(REPO, ".ai/state.json");
  if (!existsSync(real)) { t.skip("no .ai/state.json in this checkout"); return; }
  roundTripThroughClone(t, "real", (ai) => {
    const s = JSON.parse(readFileSync(real, "utf8"));
    s.deltas = []; // per-machine notices: not records, so a clone starts without them
    writeFileSync(join(ai, "state.json"), JSON.stringify(s, null, 2) + "\n");
    regenerateViews(ai, getDbSeeded(ai));
  });
});

// ── E-348 (D-111 r1): order is per-origin seq, clocks repaired between origins ─────────
// Extends the round trips above: the real-state.json case went red when the clock ran back
// ~14 h (2026-10-23) and the rebuild ordered by created_at first.
const rec = (origin, seq, at, id) => ({ rec: { id, origin, ...(seq == null ? {} : { seq }), created_at: at }, name: id });
const ids = (xs) => orderRecords(xs).map((x) => x.name);

test("one origin whose clock ran backwards rebuilds in seq order", () => {
  const xs = [rec("a@x", 3, "2026-10-23T05:00:00Z", "E-3"), rec("a@x", 1, "2026-10-23T10:00:00Z", "E-1"),
              rec("a@x", 2, "2026-10-23T02:00:00Z", "E-2")];
  assert.deepEqual(ids(xs), ["E-1", "E-2", "E-3"]);
});

test("two origins, one clock an hour behind: each keeps its own order, and the result is deterministic", () => {
  // A wrote A1..A3 at 10:00, 10:10, 10:20; B (clock 1 h slow) wrote B1, B2 at 09:05, 09:15 —
  // really 10:05 and 10:15. Within each origin seq order holds; between origins the repaired time decides.
  const xs = [rec("b@x", 2, "2026-10-23T09:15:00Z", "B2"), rec("a@x", 3, "2026-10-23T10:20:00Z", "A3"),
              rec("a@x", 1, "2026-10-23T10:00:00Z", "A1"), rec("b@x", 1, "2026-10-23T09:05:00Z", "B1"),
              rec("a@x", 2, "2026-10-23T10:10:00Z", "A2")];
  const once = ids(xs);
  assert.deepEqual(once.filter((n) => n.startsWith("A")), ["A1", "A2", "A3"]);
  assert.deepEqual(once.filter((n) => n.startsWith("B")), ["B1", "B2"]);
  assert.deepEqual(ids([...xs].reverse()), once, "the same order from any input order");
  assert.deepEqual(ids(xs), once, "and on a second rebuild");
});

test("within one origin, records without seq (written before it existed) come first, ordered by time", () => {
  const xs = [rec("a@x", 1, "2026-10-23T01:00:00Z", "S-new"), rec("a@x", null, "2026-10-22T09:00:00Z", "S-old2"),
              rec("a@x", null, "2026-10-22T08:00:00Z", "S-old1")];
  assert.deepEqual(ids(xs), ["S-old1", "S-old2", "S-new"]);
});

test("a stamp written now carries seq, and a pre-E-348 stamp file without one still rebuilds", (t) => {
  const { root, ai } = repo(t, "seq");
  seedLegacy(ai);
  commitAll(root, "seed");
  assert.equal(migrateTeam(ai, { trunk: "master" }).ok, true);
  const db = getDb(ai);
  insertStamp(ai, db, { type: "TESTS_PASS", agent: "critic_tests", task_id: "E-1", timestamp: "2026-10-18T12:00:00.000Z", summary: "new" });
  const fresh = listRecords(ai, "stamp").map((e) => e.record).find((r) => r.summary === "new");
  assert.ok(Number.isInteger(fresh.seq), "insertStamp records a seq (nextSeq)");
  assert.ok(listRecords(ai, "stamp").every((e) => Number.isInteger(e.record.seq)), "migrateTeam records seq too");
  writeRecord(ai, "stamp", "2026-10/0000000-OLD_STAMP-1",
    { task_id: null, type: "OLD_STAMP", agent: "x", summary: "pre-E-348", sha: null, author: null, created_at: "2026-10-01T00:00:00.000Z" },
    { fresh: true });
  const n = rebuildIndex(ai, db);
  assert.equal(n.stamps, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM stamps WHERE type = 'OLD_STAMP'").get().c, 1);
});

test("seq stays monotonic per origin across a fresh index (archived records count)", (t) => {
  // Review of E-348: a fresh clone rebuilds state.sqlite from the LIVE records only, so rowids
  // restart low; a new record must still number above every seq its origin already wrote.
  const { root, ai } = repo(t, "hw");
  seedLegacy(ai);
  commitAll(root, "seed");
  assert.equal(migrateTeam(ai, { trunk: "master" }).ok, true);
  writeRecord(ai, "task-archive", "2026-09/E-300", {
    seq: 300, id: "E-300", owner: "Engineer (Claude)", status: "DONE", tier: 1, description: "old", depends_on: [],
    created_at: "2026-09-01T00:00:00.000Z", completed_at: "2026-09-02T00:00:00.000Z", summary: "done",
  }, { fresh: true });
  writeRecord(ai, "stamp", "2026-09/0000000-OLD-1", {
    seq: 500, task_id: null, type: "OLD", agent: "x", summary: "old", sha: null, author: null, created_at: "2026-09-01T00:00:00.000Z",
  }, { fresh: true });
  for (const f of ["state.sqlite", "state.sqlite-shm", "state.sqlite-wal"]) rmSync(join(ai, f), { force: true });
  const db = getDbSeeded(ai);
  assert.ok(db.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM tasks").get().n < 300, "the fresh index restarts low (non-vacuity)");
  insertTask(ai, db, { id: "E-301", owner: "Engineer (Claude)", status: "OPEN", tier: 1, description: "new", depends_on: [],
    created_at: "2026-10-20T00:00:00.000Z" });
  assert.ok(readRecord(ai, "task", "E-301").seq > 300, "the new task's seq is above the archived one");
  insertStamp(ai, db, { type: "NEW", agent: "x", task_id: null, timestamp: "2026-10-20T00:00:00.000Z", summary: "new" });
  const fresh = listRecords(ai, "stamp").map((e) => e.record).find((r) => r.summary === "new");
  assert.ok(fresh.seq > 500, "the new stamp's seq is above the older stamp's");
});

// ── the MCP write path ───────────────────────────────────────────────────────

function callTools(cwd, home, calls) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--no-warnings", SYNC_SERVER], {
      cwd, env: { PATH: process.env.PATH, HOME: home, AI_TELEMETRY_DISABLE: "1", REIN_CI_GATE: "0", REIN_BUILD_STAMP: "0" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const frames = [
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "unit", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      ...calls.map(([name, args], i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name, arguments: args } })),
    ];
    let buf = "";
    const results = new Map();
    const timer = setTimeout(() => { child.kill(); fail(new Error(`server timeout: ${buf.slice(-500)}`)); }, 20000);
    child.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n").slice(0, -1)) {
        try { const m = JSON.parse(line); if (m.id > 0) results.set(m.id, m.result); } catch { /* partial */ }
      }
      if (results.size === calls.length) { clearTimeout(timer); child.kill(); done(calls.map((_c, i) => results.get(i + 1))); }
    });
    // Sequential: each call is sent only after the previous frames, in one write — the server
    // handles requests in order on stdio.
    child.stdin.write(frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
  });
}

test("every task-synchronizer mutation lands in a record file that rebuilds the same index", async (t) => {
  const { root, ai } = repo(t, "mcp");
  seedLegacy(ai); commitAll(root, "seed");
  migrateTeam(ai, { trunk: "master" });
  const home = tmp(t, "home");
  const res = await callTools(root, home, [
    ["add_task", { owner: "Engineer (Claude)", description: "via mcp", tier: 1 }],
    ["update_task_status", { id: "E-1", status: "BLOCKED" }],
    ["update_task_status", { id: "E-2", status: "OPEN", depends_on: [] }],
    ["add_stamp", { type: "TESTS_PASS", agent: "critic_tests", task_id: "E-3", summary: "green" }],
    ["set_project_focus", { focus: "team arc", current_tier: 3 }],
    ["verify_markdown_sync", {}],
  ]);
  assert.match(res.at(-1).content[0].text, /\[SYNC_PASS\]/, "verify_markdown_sync passes on a team project");
  for (const r of res) assert.notEqual(r?.isError, true, JSON.stringify(r));
  assert.equal(readRecord(ai, "task", "E-3").description, "via mcp");
  assert.equal(readRecord(ai, "task", "E-1").status, "BLOCKED");
  assert.deepEqual(readRecord(ai, "task", "E-2").depends_on, []);
  assert.ok(listRecords(ai, "stamp").some((e) => e.record.type === "TESTS_PASS" && e.record.task_id === "E-3"));
  assert.equal(readRecord(ai, "project", null).focus, "team arc");
  // The files alone reproduce the server's view.
  const viewAfterServer = stateOf(ai);
  const clone = join(tmp(t, "mcp-clone"), "c");
  commitAll(root, "mcp writes");
  git(dirname(clone), "clone", "-q", root, clone);
  const cai = join(clone, ".ai");
  regenerateViews(cai, getDbSeeded(cai));
  assert.equal(stateOf(cai), viewAfterServer);
});

// E-342 (D-106 r4): the guard on the MCP path. Extends the case above to a legacy project whose
// HEAD:.ai/state.json holds a task the index lacks (finding 5's shape, written by hand).
test("a legacy index behind HEAD: verify_markdown_sync is [SYNC_FAIL] and add_task refused, nothing written, until the import", async (t) => {
  const { root, ai } = repo(t, "behind");
  seedLegacy(ai); commitAll(root, "seed");
  const doc = JSON.parse(readFileSync(join(ai, "state.json"), "utf8"));
  doc.tasks.push({ ...doc.tasks[1], id: "E-9", description: "pulled", updated_at: "2026-10-26T00:00:00.000Z" });
  writeFileSync(join(ai, "state.json"), JSON.stringify(doc, null, 2) + "\n");
  commitAll(root, "pulled E-9");
  const views = ["TASKS.md", "REVIEWS.md", "state.json"].map((f) => readFileSync(join(ai, f), "utf8"));
  const home = tmp(t, "home");
  const [sync, add] = await callTools(root, home, [["verify_markdown_sync", {}], ["add_task", { owner: "Engineer (Claude)", description: "x" }]]);
  const line = "[STATE_BEHIND_HEAD] HEAD has E-9 the index lacks — run: rein state import";
  assert.match(sync.content[0].text, /^\[SYNC_FAIL\]/);
  assert.ok(sync.content[0].text.includes(line));
  assert.equal(add.isError, true);
  assert.ok(add.content[0].text.includes(line));
  assert.deepEqual(["TASKS.md", "REVIEWS.md", "state.json"].map((f) => readFileSync(join(ai, f), "utf8")), views, "the guard never writes");
  assert.equal(getDb(ai).prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 3);

  assert.equal(cliMain(["state", "import"], root).code, 0);
  const [after] = await callTools(root, home, [["verify_markdown_sync", {}]]);
  assert.match(after.content[0].text, /^\[SYNC_PASS\]/);
  assert.match(readFileSync(join(ai, "TASKS.md"), "utf8"), /- \[ \] E-9: pulled/);
});

// E-344 (D-108 r6-r8): the bonkraft incident — a read-only opener created an EMPTY state.sqlite
// next to a committed state.json, and the next regeneration rewrote the views from it.
const VIEWS = ["TASKS.md", "REVIEWS.md", "state.json"];
const views = (ai) => VIEWS.map((f) => readFileSync(join(ai, f), "utf8"));
function emptyIndex(ai) {
  for (const f of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]) rmSync(join(ai, f), { force: true });
  const p = join(ai, "state.sqlite");
  const db = new DatabaseSync(p);   // what a plain getDb() opener left behind: schema, no rows
  db.exec("CREATE TABLE project (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN', tier INTEGER, description TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, summary TEXT, depends_on TEXT)");
  return db;
}

test("an empty index next to a committed state.json is seeded by the next opener: the task is found, [SYNC_PASS], views unchanged", async (t) => {
  const { root, ai } = repo(t, "bonkraft");
  seedLegacy(ai); commitAll(root, "seed");
  emptyIndex(ai).close();
  const home = tmp(t, "home");
  const [sync] = await callTools(root, home, [["verify_markdown_sync", {}]]);
  assert.match(sync.content[0].text, /^\[SYNC_PASS\]/, sync.content[0].text);
  assert.deepEqual(views(ai), VIEWS.map((f) => git(root, "show", `HEAD:.ai/${f}`)), "byte-identical to HEAD");
  const [upd] = await callTools(root, home, [["update_task_status", { id: "E-1", status: "BLOCKED" }]]);
  assert.notEqual(upd.isError, true, JSON.stringify(upd));
  assert.match(readFileSync(join(ai, "TASKS.md"), "utf8"), /- \[ \] P-1|- \[x\] P-1/, "the rest of the tasks are still in the view");
});

test("with the seed off (an import on record) an empty index is refused: [STATE_BEHIND_HEAD], or [EMPTY_STATE_DB] without git; nothing written", async (t) => {
  const { root, ai } = repo(t, "seedoff");
  seedLegacy(ai); commitAll(root, "seed");
  const db = emptyIndex(ai);
  db.prepare("INSERT INTO project(key, value) VALUES ('last_import_blob', 'deadbeef')").run();
  db.close();
  const before = views(ai);
  const home = tmp(t, "home");
  const [sync] = await callTools(root, home, [["verify_markdown_sync", {}]]);
  assert.match(sync.content[0].text, /^\[SYNC_FAIL\][\s\S]*\[STATE_BEHIND_HEAD\] HEAD has E-1\.\.P-1 the index lacks — run: rein state import/);
  assert.deepEqual(views(ai), before);

  rmSync(join(root, ".git"), { recursive: true, force: true });   // no git: nothing to compare with
  const [nogit] = await callTools(root, home, [["verify_markdown_sync", {}]]);
  assert.match(nogit.content[0].text, /\[EMPTY_STATE_DB\] index has 0 tasks, TASKS\.md lists 3 — run: rein state import/);
  assert.deepEqual(views(ai), before, "no auto-fix from an empty index");
  // …and the advice works: the import takes the working state.json when nothing is committed.
  const imp = spawnSync(process.execPath, ["--no-warnings", join(REPO, "src/shared/cli-state.mjs"), "state", "import"], { cwd: root, encoding: "utf8", env: { ...process.env, AI_TELEMETRY_DISABLE: "1" } }).stdout;
  assert.match(imp, /^\[STATE_IMPORT\] legacy: \+3 tasks \(E-1\.\.P-1\), ~0 updated, \+2 stamps from the working state\.json$/m);
  assert.equal(new DatabaseSync(join(ai, "state.sqlite")).prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 3);
});

test("a project whose state.json has zero tasks stays empty, and reseeding never duplicates its stamps", (t) => {
  const { root, ai } = repo(t, "zero");
  writeFileSync(join(ai, "state.json"), JSON.stringify({ version: "1.0", project: { focus: null }, tasks: [], stamps: [{ type: "X", agent: "a", task_id: null, timestamp: "2026-10-01T00:00:00.000Z", summary: "s" }], deltas: [] }));
  commitAll(root, "zero");
  for (let i = 0; i < 3; i++) {
    const db = getDbSeeded(ai);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stamps").get().n, 1);
  }
});

test("rein doctor's State Health names rein state import for an empty or behind index, and migrate-state only when the view is all there is", (t) => {
  const { root, ai } = repo(t, "doctor");
  seedLegacy(ai); commitAll(root, "seed");
  emptyIndex(ai).close();
  // A child process: this one's getDb cache still holds the index emptyIndex() replaced.
  const health = (...a) => spawnSync(process.execPath, ["--no-warnings", join(REPO, "src/shared/cli-state.mjs"), "state", "health", ...a], { cwd: root, encoding: "utf8", env: { ...process.env, AI_TELEMETRY_DISABLE: "1" } }).stdout;
  const out = health();
  assert.match(out, /index: tasks=0, stamps=0 · HEAD state\.json: tasks=3/);
  assert.match(out, /WARN: the index is empty but HEAD has 3 task\(s\) — run: rein state import/);
  assert.doesNotMatch(out, /migrate-state/);
  assert.match(health("--repair"), /repaired: rein state import/);
  assert.match(health("--short"), /^OK — the index is in step with HEAD$/m);

  const bare = repo(t, "doctor-bare");
  writeFileSync(join(bare.ai, "TASKS.md"), "# TASKS (Generated from state.json)\n\n## Engineer\n- [ ] E-1: only the view\n");
  assert.match(cliMain(["state", "health"], bare.root).out, /run: rein migrate-state \(rebuilds from the view; lossy\)/);
});

test("rein migrate-state refuses [LOSSY_RESEED] when HEAD's state.json holds more tasks than TASKS.md, unless --from-tasks", (t) => {
  const { root, ai } = repo(t, "lossy");
  seedLegacy(ai); commitAll(root, "seed");
  writeFileSync(join(ai, "TASKS.md"), "# TASKS (Generated from state.json)\n\n## Engineer\n- [ ] E-1: build it\n");
  rmSync(join(ai, "state.json"));
  const h = tmp(t, "h");
  tcFixtureHome(h);   // E-345 (D-109 r1): the toolchain record the hooks pin
  const run = (...a) => spawnSync("bash", [join(REPO, "src/bin/rein"), "migrate-state", ...a], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: h, AI_TELEMETRY_DISABLE: "1" } });
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\[LOSSY_RESEED\] HEAD:\.ai\/state\.json has 3 tasks, TASKS\.md lists 1 — run: rein state import/);
  assert.doesNotMatch(run("--from-tasks").stdout, /LOSSY_RESEED/);
});

test("every opener of a project's state.sqlite outside state-db.js seeds it (getDbSeeded, never getDb)", () => {
  const offenders = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(m?js)$/.test(e.name) || p.endsWith(join("shared", "state-db.js"))) continue;
      const src = readFileSync(p, "utf8");
      if (/import\s*\{[^}]*\bgetDb\b[^}]*\}\s*from\s*["'][^"']*state-db\.js["']/.test(src)) offenders.push(p.slice(REPO.length + 1));
    }
  };
  walk(join(REPO, "src"));
  assert.deepEqual(offenders, []);
});

// ── `rein task done` (the post-commit "Fixes E-##" path) ───────────────────────

test("rein task done closes through completeTask: record, cascade, views", (t) => {
  const { root, ai } = repo(t, "done");
  seedLegacy(ai); commitAll(root, "seed");
  migrateTeam(ai, { trunk: "master" });
  const env = { REIN_CI_GATE: "0" };
  const res = runTaskDone(ai, "E-1", "closed by commit abc1234", { env });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /E-1 → DONE.*unblocked: E-2/);
  assert.equal(readRecord(ai, "task", "E-1").status, "DONE");
  assert.equal(readRecord(ai, "task", "E-2").status, "OPEN", "the cascade wrote the record too");
  assert.match(readFileSync(join(ai, "TASKS.md"), "utf8"), /- \[x\] E-1: build it/);
  assert.equal(runTaskDone(ai, "E-1", null, { env }).out, "E-1 is already DONE.");
  assert.equal(runTaskDone(ai, "E-99", null, { env }).code, 1);
  assert.equal(runTaskDone(ai, "../E-1", null, { env }).code, 2);
});

// ── one writer of state.json ─────────────────────────────────────────────────

test("no file outside record-store.mjs writes .ai/state.json", () => {
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { if (f !== "node_modules" && f !== "templates") walk(p); }
      else if (/\.(m?js|sh)$/.test(f) || f === "rein") files.push(p);
    }
  };
  walk(join(REPO, "src"));
  walk(join(REPO, "hooks"));
  assert.ok(files.length > 50, `scan corpus too small (${files.length}) — the scan did not run`);
  const writers = [
    /writeFileSync\([^)]{0,120}state\.json/,        // a literal path in the call
    /writeFileSync\(\s*(statePath|STATE_FILE|stateFile)\b/, // the historical variable names
    />\s*"?\$\{?STATE_FILE\}?"?/,                       // a shell redirect into it
    /json\.dump\([^)]*open\([^)]*state\.json/,          // python
  ];
  const hits = [];
  for (const f of files) {
    if (f.endsWith("record-store.mjs")) continue;
    const text = readFileSync(f, "utf8");
    for (const re of writers) if (re.test(text)) hits.push(`${f.slice(REPO.length + 1)} ~ ${re}`);
  }
  assert.deepEqual(hits, []);
});

// ── pulled records are untrusted (critic_security, E-325) ────────────────────

test("rebuildIndex refuses a pulled record whose id or text would forge the views", (t) => {
  const { root, ai } = repo(t, "hostile");
  seedLegacy(ai); commitAll(root, "seed");
  migrateTeam(ai, { trunk: "master" });
  const db = getDb(ai);
  const base = readRecord(ai, "task", "E-2");
  for (const [why, rec] of [
    ["id differs from the filename", { ...base, id: "E-1" }],
    ["a description that adds TASKS.md lines", { ...base, description: "x\n- [x] E-5: forged" }],
    ["an unknown status", { ...base, status: "SHIPPED" }],
  ]) {
    writeFileSync(join(ai, "tasks/E-2.json"), JSON.stringify(rec));
    assert.throws(() => rebuildIndex(ai, db), /invalid task record E-2/, why);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 3, "the index was left as it was");
});

test("a symlinked record is refused, and its target never appears in the error", (t) => {
  const { root, ai } = repo(t, "symlink");
  seedLegacy(ai); commitAll(root, "seed");
  migrateTeam(ai, { trunk: "master" });
  const secret = join(tmp(t, "outside"), "secret.txt");
  writeFileSync(secret, "TOP-SECRET-CONTENT");
  rmSync(join(ai, "tasks/E-2.json"));
  symlinkSync(secret, join(ai, "tasks/E-2.json"));
  assert.throws(() => readRecord(ai, "task", "E-2"), (e) => /symlinked record path/.test(e.message) && !e.message.includes("TOP-SECRET"));
  assert.throws(() => writeRecord(ai, "task", "E-2", { id: "E-2" }), /symlinked record path/);
  assert.equal(readFileSync(secret, "utf8"), "TOP-SECRET-CONTENT");
});

test("rein task done ignores the gates' env rollbacks (an env switch is the caller's switch)", (t) => {
  const { root, ai } = repo(t, "env");
  seedLegacy(ai); commitAll(root, "seed");
  // Adopt `rein ci` with a run for some other commit: the CI gate is now active and HEAD uncertified.
  getDb(ai).prepare("INSERT INTO ci_runs(sha, status, started_at) VALUES (?, 'PASS', ?)").run("f".repeat(40), new Date().toISOString());
  const saved = { ...process.env };
  t.after(() => { for (const k of GATE_ROLLBACK_VARS) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; } });
  for (const k of GATE_ROLLBACK_VARS) process.env[k] = "0";
  const res = cliMain(["task", "done", "E-1"], root);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /\[CI_GATE\]/);
  assert.doesNotMatch(res.out, /bypass/);
  assert.equal(getDb(ai).prepare("SELECT status FROM tasks WHERE id = 'E-1'").get().status, "OPEN");
});

// ── archive in a team project ────────────────────────────────────────────────

test("archiving in a team project moves the records before the rows, and the round trip still holds", (t) => {
  const { root, ai } = repo(t, "archive");
  seedLegacy(ai); commitAll(root, "seed");
  migrateTeam(ai, { trunk: "master" });
  const db = getDb(ai);
  const n = DONE_ARCHIVE_THRESHOLD + 5;
  for (let i = 0; i < n; i++) {
    const { task } = addTask(ai, db, { owner: "Engineer (Claude)", description: `bulk ${i}` });
    completeTask(ai, db, task.id, "done");
  }
  const done = n + 1; // P-1 from the seed
  const res = archiveDoneTasks(ai, db);
  assert.equal(res.archived, done - DONE_KEEP_RECENT);
  const archived = listRecords(ai, "task-archive");
  assert.equal(archived.length, done - DONE_KEEP_RECENT, "every archived row's record moved");
  assert.equal(listRecords(ai, "task").length, db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, "live records = live rows");
  const view = stateOf(ai);
  rebuildIndex(ai, db);
  regenerateViews(ai, db);
  assert.equal(stateOf(ai), view, "a rebuild does not resurrect archived tasks");
  commitAll(root, "archived");
  assert.equal(migrateLegacy(ai).ok, true);
  assert.equal(stateOf(ai), view);
});

test("rein task done refuses through the gates with the default env and changes nothing", (t) => {
  const { root, ai } = repo(t, "refuse");
  seedLegacy(ai); commitAll(root, "seed");
  migrateTeam(ai, { trunk: "master" });
  getDb(ai).prepare("INSERT INTO ci_runs(sha, status, started_at) VALUES (?, 'PASS', ?)").run("e".repeat(40), new Date().toISOString());
  const before = readRecord(ai, "task", "E-1");
  const res = runTaskDone(ai, "E-1", "x");
  assert.equal(res.code, 1);
  assert.match(res.out, /\[CI_GATE\]/);
  assert.deepEqual(readRecord(ai, "task", "E-1"), before, "the record is untouched");
  assert.equal(cliMain(["task", "done"], root).code, 2, "usage");
  assert.equal(cliMain(["task", "done", "E-1", "--bogus"], root).code, 2, "unknown flag");
  assert.equal(cliMain(["state", "migrate"], root).code, 2, "migrate needs a mode");
});

test("a team project with no tasks is still a team project in a fresh clone (project.json is the marker)", (t) => {
  const { root, ai } = repo(t, "empty");
  writeFileSync(join(ai, "state.json"), JSON.stringify({ version: "1.0", project: {}, tasks: [], stamps: [] }));
  commitAll(root, "seed");
  assert.equal(migrateTeam(ai, { trunk: "master" }).ok, true);
  commitAll(root, "team");
  const clone = join(tmp(t, "empty-clone"), "c");
  git(dirname(clone), "clone", "-q", root, clone);
  assert.equal(existsSync(join(clone, ".ai/tasks")), false, "git carries no empty directory");
  assert.equal(isRecordStore(join(clone, ".ai")), true);
});

test("--team writes .ai/.gitattributes; --legacy removes it, but keeps one the user edited", (t) => {
  const { root, ai } = repo(t, "attrs");
  seedLegacy(ai); commitAll(root, "seed");
  migrateTeam(ai, { trunk: "master" });
  assert.equal(readFileSync(join(ai, ".gitattributes"), "utf8"), ATTRIBUTES);
  commitAll(root, "team");
  assert.equal(migrateLegacy(ai).ok, true);
  assert.equal(existsSync(join(ai, ".gitattributes")), false);
  commitAll(root, "legacy");
  migrateTeam(ai, { trunk: "master" });
  writeFileSync(join(ai, ".gitattributes"), ATTRIBUTES + "*.md diff=markdown\n");
  commitAll(root, "user edit");
  migrateLegacy(ai);
  assert.match(readFileSync(join(ai, ".gitattributes"), "utf8"), /diff=markdown/);
  // E-328: a project migrated before ci/*.json joined the attributes still gets its file removed.
  commitAll(root, "legacy again");
  migrateTeam(ai, { trunk: "master" });
  writeFileSync(join(ai, ".gitattributes"), ATTRIBUTES.replace("ci/*.json merge=rein-record\n", ""));
  commitAll(root, "pre-E-328 attributes");
  assert.equal(migrateLegacy(ai).ok, true);
  assert.equal(existsSync(join(ai, ".gitattributes")), false);
});

// ── E-329 (D-102 §Component 6): a stamp names the commit it reviewed ──────────
// Extends the insertStamp / rebuildIndex / view tests above with sha + author; pre-commit
// Gate 2 itself is driven through the real hook in tests/suites/git_lane_test.sh (E-329.*).

test("every stamp — legacy or team — records HEAD and the git email; the views show them; an older stamp reads as before", (t) => {
  const { root, ai } = repo(t, "stampsha");
  const db = getDb(ai);
  insertStamp(ai, db, { type: "ARCH_PASS", agent: "a", timestamp: "2026-10-01T00:00:00.000Z", summary: "before any commit" });
  writeFileSync(join(root, "README"), "x\n"); commitAll(root, "base");
  const head = git(root, "rev-parse", "HEAD").trim();
  insertStamp(ai, db, { type: "CRITIC_STAMP", agent: "b", timestamp: "2026-10-19T00:00:00.000Z", summary: "reviewed" });
  assert.deepEqual(db.prepare("SELECT sha, author FROM stamps ORDER BY id").all().map((r) => ({ ...r })),
    [{ sha: null, author: "dev-a@example.com" }, { sha: head, author: "dev-a@example.com" }]);
  regenerateViews(ai, db);
  const state = JSON.parse(readFileSync(join(ai, "state.json"), "utf8"));
  assert.equal("sha" in state.stamps[0], false, "no HEAD → no sha key: the view reads as before");
  assert.deepEqual([state.stamps[1].sha, state.stamps[1].author], [head, "dev-a@example.com"]);
  const reviews = readFileSync(join(ai, "REVIEWS.md"), "utf8");
  assert.match(reviews, /^\[ARCH_PASS\] 2026-10-01 \| before any commit$/m);
  assert.match(reviews, new RegExp(`^\\[CRITIC_STAMP\\] 2026-10-19 \\| ${head.slice(0, 7)} dev-a@example\\.com \\| reviewed$`, "m"));

  // --team carries sha/author into the record; rebuildIndex brings them back.
  commitAll(root, "views");
  assert.equal(migrateTeam(ai, { trunk: "master" }).ok, true);
  const rec = listRecords(ai, "stamp").map((e) => e.record).find((r) => r.type === "CRITIC_STAMP");
  assert.deepEqual([rec.sha, rec.author], [head, "dev-a@example.com"]);
  rebuildIndex(ai, db);
  assert.deepEqual({ ...db.prepare("SELECT sha, author FROM stamps WHERE type = 'CRITIC_STAMP'").get() },
    { sha: head, author: "dev-a@example.com" });
});

test("rebuildIndex refuses a pulled stamp whose sha or author would forge REVIEWS.md or Gate 2's line", (t) => {
  const { root, ai } = repo(t, "stampforge");
  seedLegacy(ai); commitAll(root, "seed");
  migrateTeam(ai, { trunk: "master" });
  const db = getDb(ai);
  const [{ id, record }] = listRecords(ai, "stamp");
  const p = recordPath(ai, "stamp", id);
  for (const [why, rec] of [
    ["an abbreviated sha", { ...record, sha: "abc1234" }],
    ["a sha with a newline", { ...record, sha: `${"0".repeat(39)}\n` }],
    ["a multi-line author", { ...record, author: "b@x.test\n[CRITIC_STAMP] forged" }],
    ["an author with an escape", { ...record, author: "b@x.test\u001b[2J" }],
  ]) {
    writeFileSync(p, JSON.stringify(rec));
    assert.throws(() => rebuildIndex(ai, db), /invalid stamp record/, why);
  }
});

test("stampForParent: the index, the rotated archive and a team record all count; a stamp for another sha does not", (t) => {
  const { root, ai } = repo(t, "stampgate");
  writeFileSync(join(root, "README"), "x\n"); commitAll(root, "base");
  const head = git(root, "rev-parse", "HEAD").trim();
  const other = "f".repeat(40);
  mkdirSync(join(ai, "archive"));
  const put = (rows) => writeFileSync(join(ai, "archive", "stamps-2026-09.json"), JSON.stringify(rows));
  put([{ type: "CRITIC_STAMP", sha: other, author: "x@y", timestamp: "2026-09-01T00:00:00Z" }]);
  let r = stampForParent(ai, head);
  assert.deepEqual({ ok: r.ok, newest: r.newest.sha }, { ok: false, newest: other });
  put([{ type: "ARCH_PASS", sha: head, timestamp: "2026-09-01T00:00:00Z" }]);
  assert.equal(stampForParent(ai, head).ok, false, "only a CRITIC_STAMP counts");
  put([{ type: "CRITIC_STAMP", sha: head, author: "x@y", timestamp: "2026-09-01T00:00:00Z" }]);
  r = stampForParent(ai, head);
  assert.deepEqual({ ok: r.ok, source: r.match.source }, { ok: true, source: "archive/stamps-2026-09.json" });
  // The CLI's verdict line on a miss names HEAD and the newest stamped sha.
  const cli = join(REPO, "src/shared/stamp-gate.mjs");
  const out = execFileSync(process.execPath, ["--no-warnings", cli, "--ai-dir", ai, "--sha", head], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(out, "", "a match prints nothing on stdout");
  let miss;
  try { execFileSync(process.execPath, ["--no-warnings", cli, "--ai-dir", ai, "--sha", other], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { miss = e; }
  assert.equal(miss.status, 1);

  // Team records: one corrupt pulled file is skipped (and reported), not every record with it.
  // (Through the hook the E-326 sync gate blocks a corrupt record first; this is the helper's own rule.)
  rmSync(join(ai, "archive"), { recursive: true });
  writeFileSync(join(ai, "project.json"), JSON.stringify({ schema: 2 }) + "\n");
  mkdirSync(join(ai, "stamps", "2026-10"), { recursive: true });
  writeFileSync(join(ai, "stamps", "2026-10", "0000000-ARCH_PASS-1.json"), "<<<<<<< conflict");
  const s = { type: "CRITIC_STAMP", agent: "c", summary: "ok", timestamp: "2026-10-19T09:00:00Z", author: "b@x.test" };
  writeRecord(ai, "stamp", `2026-10/${head.slice(0, 7)}-CRITIC_STAMP-1`, { ...s, sha: head, created_at: s.timestamp }, { fresh: true });
  const warnings = [];
  r = stampForParent(ai, head, warnings);
  assert.deepEqual({ ok: r.ok, source: r.match?.source, author: r.match?.author }, { ok: true, source: "record", author: "b@x.test" });
  assert.match(warnings.join("\n"), /\[GATE2\] stamp record skipped: corrupt record .*0000000-ARCH_PASS-1\.json/);
  assert.throws(() => listRecords(ai, "stamp"), /corrupt record/, "the default (rebuildIndex's) still refuses");
  assert.match(miss.stdout, new RegExp(`^\\[GATE2\\] no CRITIC_STAMP for HEAD fffffff — the newest CRITIC_STAMP is for ${head.slice(0, 7)} \\(by x@y on 2026-09-01\\)\\n$`));
});
