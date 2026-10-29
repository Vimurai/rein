// tests/unit/task-usage.test.mjs — node:test unit suite for E-259 (D-077,
// meta-cognition.md §Task Velocity from the Transcript): the transcript reader
// (src/shared/task-usage.mjs), the task_velocity writer's zero refusal, and the migration.
//
// Every transcript is a fixture under its own temp "projects/" root; the store is a temp
// file. Security cases follow the security_engineer E-259 threat model. Run standalone:
//   node --test tests/unit/task-usage.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync, realpathSync, truncateSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import {
  measureTaskWindow, confineTranscriptPath, projectsRoot, responseIsDone, MAX_LINE_BYTES, MAX_FILE_BYTES,
} from "../../src/shared/task-usage.mjs";
import {
  recordTaskVelocity, resetTelemetryCache, downTaskVelocityColumns, VELOCITY_EXTRA_COLUMNS,
} from "../../src/shared/telemetry.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const READER = join(REPO, "src/shared/task-usage.mjs");
const TOOL = "mcp__task-synchronizer-mcp__update_task_status";
const SID = "11111111-2222-3333-4444-555555555555";
const MARKER = "PRIVACY-MARKER-7f3a9c";

// A fixture Claude config dir: <cfg>/projects/<proj>/<session>.jsonl
function fixture() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "aios-t-taskusage-")));
  const cfg = join(d, "claude");
  const proj = join(cfg, "projects", "-fixture-project");
  mkdirSync(proj, { recursive: true });
  const root = join(cfg, "projects");
  return {
    d, cfg, root, proj,
    write(lines, name = `${SID}.jsonl`) {
      const p = join(proj, name);
      writeFileSync(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
      return p;
    },
    done: () => { resetTelemetryCache(); rmSync(d, { recursive: true, force: true }); },
  };
}

// Transcript line builders (the shape Claude Code writes, trimmed to what matters).
const asst = (id, usage, extra = {}) => ({
  type: "assistant", sessionId: SID, isSidechain: false,
  message: { id, role: "assistant", usage, content: [{ type: "text", text: `${MARKER} assistant text` }], ...extra },
});
const U = (i, o, cc = 0, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr });
const doneUse = (msgId, useId, taskId, usage = U(1, 1)) => ({
  type: "assistant", sessionId: SID,
  message: { id: msgId, usage, content: [{ type: "tool_use", id: useId, name: TOOL,
    input: { id: taskId, status: "DONE", summary: `${MARKER} summary` } }] },
});
const result = (useId, ok, taskId) => ({
  type: "user", sessionId: SID,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: useId,
    ...(ok ? {} : { is_error: true }),
    content: [{ type: "text", text: ok ? `✓ ${taskId} → DONE: ${MARKER}` : `✗ [CI_GATE] ${MARKER}` }] }] },
});
const measure = (f, p, id) => measureTaskWindow(p, id, { root: f.root });

// ── counting ─────────────────────────────────────────────────────────────────────────────
test("one message id on 5 lines is counted once (dedupe by message.id)", async () => {
  const f = fixture();
  try {
    const p = f.write([
      asst("m1", U(10, 20, 5, 100)), asst("m1", U(10, 20, 5, 100)), asst("m1", U(10, 20, 5, 100)),
      asst("m1", U(10, 20, 5, 100)), asst("m1", U(10, 20, 5, 100)),
      doneUse("m2", "tu1", "E-1", U(1, 2, 0, 0)),
    ]);
    const r = await measure(f, p, "E-1");
    assert.deepEqual(r, { turn_count: 2, tokens_consumed: 10 + 20 + 5 + 1 + 2, output_tokens: 22,
      cache_read_tokens: 100, session_id: SID });
  } finally { f.done(); }
});

test("a message belongs to the window of its FIRST line, even when a later line crosses the boundary", async () => {
  const f = fixture();
  try {
    // The previous DONE's message (a2) has another line AFTER the boundary tool_use line.
    const p = f.write([
      asst("a1", U(100, 0)), doneUse("a2", "tu1", "E-1", U(40, 0)), asst("a2", U(40, 0)),
      result("tu1", true, "E-1"),
      asst("b1", U(7, 0)), doneUse("b2", "tu2", "E-2", U(1, 0)),
    ]);
    const r2 = await measure(f, p, "E-2");
    assert.equal(r2.tokens_consumed, 8, "a2 stays in E-1's window");
    assert.equal(r2.turn_count, 2);
  } finally { f.done(); }
});

test("two successful DONEs give two disjoint windows (the cursor is the transcript)", async () => {
  const f = fixture();
  try {
    const p = f.write([
      asst("a1", U(100, 0)), doneUse("a2", "tu1", "E-1", U(1, 0)), result("tu1", true, "E-1"),
      asst("b1", U(7, 0)), asst("b2", U(3, 0)), doneUse("b3", "tu2", "E-2", U(1, 0)),
    ]);
    const r1 = await measure(f, p, "E-1");
    const r2 = await measure(f, p, "E-2");
    assert.equal(r1.tokens_consumed, 101);
    assert.equal(r2.tokens_consumed, 11);
    assert.equal(r1.turn_count + r2.turn_count, 5, "every message in exactly one window");
  } finally { f.done(); }
});

test("a REJECTED DONE is not a window boundary", async () => {
  const f = fixture();
  try {
    const p = f.write([
      asst("a1", U(50, 0)), doneUse("a2", "tu1", "E-1", U(1, 0)), result("tu1", false, "E-1"),
      asst("a3", U(9, 0)), doneUse("a4", "tu2", "E-1", U(1, 0)),
    ]);
    const r = await measure(f, p, "E-1");
    assert.equal(r.tokens_consumed, 61, "the retry's window reaches back past the rejected attempt");
    assert.equal(r.turn_count, 4);
  } finally { f.done(); }
});

test("no DONE for the task, or no usage in the window → null (unmeasured, never a zero row)", async () => {
  const f = fixture();
  try {
    const p = f.write([asst("a1", U(5, 5)), doneUse("a2", "tu1", "E-1", U(0, 0))]);
    assert.equal(await measure(f, p, "E-9"), null);
    const q = f.write([doneUse("x1", "tu1", "E-1", U(0, 0))], "empty.jsonl");
    assert.equal(await measure(f, q, "E-1"), null);
  } finally { f.done(); }
});

test("a forged input.id in the transcript is ignored", async () => {
  const f = fixture();
  try {
    const p = f.write([asst("a1", U(5, 5)), doneUse("a2", "tu1", "E-1'; DROP TABLE x;--", U(1, 1))]);
    assert.equal(await measure(f, p, "E-1'; DROP TABLE x;--"), null);
    assert.equal(await measure(f, p, "E-1"), null);
  } finally { f.done(); }
});

test("malformed and over-long lines are skipped; the rest is still measured", async () => {
  const f = fixture();
  try {
    const huge = JSON.stringify(asst("big", U(999999, 999999))).replace(`${MARKER} assistant text`,
      "x".repeat(MAX_LINE_BYTES + 10));
    const p = f.write([`{not json ${MARKER}`, huge, asst("a1", U(4, 4)), doneUse("a2", "tu1", "E-1", U(1, 1))]);
    const r = await measure(f, p, "E-1");
    assert.equal(r.tokens_consumed, 10);
    assert.equal(r.turn_count, 2);
  } finally { f.done(); }
});

// ── confinement and the file itself (security_engineer E-259) ─────────────────────────────
test("a path outside projects/ is refused, including via parent-directory segments and an escaping symlink", async () => {
  const f = fixture();
  try {
    const inside = f.write([asst("a1", U(1, 1)), doneUse("a2", "tu1", "E-1")]);
    const outside = join(f.d, "outside.jsonl");
    writeFileSync(outside, readFileSync(inside));
    assert.equal(confineTranscriptPath(outside, { root: f.root }), null);
    assert.equal(confineTranscriptPath(join(f.proj, "..", "..", "..", "outside.jsonl"), { root: f.root }), null);
    const link = join(f.proj, "link.jsonl");
    symlinkSync(outside, link);
    assert.equal(confineTranscriptPath(link, { root: f.root }), null);
    assert.equal(confineTranscriptPath("relative/x.jsonl", { root: f.root }), null);
    assert.equal(confineTranscriptPath(join(f.proj, "x.txt"), { root: f.root }), null);
    assert.equal(confineTranscriptPath(inside + "\0", { root: f.root }), null);
    assert.ok(confineTranscriptPath(inside, { root: f.root }));
  } finally { f.done(); }
});

test("a FIFO or a device never hangs the reader and is refused", async () => {
  const f = fixture();
  try {
    const fifo = join(f.proj, "fifo.jsonl");
    const mk = spawnSync("mkfifo", [fifo]);
    if (mk.status === 0) {
      const t0 = Date.now();
      assert.equal(await measure(f, fifo, "E-1"), null);
      assert.ok(Date.now() - t0 < 2000, "O_NONBLOCK: the open did not wait for a writer");
    }
    const dev = join(f.proj, "zero.jsonl");
    symlinkSync("/dev/zero", dev);
    assert.equal(await measure(f, dev, "E-1"), null);
  } finally { f.done(); }
});

test("a FIFO with a live writer is refused at once, not read until the writer stops", async () => {
  const f = fixture();
  const fifo = join(f.proj, "live.jsonl");
  if (spawnSync("mkfifo", [fifo]).status !== 0) { f.done(); return; }
  // An endless writer: without the descriptor check the stream never ends.
  const line = JSON.stringify(asst("w", U(1, 1)));
  const writer = spawn("sh", ["-c", `while :; do printf '%s\\n' '${line}'; sleep 0.05; done > '${fifo}'`],
    { stdio: "ignore", detached: true });
  try {
    const t0 = Date.now();
    const r = await Promise.race([
      measure(f, fifo, "E-1"),
      new Promise((res) => setTimeout(() => res("TIMEOUT"), 3000)),
    ]);
    assert.equal(r, null);
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    try { process.kill(-writer.pid, "SIGKILL"); } catch { /* already gone */ }
    f.done();
  }
});

test("a transcript over the size cap is refused on the descriptor, not read", async () => {
  const f = fixture();
  try {
    const p = f.write([asst("a1", U(5, 5)), doneUse("a2", "tu1", "E-1", U(1, 1))]);
    assert.ok(await measure(f, p, "E-1"), "measured while under the cap");
    truncateSync(p, MAX_FILE_BYTES + 1); // sparse: cheap to create, over the cap to fstat
    assert.equal(await measure(f, p, "E-1"), null);
  } finally { f.done(); }
});

test("CLAUDE_CONFIG_DIR inside the project is not trusted as the root", () => {
  const f = fixture();
  try {
    const inProject = join(f.d, "proj", ".claude-evil");
    mkdirSync(join(inProject, "projects"), { recursive: true });
    const r = projectsRoot({ CLAUDE_CONFIG_DIR: inProject }, join(f.d, "proj"));
    assert.notEqual(r, realpathSync(join(inProject, "projects")));
    assert.equal(projectsRoot({ CLAUDE_CONFIG_DIR: f.cfg }, REPO), realpathSync(f.root));
  } finally { f.done(); }
});

// ── the hook's success check ─────────────────────────────────────────────────────────────
test("responseIsDone accepts only a success for THIS task; unknown shapes are false", () => {
  const ok = [{ type: "text", text: "✓ E-7 → DONE: shipped" }];
  assert.equal(responseIsDone(ok, "E-7"), true);
  assert.equal(responseIsDone({ content: ok }, "E-7"), true);
  assert.equal(responseIsDone(ok, "E-8"), false);
  assert.equal(responseIsDone({ content: ok, isError: true }, "E-7"), false);
  assert.equal(responseIsDone([{ type: "text", text: "✗ [CI_GATE] no green run" }], "E-7"), false);
  assert.equal(responseIsDone([{ type: "text", text: "✗ [TASK_LOCKED] 'E-7' is DONE" }], "E-7"), false);
  for (const odd of [null, 42, { foo: 1 }, [{ foo: 1 }]]) assert.equal(responseIsDone(odd, "E-7"), false);
});

// ── the CLI end to end, and privacy ──────────────────────────────────────────────────────
test("the CLI writes one transcript row and no message text reaches the store or stderr", () => {
  const f = fixture();
  try {
    const p = f.write([
      asst("a1", U(10, 10)), `{"broken": "${MARKER}`,
      doneUse("a2", "tu1", "E-3", U(1, 1)),
    ]);
    const db = join(f.d, "telemetry.sqlite");
    const r = spawnSync(process.execPath, [READER, "--record"], {
      input: JSON.stringify({ transcript_path: p, task_id: "E-3",
        tool_response: [{ type: "text", text: `✓ E-3 → DONE: ${MARKER}` }] }),
      env: { ...process.env, CLAUDE_CONFIG_DIR: f.cfg, AI_TELEMETRY_DB_PATH: db, AI_TELEMETRY_DISABLE: "" },
      cwd: REPO, encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(MARKER), "no message text on stdout/stderr");
    const h = new DatabaseSync(db, { readOnly: true });
    try {
      const rows = h.prepare("SELECT * FROM task_velocity").all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source, "transcript");
      assert.equal(rows[0].turn_count, 2);
      assert.equal(rows[0].tokens_consumed, 22);
      assert.equal(rows[0].session_id, SID);
    } finally { h.close(); }
    assert.ok(!readFileSync(db).includes(MARKER), "no message text in the store file");
  } finally { f.done(); }
});

test("the CLI waits for the DONE line Claude Code appends only after the hook has run", async () => {
  const f = fixture();
  try {
    // At hook time the transcript does not yet hold this DONE's tool_use line.
    const p = f.write([asst("a1", U(10, 10))]);
    const db = join(f.d, "telemetry.sqlite");
    const child = spawn(process.execPath, [READER, "--record"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: f.cfg, AI_TELEMETRY_DB_PATH: db }, cwd: REPO, stdio: ["pipe", "ignore", "ignore"],
    });
    // Listen from the start: a reader that gives up at once exits before the append below.
    const exited = new Promise((res) => child.on("exit", res));
    child.stdin.end(JSON.stringify({ transcript_path: p, task_id: "E-4",
      tool_response: [{ type: "text", text: "✓ E-4 → DONE: ok" }] }));
    await new Promise((res) => setTimeout(res, 700));
    appendFileSync(p, JSON.stringify(doneUse("a2", "tu1", "E-4", U(1, 1))) + "\n");
    const code = await Promise.race([exited, new Promise((res) => setTimeout(() => res("TIMEOUT"), 20_000))]);
    if (code === "TIMEOUT") child.kill("SIGKILL");
    assert.equal(code, 0);
    const h = new DatabaseSync(db, { readOnly: true });
    try {
      const rows = h.prepare("SELECT task_id, turn_count FROM task_velocity").all();
      assert.deepEqual(rows.map((r) => [r.task_id, r.turn_count]), [["E-4", 2]]);
    } finally { h.close(); }
  } finally { f.done(); }
});

test("the CLI writes nothing for a rejected DONE, or with AI_OS_TASK_USAGE=0", () => {
  const f = fixture();
  try {
    const p = f.write([asst("a1", U(10, 10)), doneUse("a2", "tu1", "E-3", U(1, 1))]);
    const db = join(f.d, "telemetry.sqlite");
    const run = (resp, extra = {}) => spawnSync(process.execPath, [READER, "--record"], {
      input: JSON.stringify({ transcript_path: p, task_id: "E-3", tool_response: resp }),
      env: { ...process.env, CLAUDE_CONFIG_DIR: f.cfg, AI_TELEMETRY_DB_PATH: db, ...extra }, cwd: REPO,
    });
    run([{ type: "text", text: "✗ [CI_GATE] no green run" }]);
    run([{ type: "text", text: "✓ E-3 → DONE" }], { AI_OS_TASK_USAGE: "0" });
    let n = 0;
    try { const h = new DatabaseSync(db, { readOnly: true }); n = h.prepare("SELECT COUNT(*) AS c FROM task_velocity").get().c; h.close(); }
    catch { n = 0; }
    assert.equal(n, 0);
  } finally { f.done(); }
});

// ── the writer and the migration ─────────────────────────────────────────────────────────
test("recordTaskVelocity never writes an all-zero row", () => {
  const f = fixture();
  try {
    const db = join(f.d, "telemetry.sqlite");
    recordTaskVelocity({ task_id: "E-1", turn_count: 0, tokens_consumed: 0 }, { sync: true, db_path: db });
    recordTaskVelocity({ task_id: "E-2", turn_count: 1, tokens_consumed: 5, source: "transcript" }, { sync: true, db_path: db });
    resetTelemetryCache();
    const h = new DatabaseSync(db, { readOnly: true });
    try { assert.deepEqual(h.prepare("SELECT task_id FROM task_velocity").all().map((r) => r.task_id), ["E-2"]); }
    finally { h.close(); }
  } finally { f.done(); }
});

test("migration: a pre-E-259 table gains the four columns; the down-migration drops them", () => {
  const f = fixture();
  try {
    const db = join(f.d, "telemetry.sqlite");
    const pre = new DatabaseSync(db);
    pre.exec(`CREATE TABLE task_velocity (id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
      turn_count INTEGER NOT NULL CHECK(turn_count >= 0), tokens_consumed INTEGER NOT NULL CHECK(tokens_consumed >= 0),
      timestamp TEXT NOT NULL);
      INSERT INTO task_velocity VALUES ('old', 'E-0', 0, 0, '2026-09-01T00:00:00.000Z');`);
    pre.close();
    recordTaskVelocity({ task_id: "E-1", turn_count: 2, tokens_consumed: 9, output_tokens: 4,
      cache_read_tokens: 30, source: "transcript", session_id: SID }, { sync: true, db_path: db });
    resetTelemetryCache();
    const cols = () => { const h = new DatabaseSync(db, { readOnly: true });
      try { return h.prepare("PRAGMA table_info(task_velocity)").all().map((c) => c.name); } finally { h.close(); } };
    for (const [c] of VELOCITY_EXTRA_COLUMNS) assert.ok(cols().includes(c), `up: ${c}`);
    const h = new DatabaseSync(db, { readOnly: true });
    try {
      const rows = h.prepare("SELECT task_id, source, cache_read_tokens FROM task_velocity ORDER BY rowid").all();
      assert.deepEqual(rows.map((r) => [r.task_id, r.source, r.cache_read_tokens]), [["E-0", null, null], ["E-1", "transcript", 30]]);
    } finally { h.close(); }
    const down = downTaskVelocityColumns(db);
    assert.equal(down.ok, true);
    assert.equal(down.dropped.length, 4);
    for (const [c] of VELOCITY_EXTRA_COLUMNS) assert.ok(!cols().includes(c), `down: ${c}`);
    assert.equal(cols().length, 5, "the original five columns and their rows survive");
  } finally { f.done(); }
});
