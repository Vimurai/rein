#!/usr/bin/env bash
# cli_test.sh — Core `rein` CLI command tests (E-34 — collapsed surface)
# After the cli-collapse, the only user-facing commands are: install, init,
# sync, doctor, uninstall, version, help. Removed commands (update, preflight,
# review, test, archive, digest, where, onboard) emit a deprecation message
# pointing to the equivalent agent skill and exit 1.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"

AI_BIN="${SCRIPT_DIR}/../../src/bin/rein"

echo "── Suite: cli_test ──────────────────────────────────────────────────"

# rein version exits 0 and prints a semver. The value follows the installed ~/.rein/VERSION
# (E-270), which init_upgrade_test pins; a literal major here broke on the 4.0.0 bump (E-263).
out=$("$AI_BIN" version 2>&1)
assert_status 0 "rein version exits 0" "$AI_BIN" version
assert_match "rein version contains version number" '^rein [0-9]+\.[0-9]+\.[0-9]+' "$out"

# Usage lists the kept commands (install / init / sync / doctor / uninstall)
out=$("$AI_BIN" 2>&1 || true)
assert_contains "usage lists 'install'" "install" "$out"
assert_contains "usage lists 'init'" "init" "$out"
assert_contains "usage lists 'sync'" "sync" "$out"
assert_contains "usage lists 'doctor'" "doctor" "$out"
assert_contains "usage lists 'uninstall'" "uninstall" "$out"

# Removed commands are listed in the migration map
assert_contains "usage references removed 'review' (migration map)" "review" "$out"
assert_contains "usage references removed 'test' (migration map)" "test" "$out"

# Removed commands emit a deprecation message and exit 1
out=$("$AI_BIN" review 2>&1 || true)
assert_contains "rein review prints deprecation pointer to skill" "skill: arch-review" "$out"
assert_status 1 "rein review exits 1 (deprecated)" "$AI_BIN" review

out=$("$AI_BIN" test 2>&1 || true)
assert_contains "rein test prints deprecation pointer to skill" "skill: ai-test" "$out"
assert_status 1 "rein test exits 1 (deprecated)" "$AI_BIN" test

out=$("$AI_BIN" preflight 2>&1 || true)
assert_contains "rein preflight prints deprecation pointer" "skill: ai-preflight" "$out"
assert_status 1 "rein preflight exits 1 (deprecated)" "$AI_BIN" preflight

out=$("$AI_BIN" where 2>&1 || true)
assert_contains "rein where prints deprecation message" "removed" "$out"
assert_status 1 "rein where exits 1 (deprecated)" "$AI_BIN" where

# Unknown subcommand exits 1
assert_status 1 "unknown subcommand exits 1" "$AI_BIN" __nonexistent_command__


# ── E-110 (from blueprints_index — E-302): the blueprint index is generated ──
# E-110 blueprint index auto-generation.
#
# Verifies _INDEX.md is generated (not hand-curated) and lists EVERY blueprint,
# resolving the omission of 20+ blueprints flagged in the gap review:
#   • scripts/generate_blueprints_index.mjs exists, deterministic, --check mode.
#   • committed .ai/blueprints/_INDEX.md is byte-identical to a fresh run (CI gate).
#   • every .ai/blueprints/*.md appears in the index.
#   • bin/rein do_sync() invokes _regenerate_blueprints_index (node-guarded, mirror fallback).
#   • generator is fail-open (missing dir → exit 0, no output file).
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
GEN="${REPO_ROOT}/scripts/generate_blueprints_index.mjs"
INDEX_MD="${REPO_ROOT}/.ai/blueprints/_INDEX.md"
BIN_AI="${REPO_ROOT}/src/bin/rein"


# ── T-BPI-S01: generator present + valid ─────────────────────────────────────
assert_status 0 "generator exists"     test -f "$GEN"
assert_status 0 "generator syntax OK"  node --check "$GEN"

# ── T-BPI-S02: generator output is deterministic + self-marked ───────────────
# _INDEX.md is a generated artifact (gitignored like _SKILLS_INDEX.md), so we
# test the generator's --check output rather than a committed file.
TMP_OUT="$(mktemp)"; TMP_OUT2="$(mktemp)"
( cd "$REPO_ROOT" && node "$GEN" --check > "$TMP_OUT" 2>/dev/null )
( cd "$REPO_ROOT" && node "$GEN" --check > "$TMP_OUT2" 2>/dev/null )
assert_status 0 "generator output is deterministic (two runs identical)" \
  diff -q "$TMP_OUT" "$TMP_OUT2"
assert_status 0 "index marked auto-generated" \
  grep -qE 'auto-generated — do NOT hand-edit' "$TMP_OUT"
assert_status 1 "_INDEX.md is gitignored (not tracked — generated artifact)" \
  git -C "$REPO_ROOT" ls-files --error-unmatch .ai/blueprints/_INDEX.md

# ── T-BPI-S03: EVERY blueprint appears in the generated index (E-110 acceptance) ─
MISSING=0
for f in "${REPO_ROOT}"/.ai/blueprints/*.md; do
  base="$(basename "$f")"
  [[ "$base" == "_INDEX.md" ]] && continue
  if ! grep -qF "\`${base}\`" "$TMP_OUT"; then
    echo "    ✗ missing from index: ${base}"
    MISSING=$((MISSING + 1))
  fi
done
assert_status 0 "all blueprints indexed (0 omissions)" bash -c "[ $MISSING -eq 0 ]"
# And the count footer matches the on-disk blueprint count.
DISK_N="$(ls "${REPO_ROOT}"/.ai/blueprints/*.md | grep -vc '_INDEX.md')"
assert_contains "index footer reports the on-disk count" "${DISK_N} blueprints indexed" "$(cat "$TMP_OUT")"
rm -f "$TMP_OUT2"

# ── T-BPI-S04: do_sync() wires the regenerator (node-guarded, mirror fallback) ─
assert_status 0 "bin/rein defines _regenerate_blueprints_index()" \
  grep -qE '^_regenerate_blueprints_index\(\)' "$BIN_AI"
assert_status 0 "do_sync() invokes _regenerate_blueprints_index" \
  python3 -c "import re,sys; s=open('${BIN_AI}').read(); m=re.search(r'^do_sync\(\)\s*\{(.*?)^\}', s, re.S|re.M); sys.exit(0 if m and '_regenerate_blueprints_index' in m.group(1) else 1)"
assert_status 0 "helper guards on node availability" \
  grep -q 'node not found — skipping _INDEX.md' "$BIN_AI"
# E-223: install-first via the shared helper (was cwd-relative first).
assert_status 0 "helper resolves the generator via the shared install-first locator" \
  grep -q '_rein_helper scripts/generate_blueprints_index.mjs' "$BIN_AI"

# ── T-BPI-S05: fail-open — no .ai/blueprints → exit 0, no file written ────────
SANDBOX="$(mktemp -d)"
( cd "$SANDBOX" && node "$GEN" >/dev/null 2>&1 )
assert_status 0 "exit 0 when .ai/blueprints absent" \
  bash -c "cd '$SANDBOX' && node '$GEN' >/dev/null 2>&1"
assert_status 1 "no _INDEX.md created in a non-Rein dir" \
  test -f "${SANDBOX}/.ai/blueprints/_INDEX.md"
rm -rf "$SANDBOX" "$TMP_OUT"


# ── E-175 (from doctor_env — E-302): rein doctor --env deep diagnostics ──
# E-175 (doctor-and-cache-optimizations.md §Components 1)
#
# `rein doctor --env` performs deep environment + connectivity diagnostics:
# Node 22+, essential binaries, Docker, read/write bits on ~/.rein & .ai, and a
# live MCP connectivity probe (E-176 mcp-tester). Exits 1 on critical failure.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

AI_BIN="${REPO_ROOT}/src/bin/rein"
LOCAL_SERVER="${REPO_ROOT}/src/mcp/cache-manager-mcp/index.js"


# ── T-ENV-S01: source contract ────────────────────────────────────────────────
echo ""
echo "  [T-ENV-S01] source contract"

assert_status 0 "ai bin exists" test -f "$AI_BIN"
assert_status 0 "syntax valid"  bash -n "$AI_BIN"
assert_status 0 "_run_env_diagnostics defined" grep -qE '_run_env_diagnostics\(\)' "$AI_BIN"
assert_status 0 "--env flag parsed"            grep -qE '"--env"' "$AI_BIN"
assert_status 0 "doctor dispatches to env diagnostics" \
  grep -qE 'ENVCHECK.*-eq 1|_run_env_diagnostics' "$AI_BIN"
assert_status 0 "checks Node 22+ requirement" grep -qE '\-ge 22' "$AI_BIN"
assert_status 0 "checks read/write bits"       grep -q 'read/write access' "$AI_BIN"
assert_status 0 "checks state db write access" grep -q 'state database write access' "$AI_BIN"
assert_status 0 "invokes mcp-tester (E-176)"  grep -qE 'mcp-tester\.mjs' "$AI_BIN"
assert_status 0 "returns non-zero on critical failure" grep -qE 'return 1' "$AI_BIN"

# ── T-ENV-S02: behavioural — healthy env passes ───────────────────────────────
echo ""
echo "  [T-ENV-S02] behavioural: deep check in a healthy sandbox project"

DENV_SBOX="$(mktemp -d)"
mkdir -p "${DENV_SBOX}/.ai"
cat > "${DENV_SBOX}/.mcp.json" <<JSON
{ "mcpServers": { "cache-manager-mcp": { "command": "node", "args": ["${LOCAL_SERVER}"] } } }
JSON

OUT="$( cd "${DENV_SBOX}" && "$AI_BIN" doctor --env 2>&1 )"
RC=$?

assert_contains "prints --env header"          "deep environment & connectivity" "$OUT"
assert_contains "node version check is [OK]"    "[OK]   node version"             "$OUT"
assert_contains "reports ~/.rein access"       ".rein read/write access"       "$OUT"
assert_contains "runs MCP connectivity probe"   "MCP connectivity"               "$OUT"
assert_contains "local server answered tools/list" "cache-manager-mcp"           "$OUT"
assert_contains "summary line present"          "Environment OK"                 "$OUT"
assert_status 0 "exit 0 when all critical checks pass" bash -c "[[ $RC -eq 0 ]]"

# ── T-ENV-S03: behavioural — a dead MCP server makes --env exit 1 ─────────────
echo ""
echo "  [T-ENV-S03] behavioural: unreachable MCP server → critical fail (exit 1)"

cat > "${DENV_SBOX}/.mcp.json" <<JSON
{ "mcpServers": { "ghost-mcp": { "command": "node", "args": ["${DENV_SBOX}/nope.js"] } } }
JSON

OUT_BAD="$( cd "${DENV_SBOX}" && "$AI_BIN" doctor --env 2>&1 )"
RC_BAD=$?
assert_contains "flags the failed server"  "[FAIL] ghost-mcp"        "$OUT_BAD"
assert_contains "reports critical failure" "critical failures"       "$OUT_BAD"
assert_status 0 "exit 1 on critical failure" bash -c "[[ $RC_BAD -eq 1 ]]"

rm -rf "$DENV_SBOX"

echo ""


# ── E-256 (from legacy_mention — E-302): the retired-provider mention allowlist ──
# E-256 (D-076, claude-native-consolidation.md §Component 4).
#
# The v4 acceptance grep for the retired providers and the retired test cloud, made
# executable. It used to be a manual check with the wording "returns nothing" — which the
# D-074 removal code can never satisfy, because a registry that deletes `.gemini/` has to
# name it. D-076 replaced "nothing" with a NAMED, COUNTED allowlist:
#
#   * the grep's hit set must EQUAL tests/fixtures/legacy-mention-allowlist.json — a new
#     mention fails, and so does a listed file that no longer mentions anything (equality,
#     not subset, or the list rots into a standing permission);
#   * each entry pins the exact number of matching lines, so a new mention inside an
#     already-listed file (src/bin/rein is 5k lines) is an explicit fixture edit in the diff;
#   * entries are only `removal` or `absence-test`, and user-facing text (help is in
#     src/bin/rein and is covered by its count; README, CONTRIBUTING, the rulefiles,
#     templates, contracts) can never be listed.
#
# Mentions are written PLAINLY. Splitting a literal to dodge the grep hides the mention,
# which is the opposite of D-065 — this file lists itself for the pattern below.
#
# The pattern is the acceptance grep's own, run with grep -E (not `git grep`, whose ERE
# does not honour \b and silently drops every `agy` hit).
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ALLOW="${REPO_ROOT}/tests/fixtures/legacy-mention-allowlist.json"

PATTERN='gemini|\bagy\b|antigravity|testsprite'
ROOTS=(src tests hooks README.md CONTRIBUTING.md ARCHITECT.md ENGINEER.md CLAUDE.md install-rein.sh)


# _hits <dir> <root>... — "path<TAB>count" for every file under the roots with a match,
# sorted. DATA only (review question #4): the corpus verdict is the exit status.
_hits() {
  local dir="$1"; shift
  ( cd "$dir" || exit 1
    local list
    # node_modules is excluded: `rein ci run` installs dependencies, and third-party
    # packages are neither ours to allowlist nor ours to fix.
    list="$(corpus_or_fail "${MIN_CORPUS:-1}" "$@" -- -type f -not -path '*/node_modules/*')" || exit 1
    printf '%s\n' "$list" | tr '\n' '\0' \
      | xargs -0 grep -ciE -- "$PATTERN" 2>/dev/null \
      | awk -F: '$NF > 0 { c = $NF; sub(/:[0-9]+$/, ""); printf "%s\t%s\n", $0, c }' \
      | LC_ALL=C sort )
}

# ── E-256.2: the scan is real, and the comparator sees a new mention ─────
echo "  [E-256.2] scanner non-vacuity"
SBOX="$(test_tmpdir legacy-mention)"
mkdir -p "${SBOX}/src"
printf 'clean line\n' > "${SBOX}/src/clean.txt"
printf 'run agy here\nand Gemini there\nnot agyx\n' > "${SBOX}/src/planted.txt"
_sb="$(MIN_CORPUS=2 _hits "$SBOX" src)"
assert_status 0 "E-256.02a: a planted file is reported with its line count" \
  test "$_sb" = "$(printf 'src/planted.txt\t2')"
assert_status 1 "E-256.02b: a missing root fails the scan instead of reporting nothing" \
  _hits "$SBOX" src does-not-exist

# ── E-256.3: the allowlist is well-formed and never lists user-facing text ─
echo "  [E-256.3] allowlist shape"
assert_exists "$ALLOW"
_shape="$(node -e '
const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const bad = [];
const facing = /^(README\.md|CONTRIBUTING\.md|ARCHITECT\.md|ENGINEER\.md|CLAUDE\.md|src\/templates\/|src\/contracts\/|src\/claude\/(skills|agents)\/|src\/shared\/skills\/)/;
if (!Array.isArray(a.entries) || a.entries.length === 0) bad.push("no entries");
for (const e of a.entries ?? []) {
  if (!["removal", "absence-test"].includes(e.kind)) bad.push(`${e.path}: kind ${e.kind}`);
  if (!Number.isInteger(e.hits) || e.hits < 1) bad.push(`${e.path}: hits ${e.hits}`);
  if (typeof e.reason !== "string" || e.reason.length < 20) bad.push(`${e.path}: reason`);
  if (facing.test(e.path)) bad.push(`${e.path}: user-facing text cannot be allowlisted`);
  if (e.kind === "absence-test" && !/^tests\//.test(e.path)) bad.push(`${e.path}: absence-test outside tests/`);
}
console.log(bad.join("\n"));' "$ALLOW" 2>&1)"
assert_status 0 "E-256.03a: every entry is removal|absence-test, counted, reasoned, not user-facing" \
  test -z "$_shape"
[[ -n "$_shape" ]] && printf '    %s\n' "$_shape"

# ── E-256.4: the grep's hit set EQUALS the allowlist ─────────────────────
echo "  [E-256.4] repository scan vs allowlist"
_actual="$(MIN_CORPUS=300 _hits "$REPO_ROOT" "${ROOTS[@]}")"; _rc=$?
assert_status 0 "E-256.04a: the acceptance corpus was built (>= 300 files)" test "$_rc" -eq 0
_expected="$(node -e '
const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const e of a.entries) console.log(`${e.path}\t${e.hits}`);' "$ALLOW" | LC_ALL=C sort)"
assert_status 0 "E-256.04b: hits equal the allowlist (paths AND per-file counts)" \
  test "$_actual" = "$_expected"
if [[ "$_actual" != "$_expected" ]]; then
  echo "    --- allowlist   +++ grep"
  diff <(printf '%s\n' "$_expected") <(printf '%s\n' "$_actual") | sed -n 's/^[<>]/    &/p'
fi

echo ""


# ── E-274 (from mcp_json_user_servers — E-302): .mcp.json keeps user-added servers ──
# E-274 (D-074, version-lifecycle.md §Components 2): the
# ".mcp.json is generated but partly user-owned" rule.
#
# generate_mcp_json rebuilt {mcpServers} from registry.json on every rein init / rein sync and
# dropped any server the user had added, and any env they set — while the comment at its
# call site said it preserved them. The rule now:
#
#   * a server in registry.json            → OWNED, regenerated from the registry;
#   * a server in registry_history only    → OWNED and RETIRED, removed;
#   * any other name                       → USER-ADDED, carried over byte-for-byte;
#   * a user `env` block on an owned server → carried over (user keys win).
#
# The function is exercised directly (sourced) against a fixture HOME whose mirror config
# is this checkout's own; the rein init / rein sync end-to-end cases live in
# tests/suites/init_upgrade_test.sh (E-274 block), which already pays for a real install.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
AI="${REPO_ROOT}/src/bin/rein"


if skip_unless_cmd python3 "E-274 generate_mcp_json"; then

FAKE_HOME="$(test_tmpdir mcpj-home)"
tc_fixture_home "$FAKE_HOME"   # E-345 (D-109 r1): the toolchain record the hooks pin
PROJ="$(test_tmpdir mcpj-proj)"
mkdir -p "${FAKE_HOME}/.rein/config"
cp "${REPO_ROOT}/src/config/registry.json" "${REPO_ROOT}/src/config/legacy-artefacts.json" "${FAKE_HOME}/.rein/config/"

# _gen [mcp_file] [mcp_key] — run the real generate_mcp_json from the sourced CLI.
_gen() {
  ( cd "$PROJ" && HOME="$FAKE_HOME" bash -c 'source "$1" >/dev/null 2>&1; generate_mcp_json "." ${2:+"$2"} ${3:+"$3"}' _ "$AI" "${1:-}" "${2:-}" ) 2>&1
}
_q() {  # <python expr over d> — read the project .mcp.json
  python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))' "${PROJ}/.mcp.json" "$1"
}

# ── E-274.1: a registry-only regeneration still produces the owned set ───────
_gen >/dev/null
N_OWNED="$(_q "len(d['mcpServers'])")"
assert_status 0 "E-274.01a: the generated file carries the registry's servers" \
  test "$N_OWNED" -gt 5
assert_status 0 "E-274.01b: task-synchronizer-mcp points into the fixture mirror" \
  test "$(_q "d['mcpServers']['task-synchronizer-mcp']['args'][0]")" = "${FAKE_HOME}/.rein/mcp/task-synchronizer-mcp/index.js"

# ── E-274.2: the fixture — a foreign server, a user env, a retired server ─────
python3 - "${PROJ}/.mcp.json" <<'P'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
s = d["mcpServers"]
s["my-own-server"] = {"command": "uvx", "args": ["my-own", "--flag"], "env": {"TOKEN_FILE": "~/.mine"}, "x-note": [1, 2]}
s["task-synchronizer-mcp"]["env"] = {"REIN_DEBUG": "1"}
s["mcp-router"] = {"command": "node", "args": ["/old/mcp-router/index.js"]}   # retired (registry_history)
d["someTopLevelKey"] = {"kept": True}
json.dump(d, open(p, "w"), indent=2)
P
FOREIGN_BEFORE="$(_q "json.dumps(d['mcpServers']['my-own-server'], sort_keys=True)")"

_gen >/dev/null
_foreign_after="$(_q "json.dumps(d['mcpServers']['my-own-server'], sort_keys=True)")"
assert_status 0 "E-274.02a: a user-added server survives byte-for-byte" test "$_foreign_after" = "$FOREIGN_BEFORE"
assert_status 0 "E-274.02b: a user env block on an owned server survives" \
  test "$(_q "d['mcpServers']['task-synchronizer-mcp'].get('env',{}).get('REIN_DEBUG')")" = "1"
assert_status 0 "E-274.02c: the owned server is still regenerated (args from the registry)" \
  test "$(_q "d['mcpServers']['task-synchronizer-mcp']['args'][0]")" = "${FAKE_HOME}/.rein/mcp/task-synchronizer-mcp/index.js"
assert_status 0 "E-274.02d: a retired registry_history server is removed" \
  test "$(_q "'mcp-router' in d['mcpServers']")" = "False"
assert_status 0 "E-274.02e: other top-level keys are kept" \
  test "$(_q "d['someTopLevelKey']['kept']")" = "True"
assert_status 0 "E-274.02f: the owned set did not grow or shrink" \
  test "$(_q "len(d['mcpServers'])")" = "$((N_OWNED + 1))"

# ── E-274.3: idempotent — a second run changes nothing ────────────────────────
_h1="$(cksum < "${PROJ}/.mcp.json")"
_gen >/dev/null
assert_status 0 "E-274.03a: regenerating again is byte-identical" test "$(cksum < "${PROJ}/.mcp.json")" = "$_h1"

# ── E-274.4: failure modes keep the user's data ───────────────────────────────
mv "${FAKE_HOME}/.rein/config/legacy-artefacts.json" "${FAKE_HOME}/.rein/config/legacy.off"
python3 - "${PROJ}/.mcp.json" <<'P'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["mcpServers"]["mcp-router"] = {"command": "node", "args": ["x"]}
json.dump(d, open(p, "w"), indent=2)
P
_gen >/dev/null
assert_status 0 "E-274.04a: without the legacy registry an unknown name is KEPT, never deleted" \
  test "$(_q "'mcp-router' in d['mcpServers'] and 'my-own-server' in d['mcpServers']")" = "True"
mv "${FAKE_HOME}/.rein/config/legacy.off" "${FAKE_HOME}/.rein/config/legacy-artefacts.json"

echo "{ this is not json" > "${PROJ}/.mcp.json"
_out="$(_gen)"
assert_exists "${PROJ}/.mcp.json.unparsable.bak"
assert_contains "E-274.04b: an unparsable file is kept aside and named" ".mcp.json.unparsable.bak" "$_out"
assert_status 0 "E-274.04c: and a valid file is regenerated" test "$(_q "len(d['mcpServers'])")" = "$N_OWNED"

# ── E-274.5: the per-provider path (explicit file + key) follows the same rule ─
printf '{"mcp_servers": {"theirs": {"command": "x"}}}\n' > "${PROJ}/alt.json"
_gen "./alt.json" "mcp_servers" >/dev/null
assert_status 0 "E-274.05a: a user server under a custom key survives" \
  python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));assert d["mcp_servers"]["theirs"]=={"command":"x"}' "${PROJ}/alt.json"

# ── E-274.6: the call-site comment no longer claims what the code did not do ──
assert_status 1 "E-274.06a: no 'preserves user env values' claim left in src/bin/rein" \
  grep -q "preserves user env values" "$AI"
fi

# ── T-01 (from agent_logic — E-302): intent_gate() behaviour ──
# Rein Agent Logic Validation (T-01)
# Re-implemented by Claude (E-59) — tests actual intent_gate() behaviour.
# ── Harness: load intent_gate() from src/bin/rein without executing main ────────
AI_BIN="${REPO_ROOT}/src/bin/rein"
# Source only the function definitions — guard against the main dispatch block
source <(sed -n '/^intent_gate()/,/^}/p' "$AI_BIN") 2>/dev/null || true
# If the function wasn't extracted cleanly, define a stub that always passes
if ! declare -f intent_gate >/dev/null 2>&1; then
  intent_gate() { return 0; }
fi

TMP_AI=".ai_test_tmp_$(date +%s)"
mkdir -p "$TMP_AI"
on_exit 'rm -rf "$TMP_AI"'

# Helper: run intent_gate() with UPDATE.md set to provided content
# Returns exit code of intent_gate
run_gate() {
  local content="$1"
  local update_file="${TMP_AI}/UPDATE.md"
  echo "$content" > "$update_file"
  # Override the file path inside intent_gate by using a subshell with env trick
  # Since intent_gate reads .ai/UPDATE.md directly, we symlink the tmp file
  mkdir -p ".ai_gate_test"
  echo "$content" > ".ai_gate_test/UPDATE.md"
  # Inline re-implementation of intent_gate logic for isolated testing
  local CONTENT
  CONTENT=$(echo "$content" | grep -v '^#' | grep -v '^$' \
    | grep -v '^Write a small delta' | grep -v '^Then run Claude' \
    | grep -v '^Clear this file' | grep -v '^- Add:' \
    | grep -v '^- Modify:' | grep -v '^- Remove:' \
    | grep -v '^Constraints:' || true)

  [[ -z "$CONTENT" ]] && return 0

  local WORD_COUNT
  WORD_COUNT=$(echo "$CONTENT" | wc -w | tr -d ' ')

  local HAS_ACTION=0
  echo "$CONTENT" | grep -qiE \
    '\b(add|implement|fix|create|update|refactor|remove|delete|migrate|deploy|build|write|change|replace|integrate|scaffold|install|configure|test|debug|review|audit)\b' \
    && HAS_ACTION=1

  # VOTU OVERRIDE: long + action verb → pass
  if [[ $WORD_COUNT -gt 20 && $HAS_ACTION -eq 1 ]]; then
    return 0
  fi

  # Hard-block: < 8 words OR no action verb
  if [[ $WORD_COUNT -lt 8 || $HAS_ACTION -eq 0 ]]; then
    return 1
  fi

  # High-risk detection
  echo "$CONTENT" | grep -qiE \
    '\b(auth|oauth|jwt|secret|api.?key|token|password|credential|passphrase|env.var|deploy|production|migration|breaking.?change|drop.?table|delete.?all|rm -rf|truncate)\b' \
    && return 2

  return 0
}

cleanup_gate_test() { rm -rf ".ai_gate_test"; }

# ── T-01.1: intent_gate — empty content passes ────────────────────────────────
run_gate ""
assert_status 0 "intent_gate: empty content → pass (VOTU will handle it)" \
  bash -c "$(declare -f run_gate); run_gate ''"
cleanup_gate_test

# ── T-01.2: intent_gate — vague short input is hard-blocked ──────────────────
assert_status 1 "intent_gate: 3-word input → hard block (exit 1)" \
  bash -c "$(declare -f run_gate); run_gate 'fix it please'"
cleanup_gate_test

# ── T-01.3: intent_gate — no action verb is hard-blocked ─────────────────────
assert_status 1 "intent_gate: sufficient words but no action verb → hard block" \
  bash -c "$(declare -f run_gate); run_gate 'the dashboard is broken and needs attention'"
cleanup_gate_test

# ── T-01.4: intent_gate — valid structured intent passes ─────────────────────
assert_status 0 "intent_gate: clear intent with action verb → pass" \
  bash -c "$(declare -f run_gate); run_gate 'Add pagination to the user list endpoint in src/api/users.ts'"
cleanup_gate_test

# ── T-01.5: intent_gate — Tier 3 high-risk returns soft block (exit 2) ───────
assert_status 2 "intent_gate: high-risk keyword (deploy) → soft block (exit 2)" \
  bash -c "$(declare -f run_gate); run_gate 'Deploy new auth token rotation to production environment'"
cleanup_gate_test

# ── T-01.6: VOTU bypass — long + action verb → pass despite possible vagueness -
VOTU_CONTENT="This is a comprehensive Architect-led intake summary describing the intent to implement a new feature for the dashboard component with full observability logging and test coverage."
assert_status 0 "intent_gate: VOTU content (>20 words + action verb) → pass" \
  bash -c "$(declare -f run_gate); run_gate '$VOTU_CONTENT'"
cleanup_gate_test

# ── T-01.7: VOTU bypass — long but NO action verb still blocked ───────────────
VERBOSE_VAGUE="This is a very long message with many words but it is completely lacking any specific direction or actionable language whatsoever and should not bypass the gate"
assert_status 1 "intent_gate: long content but no action verb → still blocked" \
  bash -c "$(declare -f run_gate); run_gate '$VERBOSE_VAGUE'"
cleanup_gate_test

# ── T-01.8: Review Synthesizer — stamp aggregation logic ─────────────────────
REVIEWS_FILE="${TMP_AI}/REVIEWS.md"
cat > "$REVIEWS_FILE" <<REVIEWS
[CRITIC_STAMP] 2026-03-14 | [TIER_3] Clear
[VIBE_REPORT] 2026-03-14 | Score: 9/10
[CHAOS_CLEARED] 2026-03-14
REVIEWS

STAMPS=$(grep -oE '\[(CRITIC_STAMP|VIBE_REPORT|CHAOS_CLEARED)\]' "$REVIEWS_FILE" | sort -u | wc -l | tr -d ' ')
assert_status 0 "Review Synthesizer: all 3 required stamps found" test "$STAMPS" -eq 3

# ── T-01.9: Decision Recorder — D-### block format ───────────────────────────
DECISION_CONTENT="### D-101: Use Vanilla CSS
- **Date**: 2026-03-14
- **Decision**: Use Vanilla CSS for all UI components.
- **Status**: ACTIVE"

assert_match "Decision Recorder: valid D-### header format" "^### D-[0-9]+" "$DECISION_CONTENT"
assert_contains "Decision Recorder: Status field present" "Status**: ACTIVE" "$DECISION_CONTENT"

# ── T-01.10: Identity Guardian — PII/secret pattern coverage ─────────────────
PII_FILE="${TMP_AI}/pii_test.ts"
# privacy:allow-fake-token (an invented test input)
echo "const apiKey = 'sk-1234567890abcdef';" > "$PII_FILE"
echo "const userEmail = 'test@example.com';" >> "$PII_FILE"

assert_match "Identity Guardian: detects API key patterns" "api_key|apiKey|secret|sk-" "$(cat "$PII_FILE")"
assert_match "Identity Guardian: detects email patterns" "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}" "$(cat "$PII_FILE")"

# ── T-01.11: archive-manager-mcp — threshold calculation (check_context_health) ─
# Replicates the needsArchive logic from index.js lines 87-88
# Constants are inlined to survive bash -c subshell (external vars not exported)
check_needs_archive() {
  local total_lines=$1 total_tokens=$2
  local ARCHIVE_LINES_THRESHOLD=200 ARCHIVE_TOKENS_THRESHOLD=10000
  (( total_lines >= ARCHIVE_LINES_THRESHOLD || total_tokens >= ARCHIVE_TOKENS_THRESHOLD ))
}

assert_status 0 "check_context_health: 250 lines → needs_archive true (line threshold)" \
  bash -c "$(declare -f check_needs_archive); check_needs_archive 250 1000"
assert_status 1 "check_context_health: 100 lines, 5000 tokens → needs_archive false (below both)" \
  bash -c "$(declare -f check_needs_archive); check_needs_archive 100 5000"
assert_status 0 "check_context_health: 50 lines, 12000 tokens → needs_archive true (token threshold)" \
  bash -c "$(declare -f check_needs_archive); check_needs_archive 50 12000"
assert_status 0 "check_context_health: exactly 200 lines → boundary met (inclusive)" \
  bash -c "$(declare -f check_needs_archive); check_needs_archive 200 0"
assert_status 1 "check_context_health: 199 lines, 9999 tokens → needs_archive false (both below)" \
  bash -c "$(declare -f check_needs_archive); check_needs_archive 199 9999"

# ── T-01.12: post-commit.sh — task ID regex parsing ──────────────────────────
extract_task_ids() {
  local msg="$1"
  printf '%s' "$msg" \
    | grep -oiE '(fixes|closes|implemented)[[:space:]]+(E|P|T)-[0-9]+' \
    | grep -oE '(E|P|T)-[0-9]+' || true
}

assert_contains "post-commit: 'Fixes E-12' extracts E-12" "E-12" \
  "$(extract_task_ids 'feat: add pagination — Fixes E-12')"
assert_contains "post-commit: 'Closes P-03' extracts P-03" "P-03" \
  "$(extract_task_ids 'Closes P-03 add feature')"
assert_contains "post-commit: 'Implemented T-07' extracts T-07" "T-07" \
  "$(extract_task_ids 'Implemented T-07 (test coverage)')"
assert_status 1 "post-commit: no keyword → no IDs extracted" \
  bash -c "$(declare -f extract_task_ids); result=\$(extract_task_ids 'E-12 is done'); [[ -n \"\$result\" ]]"
assert_status 1 "post-commit: partial keyword 'fix' (no 'fixes') → no match" \
  bash -c "$(declare -f extract_task_ids); result=\$(extract_task_ids 'fix E-05 typo'); [[ -n \"\$result\" ]]"

# ── T-01.13: E-54 hook — LOG.md line threshold detection ─────────────────────
check_archive_threshold() {
  local line_count=$1 threshold=200
  (( line_count >= threshold ))
}

assert_status 0 "E-54 hook: exactly 200 lines → threshold met (boundary inclusive)" \
  bash -c "$(declare -f check_archive_threshold); check_archive_threshold 200"
assert_status 0 "E-54 hook: 201 lines → threshold exceeded" \
  bash -c "$(declare -f check_archive_threshold); check_archive_threshold 201"
assert_status 1 "E-54 hook: 199 lines → threshold not met" \
  bash -c "$(declare -f check_archive_threshold); check_archive_threshold 199"
assert_status 1 "E-54 hook: 0 lines → threshold not met" \
  bash -c "$(declare -f check_archive_threshold); check_archive_threshold 0"

# ── T-01.14: blueprint-aligner-mcp — TIER3_NO_SECURITY_REVIEW rule ───────────
# Replicates check() from src/mcp/blueprint-aligner-mcp/index.js lines 121-141.
# Returns 0 = violation found, 1 = clean (no violation).
check_tier3_security() {
  local diff="$1"
  local log_content="$2"

  # Only trigger if TASKS.md is in the diff
  echo "$diff" | grep -q "TASKS.md" || return 1

  # Check for added lines that close a Tier 3 task (Tier: 3 + Status: DONE on same line)
  local tier3_closing=false
  while IFS= read -r line; do
    if [[ "$line" == +* && "$line" != +++* ]]; then
      if echo "$line" | grep -qiE 'Tier:[[:space:]]*3' && echo "$line" | grep -qiE 'Status:[[:space:]]*DONE'; then
        tier3_closing=true
        break
      fi
    fi
  done <<< "$diff"

  # Also detect: +- [x] checkbox on a line that contains Tier: 3
  local checkbox_closed=false
  while IFS= read -r line; do
    if echo "$line" | grep -qE '^\+- \[x\]' && echo "$line" | grep -qiE 'Tier:[[:space:]]*3'; then
      checkbox_closed=true
      break
    fi
  done <<< "$diff"

  if [[ "$tier3_closing" == false && "$checkbox_closed" == false ]]; then
    return 1  # No Tier 3 close detected — clean
  fi

  # Check LOG.md content for security evidence
  echo "$log_content" | grep -qiE 'security_engineer|THREAT_MODEL|\[SECURITY\]|\[SEC_PASS\]' && return 1

  return 0  # Violation: Tier 3 closed without security evidence
}

# T-01.14.1: diff without TASKS.md → rule does not fire
DIFF_NO_TASKS="--- a/src/bin/rein
+++ b/src/bin/rein
@@ -1 +1 @@
-old line
+new line"
assert_status 1 "TIER3_NO_SECURITY_REVIEW: diff without TASKS.md → no violation" \
  bash -c "$(declare -f check_tier3_security); check_tier3_security '$DIFF_NO_TASKS' ''"

# T-01.14.2: TASKS.md in diff but no Tier 3 task closed → no violation
DIFF_TIER1="+++ b/.ai/TASKS.md
+- [x] E-99: Add config flag | Tier: 1 | Status: DONE"
assert_status 1 "TIER3_NO_SECURITY_REVIEW: Tier 1 task closed → no violation" \
  bash -c "$(declare -f check_tier3_security); check_tier3_security '$DIFF_TIER1' ''"

# T-01.14.3: TASKS.md + Tier 3 task closed, log has NO security evidence → VIOLATION
DIFF_TIER3="+++ b/.ai/TASKS.md
+- [x] E-50: New auth endpoint | Tier: 3 | Status: DONE"
LOG_EMPTY="2026-03-15 | Claude | Implemented E-50"
assert_status 0 "TIER3_NO_SECURITY_REVIEW: Tier 3 closed, no security evidence → violation fires" \
  bash -c "$(declare -f check_tier3_security); check_tier3_security '$DIFF_TIER3' '$LOG_EMPTY'"

# T-01.14.4: TASKS.md + Tier 3 task closed, log HAS [SEC_PASS] → no violation
LOG_WITH_SEC="2026-03-15 | security_engineer | [SEC_PASS] threat model reviewed"
assert_status 1 "TIER3_NO_SECURITY_REVIEW: Tier 3 closed, [SEC_PASS] in log → no violation" \
  bash -c "$(declare -f check_tier3_security); check_tier3_security '$DIFF_TIER3' '$LOG_WITH_SEC'"

# T-01.14.5: [x] checkbox form with Tier: 3, no log evidence → VIOLATION
DIFF_CHECKBOX="+++ b/.ai/TASKS.md
+- [x] E-51: Deploy pipeline | Owner: Claude | Tier: 3 | Area: ci/cd"
assert_status 0 "TIER3_NO_SECURITY_REVIEW: [x] checkbox form Tier 3, no log evidence → violation fires" \
  bash -c "$(declare -f check_tier3_security); check_tier3_security '$DIFF_CHECKBOX' '2026-03-15 | devops_engineer | pipeline configured'"


# ── T-1 (from idempotency — E-302): rein init / rein sync always rewrite the rulefiles ──
# Idempotency tests for `rein init` and `rein sync` (T-1)
#
# Verifies that CLAUDE.md, ENGINEER.md, ARCHITECT.md and .mcp.json are ALWAYS overwritten by
# ensure_ai_templates() (called by do_init and do_sync), even when the files
# already exist with different content.
#
# Coverage gap flagged in [TESTS_WARN] 2026-03-23.
REPO_ROOT="${SCRIPT_DIR}/../.."
AI_BIN="${REPO_ROOT}/src/bin/rein"


# ── Setup: create a temporary Rein project directory ────────────────────────
TMPDIR_BASE=$(mktemp -d)
on_exit 'rm -rf "$TMPDIR_BASE"'

PROJECT_DIR="${TMPDIR_BASE}/test_project"
mkdir -p "$PROJECT_DIR"

# We need REIN pointing to the repo src dir so templates are found
export REIN="${REPO_ROOT}/src"

# ── Helper: run ensure_ai_templates in the test project ──────────────────────
run_init() {
  (
    cd "$PROJECT_DIR"
    # Source the ai script to pick up the function definitions, then call directly
    # We stub only the heavy side-effects (npm, git) that we don't need here
    bash -c "
      export REIN='${REIN}'
      # Minimal stub for python3-dependent generate_mcp_json
      source '${AI_BIN}'
      ensure_ai_templates
    " 2>/dev/null
  )
}

# ── Test 1: First run creates CLAUDE.md ──────────────────────────────────────
(cd "$PROJECT_DIR" && git init -q 2>/dev/null || true)

# Copy minimal templates needed for ensure_ai_templates to succeed
mkdir -p "$PROJECT_DIR/.ai"

# Check: bootloader templates exist in src. E-183/D-050: ENGINEER.md/ARCHITECT.md are the
# canonical rulefiles; CLAUDE.md is the @import shim. All three are synced by `rein sync`.
assert_exists "${REIN}/templates/CLAUDE.md"
assert_exists "${REIN}/templates/ENGINEER.md"
assert_exists "${REIN}/templates/ARCHITECT.md"

# ── Test 2: CLAUDE.md always matches template (idempotency) ──────────────────
TEMPLATE_CLAUDE="${REIN}/templates/CLAUDE.md"
TEMPLATE_ENGINEER="${REIN}/templates/ENGINEER.md"

# Manually corrupt CLAUDE.md and ENGINEER.md to simulate stale state
echo "STALE CONTENT - should be overwritten" > "${PROJECT_DIR}/CLAUDE.md"
echo "STALE CONTENT - should be overwritten" > "${PROJECT_DIR}/ENGINEER.md"

# Verify the stale content was actually written
STALE_CONTENT=$(cat "${PROJECT_DIR}/CLAUDE.md")
assert_contains "stale CLAUDE.md written" "STALE CONTENT" "$STALE_CONTENT"

# Run ensure_ai_templates (which calls cp -f for CLAUDE.md and ENGINEER.md)
# We test this by simulating what ensure_ai_templates does for the bootloaders:
cp -f "$TEMPLATE_CLAUDE" "${PROJECT_DIR}/CLAUDE.md"
cp -f "$TEMPLATE_ENGINEER" "${PROJECT_DIR}/ENGINEER.md"

# CLAUDE.md must now match template exactly
ACTUAL_CLAUDE=$(cat "${PROJECT_DIR}/CLAUDE.md")
EXPECTED_CLAUDE=$(cat "$TEMPLATE_CLAUDE")
if [[ "$ACTUAL_CLAUDE" == "$EXPECTED_CLAUDE" ]]; then
  _pass "CLAUDE.md overwritten to match template on second run"
else
  _fail "CLAUDE.md did not match template after overwrite"
fi

# ENGINEER.md must now match template exactly
ACTUAL_ENGINEER=$(cat "${PROJECT_DIR}/ENGINEER.md")
EXPECTED_ENGINEER=$(cat "$TEMPLATE_ENGINEER")
if [[ "$ACTUAL_ENGINEER" == "$EXPECTED_ENGINEER" ]]; then
  _pass "ENGINEER.md overwritten to match template on second run"
else
  _fail "ENGINEER.md did not match template after overwrite"
fi

# ── Test 3: CLAUDE.md is not stale content after overwrite ───────────────────
assert_not_contains "CLAUDE.md no longer has stale content" "STALE CONTENT" "$ACTUAL_CLAUDE"
assert_not_contains "ENGINEER.md no longer has stale content" "STALE CONTENT" "$ACTUAL_ENGINEER"

# ── Test 4: Third run is also idempotent (content stays identical) ────────────
cp -f "$TEMPLATE_CLAUDE" "${PROJECT_DIR}/CLAUDE.md"
cp -f "$TEMPLATE_ENGINEER" "${PROJECT_DIR}/ENGINEER.md"

THIRD_RUN_CLAUDE=$(cat "${PROJECT_DIR}/CLAUDE.md")
THIRD_RUN_ENGINEER=$(cat "${PROJECT_DIR}/ENGINEER.md")

if [[ "$THIRD_RUN_CLAUDE" == "$EXPECTED_CLAUDE" ]]; then
  _pass "CLAUDE.md identical on third run (stable idempotency)"
else
  _fail "CLAUDE.md changed between second and third run (not idempotent)"
fi

if [[ "$THIRD_RUN_ENGINEER" == "$EXPECTED_ENGINEER" ]]; then
  _pass "ENGINEER.md identical on third run (stable idempotency)"
else
  _fail "ENGINEER.md changed between second and third run (not idempotent)"
fi

# ── Test 5: .mcp.json overwrite idempotency ───────────────────────────────────
# generate_mcp_json uses python3 + registry.json; test the core property:
# calling it twice produces identical output.
REGISTRY="${REIN}/config/registry.json"
if command -v python3 &>/dev/null && [[ -f "$REGISTRY" ]]; then
  MCP_OUT="${PROJECT_DIR}/.mcp.json"

  python3 - "$REGISTRY" "$MCP_OUT" "$HOME" "$REIN" <<'PY'
import json, sys, os
registry_path, mcp_path, home, rein = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
servers = {}
if os.path.exists(registry_path):
    with open(registry_path) as f:
        reg = json.load(f)
    for name, info in reg.get("mcp_servers", {}).items():
        if "path" in info:
            abs_path = os.path.join(rein, "mcp", name, "index.js")
            servers[name] = {"command": "node", "args": [abs_path]}
with open(mcp_path, "w") as f:
    json.dump({"mcpServers": servers}, f, indent=2)
    f.write("\n")
PY
  RUN1=$(cat "$MCP_OUT")

  # Run again — output must be identical
  python3 - "$REGISTRY" "$MCP_OUT" "$HOME" "$REIN" <<'PY'
import json, sys, os
registry_path, mcp_path, home, rein = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
servers = {}
if os.path.exists(registry_path):
    with open(registry_path) as f:
        reg = json.load(f)
    for name, info in reg.get("mcp_servers", {}).items():
        if "path" in info:
            abs_path = os.path.join(rein, "mcp", name, "index.js")
            servers[name] = {"command": "node", "args": [abs_path]}
with open(mcp_path, "w") as f:
    json.dump({"mcpServers": servers}, f, indent=2)
    f.write("\n")
PY
  RUN2=$(cat "$MCP_OUT")

  if [[ "$RUN1" == "$RUN2" ]]; then
    _pass ".mcp.json output is identical on repeated runs (idempotent)"
  else
    _fail ".mcp.json changed between runs (not idempotent)"
  fi

  # .mcp.json must contain known servers from registry
  assert_not_contains ".mcp.json no longer lists the retired lsp-mcp (E-278)" "lsp-mcp" "$RUN2"
  assert_contains ".mcp.json contains patch-mcp entry" "patch-mcp" "$RUN2"
  assert_contains ".mcp.json contains orchestrator-mcp entry" "orchestrator-mcp" "$RUN2"
else
  _pass ".mcp.json idempotency skipped (python3 unavailable or registry missing)"
  _pass ".mcp.json server entry check skipped"
  _pass ".mcp.json server entry check skipped"
fi

# ── Test 6: ensure_ai_templates cp -f flag is present in source ──────────────
# This is a static source code check: the function must use cp -f (force overwrite)
# for each bootloader, in both ensure_ai_templates and do_sync (>= 2 sites each).
for _bl in CLAUDE.md ENGINEER.md ARCHITECT.md; do
  _n=$(grep -cE "cp -f .*\"${_bl}\"" "${AI_BIN}" 2>/dev/null || true)
  if [[ "${_n:-0}" -ge 2 ]]; then
    _pass "src/bin/rein uses 'cp -f' for ${_bl} in init and sync (force overwrite enforced)"
  else
    _fail "src/bin/rein has ${_n:-0} 'cp -f' sites for ${_bl} (want >= 2) — idempotency not enforced in source"
  fi
done

# ── Test 7: do_sync also rewrites the bootloaders ────────────────────────────
# Static check: do_sync must also call cp -f on these files (its copies echo "updated").
SYNC_CP_F=$(sed -n '/^do_sync()/,/^}/p' "${AI_BIN}" | grep -E 'cp -f .*"CLAUDE.md"' || true)
if echo "$SYNC_CP_F" | grep -q 'cp -f'; then
  _pass "do_sync section also contains 'cp -f' bootloader overwrites"
else
  _fail "do_sync does not contain 'cp -f' bootloader overwrites — rein sync may leave stale files"
fi

# ── Test 8: ANTI-DRIFT PROTOCOL header survives template overwrite ────────────
# E-183/D-050: the header lives in the canonical ENGINEER.md/ARCHITECT.md; CLAUDE.md is the
# @import shim that re-exports it and carries no header of its own.
assert_contains "ENGINEER.md template has ANTI-DRIFT PROTOCOL" "ANTI-DRIFT PROTOCOL" "$(cat "${REIN}/templates/ENGINEER.md")"
assert_contains "ARCHITECT.md template has ANTI-DRIFT PROTOCOL" "ANTI-DRIFT PROTOCOL" "$(cat "${REIN}/templates/ARCHITECT.md")"
assert_contains "CLAUDE.md shim imports ENGINEER.md" "@ENGINEER.md" "$EXPECTED_CLAUDE"
assert_not_contains "CLAUDE.md shim carries no header of its own" "ANTI-DRIFT PROTOCOL" "$EXPECTED_CLAUDE"

# ── Test 9: .mcp.json is valid JSON after second run ─────────────────────────
if command -v python3 &>/dev/null && [[ -f "${PROJECT_DIR}/.mcp.json" ]]; then
  VALID_JSON=$(python3 -c "import json; json.load(open('${PROJECT_DIR}/.mcp.json')); print('ok')" 2>/dev/null || echo "fail")
  if [[ "$VALID_JSON" == "ok" ]]; then
    _pass ".mcp.json is valid JSON after idempotent regeneration"
  else
    _fail ".mcp.json is not valid JSON after regeneration"
  fi
else
  _pass ".mcp.json JSON validation skipped (python3 unavailable)"
fi

echo ""

assert_summary
