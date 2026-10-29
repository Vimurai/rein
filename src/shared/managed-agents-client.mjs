#!/usr/bin/env node
/**
 * managed-agents-client.mjs — Live Managed Agents API client (E-70).
 *
 * Promotes the E-47 offline spike (`tests/tools/managed_agents_spike.js`,
 * verdict=PROCEED) into a real client per
 * `.ai/blueprints/system-hardening-phase3.md` §Components §3:
 *
 *   1. Feature-flagged behind AI_MANAGED_AGENTS_ENABLE.
 *      Default OFF → every entry point is a no-op that returns a
 *      structured `{ status: "DISABLED" }` envelope. Rollback is a single
 *      env var flip (§Rollback Plan).
 *
 *   2. API key via env only (AI_MANAGED_AGENT_KEY).
 *      Never read from state.json. Never logged. Validated by length +
 *      character class; redacted in every diagnostic message.
 *
 *   3. Payload migrated to the `steps` schema:
 *      Legacy: { outputs: [{ text }] }
 *      Live:   { steps:   [{ text, tool_calls? }] }
 *
 *   4. Single dependency: built-in `fetch` (Node 22+).
 *      No SDK pin → no supply-chain surface.
 *
 * Usage (programmatic):
 *   import { sendSteps, isEnabled } from "../shared/managed-agents-client.mjs";
 *   if (isEnabled()) {
 *     const res = await sendSteps({ agentId: "abc", steps: [{ text: "hi" }] });
 *   }
 *
 * Usage (CLI smoke):
 *   node src/shared/managed-agents-client.mjs --status
 *   node src/shared/managed-agents-client.mjs --send <agentId> '<json-steps>'
 *
 * Security boundaries (system-hardening-phase3.md §Security):
 *   - AI_MANAGED_AGENT_KEY is the only secret; held in a closure, never
 *     interpolated into logs or error messages.
 *   - All outbound requests carry `Authorization: Bearer <key>` — never
 *     `key` as a query string (avoids HTTP-log capture).
 *   - The endpoint URL is validated against an allowlist (https only,
 *     hostname must match the configured AI_MANAGED_AGENT_HOST, default
 *     `api.managed-agents.anthropic.com`). Prevents key exfiltration via
 *     a swapped env var pointing at an attacker host.
 *   - Step payloads are sanitised through the same redaction regex as the
 *     E-47 spike before send.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const SERVICE = "managed-agents-client";
const API_VERSION = "managed-agents-2026-04-01";
const DEFAULT_HOST = "api.managed-agents.anthropic.com";
const ALLOWED_PROTOCOL = "https:";
// Conservative request timeout — managed-agent endpoints are not on the
// critical path of any local workflow, so we'd rather fail fast than block.
const DEFAULT_TIMEOUT_MS = 10_000;

// ── E-73 State Projector / sync_to_cloud constants ───────────────────────────
// Per .ai/blueprints/managed-agents-state-reconciliation.md:
//   §Components 1 (State Projector): read OPEN+BLOCKED tasks from local
//     state.sqlite and emit the Cloud Projection Payload.
//   §Components 2 (Sync Hook): debounced, non-blocking, fire-and-forget POST.
//   §Execution Constraints: 2000ms debounce default.
//   §Security/Data Privacy: only id, status, owner cross the boundary —
//     descriptions / summaries / created_at NEVER leave the local machine.
const DEFAULT_DB_PATH = ".ai/state.sqlite";
const DEFAULT_DEBOUNCE_MS = 2_000;
const PROJECTION_PATH = "/v1/managed-agents/state/projection";

// ── Sensitive-key redaction (mirrors E-47 spike + E-65 incident-append) ──────
const SENSITIVE_KEY_RE = /(?:secret|password|token|apikey|api_key|private_key|credential|bearer)/i;

function redact(obj, depth = 0) {
  if (obj === null || typeof obj !== "object" || depth > 12) return obj;
  if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = "[REDACTED]";
      continue;
    }
    out[k] = redact(v, depth + 1);
  }
  return out;
}

// ── Structured stderr logger (obs_baseline §Logging — never logs the key) ────
function log(level, message, extras = {}) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE,
    message,
    ...redact(extras),
  });
  process.stderr.write(line + "\n");
}

// ── Feature flag + key gating ────────────────────────────────────────────────
export function isEnabled(env = process.env) {
  return env.AI_MANAGED_AGENTS_ENABLE === "1";
}

function readKey(env = process.env) {
  const k = env.AI_MANAGED_AGENT_KEY;
  if (typeof k !== "string") return null;
  // Length + charset check — refuses obviously malformed payloads without
  // ever including the value itself in the error.
  if (k.length < 16 || k.length > 256) return null;
  if (!/^[A-Za-z0-9_\-.]+$/.test(k)) return null;
  return k;
}

// ── URL allowlist ────────────────────────────────────────────────────────────
function buildUrl(env, pathSegment) {
  const host = env.AI_MANAGED_AGENT_HOST || DEFAULT_HOST;
  if (!/^[A-Za-z0-9.\-]+$/.test(host)) {
    throw new Error("invalid AI_MANAGED_AGENT_HOST");
  }
  const url = new URL(`${ALLOWED_PROTOCOL}//${host}${pathSegment}`);
  if (url.protocol !== ALLOWED_PROTOCOL) {
    throw new Error(`refusing non-https endpoint: ${url.protocol}`);
  }
  return url;
}

// ── E-73 State Projector ─────────────────────────────────────────────────────
// Reads OPEN+BLOCKED tasks from .ai/state.sqlite and returns the Cloud
// Projection Payload. Privacy contract (blueprint §Security/Data Privacy):
// only {id, status, owner} fields cross the boundary — descriptions /
// summaries / timestamps stay on the local box.

function normaliseOwner(owner) {
  if (typeof owner !== "string") return "unknown";
  // task-synchronizer stores "Engineer (Claude)" / "Architect (Claude)" /
  // "Tester (claude · sonnet)" — the provider half is derived from roles.json (E-255).
  // The cloud projection only needs the short role.
  if (owner.startsWith("Engineer")) return "Engineer";
  if (owner.startsWith("Architect")) return "Architect";
  if (owner.startsWith("Tester")) return "Tester";
  return owner.slice(0, 32);
}

/**
 * Build the Cloud Projection Payload from local SQLite state.
 *
 * Returns one of:
 *   { status: "OK", payload: { local_timestamp, state_hash, active_tasks } }
 *   { status: "STATE_UNAVAILABLE", reason }   — db missing / open failed
 *
 * Pure read — never mutates state.sqlite. Closes the handle on every exit.
 */
export function projectState(opts = {}) {
  const dbPath = typeof opts.dbPath === "string" && opts.dbPath.length > 0
    ? opts.dbPath
    : DEFAULT_DB_PATH;
  const absolute = resolve(dbPath);
  if (!existsSync(absolute)) {
    return { status: "STATE_UNAVAILABLE", reason: `state.sqlite not found at ${absolute}` };
  }
  let rows;
  let db;
  try {
    db = new DatabaseSync(absolute);
    rows = db
      .prepare("SELECT id, status, owner FROM tasks WHERE status IN ('OPEN','BLOCKED') ORDER BY id")
      .all();
  } catch (e) {
    if (db) { try { db.close(); } catch { /* ignore */ } }
    return { status: "STATE_UNAVAILABLE", reason: e.message };
  }
  try { db.close(); } catch { /* ignore */ }

  const active_tasks = rows.map((r) => ({
    id: String(r.id),
    status: String(r.status),
    owner: normaliseOwner(r.owner),
  }));
  // Canonical-form hash: deterministic across runs given identical state.
  // Excludes the timestamp so the reconciliation engine can detect actual
  // task-set drift without false positives from the clock.
  const canonical = JSON.stringify(active_tasks);
  const state_hash = createHash("sha256").update(canonical).digest("hex");

  return {
    status: "OK",
    payload: {
      local_timestamp: new Date().toISOString(),
      state_hash,
      active_tasks,
    },
  };
}

// ── E-73 Debounced sync_to_cloud dispatcher ──────────────────────────────────
// Per blueprint §Execution Constraints + §API:
//   - 2000ms debounce → rapid task mutations coalesce into one POST.
//   - Fire-and-forget → caller is never blocked on network I/O.
//   - Errors are swallowed + logged; the local MCP process must NOT crash
//     because the cloud is unreachable (§API: "swallow and log HTTP errors").
//
// Module-level debouncer state. Single timer is sufficient because the
// reconciliation contract treats the latest snapshot as authoritative —
// older scheduled syncs are intentionally cancelled when a new one is
// requested within the window (the cloud should always converge on the
// newest local state, not a partial sequence).
let _pendingTimer = null;

function _fireProjectionSync(dbPath, env) {
  const key = readKey(env);
  if (!key) {
    log("warn", "skipping sync: AI_MANAGED_AGENT_KEY missing at fire time");
    return;
  }
  const projection = projectState({ dbPath });
  if (projection.status !== "OK") {
    log("warn", "skipping sync: state unavailable", { reason: projection.reason });
    return;
  }
  let url;
  try {
    url = buildUrl(env, PROJECTION_PATH);
  } catch (e) {
    log("error", "projection endpoint validation failed", { error: e.message });
    return;
  }
  // Fire-and-forget: never await the promise from the caller side. The
  // .catch() guard ensures an unhandled rejection cannot propagate into
  // the local process's exit code (blueprint §Execution Constraints).
  fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-Managed-Agents-Api-Version": API_VERSION,
    },
    body: JSON.stringify(projection.payload),
  })
    .then(async (res) => {
      if (!res.ok) {
        log("warn", "projection non-2xx", { code: res.status });
      }
    })
    .catch((e) => {
      log("warn", "projection fetch failed", { error: e.message, name: e.name });
    });
}

/**
 * Schedule a (debounced) cloud projection sync. Returns immediately with a
 * structured envelope:
 *
 *   { status: "DISABLED" }              — feature flag off
 *   { status: "MISSING_KEY" }           — AI_MANAGED_AGENT_KEY absent/malformed
 *   { status: "STATE_UNAVAILABLE", … }  — state.sqlite cannot be read NOW
 *   { status: "DEBOUNCED", debounce_ms } — sync scheduled; will fire after window
 *
 * The actual network call happens asynchronously after `debounce_ms`. The
 * caller MUST NOT await the result of the eventual fetch — that is the
 * blueprint's whole point. For test/shutdown use, call cancelPendingSync().
 */
export function syncToCloud(opts = {}, env = process.env) {
  if (!isEnabled(env)) return { status: "DISABLED" };
  const key = readKey(env);
  if (!key) {
    log("warn", "AI_MANAGED_AGENT_KEY missing or malformed");
    return { status: "MISSING_KEY" };
  }
  const dbPath = typeof opts.dbPath === "string" && opts.dbPath.length > 0
    ? opts.dbPath
    : DEFAULT_DB_PATH;
  // Eager state probe — if state.sqlite is already missing/unreadable at
  // schedule time, surface that to the caller now rather than silently
  // logging at fire time. Cheap (single existsSync + 1 prepared query).
  const eager = projectState({ dbPath });
  if (eager.status !== "OK") {
    return { status: "STATE_UNAVAILABLE", reason: eager.reason };
  }
  const debounceMs = Number.isFinite(Number(env.AI_MANAGED_AGENTS_DEBOUNCE_MS))
    && Number(env.AI_MANAGED_AGENTS_DEBOUNCE_MS) >= 0
    ? Number(env.AI_MANAGED_AGENTS_DEBOUNCE_MS)
    : DEFAULT_DEBOUNCE_MS;
  if (_pendingTimer !== null) {
    clearTimeout(_pendingTimer);
    _pendingTimer = null;
  }
  _pendingTimer = setTimeout(() => {
    _pendingTimer = null;
    _fireProjectionSync(dbPath, env);
  }, debounceMs);
  // Don't keep the event loop alive solely for the debounce timer — if the
  // host process exits, dropping the pending sync is fine; the next session
  // will re-emit the snapshot via the reconciliation engine.
  if (typeof _pendingTimer.unref === "function") _pendingTimer.unref();
  return { status: "DEBOUNCED", debounce_ms: debounceMs };
}

/**
 * Cancel any pending debounced sync. Returns true if a timer was cleared,
 * false if there was nothing pending. Safe to call from shutdown handlers
 * and test teardown.
 */
export function cancelPendingSync() {
  if (_pendingTimer !== null) {
    clearTimeout(_pendingTimer);
    _pendingTimer = null;
    return true;
  }
  return false;
}

// ── Schema migration: legacy `outputs` → live `steps` ────────────────────────
export function migrateLegacyToSteps(payload) {
  if (!payload || typeof payload !== "object") return { steps: [] };
  if (Array.isArray(payload.steps)) return payload; // already migrated
  const legacy = Array.isArray(payload.outputs) ? payload.outputs : [];
  const steps = legacy.map((o) => {
    if (typeof o === "string") return { text: o };
    if (o && typeof o === "object") {
      const step = {};
      if (typeof o.text === "string") step.text = o.text;
      if (Array.isArray(o.tool_calls)) step.tool_calls = o.tool_calls;
      return step;
    }
    return { text: String(o ?? "") };
  });
  return { steps };
}

// ── Payload validation ───────────────────────────────────────────────────────
function validateStepsPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("payload must be an object");
  }
  if (!Array.isArray(payload.steps)) {
    throw new Error("payload.steps must be an array");
  }
  for (const [i, step] of payload.steps.entries()) {
    if (!step || typeof step !== "object") {
      throw new Error(`payload.steps[${i}] must be an object`);
    }
    if (step.text !== undefined && typeof step.text !== "string") {
      throw new Error(`payload.steps[${i}].text must be a string when present`);
    }
    if (step.tool_calls !== undefined && !Array.isArray(step.tool_calls)) {
      throw new Error(`payload.steps[${i}].tool_calls must be an array when present`);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a steps-schema payload to a Managed Agent.
 *
 * Returns one of:
 *   { status: "DISABLED" }           — feature flag off
 *   { status: "MISSING_KEY" }        — AI_MANAGED_AGENT_KEY absent/invalid
 *   { status: "INVALID_PAYLOAD" }    — payload failed schema check
 *   { status: "NETWORK_ERROR", … }   — fetch rejected
 *   { status: "HTTP_ERROR", code }   — non-2xx response
 *   { status: "OK", body }           — response JSON
 *
 * Never throws on transport failure — every error path returns a
 * structured envelope so callers can branch without try/catch sprawl.
 */
export async function sendSteps(opts = {}, env = process.env) {
  const { agentId, steps, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  if (!isEnabled(env)) return { status: "DISABLED" };

  const key = readKey(env);
  if (!key) {
    log("warn", "AI_MANAGED_AGENT_KEY missing or malformed");
    return { status: "MISSING_KEY" };
  }

  if (typeof agentId !== "string" || agentId.length === 0) {
    return { status: "INVALID_PAYLOAD", reason: "agentId must be a non-empty string" };
  }
  if (!/^[A-Za-z0-9_\-]{1,64}$/.test(agentId)) {
    return { status: "INVALID_PAYLOAD", reason: "agentId fails charset/length check" };
  }

  // Accept either pre-migrated `steps` or legacy `{outputs}`. If the
  // caller passed a `steps` field that is non-undefined but non-array,
  // refuse — silently migrating that to an empty array would mask a
  // real schema bug in the caller.
  if (steps !== undefined && !Array.isArray(steps)) {
    return { status: "INVALID_PAYLOAD", reason: "opts.steps must be an array" };
  }
  const migrated = Array.isArray(steps)
    ? { steps }
    : migrateLegacyToSteps(opts);
  try {
    validateStepsPayload(migrated);
  } catch (e) {
    return { status: "INVALID_PAYLOAD", reason: e.message };
  }

  let url;
  try {
    url = buildUrl(env, `/v1/managed-agents/${agentId}/steps`);
  } catch (e) {
    log("error", "endpoint validation failed", { error: e.message });
    return { status: "INVALID_PAYLOAD", reason: e.message };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-Managed-Agents-Api-Version": API_VERSION,
      },
      body: JSON.stringify(migrated),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!res.ok) {
      log("warn", "managed-agents non-2xx", { code: res.status });
      return { status: "HTTP_ERROR", code: res.status, body };
    }
    return { status: "OK", body };
  } catch (e) {
    clearTimeout(timer);
    log("error", "managed-agents fetch failed", { error: e.message, name: e.name });
    return { status: "NETWORK_ERROR", error: e.message, name: e.name };
  }
}

/** Status helper for diagnostics — returns the flags without ever touching the key value. */
export function diagnostics(env = process.env) {
  return {
    api_version: API_VERSION,
    enabled: isEnabled(env),
    key_present: typeof env.AI_MANAGED_AGENT_KEY === "string" && env.AI_MANAGED_AGENT_KEY.length > 0,
    key_valid: readKey(env) !== null,
    host: env.AI_MANAGED_AGENT_HOST || DEFAULT_HOST,
  };
}

// ── CLI entry (smoke test) ───────────────────────────────────────────────────
// Detect direct invocation: argv[1] is this file path (resolved via process.argv).
const __isMain = (() => {
  try {
    const argv1 = process.argv[1] || "";
    return argv1.endsWith("/managed-agents-client.mjs") ||
           argv1.endsWith("\\managed-agents-client.mjs");
  } catch { return false; }
})();

if (__isMain) {
  const flag = process.argv[2];
  if (flag === "--status" || flag === undefined) {
    process.stdout.write(JSON.stringify(diagnostics(), null, 2) + "\n");
    process.exit(0);
  }
  if (flag === "--send") {
    const agentId = process.argv[3];
    const rawJson = process.argv[4] || '{"steps":[]}';
    let parsed;
    try { parsed = JSON.parse(rawJson); }
    catch (e) {
      process.stderr.write(`[managed-agents-client] invalid JSON: ${e.message}\n`);
      process.exit(2);
    }
    const result = await sendSteps({ agentId, steps: parsed.steps, ...parsed });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(result.status === "OK" ? 0 : 1);
  }
  if (flag === "--project") {
    // Smoke: print the Cloud Projection Payload for the current state.sqlite.
    const dbPath = process.argv[3] || DEFAULT_DB_PATH;
    const result = projectState({ dbPath });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(result.status === "OK" ? 0 : 1);
  }
  if (flag === "--sync") {
    // Smoke: schedule a debounced sync. Returns the envelope immediately;
    // the actual fetch (if any) fires after the debounce window.
    const dbPath = process.argv[3] || DEFAULT_DB_PATH;
    const result = syncToCloud({ dbPath });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(result.status === "DEBOUNCED" ? 0 : 1);
  }
  process.stderr.write(
    "usage: managed-agents-client.mjs [--status | --send <agentId> <json> | --project [dbPath] | --sync [dbPath]]\n"
  );
  process.exit(2);
}
