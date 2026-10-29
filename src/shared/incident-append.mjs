#!/usr/bin/env node
// E-65: incident-append.mjs — atomic NDJSON appender for ~/.rein/incidents.ndjson.
//
// Invocation:
//   node incident-append.mjs '<json>'
//
// Where <json> is an object with:
//   incident_type    string  required   ("MCP_CRASH" | "DRIFT_DETECTED" | "ENV_ERROR" | …)
//   message          string  required   short human description
//   stack_signature  string  required   stable grouping key, e.g. "task-synchronizer-mcp/index.js:45"
//   source_agent     string  optional   "Claude" | "Tester"
//
// Sanitization (incident-tracker.md §Security):
//   - $HOME → "~"  (every occurrence)
//   - emails redacted to "[email]"
//   - bearer-style tokens redacted to "[token]" (sk_*, ghp_*, hex≥32)
//   - message truncated to 500 chars, signature to 200 chars
//   - timestamp injected by the helper (UTC ISO-8601)
//
// Rotation: when the active log exceeds INCIDENT_ROTATE_LINES lines, it is
// renamed to incidents-YYYY-MM.ndjson.archive and a fresh file is created.
//
// Honours AI_INCIDENT_TRACKER_DISABLE=1 (incident-tracker.md §Rollback):
// emits a single warning to stderr and exits 0 so callers stay fail-open.
//
// Pure node (no deps). Boot ≪10ms — must stay in the preflight budget.

import { existsSync, mkdirSync, appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { redact } from "./publish-scan.mjs";

const INCIDENTS_DIR    = resolve(homedir(), ".rein");
const INCIDENTS_PATH   = resolve(INCIDENTS_DIR, "incidents.ndjson");
const INCIDENT_ROTATE_LINES = Number(process.env.INCIDENT_ROTATE_LINES || 500);
const MAX_MSG_LEN      = 500;
const MAX_SIG_LEN      = 200;

function emitErr(code, detail) {
  process.stderr.write(JSON.stringify({ service: "incident-append", level: "error", code, detail }) + "\n");
}

function sanitizeString(s) {
  if (typeof s !== "string") return "";
  let out = s;
  // $HOME-prefixed absolute paths → "~/..."
  const home = homedir();
  if (home) out = out.split(home).join("~");
  // Emails (RFC 5322-ish, conservative)
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  // Bearer-style secret prefixes
  out = out.replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr|xoxb|xoxp|AKIA)[A-Za-z0-9_-]{16,}/g, "[token]");
  // Long hex strings (≥32 chars) — likely tokens or hashes
  out = out.replace(/\b[a-fA-F0-9]{32,}\b/g, "[hex]");
  // E-379 (D-130): then the shared redactor — credentials by the D-080 detector, other users'
  // home paths, session ids and sockets. The rules above stay: this file is broader on purpose
  // (every address, reserved example domains included). No operator list is read here.
  return redact(out, { file: "incidents.ndjson", count: false });
}

function rotateIfNeeded() {
  if (!existsSync(INCIDENTS_PATH)) return;
  let st;
  try { st = statSync(INCIDENTS_PATH); } catch { return; }
  if (!st || st.size === 0) return;
  // Cheap line count via single read — acceptable up to a few MB; large files
  // hint at a runaway agent, where rotation is the right move anyway.
  let lines;
  try {
    lines = readFileSync(INCIDENTS_PATH, "utf8").split("\n").length - 1;
  } catch {
    return;
  }
  if (lines < INCIDENT_ROTATE_LINES) return;
  const ym = new Date().toISOString().slice(0, 7);
  const archived = resolve(INCIDENTS_DIR, `incidents-${ym}.ndjson.archive`);
  // Atomic rename: if a same-month archive already exists, append; else rename.
  if (existsSync(archived)) {
    try {
      const tail = readFileSync(INCIDENTS_PATH, "utf8");
      appendFileSync(archived, tail, "utf8");
      writeFileSync(INCIDENTS_PATH, "", "utf8");
    } catch (e) {
      emitErr("rotate-failed-append", e.message);
    }
  } else {
    try { renameSync(INCIDENTS_PATH, archived); } catch (e) { emitErr("rotate-failed-rename", e.message); }
  }
}

function main(argv) {
  if (process.env.AI_INCIDENT_TRACKER_DISABLE === "1") {
    process.stderr.write("[incident-append] AI_INCIDENT_TRACKER_DISABLE=1 — skipping\n");
    return 0;
  }
  const raw = argv[2];
  if (!raw || typeof raw !== "string") {
    emitErr("missing-arg", "expected: incident-append.mjs <json>");
    return 1;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    emitErr("invalid-json", e.message);
    return 1;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    emitErr("invalid-payload", "payload must be a JSON object");
    return 1;
  }
  const required = ["incident_type", "message", "stack_signature"];
  for (const k of required) {
    if (typeof parsed[k] !== "string" || !parsed[k].trim()) {
      emitErr("missing-field", `field "${k}" must be a non-empty string`);
      return 1;
    }
  }
  // E-255: "Tester" is the headless Claude Tester role (D-069).
  const allowedAgents = new Set(["Claude", "Tester", "unknown"]);
  const agent = parsed.source_agent && allowedAgents.has(parsed.source_agent)
    ? parsed.source_agent
    : "unknown";

  const record = {
    timestamp:       new Date().toISOString(),
    incident_type:   sanitizeString(parsed.incident_type).slice(0, 64),
    source_agent:    agent,
    message:         sanitizeString(parsed.message).slice(0, MAX_MSG_LEN),
    stack_signature: sanitizeString(parsed.stack_signature).slice(0, MAX_SIG_LEN),
  };

  if (!existsSync(INCIDENTS_DIR)) {
    try { mkdirSync(INCIDENTS_DIR, { recursive: true }); } catch (e) {
      emitErr("mkdir-failed", e.message);
      return 1;
    }
  }
  rotateIfNeeded();
  try {
    appendFileSync(INCIDENTS_PATH, JSON.stringify(record) + "\n", "utf8");
  } catch (e) {
    emitErr("append-failed", e.message);
    return 1;
  }
  process.stdout.write(JSON.stringify({ ok: true, path: INCIDENTS_PATH, record }) + "\n");
  return 0;
}

process.exit(main(process.argv));
