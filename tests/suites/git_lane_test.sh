#!/usr/bin/env bash
# git_lane_test.sh — E-214 (architect-provider-parity.md §Git Lane, D-054):
# the Architect-scoped commit lane.
#
# A Claude Architect HAS git, so the D-053 proxy-commit workaround (the
# Engineer commits the Architect's .ai/ edits) is retired for same-provider Triads.
# The lane is the LAST checkpoint before history: an Architect may commit only paths
# under .ai/ or plans/, and for such a commit the [CRITIC_STAMP] requirement is waived
# because the critics review src/ and an .ai/-only diff gives them nothing to read.
#
# Every assertion drives the REAL hook in a disposable git repo with real staged files.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${REPO_ROOT}/hooks/pre-commit.sh"
SAFE_EXEC="${REPO_ROOT}/src/mcp/safe-exec-mcp/index.js"

echo "── Suite: git_lane_test (E-214) ─────────────────────────────────────"

_RC=0   # declared up front: the suite runs under `set -u`

# E-294 (D-087, Component 8g): pre-commit resolves the role from four sources, in order —
# (1) a CLAUDE_CODE_SESSION_ID whose token VERIFIES → record (the only waiver source),
# (2) a live launch record on the commit process's chain → chain, (3) a session id that does
# not verify → union (architect), (4) the advisory env, then engineer. Every hook run below
# uses a throwaway HOME (rule 6) whose ~/.rein/{mcp,shared} are this checkout's src/ — the
# hook locates safe-exec and launch-record.py there (never the operator's install, and never
# a launch record on the operator's own process chain). Real sessions come from as-session.sh.
GH="$(test_tmpdir glhome)"
mkdir -p "${GH}/.rein"
tc_link_shared "$GH"   # E-345 (D-109 r1): mirror = this tree + the toolchain record the hooks pin
ln -s "${REPO_ROOT}/src/mcp" "${GH}/.rein/mcp"
AS="${REPO_ROOT}/tests/lib/as-session.sh"

# Disposable repo with a seeded stamp, so Gate 2 is satisfied for the engineer path
# and the ONLY variable under test is the role + staged scope.
# E-329: a stamp is bound to a commit, so the repo has a parent commit and the seeded
# [CRITIC_STAMP] names it (in the state.json view — there is no state.sqlite here). It is
# removed with `rm -f .ai/state.json`. A line in REVIEWS.md no longer counts (E-329.06).
_mkrepo() {
  local d; d="$(test_tmpdir glrepo)"
  ( cd "$d"
    git init -q .
    git config user.email t@t; git config user.name t; git config commit.gpgsign false
    mkdir -p .ai/blueprints plans src tests
    echo base > README
    git add README && git commit -q --no-verify -m base
    _seed_stamp "$(git rev-parse HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  )
  printf '%s' "$d"
}
_seed_stamp() {  # <sha> <iso time> → .ai/state.json with one CRITIC_STAMP for <sha> (cwd = repo)
  printf '{"tasks":[],"stamps":[{"type":"CRITIC_STAMP","agent":"t","sha":"%s","author":"t@t","timestamp":"%s","summary":"seeded"}]}\n' \
    "$1" "$2" > .ai/state.json
}

# Run the hook with an explicit role, assigning into _OUT/_RC in the CURRENT shell.
# NOTE: `_out="$(_run ...)"` would run _run in a SUBSHELL, so an _RC set inside would
# never reach the parent and every exit-code assertion would silently read a stale
# value. Call this directly and read _OUT/_RC.
# E-236 (environment dependence): REIN_PANE_ROLE is stripped from every hook invocation
# below. `rein pane <role>` EXPORTS it, so a suite run from inside an Engineer pane inherited
# REIN_PANE_ROLE=engineer — and the hook's resolver ranks the pane role ABOVE
# REIN_CALLER_ROLE, so the role this suite sets was silently overridden and the whole
# Architect lane never activated. It passed on CI (no pane) and failed on a real Triad
# machine: the verdict depended on where the suite was run from, not on the hook.
# CLAUDE_CODE_SESSION_ID is emptied so the env fallback is what is under test here;
# the HMAC-record path is covered separately in E-214.7.
# E-264: REIN_PANE_ROLE is stripped centrally (tests/lib/launch-vars.sh), not per call.
assert_status 1 "E-264: REIN_PANE_ROLE is not in the environment the hook inherits" \
  bash -c '[[ -n "${REIN_PANE_ROLE+x}" ]]'
_OUT=""
_run() {  # <repo> <role> → sets _OUT and _RC
  local d="$1" role="$2"
  _OUT="$( cd "$d" && env HOME="$GH" REIN_CALLER_ROLE="$role" \
           REIN_SKIP_STANDARDS=1 CLAUDE_CODE_SESSION_ID= \
           bash "$HOOK" 2>&1 )"
  _RC=$?
}

# ── E-214.1: in-scope architect commit passes and waives the stamp ───────────
R1="$(_mkrepo)"
( cd "$R1" && echo x > .ai/blueprints/new.md && echo y > plans/p.md && git add .ai/blueprints/new.md plans/p.md )
_run "$R1" architect
assert_contains "E-214.01a: architect in-scope commit is allowed (rc 0)" "0" "$_RC"
assert_contains "E-214.01b: the lane announces the waiver" "ARCHITECT_LANE" "$_OUT"
assert_not_contains "E-214.01c: no sovereignty block for an in-scope commit" "SOVEREIGNTY_BLOCK" "$_OUT"

# ── E-214.2: any out-of-scope path blocks ────────────────────────────────────
R2="$(_mkrepo)"
( cd "$R2" && echo x > .ai/ok.md && echo z > src/impl.js && git add .ai/ok.md src/impl.js )
_run "$R2" architect
assert_contains "E-214.02a: a single src/ path blocks the whole commit (rc 1)" "1" "$_RC"
assert_contains "E-214.02b: the block is labelled [SOVEREIGNTY_BLOCK]" "SOVEREIGNTY_BLOCK" "$_OUT"
assert_contains "E-214.02c: the offending path is named" "src/impl.js" "$_OUT"
assert_contains "E-214.02d: the hint routes work to the Engineer" "skill: ai-handoff" "$_OUT"
assert_contains "E-214.02e: the hint says how to unstage" "git restore --staged" "$_OUT"
# Mixed staging must not be partially accepted — .ai/ok.md is in scope but the commit
# is atomic, so the whole thing is refused.
assert_contains "E-214.02f: an in-scope sibling does not rescue the commit" "SOVEREIGNTY_BLOCK" "$_OUT"

# tests/ is Engineer territory too — .ai/ and plans/ are the ONLY architect paths.
R3="$(_mkrepo)"
( cd "$R3" && echo t > tests/x.sh && git add tests/x.sh )
_run "$R3" architect
assert_contains "E-214.03a: tests/ is out of scope for the Architect" "SOVEREIGNTY_BLOCK" "$_OUT"
R4="$(_mkrepo)"
( cd "$R4" && echo r > README.md && git add README.md )
_run "$R4" architect
assert_contains "E-214.03b: a repo-root file is out of scope" "SOVEREIGNTY_BLOCK" "$_OUT"

# ── E-214.4: RENAMES — both sides of the rename are checked ──────────────────
# --name-only would report only the NEW path, so moving a file OUT of .ai/ would slip
# through. -M + --name-status is what makes this catchable.
R5="$(_mkrepo)"
( cd "$R5" && echo keep > .ai/moveme.md && git add .ai/moveme.md && git commit -qm seed --no-verify
  git mv .ai/moveme.md src/moveme.md )
_run "$R5" architect
assert_contains "E-214.04a: renaming a file OUT of .ai/ is blocked" "SOVEREIGNTY_BLOCK" "$_OUT"
R6="$(_mkrepo)"
( cd "$R6" && echo keep > .ai/moveme.md && git add .ai/moveme.md && git commit -qm seed --no-verify
  git mv .ai/moveme.md .ai/renamed.md )
_run "$R6" architect
assert_contains "E-214.04b: renaming WITHIN .ai/ is allowed" "ARCHITECT_LANE" "$_OUT"

# ── E-214.5: the Engineer path is completely unchanged ──────────────────────
R7="$(_mkrepo)"
( cd "$R7" && echo z > src/impl.js && git add src/impl.js )
_run "$R7" engineer
assert_contains "E-214.05a: engineer commits src/ freely (rc 0, stamp present)" "0" "$_RC"
assert_not_contains "E-214.05b: engineer never sees the sovereignty block" "SOVEREIGNTY_BLOCK" "$_OUT"
assert_not_contains "E-214.05c: engineer never gets the stamp waiver" "ARCHITECT_LANE" "$_OUT"

# An unset role must behave exactly like engineer — no new restriction by default.
R8="$(_mkrepo)"
( cd "$R8" && echo z > src/impl.js && git add src/impl.js )
_OUT="$( cd "$R8" && env HOME="$GH" REIN_SKIP_STANDARDS=1 \
         CLAUDE_CODE_SESSION_ID= bash "$HOOK" 2>&1 )"; _RC=$?
assert_contains "E-214.05d: no role set → engineer behaviour, rc 0" "0" "$_RC"
assert_not_contains "E-214.05e: no role set → no sovereignty block" "SOVEREIGNTY_BLOCK" "$_OUT"

# ── E-214.6: the waiver is real — it must hold with NO stamp at all ──────────
R9="$(_mkrepo)"
( cd "$R9" && rm -f .ai/state.json && echo x > plans/only.md && git add plans/only.md )
# E-218 (D-055 R4) NARROWED this: the waiver now requires a VERIFIED session record.
# `_run` deliberately empties CLAUDE_CODE_SESSION_ID, so this is the env-only path and
# the stamp requirement correctly still applies. The waiver itself is asserted with a
# minted record in E-218.01a.
_run "$R9" architect
assert_contains "E-214.06a: env-only architect in-scope does NOT waive the stamp (E-218)" "1" "$_RC"
assert_contains "E-214.06b: and it says why the waiver did not apply" "still applies" "$_OUT"
_run "$R9" engineer
assert_contains "E-214.06c: the SAME commit as engineer is still Gate-2 blocked" "1" "$_RC"
assert_contains "E-214.06d: engineer sees the Gate 2 banner" "GATE 2" "$_OUT"

# ── E-214.7: role resolution prefers the HMAC record over the env ────────────
# The record is authoritative: an architect-bound session cannot become the Engineer by
# exporting REIN_CALLER_ROLE=engineer. E-294: the token is minted from a real launch record
# and bound to the session process (as-session.sh), never from a role word in argv.
R10="$(_mkrepo)"
( cd "$R10" && echo z > src/impl.js && git add src/impl.js )
_OUT="$( cd "$R10" && HOME="$GH" bash "$AS" architect e214-l -- env REIN_CALLER_ROLE=engineer REIN_PANE_ROLE=engineer \
         REIN_SKIP_STANDARDS=1 CLAUDE_CODE_SESSION_ID=e214-l bash "$HOOK" 2>&1 )"; _RC=$?
assert_contains "E-214.07a: the HMAC record beats a forged REIN_CALLER_ROLE=engineer" \
  "SOVEREIGNTY_BLOCK" "$_OUT"
assert_status 0 "E-214.07b: --verify-role returns the recorded role inside its session" \
  bash -c "cd '$R10' && [[ \"\$(HOME='$GH' bash '$AS' architect e214-v -- node --no-warnings '$SAFE_EXEC' --verify-role e214-v)\" == 'architect' ]]"
assert_status 1 "E-214.07c: --verify-role exits 1 for an unknown session" \
  bash -c "HOME='$GH' node --no-warnings '$SAFE_EXEC' --verify-role no-such-session >/dev/null 2>&1"

# ── E-214.8: rollback escape hatch ──────────────────────────────────────────
R11="$(_mkrepo)"
( cd "$R11" && echo z > src/impl.js && git add src/impl.js )
_OUT="$( cd "$R11" && env HOME="$GH" REIN_CALLER_ROLE=architect REIN_SKIP_GIT_LANE=1 \
         REIN_SKIP_STANDARDS=1 \
         CLAUDE_CODE_SESSION_ID= bash "$HOOK" 2>&1 )"; _RC=$?
assert_contains "E-214.08a: REIN_SKIP_GIT_LANE=1 bypasses the lane" "0" "$_RC"
assert_not_contains "E-214.08b: bypass produces no sovereignty block" "SOVEREIGNTY_BLOCK" "$_OUT"
# E-294 (D-087 r3): the four git-hook opt-outs are recorded residuals — each is LOUD when
# honoured (REIN_SKIP_GIT_LANE was silent before).
assert_contains "E-294.08c: REIN_SKIP_GIT_LANE=1 prints its [GATE_SKIPPED] line" \
  "[GATE_SKIPPED] REIN_SKIP_GIT_LANE=1" "$_OUT"
assert_contains "E-294.08d: REIN_SKIP_STANDARDS=1 prints its [GATE_SKIPPED] line" \
  "[GATE_SKIPPED] REIN_SKIP_STANDARDS=1" "$_OUT"
_OUT="$( cd "$R11" && env HOME="$GH" REIN_SKIP_CONFLICT_GATE=1 REIN_SKIP_STANDARDS=1 \
         CLAUDE_CODE_SESSION_ID= bash "$HOOK" 2>&1 )"
assert_contains "E-294.08e: REIN_SKIP_CONFLICT_GATE=1 prints its [GATE_SKIPPED] line" \
  "[GATE_SKIPPED] REIN_SKIP_CONFLICT_GATE=1" "$_OUT"
_OUT="$( cd "$R11" && env HOME="$GH" CLAUDE_CODE_SESSION_ID= bash "$HOOK" 2>&1 )"
assert_not_contains "E-294.08f: without any opt-out no [GATE_SKIPPED] line is printed" "[GATE_SKIPPED]" "$_OUT"
_OUT="$( cd "$R11" && env HOME="$GH" REIN_CI_SKIP=1 REIN_CI_SKIP_REASON=e294-test \
         bash "${REPO_ROOT}/hooks/pre-push.sh" origin x </dev/null 2>&1 )"
assert_contains "E-294.08g: REIN_CI_SKIP=1 (pre-push) prints its [GATE_SKIPPED] line" \
  "[GATE_SKIPPED] REIN_CI_SKIP=1" "$_OUT"

# ── E-214.9: other Gate 2 checks still run for an architect commit ──────────
# The waiver covers the [CRITIC_STAMP] ONLY. The credential scan lives in the E-82
# standards gate, which must still fire — assert it is not short-circuited by the lane.
assert_status 0 "E-214.09a: the standards gate is still invoked before the lane" \
  bash -c "grep -n 'check_standards_gate' '$HOOK' | head -1 | cut -d: -f1 | \
           xargs -I{} test {} -lt \$(grep -n 'check_architect_git_lane\$' '$HOOK' | tail -1 | cut -d: -f1)"
assert_status 0 "E-214.09b: the co-modification warning still runs before the lane" \
  bash -c "grep -n 'check_architect_src_comodification\$' '$HOOK' | head -1 | cut -d: -f1 | \
           xargs -I{} test {} -lt \$(grep -n 'check_architect_git_lane\$' '$HOOK' | tail -1 | cut -d: -f1)"
assert_status 0 "E-214.09c: markdown sync still runs before the lane" \
  bash -c "grep -n 'check_markdown_sync\$' '$HOOK' | head -1 | cut -d: -f1 | \
           xargs -I{} test {} -lt \$(grep -n 'check_architect_git_lane\$' '$HOOK' | tail -1 | cut -d: -f1)"

# ── E-214.10: security-audit regressions (2026-09-07) ───────────────────────
# Each case below reproduces something that WORKED against the first cut.
echo "  [E-214.10] security-audit regressions"

# S1 (BLOCKING) — the lane read the staged list from a process substitution and never
# checked git's exit status. A failed `git diff` produced zero records, the
# out-of-scope list stayed empty, and the waiver was granted: any diff hiccup became a
# full Gate 2 bypass with arbitrary staged content. Proven with a stubbed git.
R12="$(_mkrepo)"
mkdir -p "$R12/stub"
cat > "$R12/stub/git" <<'EOS'
#!/usr/bin/env bash
if [[ "${1:-}" == "diff" ]]; then exit 128; fi
exec /usr/bin/git "$@"
EOS
chmod +x "$R12/stub/git"
( cd "$R12" && echo evil > src/evil.js && /usr/bin/git add src/evil.js )
# E-286: the hook pins its PATH, so the stub reaches it through the recorded toolchain
# (its dir is first on the pinned PATH), never through an inherited PATH.
tc_overlay_home "$R12/fh" "$R12/stub"
_OUT="$( cd "$R12" && env HOME="$R12/fh" REIN_CALLER_ROLE=architect \
         REIN_SKIP_STANDARDS=1 \
         CLAUDE_CODE_SESSION_ID= bash "$HOOK" 2>&1 )"; _RC=$?
assert_contains "E-214.10a: a FAILED git diff blocks (fail-closed), never waives" "1" "$_RC"
assert_not_contains "E-214.10b: a failed diff never grants the stamp waiver" "ARCHITECT_LANE" "$_OUT"
assert_contains "E-214.10c: the fail-closed block explains itself" "fail-closed" "$_OUT"

# S1b — nothing staged must NOT be treated as an architect-scoped commit; it falls
# through to the normal Gate 2 stamp check instead of collecting a waiver.
R13="$(_mkrepo)"
( cd "$R13" && rm -f .ai/state.json )
_run "$R13" architect
assert_not_contains "E-214.10d: an EMPTY diff grants no waiver" "ARCHITECT_LANE" "$_OUT"
assert_contains "E-214.10e: an empty diff falls through to Gate 2" "1" "$_RC"

# S3 — git emits a bare `.ai` entry only when .ai/ is no longer a directory. Matching
# it as in-scope let a commit that DELETES every .ai/ file and stages a symlink in its
# place ride through on the waiver.
R14="$(_mkrepo)"
( cd "$R14" && echo x > .ai/seed.md && git add .ai/seed.md && git commit -qm seed --no-verify
  rm -rf .ai && ln -s /tmp .ai && git add -A .ai >/dev/null 2>&1 )
_run "$R14" architect
assert_contains "E-214.10f: replacing .ai/ with a symlink is BLOCKED" "SOVEREIGNTY_BLOCK" "$_OUT"
assert_not_contains "E-214.10g: and it never collects the waiver" "ARCHITECT_LANE" "$_OUT"

# S5 — the role comparison was exact-match, so `Architect` or a trailing space
# silently disabled the lane for a real Architect. (Since E-294 this is the row-4 advisory
# env, restrict-only — a variant must still restrict.)
for _r in "Architect" "ARCHITECT" "architect "; do
  R15="$(_mkrepo)"
  ( cd "$R15" && echo z > src/x.js && git add src/x.js )
  _run "$R15" "$_r"
  assert_contains "E-214.10h [role='$_r']: case/whitespace variant still activates the lane" \
    "SOVEREIGNTY_BLOCK" "$_OUT"
done

# S6 — `--verify-role --mint-token` was captured by the mint block, which exits 0
# printing nothing, violating the contract that exit 0 means a role on stdout.
assert_status 1 "E-214.10i: --verify-role is not captured by the mint mode scan" \
  bash -c "HOME='$GH' node --no-warnings '$SAFE_EXEC' --verify-role --mint-\"\$(printf 'to')ken\" >/dev/null 2>&1"
# The real mint path must still work — the fix binds modes to argv[2], so verify it.
# E-294: minted the production way (launch record + `--mint-token <sid> <session pid>`).
assert_status 0 "E-214.10j: the normal mint path still works after the argv fix" \
  bash -c "cd '$REPO_ROOT' && [[ \"\$(HOME='$GH' bash '$AS' architect e214-m -- node --no-warnings '$SAFE_EXEC' --verify-role e214-m)\" == 'architect' ]]"

# Round-2 nit: `read` folds EXTRA tab fields into the last variable, so a 4-field
# record would hide a path inside path2 (`.ai/b<TAB>src/c` matches the .ai/* arm) while
# the field counter still reported progress. Not reachable from git today, which is
# precisely why the guard belongs here rather than in a comment.
R16="$(_mkrepo)"
mkdir -p "$R16/stub"
cat > "$R16/stub/git" <<'EOS'
#!/usr/bin/env bash
if [[ "${1:-}" == "diff" ]]; then printf 'R100\t.ai/a\t.ai/b\tsrc/c\n'; exit 0; fi
exec /usr/bin/git "$@"
EOS
chmod +x "$R16/stub/git"
# E-286: the hook pins its PATH, so the stub reaches it through the recorded toolchain
# (its dir is first on the pinned PATH), never through an inherited PATH.
tc_overlay_home "$R16/fh" "$R16/stub"
_OUT="$( cd "$R16" && env HOME="$R16/fh" REIN_CALLER_ROLE=architect \
         REIN_SKIP_STANDARDS=1 \
         CLAUDE_CODE_SESSION_ID= bash "$HOOK" 2>&1 )"; _RC=$?
assert_contains "E-214.10k: a 4-field diff record blocks (fail-closed)" "1" "$_RC"
assert_contains "E-214.10l: and it says the shape was unexpected" "Unexpected diff record shape" "$_OUT"
assert_not_contains "E-214.10m: a hidden 4th-field path never collects the waiver" "ARCHITECT_LANE" "$_OUT"

# Both CLI modes are argv[2]-bound, so neither can capture the other's arguments.
# Prove WHICH mode handled the call: with no session token (E-294: the union, i.e. the
# Architect's path rules — the env var below no longer selects anything), --check-path must treat
# "--verify-role" as an ordinary (out-of-scope) path and exit 2. If the verify block had
# captured the argv instead, it would exit 0 or 1 and never reach a path verdict.
assert_status 2 "E-214.10n: --check-path handles its own argv, not --verify-role's" \
  bash -c "HOME='$GH' REIN_CALLER_ROLE=engineer node --no-warnings '$SAFE_EXEC' --check-path --verify-role >/dev/null 2>&1"

# ── E-218 (D-055 R4): the stamp waiver requires a VERIFIED record ───────────
# The path-scope BLOCK may act on the env fallback — restricting an unverified session
# is safe in the strict direction. The WAIVER may not: it is a hole in the Engineer's
# own quality gate, and `.ai/` contains REVIEWS.md, the file Gate 2 reads. So anyone
# exporting REIN_CALLER_ROLE=architect could previously commit stamp-file edits with
# no stamp.
# E-329: Gate 2 no longer reads REVIEWS.md, and a commit touching ONLY .ai/ is bookkeeping
# for every role (operator ruling 2026-10-19). The waiver rows below therefore stage a
# plans/ file — in the Architect lane, not bookkeeping — so "no waiver" still means
# "Gate 2 blocks".
echo "  [E-218] waiver requires a verified session record"

_e218_verdict() {  # <repo> <env...> → rc + label  (no session: env / chain-less rows)
  local d="$1"; shift
  local out rc
  out="$( cd "$d" && env HOME="$GH" "$@" \
          REIN_SKIP_STANDARDS=1 bash "$HOOK" 2>&1 )"; rc=$?
  _e218_label "$rc" "$out"
}
_e218_as() {  # <repo> <architect|engineer|none> <sid> <env...> → rc + label, the hook a child of a real session
  local d="$1" role="$2" sid="$3"; shift 3
  local out rc
  out="$( cd "$d" && HOME="$GH" bash "$AS" "$role" "$sid" -- env "$@" \
          REIN_SKIP_STANDARDS=1 bash "$HOOK" 2>&1 )"; rc=$?
  _e218_label "$rc" "$out"
}
_e218_label() {
  local rc="$1" out="$2" l=pass
  printf '%s' "$out" | grep -q SOVEREIGNTY_BLOCK && l=BLOCK
  printf '%s' "$out" | grep -q 'stamp waived' && l=WAIVED
  printf '%s' "$out" | grep -q 'still applies' && l=NO_WAIVER
  printf '%s' "$out" | grep -q 'GATE 2' && l="${l}+gate2"
  printf 'rc=%s %s' "$rc" "$l"
}
_nostamp_ai() { local R; R="$(_mkrepo)"; ( cd "$R" && rm -f .ai/state.json && echo x > plans/n.md && git add plans/n.md ); printf '%s' "$R"; }
_src()        { local R; R="$(_mkrepo)"; ( cd "$R" && echo z > src/x.js && git add src/x.js ); printf '%s' "$R"; }

# ── Row 1: verified record — the ONLY waiver source ──────────────────────────
# Verified record + in scope + NO stamp → waiver applies.
assert_contains "E-218.01a: verified architect record waives the stamp" "rc=0 WAIVED" \
  "$(_e218_as "$(_nostamp_ai)" architect e218-a1 CLAUDE_CODE_SESSION_ID=e218-a1 REIN_CALLER_ROLE=engineer)"

# Env-only architect + in scope + NO stamp → NO waiver, Gate 2 still blocks.
_E218_OUT="$(_e218_verdict "$(_nostamp_ai)" CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE=architect)"
assert_contains "E-218.01b: an env-only architect gets NO waiver" "NO_WAIVER" "$_E218_OUT"
assert_contains "E-218.01c: and Gate 2 still blocks the commit" "rc=1" "$_E218_OUT"

# Env-only architect + in scope + WITH a stamp → passes normally.
R="$(_mkrepo)"; ( cd "$R" && echo x > .ai/n.md && git add .ai/n.md )
assert_contains "E-218.01d: env-only architect passes when a stamp exists" "rc=0" \
  "$(_e218_verdict "$R" CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE=architect)"

# The RESTRICTION still acts on the env fallback — strict in both directions.
assert_contains "E-218.02a: env-only architect is still path-restricted" "BLOCK" \
  "$(_e218_verdict "$(_src)" CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE=architect)"
assert_contains "E-218.02b: verified architect is path-restricted too" "BLOCK" \
  "$(_e218_as "$(_src)" architect e218-a2 CLAUDE_CODE_SESSION_ID=e218-a2 REIN_CALLER_ROLE=engineer)"

# Engineer unchanged in both directions.
assert_contains "E-218.03a: engineer with a verified record commits src/ freely" "rc=0" \
  "$(_e218_as "$(_src)" engineer e218-e1 CLAUDE_CODE_SESSION_ID=e218-e1 REIN_CALLER_ROLE=architect)"
R="$(_mkrepo)"; ( cd "$R" && rm -f .ai/state.json && echo z > src/x.js && git add src/x.js )
assert_contains "E-218.03b: engineer with no stamp still hits Gate 2" "gate2" \
  "$(_e218_as "$R" engineer e218-e2 CLAUDE_CODE_SESSION_ID=e218-e2 REIN_CALLER_ROLE=engineer)"
assert_contains "E-294.03c: a plain launch (no record → engineer token) commits src/ freely" "rc=0" \
  "$(_e218_as "$(_src)" none e218-n1 CLAUDE_CODE_SESSION_ID=e218-n1)"

# ── Row 2: a live launch record on the commit's process chain (no session id) ──
# Restrict-only and env-free: clearing the session id no longer drops a `rein pane` session
# out of its lane — and it never waives.
assert_contains "E-294.R2a: architect record on the chain, session id cleared → path-restricted" "BLOCK" \
  "$(_e218_as "$(_src)" architect e294-r2a CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE=engineer REIN_PANE_ROLE=engineer)"
_E294_OUT="$(_e218_as "$(_nostamp_ai)" architect e294-r2b CLAUDE_CODE_SESSION_ID=)"
assert_contains "E-294.R2b: …and in-scope with no stamp it gets NO waiver (row 2 never waives)" "NO_WAIVER" "$_E294_OUT"
assert_contains "E-294.R2c: …so Gate 2 blocks" "rc=1" "$_E294_OUT"
# Row 2 ranks above row 3: an engineer record on the chain beats a non-verifying session id
# (row 3 alone would be the union and block src/).
assert_contains "E-294.R2d: engineer record on the chain outranks a non-verifying session id" "rc=0 pass" \
  "$(_e218_as "$(_src)" engineer e294-r2d CLAUDE_CODE_SESSION_ID=e294-not-a-session)"

# ── Row 3: a session id present but not verifying → the union ────────────────
assert_contains "E-294.R3a: an unknown session id (no record on the chain) is path-restricted" "BLOCK" \
  "$(_e218_verdict "$(_src)" CLAUDE_CODE_SESSION_ID=e294-no-such-session REIN_CALLER_ROLE=engineer REIN_PANE_ROLE=engineer)"
_E294_OUT="$(_e218_verdict "$(_nostamp_ai)" CLAUDE_CODE_SESSION_ID=e294-no-such-session)"
assert_contains "E-294.R3b: …and in-scope with no stamp gets NO waiver" "NO_WAIVER" "$_E294_OUT"
assert_contains "E-294.R3c: …so Gate 2 blocks" "rc=1" "$_E294_OUT"

# A session id BORROWED from another live session (T-GITLANE-001 residual 2, closed): its
# token is HMAC-valid but bound to a process that is not an ancestor of this commit, so it
# verifies nothing — the commit gets the union, not the other session's role or its waiver.
_bg_session() {  # <repo> <role> <sid> → starts a live session in <repo> in the background; prints its pid
  local d="$1"; shift
  local stop="${GH}/stop-$2"
  ( cd "$d" && HOME="$GH" bash "$AS" "$1" "$2" -- \
      bash -c 'i=0; while [ ! -e "$1" ] && [ -d "${1%/*}" ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done' _ "$stop" ) >/dev/null 2>&1 &   # REIN_SLEEP_ALLOWED: keep-alive loop of a child session shell (no assert.sh there); ends on the stop file
  local pid=$!
  on_exit "touch '${stop}'; wait_for '! kill -0 ${pid} 2>/dev/null' 3000 100 2>/dev/null; kill ${pid} 2>/dev/null || true"
  wait_for "[ -e \"${GH}/.rein/run/role-$2.lock\" ]" 10000 100 || true
  printf '%s' "$pid"
}
# Each borrowed session runs in the very repo the commit happens in, so the only thing that
# differs from a legitimate commit is the process chain (not the project).
_R3D="$(_src)"; _R3E="$(_nostamp_ai)"
_BE_PID="$(_bg_session "$_R3D" engineer e294-live-eng)"
_BA_PID="$(_bg_session "$_R3E" architect e294-live-arch)"
assert_status 0 "E-294.R3d0: both live sessions hold a token (fixture)" \
  test -f "${GH}/.rein/run/role-e294-live-eng.lock" -a -f "${GH}/.rein/run/role-e294-live-arch.lock"
assert_contains "E-294.R3d: a borrowed ENGINEER session id does not unlock src/ (union)" "BLOCK" \
  "$(_e218_verdict "$_R3D" CLAUDE_CODE_SESSION_ID=e294-live-eng)"
_E294_OUT="$(_e218_verdict "$_R3E" CLAUDE_CODE_SESSION_ID=e294-live-arch)"
assert_contains "E-294.R3e: a borrowed ARCHITECT session id does not collect the waiver" "NO_WAIVER" "$_E294_OUT"
assert_contains "E-294.R3f: …so Gate 2 blocks" "rc=1" "$_E294_OUT"
touch "${GH}/stop-e294-live-eng" "${GH}/stop-e294-live-arch"
wait "$_BE_PID" "$_BA_PID" 2>/dev/null || true

# ── Row 4: the advisory env (restrict-only), then engineer — covered by E-214.01–06 above ──
assert_contains "E-294.R4a: no session id, no record, env engineer → engineer behaviour" "rc=0 pass" \
  "$(_e218_verdict "$(_src)" CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE=engineer)"

# The role source must be RETURNED, not assigned inside a command substitution — a
# variable set in the subshell never reaches the caller, and the first cut of this
# change did exactly that, so the waiver silently never fired.
assert_status 0 "E-218.04a: role source is returned as <source>:<role>" \
  grep -q "printf 'record:%s'" "$HOOK"
assert_status 0 "E-218.04b: the subshell trap is recorded in the comment" \
  grep -q "set in the SUBSHELL and lost" "$HOOK"
assert_status 0 "E-218.04c: THREAT_MODEL item 4 is marked FIXED" \
  grep -q "FIXED in E-218" "${REPO_ROOT}/.ai/THREAT_MODEL.md"

# ── E-326 (D-102): the sync gate rides this suite's real-hook harness ─────────
# Replaces the P-30 ±2 count check: after a pull the tracked TASKS.md runs ahead of the
# local index by design, so the count blocked the next commit. A team project checks
# record ↔ index parity instead, and the post-merge import is what keeps it.
_seed_state() {  # <repo> <team:0|1> — two tasks through the real writer; TASKS.md generated
  ( cd "$1" && node --no-warnings --input-type=module -e "
      const { getDb, addTask, regenerateViews } = await import('file://${REPO_ROOT}/src/mcp/shared/state-db.js');
      const { migrateTeam } = await import('file://${REPO_ROOT}/src/mcp/shared/record-migrate.mjs');
      const db = getDb('.ai');
      addTask('.ai', db, { owner: 'Engineer (Claude)', description: 'one' });
      addTask('.ai', db, { owner: 'Engineer (Claude)', description: 'two' });
      regenerateViews('.ai', db);
      if ('$2' === '1') {
        const { execFileSync } = await import('child_process');
        execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'seed', '--no-verify']);
        const r = migrateTeam('.ai', { trunk: 'master' }); if (!r.ok) throw new Error(r.message);
      }
    " && printf 'state.sqlite*\n' >> .ai/.gitignore && git add -A && git commit -qm state --no-verify \
    && node --no-warnings --input-type=module -e "
      const { getDb } = await import('file://${REPO_ROOT}/src/mcp/shared/state-db.js');
      const { insertStamp } = await import('file://${REPO_ROOT}/src/mcp/shared/record-store.mjs');
      insertStamp('.ai', getDb('.ai'), { type: 'CRITIC_STAMP', agent: 't', timestamp: new Date().toISOString(), summary: 'seeded' });
    " )   # E-329: the review that unlocks the next commit names THIS HEAD
}
S1="$(_mkrepo)"; _seed_state "$S1" 0
# What a pull leaves behind: three tasks in the tracked view that the local index lacks.
( cd "$S1" && printf -- '- [ ] E-3: pulled\n- [ ] E-4: pulled\n- [ ] E-5: pulled\n' >> .ai/TASKS.md \
    && git add .ai/TASKS.md && echo s > src/s.js && git add src/s.js )
_run "$S1" engineer
# The removed count check only ran where sqlite3 exists; without it g1 cannot tell old from new.
skip_unless_cmd sqlite3 "E-326.g1 needs sqlite3 (the removed check ran only with it)" && \
  assert_status 0 "E-326.g1: a pull that adds three tasks no longer blocks the next commit (rc 0)" test "$_RC" -eq 0
assert_not_contains "E-326.g1b: …no SYNC GATE" "SYNC GATE" "$_OUT"

S2="$(_mkrepo)"; _seed_state "$S2" 1
( cd "$S2" && node --no-warnings --input-type=module -e "
    const { writeRecord, taskRecord } = await import('file://${REPO_ROOT}/src/mcp/shared/record-store.mjs');
    writeRecord('.ai', 'task', 'E-900', taskRecord({ id: 'E-900', owner: 'Engineer (Claude)', status: 'OPEN', description: 'pulled', created_at: new Date().toISOString() }), { fresh: true });
  " && echo s > src/s.js && git add src/s.js )
_run "$S2" engineer
assert_status 0 "E-326.g2: a team record the index lacks blocks the commit (rc 1)" test "$_RC" -eq 1
assert_contains "E-326.g2b: …naming the record" "E-900 has a record file but no index row" "$_OUT"
assert_contains "E-326.g2c: …and the one command that fixes it" "fix: rein state import" "$_OUT"
( cd "$S2" && HOME="$GH" node --no-warnings "${REPO_ROOT}/src/shared/cli-state.mjs" state import >/dev/null )
_run "$S2" engineer
assert_status 0 "E-326.g3: after the import the same commit passes (rc 0)" test "$_RC" -eq 0

# ── E-329 (D-102 §Component 6): Gate 2 wants a [CRITIC_STAMP] for the commit's parent ──
# The real hook in a repo with a parent commit; shared/stamp-gate.mjs resolves from $GH
# (this checkout's src/shared). The seven-day window is gone in both directions.
echo "  [E-329] stamps bound to a commit"
_head() { git -C "$1" rev-parse HEAD; }

G1="$(_mkrepo)"; ( cd "$G1" && echo z > src/x.js && git add src/x.js )
_run "$G1" engineer
assert_status 0 "E-329.01a: a CRITIC_STAMP for HEAD lets a src/ commit through (rc 0)" test "$_RC" -eq 0
assert_contains "E-329.01b: …and says which review" "[GATE2] HEAD $(_head "$G1" | cut -c1-7) reviewed: CRITIC_STAMP by t@t" "$_OUT"

G2="$(_mkrepo)"; _G2_OLD="$(_head "$G2")"
( cd "$G2" && echo more > README && git commit -qam next --no-verify && echo z > src/x.js && git add src/x.js )
_run "$G2" engineer
assert_status 0 "E-329.02a: a stamp for an OLDER sha blocks (rc 1)" test "$_RC" -eq 1
assert_contains "E-329.02b: …naming HEAD" "no CRITIC_STAMP for HEAD $(_head "$G2" | cut -c1-7)" "$_OUT"
assert_contains "E-329.02c: …and the sha the newest stamp is for" "is for ${_G2_OLD:0:7}" "$_OUT"

G3="$(_mkrepo)"; ( cd "$G3" && rm -f .ai/state.json && echo done > .ai/LOG.md && git add .ai/LOG.md )
_run "$G3" engineer
assert_status 0 "E-329.03a: a bookkeeping-only .ai/ commit needs no stamp (rc 0)" test "$_RC" -eq 0
assert_contains "E-329.03b: …and says so" "bookkeeping-only commit" "$_OUT"
_run "$G3" architect
assert_status 0 "E-329.03c: …for an env-only Architect too (operator ruling: any role)" test "$_RC" -eq 0
G3B="$(_mkrepo)"; ( cd "$G3B" && echo m > .ai/m.md && git add .ai/m.md && git commit -qm m --no-verify \
    && rm -f .ai/state.json && git mv .ai/m.md src/m.md )
_run "$G3B" engineer
assert_status 0 "E-329.03d: a rename OUT of .ai/ is not bookkeeping (rc 1)" test "$_RC" -eq 1
assert_contains "E-329.03d2: …blocked by Gate 2 itself" "no CRITIC_STAMP for HEAD" "$_OUT"
G3C="$(_mkrepo)"; ( cd "$G3C" && rm -f .ai/state.json && echo d > .ai/LOG.md && echo z > src/x.js && git add .ai/LOG.md src/x.js )
_run "$G3C" engineer
assert_status 0 "E-329.03e: .ai/ plus one src/ file is not bookkeeping (rc 1)" test "$_RC" -eq 1
assert_contains "E-329.03e2: …blocked by Gate 2 itself" "no CRITIC_STAMP for HEAD" "$_OUT"

G4="$(_mkrepo)"; ( cd "$G4" && _seed_stamp "$(git rev-parse HEAD)" "2026-01-01T00:00:00Z" && echo z > src/x.js && git add src/x.js )
_run "$G4" engineer
assert_status 0 "E-329.04: a stamp months old for the current HEAD still passes (no seven-day window)" test "$_RC" -eq 0

G5="$(_mkrepo)"
( cd "$G5" && rm -f .ai/state.json && mkdir -p .ai/stamps/2026-10 && printf '{"tasks":[]}\n' > .ai/state.json \
    && node --no-warnings --input-type=module -e "
      const { writeRecord, stampRecord, stampRecordId } = await import('file://${REPO_ROOT}/src/mcp/shared/record-store.mjs');
      const { writeFileSync } = await import('fs');
      writeFileSync('.ai/project.json', JSON.stringify({ schema: 2 }) + '\n');
      const s = { type: 'CRITIC_STAMP', agent: 'critic', summary: 'teammate review', timestamp: '2026-10-19T09:00:00Z' };
      const sha = '$(_head "$G5")';
      writeRecord('.ai', 'stamp', stampRecordId('.ai', s, sha), stampRecord(s, sha, 'b@x.test'), { fresh: true });
    " && echo z > src/x.js && git add src/x.js )
_run "$G5" engineer
assert_status 0 "E-329.05a: a teammate's pulled stamp record for HEAD lets the commit through (rc 0)" test "$_RC" -eq 0
assert_contains "E-329.05b: …naming the teammate" "CRITIC_STAMP by b@x.test" "$_OUT"

G6="$(_mkrepo)"
( cd "$G6" && rm -f .ai/state.json && printf '[CRITIC_STAMP] %s | typed by hand\n' "$(date +%Y-%m-%d)" > .ai/REVIEWS.md \
    && echo z > src/x.js && git add src/x.js )
_run "$G6" engineer
assert_status 0 "E-329.06: a [CRITIC_STAMP] line typed into REVIEWS.md unlocks nothing (rc 1)" test "$_RC" -eq 1
assert_contains "E-329.06b: …blocked by Gate 2 itself" "no CRITIC_STAMP at all" "$_OUT"

# Bookkeeping is an allowlist, not all of .ai/ (critic_security P1): a launch-flag file needs a review.
G8="$(_mkrepo)"; ( cd "$G8" && rm -f .ai/state.json && echo '{"launch":["--dangerously"]}' > .ai/providers.json && git add .ai/providers.json )
_run "$G8" engineer
assert_status 0 "E-329.08a: .ai/providers.json alone is NOT bookkeeping (rc 1)" test "$_RC" -eq 1
assert_contains "E-329.08b: …Gate 2 asks for a review" "no CRITIC_STAMP" "$_OUT"
G8B="$(_mkrepo)"; ( cd "$G8B" && rm -f .ai/state.json && mkdir -p .ai/ci .ai/tasks && echo '{}' > ".ai/ci/$(git rev-parse HEAD).json" \
    && echo '{}' > .ai/tasks/E-1.json && git add .ai/ci .ai/tasks )
_run "$G8B" engineer
assert_status 0 "E-329.08c: a CI record and a task record are bookkeeping (rc 0)" test "$_RC" -eq 0

# The first-commit skip is the repository's FIRST commit only (critic_security / critic_tests P1).
G9="$(test_tmpdir glfirst)"
( cd "$G9" && git init -q . && git config user.email t@t && git config user.name t \
    && mkdir -p .ai src && echo z > src/x.js && git add src/x.js )
_run "$G9" engineer
assert_status 0 "E-329.09a: the repository's first commit needs no stamp (rc 0)" test "$_RC" -eq 0
assert_contains "E-329.09b: …and says why" "first commit of the repository" "$_OUT"
G9B="$(_mkrepo)"; ( cd "$G9B" && git checkout -q --orphan elsewhere && echo z > src/x.js && git add src/x.js )
_run "$G9B" engineer
assert_status 0 "E-329.09c: an orphan branch in a repo WITH history is blocked (rc 1)" test "$_RC" -eq 1
assert_contains "E-329.09d: …naming the reason" "HEAD is not a commit in a repository that has history" "$_OUT"


# Fail closed: no stamp-gate.mjs in the install mirror is a BLOCK, not a pass.
GH_NOGATE="$(test_tmpdir glnogate)"; mkdir -p "${GH_NOGATE}/.rein/shared"
ln -s "${REPO_ROOT}/src/mcp" "${GH_NOGATE}/.rein/mcp"
for _f in "${REPO_ROOT}"/src/shared/*; do
  [[ "${_f##*/}" == "stamp-gate.mjs" ]] || ln -s "$_f" "${GH_NOGATE}/.rein/shared/${_f##*/}"
done
tc_fixture_home "$GH_NOGATE"   # E-345: node is found, so only the missing stamp-gate.mjs can explain the verdict
G7="$(_mkrepo)"; ( cd "$G7" && echo z > src/x.js && git add src/x.js )
_OUT="$( cd "$G7" && env HOME="$GH_NOGATE" REIN_CALLER_ROLE=engineer REIN_SKIP_STANDARDS=1 CLAUDE_CODE_SESSION_ID= bash "$HOOK" 2>&1 )"; _RC=$?
assert_status 0 "E-329.07a: a missing stamp-gate helper blocks the commit (rc 1)" test "$_RC" -eq 1
assert_contains "E-329.07b: …and names what is missing" "stamp-gate.mjs or node unavailable" "$_OUT"

# ── E-41 (from git_hooks_stub — E-301): the git hooks are thin execution stubs ──
# install_git_hooks emits a stub instead of a full copy of pre-commit.sh / post-commit.sh; the
# chained-hook path still preserves a user's pre-existing hook; do_sync upgrades legacy copies
# in place; and the stub fails closed when the canonical script is missing (Gate 2 contract).
AI_BIN="${REPO_ROOT}/src/bin/rein"

# ── Sandbox setup ─────────────────────────────────────────────────────────────
# Create a throwaway git repo and a fake REIN install directory under it so
# every test runs against an isolated environment. REIN is exported via env
# so the ai bin uses our sandbox instead of the real ~/.rein.

TMP="$(mktemp -d -t rein-git-hooks-XXXXXX)"
tc_fixture_home "$TMP"   # E-345 (D-109 r1): the toolchain record the hooks pin
on_exit 'rm -rf "$TMP"'

PROJECT="${TMP}/project"
FAKE_REIN="${TMP}/.rein"

mkdir -p "$PROJECT" "${FAKE_REIN}/hooks" "${FAKE_REIN}/templates"
git -C "$PROJECT" init -q
# Provide canonical hook sources so install_git_hooks finds them.
cat > "${FAKE_REIN}/hooks/pre-commit.sh" <<'PRE'
#!/usr/bin/env bash
# Rein Gate 2 — Quality Gate
echo "canonical pre-commit ran" >&2
exit 0
PRE
cat > "${FAKE_REIN}/hooks/post-commit.sh" <<'POST'
#!/usr/bin/env bash
# Rein TASKS.md Auto-Sync
echo "canonical post-commit ran" >&2
exit 0
POST
cat > "${FAKE_REIN}/hooks/state-import.sh" <<'IMP'
#!/usr/bin/env bash
echo "canonical state-import ran: $*"
exit 0
IMP
mkdir -p "${FAKE_REIN}/shared" && : > "${FAKE_REIN}/shared/cli-state.mjs"
chmod +x "${FAKE_REIN}/hooks/"*.sh

# Source only the helpers we need from src/bin/rein. The bin guards its
# dispatcher behind argv parsing, so sourcing it without args is safe.
# To keep the test fast and side-effect free we extract the functions via
# a tiny shim that defines REIN, HOME, then pulls in the function bodies.
SHIM="${TMP}/shim.sh"
cat > "$SHIM" <<SHIM
REIN="${FAKE_REIN}"
HOME="${TMP}"  # so \$HOME/.rein/hooks/... resolves to the fake REIN
SHIM

# Extract just the helper block (lines around install_git_hooks &
# _upgrade_legacy_git_hooks) by sourcing the full bin in a fresh subshell
# with --no-op argv. Easier: pull functions via awk into the shim.
awk '
  /^_write_post_(merge|checkout|rewrite)_stub\(\)/ { print; next }
  /^IMPORT_HOOKS=/ { print; next }
  /^_write_import_stub\(\)/ { p = 1 }
  /^_install_record_merge_driver\(\)/ { p = 1 }
  /^_stub_backup_of\(\)/ { p = 1 }
  /^_expected_stub\(\)/ { p = 1 }
  /^_refresh_stub\(\)/ { p = 1 }
  /^REIN_STUB_MARKER=/ { p = 1 }
  /^_upgrade_legacy_git_hooks\(\)/ { p = 1 }
  /^install_git_hooks\(\)/ { p = 1 }
  /^_write_pre_commit_stub\(\)/ { p = 1 }
  /^_write_post_commit_stub\(\)/ { p = 1 }
  /^_is_rein_stub\(\)/ { p = 1 }
  p { print }
  /^}/ && p { p = 0; print "" }
' "$AI_BIN" >> "$SHIM"

source "$SHIM"

# ── T-HOOK-S01: Fresh install → stub written, not a copy ─────────────────────
echo ""
echo "  [T-HOOK-S01] Fresh install emits stub"

(
  cd "$PROJECT"
  install_git_hooks >/dev/null
)

PRE_DST="${PROJECT}/.git/hooks/pre-commit"
POST_DST="${PROJECT}/.git/hooks/post-commit"

assert_status 0 "pre-commit hook installed" test -f "$PRE_DST"
assert_status 0 "pre-commit hook executable" test -x "$PRE_DST"
assert_status 0 "pre-commit is a stub (carries E-41 marker)" \
  grep -q "Rein Execution Stub (E-41)" "$PRE_DST"

# Stub must be small. The legacy copy is hundreds of lines; a stub is < 30.
PRE_LINES="$(wc -l < "$PRE_DST")"
assert_status 0 "pre-commit stub under 30 lines (got ${PRE_LINES})" \
  bash -c "[[ $PRE_LINES -lt 30 ]]"

# E-290 (D-083 r4): CANONICAL is the install-time ABSOLUTE path — never $HOME, which a
# session's environment could redirect.
assert_status 0 "pre-commit stub's CANONICAL is the absolute install path" \
  grep -qF "CANONICAL=\"${FAKE_REIN}/hooks/pre-commit.sh\"" "$PRE_DST"
assert_status 1 "pre-commit stub's CANONICAL never names \$HOME" \
  grep -q 'CANONICAL="\$HOME' "$PRE_DST"

assert_status 0 "pre-commit stub forwards \"\$@\" to canonical" \
  grep -qE 'exec /bin/bash -p "\$CANONICAL" "\$@"' "$PRE_DST"

assert_status 0 "post-commit hook installed" test -f "$POST_DST"
assert_status 0 "post-commit is a stub (carries E-41 marker)" \
  grep -q "Rein Execution Stub (E-41)" "$POST_DST"

POST_LINES="$(wc -l < "$POST_DST")"
assert_status 0 "post-commit stub under 30 lines (got ${POST_LINES})" \
  bash -c "[[ $POST_LINES -lt 30 ]]"

# ── T-HOOK-S02: Stub executes the canonical hook end-to-end ──────────────────
echo ""
echo "  [T-HOOK-S02] Stub runs canonical script"

# The shim points HOME at $TMP so $HOME/.rein/hooks/pre-commit.sh resolves
# to the fake canonical. Run the stub directly under that HOME.
PRE_OUTPUT="$(HOME="$TMP" bash "$PRE_DST" 2>&1)"
assert_contains "stub invokes canonical pre-commit" "canonical pre-commit ran" "$PRE_OUTPUT"

POST_OUTPUT="$(HOME="$TMP" bash "$POST_DST" 2>&1)"
assert_contains "stub invokes canonical post-commit" "canonical post-commit ran" "$POST_OUTPUT"

# ── T-HOOK-S03: Re-running install_git_hooks is idempotent ───────────────────
echo ""
echo "  [T-HOOK-S03] Idempotent install"

PRE_BEFORE_HASH="$(md5sum "$PRE_DST" | awk '{print $1}')"
(
  cd "$PROJECT"
  install_git_hooks >/dev/null
)
PRE_AFTER_HASH="$(md5sum "$PRE_DST" | awk '{print $1}')"
assert_status 0 "pre-commit stub unchanged on second install" \
  bash -c "[[ '$PRE_BEFORE_HASH' == '$PRE_AFTER_HASH' ]]"

# ── T-HOOK-S04: Legacy copy upgraded in place ────────────────────────────────
echo ""
echo "  [T-HOOK-S04] do_sync upgrades legacy copies"

# Replace the stub with a "legacy copy" — i.e. the literal canonical script
# without the stub marker — and confirm _upgrade_legacy_git_hooks rewrites it.
cp "${FAKE_REIN}/hooks/pre-commit.sh" "$PRE_DST"
chmod +x "$PRE_DST"
# Sanity: it is NOT yet a stub.
assert_status 1 "legacy copy lacks stub marker (precondition)" \
  grep -q "Rein Execution Stub (E-41)" "$PRE_DST"

(
  cd "$PROJECT"
  _upgrade_legacy_git_hooks >/dev/null
)

assert_status 0 "legacy pre-commit upgraded to stub" \
  grep -q "Rein Execution Stub (E-41)" "$PRE_DST"

# Same for post-commit.
cp "${FAKE_REIN}/hooks/post-commit.sh" "$POST_DST"
chmod +x "$POST_DST"
assert_status 1 "legacy post-commit copy lacks stub marker (precondition)" \
  grep -q "Rein Execution Stub (E-41)" "$POST_DST"
(
  cd "$PROJECT"
  _upgrade_legacy_git_hooks >/dev/null
)
assert_status 0 "legacy post-commit upgraded to stub" \
  grep -q "Rein Execution Stub (E-41)" "$POST_DST"

# ── T-HOOK-S05: Third-party hook preserved via chain ─────────────────────────
echo ""
echo "  [T-HOOK-S05] Third-party hook chained, not overwritten"

# Reset .git/hooks and seed a user-authored hook lacking Rein markers.
rm -f "$PRE_DST" "$POST_DST" "${PRE_DST}.pre-rein" "${POST_DST}.pre-rein"
cat > "$PRE_DST" <<'USER'
#!/usr/bin/env bash
# user's own hook
echo "user pre-commit ran" >&2
exit 0
USER
chmod +x "$PRE_DST"

(
  cd "$PROJECT"
  install_git_hooks >/dev/null
)

assert_status 0 "user hook backed up to .pre-rein" test -f "${PRE_DST}.pre-rein"
assert_status 0 "user hook content preserved" \
  grep -q "user pre-commit ran" "${PRE_DST}.pre-rein"
assert_status 0 "new pre-commit is the Rein stub" \
  grep -q "Rein Execution Stub (E-41)" "$PRE_DST"
assert_status 0 "stub references the backup chain" \
  grep -q "pre-commit.pre-rein" "$PRE_DST"

# Run the chained stub under HOME=$TMP so the fake canonical also resolves.
CHAIN_OUT="$(HOME="$TMP" bash "$PRE_DST" 2>&1)"
assert_contains "chained stub runs user hook"      "user pre-commit ran"      "$CHAIN_OUT"
assert_contains "chained stub runs canonical hook" "canonical pre-commit ran" "$CHAIN_OUT"

# ── T-HOOK-S06: Fail-closed when canonical missing (pre-commit) ──────────────
echo ""
echo "  [T-HOOK-S06] Fail-closed when canonical missing"

# Reset to a fresh stub install.
rm -f "$PRE_DST" "${PRE_DST}.pre-rein" "$POST_DST" "${POST_DST}.pre-rein"
(
  cd "$PROJECT"
  install_git_hooks >/dev/null
)

# Move the canonicals away — since E-290 the stub names the absolute install path, so
# redirecting HOME no longer makes it "missing" (that redirection is what E-290 closes).
mv "${FAKE_REIN}/hooks/pre-commit.sh" "${FAKE_REIN}/hooks/pre-commit.sh.away"
mv "${FAKE_REIN}/hooks/post-commit.sh" "${FAKE_REIN}/hooks/post-commit.sh.away"
EMPTY_HOME="$(mktemp -d)"
PRE_FAIL_OUT="$(HOME="$EMPTY_HOME" bash "$PRE_DST" 2>&1)"
PRE_FAIL_RC=0
HOME="$EMPTY_HOME" bash "$PRE_DST" >/dev/null 2>&1 || PRE_FAIL_RC=$?
assert_contains "pre-commit warns about missing canonical" "canonical missing" "$PRE_FAIL_OUT"
assert_status 0 "pre-commit fails closed (exit != 0)" bash -c "[[ $PRE_FAIL_RC -ne 0 ]]"

# Post-commit must fail OPEN — advisory, never blocks an otherwise-good commit.
POST_FAIL_OUT="$(HOME="$EMPTY_HOME" bash "$POST_DST" 2>&1)"
POST_FAIL_RC=0
HOME="$EMPTY_HOME" bash "$POST_DST" >/dev/null 2>&1 || POST_FAIL_RC=$?
assert_contains "post-commit warns about missing canonical" "canonical missing" "$POST_FAIL_OUT"
assert_status 0 "post-commit fails open (exit 0)" bash -c "[[ $POST_FAIL_RC -eq 0 ]]"

rm -rf "$EMPTY_HOME"
mv "${FAKE_REIN}/hooks/pre-commit.sh.away" "${FAKE_REIN}/hooks/pre-commit.sh"
mv "${FAKE_REIN}/hooks/post-commit.sh.away" "${FAKE_REIN}/hooks/post-commit.sh"

# ── T-HOOK-S07: Argument forwarding ──────────────────────────────────────────
echo ""
echo "  [T-HOOK-S07] Stub forwards arguments"

# Replace the canonical with one that echoes its argv so we can assert
# faithful forwarding through the stub.
cat > "${FAKE_REIN}/hooks/pre-commit.sh" <<'PRE_ECHO'
#!/usr/bin/env bash
# Rein Gate 2 — argv probe
echo "ARGV: $*"
exit 0
PRE_ECHO
chmod +x "${FAKE_REIN}/hooks/pre-commit.sh"

ARGV_OUT="$(HOME="$TMP" bash "$PRE_DST" alpha beta 2>&1 || true)"
assert_contains "alpha forwarded to canonical" "alpha" "$ARGV_OUT"
assert_contains "beta forwarded to canonical"  "beta"  "$ARGV_OUT"

# ── E-326: the state import stubs and the record merge driver ────────────────
# Extends T-HOOK-S01/S06/S07 to the three hooks that import pulled team records.
echo ""
echo "  [E-326] post-merge / post-checkout / post-rewrite stubs + merge driver"
rm -f "${PROJECT}/.git/hooks/post-merge"
printf '#!/bin/bash\necho "user post-merge ran"\n' > "${PROJECT}/.git/hooks/post-merge"
chmod +x "${PROJECT}/.git/hooks/post-merge"
( cd "$PROJECT" && install_git_hooks >/dev/null 2>&1 )
for h in post-merge post-checkout post-rewrite; do
  assert_status 0 "E-326.01 ${h} is a Rein stub" grep -q "Rein Execution Stub (E-41)" "${PROJECT}/.git/hooks/${h}"
  assert_contains "E-326.02 ${h} runs the canonical with its own name and git's args" \
    "canonical state-import ran: ${h} x y" "$(HOME="$TMP" bash "${PROJECT}/.git/hooks/${h}" x y 2>&1)"
done
assert_status 0 "E-326.03 an existing user post-merge hook is kept and chained" test -f "${PROJECT}/.git/hooks/post-merge.pre-rein"
assert_contains "E-326.04 …and still runs first" "user post-merge ran" "$(HOME="$TMP" bash "${PROJECT}/.git/hooks/post-merge" 2>&1)"
assert_contains "E-326.05 the rein-record merge driver is configured with the install path" \
  "${FAKE_REIN}/shared/cli-state.mjs' state merge-driver %O %A %B %P" "$(git -C "$PROJECT" config merge.rein-record.driver)"
mv "${FAKE_REIN}/hooks/state-import.sh" "${FAKE_REIN}/hooks/state-import.sh.away"
_imp_rc=0; _imp_out="$(HOME="$TMP" bash "${PROJECT}/.git/hooks/post-checkout" 2>&1)" || _imp_rc=$?
assert_status 0 "E-326.06 a missing canonical fails OPEN (an import never blocks git)" test "$_imp_rc" -eq 0
assert_contains "E-326.07 …and says so" "canonical missing" "$_imp_out"
mv "${FAKE_REIN}/hooks/state-import.sh.away" "${FAKE_REIN}/hooks/state-import.sh"

# ── E-326: the REAL canonical hooks/state-import.sh (the rows above use a fake one) ──
CANON_IMPORT="${REPO_ROOT}/hooks/state-import.sh"
SI="$(mktemp -d -t rein-si-XXXXXX)"; on_exit "rm -rf '$SI'"
mkdir -p "$SI/home/.rein/bin" "$SI/team/.ai" "$SI/legacy/.ai"
printf '#!/bin/bash\nprintf "%%s|" "$@" >> "%s/calls"; printf "\\n" >> "%s/calls"\n' "$SI" "$SI" > "$SI/home/.rein/bin/rein"
chmod +x "$SI/home/.rein/bin/rein"
tc_fixture_home "$SI/home"   # E-345 (D-109 r1): the toolchain record the hooks pin ($SI/nohome stays bare: no mirror at all)
git -C "$SI/team" init -q; git -C "$SI/legacy" init -q
printf '{"schema":2}\n' > "$SI/team/.ai/project.json"
_si() { ( cd "$SI/$1" && HOME="${2:-$SI/home}" /bin/bash -p "$CANON_IMPORT" "${@:3}" ) 2>&1; }
_si team "" post-merge 0 >/dev/null
assert_contains "E-326.08 post-merge in a team project runs the mirror's rein state import" "state|import|--hook|post-merge|" "$(cat "$SI/calls" 2>/dev/null)"
: > "$SI/calls"; _si team "" post-checkout old new 0 >/dev/null
assert_status 1 "E-326.09 post-checkout of a FILE (flag 0) imports nothing" test -s "$SI/calls"
_si team "" post-checkout old new 1 >/dev/null
assert_contains "E-326.10 post-checkout of a branch (flag 1) imports" "--hook|post-checkout|" "$(cat "$SI/calls" 2>/dev/null)"
: > "$SI/calls"; _si legacy "" post-merge 0 >/dev/null
assert_status 1 "E-326.11 a legacy project (no .ai/project.json) exits before ai/node" test -s "$SI/calls"
_si_rc=0; _si_out="$(_si team "$SI/nohome" post-merge 0)" || _si_rc=$?
assert_status 0 "E-326.12 no ai in the mirror → exit 0" test "$_si_rc" -eq 0
assert_contains "E-326.13 …with a WARN naming the fix" "WARN:" "$_si_out"

assert_summary
