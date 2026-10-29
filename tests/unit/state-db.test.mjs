// tests/unit/state-db.test.mjs — node:test unit suite for src/mcp/shared/state-db.js (E-206)
//
// Deterministic, coverage-measured unit layer for the pure/core state logic that
// underpins the whole Triad: DAG validation, dependency parsing, monotonic ID
// allocation, role derivation, and the single-source addTask write path.
//
// Uses a REAL throwaway SQLite DB per test (no mocks) so the assertions exercise
// the same DatabaseSync path production uses, while staying hermetic — each test
// gets its own temp .ai dir that is torn down afterwards.
//
// Run standalone:      node --test tests/unit/state-db.test.mjs
// With coverage:       node --test --experimental-test-coverage tests/unit/state-db.test.mjs
// In the master suite: bash tests/suites/node_unit_test.sh   (wired into tests/run.sh)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseDeps,
  roleFromOwner,
  MAX_DAG_DEPTH,
  validateDag,
  nextId,
  recordIdHighWater,
  addTask,
  withTransaction,
  readDependencyGraph,
} from "../../src/mcp/shared/state-db.js";

// A fresh, isolated state DB in a temp dir. Returns { dir, db, cleanup }.
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "aios-unit-"));
  // Import lazily so the schema is created via the public entrypoint.
  return import("../../src/mcp/shared/state-db.js").then(({ getDb }) => {
    const db = getDb(dir);
    return {
      dir,
      db,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  });
}

// Insert a task row directly (bypasses addTask) so DAG/graph tests can set up
// arbitrary states without triggering the addTask validation path.
function insertTask(db, id, { status = "OPEN", deps = [] } = {}) {
  db.prepare(
    `INSERT INTO tasks(id, owner, status, tier, description, created_at, depends_on)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    "Engineer (Claude)",
    status,
    null,
    `desc ${id}`,
    new Date().toISOString(),
    deps.length ? JSON.stringify(deps) : null
  );
}

// ── parseDeps (pure) ─────────────────────────────────────────────────────────

test("parseDeps: empty / null / undefined → []", () => {
  assert.deepEqual(parseDeps(""), []);
  assert.deepEqual(parseDeps(null), []);
  assert.deepEqual(parseDeps(undefined), []);
});

test("parseDeps: valid JSON string array round-trips", () => {
  assert.deepEqual(parseDeps(JSON.stringify(["E-1", "E-2"])), ["E-1", "E-2"]);
});

test("parseDeps: filters out non-string members", () => {
  assert.deepEqual(parseDeps(JSON.stringify(["E-1", 5, null, "E-2", { a: 1 }])), ["E-1", "E-2"]);
});

test("parseDeps: malformed JSON degrades to [] (never throws)", () => {
  assert.deepEqual(parseDeps("{not json"), []);
  assert.deepEqual(parseDeps("[unterminated"), []);
});

test("parseDeps: non-array JSON degrades to []", () => {
  assert.deepEqual(parseDeps('"E-1"'), []);
  assert.deepEqual(parseDeps("5"), []);
  assert.deepEqual(parseDeps("{}"), []);
});

// ── roleFromOwner (pure) ─────────────────────────────────────────────────────

test("roleFromOwner: strips the provider parenthetical", () => {
  assert.equal(roleFromOwner("Engineer (Claude)"), "Engineer");
  assert.equal(roleFromOwner("Architect (Claude)"), "Architect");
  assert.equal(roleFromOwner("Tester (claude · sonnet)"), "Tester");
});

test("roleFromOwner: bare role passes through", () => {
  assert.equal(roleFromOwner("Engineer"), "Engineer");
});

test("roleFromOwner: empty / null / undefined → Unassigned", () => {
  assert.equal(roleFromOwner(""), "Unassigned");
  assert.equal(roleFromOwner(null), "Unassigned");
  assert.equal(roleFromOwner(undefined), "Unassigned");
});

test("MAX_DAG_DEPTH is the documented constant (5)", () => {
  assert.equal(MAX_DAG_DEPTH, 5);
});

// ── nextId / recordIdHighWater ───────────────────────────────────────────────

test("nextId: empty table starts each prefix at 1", async () => {
  const { db, dir, cleanup } = await freshDb();
  try {
    assert.equal(nextId(db, "E", dir), "E-1");
    assert.equal(nextId(db, "P", dir), "P-1");
    assert.equal(nextId(db, "T", dir), "T-1");
  } finally {
    cleanup();
  }
});

test("nextId: advances past the highest live id, per prefix", async () => {
  const { db, dir, cleanup } = await freshDb();
  try {
    insertTask(db, "E-3");
    insertTask(db, "E-7");
    insertTask(db, "P-2");
    assert.equal(nextId(db, "E", dir), "E-8");
    assert.equal(nextId(db, "P", dir), "P-3");
    assert.equal(nextId(db, "T", dir), "T-1"); // untouched prefix
  } finally {
    cleanup();
  }
});

test("nextId: high-water mark prevents re-issuing a deleted id", async () => {
  const { db, dir, cleanup } = await freshDb();
  try {
    insertTask(db, "E-5");
    recordIdHighWater(db, "E-5");
    db.prepare("DELETE FROM tasks WHERE id = ?").run("E-5"); // row gone, but hw stays
    assert.equal(nextId(db, "E", dir), "E-6", "must not recycle E-5 after deletion");
  } finally {
    cleanup();
  }
});

test("recordIdHighWater: only advances, never regresses; ignores junk", async () => {
  const { db, dir, cleanup } = await freshDb();
  try {
    recordIdHighWater(db, "E-9");
    recordIdHighWater(db, "E-4"); // lower — must be ignored
    recordIdHighWater(db, "not-a-number"); // junk — must be ignored
    recordIdHighWater(db, "E"); // no suffix — must be ignored
    assert.equal(nextId(db, "E", dir), "E-10");
  } finally {
    cleanup();
  }
});

// ── validateDag ──────────────────────────────────────────────────────────────

test("validateDag: no dependencies is valid (depth 1)", async () => {
  const { db, cleanup } = await freshDb();
  try {
    const r = validateDag(db, "E-1", []);
    assert.equal(r.ok, true);
    assert.equal(r.depth, 1);
  } finally {
    cleanup();
  }
});

test("validateDag: self-reference is rejected", async () => {
  const { db, cleanup } = await freshDb();
  try {
    insertTask(db, "E-1");
    const r = validateDag(db, "E-1", ["E-1"]);
    assert.equal(r.ok, false);
    assert.equal(r.code, "DAG_FAIL");
    assert.match(r.error, /itself/);
  } finally {
    cleanup();
  }
});

test("validateDag: unknown dependency is rejected", async () => {
  const { db, cleanup } = await freshDb();
  try {
    const r = validateDag(db, "E-2", ["E-999"]);
    assert.equal(r.ok, false);
    assert.equal(r.code, "DAG_FAIL");
    assert.match(r.error, /Unknown dependency/);
  } finally {
    cleanup();
  }
});

test("validateDag: cycle is detected", async () => {
  const { db, cleanup } = await freshDb();
  try {
    insertTask(db, "E-1", { deps: ["E-2"] }); // E-1 → E-2
    insertTask(db, "E-2"); // leaf
    // Now try to make E-2 depend on E-1 → closes the loop.
    const r = validateDag(db, "E-2", ["E-1"]);
    assert.equal(r.ok, false);
    assert.equal(r.code, "DAG_FAIL");
    assert.match(r.error, /Circular/);
  } finally {
    cleanup();
  }
});

test("validateDag: depth beyond max is rejected (respects opts.maxDepth)", async () => {
  const { db, cleanup } = await freshDb();
  try {
    insertTask(db, "E-1"); // leaf (depth 1)
    insertTask(db, "E-2", { deps: ["E-1"] }); // depth 2
    // Candidate E-3 → E-2 → E-1 = depth 3. Under a maxDepth of 2 this fails.
    const bad = validateDag(db, "E-3", ["E-2"], { maxDepth: 2 });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /depth/);
    // The same chain is fine when the cap allows depth 3.
    const good = validateDag(db, "E-3", ["E-2"], { maxDepth: 3 });
    assert.equal(good.ok, true);
    assert.equal(good.depth, 3);
  } finally {
    cleanup();
  }
});

test("validateDag: duplicate candidate deps are de-duplicated", async () => {
  const { db, cleanup } = await freshDb();
  try {
    insertTask(db, "E-1");
    const r = validateDag(db, "E-2", ["E-1", "E-1", "E-1"]);
    assert.equal(r.ok, true);
    assert.equal(r.depth, 2);
  } finally {
    cleanup();
  }
});

// ── addTask (single-source write path) ───────────────────────────────────────

test("addTask: rejects empty owner and empty description", async () => {
  const { db, dir, cleanup } = await freshDb();
  try {
    assert.equal(addTask(dir, db, { owner: "", description: "x" }).code, "INVALID_OWNER");
    assert.equal(addTask(dir, db, { owner: "Engineer (Claude)", description: "  " }).code, "INVALID_DESCRIPTION");
  } finally {
    cleanup();
  }
});

test("addTask: creates an OPEN task with a sequential id when it has no deps", async () => {
  const { db, dir, cleanup } = await freshDb();
  try {
    const a = addTask(dir, db, { owner: "Engineer (Claude)", description: "first" });
    const b = addTask(dir, db, { owner: "Engineer (Claude)", description: "second" });
    assert.equal(a.ok, true);
    assert.equal(a.task.id, "E-1");
    assert.equal(a.task.status, "OPEN");
    assert.equal(b.task.id, "E-2");
  } finally {
    cleanup();
  }
});

test("addTask: a task with an unfinished dependency starts BLOCKED, then OPEN when done", async () => {
  const { db, dir, cleanup } = await freshDb();
  try {
    const dep = addTask(dir, db, { owner: "Engineer (Claude)", description: "dependency" });
    const blocked = addTask(dir, db, {
      owner: "Engineer (Claude)",
      description: "dependent",
      depends_on: [dep.task.id],
    });
    assert.equal(blocked.task.status, "BLOCKED");

    // Mark the dependency DONE, then a new dependent on it starts OPEN.
    db.prepare("UPDATE tasks SET status = 'DONE' WHERE id = ?").run(dep.task.id);
    const open = addTask(dir, db, {
      owner: "Engineer (Claude)",
      description: "dependent-2",
      depends_on: [dep.task.id],
    });
    assert.equal(open.task.status, "OPEN");
  } finally {
    cleanup();
  }
});

test("addTask: propagates a DAG violation (unknown dep) as a failure result", async () => {
  const { db, dir, cleanup } = await freshDb();
  try {
    const r = addTask(dir, db, {
      owner: "Engineer (Claude)",
      description: "bad dep",
      depends_on: ["E-404"],
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "DAG_FAIL");
  } finally {
    cleanup();
  }
});

// ── withTransaction ──────────────────────────────────────────────────────────

test("withTransaction: commits on success", async () => {
  const { db, cleanup } = await freshDb();
  try {
    withTransaction(db, (d) => insertTask(d, "E-1"));
    const row = db.prepare("SELECT id FROM tasks WHERE id = ?").get("E-1");
    assert.equal(row.id, "E-1");
  } finally {
    cleanup();
  }
});

test("withTransaction: rolls back on throw and re-raises", async () => {
  const { db, cleanup } = await freshDb();
  try {
    assert.throws(() => {
      withTransaction(db, (d) => {
        insertTask(d, "E-1");
        throw new Error("boom");
      });
    }, /boom/);
    const row = db.prepare("SELECT id FROM tasks WHERE id = ?").get("E-1");
    assert.equal(row, undefined, "insert must be rolled back");
  } finally {
    cleanup();
  }
});

// ── readDependencyGraph ──────────────────────────────────────────────────────

test("readDependencyGraph: returns parsed deps + status maps for every task", async () => {
  const { db, cleanup } = await freshDb();
  try {
    insertTask(db, "E-1", { status: "DONE" });
    insertTask(db, "E-2", { status: "OPEN", deps: ["E-1"] });
    const { deps, status } = readDependencyGraph(db);
    assert.deepEqual(deps.get("E-2"), ["E-1"]);
    assert.deepEqual(deps.get("E-1"), []);
    assert.equal(status.get("E-1"), "DONE");
    assert.equal(status.get("E-2"), "OPEN");
  } finally {
    cleanup();
  }
});
