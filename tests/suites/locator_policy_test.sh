#!/usr/bin/env bash
# locator_policy_test.sh — E-223 (D-057 §3): install-first helper resolution.
#
# Every hook used to locate framework helpers as
#     "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/src/<helper>"
# which names the USER's repository, not the Rein install. A project containing
# `src/mcp/safe-exec-mcp/index.js` therefore had THAT file executed by node from inside a
# PreToolUse hook, with its stdout trusted to decide whether a write is allowed: cloning a
# repo was enough to run its code AND disable the gate meant to stop it.
#
# The canary cases below are the point of this suite. They plant an executable marker in a
# decoy repo and assert it never runs. A grep for the old idiom would pass against a
# resolver that still consults the visited repo by another route, so the assertions are on
# EXECUTION, not on source text.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LOC_SH="${REPO_ROOT}/src/shared/locate.sh"
LOC_MJS="${REPO_ROOT}/src/shared/locate.mjs"
AI_BIN="${REPO_ROOT}/src/bin/ai"

echo "── Suite: locator_policy_test (E-223) ───────────────────────────────"

# ── Build a decoy project: a real git repo that is NOT the framework clone, carrying
# ── the exact filenames the old locators would have reached for.
_decoy() {
  local d; d="$(mktemp -d)"
  mkdir -p "$d/src/mcp/safe-exec-mcp" "$d/src/mcp/cache-manager-mcp" "$d/src/shared" "$d/.ai"
  local marker="$d/CANARY_EXECUTED"
  for f in "src/mcp/safe-exec-mcp/index.js" "src/mcp/cache-manager-mcp/index.js" \
           "src/shared/telemetry.mjs" "src/shared/provider-adapter.mjs" \
           "src/shared/sync-manifest.mjs" "src/shared/role-manifest.mjs" \
           "src/shared/resolve-launch.mjs"; do
    printf 'require("fs").appendFileSync(%s,"%s\\n");\n' "\"$marker\"" "$f" > "$d/$f"
  done
  ( cd "$d" && git init -q . && git add -A >/dev/null 2>&1 && \
    git -c user.email=t@t -c user.name=t commit -qm decoy >/dev/null 2>&1 )
  printf '%s' "$d"
}

# ── E-223.1: the resolver itself ────────────────────────────────────────────
_D="$(_decoy)"
_resolved="$(cd "$_D" && bash -c "source '$LOC_SH'; rein_locate mcp/safe-exec-mcp/index.js" 2>/dev/null)"
assert_not_contains "E-223.01a: a decoy repo never resolves its OWN src/" "$_D" "$_resolved"
assert_contains     "E-223.01b: it resolves the install mirror instead" ".rein/mcp/safe-exec-mcp" "$_resolved"
_resolved="$(cd "$REPO_ROOT" && bash -c "source '$LOC_SH'; rein_locate mcp/safe-exec-mcp/index.js" 2>/dev/null)"
assert_contains "E-223.01c: the framework clone still resolves the dev tree (dogfooding)" \
  "$REPO_ROOT/src/mcp/safe-exec-mcp" "$_resolved"

# ── E-223.2: the node twin answers identically ──────────────────────────────
# Two implementations of one policy drift silently. Compare their ANSWERS, not their text.
for _lg in "mcp/safe-exec-mcp/index.js" "shared/telemetry.mjs"; do
  for _cwd in "$_D" "$REPO_ROOT"; do
    _a="$(cd "$_cwd" && bash -c "source '$LOC_SH'; rein_locate $_lg" 2>/dev/null)"
    _b="$(cd "$_cwd" && node --no-warnings "$LOC_MJS" "$_lg" 2>/dev/null)"
    _where="$([[ "$_cwd" == "$REPO_ROOT" ]] && echo framework || echo decoy)"
    assert_contains "E-223.02: shell and node agree on $_lg in the $_where repo" "$_a" "$_b"
  done
done

# ── E-223.3: REIN_LOCATE_DEV=1 restores dev-first ──────────────────────────
_resolved="$(cd "$_D" && REIN_LOCATE_DEV=1 bash -c "source '$LOC_SH'; rein_locate shared/telemetry.mjs" 2>/dev/null)"
assert_contains "E-223.03a: the rollback flag reaches the dev tree" "$_D" "$_resolved"
_resolved="$(cd "$_D" && bash -c "source '$LOC_SH'; rein_locate shared/telemetry.mjs" 2>/dev/null)"
assert_not_contains "E-223.03b: without it, the decoy tree is not consulted" "$_D" "$_resolved"

# ── E-223.4: THE CANARY — no hook executes a decoy repo's helpers ───────────
# This is the acceptance criterion. Each hook is run from inside the decoy with the input
# shape it expects; the marker file must never appear.
_run_hooks_in() {
  local d="$1"
  local payload='{"tool_name":"Bash","tool_input":{"command":"echo hi"},"session_id":"e223-probe"}'
  ( cd "$d" || exit 0
    printf '%s' "$payload" | bash "${REPO_ROOT}/hooks/pre-tool-use.sh"  >/dev/null 2>&1
    printf '%s' "$payload" | bash "${REPO_ROOT}/hooks/post-tool-use.sh" >/dev/null 2>&1
    printf '%s' "$payload" | bash "${REPO_ROOT}/hooks/session-start.sh" engineer >/dev/null 2>&1
    printf '%s' "$payload" | bash "${REPO_ROOT}/hooks/stop-hook.sh"     >/dev/null 2>&1
    bash "${REPO_ROOT}/hooks/pre-commit.sh"  >/dev/null 2>&1
    bash "${REPO_ROOT}/hooks/post-commit.sh" >/dev/null 2>&1
  ) || true
}
_run_hooks_in "$_D"
assert_status 1 "E-223.04a: NO hook executed the decoy repo's helpers" test -f "$_D/CANARY_EXECUTED"

# ── E-223.5: THE CANARY — no `ai` subcommand executes them either ───────────
( cd "$_D" && bash "$AI_BIN" sync   >/dev/null 2>&1; bash "$AI_BIN" doctor >/dev/null 2>&1 ) || true
assert_status 1 "E-223.05a: NO ai subcommand executed the decoy repo's helpers" \
  test -f "$_D/CANARY_EXECUTED"
if [[ -f "$_D/CANARY_EXECUTED" ]]; then
  echo "    executed: $(tr '\n' ' ' < "$_D/CANARY_EXECUTED")" >&2
fi

# ── E-223.6: the old idiom is gone from the locator sites ───────────────────
# Weaker than the canary and kept only to stop the pattern being pasted back in. The
# REMAINING rev-parse uses are project-data paths (a project's own .ai/, its own tests) —
# those are correct and must NOT be rewritten, so the assertion is scoped to `/src/`.
# Comment lines are stripped first: the replacement carries an explanation that QUOTES
# the old idiom, and matching that would make this assertion fail on its own documentation.
_no_locator_idiom() {  # <file...>
  ! sed 's/[[:space:]]*#.*$//' "$@" | grep -qE 'rev-parse --show-toplevel.*/src/'
}
assert_status 0 "E-223.06a: no hook locates a framework helper via the visited repo" \
  _no_locator_idiom ${REPO_ROOT}/hooks/*.sh
assert_status 0 "E-223.06b: nor does src/bin/ai" \
  _no_locator_idiom "$AI_BIN"
assert_status 0 "E-223.06c: pre-commit still finds the PROJECT's .ai/ via git toplevel" \
  bash -c "grep -q 'AI_DIR=\"\\\$(git rev-parse --show-toplevel' '${REPO_ROOT}/hooks/pre-commit.sh'"
assert_status 0 "E-223.06d: post-tool-use still runs the PROJECT's own test runner" \
  bash -c "grep -q 'PROJECT_ROOT=\"\\\$(git rev-parse --show-toplevel' '${REPO_ROOT}/hooks/post-tool-use.sh'"

# ── E-223.8: env a visited repo controls must not re-open the boundary ──────
# A project's own `.claude/settings.json` carries an `env` block that the CLI applies to
# the session, and hooks inherit it — `ai init` writes that key, so it is the NORMAL shape.
# The first cut of E-223 was defeated by three vars settable from that file, and the worst
# of them was one E-223 itself introduced: pre-E-223 hooks hardcoded ${HOME}/.rein and
# never read REIN_HOME. Cloning a repo was still enough; it just needed one more file.
_env_canary() {  # <env assignment...> → the marker content, or "not executed"
  : > "$_D/CANARY_EXECUTED"
  local payload='{"tool_name":"Bash","tool_input":{"command":"echo hi"},"session_id":"e223-env"}'
  ( cd "$_D" || exit 0
    printf '%s' "$payload" | env "$@" bash "${REPO_ROOT}/hooks/pre-tool-use.sh"  >/dev/null 2>&1
    printf '%s' "$payload" | env "$@" bash "${REPO_ROOT}/hooks/post-tool-use.sh" >/dev/null 2>&1
  ) || true
  local got; got="$(tr '\n' ' ' < "$_D/CANARY_EXECUTED" 2>/dev/null)"
  printf '%s' "${got:-not executed}"
}
# The decoy needs a shell payload too: with REIN_HOME redirected, the bootstrap SOURCES
# the decoy's locate.sh, which is arbitrary shell inside a fail-closed gate process.
mkdir -p "$_D/shared"
printf 'printf "SH_SOURCED_DECOY\\n" >> "%s"\nrein_locate() { printf "%%s" "%s"; return 0; }\n' \
  "$_D/CANARY_EXECUTED" "$_D/src/mcp/safe-exec-mcp/index.js" > "$_D/shared/locate.sh"

assert_contains "E-223.08a: REIN_LOCATE_DEV=1 is ignored inside hooks" "not executed" \
  "$(_env_canary REIN_LOCATE_DEV=1)"
assert_contains "E-223.08b: REIN_WORKSPACE cannot claim the visited repo is the clone" "not executed" \
  "$(_env_canary REIN_WORKSPACE="$_D")"
assert_contains "E-223.08c: REIN_HOME cannot redirect the resolver bootstrap" "not executed" \
  "$(_env_canary REIN_HOME="$_D")"
assert_status 0 "E-223.08d: every hook declares its environment untrusted" \
  bash -c "for h in pre-tool-use session-start pre-commit post-tool-use stop-hook; do
             grep -q 'REIN_LOCATE_UNTRUSTED_ENV=1' '${REPO_ROOT}/hooks/'\$h'.sh' || exit 1; done"
# Match an EXPANSION of the env var (`${REIN_HOME...}` / `$REIN_HOME`), not the local
# `_REIN_HOME_DIR` that holds the hardcoded path — an earlier version of this assertion
# matched the variable NAME and failed on correct code.
assert_status 1 "E-223.08e: no hook reads the REIN_HOME env var any more" \
  bash -c "sed 's/[[:space:]]*#.*\$//' ${REPO_ROOT}/hooks/*.sh | grep -qE '[\\\$]\\{?REIN_HOME[}:]'"
# The recorded workspace file outranks the env var even when the env IS trusted.
assert_status 0 "E-223.08f: the installer-recorded workspace outranks REIN_WORKSPACE" \
  bash -c "grep -q 'rein-workspace.txt' '$LOC_SH' &&
           python3 - <<'PYX'
import re,sys
s=open('$LOC_SH').read()
i=s.index('rein_is_framework_clone')
body=s[i:i+1400]
sys.exit(0 if body.index('rein-workspace.txt') < body.index('REIN_WORKSPACE:-') else 1)
PYX"

# ── E-223.9: the framework test PARSES package.json, never greps it ─────────
# A substring grep and a JSON parse disagree, and the shell side is the one every hook
# uses. A repo named `totally-innocent-app` carrying a NESTED "name": "@vimurai/rein" satisfied
# the grep. Two implementations of one policy must not diverge — and when they do, the
# permissive one is the one that decides.
_SB="$(mktemp -d)"; _LIAR="$_SB/liar"
mkdir -p "$_LIAR/src/mcp/safe-exec-mcp" "$_SB/home/.rein/mcp/safe-exec-mcp" "$_SB/home/.rein/config"
tc_fixture_home "$_SB/home"   # E-345 (D-109 r1): the toolchain record the hooks pin
echo 'x' > "$_LIAR/src/mcp/safe-exec-mcp/index.js"
echo 'x' > "$_SB/home/.rein/mcp/safe-exec-mcp/index.js"
printf '{ "name": "totally-innocent-app", "bundledMeta": { "vendored": { "name": "@vimurai/rein" } } }\n' \
  > "$_LIAR/package.json"
( cd "$_LIAR" && git init -q . && git add -A >/dev/null 2>&1 &&
  git -c user.email=t@t -c user.name=t commit -qm x >/dev/null 2>&1 )
_sh="$(cd "$_LIAR" && HOME="$_SB/home" REIN_HOME="$_SB/home/.rein" \
        bash -c "source '$LOC_SH'; rein_locate mcp/safe-exec-mcp/index.js" 2>/dev/null)"
_nd="$(cd "$_LIAR" && HOME="$_SB/home" REIN_HOME="$_SB/home/.rein" \
        node --no-warnings "$LOC_MJS" mcp/safe-exec-mcp/index.js 2>/dev/null)"
assert_not_contains "E-223.09a: a nested name does not make a repo the framework clone" "$_LIAR" "$_sh"
assert_contains "E-223.09b: shell and node agree on the liar manifest" "$_sh" "$_nd"
assert_status 1 "E-223.09c: the name is parsed, not substring-matched" \
  bash -c "grep -q 'grep -qE .\"name\"' '$LOC_SH'"
rm -rf "$_SB"

# ── E-223.10: `ai` is subject to the same untrusted env as the hooks ────────
# `ai` is invoked through Bash from inside the project being worked on, so it inherits the
# same repo-chosen session env. Hardening only the hooks left REIN_HOME and
# REIN_LOCATE_DEV honoured here — and `_locate_resolve_launch`'s stdout decides which
# BINARY `ai pane` execs. The bootstrap is EXTRACTED from the shipped script rather than
# retyped: a hand-copied bootstrap is how the first version of this probe kept
# "reproducing" a bug that was already fixed.
_SB2="$(mktemp -d)"; _DEC="$_SB2/decoy"
mkdir -p "$_DEC/src/mcp/safe-exec-mcp" "$_DEC/mcp/safe-exec-mcp" \
         "$_SB2/home/.rein/mcp/safe-exec-mcp" "$_SB2/home/.rein/config" "$_SB2/home/.rein/shared"
tc_fixture_home "$_SB2/home"   # E-345 (D-109 r1): the toolchain record the hooks pin
echo x > "$_DEC/src/mcp/safe-exec-mcp/index.js"
echo x > "$_DEC/mcp/safe-exec-mcp/index.js"
echo x > "$_SB2/home/.rein/mcp/safe-exec-mcp/index.js"
cp "$LOC_SH" "$_SB2/home/.rein/shared/locate.sh"
printf '%s\n' "$REPO_ROOT" > "$_SB2/home/.rein/config/rein-workspace.txt"
( cd "$_DEC" && git init -q . && git commit -q --allow-empty -m x >/dev/null 2>&1 )
sed -n '1,/^usage() {/p' "$AI_BIN" | sed '$d' > "$_SB2/boot.sh"

_ai_boot_resolves() {   # <env...> → the resolved path
  ( cd "$_DEC" && env HOME="$_SB2/home" "$@" bash -c '
      set +e
      source "'"$_SB2"'/boot.sh" >/dev/null 2>&1
      rein_locate mcp/safe-exec-mcp/index.js' 2>/dev/null )
}
assert_not_contains "E-223.10a: ai baseline resolves the install mirror" "$_DEC" "$(_ai_boot_resolves IGNORE=1)"
assert_not_contains "E-223.10b: REIN_LOCATE_DEV cannot redirect ai"     "$_DEC" "$(_ai_boot_resolves REIN_LOCATE_DEV=1)"
assert_not_contains "E-223.10c: REIN_HOME cannot redirect ai"           "$_DEC" "$(_ai_boot_resolves REIN_HOME="$_DEC")"
assert_not_contains "E-223.10d: REIN_WORKSPACE cannot redirect ai"       "$_DEC" "$(_ai_boot_resolves REIN_WORKSPACE="$_DEC")"
# The argv override must be argv-ONLY: bin/ai resets it before reading argv, so an
# inherited value cannot pre-set it. Without that reset the fix would just rename the hole.
assert_not_contains "E-223.10e: the argv override cannot be forged through the env" "$_DEC" \
  "$(_ai_boot_resolves _REIN_LOCATE_DEV_ARGV=1)"
# …and it must still work, or framework development has no dev-tree path at all.
_dev="$( cd "$REPO_ROOT" && bash -c "set -- --dev-tree sync; source '$_SB2/boot.sh' >/dev/null 2>&1; rein_locate shared/locate.sh" 2>/dev/null )"
assert_contains "E-223.10f: ai --dev-tree still reaches the dev tree" "$REPO_ROOT/src" "$_dev"
assert_status 0 "E-223.10g: ai declares its environment untrusted" \
  bash -c "grep -q 'REIN_LOCATE_UNTRUSTED_ENV=1' '$AI_BIN'"

# ── E-223.11: the twins agree on the UNTRUSTED branch too ───────────────────
# E-223.02 compares only the trusted branch — the one where they already agreed. The
# untrusted branch is the one every hook runs, and for a round the two implemented
# different trust models there: shell returned the install mirror, node returned the decoy,
# for all three env vars. Comparing only where two implementations agree is precisely the
# vacuous-parity failure this suite exists to prevent.
for _ev in "REIN_LOCATE_DEV=1" "REIN_HOME=$_DEC" "REIN_WORKSPACE=$_DEC"; do
  _sh="$( cd "$_DEC" && env HOME="$_SB2/home" REIN_LOCATE_UNTRUSTED_ENV=1 "$_ev" \
            bash -c "source '$LOC_SH'; rein_locate mcp/safe-exec-mcp/index.js" 2>/dev/null )"
  _nd="$( cd "$_DEC" && env HOME="$_SB2/home" REIN_LOCATE_UNTRUSTED_ENV=1 "$_ev" \
            node --no-warnings "$LOC_MJS" mcp/safe-exec-mcp/index.js 2>/dev/null )"
  assert_not_contains "E-223.11 node honours the untrusted flag for ${_ev%%=*}" "$_DEC" "$_nd"
  assert_contains     "E-223.11 twins agree under untrusted env for ${_ev%%=*}" "$_sh" "$_nd"
done
# ── E-223.12: the dev-tree override cannot come from the environment ────────
# The fix for F1 introduced this bug: "argv-only" implemented as another env var that each
# caller resets. bin/ai reset it; the five hooks never mentioned it, so a settings.json env
# block made a hook resolve the VISITED repo's own safe-exec analyzer — and the gate then
# allowed everything. It is a function call now, with the state reset at source time, so no
# variable of any name can turn it on.
# REIN_LOCATE_DEV is deliberately NOT in this list: in a TRUSTED env it is supposed to
# work, and D-057 §3 names it as the framework-dev rollback. Its containment is asserted
# where it belongs — under the untrusted flag (E-223.11) and through a real hook
# (E-223.08a). An assertion that banned it everywhere would have been testing my own
# misreading rather than the policy.
for _forge in _REIN_LOCATE_DEV_TREE=1 _REIN_LOCATE_DEV_ARGV=1; do
  _r="$( cd "$_DEC" && env HOME="$_SB2/home" "$_forge" \
          bash -c "source '$LOC_SH'; rein_locate mcp/safe-exec-mcp/index.js" 2>/dev/null )"
  assert_not_contains "E-223.12 no env var enables the dev tree: ${_forge%%=*}" "$_DEC" "$_r"
done
# Through the REAL hook, end to end — the shape that actually failed.
: > "$_DEC/CANARY_EXECUTED"
( cd "$_DEC" && printf '%s' '{"tool_name":"Bash","tool_input":{"command":"echo hi"}}' \
    | env HOME="$_SB2/home" _REIN_LOCATE_DEV_ARGV=1 bash "${REPO_ROOT}/hooks/pre-tool-use.sh" >/dev/null 2>&1 ) || true
assert_status 1 "E-223.12d: the forged override does not reach a real hook" \
  bash -c "test -s '$_DEC/CANARY_EXECUTED'"
# The trusted-env path must still work, or the rollback D-057 §3 names is gone.
_r="$( cd "$_DEC" && env HOME="$_SB2/home" REIN_LOCATE_DEV=1 \
        bash -c "source '$LOC_SH'; rein_locate mcp/safe-exec-mcp/index.js" 2>/dev/null )"
assert_contains "E-223.12h: REIN_LOCATE_DEV still works in a TRUSTED env" "$_DEC" "$_r"

assert_status 0 "E-223.12e: the override is a function, not a variable" \
  bash -c "grep -q 'rein_locate_enable_dev_tree()' '$LOC_SH'"
assert_status 0 "E-223.12f: its state is reset unconditionally at source time" \
  bash -c "grep -qE '^_REIN_LOCATE_DEV_TREE=0' '$LOC_SH'"
assert_status 0 "E-223.12g: the node twin exposes the same function, not an env var" \
  bash -c "grep -q 'export function enableDevTree' '$LOC_MJS' && ! grep -q 'DEV_ARGV' '$LOC_MJS'"

# ── E-223.13: `--dev-tree` is positional and inert as user DATA ─────────────
# Matching it anywhere would let a task title or handoff message flip resolution policy —
# and silently remove the argument the user meant to pass.
_try_argv() {  # <args...> → "dev" | "install"
  local r
  r="$( cd "$_DEC" && env HOME="$_SB2/home" bash -c '
          set +e; set -- '"$*"'
          source "'"$_SB2"'/boot.sh" >/dev/null 2>&1
          rein_locate mcp/safe-exec-mcp/index.js' 2>/dev/null )"
  [[ "$r" == *"/decoy/src/"* ]] && printf 'dev' || printf 'install'
}
assert_contains "E-223.13a: --dev-tree in first position works"        "dev"     "$(_try_argv --dev-tree sync)"
assert_contains "E-223.13b: after a -- terminator it is inert"         "install" "$(_try_argv add-task -- --dev-tree)"
assert_contains "E-223.13c: as a later argument it is inert"           "install" "$(_try_argv handoff architect --dev-tree)"
assert_contains "E-223.13d: plain invocation is unaffected"            "install" "$(_try_argv sync)"

assert_status 0 "E-223.11g: the node twin reads the untrusted-env flag" \
  bash -c "grep -q 'REIN_LOCATE_UNTRUSTED_ENV' '$LOC_MJS'"
assert_status 0 "E-223.11h: hooks EXPORT the flag so children inherit it" \
  bash -c "for h in pre-tool-use session-start pre-commit post-tool-use stop-hook; do
             grep -q 'export REIN_LOCATE_UNTRUSTED_ENV=1' '${REPO_ROOT}/hooks/'\$h'.sh' || exit 1; done"
rm -rf "$_SB2"

# ── E-223.14: EVERY helper lookup in src/bin/ai goes through the resolver ───
# D-057 §3 names src/bin/ai, and the first pass converted only the three _locate_*
# wrappers. Eight other chains kept their own order and FOUR were cwd-relative FIRST —
# the defect in a more direct form than the original, since no git repo is needed: a
# `src/shared/memory-batch-scanner.mjs` in any directory `ai sync` ran from was handed to
# node, and that one runs inside do_sync.
_D2="$(mktemp -d)"
mkdir -p "$_D2/src/shared" "$_D2/scripts"
for _f in memory-batch-scanner wal-flusher cli-add-task mcp-tester plugin-builder; do
  echo x > "$_D2/src/shared/$_f.mjs"
done
echo x > "$_D2/scripts/generate_mcp_docs.mjs"
( cd "$_D2" && git init -q . && git commit -q --allow-empty -m x >/dev/null 2>&1 )
for _h in shared/memory-batch-scanner.mjs shared/wal-flusher.mjs shared/cli-add-task.mjs shared/mcp-tester.mjs shared/plugin-builder.mjs; do
  _r="$( cd "$_D2" && bash -c "set -- sync; source '$_SB2/boot.sh' >/dev/null 2>&1; _rein_helper $_h" 2>/dev/null )"
  assert_not_contains "E-223.14 ${_h#shared/} does not resolve the visited repo" "$_D2" "$_r"
done
assert_status 1 "E-223.14g: no cwd-relative helper chain survives in src/bin/ai" \
  bash -c "sed 's/[[:space:]]*#.*\$//' '$AI_BIN' | grep -qE 'for (c|candidate) in \"?(src|scripts)/'"
assert_status 0 "E-223.14h: helper lookups share one function" \
  bash -c "test \$(grep -c '_rein_helper ' '$AI_BIN') -ge 8"
rm -rf "$_D2"

# ── E-223.15: the bootstrap guard means "my source SUCCEEDED" ───────────────
# `declare -f rein_locate` asks whether a NAME is defined. bash imports exported
# functions from the environment at startup, so an inherited `rein_locate` satisfies it,
# the safe inline fallback is never installed, and the attacker's function IS the
# resolver — reachable whenever shared/locate.sh is absent, which is precisely the
# degraded install the fallback exists to cover.
_SB3="$(mktemp -d)"; mkdir -p "$_SB3/home/.rein/shared"
sed -n '/^export REIN_LOCATE_UNTRUSTED_ENV=1/,/^fi$/p' "${REPO_ROOT}/hooks/pre-tool-use.sh" > "$_SB3/boot.sh"
grep -v '^unset -f rein_locate' "$_SB3/boot.sh" > "$_SB3/boot_unguarded.sh"
_forge_run() {  # <bootstrap> <present?>
  if [[ "$2" == yes ]]; then cp "$LOC_SH" "$_SB3/home/.rein/shared/locate.sh"
  else rm -f "$_SB3/home/.rein/shared/locate.sh"; fi
  HOME="$_SB3/home" bash -c '
    rein_locate() { printf "%s" "FORGED-RESOLVER-USED"; }
    export -f rein_locate
    bash -c "source "'"$1"'" >/dev/null 2>&1; rein_locate mcp/safe-exec-mcp/index.js"' 2>/dev/null
}
assert_not_contains "E-223.15a: a forged resolver is inert when locate.sh is missing" \
  "FORGED-RESOLVER-USED" "$(_forge_run "$_SB3/boot.sh" no)"
assert_not_contains "E-223.15b: and when it is present" \
  "FORGED-RESOLVER-USED" "$(_forge_run "$_SB3/boot.sh" yes)"
# Non-vacuity: the same bootstrap WITHOUT the guard must fail, or the assertion above is
# testing nothing. A guard whose removal changes no outcome is not a guard.
assert_contains "E-223.15c: without the guard the forged resolver IS used (non-vacuity)" \
  "FORGED-RESOLVER-USED" "$(_forge_run "$_SB3/boot_unguarded.sh" no)"
assert_status 0 "E-223.15d: all five hooks and src/bin/ai carry the guard" \
  bash -c "c=0; for h in pre-tool-use session-start pre-commit post-tool-use stop-hook; do
             grep -q 'unset -f rein_locate' '${REPO_ROOT}/hooks/'\$h'.sh' && c=\$((c+1)); done
           grep -q 'unset -f rein_locate' '$AI_BIN' && c=\$((c+1)); test \$c -eq 6"
rm -rf "$_SB3"

# ── E-223.7: hooks stay fail-open when the resolver is missing ──────────────
# A hook that aborts because a helper moved is worse than a degraded gate.
_out="$(printf '{"tool_name":"Bash","tool_input":{"command":"echo hi"}}' | \
  REIN_HOME="$(mktemp -d)" bash "${REPO_ROOT}/hooks/post-tool-use.sh" 2>&1; echo "rc=$?")"
assert_contains "E-223.07a: post-tool-use survives an empty install root" "rc=0" "$_out"
assert_status 0 "E-223.07b: every hook defines the fail-open fallback" \
  bash -c "for h in pre-tool-use session-start pre-commit post-tool-use stop-hook; do
             grep -q 'declare -f rein_locate' '${REPO_ROOT}/hooks/'\$h'.sh' || exit 1; done"

rm -rf "$_D"
assert_summary
