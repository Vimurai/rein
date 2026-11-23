#!/usr/bin/env bash
# pre_commit_hook_test.sh — what hooks/pre-commit.sh refuses (was conflict_gate_test, renamed for
# the behaviour by E-301; absorbs mcp_stdout_purity, pre_commit_standards_gate and
# standards_checker's process rows).
#
# E-467 (D-170 r4-r5) cut the hook to the lane, machine-local file and publish checks. Deleted
# with the gates they tested: the conflict-marker and .ai JSON gate (E-238.1-4), the MCP stdout
# purity wiring (T-MPG-S10), the standards gate in the hook (E-82, T-PCS-S01..S10) and the
# registry-drift wiring (E-302.RD1). Kept: the rules the E-238 incident wrote down (E-238.5),
# the purity checker and the standards checker as standalone tools (T-MPG, E-80, E-250), the
# registry-drift checker (E-302.RD2-3) and the machine-local gate (E-448).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${REPO_ROOT}/hooks/pre-commit.sh"

echo "── Suite: pre_commit_hook_test (E-238, E-48, E-80, E-448) ──────────"

# ── E-238.5: the rules are written down where they are read ───────────────
# E-282 (D-075/D-080): these rules moved out of ENGINEER.md into path-scoped
# .claude/rules/ files (canonical src/claude/rules/), which load when a matching file is
# read. The assertions follow the rule, not the file it used to live in.
_RULES="${REPO_ROOT}/src/claude/rules"
assert_status 0 "E-238.05a: the .ai/** rule forbids stashing bookkeeping" \
  grep -q 'Never move bookkeeping with' "${_RULES}/ai-bookkeeping.md"
assert_status 0 "E-238.05b: and the template matches (they are one file)" \
  diff -q "${REPO_ROOT}/ENGINEER.md" "${REPO_ROOT}/src/templates/ENGINEER.md"
# E-407 (D-141 r4, addendum r1): extends E-238.05b — the rulefile carries the merge rule, and the
# dead "Project-Scoped Rules" section that paid for the line is gone. E-461: the prune steps moved
# from the removed rein-task skill (its Step 3.5) into the rulefile itself.
assert_status 0 "E-407.01a: the rulefile merges with --delete-branch" \
  grep -qF "gh pr merge <n> --merge --delete-branch" "${REPO_ROOT}/src/templates/ENGINEER.md"
assert_status 0 "E-407.01b: and prunes with -d, never -D" \
  bash -c 'grep -qF "git branch -d <branch>" "$1" && grep -qF "never -D" "$1"' _ "${REPO_ROOT}/src/templates/ENGINEER.md"
# E-461 (D-169 r7): both rulefiles point at the bookkeeping commands, not the removed skills,
# and stay at most 2 KB (E-460).
for _rf in ENGINEER ARCHITECT; do
  assert_status 0 "E-461.01 [${_rf}]: names rein done and rein handoff" \
    bash -c 'grep -qF "rein done" "$1" && grep -qF "rein handoff --to" "$1"' _ "${REPO_ROOT}/src/templates/${_rf}.md"
  assert_status 1 "E-461.02 [${_rf}]: names none of the removed bookkeeping skills" \
    grep -qE 'rein-task|arch-task|rein-handoff|task-planner|decision-recorder|rein-log' "${REPO_ROOT}/src/templates/${_rf}.md"
  assert_status 0 "E-461.03 [${_rf}]: at most 2048 bytes" test "$(wc -c < "${REPO_ROOT}/src/templates/${_rf}.md")" -le 2048
done
assert_status 0 "E-461.04: the Architect's rulefile names rein decide" grep -qF "rein decide --file" "${REPO_ROOT}/src/templates/ARCHITECT.md"
assert_status 1 "E-407.01c: the self-referential Project-Scoped Rules section is gone" \
  grep -qF "## Project-Scoped Rules" "${REPO_ROOT}/src/templates/ENGINEER.md"
assert_status 0 "E-238.05c: the triage rule is recorded (tests/** rule)" \
  grep -q 'presumed REAL until you have read its log' "${_RULES}/test-harness.md"
# The triage rule is only useful if it says what a flake claim REQUIRES; "rerun it" is how
# a real failure gets filed as noise.
assert_status 0 "E-238.05d: and it demands a NAMED nondeterminism, not just a rerun" \
  grep -q 'named nondeterminism' "${_RULES}/test-harness.md"
# E-238.05e-f (commit-crafter's staging rule) went with the skill (E-467); the .ai/** rule keeps it.
assert_status 0 "E-238.05e: the .ai/** rule says to stage named paths after a conflict" \
  grep -q 'Stage named' "${_RULES}/ai-bookkeeping.md"

echo ""
# ── E-48 (from mcp_stdout_purity — E-301): the MCP stdout purity gate ─────────
# Drives tests/lib/mcp_purity_check.sh against a sandbox git repo: a staged console.log or
# console.info under src/mcp/ fails [MCP_PURITY_FAIL]; console.error, commented forms, files
# outside src/mcp/ and non-source extensions pass; the hook runs the checker only when
# src/mcp/* is staged.
CHECKER="${REPO_ROOT}/tests/lib/mcp_purity_check.sh"

# ── T-MPG-S01: Helper exists + executable ────────────────────────────────────
echo ""
echo "  [T-MPG-S01] Helper file structure"

assert_status 0 "checker script exists"     test -f "$CHECKER"
assert_status 0 "checker is executable"     test -x "$CHECKER"

# ── Sandbox setup — fresh git repo per test run ─────────────────────────────
SANDBOX="$(mktemp -d -t mcp-purity-XXXXXX)"
on_exit 'rm -rf "$SANDBOX"'
git -C "$SANDBOX" init -q
git -C "$SANDBOX" config user.email "test@example.com"
git -C "$SANDBOX" config user.name "Test"
mkdir -p "${SANDBOX}/src/mcp/test-server" "${SANDBOX}/tests/lib"
cp "$CHECKER" "${SANDBOX}/tests/lib/mcp_purity_check.sh"

# Initial empty commit so staged-only checks have something to diff against.
git -C "$SANDBOX" commit --allow-empty -q -m "init"

run_checker() {
  ( cd "$SANDBOX" && bash tests/lib/mcp_purity_check.sh )
}

stage_file() {
  local path="$1" content="$2"
  mkdir -p "$(dirname "${SANDBOX}/${path}")"
  printf '%s' "$content" > "${SANDBOX}/${path}"
  git -C "$SANDBOX" add "$path"
}

reset_index() {
  git -C "$SANDBOX" reset -q
  find "$SANDBOX" -type f -not -path '*/.git/*' -not -path '*/tests/lib/*' -delete 2>/dev/null
}

# ── T-MPG-S02: clean staged diff passes ──────────────────────────────────────
echo ""
echo "  [T-MPG-S02] Clean staged content passes"

reset_index
stage_file "src/mcp/test-server/index.js" "// clean — no forbidden calls
import { createLogger } from '../shared/logger.js';
const log = createLogger('test-server');
log.info('startup', 'ready');
"
assert_status 0 "clean diff exits 0" run_checker

# ── T-MPG-S03: staged console.log triggers FAIL ──────────────────────────────
echo ""
echo "  [T-MPG-S03] console.log fires"

reset_index
stage_file "src/mcp/test-server/index.js" "import x from 'y';
console.log('this would corrupt JSON-RPC stdout');
"
OUT=$(run_checker 2>&1) ; RC=$?
assert_status 0 "staged console.log exits 1" bash -c "[[ $RC -eq 1 ]]"
assert_contains "error message uses MCP_PURITY_FAIL marker" "MCP_PURITY_FAIL" "$OUT"
assert_contains "error message names the file" "src/mcp/test-server/index.js" "$OUT"

# ── T-MPG-S04: staged console.info also fires ────────────────────────────────
echo ""
echo "  [T-MPG-S04] console.info fires"

reset_index
stage_file "src/mcp/test-server/index.js" "console.info('also bad');
"
RC=0; run_checker >/dev/null 2>&1 || RC=$?
assert_status 0 "staged console.info exits 1" bash -c "[[ $RC -eq 1 ]]"

# ── T-MPG-S05: console.error is permitted ────────────────────────────────────
echo ""
echo "  [T-MPG-S05] console.error is permitted (stderr is allowed)"

reset_index
stage_file "src/mcp/test-server/index.js" "console.error('this writes to stderr — fine');
"
assert_status 0 "console.error exits 0" run_checker

# ── T-MPG-S06: line-commented console.log is permitted ──────────────────────
echo ""
echo "  [T-MPG-S06] // commented console.log is permitted"

reset_index
stage_file "src/mcp/test-server/index.js" "// console.log('explained in a comment');
"
assert_status 0 "line-commented exits 0" run_checker

# ── T-MPG-S07: block-commented console.log is permitted ─────────────────────
echo ""
echo "  [T-MPG-S07] /* block-commented */ console.log permitted"

reset_index
stage_file "src/mcp/test-server/index.js" "/*
 * Historical:
 * console.log('this used to leak');
 */
"
assert_status 0 "block-commented exits 0" run_checker

# ── T-MPG-S08: outside src/mcp/ → ignored ────────────────────────────────────
echo ""
echo "  [T-MPG-S08] Files outside src/mcp/ are not gated"

reset_index
stage_file "tests/fixtures/some.js" "console.log('test fixture should not be flagged');
"
assert_status 0 "non-mcp path exits 0" run_checker

# ── T-MPG-S09: non-JS extensions under src/mcp/ are ignored ─────────────────
echo ""
echo "  [T-MPG-S09] Non-source extensions under src/mcp/ are not gated"

reset_index
stage_file "src/mcp/test-server/README.md" "Example: \`console.log\` would be bad here.
"
assert_status 0 "markdown under src/mcp/ exits 0" run_checker

# T-MPG-S10 (the hook dispatching the purity checker) went with that gate (E-467, D-170 r4).

# ── T-MPG-S11: real-world clean repo passes ─────────────────────────────────
echo ""
echo "  [T-MPG-S11] Current repository's src/mcp/ is already clean"

# Run the checker against a synthetic stage that adds every existing
# src/mcp/**/*.js. If the repo has drifted, this is the canary.
# Prune nested node_modules (vendor JS contains console.log and would
# create false positives on CI where `npm ci` populates the workspaces).
reset_index
( cd "$SANDBOX"
  for f in $(cd "$REPO_ROOT" && find src/mcp -type d -name node_modules -prune -o -type f \( -name '*.js' -o -name '*.mjs' \) -print | head -40); do
    rel="$f"
    mkdir -p "$(dirname "$rel")"
    cp "${REPO_ROOT}/${rel}" "$rel"
    git add "$rel"
  done
)
assert_status 0 "every existing src/mcp/*.js passes the gate" run_checker

# E-82 (the standards gate inside hooks/pre-commit.sh, T-PCS-S01..S10) went with the gate (E-467).

# ── E-80 (from standards_checker — E-301): the standards checker where a process is under test ──
# validateStaged over a real git index, the CLI's 0/1/2 contract and --json envelope,
# REIN_SKIP_STANDARDS=1, the install layout and the E-250 suppression report. The rules
# themselves are rows of the standards contract table, in process in tests/unit (D-088).
STANDARDS_JSON="${REPO_ROOT}/src/shared/standards.json"
STD_CHECKER="${REPO_ROOT}/src/shared/standards-checker.mjs"
CLI="${REPO_ROOT}/scripts/standards.mjs"

# ── Set up a sandboxed git repo for behavioural tests ───────────────────────
SSBOX="$(mktemp -d -t e80-XXXXXX)"
on_exit 'rm -rf "$SSBOX"'
SPROJ="${SSBOX}/proj"
mkdir -p "${SPROJ}/src/mcp/foo" "${SPROJ}/src/shared" "${SPROJ}/scripts"
git -C "$SPROJ" init -q
git -C "$SPROJ" config user.email "t@t"
git -C "$SPROJ" config user.name "tester"

# ── T-STD-S09: validateStaged integrates `git diff --cached` ────────────────
echo ""
echo "  [T-STD-S09] validateStaged reads the staged set"

# Stage a clean file + a dirty file (.tmp).
echo 'export const x = 1' > "${SPROJ}/src/staged-ok.mjs"
echo 'temp data' > "${SPROJ}/src/staged.tmp"
git -C "$SPROJ" add src/staged-ok.mjs src/staged.tmp

staged_out="$(node --input-type=module -e "
  const m = await import('file://${STD_CHECKER}');
  const rules = m.loadStandards().rules;
  const envelope = m.validateStaged('${SPROJ}', rules);
  console.log(JSON.stringify(envelope));
" 2>/dev/null)"

assert_status 0 "validateStaged reports both staged files" \
  bash -c "grep -q '\"files_checked\":2' <<< '$staged_out'"
assert_status 0 "validateStaged surfaces the .tmp error" \
  bash -c "grep -q 'no_committed_tmp_files' <<< '$staged_out'"
assert_status 0 "validateStaged summary.error_count >= 1" \
  bash -c "echo '$staged_out' | python3 -c 'import json, sys; sys.exit(0 if json.load(sys.stdin)[\"summary\"][\"error_count\"] >= 1 else 1)'"

# ── T-STD-S10: Performance budget — <200ms on a 10-file synthetic set ───────
echo ""
echo "  [T-STD-S10] validateStaged completes within the 200ms budget"

for i in 1 2 3 4 5 6 7 8 9 10; do
  echo "export const x${i} = ${i}" > "${SPROJ}/src/perf-${i}.mjs"
  git -C "$SPROJ" add "src/perf-${i}.mjs"
done
elapsed="$(node --input-type=module -e "
  const m = await import('file://${STD_CHECKER}');
  const rules = m.loadStandards().rules;
  const r = m.validateStaged('${SPROJ}', rules);
  console.log(r.summary.elapsed_ms);
" 2>/dev/null)"
assert_status 0 "elapsed_ms <= 500ms (generous CI floor)" bash -c "[[ ${elapsed:-9999} -le 500 ]]"

# ── T-STD-S11: CLI exit codes + --json output shape ────────────────────────
echo ""
echo "  [T-STD-S11] CLI exit code contract: PASS=0, error=1, usage=2"

# `check --file` on a clean file → exit 0.
( cd "$SPROJ" && node "$CLI" check --file src/staged-ok.mjs >/dev/null 2>&1 )
assert_status 0 "clean file → exit 0" bash -c "[[ $? -eq 0 ]]"

# `check --file` on the .tmp file → exit 1.
( cd "$SPROJ" && node "$CLI" check --file src/staged.tmp >/dev/null 2>&1 )
rc=$?
assert_status 0 "error-grade violation → exit 1" bash -c "[[ $rc -eq 1 ]]"

# Unknown subcommand → exit 2.
( cd "$SPROJ" && node "$CLI" bogus >/dev/null 2>&1 )
rc=$?
assert_status 0 "unknown subcommand → exit 2" bash -c "[[ $rc -eq 2 ]]"

# `--json` mode produces parseable JSON on stdout.
json_out="$( ( cd "$SPROJ" && node "$CLI" check --file src/staged-ok.mjs --json ) 2>/dev/null)"
assert_status 0 "--json output parses cleanly" \
  bash -c "echo '$json_out' | python3 -c 'import json, sys; json.loads(sys.stdin.read())'"

# `list-rules --json` round-trips the standards.json shape.
# E-250: the JSON is piped, never interpolated into a quoted shell string. It used to be
# embedded as \$list_json, so the first apostrophe in any rule description or
# exemption reason closed the quote and the assertion failed on the CONTENT of
# standards.json rather than on its shape — which is what happened when a reason
# containing "rule's scope" was added.
list_json="$(node "$CLI" list-rules --json 2>/dev/null)"
_lj_file="$(test_tmpdir std-json)/list.json"
printf '%s' "$list_json" > "$_lj_file"
assert_status 0 "list-rules --json parses + carries rules[]" \
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if isinstance(d.get("rules"), list) and len(d["rules"]) >= 6 else 1)' "$_lj_file"

# ── T-STD-S12: REIN_SKIP_STANDARDS=1 rollback path ─────────────────────────
echo ""
echo "  [T-STD-S12] REIN_SKIP_STANDARDS=1 short-circuits the gate"

stderr_out="$( ( cd "$SPROJ" && REIN_SKIP_STANDARDS=1 node "$CLI" check --file src/staged.tmp ) 2>&1 >/dev/null )"
rc=$?
assert_status 0 "skip flag → exit 0 (even on would-be error)" bash -c "[[ $rc -eq 0 ]]"
assert_status 0 "stderr carries STANDARDS_SKIPPED marker" \
  bash -c "grep -q 'STANDARDS_SKIPPED' <<< '$stderr_out'"

# ── T-STD-S14: ~/.rein mirrors byte-identical ──────────────────────────────
echo ""
echo "  [T-STD-S14] ~/.rein mirrors byte-identical"

assert_status 0 "standards.json mirror"        diff -q "$STANDARDS_JSON" "${HOME}/.rein/shared/standards.json"
assert_status 0 "standards-checker mirror"     diff -q "$STD_CHECKER" "${HOME}/.rein/shared/standards-checker.mjs"
assert_status 0 "scripts/standards.mjs mirror" diff -q "$CLI"      "${HOME}/.rein/scripts/standards.mjs"

# ── T-STD-S15: scripts/standards.mjs locator chain (E-83) ───────────────────
echo ""
echo "  [T-STD-S15] CLI resolves standards-checker.mjs via dynamic locator chain"

# Synthetic install layout: <root>/scripts/standards.mjs + <root>/shared/standards-checker.mjs
# (matches ~/.rein/ tree). Asserts Candidate 2 of the locator chain.
INSTALL="${SSBOX}/installroot"
mkdir -p "${INSTALL}/scripts" "${INSTALL}/shared"
cp "$CLI"      "${INSTALL}/scripts/standards.mjs"
cp "$STD_CHECKER"  "${INSTALL}/shared/standards-checker.mjs"
cp "$STANDARDS_JSON" "${INSTALL}/shared/standards.json"
# E-225: the checker now imports the E-224 markdown classifier (so "executable markdown"
# has one definition). It is a real runtime dependency of the installed layout, and the
# installer ships it alongside — this fixture must mirror that or it tests a layout that
# does not exist.
cp "${REPO_ROOT}/src/shared/markdown-exec.mjs" "${INSTALL}/shared/markdown-exec.mjs"
cp "${REPO_ROOT}/src/shared/standards-test-rules.mjs" "${INSTALL}/shared/standards-test-rules.mjs"   # E-299 sibling

assert_status 0 "list-rules works from installed-mode layout (Candidate 2)" \
  bash -c "node '${INSTALL}/scripts/standards.mjs' list-rules --json >/dev/null 2>&1"

# Fail-closed: script alone with no checker anywhere reachable. Override HOME
# so the absolute Candidate 3 fallback also misses. Expect exit 1 + stderr marker.
ORPHAN="${SSBOX}/orphan"
mkdir -p "${ORPHAN}/scripts" "${ORPHAN}/fakehome"
tc_fixture_home "${ORPHAN}/fakehome"   # E-345 (D-109 r1): the record only; the checker stays absent, so the layout is still an orphan
cp "$CLI" "${ORPHAN}/scripts/standards.mjs"
stderr_out="$( HOME="${ORPHAN}/fakehome" node "${ORPHAN}/scripts/standards.mjs" list-rules 2>&1 >/dev/null )"
rc=$?
assert_status 0 "orphan layout → exit 1"                bash -c "[[ $rc -eq 1 ]]"
assert_status 0 "fail-closed stderr marker present"     \
  bash -c "grep -q '\[standards\] ERROR: standards-checker.mjs not found' <<< '$stderr_out'"

# ── E-250 (D-067 §4 / D-065 §1): counted suppressions, named exemptions ──────
#
# D-065 ruled that a false positive is silenced by an explicit greppable marker and a
# legitimately out-of-scope file is exempted BY NAME — and that both, being coverage
# REDUCTIONS, must be visible. The markers existed; nothing counted them, and the one
# by-name exemption was a hardcoded regex inside a rule where no report could reach it.
# A suppression nobody counts is indistinguishable from a rule that stopped working.
_e250_sandbox() {
  local d; d="$(test_tmpdir e250)"
  mkdir -p "$d/tests"
  printf '%s\n' 'trap "rm -rf /tmp/x" EXIT' > "$d/tests/plain_test.sh"  # standards:allow-raw-trap - fixture data
  printf '%s\n' 'trap "rm -rf /tmp/x" EXIT  # standards:allow-raw-trap - fixture data' \
    > "$d/tests/suppressed_test.sh"
  printf '%s\n' '# standards:allow-no_raw_exit_trap_in_tests' \
                 'trap "rm -rf /tmp/x" EXIT' > "$d/tests/above_test.sh"  # standards:allow-raw-trap - fixture data
  printf '%s\n' 'echo hi  # standards:allow-not-a-real-rule' > "$d/tests/typo_test.sh"
  printf '%s' "$d"
}
_E250="$(_e250_sandbox)"
_e250_check() { ( cd "$_E250" && node "$CLI" check --file "$1" 2>&1 ); }

# The rule still FIRES — everything below is meaningless if it does not.
_plain="$(_e250_check tests/plain_test.sh)"
assert_contains "E-250.01a: an unsuppressed raw EXIT trap is still an error" \
  "no_raw_exit_trap_in_tests" "$_plain"
assert_contains "E-250.01b: and the run reports zero suppressions" \
  "Active suppressions (# standards:allow-<rule>): 0" "$_plain"

# THE MARKER, on the flagged line and on the line above it (D-065 §1 allows both).
_sup="$(_e250_check tests/suppressed_test.sh)"
assert_status 1 "E-250.02a: a marked line produces NO violation" \
  bash -c "grep -q 'error' <<< \"\$_sup\""
assert_contains "E-250.02b: and the suppression is COUNTED, not silently swallowed" \
  "no_raw_exit_trap_in_tests: 1" "$_sup"
assert_contains "E-250.02c: with the file:line that carries it" "tests/suppressed_test.sh:1" "$_sup"

_above="$(_e250_check tests/above_test.sh)"
assert_status 1 "E-250.03a: a marker on the line ABOVE also suppresses" \
  bash -c "grep -q 'error' <<< \"\$_above\""
assert_contains "E-250.03b: and the rule_id form of the token works, not just the alias" \
  "no_raw_exit_trap_in_tests: 1" "$_above"

# A MARKER THAT MATCHES NOTHING is a finding: the author believed they had silenced
# something, and a marker that silences nothing reads to the next person as a reviewed
# and accepted exception.
_typo="$(_e250_check tests/typo_test.sh)"
assert_contains "E-250.04a: an unknown suppression token is reported" \
  "standards_suppression_unknown" "$_typo"
assert_contains "E-250.04b: at P1" "[P1]" "$_typo"
assert_contains "E-250.04c: and it lists the tokens that WOULD have matched" \
  "no_raw_exit_trap_in_tests" "$_typo"
# A typo in a comment must not block a commit — over-block is what D-056 governs against.
assert_contains "E-250.04d: it is a warning, not a commit-blocking error" "warnings: 1" "$_typo"

# THE SUMMARY PRINTS ON EVERY RUN, including the clean one. A section that appears only
# when there is something to say is indistinguishable from one that did not run — which is
# review question #5 (E-251) applied to a report instead of a scan.
assert_contains "E-250.05a: the suppression section prints even at zero" \
  "Active suppressions" "$_plain"
assert_contains "E-250.05b: and says (none) rather than omitting itself" "(none)" "$_plain"

# BY-NAME EXEMPTIONS come from standards.json, with their reasons, on every run — NOT from
# the files this run happened to touch. A staged-file run sees only the diff, so an
# exemption that vanished when its file was not staged would read as "none" almost always.
_n_exempt="$(python3 -c 'import json,sys; print(sum(len(r.get("exempt_files") or []) for r in json.load(open(sys.argv[1]))["rules"]))' "${REPO_ROOT}/src/shared/standards.json")"
assert_contains "E-250.06a: exemptions are listed from the config (${_n_exempt}, counted from standards.json)" \
  "By-name exemptions (standards.json): ${_n_exempt}" "$_plain"
assert_contains "E-250.06b: named by rule and path" "no_raw_exit_trap_in_tests" "$_plain"
assert_contains "E-250.06c: with the one-line reason D-065 requires" "reason:" "$_plain"
# The exemption must still WORK, or moving it was a deletion.
_runsh="$( cd "$REPO_ROOT" && node "$CLI" check --file tests/run.sh 2>&1 )"
assert_contains "E-250.06f: tests/run.sh is still exempt in the real repo" \
  "applied this run" "$_runsh"

echo ""

# ── E-302: the registry-drift checker's exit status says whether the registries agree ──
# check_registry_sync ran tests/suites/registry_sync_test.sh, which exited 0 on a failed check
# (assert_summary prints counts, it sets no status), so the gate could not block; when E-302 moved
# the checks, the old path vanished and `[[ -f ]] || return 0` would have passed silently.
_RD="${REPO_ROOT}/tests/tools/registry-drift.sh"
# E-302.RD1 (the hook names the checker) went with the hook's registry-drift gate (E-467).
_RD_HOME="$(test_tmpdir rdhome)"; mkdir -p "${_RD_HOME}/.rein/config"
printf '{"mcp_servers":{}}\n' > "${_RD_HOME}/.rein/config/registry.json"
assert_status 1 "E-302.RD2: a global registry missing the local servers fails the checker (the gate blocks)" \
  env HOME="$_RD_HOME" bash "$_RD"
cp "${REPO_ROOT}/src/config/registry.json" "${_RD_HOME}/.rein/config/registry.json"
assert_status 0 "E-302.RD3: …and a matching one passes" env HOME="$_RD_HOME" bash "$_RD"

# ── E-448 (D-165): a machine-local generated file is refused at commit ──────────────────────
# The whole hook, as `git commit` runs it, in a provisioned fixture project: the mirror is this
# tree's src/shared (machine-local.list included), so the only gate that can refuse is the one
# under test (E-464: no review stamp is asked for at commit). The Engineer role, so the Architect git lane
# (which keeps .claude/ out of an Architect commit) is not what answers.
echo ""
_ML_HOME="$(test_tmpdir mlhome)"; tc_link_shared "$_ML_HOME"
_ml_repo() {
  local d; d="$(test_tmpdir mlrepo)"
  ( cd "$d" && git init -q . && git config user.email t@t && git config user.name t && git config commit.gpgsign false
    mkdir -p .ai .claude docs && echo base > README && git add README && git commit -q --no-verify -m base
    printf '#!/bin/bash\nexec /bin/bash %q "$@"\n' "$HOOK" > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit )
  printf '%s' "$d"
}
_ml_state() {  # cwd = repo: an empty state view
  printf '{"tasks":[],"stamps":[]}\n' > .ai/state.json
}
_ml_commit() {  # <repo> → _OUT/_RC of `git commit` through the installed hook
  _OUT="$( cd "$1" && _ml_state && env HOME="$_ML_HOME" REIN_CALLER_ROLE=engineer \
           CLAUDE_CODE_SESSION_ID= git commit -qm t 2>&1 )"; _RC=$?
}
_M1="$(_ml_repo)"; ( cd "$_M1" && echo '{}' > .claude/settings.json && git add -f .claude/settings.json )
_ml_commit "$_M1"
assert_status 0 "E-448.01a: a staged .claude/settings.json is refused (rc ${_RC})" test "$_RC" -ne 0
assert_contains "E-448.01b: …as [MACHINE_LOCAL], naming the path and the fix" \
  "[MACHINE_LOCAL] .claude/settings.json is generated for this machine and never committed — run: git rm --cached .claude/settings.json" "$_OUT"
_M2="$(_ml_repo)"; ( cd "$_M2" && echo '{}' > .claude/settings.json && git add -f .claude/settings.json \
    && git commit -q --no-verify -m track && git rm -q --cached .claude/settings.json )
_ml_commit "$_M2"
assert_status 0 "E-448.02: staging its deletion (git rm --cached) commits — that is the fix (rc ${_RC})" test "$_RC" -eq 0
_M3="$(_ml_repo)"; ( cd "$_M3" && echo '{"ci":1}' > .ai/ci.local.json && git add -f .ai/ci.local.json )
_ml_commit "$_M3"
assert_contains "E-448.03: every path on shared/machine-local.list is refused, not only settings.json" \
  "[MACHINE_LOCAL] .ai/ci.local.json" "$_OUT"
_M4="$(_ml_repo)"; ( cd "$_M4" && echo '{"permissions":{}}' > .claude/settings.architect.json && git add .claude/settings.architect.json )
_ml_commit "$_M4"
assert_status 0 "E-448.04a: a role overlay without a home path commits (rc ${_RC})" test "$_RC" -eq 0
_M5="$(_ml_repo)"; ( cd "$_M5" && printf '{"x":"%s/x"}\n' "$_ML_HOME" > .claude/settings.architect.json && git add .claude/settings.architect.json )
_ml_commit "$_M5"
assert_contains "E-448.04b: …the same overlay holding \$HOME/ is refused" \
  "[MACHINE_LOCAL] .claude/settings.architect.json contains this machine's home directory" "$_OUT"
_M6="$(_ml_repo)"; ( cd "$_M6" && printf '{"x":"%s/x"}\n' "$_ML_HOME" > .mcp.json && git add .mcp.json )
_ml_commit "$_M6"
assert_contains "E-448.04c: a staged .mcp.json holding \$HOME/ is refused (the second place of r3)" \
  "[MACHINE_LOCAL] .mcp.json contains" "$_OUT"
# E-454 (D-167 r15; extends E-448.04b): a path holding a newline prints a one-line message.
_M8="$(_ml_repo)"; ( cd "$_M8" && printf '{"x":"%s/x"}\n' "$_ML_HOME" > $'.claude/a\nb.json' && git add $'.claude/a\nb.json' )
_ml_commit "$_M8"
_ML_WANT="$(printf '%q' $'.claude/a\nb.json')"   # $'.claude/a\nb.json' — one line
assert_contains "E-454.01: a path with a newline is refused on ONE [MACHINE_LOCAL] line, through %q" \
  "[MACHINE_LOCAL] ${_ML_WANT} contains this machine's home directory" "$_OUT"
_M7="$(_ml_repo)"; ( cd "$_M7" && printf 'see %s/x\n' "$_ML_HOME" > docs/x.md && git add docs/x.md )
_ml_commit "$_M7"
assert_status 0 "E-448.05: a doc naming the home path commits — no other path is scanned (rc ${_RC})" test "$_RC" -eq 0
assert_status 1 "E-448.06: the hook carries no copy of the list (D-165 r1)" grep -q "start\.local\.json" "$HOOK"

assert_summary
if [[ "${FAIL_COUNT:-0}" -eq 0 ]]; then
  echo "===== conflict_gate_test.sh PASS ====="
else
  echo "===== conflict_gate_test.sh FAIL (${FAIL_COUNT}) ====="
fi
