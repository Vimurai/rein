#!/usr/bin/env bash
# pre_commit_hook_test.sh — what hooks/pre-commit.sh refuses (was conflict_gate_test, renamed for
# the behaviour by E-301; absorbs mcp_stdout_purity, pre_commit_standards_gate and
# standards_checker's process rows).
#
# E-238 (D-062): conflict markers and unparseable .ai JSON never reach a commit.
#
# On 2026-09-09 a conflicted `git stash pop` left conflict markers inside .ai/state.json.
# Git reported the conflict; the file was staged and committed to master UNREAD (44243bc).
# Master carried invalid JSON for four commits, and every task read goes through that file.
#
# The over-block half is the hard half, and it is weighted accordingly below. This
# repository's own prose QUOTES conflict markers — .ai/DECISIONS.md documents this very
# gate using them — so a substring search would make the gate reject the document that
# defines it. That is exactly the trap E-224 hit when a P0 blocked the Architect's text for
# quoting the example it was defining.
#
# `=======` alone is NOT treated as a marker: exactly seven '=' at line start is also a
# valid Markdown setext H2 underline, and rejecting on it would fail any document that
# happens to underline a heading.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${REPO_ROOT}/hooks/pre-commit.sh"

echo "── Suite: pre_commit_hook_test (E-238, E-48, E-82, E-80) ───────────"

# A scratch repo per case, so nothing here can touch the real one — and so the gate is
# exercised through `git diff --cached`, the way it runs for real, rather than by grepping
# a file directly.
_gate() {  # <filename> <content> → BLOCK | ALLOW
  local name="$1" body="$2"
  local d; d="$(mktemp -d)"
  ( cd "$d" && git init -q . && git config user.email t@t && git config user.name t
    mkdir -p "$(dirname "$name")" 2>/dev/null
    printf '%s' "$body" > "$name"
    git add "$name" >/dev/null 2>&1
    # Source only the two gate functions; the rest of the hook needs a provisioned project.
    source /dev/stdin <<< "$(sed -n '/^_conflict_marker_gate() {/,/^}/p;/^_ai_json_parse_gate() {/,/^}/p' "$HOOK")"
    if _conflict_marker_gate >/dev/null 2>&1 && _ai_json_parse_gate >/dev/null 2>&1; then
      echo ALLOW
    else
      echo BLOCK
    fi )
  rm -rf "$d"
}

# ── E-238.1: the real thing is caught ──────────────────────────────────────
_conflicted=$'{\n  "a": 1,\n<<<<<<< Updated upstream\n=======\n  "b": 2\n>>>>>>> Stashed changes\n}\n'
assert_contains "E-238.01a: a conflicted .ai/state.json is BLOCKED" "BLOCK" \
  "$(_gate .ai/state.json "$_conflicted")"
assert_contains "E-238.01b: markers in ANY staged file are blocked, not just .ai" "BLOCK" \
  "$(_gate src/thing.mjs $'const a = 1;\n<<<<<<< HEAD\nconst b = 2;\n=======\nconst b = 3;\n>>>>>>> other\n')"
assert_contains "E-238.01c: a bare marker with no label is blocked" "BLOCK" \
  "$(_gate notes.md $'text\n<<<<<<<\nmore\n>>>>>>>\n')"
assert_contains "E-238.01d: a rebase-style marker is blocked" "BLOCK" \
  "$(_gate f.txt $'x\n<<<<<<< HEAD (current)\ny\n>>>>>>> abc1234 (topic)\n')"

# ── E-238.2: unparseable .ai JSON is caught even WITHOUT markers ───────────
# The two failures are independent: a truncated write corrupts state.json with no conflict
# anywhere, and the gate must still stop it.
assert_contains "E-238.02a: a truncated .ai/state.json is BLOCKED" "BLOCK" \
  "$(_gate .ai/state.json '{ "tasks": [ {"id": "E-1"')"
assert_contains "E-238.02b: a trailing-comma .ai json is BLOCKED" "BLOCK" \
  "$(_gate .ai/roles.json '{ "roles": { "engineer": {} }, }')"
assert_contains "E-238.02c: valid .ai json is ALLOWED" "ALLOW" \
  "$(_gate .ai/state.json '{ "tasks": [], "stamps": [] }')"
# Scope: a non-.ai JSON file is not this gate's business — package.json is validated
# elsewhere, and widening here would block legitimate JSON-with-comments fixtures.
assert_contains "E-238.02d: a broken NON-.ai json is not this gate's business" "ALLOW" \
  "$(_gate fixtures/broken.json '{ "not": ')"

# ── E-238.3: OVER-BLOCK GUARD — prose that QUOTES markers must pass ────────
# Every case here exists in this repository or is a shape a document may legitimately have.
assert_contains "E-238.03a: backtick-quoted markers in prose are ALLOWED" "ALLOW" \
  "$(_gate .ai/DECISIONS.md 'The gate rejects a marker at line start (`<<<<<<< `, `=======`, `>>>>>>> `).')"
assert_contains "E-238.03b: a marker mid-line is not at line start" "ALLOW" \
  "$(_gate doc.md 'git leaves <<<<<<< HEAD in the file when a merge conflicts.')"
assert_contains "E-238.03c: an INDENTED marker (a fenced example) is ALLOWED" "ALLOW" \
  "$(_gate doc.md $'Example:\n\n    <<<<<<< HEAD\n    yours\n    >>>>>>> theirs\n')"
# THE SETEXT CASE. Seven '=' at line start is a valid Markdown H2 underline. A gate that
# rejected it would fail ordinary documents for looking like a conflict.
assert_contains "E-238.03d: a Markdown setext H2 underline is ALLOWED" "ALLOW" \
  "$(_gate doc.md $'Heading\n=======\n\nbody text\n')"
assert_contains "E-238.03e: a long === rule is ALLOWED" "ALLOW" \
  "$(_gate doc.md $'Title\n==========================\n\nbody\n')"
assert_contains "E-238.03f: this repo's own DECISIONS.md passes the gate" "ALLOW" \
  "$(_gate .ai/DECISIONS.md "$(cat "${REPO_ROOT}/.ai/DECISIONS.md")")"
assert_contains "E-238.03g: and its COMM.md, which narrates the incident" "ALLOW" \
  "$(_gate .ai/COMM.md "$(cat "${REPO_ROOT}/.ai/COMM.md" 2>/dev/null || echo 'no comm')")"

# NON-VACUITY for the 03 block: if _gate always answered ALLOW these would pass for the
# wrong reason, so pin that the same helper still blocks a genuine marker.
assert_contains "E-238.03h: the probe still BLOCKS a real marker (non-vacuity)" "BLOCK" \
  "$(_gate doc.md $'a\n<<<<<<< HEAD\nb\n>>>>>>> x\n')"

# ── E-238.4: the rollback exists, and the gate is wired into the hook ──────
assert_status 0 "E-238.04a: AI_OS_SKIP_CONFLICT_GATE is honoured" \
  grep -q 'AI_OS_SKIP_CONFLICT_GATE' "$HOOK"
assert_status 0 "E-238.04b: the gate runs in the hook, not merely defined" \
  grep -q '_conflict_marker_gate || _cm_ok=1' "$HOOK"
assert_status 0 "E-238.04c: the JSON gate runs too" \
  grep -q '_ai_json_parse_gate   || _cm_ok=1' "$HOOK"
# It must read the STAGED blob: worktree and index differ when only part of a file is
# staged, and what is being committed is what matters.
assert_status 0 "E-238.04d: the JSON gate inspects the STAGED blob, not the worktree" \
  bash -c "sed -n '/^_ai_json_parse_gate() {/,/^}/p' '$HOOK' | grep -q 'git show \":\\\${f}\"'"

# ── E-238.5: the rules are written down where they are read ───────────────
# E-282 (D-075/D-080): these rules moved out of ENGINEER.md into path-scoped
# .claude/rules/ files (canonical src/claude/rules/), which load when a matching file is
# read. The assertions follow the rule, not the file it used to live in.
_RULES="${REPO_ROOT}/src/claude/rules"
assert_status 0 "E-238.05a: the .ai/** rule forbids stashing bookkeeping" \
  grep -q 'Never move bookkeeping with' "${_RULES}/ai-bookkeeping.md"
assert_status 0 "E-238.05b: and the template matches (they are one file)" \
  diff -q "${REPO_ROOT}/ENGINEER.md" "${REPO_ROOT}/src/templates/ENGINEER.md"
assert_status 0 "E-238.05c: the triage rule is recorded (tests/** rule)" \
  grep -q 'presumed REAL until you have read its log' "${_RULES}/test-harness.md"
# The triage rule is only useful if it says what a flake claim REQUIRES; "rerun it" is how
# a real failure gets filed as noise.
assert_status 0 "E-238.05d: and it demands a NAMED nondeterminism, not just a rerun" \
  grep -q 'named nondeterminism' "${_RULES}/test-harness.md"
assert_status 0 "E-238.05e: commit-crafter carries the staging rule" \
  grep -q 'Stage named paths, not' "${REPO_ROOT}/src/claude/skills/commit-crafter/SKILL.md"
assert_status 0 "E-238.05f: commit-crafter mirror is in sync" \
  diff -q "${REPO_ROOT}/src/claude/skills/commit-crafter/SKILL.md" \
          "${REPO_ROOT}/.claude/skills/commit-crafter/SKILL.md"

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

# ── T-MPG-S10: pre-commit hook wiring ────────────────────────────────────────
echo ""
echo "  [T-MPG-S10] hooks/pre-commit.sh dispatches the gate"

assert_status 0 "pre-commit defines check_mcp_stdout_purity" \
  grep -q 'check_mcp_stdout_purity' "${REPO_ROOT}/hooks/pre-commit.sh"

assert_status 0 "pre-commit gates only when src/mcp staged" \
  grep -qE 'src/mcp/.*\\\.\(js\|mjs\|cjs\|ts\)\$' "${REPO_ROOT}/hooks/pre-commit.sh"

assert_status 0 "pre-commit calls checker only when applicable" \
  grep -q 'tests/lib/mcp_purity_check.sh' "${REPO_ROOT}/hooks/pre-commit.sh"

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

# ── E-82 (from pre_commit_standards_gate — E-301): the standards gate in the hook ──
# hooks/pre-commit.sh wires the E-80 standards-checker CLI into the commit (engineering-
# standards.md §Components 2, §Rollback Plan): check_standards_gate() defined and invoked,
# AI_OS_SKIP_STANDARDS=1 skips silently, the locator chain falls back gracefully, CLI exit 1
# prints [STANDARDS_BLOCK] and blocks, exit 0 is silent.

# ── T-PCS-S01: Source contract — function defined + invoked ─────────────────
echo ""
echo "  [T-PCS-S01] hooks/pre-commit.sh defines + calls check_standards_gate"

assert_status 0 "hook file exists"                       test -f "$HOOK"
assert_status 0 "bash syntax check passes"              bash -n "$HOOK"
assert_status 0 "check_standards_gate function defined" \
  grep -q 'check_standards_gate()' "$HOOK"
assert_status 0 "check_standards_gate invoked"          \
  grep -qE '^check_standards_gate$' "$HOOK"

# ── T-PCS-S02: Rollback contract — AI_OS_SKIP_STANDARDS=1 ───────────────────
echo ""
echo "  [T-PCS-S02] AI_OS_SKIP_STANDARDS=1 short-circuits the gate"

assert_status 0 "AI_OS_SKIP_STANDARDS guard present" \
  grep -q 'AI_OS_SKIP_STANDARDS' "$HOOK"
# The block must short-circuit BEFORE invoking the CLI.
assert_status 0 "skip guard appears before the CLI invocation" \
  python3 -c "
import re, sys
text = open('$HOOK').read()
# Find the function block
m = re.search(r'check_standards_gate\(\)\s*\{(.*?)\n\}\n', text, flags=re.S)
if not m: sys.exit(1)
body = m.group(1)
i_skip = body.find('AI_OS_SKIP_STANDARDS')
i_cli  = body.find('node \"\$cli\"')
sys.exit(0 if 0 <= i_skip < i_cli else 2)
"

# ── T-PCS-S03: Locator chain — in-tree → ~/.ai-os → graceful skip ────────────
echo ""
echo "  [T-PCS-S03] Locator chain matches E-58/E-65/E-75 pattern"

assert_status 0 "checks in-tree scripts/standards.mjs first" \
  grep -q '\${repo_root}/scripts/standards.mjs' "$HOOK"
assert_status 0 "falls back to ~/.ai-os/scripts/standards.mjs" \
  grep -q '\${HOME}/.ai-os/scripts/standards.mjs' "$HOOK"
assert_status 0 "graceful skip when both absent (pre-E-80 install)" \
  python3 -c "
import re, sys
text = open('$HOOK').read()
m = re.search(r'check_standards_gate\(\)\s*\{(.*?)\n\}\n', text, flags=re.S)
body = m.group(1) if m else ''
# After the locator chain there must be a 'return 0' path for the
# absent-CLI case (the third arm).
sys.exit(0 if re.search(r'cli=\"\"', body) and 'return 0' in body else 1)
"

# ── T-PCS-S04: Node-absent guard ─────────────────────────────────────────────
echo ""
echo "  [T-PCS-S04] Gate skips when node binary missing"

assert_status 0 "command -v node guard present" \
  grep -q 'command -v node' "$HOOK"

# ── T-PCS-S05: Block banner shape on CLI failure ────────────────────────────
echo ""
echo "  [T-PCS-S05] STANDARDS_BLOCK banner + exit 1 on CLI failure"

assert_status 0 "STANDARDS_BLOCK heredoc tag present"     grep -q 'STANDARDS_BLOCK' "$HOOK"
assert_status 0 "banner names the gate verbatim"          grep -q 'ENGINEERING-STANDARDS — COMMIT BLOCKED' "$HOOK"
assert_status 0 "banner documents the rollback flag"      \
  bash -c "awk '/STANDARDS_BLOCK/{f=1; next} /STANDARDS_BLOCK\$/{f=0} f' '$HOOK' | grep -q 'AI_OS_SKIP_STANDARDS=1'"
assert_status 0 "banner mentions kebab-case / shared / NDJSON fix hints" \
  bash -c "awk '/STANDARDS_BLOCK/{f=1; next} /STANDARDS_BLOCK\$/{f=0} f' '$HOOK' | grep -qiE 'kebab|shared|NDJSON'"
assert_status 0 "exit 1 follows the banner on failure" \
  python3 -c "
import re, sys
text = open('$HOOK').read()
m = re.search(r'check_standards_gate\(\)\s*\{(.*?)\n\}\n', text, flags=re.S)
body = m.group(1) if m else ''
i_banner = body.find('STANDARDS_BLOCK')
i_exit   = body.find('exit 1', i_banner) if i_banner >= 0 else -1
sys.exit(0 if i_banner >= 0 and i_exit > i_banner else 1)
"

# ── Behavioural tests: drive the hook in a sandbox git repo ─────────────────
SBOX="$(mktemp -d -t e82-XXXXXX)"
on_exit 'rm -rf "$SBOX"'
PROJ="${SBOX}/proj"
mkdir -p "${PROJ}/.ai" "${PROJ}/src/mcp/foo" "${PROJ}/scripts"
git -C "$PROJ" init -q
git -C "$PROJ" config user.email "t@t"
git -C "$PROJ" config user.name "tester"
# Pre-seed .ai/TASKS.md with the generated header so check_markdown_sync
# passes through and lets the test reach check_standards_gate. The sandbox
# is deliberately stamp-free — the final Gate 2 stamp check (stamp-gate.mjs, E-329) will
# still block, but only AFTER check_standards_gate runs.
cat > "${PROJ}/.ai/TASKS.md" <<'TASKS'
# TASKS (Generated from state.json)

## Engineer (Claude)
TASKS

# Copy the standards machinery + a CRITIC_STAMP into the sandbox so the
# downstream check_critic_stamp gate isn't the one tripping the test.
cp "${REPO_ROOT}/src/shared/standards.json" "${PROJ}/src/shared/standards.json" 2>/dev/null || mkdir -p "${PROJ}/src/shared" && cp "${REPO_ROOT}/src/shared/standards.json" "${PROJ}/src/shared/standards.json"
cp "${REPO_ROOT}/src/shared/standards-checker.mjs" "${PROJ}/src/shared/standards-checker.mjs"
# E-225: the checker imports the E-224 markdown classifier (one definition of "executable
# markdown", shared with run_review). It is a real runtime dependency — without it the CLI
# throws, the hook prints its banner with no report, and a CLEAN diff trips the gate. Both
# of those showed up as test failures rather than as an import error, which is why the
# fixture has to mirror the deployed file set rather than a subset of it.
cp "${REPO_ROOT}/src/shared/markdown-exec.mjs" "${PROJ}/src/shared/markdown-exec.mjs"
cp "${REPO_ROOT}/src/shared/standards-test-rules.mjs" "${PROJ}/src/shared/standards-test-rules.mjs"   # E-299 sibling
cp "${REPO_ROOT}/scripts/standards.mjs" "${PROJ}/scripts/standards.mjs"

# Hook helper: source the file with a controlled environment.
_run_gate() {
  # $1 = extra env (KEY=VAL pairs, space-separated)
  (
    cd "$PROJ"
    eval "$1" bash -c "
      AI_DIR='${PROJ}/.ai'
      source '$HOOK' 2>/dev/null || true
      # The 'source' executes the whole hook; if the gate didn't already
      # exit, capture its exit by re-invoking. We bypass that risk by
      # running the hook as a subprocess directly.
    " >/dev/null 2>&1
  )
}

# Cleaner approach: invoke the hook as a subprocess. Stage a file that
# trips the gate (an .orig file) and confirm exit 1.
echo "junk" > "${PROJ}/leftover.orig"
git -C "$PROJ" add leftover.orig

# ── T-PCS-S06: Hook blocks commit when standards-checker fails ──────────────
echo ""
echo "  [T-PCS-S06] Hook exits 1 with banner when CLI returns error"

OUT_FILE="${SBOX}/hook.out"
(cd "$PROJ" && bash "$HOOK") > "$OUT_FILE" 2>&1
rc=$?
assert_status 0 "hook exits non-zero on standards failure" bash -c "[[ $rc -ne 0 ]]"
assert_status 0 "banner surfaced on stderr" \
  grep -q "ENGINEERING-STANDARDS — COMMIT BLOCKED" "$OUT_FILE"
assert_status 0 "CLI report appended after the banner" \
  grep -q "no_committed_tmp_files" "$OUT_FILE"

# ── T-PCS-S07: AI_OS_SKIP_STANDARDS=1 bypasses the gate ─────────────────────
echo ""
echo "  [T-PCS-S07] AI_OS_SKIP_STANDARDS=1 silences the gate"

(cd "$PROJ" && AI_OS_SKIP_STANDARDS=1 bash "$HOOK") > "$OUT_FILE" 2>&1 || true
assert_status 1 "standards banner NOT printed when skip flag set" \
  grep -q "ENGINEERING-STANDARDS — COMMIT BLOCKED" "$OUT_FILE"

# ── T-PCS-S08: Clean staged set → standards gate passes ─────────────────────
echo ""
echo "  [T-PCS-S08] Clean staged file does NOT trip the gate"

# Remove the offending .orig file from staging, stage a clean source file.
git -C "$PROJ" rm --cached leftover.orig >/dev/null 2>&1
rm "${PROJ}/leftover.orig"
echo "export const x = 1;" > "${PROJ}/src/clean.mjs"
git -C "$PROJ" add src/clean.mjs

(cd "$PROJ" && bash "$HOOK") > "$OUT_FILE" 2>&1 || true
assert_status 1 "standards banner NOT printed on clean diff" \
  grep -q "ENGINEERING-STANDARDS — COMMIT BLOCKED" "$OUT_FILE"

# ── T-PCS-S09: Node-absent path returns 0 silently (degradation) ────────────
echo ""
echo "  [T-PCS-S09] Hook degrades gracefully when node is unavailable"

# Simulate by stripping node from PATH for the hook invocation.
(cd "$PROJ" && env -i HOME="$HOME" PATH=/usr/bin:/bin AI_TELEMETRY_DB_PATH="${AI_TELEMETRY_DB_PATH:-}" bash "$HOOK") > "$OUT_FILE" 2>&1 || true
assert_status 1 "no STANDARDS banner when node absent" \
  grep -q "ENGINEERING-STANDARDS — COMMIT BLOCKED" "$OUT_FILE"

# ── T-PCS-S10: ~/.ai-os mirror byte-identical ──────────────────────────────
echo ""
echo "  [T-PCS-S10] ~/.ai-os/hooks/pre-commit.sh mirror matches src/"

MIRROR="${HOME}/.ai-os/hooks/pre-commit.sh"
if [[ -f "$MIRROR" ]]; then
  assert_status 0 "mirror is byte-identical to src/" diff -q "$HOOK" "$MIRROR"
else
  echo "    ⚠  mirror absent — skipping"
fi

echo ""

# ── E-80 (from standards_checker — E-301): the standards checker where a process is under test ──
# validateStaged over a real git index, the CLI's 0/1/2 contract and --json envelope,
# AI_OS_SKIP_STANDARDS=1, the install layout and the E-250 suppression report. The rules
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
  bash -c "echo '$staged_out' | grep -q '\"files_checked\":2'"
assert_status 0 "validateStaged surfaces the .tmp error" \
  bash -c "echo '$staged_out' | grep -q 'no_committed_tmp_files'"
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

# ── T-STD-S12: AI_OS_SKIP_STANDARDS=1 rollback path ─────────────────────────
echo ""
echo "  [T-STD-S12] AI_OS_SKIP_STANDARDS=1 short-circuits the gate"

stderr_out="$( ( cd "$SPROJ" && AI_OS_SKIP_STANDARDS=1 node "$CLI" check --file src/staged.tmp ) 2>&1 >/dev/null )"
rc=$?
assert_status 0 "skip flag → exit 0 (even on would-be error)" bash -c "[[ $rc -eq 0 ]]"
assert_status 0 "stderr carries STANDARDS_SKIPPED marker" \
  bash -c "echo '$stderr_out' | grep -q 'STANDARDS_SKIPPED'"

# ── T-STD-S14: ~/.ai-os mirrors byte-identical ──────────────────────────────
echo ""
echo "  [T-STD-S14] ~/.ai-os mirrors byte-identical"

assert_status 0 "standards.json mirror"        diff -q "$STANDARDS_JSON" "${HOME}/.ai-os/shared/standards.json"
assert_status 0 "standards-checker mirror"     diff -q "$STD_CHECKER" "${HOME}/.ai-os/shared/standards-checker.mjs"
assert_status 0 "scripts/standards.mjs mirror" diff -q "$CLI"      "${HOME}/.ai-os/scripts/standards.mjs"

# ── T-STD-S15: scripts/standards.mjs locator chain (E-83) ───────────────────
echo ""
echo "  [T-STD-S15] CLI resolves standards-checker.mjs via dynamic locator chain"

# Synthetic install layout: <root>/scripts/standards.mjs + <root>/shared/standards-checker.mjs
# (matches ~/.ai-os/ tree). Asserts Candidate 2 of the locator chain.
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
  bash -c "echo '$stderr_out' | grep -q '\[standards\] ERROR: standards-checker.mjs not found'"

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
  bash -c "printf '%s' \"\$_sup\" | grep -q 'error'"
assert_contains "E-250.02b: and the suppression is COUNTED, not silently swallowed" \
  "no_raw_exit_trap_in_tests: 1" "$_sup"
assert_contains "E-250.02c: with the file:line that carries it" "tests/suppressed_test.sh:1" "$_sup"

_above="$(_e250_check tests/above_test.sh)"
assert_status 1 "E-250.03a: a marker on the line ABOVE also suppresses" \
  bash -c "printf '%s' \"\$_above\" | grep -q 'error'"
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

# ── E-302: the registry-drift gate runs a checker that exists, and its exit status blocks ──
# check_registry_sync ran tests/suites/registry_sync_test.sh, which exited 0 on a failed check
# (assert_summary prints counts, it sets no status), so the gate could not block; when E-302 moved
# the checks, the old path vanished and `[[ -f ]] || return 0` would have passed silently.
_RD="${REPO_ROOT}/tests/tools/registry-drift.sh"
assert_status 0 "E-302.RD1: the hook names the registry checker that exists" \
  bash -c 'f="$(grep -o "tests/tools/registry-drift\.sh" "$1" | head -1)"; [[ -n "$f" && -f "$2/$f" ]]' _ "$HOOK" "$REPO_ROOT"
_RD_HOME="$(test_tmpdir rdhome)"; mkdir -p "${_RD_HOME}/.ai-os/config"
printf '{"mcp_servers":{}}\n' > "${_RD_HOME}/.ai-os/config/registry.json"
assert_status 1 "E-302.RD2: a global registry missing the local servers fails the checker (the gate blocks)" \
  env HOME="$_RD_HOME" bash "$_RD"
cp "${REPO_ROOT}/src/config/registry.json" "${_RD_HOME}/.ai-os/config/registry.json"
assert_status 0 "E-302.RD3: …and a matching one passes" env HOME="$_RD_HOME" bash "$_RD"

assert_summary
if [[ "${FAIL_COUNT:-0}" -eq 0 ]]; then
  echo "===== conflict_gate_test.sh PASS ====="
else
  echo "===== conflict_gate_test.sh FAIL (${FAIL_COUNT}) ====="
fi
