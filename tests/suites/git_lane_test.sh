#!/usr/bin/env bash
# REIN_SUITE_TIMEOUT=283   (E-401, D-138 r3: 3x the slowest green hosted run — 33 s Linux / 94 s macOS, CENSUS_SUITE ms over 10 main CI runs 41145231705..42041035881, 2026-11-06)
# git_lane_test.sh — E-214 (architect-provider-parity.md §Git Lane, D-054):
# the Architect-scoped commit lane.
#
# A Claude Architect HAS git, so the D-053 proxy-commit workaround (the
# Engineer commits the Architect's .ai/ edits) is retired for same-provider Triads.
# The lane is the LAST checkpoint before history: an Architect may commit only paths
# under .ai/ or plans/. E-464 (D-170 r9): no role needs a review stamp to commit any more —
# review is checked at task close — so the lane's stamp waiver went with Gate 2's stamp check.
#
# Every assertion drives the REAL hook in a disposable git repo with real staged files.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${REPO_ROOT}/hooks/pre-commit.sh"

echo "── Suite: git_lane_test (E-214) ─────────────────────────────────────"

_RC=0   # declared up front: the suite runs under `set -u`

# E-294 (D-087, Component 8g), E-463: pre-commit resolves the role from two sources, in order —
# (1) a live launch record on the commit process's chain → chain, (2) the advisory env, then
# engineer. Every hook run below uses a throwaway HOME (rule 6) whose ~/.rein/{mcp,shared} are
# this checkout's src/ — the hook locates launch-record.py there (never the operator's install,
# and never a launch record on the operator's own process chain). Real sessions come from
# as-session.sh.
GH="$(test_tmpdir glhome)"
mkdir -p "${GH}/.rein"
tc_link_shared "$GH"   # E-345 (D-109 r1): mirror = this tree + the toolchain record the hooks pin
ln -s "${REPO_ROOT}/src/mcp" "${GH}/.rein/mcp"
AS="${REPO_ROOT}/tests/lib/as-session.sh"

# Disposable repo with a parent commit; the ONLY variable under test is the role + staged
# scope. E-464: no stamp is seeded — pre-commit asks for none.
_mkrepo() {
  local d; d="$(test_tmpdir glrepo)"
  ( cd "$d"
    git init -q .
    git config user.email t@t; git config user.name t; git config commit.gpgsign false
    mkdir -p .ai/blueprints plans src tests
    echo base > README
    git add README && git commit -q --no-verify -m base
  )
  printf '%s' "$d"
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
           CLAUDE_CODE_SESSION_ID= \
           bash "$HOOK" 2>&1 )"
  _RC=$?
}

# ── E-214.1: in-scope architect commit passes ────────────────────────────────
R1="$(_mkrepo)"
( cd "$R1" && echo x > .ai/blueprints/new.md && echo y > plans/p.md && git add .ai/blueprints/new.md plans/p.md )
_run "$R1" architect
assert_contains "E-214.01a: architect in-scope commit is allowed (rc 0)" "0" "$_RC"
assert_contains "E-214.01b: the lane announces the in-scope commit" "ARCHITECT_LANE" "$_OUT"
assert_not_contains "E-214.01c: no sovereignty block for an in-scope commit" "SOVEREIGNTY_BLOCK" "$_OUT"

# ── E-214.2: any out-of-scope path blocks ────────────────────────────────────
R2="$(_mkrepo)"
( cd "$R2" && echo x > .ai/ok.md && echo z > src/impl.js && git add .ai/ok.md src/impl.js )
_run "$R2" architect
assert_contains "E-214.02a: a single src/ path blocks the whole commit (rc 1)" "1" "$_RC"
assert_contains "E-214.02b: the block is labelled [SOVEREIGNTY_BLOCK]" "SOVEREIGNTY_BLOCK" "$_OUT"
assert_contains "E-214.02c: the offending path is named" "src/impl.js" "$_OUT"
assert_contains "E-214.02d: the hint routes work to the Engineer" "rein handoff --to engineer" "$_OUT"
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
assert_contains "E-214.05a: engineer commits src/ freely (rc 0)" "0" "$_RC"
assert_not_contains "E-214.05b: engineer never sees the sovereignty block" "SOVEREIGNTY_BLOCK" "$_OUT"
assert_not_contains "E-214.05c: engineer never enters the architect lane" "ARCHITECT_LANE" "$_OUT"

# An unset role must behave exactly like engineer — no new restriction by default.
R8="$(_mkrepo)"
( cd "$R8" && echo z > src/impl.js && git add src/impl.js )
_OUT="$( cd "$R8" && env HOME="$GH" REIN_SKIP_STANDARDS=1 \
         CLAUDE_CODE_SESSION_ID= bash "$HOOK" 2>&1 )"; _RC=$?
assert_contains "E-214.05d: no role set → engineer behaviour, rc 0" "0" "$_RC"
assert_not_contains "E-214.05e: no role set → no sovereignty block" "SOVEREIGNTY_BLOCK" "$_OUT"

# ── E-214.6 / E-464 (D-169 r8, D-170 r9): no review stamp at commit time ─────
# A Tier 1 commit — and any other — passes pre-commit with no stamp at all; review by tier is
# checked when the task closes (tests/unit/completion-gates.test.mjs, [REVIEW_GATE]).
R9="$(_mkrepo)"
( cd "$R9" && echo x > plans/only.md && git add plans/only.md )
_run "$R9" architect
assert_contains "E-214.06a: env-only architect in-scope commit with no stamp passes (rc 0)" "0" "$_RC"
assert_not_contains "E-214.06b: …and sees no Gate 2 banner" "GATE 2" "$_OUT"
_run "$R9" engineer
assert_contains "E-214.06c: the SAME commit as engineer passes too (rc 0)" "0" "$_RC"
assert_not_contains "E-214.06d: …with no CRITIC_STAMP request" "CRITIC_STAMP" "$_OUT"

# ── E-214.7: role resolution prefers the HMAC record over the env ────────────
# The record is authoritative: an architect-bound session cannot become the Engineer by
# exporting REIN_CALLER_ROLE=engineer (a real launch record on the chain, as-session.sh).
R10="$(_mkrepo)"
( cd "$R10" && echo z > src/impl.js && git add src/impl.js )
_OUT="$( cd "$R10" && HOME="$GH" bash "$AS" architect e214-l -- env REIN_CALLER_ROLE=engineer REIN_PANE_ROLE=engineer \
         CLAUDE_CODE_SESSION_ID=e214-l bash "$HOOK" 2>&1 )"; _RC=$?
assert_contains "E-214.07a: the launch record beats a forged REIN_CALLER_ROLE=engineer" \
  "SOVEREIGNTY_BLOCK" "$_OUT"
# ── E-471: the block names the role's source, and for union the walk's reason ──
# A fail-closed fallback (union) must not read as a real Architect. Extends E-214.7.
# (1) a live record naming ANOTHER project on the chain → union, with the reason and the fix.
R10b="$(_mkrepo)"; OTHER="$(test_tmpdir glother)"; mkdir -p "$OTHER/.ai"
( cd "$R10b" && echo z > src/impl.js && git add src/impl.js )
_OUT="$( cd "$OTHER" && HOME="$GH" bash "$AS" engineer e471-u -- \
         bash -c 'cd "$1" && exec bash "$2"' _ "$R10b" "$HOOK" 2>&1 >/dev/null )"; _RC=$?
assert_status 0 "E-471.1a: a record for another project blocks out-of-scope paths (rc 1)" test "$_RC" -eq 1
assert_contains "E-471.1b: …naming the source" "source: union" "$_OUT"
assert_contains "E-471.1c: …and the walk's reason" "is for another project" "$_OUT"
assert_contains "E-471.1d: …and the fix" "rein pane <role>" "$_OUT"
# (2) a live architect record for this project → chain, with no reason text.
_OUT="$( cd "$R10" && HOME="$GH" bash "$AS" architect e471-c -- bash "$HOOK" 2>&1 >/dev/null )"
assert_contains "E-471.2a: an architect record prints source: chain (on stderr)" "source: chain)" "$_OUT"
assert_not_contains "E-471.2b: …and no reason" "is for another project" "$_OUT"
# (3) a reason holding a newline and escape sequences prints on one line, controls removed —
# including a C1 nested inside another (\xc2 \xc2\x9b \x9b, F-471-1).
# A stub launch-record.py stands in for a record whose content reaches the reason.
GH3="$(test_tmpdir glhome3)"; mkdir -p "$GH3/.rein/shared"
printf '%s\n' 'import sys' \
  'sys.stdout.buffer.write(b"union\tline-one\nline-two \x1b[31mRED\x07 \xc2\x9b2J \xc2\xc2\x9b\x9b2K end")' \
  > "$GH3/.rein/shared/launch-record.py"
tc_link_shared "$GH3"; ln -s "${REPO_ROOT}/src/mcp" "${GH3}/.rein/mcp"
_OUT="$( cd "$R10" && env HOME="$GH3" REIN_CALLER_ROLE= bash "$HOOK" 2>&1 >/dev/null )"; _RC=$?
_why_line="$(grep -a 'Session role:' <<< "$_OUT")"
assert_status 0 "E-471.3: the union fallback blocks (rc 1)" test "$_RC" -eq 1
assert_contains "E-471.3a: the reason is printed on the role line" "line-one line-two [31mRED 2J 2K end" "$_why_line"
assert_status 1 "E-471.3b: no control character reaches the output" \
  bash -c 'LC_ALL=C grep -aq "[[:cntrl:]]" <<< "$1"' _ "$_why_line"
assert_status 1 "E-471.3c: no C1 control (UTF-8) reaches the output" \
  bash -c 'LC_ALL=C grep -aq $'"'"'\xc2[\x80-\x9f]'"'"' <<< "$1"' _ "$_why_line"

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
# E-294.08d/e (the standards and conflict-marker gates' [GATE_SKIPPED] lines) went with those
# gates (E-467, D-170 r4: pre-commit keeps the lane, machine-local and publish checks only).
_OUT="$( cd "$R11" && env HOME="$GH" CLAUDE_CODE_SESSION_ID= bash "$HOOK" 2>&1 )"
assert_not_contains "E-294.08f: without any opt-out no [GATE_SKIPPED] line is printed" "[GATE_SKIPPED]" "$_OUT"
_OUT="$( cd "$R11" && env HOME="$GH" REIN_CI_SKIP=1 REIN_CI_SKIP_REASON=e294-test \
         bash "${REPO_ROOT}/hooks/pre-push.sh" origin x </dev/null 2>&1 )"
assert_contains "E-294.08g: REIN_CI_SKIP=1 (pre-push) prints its [GATE_SKIPPED] line" \
  "[GATE_SKIPPED] REIN_CI_SKIP=1" "$_OUT"

# ── E-214.9: other Gate 2 checks still run for an architect commit ──────────
# The credential scan lives in the E-82 standards gate, which must still fire — assert it is
# not short-circuited by the lane.
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
# out-of-scope list stayed empty, and the lane passed: any diff hiccup let arbitrary staged
# content through. Proven with a stubbed git.
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
assert_contains "E-214.10a: a FAILED git diff blocks (fail-closed)" "1" "$_RC"
assert_not_contains "E-214.10b: a failed diff never passes the lane" "ARCHITECT_LANE" "$_OUT"
assert_contains "E-214.10c: the fail-closed block explains itself" "fail-closed" "$_OUT"

# S1b — nothing staged is not an architect-scoped commit: nothing is classified or announced.
R13="$(_mkrepo)"
_run "$R13" architect
assert_not_contains "E-214.10d: an EMPTY diff is not announced as in-scope" "ARCHITECT_LANE" "$_OUT"

# S3 — git emits a bare `.ai` entry only when .ai/ is no longer a directory. Matching
# it as in-scope let a commit that DELETES every .ai/ file and stages a symlink in its
# place ride through the lane.
R14="$(_mkrepo)"
( cd "$R14" && echo x > .ai/seed.md && git add .ai/seed.md && git commit -qm seed --no-verify
  rm -rf .ai && ln -s /tmp .ai && git add -A .ai >/dev/null 2>&1 )
_run "$R14" architect
assert_contains "E-214.10f: replacing .ai/ with a symlink is BLOCKED" "SOVEREIGNTY_BLOCK" "$_OUT"
assert_not_contains "E-214.10g: and it is never announced as in-scope" "ARCHITECT_LANE" "$_OUT"

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
assert_not_contains "E-214.10m: a hidden 4th-field path never passes the lane" "ARCHITECT_LANE" "$_OUT"

# ── E-218 / E-294: role resolution for the lane ─────────────────────────────
# The path-scope BLOCK may act on every source — restricting is safe in the strict direction.
# E-464 removed the stamp waiver these rows also pinned (a verified record was its only
# source); what stays is who is path-restricted and that no role needs a stamp to commit.
echo "  [E-218] role sources for the lane"

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
  grep -q SOVEREIGNTY_BLOCK <<< "$out" && l=BLOCK
  grep -q 'GATE 2' <<< "$out" && l="${l}+gate2"
  printf 'rc=%s %s' "$rc" "$l"
}
_nostamp_ai() { local R; R="$(_mkrepo)"; ( cd "$R" && echo x > plans/n.md && git add plans/n.md ); printf '%s' "$R"; }
_src()        { local R; R="$(_mkrepo)"; ( cd "$R" && echo z > src/x.js && git add src/x.js ); printf '%s' "$R"; }

# ── Row 1: a launch record on the chain ───────────────────────────────────────────────────
assert_contains "E-218.01a: architect record, in scope, no stamp → passes" "rc=0 pass" \
  "$(_e218_as "$(_nostamp_ai)" architect e218-a1 CLAUDE_CODE_SESSION_ID=e218-a1 REIN_CALLER_ROLE=engineer)"
assert_contains "E-218.01b: env-only architect, in scope, no stamp → passes (E-464)" "rc=0 pass" \
  "$(_e218_verdict "$(_nostamp_ai)" CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE=architect)"

# The RESTRICTION still acts on the env fallback — strict in both directions.
assert_contains "E-218.02a: env-only architect is still path-restricted" "BLOCK" \
  "$(_e218_verdict "$(_src)" CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE=architect)"
assert_contains "E-218.02b: an architect record is path-restricted too" "BLOCK" \
  "$(_e218_as "$(_src)" architect e218-a2 CLAUDE_CODE_SESSION_ID=e218-a2 REIN_CALLER_ROLE=engineer)"

# Engineer unchanged in both directions.
assert_contains "E-218.03a: engineer with a record commits src/ freely" "rc=0" \
  "$(_e218_as "$(_src)" engineer e218-e1 CLAUDE_CODE_SESSION_ID=e218-e1 REIN_CALLER_ROLE=architect)"
assert_contains "E-218.03b: engineer with no stamp commits src/ (E-464: review is checked at DONE)" "rc=0 pass" \
  "$(_e218_as "$(_src)" engineer e218-e2 CLAUDE_CODE_SESSION_ID=e218-e2 REIN_CALLER_ROLE=engineer)"
assert_contains "E-294.03c: a plain launch (no record → engineer) commits src/ freely" "rc=0" \
  "$(_e218_as "$(_src)" none e218-n1 CLAUDE_CODE_SESSION_ID=e218-n1)"

# ── Row 2: a live launch record on the commit's process chain (no session id) ──
# Restrict-only and env-free: clearing the session id no longer drops a `rein pane` session
# out of its lane.
assert_contains "E-294.R2a: architect record on the chain, session id cleared → path-restricted" "BLOCK" \
  "$(_e218_as "$(_src)" architect e294-r2a CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE=engineer REIN_PANE_ROLE=engineer)"
# A session id is a selector, never a role (E-463): with no record on the chain it is the
# plain-launch default, whatever id it names.
assert_contains "E-294.R3a: an unknown session id with no record commits as engineer" "rc=0 pass" \
  "$(_e218_verdict "$(_src)" CLAUDE_CODE_SESSION_ID=e294-no-such-session REIN_CALLER_ROLE=engineer REIN_PANE_ROLE=engineer)"

# ── Row 2: the advisory env (restrict-only), then engineer — covered by E-214.01–06 above ──
assert_contains "E-294.R4a: no session id, no record, env engineer → engineer behaviour" "rc=0 pass" \
  "$(_e218_verdict "$(_src)" CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE=engineer)"

# The role source must be RETURNED, not assigned inside a command substitution — a
# variable set in the subshell never reaches the caller.
assert_status 0 "E-218.04a: role source is returned as <source>:<role>" \
  grep -q "printf 'chain:architect'" "$HOOK"
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
    " && printf 'state.sqlite*\n' >> .ai/.gitignore && git add -A && git commit -qm state --no-verify )
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

# ── E-464 (D-169 r8, D-170 r9): the commit-time stamp check is gone ─────────────────
# E-329's rows (a [CRITIC_STAMP] bound to the parent HEAD; bookkeeping-only, first-commit and
# orphan-branch exceptions; a missing stamp-gate.mjs blocking) were removed with the check and
# with src/shared/stamp-gate.mjs. The stamp's sha still binds it, now at task close.
echo "  [E-464] no review stamp at commit time"
G1="$(_mkrepo)"; ( cd "$G1" && echo z > src/x.js && git add src/x.js )
_run "$G1" engineer
assert_status 0 "E-464.01a: a src/ commit with no stamp passes pre-commit (rc 0)" test "$_RC" -eq 0
assert_not_contains "E-464.01b: …and nothing asks for a review" "CRITIC_STAMP" "$_OUT"
assert_status 1 "E-464.01c: the hook no longer calls stamp-gate.mjs" grep -q 'stamp-gate.mjs' "$HOOK"

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
