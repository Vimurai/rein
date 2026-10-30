#!/usr/bin/env bash
# mcp_role_interceptors_test.sh — the patch servers' role interceptors (E-143, §35 ANTI-DRIFT)
# and their server-side caller-role derivation (E-219, D-056 R1; T-PATCHMCP-001). Was e143_test
# (renamed for the behaviour, D-088) and absorbs caller_role_test (E-301).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "── Suite: mcp_role_interceptors_test (E-143, E-219) ─────────────────"

PATCH_MCP="${REPO_ROOT}/src/mcp/patch-mcp/index.js"
PROPOSE_MCP="${REPO_ROOT}/src/mcp/propose-patch-mcp/index.js"
GUARDIAN_MCP="${REPO_ROOT}/src/mcp/context-guardian-mcp/index.js"

assert_exists "$PATCH_MCP"
assert_exists "$PROPOSE_MCP"
assert_exists "$GUARDIAN_MCP"

PATCH_SRC="$(cat "$PATCH_MCP")"
# E-219 (D-056 R1): role derivation and the .ai//plans/ scope moved OUT of each server into one shared module, so the scope assertions follow it.
CALLER_ROLE_SRC="${REPO_ROOT}/src/mcp/shared/caller-role.mjs"
PROPOSE_SRC="$(cat "$PROPOSE_MCP")"
GUARDIAN_SRC="$(cat "$GUARDIAN_MCP")"

# ── patch-mcp: roleGuard present ──────────────────────────────────────────────
assert_contains "patch-mcp: roleGuard function defined" "roleGuard" "$PATCH_SRC"
assert_contains "patch-mcp: ANTI_DRIFT_VIOLATION error present" "ANTI_DRIFT_VIOLATION" "$PATCH_SRC"
assert_contains "patch-mcp: caller_role parameter in schema" "caller_role" "$PATCH_SRC"
assert_contains "patch-mcp: architect enum value in schema" '"architect"' "$PATCH_SRC"
assert_contains "patch-mcp: roleGuard called with args.caller_role" "roleGuard(args.caller_role" "$PATCH_SRC"

# ── patch-mcp: whitelist paths ────────────────────────────────────────────────
# E-219: there is no longer a quoted whitelist STRING to grep for — the scope is one
# regex in architect-writes.mjs, and caller-role delegates to the predicate built on it.
# Asserting the delegation is stronger than asserting a literal: a second hand-rolled
# prefix test would satisfy the old grep while reintroducing the symlink hole E-216 closed.
ARCH_WRITES_SRC="${REPO_ROOT}/src/mcp/safe-exec-mcp/architect-writes.mjs"
assert_status 0 "patch-mcp: .ai//plans/ scope defined once, as a regex" \
  grep -qE 'SAFE_ARCHITECT_PATH = /.*\.ai\|plans' "$ARCH_WRITES_SRC"
assert_status 0 "patch-mcp: the shared guard DELEGATES to that predicate (no second copy)" \
  grep -q 'architectPathVerdict(absPath, findProjectRootFrom(cwd))' "$CALLER_ROLE_SRC"

# ── propose-patch-mcp: roleGuard present ─────────────────────────────────────
assert_contains "propose-patch-mcp: roleGuard function defined" "roleGuard" "$PROPOSE_SRC"
assert_contains "propose-patch-mcp: ANTI_DRIFT_VIOLATION error present" "ANTI_DRIFT_VIOLATION" "$PROPOSE_SRC"
assert_contains "propose-patch-mcp: caller_role parameter in schema" "caller_role" "$PROPOSE_SRC"
assert_contains "propose-patch-mcp: roleGuard called at propose time" "roleGuard(args.caller_role" "$PROPOSE_SRC"
assert_contains "propose-patch-mcp: roleGuard called at confirm time (defense in depth)" "roleGuard(patch.caller_role" "$PROPOSE_SRC"
assert_contains "propose-patch-mcp: caller_role stored in patch object" "caller_role: args.caller_role" "$PROPOSE_SRC"

# ── context-guardian-mcp: check_role_access tool ─────────────────────────────
assert_contains "context-guardian-mcp: check_role_access tool registered" "check_role_access" "$GUARDIAN_SRC"
assert_contains "context-guardian-mcp: ANTI_DRIFT_VIOLATION in response" "ANTI_DRIFT_VIOLATION" "$GUARDIAN_SRC"
assert_contains "context-guardian-mcp: ALLOWED response for permitted paths" "ALLOWED" "$GUARDIAN_SRC"
assert_contains "context-guardian-mcp: engineer enum value" '"engineer"' "$GUARDIAN_SRC"
assert_contains "context-guardian-mcp: Pre-flight RBAC description" "Pre-flight RBAC check" "$GUARDIAN_SRC"

# ── functional: roleGuard logic ───────────────────────────────────────────────
if command -v node &>/dev/null; then
  # E-219: this previously embedded its own COPY of roleGuard and asserted that a
  # caller supplying NO role was allowed to write anywhere — so the suite certified the
  # exact default-open behaviour E-219 exists to remove, and it passed because it was
  # testing a copy rather than the shipped code. It now imports the real module.
# `mktemp <tmpl>` only substitutes X's at the END of the template on BSD/macOS, so a
# suffixed template like `/tmp/name_XXXXXX.mjs` is a FIXED, PREDICTABLE path — it does not
# randomise at all. Two concurrent runs collide (`mkstemp failed: File exists`) and the
# suite dies before its summary. A temp DIRECTORY plus a named file inside randomises on
# both BSD and GNU and keeps the extension, which node needs to pick the ESM loader.
  GUARD_DIR=$(mktemp -d); GUARD_SCRIPT="$GUARD_DIR/guard.mjs"
  cat > "$GUARD_SCRIPT" <<JSEOF
import { architectScopeGuard, _resetCallerRoleCache } from "file://${REPO_ROOT}/src/mcp/shared/caller-role.mjs";

const cwd = process.cwd();
const g = (role, p) => {
  _resetCallerRoleCache();
  return architectScopeGuard(role, p, cwd) === null ? "allow" : "block";
};

// With REIN_CALLER_ROLE=architect in the environment (set by the runner below), the
// derived role is architect regardless of what the caller volunteers.
const results = {
  srcBlocked:      g(undefined, cwd + "/src/mcp/foo.js"),
  aiAllowed:       g(undefined, cwd + "/.ai/TASKS.md"),
  plansAllowed:    g(undefined, cwd + "/plans/foo.md"),
  // THE REGRESSION: omitting the role no longer buys unrestricted access.
  omittedBlocked:  g(undefined, cwd + "/src/bin/rein"),
  // A volunteered engineer cannot lift the derived architect restriction.
  claimedEngineer: g("engineer", cwd + "/src/bin/rein"),
};

const ok =
  results.srcBlocked === "block" &&
  results.aiAllowed === "allow" &&
  results.plansAllowed === "allow" &&
  results.omittedBlocked === "block" &&
  results.claimedEngineer === "block";

process.stdout.write(ok ? "PASS" : "FAIL " + JSON.stringify(results));
JSEOF
  RESULT=$(REIN_CALLER_ROLE=architect CLAUDE_CODE_SESSION_ID= node "$GUARD_SCRIPT" 2>/dev/null || echo "error")
  rm -rf "$GUARD_DIR"
  if [[ "$RESULT" == "PASS" ]]; then
    _pass "E-143: shipped guard blocks src/ for architect, allows .ai//plans/, and an OMITTED role no longer allows (E-219)"
  else
    _fail "E-143: roleGuard logic incorrect (got: $RESULT)"
  fi
else
  _pass "E-143: roleGuard functional test skipped (node unavailable)"
fi

# ── syntax checks ─────────────────────────────────────────────────────────────
assert_status 0 "patch-mcp: syntax OK after E-143 changes" \
  node --check "$PATCH_MCP"

assert_status 0 "propose-patch-mcp: syntax OK after E-143 changes" \
  node --check "$PROPOSE_MCP"

assert_status 0 "context-guardian-mcp: syntax OK after E-143 changes" \
  node --check "$GUARDIAN_MCP"

# ── E-219 (from caller_role — E-301): server-side caller-role derivation ──────
# Closes THREAT_MODEL T-PATCHMCP-001. patch-mcp and propose-patch-mcp each carried a
# self-declared guard that returned ALLOW whenever the caller simply omitted `caller_role` —
# so an unidentified client could write anywhere. Every case drives the REAL server over stdio
# JSON-RPC in a disposable project: a static grep cannot tell whether the guard refuses a write.
DRIVER="${REPO_ROOT}/tests/lib/patch-mcp-driver.mjs"
SAFE_EXEC="${REPO_ROOT}/src/mcp/safe-exec-mcp/index.js"

# E-294 (D-087): the role is the HMAC-verified v2 token, minted from a launch record and bound
# to its session process — never an env var. Each case runs the driver as a DIRECT child of a
# real session process (tests/lib/as-session.sh), so the patch server it spawns has the token's
# pid as an ancestor (the --verify-role path). Throwaway HOME: nothing touches ~/.rein (rule 6).
# The session starts in the SAME project the driver's patch server runs in (_P): the verifier
# re-walks from the server's cwd, and a live record for another project is the union.
_H="$(test_tmpdir crhome)"; mkdir -p "${_H}/.rein"
tc_fixture_home "$_H"   # E-345 (D-109 r1): the toolchain record the install writes
_P="$(test_tmpdir crproj)"; mkdir -p "${_P}/.ai" "${_P}/src"
_AS="${REPO_ROOT}/tests/lib/as-session.sh"
_N=0

_drive() {  # <target> <json-args-extra> <env assignments...> → allow | BLOCK | error (no session)
  local target="$1" extra="$2"; shift 2
  ( cd "$_P" && env HOME="$_H" "$@" node --no-warnings "$DRIVER" "$target" "$extra" "$_P" 2>/dev/null )
}
_drive_as() {  # <architect|engineer|none> <target> <json-args-extra> <env...> → as a real session
  local role="$1" target="$2" extra="$3" sid; shift 3
  _N=$((_N + 1)); sid="e219s-${role}-${_N}"
  ( cd "$_P" && HOME="$_H" bash "$_AS" "$role" "$sid" -- \
      env CLAUDE_CODE_SESSION_ID="$sid" "$@" node --no-warnings "$DRIVER" "$target" "$extra" "$_P" 2>/dev/null )
}

# ── E-219.1: the verified session record is authoritative ──────────────────
assert_contains "E-219.01a: verified ENGINEER record may write src/" "allow" \
  "$(_drive_as engineer src '{}')"
assert_contains "E-219.01b: verified ARCHITECT record may NOT write src/" "BLOCK" \
  "$(_drive_as architect src '{}')"
assert_contains "E-219.01c: verified ARCHITECT record may write .ai/" "allow" \
  "$(_drive_as architect ai '{}')"
assert_contains "E-294.01d: a plain launch (no record → engineer, launch unverified) may write src/" "allow" \
  "$(_drive_as none src '{}')"

# ── E-219.2 → E-294 (D-087 r3): the spawn env is NOT evidence any more ─────
# Was: "env engineer (no record) may write src/". A project's settings `env` reaches the
# server, so the env branch is removed: with no verified token the default is architect.
assert_contains "E-294.02a: env REIN_CALLER_ROLE=engineer with no token no longer lifts the default" "BLOCK" \
  "$(_drive src '{}' CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE=engineer)"
assert_contains "E-219.02b: env architect (no record) may NOT write src/" "BLOCK" \
  "$(_drive src '{}' CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE=architect)"
assert_contains "E-294.02c: env REIN_CALLER_ROLE=engineer does not lift a verified ARCHITECT token" "BLOCK" \
  "$(_drive_as architect src '{}' REIN_CALLER_ROLE=engineer REIN_PANE_ROLE=engineer)"

# ── E-219.3: NO evidence → architect (fail closed) ─────────────────────────
# THE REGRESSION THIS TASK EXISTS FOR: omitting caller_role used to mean "unrestricted".
assert_contains "E-219.03a: no record and no env → src/ is BLOCKED" "BLOCK" \
  "$(_drive src '{}' CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE=)"
assert_contains "E-219.03b: no record and no env → .ai/ is still allowed" "allow" \
  "$(_drive ai '{}' CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE=)"

# ── E-294.03c: a session id borrowed from ANOTHER live session verifies nothing ──
# The token is bound to its session process; a caller that is not its descendant presenting
# the same CLAUDE_CODE_SESSION_ID gets the fail-closed default (the id is a selector).
_BSID="e219s-borrowed"; _BSTOP="${_H}/borrowed.stop"
( cd "$_P" && HOME="$_H" bash "$_AS" engineer "$_BSID" -- \
    bash -c 'i=0; while [ ! -e "$1" ] && [ -d "${1%/*}" ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done' _ "$_BSTOP" ) >/dev/null 2>&1 &   # REIN_SLEEP_ALLOWED: keep-alive loop of a child session shell (no assert.sh there); ends on the stop file
_BPID=$!
on_exit "touch '${_BSTOP}'; wait_for '! kill -0 ${_BPID} 2>/dev/null' 3000 100 2>/dev/null; kill ${_BPID} 2>/dev/null || true"
wait_for "[ -e \"${_H}/.rein/run/role-${_BSID}.lock\" ]" 10000 100 || true
assert_status 0 "E-294.03c0: the other session's engineer token exists while it runs (fixture)" \
  test -f "${_H}/.rein/run/role-${_BSID}.lock"
assert_contains "E-294.03c: borrowing a live ENGINEER session's id from outside it → src/ BLOCKED" "BLOCK" \
  "$(_drive src '{}' CLAUDE_CODE_SESSION_ID="$_BSID")"
touch "$_BSTOP"; wait "$_BPID" 2>/dev/null || true

# ── E-219.4: a volunteered role may RESTRICT, never LIFT ───────────────────
assert_contains "E-219.04a: claiming engineer against an ARCHITECT record is ignored" "BLOCK" \
  "$(_drive_as architect src '{"caller_role":"engineer"}')"
assert_contains "E-219.04b: claiming architect against an ENGINEER record self-restricts" "BLOCK" \
  "$(_drive_as engineer src '{"caller_role":"architect"}')"
assert_contains "E-219.04c: claiming engineer with no evidence does not lift the default" "BLOCK" \
  "$(_drive src '{"caller_role":"engineer"}' CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE=)"

# ── E-219.5: symlink / hardlink — the F1 regression ────────────────────────
# `.ai/link -> ../src/x` is a symlink the Architect may legitimately create INSIDE its
# own scope. A prefix test on the path allows a write straight through it, which is the
# normalise-only check E-216 spent seven rounds replacing. The guard must delegate to
# architectPathVerdict rather than hand-roll a second predicate.
assert_contains "E-219.05a: a symlink in .ai/ pointing at src/ is BLOCKED" "BLOCK" \
  "$(_drive_as architect symlink '{}')"
assert_contains "E-219.05b: a hardlink in .ai/ aliasing src/ is BLOCKED" "BLOCK" \
  "$(_drive_as architect hardlink '{}')"
assert_contains "E-219.05c: an ordinary .ai/ file is unaffected by those checks" "allow" \
  "$(_drive_as architect ai '{}')"
assert_contains "E-219.05d: the ENGINEER may still write through the same symlink" "allow" \
  "$(_drive_as engineer symlink '{}')"

# ── E-219.6 → E-294 (D-084 r1, D-087 r3): the env rollback is REMOVED ──────
# Was: "REIN_SOVEREIGNTY_LOCK=0 restores the omitted-role allow". The lock variable is gone
# everywhere; the operator's lift is the time-boxed override file.
assert_contains "E-294.06a: REIN_SOVEREIGNTY_LOCK=0 no longer restores the omitted-role allow" "BLOCK" \
  "$(_drive src '{}' CLAUDE_CODE_SESSION_ID= REIN_CALLER_ROLE= REIN_SOVEREIGNTY_LOCK=0)"
assert_contains "E-219.06b: a VOLUNTEERED architect outside scope is still blocked with the var set" "BLOCK" \
  "$(_drive src '{"caller_role":"architect"}' CLAUDE_CODE_SESSION_ID= REIN_SOVEREIGNTY_LOCK=0)"
assert_contains "E-294.06c: REIN_SOVEREIGNTY_LOCK=0 does not lift a verified ARCHITECT token" "BLOCK" \
  "$(_drive_as architect src '{}' REIN_SOVEREIGNTY_LOCK=0)"

# ── E-219.7: structure — one rule, one implementation ──────────────────────
CALLER_ROLE="${REPO_ROOT}/src/mcp/shared/caller-role.mjs"
assert_status 0 "E-219.07a: the scope check delegates to architectPathVerdict" \
  grep -q 'architectPathVerdict(absPath, findProjectRootFrom(cwd))' "$CALLER_ROLE"
# Root resolution must match the other gates: this project has a documented MCP rooting
# trap where a server's cwd is not the project root, so passing the raw cwd would let
# the two gates agree on the RULE while disagreeing on where the root is.
assert_status 0 "E-219.07a2: and resolves the project root the same way safe-exec does" \
  grep -q 'findProjectRootFrom' "$CALLER_ROLE"
assert_status 0 "E-219.07a3: the scope check fails closed on a predicate error" \
  grep -q 'return false;' "$CALLER_ROLE"
assert_status 1 "E-219.07b: no hand-rolled prefix test remains" \
  bash -c "grep -q 'rel.startsWith(\".ai/\")' '$CALLER_ROLE'"
# safe-exec must be located relative to THIS MODULE: a cwd-relative candidate meant any
# project containing src/mcp/safe-exec-mcp/index.js got it EXECUTED, and its stdout is
# trusted to name a role.
assert_status 0 "E-219.07c: safe-exec is located via import.meta.url, not the cwd" \
  grep -q 'new URL("../safe-exec-mcp/index.js", import.meta.url)' "$CALLER_ROLE"
assert_status 1 "E-219.07d: no cwd-relative safe-exec candidate remains" \
  bash -c "grep -q 'join(cwd, \"src\", \"mcp\", \"safe-exec-mcp\"' '$CALLER_ROLE'"
# Both servers must delegate — a divergent copy is how this class returns.
for _srv in patch-mcp propose-patch-mcp; do
  assert_status 0 "E-219.07g [$_srv]: delegates to the shared guard" \
    grep -q 'architectScopeGuard' "${REPO_ROOT}/src/mcp/${_srv}/index.js"
done

assert_status 1 "E-294.07h: caller-role.mjs reads no role or lock environment variable" \
  grep -qE 'process\.env\.REIN_(CALLER_ROLE|PANE_ROLE|SOVEREIGNTY_LOCK)' "$CALLER_ROLE"

assert_summary
