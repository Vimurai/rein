#!/usr/bin/env bash
# role_token_test.sh — the session role: launch records, the v2 token, the mint table and the
# verifier (E-129 → E-294; D-083 r9, D-087; sovereignty-hardening.md Components 8a–8h).
#
# The invariant under test: A ROLE MAY ONLY MOVE TOWARD RESTRICTION. The role has no
# environment or argv input; it is the most restricted live launch record on the process chain,
# minted into an HMAC token bound to the session process (pid + start time), and verified only
# for a descendant of that process. Every case builds a REAL process chain — `bash -c` processes
# write records for their own pid and mint for their own pid, exactly as `ai pane` and the
# SessionStart hook do — in a hermetic HOME (rule 6). The hooks run from the repo, the framework
# clone, so the locator resolves the dev tree's safe-exec.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
export SE="${REPO_ROOT}/src/mcp/safe-exec-mcp/index.js"
export LR="${REPO_ROOT}/src/shared/launch-record.py"
export SSH_HOOK="${REPO_ROOT}/hooks/session-start.sh"
export PTU="${REPO_ROOT}/hooks/pre-tool-use.sh"
AI_BIN="${REPO_ROOT}/src/bin/ai"
_T="$(test_tmpdir roletok)"
export HOME="${_T}/home"; mkdir -p "${HOME}/.ai-os"; chmod 755 "${HOME}/.ai-os"
tc_fixture_home "$HOME"   # E-345 (D-109 r1): the toolchain record the hooks pin
FOREIGN="${_T}/foreign"; mkdir -p "${FOREIGN}/.ai"
RUN="${HOME}/.ai-os/run"
cd "$REPO_ROOT"

echo "===== role_token_test.sh (E-129, E-294) ====="

# forge <pid> <role> [project] — write a record for <pid> by hand, with its REAL start time,
# bypassing the writer's nested check: the state an attacker (or a bug) could leave behind.
cat > "${_T}/forge.sh" <<'EOF'
#!/usr/bin/env bash
pid="$1"; role="$2"; proj="${3:-$PWD}"
started="$(python3 -I "$LR" starttime "$pid")" || exit 1
mkdir -p "${HOME}/.ai-os/run/launch"; chmod 700 "${HOME}/.ai-os/run" "${HOME}/.ai-os/run/launch"
python3 -c 'import json,sys; json.dump({"role":sys.argv[1],"project":sys.argv[2],"started":sys.argv[3]}, open(sys.argv[4],"w"))' \
  "$role" "$(cd "$proj" && pwd -P)" "$started" "${HOME}/.ai-os/run/launch/${pid}.json"
chmod 600 "${HOME}/.ai-os/run/launch/${pid}.json"
EOF
export FORGE="${_T}/forge.sh"
tok() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get(sys.argv[2]))' "${RUN}/role-$1.lock" "$2" 2>/dev/null; }

# ── R01: the plain launch and the recorded launch ─────────────────────────────────────────
_o="$(bash -c 'node --no-warnings "$SE" --mint-token rt-plain $$; node --no-warnings "$SE" --verify-role rt-plain' 2>/dev/null)"
assert_contains "R01: no record on the chain → engineer, launch unverified (the plain-launch default)" $'engineer\tunverified' "$_o"
assert_contains "R01: …and it verifies for a descendant of the session process" $'\nengineer' "$_o"
assert_contains "R01: the token is v2" "2" "$(tok rt-plain v)"
_o="$(bash -c 'python3 -I "$LR" write $$ architect >/dev/null; node --no-warnings "$SE" --mint-token rt-arch $$; node --no-warnings "$SE" --verify-role rt-arch' 2>/dev/null)"
assert_contains "R01: an architect record → architect, launch record" $'architect\trecord' "$_o"
assert_contains "R01: …verified as architect" $'\narchitect' "$_o"
assert_status 0 "R01: machine key is 0600" test "$(file_mode "$HOME/.ai-os/secrets/role-hmac.key")" = "600"

# ── R02: nesting — a role never loosens below a live architect record ─────────────────────
# Each outer `bash -c` ends in `; :` — bash 5.1+ execs the LAST command of a -c string in
# place, which would run the "nested" shell under the SAME pid as the record (E-332, Linux).
_o="$(bash -c 'python3 -I "$LR" write $$ architect >/dev/null; bash -c "python3 -I \"\$LR\" write \$\$ engineer; echo rc=\$?"; :' 2>/dev/null)"
assert_contains "R02: the writer refuses under a live ancestor record (NESTED)" "NESTED" "$_o"
assert_contains "R02: …exit 3, nothing written" "rc=3" "$_o"
_o="$(bash -c 'python3 -I "$LR" write $$ architect >/dev/null; bash -c "node --no-warnings \"\$SE\" --mint-token rt-nest \$\$; node --no-warnings \"\$SE\" --verify-role rt-nest"; :' 2>/dev/null)"
assert_contains "R02: a nested provider (no record of its own) under an architect record mints architect" $'architect\trecord' "$_o"
_o="$(bash -c 'python3 -I "$LR" write $$ architect >/dev/null; bash -c "bash \"\$FORGE\" \$\$ engineer; node --no-warnings \"\$SE\" --mint-token rt-below \$\$"; :' 2>/dev/null)"
assert_contains "R02: an engineer record BELOW an architect record on one chain → architect (most restrictive wins)" $'architect\trecord' "$_o"

# ── R03: the mint takes no role ───────────────────────────────────────────────────────────
_e="$(bash -c 'node --no-warnings "$SE" --mint-token engineer $$' 2>&1)"
assert_contains "R03: a role word in the session-id slot is refused" "role word" "$_e"
assert_status 0 "R03: …and nothing is written for it" test ! -e "${RUN}/role-engineer.lock"
_e="$(bash -c 'node --no-warnings "$SE" --mint-token rt-x engineer' 2>&1)"
assert_contains "R03: a role word in the pid slot is refused" "session pid" "$_e"
sleep 30 & _SIB=$!; on_exit "kill $_SIB 2>/dev/null || true"   # AIOS_SLEEP_ALLOWED: a live sibling stand-in process, not a wait
_e="$(node --no-warnings "$SE" --mint-token rt-notmine "$_SIB" 2>&1)"   # a live SIBLING, not an ancestor
kill "$_SIB" 2>/dev/null; wait "$_SIB" 2>/dev/null
assert_contains "R03: a session pid that is not an ancestor of the minter is refused" "not an ancestor" "$_e"
_e="$(bash -c 'node --no-warnings "$SE" --mint-token "../../etc/evil" $$' 2>&1)"
assert_contains "R03: a traversal session id is refused" "malformed session id" "$_e"
assert_status 0 "R03: …nothing outside run/" test ! -e "${HOME}/.ai-os/etc/evil.lock"

# ── R04: the mint table (D-087 r2) ────────────────────────────────────────────────────────
# row 2 — the same session process mints again (SessionStart re-fires): a no-op.
_o="$(bash -c 'node --no-warnings "$SE" --mint-token rt-r2 $$ >/dev/null; shasum "$HOME/.ai-os/run/role-rt-r2.lock"; node --no-warnings "$SE" --mint-token rt-r2 $$; shasum "$HOME/.ai-os/run/role-rt-r2.lock"' 2>/dev/null)"
assert_status 0 "R04 row 2: a re-mint by the bound process leaves the token byte-identical" \
  test "$(printf '%s\n' "$_o" | sed -n '1p' | cut -d' ' -f1)" = "$(printf '%s\n' "$_o" | sed -n '3p' | cut -d' ' -f1)"
assert_contains "R04 row 2: …and reports the bound role" $'engineer\tunverified' "$_o"
# row 3 — bound to another LIVE process: refused, untouched.
# `(exec bash …) &`, not `bash … &`: footprint.sh's bash() function makes `$!` a subshell, and
# on bash 5 (Linux) that subshell does not exec the real bash — killing `$!` left the session
# process the token is bound to alive, so row 4 saw "another live process" (E-332).
(exec bash -c 'node --no-warnings "$SE" --mint-token rt-r3 $$ >/dev/null 2>&1; exec sleep 30') &   # AIOS_SLEEP_ALLOWED: a live stand-in session process, not a wait
_B=$!; on_exit "kill $_B 2>/dev/null || true"
wait_for "[[ -f '${RUN}/role-rt-r3.lock' ]]" 5000 || true
_sum="$(shasum "${RUN}/role-rt-r3.lock" | cut -d' ' -f1)"
_e="$(bash -c 'node --no-warnings "$SE" --mint-token rt-r3 $$' 2>&1)"
assert_contains "R04 row 3: a session id bound to another live process is refused" "another live process" "$_e"
assert_status 0 "R04 row 3: …the token is untouched" test "$(shasum "${RUN}/role-rt-r3.lock" | cut -d' ' -f1)" = "$_sum"
kill "$_B" 2>/dev/null; wait "$_B" 2>/dev/null
# row 4 — the bound process is gone (a resume in a new process).
_o="$(bash -c 'node --no-warnings "$SE" --mint-token rt-r3 $$; echo "pid=$$"' 2>/dev/null)"
assert_contains "R04 row 4: a dead process's token is re-bound at the same role" $'engineer\tunverified' "$_o"
assert_contains "R04 row 4: …to the new session process" "pid=$(tok rt-r3 pid)" "$_o"
bash -c 'node --no-warnings "$SE" --mint-token rt-up $$ >/dev/null 2>&1'
_o="$(bash -c 'python3 -I "$LR" write $$ architect >/dev/null; node --no-warnings "$SE" --mint-token rt-up $$' 2>/dev/null)"
assert_contains "R04 row 4: engineer → architect (toward restriction) is allowed" $'architect\trecord' "$_o"
bash -c 'python3 -I "$LR" write $$ architect >/dev/null; node --no-warnings "$SE" --mint-token rt-down $$ >/dev/null 2>&1'
_e="$(bash -c 'node --no-warnings "$SE" --mint-token rt-down $$; node --no-warnings "$SE" --verify-role rt-down; echo vr=$?' 2>&1)"
assert_contains "R04 row 4: architect → engineer (a resume outside the Architect pane) is refused" "only moves toward restriction" "$_e"
assert_contains "R04 row 4: …and the old token does not verify there (union)" "vr=1" "$_e"
assert_status 0 "R04 row 4: …and the DEAD architect token is removed rather than left for pid reuse (P2-2) — union" test ! -e "${RUN}/role-rt-down.lock"
# v1 — recognised only in row 4; never verifies.
mkv1() { node -e '
  const c=require("node:crypto"),fs=require("fs");
  const [role,sid,p]=process.argv.slice(1);
  const key=fs.readFileSync(process.env.HOME+"/.ai-os/secrets/role-hmac.key","utf8").trim();
  const h=c.createHmac("sha256",Buffer.from(key,"hex")).update(`v1|${role}|${sid}`).digest("hex");
  fs.writeFileSync(p,JSON.stringify({v:1,role,session_id:sid,hmac:h}),{mode:0o600});' "$1" "$2" "${RUN}/role-$2.lock"; }
mkv1 engineer rt-v1a
assert_status 1 "R04 v1: a valid v1 token never verifies" node --no-warnings "$SE" --verify-role rt-v1a
_o="$(bash -c 'node --no-warnings "$SE" --mint-token rt-v1a $$' 2>/dev/null)"
assert_contains "R04 v1: a v1 engineer token is re-minted as v2 at the same role" $'engineer\tunverified' "$_o"
assert_contains "R04 v1: …the file is now v2" "2" "$(tok rt-v1a v)"
mkv1 architect rt-v1b
_e="$(bash -c 'node --no-warnings "$SE" --mint-token rt-v1b $$' 2>&1)"
assert_contains "R04 v1: a v1 architect token is never re-minted as engineer" "only moves toward restriction" "$_e"
# row 5 — anything else at the path: refused, never replaced.
bash -c 'node --no-warnings "$SE" --mint-token rt-r5 $$ >/dev/null 2>&1'
python3 - "${RUN}/role-rt-r5.lock" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["role"] = "architect"; json.dump(d, open(p, "w"))
PY
_sum="$(shasum "${RUN}/role-rt-r5.lock" | cut -d' ' -f1)"
_e="$(bash -c 'node --no-warnings "$SE" --mint-token rt-r5 $$' 2>&1)"
assert_contains "R04 row 5: a token with a bad HMAC is refused" "never replaced" "$_e"
assert_status 0 "R04 row 5: …and left untouched" test "$(shasum "${RUN}/role-rt-r5.lock" | cut -d' ' -f1)" = "$_sum"
assert_status 1 "R04 row 5: …and it does not verify" node --no-warnings "$SE" --verify-role rt-r5
mkdir -p "${RUN}/role-rt-dir.lock"
_e="$(bash -c 'node --no-warnings "$SE" --mint-token rt-dir $$' 2>&1)"
assert_contains "R04 row 5: a directory at the token path is refused" "never replaced" "$_e"

# ── R05: removing the token never yields a less restricted role while the record is live ──
_o="$(bash -c 'python3 -I "$LR" write $$ architect >/dev/null; node --no-warnings "$SE" --mint-token rt-rm $$ >/dev/null; rm -f "$HOME/.ai-os/run/role-rt-rm.lock"; node --no-warnings "$SE" --mint-token rt-rm $$' 2>/dev/null)"
assert_contains "R05: delete-then-re-mint under a live architect record → architect again" $'architect\trecord' "$_o"

# ── R06: stale and foreign records ────────────────────────────────────────────────────────
_o="$(bash -c 'python3 -I "$LR" write $$ architect >/dev/null; f="$HOME/.ai-os/run/launch/$$.json"; python3 -c "import json,sys;d=json.load(open(sys.argv[1]));d[\"started\"]=\"Mon Jan  1 00:00:00 2001\";json.dump(d,open(sys.argv[1],\"w\"))" "$f"; node --no-warnings "$SE" --mint-token rt-stale $$' 2>/dev/null)"
assert_contains "R06: a record whose start time does not match its pid (pid reuse) is skipped" $'engineer\tunverified' "$_o"
_o="$(bash -c 'bash "$FORGE" $$ architect "'"$FOREIGN"'"; node --no-warnings "$SE" --mint-token rt-foreign $$; echo "minted=[$?]"; node --no-warnings "$SE" --check-path src/x.js --session rt-foreign; echo "rc=$?"' 2>&1)"
assert_not_contains "R06: a live record for ANOTHER project mints nothing" $'architect\trecord' "$_o"
assert_contains "R06: …and the write gate applies the union" "rc=2" "$_o"
assert_contains "R06: …naming the fix" "[ROLE_UNVERIFIED]" "$_o"

# ── R07: undisciplined records → the union ────────────────────────────────────────────────
for _k in symlink hardlink mode extrakey oversize badrole; do
  _o="$(K="$_k" bash -c '
    python3 -I "$LR" write $$ engineer >/dev/null
    f="$HOME/.ai-os/run/launch/$$.json"
    case "$K" in
      symlink)  mv "$f" "$f.real"; ln -s "$f.real" "$f" ;;
      hardlink) ln "$f" "$HOME/.ai-os/run/launch/link-$$" ;;
      mode)     chmod 644 "$f" ;;
      extrakey) python3 -c "import json,sys;d=json.load(open(sys.argv[1]));d[\"x\"]=1;json.dump(d,open(sys.argv[1],\"w\"))" "$f" ;;
      oversize) python3 -c "import json,sys;d=json.load(open(sys.argv[1]));d[\"project\"]=d[\"project\"]+\" \"*5000;json.dump(d,open(sys.argv[1],\"w\"))" "$f" ;;
      badrole)  python3 -c "import json,sys;d=json.load(open(sys.argv[1]));d[\"role\"]=\"root\";json.dump(d,open(sys.argv[1],\"w\"))" "$f" ;;
    esac
    node --no-warnings "$SE" --mint-token "rt-bad-$K" $$; node --no-warnings "$SE" --check-path src/x.js --session "rt-bad-$K"; echo "rc=$?"' 2>&1)"
  assert_not_contains "R07 [${_k}]: an undisciplined record mints nothing" $'engineer\t' "$_o"
  assert_contains "R07 [${_k}]: …and a src/ write is blocked by the union" "rc=2" "$_o"
done

# ── R08: a token verifies only under its own session process (session-id substitution) ────
bash -c 'python3 -I "$LR" write $$ engineer >/dev/null; node --no-warnings "$SE" --mint-token rt-eng $$ >/dev/null 2>&1'
_o="$(bash -c 'python3 -I "$LR" write $$ architect >/dev/null; node --no-warnings "$SE" --mint-token rt-arch2 $$ >/dev/null
  node --no-warnings "$SE" --check-path src/x.js --session rt-eng; echo "cp=$?"
  node --no-warnings "$SE" --check-path src/x.js --session rt-eng --session-pid $$; echo "hot=$?"
  node --no-warnings "$SE" --verify-role rt-eng; echo "vr=$?"' 2>&1)"
assert_contains "R08: an Architect presenting an Engineer session's id cannot write src/ (--check-path)" "cp=2" "$_o"
assert_contains "R08: …nor through the hot path with its own pid" "hot=2" "$_o"
assert_contains "R08: …and --verify-role (pre-commit, caller-role) does not verify it" "vr=1" "$_o"

# ── R09: the hooks end to end — env claims change nothing ─────────────────────────────────
_ss='{"session_id":"rt-hk","source":"startup"}'
_w='{"tool_name":"Write","tool_input":{"file_path":"src/x.js","content":"x"},"session_id":"rt-hk"}'
_b='{"tool_name":"Bash","tool_input":{"command":"git push origin main"},"session_id":"rt-hk"}'
_o="$(SS="$_ss" W="$_w" B="$_b" bash -c 'python3 -I "$LR" write $$ architect >/dev/null
  export AI_OS_PANE_ROLE=engineer AI_OS_CALLER_ROLE=engineer AI_OS_SOVEREIGNTY_LOCK=0
  printf "%s" "$SS" | bash "$SSH_HOOK" engineer
  echo; printf "%s" "$W" | bash "$PTU" >/dev/null 2>&1; echo "write=$?"
  printf "%s" "$B" | bash "$PTU" >/dev/null 2>&1; echo "push=$?"' 2>/dev/null)"
assert_contains "R09: an ai-pane-architect launch with engineer env claims still stamps architect" "[AI_OS_ROLE] architect" "$_o"
assert_contains "R09: …and blocks a src/ write" "write=2" "$_o"
assert_contains "R09: …and blocks git push" "push=2" "$_o"
_ss='{"session_id":"rt-plainhk","source":"startup"}'
_w='{"tool_name":"Write","tool_input":{"file_path":"src/x.js","content":"x"},"session_id":"rt-plainhk"}'
_o="$(SS="$_ss" W="$_w" bash -c 'printf "%s" "$SS" | bash "$SSH_HOOK" engineer; echo; printf "%s" "$W" | bash "$PTU" >/dev/null 2>&1; echo "write=$?"' 2>/dev/null)"
assert_contains "R09: a plain launch stamps engineer" "[AI_OS_ROLE] engineer" "$_o"
assert_contains "R09: …says the launch is unverified" "[AI_OS_LAUNCH] unverified" "$_o"
assert_contains "R09: …and keeps today's Engineer rules (src/ write allowed)" "write=0" "$_o"
_o="$(W="$_w" bash -c 'printf "%s" "$W" | bash "$PTU" 2>&1 >/dev/null; echo "write=$?"')"
assert_contains "R09: the same session id from a process that is not its session process → the union" "write=2" "$_o"
assert_contains "R09: …with the ROLE_UNVERIFIED line" "[ROLE_UNVERIFIED]" "$_o"
_o="$(bash -c 'printf "%s" "{\"session_id\":\"rt-none\",\"source\":\"startup\"}" | HOME=/nonexistent-aios-home bash "$SSH_HOOK" engineer' 2>/dev/null)"
assert_contains "R09: no token at all → the stamp says unverified" "[AI_OS_ROLE] unverified" "$_o"

# ── R11: critic_security's E-294 findings, pinned ─────────────────────────────────────────
# P1-1: a failed process snapshot is an error, never "nobody is alive". `ulimit -u 1` makes
# /bin/ps fail to start; prune must refuse (keeping the live record) and the walk must be the union.
cat > "${_T}/p11.sh" <<'EOF'
python3 -I "$LR" write $$ architect >/dev/null
bash -c 'ulimit -u 1; exec python3 -I "$LR" prune' >/dev/null 2>&1; echo "prune=$?"
test -f "$HOME/.ai-os/run/launch/$$.json" && echo "record=kept" || echo "record=GONE"
bash -c 'ulimit -u 1; exec python3 -I "$LR" walk'
EOF
# The failure being pinned is /bin/ps failing to start. launch-record.py reads /proc wherever
# /proc/self exists (Linux), and `ulimit -u` cannot make that unreadable — the case does not
# exist on such a host (E-236: a recorded SKIP, not a fabricated PASS or FAIL).
if [[ -d /proc/self ]]; then
  _skip "R11 P1-1: the process table is read from /proc here, not /bin/ps — ulimit -u cannot fail it"
else
  _o="$(bash "${_T}/p11.sh" 2>/dev/null)"
  assert_contains "R11 P1-1: prune refuses when the process table cannot be read" "prune=1" "$_o"
  assert_contains "R11 P1-1: …and the live architect record survives" "record=kept" "$_o"
  assert_contains "R11 P1-1: the walk on an unreadable table is the union, not the engineer default" '"result": "union"' "$_o"
fi
# The same behaviour on EVERY host (critic_tests P2): the snapshot itself reports an empty
# table — what /bin/ps failing, or an unreadable /proc, both come down to — and prune must
# refuse with the live record kept, and the walk must be the union.
cat > "${_T}/p11b.sh" <<'EOF'
python3 -I "$LR" write $$ architect >/dev/null
_lr_empty() { python3 -I - "$LR" "$@" <<'PYEOF'
import importlib.util, sys
sys.dont_write_bytecode = True   # -I does not stop it: no __pycache__ beside src/shared
spec = importlib.util.spec_from_file_location("launch_record", sys.argv[1])
lr = importlib.util.module_from_spec(spec); spec.loader.exec_module(lr)
lr._snapshot_raw = lambda: {}
sys.exit(lr.main(["launch-record.py"] + sys.argv[2:]))
PYEOF
}
_lr_empty prune >/dev/null 2>&1; echo "prune=$?"
test -f "$HOME/.ai-os/run/launch/$$.json" && echo "record=kept" || echo "record=GONE"
_lr_empty walk
EOF
_o="$(bash "${_T}/p11b.sh" 2>/dev/null)"
assert_contains "R11 P1-1b: an empty process snapshot makes prune refuse (any host)" "prune=1" "$_o"
assert_contains "R11 P1-1b: …the live architect record survives" "record=kept" "$_o"
assert_contains "R11 P1-1b: …and the walk is the union" '"result": "union"' "$_o"
# P2-1: an `ai pane architect` started inside a PLAIN session sits between that session's token
# and the verifier; borrowing the plain session's id must not yield engineer there.
_o="$(bash -c 'node --no-warnings "$SE" --mint-token rt-plainparent $$ >/dev/null 2>&1
  bash -c "python3 -I \"\$LR\" write \$\$ architect >/dev/null; node --no-warnings \"\$SE\" --verify-role rt-plainparent"' 2>/dev/null)"
assert_contains "R11 P2-1: --verify-role returns the MORE restrictive of the token and the walk" "architect" "$_o"
# …and the verifier's walk only ADDS restriction: a verified engineer session verifying from a
# directory in ANOTHER project (a commit in another repo, an MCP server's cwd) stays engineer.
_o="$(F="$FOREIGN" bash -c 'python3 -I "$LR" write $$ engineer >/dev/null; node --no-warnings "$SE" --mint-token rt-elsewhere $$ >/dev/null 2>&1
  cd "$F" && node --no-warnings "$SE" --verify-role rt-elsewhere' 2>/dev/null)"
assert_contains "R11 P2-1: a verified engineer verifying from another project's directory stays engineer (restrict-only walk)" "engineer" "$_o"
# P2-2: a refused mint removes a dead process's v2 token (only ever toward the union).
bash -c 'python3 -I "$LR" write $$ architect >/dev/null; node --no-warnings "$SE" --mint-token rt-deadarch $$ >/dev/null 2>&1'
bash -c 'node --no-warnings "$SE" --mint-token rt-deadarch $$ >/dev/null 2>&1'
assert_status 0 "R11 P2-2: a refused less-restricted re-mint deletes the dead process's token" test ! -e "${RUN}/role-rt-deadarch.lock"
assert_status 0 "R11 P2-3: caller-role spawns the verifier with process.execPath, not PATH" \
  grep -qF 'execFileSync(process.execPath, ["--no-warnings", se, "--verify-role", sid]' "${REPO_ROOT}/src/mcp/shared/caller-role.mjs"

# ── R10: wiring and the env inventory ─────────────────────────────────────────────────────
assert_status 0 "R10: SessionStart fires on startup|resume|clear|compact (a /clear issues a new session id) with no role arg" \
  grep -qF '("SessionStart", "startup|resume|clear|compact", "session-start.sh", [])' "$AI_BIN"
assert_status 0 "R10: pre-tool-use passes its own PPID as --session-pid" grep -qF -- '--session-pid "$PPID"' "$PTU"
assert_status 0 "R10: session-start mints with its own PPID and no role" grep -qF -- '--mint-token "$_SID" "$PPID"' "$SSH_HOOK"
assert_status 1 "R10: no gate file reads AI_OS_CALLER_ROLE / AI_OS_PANE_ROLE" \
  grep -qE 'process\.env\.AI_OS_(CALLER|PANE)_ROLE' "$SE" "${REPO_ROOT}/src/mcp/safe-exec-mcp/role-token.mjs" "${REPO_ROOT}/src/mcp/shared/caller-role.mjs"
assert_status 1 "R10: session-start and pre-tool-use read no role variable outside comments" \
  bash -c "grep -vE '^[[:space:]]*#' '$SSH_HOOK' '$PTU' | grep -qE '\\\$\\{?AI_OS_(CALLER|PANE)_ROLE'"
_V_TOKEN="AI_OS_ROLE""_TOKEN"
assert_status 1 "R10: no environment rollback for the token layer (E-291)" grep -qF "$_V_TOKEN" "$SE"
assert_status 0 "R10: install_global provisions the HMAC key" grep -qF 'role-hmac.key' "$AI_BIN"
_argv="$(cd "$REPO_ROOT" && node --input-type=module -e '
  import { providerAdapter, buildArgv, DEFAULT_ADAPTERS } from "./src/shared/provider-adapter.mjs";
  const a = providerAdapter(".ai", "claude");
  console.log(JSON.stringify([buildArgv(a.print_mode, { prompt: "p", rulefile: "r" }),
                              buildArgv(DEFAULT_ADAPTERS.claude.print_mode, { prompt: "p", rulefile: "r" })]));' 2>&1)"
assert_match "R10: the advisor's resolved print_mode argv is non-empty" '"-p"' "$_argv"
assert_not_contains "R10: …and carries no permission-bypass flag (D-087 r6)" "dangerously" "$_argv"
assert_not_contains "R10: …nor a permission mode" "permission-mode" "$_argv"

assert_summary
