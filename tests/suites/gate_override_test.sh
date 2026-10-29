#!/usr/bin/env bash
# gate_override_test.sh — E-291 (D-081 r2, D-083 r5-8): the operator's time-boxed override
# replaces the two environment opt-outs, and the agent cannot switch its own gate off.
#
# The removed variable NAMES are assembled at run time below: the task's acceptance greps
# src/ hooks/ tests/ for them and expects nothing outside CHANGELOG/.ai/archive.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${REPO_ROOT}/hooks/pre-tool-use.sh"
SS_HOOK="${REPO_ROOT}/hooks/session-start.sh"
AI_BIN="${REPO_ROOT}/src/bin/ai"
V_GATE="AI_OS_SAFE""_EXEC_GATE"; V_TOKEN="AI_OS_ROLE""_TOKEN"
PRE_E291_REF="bba0150"   # E-290 tip: the last hook with the env opt-outs

echo "── Suite: gate_override_test (E-291) ────────────────────────────────"
skip_unless_cmd node "E-291 gate override" || { assert_summary; exit 0; }
skip_unless_cmd python3 "E-291 gate override" || { assert_summary; exit 0; }

T="$(mktemp -d)"; on_exit "rm -rf '$T'"
T="$(cd -P "$T" && pwd -P)"
# A fixture HOME whose mirror is THIS checkout's code (not whatever is installed).
H="$T/home"; M="$H/.ai-os"
mkdir -p "$M/mcp/safe-exec-mcp" "$T/proj/.ai" "$T/proj/src"
cp -R "${REPO_ROOT}/src/shared" "$M/shared"
cp -R "${REPO_ROOT}/src/mcp/shared" "$M/mcp/shared"
for f in "${REPO_ROOT}/src/mcp/safe-exec-mcp/"*; do
  n="${f##*/}"; if [[ "$n" == node_modules ]]; then ln -s "$f" "$M/mcp/safe-exec-mcp/$n"; else cp -R "$f" "$M/mcp/safe-exec-mcp/"; fi
done
[[ -d "${REPO_ROOT}/node_modules" ]] && ln -s "${REPO_ROOT}/node_modules" "$M/node_modules"
chmod 700 "$M"
tc_fixture_home "$H"   # E-345 (D-109 r1): the record the install writes, through its own writer
GO="$M/gate-override.json"; GOPY="$M/shared/gate-override.py"
export AI_TELEMETRY_DB_PATH="$T/telemetry.sqlite"

# The command/path travels on STDIN (printf is a builtin, no exec limit): E-291.03d pads a
# command past ARG_MAX, which would otherwise break this builder before the hook ever ran.
_payload() { printf '%s' "$2" | python3 -c 'import json,sys; a=sys.stdin.read(); print(json.dumps({"tool_name":sys.argv[1],"tool_input":({"command":a} if sys.argv[1]=="Bash" else {"file_path":a,"content":"x"}),"session_id":sys.argv[2]}))' "$1" "$3"; }
# E-294 (D-087): a role is a launch record + a token bound to the session process — the
# `--mint-token <role> <sid>` form this suite used is refused now. _hook runs the hook as the
# DIRECT child of a real Architect session (tests/lib/as-session.sh) in the fixture project, so
# the hook's PPID is the token's pid (the --session-pid hot path), exactly as under claude.
AS="${REPO_ROOT}/tests/lib/as-session.sh"
_hook() {  # <hook> <tool> <arg> <sid> [env…] → rc; stdout → $T/out, stderr → $T/err
  local hook="$1" tool="$2" arg="$3" sid="$4"; shift 4
  _payload "$tool" "$arg" "$sid" > "$T/p.json"
  if [[ "${_HOOK_SESSION:-1}" == 1 ]]; then
    ( cd "$T/proj" && HOME="$H" bash "$AS" architect "$sid" -- env HOME="$H" "$@" /bin/bash "$hook" < "$T/p.json" >"$T/out" 2>"$T/err" ); echo $?
  else  # no session at all: the union (the Architect rule set for everyone)
    ( cd "$T/proj" && env HOME="$H" "$@" /bin/bash "$hook" < "$T/p.json" >"$T/out" 2>"$T/err" ); echo $?
  fi
}
_override() { python3 -I "$GOPY" write "$GO" "${1:-15}" "${2:-e291 test}" >/dev/null; }
SE="$M/mcp/safe-exec-mcp/index.js"
SID_A="e291arch$RANDOM"   # an Architect session per _hook call (as-session.sh), not a pre-minted token

# ── E-291.1: the env opt-outs are gone — closure, and the gap they were ───────
rm -f "$GO"
rc="$(_hook "$HOOK" Write "$T/proj/src/x.js" "$SID_A" "$V_GATE=0" "$V_TOKEN=0")"
assert_status 0 "E-291.01a: with both removed env switches set, an Architect write is still BLOCKED (rc=${rc})" test "$rc" -eq 2
rc="$( cd "$T/proj" && HOME="$H" bash "$AS" architect "$SID_A" -- env HOME="$H" "$V_TOKEN=0" AI_OS_CALLER_ROLE=engineer node --no-warnings "$SE" --check 'git push origin main' engineer --session "$SID_A" >/dev/null 2>&1; echo $? )"
assert_status 0 "E-291.01b: …and the role still comes from the token, not the env (rc=${rc})" test "$rc" -eq 2
OLD="$T/old-hook.sh"
if git -C "$REPO_ROOT" show "${PRE_E291_REF}:hooks/pre-tool-use.sh" > "$OLD" 2>/dev/null; then
  rc="$(_hook "$OLD" Write "$T/proj/src/x.js" "$SID_A" "$V_GATE=0" "$V_TOKEN=0")"
  assert_status 0 "E-291.01c: the PRE-change hook let that write through on the env switch (proves the gap; rc=${rc})" test "$rc" -eq 0
else
  _skip "E-291.01c: pre-change hook (${PRE_E291_REF}) not in this checkout's history"
fi
_env_hits="$(grep -rln "${V_GATE}\|${V_TOKEN}" "${REPO_ROOT}/src" "${REPO_ROOT}/hooks" "${REPO_ROOT}/tests" 2>/dev/null | grep -v node_modules || true)"
assert_status 0 "E-291.01d: no source, hook or test names the removed switches (got: ${_env_hits:-none})" test -z "$_env_hits"

# ── E-291.2: a valid override lets the call through — loudly ─────────────────
_override 15 "e291 valid"
rc="$(_hook "$HOOK" Write "$T/proj/src/x.js" "$SID_A")"
assert_status 0 "E-291.02a: with a valid override the Architect write passes (rc=${rc})" test "$rc" -eq 0
assert_contains "E-291.02b: …with a user-visible systemMessage on stdout" '"systemMessage":"[GATE_OVERRIDE] safe-exec bypassed until' "$(cat "$T/out")"
assert_contains "E-291.02c: …naming the reason" "(e291 valid)" "$(cat "$T/out")"
rc="$(_hook "$HOOK" Bash "ls -la" "$SID_A")"
assert_contains "E-291.02d: a Bash call under the override is announced too" "[GATE_OVERRIDE]" "$(cat "$T/out")"
_bypass_rows() { node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  try { const db = new DatabaseSync(process.argv[1], { readOnly: true });
        process.stdout.write(String(db.prepare("SELECT COUNT(*) n FROM tool_executions WHERE status = ? AND source = ?").get("BYPASS","hook").n)); }
  catch { process.stdout.write("0"); }' "$AI_TELEMETRY_DB_PATH" 2>/dev/null; }
wait_for '[[ "$(_bypass_rows)" -ge 2 ]]' 5000 250 || true
assert_status 0 "E-291.02e: each bypassed call books one BYPASS telemetry row (got $(_bypass_rows))" test "$(_bypass_rows)" -ge 2

# ── E-291.3: the backstop and the self-disable guard hold UNDER the override ──
rc="$(_hook "$HOOK" Bash "rm -rf /" "$SID_A")"
assert_status 0 "E-291.03a: rm -rf / is BLOCKED even with an active override (r8; rc=${rc})" test "$rc" -eq 2
rc="$(_hook "$HOOK" Bash "ai gate off --minutes 60" "$SID_A")"
assert_status 0 "E-291.03b: the agent cannot extend the override (rc=${rc})" test "$rc" -eq 2
rc="$(_hook "$HOOK" Write "$M/hooks-x.sh" "$SID_A")"
assert_status 0 "E-291.03c: a Write under ~/.ai-os/ is BLOCKED even with an override (rc=${rc})" test "$rc" -eq 2

# critic_security P1-1: a command padded past ARG_MAX makes node exit 126 (no verdict); under
# an override that path must still refuse anything touching the gate.
_pad="$(python3 -c 'print("A" * 1200000)')"
rc="$(_hook "$HOOK" Bash "ai gate off --minutes 60 #${_pad}" "$SID_A")"
assert_status 0 "E-291.03d: an ARG_MAX-padded self-disable is BLOCKED under the override (rc=${rc})" test "$rc" -eq 2
rc="$(_hook "$HOOK" Bash "echo ok #${_pad}" "$SID_A")"
assert_status 0 "E-291.03e: …while a padded harmless command passes loudly (the no-verdict path ran; rc=${rc})" test "$rc" -eq 0
unset _pad
rm -f "$GO"

# ── E-291.4: invalid override files are ignored with ONE notice ─────────────
_ignored() {  # <label> <reason substring> → the gate ran normally (not a crash) and said why
  rc="$(_hook "$HOOK" Write "$T/proj/src/x.js" "$SID_A")"
  assert_status 0 "E-291.04 [$1]: ignored — the write is BLOCKED as without an override (rc=${rc})" test "$rc" -eq 2
  assert_contains "E-291.04 [$1]: …by the write gate itself (a real verdict, not a hook crash)" "SOVEREIGNTY_BLOCK" "$(cat "$T/err")"
  assert_status 0 "E-291.04 [$1]: exactly one [GATE_OVERRIDE] ignored notice" test "$(grep -c '\[GATE_OVERRIDE\] ignored' "$T/err")" -eq 1
  assert_contains "E-291.04 [$1]: …naming the reason" "$2" "$(cat "$T/err")"
}
rm -f "$GO"; printf '{"until": %s, "reason": "old"}' "$(( $(date +%s) - 10 ))" > "$GO"; chmod 600 "$GO"; _ignored "expired" "expired"
rm -f "$GO"; printf '{"until": NaN}' > "$GO"; chmod 600 "$GO"; _ignored "NaN until (the naive-check exploit)" "not a finite number"
rm -f "$GO"; printf '{"until": %s}' "$(( $(date +%s) + 4000 ))" > "$GO"; chmod 600 "$GO"; _ignored "window over 60 minutes" "longer than 60 minutes"
_override; chmod 620 "$GO"; _ignored "group-writable" "group/other-writable"
# E-294: a group-writable ~/.ai-os also fails the launch-record discipline (each directory 0700),
# so no session can be minted there — the hook runs with no token, i.e. in the union, which
# applies the same Architect write rule this case needs.
_override; chmod 770 "$M"; _HOOK_SESSION=0; _ignored "group-writable directory" "directory is group/other-writable"; _HOOK_SESSION=1; chmod 700 "$M"
rm -f "$GO"; ln -s /etc/hosts "$GO"; _ignored "symlink" "symlink"
rm -f "$GO"
if ln /private/etc/hosts "$GO" 2>/dev/null || ln /etc/hosts "$GO" 2>/dev/null; then
  # The owner check runs before the link-count check, so this reason proves the OWNER rule
  # fired (critic_tests: a link count of 2 alone would also reject this file).
  _ignored "other owner (a hardlink to a root-owned file)" "not owned by you"
else
  _skip "E-291.04 [other owner]: this host refuses a hardlink to a root-owned file (protected_hardlinks)"
fi
rm -f "$GO"

# ── E-291.5: `ai gate` — clamp, on, status; the analyzer refuses it to the agent ─
out="$(HOME="$H" bash "$AI_BIN" gate off --minutes 90 --reason "e291 clamp" 2>&1)"
assert_contains "E-291.05a: --minutes 90 is clamped to 60, with a notice" "clamped to 60" "$out"
assert_status 0 "E-291.05b: the file is 0600" test "$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$GO")" = "600"
assert_contains "E-291.05c: status reports it ACTIVE" "override ACTIVE" "$(HOME="$H" bash "$AI_BIN" gate status 2>&1)"
for bad in 0 -5 1e9 '15;id'; do
  rc=0; HOME="$H" bash "$AI_BIN" gate off --minutes "$bad" >/dev/null 2>&1 || rc=$?
  assert_status 0 "E-291.05d: --minutes '${bad}' is rejected" test "$rc" -ne 0
done
HOME="$H" bash "$AI_BIN" gate on >/dev/null 2>&1
assert_status 1 "E-291.05e: ai gate on removes the file" test -e "$GO"
# E-291.05f/g (the analyzer's GATE_SELF_DISABLE verdicts for the Engineer, 29 forms) are rows of
# the gate-self-disable contract table in the unit layer (E-301, D-088); the spawn path is probed
# once for it in safe_exec_test. What stays here needs the hook, a live session or the override.
rc="$( cd "$T/proj" && HOME="$H" bash "$AS" none e291chk -- node --no-warnings "$SE" --check-path "$M/shared/x.mjs" --session e291chk >/dev/null 2>&1; echo $? )"
assert_status 0 "E-291.05h: the write gate blocks ~/.ai-os/** for the ENGINEER too (rc=${rc})" test "$rc" -eq 2

# ── E-291.6: loudness beyond the call — session start and doctor ────────────
_override 15 "e291 loud"
ss="$(printf '{"session_id":"e291ss"}' | ( cd "$T/proj" && HOME="$H" /bin/bash "$SS_HOOK" engineer 2>/dev/null ))"
assert_contains "E-291.06a: session start announces the active override" "[GATE_OVERRIDE] the operator lifted the safe-exec policy gate" "$ss"
assert_contains "E-291.06b: ai doctor reports it" "override ACTIVE" "$( cd "$T/proj" && HOME="$H" bash "$AI_BIN" doctor 2>&1 )"
rm -f "$GO"

# ── E-291.7: telemetry — a pre-E-291 store accepts BYPASS after opening ─────
OLDDB="$T/old.sqlite"
node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1]);
  db.exec(`CREATE TABLE tool_executions (id TEXT PRIMARY KEY, project_hash TEXT, session_id TEXT, tool_name TEXT NOT NULL,
    execution_time_ms INTEGER, status TEXT NOT NULL CHECK(status IN (\x27SUCCESS\x27,\x27ERROR\x27,\x27TIMEOUT\x27,\x27REJECTED\x27)),
    timestamp TEXT NOT NULL, source TEXT)`);
  db.prepare("INSERT INTO tool_executions VALUES (?,?,?,?,?,?,?,?)").run("r1","p","s","Bash",1,"REJECTED",new Date().toISOString(),"hook");' "$OLDDB"
printf '{"tool_name":"Bash","execution_time_ms":0,"status":"BYPASS","source":"hook"}' \
  | AI_TELEMETRY_DB_PATH="$OLDDB" node --no-warnings "${REPO_ROOT}/src/shared/telemetry.mjs" --record-tool >/dev/null 2>&1
_n="$(node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  const r = db.prepare("SELECT status, COUNT(*) n FROM tool_executions GROUP BY status ORDER BY status").all();
  process.stdout.write(r.map((x) => x.status + "=" + x.n).join(","));' "$OLDDB" 2>/dev/null)"
assert_contains "E-291.07a: a 4-status store is migrated and accepts BYPASS, keeping its rows" "BYPASS=1,REJECTED=1" "$_n"

assert_summary
