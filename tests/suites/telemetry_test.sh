#!/usr/bin/env bash
# telemetry_test.sh — E-84 src/shared/telemetry.mjs where a process is under test: the CLI
# (--stats, --path, --record-*), the post-tool-use hook that feeds it, the mirrors, and the
# hook's task-velocity branch (E-259, from task_velocity — E-302). The module's in-process
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
HOOK="${REPO_ROOT}/hooks/post-tool-use.sh"

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
  bash -c "echo '$ROW_RT' | grep -qE '\"project_hash\":\"[0-9a-f]{12}\"'"

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

# ── T-TEL-S14: post-tool-use.sh source contract (E-105) ──────────────────────
echo ""
echo "  [T-TEL-S14] hooks/post-tool-use.sh wires telemetry without breaking AQG"

assert_status 0 "post-tool-use.sh exists" test -f "$HOOK"

# AQG behavior preserved verbatim (LOCKED on test failure).
assert_status 0 "AQG block preserved (LOCKED tag)" \
  grep -qE 'LOCKED - AQG FAILED' "$HOOK"
assert_status 0 "AQG re-runs tests/run.sh"     grep -qE 'tests/run\.sh' "$HOOK"

# New telemetry block invokes --record-tool via the locator chain.
assert_status 0 "hook references --record-tool" \
  grep -qE '\-\-record-tool' "$HOOK"
# E-223 REVERSED this order deliberately, so the assertion is rewritten rather than
# relaxed. "src/shared first" meant the VISITED repository's copy won: any project
# containing src/shared/telemetry.mjs had that file executed by node from inside this
# hook. Resolution is now install-first through the shared resolver, and the dev tree is
# reachable only inside the framework clone.
assert_status 0 "hook resolves telemetry via the shared install-first locator" \
  grep -qE 'rein_locate shared/telemetry\.mjs' "$HOOK"
assert_status 1 "hook no longer prefers the visited repo's own src/shared copy" \
  bash -c "sed 's/[[:space:]]*#.*\$//' '$HOOK' | grep -qE 'show-toplevel.*src/shared/telemetry'"

# Fail-open: backgrounded via & + disown, stderr/stdout swallowed.
assert_status 0 "telemetry call is backgrounded (& + disown)" \
  bash -c "grep -qE '2>&1 &\$' '$HOOK' && grep -qE 'disown' '$HOOK'"
assert_status 0 "telemetry stderr/stdout redirected to /dev/null" \
  grep -qE '>/dev/null 2>&1' "$HOOK"

# Privacy: hook never forwards tool_input/tool_response bodies — only the
# three blueprint fields the CLI persists.
assert_status 0 "translation extracts only tool_name + execution_time_ms + status" \
  bash -c "grep -q 'tool_name' '$HOOK' \
        && grep -q 'execution_time_ms' '$HOOK' \
        && grep -q '\"status\"' '$HOOK'"

# ── T-TEL-S15: hook end-to-end records a row in sandbox HOME ─────────────────
echo ""
echo "  [T-TEL-S15] hook end-to-end: payload → backgrounded write → DB row"

SBOX_H="$(mktemp -d)"
tc_fixture_home "$SBOX_H"   # E-345 (D-109 r1): the toolchain record the hooks pin
mkdir -p "${SBOX_H}/.rein/shared" "${SBOX_H}/repo/.git"
cp "$TELEMETRY" "${SBOX_H}/.rein/shared/telemetry.mjs"

PAYLOAD_H='{"session_id":"hook-e2e","tool_name":"E105HookSmoke","tool_input":{"x":1},"tool_response":{"isError":false,"duration_ms":27}}'

# Run hook — synchronous part should be quick; background write may take ~1s.
( cd "${SBOX_H}/repo" && echo "$PAYLOAD_H" \
    | HOME="${SBOX_H}" bash "$HOOK" >/dev/null 2>&1 )
RC_HOOK=$?
assert_status 0 "hook rc==0 on success path" bash -c "[[ $RC_HOOK -eq 0 ]]"

# Wait for the backgrounded node to land its write (E-307: poll for the row, not a guessed 2 s).
_tel_has() {  # <db> <tool_name> → 0 when a row for that tool exists
  node -e 'const { DatabaseSync } = require("node:sqlite");
    try { const d = new DatabaseSync(process.argv[1], { readOnly: true });
          process.exit(d.prepare("SELECT 1 FROM tool_executions WHERE tool_name = ?").get(process.argv[2]) ? 0 : 1); }
    catch { process.exit(1); }' "$1" "$2"
}
wait_for "_tel_has '${SBOX_H}/.rein/telemetry.sqlite' E105HookSmoke" 10000 100 || true

DB_H="${SBOX_H}/.rein/telemetry.sqlite"
assert_status 0 "background write created sandbox DB" test -f "$DB_H"

ROW_H="$(node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('${DB_H}');
const r = db.prepare('SELECT tool_name, execution_time_ms, status FROM tool_executions ORDER BY timestamp DESC LIMIT 1').get();
process.stdout.write(JSON.stringify(r));
")"
assert_contains "tool_name from payload landed"   "\"tool_name\":\"E105HookSmoke\""  "$ROW_H"
assert_contains "execution_time_ms from duration" "\"execution_time_ms\":27"          "$ROW_H"
assert_contains "status SUCCESS from isError:false" "\"status\":\"SUCCESS\""          "$ROW_H"

# Error path: isError:true → status=ERROR
PAYLOAD_HE='{"session_id":"hook-e2e","tool_name":"E105ErrCase","tool_response":{"isError":true,"duration_ms":3}}'
( cd "${SBOX_H}/repo" && echo "$PAYLOAD_HE" \
    | HOME="${SBOX_H}" bash "$HOOK" >/dev/null 2>&1 )
wait_for "_tel_has '${DB_H}' E105ErrCase" 10000 100 || true
ROWS_HE="$(node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('${DB_H}');
const r = db.prepare(\"SELECT status FROM tool_executions WHERE tool_name='E105ErrCase'\").get();
process.stdout.write(JSON.stringify(r));
")"
assert_contains "isError:true translates to status=ERROR" "\"status\":\"ERROR\"" "$ROWS_HE"

# ── T-TEL-S16: hook fail-open on every degraded environment ───────────────────
echo ""
echo "  [T-TEL-S16] hook fail-open: missing helper / malformed input / no tool_name"

# (a) telemetry.mjs absent from both locator slots → hook rc==0, no DB
SBOX_NO="$(mktemp -d)"
tc_fixture_home "$SBOX_NO"   # E-345 (D-109 r1): the toolchain record the hooks pin
mkdir -p "${SBOX_NO}/repo/.git"
( cd "${SBOX_NO}/repo" && echo "$PAYLOAD_H" \
    | HOME="${SBOX_NO}" bash "$HOOK" >/dev/null 2>&1 )
RC_NOHELPER=$?
sleep 1   # REIN_SLEEP_ALLOWED: negative wait — the detached writer gets the time a write takes, and must write nothing
assert_status 0 "hook rc==0 even when telemetry.mjs is missing" \
  bash -c "[[ $RC_NOHELPER -eq 0 ]]"
assert_status 1 "no DB written when helper is missing" \
  test -f "${SBOX_NO}/.rein/telemetry.sqlite"

# (b) malformed JSON payload → python parse fails → hook rc==0, no row
SBOX_BAD="$(mktemp -d)"
tc_fixture_home "$SBOX_BAD"   # E-345 (D-109 r1): the toolchain record the hooks pin
mkdir -p "${SBOX_BAD}/.rein/shared" "${SBOX_BAD}/repo/.git"
cp "$TELEMETRY" "${SBOX_BAD}/.rein/shared/telemetry.mjs"
( cd "${SBOX_BAD}/repo" && echo "not json at all" \
    | HOME="${SBOX_BAD}" bash "$HOOK" >/dev/null 2>&1 )
RC_BADJSON=$?
sleep 1   # REIN_SLEEP_ALLOWED: negative wait — the detached writer gets the time a write takes, and must write nothing
assert_status 0 "hook rc==0 on malformed payload" \
  bash -c "[[ $RC_BADJSON -eq 0 ]]"
assert_status 1 "no DB written from malformed payload" \
  test -f "${SBOX_BAD}/.rein/telemetry.sqlite"

# (c) AI_TELEMETRY_DISABLE=1 → helper short-circuits, no row written
SBOX_OFF="$(mktemp -d)"
tc_fixture_home "$SBOX_OFF"   # E-345 (D-109 r1): the toolchain record the hooks pin
mkdir -p "${SBOX_OFF}/.rein/shared" "${SBOX_OFF}/repo/.git"
cp "$TELEMETRY" "${SBOX_OFF}/.rein/shared/telemetry.mjs"
( cd "${SBOX_OFF}/repo" && echo "$PAYLOAD_H" \
    | HOME="${SBOX_OFF}" AI_TELEMETRY_DISABLE=1 bash "$HOOK" >/dev/null 2>&1 )
RC_OFF=$?
sleep 1   # REIN_SLEEP_ALLOWED: negative wait — the detached writer gets the time a write takes, and must write nothing
assert_status 0 "hook rc==0 with AI_TELEMETRY_DISABLE=1" \
  bash -c "[[ $RC_OFF -eq 0 ]]"
assert_status 1 "no DB written when AI_TELEMETRY_DISABLE=1" \
  test -f "${SBOX_OFF}/.rein/telemetry.sqlite"

# ── T-TEL-S17: hook synchronous overhead within blueprint <50ms budget ───────
echo ""
echo "  [T-TEL-S17] hook synchronous overhead under <50ms budget (warm)"

SBOX_T="$(mktemp -d)"
tc_fixture_home "$SBOX_T"   # E-345 (D-109 r1): the toolchain record the hooks pin
mkdir -p "${SBOX_T}/.rein/shared" "${SBOX_T}/repo/.git"
cp "$TELEMETRY" "${SBOX_T}/.rein/shared/telemetry.mjs"

# Cold + warm runs — measure warmer runs (2-5) as the steady-state. A function, so
# assert_perf can re-take it once when the host is overloaded (E-296).
_tel_measure() {
  local i START_NS END_NS EL max=0
  for i in 1 2 3 4 5; do
    START_NS=$(node -e 'process.stdout.write(String(Date.now()))')
    ( cd "${SBOX_T}/repo" && echo "$PAYLOAD_H" \
        | HOME="${SBOX_T}" bash "$HOOK" >/dev/null 2>&1 )
    END_NS=$(node -e 'process.stdout.write(String(Date.now()))')
    EL=$((END_NS - START_NS))
    if [[ $i -ge 2 && $EL -gt $max ]]; then max=$EL; fi
  done
  printf '%s' "$max"
}
ELAPSED_MS_MAX="$(_tel_measure)"
# Wallclock measurement is bounded by the two `node -e Date.now` calls (~75ms
# overhead apiece). The hook itself must be << than the floor of measurable
# elapsed time. We assert on the steady-state max not exceeding 250ms (which
# already includes ~150ms of measurement noise). The real synchronous-hook
# overhead is verified separately via the `time` builtin and documented in
# DEVOPS-004; this assertion is the CI-safe lower bound that catches gross
# regressions (e.g. someone removes the `&` and makes the write synchronous).
# E-239 (D-062 §2): host-relative. The baseline is built to match THIS measurement rather
# than a bare hook, because the comment above is right — the window is dominated by the two
# `node -e Date.now` calls used as the clock, not by the hook. So the floor is
# 2 x node-spawn + one no-op hook, measured on this same host in this same run. Comparing
# against a bare-hook baseline would flatter the assertion by ignoring its own instrument.
#
# The absolute 250ms still governs on CI, where the hardware is known.
_TEL_BASELINE=$(( 2 * $(perf_baseline_node) + $(perf_baseline_hook) ))
assert_perf "hook warm-path (steady-state max)" "$ELAPSED_MS_MAX" 250 "$_TEL_BASELINE" 2 50 _tel_measure

# ── T-TEL-S10: ~/.rein mirrors byte-identical ────────────────────────────────
echo ""
echo "  [T-TEL-S10] ~/.rein mirrors byte-identical"

assert_status 0 "telemetry.mjs mirror"          diff -q "$TELEMETRY" "${HOME}/.rein/shared/telemetry.mjs"
assert_status 0 "post-tool-use.sh mirror"       diff -q "$HOOK"      "${HOME}/.rein/hooks/post-tool-use.sh"

echo ""

# ── E-259 (from task_velocity — E-302): task velocity from the transcript, through the hook ──
# E-259 (D-077, meta-cognition.md §Task Velocity from the Transcript).
#
# The hook end to end: a successful update_task_status(DONE) in hooks/post-tool-use.sh reads
# the task's window of the transcript through src/shared/task-usage.mjs and writes ONE
# task_velocity row; a rejected DONE, another tool, or REIN_TASK_USAGE=0 writes nothing.
# Also the static contract (the E-155 aggregator is gone; the reader is located install-first
# and fed on stdin) and the 50 MB budget. The reader's own rules — dedupe, window, confinement,
# privacy, migration — are pinned in tests/unit/task-usage.test.mjs.
#
# Replaces task_velocity_aggregator_test.sh (E-155), whose subject — a usage.sqlite
# aggregator that always wrote a row, 0/0 when nothing was recorded — D-077 removed.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
READER="${REPO_ROOT}/src/shared/task-usage.mjs"
SYNC="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"
TOOL="mcp__task-synchronizer-mcp__update_task_status"


# ── E-259.1: static contract ────────────────────────────────────────────────
echo "  [E-259.1] static contract"
assert_status 1 "E-259.01a: the E-155 aggregator is gone from telemetry.mjs and task-synchronizer" \
  grep -qE 'recordTaskVelocityForTask|usage\.sqlite' "$TELEMETRY" "$SYNC"
assert_status 0 "E-259.01b: the hook locates the reader install-first" \
  grep -qF 'rein_locate shared/task-usage.mjs' "$HOOK"
assert_status 0 "E-259.01c: the hook feeds the reader on stdin, not argv" \
  grep -qE 'printf .%s. "\$TU_JSON" \| "\$\{REIN_TC_NICE:-nice\}" -n 10 "\$\{REIN_TC_NODE:-node\}" "\$TASK_USAGE_HELPER" --record' "$HOOK"
# E-286: nice re-resolves its target through PATH, so both are named by absolute path.
assert_status 0 "E-259.01d: the branch is backgrounded and silenced (fail-open)" \
  bash -c "sed -n '/Task velocity from the transcript/,/Context-cache rebuild/p' '$HOOK' | grep -q '>/dev/null 2>&1 &'"

# ── E-259.2: the hook end to end ────────────────────────────────────────────
echo "  [E-259.2] hook end to end"
FX="$(test_tmpdir taskvel)"
FHOME="${FX}/home"; CFG="${FX}/claude"; PROJ="${FX}/repo"
mkdir -p "${FHOME}/.rein/shared" "${CFG}/projects/-fx" "${PROJ}/.git"
tc_fixture_home "$FHOME"   # E-345 (D-109 r1): the toolchain record the hooks pin
cp "$READER" "$TELEMETRY" "${FHOME}/.rein/shared/"
DB="${FX}/telemetry.sqlite"
TR="${CFG}/projects/-fx/session.jsonl"
cat > "$TR" <<EOF
{"type":"assistant","sessionId":"fx-session","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":5,"cache_read_input_tokens":300},"content":[]}}
{"type":"assistant","sessionId":"fx-session","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":5,"cache_read_input_tokens":300},"content":[]}}
{"type":"assistant","sessionId":"fx-session","message":{"id":"m2","usage":{"input_tokens":1,"output_tokens":2},"content":[{"type":"tool_use","id":"tu1","name":"${TOOL}","input":{"id":"E-5","status":"DONE"}}]}}
EOF

_payload() {  # <response text> [tool_name]
  python3 -c 'import json,sys; print(json.dumps({"tool_name": sys.argv[3], "tool_input": {"id": "E-5", "status": "DONE"},
    "tool_response": [{"type": "text", "text": sys.argv[1]}], "transcript_path": sys.argv[2]}))' \
    "$1" "$TR" "${2:-$TOOL}"
}
_hook() {  # <payload> [env...]
  local p="$1"; shift
  ( cd "$PROJ" && printf '%s' "$p" | env HOME="$FHOME" CLAUDE_CONFIG_DIR="$CFG" AI_TELEMETRY_DB_PATH="$DB" "$@" \
      bash "$HOOK" >/dev/null 2>&1 )
}
_rows() {  # → "count|turns|tokens|cache_read|source" or "0"
  node -e "
    const { DatabaseSync } = require('node:sqlite');
    try { const d = new DatabaseSync('$DB', { readOnly: true });
      const r = d.prepare(\"SELECT COUNT(*) c, MAX(turn_count) t, MAX(tokens_consumed) k, MAX(cache_read_tokens) cr, MAX(source) s FROM task_velocity\").get();
      process.stdout.write(r.c ? [r.c, r.t, r.k, r.cr, r.s].join('|') : '0'); } catch { process.stdout.write('0'); }"
}
_wait_rows() { wait_for '[[ "$(_rows)" != "0" ]]' 5000 100 || true; _rows; }

# Negative cases first, while the store is still empty: each waits the same time a write takes.
_hook "$(_payload '✗ [CI_GATE] no green local CI run for HEAD')"; sleep 1.5   # REIN_SLEEP_ALLOWED: negative wait — as long as a write takes; nothing may land
assert_status 0 "E-259.02a: a rejected DONE writes nothing" test "$(_rows)" = "0"
_hook "$(_payload '✓ E-5 → DONE: ok')" REIN_TASK_USAGE=0; sleep 1.5   # REIN_SLEEP_ALLOWED: negative wait — as long as a write takes; nothing may land
assert_status 0 "E-259.02b: REIN_TASK_USAGE=0 writes nothing" test "$(_rows)" = "0"
_hook "$(_payload '✓ E-5 → DONE: ok' mcp__task-synchronizer-mcp__get_state)"; sleep 1.5   # REIN_SLEEP_ALLOWED: negative wait — as long as a write takes; nothing may land
assert_status 0 "E-259.02c: another task-synchronizer tool writes nothing" test "$(_rows)" = "0"

_hook "$(_payload '✓ E-5 → DONE: shipped')"
_got="$(_wait_rows)"
assert_status 0 "E-259.02d: a successful DONE writes one measured row (2 turns, 38, cache 300, transcript)" \
  test "$_got" = "1|2|38|300|transcript"
[[ "$_got" != "1|2|38|300|transcript" ]] && echo "      got: $_got"

# ── E-259.3: 50 MB transcript within budget ─────────────────────────────────
echo "  [E-259.3] 50 MB transcript"
BIG="${CFG}/projects/-fx/big.jsonl"
node -e "
  const fs = require('node:fs'); const out = fs.openSync('$BIG', 'w'); const pad = 'y'.repeat(900);
  let n = 0, i = 0;
  while (n < 50 * 1024 * 1024) {
    const l = JSON.stringify(i % 3 === 0
      ? { type: 'user', message: { content: [{ type: 'text', text: pad }] } }
      : { type: 'assistant', message: { id: 'm' + (i >> 1), usage: { input_tokens: 3, output_tokens: 5 }, content: [{ type: 'text', text: pad }] } });
    fs.writeSync(out, l + '\n'); n += l.length + 1; i++;
  }
  fs.writeSync(out, JSON.stringify({ type: 'assistant', message: { id: 'z', usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'tool_use', id: 'tz', name: '$TOOL', input: { id: 'E-6', status: 'DONE' } }] } }) + '\n');
  fs.closeSync(out);"
_tv_measure() {   # a function so assert_perf can re-take it once under host load (E-296)
  CLAUDE_CONFIG_DIR="$CFG" node --input-type=module -e "
  const { measureTaskWindow } = await import('$READER');
  const t0 = performance.now(); const r = await measureTaskWindow('$BIG', 'E-6');
  process.stdout.write(r && r.turn_count > 1000 ? String(Math.round(performance.now() - t0)) : 'NULL');"
}
_ms="$(_tv_measure)"
assert_status 0 "E-259.03a: the 50 MB fixture was measured (not skipped)" test "$_ms" != "NULL"
[[ "$_ms" == "NULL" ]] && _ms=999999
assert_perf "E-259.03b: 50 MB transcript read" "$_ms" 500 "$(perf_baseline_node)" 4 200 _tv_measure

echo ""

assert_summary
