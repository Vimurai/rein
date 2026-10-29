// wal-flusher.test.mjs — E-57: src/shared/wal-flusher.mjs (the node:sqlite WAL checkpoint helper).
// Moved from tests/suites/wal_flusher_node_test.sh (E-302, D-088: the helper needs no hook, tmux
// or installer, so it belongs in the unit layer); the T-FLU-S01..S04 assertions are unchanged.
//
// Contract (wal-checkpoint-node.md): uses node:sqlite (no shell sqlite3); validates db-path
// (required, exists, regular file, .sqlite extension); checkpoints a real WAL-mode DB and leaves
// it queryable; emits structured JSON on stderr on error; boots fast.
//
// The helper runs main() on import and exports nothing, so each case runs it as `node <helper>`.
// The fixture DBs are made with node:sqlite itself, so the old sqlite3-CLI skip is gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FLUSHER = resolve(repo, "src/shared/wal-flusher.mjs");
const run = (...args) => spawnSync(process.execPath, [FLUSHER, ...args], { encoding: "utf8" });

function walDb(t, rows) {
  const dir = mkdtempSync(join(tmpdir(), "rein-t-walflush-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(k INTEGER PRIMARY KEY, v TEXT);");
  const ins = db.prepare("INSERT INTO t(v) VALUES (?)");
  for (const v of rows) ins.run(v);
  db.close();
  return path;
}

// ── T-FLU-S01: file presence and source contract ─────────────────────────────
test("T-FLU-S01: wal-flusher.mjs uses node:sqlite, never a shell-out", () => {
  assert.ok(existsSync(FLUSHER), "src/shared/wal-flusher.mjs exists");
  const src = readFileSync(FLUSHER, "utf8");
  assert.match(src, /from "node:sqlite"/, "imports from node:sqlite");
  assert.match(src, /PRAGMA wal_checkpoint\(TRUNCATE\)/, "executes PRAGMA wal_checkpoint(TRUNCATE)");
  // The whole point of E-58 is to retire the `sqlite3` binary dependency.
  assert.doesNotMatch(src, /child_process|spawnSync|spawn\(|execSync/, "no child_process / spawn / exec shell-out");
  assert.match(src, /function validatePath/, "validates db-path argument shape");
});

// ── T-FLU-S02: behavioural — happy path against a real WAL DB ───────────────
test("T-FLU-S02: checkpoints a real WAL DB, DB stays queryable", (t) => {
  const path = walDb(t, ["alpha", "beta", "gamma"]);
  assert.equal(run(path).status, 0, "wal-flusher.mjs exits 0 on valid DB");
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM t").get().n, 3, "DB rows still readable after checkpoint");
  } finally { db.close(); }
});

// ── T-FLU-S03: validation — rejects bad paths with exit 1 + structured stderr ─
test("T-FLU-S03: missing arg → non-zero exit naming the argument", () => {
  const r = run();
  assert.notEqual(r.status, 0, "missing arg → exits non-zero");
  assert.match(r.stderr, /db-path argument is required/, "missing arg → stderr contains 'db-path argument is required'");
});

// One rule (validatePath), several inputs: rows. `dir` is a directory renamed to end in
// .sqlite so the extension check passes and the regular-file check is the one that fires.
const BAD_PATHS = [
  { label: "non-.sqlite path → rejected", arg: () => "/etc/hosts", want: /extension must be \.sqlite/ },
  { label: "nonexistent .sqlite → 'does not exist'", arg: () => "/tmp/nonexistent-12345.sqlite", want: /does not exist/ },
  { label: "directory → 'not a regular file'", arg: (t) => {
      const d = mkdtempSync(join(tmpdir(), "rein-t-walflush-"));
      renameSync(d, `${d}.sqlite`);
      t.after(() => rmdirSync(`${d}.sqlite`));
      return `${d}.sqlite`;
    }, want: /not a regular file/ },
];
for (const row of BAD_PATHS) {
  test(`T-FLU-S03: ${row.label}`, (t) => assert.match(run(row.arg(t)).stderr, row.want));
}

test("T-FLU-S03: errors emit JSON with service=wal-flusher", () => {
  const d = JSON.parse(run("/etc/hosts").stderr);
  assert.equal(d.service, "wal-flusher");
  assert.equal(d.level, "error");
});

// ── T-FLU-S04: boot time budget ──────────────────────────────────────────────
// E-239 (D-061): the bound is a same-host baseline measured in this run — a bare `node` boot —
// so a loaded machine slows both sides; the absolute 500 ms budget applies only on CI.
test("T-FLU-S04: node wal-flusher.mjs boots within budget", (t) => {
  const path = walDb(t, ["1"]);
  const time = (argv) => { const s = process.hrtime.bigint(); spawnSync(process.execPath, argv); return Number(process.hrtime.bigint() - s) / 1e6; };
  const baseline = time(["-e", ""]);
  const elapsed = time([FLUSHER, path]);
  t.diagnostic(`baseline ${baseline.toFixed(0)} ms, elapsed ${elapsed.toFixed(0)} ms`);
  assert.ok(elapsed <= 3 * baseline + 300, `wal-flusher ${elapsed.toFixed(0)} ms > 3 × ${baseline.toFixed(0)} ms + 300`);
  if (process.env.CI === "true") assert.ok(elapsed < 500, `boots in <500ms (measured ${elapsed.toFixed(0)} ms)`);
});
