#!/usr/bin/env bash
# skill_lines_test.sh — what a skill's `!`-line may do (was skill_locator_test, renamed for the
# behaviour by E-301; absorbs skill_consent_test).
#
# E-225 (D-058 §2): the skills half of T-LOCATOR-001.
#
# `!`-prefixed lines in skill files are AUTO-EXECUTED by the harness at session start.
# Four of them resolved framework helpers cwd-relative — `for c in
# src/shared/incident-aggregate.mjs ...` — so running a session inside ANY project that
# planted that file executed THAT file. Worse than the hook form E-223 fixed: no git repo
# is needed, and `ai-preflight` runs at the start of every single session.
#
# The assertions are on EXECUTION, not on the text of the SKILL.md. A grep would pass
# against any rewrite that still resolved cwd-relative by another route.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DRIVER="${REPO_ROOT}/tests/lib/skill-exec-driver.sh"
RULECHK="${REPO_ROOT}/tests/lib/standards-rule-check.mjs"
STD_JSON="${REPO_ROOT}/src/shared/standards.json"
STD_MJS="${REPO_ROOT}/src/shared/standards-checker.mjs"

echo "── Suite: skill_lines_test (E-225, E-232) ───────────────────────────"

SKILLS=(
  "${REPO_ROOT}/src/shared/skills/ai-preflight/SKILL.md"
  "${REPO_ROOT}/src/shared/skills/ai-insights/SKILL.md"
  "${REPO_ROOT}/src/shared/skills/ai-review-proposed-skills/SKILL.md"
)

# ── E-225.1: THE CANARY — no skill executes a decoy project's helper ────────
_out="$(bash "$DRIVER" "${SKILLS[@]}" 2>/dev/null)"
assert_status 1 "E-225.01a: no skill executed the decoy's helpers" \
  bash -c "[[ -n '$_out' ]]"
if [[ -n "$_out" ]]; then echo "    executed: $(printf '%s' "$_out" | tr '\n' ' ')" >&2; fi

# Non-vacuity: the SAME driver against a PRE-FIX skill must fire. A canary that never
# fires proves the harness is broken, not that the code is safe.
#
# The fixture is written inline, NOT fetched with `git show HEAD:`. The first version did
# that, which quietly made the control depend on version-control state: it passed only
# while the fix was uncommitted, and the moment the branch merged, `HEAD` became the FIXED
# file, the control found nothing executing, and it failed — on correct code, forever.
# A test that asserts "the old code was broken" has to carry the old code.
_old="$(mktemp -d)"; mkdir -p "$_old/prefix"
cat > "$_old/prefix/SKILL.md" <<'PREFIX'
# Pre-fix ai-preflight (verbatim shape of the E-225 defect)

Incident status: !for c in src/shared/incident-aggregate.mjs "${HOME}/.rein/shared/incident-aggregate.mjs"; do [ -f "$c" ] && node "$c" 2>/dev/null && break; done 2>/dev/null || echo "(aggregator unavailable)"

```bash
for c in src/shared/insights-staleness.mjs "${HOME}/.rein/shared/insights-staleness.mjs"; do
  if [ -f "$c" ]; then PROBE="$c"; break; fi
done
node "${PROBE}" 2>/dev/null || echo '{"status":"UNAVAILABLE"}'
```
PREFIX
_pre="$(bash "$DRIVER" "$_old/prefix/SKILL.md" 2>/dev/null)"
assert_contains "E-225.01b: the pre-fix shape DOES execute the decoy (non-vacuity)" \
  "EXECUTED" "$_pre"
assert_contains "E-225.01c: including the session-start !-line's helper" \
  "incident-aggregate" "$_pre"
assert_contains "E-225.01d: and the fenced locator chain's helper" \
  "insights-staleness" "$_pre"
rm -rf "$_old"

# ── E-225.1b: the DEGRADED-INSTALL branch (audit F1) ───────────────────────
# The canary above runs with a healthy HOME, so it only ever exercised the branch where
# the fix works. With locate.sh unreachable AND an inherited exported `ai_os_locate`, the
# first cut executed the decoy — `declare -f` is satisfied by an environment-supplied
# function, which is exactly what E-223 F13 fixed for the hooks and E-225 did not port.
_line="$(grep -m1 '^Incident status:' "${REPO_ROOT}/src/shared/skills/ai-preflight/SKILL.md" | sed 's/^[^!]*!//')"
_d="$(mktemp -d)"; mkdir -p "$_d/src/shared"
printf 'console.log(%s);\n' "'{\"status\":\"PWNED\"}'" > "$_d/src/shared/incident-aggregate.mjs"
_got="$( cd "$_d" && env "BASH_FUNC_ai_os_locate%%=() { printf '%s' \"\$PWD/src/shared/incident-aggregate.mjs\"; }" \
          HOME=/nonexistent bash -c "$_line" 2>/dev/null )"
assert_not_contains "E-225.01f: a forged resolver cannot run the decoy (degraded install)" \
  "PWNED" "$_got"
assert_contains "E-225.01g: it fails CLOSED with the unavailable message" \
  "unavailable" "$_got"
rm -rf "$_d"

# ── E-225.2: the rewritten lines go through the shared resolver ────────────
for s in "${SKILLS[@]}"; do
  _n="$(basename "$(dirname "$s")")"
  assert_status 0 "E-225.02 $_n sources the install-rooted locator" \
    grep -q 'HOME}/.rein/shared/locate.sh' "$s"
  assert_status 0 "E-225.02 $_n resolves via ai_os_locate" \
    grep -q 'ai_os_locate shared/' "$s"
  assert_status 0 "E-225.02 $_n declares its environment untrusted" \
    grep -q 'REIN_LOCATE_UNTRUSTED_ENV=1' "$s"
  # F1: the hooks' guard, which the first cut of E-225 omitted. `declare -f` is satisfied
  # by an inherited EXPORTED bash function, so without this an attacker-supplied
  # ai_os_locate IS the resolver whenever locate.sh is unreachable.
  assert_status 0 "E-225.02 $_n unsets inherited resolver functions" \
    grep -q 'unset -f ai_os_locate' "$s"
  assert_status 0 "E-225.02 $_n gates the source on the file existing" \
    grep -q '\[ -f "\${HOME}/.rein/shared/locate.sh" \]' "$s"
  # F5: ORDER is load-bearing — locate.sh fixes its install root at source time, so the
  # untrusted flag set afterwards is too late. Three independent greps would pass on a
  # reordered file, so this is one regex across the sequence.
  assert_status 0 "E-225.02 $_n sets the flag BEFORE sourcing" \
    bash -c "python3 - '$s' <<'PYX'
import sys
# EVERY source site must be preceded by the flag and the unset. Checking only the first
# occurrence, or matching within one line, would pass a file whose block form is ordered
# wrongly — the one-line sites and the fenced block are written differently, and an
# earlier version of this assertion only handled the one-liners.
t = open(sys.argv[1]).read()
i, ok = 0, True
while True:
    i = t.find('. \"${HOME}/.rein/shared/locate.sh\"', i)
    if i == -1:
        break
    window = t[max(0, i - 500):i]
    if 'REIN_LOCATE_UNTRUSTED_ENV=1' not in window or 'unset -f ai_os_locate' not in window:
        ok = False
        break
    i += 1
sys.exit(0 if ok else 1)
PYX"
done

# ── E-225.3: the standards rule catches the shape, in both directions ──────
# It must FAIL the old chain and PASS both the new one and the many legitimate skill
# lines that merely READ project files. A scan found 23 executable lines mentioning
# `src/` and only 5 that executed a framework helper; a rule that flagged all 23 would
# be the same over-block this sprint keeps removing.
_t="$(mktemp -d)"; mkdir -p "$_t/src/shared/skills/bad" "$_t/src/shared/skills/good"
printf 'S: !for c in src/shared/x.mjs "${HOME}/.rein/shared/x.mjs"; do [ -f "$c" ] && node "$c"; done\n' \
  > "$_t/src/shared/skills/bad/SKILL.md"
printf 'S: !. "${HOME}/.rein/shared/locate.sh"; c="$(ai_os_locate shared/x.mjs)"; node "$c"\n' \
  > "$_t/src/shared/skills/good/SKILL.md"
printf 'A: !cat src/db/schema.sql\nB: !grep -r foo src/\nC: !test -f src/claude/agents/x.md\nD: !node -p "require(%s./package.json%s).version"\n' "'" "'" \
  > "$_t/src/shared/skills/good/DATA.md"
printf '# a comment mentioning src/shared/x.mjs\nS: !echo ok\n' \
  > "$_t/src/shared/skills/good/COMMENT.md"

_rule() { node --no-warnings "$RULECHK" "$1" "$2" 2>/dev/null; }
assert_contains "E-225.03a: the old cwd-relative chain FAILS" "FLAGGED" \
  "$(_rule "$_t" src/shared/skills/bad/SKILL.md)"
assert_not_contains "E-225.03b: the rewritten shape passes" "FLAGGED" \
  "$(_rule "$_t" src/shared/skills/good/SKILL.md)"
assert_not_contains "E-225.03c: reading the project's own files is not flagged" "FLAGGED" \
  "$(_rule "$_t" src/shared/skills/good/DATA.md)"
assert_not_contains "E-225.03d: a comment mentioning a helper is not flagged" "FLAGGED" \
  "$(_rule "$_t" src/shared/skills/good/COMMENT.md)"
rm -rf "$_t"

# The real skills must pass their own rule.
for s in "${SKILLS[@]}"; do
  _rel="${s#$REPO_ROOT/}"
  assert_not_contains "E-225.03 $(basename "$(dirname "$s")") passes the standards rule" "FLAGGED" \
    "$(_rule "$REPO_ROOT" "$_rel")"
done

# ── E-225.4: the rule is registered and reuses the E-224 classifier ────────
assert_status 0 "E-225.04a: the rule is in standards.json" \
  grep -q 'skill_locator_install_first' "$STD_JSON"
assert_status 0 "E-225.04b: the handler reuses the E-224 classifier" \
  bash -c "grep -q 'classifyMarkdown' '$STD_MJS'"
assert_status 0 "E-225.04c: the documented bypass exists" \
  bash -c "grep -q 'REIN_STANDARDS_SKIP === \"skill-locator\"' '$STD_MJS'"
# The bypass must actually bypass.
_t2="$(mktemp -d)"; mkdir -p "$_t2/src/shared/skills/bad"
printf 'S: !for c in src/shared/x.mjs; do node "$c"; done\n' > "$_t2/src/shared/skills/bad/SKILL.md"
assert_not_contains "E-225.04d: REIN_STANDARDS_SKIP=skill-locator bypasses it" "FLAGGED" \
  "$(REIN_STANDARDS_SKIP=skill-locator node --no-warnings "$RULECHK" "$_t2" src/shared/skills/bad/SKILL.md 2>/dev/null)"
rm -rf "$_t2"

# ── E-225.6: the rule's detection, both directions (audit F2) ──────────────
# The first cut allowlisted two prefixes (`./`, `src/`) and required a known extension,
# so it missed `node ../shared/x.mjs`, `bash scripts/helper.sh`, `node lib/x.mjs` and —
# worst — `bash src/bin/ai`, the framework's own EXTENSION-LESS entrypoint. The test is
# inverted now: does this line hand an interpreter a path the visited project controls?
_m="$(mktemp -d)"; mkdir -p "$_m/src/shared/skills/x"
# A CRASH must never read as a CATCH. The round-2 rewrite threw on an undefined constant,
# and because "not clean" was treated as "flagged" an entire matrix reported green while
# the rule was dead. The checker now prints ERROR distinctly and this asserts on it.
_probe() {  # <want:FLAGGED|clean> <line>
  printf '%s\n' "$2" > "$_m/src/shared/skills/x/SKILL.md"
  local got; got="$(node --no-warnings "$RULECHK" "$_m" src/shared/skills/x/SKILL.md 2>/dev/null)"
  assert_not_contains "E-225.06 rule does not crash on: ${2:0:40}" "ERROR" "$got"
  if [[ "$1" == FLAGGED ]]; then
    assert_contains "E-225.06 catches: ${2:0:46}" "FLAGGED" "$got"
  else
    assert_not_contains "E-225.06 passes: ${2:0:46}" "FLAGGED" "$got"
  fi
}
# The original defect shape: the path sits in a LIST and the interpreter gets a variable,
# so an interpreter-argument test alone would miss the very thing E-225 removed.
_probe FLAGGED 'A: !for c in src/shared/x.mjs; do node "$c"; done'
_probe FLAGGED 'A: !PROBE=src/shared/y.mjs; node "$PROBE"'
_probe FLAGGED 'A: !node ../shared/x.mjs'
_probe FLAGGED 'A: !bash src/bin/ai sync'
_probe FLAGGED 'A: !bash scripts/helper.sh'
_probe FLAGGED 'A: !node lib/x.mjs'
_probe FLAGGED 'A: !python3 tools/x.py'
# Legitimate shapes. Over-blocking here would be the same defect this sprint keeps
# removing, one layer up — a gate that fires on correct code gets routed around.
_probe clean 'A: !. "${HOME}/.rein/shared/locate.sh"; c="$(ai_os_locate shared/x.mjs)"; node "$c"'
_probe clean 'A: !node /abs/x.mjs'
_probe clean 'A: !node "${HOME}/.rein/shared/x.mjs"'
_probe clean 'A: !cat src/db/schema.sql'
_probe clean 'A: !grep -r foo src/'
_probe clean 'A: !test -f src/claude/agents/x.md'
_probe clean 'A: !bash tests/run.sh'
_probe clean 'A: !bash tests/suites/x.sh'
_probe clean 'A: !npm run test'
# A path-shaped DATA string is not an execution: ai-incident passes a stack signature to
# jq, and the rule flagged a string being recorded rather than a file being run.
_probe clean '--arg s "task-synchronizer-mcp/index.js:add_task"'

# ── Round-2 audit shapes. Each of these passed the first inverted rule. ─────
# The allowlist was a PREFIX, so anything merely starting `tests/` was waved through —
# including a traversal straight back out of it.
_probe FLAGGED 'A: !bash tests/../src/shared/evil.sh'
_probe FLAGGED 'A: !node tests/shared/incident-aggregate.mjs'
# POSIX `.` executes in the CALLER's shell and is the operator the E-225 fix itself uses;
# the rule policing the fix could not see it.
_probe FLAGGED 'A: !. src/shared/evil.sh'
_probe FLAGGED 'A: !. ./src/shared/evil.sh'
# $PWD/$(pwd) name the visited project's root — an absolute-looking relative path.
_probe FLAGGED 'A: !node "$(pwd)/src/shared/evil.mjs"'
_probe FLAGGED 'A: !node "$PWD/src/shared/evil.mjs"'
# A decoy at the repo ROOT needs no directory component at all.
_probe FLAGGED 'A: !node helper.mjs'
_probe FLAGGED 'A: !bash setup.sh'
_probe FLAGGED 'A: !cd src/shared && node evil.mjs'
_probe FLAGGED 'A: !perl src/shared/evil.pl'
# Laundering a real path through the resolver's exemption. Inert at runtime (ai_os_locate
# joins onto the install root) but the rule should still say so.
_probe FLAGGED 'A: !x=$(ai_os_locate src/shared/evil.mjs); node "$x"'

# Inline CODE is not a path. `-c` / `-e` / `--input-type=module` invocations flagged four
# real skills once the rule was broadened, because an unparsed flag became the "path".
_probe clean 'A: !python3 -c "'
_probe clean 'A: !node --input-type=module -e "'
_probe clean 'A: !node -p "require(x).version"'
# The accepted project entrypoints, by exact shape.
# repro.sh is accepted ONLY in the skill that writes it, and `./repro.sh` is judged the
# same as `repro.sh` — an allowlist that answers differently for two spellings of one file
# is a trap. The scoping is asserted separately below because _probe writes to a generic
# skill path, where it must FLAG.
_probe FLAGGED 'A: !bash repro.sh'

# ── Round-3 audit shapes. Each passed the round-2 rule. ────────────────────
# The inline-code skip abandoned the WHOLE match, so every later token went unexamined
# and only an executable extension could rescue it — leaving `src/bin/ai`, the
# framework's own extension-less entrypoint, invisible in the very idiom E-225 ships.
_probe FLAGGED 'A: !node -e "import(process.argv[1])" src/bin/ai'
_probe FLAGGED 'A: !python3 -c "import sys;exec(open(sys.argv[1]).read())" src/bin/tool'
_probe FLAGGED 'A: !node -e "import(process.argv[1])" src/shared/evil.mjs'
# `${PWD}` is the MORE idiomatic brace form and fell through as "a variable we cannot
# read"; $OLDPWD is the same root under another name.
_probe FLAGGED 'A: !node "${PWD}/src/shared/evil.mjs"'
_probe FLAGGED 'A: !bash "${PWD}/src/bin/ai"'
_probe FLAGGED 'A: !node "$OLDPWD/src/shared/evil.mjs"'
# A `.` after a shell keyword is still command position — and because `invokes` derives
# from the same matchers, missing it disabled the SECOND signal too.
_probe FLAGGED 'A: !if true; then . src/bin/ai; fi'
_probe FLAGGED 'A: !if true; then . src/shared/evil.sh; fi'
# Regression guards for the two over-blocks the round-3 fixes introduced and removed:
# a stripped inline-code line leaves `2>/dev/null` (a redirect, not a path), and
# `tests/suites/<placeholder>.sh` must survive the redirect handling.
_probe clean 'Unread deltas: !python3 -c "import json" 2>/dev/null || echo "(none)"'
_probe clean 'A: !node -p "require(x).version" 2>/dev/null || echo "(none)"'
_probe clean 'A: !bash tests/suites/<failing_suite>.sh 2>&1'

# ── Round-4 audit shapes. Each passed the round-3 rule. ────────────────────
# A `--flag=value` the flags group could not consume ENDED the scan for the whole line,
# and the pattern is live at ai-review-proposed-skills:40,69 — the rule was blind on a
# line of a skill E-225 itself rewrote.
_probe FLAGGED 'A: !node --input-type=module src/bin/ai'
_probe FLAGGED 'A: !node --input-type=module -e "0" src/bin/ai'
_probe FLAGGED 'A: !python3 -X opt=1 src/bin/tool'
# The inline-code strip required a plain quote, so unquoted code and ANSI-C `$'…'` both
# re-entered the gap it was written to close.
_probe FLAGGED 'A: !python3 -c print(1) src/bin/tool'
_probe FLAGGED "A: !node -e \$'import(\"x\")' src/bin/ai"
# Backticks are the third spelling of the project root, after $(pwd) and ${PWD}.
_probe FLAGGED 'A: !node `pwd`/src/shared/evil.mjs'

# The invocation is TOKENISED rather than regex-matched — four rounds each found a new
# hole in a single-pattern parser. These pin the tokeniser's own edges.
_probe FLAGGED 'A: !node   src/bin/ai'
_probe FLAGGED 'A: !bash "src/bin/ai"'
_probe clean   'A: !node "$h"'
_probe clean   'A: !echo "run node src/x.mjs to start"'

# ── Round-5 audit shapes. ──────────────────────────────────────────────────
# P1 — an OVER-BLOCK on a shape the allowlist explicitly permits. The tokeniser splits on
# whitespace only, so `bash tests/run.sh; echo done` left the `;` glued to the operand and
# the entrypoint failed the allowlist. A commit gate that blocks a permitted line is how
# people learn to bypass it.
_probe clean 'A: !bash tests/run.sh; echo done'
_probe clean 'A: !bash tests/run.sh | tail -5'
_probe clean 'A: !bash tests/run.sh && echo ok'
# P3 — an interpreter named by path is the same invocation.
_probe FLAGGED 'A: !/usr/local/bin/node src/bin/ai'
_probe FLAGGED 'A: !./node_modules/.bin/tsx src/bin/ai'
_probe FLAGGED 'A: !/usr/bin/env node src/bin/ai'
# Q2 — the walk must continue past an operand that was merely REJECTED or ACCEPTED…
_probe FLAGGED 'A: !bash tests/run.sh src/bin/ai'
_probe FLAGGED 'A: !node "$HELPER" src/bin/ai'
# …but STOP at a command terminator. Without that the walk ran past
# `. "${HOME}/…/locate.sh";` into the next command and read the resolver's own logical
# argument as a path — an over-block on the exact line this task ships.
_probe clean 'A: !. "${HOME}/.rein/shared/locate.sh"; c="$(ai_os_locate shared/x.mjs)"; node "$c"'
_probe clean 'A: !bash tests/run.sh; node "$c"'



rm -rf "$_m"

# ── E-225.08: self-authored scripts are accepted only in their own skill ───
_rs="$(mktemp -d)"
mkdir -p "$_rs/src/claude/skills/bug-reproducer" "$_rs/src/shared/skills/other"
printf 'A: !bash repro.sh\nB: !bash ./repro.sh\n' > "$_rs/src/claude/skills/bug-reproducer/SKILL.md"
printf 'A: !bash repro.sh\n' > "$_rs/src/shared/skills/other/SKILL.md"
assert_not_contains "E-225.08a: bug-reproducer may run the script it writes" "FLAGGED" \
  "$(node --no-warnings "$RULECHK" "$_rs" src/claude/skills/bug-reproducer/SKILL.md 2>/dev/null)"
assert_contains "E-225.08b: any other skill running repro.sh is flagged" "FLAGGED" \
  "$(node --no-warnings "$RULECHK" "$_rs" src/shared/skills/other/SKILL.md 2>/dev/null)"
rm -rf "$_rs"

# ── E-225.7: the rule covers the MIRRORS too (audit F3) ────────────────────
# E-201 is a recorded incident of an edit landing in the mirror instead of canonical
# src/. A reintroduced chain there would otherwise commit clean.
assert_status 0 "E-225.07a: applies_to covers the .claude/ mirror" \
  bash -c "python3 - <<'PYX'
import json, sys
d = json.load(open('$STD_JSON'))
r = next(x for x in d['rules'] if x['rule_id'] == 'skill_locator_install_first')
need = {'.claude/skills/**/SKILL.md'}
sys.exit(0 if need <= set(r['applies_to']) else 1)
PYX"
_mm="$(mktemp -d)"; mkdir -p "$_mm/.claude/skills/x"
printf 'S: !for c in src/shared/x.mjs; do node "$c"; done\n' > "$_mm/.claude/skills/x/SKILL.md"
assert_contains "E-225.07b: a bad chain in a MIRROR is flagged" "FLAGGED" \
  "$(node --no-warnings "$RULECHK" "$_mm" .claude/skills/x/SKILL.md 2>/dev/null)"
rm -rf "$_mm"

# ── E-225.5: mirrors carry the fix ─────────────────────────────────────────
# A fix that lives only in src/ is not deployed: the harness loads .claude/skills.
for m in ".claude/skills/ai-preflight/SKILL.md" ".agents/skills/ai-preflight/SKILL.md"; do
  if [[ -f "${REPO_ROOT}/$m" ]]; then
    assert_status 0 "E-225.05 $m carries the resolver" \
      grep -q 'ai_os_locate shared/incident-aggregate.mjs' "${REPO_ROOT}/$m"
    assert_status 1 "E-225.05 $m has no cwd-relative chain left" \
      grep -q 'for c in src/shared/incident-aggregate.mjs' "${REPO_ROOT}/$m"
  fi
done

# ── E-232 (from skill_consent — E-301; D-060 §3): a `!`-line may inspect, never execute ──
# A `!`-line runs the moment the file LOADS — before the agent has decided anything and before
# the operator has been asked. `ai-debug` opened with `!bash tests/run.sh`, so loading the
# debugging skill executed the VISITED project's test script. The rule is a DENYLIST of
# execution shapes; each catch case is paired with cases that must NOT fire (over-blocking
# would reject every ordinary git/grep inspection line). `npm outdated` / `npm audit` run none
# of the project's own code, so they stay allowed.
CHECKER="${REPO_ROOT}/src/shared/standards-checker.mjs"

# <line> → "HIT" | "MISS"
_verdict() {
  # DYNAMIC import: a static `import ... from process.env.X` is a syntax error — the
  # specifier must be a literal — and node then printed nothing, so every case using this
  # helper failed identically and said only "expected to contain: MISS".
  MDLINE="$1" node --input-type=module -e '
    const { RULE_REGISTRY } = await import(process.env.CHECKER_URL);
    const rule = RULE_REGISTRY.skill_consent_no_project_exec;
    const content = "---\nname: x\n---\n\n## Dynamic Context Injection\n" + process.env.MDLINE + "\n";
    const r = rule({ relPath: "src/shared/skills/x/SKILL.md", content });
    console.log(r ? "HIT" : "MISS");
  ' 2>/dev/null
}
export CHECKER_URL="file://${CHECKER}"

# ── E-232.1: executions that MUST be caught ─────────────────────────────────
while IFS='|' read -r label line; do
  [[ -z "$label" ]] && continue
  assert_contains "E-232.01 catches: ${label}" "HIT" "$(_verdict "$line")"
done <<'CASES'
bash tests/run.sh|Failing tests: !bash tests/run.sh 2>&1 | grep x
npm run test|Status: !npm run test 2>&1 | tail -1
yarn test|Status: !yarn test
pnpm run build|Build: !pnpm run build
make|Build: !make all
npx|Lint: !npx eslint .
./relative script|Run: !./repro.sh
scripts/ path|Setup: !scripts/setup.sh
node on src/|Check: !node src/bin/ai doctor
python3 on scripts/|Gen: !python3 scripts/gen.py
hidden after a pipe|Tests: !git status | bash tests/run.sh
hidden after &&|Tests: !git status && bash tests/run.sh
CASES

# ── E-232.2: OVER-BLOCK GUARD — ordinary inspection must still be allowed ───
# Every one of these appears in the shipped corpus. If the rule fires on any of them it
# has stopped being a consent check and become a ban on dynamic context.
while IFS='|' read -r label line; do
  [[ -z "$label" ]] && continue
  assert_contains "E-232.02 allows: ${label}" "MISS" "$(_verdict "$line")"
done <<'CASES'
git diff|Recent changes: !git diff --name-only | head -10
git log|Recent commits: !git log --oneline -10 || echo none
grep .ai/TASKS.md|Open tasks: !grep "^- \[ \]" .ai/TASKS.md || echo none
cat .ai file|Scope: !cat .ai/CAPABILITIES.md 2>/dev/null || echo none
npm outdated (query only)|Packages: !npm outdated 2>/dev/null || echo none
npm audit (query only)|Vulns: !npm audit --json 2>/dev/null | jq .x || echo 0
date|Today: !date "+%Y-%m-%d"
echo env var|Target: !echo "${TARGET:-(not set)}"
wc on .ai|Lines: !wc -l < .ai/SESSION.md || echo 0
find yml configs|Configs: !find . -name "*.yml" -path "*/deploy/*" | head
command -v probe|Copilot: !command -v gh &>/dev/null && echo yes || echo no
test -d|Archive: !test -d .ai/archive && echo YES || echo NO
ls listing|Structure: !ls -1 . | head -20
python3 inline code|Next: !python3 -c "print(1)"
framework helper via resolver|Agg: !node "${HOME}/.rein/shared/incident-aggregate.mjs" || echo none
CASES

# ── E-232.3: the shipped corpus is clean, and the scan is not vacuous ───────
_CORPUS_FILE="$(test_tmpdir e232-corpus)/corpus.txt"
_corpus_list="$(cd "$REPO_ROOT" && corpus_or_fail 100 src .claude \
                 -- -name "SKILL.md" -o -path "*/agents/*.md")"
_corpus_rc=$?
printf '%s\n' "$_corpus_list" > "$_CORPUS_FILE"

# THE CORPUS STEP IS ITSELF AN ASSERTION (E-251). Everything below reports on this list;
# if it is empty or short, "no violations" is a statement about nothing.
assert_status 0 "E-232.03a: the corpus was BUILT — roots present, count above the floor" \
  bash -c "[[ '${_corpus_rc}' -eq 0 ]]"

_corpus_violations() {
  CORPUS_FILE="$_CORPUS_FILE" node --input-type=module -e '
    const { RULE_REGISTRY } = await import(process.env.CHECKER_URL);
    const { readFileSync } = await import("fs");
    const rule = RULE_REGISTRY.skill_consent_no_project_exec;
    // E-251 (D-067 §5): the corpus arrives as a FILE built by corpus_or_fail in the shell.
    // It used to be built here, by shelling out to `find` over roots that may not exist —
    // and when two of them stopped being provisioned, `find` exited non-zero, execSync
    // threw, and the corpus came back EMPTY. Zero files report zero findings, so this scan
    // would have gone on announcing "clean" forever. The corpus step now fails loudly
    // instead, and this code reads a list it did not have to guess at.
    const files = readFileSync(process.env.CORPUS_FILE, "utf8")
      .split("\n").map(s => s.trim()).filter(Boolean);
    let hits = 0;
    for (const f of files) {
      let c; try { c = readFileSync(process.env.REPO_ROOT + "/" + f, "utf8"); } catch { continue; }
      if (rule({ relPath: f, content: c })) hits++;
    }
    console.log(files.length + " " + hits);
  ' 2>/dev/null
}
export REPO_ROOT
_scan="$(_corpus_violations)"
_files="${_scan%% *}"; _hits="${_scan##* }"
assert_status 0 "E-232.03b: no shipped skill or agent auto-executes a project program (files=${_files})" \
  bash -c "[[ '${_hits:-1}' -eq 0 ]]"
# The corpus gate proves the LIST is long enough; this proves the SCANNER read that same
# list. Without it, a scanner that silently read an empty CORPUS_FILE would still report
# "clean" — the very shape E-251 exists to close, one layer further in.
_corpus_n="$(printf '%s\n' "$_corpus_list" | grep -c . || true)"
assert_contains "E-232.03c: the scanner read the whole corpus (${_corpus_n} files)" \
  "${_corpus_n}" "${_files}"

# ── E-232.4: the three converted skills kept their capability, as STEPS ────
# Removing the `!` line must not remove the ability — otherwise this "fix" is a deletion.
for f in src/shared/skills/ai-debug/SKILL.md \
         src/claude/skills/bug-reproducer/SKILL.md \
         src/shared/skills/ai-upgrade/SKILL.md; do
  assert_status 0 "E-232.04: ${f##*/} ($(dirname "$f" | xargs basename)) still instructs the agent to run the suite" \
    grep -q "Step 0" "${REPO_ROOT}/$f"
done
assert_status 0 "E-232.04b: ai-debug still names the project's test command" \
  grep -q "tests/run.sh" "${REPO_ROOT}/src/shared/skills/ai-debug/SKILL.md"
assert_status 0 "E-232.04c: ai-upgrade still names npm run test" \
  grep -q "npm run test" "${REPO_ROOT}/src/shared/skills/ai-upgrade/SKILL.md"

# ── E-232.5: mirrors are byte-identical ────────────────────────────────────
assert_status 0 "E-232.05a: ai-debug .claude mirror matches src" \
  diff -q "${REPO_ROOT}/src/shared/skills/ai-debug/SKILL.md" "${REPO_ROOT}/.claude/skills/ai-debug/SKILL.md"
assert_mirror_if_present "E-232.05b: ai-debug .agents mirror matches src" "${REPO_ROOT}/src/shared/skills/ai-debug/SKILL.md" "${REPO_ROOT}/.agents/skills/ai-debug/SKILL.md"
assert_status 0 "E-232.05c: ai-upgrade .claude mirror matches src" \
  diff -q "${REPO_ROOT}/src/shared/skills/ai-upgrade/SKILL.md" "${REPO_ROOT}/.claude/skills/ai-upgrade/SKILL.md"
assert_status 0 "E-232.05d: bug-reproducer .claude mirror matches src" \
  diff -q "${REPO_ROOT}/src/claude/skills/bug-reproducer/SKILL.md" "${REPO_ROOT}/.claude/skills/bug-reproducer/SKILL.md"

# ── E-232.6: the rule is registered, and has a rollback ────────────────────
assert_status 0 "E-232.06a: registered in standards.json" \
  grep -q "skill_consent_no_project_exec" "${REPO_ROOT}/src/shared/standards.json"
assert_contains "E-232.06b: REIN_STANDARDS_SKIP=skill-consent disables it" "MISS" \
  "$(REIN_STANDARDS_SKIP=skill-consent _verdict 'Failing tests: !bash tests/run.sh')"

assert_summary
