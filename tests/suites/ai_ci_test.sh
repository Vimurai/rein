#!/usr/bin/env bash
# ai_ci_test.sh — local CI (D-072): `ai ci run` (E-265), the run record and its readers
# (E-266, from ai_ci_record), the push and DONE gates (E-267, from ai_ci_gate) and the
# retired hosted CI (E-268, from actions_decommission) — merged in E-302.
#
# E-265 (local-ci.md §Components 1-2): `ai ci run`.
#
# A local CI run is only worth recording if it measures the COMMIT, not the laptop. The
# assertions are weighted toward the three isolation properties the GitHub runner gave us
# for free and a bare `bash tests/run.sh` does not:
#   * a clean checkout — an uncommitted file is invisible unless --dirty asks for it;
#   * a fresh environment — no CI, TMUX or launch variable leaks in, and HOME is throwaway;
#   * nothing left behind — the worktree, the throwaway HOME and the lock are gone after.
#
# Every run here targets a FIXTURE repository whose tests/run.sh is a stub that prints what
# it can see, under a fake HOME and a private TMPDIR, so the operator's ~/.ai-os/ci is
# never touched by the suite.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
source "${SCRIPT_DIR}/../lib/mcp-client.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AI="${REPO_ROOT}/src/bin/ai"

echo "── Suite: ai_ci_test ───────────────────────────────────────────────"

FAKE_HOME="$(test_tmpdir ci-home)"
tc_fixture_home "$FAKE_HOME"   # E-345 (D-109 r1): the toolchain record the hooks pin
# E-265.03b compares shared/ after every run with this snapshot: the record is the fixture's.
_shared_sig() { ( cd "${FAKE_HOME}/.ai-os/shared" && find . -print0 | sort -z | xargs -0 cksum 2>/dev/null; find . | sort ); }
_SHARED_BEFORE="$(_shared_sig)"
# TMPDIR is spelled through a SYMLINK, as macOS spells it (/var → /private/var). The node
# helpers compare argv[1] with the resolved import.meta.url, so a run whose paths are not
# physical silently skipped every helper CLI — the first real run failed 20 assertions.
RUN_REAL="$(test_tmpdir ci-tmp)"
mkdir -p "${RUN_REAL}/real"
ln -s "${RUN_REAL}/real" "${RUN_REAL}/link"
RUN_TMP="${RUN_REAL}/link"

# _mk_repo <dir> [--no-gitignore] — a committed fixture repo with a probing stub runner.
_mk_repo() {
  local d="$1"
  mkdir -p "${d}/tests"
  cat > "${d}/tests/run.sh" <<'STUB'
#!/usr/bin/env bash
echo "PROBE_HOME=${HOME}"
[[ "$HOME" == "$(cd "$HOME" && pwd -P)" && "$PWD" == "$(pwd -P)" ]] \
  && echo "PROBE_PHYSICAL=yes" || echo "PROBE_PHYSICAL=no"
echo "PROBE_ENV CI=${CI-unset} TMUX=${TMUX-unset} ROLE=${AI_OS_PANE_ROLE-unset} AI_OS_CI=${AI_OS_CI-unset}"
[[ -f UNCOMMITTED.txt ]] && echo "PROBE_UNCOMMITTED=present" || echo "PROBE_UNCOMMITTED=absent"
[[ -f tracked.txt ]] && echo "PROBE_TRACKED=present" || echo "PROBE_TRACKED=absent"
# A run that writes under HOME must land in the throwaway HOME, never the caller's.
mkdir -p "${HOME}/.ai-os" && echo probe > "${HOME}/.ai-os/probe-written"
echo "PROBE_LANES=${AIOS_TEST_LANES-unset} AUTO=${AIOS_TEST_LANES_AUTO-unset} FREE=${AIOS_TEST_FREE_MB-unset}"
echo "PROBE_HINTS=${AIOS_TEST_WALL_HINTS-unset}"
# E-343: what .ai/ci.local.json adds. BAR's VALUE is compared, never printed — the log is read.
echo "PROBE_LOCAL FOO_PORT=${FOO_PORT-unset} BAR=$([[ "${BAR-}" == "s3cr3t-bar-value" ]] && echo match || echo ${BAR+other}${BAR-unset})"
printf 'CENSUS_SUITE\tstub_test.sh\t5\t3\t0\t0\t0\n'
echo "   Lanes: ${AIOS_TEST_LANES:-1}"
echo "   Total: 3 passed, 0 failed"
exit "$(cat stub_exit)"
STUB
  echo 0 > "${d}/stub_exit"
  echo tracked > "${d}/tracked.txt"
  [[ "${2:-}" == "--no-gitignore" ]] || printf '.env\nnode_modules\n' > "${d}/.gitignore"
  git -C "$d" init -q
  git -C "$d" add -A
  git -C "$d" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm fixture
}

# _ci <repo> <args...> — run `ai ci` from the repo under the fake HOME and private TMPDIR,
# with the variables the runner must NOT pass through set in the caller.
_ci() {
  local d="$1"; shift
  # AIOS_TEST_FREE_MB is the operator's own lane-cap override (E-309): a run that set it for
  # THIS suite must not hand it to the fixture runs.
  # TF_BUILD: the host this suite runs on may itself be Azure Pipelines (E-336.01a, D-061 §4);
  # E-386: likewise every hosted-runner marker — the fixture's host is CI=true and nothing else.
  ( cd "$d" && env -u AIOS_TEST_FREE_MB -u TF_BUILD -u GITHUB_ACTIONS -u GITLAB_CI -u BITBUCKET_BUILD_NUMBER \
      HOME="$FAKE_HOME" TMPDIR="${RUN_TMP}/" CI=true TMUX=/tmp/fake,1,0 \
      AI_OS_PANE_ROLE=architect bash "$AI" ci "$@" ) 2>&1
}
# E-386 (D-135 r1): a laptop — no hosted marker at all, CI included.
_ci_local() {
  local d="$1"; shift
  ( cd "$d" && env -u AIOS_TEST_FREE_MB -u TF_BUILD -u GITHUB_ACTIONS -u GITLAB_CI -u BITBUCKET_BUILD_NUMBER -u CI \
      HOME="$FAKE_HOME" TMPDIR="${RUN_TMP}/" bash "$AI" ci "$@" ) 2>&1
}

REPO="$(test_tmpdir ci-repo)"
_mk_repo "$REPO"
SHA="$(git -C "$REPO" rev-parse HEAD)"
echo "uncommitted" > "${REPO}/UNCOMMITTED.txt"
rm -f "${REPO}/tracked.txt"
STATUS_BEFORE="$(git -C "$REPO" status --porcelain)"

# ── E-265.1: a non-dirty run tests the COMMIT ─────────────────────────────
OUT="$(_ci "$REPO" run)"; RC=$?
assert_status 0 "E-265.01a: a passing fixture run exits 0" test "$RC" -eq 0
assert_contains "E-265.01b: an uncommitted file is NOT visible to a non-dirty run" \
  "PROBE_UNCOMMITTED=absent" "$OUT"
assert_contains "E-265.01c: a file deleted only in the working tree is still present" \
  "PROBE_TRACKED=present" "$OUT"
assert_contains "E-265.01d: the summary names PASS and the sha" "ai ci: PASS ${SHA:0:7}" "$OUT"
assert_contains "E-265.01e: the suite step parses the runner's totals" \
  "3 passed, 0 failed, 0 skipped, leaked 0" "$OUT"
assert_contains "E-265.01f: a fixture with no package.json skips deps, not errors" \
  "deps       skip" "$OUT"

# ── E-265.2: the environment is curated ──────────────────────────────────
assert_contains "E-265.02a: CI is not inherited" "CI=unset" "$OUT"
assert_contains "E-265.02b: TMUX is not inherited" "TMUX=unset" "$OUT"
assert_contains "E-265.02c: a launch variable (AI_OS_PANE_ROLE) is not inherited" "ROLE=unset" "$OUT"
assert_contains "E-265.02d: AI_OS_CI=local is set for the run" "AI_OS_CI=local" "$OUT"
assert_contains "E-343.00: without .ai/ci.local.json nothing extra reaches the run" \
  "PROBE_LOCAL FOO_PORT=unset BAR=unset" "$OUT"
PROBE_HOME="$(sed -n 's/^PROBE_HOME=//p' <<< "$OUT" | head -1)"
assert_status 0 "E-265.02e: the run's HOME is not the caller's HOME" \
  test -n "$PROBE_HOME" -a "$PROBE_HOME" != "$FAKE_HOME"
assert_status 1 "E-265.02f: the run's HOME is not inside the caller's HOME either" \
  bash -c "[[ '$PROBE_HOME' == '$FAKE_HOME'/* ]]"

assert_contains "E-265.02g: HOME and the worktree are PHYSICAL paths under a symlinked TMPDIR" \
  "PROBE_PHYSICAL=yes" "$OUT"

# ── E-265.3: the caller's ~/.ai-os is untouched, and nothing is left behind ──
assert_status 1 "E-265.03a: the stub's HOME write did not reach the caller's ~/.ai-os" \
  test -e "${FAKE_HOME}/.ai-os/probe-written"
# shared/ is the fixture's own toolchain record (tc_fixture_home, E-345), written before the run:
# it must still be exactly what the helper wrote — a run that wrote there would show.
assert_status 0 "E-265.03b: the caller's ~/.ai-os holds only the ci/ directory and the fixture's shared/" \
  test "$(command ls -A "${FAKE_HOME}/.ai-os" | tr '\n' ' ')" = "ci shared "
assert_status 0 "E-265.03b2: …and the run left shared/ byte-for-byte as the fixture wrote it" \
  test "$(_shared_sig)" = "$_SHARED_BEFORE"
assert_status 1 "E-265.03c: the throwaway HOME is removed after the run" test -e "$PROBE_HOME"
assert_status 0 "E-265.03d: the worktree is removed from git's list" \
  test "$(git -C "$REPO" worktree list | wc -l | tr -d ' ')" = "1"
assert_status 0 "E-265.03e: no ai-os-ci work dir is left in TMPDIR" \
  bash -c "! compgen -G '${RUN_TMP}/ai-os-ci.*' >/dev/null"
assert_status 0 "E-265.03f: the lock is released" \
  bash -c "! compgen -G '${FAKE_HOME}/.ai-os/ci/run-*.lock' >/dev/null"
assert_status 0 "E-265.03g: the operator's working tree is unchanged by the run" \
  test "$(git -C "$REPO" status --porcelain)" = "$STATUS_BEFORE"

# ── E-265.4: the log ──────────────────────────────────────────────────────
LOG="$(compgen -G "${FAKE_HOME}/.ai-os/ci/logs/${SHA}-*.log" | head -1)"
assert_status 0 "E-265.04a: the log is named <sha>-<started>.log" test -f "$LOG"
assert_status 0 "E-265.04b: the log records the result line" \
  grep -q '^\[ci\] result status=PASS suite=PASS pass=3 fail=0 skip=0 leaked=0' "$LOG"
assert_status 0 "E-265.04c: the log records the toolchain" grep -q '^\[ci\] toolchain node=' "$LOG"
assert_status 0 "E-265.04d: the log records dirty=0" grep -q "sha=${SHA} ref=HEAD dirty=0" "$LOG"

# ── E-265.5: --dirty sees the working tree, and only reads it ────────────
OUT="$(_ci "$REPO" run --dirty)"; RC=$?
assert_status 0 "E-265.05a: a dirty run exits 0" test "$RC" -eq 0
assert_contains "E-265.05b: an uncommitted file IS visible under --dirty" \
  "PROBE_UNCOMMITTED=present" "$OUT"
assert_contains "E-265.05c: a working-tree deletion is honoured under --dirty" \
  "PROBE_TRACKED=absent" "$OUT"
assert_contains "E-265.05d: the worktree step reports the overlay" "dirty: 1 copied, 1 removed" "$OUT"
assert_status 0 "E-265.05e: the working tree is unchanged by a dirty run" \
  test "$(git -C "$REPO" status --porcelain)" = "$STATUS_BEFORE"
assert_status 0 "E-265.05f: the dirty run's log says dirty=1" \
  bash -c "grep -l 'dirty=1' '${FAKE_HOME}'/.ai-os/ci/logs/${SHA}-*.log >/dev/null"

# ── E-265.6: exit codes ───────────────────────────────────────────────────
FREPO="$(test_tmpdir ci-fail)"
_mk_repo "$FREPO"
echo 1 > "${FREPO}/stub_exit"
git -C "$FREPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qam fail
OUT="$(_ci "$FREPO" run)"; RC=$?
assert_status 0 "E-265.06a: a failing suite exits 1 (FAIL, not ERROR)" test "$RC" -eq 1
assert_contains "E-265.06b: and says FAIL" "ai ci: FAIL" "$OUT"

NREPO="$(test_tmpdir ci-noignore)"
_mk_repo "$NREPO" --no-gitignore
OUT="$(_ci "$NREPO" run)"; RC=$?
assert_status 0 "E-265.06c: a repo whose .gitignore misses .env fails the secrets step" test "$RC" -eq 1
assert_contains "E-265.06d: and names it" "secrets    FAIL" "$OUT"

OUT="$(_ci "$REPO" run --ref does-not-exist)"; RC=$?
assert_status 0 "E-265.06e: an unknown ref is ERROR (exit 2)" test "$RC" -eq 2
OUT="$(_ci "$REPO" run --dirty --ref HEAD)"; RC=$?
assert_status 0 "E-265.06f: --dirty with --ref is refused (exit 2)" test "$RC" -eq 2
OUT="$(_ci "$REPO" run --suite-only --unit-only)"; RC=$?
assert_status 0 "E-265.06g: --suite-only with --unit-only is refused (exit 2)" test "$RC" -eq 2
NOGIT="$(test_tmpdir ci-nogit)"
OUT="$(_ci "$NOGIT" run)"; RC=$?
assert_status 0 "E-265.06h: outside a git repository is ERROR (exit 2)" test "$RC" -eq 2
OUT="$(_ci "$REPO" frobnicate)"; RC=$?
assert_status 0 "E-265.06i: an unknown subcommand exits 2" test "$RC" -eq 2

# ── E-265.7: one run at a time per project ───────────────────────────────
KEY="$(printf '%s' "$(git -C "$REPO" rev-parse --show-toplevel)" | cksum | awk '{print $1}')"
LOCK="${FAKE_HOME}/.ai-os/ci/run-${KEY}.lock"
HOLDER="$(test_bg sleep 60)"   # AIOS_SLEEP_ALLOWED: a live stand-in process holding the lock, not a wait
mkdir -p "$LOCK" && echo "$HOLDER" > "${LOCK}/pid"
OUT="$(_ci "$REPO" run)"; RC=$?
assert_status 0 "E-265.07a: a live lock refuses a second run with exit 2" test "$RC" -eq 2
assert_contains "E-265.07b: and names the holder" "another run is in progress for this project (pid ${HOLDER}" "$OUT"
assert_status 0 "E-265.07c: the refused run does not remove the holder's lock" test -f "${LOCK}/pid"
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
# A lock whose owner is dead is stale and must not wedge CI forever.
echo 999999 > "${LOCK}/pid"
OUT="$(_ci "$REPO" run --suite-only)"; RC=$?
assert_status 0 "E-265.07d: a stale lock (dead owner) is reclaimed" test "$RC" -eq 0
assert_status 1 "E-265.07e: and released afterwards" test -e "$LOCK"

# ── E-265.8: --keep retains the work dir for debugging ───────────────────
OUT="$(_ci "$REPO" run --keep)"; RC=$?
KEPT="$(sed -nE 's/^ai ci: kept ([^ ]+) \(--keep\).*/\1/p' <<< "$OUT")"
assert_status 0 "E-265.08a: --keep reports the kept directory" test -n "$KEPT"
assert_status 0 "E-265.08b: and the worktree is still there" test -f "${KEPT}/wt/tests/run.sh"
git -C "$REPO" worktree remove --force "${KEPT}/wt" >/dev/null 2>&1
rm -rf "$KEPT"

# ── E-265.9: the runner's shape ──────────────────────────────────────────
assert_status 0 "E-265.09a: steps run under env -i (isolation by construction)" \
  grep -q 'env -i "\${CI_ENV\[@\]}"' "$AI"
assert_status 0 "E-265.09b: the suite runs under /bin/bash, the shell users have" \
  grep -q '/bin/bash tests/run.sh' "$AI"
assert_status 0 "E-265.09c: the caller's ~/.ai-os is stripped from PATH" \
  grep -q '_ci_clean_path' "$AI"
assert_status 0 "E-265.09d: ai --help lists ai ci run" \
  bash -c "HOME='$FAKE_HOME' bash '$AI' --help | grep -q 'ai ci run'"
assert_status 0 "E-265.09e: DEVOPS.md carries the ci_gate entry" \
  grep -q 'DEVOPS-007 — Local CI runner' "${REPO_ROOT}/.ai/DEVOPS.md"

# ── E-309 (D-091): --lanes reaches the runner; the wall hints are this project's ──
# Extends the E-265.2 environment block: the stub prints the four lane variables it sees.
LREPO="$(test_tmpdir ci-lanes)"
_mk_repo "$LREPO"
_cores="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 2)"
_want=$(( _cores / 2 )); (( _want > 4 )) && _want=4; (( _want < 1 )) && _want=1
# A NEWER log from another project, with census lines, must not be this run's hints.
mkdir -p "${FAKE_HOME}/.ai-os/ci/logs"
_foreign="${FAKE_HOME}/.ai-os/ci/logs/ffffffffffffffffffffffffffffffffffffffff-29991231T000000Z.log"
printf '[ci] repo=/elsewhere/project\nCENSUS_SUITE\tother_test.sh\t9\t1\t0\t0\t0\n' > "$_foreign"
OUT="$(_ci_local "$LREPO" run)"
assert_contains "E-309.C1: the default is min(4, cores/2) on a laptop, marked auto (clamped, not refused)" \
  "PROBE_LANES=${_want} AUTO=1 FREE=unset" "$OUT"
assert_contains "E-309.C2: no log of this project yet → no hints (another project's log is skipped)" \
  "PROBE_HINTS=" "$OUT"
assert_not_contains "E-309.C2b: …not the foreign log" "PROBE_HINTS=${_foreign}" "$OUT"
# The NEWEST log: fixture repos committed in the same second share a sha with the ones above.
LLOG1="$(command ls -1t "${FAKE_HOME}/.ai-os/ci/logs/$(git -C "$LREPO" rev-parse HEAD)"-*.log | head -1)"
assert_status 0 "E-309.C3: the log records the lane count the runner used" grep -q "^\[ci\] resources lanes=${_want} " "$LLOG1"
# E-310 (D-091): extends C3 — what the suite step spent is in the log and in the row.
# E-386: extends R1 — the serial tail ("-": the stub prints no exclusive phase) and the host class.
assert_status 0 "E-310.R1: peak RSS is measured (an integer > 0 MB) on this host's /usr/bin/time" \
  grep -qE '^\[ci\] resources lanes=[0-9]+ peak_rss_mb=[1-9][0-9]* suite_seconds=[0-9]+ exclusive_seconds=- host=local runner=aios$' "$LLOG1"

touch "$_foreign"   # still the newest
# A second COMMIT: a log is named <sha>-<second>, so the same sha in the same second would
# overwrite LLOG1 (a real run takes minutes).
echo two > "${LREPO}/tracked.txt"
git -C "$LREPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qam two
mkdir -p "${LREPO}/.ai"
OUT="$(cd "$LREPO" && HOME="$FAKE_HOME" TMPDIR="${RUN_TMP}/" AIOS_TEST_FREE_MB=8192 bash "$AI" ci run --lanes 3 2>&1)"
# E-312 (D-093) reverses E-309's pass-through: no operator opt-out of the memory cap.
assert_contains "E-309.C4: an explicit --lanes is passed as asked, not auto; a caller's FREE_MB does NOT reach it" \
  "PROBE_LANES=3 AUTO=0 FREE=unset" "$OUT"
assert_contains "E-309.C5: the hints are this project's newest census log" "PROBE_HINTS=${LLOG1}" "$OUT"
# An .ai/ (untracked) makes the runs below RECORDED, so the row can be read back.
_st="$(cd "$LREPO" && HOME="$FAKE_HOME" bash "$AI" ci status 2>&1)"
assert_match "E-310.R2: ai ci status prints lanes, peak RSS, suite seconds and the runner" \
  "spent: +lanes 3, peak RSS [1-9][0-9]* MB \(largest process\), - \(concurrent sum\), suite [0-9]+s, runner aios" "$_st"
assert_contains "E-310.R3: …and the slowest suites, from the census rows" "slowest:  stub 0s" "$_st"
OUT="$(_ci "$LREPO" run --lanes 0)"; RC=$?
assert_status 0 "E-309.C6: --lanes 0 is refused (rc=${RC})" test "$RC" -eq 2
assert_contains "E-309.C6b: …saying why" "--lanes needs a positive integer" "$OUT"
rm -f "$_foreign"
# E-386 (D-135 r1): extends C1 — a hosted runner (its marker, else CI=true) uses every core.
echo hosted > "${LREPO}/tracked.txt"
git -C "$LREPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qam hosted
OUT="$(_ci "$LREPO" run)"
assert_contains "E-386.H1: CI=true alone is a hosted runner — every core, still auto (the memory cap clamps it)" \
  "PROBE_LANES=${_cores} AUTO=1 FREE=unset" "$OUT"
LLOGH="$(command ls -1t "${FAKE_HOME}/.ai-os/ci/logs/$(git -C "$LREPO" rev-parse HEAD)"-*.log | head -1)"
assert_status 0 "E-386.H2: …and the log names the host class hosted:ci" grep -qE '^\[ci\] resources .* host=hosted:ci runner=' "$LLOGH"
echo github > "${LREPO}/tracked.txt"
git -C "$LREPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qam github
OUT="$(cd "$LREPO" && env -u CI -u TF_BUILD HOME="$FAKE_HOME" TMPDIR="${RUN_TMP}/" GITHUB_ACTIONS=true bash "$AI" ci run 2>&1)"
assert_contains "E-386.H3: a GitHub runner's own marker, without CI=true, is hosted too" "PROBE_LANES=${_cores} AUTO=1" "$OUT"
LLOGH="$(command ls -1t "${FAKE_HOME}/.ai-os/ci/logs/$(git -C "$LREPO" rev-parse HEAD)"-*.log | head -1)"
assert_status 0 "E-386.H4: …named hosted:github" grep -qE '^\[ci\] resources .* host=hosted:github runner=' "$LLOGH"

echo ""
# ── E-343 (D-108 r9): the per-machine env allow-list, .ai/ci.local.json ──
# An AI-OS project (tracked .ai/) whose .gitignore covers the file, as `ai sync` leaves it.
EREPO="$(test_tmpdir ci-localenv)"
_mk_repo "$EREPO"
mkdir -p "${EREPO}/.ai"; echo keep > "${EREPO}/.ai/keep"
printf '.env\nnode_modules\n.ai/ci.local.json\n' > "${EREPO}/.gitignore"
git -C "$EREPO" add -A; git -C "$EREPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm ai
_eci() { ( cd "$EREPO" && env -u AIOS_TEST_FREE_MB -u TF_BUILD HOME="$FAKE_HOME" TMPDIR="${RUN_TMP}/" "$@" bash "$AI" ci run ) 2>&1; }
_wtcount() { git -C "$EREPO" worktree list | wc -l | tr -d ' '; }

printf '{"env":["FOO_PORT=3101","BAR"]}\n' > "${EREPO}/.ai/ci.local.json"
OUT="$(_eci BAR=s3cr3t-bar-value)"; RC=$?
assert_status 0 "E-343.01a: a run with the allow-list passes" test "$RC" -eq 0
assert_contains "E-343.01b: NAME=value reaches tests/run.sh under env -i as a literal" "FOO_PORT=3101" "$OUT"
assert_contains "E-343.01c: a bare NAME passes the invoking shell's value through" "BAR=match" "$OUT"
assert_contains "E-343.01d: the env step names what was added" "AI_OS_CI=local +FOO_PORT +BAR" "$OUT"
_elog="$(command ls -t "${FAKE_HOME}/.ai-os/ci/logs/"*.log | head -1)"
assert_status 1 "E-343.01e: BAR's value is never written to the log" grep -q 's3cr3t-bar-value' "$_elog"
assert_status 0 "E-343.01f: …nor to the file" bash -c "! grep -q 's3cr3t-bar-value' '${EREPO}/.ai/ci.local.json'"

OUT="$(_eci env -u BAR)"
assert_contains "E-343.02a: an unset bare NAME is skipped with a note" "(BAR unset in this shell — skipped)" "$OUT"
assert_contains "E-343.02b: and does not reach the run" "BAR=unset" "$OUT"

for _bad in '{"env":["HOME=/x"]}|HOME' '{"env":["AI_OS_CI=hosted"]}|AI_OS_CI' '{"env":["npm_config_cache"]}|npm_config_cache' \
            '{"env":["PLAYWRIGHT_BROWSERS_PATH=/x"]}|PLAYWRIGHT_BROWSERS_PATH' '{"env":["AIOS_WORKSPACE"]}|AIOS_WORKSPACE'; do
  printf '%s\n' "${_bad%|*}" > "${EREPO}/.ai/ci.local.json"
  OUT="$(_eci)"; RC=$?
  assert_status 0 "E-343.03a: ${_bad##*|} is reserved — the run is ERROR (exit 2)" test "$RC" -eq 2
  assert_contains "E-343.03b: …naming it" "[CI_ENV_RESERVED] ${_bad##*|}" "$OUT"
  assert_not_contains "E-343.03c: …before the worktree is created" "worktree   ok" "$OUT"
done
assert_status 0 "E-343.03d: no worktree was left registered" test "$(_wtcount)" = "1"

printf '{"env": [' > "${EREPO}/.ai/ci.local.json"
OUT="$(_eci)"; RC=$?
assert_status 0 "E-343.04a: malformed JSON is ERROR" test "$RC" -eq 2
assert_contains "E-343.04b: …with the parse reason" "is not valid JSON" "$OUT"
printf '{"env": "FOO=1"}\n' > "${EREPO}/.ai/ci.local.json"
OUT="$(_eci)"; RC=$?
assert_status 0 "E-343.04c: a non-array env is ERROR" test "$RC" -eq 2
assert_contains "E-343.04d: …saying what it must be" '"env" must be an array' "$OUT"
rm -f "${EREPO}/.ai/ci.local.json"

# The secrets step: an AI-OS project whose .gitignore misses the file FAILs; a repo without .ai/
# (REPO above) is not asked about it.
printf '.env\nnode_modules\n' > "${EREPO}/.gitignore"
git -C "$EREPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qam "drop the line"
OUT="$(_eci)"; RC=$?
assert_status 0 "E-343.05a: an AI-OS project not ignoring .ai/ci.local.json fails the secrets step" test "$RC" -eq 1
assert_contains "E-343.05b: …and names the file" "must cover .env, node_modules and .ai/ci.local.json" "$OUT"

# The reserved names carry every E-264 launch variable; adding one there without here fails.
source "${REPO_ROOT}/tests/lib/launch-vars.sh"
_reserved="$(sed -n 's/^CI_ENV_RESERVED_NAMES="\(.*\)"$/\1/p' "$AI")"
for _lv in "${LAUNCH_VARS[@]}"; do
  assert_contains "E-343.06: launch variable ${_lv} is reserved for ai ci run" " ${_lv} " " ${_reserved} "
done

echo ""
# ── E-336 (D-103): under Azure Pipelines the run names its log directory for the wrapper ──
# A task input cannot expand $HOME, so azure-pipelines.yml's artefact step reads
# $(AI_OS_CI_LOG_DIR); TF_BUILD=True is Azure's marker. Extends E-265.1's fixture run.
assert_not_contains "E-336.01a: outside Azure no ##vso line is printed" "##vso[" "$(_ci "$REPO" run)"
_az="$( cd "$REPO" && env -u AIOS_TEST_FREE_MB HOME="$FAKE_HOME" TMPDIR="${RUN_TMP}/" TF_BUILD=True bash "$AI" ci run 2>&1 )"
assert_contains "E-336.01b: under Azure the run sets AI_OS_CI_LOG_DIR to its log directory" \
  "##vso[task.setvariable variable=AI_OS_CI_LOG_DIR]${FAKE_HOME}/.ai-os/ci/logs" "$_az"


# ── E-266 (from ai_ci_record — E-302): the run record ──
# E-266 (D-072, local-ci.md §Components 3-4): the run record.
#
# From D-072 on, "CI green" is a fact in state.sqlite, not a badge: a NON-DIRTY ci_runs
# row with status PASS for the commit. This suite drives the real `ai ci run` against a
# fixture repo and then reads the record back through every reader — `ai ci status`
# (both forms, all four outcomes), `ai ci list`, `ai ci log [--failed]`, the `ai doctor`
# line and the get_ci_status MCP tool — so a reader that disagrees with the writer fails
# here rather than at a gate.
#
# The table, parser, verdict rules and retention are unit-tested in
# tests/unit/ci-runs.test.mjs; this suite is the end-to-end layer.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AI="${REPO_ROOT}/src/bin/ai"
SYNC_SERVER="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"


FAKE_HOME="$(test_tmpdir cirec-home)"
tc_fixture_home "$FAKE_HOME"   # E-345 (D-109 r1): the toolchain record the hooks pin
RUN_TMP="$(test_tmpdir cirec-tmp)"
REPO="$(test_tmpdir cirec-repo)"

_commit() { git -C "$REPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qam "$1"; }
_ci() { ( cd "$REPO" && HOME="$FAKE_HOME" TMPDIR="${RUN_TMP}/" bash "$AI" ci "$@" ) 2>&1; }
_sql() { python3 - "$REPO/.ai/state.sqlite" "$1" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
for row in con.execute(sys.argv[2]):
    print("|".join("" if v is None else str(v) for v in row))
PY
}

mkdir -p "${REPO}/tests" "${REPO}/.ai"
cat > "${REPO}/tests/run.sh" <<'STUB'
#!/usr/bin/env bash
echo "── Suite: stub_test ──"
if [[ "$(cat stub_exit)" != 0 ]]; then
  echo "  ✗ stub assertion that fails on purpose"
  echo "SUITE_RESULT PASS=2 FAIL=1 SKIP=0"
  echo "━━ Results ━━"
  echo "  ✗ stub_test.sh (2 passed, 1 failed)"
  echo "   Total: 2 passed, 1 failed"
  exit 1
fi
echo "  ✓ stub assertion"
echo "SUITE_RESULT PASS=3 FAIL=0 SKIP=1"
echo "━━ Results ━━"
echo "   Total: 3 passed, 0 failed, 1 skipped"
STUB
echo 0 > "${REPO}/stub_exit"
printf '.env\nnode_modules\n.ai/\n' > "${REPO}/.gitignore"
git -C "$REPO" init -q -b main
git -C "$REPO" add -A
_commit "green"
SHA_PASS="$(git -C "$REPO" rev-parse HEAD)"

# ── E-266.1: a run writes its row ─────────────────────────────────────────
OUT="$(_ci run)"; RC=$?
assert_status 0 "E-266.01a: the fixture run passes" test "$RC" -eq 0
assert_not_contains "E-266.01b: the run did not warn about recording" "not recorded" "$OUT"
ROW="$(_sql "SELECT sha,ref,branch,dirty,status,suite_pass,suite_fail,suite_skip,leaked,unit_status,secrets_status FROM ci_runs")"
assert_contains "E-266.01c: the row carries the run's facts" \
  "${SHA_PASS}|HEAD|main|0|PASS|3|0|1|0|SKIPPED|PASS" "$ROW"
NULLS="$(_sql "SELECT (started_at IS NULL)+(finished_at IS NULL)+(duration_ms IS NULL)+(node_version IS NULL)+(bash_version IS NULL)+(os IS NULL)+(log_path IS NULL) FROM ci_runs")"
assert_status 0 "E-266.01d: timing, toolchain and log path are populated" test "$NULLS" = "0"
LOGP="$(_sql "SELECT log_path FROM ci_runs")"
assert_status 0 "E-266.01e: log_path points at the kept log" test -f "$LOGP"
assert_status 0 "E-266.01f: started_at is ISO-8601 T-form" \
  bash -c "[[ '$(_sql "SELECT started_at FROM ci_runs")' =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]]"

# ── E-266.2: status — PASS ────────────────────────────────────────────────
OUT="$(_ci status)"; RC=$?
assert_status 0 "E-266.02a: status on a green HEAD exits 0" test "$RC" -eq 0
assert_contains "E-266.02b: and names PASS and the sha" "local CI: PASS ${SHA_PASS:0:7}" "$OUT"
OUT="$(_ci status --short)"; RC=$?
assert_status 0 "E-266.02c: --short exits 0 too" test "$RC" -eq 0
assert_match "E-266.02d: --short is one line in the injected format" \
  "^PASS ${SHA_PASS:0:7} [0-9]+[smhd] ago \(suite 3/0/1, unit SKIPPED, leaked 0\)$" "$OUT"

# ── E-266.3: status — FAIL ────────────────────────────────────────────────
echo 1 > "${REPO}/stub_exit"; _commit "red"
SHA_FAIL="$(git -C "$REPO" rev-parse HEAD)"
_ci run >/dev/null
OUT="$(_ci status --short)"; RC=$?
assert_status 0 "E-266.03a: status on a red HEAD exits 1" test "$RC" -eq 1
assert_match "E-266.03b: --short says FAIL" "^FAIL ${SHA_FAIL:0:7} " "$OUT"
OUT="$(_ci status --ref "$SHA_PASS" --short)"; RC=$?
assert_status 0 "E-266.03c: --ref reads another commit's row (the green one)" test "$RC" -eq 0
OUT="$(_ci status "${SHA_PASS:0:7}" --short)"; RC=$?
assert_status 0 "E-328.03d: status <sha> (positional) reads that commit's row" test "$RC" -eq 0
assert_match "E-328.03e: and names it" "^PASS ${SHA_PASS:0:7} " "$OUT"

# ── E-266.4: log and log --failed ────────────────────────────────────────
OUT="$(_ci log --failed)"; RC=$?
assert_status 0 "E-266.04a: log --failed exits 0" test "$RC" -eq 0
assert_contains "E-266.04b: it shows the failing assertion" "stub assertion that fails on purpose" "$OUT"
assert_contains "E-266.04c: and the failing suite in the summary" "stub_test.sh (2 passed, 1 failed)" "$OUT"
assert_not_contains "E-266.04d: and not the full log" "[ci] toolchain" "$OUT"
OUT="$(_ci log "$SHA_PASS")"; RC=$?
assert_contains "E-266.04e: log <sha> prints that run's whole log" "[ci] sha=${SHA_PASS}" "$OUT"

# ── E-266.5: status — dirty only ─────────────────────────────────────────
echo 0 > "${REPO}/stub_exit"; _commit "green again"
SHA_DIRTY="$(git -C "$REPO" rev-parse HEAD)"
echo "scratch" > "${REPO}/scratch.txt"
_ci run --dirty >/dev/null
OUT="$(_ci status --short)"; RC=$?
assert_status 0 "E-266.05a: a dirty-only commit exits 2 (no certifying run)" test "$RC" -eq 2
assert_match "E-266.05b: --short says DIRTY and why it does not count" \
  "^DIRTY ${SHA_DIRTY:0:7} .*not a certification; run: ai ci run$" "$OUT"
assert_status 0 "E-266.05c: the dirty row is marked dirty=1" \
  test "$(_sql "SELECT dirty FROM ci_runs WHERE sha='${SHA_DIRTY}'")" = "1"
rm -f "${REPO}/scratch.txt"

# ── E-266.6: status — no row ─────────────────────────────────────────────
echo "more" >> "${REPO}/stub_exit.note"; git -C "$REPO" add -A; _commit "untested"
SHA_NONE="$(git -C "$REPO" rev-parse HEAD)"
OUT="$(_ci status --short)"; RC=$?
assert_status 0 "E-266.06a: an untested commit exits 2" test "$RC" -eq 2
assert_contains "E-266.06b: --short says NONE and what to run" \
  "NONE ${SHA_NONE:0:7} — no local CI run; run: ai ci run" "$OUT"
OUT="$(_ci log)"; RC=$?
assert_status 0 "E-266.06c: log for an untested commit exits 2" test "$RC" -eq 2
OUT="$(_ci status --ref nope)"; RC=$?
assert_status 0 "E-266.06d: status --ref <unknown> exits 2" test "$RC" -eq 2

# ── E-266.7: list ────────────────────────────────────────────────────────
OUT="$(_ci list)"; RC=$?
assert_status 0 "E-266.07a: list exits 0" test "$RC" -eq 0
assert_status 0 "E-266.07b: list shows the three recorded runs" \
  test "$(printf '%s\n' "$OUT" | grep -cE '^(PASS|FAIL|ERROR|SKIPPED) ')" = "3"
assert_match "E-266.07c: newest first (the dirty run)" "^PASS    ${SHA_DIRTY:0:7} dirty" "$(printf '%s\n' "$OUT" | head -1)"
OUT="$(_ci list -n 1)"
assert_status 0 "E-266.07d: -n limits the rows" test "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')" = "1"
OUT="$(_ci list -n x)"; RC=$?
assert_status 0 "E-266.07e: -n with a non-number exits 2" test "$RC" -eq 2

# ── E-266.8: doctor line, both branches ──────────────────────────────────
_doctor_line() { ( cd "$REPO" && HOME="$FAKE_HOME" bash "$AI" doctor 2>&1 ) | grep 'local CI:' | head -1; }
OUT="$(_doctor_line)"
assert_contains "E-266.08a: doctor reports ✗ with the command for an untested HEAD" \
  "✗ local CI: no run for HEAD ${SHA_NONE:0:7} — run: ai ci run" "$OUT"
git -C "$REPO" checkout -q "$SHA_PASS"
OUT="$(_doctor_line)"
assert_match "E-266.08b: doctor reports ✓ for a green HEAD" "✓ local CI: HEAD ${SHA_PASS:0:7} PASS [0-9]+[smhd] ago" "$OUT"
git -C "$REPO" checkout -q "$SHA_FAIL"
OUT="$(_doctor_line)"
assert_contains "E-266.08c: doctor points a red HEAD at log --failed" "run: ai ci log --failed" "$OUT"
git -C "$REPO" checkout -q main

# ── E-266.9: get_ci_status (task-synchronizer-mcp) ───────────────────────
_mcp() { ( cd "$REPO" && mcp_call_tool "$SYNC_SERVER" get_ci_status "$1" ) | python3 -c '
import json,sys
d=json.load(sys.stdin)
t=(d.get("content") or [{}])[0].get("text","{}")
try: j=json.loads(t)
except Exception: print("UNPARSEABLE", t); sys.exit()
print(j.get("status"), j.get("verdict"), j.get("sha"), j.get("dirty"))'; }
assert_contains "E-266.09a: get_ci_status on the untested HEAD is NONE" "NONE None ${SHA_NONE}" "$(_mcp '{}')"
assert_contains "E-266.09b: get_ci_status by sha returns the PASS row" \
  "PASS PASS ${SHA_PASS} False" "$(_mcp "{\"sha\":\"${SHA_PASS}\"}")"
assert_contains "E-266.09c: an abbreviated sha resolves" \
  "FAIL FAIL ${SHA_FAIL} False" "$(_mcp "{\"sha\":\"${SHA_FAIL:0:7}\"}")"
assert_contains "E-266.09d: a dirty-only commit reports verdict DIRTY" \
  "PASS DIRTY ${SHA_DIRTY} True" "$(_mcp "{\"sha\":\"${SHA_DIRTY}\"}")"
assert_contains "E-266.09e: get_ci_status is advertised" "get_ci_status" "$(mcp_list_tools "$SYNC_SERVER")"

# ── E-266.10: registration and the not-recorded path ─────────────────────
assert_status 0 "E-266.10a: registry allows get_ci_status" \
  grep -q '"get_ci_status"' "${REPO_ROOT}/src/config/registry.json"
# E-290: .claude/settings.json is generated (gitignored) — read the one `ai sync` writes.
source "${SCRIPT_DIR}/../lib/generated-settings.sh"
_GEN_DIR="$(mktemp -d)"; on_exit "rm -rf '$_GEN_DIR'"
GEN_SETTINGS="$(gen_project_settings "$_GEN_DIR/proj")"
assert_status 0 "E-266.10b: the generated project allow-list grants it" \
  grep -q 'mcp__task-synchronizer-mcp__get_ci_status' "$GEN_SETTINGS"
NOAI="$(test_tmpdir cirec-noai)"
mkdir -p "${NOAI}/tests"; cp "${REPO}/tests/run.sh" "${NOAI}/tests/run.sh"; echo 0 > "${NOAI}/stub_exit"
printf '.env\nnode_modules\n' > "${NOAI}/.gitignore"
git -C "$NOAI" init -q; git -C "$NOAI" add -A
git -C "$NOAI" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm x
OUT="$( ( cd "$NOAI" && HOME="$FAKE_HOME" TMPDIR="${RUN_TMP}/" bash "$AI" ci run ) 2>&1 )"; RC=$?
assert_status 0 "E-266.10c: a repo without .ai/ still runs (exit 0)" test "$RC" -eq 0
assert_contains "E-266.10d: and says plainly that it was not recorded" "not recorded" "$OUT"
assert_status 1 "E-266.10e: and no state store was created for it" test -e "${NOAI}/.ai"

echo ""


# ── E-303 (D-088, test-economics.md §Component 7): the test budget ratchet, end to end ──
# Extends the record rows above through the real CLI: a recorded budget holds the next run;
# one more suite FAILS with recorded/measured/slack on one line; `ai ci budget set` refuses
# without a D-### ruling and writes the ruling into the record. The arithmetic and the
# slacks are rows of tests/unit/ci-runs.test.mjs.
CIREC="${REPO_ROOT}/src/shared/ci-record.mjs"
_blog() {  # <file> <sha> <suites> → a green run log carrying a budget line
  printf '[ci] sha=%s ref=HEAD dirty=0 started_at=2026-10-28T10:00:00Z\n[ci] result status=PASS suite=PASS pass=1 fail=0 skip=0 leaked=0 unit=PASS secrets=PASS\n[ci] budget suites=%s test_lines=1000 fast_tier_seconds=30 full_seconds=400\n[ci] finished status=PASS duration_ms=1000 finished_at=2026-10-28T10:01:00Z\n' "$2" "$3" > "$1"
}
_blog "${RUN_TMP}/b45.log" "$SHA_PASS" 45
node --no-warnings "$CIREC" record --ai-dir "${REPO}/.ai" --log "${RUN_TMP}/b45.log" >/dev/null 2>&1
_blog "${RUN_TMP}/b46.log" "$SHA_PASS" 46
OUT="$(node --no-warnings "$CIREC" budget-check --ai-dir "${REPO}/.ai" --log "${RUN_TMP}/b46.log" 2>&1)"; RC=$?
assert_status 0 "E-303.01a: one more suite than the recorded budget fails the check (rc=${RC})" test "$RC" -eq 1
assert_contains "E-303.01b: …with recorded, measured and slack on one line" \
  "[BUDGET_REGRESSION] suites: recorded 45, measured 46, slack +0" "$OUT"
OUT="$(node --no-warnings "$CIREC" budget-check --ai-dir "${REPO}/.ai" --log "${RUN_TMP}/b45.log" 2>&1)"; RC=$?
assert_status 0 "E-303.01c: an equal measurement passes" test "$RC" -eq 0
OUT="$(_ci budget)"
assert_contains "E-303.02a: ai ci budget prints the current budget" "test budget: suites 45, test_lines 1000, fast_tier_seconds 30" "$OUT"
OUT="$(_ci budget set suites=46)"; RC=$?
assert_status 0 "E-303.02b: raising the budget without a ruling is refused (rc=${RC})" test "$RC" -eq 2
assert_contains "E-303.02c: …and says a ruling is the way" "only by ruling: --ruling D-###" "$OUT"
OUT="$(_ci budget set --ruling D-118 suites=46)"; RC=$?
assert_status 0 "E-303.02d: a D-### ruling raises it" test "$RC" -eq 0
assert_contains "E-303.02e: the ruling id is written into the record" "D-118" \
  "$(_sql "SELECT budget_ruling FROM ci_runs WHERE budget_ruling IS NOT NULL")"
OUT="$(node --no-warnings "$CIREC" budget-check --ai-dir "${REPO}/.ai" --log "${RUN_TMP}/b46.log" 2>&1)"; RC=$?
assert_status 0 "E-303.02f: the ruled budget admits the run it was raised for" test "$RC" -eq 0
assert_contains "E-303.02g: ai ci budget names the ruling" "ruled by D-118" "$(_ci budget)"
assert_status 1 "E-303.03: no env var or flag lifts the ratchet (none is read)" \
  grep -qE 'AI_OS_[A-Z_]*BUDGET|--no-budget' "$AI" "$CIREC" "${REPO_ROOT}/src/mcp/shared/ci-budget.js"

# ── E-267 (from ai_ci_gate — E-302): the local CI gates ──
# E-267 (D-072, local-ci.md §Components 5-6a): the local CI gates.
#
# Two gates read the ci_runs record: `git push` (hooks/pre-push.sh, through a fail-closed
# stub) and update_task_status(DONE). Both are driven for real here — a real `git push` to
# a bare remote, a real MCP roundtrip — because a gate that only greps well is the
# pre-D-060 state with better prose.
#
# The certification rules themselves (self / bookkeeping ancestor / SKIPPED) are unit
# tested in tests/unit/ci-runs.test.mjs; this suite proves the wiring carries them.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AI="${REPO_ROOT}/src/bin/ai"
SYNC_SERVER="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"


# A fake HOME whose ~/.ai-os mirror points at THIS tree, so the stub's canonical and the
# hook's helper are the code under test, and the operator's real mirror is never read.
FAKE_HOME="$(test_tmpdir cigate-home)"
mkdir -p "${FAKE_HOME}/.ai-os/hooks"
tc_link_shared "$FAKE_HOME"   # E-345 (D-109 r1): mirror = this tree + the toolchain record the hooks pin
ln -s "${REPO_ROOT}/src/mcp" "${FAKE_HOME}/.ai-os/mcp"
ln -s "${REPO_ROOT}/hooks/pre-push.sh" "${FAKE_HOME}/.ai-os/hooks/pre-push.sh"

REPO="$(test_tmpdir cigate-repo)"
REMOTE="$(test_tmpdir cigate-remote)"
git init -q --bare "$REMOTE"
git -C "$REPO" init -q -b main
git -C "$REPO" remote add origin "$REMOTE"
mkdir -p "${REPO}/.ai" "${REPO}/src"
printf '.ai/state.sqlite*\n' > "${REPO}/.gitignore"

_commit() {  # <path> <content> <msg> → sha
  mkdir -p "$(dirname "${REPO}/$1")"
  printf '%s\n' "$2" > "${REPO}/$1"
  git -C "$REPO" add -A
  git -C "$REPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm "$3"
  git -C "$REPO" rev-parse HEAD
}
_row() {  # <sha> <status> [dirty] [reason] — a ci_runs row, written through the real module
  ( cd "$REPO_ROOT" && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --disable-warning=ExperimentalWarning \
      --input-type=module -e "
import { getDb } from './src/mcp/shared/state-db.js';
import { recordCiRun } from './src/mcp/shared/ci-runs.js';
recordCiRun(getDb('${REPO}/.ai'), { sha: '$1', ref: 'HEAD', status: '$2', dirty: ${3:-false},
  skip_reason: '${4:-}' || null, started_at: new Date(Date.now() + ${ROWN:-0}).toISOString() });" )
  ROWN=$(( ${ROWN:-0} + 1000 ))
}
_push() {  # [env...] → push HEAD:main, output + exit code in PUSH_OUT / PUSH_RC
  PUSH_OUT="$( cd "$REPO" && env HOME="$FAKE_HOME" "$@" git push -q origin HEAD:main 2>&1 )"; PUSH_RC=$?
}
_sql() { python3 - "$REPO/.ai/state.sqlite" "$1" <<'PY'
import sqlite3, sys
for row in sqlite3.connect(sys.argv[1]).execute(sys.argv[2]):
    print("|".join("" if v is None else str(v) for v in row))
PY
}

# Install the stub exactly as `ai init` does.
_hooks_out="$( cd "$REPO" && HOME="$FAKE_HOME" bash -c "
  AIOS=\"\$HOME/.ai-os\"; AIOS_STUB_MARKER='# AI-OS-STUB'
  $(awk '/^_write_pre_push_stub\(\) \{/,/^}$/' "$AI")
  _write_pre_push_stub .git/hooks/pre-push && echo written" 2>&1 )"
assert_contains "E-267.00: the pre-push stub is written" "written" "$_hooks_out"

# ── E-267.1: adoption — no rows, the gate does not block ────────────────
C1="$(_commit src/a.js 1 first)"
_push
assert_status 0 "E-267.01a: a project with no ai ci history can push" test "$PUSH_RC" -eq 0
assert_contains "E-267.01b: and is told the gate is not enforced yet" "not enforced" "$PUSH_OUT"

# ── E-267.2: tip tested → push allowed ───────────────────────────────────
C2="$(_commit src/a.js 2 second)"
_row "$C2" PASS
_push
assert_status 0 "E-267.02a: a tip with a green run pushes" test "$PUSH_RC" -eq 0
assert_contains "E-267.02b: and says why" "${C2:0:7} ok (PASS run)" "$PUSH_OUT"

# ── E-267.3: bookkeeping on top of a tested commit rides on it ──────────
C3="$(_commit .ai/TASKS.md "- [x] done" "chore(state): mark DONE")"
_push
assert_status 0 "E-267.03a: a .ai/-only commit above a tested tip pushes" test "$PUSH_RC" -eq 0
assert_contains "E-267.03b: via the tested ancestor" "tested ancestor ${C2:0:7}, only .ai/ differs" "$PUSH_OUT"

# ── E-267.4: code above the tested commit is refused ─────────────────────
C4="$(_commit src/a.js 3 "untested code")"
_push
assert_status 1 "E-267.04a: an untested code commit is refused" test "$PUSH_RC" -eq 0
assert_contains "E-267.04b: with the CI_GATE message and the command" \
  "[CI_GATE] refs/heads/main: no green local CI run for ${C4:0:7}" "$PUSH_OUT"
assert_contains "E-267.04c: naming the nearest tested ancestor and the path" \
  "nearest tested ancestor ${C2:0:7} differs outside .ai/: src/a.js" "$PUSH_OUT"
assert_contains "E-267.04d: and the recorded bypass" 'AI_OS_CI_SKIP=1 AI_OS_CI_SKIP_REASON=' "$PUSH_OUT"
assert_status 0 "E-267.04e: the remote did not move" \
  test "$(git -C "$REMOTE" rev-parse main)" = "$C3"

# A FAIL row on the tip is refused, not rescued by the ancestor.
_row "$C4" FAIL
_push
assert_status 1 "E-267.04f: a tip whose run FAILED is refused" test "$PUSH_RC" -eq 0
assert_contains "E-267.04g: and says so" "its run is FAIL" "$PUSH_OUT"

# ── E-267.5: skip — with a reason recorded, without a reason refused ─────
_push AI_OS_CI_SKIP=1
assert_status 1 "E-267.05a: AI_OS_CI_SKIP=1 without a reason is refused" test "$PUSH_RC" -eq 0
assert_contains "E-267.05b: and says a reason is required" "needs AI_OS_CI_SKIP_REASON" "$PUSH_OUT"
_push AI_OS_CI_SKIP=1 "AI_OS_CI_SKIP_REASON=prod outage hotfix"
assert_status 0 "E-267.05c: a skip with a reason pushes" test "$PUSH_RC" -eq 0
assert_status 0 "E-267.05d: and the remote moved" test "$(git -C "$REMOTE" rev-parse main)" = "$C4"
assert_contains "E-267.05e: the skip is a SKIPPED row carrying the reason and ref" \
  "SKIPPED|prod outage hotfix|refs/heads/main" \
  "$(_sql "SELECT status, skip_reason, ref FROM ci_runs WHERE sha='${C4}' ORDER BY id DESC LIMIT 1")"
_push
assert_status 0 "E-267.05f: a later plain push of the skipped tip is let through (it is recorded)" test "$PUSH_RC" -eq 0

# ── E-267.6: fail closed ─────────────────────────────────────────────────
C6="$(_commit src/a.js 6 "sixth")"
_row "$C6" PASS
rm "${FAKE_HOME}/.ai-os/hooks/pre-push.sh"
_push
assert_status 1 "E-267.06a: a missing canonical refuses the push" test "$PUSH_RC" -eq 0
assert_contains "E-267.06b: and names the fix" "pre-push canonical missing" "$PUSH_OUT"
ln -s "${REPO_ROOT}/hooks/pre-push.sh" "${FAKE_HOME}/.ai-os/hooks/pre-push.sh"
mv "${FAKE_HOME}/.ai-os/shared" "${FAKE_HOME}/.ai-os/shared.off"
_push
assert_status 1 "E-267.06c: a missing helper refuses the push" test "$PUSH_RC" -eq 0
assert_contains "E-267.06d: and names the fix" "ci-record.mjs or node unavailable" "$PUSH_OUT"
mv "${FAKE_HOME}/.ai-os/shared.off" "${FAKE_HOME}/.ai-os/shared"
_push
assert_status 0 "E-267.06e: restored, the tested tip pushes (non-vacuity for 06a-d)" test "$PUSH_RC" -eq 0

# A repo that is not an AI-OS project is not gated.
PLAIN="$(test_tmpdir cigate-plain)"
git -C "$PLAIN" init -q
out="$( cd "$PLAIN" && printf 'refs/heads/x %s refs/heads/x %s\n' "$C6" "$C6" \
  | HOME="$FAKE_HOME" bash "${REPO_ROOT}/hooks/pre-push.sh" 2>&1 )"; rc=$?
assert_status 0 "E-267.06f: a repo without .ai/ is not gated" test "$rc" -eq 0
# Deleting a remote branch pushes no content.
out="$( cd "$REPO" && printf 'refs/heads/gone 0000000000000000000000000000000000000000 refs/heads/gone %s\n' "$C6" \
  | HOME="$FAKE_HOME" bash "${REPO_ROOT}/hooks/pre-push.sh" 2>&1 )"; rc=$?
assert_status 0 "E-267.06g: a branch deletion is not gated" test "$rc" -eq 0

# ── E-267.7: stub chaining preserves the user's hook and stdin ───────────
CH="$(test_tmpdir cigate-chain)"
printf '#!/usr/bin/env bash\ncat > "%s/seen"\nexit 0\n' "$CH" > "${REPO}/.git/hooks/pre-push.pre-aios"
chmod +x "${REPO}/.git/hooks/pre-push.pre-aios"
# E-290: the stub bakes in \${AIOS} (the install path) at WRITE time, as src/bin/ai defines it.
( cd "$REPO" && HOME="$FAKE_HOME" bash -c "
  AIOS_STUB_MARKER='# AI-OS-STUB'
  AIOS='${FAKE_HOME}/.ai-os'
  $(awk '/^_write_pre_push_stub\(\) \{/,/^}$/' "$AI")
  _write_pre_push_stub .git/hooks/pre-push .git/hooks/pre-push.pre-aios" )
# A NEW tested commit: git hands a hook no ref lines when there is nothing to update.
C7="$(_commit src/a.js 7 "seventh")"
_row "$C7" PASS
_push
assert_status 0 "E-267.07a: the chained push still passes the gate" test "$PUSH_RC" -eq 0
assert_contains "E-267.07b: the user's hook received git's ref line on stdin" "refs/heads/main" "$(cat "${CH}/seen" 2>/dev/null)"
printf '#!/usr/bin/env bash\nexit 7\n' > "${REPO}/.git/hooks/pre-push.pre-aios"
_push
assert_status 1 "E-267.07c: a failing user hook still blocks the push" test "$PUSH_RC" -eq 0
rm -f "${REPO}/.git/hooks/pre-push.pre-aios"

# ── E-267.8: the DONE gate, through the real MCP server ─────────────────
_mcp() { ( cd "$REPO" && env HOME="$FAKE_HOME" "$@" ) | python3 -c '
import json,sys
d=json.load(sys.stdin)
print((d.get("content") or [{}])[0].get("text",""))'; }
_done() {  # <task> [env...] → the update_task_status text
  local id="$1"; shift
  _mcp "$@" bash -c "source '${REPO_ROOT}/tests/lib/mcp-client.sh'; mcp_call_tool '$SYNC_SERVER' update_task_status '{\"id\":\"$id\",\"status\":\"DONE\",\"summary\":\"probe\"}'"
}
_add() { _mcp bash -c "source '${REPO_ROOT}/tests/lib/mcp-client.sh'; mcp_call_tool '$SYNC_SERVER' add_task '{\"owner\":\"Engineer (Claude)\",\"description\":\"Probe the CI gate $1\",\"prefix\":\"E\"}'" >/dev/null; }
for n in 1 2 3; do _add "$n"; done
C8="$(_commit src/a.js 8 "eighth")"
OUT="$(_done E-1)"
assert_contains "E-267.08a: DONE is refused when HEAD has no run" \
  "[CI_GATE] no green local CI run for HEAD ${C8:0:7}" "$OUT"
assert_contains "E-267.08b: the refusal names the command and the bypass" "run: ai ci run (bypass: AI_OS_CI_GATE=0)" "$OUT"
OUT="$(_done E-1 AI_OS_CI_GATE=0)"
assert_contains "E-267.08c: AI_OS_CI_GATE=0 lets DONE through" "E-1 → DONE" "$OUT"
_row "$C8" PASS true
OUT="$(_done E-2)"
assert_contains "E-267.08d: a dirty-only HEAD is refused" "[CI_GATE]" "$OUT"
_row "$C8" FAIL
OUT="$(_done E-2)"
assert_contains "E-267.08e: a FAIL HEAD is refused, and says so" "its run is FAIL" "$OUT"
_row "$C8" PASS
OUT="$(_done E-2)"
assert_contains "E-267.08f: a PASS HEAD is accepted" "E-2 → DONE" "$OUT"
C9="$(_commit .ai/notes.md "bookkeeping" "chore(state)")"
OUT="$(_done E-3)"
assert_contains "E-267.08g: a .ai/-only HEAD above the tested commit is accepted" "E-3 → DONE" "$OUT"

EMPTY="$(test_tmpdir cigate-empty)"
git -C "$EMPTY" init -q; mkdir -p "${EMPTY}/.ai"
git -C "$EMPTY" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --allow-empty -m x
OUT="$( cd "$EMPTY" && HOME="$FAKE_HOME" mcp_call_tool "$SYNC_SERVER" add_task '{"owner":"Engineer (Claude)","description":"Probe adoption off","prefix":"E"}' >/dev/null
        cd "$EMPTY" && HOME="$FAKE_HOME" mcp_call_tool "$SYNC_SERVER" update_task_status '{"id":"E-1","status":"DONE","summary":"x"}' \
          | python3 -c 'import json,sys; print((json.load(sys.stdin).get("content") or [{}])[0].get("text",""))' )"
assert_contains "E-267.08h: a project that never ran ai ci is not gated" "E-1 → DONE" "$OUT"

# ── E-267.9: the consumers ───────────────────────────────────────────────
TASK_SKILL="${REPO_ROOT}/src/shared/skills/ai-task/SKILL.md"
# The needles below are REGEXES ('gh +run'), not the literal phrase, so E-268's repo-wide
# "nothing names the hosted runner any more" grep is not tripped by its own negative tests.
assert_status 1 "E-267.09a: ai-task no longer reads the hosted runner" grep -qE 'gh +run' "$TASK_SKILL"
assert_status 1 "E-267.09b: ai-task's injection no longer shells out to python3" grep -q '^Local CI.*python3' "$TASK_SKILL"
INJ="$(sed -n 's/^Local CI (HEAD): !//p' "$TASK_SKILL")"
assert_contains "E-267.09c: ai-task injects ai ci status --short" "ai ci status --ref HEAD --short" "$INJ"
# Run the injection line itself against a fixture, with an `ai` on PATH that is this tree.
BIN="$(test_tmpdir cigate-bin)"
printf '#!/usr/bin/env bash\nexec bash "%s" "$@"\n' "$AI" > "${BIN}/ai"; chmod +x "${BIN}/ai"
OUT="$( cd "$REPO" && git checkout -qf "$C8" && HOME="$FAKE_HOME" PATH="${BIN}:$PATH" bash -c "$INJ" 2>&1 )"
assert_match "E-267.09d: the injected line reads PASS for a tested HEAD" "^PASS ${C8:0:7} " "$OUT"
OUT="$( cd "$REPO" && git checkout -qf "$C1" && HOME="$FAKE_HOME" PATH="${BIN}:$PATH" bash -c "$INJ" 2>&1 )"
assert_match "E-267.09e: and NONE for an untested one" "^NONE ${C1:0:7} " "$OUT"
OUT="$( cd "$REPO" && HOME="$FAKE_HOME" PATH="/usr/bin:/bin" bash -c "$INJ" 2>&1 )"
assert_contains "E-267.09f: and says unavailable when ai is not installed" "(ai ci unavailable" "$OUT"
git -C "$REPO" checkout -qf main

# E-282: the triage rule moved from ENGINEER.md to the tests/** path-scoped rule.
assert_status 0 "E-267.09g: the tests/** rule triages with ai ci log --failed" \
  grep -q 'ai ci log --failed' "${REPO_ROOT}/src/claude/rules/test-harness.md"
for f in ENGINEER.md src/templates/ENGINEER.md src/claude/rules/test-harness.md; do
  assert_status 1 "E-267.09h: ${f} no longer names the hosted runner" grep -qE 'gh +run +view' "${REPO_ROOT}/${f}"
done
for f in src/claude/agents/critic_tests.md src/claude/skills/ai-review/SKILL.md; do
  assert_status 0 "E-267.09i: ${f} says 'under \`ai ci\`'" grep -q 'under `ai ci`' "${REPO_ROOT}/${f}"
  assert_status 1 "E-267.09j: ${f} no longer says 'fails the run on CI'" grep -q 'fails the run on CI' "${REPO_ROOT}/${f}"
done
assert_status 0 "E-267.09k: ci_gate forbids pushing without a green ai ci run" \
  grep -q 'without a green `ai ci run`' "${REPO_ROOT}/src/claude/skills/ci_gate/SKILL.md"
assert_status 0 "E-267.09l: install_git_hooks installs the pre-push stub" \
  grep -q '_write_pre_push_stub "\$PP_DST"' "$AI"
assert_status 0 "E-267.09m: uninstall tells the operator to remove it" \
  grep -q 'rm .git/hooks/pre-push' "$AI"
for m in .claude/skills/ai-task/SKILL.md:src/shared/skills/ai-task/SKILL.md \
         .claude/skills/ai-review/SKILL.md:src/claude/skills/ai-review/SKILL.md \
         .claude/skills/ci_gate/SKILL.md:src/claude/skills/ci_gate/SKILL.md \
         .claude/agents/critic_tests.md:src/claude/agents/critic_tests.md; do
  assert_mirror_if_present "E-267.09n: ${m%%:*} mirrors ${m##*:}" "${REPO_ROOT}/${m##*:}" "${REPO_ROOT}/${m%%:*}"
done

echo ""


# ── E-268 (from actions_decommission — E-302): GitHub Actions is retired ──
# E-268 (D-072, local-ci.md §Component 6b).
#
# GitHub Actions is retired: the workflow is deleted and every surface that told an operator
# (or an agent) to look at a hosted run now points at `ai ci`. The assertions are the
# acceptance grep, kept executable — a future edit that reintroduces a hosted-CI instruction
# fails here rather than sending someone to a pipeline that no longer runs.
#
# The workflow file stays in git history; that is the rollback (D-072).
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"


# ── E-268.1: the workflow is gone, history keeps it ───────────────────────
# E-332 (D-102 §5b, D-103) brought back ONE workflow — the hosted master check, which runs
# `ai ci run` and nothing else (tests/unit/hosted-ci-workflow.test.mjs). Any other is a regression.
# E-378 (D-129): the public repository adds ONE more, the privacy scan of the tracked tree
# (publish-scan.mjs scan-tree) — present exactly where .ai/publish.json marks that repository.
# E-384 (D-133 §Component 2): the public repository's CI is layered — the scanners, the
# dependency review, the nightly and the release workflow beside the rendered ci.yml. The list
# is exact: a workflow nobody named here is still a regression.
_e268_want="ci.yml"
[[ -f "${REPO_ROOT}/.ai/publish.json" ]] && _e268_want="$(printf 'ci.yml\ncodeql.yml\ndependency-review.yml\nnightly.yml\nprivacy.yml\nrelease.yml\nscorecard.yml')"
assert_status 0 "E-268.01a: the workflows are the hosted master check (D-103) and, in the public repository, the privacy scan" \
  bash -c '[[ "$(command ls -1A "$1" 2>/dev/null)" == "$2" ]]' _ "${REPO_ROOT}/.github/workflows" "$_e268_want"
assert_status 1 "E-268.01b: and neither does the workflow file" test -e "${REPO_ROOT}/.github/workflows/test.yml"
assert_status 0 "E-268.01c: .github survives (copilot-instructions.md lives there)" \
  test -f "${REPO_ROOT}/.github/copilot-instructions.md"
# E-378 (D-129): a checkout without the private history (the public repository starts from one
# squashed commit) records this as a skip, as the other history-pinned rows do.
# The public line's root is the bootstrap snapshot, whose subject names the private predecessor.
_e268_root="$(git -C "$REPO_ROOT" rev-list --max-parents=0 HEAD 2>/dev/null | head -1)"
if [[ -n "$_e268_root" && "$(git -C "$REPO_ROOT" log -1 --format=%s "$_e268_root")" != "Rein — successor of the private ai-os repository"* ]] \
   && [[ "$(git -C "$REPO_ROOT" rev-list --count HEAD 2>/dev/null)" -gt 1 ]]; then
  assert_status 0 "E-268.01d: the workflow is still in git history — that is the rollback" \
    bash -c "cd '$REPO_ROOT' && git log --oneline -1 -- .github/workflows/test.yml | grep -q ."
else
  _skip "E-268.01d: the removed workflow's history is not in this checkout"
fi

# ── E-268.2: nothing instructs anyone to read a hosted run ───────────────
# One grep, the acceptance one. Written as regexes so this suite does not trip itself.
# --exclude-dir=node_modules: `ai ci run` installs dependencies INSIDE the worktree it
# tests, and half of npm advertises its own GitHub Actions badge. Without this the assertion
# measured what the machine happened to have installed (E-236) — it passed on a tree with no
# vendored deps and failed under the runner, which is the wrong way round.
_hits="$(cd "$REPO_ROOT" && grep -rnE --exclude-dir=node_modules --exclude-dir=.git \
  'gh +run|GITHUB_ACTIONS|actions/workflow|workflows/test\.yml|ubuntu-latest' \
  src tests hooks .claude README.md CONTRIBUTING.md ENGINEER.md ARCHITECT.md install-ai-os.sh 2>/dev/null \
  | grep -vE '^tests/suites/ai_ci_test\.sh:' \
  | grep -vE '^src/templates/ci/' \
  | grep -vE '^(src/shared/hosted-ci\.mjs|tests/unit/hosted-ci(-workflow)?\.test\.mjs):' \
  | grep -vE '^src/templates/public/privacy\.yml:' \
  | grep -vE '^README\.md:[0-9]+:\[ci(-badge)?\]: https://github\.com/Vimurai/rein/actions/workflows/ci\.yml(/badge\.svg)?$' \
  | grep -vE '^README\.md:[0-9]+:\[privacy(-badge)?\]: https://github\.com/Vimurai/rein/actions/workflows/privacy\.yml(/badge\.svg)?$' \
  | grep -vE '^README\.md:[0-9]+:\[codeql(-badge)?\]: https://github\.com/Vimurai/rein/actions/workflows/codeql\.yml(/badge\.svg)?$' \
  | grep -vE '^src/bin/ai:[0-9]+:  if \[\[ -n "\$\{GITHUB_ACTIONS:-\}" \]\]; then echo "hosted:github"$' \
  || true)"   # E-335 (D-103): the rendered hosted-check templates ARE a hosted run.
# E-384 (D-135 r5): so is the renderer that builds their matrix, and the two suites that pin it.
# E-386 (D-135 r1): _ci_host_class reads the GitHub runner's marker to widen its lanes — the
# one src/bin/ai line allowed to name it; detecting a runner is not an instruction to read one.
# E-374 (D-125, D-129): the public repo's live CI badge and its link are the two README lines
# allowed to name a workflow — a status display, not an instruction to read a hosted run.
# E-384 (D-133 §Component 3): likewise the privacy and CodeQL badges and their links, each
# naming only its own workflow.
assert_status 0 "E-268.02a: no hosted-CI instruction remains under src/tests/hooks/.claude/docs" \
  bash -c "[[ -z \"\$1\" ]]" _ "$_hits"
[[ -n "$_hits" ]] && printf '  ⓘ remaining hits:\n%s\n' "$_hits"
# The permitted mentions: CHANGELOG history, DECISIONS, the archive.
assert_status 0 "E-268.02b: the CHANGELOG records the removal for the release notes" \
  grep -q 'GitHub Actions workflow removed; CI runs locally via `ai ci`' "${REPO_ROOT}/CHANGELOG.md"
# E-382 (D-131): E-263 released it in [4.0.0], now under "Private predecessor"; no [Unreleased].
assert_status 0 "E-268.02c: under the 4.0.0 BREAKING heading, where E-263 released it" \
  bash -c "sed -n '/^## \[4\.0\.0\]/,/^## \[3/p' '${REPO_ROOT}/CHANGELOG.md' | grep -q 'Changed — BREAKING'"

# ── E-268.3: README ──────────────────────────────────────────────────────
# E-374 (D-125): a live GitHub Actions badge reflects real runs and is allowed; a static
# "tests passing" image is what E-268 removed, and stays gone.
assert_status 1 "E-268.03a: no static tests-passing badge" grep -qiE 'img\.shields\.io/badge/tests|tests-passing' "${REPO_ROOT}/README.md"
assert_status 0 "E-268.03b: a Local CI section documents the runner" \
  grep -q '^## Local CI — `ai ci`' "${REPO_ROOT}/README.md"
for needle in 'ai ci run' 'ai ci status' 'ai ci log --failed' 'AI_OS_CI_SKIP_REASON' 'pre-push'; do
  assert_status 0 "E-268.03c: README documents ${needle}" \
    bash -c "sed -n '/^## Local CI/,/^## Troubleshooting/p' '${REPO_ROOT}/README.md' | grep -qF '$needle'"
done

# ── E-268.4: CONTRIBUTING ────────────────────────────────────────────────
assert_status 0 "E-268.04a: CONTRIBUTING has the Local CI section" \
  grep -q 'Local CI (`ai ci`)' "${REPO_ROOT}/CONTRIBUTING.md"
assert_status 0 "E-268.04b: and says what green means for a PR" \
  grep -q 'non-dirty' "${REPO_ROOT}/CONTRIBUTING.md"
assert_status 0 "E-268.04c: and names the recorded bypass" \
  grep -q 'AI_OS_CI_SKIP=1' "${REPO_ROOT}/CONTRIBUTING.md"

# ── E-268.5: the agent-facing surfaces ───────────────────────────────────
CG="${REPO_ROOT}/src/claude/skills/ci_gate/SKILL.md"
assert_status 0 "E-268.05a: ci_gate names the local config files it protects" \
  grep -q 'hooks/pre-push.sh' "$CG"
assert_status 0 "E-268.05b: ci_gate injects the local CI verdict, not a workflow find" \
  grep -q 'ai ci status --ref HEAD --short' "$CG"
assert_status 0 "E-268.05c: ci_gate enforces the step order of the runner" \
  grep -q 'worktree → env → deps' "$CG"
assert_status 0 "E-268.05d: the DevOps contract says what CI means here" \
  grep -q 'ai ci run` on the machine' "${REPO_ROOT}/src/contracts/40_DEVOPS.md"
assert_status 0 "E-268.05e: devops_engineer knows CI is local" \
  grep -q 'AI-OS itself runs CI locally' "${REPO_ROOT}/src/claude/agents/devops_engineer.md"
assert_status 0 "E-268.05f: the copilot brief no longer offers CI triggers" \
  bash -c "! grep -q 'CI triggers' '${REPO_ROOT}/src/copilot/COPILOT.md'"

# ── E-268.6: mirrors carry the same text ─────────────────────────────────
assert_mirror_if_present "E-268.06a: .claude/skills/ci_gate mirrors src/" \
  "$CG" "${REPO_ROOT}/.claude/skills/ci_gate/SKILL.md"
assert_mirror_if_present "E-268.06b: .claude/agents/devops_engineer mirrors src/" \
  "${REPO_ROOT}/src/claude/agents/devops_engineer.md" "${REPO_ROOT}/.claude/agents/devops_engineer.md"

echo ""

assert_summary
