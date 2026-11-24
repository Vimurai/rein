#!/usr/bin/env bash
# telemetry_test.sh — E-84 src/shared/telemetry.mjs where a process is under test: the CLI
# (--stats, --path, --record-*) and the mirror. E-467 (D-170 r5) retired the post-tool-use hook
# and its task-velocity branch; the store stays while the gate books to it. The module's in-process
# contract is tests/unit/telemetry.test.mjs. Blueprint: meta-cognition.md §Components 1.
#
#   • ~/.rein mirrors are byte-identical.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
# E-257: this suite tests the DEFAULT path itself (~/.rein/telemetry.sqlite under a
# sandbox HOME), so the harness's AI_TELEMETRY_DB_PATH redirect would hide exactly what is
# under test. Every write below goes to a sandbox HOME or an explicit db_path; the
# harness's marker check still fails the run if one ever reaches the live store.
unset AI_TELEMETRY_DB_PATH

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TELEMETRY="${REPO_ROOT}/src/shared/telemetry.mjs"

echo "===== telemetry_test.sh ====="

# ── T-TEL-S01..S07 (module contract, writes, sanitiser, enum, disable flag, stats, deferral)
# and the S18 writability probe run in process in tests/unit/telemetry.test.mjs (E-302).

# ── T-TEL-S08: CLI smoke — --stats + --path ───────────────────────────────────
echo ""
echo "  [T-TEL-S08] CLI smoke — --stats + --path"

# --path always prints the canonical telemetry path.
PATHOUT="$(node "$TELEMETRY" --path)"
assert_contains "--path includes .rein/telemetry.sqlite" ".rein/telemetry.sqlite" "$PATHOUT"

assert_status 0 "--stats exits 0" \
  bash -c "node '$TELEMETRY' --stats >/dev/null"

assert_status 2 "missing subcommand exits 2" \
  bash -c "node '$TELEMETRY' >/dev/null 2>&1"

# ── T-TEL-S11: --record-tool CLI (E-104) ──────────────────────────────────────
echo ""
echo "  [T-TEL-S11] --record-tool consumes stdin JSON and writes a row"

SBOX7="$(mktemp -d)"
tc_fixture_home "$SBOX7"   # E-345 (D-109 r1): the toolchain record the hooks pin
SBOX7_REPO="${SBOX7}/repo"
mkdir -p "${SBOX7_REPO}/.git"           # sentinel so _findProjectRoot stops here

CCID="sess-e104-$(date +%s)"
( cd "${SBOX7_REPO}" \
  && HOME="${SBOX7}" CLAUDE_CODE_SESSION_ID="${CCID}" \
     bash -c "echo '{\"tool_name\":\"HookMyTool\",\"execution_time_ms\":17,\"status\":\"SUCCESS\"}' \
              | node '${TELEMETRY}' --record-tool" )
assert_status 0 "--record-tool exits 0 (fail-open)" \
  bash -c ":"   # the previous block ran; rc captured by next assertion via direct re-run
# Re-run capturing rc explicitly:
( cd "${SBOX7_REPO}" \
  && HOME="${SBOX7}" CLAUDE_CODE_SESSION_ID="${CCID}" \
     bash -c "echo '{\"tool_name\":\"HookMyTool\",\"execution_time_ms\":17,\"status\":\"SUCCESS\"}' \
              | node '${TELEMETRY}' --record-tool >/dev/null 2>&1" )
RC_RT=$?
assert_status 0 "--record-tool rc==0" bash -c "[[ $RC_RT -eq 0 ]]"

# DB must land at $SBOX7/.rein/telemetry.sqlite (HOME-relative)
DB_RT="${SBOX7}/.rein/telemetry.sqlite"
assert_status 0 "telemetry.sqlite created under sandbox HOME" test -f "$DB_RT"

ROW_RT="$(node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('${DB_RT}');
const r = db.prepare('SELECT tool_name, execution_time_ms, status, session_id, project_hash FROM tool_executions ORDER BY timestamp DESC LIMIT 1').get();
process.stdout.write(JSON.stringify(r));
")"
assert_contains "tool_name persisted from stdin" "\"tool_name\":\"HookMyTool\"" "$ROW_RT"
assert_contains "execution_time_ms persisted"   "\"execution_time_ms\":17"     "$ROW_RT"
assert_contains "status SUCCESS persisted"      "\"status\":\"SUCCESS\""       "$ROW_RT"
assert_contains "session_id derived from env"   "\"session_id\":\"${CCID}\""   "$ROW_RT"
assert_status 0 "project_hash is 12 hex chars from sandbox repo cwd" \
  bash -c "grep -qE '\"project_hash\":\"[0-9a-f]{12}\"' <<< '$ROW_RT'"

# Privacy: raw sandbox path must not leak.
assert_not_contains "sandbox path NOT in row" "${SBOX7_REPO}" "$ROW_RT"

# ── T-TEL-S12: --record-task CLI (E-104) ──────────────────────────────────────
echo ""
echo "  [T-TEL-S12] --record-task consumes stdin JSON and writes a row"

SBOX8="$(mktemp -d)"
tc_fixture_home "$SBOX8"   # E-345 (D-109 r1): the toolchain record the hooks pin
( cd "${SBOX8}" \
  && HOME="${SBOX8}" \
     bash -c "echo '{\"task_id\":\"E-104\",\"turn_count\":4,\"tokens_consumed\":2048}' \
              | node '${TELEMETRY}' --record-task >/dev/null 2>&1" )
RC_TV=$?
assert_status 0 "--record-task rc==0" bash -c "[[ $RC_TV -eq 0 ]]"

DB_TV="${SBOX8}/.rein/telemetry.sqlite"
ROW_TV="$(node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('${DB_TV}');
const r = db.prepare('SELECT task_id, turn_count, tokens_consumed FROM task_velocity ORDER BY timestamp DESC LIMIT 1').get();
process.stdout.write(JSON.stringify(r));
")"
assert_contains "task_id persisted"         "\"task_id\":\"E-104\""        "$ROW_TV"
assert_contains "turn_count persisted"      "\"turn_count\":4"             "$ROW_TV"
assert_contains "tokens_consumed persisted" "\"tokens_consumed\":2048"     "$ROW_TV"

# ── T-TEL-S13: --record-* fail-open on malformed/empty stdin (E-104) ─────────
echo ""
echo "  [T-TEL-S13] --record-* never blocks the caller on malformed input"

SBOX9="$(mktemp -d)"
tc_fixture_home "$SBOX9"   # E-345 (D-109 r1): the toolchain record the hooks pin

# Empty stdin → exit 0, no row written, no DB file created.
( cd "${SBOX9}" && HOME="${SBOX9}" \
    bash -c ": | node '${TELEMETRY}' --record-tool >/dev/null 2>&1" )
RC_EMPTY=$?
assert_status 0 "empty stdin still rc==0" bash -c "[[ $RC_EMPTY -eq 0 ]]"
assert_status 1 "empty stdin writes no DB" test -f "${SBOX9}/.rein/telemetry.sqlite"

# Malformed JSON → exit 0, no row written.
SBOX10="$(mktemp -d)"
( cd "${SBOX10}" && HOME="${SBOX10}" \
    bash -c "echo 'not valid json' | node '${TELEMETRY}' --record-tool >/dev/null 2>&1" )
RC_BAD=$?
assert_status 0 "malformed stdin still rc==0" bash -c "[[ $RC_BAD -eq 0 ]]"
assert_status 1 "malformed stdin writes no DB" test -f "${SBOX10}/.rein/telemetry.sqlite"

# Missing tool_name → helper logs and skips, but rc still 0.
SBOX11="$(mktemp -d)"
( cd "${SBOX11}" && HOME="${SBOX11}" \
    bash -c "echo '{\"execution_time_ms\":5}' | node '${TELEMETRY}' --record-tool >/dev/null 2>&1" )
RC_NOTOOL=$?
assert_status 0 "missing tool_name still rc==0" bash -c "[[ $RC_NOTOOL -eq 0 ]]"

# AI_TELEMETRY_DISABLE=1 also short-circuits the CLI write paths.
SBOX12="$(mktemp -d)"
( cd "${SBOX12}" && HOME="${SBOX12}" AI_TELEMETRY_DISABLE=1 \
    bash -c "echo '{\"tool_name\":\"x.y\",\"execution_time_ms\":1,\"status\":\"SUCCESS\"}' \
             | node '${TELEMETRY}' --record-tool >/dev/null 2>&1" )
RC_DISABLED=$?
assert_status 0 "AI_TELEMETRY_DISABLE=1 still rc==0" bash -c "[[ $RC_DISABLED -eq 0 ]]"
assert_status 1 "AI_TELEMETRY_DISABLE=1 writes no DB via CLI" \
  test -f "${SBOX12}/.rein/telemetry.sqlite"

# Pure-node project-root walk-up is required (no child_process per S01).
# Sanity-grep the source for the walk-up implementation.
assert_status 0 "telemetry.mjs has pure-node project-root walker" \
  grep -qE '_findProjectRoot|\.git' "$TELEMETRY"

# ── T-TEL-S09: retired with mcp-router (E-277); interceptor coverage lives in
# tests/unit/telemetry.test.mjs (E-277: every registry server is instrumented).

# T-TEL-S14..S17 (the post-tool-use hook) were deleted with the hook (E-467, D-170 r5).

# ── T-TEL-S10: ~/.rein mirrors byte-identical ────────────────────────────────
echo ""
echo "  [T-TEL-S10] ~/.rein mirrors byte-identical"

assert_status 0 "telemetry.mjs mirror"          diff -q "$TELEMETRY" "${HOME}/.rein/shared/telemetry.mjs"

echo ""

# E-259 (task velocity through the hook) was deleted with the hook and task-usage.mjs (E-467).

assert_summary
