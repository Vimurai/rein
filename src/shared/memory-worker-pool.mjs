#!/usr/bin/env node
/**
 * memory-worker-pool.mjs — E-76 Bounded Worker Pool + Dead-Letter Queue.
 *
 * Implements §Components 2+3 of .ai/blueprints/multimodal-rag-batching.md:
 *
 *   "A dispatcher using a concurrency limit … that ensures no more than N
 *    (default 3) embedding requests are in-flight simultaneously."
 *   "A local JSON file (`.ai/memory/dlq.json`) that logs files failing
 *    ingestion (e.g., due to 5xx or unrecoverable 429s) so they aren't
 *    lost and can be retried."
 *
 * Wired to consume E-75's `scanWorkspace({…}).eligible[]` envelope:
 * each input file is `{ path, sha256, size, kind }`.
 *
 * Concurrency model: N persistent worker promises share a single cursor
 * into the eligible[] array. Cursor increment is atomic under V8's
 * single-threaded execution — no lock needed. Workers exit when the
 * cursor passes the end of the array, then Promise.all() resolves.
 *
 * Backoff (per blueprint §Execution Constraints):
 *   Minimum wait after a 429 = 1000ms, doubled each retry, capped at
 *   15000ms. Once the cap is reached and the next attempt still fails,
 *   the job moves to the DLQ. Non-rate-limit errors (5xx, network,
 *   payload-malformed) are NOT retried — they short-circuit straight
 *   to the DLQ to avoid amplifying server stress.
 *
 * Rollback (per blueprint §Rollback Plan):
 *   - AI_RAG_MODE=text-only        → processBatch returns immediately
 *                                    with every file in `skipped[]`.
 *   - AI_EMBEDDING_CONCURRENCY=1   → serial fallback (one worker).
 *
 * Pure node:fs / node:path — no external deps. The embedding call is
 * injected as `opts.sendEmbedding` so this module never talks to an
 * embedding API directly — keeps the unit-test surface clean and avoids
 * coupling to whichever transport memory_curator chooses. No embedding
 * provider is configured today: the live index is the text/hash index in
 * memory-batch-scanner.mjs, and multimodal retrieval is deferred.
 *
 * Usage (programmatic):
 *   import { processBatch, flushDlq } from "./shared/memory-worker-pool.mjs";
 *   const result = await processBatch(eligible, {
 *     sendEmbedding: async (file) => embed(file),
 *     dlqPath: ".ai/memory/dlq.json",
 *     concurrency: 3,
 *   });
 *
 * Usage (CLI smoke):
 *   node src/shared/memory-worker-pool.mjs --dlq-show <path>
 *   node src/shared/memory-worker-pool.mjs --dlq-clear <path>
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync,
} from "node:fs";
import { resolve, dirname } from "node:path";

const SERVICE = "memory-worker-pool";

export const DEFAULT_CONCURRENCY  = 3;
export const DEFAULT_BACKOFF_MIN_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 15_000;
export const DEFAULT_DLQ_PATH       = ".ai/memory/dlq.json";

// ── Structured stderr logger (obs_baseline §Logging) ─────────────────────────
function log(level, message, extras = {}) {
  process.stderr.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    level, service: SERVICE, message, ...extras,
  }) + "\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Rate-limit error detection ───────────────────────────────────────────────
// Flexible: accepts the common shapes that embedding SDKs / fetch wrappers /
// custom errors throw. Test code can mark errors as rate-limit via any
// of: e.code, e.status, e.statusCode, or a "429"/"rate limit" message.
export function isRateLimitError(e) {
  if (!e || typeof e !== "object") return false;
  for (const key of ["code", "status", "statusCode"]) {
    const v = e[key];
    if (v === 429 || v === "429") return true;
    if (typeof v === "string" && /RATE_LIMIT|RATE_LIMITED/i.test(v)) return true;
  }
  if (typeof e.message === "string" && /\b429\b|rate[- ]?limit/i.test(e.message)) {
    return true;
  }
  return false;
}

// ── Backoff envelope ─────────────────────────────────────────────────────────
async function _sendWithBackoff(sendFn, file, opts) {
  const minMs  = Number.isFinite(opts.backoffMinMs) && opts.backoffMinMs >= 0
    ? opts.backoffMinMs
    : DEFAULT_BACKOFF_MIN_MS;
  const maxMs  = Number.isFinite(opts.backoffMaxMs) && opts.backoffMaxMs >= minMs
    ? opts.backoffMaxMs
    : DEFAULT_BACKOFF_MAX_MS;

  let attempt   = 0;
  let delay     = minMs;
  let lastError = null;

  // The retry budget: first call (attempt 1) + retries while delay <= maxMs.
  // The doubling sequence (1000, 2000, 4000, 8000, 15000) yields up to 5
  // total attempts at the default cap.
  while (true) {
    attempt += 1;
    try {
      return await sendFn(file);
    } catch (e) {
      lastError = e;
      // Non-retryable: short-circuit straight to DLQ.
      if (!isRateLimitError(e)) {
        const err = new Error(`non-retryable: ${e.message || String(e)}`);
        err.retry_count = attempt;
        err.cause       = e;
        err.kind        = "non-retryable";
        throw err;
      }
      if (delay > maxMs) {
        const err = new Error(
          `exhausted ${attempt} retries on 429 (last: ${e.message || String(e)})`
        );
        err.retry_count = attempt;
        err.cause       = e;
        err.kind        = "exhausted";
        throw err;
      }
      await sleep(delay);
      // Cap the delay AFTER waiting so the maxMs delay is genuinely tried.
      delay = Math.min(delay * 2, maxMs * 2);
    }
  }
}

// ── DLQ persistence (atomic writes) ──────────────────────────────────────────

/**
 * Read the DLQ from disk. Returns `{ failed_jobs: [] }` when the file is
 * absent, unparseable, or missing the expected key — never throws.
 */
export function loadDlq(dlqPath) {
  if (!dlqPath || !existsSync(dlqPath)) return { failed_jobs: [] };
  try {
    const parsed = JSON.parse(readFileSync(dlqPath, "utf8"));
    if (parsed && Array.isArray(parsed.failed_jobs)) return parsed;
  } catch (e) {
    log("warn", "DLQ file unparseable — resetting to empty", { error: e.message });
  }
  return { failed_jobs: [] };
}

/**
 * Atomically replace the DLQ on disk. Writes to a per-pid temp file and
 * renames — protects against partial writes if the host crashes mid-flush.
 */
export function saveDlq(dlqPath, state) {
  const dir = dirname(resolve(dlqPath));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${dlqPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, dlqPath);
}

/**
 * Push a failure into the DLQ. If the same file_path is already present,
 * update its retry_count + last_error rather than appending a duplicate
 * row (keeps the DLQ from growing unbounded under thrash).
 *
 * Synchronous load-modify-save — atomic under JS's single-threaded loop.
 */
export function appendToDlq(dlqPath, failure) {
  if (!dlqPath) return;
  const state = loadDlq(dlqPath);
  const idx = state.failed_jobs.findIndex((j) => j.file_path === failure.file_path);
  if (idx >= 0) {
    const prev = state.failed_jobs[idx];
    state.failed_jobs[idx] = {
      file_path:    failure.file_path,
      last_error:   failure.last_error,
      retry_count:  (prev.retry_count || 0) + (failure.retry_count || 1),
      last_attempt: failure.last_attempt,
    };
  } else {
    state.failed_jobs.push(failure);
  }
  saveDlq(dlqPath, state);
}

// ── Bounded worker pool ──────────────────────────────────────────────────────

/**
 * Process a batch of file objects through the injected `sendEmbedding`
 * function with bounded concurrency, exponential backoff, and a
 * persistent DLQ.
 *
 * opts:
 *   sendEmbedding   (required) async (file) => result
 *   concurrency     (optional) integer; defaults to AI_EMBEDDING_CONCURRENCY
 *                              env var or DEFAULT_CONCURRENCY (3).
 *   dlqPath         (optional) string; null/undefined disables DLQ writes.
 *   backoffMinMs    (optional) starting backoff in ms; default 1000.
 *   backoffMaxMs    (optional) backoff cap in ms; default 15000.
 *   env             (optional) env override; defaults to process.env.
 *   onInFlightChange (optional) callback(count) for test observability.
 *
 * Returns:
 *   {
 *     successes: [{ file, result }],
 *     failures:  [{ file_path, last_error, retry_count, last_attempt, kind }],
 *     skipped:   [{ file_path, reason }]   // only populated when text-only mode
 *   }
 */
export async function processBatch(files, opts = {}) {
  const env = opts.env || process.env;
  if (typeof opts.sendEmbedding !== "function") {
    throw new Error("opts.sendEmbedding (async (file) => result) is required");
  }
  if (!Array.isArray(files)) {
    throw new Error("files must be an array of {path,...} objects");
  }

  // Rollback path: AI_RAG_MODE=text-only short-circuits the whole pool.
  if (env.AI_RAG_MODE === "text-only") {
    log("info", "AI_RAG_MODE=text-only — short-circuiting batch");
    return {
      successes: [],
      failures:  [],
      skipped:   files.map((f) => ({ file_path: f.path, reason: "text-only-mode" })),
    };
  }

  const envConcurrency = Number(env.AI_EMBEDDING_CONCURRENCY);
  const concurrencyRaw = opts.concurrency ?? envConcurrency;
  const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw > 0
    ? Math.floor(concurrencyRaw)
    : DEFAULT_CONCURRENCY;

  const dlqPath  = opts.dlqPath === null ? null : (opts.dlqPath || null);
  const successes = [];
  const failures  = [];

  // Single shared cursor — V8's single-threaded loop makes the
  // post-increment effectively atomic across N workers.
  let cursor    = 0;
  let inFlight  = 0;
  const reportInFlight = typeof opts.onInFlightChange === "function"
    ? opts.onInFlightChange
    : null;

  const workerCount = Math.min(concurrency, files.length);
  const workers = [];

  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (cursor < files.length) {
        const myIndex = cursor++;
        const file    = files[myIndex];

        inFlight += 1;
        if (reportInFlight) reportInFlight(inFlight);

        try {
          const result = await _sendWithBackoff(opts.sendEmbedding, file, opts);
          successes.push({ file, result });
        } catch (e) {
          const failure = {
            file_path:    file.path,
            last_error:   e.message,
            retry_count:  e.retry_count || 1,
            last_attempt: new Date().toISOString(),
            kind:         e.kind || "unknown",
          };
          failures.push(failure);
          if (dlqPath) appendToDlq(dlqPath, failure);
        } finally {
          inFlight -= 1;
          if (reportInFlight) reportInFlight(inFlight);
        }
      }
    })());
  }

  await Promise.all(workers);
  return { successes, failures, skipped: [] };
}

/**
 * Retry every job currently in the DLQ via the injected sendEmbedding
 * function. Successes are removed from the DLQ; jobs that fail again
 * remain (their retry_count accumulates via appendToDlq's dedup logic
 * if processBatch's own DLQ writes overlap — flushDlq itself rewrites
 * the file from scratch at the end).
 *
 * Returns: { retried, succeeded, still_failing }
 *
 * Per blueprint §API: "Attempts to re-ingest the failed_jobs before
 * processing new files." Callers should invoke flushDlq() at the start
 * of each sync cycle, then processBatch() for the fresh eligible[] set.
 */
export async function flushDlq(dlqPath, sendEmbedding, opts = {}) {
  if (!dlqPath) {
    return { retried: 0, succeeded: 0, still_failing: 0 };
  }
  const state = loadDlq(dlqPath);
  if (state.failed_jobs.length === 0) {
    return { retried: 0, succeeded: 0, still_failing: 0 };
  }

  // Reconstruct {path} entries — the DLQ only persists file_path. The
  // caller's sendEmbedding is expected to handle a slim entry (it may
  // re-hash or re-read the file on its own). We pass `_dlq_retry: true`
  // as a hint for telemetry inside sendEmbedding.
  const files = state.failed_jobs.map((j) => ({
    path:        j.file_path,
    _dlq_retry:  true,
    retry_count: j.retry_count,
  }));

  // Disable DLQ writes inside the inner processBatch — we rebuild the
  // DLQ atomically below using the consolidated failures[] result.
  const result = await processBatch(files, {
    ...opts,
    sendEmbedding,
    dlqPath: null,
  });

  // Rebuild the DLQ from what still failed. The failures array carries
  // the new last_error / last_attempt / retry_count.
  saveDlq(dlqPath, { failed_jobs: result.failures });

  return {
    retried:        state.failed_jobs.length,
    succeeded:      result.successes.length,
    still_failing:  result.failures.length,
  };
}

// ── CLI entry (smoke / ops) ──────────────────────────────────────────────────
const __isMain = (() => {
  try {
    const argv1 = process.argv[1] || "";
    return argv1.endsWith("/memory-worker-pool.mjs") ||
           argv1.endsWith("\\memory-worker-pool.mjs");
  } catch { return false; }
})();

if (__isMain) {
  const flag = process.argv[2];
  if (flag === "--dlq-show") {
    const path = process.argv[3] || DEFAULT_DLQ_PATH;
    const state = loadDlq(path);
    process.stdout.write(JSON.stringify({
      path,
      count: state.failed_jobs.length,
      failed_jobs: state.failed_jobs,
    }, null, 2) + "\n");
    process.exit(0);
  }
  if (flag === "--dlq-clear") {
    const path = process.argv[3] || DEFAULT_DLQ_PATH;
    saveDlq(path, { failed_jobs: [] });
    process.stdout.write(`✓ cleared DLQ at ${path}\n`);
    process.exit(0);
  }
  process.stderr.write(
    "usage: memory-worker-pool.mjs [--dlq-show <path> | --dlq-clear <path>]\n"
  );
  process.exit(2);
}
