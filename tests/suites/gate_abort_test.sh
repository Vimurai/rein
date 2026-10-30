#!/usr/bin/env bash
# REIN_EXCLUSIVE: perf   (E-312: E-292.05f bounds a 10 s timer at +1.5 s; 4-lane contention measured 12309 ms on 7b33882)
# gate_abort_test.sh — E-292 (D-082 ruling 2, sovereignty-hardening.md §Hook Toolchain Pinning
# Component 7): an ABORTED gate is a BLOCKED call; the analyzer answers within 10 s; a
# fail-open hook that aborts exits 0 and leaves exactly one incident record.
#
# Fixture: a throwaway HOME whose install mirror carries this checkout's analyzer and shared
# helpers, and COPIES of the hooks outside the repo, so a hook resolves only that mirror.
# Faults are injected into the copies (never into hooks/). The hook before E-292 (E-291 tip,
# fe964a1) runs the same fixtures where a test claims "this was the gap".
#
# Measured, and recorded honestly (divergence from the task's acceptance wording): bash exits a
# SCRIPT with status 2 on a syntax error (258 is only the internal $?), so the pre-change hook
# already BLOCKED a syntax error — what E-292 adds there is the [GATE_INTERNAL_ERROR] line. The
# unbound variable (rc 1) and the parser failures below were real allow paths.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PRE_E292_REF="fe964a1"

echo "── Suite: gate_abort_test (E-292) ───────────────────────────────────"

skip_unless_cmd node "E-292 gate abort" || { assert_summary; exit 0; }
skip_unless_cmd python3 "E-292 gate abort" || { assert_summary; exit 0; }

T="$(mktemp -d)"; on_exit "rm -rf '$T'"
T="$(cd -P "$T" && pwd -P)"
H="$T/home"; M="$H/.rein"
mkdir -p "$M/mcp/safe-exec-mcp" "$T/tree/hooks" "$T/proj"
cp -R "${REPO_ROOT}/src/shared" "$M/shared"
cp -R "${REPO_ROOT}/src/mcp/shared" "$M/mcp/shared"
for f in "${REPO_ROOT}/src/mcp/safe-exec-mcp/"*; do
  n="${f##*/}"
  if [[ "$n" == "node_modules" ]]; then ln -s "$f" "$M/mcp/safe-exec-mcp/node_modules"; else cp -R "$f" "$M/mcp/safe-exec-mcp/"; fi
done
[[ -d "${REPO_ROOT}/node_modules" ]] && ln -s "${REPO_ROOT}/node_modules" "$M/node_modules"
tc_fixture_home "$H"   # E-345 (D-109 r1): the record the install writes, through its own writer
SE="$M/mcp/safe-exec-mcp/index.js"
cp "$SE" "$T/index.js.real"
NEW="$T/tree/hooks/pre-tool-use.sh"; cp "${REPO_ROOT}/hooks/pre-tool-use.sh" "$NEW"
OLD="$T/old/hooks/pre-tool-use.sh"; mkdir -p "${OLD%/*}"
# E-378 (D-129): the public repository starts from one squashed commit, so the pre-change hook
# exists only in a checkout carrying the private history. Without it every "GAP" assertion and
# the frozen-row comparison are recorded skips (rule 1), as gate_override and pre_tool_use_gate do.
HAVE_OLD=0
git -C "$REPO_ROOT" show "${PRE_E292_REF}:hooks/pre-tool-use.sh" > "$OLD" 2>/dev/null && HAVE_OLD=1
_old() { [[ "$HAVE_OLD" -eq 1 ]] || { _skip "$1: pre-change hook (${PRE_E292_REF}) not in this checkout's history"; return 1; }; }

# inject <src> <dst> <line> — the line goes right after the hook's `set -uo pipefail`
inject() { awk -v L="$3" '{print} /^set -uo pipefail$/ && !d {print L; d=1}' "$1" > "$2"; grep -qxF -- "$3" "$2"; }
_bash_payload() { python3 -c 'import json,sys; print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.argv[1]},"session_id":"e292"}))' "$1"; }
_run_raw() {  # <hook> <raw payload> → exit code; stderr in $T/err
  ( cd "$T/proj" && printf '%s' "$2" | env HOME="$H" /bin/bash -p "$1" >/dev/null 2>"$T/err" ); echo $?
}
_run() { _run_raw "$1" "$(_bash_payload "$2")"; }

# What THIS host's /bin/bash hands an EXIT trap (E-332, measured — never assumed): bash 3.2
# reports a script syntax error as rc 258 and the aborting line in $LINENO; bash 5 reports
# rc 2 and LINENO 1. The verdict (block, exit 2, the GATE_INTERNAL_ERROR line) is the same.
printf 'set -uo pipefail\ntrap %s EXIT\n:\nif then fi\n' "'echo \"\$?\"'" > "$T/probe-syntax.sh"
_SYN_RC="$(/bin/bash -p "$T/probe-syntax.sh" 2>/dev/null)"
printf 'set -uo pipefail\ntrap %s EXIT\n:\n: "${E292_PROBE_UNSET}"\n' "'echo \"\$LINENO\"'" > "$T/probe-line.sh"
_TRAP_LINE="$(/bin/bash -p "$T/probe-line.sh" 2>/dev/null)"

# ── E-292.01: unbound variable → [GATE_INTERNAL_ERROR], exit 2 ────────────────────
rc="$(_run "$NEW" "ls -la")"
assert_status 0 "E-292.01a: fixture sanity — a harmless command passes (rc=${rc})" test "$rc" -eq 0
rc="$(_run "$NEW" "rm -rf ~/")"
assert_status 0 "E-292.01b: fixture sanity — a destructive one blocks with a verdict (rc=${rc})" test "$rc" -eq 2
for v in old new; do src="$NEW"; [[ "$v" == old ]] && { [[ "$HAVE_OLD" -eq 1 ]] || continue; src="$OLD"; }
  inject "$src" "$T/$v-unbound.sh" ': "${E292_UNSET_VAR}"'
  inject "$src" "$T/$v-unbound-fn.sh" 'e292f() { : "${E292_UNSET_VAR}"; }; e292f'
  inject "$src" "$T/$v-syntax.sh" 'if then fi'
done
if _old "E-292.01c"; then
  rc="$(_run "$T/old-unbound.sh" "ls -la")"
  assert_status 0 "E-292.01c: GAP — the pre-change hook exits 1 on an unbound variable = ALLOW (rc=${rc})" test "$rc" -eq 1
fi
rc="$(_run "$T/new-unbound.sh" "ls -la")"
assert_status 0 "E-292.01d: the new hook BLOCKS it (rc=${rc})" test "$rc" -eq 2
assert_contains "E-292.01e: with the GATE_INTERNAL_ERROR line naming rc 1" \
  "[GATE_INTERNAL_ERROR] pre-tool-use aborted (rc 1 near line" "$(cat "$T/err")"
assert_contains "E-292.01f: …and the repair hint" "— run: rein doctor" "$(cat "$T/err")"
_line="$(sed -n 's/.*near line \([0-9]*\)).*/\1/p' "$T/err")"
_want="$(grep -nxF ': "${E292_UNSET_VAR}"' "$T/new-unbound.sh" | cut -d: -f1)"
if [[ "$_TRAP_LINE" == 4 ]]; then
  assert_status 0 "E-292.01g: the line is the injected one (want ${_want}, got ${_line:-none})" test -n "$_want" -a "$_want" = "$_line"
elif [[ "$_TRAP_LINE" =~ ^[0-9]+$ ]]; then
  _skip "E-292.01g: this host's bash does not carry the aborting line into an EXIT trap (LINENO=${_TRAP_LINE})"
else
  _fail "E-292.01g: the LINENO probe printed nothing — /bin/bash -p did not run it (critic_tests P3)"
fi
if _old "E-292.01h"; then
  rc="$(_run "$T/old-unbound-fn.sh" "ls -la")"
  assert_status 0 "E-292.01h: GAP — inside a function too, pre-change (rc=${rc})" test "$rc" -eq 1
fi
rc="$(_run "$T/new-unbound-fn.sh" "ls -la")"
assert_status 0 "E-292.01i: inside a function the new hook blocks (rc=${rc})" test "$rc" -eq 2
# Not a deliberate exit just because the failing command IS `exit`: `exit $UNSET` aborts.
inject "$NEW" "$T/new-exit-unset.sh" 'exit "${E292_UNSET_VAR}"'
rc="$(_run "$T/new-exit-unset.sh" "ls -la")"
assert_status 0 "E-292.01j: 'exit \$UNSET' is an abort, not a deliberate exit (rc=${rc})" test "$rc" -eq 2
assert_contains "E-292.01k: …and says so" "[GATE_INTERNAL_ERROR]" "$(cat "$T/err")"

# ── E-292.02: syntax error ─────────────────────────────────────────────────────────
if _old "E-292.02a/b"; then
  rc="$(_run "$T/old-syntax.sh" "ls -la")"
  assert_status 0 "E-292.02a: measured — bash already exits 2 on a script syntax error, pre-change (rc=${rc})" test "$rc" -eq 2
  assert_not_contains "E-292.02b: …but silently: no GATE_INTERNAL_ERROR line" "[GATE_INTERNAL_ERROR]" "$(cat "$T/err")"
fi
rc="$(_run "$T/new-syntax.sh" "ls -la")"
assert_status 0 "E-292.02c: the new hook blocks it (rc=${rc})" test "$rc" -eq 2
assert_contains "E-292.02d: and names the syntax-error rc (${_SYN_RC} on this bash)" "[GATE_INTERNAL_ERROR] pre-tool-use aborted (rc ${_SYN_RC} near line" "$(cat "$T/err")"

# ── E-292.03: the payload parser (security_engineer P0-1) ──────────────────────────
SURR='{"tool_name":"Bash","tool_input":{"command":"rm -rf / \ud800"},"session_id":"e292"}'
MALF='{"tool_name":"Bash","tool_input":{"command":"rm -rf /"'
FPSU='{"tool_name":"Write","tool_input":{"file_path":"/x/\ud800","content":""},"session_id":"e292"}'
NLTN='{"tool_name":"Bash\nWrite","tool_input":{"command":"ls"},"session_id":"e292"}'
NOTD='["Bash"]'
if _old "E-292.03a"; then
  for c in SURR MALF FPSU; do
    rc="$(_run_raw "$OLD" "${!c}")"
    assert_status 0 "E-292.03a: GAP — pre-change hook ALLOWS a ${c} payload (rc=${rc})" test "$rc" -eq 0
  done
fi
NULC='{"tool_name":"Bash","tool_input":{"command":"echo ok\u0000rm -rf ~"},"session_id":"e292"}'
for c in SURR MALF FPSU NLTN NOTD NULC; do
  rc="$(_run_raw "$NEW" "${!c}")"
  assert_status 0 "E-292.03b: the new hook BLOCKS a ${c} payload (rc=${rc})" test "$rc" -eq 2
  assert_contains "E-292.03c: ${c} → parse line" "[GATE_INTERNAL_ERROR] pre-tool-use could not parse the tool call" "$(cat "$T/err")"
done
rc="$(_run_raw "$NEW" '{"tool_name":"Read","tool_input":{"file_path":"/etc/hosts"},"session_id":"e292"}')"
assert_status 0 "E-292.03d: a well-formed non-Bash call still passes (rc=${rc})" test "$rc" -eq 0
rc="$(_run_raw "$NEW" "")"
assert_status 0 "E-292.03e: an empty payload is still 'nothing to gate' (rc=${rc})" test "$rc" -eq 0

# ── E-292.04: the backstop no longer SIGPIPEs on a padded command ───────────────────
mv "$SE" "$T/index.js.away"
PAD="$(yes '# pad' | head -n 60000)"
# The padding goes in on stdin: as one argv string it exceeds Linux's 128 KB per-argument cap
# (MAX_ARG_STRLEN), python3 never ran, and an EMPTY payload made 04a/04b vacuous (E-332).
PP="$(printf '%s' "$PAD" | python3 -c 'import json,sys; print(json.dumps({"tool_name":"Bash","tool_input":{"command":"rm -rf /\n"+sys.stdin.read()},"session_id":"e292"}))')"
assert_status 0 "E-292.04: fixture sanity — the padded payload was built (${#PP} bytes)" test "${#PP}" -gt 300000
if _old "E-292.04a"; then
  rc="$(_run_raw "$OLD" "$PP")"
  assert_status 0 "E-292.04a: GAP — analyzer absent, pre-change backstop ALLOWS rm -rf / + 60k lines (pipefail SIGPIPE, rc=${rc})" test "$rc" -eq 0
fi
rc="$(_run_raw "$NEW" "$PP")"
assert_status 0 "E-292.04b: the new backstop blocks it (rc=${rc})" test "$rc" -eq 2
mv "$T/index.js.away" "$SE"

# ── E-292.05: the 10 s wall clock (exit 4 = TIMEOUT) ───────────────────────────────
# Timing (E-239): millisecond clock; the bound is 10 s + this host's own fast-path hook time
# (measured now, same fixture) + 1.5 s slack — printed every run.
_ms() { python3 -c 'import time; print(int(time.monotonic() * 1000))'; }
t0=$(_ms); _run "$NEW" "ls -la" >/dev/null; BASE_MS=$(( $(_ms) - t0 ))
LIMIT_MS=$(( 10000 + BASE_MS + 1500 ))
echo "  timing: fast-path hook ${BASE_MS} ms on this host → TIMEOUT bound ${LIMIT_MS} ms"
# A SYNCHRONOUS hang: an unref'd in-process timer can never fire here, so this proves the
# hook's outside alarm (security_engineer: an async sleep would pass either design).
printf '%s\n' 'const end = Date.now() + 15000; while (Date.now() < end) {}' > "$SE"
t0=$(_ms); rc="$(_run "$NEW" "ls -la")"; dt=$(( $(_ms) - t0 ))
assert_status 0 "E-292.05a: a 15 s synchronous analyzer is BLOCKED (rc=${rc})" test "$rc" -eq 2
assert_status 0 "E-292.05b: …within ${LIMIT_MS} ms, not 15 s (took ${dt} ms)" test "$dt" -le "$LIMIT_MS"
assert_contains "E-292.05c: naming rc 4 (TIMEOUT)" "safe-exec exited 4 (TIMEOUT" "$(cat "$T/err")"
t0=$(_ms)
rc="$(_run_raw "$NEW" '{"tool_name":"Write","tool_input":{"file_path":"'"$T"'/proj/a.txt","content":""},"session_id":"e292"}')"
dt=$(( $(_ms) - t0 ))
assert_status 0 "E-292.05d: the write gate's --check-path is bounded the same way (rc=${rc}, ${dt} ms ≤ ${LIMIT_MS})" test "$rc" -eq 2 -a "$dt" -le "$LIMIT_MS"
assert_contains "E-292.05e: …and says TIMEOUT" "(rc 4 TIMEOUT)" "$(cat "$T/err")"
# critic_security P1: under an operator override, a write with NO verdict (timeout) is never
# bypassed — the self-disable guard did not run, and a text test on the path (.Rein on
# case-insensitive APFS, a symlinked parent) is no substitute.
python3 -I "$M/shared/gate-override.py" write "$M/gate-override.json" 15 "e292 test" >/dev/null
for fp in "$T/proj/a.txt" "$H/.Rein/hooks/x.sh"; do
  rc="$(_run_raw "$NEW" '{"tool_name":"Write","tool_input":{"file_path":"'"$fp"'","content":""},"session_id":"e292"}')"
  assert_status 0 "E-292.05h: override active + analyzer timeout → write to ${fp##"$T"/} BLOCKED, not bypassed (rc=${rc})" test "$rc" -eq 2
done
rm -f "$M/gate-override.json"
cp "$T/index.js.real" "$SE"
# The in-process timer (async wait): a preload swallows the CLI's FIRST process.exit and holds
# the event loop open, so the check never answers; only the timer can end it.
printf '%s\n' 'let n = 0; const real = process.exit; process.exit = (c) => { if (n++ === 0) { setInterval(() => {}, 1000); return; } real(c); };' > "$T/hold.mjs"
t0=$(_ms)
_trc=0; node --no-warnings --import "$T/hold.mjs" "$SE" --check "ls" engineer </dev/null >/dev/null 2>"$T/err" || _trc=$?
dt=$(( $(_ms) - t0 ))
assert_status 0 "E-292.05f: with the event loop free, safe-exec's own timer exits 4 (rc=${_trc}, ${dt} ms ≤ ${LIMIT_MS})" test "$_trc" -eq 4 -a "$dt" -ge 9000 -a "$dt" -le "$LIMIT_MS"
assert_contains "E-292.05g: …with its TIMEOUT line" "[safe-exec] TIMEOUT: no verdict within 10 s" "$(cat "$T/err")"

# ── E-292.06: a signal while the analyzer runs blocks ──────────────────────────────
# Works as ESM or CJS: getBuiltinModule needs no import/require.
printf '%s\n' "process.getBuiltinModule('fs').writeFileSync('$T/analyzer-started', ''); setTimeout(() => {}, 3000);" > "$SE"
rm -f "$T/analyzer-started"
( cd "$T/proj" && _bash_payload "ls" | env HOME="$H" /bin/bash -p "$NEW" >/dev/null 2>"$T/err" ) &
_hp=$!
wait_for "[[ -e '$T/analyzer-started' ]]" 5000 || true
assert_status 0 "E-292.06z: the analyzer was running when the signal was sent" test -e "$T/analyzer-started"
pkill -TERM -f "/bin/bash -p ${NEW}" 2>/dev/null
wait "$_hp"; rc=$?
assert_status 0 "E-292.06a: SIGTERM to the gate mid-analysis ends in exit 2 (rc=${rc})" test "$rc" -eq 2
assert_contains "E-292.06b: …with the interrupted line" "[GATE_INTERNAL_ERROR] pre-tool-use interrupted by a signal" "$(cat "$T/err")"
cp "$T/index.js.real" "$SE"

# ── E-292.07: PERL* cannot load code into the gate (the wall clock is perl) ─────────
mkdir -p "$T/perl5"; MARK="$T/perl-ran"
printf 'package E292Evil; open(my $f, ">", "%s"); close $f; 1;\n' "$MARK" > "$T/perl5/E292Evil.pm"
( cd "$T/proj" && _bash_payload "ls" | env HOME="$H" PERL5LIB="$T/perl5" PERL5OPT="-ME292Evil" /bin/bash -p "$NEW" >/dev/null 2>&1 )
rc=$?
assert_status 0 "E-292.07a: the gate still answers with PERL5LIB/PERL5OPT set (rc=${rc})" test "$rc" -eq 0
assert_status 0 "E-292.07b: …and the project's perl module never ran" test ! -e "$MARK"
env PERL5LIB="$T/perl5" PERL5OPT="-ME292Evil" /usr/bin/perl -e 1 2>/dev/null
assert_status 0 "E-292.07c: non-vacuity — the same env DOES load it into a bare perl" test -e "$MARK"
rm -f "$MARK"

# ── E-292.08: git gates — an abort is not a policy refusal, and a refusal is not an abort ─
G="$T/repo"; mkdir -p "$G/.ai"; git -C "$G" init -q
cp "${REPO_ROOT}/hooks/pre-push.sh" "$T/tree/hooks/pre-push.sh"
mv "$M/shared/ci-record.mjs" "$T/ci-record.mjs.away"
rc=0; ( cd "$G" && env HOME="$H" /bin/bash -p "$T/tree/hooks/pre-push.sh" </dev/null >/dev/null 2>"$T/err" ) || rc=$?
assert_status 0 "E-292.08a: pre-push's deliberate refusal still exits 1 (rc=${rc})" test "$rc" -eq 1
assert_contains "E-292.08b: …with its own message" "[CI_GATE] pre-push" "$(cat "$T/err")"
assert_not_contains "E-292.08c: …and no GATE_INTERNAL_ERROR" "[GATE_INTERNAL_ERROR]" "$(cat "$T/err")"
mv "$T/ci-record.mjs.away" "$M/shared/ci-record.mjs"
awk '{print} /^AI_DIR=/ && !d {print "e292f() { if then; }"; d=1}' "$T/tree/hooks/pre-push.sh" > "$T/pre-push-bad.sh"
rc=0; ( cd "$G" && env HOME="$H" /bin/bash -p "$T/pre-push-bad.sh" </dev/null >/dev/null 2>"$T/err" ) || rc=$?
assert_status 0 "E-292.08d: a pre-push that aborts exits 2 (rc=${rc})" test "$rc" -eq 2
assert_contains "E-292.08e: …and says it aborted" "[GATE_INTERNAL_ERROR] pre-push aborted (rc ${_SYN_RC}" "$(cat "$T/err")"
# pre-commit's trap is a different text (codes 0/1): run it, don't just grep it (critic_tests P2).
awk '{print} /^unset _v _p$/ && !d {print ": $(( E292_X ))"; print "e292g() { : \"${E292_UNSET_VAR:?boom}\"; }; e292g"; d=1}' \
  "${REPO_ROOT}/hooks/pre-commit.sh" > "$T/pre-commit-bad.sh"
rc=0; ( cd "$G" && env HOME="$H" /bin/bash -p "$T/pre-commit-bad.sh" </dev/null >/dev/null 2>"$T/err" ) || rc=$?
assert_status 0 "E-292.08f: a pre-commit that aborts exits 2, not its deliberate 1 (rc=${rc})" test "$rc" -eq 2
assert_contains "E-292.08g: …and says it aborted" "[GATE_INTERNAL_ERROR] pre-commit aborted (rc 1 near line" "$(cat "$T/err")"

# ── E-292.09: fail-open hooks exit 0 and leave exactly ONE incident ─────────────────
INC="$M/incidents.ndjson"
_one_incident() {  # <label> <hook copy> <expected hook name> — env carries the tracker opt-out
  rm -f "$INC"
  local rc=0
  ( cd "$T/proj" && printf '{}' | env HOME="$H" AI_INCIDENT_TRACKER_DISABLE=1 /bin/bash -p "$2" >/dev/null 2>&1 ) || rc=$?
  assert_status 0 "E-292.09: $1 — the fail-open hook still exits 0 (rc=${rc})" test "$rc" -eq 0
  wait_for "[[ -s '$INC' ]]" 5000 100 || true
  sleep 0.3   # REIN_SLEEP_ALLOWED: negative wait — a SECOND record would land within this; exactly one may
  local n=0; [[ -f "$INC" ]] && n="$(grep -c . "$INC")"
  assert_status 0 "E-292.09: $1 — exactly one incident record, tracker opt-out in env ignored (got ${n})" test "$n" = 1
  assert_contains "E-292.09: $1 — HOOK_ABORT naming the hook" "\"stack_signature\":\"hooks/$3.sh:" "$(cat "$INC" 2>/dev/null)"
  assert_not_contains "E-292.09: $1 — no payload content in the record" "E292_SECRET_MARKER" "$(cat "$INC" 2>/dev/null)"
}
inject "${REPO_ROOT}/hooks/session-start.sh" "$T/tree/hooks/session-start-bad.sh" ': "${E292_UNSET_VAR}" # E292_SECRET_MARKER'
_one_incident "session-start, unbound variable" "$T/tree/hooks/session-start-bad.sh" "session-start"
# stop-hook and post-tool-log have no `set -u`: a syntax error right after the pin loads
# (`unset _v _p`), i.e. BEFORE locate.sh — the helper must reach the install mirror itself.
for h in stop-hook post-tool-log; do
  awk '{print} /^unset _v _p$/ && !d {print "e292f() { if then; }"; d=1}' "${REPO_ROOT}/hooks/${h}.sh" > "$T/tree/hooks/${h}-bad.sh"
  grep -qxF 'e292f() { if then; }' "$T/tree/hooks/${h}-bad.sh" || echo "  (injection point missing in ${h})"
  _one_incident "${h}, syntax error" "$T/tree/hooks/${h}-bad.sh" "${h}"
done
# Before the pin there is no trusted node, so nothing is recorded — and the hook still exits 0.
awk '{print} /^PATH=/ && !d {print "e292f() { if then; }"; d=1}' "${REPO_ROOT}/hooks/stop-hook.sh" > "$T/tree/hooks/stop-hook-prepin.sh"
rm -f "$INC"; rc=0
( cd "$T/proj" && printf '{}' | env HOME="$H" /bin/bash -p "$T/tree/hooks/stop-hook-prepin.sh" >/dev/null 2>&1 ) || rc=$?
sleep 0.5   # REIN_SLEEP_ALLOWED: negative wait — no incident may be written
assert_status 0 "E-292.09p: an abort BEFORE the pin still exits 0 and records nothing (documented, rc=${rc})" \
  test "$rc" -eq 0 -a ! -e "$INC"
rm -f "$INC"
rc=0; ( cd "$T/proj" && printf '{}' | env HOME="$H" /bin/bash -p "${REPO_ROOT}/hooks/stop-hook.sh" >/dev/null 2>&1 ) || rc=$?
sleep 0.5   # REIN_SLEEP_ALLOWED: negative wait — no incident may be written
assert_status 0 "E-292.09z: an UNBROKEN fail-open hook writes no incident (rc=${rc})" test ! -e "$INC"

# ── E-292.10: structure — one EXIT trap per hook, first executable line, nothing sourced sets one
for h in "${REPO_ROOT}"/hooks/*.sh; do
  n="$(grep -c "^trap .* EXIT$" "$h")"
  assert_status 0 "E-292.10a: $(basename "$h") has exactly one EXIT trap (got ${n})" test "$n" = 1
  first="$(awk 'NR>1 && $0 !~ /^[[:space:]]*(#|$)/ {print; exit}' "$h")"
  assert_contains "E-292.10b: $(basename "$h") — the trap is the first executable line" "trap '_rein_rc=\$?" "$first"
done
for s in locate.sh toolchain-pin.sh; do
  assert_status 0 "E-292.10c: src/shared/${s} sets no trap (it would replace the hook's)" \
    bash -c "! grep -qE '^[[:space:]]*trap[[:space:]]' '${REPO_ROOT}/src/shared/${s}'"
done
assert_contains "E-292.10d: generated hook entries carry an explicit 30 s timeout" \
  '"timeout": 30}' "$(grep -F '"args": ["-p", os.path.join(_HOOKS_DIR' "${REPO_ROOT}/src/bin/rein")"

# ── E-292.11: normal exit paths unchanged — the frozen contracts ─────────────────────
# A table may gain rows after E-292 (E-355 added secret rows); every row it had then must
# still be there, unchanged. Rows are one per line; a trailing comma is not part of a row.
for f in arch-write-cases secret-cases; do
  _old "E-292.11a (${f})" || continue
  assert_status 0 "E-292.11a: every row of tests/fixtures/${f}.json at ${PRE_E292_REF} is unchanged" \
    bash -c 'comm -23 <(git -C "$1" show "$2:tests/fixtures/$3.json" | sed "s/,\$//" | sort -u) \
      <(sed "s/,\$//" "$1/tests/fixtures/$3.json" | sort -u) | grep -q . && exit 1 || exit 0' _ "$REPO_ROOT" "$PRE_E292_REF" "$f"
done

assert_summary
