#!/usr/bin/env bash
# ai_sync_test.sh — `ai sync`: every step runs (E-247, D-067 §1), and what it prunes, mirrors
# and regenerates (sync_prune, path_rules, mcp_doc_sync, registry_sync, mcp, skill_prune,
# memory_palace_sync sections, merged in E-302).
#
# E-247 — every step of `ai sync` actually runs.
#
# THE BUG THIS SUITE EXISTS FOR. E-217 added an early `return 0` to do_sync to fix its exit
# status — the function used to return whatever ran last, and a stray 128 from a
# `git rev-parse` in a non-git directory made a clean sync look like a failure. The return
# was placed BEFORE the second half of the function, so from that commit onward:
#
#   install_git_hooks, _upgrade_legacy_git_hooks, _regenerate_mcp_docs,
#   _regenerate_blueprints_index, _wal_checkpoint_state_db, _generate_repo_map,
#   _generate_memory_palace, _ensure_generated_gitignore and _report_policy_staleness
#
# never ran, and `ai sync` never printed "Done." Nine ruled features were silently lost, for
# weeks, in a command run reflexively after every pull. Nothing failed. That is the whole
# difficulty: dead code does not raise anything, and the only visible symptom was a missing
# final line that nobody was checking for.
#
# WHY THE TEST IS SHAPED THIS WAY. Asserting "the source contains install_git_hooks" would
# have passed throughout the entire outage — the call was always there, just unreachable. So
# every assertion below reads the OUTPUT OF A REAL SYNC in a temp project. A step is proven
# to have run only by the marker it prints.
#
# A first restore attempt made `ai sync` EXIT 1 under `set -e` (E-244, reverted), which is
# why D-067 §1 rules each step fail-open with a printed reason: a step that breaks must say
# so and let the rest finish, never abort the command or resurrect the silent-loss failure
# in a new form.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AI="${REPO_ROOT}/src/bin/ai"

echo "── Suite: ai_sync_test ─────────────────────────────────────────────"

# The AST repo map is the most expensive step and its content is irrelevant here; the
# assertions below check that it REPORTS, and the skip notice is a report.
export AI_OS_DISABLE_REPO_MAP=1

# A project fixture. Deliberately NOT a git repository for the default case: `ai init`
# exited 128 there until E-244, and install_git_hooks is the first step of the restored
# half — so the non-git path is the one most likely to abort the whole command again.
_proj() {
  local d; d="$(test_tmpdir e247)"
  mkdir -p "$d/.ai" "$d/.claude"
  cat > "$d/.ai/roles.json" <<'JSON'
{ "roles": { "architect": {"provider":"claude","pane_identifier":"1","model":"fable"},
             "engineer":  {"provider":"claude","pane_identifier":"0","model":"opus"} } }
JSON
  cp "${REPO_ROOT}/src/templates/providers.json" "$d/.ai/providers.json" 2>/dev/null || true
  printf '%s' "$d"
}

_p="$(_proj)"
_out="$( cd "$_p" && bash "$AI" sync 2>&1 )"
_rc=$?

# ── E-247.1: the command completes and SAYS so ───────────────────────────────
# The missing final line was the only symptom the outage ever produced.
assert_contains "E-247.01a: 'ai sync' prints Done. — it did not for weeks" "Done." "$_out"
assert_status 0 "E-247.01b: and still exits 0 (the reason the early return was added)" \
  bash -c "[[ '$_rc' -eq 0 ]]"

# ── E-247.2: every restored step reports, by marker ──────────────────────────
# Each step is named by something it prints on the path a fixture actually takes. A step
# that is skipped prints its reason and still counts as reached — reachability is the
# property under test, not success.
assert_contains "E-247.02a: git hooks step runs (non-git fixture → its own notice)" \
  "Not a git repo" "$_out"
assert_contains "E-247.02b: mcp.md is regenerated from registry.json" \
  ".ai/blueprints/mcp.md" "$_out"
# NOT the bare "_INDEX.md": that substring also appears in "_SKILLS_INDEX.md", which the
# PROVISIONING half prints — so the loose form passed throughout the outage and would have
# gone on passing after a broken restore. Caught by running the reproducer before fixing
# anything, which is the point of running it first.
assert_contains "E-247.02c: the blueprint index is regenerated" \
  ".ai/blueprints/_INDEX.md" "$_out"
assert_contains "E-247.02d: the AST repo map step reports (skipped here by env)" \
  "REPO_MAP.md" "$_out"
assert_contains "E-247.02e: the Memory Palace candidate index is refreshed" \
  "palace-index.json" "$_out"

# ── E-247.3: the step summary ────────────────────────────────────────────────
# A count is what makes a SILENT loss loud. "Done." alone returned in E-217's shape too;
# the summary is what distinguishes "every step ran" from "the function reached its end".
assert_match "E-247.03a: a step summary is printed" \
  'steps: [0-9]+ ok' "$_out"
assert_status 1 "E-247.03b: and it is not a hardcoded zero" \
  bash -c "printf '%s' '$_out' | grep -q 'steps: 0 ok'"

# ── E-247.4 / E-339 (D-107 r1): a broken step is FAILED, loudly, and the rest still run ──
# The property that separates this restore from the one that had to be reverted: a step
# forced to fail must not abort the command. Since D-107 it must also not be counted as
# anything but FAILED: the ✗ line carries the step's own last stderr line and the path of its
# captured log, every later step still runs, and the exit status is 1. The forced failure
# runs through the same capture path as a real step (its stderr is a real process's).
_pf="$(_proj)"
_fout="$( cd "$_pf" && AI_OS_E247_FORCE_FAIL=repo_map bash "$AI" sync 2>&1 )"
_frc=$?
assert_match "E-247.04a: a failing step prints ✗ <step>: <its last stderr line>" \
  '✗ repo_map: forced failure \(AI_OS_E247_FORCE_FAIL=repo_map\)' "$_fout"
assert_match "E-339.04e: and the path of the captured stderr (E-346: the mktemp'd name)" \
  'ai-sync-repo_map\.[0-9]+\.[A-Za-z0-9]{6}\)' "$_fout"
assert_contains "E-247.04b: and the sync still completes" "Done." "$_fout"
assert_status 0 "E-339.04c: and exits 1 (D-107 r1 — a failed step is not a success)" \
  bash -c "[[ '$_frc' -eq 1 ]]"
assert_match "E-247.04d: the summary counts the failure as FAILED" \
  'steps: [0-9]+ ok, [0-9]+ skipped, 1 FAILED — see the ✗ lines' "$_fout"
assert_contains "E-339.04f: a step AFTER the failed one still ran" \
  "palace-index.json" "$_fout"

# ── E-247.5: the rollback ────────────────────────────────────────────────────
# D-067 §1 makes today's truncated behaviour available EXPLICITLY, so an operator who hits
# a bad step has a way back that does not involve editing the script.
_pm="$(_proj)"
_mout="$( cd "$_pm" && AI_OS_SYNC_MINIMAL=1 bash "$AI" sync 2>&1 )"
assert_status 1 "E-247.05a: AI_OS_SYNC_MINIMAL=1 stops after provisioning" \
  bash -c "printf '%s' '$_mout' | grep -q 'palace-index.json'"
assert_contains "E-247.05b: and says why it stopped, rather than looking finished" \
  "AI_OS_SYNC_MINIMAL=1" "$_mout"
assert_status 0 "E-247.05c: the minimal path still exits 0" \
  bash -c "cd '$_pm' && AI_OS_SYNC_MINIMAL=1 bash '$AI' sync >/dev/null 2>&1"

# ── E-247.6: the non-git case specifically ───────────────────────────────────
# install_git_hooks is the FIRST restored step and `git rev-parse` exits 128 outside a
# repository. Under `set -e` a plain assignment carried that status and killed the script
# (fixed in E-244); this pins that the whole tail still runs there.
_pg="$(_proj)"
_gout="$( cd "$_pg" && bash "$AI" sync 2>&1 )"
assert_contains "E-247.06a: a NON-git project reaches the end of sync" "Done." "$_gout"
# NOT a .gitignore assertion here: _ensure_generated_gitignore returns early outside a git
# work tree, and correctly so — a .gitignore in a directory git does not track is furniture.
# The step still has to have RUN, which the summary count below proves, and the file itself
# is asserted in the git fixture (06e).
assert_match "E-247.06b: and every step is accounted for in the non-git case" \
  'steps: [0-9]+ ok' "$_gout"

# A REAL git repository must reach the end too — the hook install actually does work there.
_pr="$(_proj)"
( cd "$_pr" && git init -q . && git config user.email t@t && git config user.name t )
_rout="$( cd "$_pr" && bash "$AI" sync 2>&1 )"
assert_contains "E-247.06c: a git project reaches the end as well" "Done." "$_rout"
assert_status 0 "E-247.06d: and the Gate 2 pre-commit stub was installed" \
  test -f "${_pr}/.git/hooks/pre-commit"
# E-233's generated-artefact patterns land where they mean something: inside a work tree.
assert_status 0 "E-247.06e: the generated-artefact .gitignore was written (E-233)" \
  test -f "${_pr}/.gitignore"
assert_status 0 "E-247.06f: and it names an artefact sync regenerates" \
  grep -q '_SKILLS_INDEX.md' "${_pr}/.gitignore"

# ── E-339 (D-107 r3): the gate sync leaves behind is probed ─────────────────────
# A HOME whose install mirror has no safe-exec analyzer is the shape that blocked every Bash
# call after the 2026-10-23 sync. Sync and doctor both say so with the repair command; sync
# never runs the installer itself (r4). The probe and the hook share one file: the analyzer
# invocation lives in src/shared/gate-probe.sh only.
_ph="$(test_tmpdir e339home)"
tc_fixture_home "$_ph"   # E-345 (D-109 r1): the toolchain record the hooks pin
mkdir -p "$_ph/.ai-os/mcp/ast-parser-mcp"
# The same HOME carries an ast-parser CLI that exits 1, so the REPO_MAP step fails for real
# (no AI_OS_E247_FORCE_FAIL): its own stderr tail must be the ✗ line (D-107 r2).
printf '%s\n' 'process.stderr.write("noise\n\nparse failed: grammar wasm missing\n"); process.exit(1);' \
  > "$_ph/.ai-os/mcp/ast-parser-mcp/index.js"
_pb="$(_proj)"
_bout="$( cd "$_pb" && HOME="$_ph" AI_OS_DISABLE_REPO_MAP= bash "$AI" sync 2>&1 )"
_brc=$?
assert_match "E-339.07a: sync prints ✗ gate_check: [SAFE_EXEC_BROKEN] with the repair command" \
  '✗ gate_check: \[SAFE_EXEC_BROKEN\] .* — run: bash install-ai-os\.sh' "$_bout"
assert_status 0 "E-339.07b: and exits 1" bash -c "[[ '$_brc' -eq 1 ]]"
assert_match "E-339.07f: a real ast-parser exit 1 prints ✗ repo_map: <its last stderr line>" \
  '✗ repo_map: parse failed: grammar wasm missing \(log: ' "$_bout"
assert_match "E-339.07g: and both failures are counted" \
  'steps: [0-9]+ ok, [0-9]+ skipped, 2 FAILED' "$_bout"
_dout="$( cd "$_pb" && HOME="$_ph" bash "$AI" doctor 2>&1 )"
assert_contains "E-339.07c: doctor prints the same [SAFE_EXEC_BROKEN] finding" \
  "[SAFE_EXEC_BROKEN]" "$_dout"
assert_status 1 "E-339.07d: the hook and src/bin/ai carry no analyzer invocation of their own" \
  grep -nE -- '--check(-path)? "\$' "${REPO_ROOT}/hooks/pre-tool-use.sh" "${REPO_ROOT}/src/bin/ai"
assert_status 0 "E-339.07e: gate-probe.sh carries it" \
  grep -qE -- '--check "\$' "${REPO_ROOT}/src/shared/gate-probe.sh"

# ── E-346 (D-109 r2): step logs are mktemp'd and reaped ──────────────────────────
# A private TMPDIR so the reaper's victims and survivors are the only files there. The old
# fixed name `ai-sync-<step>.<pid>.log` is pre-planted as a symlink: the pid is known because
# the subshell execs sync in place, so this is exactly the name E-339 would have written.
_lt="$(test_tmpdir e346tmp)"
_victim="$(test_tmpdir e346victim)/target"
printf 'untouched\n' > "$_victim"
_ts() { node -e 'const fs=require("fs");const t=Date.now()/1000-Number(process.argv[2])*3600;fs.utimesSync(process.argv[1],t,t)' "$1" "$2"; }
for _f in ai-sync-foo.1.abcdef ai-sync-foo.1.ghijkl ai-sync-foo.1.log; do printf 'x\n' > "$_lt/$_f"; done
_ts "$_lt/ai-sync-foo.1.abcdef" 25; _ts "$_lt/ai-sync-foo.1.ghijkl" 1; _ts "$_lt/ai-sync-foo.1.log" 25
_pl="$(_proj)"
_lout="$( cd "$_pl" && TMPDIR="$_lt" AI_OS_E247_FORCE_FAIL=repo_map \
  bash -c 'ln -s "$1" "${TMPDIR}/ai-sync-repo_map.${BASHPID}.log" && exec bash "$2" sync' _ "$_victim" "$AI" 2>&1 )"
assert_status 0 "E-346.01a: the pre-planted symlink at the old fixed path is never followed" \
  bash -c "[[ \"\$(cat '$_victim')\" == untouched ]]"
assert_status 0 "E-346.01b: and is left as it was" \
  bash -c "[[ -L \"\$(printf '%s' '$_lt'/ai-sync-repo_map.*.log)\" ]]"
_llog="$(printf '%s' "$_lout" | sed -nE 's/.*✗ repo_map: .*\(log: (.*)\)$/\1/p' | head -1)"
assert_match "E-346.01c: the ✗ line names the mktemp'd log" \
  "^${_lt}/ai-sync-repo_map\.[0-9]+\.[A-Za-z0-9]{6}\$" "$_llog"
assert_status 0 "E-346.01d: and that log holds the step's stderr" \
  grep -q 'forced failure' "${_llog:-/nonexistent}"
assert_status 1 "E-346.02a: a 25 h-old ai-sync-*.?????? log of the caller is removed at start" \
  test -e "$_lt/ai-sync-foo.1.abcdef"
assert_status 0 "E-346.02b: a 1 h-old one survives (a concurrent sync's)" \
  test -e "$_lt/ai-sync-foo.1.ghijkl"
assert_status 0 "E-346.02c: a 25 h-old file outside the template survives (chown needs root here)" \
  test -e "$_lt/ai-sync-foo.1.log"
# A missing TMPDIR aborts the provisioning half before any step, so the step's own mktemp
# failure is observed at function level, with mktemp stubbed to fail.
_mout="$( cd "$_pl" && bash -c "source '$AI' >/dev/null 2>&1; mktemp() { return 1; }; _sync_step log_reap touch '$_lt/ran'; echo failed=\$_SYNC_STEPS_FAILED" 2>&1 )"
assert_match "E-346.02d: mktemp failing is the step FAILING with [LOG_UNAVAILABLE]" \
  '✗ log_reap: \[LOG_UNAVAILABLE\]' "$_mout"
assert_contains "E-346.02e: counted FAILED" "failed=1" "$_mout"
assert_status 1 "E-346.02f: and the step is not run without a log" test -e "$_lt/ran"

# ── E-346 (D-109 r3): a reaper that crashes has FAILED ──────────────────────────
# The fixture ai-clean.mjs sits in the HOME's install mirror, which ai_os_locate resolves
# first for a project that is not the framework clone.
_rh="$(test_tmpdir e346home)"
tc_fixture_home "$_rh"   # E-345 (D-109 r1)
printf '%s\n' 'process.stderr.write("reaper exploded\n"); process.exit(1);' > "$_rh/.ai-os/shared/ai-clean.mjs"
_rout2="$( cd "$_pl" && HOME="$_rh" bash "$AI" sync 2>&1 )"
_rrc=$?
assert_match "E-346.03a: a fixture ai-clean.mjs exiting 1 yields ✗ run_reap: <its stderr>" \
  '✗ run_reap: reaper exploded \(log: ' "$_rout2"
assert_status 0 "E-346.03b: and ai sync exits 1" bash -c "[[ '$_rrc' -eq 1 ]]"
assert_match "E-346.03c: the watcher reaper fails the same way" '✗ watcher_reap: reaper exploded' "$_rout2"
printf '%s\n' 'process.stdout.write("nope\n");' > "$_rh/.ai-os/shared/ai-clean.mjs"
_reap() { ( cd "$_pl" && HOME="$_rh" "$@" bash -c "source '$AI' >/dev/null 2>&1; _sync_step run_reap _sync_reap_run_records; echo \"ok=\$_SYNC_STEPS_OK skipped=\$_SYNC_STEPS_SKIPPED failed=\$_SYNC_STEPS_FAILED\"" 2>&1 ); }
_bad="$(_reap env)"
assert_match "E-346.03d: exit 0 with output that is not JSON is [REAP_BAD_OUTPUT] <output>" \
  '✗ run_reap: \[REAP_BAD_OUTPUT\] nope' "$_bad"
assert_contains "E-346.03e: and counted FAILED" "failed=1" "$_bad"
assert_contains "E-346.03f: AI_OS_CLEAN_DISABLE=1 is still a by-design skip" \
  "ok=0 skipped=1 failed=0" "$(_reap env AI_OS_CLEAN_DISABLE=1)"
printf '%s\n' 'process.stdout.write(JSON.stringify({moved:[{}]}));' > "$_rh/.ai-os/shared/ai-clean.mjs"
assert_contains "E-346.03g: the helper's JSON still counts what it moved" \
  "Reaped 1 dead ~/.ai-os/run/ record(s)" "$(_reap env)"
# ai-clean reports a failed move in its JSON with exit 2 and NO stderr. That made the ✗ line's
# own grep exit 1 under pipefail and set -e killed the sync: the first CI run of E-346 lost
# "Done." and every later step (two reapers racing over a shared HOME's dead records).
printf '%s\n' 'process.stdout.write(JSON.stringify({moved:[],failures:["/x/build-1.json: EACCES"]})); process.exit(2);' \
  > "$_rh/.ai-os/shared/ai-clean.mjs"
_silent="$(_reap env)"
assert_match "E-346.03h: a failed move named only in the JSON is ✗ run_reap: [REAP_FAILED] <it>" \
  '✗ run_reap: \[REAP_FAILED\] /x/build-1\.json: EACCES' "$_silent"
# E-352 (D-112 r6): the cause was cut at 200 chars (and a newline in it ended the line), so a long
# path hid the reason. The ✗ line carries the whole cause, folded onto one line.
_long="/x/$(printf 'd%.0s' $(seq 480))/build-1.json"
printf 'process.stdout.write(JSON.stringify({moved:[],failures:[%s]})); process.exit(2);\n' \
  "$(node -e 'console.log(JSON.stringify(process.argv[1]+": EACCES\npermission denied"))' "$_long")" \
  > "$_rh/.ai-os/shared/ai-clean.mjs"
_whole="$(_reap env)"
assert_contains "E-352.06: a 500-char cause prints whole on one ✗ line, newlines folded" \
  "✗ run_reap: [REAP_FAILED] ${_long}: EACCES permission denied (log: " "$_whole"
assert_contains "E-346.03i: and the caller survives a step that failed with no stderr at all" \
  "failed=1" "$( cd "$_pl" && bash -c "source '$AI' >/dev/null 2>&1; _sync_step silent false; echo failed=\$_SYNC_STEPS_FAILED" 2>&1 )"

# ── E-346 (D-109 r3): the audited steps keep their exit status ──────────────────
printf '%s\n' 'process.stderr.write("probe crashed\n"); process.exit(3);' > "$_rh/probe.mjs"
_sl="$( cd "$_pl" && bash -c "source '$AI' >/dev/null 2>&1; ai_os_locate() { printf %s '$_rh/probe.mjs'; }; _sync_step stale_servers _report_stale_servers; echo failed=\$_SYNC_STEPS_FAILED" 2>&1 )"
assert_match "E-346.04a: a crashing build-stamp probe is ✗ stale_servers, not 'no stale servers'" \
  '✗ stale_servers: probe crashed' "$_sl"
_cp="$(test_tmpdir e346cb)/cb.py"
printf '%s\n' 'print("ERROR\tKeyError: boom"); raise SystemExit(6)' > "$_cp"
_cl="$( cd "$_pl" && HOME="$_rh" bash -c "source '$AI' >/dev/null 2>&1; _cb_py() { printf %s '$_cp'; }; _sync_step classifier _classifier_refresh_all; echo failed=\$_SYNC_STEPS_FAILED" 2>&1 )"
assert_match "E-346.04b: a classifier refresh ERROR is ✗ classifier (it printed ✗ and counted ok)" \
  '✗ classifier: .*could not refresh .*KeyError: boom' "$_cl"
assert_contains "E-346.04c: and counted FAILED" "failed=1" "$_cl"

echo ""

# ── E-220 (from sync_prune — E-302): manifest-scoped pruning in ai sync ──
# The sections below ran without the repo-map skip the E-247 section exports.
unset AI_OS_DISABLE_REPO_MAP
# E-220 (D-056 R2): manifest-scoped pruning in `ai sync`.
#
# `ai sync` was purely additive: after the E-217 rename the old `ai-task` directories
# survived in every workspace forever. The obvious fix — "delete anything not in the
# source" — is the dangerous one, because a user's own skill is exactly "not in the
# source". So a path is deleted ONLY when all three hold: sync wrote it (manifest),
# nobody has edited it since (hash), and it is gone upstream (source set).
#
# The assertions below are deliberately weighted toward the KEEP direction. Over-pruning
# is data loss caused by housekeeping; under-pruning just leaves a stale directory. Every
# deletion case therefore carries a paired survival case in the same fixture.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SM="${REPO_ROOT}/src/shared/sync-manifest.mjs"
AI_BIN="${REPO_ROOT}/src/bin/ai"


_mkskill() { mkdir -p "$1/$2"; printf -- "---\nname: %s\n---\nbody %s\n" "$2" "${3:-x}" > "$1/$2/SKILL.md"; }
_sm() { node --no-warnings "$SM" "$@" 2>&1; }

# ── E-220.1: a first run has no evidence and must prune NOTHING ──────────────
T1="$(mktemp -d)"; D1="$T1/dst"; mkdir -p "$D1"
_mkskill "$D1" alpha; _mkskill "$D1" leftover; _mkskill "$D1" users-own
# Run 1: sync provides (and so WROTE) alpha and leftover. users-own was already there.
printf '["alpha","leftover"]' > "$T1/names.json"
_o="$(_sm apply "$D1" "$T1/names.json")"
assert_status 0 "E-220.01a: a pre-existing skill survives the first (manifest-less) run" test -d "$D1/users-own"
assert_status 0 "E-220.01b: alpha survives the first run"                   test -d "$D1/alpha"
assert_contains "E-220.01c: the reason names the missing manifest" "no manifest yet" "$_o"
assert_status 0 "E-220.01d: the run records a manifest for next time" test -f "$D1/_SYNC_MANIFEST.json"
# E-273: the manifest records only what sync WROTE. Recording everything present put
# users-own into it, and the second run then deleted it as "sync-written, unmodified,
# no longer in the source set".
assert_status 1 "E-220.01e: the manifest does not claim the user's skill" \
  grep -q '"users-own"' "$D1/_SYNC_MANIFEST.json"

# ── E-220.2: write -> rename -> prune, the shape E-217 left behind ───────────
printf '["alpha"]' > "$T1/names.json"   # leftover was renamed away upstream
_o="$(_sm apply "$D1" "$T1/names.json")"
assert_status 0 "E-220.02d: a user-authored skill survives the SECOND run (E-273 regression)" test -d "$D1/users-own"
_o3="$(_sm apply "$D1" "$T1/names.json")"
assert_status 0 "E-220.02e: …and the third" test -d "$D1/users-own"
assert_contains "E-220.02f: it is reported as user-authored" "users-own — not written by sync (user-authored)" "$_o3"

# E-273 (critic_security P1): a v1 manifest written by the OLD apply already claims the
# user's skill with its real hash. Trusting it would delete the skill on the first
# upgraded sync; a v1 manifest is therefore treated as absent.
T1b="$(mktemp -d)"; D1b="$T1b/dst"; mkdir -p "$D1b"
_mkskill "$D1b" alpha; _mkskill "$D1b" poisoned-user-skill
_h="$(shasum -a 256 "$D1b/poisoned-user-skill/SKILL.md" | cut -d' ' -f1)"
_ha="$(shasum -a 256 "$D1b/alpha/SKILL.md" | cut -d' ' -f1)"
printf '{"version":1,"written_at":"2026-09-01T00:00:00Z","entries":{"alpha":"%s","poisoned-user-skill":"%s"}}\n' "$_ha" "$_h" \
  > "$D1b/_SYNC_MANIFEST.json"
printf '["alpha"]' > "$T1b/names.json"
_o1b="$(_sm apply "$D1b" "$T1b/names.json")"
assert_status 0 "E-220.02g: a user skill claimed by a poisoned v1 manifest survives" test -d "$D1b/poisoned-user-skill"
assert_contains "E-220.02h: the v1 manifest is treated as absent" "no manifest yet" "$_o1b"
assert_status 0 "E-220.02i: the manifest is rewritten as v2" grep -q '"version": 2' "$D1b/_SYNC_MANIFEST.json"
assert_status 1 "E-220.02j: …without the user's skill" grep -q '"poisoned-user-skill"' "$D1b/_SYNC_MANIFEST.json"
rm -rf "$T1b"
assert_status 1 "E-220.02a: second run prunes the sync-written, now-absent skill" test -d "$D1/leftover"
assert_status 0 "E-220.02b: a skill STILL in the source set is untouched"        test -d "$D1/alpha"
assert_contains "E-220.02c: the prune states all three grounds" "no longer in the source set" "$_o"

# ── E-220.3: a user-authored skill is never pruned ───────────────────────────
# The case the whole design exists for: absence from the source set is NOT evidence
# that a file is disposable.
T2="$(mktemp -d)"; D2="$T2/dst"; mkdir -p "$D2"
_mkskill "$D2" alpha
_sm record "$D2" >/dev/null            # manifest records ONLY alpha
_mkskill "$D2" my-own-skill "handwritten"
printf '["alpha"]' > "$T2/names.json"
_o="$(_sm apply "$D2" "$T2/names.json")"
assert_status 0 "E-220.03a: a skill sync never wrote is kept" test -d "$D2/my-own-skill"
assert_contains "E-220.03b: it is reported, not silently kept" "not written by sync" "$_o"

# ── E-220.4: a MODIFIED synced skill is kept and reported ────────────────────
# Sync wrote it, but a user edit outranks our bookkeeping.
T3="$(mktemp -d)"; D3="$T3/dst"; mkdir -p "$D3"
_mkskill "$D3" alpha; _mkskill "$D3" gone
_sm record "$D3" >/dev/null
printf -- "---\nname: gone\n---\nEDITED BY THE USER\n" > "$D3/gone/SKILL.md"
printf '["alpha"]' > "$T3/names.json"
_o="$(_sm apply "$D3" "$T3/names.json")"
assert_status 0 "E-220.04a: an edited synced skill survives" test -d "$D3/gone"
assert_contains "E-220.04b: the edit is the stated reason" "modified since sync wrote it" "$_o"

# ── E-220.5: --prune-known removes ONLY a byte-identical leftover ────────────
# The E-217 shape specifically: a workspace's `skills/ai-task` holding an exact copy of a
# skill that now lives under another name. Identity is the evidence — a byte-for-byte
# match with a CURRENT canonical skill carries nothing a user could lose.
T4="$(mktemp -d)"; S4="$T4/src"; D4="$T4/dst"; mkdir -p "$S4" "$D4"
_mkskill "$S4" arch-task "TASKBODY"
_mkskill "$D4" arch-task "TASKBODY"
cp -R "$D4/arch-task" "$D4/ai-task"          # a true copy, as a rename leaves behind
_mkskill "$D4" genuinely-mine "DIFFERENT"
printf '["arch-task"]' > "$T4/names.json"; printf '["%s"]' "$S4" > "$T4/canon.json"
_o="$(_sm apply "$D4" "$T4/names.json" --prune-known --canon "$T4/canon.json")"
assert_status 1 "E-220.05a: the byte-identical leftover is removed" test -d "$D4/ai-task"
assert_status 0 "E-220.05b: a DIFFERENT orphan is kept"             test -d "$D4/genuinely-mine"
assert_status 0 "E-220.05c: the canonical skill itself is kept"     test -d "$D4/arch-task"
assert_contains "E-220.05d: identity is the stated ground" "byte-identical" "$_o"

# Without the flag the same fixture must keep everything — the flag is the whole
# difference, so a default-on regression fails here.
T5="$(mktemp -d)"; S5="$T5/src"; D5="$T5/dst"; mkdir -p "$S5" "$D5"
_mkskill "$S5" arch-task "TASKBODY"; _mkskill "$D5" arch-task "TASKBODY"
cp -R "$D5/arch-task" "$D5/ai-task"
printf '["arch-task"]' > "$T5/names.json"; printf '["%s"]' "$S5" > "$T5/canon.json"
_sm apply "$D5" "$T5/names.json" --canon "$T5/canon.json" >/dev/null
assert_status 0 "E-220.05e: WITHOUT --prune-known the identical leftover stays" test -d "$D5/ai-task"

# ── E-220.6: refuse to prune when the source list is unusable ────────────────
# An empty source set makes every entry look "gone upstream". Exiting non-zero rather
# than pruning against nothing is the difference between a no-op and wiping a workspace.
T6="$(mktemp -d)"; D6="$T6/dst"; mkdir -p "$D6"; _mkskill "$D6" alpha
_sm record "$D6" >/dev/null
assert_status 3 "E-220.06a: a missing source list refuses to prune" \
  node --no-warnings "$SM" apply "$D6" "$T6/absent.json"
printf 'not json' > "$T6/bad.json"
assert_status 3 "E-220.06b: an unparseable source list refuses to prune" \
  node --no-warnings "$SM" apply "$D6" "$T6/bad.json"
printf '{"alpha":1}' > "$T6/obj.json"
assert_status 3 "E-220.06c: a non-array source list refuses to prune" \
  node --no-warnings "$SM" apply "$D6" "$T6/obj.json"
assert_status 0 "E-220.06d: alpha survived all three refusals" test -d "$D6/alpha"

# A corrupt manifest degrades to "no evidence", never to "prune everything".
printf 'garbage{' > "$D6/_SYNC_MANIFEST.json"
printf '[]' > "$T6/empty.json"
_o="$(_sm apply "$D6" "$T6/empty.json")"
assert_status 0 "E-220.06e: a corrupt manifest keeps everything" test -d "$D6/alpha"

# ── E-220.7: the manifest itself is never treated as a managed entry ─────────
_o="$(_sm plan "$D6" "$T6/empty.json")"
assert_not_contains "E-220.07a: _SYNC_MANIFEST.json is not a prune candidate" "_SYNC_MANIFEST" "$_o"
assert_not_contains "E-220.07b: the generated index is not a prune candidate" "_SKILLS_INDEX" "$_o"

# ── E-220.8: plan is read-only, apply is the only mode that deletes ──────────
T7="$(mktemp -d)"; D7="$T7/dst"; mkdir -p "$D7"; _mkskill "$D7" alpha; _mkskill "$D7" stale
_sm record "$D7" >/dev/null
printf '["alpha"]' > "$T7/names.json"
_o="$(_sm plan "$D7" "$T7/names.json")"
assert_contains "E-220.08a: plan reports the prune"  "PRUNE stale" "$_o"
assert_status 0 "E-220.08b: plan deletes nothing"    test -d "$D7/stale"
_sm apply "$D7" "$T7/names.json" >/dev/null
assert_status 1 "E-220.08c: apply performs it"       test -d "$D7/stale"

# ── E-220.9: `ai sync` end-to-end in a NON-GIT dir exits 0 ───────────────────
# A fresh clone has no manifest anywhere, and the helper is located relative to the
# repo root — which `git rev-parse` cannot supply here. Exiting non-zero would break
# every fresh install, so this is the case that guards the locator's fallback.
T8="$(mktemp -d)"; mkdir -p "$T8/.ai"
cp "${REPO_ROOT}/.ai/roles.json" "$T8/.ai/roles.json" 2>/dev/null || true
_o="$(cd "$T8" && AI_OS_HOME="${AIOS:-$HOME/.ai-os}" bash "$AI_BIN" sync 2>&1)"; _rc=$?
# E-346: a FAILED step is what makes it exit 1 — name its ✗ line(s) in the label, or a red run
# says only "got 1" (the case the shared CI HOME hit after the reapers stopped masking).
_x="$(printf '%s\n' "$_o" | grep '✗' | tr '\n' ' ' | cut -c1-400)"
assert_status 0 "E-220.09a: sync exits 0 in a fresh non-git dir${_x:+ — $_x}" test "$_rc" -eq 0
assert_not_contains "E-220.09b: no unbound-variable abort" "unbound variable" "$_o"
assert_status 0 "E-220.09c: the workspace was still provisioned" test -d "$T8/.claude/skills"

# ── E-220.11: the REAL `ai sync` prunes end-to-end ───────────────────────────
# Case 09 asserts exit 0, and a silently SKIPPED prune satisfies that just as well as a
# working one — which is how the first cut shipped a locator that resolved
# `git rev-parse --show-toplevel` (the USER's repo, not the AI-OS install) and never ran
# at all. These assertions pin the observable effect, not the exit code.
TA="$(mktemp -d)"; mkdir -p "$TA/.ai"
# The fixture decides its own binding rather than copying this repo's roles.json.
# (E-254: v4 provisions .claude/ only, so the former "every provisioned workspace is
# covered" case 11b has no second workspace to cover and was removed.)
cat > "$TA/.ai/roles.json" <<'JSON'
{ "roles": { "architect": {"provider":"claude","pane_identifier":"1","model":"fable"},
             "engineer":  {"provider":"claude","pane_identifier":"0","model":"opus"} } }
JSON
(cd "$TA" && bash "$AI_BIN" sync >/dev/null 2>&1)
assert_status 0 "E-220.11a: the first real sync records a manifest" \
  test -f "$TA/.claude/skills/_SYNC_MANIFEST.json"
# A renamed-away skill: a copy sync itself recorded, now absent upstream.
_seed="$(find "$TA/.claude/skills" -maxdepth 1 -mindepth 1 -type d | head -1)"
cp -R "$_seed" "$TA/.claude/skills/zz-renamed-away"
mkdir -p "$TA/.claude/skills/zz-user-authored"
printf -- "---\nname: zz-user-authored\n---\nmine\n" > "$TA/.claude/skills/zz-user-authored/SKILL.md"
node --no-warnings "$SM" record "$TA/.claude/skills" >/dev/null 2>&1
python3 - "$TA/.claude/skills/_SYNC_MANIFEST.json" <<'PYX'
import json,sys
p=sys.argv[1]; m=json.load(open(p))
m["entries"].pop("zz-user-authored", None)   # sync never wrote this one
json.dump(m, open(p,"w"))
PYX
_o="$(cd "$TA" && bash "$AI_BIN" sync 2>&1)"
assert_status 1 "E-220.11c: the real sync prunes the renamed-away copy" \
  test -d "$TA/.claude/skills/zz-renamed-away"
assert_status 0 "E-220.11d: it keeps the user-authored skill beside it" \
  test -d "$TA/.claude/skills/zz-user-authored"
assert_contains "E-220.11e: the prune is reported to the user" "pruned zz-renamed-away" "$_o"
assert_contains "E-220.11f: the kept orphan is reported too" "orphan (kept) zz-user-authored" "$_o"
# The rollback flag must reach the real command path, not just the helper.
cp -R "$_seed" "$TA/.claude/skills/zz-renamed-again"
node --no-warnings "$SM" record "$TA/.claude/skills" >/dev/null 2>&1
(cd "$TA" && AI_OS_NO_PRUNE=1 bash "$AI_BIN" sync >/dev/null 2>&1)
assert_status 0 "E-220.11g: AI_OS_NO_PRUNE=1 leaves the leftover in place" \
  test -d "$TA/.claude/skills/zz-renamed-again"
rm -rf "$TA"

# ── D-099 (E-322): sync reaps the removed watcher's project leftovers ─────────
# The watcher lock, its signal queue and the queue's write lock are registry entries
# (watcher-lock, watcher-signal-queue, watcher-signal-lock) that `ai sync` applies on every
# run. The step function is called directly under a throwaway HOME, so the trash it writes
# never lands in the operator's ~/.ai-os; S0 pins that do_sync runs it. Extends E-220.11.
_WR="$(test_tmpdir syncreap)"; _WH="$(test_tmpdir syncreaphome)"
tc_fixture_home "$_WH"   # E-345 (D-109 r1): the toolchain record the hooks pin
_wr_seed() {  # <project> <pid for the lock>
  mkdir -p "$1/.ai/.ai-watch.lock" "$1/.ai/signal.json.lock"
  printf '%s\n' "$2" > "$1/.ai/.ai-watch.lock/pid"; printf '[]\n' > "$1/.ai/signal.json"; : > "$1/.ai/LOG.md"
}
_wr_sync() { ( cd "$1" && HOME="$_WH" bash -c "source '$AI_BIN' >/dev/null 2>&1; _sync_reap_watcher_state" 2>&1 ); }
assert_status 0 "E-322.S0: do_sync runs the watcher reap step" grep -qE '_sync_step watcher_reap +_sync_reap_watcher_state' "$AI_BIN"
_wr_seed "$_WR/dead" 999999
_o="$(_wr_sync "$_WR/dead")"
assert_status 1 "E-322.S1: a dead watcher's lock is reaped" test -e "$_WR/dead/.ai/.ai-watch.lock"
assert_status 1 "E-322.S2: …with its signal queue" test -e "$_WR/dead/.ai/signal.json"
assert_status 1 "E-322.S3: …and the queue's write lock" test -e "$_WR/dead/.ai/signal.json.lock"
assert_contains "E-322.S4: the reap is reported with its restore command" "ai clean --restore" "$_o"
_wr_seed "$_WR/live" "$$"
_wr_sync "$_WR/live" >/dev/null
assert_status 0 "E-322.S5: a lock whose pid is alive is kept" test -e "$_WR/live/.ai/.ai-watch.lock"
assert_status 0 "E-322.S6: …and so is the queue it guards" test -e "$_WR/live/.ai/signal.json"

# ── E-220.12: helpers resolve relative to the SCRIPT, never the user's repo ──
# `git rev-parse --show-toplevel` inside a user project resolves to THEIR repo, so a
# project containing src/shared/<helper>.mjs got that file executed by node and its
# stdout trusted — the E-219 F3 shape.
assert_status 1 "E-220.12a: no locator resolves a helper via git rev-parse" \
  bash -c "grep -q 'rev-parse --show-toplevel.*/src/shared/' '$AI_BIN'"

# ── E-220.10: the rollback flag genuinely disables pruning ───────────────────
T9="$(mktemp -d)"; D9="$T9/dst"; mkdir -p "$D9"; _mkskill "$D9" alpha; _mkskill "$D9" stale
_sm record "$D9" >/dev/null
printf '["alpha"]' > "$T9/names.json"
assert_status 0 "E-220.10a: AI_OS_NO_PRUNE=1 is honoured by the shell caller" \
  bash -c "grep -q 'AI_OS_NO_PRUNE' '$AI_BIN'"
assert_status 0 "E-220.10b: pruning is wired into the provisioner, not one workspace" \
  bash -c "grep -q '_prune_workspace_dir \"\${ws}/skills\"' '$AI_BIN'"

# ── E-254 (D-069 §Components 2): legacy v3 workspaces are pruned on evidence ──
# A v3 project still carries the two retired provider workspaces and their shims. `ai
# sync` removes what the sync manifest proves it wrote and nobody changed, and prints
# every other leftover with the exact `rm` — the E-220 rule, applied to a directory that
# has no source set at all.
#
# SANCTIONED GREP EXCEPTION (E-254): the four legacy path literals below are the ones
# _prune_legacy_workspaces necessarily names. They are confined to this block and to the
# _lg_* fixture helpers; nothing else in tests/ may name them.
_LG_DIR_A=".gemini"; _LG_DIR_B=".agents"; _LG_SHIM_A="GEMINI.md"; _LG_SHIM_B="AGENTS.md"

# _lg_fixture → a non-git all-Claude project holding both legacy workspaces:
#   DIR_A: agents/synced.md + skills/synced-skill   — both recorded, unmodified
#   DIR_B: skills/synced (recorded, unmodified), skills/edited (recorded, then EDITED),
#          skills/mine (NEVER recorded — user-authored)
_lg_fixture() {
  local d; d="$(mktemp -d)"
  mkdir -p "$d/.ai"
  cat > "$d/.ai/roles.json" <<'JSON'
{ "roles": { "architect": {"provider":"claude","pane_identifier":"1"},
             "engineer":  {"provider":"claude","pane_identifier":"0"} } }
JSON
  mkdir -p "$d/${_LG_DIR_A}/agents" "$d/${_LG_DIR_A}/skills"
  printf -- "---\nname: synced\n---\nagent\n" > "$d/${_LG_DIR_A}/agents/synced.md"
  _mkskill "$d/${_LG_DIR_A}/skills" synced-skill
  node --no-warnings "$SM" record "$d/${_LG_DIR_A}/agents" >/dev/null 2>&1
  node --no-warnings "$SM" record "$d/${_LG_DIR_A}/skills" >/dev/null 2>&1
  mkdir -p "$d/${_LG_DIR_B}/skills"
  _mkskill "$d/${_LG_DIR_B}/skills" synced
  _mkskill "$d/${_LG_DIR_B}/skills" edited "as-synced"
  node --no-warnings "$SM" record "$d/${_LG_DIR_B}/skills" >/dev/null 2>&1
  printf -- "---\nname: edited\n---\nEDITED BY THE USER\n" > "$d/${_LG_DIR_B}/skills/edited/SKILL.md"
  _mkskill "$d/${_LG_DIR_B}/skills" mine "handwritten"
  printf '%s' "$d"
}
_lg_sync() { ( cd "$1" && shift && env AI_OS_DISABLE_REPO_MAP=1 "$@" bash "$AI_BIN" sync 2>&1 ); }

# (a) + (b) in ONE fixture: every deletion is paired with a survival beside it.
LG1="$(_lg_fixture)"
_o="$(_lg_sync "$LG1")"
# (a) manifest-owned + unmodified → pruned, and the whole directory goes with it.
assert_status 1 "E-254.01a: a recorded, unmodified legacy agent is pruned" \
  test -f "$LG1/${_LG_DIR_A}/agents/synced.md"
assert_status 1 "E-254.01b: a fully-prunable legacy workspace directory is removed" \
  test -d "$LG1/${_LG_DIR_A}"
assert_contains "E-254.01c: the removal is announced" \
  "pruned legacy workspace: ${_LG_DIR_A}" "$_o"
assert_status 1 "E-254.01d: the recorded, unmodified skill beside the user's is pruned too" \
  test -d "$LG1/${_LG_DIR_B}/skills/synced"
# (b) not in the manifest, or modified since sync wrote it → kept and reported.
assert_status 0 "E-254.02a: a legacy skill sync never recorded is KEPT" \
  test -f "$LG1/${_LG_DIR_B}/skills/mine/SKILL.md"
assert_status 0 "E-254.02b: a recorded skill EDITED since sync wrote it is KEPT" \
  grep -q 'EDITED BY THE USER' "$LG1/${_LG_DIR_B}/skills/edited/SKILL.md"
assert_contains "E-254.02c: the surviving directory is reported with its rm command" \
  "legacy leftover (not generated by sync): ${_LG_DIR_B} — remove with: rm -r ${_LG_DIR_B}" "$_o"
assert_contains "E-254.02d: and the files that kept it are listed" \
  "${_LG_DIR_B}/skills/mine/SKILL.md" "$_o"
assert_not_contains "E-254.02e: a kept directory is never announced as pruned" \
  "pruned legacy workspace: ${_LG_DIR_B}" "$_o"

# A settings file the v3 sync MERGED into (it preserved every key already present) can
# hold keys the user wrote. There is no manifest entry or hash for it, so by the rule
# above it is not provably disposable and must survive.
LG2="$(mktemp -d)"; mkdir -p "$LG2/.ai" "$LG2/${_LG_DIR_A}"
cp "$LG1/.ai/roles.json" "$LG2/.ai/roles.json"
printf '{ "mcpServers": {}, "env": {"AI_OS_CALLER_ROLE": "architect"}, "theme": "user-chosen" }\n' \
  > "$LG2/${_LG_DIR_A}/settings.json"
_o="$(_lg_sync "$LG2")"
assert_status 0 "E-254.02f: a legacy settings.json with no manifest evidence is not deleted" \
  test -f "$LG2/${_LG_DIR_A}/settings.json"

# (c) the rollback flag prints every leftover and deletes NOTHING — not even the entries
# (a) proved prunable. Compared as a full file listing, so any deletion fails it.
LG3="$(_lg_fixture)"
printf 'shim\n' > "$LG3/${_LG_SHIM_A}"; printf 'shim\n' > "$LG3/${_LG_SHIM_B}"
_lg_list() { ( cd "$1" && find "${_LG_DIR_A}" "${_LG_DIR_B}" "${_LG_SHIM_A}" "${_LG_SHIM_B}" 2>/dev/null | sort ); }
_before="$(_lg_list "$LG3")"
_o="$(_lg_sync "$LG3" AI_OS_KEEP_LEGACY_WORKSPACES=1)"
assert_status 0 "E-254.03a: AI_OS_KEEP_LEGACY_WORKSPACES=1 deletes nothing" \
  test "$_before" = "$(_lg_list "$LG3")"
assert_status 0 "E-254.03b: including the entry that is otherwise prunable (non-vacuity)" \
  test -f "$LG3/${_LG_DIR_A}/agents/synced.md"
assert_contains "E-254.03c: it says nothing was removed" "AI_OS_KEEP_LEGACY_WORKSPACES=1 — nothing removed" "$_o"
assert_contains "E-254.03d: and prints the first legacy directory" \
  "legacy leftover (not generated by sync): ${_LG_DIR_A} — remove with: rm -r ${_LG_DIR_A}" "$_o"
assert_contains "E-254.03e: the second legacy directory" \
  "legacy leftover (not generated by sync): ${_LG_DIR_B} — remove with: rm -r ${_LG_DIR_B}" "$_o"
assert_contains "E-254.03f: the first shim" \
  "legacy leftover (not generated by sync): ${_LG_SHIM_A} — remove with: rm ${_LG_SHIM_A}" "$_o"
assert_contains "E-254.03g: and the second shim" \
  "legacy leftover (not generated by sync): ${_LG_SHIM_B} — remove with: rm ${_LG_SHIM_B}" "$_o"
assert_not_contains "E-254.03h: no line claims a prune" "pruned legacy" "$_o"

# The shims. Evidence for a shim is byte-identity with the template the install shipped,
# so these run the REAL function against a controlled install root — the live
# ~/.ai-os/templates may or may not still hold the retired templates on this machine.
LG4="$(mktemp -d)"; LGA="$LG4/aios"; LGP="$LG4/proj"
mkdir -p "$LGA/templates" "$LGP"
printf '@ARCHITECT.md\n' > "$LGA/templates/${_LG_SHIM_A}"
printf '@ARCHITECT.md\n' > "$LGA/templates/${_LG_SHIM_B}"
cp "$LGA/templates/${_LG_SHIM_A}" "$LGP/${_LG_SHIM_A}"               # unmodified copy
printf '@ARCHITECT.md\nmy own notes\n' > "$LGP/${_LG_SHIM_B}"          # edited by the user
_lg_fn() {  # <project> <aios> — source the CLI (guarded) and call the pruner directly
  ( cd "$1" || exit 1
    # shellcheck disable=SC1090
    source "$AI_BIN" >/dev/null 2>&1
    AIOS="$2"
    _prune_legacy_workspaces sync 2>&1 || true )
}
_o="$(_lg_fn "$LGP" "$LGA")"
assert_status 1 "E-254.04a: a shim byte-identical to its installed template is pruned" \
  test -f "$LGP/${_LG_SHIM_A}"
assert_contains "E-254.04b: the shim prune is announced" "pruned legacy shim: ${_LG_SHIM_A}" "$_o"
assert_status 0 "E-254.04c: an EDITED shim is kept" test -f "$LGP/${_LG_SHIM_B}"
assert_contains "E-254.04d: and reported with its rm command" \
  "legacy leftover (not generated by sync): ${_LG_SHIM_B} — remove with: rm ${_LG_SHIM_B}" "$_o"
# No template to compare against = no evidence: an unmodified-looking shim is still kept.
rm -f "$LGA/templates/${_LG_SHIM_A}"
printf '@ARCHITECT.md\n' > "$LGP/${_LG_SHIM_A}"
_o="$(_lg_fn "$LGP" "$LGA")"
assert_status 0 "E-254.04e: with no installed template to prove it, the shim is kept" \
  test -f "$LGP/${_LG_SHIM_A}"
assert_contains "E-254.04f: and reported as a leftover" \
  "legacy leftover (not generated by sync): ${_LG_SHIM_A}" "$_o"

# A project with none of the legacy paths hears nothing about them.
LG5="$(mktemp -d)"; mkdir -p "$LG5/.ai"; cp "$LG1/.ai/roles.json" "$LG5/.ai/roles.json"
_o="$(_lg_sync "$LG5")"
assert_not_contains "E-254.05a: a clean v4 project gets no leftover report" "legacy leftover" "$_o"
assert_not_contains "E-254.05b: nor a prune line" "pruned legacy" "$_o"
rm -rf "$LG1" "$LG2" "$LG3" "$LG4" "$LG5"

# ── E-233 (D-060 §4): the artefacts sync regenerates must not dirty the project ──
# The manifest is machine-local by construction — its hashes describe what THIS machine
# wrote — so committing one hands another machine a manifest that lies, and the prune
# above then trusts that lie. Ignoring it is therefore a correctness requirement, not
# just diff hygiene. `ai init` and `ai sync` add the patterns so a project cannot end up
# permanently dirty (or, worse, tracking one).
_gi() {
  # Run the real helper against a scratch repo. Sourced by extraction rather than by
  # running `ai sync`, which would need a whole provisioned workspace to reach the call.
  ( eval "$(sed -n '/^_ensure_generated_gitignore() {/,/^}/p' "$AI_BIN")"
    cd "$1" && _ensure_generated_gitignore "." ) 2>&1
}

T10="$(mktemp -d)"
assert_status 0 "E-233.01a: init wires the helper in" \
  bash -c "grep -q '_ensure_generated_gitignore \"\.\"' '$AI_BIN'"
# Pinned by the FUNCTION each call sits in, not by a count: E-270's `ai init --check`
# replays init in a scratch copy and is a legitimate third caller.
assert_status 0 "E-233.01b: sync wires it in too (do_sync and ensure_ai_templates)" \
  bash -c "sed -n '/^do_sync() {/,/^}/p' '$AI_BIN' | grep -q '_ensure_generated_gitignore \"\.\"' && sed -n '/^ensure_ai_templates() {/,/^}/p' '$AI_BIN' | grep -q '_ensure_generated_gitignore \"\.\"'"

# Outside a git work tree there is nothing to ignore — writing a .gitignore anyway would
# be litter in a directory the user never asked to be a repo.
_gi "$T10" >/dev/null 2>&1 || true
assert_status 1 "E-233.02a: a non-git directory gets no .gitignore" test -f "$T10/.gitignore"

G1="$T10/repo"; mkdir -p "$G1"; git -C "$G1" init -q .
_o="$(_gi "$G1")"
assert_status 0 "E-233.03a: a fresh repo gets the manifest pattern"      grep -qx '\*\*/_SYNC_MANIFEST.json' "$G1/.gitignore"
assert_status 0 "E-233.03b: and the skills index pattern"                grep -qx '\*\*/_SKILLS_INDEX.md' "$G1/.gitignore"
assert_status 0 "E-233.03c: and the blueprint index pattern"             grep -qx '\.ai/blueprints/_INDEX.md' "$G1/.gitignore"
assert_contains "E-233.03d: the addition is reported"                    "generated-artefact pattern" "$_o"
assert_status 0 "E-343.01: and the per-machine CI env allow-list (git check-ignore)" \
  git -C "$G1" check-ignore -q .ai/ci.local.json

# Idempotence is the whole point: init and sync both call this, on every run.
_before="$G1/.before"; cp "$G1/.gitignore" "$_before"
_gi "$G1" >/dev/null; _gi "$G1" >/dev/null
assert_status 0 "E-233.04a: repeated runs do not append again" \
  cmp -s "$_before" "$G1/.gitignore"

# A project that already ignores the artefact by bare name is ALREADY correct; adding a
# second, differently-spelled pattern for the same file is noise in someone else's file.
G2="$T10/named"; mkdir -p "$G2"; git -C "$G2" init -q .
# E-290 adds .claude/settings.json to the generated set (matched by full path); E-333 adds
# .ai/start.local.json (one developer's account binding, matched by base name); E-342 adds
# .ai/.last-import-blob (this machine's imported state.json blob id); E-343 .ai/ci.local.json.
printf '_SKILLS_INDEX.md\n_SYNC_MANIFEST.json\n_INDEX.md\n.claude/settings.json\nstart.local.json\n.last-import-blob\nci.local.json\n' > "$G2/.gitignore"
_gi "$G2" >/dev/null
assert_status 0 "E-233.05a: an equivalent existing rule suppresses the append" \
  bash -c "[ \"\$(grep -c . '$G2/.gitignore' | tr -d ' ')\" -eq 7 ]"

# NON-VACUITY for 05a: a mere mention in a COMMENT is not an ignore rule, so the same
# fixture minus the real rules must still gain the pattern. Without this, 05a would pass
# just as well if the helper had stopped writing anything at all.
G3="$T10/comment"; mkdir -p "$G3"; git -C "$G3" init -q .
printf '# TODO: ignore _SYNC_MANIFEST.json and _SKILLS_INDEX.md and _INDEX.md\n' > "$G3/.gitignore"
_gi "$G3" >/dev/null
assert_status 0 "E-233.05b: a commented-out mention does not count (non-vacuity)" \
  grep -qx '\*\*/_SYNC_MANIFEST.json' "$G3/.gitignore"

# A .gitignore with no final newline: appending naively rewrites the project's LAST RULE
# into something else entirely, which is a silent change to their ignore semantics.
G4="$T10/nonl"; mkdir -p "$G4"; git -C "$G4" init -q .
printf 'node_modules' > "$G4/.gitignore"
_gi "$G4" >/dev/null
assert_status 0 "E-233.06a: a missing trailing newline does not splice the last rule" \
  grep -qx 'node_modules' "$G4/.gitignore"
assert_status 0 "E-233.06b: and the pattern still lands"  grep -qx '\*\*/_SYNC_MANIFEST.json' "$G4/.gitignore"

# This repo is the reference project: the patterns are already present, so a sync here
# must be a no-op. If this fails, `ai sync` would start dirtying the framework tree.
#
# Run against a COPY, never against $REPO_ROOT itself. A test that invokes a file-writing
# helper on the repository under test will, the first time the helper regresses, silently
# edit the real .gitignore and then pass on the next run because it fixed its own input.
G5="$T10/reference"; mkdir -p "$G5"; git -C "$G5" init -q .
cp "$REPO_ROOT/.gitignore" "$G5/.gitignore"
_gi "$G5" >/dev/null
assert_status 0 "E-233.07a: the framework repo's own rules need no change" \
  cmp -s "$REPO_ROOT/.gitignore" "$G5/.gitignore"

rm -rf "$T1" "$T2" "$T3" "$T4" "$T5" "$T6" "$T7" "$T8" "$T9" "$T10"


# ── E-282 (from path_rules — E-302): path-scoped .claude/rules/ ──
# E-282 (D-075 §Component 2, D-080 ruling 5): path-scoped
# .claude/rules/.
#
# Rules that matter for one part of the tree left the bootloaders for src/claude/rules/*.md
# with a `paths:` frontmatter list; Claude Code loads one when a matching file is read.
# This suite pins: every rule carries a non-empty, well-formed `paths:` list; the four
# mapped trees are covered; the bootloaders shrank (ENGINEER.md ≥ 25% vs E-275, ARCHITECT.md
# no larger); provisioning never overwrites a rule sync cannot prove it wrote; `ai sync`
# provisions .claude/rules/; `ai doctor` reports it; the SessionStart blob excludes rules.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RULES="${REPO_ROOT}/src/claude/rules"
SM="${REPO_ROOT}/src/shared/sync-manifest.mjs"
AI_BIN="${REPO_ROOT}/src/bin/ai"


# ── E-282.1: every rule has a valid, non-empty paths: list ──────────────────
_corpus="$(corpus_or_fail 5 "$RULES" -- -name '*.md')"
assert_status 0 "E-282.01a: the rules corpus is built (>= 5 rule files)" test $? -eq 0
_paths_of() {  # <rule file> → one glob per line; exit 1 when the frontmatter is malformed
  python3 - "$1" <<'PY'
import sys, re
s = open(sys.argv[1], encoding="utf-8").read()
m = re.match(r"^---\n(.*?)\n---\n", s, re.S)
if not m: sys.exit(1)
lines = m.group(1).splitlines()
if not lines or lines[0].strip() != "paths:": sys.exit(1)
globs = []
for ln in lines[1:]:
    g = re.match(r'^\s+-\s+"([^"]+)"\s*$', ln)
    if not g: sys.exit(1)          # anything else in the block is not the documented shape
    globs.append(g.group(1))
if not globs or not s[m.end():].strip(): sys.exit(1)
print("\n".join(globs))
PY
}
_all_globs=""
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  g="$(_paths_of "$f")"; rc=$?
  assert_status 0 "E-282.01b: $(basename "$f") has a non-empty paths: list and a body" test "$rc" -eq 0 -a -n "$g"
  _all_globs+="${g}"$'\n'
done <<< "$_corpus"
for want in 'src/**' 'tests/**' 'src/mcp/**' 'hooks/**' '.ai/**'; do
  assert_contains "E-282.01c: a rule is scoped to ${want}" "$want" "$_all_globs"
done
_neg="$(mktemp -d)"; printf -- '---\npaths:\n---\nbody\n' > "$_neg/empty.md"
assert_status 1 "E-282.01d: the checker rejects an empty paths: list (non-vacuity)" _paths_of "$_neg/empty.md"

# ── E-282.2: the bootloaders shrank (D-080 ruling 5) ────────────────────────
# Baselines at E-275 (eed6094): ENGINEER.md 9,259 bytes, ARCHITECT.md 7,696 bytes.
_eng="$(wc -c < "${REPO_ROOT}/ENGINEER.md" | tr -d ' ')"
_arch="$(wc -c < "${REPO_ROOT}/ARCHITECT.md" | tr -d ' ')"
echo "    ENGINEER.md ${_eng} bytes (limit 6944), ARCHITECT.md ${_arch} bytes (limit 7696)"
assert_status 0 "E-282.02a: ENGINEER.md is >= 25% shorter than at E-275" test "$_eng" -le 6944
assert_status 0 "E-282.02b: ARCHITECT.md is not larger than at E-275" test "$_arch" -le 7696
for f in ENGINEER.md ARCHITECT.md; do
  assert_status 0 "E-282.02c: root ${f} matches its template" diff -q "${REPO_ROOT}/${f}" "${REPO_ROOT}/src/templates/${f}"
  assert_status 1 "E-282.02d: ${f} no longer carries the moved path-scoped rules" \
    grep -qE 'Never move bookkeeping with|presumed REAL until' "${REPO_ROOT}/${f}"
done
assert_status 0 "E-282.02e: ENGINEER.md points at the path-scoped rules" grep -q '.claude/rules/' "${REPO_ROOT}/ENGINEER.md"

# ── E-282.3: provisioning never overwrites what sync cannot prove it wrote ──
_sm() { node --no-warnings "$SM" "$@" 2>&1; }
T="$(mktemp -d)"; S="$T/src"; D="$T/dst"; mkdir -p "$S"
printf -- '---\npaths:\n  - "src/**"\n---\nv1 a\n' > "$S/a.md"
printf -- '---\npaths:\n  - "tests/**"\n---\nv1 b\n' > "$S/b.md"
mkdir -p "$D"; printf 'my own rule\n' > "$D/b.md"; printf 'team rule\n' > "$D/team.md"
_o="$(_sm provision "$S" "$D")"
assert_status 0 "E-282.03a: a fresh rule is provisioned" cmp -s "$S/a.md" "$D/a.md"
assert_contains "E-282.03b: a same-named user rule is NOT overwritten" "my own rule" "$(cat "$D/b.md")"
assert_contains "E-282.03c: and the keep is reported as user-authored" "b.md — not written by sync (user-authored)" "$_o"
assert_status 0 "E-282.03d: a user rule outside the source set survives" test -f "$D/team.md"
assert_status 1 "E-282.03e: the manifest does not claim the kept user rule" grep -q '"b.md"' "$D/_SYNC_MANIFEST.json"
printf -- '---\npaths:\n  - "src/**"\n---\nv2 a\n' > "$S/a.md"
_sm provision "$S" "$D" >/dev/null
assert_status 0 "E-282.03f: a sync-written, unedited rule is updated when the source changes" cmp -s "$S/a.md" "$D/a.md"
printf 'local edit\n' >> "$D/a.md"
printf -- '---\npaths:\n  - "src/**"\n---\nv3 a\n' > "$S/a.md"
_o="$(_sm provision "$S" "$D")"
assert_contains "E-282.03g: an edited sync-written rule is kept, not clobbered" "local edit" "$(cat "$D/a.md")"
assert_contains "E-282.03h: and reported as modified" "a.md — modified since sync wrote it" "$_o"
rm -f "$D/a.md"; printf -- '---\npaths:\n  - "x/**"\n---\nold\n' > "$S/old.md"
_sm provision "$S" "$D" >/dev/null; rm -f "$S/old.md"
_o="$(_sm provision "$S" "$D")"
assert_status 1 "E-282.03i: a retired rule sync wrote and nobody edited is pruned" test -f "$D/old.md"
assert_status 0 "E-282.03j: the team rule still survives the prune" test -f "$D/team.md"
_sm provision "$S" "$D" --no-prune >/dev/null
assert_status 0 "E-282.03k: --no-prune provisions without removing" test -f "$D/team.md"

# ── E-282.4: ai sync provisions .claude/rules/ and ai doctor reports it ────
# `ai sync` reads rules from the INSTALL MIRROR. Under `ai ci run` the mirror is installed
# from the commit; a working tree may predate E-282 — a recorded SKIP, never a fake result.
if [[ -d "${HOME}/.ai-os/claude/rules" ]]; then
  TA="$(mktemp -d)"; on_exit "rm -rf '$TA'"; mkdir -p "$TA/.ai"
  cat > "$TA/.ai/roles.json" <<'JSON'
{ "roles": { "architect": {"provider":"claude","pane_identifier":"1","model":"fable"},
             "engineer":  {"provider":"claude","pane_identifier":"0","model":"opus"} } }
JSON
  _o="$(cd "$TA" && AI_OS_DISABLE_REPO_MAP=1 bash "$AI_BIN" sync 2>&1)"
  _n_src="$(find "${HOME}/.ai-os/claude/rules" -name '*.md' | wc -l | tr -d ' ')"
  _n_dst="$(find "$TA/.claude/rules" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
  assert_status 0 "E-282.04a: ai sync provisions every shipped rule (${_n_dst}/${_n_src})" test "$_n_dst" -eq "$_n_src" -a "$_n_src" -ge 5
  assert_contains "E-282.04b: and says so" "path-scoped rule(s)" "$_o"
  _d="$(cd "$TA" && bash "$AI_BIN" doctor 2>&1)"
  assert_contains "E-282.04c: ai doctor reports the rules current" "path-scoped rule(s) current" "$_d"
  rm -f "$TA/.claude/rules/"*.md
  _d="$(cd "$TA" && bash "$AI_BIN" doctor 2>&1)"
  assert_contains "E-282.04d: ai doctor reports missing rules with the fix" "missing — run: ai sync" "$_d"
else
  _skip "E-282.04: ai sync / doctor end to end — the install mirror predates E-282 (run: bash install-ai-os.sh)"
fi

# ── E-282.5: the SessionStart blob excludes rules ───────────────────────────
_blob="$(cd "$REPO_ROOT" && node --no-warnings src/mcp/cache-manager-mcp/index.js --emit-context 2>/dev/null)"
assert_status 0 "E-282.05a: the blob was produced (non-vacuity)" test -n "$_blob"
assert_not_contains "E-282.05b: no rule body reaches the SessionStart blob" "# Hooks contract (hooks/)" "$_blob"
assert_not_contains "E-282.05c: nor a rule's frontmatter" 'paths:
  - "hooks/**"' "$_blob"

rm -rf "$T" "$_neg"


# ── E-52 (from mcp_doc_sync — E-302): MCP registry docs are generated ──
# Tests for E-52 MCP Registry Auto-Generation.
#
# Verifies the contract demanded by drift-resolution-2026.md
# §"Auto-Generated Documentation":
#   • scripts/generate_mcp_docs.mjs exists and emits deterministic output.
#   • The committed .ai/blueprints/mcp.md is byte-identical to a fresh
#     generator run — i.e. nobody hand-edited it (CI gate).
#   • src/mcp/shared/mcp-domains.mjs is the single DOMAINS source the
#     generator reads (the router that shared it was retired by E-277).
#   • bin/ai do_sync() invokes _regenerate_mcp_docs.
#   • install-ai-os.sh ships scripts/ to ~/.ai-os/scripts/ so downstream
#     projects can regenerate too.
#   • Generator is fail-open: a malformed registry warns but exits 0.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
GEN="${REPO_ROOT}/scripts/generate_mcp_docs.mjs"
DOMAINS_MJS="${REPO_ROOT}/src/mcp/shared/mcp-domains.mjs"
MCP_MD="${REPO_ROOT}/.ai/blueprints/mcp.md"
BIN_AI="${REPO_ROOT}/src/bin/ai"
INSTALLER="${REPO_ROOT}/install-ai-os.sh"


# ── T-MCPDOC-S01: generator + DOMAINS source exist ───────────────────────────
echo ""
echo "  [T-MCPDOC-S01] generator + DOMAINS source files present"

assert_status 0 "scripts/generate_mcp_docs.mjs exists"  test -f "$GEN"
assert_status 0 "src/mcp/shared/mcp-domains.mjs exists" test -f "$DOMAINS_MJS"
assert_status 0 "DOMAINS exported from shared module" \
  grep -qE 'export const DOMAINS' "$DOMAINS_MJS"

# Single source of truth — the generator imports DOMAINS rather than declaring a copy.
assert_status 0 "generator imports from shared mcp-domains" \
  grep -qE 'mcp-domains\.mjs' "${REPO_ROOT}/scripts/generate_mcp_docs.mjs"

assert_status 1 "generator does NOT redeclare DOMAINS locally" \
  grep -qE '^const DOMAINS = \{' "${REPO_ROOT}/scripts/generate_mcp_docs.mjs"

# ── T-MCPDOC-S02: committed mcp.md is in sync with generator output ──────────
echo ""
echo "  [T-MCPDOC-S02] mcp.md byte-identical to generator output (CI gate)"

# Regenerate to a temp file so subsequent assertions can grep it directly.
TMP_OUT="$(mktemp)"
node "$GEN" --check > "$TMP_OUT" 2>/dev/null

assert_status 0 "generator output matches committed .ai/blueprints/mcp.md" \
  diff -q "$TMP_OUT" "$MCP_MD"

# Generator output sanity: header marker and expected domains.
assert_status 0 "output carries the AUTO-GENERATED marker" \
  grep -qE 'AUTO-GENERATED by scripts/generate_mcp_docs\.mjs' "$TMP_OUT"

assert_status 0 "output includes the State domain heading" \
  grep -qE '^## State$' "$TMP_OUT"

# E-277 (D-075): the retired router is in neither the registry nor the generated doc.
assert_status 1 "output no longer lists the retired mcp-router" \
  grep -q 'mcp-router' "$TMP_OUT"

rm -f "$TMP_OUT"

# ── T-MCPDOC-S03: bin/ai do_sync() invokes the regenerator ──────────────────
echo ""
echo "  [T-MCPDOC-S03] bin/ai wires _regenerate_mcp_docs into do_sync()"

assert_status 0 "bin/ai defines _regenerate_mcp_docs()" \
  grep -qE '^_regenerate_mcp_docs\(\)' "$BIN_AI"

assert_status 0 "do_sync() body invokes _regenerate_mcp_docs" \
  python3 -c "
import re,sys
src=open('${BIN_AI}').read()
m=re.search(r'^do_sync\(\)\s*\{(.*?)^\}', src, re.S|re.M)
sys.exit(0 if m and '_regenerate_mcp_docs' in m.group(1) else 1)
"

# Helper must guard on `node` availability (fail-open).
assert_status 0 "_regenerate_mcp_docs guards on node availability" \
  grep -qE 'command -v node' "$BIN_AI"

# E-223: install-first via the shared helper (was cwd-relative first).
assert_status 0 "helper resolves the generator via the shared install-first locator" \
  grep -q '_ai_os_helper scripts/generate_mcp_docs.mjs' "$BIN_AI"

# ── T-MCPDOC-S04: install-ai-os.sh ships scripts/ ────────────────────────────
echo ""
echo "  [T-MCPDOC-S04] install-ai-os.sh ships scripts/ to ~/.ai-os/scripts/"

# E-304: one staged pass from the source tree, then a live sync (rsync, or the atomic cp fallback).
assert_status 0 "installer stages scripts/ from the source tree" \
  grep -qF '_stage_one "${REPO_DIR}/scripts" "${_STAGE}/scripts"' "$INSTALLER"

assert_status 0 "installer syncs the staged scripts/ live" \
  grep -qF '_live_one scripts' "$INSTALLER"

# ── T-MCPDOC-S05: fail-open behaviour on broken registry ────────────────────
echo ""
echo "  [T-MCPDOC-S05] generator fail-open against malformed registry"

SBOX="$(mktemp -d)"
mkdir -p "$SBOX/.ai/blueprints" "$SBOX/src/config"
echo '{ this is not json' > "$SBOX/src/config/registry.json"

# Run generator in a subshell with CWD set to the sandbox. The script's
# locator will resolve the local registry first and hit a parse error;
# the parse error path must exit 0 (fail-open) so `ai sync` continues.
EXIT_CODE=0
( cd "$SBOX" && node "$GEN" >/dev/null 2>&1 ) || EXIT_CODE=$?
assert_status 0 "generator exits 0 on malformed registry (fail-open)" \
  test "$EXIT_CODE" -eq 0

rm -rf "$SBOX"

# ── T-MCPDOC-S06: --check mode is read-only ─────────────────────────────────
echo ""
echo "  [T-MCPDOC-S06] --check mode does not modify mcp.md"

# E-236: `file_mtime` instead of a `stat -f … || stat -c …` chain. On Linux the BSD form
# means --file-system, so GNU stat printed a whole filesystem REPORT for the operand and
# exited non-zero — and the `||` inside one substitution captured BOTH outputs. The
# resulting blob contains free-block counts, which change as the machine works, so BEFORE
# and AFTER differed even though --check never touched the file. That is why this assertion
# flaked on CI (master run 34387218090) while passing on macOS, where the BSD form succeeds
# first and the GNU form is never reached. Same defect as E-229's `_self_stamp`.
MCP_MTIME_BEFORE="$(file_mtime "$MCP_MD")"
node "$GEN" --check >/dev/null 2>&1
MCP_MTIME_AFTER="$(file_mtime "$MCP_MD")"
assert_status 0 "mcp.md mtime unchanged after --check run" \
  test "$MCP_MTIME_BEFORE" = "$MCP_MTIME_AFTER"

echo ""


# ── (from registry_sync — E-302): source registry vs install layer drift guard ──
# The checks live once in tests/tools/registry-drift.sh: the pre-commit hook RUNS that file on a
# commit touching the registry; here it is SOURCED, so its assertions count in this suite. Its
# paths are relative to the repository root.
pushd "$REPO_ROOT" >/dev/null
source "${REPO_ROOT}/tests/tools/registry-drift.sh"
popd >/dev/null


# ── P-15 (from mcp — E-302): generate_mcp_json ──
# generate_mcp_json tests (P-15 / §22)
REPO_ROOT="${SCRIPT_DIR}/../.."
REGISTRY="${REPO_ROOT}/src/config/registry.json"


# registry.json exists and is valid JSON
assert_exists "$REGISTRY"
out=$(python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$REGISTRY" 2>&1)
assert_status 0 "registry.json is valid JSON" python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$REGISTRY"

# registry has mcp_servers key
out=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('ok' if 'mcp_servers' in d else 'missing')" "$REGISTRY")
assert_contains "registry has mcp_servers key" "ok" "$out"

# All path-based servers have index.js listed in their path value
out=$(python3 - "$REGISTRY" <<'PY'
import json, sys
reg = json.load(open(sys.argv[1]))
bad = [n for n, v in reg.get("mcp_servers", {}).items() if "path" in v and not v["path"].endswith("index.js")]
print("ok" if not bad else f"bad: {bad}")
PY
)
assert_contains "all custom servers reference index.js" "ok" "$out"

# generate_mcp_json produces valid JSON with mcpServers key in a temp dir
TMP_DIR=$(mktemp -d)
on_exit 'rm -rf "$TMP_DIR"'

# Simulate generate_mcp_json by sourcing the relevant logic inline
python3 - "$REGISTRY" "${TMP_DIR}/.mcp.json" "$HOME" "${HOME}/.ai-os" <<'PY'
import json, os, sys
registry_path, mcp_path, home, aios = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

servers = {
  "filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem@2026.1.14", "."]},
  "memory": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory@2026.1.26"]}
}

if os.path.exists(registry_path):
    with open(registry_path) as f:
        reg = json.load(f)
    for name, info in reg.get("mcp_servers", {}).items():
        if "path" in info:
            abs_path = os.path.join(aios, "mcp", name, "index.js")
            servers[name] = {"command": "node", "args": [abs_path]}

with open(mcp_path, "w") as f:
    json.dump({"mcpServers": servers}, f, indent=2)
    f.write("\n")
PY

assert_exists "${TMP_DIR}/.mcp.json"

mcp_out=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('ok' if 'mcpServers' in d else 'missing')" "${TMP_DIR}/.mcp.json")
assert_contains ".mcp.json has mcpServers key" "ok" "$mcp_out"

# Verify trailing newline exists
last_char=$(tail -c 1 "${TMP_DIR}/.mcp.json" | wc -c)
assert_contains ".mcp.json ends with newline" "1" "$last_char"

# Verify custom servers from registry appear in .mcp.json
registry_custom=$(python3 -c "
import json,sys
reg=json.load(open(sys.argv[1]))
names=[n for n,v in reg.get('mcp_servers',{}).items() if 'path' in v]
print(','.join(names))
" "$REGISTRY")

mcp_keys=$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
print(','.join(d['mcpServers'].keys()))
" "${TMP_DIR}/.mcp.json")

for name in $(echo "$registry_custom" | tr ',' ' '); do
  assert_contains ".mcp.json contains registry server: $name" "$name" "$mcp_keys"
done

# E-98: task-synchronizer-mcp must list verify_markdown_sync and archive_done_tasks
tsync_tools=$(python3 -c "
import json, sys
reg = json.load(open(sys.argv[1]))
tsync = reg.get('mcp_servers', {}).get('task-synchronizer-mcp', {})
tools = tsync.get('allowed-tools', [])
print(','.join(tools))
" "$REGISTRY")
assert_contains "E-98: registry lists verify_markdown_sync" "verify_markdown_sync" "$tsync_tools"
assert_contains "E-98: registry lists archive_done_tasks" "archive_done_tasks" "$tsync_tools"


# ── E-283 (from skill_prune — E-302): retired wrapper skills stay retired ──
# E-283 (D-075, .ai/blueprints/native-first.md §Component 4): the
# skills that duplicated a native command or a single MCP tool are retired.
#
# Formerly cli_wrapper_skills_test.sh (E-178), which asserted that five of these wrappers
# EXISTED. They were thin skills over one MCP tool each, and every description loaded at
# every session start; the MCP tool is directly callable, and ai-compact duplicated
# Claude Code's /compact and auto-compact. This suite now asserts the opposite, and that
# the retirement is complete:
#
#   * no canonical source and no tracked .claude mirror remains;
#   * the canonical skill count is 43;
#   * no rulefile, template, skill, agent or MCP server still names one — the only places
#     the names may appear are the legacy registry (which must, so `ai clean` can remove
#     the provisioned copies), .ai/archive, CHANGELOG and this suite;
#   * each has a legacy-registry entry that is safe ONLY by hash (known_hashes present);
#   * ai-archive carries the SESSION.md distillation ai-compact used to own, and the
#     rulefiles point at /compact and at the context-health tool directly.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"


RETIRED=(ai-compact ai-analyze ai-cluster ai-context-check ai-dispatch ai-sync-verify ai-topic)
PATTERN="$(IFS='|'; echo "${RETIRED[*]}")"

for n in "${RETIRED[@]}"; do
  assert_status 1 "E-283.01: ${n} has no canonical source" \
    bash -c "compgen -G '${REPO_ROOT}/src/*/skills/${n}' >/dev/null"   # not ls: GNU ls exits 2 on a missing path, BSD 1
  assert_status 1 "E-283.01: ${n} has no tracked .claude mirror" test -e "${REPO_ROOT}/.claude/skills/${n}"
done

# Every canonical skill root under src/ (shared, claude, architect, …).
_n="$(cd "$REPO_ROOT" && find src -path '*/node_modules' -prune -o -name SKILL.md -print | wc -l | tr -d ' ')"
assert_status 0 "E-283.02: 43 canonical skills (got ${_n})" test "$_n" -eq 43

# Every mention outside the permitted places is a leftover reference.
_hits="$(cd "$REPO_ROOT" && git grep -lE "(${PATTERN})" -- . \
  ':!.ai' ':!CHANGELOG.md' ':!plans' ':!src/config/legacy-artefacts.json' ':!tests/suites/ai_sync_test.sh' 2>/dev/null || true)"
assert_status 0 "E-283.03: no file outside the registry, .ai/, plans/ and CHANGELOG names a retired skill${_hits:+ (found: ${_hits//$'\n'/, })}" \
  test -z "$_hits"
# …and the grep itself saw the tree (a git grep that failed would also return nothing).
assert_status 0 "E-283.03b: the reference scan read the tree" \
  bash -c "cd '$REPO_ROOT' && git grep -l 'ai-archive' -- src | grep -q ."

REG="${REPO_ROOT}/src/config/legacy-artefacts.json"
for n in "${RETIRED[@]}"; do
  assert_status 0 "E-283.04: ${n} has a hash-evidenced legacy-registry entry" \
    python3 -c 'import json,sys
d=json.load(open(sys.argv[1])); n=sys.argv[2]
e=[x for x in d["entries"] if x["path"]==f".claude/skills/{n}/SKILL.md"]
assert len(e)==1 and e[0]["class"]=="safe" and e[0].get("known_hashes"), e' "$REG" "$n"
done
assert_status 0 "E-283.04b: the registry still loads" \
  node --no-warnings -e "import('${REPO_ROOT}/src/shared/legacy-registry.mjs').then(m=>m.loadRegistry('${REG}'))"

ARCHIVE="${REPO_ROOT}/src/shared/skills/ai-archive/SKILL.md"
assert_contains "E-283.05a: ai-archive distills SESSION.md before moving it" "SESSION.md only — distill before moving" "$(cat "$ARCHIVE")"
assert_mirror_if_present "E-283.05b: ai-archive mirror matches" "$ARCHIVE" "${REPO_ROOT}/.claude/skills/ai-archive/SKILL.md"
for f in ENGINEER.md src/templates/ENGINEER.md; do
  assert_status 0 "E-283.06: ${f} calls the context-health tool directly" \
    grep -qF 'mcp__archive-manager-mcp__check_context_health' "${REPO_ROOT}/${f}"
done
for f in ENGINEER.md ARCHITECT.md src/templates/ENGINEER.md src/templates/ARCHITECT.md; do
  assert_status 0 "E-283.07: ${f} points the Ephemeral Skill Pattern at /compact" \
    grep -qF 'Do this with `/compact`' "${REPO_ROOT}/${f}"
done


# ── E-145 (from memory_palace_sync — E-302): _generate_memory_palace in do_sync ──
# LAST on purpose: it sources src/bin/ai into this shell (which sets -e and defines its globals).
# E-145 (self-learning-arc, W5-T1): _generate_memory_palace
# is the fail-open do_sync hook that refreshes the Memory Palace candidate index via the
# API-free memory-batch-scanner. It must NEVER abort sync; since E-339 (D-107 r1) a missing
# node/scanner or the disable flag returns 2 (skipped by design) and a scanner error returns 1
# (FAILED, counted by _sync_step),
# must honor the AI_OS_DISABLE_MEMORY_PALACE escape hatch, and must write a valid manifest
# when the scanner is present. Sources src/bin/ai (guarded) and drives the function directly.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"


# The source-guard returns early when sourced, defining helpers without dispatch.
# shellcheck disable=SC1090
source "${REPO_ROOT}/src/bin/ai" 2>/dev/null || true

assert_status 0 "E-145.S0: _generate_memory_palace defined" \
  bash -c "type -t _generate_memory_palace >/dev/null 2>&1 || (source '${REPO_ROOT}/src/bin/ai' 2>/dev/null; type -t _generate_memory_palace >/dev/null)"

# ── T-1: disable flag → skipped (exit 2), no manifest ──────────────────────────
TMP1="$(mktemp -d)"; on_exit 'rm -rf "$TMP1" "${TMP2:-}" "${TMP3:-}"'
( cd "$TMP1" && mkdir -p .ai
  AIOS="${REPO_ROOT}" AI_OS_DISABLE_MEMORY_PALACE=1 bash -c "source '${REPO_ROOT}/src/bin/ai' 2>/dev/null; _generate_memory_palace" >/dev/null 2>&1 ) && rc=0 || rc=$?
assert_status 0 "T-1: disable flag → exit 2, skipped by design (E-339, D-107 r1)" test "$rc" -eq 2
assert_status 1 "T-1: disable flag → no palace-index.json written" test -f "$TMP1/.ai/memory/palace-index.json"

# ── T-2: scanner present (AIOS→repo) → valid JSON manifest, exit 0 ───────────
TMP2="$(mktemp -d)"
( cd "$TMP2" && mkdir -p .ai
  AIOS="${REPO_ROOT}" bash -c "source '${REPO_ROOT}/src/bin/ai' 2>/dev/null; _generate_memory_palace" >/dev/null 2>&1 )
rc=$?
assert_status 0 "T-2: function exits 0 with scanner present" test "$rc" -eq 0
assert_status 0 "T-2: palace-index.json written" test -f "$TMP2/.ai/memory/palace-index.json"
assert_status 0 "T-2: manifest is valid JSON" \
  node -e "JSON.parse(require('fs').readFileSync('$TMP2/.ai/memory/palace-index.json','utf8'))"

# ── T-3: scanner MISSING → skipped (exit 2, sync continues), no manifest ─────
# E-223 changed how this has to be staged. Overriding AIOS no longer hides the helper:
# the shared resolver deliberately computes its own install root from HOME so that an
# environment variable cannot redirect it, which is the whole security property. And the
# script-relative fallback finds the repo's own copy whenever bin/ai runs from the repo.
# So the scanner is made genuinely unreachable: a COPY of bin/ai outside the repo (no
# sibling src/shared) plus a HOME pointing at an empty install root. HOME must be set
# BEFORE the source, not on the function call — the resolver fixes its install root at
# source time precisely so a later assignment cannot move it.
#
# Note on what this staging exercises: the temp install root holds no shared/locate.sh, so
# bin/ai falls through to its INLINE fallback resolver (install mirror only). That is the
# right shape for these two cases — they are about fail-open behaviour when a helper is
# missing — but it is not the shared resolver, and a later reader should not take it as
# coverage of locate.sh's HOME-rooting.
TMP3="$(mktemp -d)"; mkdir -p "$TMP3/home/.ai-os/shared" "$TMP3/bin"
tc_fixture_home "$TMP3/home"   # E-345 (D-109 r1): the toolchain record the hooks pin
cp "${REPO_ROOT}/src/bin/ai" "$TMP3/bin/ai"
( cd "$TMP3" && mkdir -p .ai
  HOME="$TMP3/home" bash -c "source '$TMP3/bin/ai' 2>/dev/null; cd '$TMP3'; _generate_memory_palace" >/dev/null 2>&1 ) && rc=0 || rc=$?
assert_status 0 "T-3: missing scanner → exit 2, skipped by design (E-339, D-107 r1)" test "$rc" -eq 2
assert_status 1 "T-3: missing scanner → no manifest left behind" test -f "$TMP3/.ai/memory/palace-index.json"

# ── T-4: no partial/.tmp file left behind in any case ────────────────────────
assert_status 1 "T-4: no palace-index.json.tmp leaked (T-2 dir)" test -f "$TMP2/.ai/memory/palace-index.json.tmp"

# ── T-5: the do_sync call site + fail-open guards exist in source ────────────
assert_status 0 "T-5: _generate_memory_palace invoked in do_sync" \
  grep -q "_generate_memory_palace" "${REPO_ROOT}/src/bin/ai"
assert_status 0 "T-5: AI_OS_DISABLE_MEMORY_PALACE escape hatch present" \
  grep -q "AI_OS_DISABLE_MEMORY_PALACE" "${REPO_ROOT}/src/bin/ai"

# ── T-6: node MISSING → skipped (exit 2) before any FS write (node check first) ─
# PATH override is applied INLINE on the call (after source), so `command -v node`
# misses while the source itself ran with a normal PATH.
TMP6="$(mktemp -d)"
( cd "$TMP6" && mkdir -p .ai
  bash -c "source '${REPO_ROOT}/src/bin/ai' 2>/dev/null; cd '$TMP6'; PATH=/nonexistent _generate_memory_palace" >/dev/null 2>&1 ) && rc=0 || rc=$?
assert_status 0 "T-6: node missing → exit 2, skipped by design (E-339, D-107 r1)" test "$rc" -eq 2
assert_status 1 "T-6: node missing → no manifest (returns before mkdir)" test -f "$TMP6/.ai/memory/palace-index.json"

# ── T-7: scanner present but EXITS NON-ZERO → FAILED (exit 1), nothing left ────
# Staged like T-3: a copy of bin/ai outside the repo so the script-relative fallback
# cannot reach the real scanner, and HOME pointing at an install root holding the stub.
TMP7="$(mktemp -d)"; mkdir -p "$TMP7/home/.ai-os/shared" "$TMP7/bin"
tc_fixture_home "$TMP7/home"   # E-345 (D-109 r1): the toolchain record the hooks pin
cp "${REPO_ROOT}/src/bin/ai" "$TMP7/bin/ai"
# The stub records that it RAN before failing. Without this the assertions below pass
# identically whether the stub failed or was never resolved at all — the test would then
# be asserting nothing about the failure path it exists to cover.
# ESM syntax: the file is .mjs, so `require` is undefined and a require-based stub throws
# BEFORE writing its marker — which is how the first version of this marker silently
# failed and looked like "the scanner was never reached".
printf 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.STUB_MARK, "ran\\n");\nprocess.exit(1);\n' \
  > "$TMP7/home/.ai-os/shared/memory-batch-scanner.mjs"   # runtime-failure stub
( cd "$TMP7" && mkdir -p .ai
  HOME="$TMP7/home" STUB_MARK="$TMP7/stub-ran" \
    bash -c "source '$TMP7/bin/ai' 2>/dev/null; cd '$TMP7'; _generate_memory_palace" >/dev/null 2>&1 ) && rc=0 || rc=$?
assert_status 0 "T-7: the failing scanner was actually REACHED (not silently unresolved)" \
  test -f "$TMP7/stub-ran"
assert_status 0 "T-7: scanner exit 1 → exit 1, FAILED (E-339, D-107 r1; _sync_step still runs the rest)" test "$rc" -eq 1
assert_status 1 "T-7: scanner exit 1 → no manifest written" test -f "$TMP7/.ai/memory/palace-index.json"
assert_status 1 "T-7: scanner exit 1 → no .tmp left behind (rollback rm fired)" test -f "$TMP7/.ai/memory/palace-index.json.tmp"
rm -rf "$TMP6" "$TMP7" 2>/dev/null || true

assert_summary
