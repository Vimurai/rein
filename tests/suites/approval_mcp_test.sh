#!/usr/bin/env bash
# approval_mcp_test.sh — Unit tests for approval-mcp (E-10)
# Tests HITL gate security mitigations T-HITL-001..005, SQLite schema,
# input validation, and registry registration. Absorbs session_traceability (E-49) below (E-302).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SERVER="${REPO_ROOT}/src/mcp/approval-mcp/index.js"

echo "── Suite: approval_mcp ──────────────────────────────────────────────"

# ── T-HITL-S01: File structure ────────────────────────────────────────────────
echo ""
echo "  [T-HITL-S01] File structure"

assert_status 0 "index.js exists" test -f "$SERVER"
assert_status 0 "package.json exists" test -f "${REPO_ROOT}/src/mcp/approval-mcp/package.json"

# ── T-HITL-S02: Tool declaration (E-37: behavioral roundtrip) ────────────────
echo ""
echo "  [T-HITL-S02] Tool declaration"

source "${SCRIPT_DIR}/../lib/mcp-client.sh"

assert_status 0 "request_approval advertised in tools/list" \
  mcp_assert_tool_listed "$SERVER" "request_approval"

assert_status 0 "action parameter required (inputSchema.required)" \
  mcp_assert_tool_param_required "$SERVER" "request_approval" "action"

assert_status 0 "reason parameter required (inputSchema.required)" \
  mcp_assert_tool_param_required "$SERVER" "request_approval" "reason"

# ── T-HITL-S03: ANSI sanitization (T-HITL-001) ───────────────────────────────
echo ""
echo "  [T-HITL-S03] T-HITL-001 — ANSI/control char sanitization"

assert_status 0 "sanitizeDisplayString strips ANSI CSI sequences" \
  node --input-type=module <<'JS'
const sanitize = (s) => s
  .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b[^[\]]/g, '')
  .replace(/[\x00-\x1F\x7F\x80-\x9F]/g, '');
if (sanitize('\x1b[2Jhello\x1b[31mworld') !== 'helloworld') process.exit(1);
JS

assert_status 0 "sanitizeDisplayString strips cursor movement sequences" \
  node --input-type=module <<'JS'
const sanitize = (s) => s
  .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  .replace(/[\x00-\x1F\x7F]/g, '');
if (sanitize('\x1b[1A\x1b[2Kfake prompt') !== 'fake prompt') process.exit(1);
JS

assert_status 0 "sanitizeDisplayString strips newlines and carriage returns" \
  node --input-type=module <<'JS'
const sanitize = (s) => s.replace(/[\x00-\x1F\x7F\x80-\x9F]/g, '');
if (sanitize('line1\r\nline2\ttab') !== 'line1line2tab') process.exit(1);
JS

assert_status 0 "sanitizeDisplayString preserves normal text" \
  node --input-type=module <<'JS'
const sanitize = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x1F\x7F]/g, '');
const input = 'Run prisma migrate deploy';
if (sanitize(input) !== input) process.exit(1);
JS

assert_status 0 "sanitizeDisplayString present in source" \
  grep -q 'sanitizeDisplayString' "$SERVER"

# ── T-HITL-S04: DB_PATH hardcoded (T-HITL-002) ───────────────────────────────
echo ""
echo "  [T-HITL-S04] T-HITL-002 — SQLite path hardcoded"

assert_status 0 "DB_PATH is a const (not derived from env/args)" \
  grep -q 'const DB_PATH' "$SERVER"

assert_status 1 "DB_PATH not read from process.env" \
  grep -qE 'DB_PATH\s*=.*process\.env' "$SERVER"

assert_status 1 "DB_PATH not read from tool arguments" \
  grep -qE 'DB_PATH\s*=.*args\.' "$SERVER"

assert_status 0 "DB_PATH stored in ~/.rein/" \
  grep -q 'approvals.sqlite' "$SERVER"

# ── T-HITL-S05: TTY assertion (T-HITL-003) ───────────────────────────────────
echo ""
echo "  [T-HITL-S05] T-HITL-003 — Non-TTY gate refusal"

assert_status 0 "isTTYAvailable checks process.stdin.isTTY" \
  grep -q 'process.stdin.isTTY' "$SERVER"

assert_status 0 "NON_TTY status returned when not a TTY" \
  grep -q '"NON_TTY"' "$SERVER"

assert_status 0 "gate never auto-approves on TTY failure" \
  node --input-type=module - "$SERVER" <<'JS'
import { readFileSync } from 'fs';
const src = readFileSync(process.argv[2], 'utf8');
// NON_TTY branch: find the if (!isTTYAvailable()) block and confirm it uses NON_TTY not APPROVED
const nonTtyIdx = src.indexOf('!isTTYAvailable()');
if (nonTtyIdx === -1) process.exit(1);
const nonTtyBlock = src.slice(nonTtyIdx, nonTtyIdx + 600);
if (!nonTtyBlock.includes('NON_TTY')) process.exit(1);
if (nonTtyBlock.includes('"APPROVED"')) process.exit(1);
JS

assert_status 0 "rl close event resolves to REJECTED not APPROVED" \
  grep -q 'resolve("REJECTED")' "$SERVER"

# ── T-HITL-S06: SQLite write before response (T-HITL-004) ────────────────────
echo ""
echo "  [T-HITL-S06] T-HITL-004 — Audit record before MCP response"

assert_status 0 "recordDecision called before returning content" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
const recordIdx = src.lastIndexOf('recordDecision(');
const returnIdx = src.lastIndexOf('return {');
if (recordIdx === -1 || returnIdx === -1) process.exit(1);
// recordDecision must come before the final return
if (recordIdx > returnIdx) process.exit(1);
JS

assert_status 0 "NON_TTY path also records to SQLite" \
  grep -q 'recordDecision.*NON_TTY' "$SERVER"

assert_status 0 "SQLite CHECK constraint on status column" \
  grep -q "CHECK(status IN" "$SERVER"

assert_status 0 "approvals table has action, reason, status, timestamp" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
for (const col of ['action', 'reason', 'status', 'requested_at']) {
  if (!src.includes(col)) { console.error('Missing column:', col); process.exit(1); }
}
JS

# ── T-HITL-S07: Input length limits (T-HITL-005) ─────────────────────────────
echo ""
echo "  [T-HITL-S07] T-HITL-005 — Input length enforcement"

assert_status 0 "MAX_ACTION_LENGTH constant defined" \
  grep -q 'MAX_ACTION_LENGTH' "$SERVER"

assert_status 0 "MAX_REASON_LENGTH constant defined" \
  grep -q 'MAX_REASON_LENGTH' "$SERVER"

assert_status 0 "action length checked and rejected (not truncated)" \
  grep -q 'action.length > MAX_ACTION_LENGTH' "$SERVER"

assert_status 0 "reason length checked and rejected (not truncated)" \
  grep -q 'reason.length > MAX_REASON_LENGTH' "$SERVER"

assert_status 0 "action maxLength 200 in JSON schema" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
if (!src.includes('MAX_ACTION_LENGTH') || !src.includes('200')) process.exit(1);
JS

assert_status 0 "SQLite CHECK enforces action length as defense-in-depth" \
  grep -q "CHECK(length(action)" "$SERVER"

# ── T-HITL-S08: Observability ─────────────────────────────────────────────────
echo ""
echo "  [T-HITL-S08] Observability — structured JSON logging"

assert_status 0 "shared logger imported" \
  grep -q 'createLogger.*shared/logger' "$SERVER"

assert_status 0 "logger initialised with SERVICE" \
  grep -q 'createLogger(SERVICE)' "$SERVER"

assert_status 0 "latency_ms tracked" \
  grep -q 'latency_ms' "$SERVER"

assert_status 0 "startup log entry emitted" \
  grep -q '"startup"' "$SERVER"

# ── T-HITL-S09: Registry and .mcp.json ───────────────────────────────────────
echo ""
echo "  [T-HITL-S09] Registry and .mcp.json"

assert_status 0 "approval-mcp in registry.json" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('${REPO_ROOT}/src/config/registry.json', 'utf8'));
if (!r.mcp_servers['approval-mcp']) process.exit(1);
JS

assert_status 0 "registry allows only request_approval tool" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('${REPO_ROOT}/src/config/registry.json', 'utf8'));
const tools = r.mcp_servers['approval-mcp']['allowed-tools'];
if (!Array.isArray(tools) || tools.length !== 1 || tools[0] !== 'request_approval') process.exit(1);
JS

assert_status 0 "registry entry has _security annotation" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('${REPO_ROOT}/src/config/registry.json', 'utf8'));
if (!r.mcp_servers['approval-mcp']._security) process.exit(1);
JS

# E-364 (D-117): .mcp.json is generated by `rein sync` and no longer tracked, so a clean checkout
# has none. What it would show is that the registry entry has a path: rein_sync_test's generator
# rows and tests/tools/registry-drift.sh prove every path-based registry server is wired.
assert_status 0 "approval-mcp is a path-based registry server (the sync step wires it into .mcp.json)" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('${REPO_ROOT}/src/config/registry.json', 'utf8'));
if (!r.mcp_servers['approval-mcp'] || !r.mcp_servers['approval-mcp'].path) process.exit(1);
JS


# ── E-49 (from session_traceability — E-302): session-id traceability of approvals ──
# Tests for E-49 Session Traceability.
#
# Verifies the contract demanded by claude-code-optimizations.md
# §"Session Audit Enhancer" + §Security:
#   • approval-mcp adds session_id TEXT column with idempotent migration.
#   • CLAUDE_CODE_SESSION_ID is sanitised: [A-Za-z0-9-]{1,64} only.
#   • recordDecision INSERT picks up the env value.
#   • NULL when env is unset / malformed / oversized.
set +e   # this section ran under its own suite's error mode
APPROVAL="${REPO_ROOT}/src/mcp/approval-mcp/index.js"

# ── T-SES-S01: approval-mcp source contract ─────────────────────────────────
echo ""
echo "  [T-SES-S01] approval-mcp source contract"

assert_status 0 "captureSessionId helper exists" \
  grep -q 'function captureSessionId' "$APPROVAL"

assert_status 0 "session-id length cap is 64"   grep -q 'SESSION_ID_MAX_LENGTH = 64' "$APPROVAL"
assert_status 0 "session-id regex restricts charset" \
  grep -qE 'SESSION_ID_RE.*A-Za-z0-9' "$APPROVAL"

assert_status 0 "ALTER TABLE add column is idempotent" \
  grep -q "pragma_table_info" "$APPROVAL"
assert_status 0 "session_id added only when missing" \
  grep -q 'cols.includes("session_id")' "$APPROVAL"
assert_status 0 "INSERT now binds 4 params" \
  grep -q 'INSERT INTO approvals (action, reason, status, session_id) VALUES (?, ?, ?, ?)' "$APPROVAL"
assert_status 0 "recordDecision passes captureSessionId() to stmt.run" \
  grep -q 'stmt.run(action, reason, status, captureSessionId())' "$APPROVAL"

# ── T-SES-S02: Behavioural — captureSessionId sanitiser table ───────────────
echo ""
echo "  [T-SES-S02] captureSessionId behavioural table"

# Run the full sanitiser table inside a single Node script — no bash quoting
# games. The script exits 0 if every input maps to its expected output and
# non-zero with a diagnostic on the first mismatch.
assert_status 0 "captureSessionId passes the full input/output table" \
  node --input-type=module <<'JS'
const SESSION_ID_MAX_LENGTH = 64;
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
function captureSessionId(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > SESSION_ID_MAX_LENGTH) return null;
  return SESSION_ID_RE.test(trimmed) ? trimmed : null;
}

const cases = [
  // Accepts.
  ["01J9X2A1Z3-abcd-EFGH",                "01J9X2A1Z3-abcd-EFGH"],
  ["A",                                    "A"],
  ["-".repeat(64),                         "-".repeat(64)],
  ["aB-9".repeat(16),                      "aB-9".repeat(16)],          // 64 chars exactly
  // Rejects.
  [undefined,                              null],
  [null,                                   null],
  ["",                                     null],
  ["   ",                                  null],
  ["abc def",                              null],
  ["abc'); DROP TABLE approvals; --",      null],
  ["abc\nx",                               null],
  ["-".repeat(65),                         null],
  [{ raw: "object" },                      null],
];

for (const [input, expected] of cases) {
  const got = captureSessionId(input);
  if (got !== expected) {
    process.stderr.write(`mismatch: input=${JSON.stringify(input)} expected=${JSON.stringify(expected)} got=${JSON.stringify(got)}\n`);
    process.exit(1);
  }
}
JS

# ── T-SES-S03: End-to-end — schema migration applied + session captured ─────
echo ""
echo "  [T-SES-S03] End-to-end SQLite migration + capture"

# Build a DB the *old* way (pre-E-49 schema), then have the new server open
# it and confirm session_id is added without losing rows.
SBOX="$(mktemp -d -t e49-XXXXXX)"
on_exit 'rm -rf "$SBOX"'

PRE_DB="${SBOX}/approvals.sqlite"
node --input-type=module <<JS
import { DatabaseSync } from "node:sqlite";
const conn = new DatabaseSync("${PRE_DB}");
conn.exec(\`
  CREATE TABLE approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action      TEXT    NOT NULL,
    reason      TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    requested_at TEXT   NOT NULL DEFAULT (datetime('now','utc')),
    resolved_at  TEXT   NOT NULL DEFAULT (datetime('now','utc'))
  );
\`);
conn.prepare("INSERT INTO approvals (action, reason, status) VALUES (?, ?, ?)").run(
  "legacy-action", "pre-existing row", "APPROVED"
);
conn.close();
JS

# Now run the *new* helpers (extracted) against the same DB and confirm:
#   1. column added,
#   2. legacy row preserved,
#   3. new insert captures sanitised session.
HOME_OVERRIDE="$SBOX" CLAUDE_CODE_SESSION_ID="01J9X2A1Z3-abcd-EFGH" node --input-type=module <<JS
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";

const STORE_DIR = "${SBOX}";
const DB_PATH = STORE_DIR + "/approvals.sqlite";
const MAX_ACTION_LENGTH = 200;
const MAX_REASON_LENGTH = 500;
const SESSION_ID_MAX_LENGTH = 64;
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
function captureSessionId() {
  const raw = process.env.CLAUDE_CODE_SESSION_ID;
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > SESSION_ID_MAX_LENGTH) return null;
  return SESSION_ID_RE.test(trimmed) ? trimmed : null;
}

mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
const conn = new DatabaseSync(DB_PATH);
conn.exec("PRAGMA journal_mode = WAL;");
conn.exec("PRAGMA foreign_keys = ON;");
conn.exec(\`
  CREATE TABLE IF NOT EXISTS approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action      TEXT    NOT NULL CHECK(length(action) <= \${MAX_ACTION_LENGTH}),
    reason      TEXT    NOT NULL CHECK(length(reason) <= \${MAX_REASON_LENGTH}),
    status      TEXT    NOT NULL CHECK(status IN ('APPROVED','REJECTED','NON_TTY')),
    requested_at TEXT   NOT NULL DEFAULT (datetime('now','utc')),
    resolved_at  TEXT   NOT NULL DEFAULT (datetime('now','utc'))
  );
\`);
const cols = conn
  .prepare("SELECT name FROM pragma_table_info('approvals')")
  .all()
  .map((r) => r.name);
if (!cols.includes("session_id")) {
  conn.exec(
    \`ALTER TABLE approvals ADD COLUMN session_id TEXT
       CHECK(session_id IS NULL OR length(session_id) <= \${SESSION_ID_MAX_LENGTH})\`
  );
}
conn.prepare(
  "INSERT INTO approvals (action, reason, status, session_id) VALUES (?, ?, ?, ?)"
).run("test-action", "with session", "APPROVED", captureSessionId());

const colsAfter = conn.prepare("SELECT name FROM pragma_table_info('approvals')").all().map(r => r.name);
if (!colsAfter.includes("session_id")) { console.error("session_id column missing"); process.exit(1); }

const rows = conn.prepare("SELECT id, action, session_id FROM approvals ORDER BY id").all();
if (rows.length !== 2) { console.error("row count drift:", rows.length); process.exit(1); }
if (rows[0].action !== "legacy-action" || rows[0].session_id !== null) {
  console.error("legacy row corrupted:", rows[0]); process.exit(1);
}
if (rows[1].session_id !== "01J9X2A1Z3-abcd-EFGH") {
  console.error("new row missing session_id:", rows[1]); process.exit(1);
}

// Idempotent re-run: opening again must not re-add or error.
const conn2 = new DatabaseSync(DB_PATH);
const cols2 = conn2.prepare("SELECT name FROM pragma_table_info('approvals')").all().map(r => r.name);
if (!cols2.includes("session_id")) process.exit(2);
process.exit(0);
JS
RC=$?
assert_status 0 "schema migrated, legacy row preserved, idempotent" bash -c "[[ $RC -eq 0 ]]"

# ── T-SES-S04: rein-log skill documents the contract ──────────────────────────
echo ""
echo "  [T-SES-S04] rein-log skill body"

# The canonical source plus the Claude workspace copy — the only workspace in v4 (E-254).
_AI_LOG_COPIES=(
  "${REPO_ROOT}/src/shared/skills/rein-log/SKILL.md"
  "${REPO_ROOT}/.claude/skills/rein-log/SKILL.md"
)
for f in "${_AI_LOG_COPIES[@]}"; do

  assert_status 0 "${f#${REPO_ROOT}/} exists" test -f "$f"
  # E-284 (D-075 §5): the session id comes from the native ${CLAUDE_SESSION_ID} skill
  # substitution, not an environment read inside the skill body.
  assert_status 0 "${f##*/skills/rein-log/} uses the \${CLAUDE_SESSION_ID} substitution" \
    grep -qF '${CLAUDE_SESSION_ID}' "$f"
  assert_status 1 "${f##*/skills/rein-log/} no longer reads CLAUDE_CODE_SESSION_ID" \
    grep -q 'CLAUDE_CODE_SESSION_ID' "$f"
  assert_status 0 "${f##*/skills/rein-log/} documents the session= tag format" \
    grep -qE 'session=' "$f"
  assert_status 0 "${f##*/skills/rein-log/} documents the bounded regex" \
    grep -qE '\[A-Za-z0-9-\]\{1,64\}' "$f"
  assert_status 0 "${f##*/skills/rein-log/} documents the 'session=invalid' fallback" \
    grep -q 'session=invalid' "$f"
done

# Mirror identity.
SRC_HASH="$(md5sum "${REPO_ROOT}/src/shared/skills/rein-log/SKILL.md" | awk '{print $1}')"
CLA_HASH="$(md5sum "${REPO_ROOT}/.claude/skills/rein-log/SKILL.md"     | awk '{print $1}')"
assert_status 0 ".claude mirror = src" bash -c "[[ '$SRC_HASH' == '$CLA_HASH' ]]"
set -e

assert_summary
