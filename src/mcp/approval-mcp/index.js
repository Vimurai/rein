#!/usr/bin/env node
/**
 * approval-mcp — AI-OS MCP Server
 * Human-in-the-Loop (HITL) CLI gate for Tier 3 security operations.
 *
 * Blueprint: .ai/blueprints/interop.md §2
 *
 * Security mitigations enforced (per .ai/SECURITY.md T-HITL-001..005):
 *   T-HITL-001: ANSI escape sequences and control chars stripped from
 *               action/reason before display — prevents terminal spoofing.
 *   T-HITL-002: DB_PATH is a hardcoded source constant — no user input
 *               can redirect the audit trail.
 *   T-HITL-003: stdin.isTTY asserted at startup and per-request — gate
 *               refuses to auto-approve in non-interactive environments.
 *               Only explicit 'y'/'Y' is APPROVED; everything else is REJECTED.
 *   T-HITL-004: Approval written to SQLite BEFORE MCP response is returned
 *               — no approval can be claimed without a record.
 *   T-HITL-005: action maxLength 200, reason maxLength 500 — enforced at
 *               JSON Schema level AND at runtime; requests exceeding limits
 *               are rejected outright (not silently truncated).
 *
 * Tools:
 *   request_approval({ action, reason })
 *     → { status: "APPROVED" | "REJECTED", action, reason, timestamp, id }
 *
 * Observability:
 *   Structured JSON logs to stderr:
 *   { timestamp, level, service:"approval-mcp", tool, latency_ms, error? }
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { instrument } from "../../shared/mcp-telemetry.mjs";
import { DatabaseSync } from "node:sqlite";
import * as readline from "node:readline";
import { mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../shared/logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SERVICE = "approval-mcp";
const VERSION = "1.0.0";

// T-HITL-002: DB_PATH hardcoded — never derived from user input or env vars.
// Stored in ~/.ai-os/ alongside other AI-OS state (follows token-budget-mcp pattern).
const STORE_DIR = resolve(homedir(), ".ai-os");
const DB_PATH = join(STORE_DIR, "approvals.sqlite");

// Input length limits (T-HITL-005)
const MAX_ACTION_LENGTH = 200;
const MAX_REASON_LENGTH = 500;

// ── Structured logger (obs_baseline §Logging) ────────────────────────────────
// Shared NDJSON logger; emits one JSON line per call to stderr.

const logger = createLogger(SERVICE);
const log = (level, tool, message, extras) => logger.log(level, tool, message, extras);

// ── Security helpers ──────────────────────────────────────────────────────────

/**
 * T-HITL-001: Strip ANSI escape sequences and ASCII control characters.
 * Prevents terminal spoofing via cursor repositioning or screen clearing.
 *
 * Strips:
 *   - ANSI CSI sequences: ESC [ ... (final byte A-Za-z)
 *   - OSC sequences: ESC ] ... ST
 *   - All C0/C1 control chars (0x00-0x1F, 0x7F, 0x80-0x9F) except printable
 */
function sanitizeDisplayString(str) {
  return str
    // Strip ANSI escape sequences (CSI, OSC, etc.)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[^[\]]/g, "")
    // Strip remaining control chars (keep printable ASCII + common Unicode)
    .replace(/[\x00-\x1F\x7F\x80-\x9F]/g, "");
}

/**
 * T-HITL-003: Assert stdin is a real TTY.
 * Returns true if the gate can proceed, false if it must reject.
 */
function isTTYAvailable() {
  return process.stdin.isTTY === true;
}

// ── SQLite setup ──────────────────────────────────────────────────────────────

let db = null;

// E-49: Session-traceability sanitiser. CLAUDE_CODE_SESSION_ID is treated
// as untrusted input from the environment per claude-code-optimizations.md
// §Security. We accept only [A-Za-z0-9-] and cap the length at 64 — long
// enough for a UUIDv4 (36) plus a generous prefix, short enough to preclude
// pathological payloads. Anything else collapses to NULL so the audit trail
// never carries a hostile string.
const SESSION_ID_MAX_LENGTH = 64;
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
function captureSessionId() {
  const raw = process.env.CLAUDE_CODE_SESSION_ID;
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > SESSION_ID_MAX_LENGTH) return null;
  return SESSION_ID_RE.test(trimmed) ? trimmed : null;
}

function getDb() {
  if (db) return db;
  mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  const conn = new DatabaseSync(DB_PATH);
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA foreign_keys = ON;");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT    NOT NULL CHECK(length(action) <= ${MAX_ACTION_LENGTH}),
      reason      TEXT    NOT NULL CHECK(length(reason) <= ${MAX_REASON_LENGTH}),
      status      TEXT    NOT NULL CHECK(status IN ('APPROVED','REJECTED','NON_TTY')),
      requested_at TEXT   NOT NULL DEFAULT (datetime('now','utc')),
      resolved_at  TEXT   NOT NULL DEFAULT (datetime('now','utc'))
    );
  `);

  // E-49: idempotent schema migration. ALTER TABLE … ADD COLUMN errors if
  // the column already exists, so probe pragma_table_info first.
  const cols = conn
    .prepare("SELECT name FROM pragma_table_info('approvals')")
    .all()
    .map((r) => r.name);
  if (!cols.includes("session_id")) {
    conn.exec(
      `ALTER TABLE approvals ADD COLUMN session_id TEXT
         CHECK(session_id IS NULL OR length(session_id) <= ${SESSION_ID_MAX_LENGTH})`
    );
  }

  db = conn;
  return db;
}

/**
 * T-HITL-004: Write approval record to SQLite BEFORE returning the MCP response.
 * E-49: Captures sanitised CLAUDE_CODE_SESSION_ID from the environment so
 * every audit row links back to the originating Claude Code session.
 * Returns the inserted row ID.
 */
function recordDecision(action, reason, status) {
  const conn = getDb();
  const stmt = conn.prepare(
    "INSERT INTO approvals (action, reason, status, session_id) VALUES (?, ?, ?, ?)"
  );
  const result = stmt.run(action, reason, status, captureSessionId());
  return result.lastInsertRowid;
}

// ── Interactive prompt ────────────────────────────────────────────────────────

/**
 * Display a blocking Y/N prompt on the host terminal and wait for input.
 * T-HITL-003: Only 'y' or 'Y' returns APPROVED. All other input → REJECTED.
 * T-HITL-001: action and reason are sanitized before display.
 */
function promptHuman(safeAction, safeReason) {
  return new Promise((resolve) => {
    // HITL prompts are written to process.stderr — it reaches the operator's
    // terminal without polluting the MCP stdio (stdout) JSON-RPC channel.
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    const divider = "━".repeat(60);
    process.stderr.write(`\n${divider}\n`);
    process.stderr.write(`  ⚠  AI-OS HITL GATE — TIER 3 APPROVAL REQUIRED\n`);
    process.stderr.write(`${divider}\n`);
    process.stderr.write(`  Action : ${safeAction}\n`);
    process.stderr.write(`  Reason : ${safeReason}\n`);
    process.stderr.write(`${divider}\n`);
    process.stderr.write(`  Approve this operation? [y/N] `);

    rl.once("line", (answer) => {
      rl.close();
      const approved = answer.trim() === "y" || answer.trim() === "Y";
      process.stderr.write(`\n  → ${approved ? "APPROVED ✓" : "REJECTED ✗"}\n`);
      process.stderr.write(`${divider}\n\n`);
      resolve(approved ? "APPROVED" : "REJECTED");
    });

    // T-HITL-003: On stdin close/error without input → REJECTED, never APPROVED
    rl.once("close", () => resolve("REJECTED"));
  });
}

// ── MCP server setup ──────────────────────────────────────────────────────────

const server = new Server(
  { name: SERVICE, version: VERSION },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "request_approval",
      description: [
        "Surfaces a blocking Human-in-the-Loop (HITL) Y/N prompt for a Tier 3 operation.",
        "The gate CANNOT be bypassed — it requires explicit human keyboard input ('y'/'Y').",
        "All approvals and rejections are permanently recorded in ~/.ai-os/approvals.sqlite.",
        "",
        "Returns { status: 'APPROVED' | 'REJECTED', action, reason, timestamp, id }.",
        "On REJECTED: abort the current E-## task and mark it BLOCKED.",
        "On NON_TTY: gate refused — terminal not interactive. Mark task BLOCKED.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "The specific operation requiring approval (max 200 chars).",
            maxLength: MAX_ACTION_LENGTH,
          },
          reason: {
            type: "string",
            description: "Why this operation requires human approval (max 500 chars).",
            maxLength: MAX_REASON_LENGTH,
          },
        },
        required: ["action", "reason"],
      },
    },
  ],
}));

// ── Tool dispatcher ───────────────────────────────────────────────────────────

instrument(server, "approval-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const start = Date.now();

  if (name !== "request_approval") {
    return {
      content: [{ type: "text", text: `Error: Unknown tool: ${name}` }],
      isError: true,
    };
  }

  const { action, reason } = args;

  // ── Input validation ────────────────────────────────────────────────────────

  if (!action || typeof action !== "string" || action.trim().length === 0) {
    return {
      content: [{ type: "text", text: "Error: action must be a non-empty string" }],
      isError: true,
    };
  }
  if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
    return {
      content: [{ type: "text", text: "Error: reason must be a non-empty string" }],
      isError: true,
    };
  }

  // T-HITL-005: Reject (not truncate) inputs exceeding length limits
  if (action.length > MAX_ACTION_LENGTH) {
    return {
      content: [{
        type: "text",
        text: `Error: action exceeds ${MAX_ACTION_LENGTH} characters (got ${action.length}). Shorten the action description.`,
      }],
      isError: true,
    };
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return {
      content: [{
        type: "text",
        text: `Error: reason exceeds ${MAX_REASON_LENGTH} characters (got ${reason.length}). Shorten the reason.`,
      }],
      isError: true,
    };
  }

  // T-HITL-001: Sanitize before any display or storage
  const safeAction = sanitizeDisplayString(action);
  const safeReason = sanitizeDisplayString(reason);

  // T-HITL-003: Refuse to run in non-interactive environments
  if (!isTTYAvailable()) {
    log("warn", "request_approval", "stdin is not a TTY — gate rejected (NON_TTY)", {
      action: safeAction,
    });
    // T-HITL-004: Record the NON_TTY refusal in SQLite
    let id = null;
    try { id = recordDecision(safeAction, safeReason, "NON_TTY"); } catch { /* best-effort */ }
    const latency_ms = Date.now() - start;
    log("warn", "request_approval", "NON_TTY refusal recorded", { latency_ms, id });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "NON_TTY",
          error:
            "approval-mcp requires an interactive terminal (stdin.isTTY). " +
            "The gate was not shown. Mark this task BLOCKED and restart in an interactive session.",
          action: safeAction,
          reason: safeReason,
          id,
        }, null, 2),
      }],
      isError: true,
    };
  }

  try {
    // Display prompt and wait for human input
    const status = await promptHuman(safeAction, safeReason);

    // T-HITL-004: Write to SQLite BEFORE returning MCP response
    const id = recordDecision(safeAction, safeReason, status);
    const timestamp = new Date().toISOString();
    const latency_ms = Date.now() - start;

    log("info", "request_approval", `decision: ${status}`, {
      latency_ms,
      id,
      action: safeAction,
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          { status, action: safeAction, reason: safeReason, timestamp, id },
          null,
          2
        ),
      }],
    };
  } catch (err) {
    const latency_ms = Date.now() - start;
    log("error", "request_approval", "Unexpected error in HITL gate", {
      latency_ms,
      error: err.message,
    });
    return {
      content: [{ type: "text", text: `Error: HITL gate failed: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

// Initialise DB schema on startup (fail fast if SQLite unavailable)
try {
  getDb();
} catch (err) {
  log("error", "startup", "Failed to initialise approvals.sqlite", {
    error: err.message,
    db_path: DB_PATH,
  });
  process.exit(1);
}

log("info", "startup", `approval-mcp v${VERSION} ready`, {
  db_path: DB_PATH,
  tty_available: isTTYAvailable(),
});

if (isMainModule(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
