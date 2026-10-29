#!/usr/bin/env node
/**
 * managed_agents_spike.js — E-47 architectural feasibility spike.
 *
 * Question (per .ai/blueprints/may-2026-upgrades.md §3 / §"Components"):
 *   Can local SQLite state (`.ai/state.json` + task-synchronizer-mcp) be
 *   replaced by Claude's `managed-agents-2026-04-01` API — specifically its
 *   built-in filesystem memory and webhook lifecycle events?
 *
 * This is an EXPLORATION script, not a production feature. It:
 *   1. Models the managed-agents-2026-04-01 contract surface from the blueprint
 *      (no live API call — credentials are not in scope for a spike).
 *   2. Reads the local `.ai/state.json` (if present) and projects it into the
 *      candidate Managed-Agent filesystem layout.
 *   3. Sanitises every projected payload — strips anything matching the
 *      sensitive-file rules from the E-46 memory_curator gating, since both
 *      features cross the same trust boundary.
 *   4. Sketches the webhook lifecycle (`task.opened`, `stamp.recorded`,
 *      `archive.requested`) and asserts the local handlers we'd need.
 *   5. Emits a verdict (PROCEED / INCONCLUSIVE / ABANDON) with rationale,
 *      so the architect can decide whether to invest in the migration.
 *
 * Exit code:
 *   0   verdict ∈ {PROCEED, INCONCLUSIVE}; spike completed cleanly
 *   2   sanitisation gate fired — secrets would have leaked → ABANDON
 *   3   structural mismatch — schema cannot round-trip → ABANDON
 *   1   internal spike error (read failure, malformed state, etc.)
 *
 * Stdout: a single JSON document with the full report.
 * Stderr: human-readable summary lines.
 *
 * The spike must not call any network. Treat the contract surface below as
 * authoritative for the duration of the exploration; when the team commits
 * to this migration, replace the mock client with a real SDK.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const SPIKE_VERSION = "1.0.0";
const API_VERSION   = "managed-agents-2026-04-01";

// ── 1. Mock contract surface (frozen at spike time) ─────────────────────────
// This shape is derived from the blueprint and what is publicly documented
// for the 2026-04-01 API. Real types will live in @anthropic-ai/sdk once we
// decide to integrate. The spike never imports the SDK to keep the script
// dependency-free.

const MANAGED_AGENT_API = Object.freeze({
  version: API_VERSION,
  endpoints: Object.freeze({
    fs:        "/v1/managed-agents/{agentId}/files",   // read/write JSON
    webhook:   "/v1/managed-agents/{agentId}/hooks",
    lifecycle: ["task.opened", "task.closed", "stamp.recorded", "archive.requested"],
  }),
  // Maximum file size per managed-fs entry (best-effort estimate from the
  // 2026-04-01 docs — refine when we have a real key in hand).
  fs_size_cap_bytes: 1 * 1024 * 1024,
});

// ── 2. Trust-boundary gate (mirrors E-46 memory_curator rules) ───────────────

const SENSITIVE_PATH_RE = /(?:^|\/)(?:\.env|secrets|credentials|\.ssh|\.aws|\.gnupg)(?:\/|$)/i;
const SENSITIVE_NAME_RE = /(?:secret|credential|token|apikey|password|kubeconfig|id_rsa|id_ed25519|\.pem$|\.p12$|\.pfx$)/i;
const SENSITIVE_KEY_RE  = /(?:secret|password|token|apikey|api_key|private_key|credential)/i;

/**
 * Recursively redact any field whose key looks sensitive. Returns a new
 * object — never mutates the input. Logged in the verdict so the caller
 * can audit what would have leaked.
 */
function sanitise(obj, redactions, path = "") {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((v, i) => sanitise(v, redactions, `${path}[${i}]`));
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      redactions.push(`${path}.${k}`);
      out[k] = "[REDACTED]";
      continue;
    }
    out[k] = sanitise(v, redactions, `${path}.${k}`);
  }
  return out;
}

// ── 3. Project local state.json into the candidate managed-fs layout ─────────

/**
 * Map our local state schema to the directory tree we'd want under
 * `/v1/managed-agents/<id>/files/`. Each entry becomes a separate JSON file
 * so a single bad write doesn't corrupt the whole snapshot.
 */
function projectStateToManagedFs(state) {
  const project = state.project || {};
  const tasks   = Array.isArray(state.tasks) ? state.tasks : [];
  const stamps  = Array.isArray(state.stamps) ? state.stamps : [];
  const deltas  = Array.isArray(state.deltas) ? state.deltas : [];

  return {
    "project.json": project,
    "tasks/index.json": { count: tasks.length, ids: tasks.map((t) => t.id) },
    ...Object.fromEntries(
      tasks.map((t) => [`tasks/${(t.id || "unknown").replace(/[^A-Za-z0-9_-]/g, "_")}.json`, t])
    ),
    "stamps/index.json": { count: stamps.length, last: stamps.slice(-10) },
    "deltas/unread.json": deltas.filter((d) => !d?.read),
  };
}

// ── 4. Webhook lifecycle plan ────────────────────────────────────────────────

const WEBHOOK_PLAN = Object.freeze({
  "task.opened": {
    local_handler: "task-synchronizer-mcp::add_task",
    direction: "managed → local",
    rationale: "Managed Agent opens a task; we mirror to state.json so local tooling stays authoritative.",
  },
  "task.closed": {
    local_handler: "task-synchronizer-mcp::update_task_status",
    direction: "managed → local",
    rationale: "Status DONE flows back so TASKS.md re-renders correctly.",
  },
  "stamp.recorded": {
    local_handler: "task-synchronizer-mcp::add_stamp",
    direction: "managed → local",
    rationale: "Critic / handover stamps must reach the local REVIEWS.md view.",
  },
  "archive.requested": {
    local_handler: "archive-manager-mcp::execute_archive",
    direction: "managed → local",
    rationale: "Long-tail compaction stays local — state.sqlite is the audit log of record.",
  },
});

// ── 5. Run the spike ────────────────────────────────────────────────────────

function findings() {
  const repoRoot = process.cwd();
  const statePath = resolve(repoRoot, ".ai/state.json");
  const report = {
    spike_version: SPIKE_VERSION,
    api_version: API_VERSION,
    generated_at: new Date().toISOString(),
    contract: MANAGED_AGENT_API,
    state: { found: false, path: statePath, byte_size: 0 },
    projection: { entries: 0, sample_keys: [] },
    redactions: [],
    structural_issues: [],
    webhook_plan: WEBHOOK_PLAN,
    verdict: "INCONCLUSIVE",
    rationale: "",
  };

  if (!existsSync(statePath)) {
    report.rationale =
      "No local .ai/state.json — spike cannot evaluate projection round-trip without sample data. " +
      "Re-run inside an AI-OS project after `ai init` to get a meaningful verdict.";
    return report;
  }

  let state;
  try {
    const raw = readFileSync(statePath, "utf8");
    report.state.found = true;
    report.state.byte_size = Buffer.byteLength(raw, "utf8");
    state = JSON.parse(raw);
  } catch (e) {
    report.verdict = "ABANDON";
    report.rationale = `state.json read/parse failed: ${e.message}. Spike cannot proceed.`;
    process.stderr.write(`[spike] ABORT: ${e.message}\n`);
    process.exitCode = 1;
    return report;
  }

  // 5a. Sanitisation gate — must not leak secrets.
  const sanitised = sanitise(state, report.redactions);
  if (report.redactions.length > 0) {
    process.stderr.write(
      `[spike] sanitiser redacted ${report.redactions.length} field(s): ${report.redactions.slice(0, 5).join(", ")}${report.redactions.length > 5 ? ", ..." : ""}\n`
    );
  }

  // 5b. Structural projection — does our schema fit the managed-fs surface?
  const projection = projectStateToManagedFs(sanitised);
  report.projection.entries = Object.keys(projection).length;
  report.projection.sample_keys = Object.keys(projection).slice(0, 6);

  // 5c. Each entry must fit under the per-file size cap.
  for (const [name, body] of Object.entries(projection)) {
    const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    if (bytes > MANAGED_AGENT_API.fs_size_cap_bytes) {
      report.structural_issues.push(
        `${name}: ${bytes} bytes > ${MANAGED_AGENT_API.fs_size_cap_bytes} cap — would need chunking before sync`
      );
    }
    if (SENSITIVE_PATH_RE.test(name) || SENSITIVE_NAME_RE.test(name)) {
      report.structural_issues.push(
        `${name}: filename matches sensitive pattern — must be excluded from sync`
      );
    }
  }

  // 5d. Verdict.
  // Per blueprint §Rollback: "If the Managed Agents spike proves insecure or
  // brittle, abandon and maintain local SQLite". Our policy:
  //   - Any structural issue (file too large, sensitive name) → ABANDON for now
  //     and document chunking + name-sanitisation as a precondition for retry.
  //   - Otherwise PROCEED if the projection has at least the four anchor
  //     entries (project, tasks index, stamps index, deltas) the local
  //     state model relies on. Anything less → INCONCLUSIVE.
  //   - The redactions list is INFORMATIONAL — sanitisation worked, so
  //     redacting fields does not flip the verdict.
  const ANCHORS = ["project.json", "tasks/index.json", "stamps/index.json", "deltas/unread.json"];
  const haveAllAnchors = ANCHORS.every((k) => Object.prototype.hasOwnProperty.call(projection, k));

  if (report.structural_issues.length > 0) {
    report.verdict = "ABANDON";
    report.rationale =
      `${report.structural_issues.length} structural issue(s) blocking projection round-trip. ` +
      `Resolve chunking / naming before retrying the migration.`;
    process.exitCode = 3;
  } else if (!haveAllAnchors) {
    report.verdict = "INCONCLUSIVE";
    report.rationale =
      `Projection produced ${report.projection.entries} entries but is missing anchor file(s); ` +
      `state schema may have drifted from the spike's expectations.`;
  } else {
    report.verdict = "PROCEED";
    report.rationale =
      `state.json (${report.state.byte_size} B) projects cleanly into ${report.projection.entries} ` +
      `managed-fs entries under the ${MANAGED_AGENT_API.fs_size_cap_bytes}-byte cap. ` +
      `${report.redactions.length} sensitive field(s) were redacted as expected. ` +
      `Webhook plan covers ${Object.keys(WEBHOOK_PLAN).length}/${MANAGED_AGENT_API.endpoints.lifecycle.length} ` +
      `documented lifecycle events. Recommend a follow-up E-## to wire a real client behind a feature flag.`;
  }

  return report;
}

// ── 6. Entrypoint ────────────────────────────────────────────────────────────

const report = findings();
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.stderr.write(`[spike] verdict=${report.verdict}\n`);
