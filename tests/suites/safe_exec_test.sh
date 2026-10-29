#!/usr/bin/env bash
# safe_exec_test.sh — the safe-exec CLI and advisory-tool boundaries (E-44; slimmed by E-301, D-088).
#
# The rule verdicts are contract tables run IN PROCESS by their unit runners (tests/unit/*-cases
# and operand-scope.test.mjs): block-rules (the test_pattern rows that asserted a pasted regex,
# SUDO_SU, E-125, E-287.04), operand-scope (E-102 / E-123 sovereignty), secret (E-287.01-03),
# pipe-shell (E-291.PS1), gate-relative-home (E-294.RH1), gate-self-disable (E-291.05f/g) and
# arch-write. This suite keeps what only a process can show: each table's spawn path, probed
# once — one BLOCK and one pass row through the real `--check` CLI under a live session — and
# the advisory tool's stdio wiring. It is the ONLY bash suite that names a table path (the fast
# tier selects on that reference).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
source "${SCRIPT_DIR}/../lib/mcp-client.sh"

echo "── Suite: safe_exec_test ────────────────────────────────────────────"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SE_SERVER="${REPO_ROOT}/src/mcp/safe-exec-mcp/index.js"

# ── The spawn path, once per table ────────────────────────────────────────────
# E-294 (D-087): the gate's role is the session token's — each probe runs as a direct child of
# tests/lib/as-session.sh in a throwaway HOME (rule 6), as the hook does.
_SE_HOME="$(test_tmpdir sehome)"; mkdir -p "${_SE_HOME}/.rein"
tc_fixture_home "$_SE_HOME"   # E-345 (D-109 r1): the toolchain record the hooks pin
_probe() {  # <table> <role> <label>
  local out rc=0
  out="$(cd "$REPO_ROOT" && HOME="$_SE_HOME" node --no-warnings "${REPO_ROOT}/tests/lib/table-probe.mjs" \
    "$REPO_ROOT" "${REPO_ROOT}/tests/fixtures/$1" "$2" "se-probe-$2" 2>&1)" || rc=$?
  printf '%s\n' "$out" | sed 's/^/    /'
  assert_status 0 "$3: $1 — one BLOCK and one pass row agree through the real --check CLI (${2})" test "$rc" -eq 0
}
_probe block-rules-cases.json engineer "E-44"
_probe secret-cases.json engineer "E-287.01"
_probe pipe-shell-cases.json engineer "E-291.PS1"
_probe gate-relative-home-cases.json engineer "E-294.RH1"
_probe gate-self-disable-cases.json engineer "E-291.05f"
_probe operand-scope-cases.json engineer "E-340"
_probe operand-scope-cases.json architect "E-102"
_probe arch-write-cases.json architect "E-216"

# ── The advisory tool (analyze_command over stdio) ────────────────────────────
# verdict <command> <caller_role|""> → prints content[0].text of analyze_command
verdict() {
  local cmd="$1" role="$2" payload
  if [[ -n "$role" ]]; then
    payload="$(CMD="$cmd" ROLE="$role" python3 -c 'import json,os; print(json.dumps({"command":os.environ["CMD"],"caller_role":os.environ["ROLE"]}))')"
  else
    payload="$(CMD="$cmd" python3 -c 'import json,os; print(json.dumps({"command":os.environ["CMD"]}))')"
  fi
  mcp_call_tool "${SE_SERVER}" analyze_command "$payload" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
c=d.get("content",[{}]); print(c[0].get("text","") if c else "")'
}
unset REIN_SOVEREIGNTY_LOCK REIN_CALLER_ROLE 2>/dev/null || true

# caller_role is optional — a single-argument call still PASSes a clean command
assert_contains "E-102: command-only call still works" "PASS" "$(verdict 'ls -la' '')"

# E-294 (D-084 r1, D-087 r3): the REIN_SOVEREIGNTY_LOCK=0 rollback is REMOVED — a project's
# settings `env` could set it. With it exported, the Architect blocks still apply.
assert_contains "E-294: REIN_SOVEREIGNTY_LOCK=0 no longer lifts sovereignty" \
  "[SOVEREIGNTY_BLOCK]" "$(export REIN_SOVEREIGNTY_LOCK=0; verdict 'rm -rf src/build' architect)"
assert_contains "E-294: …nor the merge/deploy blocks" \
  "[SOVEREIGNTY_BLOCK]" "$(export REIN_SOVEREIGNTY_LOCK=0; verdict 'git push origin master' architect)"
assert_status 1 "E-294: no source file reads REIN_SOVEREIGNTY_LOCK" \
  grep -rqE 'REIN_SOVEREIGNTY_LOCK' "${REPO_ROOT}/src/mcp" "${REPO_ROOT}/src/shared" "${REPO_ROOT}/hooks" "${REPO_ROOT}/src/bin"

# E-294 (D-087 r3): the environment is not a role input anywhere in safe-exec. analyze_command is
# ADVISORY: it reports the rule set the caller's own caller_role names and reads no environment
# (the enforcing gate takes the role from the session token only).
assert_not_contains "E-294: env=architect does not change the advisory tool's answer" "[SOVEREIGNTY_BLOCK]" \
  "$(export REIN_CALLER_ROLE=architect; verdict 'git push origin main' engineer)"
assert_contains "E-294: …and env=engineer does not lift a caller_role=architect report" "[SOVEREIGNTY_BLOCK]" \
  "$(export REIN_CALLER_ROLE=engineer; verdict 'git push origin main' architect)"
assert_contains "E-127: caller_role arg honoured by the advisory tool" "[SOVEREIGNTY_BLOCK]" \
  "$(unset REIN_CALLER_ROLE; verdict 'git push origin main' architect)"
assert_status 1 "E-294: safe-exec reads no REIN_CALLER_ROLE / REIN_PANE_ROLE" \
  grep -qE 'process\.env\.REIN_(CALLER|PANE)_ROLE' "$SE_SERVER" "${REPO_ROOT}/src/mcp/safe-exec-mcp/role-token.mjs"
assert_status 0 "E-127: claude bootloader injects role=engineer" grep -qF 'env["REIN_CALLER_ROLE"] = "engineer"' "${REPO_ROOT}/src/bin/ai"
# E-254: the Architect is a Claude pane too — its role arrives via the per-role settings
# overlay (settings.<role>.json), which stamps the bound role name authoritatively.
assert_status 0 "E-127: role overlay injects the bound role (architect pane)" grep -qF 'env["REIN_CALLER_ROLE"] = role' "${REPO_ROOT}/src/bin/ai"

assert_summary
