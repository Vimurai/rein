#!/usr/bin/env bash
# task_synchronizer_test.sh — the task-synchronizer-mcp tools through the real server.
#
# One suite for the task-synchronizer tool behaviours (E-302, wave 2 of the D-088 consolidation):
# framework routing (E-63, below), then the sections absorbed from managed_agents_sync_hook
# (E-74), nextid_drift (E-109), role_header_view (E-136), token_optimization (E-107/E-108),
# dag_dependency (E-91), sovereignty_lock (E-101), structured_outputs and critic_stamp (E-12).
#
# ── E-63 (from framework_task_routing): is_framework_task routing ──
# Drives the real task-synchronizer-mcp via stdio JSON-RPC across the four
# control paths called out in task-routing.md:
#   1. is_framework_task=true + REIN_WORKSPACE unset           → [WORKSPACE_NOT_FOUND]
#   2. is_framework_task=true + non-absolute REIN_WORKSPACE    → [WORKSPACE_NOT_FOUND]
#   3. is_framework_task=true + path with no .ai/              → [WORKSPACE_NOT_FOUND]
#   4. REIN_WORKSPACE_DISABLE=1                                → [WORKSPACE_DISABLED]
#   5. is_framework_task=true + valid REIN_WORKSPACE           → row lands in framework state.sqlite
#   6. is_framework_task omitted/false                         → row lands in local state.sqlite
#   7. add_task tool schema advertises is_framework_task

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/mcp-client.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SYNC_MCP="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"

echo "===== task_synchronizer_test.sh ====="

SEED_LOCAL="$(mktemp).mjs"
cat > "$SEED_LOCAL" <<'JS'
const { getDb, regenerateViews } = await import(`${process.env.REPO_ROOT}/src/mcp/shared/state-db.js`);
const db = getDb(process.env.AIDIR);
regenerateViews(process.env.AIDIR, db);
JS

# Helper: returns the response text from one add_task call.
_call_add_task() {
  # $1 = cwd      (where the MCP resolves "local" .ai)
  # $2 = args_json
  local cwd="$1" args="$2"
  (
    cd "$cwd"
    mcp_call_tool "$SYNC_MCP" "add_task" "$args"
  ) | python3 -c "
import json, sys
raw = sys.stdin.read() or '{}'
try:
    data = json.loads(raw)
except Exception:
    print(''); sys.exit(0)
content = data.get('content') or []
print('\n'.join(c.get('text','') for c in content if c.get('type') == 'text'))
"
}

# ── T-FW-S01: tool schema advertises is_framework_task ────────────────────────
echo ""
echo "  [T-FW-S01] add_task input schema lists is_framework_task"

SCHEMA_FILE="$(mktemp)"
mcp_list_tools "$SYNC_MCP" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read() or '{}')
for t in d.get('tools', []):
    if t.get('name') == 'add_task':
        print(json.dumps(t.get('inputSchema', {})))
        break
" > "$SCHEMA_FILE"

assert_status 0 "is_framework_task is a known input property" \
  grep -q '"is_framework_task"' "$SCHEMA_FILE"
assert_status 0 "input schema describes the routing semantics" \
  grep -q 'REIN_WORKSPACE' "$SCHEMA_FILE"
rm -f "$SCHEMA_FILE"

# Set up two sandboxed .ai/ dirs to compare local vs framework targets.
SBOX="$(mktemp -d -t fw-route-XXXXXX)"
on_exit 'rm -rf "$SBOX"'

mkdir -p "${SBOX}/local/.ai" "${SBOX}/framework/.ai"
AIDIR="${SBOX}/local/.ai"     REPO_ROOT="${REPO_ROOT}" node --no-warnings "$SEED_LOCAL"
AIDIR="${SBOX}/framework/.ai" REPO_ROOT="${REPO_ROOT}" node --no-warnings "$SEED_LOCAL"

# ── T-FW-S02: REIN_WORKSPACE unset → [WORKSPACE_NOT_FOUND] ────────────────────
echo ""
echo "  [T-FW-S02] is_framework_task=true with REIN_WORKSPACE unset → error"

unset REIN_WORKSPACE
unset REIN_WORKSPACE_DISABLE
RESP="$(_call_add_task "${SBOX}/local" '{"owner":"Engineer (Claude)","description":"oops","tier":1,"is_framework_task":true}')"
assert_status 0 "response includes [WORKSPACE_NOT_FOUND]" \
  bash -c "echo \"$RESP\" | grep -q 'WORKSPACE_NOT_FOUND'"

# ── T-FW-S03: non-absolute path → [WORKSPACE_NOT_FOUND] ──────────────────────
echo ""
echo "  [T-FW-S03] non-absolute REIN_WORKSPACE rejected"

export REIN_WORKSPACE="relative/path"
RESP="$(_call_add_task "${SBOX}/local" '{"owner":"Engineer (Claude)","description":"oops","tier":1,"is_framework_task":true}')"
assert_status 0 "non-absolute path rejected" \
  bash -c "echo \"$RESP\" | grep -q 'WORKSPACE_NOT_FOUND'"
assert_status 0 "error mentions absolute requirement" \
  bash -c "echo \"$RESP\" | grep -q 'absolute'"
unset REIN_WORKSPACE

# ── T-FW-S04: path without .ai/ → [WORKSPACE_NOT_FOUND] ──────────────────────
echo ""
echo "  [T-FW-S04] REIN_WORKSPACE without .ai/ rejected"

EMPTY_DIR="$(mktemp -d)"
export REIN_WORKSPACE="$EMPTY_DIR"
RESP="$(_call_add_task "${SBOX}/local" '{"owner":"Engineer (Claude)","description":"oops","tier":1,"is_framework_task":true}')"
assert_status 0 "missing .ai/ rejected" \
  bash -c "echo \"$RESP\" | grep -q 'WORKSPACE_NOT_FOUND'"
assert_status 0 "error mentions rein init remediation" \
  bash -c "echo \"$RESP\" | grep -q 'rein init'"
unset REIN_WORKSPACE
rm -rf "$EMPTY_DIR"

# ── T-FW-S05: REIN_WORKSPACE_DISABLE=1 → [WORKSPACE_DISABLED] ────────────────
echo ""
echo "  [T-FW-S05] REIN_WORKSPACE_DISABLE=1 surfaces emergency-disable error"

export REIN_WORKSPACE="${SBOX}/framework"
export REIN_WORKSPACE_DISABLE="1"
RESP="$(_call_add_task "${SBOX}/local" '{"owner":"Engineer (Claude)","description":"oops","tier":1,"is_framework_task":true}')"
assert_status 0 "rollback flag surfaces [WORKSPACE_DISABLED]" \
  bash -c "echo \"$RESP\" | grep -q 'WORKSPACE_DISABLED'"
unset REIN_WORKSPACE_DISABLE

# ── T-FW-S06: valid framework workspace → row lands in framework DB ──────────
echo ""
echo "  [T-FW-S06] valid REIN_WORKSPACE persists into framework state.sqlite"

export REIN_WORKSPACE="${SBOX}/framework"
RESP_FILE="$(mktemp)"
_call_add_task "${SBOX}/local" '{"owner":"Engineer (Claude)","description":"framework-only task","tier":2,"is_framework_task":true}' > "$RESP_FILE"
assert_status 0 "response confirms framework routing" \
  grep -q 'framework workspace' "$RESP_FILE"
rm -f "$RESP_FILE"

# Read both DBs to verify the row landed in framework only.
COUNT_FW="$(REPO_ROOT="$REPO_ROOT" AIDIR="${SBOX}/framework/.ai" node --input-type=module --no-warnings -e "
import('node:sqlite').then(({DatabaseSync}) => {
  const db = new DatabaseSync(process.env.AIDIR + '/state.sqlite');
  const r = db.prepare('SELECT COUNT(*) as n FROM tasks').get();
  console.log(r.n);
});
")"
COUNT_LOCAL="$(REPO_ROOT="$REPO_ROOT" AIDIR="${SBOX}/local/.ai" node --input-type=module --no-warnings -e "
import('node:sqlite').then(({DatabaseSync}) => {
  const db = new DatabaseSync(process.env.AIDIR + '/state.sqlite');
  const r = db.prepare('SELECT COUNT(*) as n FROM tasks').get();
  console.log(r.n);
});
")"
assert_status 0 "framework state.sqlite carries 1 row" \
  bash -c "[[ '$COUNT_FW' == '1' ]]"
assert_status 0 "local state.sqlite still empty"          \
  bash -c "[[ '$COUNT_LOCAL' == '0' ]]"

# ── T-FW-S07: is_framework_task false → row lands in local DB ────────────────
echo ""
echo "  [T-FW-S07] non-framework task lands in local state.sqlite"

unset REIN_WORKSPACE   # prove local routing doesn't depend on the env
LOCAL_RESP_FILE="$(mktemp)"
_call_add_task "${SBOX}/local" '{"owner":"Engineer (Claude)","description":"local task","tier":1}' > "$LOCAL_RESP_FILE"
assert_status 1 "no framework-routing suffix on local task" \
  grep -q 'framework workspace' "$LOCAL_RESP_FILE"
rm -f "$LOCAL_RESP_FILE"

COUNT_LOCAL2="$(REPO_ROOT="$REPO_ROOT" AIDIR="${SBOX}/local/.ai" node --input-type=module --no-warnings -e "
import('node:sqlite').then(({DatabaseSync}) => {
  const db = new DatabaseSync(process.env.AIDIR + '/state.sqlite');
  const r = db.prepare('SELECT COUNT(*) as n FROM tasks').get();
  console.log(r.n);
});
")"
assert_status 0 "local state.sqlite gained the row" \
  bash -c "[[ '$COUNT_LOCAL2' == '1' ]]"


# ── E-74 (from managed_agents_sync_hook — E-302): the Managed Agents sync hook in add_task / update_task_status ──
# Tests for E-74: Managed Agents Sync Hook
# wired into task-synchronizer-mcp's add_task + update_task_status handlers.
#
# Verifies the production wiring of the E-73 syncToCloud() dispatcher per
# .ai/blueprints/managed-agents-state-reconciliation.md §Components 2:
#
#   - The hook fires after add_task          (mutation: new row → projection change)
#   - The hook fires after update_task_status (mutation: status flip → projection change)
#   - The hook does NOT fire when AI_MANAGED_AGENTS_ENABLE is unset
#   - The hook does NOT fire from add_stamp / set_project_focus / mark_deltas_read
#     (those mutations don't change the OPEN+BLOCKED active-task set)
#   - The hook is non-blocking — JSON-RPC response returns before the
#     debounced fetch fires
#   - Framework-routed tasks sync the framework workspace's state.sqlite,
#     not the local project's
#
# ── Harness: spawn MCP, send one tools/call, capture stdout + stderr ─────────
# Arguments: $1=tool name, $2=args JSON, $3=wait_ms (max debounce + network slack),
# $4=cwd (where MCP resolves .ai/), $5=env JSON (overrides for the child),
# $6=wait_for marker (OPTIONAL). When set, wait_ms is a DEADLINE: the harness
# keeps stdin open (so the unref'd debounce timer + DNS lookup can run) and
# polls stderr, returning as soon as the marker appears — fast in the common
# case, tolerant of CPU-load stalls up to the deadline. When empty, the harness
# waits the FULL window (used by negative cases that assert the marker is absent).
_call_mcp_capturing_stderr() {
  local tool="$1" args="$2" wait_ms="$3" cwd="$4" env_json="$5" wait_for="${6:-}"
  TOOL="$tool" ARGS="$args" WAIT_MS="$wait_ms" MCP_CWD="$cwd" ENV_JSON="$env_json" \
  WAIT_FOR="$wait_for" \
  SYNC_MCP="$SYNC_MCP" python3 - <<'PY'
import json, os, select, subprocess, sys, time

server   = os.environ["SYNC_MCP"]
tool     = os.environ["TOOL"]
args_raw = os.environ["ARGS"]
wait_ms  = int(os.environ["WAIT_MS"])
wait_for = os.environ.get("WAIT_FOR", "")
cwd      = os.environ["MCP_CWD"]
extra    = json.loads(os.environ["ENV_JSON"] or "{}")

env = {**os.environ, **extra}
# Don't propagate the harness's own settings.
for k in ("TOOL", "ARGS", "WAIT_MS", "WAIT_FOR", "MCP_CWD", "ENV_JSON", "SYNC_MCP"):
    env.pop(k, None)
# Strip parent-shell env vars that would let the MCP write outside the
# sandbox cwd. The test's `extra` dict is re-applied after the strip so a
# test that wants REIN_WORKSPACE / REIN_WORKSPACE_DISABLE still gets it.
# Without this guard, a buggy test (or a failing env-builder yielding
# `{}`) would inherit the parent shell's REIN_WORKSPACE and pollute the
# real repo's .ai/state.sqlite when is_framework_task=true.
for sensitive_key in ("REIN_WORKSPACE", "REIN_WORKSPACE_DISABLE"):
    env.pop(sensitive_key, None)
for k, v in extra.items():
    env[k] = v

initialize  = {"jsonrpc":"2.0","id":1,"method":"initialize",
               "params":{"protocolVersion":"2024-11-05","capabilities":{},
                         "clientInfo":{"name":"test","version":"1.0"}}}
initialized = {"jsonrpc":"2.0","method":"notifications/initialized"}
arguments   = json.loads(args_raw) if args_raw.strip() else {}
call        = {"jsonrpc":"2.0","id":2,"method":"tools/call",
               "params":{"name":tool,"arguments":arguments}}
frames      = "\n".join(json.dumps(m) for m in (initialize, initialized, call)) + "\n"

proc = subprocess.Popen(
    ["node", server],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, env=env, cwd=cwd,
)
proc.stdin.write(frames)
proc.stdin.flush()

# Keep stdin OPEN during the wait so the debounce timer + ENOTFOUND lookup land
# while the process is still alive (the timer is unref()'d so it cannot keep the
# loop open by itself). Instead of a blind fixed sleep — which raced the async
# "projection fetch failed" log under CPU load (E-207 flake) — drain stderr
# incrementally and, when a marker is supplied, stop as soon as it appears.
# wait_ms is a DEADLINE, not a mandatory sleep. Negative cases pass no marker and
# so wait the full window to confirm the sync did NOT fire.
err_fd     = proc.stderr.fileno()
stderr_buf = []
deadline   = time.monotonic() + wait_ms / 1000.0
try:
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        r, _, _ = select.select([err_fd], [], [], min(remaining, 0.05))
        if r:
            chunk = os.read(err_fd, 65536)
            if chunk:
                stderr_buf.append(chunk.decode("utf-8", "replace"))
            elif proc.poll() is not None:
                break  # EOF + process gone → nothing more will arrive
        if wait_for and wait_for in "".join(stderr_buf):
            break
        if not r and proc.poll() is not None:
            break  # process exited with no pending stderr
except Exception:
    # Belt-and-suspenders: if select/read misbehaves on this platform, fall back
    # to the original blind sleep so the test still runs.
    time.sleep(max(0.0, deadline - time.monotonic()))

# Close stdin (EOF ends the server's read loop) then drain the pipes via
# wait()+read() rather than communicate(). communicate() re-touches the now-
# closed stdin (selector path calls .fileno()), which raises "ValueError: I/O
# operation on closed file" on some Python versions (e.g. the ubuntu CI runner)
# while passing on others (macOS 3.14). Output here is small JSON-RPC + a few
# stderr warns, well under the pipe buffer, so wait()-then-read() cannot deadlock.
proc.stdin.close()
try:
    proc.wait(timeout=5)
except subprocess.TimeoutExpired:
    proc.kill()
    proc.wait()
# Drain any stderr left after we stopped polling (read the raw fd we've been
# using, so we don't fight the text wrapper's buffering), then combine.
try:
    while True:
        chunk = os.read(err_fd, 65536)
        if not chunk:
            break
        stderr_buf.append(chunk.decode("utf-8", "replace"))
except Exception:
    pass
stdout = proc.stdout.read()
stderr = "".join(stderr_buf)

response = None
for line in stdout.splitlines():
    line = line.strip()
    if line.startswith("{"):
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("id") == 2:
            response = obj.get("result", {})
            break

print(json.dumps({"result": response, "stderr": stderr}))
PY
}

# Seed a sandbox .ai/ with a regenerated SQLite state so the MCP can open it.
_seed_aidir() {
  local aiDir="$1"
  mkdir -p "$aiDir"
  AIDIR="$aiDir" REPO_ROOT="${REPO_ROOT}" node --no-warnings -e '
    const { getDb, regenerateViews } = await import(`${process.env.REPO_ROOT}/src/mcp/shared/state-db.js`);
    const db = getDb(process.env.AIDIR);
    regenerateViews(process.env.AIDIR, db);
  ' --input-type=module 2>/dev/null
}

# ── T-MAS-S01: Source carries the hook contract ──────────────────────────────
echo ""
echo "  [T-MAS-S01] task-synchronizer-mcp imports + calls the cloud sync hook"

assert_status 0 "syncToCloud imported from shared client" \
  grep -q 'syncToCloud as _syncToCloud.*managed-agents-client.mjs' "$SYNC_MCP"
assert_status 0 "_scheduleCloudSync helper defined" \
  grep -q 'function _scheduleCloudSync' "$SYNC_MCP"
assert_status 0 "_scheduleCloudSync called from add_task" \
  bash -c "awk '/case \"add_task\":/,/case \"update_task_status\":/' '$SYNC_MCP' | grep -q '_scheduleCloudSync'"
assert_status 0 "_scheduleCloudSync called from update_task_status" \
  bash -c "awk '/case \"update_task_status\":/,/case \"add_stamp\":/' '$SYNC_MCP' | grep -q '_scheduleCloudSync'"
assert_status 1 "_scheduleCloudSync NOT called from add_stamp" \
  bash -c "awk '/case \"add_stamp\":/,/case \"set_project_focus\":/' '$SYNC_MCP' | grep -q '_scheduleCloudSync'"
assert_status 1 "_scheduleCloudSync NOT called from set_project_focus" \
  bash -c "awk '/case \"set_project_focus\":/,/case \"archive_done_tasks\":/' '$SYNC_MCP' | grep -q '_scheduleCloudSync'"
assert_status 1 "_scheduleCloudSync NOT called from mark_deltas_read" \
  bash -c "awk '/case \"mark_deltas_read\":/,/default:/' '$SYNC_MCP' | grep -q '_scheduleCloudSync'"
assert_status 0 "blueprint reference present in comments" \
  grep -q 'managed-agents-state-reconciliation.md' "$SYNC_MCP"

# Set up sandbox dirs — file-based assertions sidestep quoting traps when
# response text or stderr contain embedded newlines / JSON quotes.
MASH_SBOX="$(test_tmpdir e74sync)"

# Helper: persist the harness JSON to two files (response text + stderr) so
# subsequent assertions can grep them without fighting bash quoting rules.
_split_result() {
  # $1 = harness JSON, $2 = stdout file, $3 = stderr file
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys, pathlib
raw, out_path, err_path = sys.argv[1], sys.argv[2], sys.argv[3]
obj = json.loads(raw)
result = obj.get("result") or {}
text = "\n".join(c.get("text","") for c in (result.get("content") or []))
pathlib.Path(out_path).write_text(text)
pathlib.Path(err_path).write_text(obj.get("stderr",""))
PY
}

LOCAL_DIR="${MASH_SBOX}/local"
LOCAL_AI="${LOCAL_DIR}/.ai"
_seed_aidir "$LOCAL_AI"

# ── T-MAS-S02: Hook fires on add_task when flag is ON ────────────────────────
echo ""
echo "  [T-MAS-S02] add_task with flag ON → debounced cloud sync fires"

env_on='{"AI_MANAGED_AGENTS_ENABLE":"1","AI_MANAGED_AGENT_KEY":"abcdef0123456789","AI_MANAGED_AGENT_HOST":"unresolvable-e74-test.invalid-tld.local","AI_MANAGED_AGENTS_DEBOUNCE_MS":"30"}'

result="$(_call_mcp_capturing_stderr \
  "add_task" \
  '{"owner":"Engineer (Claude)","description":"e74 add_task test","tier":1}' \
  3000 "$LOCAL_DIR" "$env_on" "projection fetch failed")"

ON_OUT="${MASH_SBOX}/on.out"
ON_ERR="${MASH_SBOX}/on.err"
_split_result "$result" "$ON_OUT" "$ON_ERR"

assert_status 0 "MCP response confirms task added"          grep -q "Added " "$ON_OUT"
assert_status 0 "stderr contains projection-fetch-failed"   grep -q "projection fetch failed" "$ON_ERR"
assert_status 0 "stderr carries managed-agents-client tag"  grep -q '"service":"managed-agents-client"' "$ON_ERR"
assert_status 1 "stderr does NOT include the key value"     grep -q "abcdef0123456789" "$ON_ERR"

# ── T-MAS-S03: Hook fires on update_task_status when flag is ON ──────────────
echo ""
echo "  [T-MAS-S03] update_task_status with flag ON → cloud sync fires"

existing_id="$(grep -oE 'Added E-[0-9]+' "$ON_OUT" | head -1 | awk '{print $2}')"

if [[ -z "$existing_id" ]]; then
  echo "    ⚠  could not extract task id from T-MAS-S02 output — skipping T-MAS-S03"
else
  result="$(_call_mcp_capturing_stderr \
    "update_task_status" \
    "{\"id\":\"${existing_id}\",\"status\":\"DONE\",\"summary\":\"e74 update test\"}" \
    3000 "$LOCAL_DIR" "$env_on" "projection fetch failed")"
  UPD_OUT="${MASH_SBOX}/upd.out"
  UPD_ERR="${MASH_SBOX}/upd.err"
  _split_result "$result" "$UPD_OUT" "$UPD_ERR"

  assert_status 0 "MCP response confirms transition to DONE" grep -q "DONE" "$UPD_OUT"
  assert_status 0 "update_task_status triggers cloud sync"   grep -q "projection fetch failed" "$UPD_ERR"
fi

# ── T-MAS-S04: Hook stays silent when flag is OFF ────────────────────────────
echo ""
echo "  [T-MAS-S04] add_task with flag absent → no cloud sync attempt"

LOCAL_DIR_OFF="${MASH_SBOX}/local-off"
_seed_aidir "${LOCAL_DIR_OFF}/.ai"

result="$(_call_mcp_capturing_stderr \
  "add_task" \
  '{"owner":"Engineer (Claude)","description":"flag-off test","tier":1}' \
  300 "$LOCAL_DIR_OFF" '{}')"
OFF_OUT="${MASH_SBOX}/off.out"
OFF_ERR="${MASH_SBOX}/off.err"
_split_result "$result" "$OFF_OUT" "$OFF_ERR"

assert_status 0 "task still added when flag off (no network)" grep -q "Added " "$OFF_OUT"
assert_status 1 "stderr does NOT carry projection-fetch-failed" grep -q "projection fetch failed" "$OFF_ERR"
assert_status 1 "stderr does NOT carry managed-agents-client tag" grep -q '"service":"managed-agents-client"' "$OFF_ERR"

# ── T-MAS-S05: add_stamp does NOT trigger cloud sync ─────────────────────────
echo ""
echo "  [T-MAS-S05] add_stamp with flag ON → still NO projection sync (negative)"

LOCAL_DIR_STAMP="${MASH_SBOX}/local-stamp"
_seed_aidir "${LOCAL_DIR_STAMP}/.ai"

# Pre-seed a task so the stamp has a real task_id to link to (and to give
# add_task a chance to assign the id E-1 in this fresh DB).
_call_mcp_capturing_stderr \
  "add_task" \
  '{"owner":"Engineer (Claude)","description":"stamp target","tier":1}' \
  100 "$LOCAL_DIR_STAMP" '{}' >/dev/null

result="$(_call_mcp_capturing_stderr \
  "add_stamp" \
  '{"type":"ARCH_PASS","agent":"test","task_id":"E-1","summary":"e74 stamp test"}' \
  500 "$LOCAL_DIR_STAMP" "$env_on")"
STAMP_ERR="${MASH_SBOX}/stamp.err"
_split_result "$result" "${MASH_SBOX}/stamp.out" "$STAMP_ERR"

assert_status 1 "stamp mutation does NOT schedule cloud sync" \
  grep -q "projection fetch failed" "$STAMP_ERR"

# ── T-MAS-S06: Mirror byte-identity ──────────────────────────────────────────
echo ""
echo "  [T-MAS-S06] ~/.rein mirror matches src"

MIRROR="${HOME}/.rein/mcp/task-synchronizer-mcp/index.js"
if [[ -f "$MIRROR" ]]; then
  assert_status 0 "mirror is byte-identical to src" \
    diff -q "$SYNC_MCP" "$MIRROR"
else
  echo "    ⚠  mirror absent — skipping"
fi

# ── T-MAS-S07: Framework routing — hook syncs framework workspace, not local ─
echo ""
echo "  [T-MAS-S07] is_framework_task=true → cloud sync targets the framework state.sqlite"

FRAMEWORK_DIR="${MASH_SBOX}/framework"
_seed_aidir "${FRAMEWORK_DIR}/.ai"
LOCAL_FW_DIR="${MASH_SBOX}/local-fw"
_seed_aidir "${LOCAL_FW_DIR}/.ai"

env_fw="$(FRAMEWORK_DIR="$FRAMEWORK_DIR" python3 -c '
import json, os
print(json.dumps({
  "AI_MANAGED_AGENTS_ENABLE":"1",
  "AI_MANAGED_AGENT_KEY":"abcdef0123456789",
  "AI_MANAGED_AGENT_HOST":"unresolvable-e74-fw.invalid-tld.local",
  "AI_MANAGED_AGENTS_DEBOUNCE_MS":"30",
  "REIN_WORKSPACE": os.environ["FRAMEWORK_DIR"],
}))
')"

result="$(_call_mcp_capturing_stderr \
  "add_task" \
  '{"owner":"Engineer (Claude)","description":"e74 framework-routed test","tier":1,"is_framework_task":true}' \
  3000 "$LOCAL_FW_DIR" "$env_fw" "projection fetch failed")"

FW_OUT="${MASH_SBOX}/fw.out"
FW_ERR="${MASH_SBOX}/fw.err"
_split_result "$result" "$FW_OUT" "$FW_ERR"

assert_status 0 "framework-routed task lands in REIN_WORKSPACE" \
  grep -q "routed to framework workspace" "$FW_OUT"
assert_status 0 "cloud sync still fires for framework-routed mutation" \
  grep -q "projection fetch failed" "$FW_ERR"

# Verify the row landed in the framework DB, not the local one.
fw_row_count=$(node --input-type=module -e "
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('${FRAMEWORK_DIR}/.ai/state.sqlite');
  const rows = db.prepare(\"SELECT id FROM tasks WHERE description LIKE 'e74 framework-routed%'\").all();
  console.log(rows.length);
  db.close();
" 2>/dev/null)
local_row_count=$(node --input-type=module -e "
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('${LOCAL_FW_DIR}/.ai/state.sqlite');
  const rows = db.prepare(\"SELECT id FROM tasks WHERE description LIKE 'e74 framework-routed%'\").all();
  console.log(rows.length);
  db.close();
" 2>/dev/null)
assert_status 0 "framework state.sqlite has the routed row" bash -c "[[ '$fw_row_count' == '1' ]]"
assert_status 0 "local state.sqlite has NO copy of the routed row" bash -c "[[ '$local_row_count' == '0' ]]"


# ── E-109 (from nextid_drift — E-302): nextId never re-issues an archived or allocated id ──
# E-109 (drift-resolution-2026.md): nextId must never
# re-issue an id that lives in .ai/archive/state-done-*.json or that was already
# allocated (the state-json-db-mismatch incident). The next number is
# max(live, archived, persisted-high-water) + 1.
set -e   # this section ran under its own suite's error mode
SERVER="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"

unset REIN_WORKSPACE REIN_WORKSPACE_DISABLE 2>/dev/null || true
NID_TMP="$(test_tmpdir nextid)"
PROJECT="${NID_TMP}/proj"; mkdir -p "${PROJECT}/.ai"
cat > "${PROJECT}/.ai/state.json" <<'JSON'
{ "version": "1.0", "project": {}, "tasks": [], "stamps": [], "deltas": [] }
JSON
cd "${PROJECT}"

call() { mcp_call_tool "${SERVER}" "$1" "$2" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
c=d.get("content",[{}]); print(c[0].get("text","") if c else "")'; }

OWNER='Engineer (Claude)'
DBN="node --input-type=module -e"

# ── A: fresh DB preserves the E-1, E-2 sequence (backward compat) ────────────
r=$(call add_task "{\"owner\":\"${OWNER}\",\"description\":\"first\",\"tier\":2}")
assert_contains "A: fresh → E-1" "Added E-1" "$r"
r=$(call add_task "{\"owner\":\"${OWNER}\",\"description\":\"second\",\"tier\":2}")
assert_contains "A: next → E-2" "Added E-2" "$r"

# ── B: archived ids bound the sequence (no collision with retired ids) ───────
# Seed an archive file holding E-1..E-50 (max 50), as _archiveDoneTasks would.
mkdir -p "${PROJECT}/.ai/archive"
python3 -c "import json; json.dump([{'id':f'E-{i}','status':'DONE'} for i in range(1,51)], open('${PROJECT}/.ai/archive/state-done-2026-01.json','w'))"
r=$(call add_task "{\"owner\":\"${OWNER}\",\"description\":\"after archive\",\"tier\":2}")
assert_contains "B: archived E-50 bounds the sequence → E-51" "Added E-51" "$r"

# ── C: high-water prevents re-issue even after a row leaves the live table ───
# Delete E-51 directly from the live table; the persisted high-water must still
# advance the sequence past it.
$DBN "import { getDb } from '${REPO_ROOT}/src/mcp/shared/state-db.js'; getDb('${PROJECT}/.ai').prepare('DELETE FROM tasks WHERE id = ?').run('E-51');" 2>/dev/null
r=$(call add_task "{\"owner\":\"${OWNER}\",\"description\":\"after delete\",\"tier\":2}")
assert_contains "C: deleted E-51 not re-issued → E-52" "Added E-52" "$r"
assert_not_contains "C: E-51 not re-issued" "Added E-51" "$r"

# ── D: the per-prefix high-water mark is persisted in the project table ──────
HW=$($DBN "import { getDb } from '${REPO_ROOT}/src/mcp/shared/state-db.js'; const r=getDb('${PROJECT}/.ai').prepare('SELECT value FROM project WHERE key = ?').get('last_id_E'); console.log(r ? r.value : 'NONE');" 2>/dev/null)
assert_status 0 "D: high-water last_id_E persisted at 52" bash -c "[ \"$HW\" = '52' ]"

# ── E: an unrelated prefix (P-) is independent ───────────────────────────────
r=$(call add_task "{\"owner\":\"Architect (Claude)\",\"description\":\"p task\",\"prefix\":\"P\",\"tier\":2}")
assert_contains "E: P- prefix independent → P-1" "Added P-1" "$r"

# ── F (E-330, D-102 §7): the tracked archive bounds the sequence too ─────────
# A team project's archive is .ai/tasks/archive/<YM>/<id>.json (tracked, pulled from a
# teammate): the filename is the id, and no .ai/archive/ JSON or high-water mark knows it.
mkdir -p "${PROJECT}/.ai/tasks/archive/2026-10"
printf '{}\n' > "${PROJECT}/.ai/tasks/archive/2026-10/E-90.json"
r=$(call add_task "{\"owner\":\"${OWNER}\",\"description\":\"after tracked archive\",\"tier\":2}")
assert_contains "F: tracked archived E-90 bounds the sequence → E-91" "Added E-91" "$r"

cd "${REPO_ROOT}"
set +e


# ── E-136 (from role_header_view — E-302): provider-agnostic TASKS.md section headers ──
# E-136 provider-agnostic TASKS.md section headers
# (role-abstraction.md). roleFromOwner() strips the "(Provider)" suffix so a CLI
# swap never churns headers; "Engineer (Claude)" and bare "Engineer" merge into a
# single "## Engineer" section. state.json retains the full owner string.
set -e   # this section ran under its own suite's error mode
SERVER="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"
STATE_DB="${REPO_ROOT}/src/mcp/shared/state-db.js"

# ── E-136.10: roleFromOwner strips the provider suffix (pure unit) ───────────
roles=$(node --input-type=module -e "import {roleFromOwner} from 'file://${STATE_DB}'; process.stdout.write([roleFromOwner('Engineer (Claude)'),roleFromOwner('Architect (Claude)'),roleFromOwner('Engineer'),roleFromOwner('Tester (claude · sonnet)'),roleFromOwner('')].join('|'))")
assert_contains "E-136.10a: 'Engineer (Claude)' -> Engineer" "Engineer|" "$roles"
assert_contains "E-136.10b: 'Architect (Claude)' -> Architect" "|Architect|" "$roles"
assert_contains "E-136.10c: bare 'Engineer' -> Engineer" "|Engineer|" "$roles"
assert_contains "E-136.10d: 'Tester (claude · sonnet)' -> Tester" "|Tester|" "$roles"
assert_contains "E-136.10e: '' -> Unassigned" "|Unassigned" "$roles"

# ── E-136.11: regenerated TASKS.md uses provider-agnostic headers ────────────
unset REIN_WORKSPACE REIN_WORKSPACE_DISABLE 2>/dev/null || true
RHV_TMP="$(test_tmpdir rolehdr)"
PROJECT="${RHV_TMP}/proj"; mkdir -p "${PROJECT}/.ai"
cat > "${PROJECT}/.ai/state.json" <<'JSON'
{
  "version": "1.0",
  "project": {},
  "tasks": [
    { "id": "E-1", "owner": "Engineer (Claude)", "status": "OPEN", "description": "legacy-owner task", "tier": 1, "created_at": "2026-06-01T00:00:00Z" },
    { "id": "E-2", "owner": "Engineer", "status": "OPEN", "description": "agnostic-owner task", "tier": 2, "created_at": "2026-06-01T00:00:00Z" },
    { "id": "P-1", "owner": "Architect (Claude)", "status": "OPEN", "description": "architect task", "tier": 1, "created_at": "2026-06-01T00:00:00Z" }
  ],
  "stamps": [],
  "deltas": []
}
JSON
cd "${PROJECT}"
# A state mutation migrates state.json -> state.sqlite and regenerates TASKS.md.
mcp_call_tool "${SERVER}" add_task '{"prefix":"E","owner":"Engineer (Claude)","description":"regen trigger","tier":3}' >/dev/null
TASKS="${PROJECT}/.ai/TASKS.md"
assert_status 0 "E-136.11: TASKS.md regenerated" test -f "$TASKS"
tasks_md="$(cat "$TASKS")"
assert_contains  "E-136.11a: provider-agnostic '## Engineer' header"  "## Engineer" "$tasks_md"
assert_contains  "E-136.11b: provider-agnostic '## Architect' header" "## Architect" "$tasks_md"
assert_not_contains "E-136.11c: no '## Engineer (Claude)' header"  "## Engineer (Claude)"  "$tasks_md"
assert_not_contains "E-136.11d: no '## Architect (Claude)' header" "## Architect (Claude)" "$tasks_md"
# "Engineer (Claude)" + bare "Engineer" must MERGE into exactly one section.
eng_headers="$(grep -c '^## Engineer$' "$TASKS" || true)"
assert_contains "E-136.11e: exactly one '## Engineer' section (merged)" "1" "$eng_headers"
# state.json still stores the full owner string (backwards compat).
assert_status 0 "E-136.11f: state.json retains full owner 'Engineer (Claude)'" \
  grep -q '"owner": "Engineer (Claude)"' "${PROJECT}/.ai/state.json"

cd "${REPO_ROOT}"
set +e


# ── E-107/E-108 (from token_optimization — E-302): summary capper and stamp rotator ──
# E-107 (summary capper) + E-108 (stamp rotator) in
# task-synchronizer-mcp (token-optimization.md §Components 1-2).
#
# Drives the REAL MCP server over stdio against an isolated temp .ai/. Stamps are
# bulk-seeded directly into the same state.sqlite (fast) and then rotated through
# the shipped archive_done_tasks handler.
set -e   # this section ran under its own suite's error mode
SERVER="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"

unset REIN_WORKSPACE REIN_WORKSPACE_DISABLE REIN_SUMMARY_CAP REIN_SOVEREIGNTY_LOCK 2>/dev/null || true
TOK_TMP="$(test_tmpdir tokopt)"
PROJECT="${TOK_TMP}/proj"; mkdir -p "${PROJECT}/.ai"
cat > "${PROJECT}/.ai/state.json" <<'JSON'
{ "version": "1.0", "project": {}, "tasks": [], "stamps": [], "deltas": [] }
JSON
cd "${PROJECT}"

call() { mcp_call_tool "${SERVER}" "$1" "$2" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
c=d.get("content",[{}]); print(c[0].get("text","") if c else "")'; }

task_field() { TID="$2" F="$3" python3 -c 'import json,sys,os
try: d=json.load(sys.stdin)
except Exception: print("ERR"); sys.exit(0)
t=next((x for x in d.get("tasks",[]) if x.get("id")==os.environ["TID"]),None)
print("MISSING" if t is None else json.dumps(t.get(os.environ["F"])))' <<<"$1"; }

OWNER='Engineer (Claude)'

# ── E-107.01: a >200-char DONE summary is capped + [SUMMARY_TRUNCATED] emitted ─
call add_task "{\"owner\":\"${OWNER}\",\"description\":\"long summary task\",\"tier\":2}" >/dev/null
LONG="$(python3 -c 'print("X"*300)')"
r=$(call update_task_status "{\"id\":\"E-1\",\"status\":\"DONE\",\"summary\":\"${LONG}\"}")
assert_contains "E-107.01: [SUMMARY_TRUNCATED] warning emitted" "[SUMMARY_TRUNCATED]" "$r"
state=$(call get_state "{}")
LEN=$(printf '%s' "$(task_field "$state" E-1 summary)" | python3 -c 'import sys,json; print(len(json.loads(sys.stdin.read())))')
assert_status 0 "E-107.01: stored summary length <= 200" bash -c "[ \"$LEN\" -le 200 ]"
assert_contains "E-107.01: capped summary references LOG.md" "LOG.md" "$(task_field "$state" E-1 summary)"

# ── E-107.02: a short summary is stored verbatim, no truncation note ──────────
call add_task "{\"owner\":\"${OWNER}\",\"description\":\"short summary task\",\"tier\":2}" >/dev/null
r=$(call update_task_status "{\"id\":\"E-2\",\"status\":\"DONE\",\"summary\":\"all good\"}")
assert_not_contains "E-107.02: no truncation note for short summary" "[SUMMARY_TRUNCATED]" "$r"
state=$(call get_state "{}")
assert_contains "E-107.02: short summary stored verbatim" "all good" "$(task_field "$state" E-2 summary)"

# ── E-107.03: REIN_SUMMARY_CAP rollback raises the cap (no truncation) ───────
call add_task "{\"owner\":\"${OWNER}\",\"description\":\"rollback cap task\",\"tier\":2}" >/dev/null
export REIN_SUMMARY_CAP=2000
r=$(REIN_SUMMARY_CAP=2000 call update_task_status "{\"id\":\"E-3\",\"status\":\"DONE\",\"summary\":\"${LONG}\"}")
assert_not_contains "E-107.03: cap=2000 → no truncation of 300-char summary" "[SUMMARY_TRUNCATED]" "$r"
unset REIN_SUMMARY_CAP

# ── E-108: stamp rotation ────────────────────────────────────────────────────
# Bulk-seed 60 stamps into the same state.sqlite the MCP uses (fast path).
node --input-type=module -e "
import { getDb } from '${REPO_ROOT}/src/mcp/shared/state-db.js';
const db = getDb('${PROJECT}/.ai');
const ins = db.prepare('INSERT INTO stamps(type,agent,task_id,timestamp,summary) VALUES (?,?,?,?,?)');
for (let i = 0; i < 60; i++) ins.run('TEST_STAMP','tester',null,new Date(Date.UTC(2026,0,1,0,i)).toISOString(),'stamp '+i);
" 2>/dev/null
SEEDED=$(node --input-type=module -e "import { getDb } from '${REPO_ROOT}/src/mcp/shared/state-db.js'; console.log(getDb('${PROJECT}/.ai').prepare('SELECT COUNT(*) n FROM stamps').get().n);" 2>/dev/null)
assert_status 0 "E-108.00: 60 stamps seeded" bash -c "[ \"$SEEDED\" -ge 60 ]"

# E-199: _rotateToArchive names the bucket by the CURRENT UTC year-month
# (`new Date().toISOString().slice(0,7)` in state-db.js), not the stamp's own
# date — so derive it here instead of hardcoding a month (was `2026-06`, a
# time-bomb that broke every PR after the July 2026 rollover). `date -u` matches
# toISOString()'s UTC basis.
STAMP_MONTH="$(date -u +%Y-%m)"
STAMP_ARCHIVE="${PROJECT}/.ai/archive/stamps-${STAMP_MONTH}.json"
r=$(call archive_done_tasks "{}")
assert_contains "E-108.01: archive run reports archived_stamps" '"archived_stamps"' "$r"
assert_contains "E-108.01b: 50 stamps archived (60 - 10 kept)" "50 stamps" "$r"
assert_exists "${STAMP_ARCHIVE}"

# Active stamp count is now the 10 most recent.
REMAIN=$(node --input-type=module -e "import { getDb } from '${REPO_ROOT}/src/mcp/shared/state-db.js'; console.log(getDb('${PROJECT}/.ai').prepare('SELECT COUNT(*) n FROM stamps').get().n);" 2>/dev/null)
assert_status 0 "E-108.02: 10 most-recent stamps kept in active state" bash -c "[ \"$REMAIN\" -eq 10 ]"

# Archived JSON holds the 50 rotated stamps in standard JSON (repo-oracle discoverable).
ARCHIVED_N=$(python3 -c "import json; print(len(json.load(open('${STAMP_ARCHIVE}'))))")
assert_status 0 "E-108.03: archive file holds 50 stamps" bash -c "[ \"$ARCHIVED_N\" -eq 50 ]"

# ── E-108.04: a second run below threshold is a no-op ────────────────────────
r=$(call archive_done_tasks "{}")
assert_contains "E-108.04: below-threshold run is a no-op" "No archive needed" "$r"

cd "${REPO_ROOT}"
set +e


# ── E-91 (from dag_dependency — E-302): DAG dependency support ──
# Tests for E-91 DAG dependency support in
# task-synchronizer-mcp (ecc-integrations.md §Components 3).
#
# Drives the REAL MCP server over stdio against an isolated temp .ai/ so the
# behaviour under test is the shipped handler logic, not a reimplementation.
# Covers: depends_on schema, initial BLOCKED/OPEN status, cycle detection,
# self-reference, missing-dep, depth cap (5), the DONE→OPEN unblock cascade,
# and get_state readiness flags.
set -e   # this section ran under its own suite's error mode
SERVER="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"

# Framework routing must never engage — these writes target the temp .ai/ only.
unset REIN_WORKSPACE REIN_WORKSPACE_DISABLE 2>/dev/null || true

# Isolated project: the MCP resolves aiDir as process.cwd()/.ai (index.js:409).
DAG_TMP="$(test_tmpdir dagdep)"
PROJECT="${DAG_TMP}/proj"
mkdir -p "${PROJECT}/.ai"
cat > "${PROJECT}/.ai/state.json" <<'JSON'
{
  "version": "1.0",
  "project": { "current_tier": null, "release_verdict": null, "focus": null },
  "tasks": [], "stamps": [], "deltas": [],
  "digest_stale": false, "digest_stale_reason": null
}
JSON
cd "${PROJECT}"   # subsequent server spawns inherit this cwd → temp .ai/

# call <tool> <args_json> → prints the tool's text payload (content[0].text)
call() {
  local result
  result="$(mcp_call_tool "${SERVER}" "$1" "$2")"
  printf '%s' "${result}" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
c=d.get("content",[{}])
print(c[0].get("text","") if c else "")'
}

# task_field <get_state_text> <task_id> <field> → JSON value or MISSING
task_field() {
  TID="$2" F="$3" python3 -c 'import json,sys,os
try: d=json.load(sys.stdin)
except Exception: print("ERR"); sys.exit(0)
t=next((x for x in d.get("tasks",[]) if x.get("id")==os.environ["TID"]),None)
print("MISSING" if t is None else json.dumps(t.get(os.environ["F"])))' <<<"$1"
}

OWNER='Engineer (Claude)'

# ── T-91.01: task with no deps is OPEN (backward compat) ─────────────────────
r=$(call add_task "{\"owner\":\"${OWNER}\",\"description\":\"root\",\"tier\":2}")
assert_contains "T-91.01: E-1 created"            "Added E-1" "$r"
assert_contains "T-91.01: E-1 starts OPEN"        '"status": "OPEN"' "$r"
assert_contains "T-91.01: E-1 depends_on is []"   '"depends_on": []' "$r"

# ── T-91.02: task depending on an unfinished task starts BLOCKED ─────────────
r=$(call add_task "{\"owner\":\"${OWNER}\",\"description\":\"needs E-1\",\"tier\":2,\"depends_on\":[\"E-1\"]}")
assert_contains "T-91.02: E-2 created"            "Added E-2" "$r"
assert_contains "T-91.02: E-2 starts BLOCKED"     '"status": "BLOCKED"' "$r"

# ── T-91.03: get_state surfaces readiness flags ──────────────────────────────
state=$(call get_state "{}")
assert_contains "T-91.03: E-1 ready=true"  "true"      "$(task_field "$state" E-1 ready)"
assert_contains "T-91.03: E-2 ready=false" "false"     "$(task_field "$state" E-2 ready)"
assert_contains "T-91.03: E-2 blocked_by=[E-1]" "E-1"  "$(task_field "$state" E-2 blocked_by)"

# ── T-91.04: completing E-1 cascades E-2 BLOCKED→OPEN ────────────────────────
r=$(call update_task_status "{\"id\":\"E-1\",\"status\":\"DONE\",\"summary\":\"root done\"}")
assert_contains "T-91.04: cascade unblocks E-2"   "unblocked: E-2" "$r"
state=$(call get_state "{}")
assert_contains "T-91.04: E-2 now OPEN"           '"OPEN"' "$(task_field "$state" E-2 status)"
assert_contains "T-91.04: E-2 now ready=true"     "true"   "$(task_field "$state" E-2 ready)"

# ── T-91.05: status filter reflects the cascade (no BLOCKED tasks left) ──────
r=$(call get_state "{\"status\":\"BLOCKED\"}")
assert_contains "T-91.05: zero BLOCKED tasks"     '"total_matched": 0' "$r"

# ── T-91.06: depending on a non-existent task is rejected ────────────────────
r=$(call add_task "{\"owner\":\"${OWNER}\",\"description\":\"bad dep\",\"depends_on\":[\"E-999\"]}")
assert_contains "T-91.06: DAG_FAIL on missing dep"        "[DAG_FAIL]" "$r"
assert_contains "T-91.06: names the unknown dependency"   "Unknown dependency" "$r"

# ── T-91.07: cycle detection via dependency revision ─────────────────────────
# E-3 depends on E-2; revising E-2 to depend on E-3 closes a cycle E-2→E-3→E-2.
r=$(call add_task "{\"owner\":\"${OWNER}\",\"description\":\"depends E-2\",\"tier\":2,\"depends_on\":[\"E-2\"]}")
assert_contains "T-91.07: E-3 created"            "Added E-3" "$r"
r=$(call update_task_status "{\"id\":\"E-2\",\"status\":\"OPEN\",\"depends_on\":[\"E-3\"]}")
assert_contains "T-91.07: DAG_FAIL on cycle"      "[DAG_FAIL]" "$r"
assert_contains "T-91.07: reports circular path"  "Circular dependency" "$r"

# ── T-91.08: self-reference is rejected ──────────────────────────────────────
r=$(call update_task_status "{\"id\":\"E-3\",\"status\":\"OPEN\",\"depends_on\":[\"E-3\"]}")
assert_contains "T-91.08: DAG_FAIL on self-dep"   "[DAG_FAIL]" "$r"
assert_contains "T-91.08: explains self-dep"      "cannot depend on itself" "$r"

# ── T-91.09: dependency chain deeper than 5 is rejected ──────────────────────
# Existing depths: E-1=1, E-2=2, E-3(deps E-2)=3. Extend the chain.
call add_task "{\"owner\":\"${OWNER}\",\"description\":\"d4\",\"depends_on\":[\"E-3\"]}" >/dev/null   # E-4 depth 4
r5=$(call add_task "{\"owner\":\"${OWNER}\",\"description\":\"d5\",\"depends_on\":[\"E-4\"]}")          # E-5 depth 5 (ok)
r6=$(call add_task "{\"owner\":\"${OWNER}\",\"description\":\"d6\",\"depends_on\":[\"E-5\"]}")          # E-6 depth 6 (reject)
assert_contains "T-91.09: depth-5 chain allowed"  "Added E-5"  "$r5"
assert_contains "T-91.09: DAG_FAIL on depth>5"    "[DAG_FAIL]" "$r6"
assert_contains "T-91.09: reports depth"          "depth"      "$r6"

# ── T-91.10: schema accepts valid depends_on, rejects wrong type ─────────────
r=$(call validate_payload "{\"schema_name\":\"task_create\",\"payload\":{\"owner\":\"${OWNER}\",\"description\":\"x\",\"depends_on\":[\"E-1\"]}}")
assert_contains "T-91.10: valid depends_on passes" "SCHEMA_PASS" "$r"
r=$(call validate_payload "{\"schema_name\":\"task_create\",\"payload\":{\"owner\":\"${OWNER}\",\"description\":\"x\",\"depends_on\":\"E-1\"}}")
assert_contains "T-91.10: string depends_on fails" "SCHEMA_FAIL" "$r"

cd "${REPO_ROOT}"
rm -rf "${DAG_TMP}"
set +e


# ── E-101 (from sovereignty_lock — E-302): the DONE-task mutation lock ──
# Tests for E-101 DONE-task mutation lock in
# task-synchronizer-mcp (sovereignty-hardening.md §Components 2).
#
# Drives the REAL MCP server over stdio against an isolated temp .ai/ so the
# behaviour under test is the shipped handler logic. Covers: the [TASK_LOCKED]
# guard on DONE tasks, the reopen:true override, that REIN_SOVEREIGNTY_LOCK=0 is
# NO LONGER a rollback (removed — D-084 r1, D-087 r3), that non-DONE mutations are unaffected, and that the task_update
# schema admits `reopen` past additionalProperties:false.
set -e   # this section ran under its own suite's error mode
SERVER="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"

# Framework routing must never engage — these writes target the temp .ai/ only.
unset REIN_WORKSPACE REIN_WORKSPACE_DISABLE 2>/dev/null || true
# The lock has no environment switch any more (E-294); unset it so the first cases are clean.
unset REIN_SOVEREIGNTY_LOCK 2>/dev/null || true

SOV_TMP="$(test_tmpdir soverlock)"
PROJECT="${SOV_TMP}/proj"
mkdir -p "${PROJECT}/.ai"
cat > "${PROJECT}/.ai/state.json" <<'JSON'
{
  "version": "1.0",
  "project": { "current_tier": null, "release_verdict": null, "focus": null },
  "tasks": [], "stamps": [], "deltas": [],
  "digest_stale": false, "digest_stale_reason": null
}
JSON
cd "${PROJECT}"   # subsequent server spawns inherit this cwd → temp .ai/

call() {
  local result
  result="$(mcp_call_tool "${SERVER}" "$1" "$2")"
  printf '%s' "${result}" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
c=d.get("content",[{}])
print(c[0].get("text","") if c else "")'
}

# is_error <tool> <args_json> → prints "ISERROR" when the tool result is an error
is_error() {
  mcp_call_tool "${SERVER}" "$1" "$2" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("PARSEFAIL"); sys.exit(0)
print("ISERROR" if d.get("isError") else "OK")'
}

OWNER='Engineer (Claude)'

# ── T-101.00: setup — create E-1 (OPEN), mark it DONE (OPEN→DONE allowed) ─────
r=$(call add_task "{\"owner\":\"${OWNER}\",\"description\":\"lockme\",\"tier\":2}")
assert_contains "T-101.00: E-1 created OPEN"        "Added E-1" "$r"
r=$(call update_task_status "{\"id\":\"E-1\",\"status\":\"DONE\",\"summary\":\"done once\"}")
assert_contains "T-101.00: OPEN→DONE allowed"       "E-1 → DONE" "$r"

# ── T-101.01: mutating a DONE task WITHOUT reopen is blocked ──────────────────
r=$(call update_task_status "{\"id\":\"E-1\",\"status\":\"OPEN\"}")
assert_contains "T-101.01: TASK_LOCKED tag"         "[TASK_LOCKED]" "$r"
assert_contains "T-101.01: names the task"          "E-1" "$r"
e=$(is_error update_task_status "{\"id\":\"E-1\",\"status\":\"OPEN\"}")
assert_contains "T-101.01: returns isError:true"    "ISERROR" "$e"
# State must be unchanged — E-1 is still DONE.
state=$(call get_state "{\"status\":\"DONE\"}")
assert_contains "T-101.01: E-1 still DONE"          "E-1" "$state"

# ── T-101.02: reopen:true overrides the lock ─────────────────────────────────
r=$(call update_task_status "{\"id\":\"E-1\",\"status\":\"OPEN\",\"reopen\":true}")
assert_contains "T-101.02: reopen mutates DONE task" "E-1 → OPEN" "$r"
e=$(is_error update_task_status "{\"id\":\"E-1\",\"status\":\"OPEN\",\"reopen\":true}")
# E-1 is OPEN now (not DONE) so this second call is a plain non-DONE mutation.
assert_contains "T-101.02: reopen path not an error" "OK" "$e"

# ── T-101.03: non-DONE tasks are never locked (OPEN→DONE→… handled above) ─────
# E-1 is OPEN; mutate OPEN→BLOCKED with no reopen → must succeed.
r=$(call update_task_status "{\"id\":\"E-1\",\"status\":\"BLOCKED\"}")
assert_contains "T-101.03: OPEN→BLOCKED not locked"  "E-1 → BLOCKED" "$r"

# ── T-101.04 → E-294 (D-084 r1, D-087 r3): REIN_SOVEREIGNTY_LOCK=0 NO LONGER unlocks ──
# Was: "env rollback bypasses lock". A project's settings `env` could set it, so the variable
# is removed everywhere; reopen:true is the one documented way to mutate a DONE task.
# Put E-1 back to DONE (BLOCKED→DONE allowed), then try to mutate it with the old env flag.
call update_task_status "{\"id\":\"E-1\",\"status\":\"DONE\",\"summary\":\"done again\"}" >/dev/null
export REIN_SOVEREIGNTY_LOCK=0
r=$(call update_task_status "{\"id\":\"E-1\",\"status\":\"OPEN\"}")
assert_contains "E-294.T101.04a: REIN_SOVEREIGNTY_LOCK=0 no longer unlocks a DONE task" "[TASK_LOCKED]" "$r"
e=$(is_error update_task_status "{\"id\":\"E-1\",\"status\":\"OPEN\"}")
assert_contains "E-294.T101.04b: …and it is still an error result" "ISERROR" "$e"
assert_not_contains "E-294.T101.04c: the refusal no longer offers the env switch" "REIN_SOVEREIGNTY_LOCK" "$r"
state=$(call get_state "{\"status\":\"DONE\"}")
assert_contains "E-294.T101.04d: E-1 is still DONE" "E-1" "$state"
r=$(call update_task_status "{\"id\":\"E-1\",\"status\":\"OPEN\",\"reopen\":true}")
assert_contains "E-294.T101.04e: reopen:true still mutates it (with the var still set)" "E-1 → OPEN" "$r"
unset REIN_SOVEREIGNTY_LOCK
assert_status 1 "E-294.T101.04f: neither the server nor its schemas mention the variable" \
  grep -q 'REIN_SOVEREIGNTY_LOCK' "${SERVER}" "${REPO_ROOT}/src/mcp/task-synchronizer-mcp/tool-schemas.mjs"

# ── T-101.05: task_update schema admits `reopen` past additionalProperties ────
r=$(call validate_payload "{\"schema_name\":\"task_update\",\"payload\":{\"id\":\"E-1\",\"status\":\"OPEN\",\"reopen\":true}}")
assert_contains "T-101.05: reopen:true is SCHEMA_PASS"  "SCHEMA_PASS" "$r"
r=$(call validate_payload "{\"schema_name\":\"task_update\",\"payload\":{\"id\":\"E-1\",\"status\":\"OPEN\",\"reopen\":\"yes\"}}")
assert_contains "T-101.05: reopen wrong-type SCHEMA_FAIL" "SCHEMA_FAIL" "$r"

cd "${REPO_ROOT}"
set +e


# ── E-12 (from structured_outputs — E-302): structured outputs — schema, validator, validate_payload ──
# Unit tests for E-12 Structured Outputs
# Tests: schema file, schema-validator.js, task-synchronizer-mcp validate_payload
#        tool, runtime validation guards, and TASKS.md/REVIEWS.md protection.
set -e   # this section ran under its own suite's error mode
SCHEMAS="${REPO_ROOT}/src/shared/schemas/state.json"
VALIDATOR="${REPO_ROOT}/src/shared/schema-validator.js"
SERVER="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"

# ── T-SO-S01: Schema file structure ──────────────────────────────────────────
echo ""
echo "  [T-SO-S01] Schema file"

assert_status 0 "src/shared/schemas/state.json exists" test -f "$SCHEMAS"

assert_status 0 "state.json is valid JSON" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
JSON.parse(readFileSync('$SCHEMAS', 'utf8'));
JS

assert_status 0 "state.json version is 1.0" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync('$SCHEMAS', 'utf8'));
if (s.version !== '1.0') process.exit(1);
JS

assert_status 0 "state.json has schemas property" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync('$SCHEMAS', 'utf8'));
if (!s.schemas || typeof s.schemas !== 'object') process.exit(1);
JS

assert_status 0 "task_create schema exists" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync('$SCHEMAS', 'utf8'));
if (!s.schemas.task_create) process.exit(1);
JS

assert_status 0 "task_update schema exists" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync('$SCHEMAS', 'utf8'));
if (!s.schemas.task_update) process.exit(1);
JS

assert_status 0 "stamp_add schema exists" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync('$SCHEMAS', 'utf8'));
if (!s.schemas.stamp_add) process.exit(1);
JS

assert_status 0 "project_update schema exists" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync('$SCHEMAS', 'utf8'));
if (!s.schemas.project_update) process.exit(1);
JS

assert_status 0 "task_create has required [owner, description]" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync('$SCHEMAS', 'utf8'));
const req = s.schemas.task_create.required;
if (!req.includes('owner') || !req.includes('description')) process.exit(1);
JS

assert_status 0 "task_update has required [id, status]" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync('$SCHEMAS', 'utf8'));
const req = s.schemas.task_update.required;
if (!req.includes('id') || !req.includes('status')) process.exit(1);
JS

assert_status 0 "tier enum is [1, 2, 3] in task_create" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync('$SCHEMAS', 'utf8'));
const tierEnum = s.schemas.task_create.properties.tier.enum;
if (!Array.isArray(tierEnum) || JSON.stringify(tierEnum) !== '[1,2,3]') process.exit(1);
JS

assert_status 0 "status enum is [OPEN, BLOCKED, DONE] in task_update" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync('$SCHEMAS', 'utf8'));
const e = s.schemas.task_update.properties.status.enum;
if (!e.includes('OPEN') || !e.includes('BLOCKED') || !e.includes('DONE')) process.exit(1);
JS

assert_status 0 "task_create additionalProperties is false" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync('$SCHEMAS', 'utf8'));
if (s.schemas.task_create.additionalProperties !== false) process.exit(1);
JS

# ── T-SO-S02: schema-validator.js module ─────────────────────────────────────
echo ""
echo "  [T-SO-S02] schema-validator.js"

assert_status 0 "schema-validator.js exists" test -f "$VALIDATOR"

assert_status 0 "exports validate function" \
  grep -q 'export function validate' "$VALIDATOR"

assert_status 0 "exports validateNamed function" \
  grep -q 'export function validateNamed' "$VALIDATOR"

assert_status 0 "exports loadSchemas function" \
  grep -q 'export function loadSchemas' "$VALIDATOR"

assert_status 0 "handles type checking" \
  grep -q '_matchesType' "$VALIDATOR"

assert_status 0 "handles enum validation" \
  grep -q 'schema.enum' "$VALIDATOR"

assert_status 0 "handles required fields" \
  grep -q 'schema.required' "$VALIDATOR"

assert_status 0 "handles additionalProperties" \
  grep -q 'additionalProperties' "$VALIDATOR"

assert_status 0 "handles minLength/maxLength" \
  grep -q 'minLength' "$VALIDATOR"

assert_status 0 "handles pattern (regex)" \
  grep -q 'schema.pattern' "$VALIDATOR"

# ── T-SO-S03: validate() — unit tests ────────────────────────────────────────
echo ""
echo "  [T-SO-S03] validate() unit tests"

assert_status 0 "valid task_create payload passes" \
  node --input-type=module <<JS
import { validateNamed } from '${VALIDATOR}';
const r = validateNamed('task_create', {
  owner: 'Engineer (Claude)',
  description: 'Implement foo',
  tier: 2
});
if (!r.valid) { console.error(r.errors); process.exit(1); }
JS

assert_status 0 "missing required field fails" \
  node --input-type=module <<JS
import { validateNamed } from '${VALIDATOR}';
const r = validateNamed('task_create', { description: 'no owner' });
if (r.valid) process.exit(1);
if (!r.errors.some(e => e.includes('owner'))) process.exit(1);
JS

assert_status 0 "wrong type fails" \
  node --input-type=module <<JS
import { validateNamed } from '${VALIDATOR}';
const r = validateNamed('task_create', { owner: 123, description: 'test' });
if (r.valid) process.exit(1);
if (!r.errors.some(e => e.includes('type'))) process.exit(1);
JS

assert_status 0 "invalid enum value fails" \
  node --input-type=module <<JS
import { validateNamed } from '${VALIDATOR}';
const r = validateNamed('task_create', {
  owner: 'Engineer (Claude)',
  description: 'test',
  tier: 5  // not in [1,2,3]
});
if (r.valid) process.exit(1);
if (!r.errors.some(e => e.includes('tier') || e.includes('enum'))) process.exit(1);
JS

assert_status 0 "additionalProperties violation fails" \
  node --input-type=module <<JS
import { validateNamed } from '${VALIDATOR}';
const r = validateNamed('task_create', {
  owner: 'Engineer (Claude)',
  description: 'test',
  forbidden_field: 'sneaky'
});
if (r.valid) process.exit(1);
if (!r.errors.some(e => e.includes('forbidden_field'))) process.exit(1);
JS

assert_status 0 "minLength violation fails" \
  node --input-type=module <<JS
import { validateNamed } from '${VALIDATOR}';
const r = validateNamed('task_create', { owner: '', description: 'test' });
if (r.valid) process.exit(1);
if (!r.errors.some(e => e.includes('minLength') || e.includes('owner'))) process.exit(1);
JS

assert_status 0 "task_update pattern validates E-## format" \
  node --input-type=module <<JS
import { validateNamed } from '${VALIDATOR}';
const bad = validateNamed('task_update', { id: 'WRONG', status: 'DONE' });
if (bad.valid) process.exit(1);
const good = validateNamed('task_update', { id: 'E-11', status: 'DONE' });
if (!good.valid) { console.error(good.errors); process.exit(1); }
JS

assert_status 0 "stamp_add with all required fields passes" \
  node --input-type=module <<JS
import { validateNamed } from '${VALIDATOR}';
const r = validateNamed('stamp_add', {
  type: 'CRITIC_STAMP',
  agent: 'Claude',
  summary: 'E-12 PASS'
});
if (!r.valid) { console.error(r.errors); process.exit(1); }
JS

assert_status 0 "project_update with valid focus passes" \
  node --input-type=module <<JS
import { validateNamed } from '${VALIDATOR}';
const r = validateNamed('project_update', { focus: 'E-12 Structured Outputs', current_tier: 2 });
if (!r.valid) { console.error(r.errors); process.exit(1); }
JS

assert_status 0 "unknown schema name returns error" \
  node --input-type=module <<JS
import { validateNamed } from '${VALIDATOR}';
const r = validateNamed('no_such_schema', {});
if (r.valid) process.exit(1);
if (!r.errors.some(e => e.includes('Unknown schema'))) process.exit(1);
JS

assert_status 0 "returns schemaName in result" \
  node --input-type=module <<JS
import { validateNamed } from '${VALIDATOR}';
const r = validateNamed('task_create', { owner: 'Claude', description: 'x' });
if (r.schemaName !== 'task_create') process.exit(1);
JS

# ── T-SO-S04: task-synchronizer-mcp integration ──────────────────────────────
echo ""
echo "  [T-SO-S04] task-synchronizer-mcp integration"

assert_status 0 "imports validateNamed from schema-validator" \
  grep -q 'validateNamed' "$SERVER"

assert_status 0 "_assertSchema helper defined" \
  grep -q '_assertSchema' "$SERVER"

assert_status 0 "add_task calls _assertSchema(task_create)" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
const addIdx = src.indexOf("case \"add_task\":");
if (addIdx === -1) process.exit(1);
const block = src.slice(addIdx, addIdx + 400);
if (!block.includes('task_create')) process.exit(1);
JS

assert_status 0 "update_task_status calls _assertSchema(task_update)" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
const idx = src.indexOf("case \"update_task_status\":");
if (idx === -1) process.exit(1);
const block = src.slice(idx, idx + 400);
if (!block.includes('task_update')) process.exit(1);
JS

assert_status 0 "add_stamp calls _assertSchema(stamp_add)" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
const idx = src.indexOf("case \"add_stamp\":");
if (idx === -1) process.exit(1);
const block = src.slice(idx, idx + 300);
if (!block.includes('stamp_add')) process.exit(1);
JS

assert_status 0 "set_project_focus calls _assertSchema(project_update)" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
const idx = src.indexOf("case \"set_project_focus\":");
if (idx === -1) process.exit(1);
const block = src.slice(idx, idx + 300);
if (!block.includes('project_update')) process.exit(1);
JS

assert_status 0 "validate_payload tool declared in server" \
  grep -q '"validate_payload"' "$SERVER"

assert_status 0 "validate_payload case handled in switch" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
if (!src.includes('case "validate_payload":')) process.exit(1);
JS

assert_status 0 "SCHEMA_PASS emitted on success" \
  grep -q 'SCHEMA_PASS' "$SERVER"

assert_status 0 "SCHEMA_FAIL emitted on failure" \
  grep -q 'SCHEMA_FAIL' "$SERVER"

assert_status 0 "validate_payload isError:true on invalid payload" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
const idx = src.indexOf('case "validate_payload":');
if (idx === -1) process.exit(1);
const block = src.slice(idx, idx + 1200);
// E-179: SCHEMA_FAIL still signals isError to the model, but now via the shared
// rejection() helper ({ ..., isError: true, _meta.expected_rejection }) so telemetry
// books it SUCCESS (validate_payload reporting an invalid payload is the tool working,
// not failing). Accept either the inline literal or the helper form.
if (!block.includes('isError: true') && !block.includes('rejection(')) process.exit(1);
JS

# ── T-SO-S05: TASKS.md/REVIEWS.md protection ─────────────────────────────────
echo ""
echo "  [T-SO-S05] TASKS.md / REVIEWS.md protection"

assert_status 0 "TASKS.md starts with generated header" \
  node --input-type=module <<JS
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
const p = join('${REPO_ROOT}', '.ai', 'TASKS.md');
if (!existsSync(p)) process.exit(0); // skip if missing
const content = readFileSync(p, 'utf8');
if (!content.startsWith('# TASKS (Generated from state.json)')) {
  console.error('TASKS.md is missing generated header');
  process.exit(1);
}
JS

assert_status 0 "REVIEWS.md starts with generated header" \
  node --input-type=module <<JS
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
const p = join('${REPO_ROOT}', '.ai', 'REVIEWS.md');
if (!existsSync(p)) process.exit(0); // skip if missing
const content = readFileSync(p, 'utf8');
if (!content.startsWith('# REVIEWS.md (Generated from state.json)')) {
  console.error('REVIEWS.md is missing generated header');
  process.exit(1);
}
JS

assert_status 0 "append_tasks case disabled with isError" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
// match either quote style
const idx = src.indexOf('case "append_tasks":') !== -1
  ? src.indexOf('case "append_tasks":')
  : src.indexOf("case 'append_tasks':");
if (idx === -1) process.exit(1);
const block = src.slice(idx, idx + 800);
if (!block.includes('isError: true')) process.exit(1);
JS

assert_status 0 "regenerateViews called after each mutation" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
// Must regenerate after add_task, update_task_status, add_stamp, set_project_focus
const count = (src.match(/_regenerateViews/g) || []).length;
if (count < 4) { console.error('Expected >= 4 regenerateViews calls, got', count); process.exit(1); }
JS

# ── T-SO-S06: Registry updated ───────────────────────────────────────────────
echo ""
echo "  [T-SO-S06] Registry updated"

assert_status 0 "validate_payload in task-synchronizer-mcp allowed-tools" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('${REPO_ROOT}/src/config/registry.json', 'utf8'));
const tools = r.mcp_servers['task-synchronizer-mcp']['allowed-tools'];
if (!tools.includes('validate_payload')) process.exit(1);
JS

assert_status 0 "mark_deltas_read in task-synchronizer-mcp allowed-tools" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('${REPO_ROOT}/src/config/registry.json', 'utf8'));
const tools = r.mcp_servers['task-synchronizer-mcp']['allowed-tools'];
if (!tools.includes('mark_deltas_read')) process.exit(1);
JS
set +e


# ── critic stamps (from critic_stamp — E-302): Tier-3 critics persist verdicts via add_stamp ──
# Tier-3 critics persist verdicts via add_stamp, not by
# appending to .ai/REVIEWS.md (which is a regenerated view of the SQLite stamps
# table — direct appends are clobbered on the next _regenerateViews). Aligns
# critic_arch/security/tests with the E-72 distributed-stamping pattern that
# critic_clean_code already follows.
set -e   # this section ran under its own suite's error mode
# critic → expected stamp prefix
declare -a CRITICS=("critic_arch:ARCH" "critic_security:SEC" "critic_tests:TESTS")

for row in "${CRITICS[@]}"; do
  name="${row%%:*}"; pfx="${row##*:}"
  SRC="${REPO_ROOT}/src/claude/agents/${name}.md"

  assert_status 0 "${name}: source exists" test -f "$SRC"

  # Stamps via the MCP, with the PASS and FAIL stamp types present.
  assert_status 0 "${name}: invokes add_stamp" \
    grep -q 'mcp__task-synchronizer-mcp__add_stamp' "$SRC"
  assert_status 0 "${name}: declares ${pfx}_PASS stamp" \
    grep -qE "\"${pfx}_PASS\"|${pfx}_PASS" "$SRC"
  assert_status 0 "${name}: declares ${pfx}_FAIL stamp" \
    grep -qE "\"${pfx}_FAIL\"|${pfx}_FAIL" "$SRC"

  # Must NOT instruct a direct append to the regenerated REVIEWS.md view.
  assert_status 1 "${name}: no 'Append ... to .ai/REVIEWS.md' instruction" \
    grep -qE 'Append.*\.ai/REVIEWS\.md' "$SRC"
  assert_status 1 "${name}: Target is not 'REVIEWS.md (append only)'" \
    grep -qE 'Target: \.ai/REVIEWS\.md \(append only\)' "$SRC"

  # Frontmatter integrity preserved.
  assert_status 0 "${name}: frontmatter name matches" \
    grep -qE "^name: ${name}$" "$SRC"

  # 3-copy mirror identity (src ↔ .claude ↔ ~/.rein/claude).
  assert_status 0 "${name}: .claude mirror identical" \
    diff -q "$SRC" "${REPO_ROOT}/.claude/agents/${name}.md"
  assert_status 0 "${name}: ~/.rein mirror identical" \
    diff -q "$SRC" "${HOME}/.rein/claude/agents/${name}.md"
done
set +e

assert_summary
