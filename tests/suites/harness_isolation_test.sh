#!/usr/bin/env bash
# AIOS_SUITE_TIMEOUT=300   (E-307: launch_vars' acceptance runs ~140 s on an idle host; the 180 s default leaves too little headroom)
# harness_isolation_test.sh — E-156 / E-157 (test-harness-isolation.md)
# Verifies tests/run.sh isolates MCP config into an ephemeral .mcp.test.json,
# exports MCP_CONFIG_PATH, and tears artifacts down via a trap on any exit.
#
# E-302 folds in every other harness-isolation property (one suite per variety of
# environment dependence): leaked external state and trap chaining (E-240/E-241), inherited
# launch variables (E-264), SKIP accounting (E-236), telemetry isolation (E-257) and
# same-host perf budgets (E-239). `set -e` is dropped: an absorbed section's failing setup
# command must reach its assertions, not end the suite.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUN_SH="${REPO_ROOT}/tests/run.sh"

echo "── Suite: harness_isolation_test ────────────────────────────────────"

run_sh_body="$(cat "$RUN_SH")"

# ── E-157: cleanup trap registered for EXIT, INT, and TERM ────────────────────
assert_contains "run.sh registers cleanup trap on EXIT/INT/TERM" \
  'trap _aios_test_cleanup EXIT INT TERM' "$run_sh_body"
assert_contains "run.sh defines the cleanup function" \
  '_aios_test_cleanup() {' "$run_sh_body"

# ── E-156: generates .mcp.test.json and exports MCP_CONFIG_PATH ───────────────
assert_contains "run.sh names the ephemeral config .mcp.test.json" \
  '/.mcp.test.json' "$run_sh_body"
assert_contains "run.sh exports MCP_CONFIG_PATH" \
  'export MCP_CONFIG_PATH=' "$run_sh_body"
assert_contains "run.sh bases the test config on production .mcp.json" \
  'cp "${REPO_ROOT}/.mcp.json" "$MCP_TEST_CONFIG"' "$run_sh_body"

# ── .gitignore safety net covers the ephemeral config ─────────────────────────
assert_status 0 ".mcp.test.json is git-ignored" \
  git -C "$REPO_ROOT" check-ignore .mcp.test.json

# ── Functional: a no-match run leaves the working tree clean ──────────────────
# Spawn run.sh with a pattern matching no suite — it exits 1 at discovery, AFTER
# the isolation setup + trap have run. Its temp dir is unique (mktemp), so this
# never collides with the outer runner's config.
_md5() { md5 -q "$1" 2>/dev/null || md5sum "$1" | awk '{print $1}'; }

mcp_before=""
[[ -f "${REPO_ROOT}/.mcp.json" ]] && mcp_before="$(_md5 "${REPO_ROOT}/.mcp.json")"

bash "$RUN_SH" '__aios_iso_nomatch__' >/dev/null 2>&1 || true

if [[ ! -e "${REPO_ROOT}/.mcp.test.json" ]]; then
  _pass "no .mcp.test.json left at repo root after run (trap cleaned up)"
else
  _fail "stale .mcp.test.json left at repo root after run"
fi

if [[ -n "$mcp_before" ]]; then
  mcp_after="$(_md5 "${REPO_ROOT}/.mcp.json")"
  assert_contains "production .mcp.json untouched by a test run" "$mcp_before" "$mcp_after"
fi

# ── E-251 (D-067 §5): corpus_or_fail — variety #5, "the scan that never ran" ──
#
# Three rule-scanning suites built their corpus with `find` over src/ plus every provider
# workspace root. E-244 stopped provisioning two of those roots, `find` exited non-zero, and the corpus came
# back EMPTY — so all three reported "no violations" about nothing, and would have gone on
# doing so. The helper makes the CORPUS STEP fail rather than the assertion that reads it.
#
# Everything below drives the real helper against fixtures, because the property under test
# is exactly the one that is easy to assert vacuously. NOTE: this suite runs under `set -e`,
# so every DELIBERATELY failing call captures its status with `|| _c_rc=$?` — a bare
# `x="$(failing)"` would abort the file at the assignment and the remaining assertions would
# simply not run, which is its own flavour of the scan that never ran.
_corpus_root="$(test_tmpdir e251)"
mkdir -p "${_corpus_root}/a" "${_corpus_root}/b"
for _i in 1 2 3 4 5; do
  printf 'x\n' > "${_corpus_root}/a/f${_i}.md"
  printf 'x\n' > "${_corpus_root}/b/g${_i}.txt"
done

# The happy path returns the list on stdout and 0.
_c_rc=0; _c_out="$( cd "$_corpus_root" && corpus_or_fail 5 a b 2>/dev/null )" || _c_rc=$?
assert_contains "E-251.01a: a healthy corpus returns 0" "0" "$_c_rc"
assert_contains "E-251.01b: and prints one path per file" "10" "$(printf '%s\n' "$_c_out" | grep -c .)"

# THE DEFECT, asserted directly: a missing root is a FAILURE, not a root to filter out.
_c_rc=0; _c_err="$( cd "$_corpus_root" && corpus_or_fail 1 a missing-root 2>&1 >/dev/null )" || _c_rc=$?
assert_contains "E-251.02a: a MISSING root fails the corpus (rc 1)" "1" "$_c_rc"
assert_contains "E-251.02b: and names the root that was missing" "missing-root" "$_c_err"
assert_contains "E-251.02c: and says the scan would have been empty" "empty" "$_c_err"

# Below the floor is the same defect arriving quietly — a corpus that shrank rather than
# vanished. E-244's suites had counts in the hundreds; a handful of files is not a scan.
_c_rc=0; _c_err="$( cd "$_corpus_root" && corpus_or_fail 100 a 2>&1 >/dev/null )" || _c_rc=$?
assert_contains "E-251.03a: a corpus below the minimum fails (rc 1)" "1" "$_c_rc"
assert_contains "E-251.03b: and reports the count it actually found" "5 file(s)" "$_c_err"

# The count is printed on EVERY run, pass or fail — a scan whose size is never shown is one
# nobody notices shrinking.
_c_err="$( cd "$_corpus_root" && corpus_or_fail 1 a 2>&1 >/dev/null )" || true
assert_contains "E-251.04a: the count is printed on the happy path too" "CORPUS 5 file(s)" "$_c_err"

# A predicate after `--` is wrapped in \( \), so an -o alternation binds to the predicate
# and does not swallow the roots.
_c_out="$( cd "$_corpus_root" && corpus_or_fail 1 a b -- -name "*.md" -o -name "*.txt" 2>/dev/null )" || true
assert_contains "E-251.05a: an -o predicate binds inside the parens" "10" "$(printf '%s\n' "$_c_out" | grep -c .)"
_c_out="$( cd "$_corpus_root" && corpus_or_fail 1 a b -- -name "*.md" 2>/dev/null )" || true
assert_contains "E-251.05b: and a narrowing predicate really narrows" "5" "$(printf '%s\n' "$_c_out" | grep -c .)"

# DATA OR STATE, NEVER BOTH (review question #4). The helper is called in a command
# substitution, so it must not touch the counters — a FAIL recorded inside that subshell
# would evaporate, and the suite would report a pass it never earned.
_pass_before="$PASS_COUNT"; _fail_before="$FAIL_COUNT"
_ignored="$( cd "$_corpus_root" && corpus_or_fail 999 a 2>/dev/null )" || true
assert_contains "E-251.06a: a failing corpus_or_fail does not mutate PASS_COUNT" \
  "$_pass_before" "$PASS_COUNT"
assert_contains "E-251.06b: nor FAIL_COUNT — the caller owns the assertion" \
  "$_fail_before" "$FAIL_COUNT"

# The converted suites really use it, rather than keeping a private find.
for _s in skill_lines_test; do
  assert_status 0 "E-251.07: ${_s} builds its corpus with corpus_or_fail" \
    grep -q 'corpus_or_fail ' "${SCRIPT_DIR}/${_s}.sh"
  assert_status 1 "E-251.07: ${_s} no longer filters roots for existence" \
    grep -q 'filter((d) => existsSync' "${SCRIPT_DIR}/${_s}.sh"
done
# program_position and operand_retokenise became rows of the standards table (E-301); their
# corpus scan moved in process to tests/unit/standards-cases.test.mjs, which has no shell
# helper to call, so it carries the same two guarantees itself: a required root and a floor.
_std_runner="${SCRIPT_DIR}/../unit/standards-cases.test.mjs"
assert_status 0 "E-251.07: the standards runner's corpus has a floor and required roots" \
  grep -q 'floor 100' "$_std_runner"
assert_status 1 "E-251.07: the standards runner does not filter roots for existence" \
  grep -q 'filter((d) => existsSync' "$_std_runner"

# ── E-307 (D-091): wait_for — poll the condition, never sleep a guess ──────────────────
# Extends the harness-primitive checks above (corpus_or_fail): the primitive every former
# `sleep N` site now uses. True as soon as the event happens; false at the deadline with the
# documented message; a predicate function may set state the caller reads (it runs in-shell).
_wf_dir="$(test_tmpdir waitfor)"
( sleep 0.3; touch "${_wf_dir}/ready" ) &   # AIOS_SLEEP_ALLOWED: the delayed event under test
_wf_t0=$SECONDS
assert_status 0 "E-307.F1: wait_for returns 0 once the condition holds" wait_for "[ -e '${_wf_dir}/ready' ]" 5000
assert_status 0 "E-307.F2: …without waiting out the timeout ($(( SECONDS - _wf_t0 ))s of 5s)" test $(( SECONDS - _wf_t0 )) -le 2
_wf_set() { _wf_val="seen"; return 0; }
_wf_val=""; wait_for _wf_set 1000
assert_contains "E-307.F3: a predicate function runs in the caller's shell (sets its variable)" "seen" "$_wf_val"
_wf_rc=0; _wf_err="$(wait_for false 300 100 2>&1)" || _wf_rc=$?
assert_status 0 "E-307.F4: wait_for returns 1 at the deadline (rc=${_wf_rc})" test "$_wf_rc" -eq 1
assert_contains "E-307.F5: …and says which condition and how long" "wait_for: false not true after 300 ms" "$_wf_err"
assert_status 0 "E-307.F6: grep finds no unmarked fixed sleep in tests/suites" \
  test -z "$(grep -nE 'sleep [0-9]' "${REPO_ROOT}"/tests/suites/*.sh | grep -v AIOS_SLEEP_ALLOWED)"

# ── A private socket does not isolate the CONFIG ─────────────────────────────
# The operator's ~/.tmux.conf (tmux-continuum auto-restore) put their saved sessions into
# ai_start_test's server. assert.sh now shims `tmux` with `-f /dev/null`; prove it against a
# fixture HOME whose config sets a marker option, and prove the fixture itself would load.
if skip_unless_cmd tmux "tmux config isolation"; then
  _cf_home="$(mktemp -d)"; register_cleanup "rm -rf '${_cf_home}'"
  printf 'set -g @aios_conf_probe loaded\n' > "${_cf_home}/.tmux.conf"
  _cf_real="${AIOS_TEST_REAL_TMUX:-}"
  assert_status 0 "E-254.T1a: the tmux on PATH is the harness shim" \
    bash -c "[[ '$(command -v tmux)' == '${AIOS_TEST_TMUX_SHIM:-/nonexistent}/tmux' && -x '${_cf_real}' ]]"

  _cf_sock="$(test_tmux_socket conf)"
  HOME="$_cf_home" tmux -L "$_cf_sock" new-session -d -s probe 2>/dev/null
  assert_not_contains "E-254.T1b: a server started through the harness loads no config" \
    "loaded" "$(tmux -L "$_cf_sock" show-options -gqv @aios_conf_probe 2>/dev/null)"
  tmux -L "$_cf_sock" kill-server 2>/dev/null || true

  # Non-vacuity: the same fixture, started with the real binary, DOES load the marker.
  _cf_sock2="$(test_tmux_socket conf2)"
  HOME="$_cf_home" XDG_CONFIG_HOME="${_cf_home}/.config" "$_cf_real" -L "$_cf_sock2" new-session -d -s probe 2>/dev/null
  assert_contains "E-254.T1c: without the shim the fixture config is loaded (guards T1b)" \
    "loaded" "$("$_cf_real" -L "$_cf_sock2" show-options -gqv @aios_conf_probe 2>/dev/null)"
  "$_cf_real" -L "$_cf_sock2" kill-server 2>/dev/null || true
fi

# ── E-345 (D-109 r1): the fixture-home census and the record helper ─────────────────────────
# Extends the runner checks above: a throwaway suite that points HOME at a temp dir and runs a
# hook without tc_fixture_home fails the run before any suite starts, and is named.
source "${REPO_ROOT}/tests/lib/toolchain-fixture.sh"
_fc="$(test_tmpdir fhcensus)"
mkdir -p "$_fc/suites"
cat > "$_fc/suites/bare_home_test.sh" <<'BARE'
#!/usr/bin/env bash
H="$(mktemp -d)"
printf '{}' | HOME="$H" bash "${REPO_ROOT}/hooks/stop-hook.sh"
BARE
_fc_rc=0
_fc_out="$(AIOS_TEST_SUITES_DIR="$_fc/suites" bash "$RUN_SH" 2>&1)" || _fc_rc=$?
assert_status 0 "E-345.01a: a suite running a hook under a bare fixture HOME fails the run" test "$_fc_rc" -eq 1
assert_contains "E-345.01b: …naming the suite and the rule" "[FIXTURE_HOME_NO_RECORD] bare_home_test.sh" "$_fc_out"
assert_not_contains "E-345.01c: …before any suite runs" "Suites found" "$_fc_out"
sed -i.bak 's#^H="$(mktemp -d)"$#H="$(mktemp -d)"; tc_fixture_home "$H"#' "$_fc/suites/bare_home_test.sh" && rm -f "$_fc/suites/bare_home_test.sh.bak"
assert_status 0 "E-345.01d: the same suite with tc_fixture_home passes the census" \
  node --no-warnings "${REPO_ROOT}/tests/tools/fixture-home-census.mjs" "$_fc/suites/bare_home_test.sh"
printf '{"bare_home_test.sh": {"rules": ["FIXTURE_HOME_NO_RECORD"]}}\n' > "$_fc/noreason.json"
assert_status 1 "E-345.01e: an exemption without a reason is refused" \
  node --no-warnings "${REPO_ROOT}/tests/tools/fixture-home-census.mjs" --exemptions "$_fc/noreason.json" "$_fc/suites/bare_home_test.sh"
assert_status 0 "E-345.01f: every suite and node unit test passes the census (record through the helper, or a listed reason)" \
  node --no-warnings "${REPO_ROOT}/tests/tools/fixture-home-census.mjs" "${REPO_ROOT}"/tests/suites/*.sh "${REPO_ROOT}"/tests/unit/*.test.mjs

# The helper writes the record the install writes, and AIOS_TEST_EMPTY_FALLBACK=1 is not vacuous:
# without the record, the emptied pin finds no node even on a host that has one in the list.
_fh="$_fc/home"
AIOS_TEST_EMPTY_FALLBACK=1 tc_fixture_home "$_fh"
_pin_node() { HOME="$_fh" bash -c '. "$HOME/.ai-os/shared/toolchain-pin.sh"; printf "%s" "${AI_OS_TC_NODE:-none}"'; }
assert_contains "E-345.02a: the record names this host's node (its realpath, as the install records it)" \
  "$(. "${REPO_ROOT}/src/shared/toolchain-record.sh"; ai_os_tc_realpath "$(command -v node)")" "$(_pin_node)"
mv "$_fh/.ai-os/shared/toolchain.sh" "$_fc/record.moved"
assert_contains "E-345.02b: with the fallback emptied and no record there is no node (the switch is not vacuous)" "none" "$(_pin_node)"


# ── E-240 / E-241 (from leaked_state_test — E-302, D-063 §2): a test run leaves nothing behind ──
# The E-227/E-228 suites leaked 50 tmux servers: cleanup was the LAST LINE of a block, so a FAILING
# assertion never reached it, and `$$` socket names recycled. Cleanup must survive the failing
# path, and the sweep must NEVER touch state outside the test prefix (the operator's own tmux).
LIB="${REPO_ROOT}/tests/lib/assert.sh"
RUNNER="${REPO_ROOT}/tests/run.sh"
SOCKDIR="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"
# ── E-240.1: cleanup survives a mid-suite failure ─────────────────────────
# This is the case that leaked. A fixture that aborts halfway must still tear down.
_fixture() {  # <body> → the path it created, after the fixture has exited
  local body="$1" out; out="$(mktemp)"
  ( source "$LIB"; eval "$body" ) >/dev/null 2>&1
  cat "$out" 2>/dev/null; rm -f "$out"
}
_probe="$(mktemp)"
( source "$LIB"
  d="$(test_tmpdir midfail)"
  printf '%s' "$d" > "$_probe"
  exit 1 ) >/dev/null 2>&1
_leftover="$(cat "$_probe")"; rm -f "$_probe"
assert_status 0 "E-240.01a: the fixture actually created something (non-vacuity)" \
  bash -c "[[ -n '$_leftover' ]]"
assert_status 1 "E-240.01b: a temp dir is removed even when the suite ABORTS midway" \
  test -d "$_leftover"

# A tmux socket, the thing that actually leaked 50 times.
_probe2="$(mktemp)"
( source "$LIB"
  s="$(test_tmux_socket midfail)"
  tmux -L "$s" new-session -d -s x 2>/dev/null
  printf '%s' "$s" > "$_probe2"
  exit 1 ) >/dev/null 2>&1
_sock="$(cat "$_probe2")"; rm -f "$_probe2"
assert_status 0 "E-240.01c: the fixture actually created a socket (non-vacuity)" \
  bash -c "[[ -n '$_sock' ]]"
assert_status 1 "E-240.01d: the tmux SERVER is gone after an aborted suite" \
  bash -c "tmux -L '$_sock' list-sessions >/dev/null 2>&1"
# kill-server leaves the socket FILE; a leftover file is still state the sweep would count.
assert_status 1 "E-240.01e: and the socket FILE is removed too" \
  test -e "${SOCKDIR}/${_sock}"

# ── E-240.2: registration works from a SUBSHELL ───────────────────────────
# Helpers are called as `$(test_tmux_socket …)`, which IS a subshell. The first version of
# register_cleanup used an array and a lazily-installed trap, so both died with that
# subshell and nothing was ever cleaned. Same defect as E-239's baseline cache.
_probe3="$(mktemp)"
( source "$LIB"
  d="$(test_tmpdir subshell)"      # created inside a command substitution
  printf '%s' "$d" > "$_probe3" ) >/dev/null 2>&1
_sub="$(cat "$_probe3")"; rm -f "$_probe3"
assert_status 0 "E-240.02a: the subshell fixture created something (non-vacuity)" \
  bash -c "[[ -n '$_sub' ]]"
assert_status 1 "E-240.02b: cleanup registered INSIDE a subshell still runs" \
  test -d "$_sub"

# ── E-240.2b (E-302): a subshell that SOURCES the library keeps the parent's registry ──
# The fixtures above are `( source "$LIB"; … )` mini-suites. A subshell shares `$$`, and the
# registry was `aios-cleanup-$$`: sourcing truncated the PARENT's registry and the subshell's
# EXIT handler deleted it, so every cleanup this suite had registered before that point was
# lost. Harmless while these rows were their own suite; merged after other sections (E-302),
# harness_isolation leaked 9 temp dirs and tmux sockets under CI (9a91f1f).
_keep="$(test_tmpdir keep)"
( source "$LIB"; true ) >/dev/null 2>&1
assert_status 0 "E-240.02c: the parent's cleanup survives a subshell that sources the library" \
  grep -qF "rm -rf '${_keep}'" "$_CLEANUP_FILE"

# ── E-240.3: names carry entropy, never $$ ────────────────────────────────
# `$$` recycles, and a recycled name attaches to whatever the previous owner left running.
_n1="$( source "$LIB"; test_tmux_socket n )"
_n2="$( source "$LIB"; test_tmux_socket n )"
assert_status 1 "E-240.03a: two sockets in a row are not the same name" \
  bash -c "[[ '$_n1' == '$_n2' ]]"
assert_match "E-240.03b: the name carries the sweepable test prefix" '^aios-test-' "$_n1"
assert_status 1 "E-240.03c: helpers do not use \$\$ for socket names" \
  bash -c "sed -n '/^test_tmux_socket() {/,/^}/p' '$LIB' | grep -q '\\\$\\\$'"

# ── E-240.4: THE SAFETY PROPERTY — the sweep spares foreign state ─────────
# A sweep that can kill the operator's own tmux session is worse than the leak it fixes.
_foreign="e240-not-a-test-socket-$$"
tmux -L "$_foreign" new-session -d -s work 2>/dev/null
_victim="aios-test-victim-$(basename "$(mktemp -u)")"
tmux -L "$_victim" new-session -d -s v 2>/dev/null
assert_status 0 "E-240.04a: both probe servers are up (non-vacuity)" \
  bash -c "tmux -L '$_foreign' has-session -t work 2>/dev/null && tmux -L '$_victim' has-session -t v 2>/dev/null"
bash -c "
  AIOS_TEST_SOCK_PREFIX='aios-test-'; AIOS_TEST_TMP_PREFIX='aios-t-'
  eval \"\$(sed -n '/^_leak_sweep() {/,/^}/p' '$RUNNER')\"
  _leak_sweep 'tmux-server|$_foreign
tmux-server|$_victim'" >/dev/null 2>&1
assert_status 0 "E-240.04b: a FOREIGN tmux server SURVIVES the sweep" \
  bash -c "tmux -L '$_foreign' has-session -t work 2>/dev/null"
assert_status 1 "E-240.04c: a test-prefixed server is swept (non-vacuity)" \
  bash -c "tmux -L '$_victim' list-sessions >/dev/null 2>&1"
tmux -L "$_foreign" kill-server 2>/dev/null || true
rm -f "${SOCKDIR}/${_foreign}" "${SOCKDIR}/${_victim}" 2>/dev/null || true

# ── E-240.5: the runner reports and gates ─────────────────────────────────
assert_status 0 "E-240.05a: the runner snapshots external state" \
  grep -q '_leak_snapshot' "$RUNNER"
assert_status 0 "E-240.05b: it reports LEAKED n <kind> per suite" \
  grep -q 'LEAKED \${_n} \${_kinds}' "$RUNNER"
assert_status 0 "E-240.05c: a leak FAILS the run on CI" \
  bash -c "grep -A3 'LEAK_FAILED' '$RUNNER' | grep -q 'TOTAL_FAIL'"
assert_status 0 "E-240.05d: --sweep is offered locally" \
  grep -q 'tests/run.sh --sweep' "$RUNNER"
assert_status 0 "E-240.05e: AI_OS_TEST_NO_SWEEP=1 disables the check" \
  grep -q 'AI_OS_TEST_NO_SWEEP' "$RUNNER"
# The sweep re-checks the prefix at the kill site as well as at snapshot time. Defence in
# depth on the one branch that can destroy an operator's session.
assert_status 0 "E-240.05f: the sweep re-checks the prefix before killing" \
  bash -c "sed -n '/^_leak_sweep() {/,/^}/p' '$RUNNER' | grep -q 'AIOS_TEST_SOCK_PREFIX}\"\\*'"

# ── E-265: a leak FAILS a local CI run (AI_OS_CI=local) too ─────────────
# Behavioural, not a grep: a copy of the real runner drives one suite that leaks a
# test-prefixed temp dir. Without a CI flag the run passes and offers --sweep; under
# AI_OS_CI=local (what `ai ci run` sets) the same leak fails the run.
_LK="$(test_tmpdir leakrun)"
mkdir -p "${_LK}/tests/suites" "${_LK}/tmp"
cp "$RUNNER" "${_LK}/tests/run.sh"
# E-345: run.sh refuses to start without its fixture-home census and exemptions.
mkdir -p "${_LK}/tests/tools" "${_LK}/tests/fixtures"
cp "${REPO_ROOT}/tests/tools/fixture-home-census.mjs" "${_LK}/tests/tools/"
cp "${REPO_ROOT}/tests/fixtures/fixture-home-exemptions.json" "${_LK}/tests/fixtures/"
cp -R "${REPO_ROOT}/tests/lib" "${_LK}/tests/lib"
cat > "${_LK}/tests/suites/leaky_test.sh" <<'LEAKY'
#!/usr/bin/env bash
mkdir -p "${TMPDIR%/}/${AIOS_TEST_TMP_PREFIX:-aios-t-}leaky-fixture"
echo "SUITE_RESULT PASS=1 FAIL=0 SKIP=0"
LEAKY
_lk_run() {  # <env-assignments...> → "<exit> <output>"
  local out rc
  out="$(env -u CI -u AI_OS_CI -u AI_OS_TEST_NO_SWEEP TMPDIR="${_LK}/tmp" "$@" \
         bash "${_LK}/tests/run.sh" 2>&1)"; rc=$?
  rm -rf "${_LK}/tmp/${AIOS_TEST_TMP_PREFIX}leaky-fixture"
  printf '%s %s' "$rc" "$out"
}
_lk_plain="$(_lk_run AI_OS_CI=)"
assert_contains "E-265.L1: the fixture really leaks (non-vacuity)" "LEAKED external state: 1" "$_lk_plain"
assert_contains "E-265.L2: without a CI flag the leak is reported, the run passes" "0 " "${_lk_plain:0:2}"
_lk_local="$(_lk_run AI_OS_CI=local)"
assert_contains "E-265.L3: under AI_OS_CI=local the leak FAILS the run" "[LEAK_FAILED]" "$_lk_local"
assert_contains "E-265.L4: and the run exits 1" "1 " "${_lk_local:0:2}"
# Removed HERE as well as registered: a later block re-sources the library in a subshell
# with the same $$, which truncates the registry file and would drop this handler.
rm -rf "${_LK}"

# ── E-307 (D-091): every suite has a deadline ────────────────────────────────────────────
# A fixture runner: a copy of the runner drives a suite that hangs past its
# own `# AIOS_SUITE_TIMEOUT=2` header (a child it started hangs too), then a passing suite.
# The hung one is killed WITH its process group, reported and counted FAIL; the run goes on.
_WD="$(test_tmpdir watchdog)"
mkdir -p "${_WD}/tests/suites"
cp -R "${REPO_ROOT}/tests/lib" "${_WD}/tests/lib"
cp "$RUNNER" "${_WD}/tests/run.sh"
# E-345: run.sh refuses to start without its fixture-home census and exemptions.
mkdir -p "${_WD}/tests/tools" "${_WD}/tests/fixtures"
cp "${REPO_ROOT}/tests/tools/fixture-home-census.mjs" "${_WD}/tests/tools/"
cp "${REPO_ROOT}/tests/fixtures/fixture-home-exemptions.json" "${_WD}/tests/fixtures/"
_WD_MARK="wdhang$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
cat > "${_WD}/tests/suites/a_hang_test.sh" <<WDEOF
#!/usr/bin/env bash
# AIOS_SUITE_TIMEOUT=2
bash -c 'exec -a ${_WD_MARK} sleep 100' &   # AIOS_SLEEP_ALLOWED: the hang under test
wait
echo "SUITE_RESULT PASS=1 FAIL=0 SKIP=0"
WDEOF
printf '#!/usr/bin/env bash\necho "SUITE_RESULT PASS=1 FAIL=0 SKIP=0"\n' > "${_WD}/tests/suites/b_after_test.sh"
_wd_t0=$SECONDS
_wd_out="$(env -u CI -u AI_OS_CI -u AI_OS_TEST_NO_SWEEP bash "${_WD}/tests/run.sh" 2>&1)"; _wd_rc=$?
_wd_s=$(( SECONDS - _wd_t0 ))
assert_contains "E-307.W1: the hung suite is reported at its own 2 s budget" "[SUITE_TIMEOUT] a_hang_test.sh after 2s" "$_wd_out"
assert_contains "E-307.W2: …and counted FAIL" "a_hang_test.sh (0 passed, 1 failed)" "$_wd_out"
assert_contains "E-307.W3: the run continues to the next suite" "b_after_test.sh (1 passed)" "$_wd_out"
assert_not_contains "E-307.W4: killing the group leaves nothing behind (no LEAKED line)" "LEAKED" "$_wd_out"
assert_status 1 "E-307.W5: the hung suite's child is gone with it" pgrep -f "$_WD_MARK"
assert_status 0 "E-307.W6: the run fails and ends well before the child's 100 s (${_wd_s}s, rc=${_wd_rc})" \
  test "$_wd_rc" -ne 0 -a "$_wd_s" -lt 30
pkill -f "$_WD_MARK" 2>/dev/null || true
rm -rf "${_WD}"

# ── E-309 (D-091): lanes — a leak is attributed to its lane AND suite ──────────────────
# Extends the fixture-runner blocks above. Three fixture suites: a clean shared one, a
# shared one that leaks a temp dir under ITS lane's prefix, an exclusive one (header). With no
# wall hints every suite weighs the same, so longest-first places them in suite order:
# a_ok → lane 1, b_leak → lane 2; c_excl runs after both lanes.
_LN="$(test_tmpdir lanes)"
mkdir -p "${_LN}/tests/suites"
cp -R "${REPO_ROOT}/tests/lib" "${_LN}/tests/lib"
cp "$RUNNER" "${_LN}/tests/run.sh"
# E-345: run.sh refuses to start without its fixture-home census and exemptions.
mkdir -p "${_LN}/tests/tools" "${_LN}/tests/fixtures"
cp "${REPO_ROOT}/tests/tools/fixture-home-census.mjs" "${_LN}/tests/tools/"
cp "${REPO_ROOT}/tests/fixtures/fixture-home-exemptions.json" "${_LN}/tests/fixtures/"
printf '#!/usr/bin/env bash\necho "SUITE_RESULT PASS=1 FAIL=0 SKIP=0"\n' > "${_LN}/tests/suites/a_ok_test.sh"
cat > "${_LN}/tests/suites/b_leak_test.sh" <<'LNEOF'
#!/usr/bin/env bash
# A real suite takes its prefix from assert.sh, which defaults it; a serial runner exports none.
mkdir -p "${TMPDIR:-/tmp}/${AIOS_TEST_TMP_PREFIX:-aios-t-}leakfixture"
echo "prefix=${AIOS_TEST_TMP_PREFIX:-aios-t-}"
echo "SUITE_RESULT PASS=1 FAIL=0 SKIP=0"
LNEOF
printf '#!/usr/bin/env bash\n# AIOS_EXCLUSIVE: perf\necho "excl prefix=${AIOS_TEST_TMP_PREFIX}"\necho "SUITE_RESULT PASS=1 FAIL=0 SKIP=0"\n' > "${_LN}/tests/suites/c_excl_test.sh"
mkdir -p "${_LN}/home"   # a tiny throwaway HOME: under AI_OS_CI a lane clones HOME
_ln_run() { env -u CI -u AI_OS_TEST_NO_SWEEP HOME="${_LN}/home" AIOS_TEST_WALL_HINTS=/nonexistent AIOS_TEST_FREE_MB=4096 "$@" bash "${_LN}/tests/run.sh" 2>&1; }
_ln_out="$(_ln_run AI_OS_CI=local AIOS_TEST_LANES=2)"; _ln_rc=$?
rm -rf "${TMPDIR:-/tmp}/${AIOS_TEST_TMP_PREFIX}L2-leakfixture" "${TMPDIR:-/tmp}/${AIOS_TEST_TMP_PREFIX}L1-leakfixture"
assert_contains "E-309.L1: the leak names its lane and suite" "(lane 2 b_leak_test.sh)" "$_ln_out"
assert_contains "E-309.L2: …and FAILS under AI_OS_CI=local" "[LEAK_FAILED]" "$_ln_out"
assert_status 0 "E-309.L3: the run exits non-zero (rc=${_ln_rc})" test "$_ln_rc" -ne 0
assert_contains "E-309.L4: a lane owns its prefix" "prefix=${AIOS_TEST_TMP_PREFIX}L2-" "$_ln_out"
# run.sh exports no prefix of its own (a suite takes aios-t- from assert.sh), so "the run's
# own prefix" is: the exclusive suite ran, and no lane's prefix reached it.
assert_contains "E-309.L5: the exclusive suite runs after the lanes…" "excl prefix=" "$_ln_out"
assert_not_contains "E-309.L5b: …under the run's own prefix, not a lane's" "excl prefix=${AIOS_TEST_TMP_PREFIX}L" "$_ln_out"
assert_contains "E-309.L6: the split is printed" "2 shared suite(s) in 2 lanes, then 1 exclusive suite(s) serially" "$_ln_out"
_ln_order="$(printf '%s\n' "$_ln_out" | sed -nE 's/^  [✓✗] ([a-z_]+_test\.sh) .*/\1/p' | tr '\n' ' ')"
assert_contains "E-309.L7: results are printed in suite order, not finish order" "a_ok_test.sh b_leak_test.sh c_excl_test.sh" "$_ln_order"
_ln_one="$(_ln_run AIOS_TEST_LANES=1)"
rm -rf "${TMPDIR:-/tmp}/${AIOS_TEST_TMP_PREFIX}leakfixture"
_ln_two="$(_ln_run AIOS_TEST_LANES=2)"
rm -rf "${TMPDIR:-/tmp}/${AIOS_TEST_TMP_PREFIX}L2-leakfixture" "${TMPDIR:-/tmp}/${AIOS_TEST_TMP_PREFIX}L1-leakfixture"
assert_status 0 "E-309.L8: --lanes 1 and --lanes 2 give the same suite results and totals" \
  test "$(printf '%s\n' "$_ln_one" | grep -E '^  [✓✗] |Total:')" = "$(printf '%s\n' "$_ln_two" | grep -E '^  [✓✗] |Total:')"
_ln_cap="$(_ln_run AIOS_TEST_LANES=3)"; _ln_crc=$?
assert_contains "E-309.L9: a request above the memory cap is refused with the cap on one line" "--lanes 3 refused — memory cap is 2 lane(s) (4096 MB free / 1536 MB per lane)" "$_ln_cap"
assert_status 0 "E-309.L9b: …exit 2 (rc=${_ln_crc})" test "$_ln_crc" -eq 2
# E-332 found it: `ai ci run` passes an EMPTY hint when no log of the project is left, and the
# runner's own fallback search over ~/.ai-os/ci/logs found none with CENSUS lines either — the
# search's failed last grep killed run.sh under set -e with no message, 0 suites run. A missing
# hint is not an error (E-309).
mkdir -p "${_LN}/home/.ai-os/ci/logs"
printf '[ci] repo=/elsewhere\n[ci] result status=PASS\n' > "${_LN}/home/.ai-os/ci/logs/other-project.log"
_ln_nohint="$(env -u CI -u AI_OS_TEST_NO_SWEEP HOME="${_LN}/home" AIOS_TEST_WALL_HINTS= AIOS_TEST_FREE_MB=4096 AIOS_TEST_LANES=2 bash "${_LN}/tests/run.sh" 2>&1)"
rm -rf "${_LN}/home/.ai-os" "${TMPDIR:-/tmp}/${AIOS_TEST_TMP_PREFIX}L2-leakfixture" "${TMPDIR:-/tmp}/${AIOS_TEST_TMP_PREFIX}L1-leakfixture"
assert_contains "E-309.L10: no log with CENSUS lines anywhere → the run still reaches its lanes" "Lanes: 2" "$_ln_nohint"
assert_contains "E-309.L10b: …and runs every suite" "Total: " "$_ln_nohint"

# ── E-312 (D-093): an installer-subject suite's lane follows its measured installer HOME ──
# Extends the lane fixture above: two installer-subject suites and a hints log whose CENSUS_FP
# installer lines give one a harness temp HOME and the other a foreign one.
rm -f "${_LN}/tests/suites/"*_test.sh
for _s in d_own e_foreign f_unmeasured; do
  printf '#!/usr/bin/env bash\n# AIOS_INSTALLER_SUBJECT: fixture\necho "SUITE_RESULT PASS=1 FAIL=0 SKIP=0"\n' > "${_LN}/tests/suites/${_s}_test.sh"
done
printf 'CENSUS_SUITE\td_own_test.sh\t100\t1\t0\t0\t0\nCENSUS_FP\td_own_test.sh\t2\tinstaller\tai init\ttmp\nCENSUS_FP\te_foreign_test.sh\t1\tinstaller\tinstall-ai-os.sh\tforeign:/srv/shared\n' > "${_LN}/hints.log"
_ln_cls="$(env -u CI -u AI_OS_TEST_NO_SWEEP HOME="${_LN}/home" AIOS_TEST_WALL_HINTS="${_LN}/hints.log" AIOS_TEST_FREE_MB=4096 \
  AIOS_TEST_LANES=2 bash "${_LN}/tests/run.sh" 2>&1)"
assert_contains "E-312.H1: a suite whose installer spawns all had a temp HOME shares a lane" "Lane: d_own_test.sh shared" "$_ln_cls"
assert_contains "E-312.H2: a foreign installer HOME keeps it exclusive, with the reason" \
  "Lane: e_foreign_test.sh exclusive — installer HOME foreign:/srv/shared" "$_ln_cls"
assert_contains "E-312.H3: no measured footprint keeps it exclusive, with the reason" \
  "Lane: f_unmeasured_test.sh exclusive — no measured installer footprint" "$_ln_cls"
assert_contains "E-312.H4: the split counts them" "1 shared suite(s) in 2 lanes, then 2 exclusive suite(s) serially" "$_ln_cls"
assert_match "E-312.H5: the memory figure and the per-lane number are on one line" \
  'Memory: 4096 MB available \(AIOS_TEST_FREE_MB\) / 1536 MB per lane \(fallback: no recorded peak_sum_rss_mb\) → cap 2 lane\(s\)' "$_ln_cls"
sed -i.bak '2a\
# AIOS_EXCLUSIVE: installer' "${_LN}/tests/suites/d_own_test.sh" && rm -f "${_LN}/tests/suites/d_own_test.sh.bak"
_ln_cls="$(env -u CI -u AI_OS_TEST_NO_SWEEP HOME="${_LN}/home" AIOS_TEST_WALL_HINTS="${_LN}/hints.log" AIOS_TEST_FREE_MB=4096 \
  AIOS_TEST_LANES=2 bash "${_LN}/tests/run.sh" 2>&1)"
assert_contains "E-312.H6: # AIOS_EXCLUSIVE: installer forces it back" "Lane: d_own_test.sh exclusive — # AIOS_EXCLUSIVE: installer" "$_ln_cls"

# ── E-313 (D-094): the runner samples the CONCURRENT memory of its suites ─────────────────
# Extends the fixture above: one suite holds two IDENTICAL node processes (~150 MB buffer
# each) at once. rusage's largest-process figure (/usr/bin/time — what E-310's peak_rss_mb
# reads) is one of them, so their known total is twice it; the sampled sum must be within 15%
# of that total, and the largest-process figure must hold only one.
rm -f "${_LN}/tests/suites/"*_test.sh
cat > "${_LN}/tests/suites/g_mem_test.sh" <<'MEMEOF'
#!/usr/bin/env bash
# Rewritten every 100 ms: an idle buffer is compressed out of RSS under memory pressure, and
# the "known" total would not be known.
_hold='const b = Buffer.alloc(150 * 1048576, 1); const t = setInterval(() => b.fill(1), 100); setTimeout(() => clearInterval(t), 5000)'
node -e "$_hold" & node -e "$_hold" & wait
echo "SUITE_RESULT PASS=1 FAIL=0 SKIP=0"
MEMEOF
if skip_unless_cmd /usr/bin/time "E-313.M1-M3: the concurrent-memory fixture needs /usr/bin/time"; then
  _tflag="-l"; [[ "$(uname -s)" == "Darwin" ]] || _tflag="-v"
  _ln_mem="$(env -u CI -u AI_OS_TEST_NO_SWEEP HOME="${_LN}/home" AIOS_TEST_WALL_HINTS=/nonexistent \
    /usr/bin/time "$_tflag" -o "${_LN}/rusage.txt" bash "${_LN}/tests/run.sh" 2>&1)"
  _sum_mb="$(printf '%s\n' "$_ln_mem" | sed -nE 's/^\[run\] peak_sum_rss_mb=([0-9]+) .*/\1/p')"
  _max_mb="$(awk '/maximum resident set size/ && $1 ~ /^[0-9]+$/ {print int($1 / 1048576)}
                  /Maximum resident set size \(kbytes\)/ {print int($NF / 1024)}' "${_LN}/rusage.txt" | tail -1)"
  _tot_mb=$(( ${_max_mb:-0} * 2 ))
  echo "  ⓘ E-313: largest process ${_max_mb:-?} MB → known total ${_tot_mb} MB; sampled sum ${_sum_mb:-?} MB"
  assert_status 0 "E-313.M1: the sampled sum is within 15% of the two processes' total (${_sum_mb:-?} MB vs ${_tot_mb} MB)" \
    bash -c "s=${_sum_mb:-0}; t=${_tot_mb}; (( t > 0 && s * 100 >= t * 85 && s * 100 <= t * 115 ))"
  assert_status 0 "E-313.M2: the largest-process figure holds only one of them (${_max_mb:-?} MB < 75% of the sum ${_sum_mb:-?} MB)" \
    bash -c "m=${_max_mb:-0}; s=${_sum_mb:-0}; (( m > 0 && m * 100 < s * 75 ))"
  assert_match "E-313.M3: the line beside the totals names its sample count" '\[run\] peak_sum_rss_mb=[0-9]+ samples=[1-9][0-9]* ' "$_ln_mem"
fi
# The per-lane figure comes from the last record's sum: 2000 MB at 4 lanes × 1.25 = 625 MB;
# a sum that small per lane is floored at 512 MB.
printf '[run] peak_sum_rss_mb=2000 samples=900 sampler_cpu_ms=7000\n[ci] resources lanes=4 peak_rss_mb=281 suite_seconds=870 runner=aios\n' > "${_LN}/rec.log"
_ln_rec="$(env -u CI HOME="${_LN}/home" AIOS_TEST_WALL_HINTS="${_LN}/rec.log" AIOS_TEST_FREE_MB=4096 AIOS_TEST_LANES=2 bash "${_LN}/tests/run.sh" 2>&1)"
assert_contains "E-313.P1: per-lane = last peak_sum_rss_mb / its lanes × 1.25, with the source" \
  "4096 MB available (AIOS_TEST_FREE_MB) / 625 MB per lane (last peak_sum_rss_mb 2000 at 4 lane(s) × 1.25) → cap 6 lane(s)" "$_ln_rec"
printf '[run] peak_sum_rss_mb=800 samples=900 sampler_cpu_ms=7000\n[ci] resources lanes=4 peak_rss_mb=281 suite_seconds=870 runner=aios\n' > "${_LN}/rec.log"
_ln_rec="$(env -u CI HOME="${_LN}/home" AIOS_TEST_WALL_HINTS="${_LN}/rec.log" AIOS_TEST_FREE_MB=4096 AIOS_TEST_LANES=2 bash "${_LN}/tests/run.sh" 2>&1)"
assert_contains "E-313.P2: …floored at 512 MB" "/ 512 MB per lane (last peak_sum_rss_mb 800 at 4 lane(s) × 1.25) → cap 8 lane(s)" "$_ln_rec"
rm -rf "${_LN}"

# ── E-296 (D-085 r3): a perf check that fails under host overload is re-measured ONCE ──
# _host_load is a function, so load is injected by redefining it (no environment variable).
_perf_probe() {  # <load1> <ncpu> <first ms> <retry ms> → the assertion's output
  bash -c '
    source "'"${REPO_ROOT}"'/tests/lib/assert.sh" >/dev/null 2>&1
    _host_load() { printf "%s %s" "'"$1"'" "'"$2"'"; }
    _again() { printf "%s" "'"$4"'"; }
    assert_perf "fixture" "'"$3"'" 100 40 2 10 _again' 2>&1
}
_pp="$(_perf_probe 99 1 500 20)"
assert_contains "E-296.02a: a perf check failing under load1 > ncpu passes on the retry" "on retry" "$_pp"
assert_contains "E-296.02b: …and the log shows both measurements and the load" "first=500ms retry=20ms" "$_pp"
_pp="$(_perf_probe 99 1 500 400)"
assert_contains "E-296.02c: a retry that also fails still FAILS" "then 400ms on retry" "$_pp"
_pp="$(_perf_probe 0 8 500 20)"
assert_not_contains "E-296.02d: without overload there is NO retry (the first measurement decides)" "RETRY" "$_pp"

# ── E-240.6: the previously-leaking suites are converted ──────────────────
# E-302: ai_start_surface_test merged into ai_start_test — the second pair pins that suite's
# E-228 section (its live tmux layer, socket e228) in its new home.
for _ls in "ai_start_test|test_tmux_socket" "ai_start_test (E-228 section)|test_tmux_socket e228"; do
  assert_status 0 "E-240.06: ${_ls%%|*} uses test_tmux_socket" \
    grep -q "${_ls#*|}" "${REPO_ROOT}/tests/suites/ai_start_test.sh"
  assert_status 1 "E-240.06: ${_ls%%|*} no longer names a socket with \$\$" \
    grep -q 'aios-e22[78]-\$\$' "${REPO_ROOT}/tests/suites/ai_start_test.sh"
done

# ── E-240.7: review question #3 is recorded ──────────────────────────────
assert_status 0 "E-240.07a: critic_tests asks what a halfway failure leaves behind" \
  grep -q 'What does this test leave behind when an assertion fails HALFWAY' \
    "${REPO_ROOT}/src/claude/agents/critic_tests.md"
assert_status 0 "E-240.07b: ai-review asks it too" \
  grep -q 'What does this test leave behind when an assertion fails HALFWAY' \
    "${REPO_ROOT}/src/claude/skills/ai-review/SKILL.md"
assert_status 0 "E-240.07c: it insists cleanup is registered BEFORE the state exists" \
  grep -q 'registered before' "${REPO_ROOT}/src/claude/agents/critic_tests.md"


# ── E-241 (D-064 §1): trap chaining — the limitation E-240 could not close ──
# A bare `trap 'cmd' EXIT` REPLACES the handler, so 42 suites silently discarded the
# cleanup registry and only the runner's sweep noticed. `trap` is now shadowed for the EXIT
# form so it CHAINS. This is the acceptance case: a suite that installs its own trap AFTER
# sourcing assert.sh must still self-clean.
# Run the probe as its OWN PROCESS, not `( … )`. Inside a subshell the guard correctly
# passes `trap` through to the builtin (native semantics), so a subshell fixture would test
# the opposite of the real case — a suite is a process, launched as `bash suite.sh`.
_chain_probe="$(mktemp)"; _chain_own="$(mktemp)"; _chain_sh="$(mktemp)"
cat > "$_chain_sh" <<CHAINEOF
source "$LIB"
d="\$(test_tmpdir chain)"; printf '%s' "\$d" > "$_chain_probe"
own="\$(mktemp -d)";       printf '%s' "\$own" > "$_chain_own"
trap "rm -rf '\$own'" EXIT  # standards:allow-raw-trap - fixture data, not an installation
exit 1
CHAINEOF
bash "$_chain_sh" >/dev/null 2>&1
rm -f "$_chain_sh"
_cl="$(cat "$_chain_probe")"; _co="$(cat "$_chain_own")"; rm -f "$_chain_probe" "$_chain_own"
assert_status 0 "E-241.01a: both fixtures created something (non-vacuity)" \
  bash -c "[[ -n '$_cl' && -n '$_co' ]]"
assert_status 1 "E-241.01b: the LIBRARY cleanup still ran despite the suite's own trap" \
  test -d "$_cl"
assert_status 1 "E-241.01c: and the suite's OWN trap ran too (chained, not replaced)" \
  test -d "$_co"

# A `trap … EXIT` inside a SUBSHELL must keep NATIVE semantics — it fires when THAT
# subshell exits, not at the parent's. Redirecting it into the shared registry would defer
# it and change its meaning. The guard uses BASH_SUBSHELL because BASHPID does not exist in
# bash 3.2, so a BASHPID test would behave differently on macOS and on CI — the exact
# environment dependence E-236 exists to remove.
_sub_out="$( ( source "$LIB"; ( trap 'echo SUBSHELL_FIRED' EXIT; true ); echo PARENT_LINE ) 2>&1 )"
assert_contains "E-241.02a: a subshell trap fires at the SUBSHELL's exit" "SUBSHELL_FIRED" "$_sub_out"
assert_status 0 "E-241.02b: and it fires BEFORE the parent continues (native order)" \
  bash -c "[[ \"\$(printf '%s' '$_sub_out' | grep -n SUBSHELL_FIRED | cut -d: -f1)\" -lt \"\$(printf '%s' '$_sub_out' | grep -n PARENT_LINE | cut -d: -f1)\" ]]"
assert_status 0 "E-241.02c: the guard uses BASH_SUBSHELL (bash 3.2 safe)" \
  grep -q 'BASH_SUBSHELL:-0' "$LIB"

assert_status 0 "E-241.03a: on_exit is the documented spelling" grep -q '^on_exit() {' "$LIB"
assert_status 0 "E-241.03b: CLEANUP n handlers is printed" grep -q "CLEANUP %d handlers" "$LIB"
assert_status 0 "E-241.03c: handlers run in their own subshell (one cannot skip the next)" \
  bash -c "sed -n '/^_run_cleanups() {/,/^}/p' '$LIB' | grep -q '( eval'"
assert_status 0 "E-241.03d: AI_OS_TEST_NO_TRAP_CHAIN=1 restores the builtin" \
  grep -q 'AI_OS_TEST_NO_TRAP_CHAIN' "$LIB"
# The library's own installation MUST use `builtin`, or the shadow swallows it and no
# handler is installed at all — which is exactly what happened on the first attempt.
assert_status 0 "E-241.03e: the library installs its handler with builtin trap" \
  grep -q "^builtin trap '_run_cleanups' EXIT" "$LIB"

# Counted with the RULE ITSELF rather than a hand-rolled grep, so the assertion and the
# gate cannot disagree about what counts — the E-232 lesson (one definition, reused).
#
# E-251: the corpus is built by corpus_or_fail, so a scan that reads NO files fails loudly
# instead of reporting "0 raw traps" about nothing. This suite is the reason that matters:
# its whole claim is a zero, and a zero from an empty corpus looks identical to a zero
# earned.
#
# E-250: suppression now lives in validateFile, NOT inside the rule — so a caller that
# invokes RULE_REGISTRY directly, as this one does, must apply `isSuppressed` itself or it
# will count findings the shipped gate does not. That is exactly what happened when the
# suppression moved: this assertion went red against a repo the real checker calls clean.
export REPO_ROOT
export CHECKER_URL="file://${REPO_ROOT}/src/shared/standards-checker.mjs"
# Floor 50: E-302 (D-088) consolidated the bash suites from 146 to 45 by design, so tests/ now
# holds ~58 .sh files (was ~160 under the old floor of 100); 50 still fails an empty or
# half-built corpus.
_trap_corpus="$(cd "$REPO_ROOT" && corpus_or_fail 50 tests -- -name "*.sh")"
_trap_corpus_rc=$?
_TRAP_CORPUS_FILE="$(test_tmpdir e241-corpus)/corpus.txt"
printf '%s\n' "$_trap_corpus" > "$_TRAP_CORPUS_FILE"
assert_status 0 "E-241.04a-pre: the trap corpus was BUILT (a zero over nothing is not a zero)" \
  bash -c "[[ '${_trap_corpus_rc}' -eq 0 ]]"

_raw_traps="$(CORPUS_FILE="$_TRAP_CORPUS_FILE" node --input-type=module -e '
  // THROUGH validateFile, not the raw handler. E-250 moved suppression and by-name
  // exemption OUT of the rule and into validateFile, which is the production path — so a
  // caller that invokes RULE_REGISTRY directly sees findings the shipped gate does not,
  // and a fabricated `{rule_id}` literal also loses the suppression_aliases that make
  // `# standards:allow-raw-trap` (the committed spelling) match. Both bit this assertion
  // the moment the refactor landed: it went red against a repo the real checker calls
  // clean. Reusing the real entry point is the same "one definition" lesson this suite
  // already applies to the rule itself, carried one level up.
  const { loadStandards, validateFile } = await import(process.env.CHECKER_URL);
  const { readFileSync } = await import("fs");
  const RULE = "no_raw_exit_trap_in_tests";
  const rules = loadStandards().rules.filter(r => r.rule_id === RULE);
  if (rules.length !== 1) { console.log("RULE_MISSING"); process.exit(0); }
  const files = readFileSync(process.env.CORPUS_FILE, "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean);
  let n = 0;
  for (const f of files) {
    const rep = validateFile(process.env.REPO_ROOT + "/" + f, rules, { repoRoot: process.env.REPO_ROOT });
    n += (rep.violated_rules || []).filter(v => v.rule_id === RULE).length;
  }
  console.log(n);
' 2>/dev/null)"
assert_contains "E-241.04a: no raw 'trap … EXIT' remains anywhere in tests/ (found=${_raw_traps})" \
  "0" "${_raw_traps:-unknown}"
assert_status 0 "E-241.04b: the standards rule exists" \
  grep -q 'no_raw_exit_trap_in_tests' "${REPO_ROOT}/src/shared/standards-checker.mjs"
assert_status 0 "E-241.04c: and is registered" \
  grep -q 'no_raw_exit_trap_in_tests' "${REPO_ROOT}/src/shared/standards.json"
assert_status 0 "E-241.05a: review question #4 is in critic_tests" \
  grep -q 'called inside a command substitution' "${REPO_ROOT}/src/claude/agents/critic_tests.md"
assert_status 0 "E-241.05b: and in ai-debug" \
  grep -q 'called inside a command substitution' "${REPO_ROOT}/src/shared/skills/ai-debug/SKILL.md"

echo ""

# ── E-264 (from launch_vars_test — E-302, D-071 §4): inherited launch variables ──
# The harness strips the variables `ai pane`, `ai start` and the AI-OS shell export, because the
# hooks rank them above a test's own inputs. Pins: no dead LAUNCH_VARS entries; the strip and its
# AI_OS_TEST_KEEP_LAUNCH_ENV=1 rollback; the harness started from a bound Architect pane.
LV="${REPO_ROOT}/tests/lib/launch-vars.sh"
# ── E-264.1: no dead entries ───────────────────────────────────────────────
echo "  [E-264.1] every LAUNCH_VARS entry is read by hooks/ or src/"
source "$LV"
assert_status 0 "E-264.01a: the list is not empty" test "${#LAUNCH_VARS[@]}" -ge 3
for v in "${LAUNCH_VARS[@]}"; do
  assert_status 0 "E-264.01b: ${v} is referenced by hooks/ or src/" \
    grep -rqF --exclude-dir=node_modules -- "$v" "${REPO_ROOT}/hooks" "${REPO_ROOT}/src"
done

# ── E-264.2: the strip, and its rollback ───────────────────────────────────
echo "  [E-264.2] strip_launch_vars"
for v in "${LAUNCH_VARS[@]}"; do
  assert_status 0 "E-264.02a: ${v} is removed" \
    env "${v}=planted" bash -c "source '$LV'; strip_launch_vars; [[ -z \"\${${v}+x}\" ]]"
  assert_status 0 "E-264.02b: AI_OS_TEST_KEEP_LAUNCH_ENV=1 keeps ${v}" \
    env "${v}=planted" AI_OS_TEST_KEEP_LAUNCH_ENV=1 bash -c "source '$LV'; strip_launch_vars; [[ \"\${${v}}\" == planted ]]"
done
# A strip run in a $(…) subshell would evaporate (review question #4): the function prints
# nothing, so a caller has no reason to capture it — assert that stays true.
assert_status 0 "E-264.02c: the strip returns STATE, not data (prints nothing)" \
  test -z "$(env AI_OS_PANE_ROLE=x bash -c "source '$LV'; strip_launch_vars")"

# ── E-264.3: acceptance — the harness under a hostile launch environment ───
echo "  [E-264.3] tests/run.sh started from a bound Architect pane"
# Local mode explicitly: the outer run may be `ai ci run`. No sweep: the outer run owns it.
_hostile() {
  ( cd "$REPO_ROOT" && env -u AI_OS_CI -u CI AI_OS_PANE_ROLE=architect AI_OS_CALLER_ROLE=architect \
      AIOS_WORKSPACE=/nonexistent AI_OS_TEST_NO_SWEEP=1 bash tests/run.sh "$1" ) 2>&1
}
for s in git_lane_test role_token_test mcp_servers_test; do
  _out="$(_hostile "${s}.sh")"; _rc=$?
  assert_status 0 "E-264.03a: ${s} passes when the harness inherits the Architect pane's exports" \
    test "$_rc" -eq 0
  assert_match "E-264.03b: …and it actually ran (${s})" "SUITE_RESULT PASS=[1-9][0-9]* FAIL=0" "$_out"
  [[ "$_rc" -ne 0 ]] && printf '%s\n' "$_out" | grep -E '✗' | head -5 | sed 's/^/      /'
done

# ── E-264.4: standing review question #7 ───────────────────────────────────
echo "  [E-264.4] review question #7"
for f in src/claude/agents/critic_tests.md src/claude/skills/ai-review/SKILL.md; do
  assert_status 0 "E-264.04a: review question #7 is in ${f}" \
    grep -q 'review question #7 — E-264' "${REPO_ROOT}/${f}"
done
assert_mirror_if_present "E-264.04b: critic_tests mirror matches" \
  "${REPO_ROOT}/src/claude/agents/critic_tests.md" "${REPO_ROOT}/.claude/agents/critic_tests.md"
assert_mirror_if_present "E-264.04c: ai-review mirror matches" \
  "${REPO_ROOT}/src/claude/skills/ai-review/SKILL.md" "${REPO_ROOT}/.claude/skills/ai-review/SKILL.md"

echo ""

# ── E-236 (from skip_accounting_test — E-302, D-061 §4): a SKIP is not a PASS ──
# Weighted toward the accounting, not the printing: a helper that prints "(SKIPPED)" but still
# increments PASS_COUNT would look correct in a log and be worthless in the totals.
# Each probe runs a throwaway suite in a SUBSHELL so this suite's own counters are
# untouched, and reports only the SUITE_RESULT line it produced.
_sa_probe() {  # <body> → "PASS=n FAIL=n SKIP=n"
  ( set +u
    source "$LIB"
    PASS_COUNT=0; FAIL_COUNT=0; SKIP_COUNT=0
    eval "$1"
    assert_summary
  ) 2>/dev/null | grep '^SUITE_RESULT' | sed 's/^SUITE_RESULT //'
}

# ── E-236.1: the counters are three separate things ───────────────────────
assert_contains "E-236.01a: a skip increments SKIP, not PASS" "PASS=0 FAIL=0 SKIP=1" \
  "$(_sa_probe '_skip "optional layer"')"
assert_contains "E-236.01b: a pass still increments PASS" "PASS=1 FAIL=0 SKIP=0" \
  "$(_sa_probe '_pass "something real"')"
assert_contains "E-236.01c: a fail still increments FAIL" "PASS=0 FAIL=1 SKIP=0" \
  "$(_sa_probe '_fail "something broken"')"
assert_contains "E-236.01d: they accumulate independently" "PASS=2 FAIL=1 SKIP=3" \
  "$(_sa_probe '_pass a; _pass b; _fail c; _skip d; _skip e; _skip f')"

# ── E-236.2: skip_unless_cmd ──────────────────────────────────────────────
# A present command must NOT skip — otherwise the helper would silently disable whole
# layers on hosts that can actually run them, which is worse than the bug it fixes.
assert_contains "E-236.02a: a present command does not skip" "PASS=1 FAIL=0 SKIP=0" \
  "$(_sa_probe 'if skip_unless_cmd sh "shell layer"; then _pass "ran"; fi')"
assert_contains "E-236.02b: an absent command skips and does not run the block" \
  "PASS=0 FAIL=0 SKIP=1" \
  "$(_sa_probe 'if skip_unless_cmd definitely-not-a-real-binary-e236 "imaginary layer"; then _pass "ran"; fi')"

# ── E-236.3: skip_unless_env ──────────────────────────────────────────────
assert_contains "E-236.03a: a set variable does not skip" "PASS=1 FAIL=0 SKIP=0" \
  "$(_sa_probe 'E236_SET=1; if skip_unless_env E236_SET "env layer"; then _pass "ran"; fi')"
assert_contains "E-236.03b: an unset variable skips" "PASS=0 FAIL=0 SKIP=1" \
  "$(_sa_probe 'if skip_unless_env E236_DEFINITELY_UNSET "env layer"; then _pass "ran"; fi')"
# An EMPTY variable is not a satisfied requirement. Treating "" as set is how an
# environment check passes while the thing it guards is unusable.
assert_contains "E-236.03c: an EMPTY variable skips too" "PASS=0 FAIL=0 SKIP=1" \
  "$(_sa_probe 'E236_EMPTY=""; if skip_unless_env E236_EMPTY "env layer"; then _pass "ran"; fi')"

# ── E-236.4: the summary line stays backward-compatible ───────────────────
# tests/run.sh greps PASS= and FAIL= independently, so SKIP is APPENDED. A suite that
# predates this change must still parse.
_line="$(_sa_probe '_pass a; _skip b')"
assert_match "E-236.04a: PASS= comes first, unchanged" '^PASS=[0-9]+' "$_line"
assert_match "E-236.04b: FAIL= is still present and parseable" 'FAIL=[0-9]+' "$_line"
assert_match "E-236.04c: SKIP= is appended at the end" 'SKIP=[0-9]+$' "$_line"
assert_status 0 "E-236.04d: the runner totals skips" \
  grep -q 'TOTAL_SKIP' "${REPO_ROOT}/tests/run.sh"
assert_status 0 "E-236.04e: and reports them separately from passes" \
  grep -q 'skipped' "${REPO_ROOT}/tests/run.sh"

# ── E-236.5: file_mtime — the flake that reddened master ──────────────────
# `stat -f %m` means --file-system on GNU, so the BSD-first chain printed a filesystem
# REPORT and exited non-zero, and `$(bsd || gnu)` captured BOTH. The blob carries
# free-block counts, which change as the machine works, so two "mtimes" of an untouched
# file differed. That is what flaked mcp_doc_sync's "--check is read-only" assertion on CI
# (master run 34387218090) while it passed on macOS. Same defect as E-229's `_self_stamp`.
_f="$(mktemp)"; printf 'x' > "$_f"
_m1="$(file_mtime "$_f")"
_m2="$(file_mtime "$_f")"
assert_match "E-236.05a: file_mtime returns ONE numeric token" '^[0-9]+$' "$_m1"
assert_status 0 "E-236.05b: it is a single line" \
  bash -c "[[ \"\$(printf '%s' '$_m1' | grep -c .)\" -eq 1 ]]"
assert_status 0 "E-236.05c: and stable across calls on an untouched file" \
  bash -c "[[ '$_m1' == '$_m2' ]]"
assert_contains "E-236.05d: an unreadable path yields empty, not a partial blob" "" \
  "$(file_mtime /definitely/not/a/real/path/e236)"
rm -f "$_f"

# ── E-236.6: the standing review question is recorded where reviewers look ─
assert_status 0 "E-236.06a: critic_tests asks the environment-dependence question" \
  grep -q "Does this assertion depend on what the running machine happens to have" \
    "${REPO_ROOT}/src/claude/agents/critic_tests.md"
assert_status 0 "E-236.06b: ai-review asks it too" \
  grep -q "Does this assertion depend on what the running machine happens to have" \
    "${REPO_ROOT}/src/claude/skills/ai-review/SKILL.md"
# The question is only useful with the two remedies attached: supply the dependency when it
# is accidental, skip when it is genuinely optional. Naming one without the other is how a
# reviewer reaches for skip_unless on a test that should have supplied a scratch HOME.
assert_status 0 "E-236.06c: it names BOTH remedies, not just skipping" \
  grep -q "SUPPLY what it needs" "${REPO_ROOT}/src/claude/agents/critic_tests.md"

echo ""

# ── E-257 (from telemetry_isolation_test — E-302, D-070 §1): the production instrument must stop recording the suite ──
# AI_TELEMETRY_DB_PATH honoured only in the accepted shape; a fixture emitting with the override
# leaves the live store unchanged; tests/run.sh FAILS a run that wrote a marked live row;
# `telemetry.mjs --reset --backup` moves the store aside; review question #6 is recorded.
# (TI_ROOT is the physical repo path — this section resolved REPO_ROOT with `pwd -P`.)
TI_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
TELEMETRY="${TI_ROOT}/src/shared/telemetry.mjs"
FAKE_HOME="$(test_tmpdir tel-home)"
mkdir -p "${FAKE_HOME}/.ai-os"
LIVE="${FAKE_HOME}/.ai-os/telemetry.sqlite"
_count() {  # <db> [session] → row count (0 when absent)
  [[ -f "$1" ]] || { echo 0; return; }
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const q = process.argv[2]
      ? db.prepare("SELECT count(*) n FROM tool_executions WHERE session_id = ?").get(process.argv[2])
      : db.prepare("SELECT count(*) n FROM tool_executions").get();
    console.log(q.n);' "$1" "${2:-}"
}
_emit() {  # <env…> — one tool row through the CLI the post-tool-use hook uses
  printf '{"tool_name":"Bash","execution_time_ms":3,"status":"SUCCESS"}' \
    | ( cd "$FAKE_HOME" && env "$@" HOME="$FAKE_HOME" node --no-warnings "$TELEMETRY" --record-tool ) 2>/dev/null
}

# Seed the fixture "live" store with one row, through the default path.
_emit -u AI_TELEMETRY_DB_PATH CLAUDE_CODE_SESSION_ID=seed
assert_status 0 "E-257.01a: the default path writes the (fixture) live store" test "$(_count "$LIVE")" = "1"

# ── E-257.1: the override redirects, and only in the accepted shape ──────────
TMPSTORE_DIR="$(test_tmpdir tel-store)"
_emit AI_TELEMETRY_DB_PATH="${TMPSTORE_DIR}/run.sqlite" CLAUDE_CODE_SESSION_ID=fixture
assert_status 0 "E-257.01b: with AI_TELEMETRY_DB_PATH set the live store is unchanged" test "$(_count "$LIVE")" = "1"
assert_status 0 "E-257.01c: …and the row went to the per-run store" test "$(_count "${TMPSTORE_DIR}/run.sqlite")" = "1"
assert_status 0 "E-257.01d: --path prints the override" \
  test "$(AI_TELEMETRY_DB_PATH="${TMPSTORE_DIR}/run.sqlite" node --no-warnings "$TELEMETRY" --path)" = "${TMPSTORE_DIR}/run.sqlite"
# "/x.sqlite": absolute, *.sqlite, directory exists — but outside the temp dir and ~/.ai-os,
# the shape a hostile project env would use to aim writes at a foreign database.
for bad in "relative.sqlite" "${TMPSTORE_DIR}/no-such-dir/x.sqlite" "${TMPSTORE_DIR}/x.db" "/x.sqlite"; do
  _p="$(HOME="$FAKE_HOME" AI_TELEMETRY_DB_PATH="$bad" node --no-warnings "$TELEMETRY" --path 2>/dev/null)"
  assert_status 0 "E-257.01e: a rejected override ('${bad##*/}') falls back to the live store" test "$_p" = "$LIVE"
done
assert_status 1 "E-257.01f: a rejected override never creates its directory" test -e "${TMPSTORE_DIR}/no-such-dir"
assert_contains "E-257.01g: the rejection is announced once on stderr" "telemetry-path-override-rejected" \
  "$(AI_TELEMETRY_DB_PATH=relative.sqlite node --no-warnings "$TELEMETRY" --path 2>&1 >/dev/null)"
assert_status 0 "E-257.01h: tests/lib set a per-suite store for this very suite" \
  bash -c "[[ '${AI_TELEMETRY_DB_PATH:-}' == /*.sqlite ]]"

# ── E-257.2: tests/run.sh fails a run that wrote into the live store ──────────
FIX="$(test_tmpdir tel-suites)"
cat > "${FIX}/clean_test.sh" <<EOF
source "${TI_ROOT}/tests/lib/assert.sh"
printf '{"tool_name":"Bash","execution_time_ms":1,"status":"SUCCESS"}' | node --no-warnings "${TELEMETRY}" --record-tool
_pass "clean fixture emitted through the redirect"
assert_summary
EOF
cat > "${FIX}/leaky_test.sh" <<EOF
source "${TI_ROOT}/tests/lib/assert.sh"
# Deliberately bypasses the redirect: the shape a hand-built env or env -i produces.
printf '{"tool_name":"Bash","execution_time_ms":1,"status":"SUCCESS"}' | env -u AI_TELEMETRY_DB_PATH node --no-warnings "${TELEMETRY}" --record-tool
_pass "leaky fixture wrote to the live store"
assert_summary
EOF
# Local mode explicitly (the outer run may be `ai ci run`, which sets AI_OS_CI=local and
# switches the gate to the growth rule); the CI mode is driven separately below.
_run() { ( cd "$TI_ROOT" && env -u AI_OS_CI -u CI HOME="$FAKE_HOME" AIOS_TEST_SUITES_DIR="$FIX" AI_OS_TEST_NO_SWEEP=1 bash tests/run.sh "$1" ) 2>&1; }
_run_ci() { ( cd "$TI_ROOT" && env -u CI AI_OS_CI=local HOME="$FAKE_HOME" AIOS_TEST_SUITES_DIR="$FIX" AI_OS_TEST_NO_SWEEP=1 bash tests/run.sh "$1" ) 2>&1; }

_clean_out="$(_run 'clean_test.sh')"; _clean_rc=$?
assert_status 0 "E-257.02a: a run whose suites use the redirect passes" test "$_clean_rc" -eq 0
assert_match "E-257.02b: the run prints both live counts" 'Live telemetry: [0-9]+ rows at start, [0-9]+ at end; 0 written by this run' "$_clean_out"
assert_status 0 "E-257.02c: …and the live store did not grow" test "$(_count "$LIVE")" = "1"

_leak_out="$(_run 'leaky_test.sh')"; _leak_rc=$?
assert_status 0 "E-257.02d: a run whose suite wrote to the live store FAILS" test "$_leak_rc" -ne 0
assert_contains "E-257.02e: the failure is named" "[TELEMETRY_LEAKED] 1 row(s)" "$_leak_out"
assert_match "E-257.02f: with both numbers" 'Live telemetry: 1 rows at start, 2 at end; 1 written by this run' "$_leak_out"

# CI mode: the store belongs to a throwaway HOME, so ANY growth is the run's — including a
# row that carries no marker (a spawn with a hand-built env drops the marker too).
cat > "${FIX}/unmarked_test.sh" <<EOF
source "${TI_ROOT}/tests/lib/assert.sh"
printf '{"tool_name":"Bash","execution_time_ms":1,"status":"SUCCESS"}' | env -u AI_TELEMETRY_DB_PATH CLAUDE_CODE_SESSION_ID=someone-else node --no-warnings "${TELEMETRY}" --record-tool
_pass "unmarked fixture wrote to the store"
assert_summary
EOF
_ci_out="$(_run_ci 'unmarked_test.sh')"; _ci_rc=$?
assert_status 0 "E-257.02g: under CI an UNMARKED row in the store still fails the run" test "$_ci_rc" -ne 0
assert_contains "E-257.02h: …named as growth of the throwaway store" "store grew by 1 row(s)" "$_ci_out"
_ci_clean="$(_run_ci 'clean_test.sh')"; _ci_crc=$?
assert_status 0 "E-257.02i: a clean run passes under CI mode too" test "$_ci_crc" -eq 0

# ── E-257.3: the operator's one-time reset ─────────────────────────────────────
_rs="$(HOME="$FAKE_HOME" env -u AI_TELEMETRY_DB_PATH node --no-warnings "$TELEMETRY" --reset 2>&1)"; _rsrc=$?
assert_status 0 "E-257.03a: --reset without --backup refuses (exit 2)" test "$_rsrc" -eq 2
assert_status 0 "E-257.03b: …and leaves the store alone" test "$(_count "$LIVE")" = "3"
_rb="$(HOME="$FAKE_HOME" env -u AI_TELEMETRY_DB_PATH node --no-warnings "$TELEMETRY" --reset --backup 2>&1)"
BAK="${LIVE}.$(date -u +%Y-%m-%d).bak"
assert_status 0 "E-257.03c: the store is moved to a dated backup" test -f "$BAK"
assert_status 0 "E-257.03d: the backup holds every row (WAL folded in)" test "$(_count "$BAK")" = "3"
assert_status 0 "E-257.03e: a fresh, empty store with the schema is in place" test "$(_count "$LIVE")" = "0"
assert_contains "E-257.03f: the operator is told to restart the servers" "Restart the MCP servers" "$_rb"
HOME="$FAKE_HOME" env -u AI_TELEMETRY_DB_PATH node --no-warnings "$TELEMETRY" --reset --backup >/dev/null 2>&1
assert_status 0 "E-257.03g: a second reset the same day never overwrites the first backup" \
  test "$(_count "$BAK")" = "3" -a -f "${LIVE}.$(date -u +%Y-%m-%d).1.bak"

# The reset targets the LIVE store even when the env redirects telemetry (critic_security).
OVR="${TMPSTORE_DIR}/run.sqlite"
_before_ovr="$(_count "$OVR")"
HOME="$FAKE_HOME" AI_TELEMETRY_DB_PATH="$OVR" node --no-warnings "$TELEMETRY" --reset --backup >/dev/null 2>&1
assert_status 0 "E-257.03h: --reset never moves the file AI_TELEMETRY_DB_PATH names" \
  test -f "$OVR" -a "$(_count "$OVR")" = "$_before_ovr" -a ! -e "${OVR}.$(date -u +%Y-%m-%d).bak"

# ── E-257.4: review question #6 ────────────────────────────────────────────────
for f in src/claude/agents/critic_tests.md src/claude/skills/ai-review/SKILL.md; do
  assert_status 0 "E-257.04: review question #6 is in ${f}" grep -q 'review question #6 — E-257' "${TI_ROOT}/${f}"
done
assert_mirror_if_present "E-257.04c: critic_tests mirror matches" \
  "${TI_ROOT}/src/claude/agents/critic_tests.md" "${TI_ROOT}/.claude/agents/critic_tests.md"
assert_mirror_if_present "E-257.04d: ai-review mirror matches" \
  "${TI_ROOT}/src/claude/skills/ai-review/SKILL.md" "${TI_ROOT}/.claude/skills/ai-review/SKILL.md"

# ── E-239 (from perf_budget_test — E-302, D-062 §2): a perf budget measures the CODE, not the host ──
# Both properties are pinned: a REAL regression must still fail, and the SAME code on a slow host
# must pass. A helper that only satisfied one of those would look reasonable and be useless.
# Run assert_perf in a subshell so its own pass/fail never touches this suite's counters,
# and report only the verdict it produced.
_verdict() {  # <env-assignments> <elapsed> <absolute> <baseline> [k] [slack] → PASS|FAIL
  local env_pre="$1"; shift
  ( set +u
    source "${REPO_ROOT}/tests/lib/assert.sh"
    PASS_COUNT=0; FAIL_COUNT=0; SKIP_COUNT=0
    eval "$env_pre"
    assert_perf "probe" "$@" >/dev/null 2>&1
    [[ "$FAIL_COUNT" -eq 0 ]] && echo PASS || echo FAIL )
}

# ── E-239.1: relative mode — the rule's whole purpose ─────────────────────
# 381ms elapsed against a 200ms absolute, on a host whose baseline is 197ms. This is the
# exact incident: it must PASS, because the machine, not the code, is slow.
assert_contains "E-239.01a: the real incident (381ms, baseline 197ms) now PASSES locally" \
  "PASS" "$(_verdict 'CI=' 381 200 197)"
# NON-VACUITY: the same elapsed on a FAST host is a genuine regression and must FAIL.
assert_contains "E-239.01b: 381ms on a fast host (baseline 35ms) still FAILS" \
  "FAIL" "$(_verdict 'CI=' 381 200 35)"
assert_contains "E-239.01c: a 5x-baseline regression FAILS" \
  "FAIL" "$(_verdict 'CI=' 500 200 35)"
assert_contains "E-239.01d: at exactly the limit it PASSES (k*b+slack, inclusive)" \
  "PASS" "$(_verdict 'CI=' 120 200 35)"
assert_contains "E-239.01e: one ms over the limit FAILS" \
  "FAIL" "$(_verdict 'CI=' 121 200 35)"

# ── E-239.2: CI enforces the ABSOLUTE budget ─────────────────────────────
# On known hardware a real regression must not hide behind a generous ratio.
assert_contains "E-239.02a: on CI the absolute governs — 381ms FAILS" \
  "FAIL" "$(_verdict 'CI=true' 381 200 197)"
assert_contains "E-239.02b: on CI, inside the absolute, PASSES" \
  "PASS" "$(_verdict 'CI=true' 150 200 197)"
# The ratio must NOT rescue a CI regression: baseline 197 would give a 444ms relative
# limit, and 381ms would sail through if the mode were chosen wrongly.
assert_contains "E-239.02c: on CI the ratio does not rescue a regression" \
  "FAIL" "$(_verdict 'CI=true' 381 200 197)"

# ── E-239.3: the override ────────────────────────────────────────────────
assert_contains "E-239.03a: AI_OS_PERF_ABSOLUTE=1 forces absolute off CI" \
  "FAIL" "$(_verdict 'CI=; AI_OS_PERF_ABSOLUTE=1' 381 200 197)"
assert_contains "E-239.03b: and it is honoured for a passing case too" \
  "PASS" "$(_verdict 'CI=; AI_OS_PERF_ABSOLUTE=1' 150 200 197)"

# ── E-239.4: k and slack are declarable per assertion ────────────────────
assert_contains "E-239.04a: a tighter k=1 rejects what k=2 allowed" \
  "FAIL" "$(_verdict 'CI=' 120 200 35 1 10)"
assert_contains "E-239.04b: a looser k=4 accepts it" \
  "PASS" "$(_verdict 'CI=' 120 200 35 4 10)"

# ── E-239.5: BOTH numbers are printed, every run ─────────────────────────
# A perf assertion that prints only a verdict cannot distinguish "the code got slower" from
# "the machine is busy" — which is the entire question this task exists to answer.
_out="$( ( source "${REPO_ROOT}/tests/lib/assert.sh"; PASS_COUNT=0; FAIL_COUNT=0
           CI= assert_perf "printed" 59 200 35 ) 2>&1 )"
assert_contains "E-239.05a: elapsed is printed"   "elapsed=59ms"   "$_out"
assert_contains "E-239.05b: baseline is printed"  "baseline=35ms"  "$_out"
assert_contains "E-239.05c: the limit is printed" "limit=120ms"    "$_out"
assert_contains "E-239.05d: the mode is named"    "[relative]"     "$_out"
assert_contains "E-239.05e: the absolute is shown even in relative mode" "absolute=200ms" "$_out"
# On a FAILING run the numbers must still be there — that is when they are needed most.
_outf="$( ( source "${REPO_ROOT}/tests/lib/assert.sh"; PASS_COUNT=0; FAIL_COUNT=0
            CI= assert_perf "printed" 500 200 35 ) 2>&1 )"
assert_contains "E-239.05f: a FAILING assertion prints the baseline too" "baseline 35ms" "$_outf"

# ── E-239.6: baselines are real, cached, and median-based ────────────────
_b1="$(perf_baseline_node)"
_b2="$(perf_baseline_node)"
assert_match "E-239.06a: the node baseline is a number" '^[0-9]+$' "$_b1"
assert_status 0 "E-239.06b: it is cached (identical within a run)" \
  bash -c "[[ '$_b1' == '$_b2' ]]"
assert_status 0 "E-239.06c: and plausible (>0ms — a spawn is never free)" \
  bash -c "[[ '$_b1' -gt 0 ]]"
_h="$(perf_baseline_hook)"
assert_match "E-239.06d: the hook baseline is a number" '^[0-9]+$' "$_h"
# MEDIAN, not mean: one scheduling hiccup must not inflate the baseline and thereby hide a
# real regression behind a generous limit.
assert_status 0 "E-239.06e: the baseline is a MEDIAN, not a mean" \
  grep -q 'runs\[len(runs) // 2\]' "${REPO_ROOT}/tests/lib/assert.sh"

# ── E-265: a local CI run (AI_OS_CI=local) stays host-relative ───────────
# `ai ci run` unsets CI and sets AI_OS_CI=local. This host is not the ubuntu reference
# machine the absolute budgets were calibrated on, so the incident case must still PASS.
assert_contains "E-265.P1: AI_OS_CI=local keeps the relative budget (the 381ms incident passes)" \
  "PASS" "$(_verdict 'CI=; AI_OS_CI=local' 381 200 197)"
assert_contains "E-265.P2: AI_OS_CI=local still fails a genuinely slow path" \
  "FAIL" "$(_verdict 'CI=; AI_OS_CI=local' 500 200 35)"
assert_contains "E-265.P3: AI_OS_PERF_ABSOLUTE=1 still wins under AI_OS_CI=local" \
  "FAIL" "$(_verdict 'CI=; AI_OS_CI=local; AI_OS_PERF_ABSOLUTE=1' 381 200 197)"

# ── E-239.7: the converted assertions, and the checklist ─────────────────
assert_status 0 "E-239.07a: incident_aggregator uses assert_perf" \
  grep -q 'assert_perf "aggregator on a 100-record log"' "${REPO_ROOT}/tests/suites/incident_tracker_test.sh"
assert_status 1 "E-239.07b: and no longer hard-codes a bare 200ms compare" \
  grep -q "ELAPSED_MS' -lt 200" "${REPO_ROOT}/tests/suites/incident_tracker_test.sh"
assert_status 0 "E-239.07c: telemetry uses assert_perf" \
  grep -q 'assert_perf "hook warm-path' "${REPO_ROOT}/tests/suites/telemetry_test.sh"
# Its baseline matches its own instrument (2 node spawns + a hook), not a bare hook —
# comparing against a bare-hook baseline would flatter the assertion by ignoring the clock
# it uses to measure itself.
assert_status 0 "E-239.07d: telemetry's baseline includes its own measurement overhead" \
  grep -q '2 \* \$(perf_baseline_node) + \$(perf_baseline_hook)' "${REPO_ROOT}/tests/suites/telemetry_test.sh"
assert_status 0 "E-239.07e: critic_tests flags an absolute budget with no baseline" \
  grep -q 'Absolute performance budgets without a baseline' "${REPO_ROOT}/src/claude/agents/critic_tests.md"

echo ""

assert_summary
