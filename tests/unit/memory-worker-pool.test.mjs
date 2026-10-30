// memory-worker-pool.test.mjs — E-76 Bounded Worker Pool + DLQ (src/shared/memory-worker-pool.mjs,
// per .ai/blueprints/multimodal-rag-batching.md §Components 2+3). Moved from
// tests/suites/memory_worker_pool_test.sh (E-302, D-088: a pure module is tested in the unit
// layer); the T-MWP-S* ids and every assertion are unchanged.
//
//   - Bounded concurrency (default 3, AI_EMBEDDING_CONCURRENCY override)
//   - Exponential backoff on 429s (1000ms → 15000ms cap) before DLQ
//   - Non-rate-limit errors skip retries → straight to DLQ
//   - DLQ schema persisted to .ai/memory/dlq.json with retry_count dedup
//   - flushDlq() retries DLQ entries; successes drop, failures persist
//   - AI_RAG_MODE=text-only short-circuits the pool (rollback path)
//   - AI_EMBEDDING_CONCURRENCY=1 serial fallback (rollback path)
//   - Privacy: DLQ contains file_path + error code only (no embedding bytes)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POOL = resolve(repo, "src/shared/memory-worker-pool.mjs");
const SRC = readFileSync(POOL, "utf8");
const m = await import(POOL);

let SBOX;
before(() => { SBOX = mkdtempSync(join(tmpdir(), "rein-t-mwp-")); });
after(() => { if (SBOX) rmSync(SBOX, { recursive: true, force: true }); });
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const err = (msg, props) => Object.assign(new Error(msg), props);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── T-MWP-S01: Source exports the documented surface ──
const surface = [
  ["pool has node shebang", /^#!.*node/],
  ["processBatch exported", /export async function processBatch/],
  ["flushDlq exported", /export async function flushDlq/],
  ["loadDlq exported", /export function loadDlq/],
  ["saveDlq exported", /export function saveDlq/],
  ["appendToDlq exported", /export function appendToDlq/],
  ["isRateLimitError exported", /export function isRateLimitError/],
  ["DEFAULT_CONCURRENCY = 3", /DEFAULT_CONCURRENCY {2}= 3/],
  ["DEFAULT_BACKOFF_MIN_MS = 1000", /DEFAULT_BACKOFF_MIN_MS = 1_000/],
  ["DEFAULT_BACKOFF_MAX_MS = 15000", /DEFAULT_BACKOFF_MAX_MS = 15_000/],
  ["DEFAULT_DLQ_PATH pinned", /\.ai\/memory\/dlq\.json/],
  ["blueprint reference present", /multimodal-rag-batching\.md/],
];
test("T-MWP-S01: pool file exists", () => assert.ok(existsSync(POOL)));
for (const [label, re] of surface) {
  test(`T-MWP-S01: ${label}`, () => assert.match(label.includes("shebang") ? SRC.split("\n")[0] : SRC, re));
}

// ── T-MWP-S02: all sends succeed; the concurrency cap is respected ──
let happy;
test("T-MWP-S02: all 8 files succeed", async () => {
  const files = Array.from({ length: 8 }, (_, i) => ({ path: `/tmp/f${i}.png`, sha256: `h${i}`, size: 100, kind: "png" }));
  let maxInFlight = 0;
  const r = await m.processBatch(files, {
    sendEmbedding: async (f) => { await sleep(20); return { vec: [1, 2, 3], id: f.sha256 }; },
    concurrency: 3,
    onInFlightChange: (n) => { if (n > maxInFlight) maxInFlight = n; },
  });
  happy = { successes: r.successes.length, failures: r.failures.length, maxInFlight };
  assert.equal(happy.successes, 8);
});
test("T-MWP-S02: zero failures", () => assert.equal(happy.failures, 0));
test("T-MWP-S02: max in flight ≤ concurrency cap (3)", () => assert.ok(happy.maxInFlight <= 3));
test("T-MWP-S02: max in flight reaches > 1 (parallelism actually happened)", () => assert.ok(happy.maxInFlight > 1));

// ── T-MWP-S03: 429 errors exhaust retries → DLQ ──
let exhaust, dlq1;
test("T-MWP-S03: zero successes", async () => {
  dlq1 = join(SBOX, "dlq.json");
  exhaust = await m.processBatch([{ path: "/tmp/rate.png", sha256: "r1", size: 100, kind: "png" }], {
    sendEmbedding: async () => { throw err("429 Too Many Requests", { status: 429 }); },
    concurrency: 1, dlqPath: dlq1, backoffMinMs: 1, backoffMaxMs: 8,
  });
  assert.equal(exhaust.successes.length, 0);
});
test("T-MWP-S03: exactly one failure", () => assert.equal(exhaust.failures.length, 1));
test("T-MWP-S03: failure kind=exhausted", () => assert.equal(exhaust.failures[0]?.kind, "exhausted"));
test("T-MWP-S03: retry_count > 1", () => assert.ok(exhaust.failures[0]?.retry_count > 1));
test("T-MWP-S03: DLQ file written", () => assert.ok(existsSync(dlq1)));
test("T-MWP-S03: DLQ has the failed job", () => {
  const d = readJson(dlq1);
  assert.ok(d.failed_jobs.length === 1 && d.failed_jobs[0].file_path === "/tmp/rate.png");
});
test("T-MWP-S03: DLQ entry carries last_attempt ISO timestamp", () =>
  assert.match(readJson(dlq1).failed_jobs[0].last_attempt || "", /^\d{4}-\d{2}-\d{2}T/));

// ── T-MWP-S04: non-rate-limit errors short-circuit to DLQ (no retries) ──
let nonretry;
test("T-MWP-S04: sendEmbedding called exactly once (no retry)", async () => {
  let calls = 0;
  const r = await m.processBatch([{ path: "/tmp/payload-bad.png", sha256: "p1", size: 100, kind: "png" }], {
    sendEmbedding: async () => { calls += 1; throw err("400 invalid payload", { status: 400 }); },
    concurrency: 1, dlqPath: join(SBOX, "dlq2.json"), backoffMinMs: 1, backoffMaxMs: 8,
  });
  nonretry = { calls, failures: r.failures.length, kind: r.failures[0]?.kind };
  assert.equal(calls, 1);
});
test("T-MWP-S04: exactly one failure", () => assert.equal(nonretry.failures, 1));
test("T-MWP-S04: failure kind=non-retryable", () => assert.equal(nonretry.kind, "non-retryable"));

// ── T-MWP-S05: backoff doubles between retries (minimum wait observed) ──
let timing;
test("T-MWP-S05: ≥ 3 attempts observed", async () => {
  const stamps = [];
  await m.processBatch([{ path: "/tmp/slow.png", sha256: "s1", size: 1, kind: "png" }], {
    sendEmbedding: async () => { stamps.push(Date.now()); throw err("429 try again", { status: 429 }); },
    concurrency: 1, backoffMinMs: 50, backoffMaxMs: 200,
  });
  // Diffs between consecutive timestamps reflect doubling: ~50, ~100, ~200, then exhaust.
  timing = { attempts: stamps.length, diffs: stamps.slice(1).map((t, i) => t - stamps[i]) };
  assert.ok(timing.attempts >= 3);
});
// A 40 ms floor on the first diff absorbs timer jitter.
test("T-MWP-S05: first retry waited ≥ ~minMs", () => assert.ok(timing.diffs.length && timing.diffs[0] >= 40));
test("T-MWP-S05: second retry diff > first retry diff (doubling)", () =>
  assert.ok(timing.diffs.length >= 2 && timing.diffs[1] > timing.diffs[0]));

// ── T-MWP-S06: env override AI_EMBEDDING_CONCURRENCY=1 → strictly serial ──
let serial;
test("T-MWP-S06: all 4 succeed under serial mode", async () => {
  const files = Array.from({ length: 4 }, (_, i) => ({ path: `/tmp/g${i}.png`, sha256: `g${i}`, size: 1, kind: "png" }));
  let maxInFlight = 0;
  const r = await m.processBatch(files, {
    sendEmbedding: async (f) => { await sleep(15); return { id: f.sha256 }; },
    env: { AI_EMBEDDING_CONCURRENCY: "1" },
    onInFlightChange: (n) => { if (n > maxInFlight) maxInFlight = n; },
  });
  serial = { successes: r.successes.length, maxInFlight };
  assert.equal(serial.successes, 4);
});
test("T-MWP-S06: maxInFlight is exactly 1 (truly serial)", () => assert.equal(serial.maxInFlight, 1));

// ── T-MWP-S07: AI_RAG_MODE=text-only → no embedding calls, all skipped ──
let textonly;
test("T-MWP-S07: zero embedding calls in text-only mode", async () => {
  let calls = 0;
  const r = await m.processBatch([{ path: "/tmp/a.png", sha256: "a", size: 1, kind: "png" }], {
    sendEmbedding: async () => { calls++; return {}; },
    env: { AI_RAG_MODE: "text-only" },
  });
  textonly = { calls, skipped: r.skipped.length, reason: r.skipped[0]?.reason };
  assert.equal(calls, 0);
});
test("T-MWP-S07: all files moved to skipped", () => assert.equal(textonly.skipped, 1));
test("T-MWP-S07: skip reason = text-only-mode", () => assert.equal(textonly.reason, "text-only-mode"));

// ── T-MWP-S08: isRateLimitError covers status/code/message variants ──
test("T-MWP-S08: all 6 known 429 shapes return true", () => {
  const shapes = [
    err("x", { status: 429 }), err("x", { code: 429 }), err("x", { statusCode: "429" }),
    err("RATE_LIMIT", { code: "RATE_LIMIT" }), new Error("429 Too Many Requests"), new Error("rate limit exceeded"),
  ];
  assert.deepEqual(shapes.map((e) => m.isRateLimitError(e)), [true, true, true, true, true, true]);
});
test("T-MWP-S08: non-RL errors return false", () =>
  assert.deepEqual([new Error("something else"), err("x", { status: 500 }), null, {}].map((e) => m.isRateLimitError(e)),
    [false, false, false, false]));

// ── T-MWP-S09: DLQ dedups by file_path and bumps retry_count ──
let dlq3;
test("T-MWP-S09: DLQ contains exactly 2 unique jobs", () => {
  dlq3 = join(SBOX, "dlq3.json");
  m.appendToDlq(dlq3, { file_path: "/tmp/x.png", last_error: "first", retry_count: 2, last_attempt: "2026-01-01T00:00:00Z" });
  m.appendToDlq(dlq3, { file_path: "/tmp/x.png", last_error: "second", retry_count: 1, last_attempt: "2026-01-02T00:00:00Z" });
  m.appendToDlq(dlq3, { file_path: "/tmp/y.png", last_error: "other", retry_count: 1, last_attempt: "2026-01-03T00:00:00Z" });
  assert.equal(readJson(dlq3).failed_jobs.length, 2);
});
const xJob = () => readJson(dlq3).failed_jobs.find((j) => j.file_path === "/tmp/x.png");
test("T-MWP-S09: x.png retry_count summed to 3", () => assert.equal(xJob().retry_count, 3));
test("T-MWP-S09: x.png last_error updated to most recent", () => assert.equal(xJob().last_error, "second"));

// ── T-MWP-S10: flushDlq retries the DLQ and rewrites the file ──
let dlq4, flush;
test("T-MWP-S10: flushDlq retried 2 entries", async () => {
  dlq4 = join(SBOX, "dlq4.json");
  m.saveDlq(dlq4, { failed_jobs: [
    { file_path: "/tmp/recover.png", last_error: "old", retry_count: 1, last_attempt: "2026-01-01T00:00:00Z" },
    { file_path: "/tmp/stillbad.png", last_error: "old", retry_count: 1, last_attempt: "2026-01-01T00:00:00Z" },
  ] });
  flush = await m.flushDlq(dlq4, async (file) => {
    if (file.path === "/tmp/recover.png") return { id: "ok" };
    throw err("400 still bad", { status: 400 });
  }, { backoffMinMs: 1, backoffMaxMs: 4 });
  assert.equal(flush.retried, 2);
});
test("T-MWP-S10: flushDlq reports 1 succeeded", () => assert.equal(flush.succeeded, 1));
test("T-MWP-S10: flushDlq reports 1 still_failing", () => assert.equal(flush.still_failing, 1));
test("T-MWP-S10: DLQ rewritten with only stillbad.png", () => {
  const jobs = readJson(dlq4).failed_jobs;
  assert.ok(jobs.length === 1 && jobs[0].file_path === "/tmp/stillbad.png");
});

// ── T-MWP-S11: DLQ accessors are fail-open on missing/garbage files ──
test("T-MWP-S11: missing DLQ → empty array", () =>
  assert.equal(m.loadDlq(join(SBOX, "does-not-exist.json")).failed_jobs.length, 0));
test("T-MWP-S11: garbage DLQ → empty array (no throw)", () => {
  writeFileSync(join(SBOX, "garbage.json"), "not valid json {{{\n");
  assert.equal(m.loadDlq(join(SBOX, "garbage.json")).failed_jobs.length, 0);
});
test("T-MWP-S11: flushDlq on missing DLQ returns zeros", async () =>
  assert.match(JSON.stringify(await m.flushDlq(join(SBOX, "does-not-exist.json"), async () => {})), /"retried":0/));

// ── T-MWP-S12: CLI flags for ops ──
const cli = (...a) => spawnSync(process.execPath, [POOL, ...a], { encoding: "utf8" });
test("T-MWP-S12: --dlq-show prints JSON envelope", () => assert.match(cli("--dlq-show", dlq4).stdout, /"failed_jobs"/));
test("T-MWP-S12: --dlq-show reports the surviving job", () => assert.match(cli("--dlq-show", dlq4).stdout, /stillbad\.png/));
test("T-MWP-S12: --dlq-clear empties the DLQ", () => {
  cli("--dlq-clear", dlq4);
  assert.deepEqual(readJson(dlq4).failed_jobs, []);
});
test("T-MWP-S12: usage mentions --dlq-show", () => assert.match(cli("--bogus").stderr, /--dlq-show/));
test("T-MWP-S12: usage mentions --dlq-clear", () => assert.match(cli("--bogus").stderr, /--dlq-clear/));

// ── T-MWP-S13: ~/.rein mirror matches src (read-only; absent → skip) ──
const MIRROR = join(homedir(), ".rein/shared/memory-worker-pool.mjs");
test("T-MWP-S13: mirror is byte-identical to src", { skip: !existsSync(MIRROR) && "mirror absent" }, () =>
  assert.equal(readFileSync(MIRROR, "utf8"), SRC));
