#!/usr/bin/env bash
# Rein PostToolUse — Automatic Quality Gate (AQG) + Universal Telemetry (E-105)
# 1. AQG: intercepts Write/Edit on src/** and runs tests/run.sh. Exits 1
#    with [LOCKED - AQG FAILED] if tests fail, blocking the agent.
# 2. Telemetry: pipes every tool execution to telemetry.mjs --record-tool
#    in a backgrounded, fail-open path so 100% of invocations land in
#    ~/.rein/telemetry.sqlite (per .ai/blueprints/universal-telemetry.md).
# Installed to ~/.rein/hooks/post-tool-use.sh

# ── E-292 (D-082 r2): a FAIL-OPEN hook that aborts on its own bug still exits 0 ──────
# (it never blocks the session) but leaves ONE incident record via rein_hook_incident
# (src/shared/toolchain-pin.sh; absent before the pin loads → nothing recorded). Inline
# string on the first executable line, builtins only. A deliberate exit keeps its code (post-tool-use: `exit 1` is the deliberate test-failure lock).
# The hook's ONLY EXIT trap — a later one must chain to it.
trap '_rein_rc=$?; trap - EXIT; case "$_rein_rc:$BASH_COMMAND" in 0:*|1:exit|1:exit[[:space:]]*) exit "$_rein_rc" ;; esac; rein_hook_incident post-tool-use "$_rein_rc" "$LINENO" >/dev/null 2>&1; exit 0' EXIT
# ── E-286 (D-078/D-081, T-HOOKENV-001): toolchain pin — FIRST, before any external command.
# A project's settings `env` reaches this process. Drop inherited functions and the
# variables that steer an interpreter, fix PATH, then load the pin (install mirror first,
# this script's own tree second — never the visited repo). Since E-290 the hooks run as
# exec-form `/bin/bash -p` (no BASH_ENV, no imported functions, no SHELLOPTS); these unsets
# remain for what -p leaves alone (CDPATH, GLOBIGNORE, POSIXLY_CORRECT, BASH_COMPAT, interpreter
# variables). See src/shared/toolchain-pin.sh.
unset -f $(compgen -A function) 2>/dev/null
for _v in $(compgen -e); do
  case "$_v" in NODE_*|PYTHON*|PERL*|DYLD_*|LD_*|REIN_TC_*|BASH_ENV|ENV|CDPATH|GLOBIGNORE|POSIXLY_CORRECT|BASH_COMPAT) unset "$_v" ;; esac
done
PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
for _p in "${HOME}/.rein/shared/toolchain-pin.sh" "${BASH_SOURCE[0]%/*}/../src/shared/toolchain-pin.sh"; do
  [[ -f "$_p" ]] && { . "$_p"; break; }
done
unset _v _p

# ── E-223 (D-057 §3): install-first helper resolution ────────────────────────
# The locators below used to start at "$(git rev-parse --show-toplevel)/src/...", which
# names the USER's repository, not the Rein install. Any project containing
# src/mcp/safe-exec-mcp/index.js had THAT file executed by node from inside this hook,
# with its stdout trusted to decide whether a write is allowed — cloning a repo was
# enough to run its code and disable the gate meant to stop it.
#
# Bootstrapping the shared resolver must not repeat the mistake, so it is install-mirror
# first and script-relative second — never the visited repo.
# The env here may have been chosen by the repo we are visiting (a project's
# .claude/settings.json `env` block is inherited by hooks), so REIN_HOME is NOT read:
# pointing it at a decoy made this bootstrap SOURCE the decoy's own locate.sh, i.e.
# arbitrary shell inside a fail-closed gate. Assigned here, in the hook's own text, so it
# overrides anything inherited.
# Exported so a child process — an `ai` subcommand spawned from this hook — inherits
# the same judgement rather than defaulting back to trusting the environment.
export REIN_LOCATE_UNTRUSTED_ENV=1
_REIN_HOME_DIR="${HOME}/.rein"
# The guard below asks `declare -f rein_locate`, which means "is a name defined", NOT
# "did my source succeed". bash imports exported functions from the environment at
# startup, so an inherited `rein_locate` satisfies it, the safe inline fallback is never
# installed, and the attacker's function IS the resolver — reachable whenever
# shared/locate.sh is absent, i.e. exactly the degraded install the fallback exists for.
unset -f rein_locate rein_locate_enable_dev_tree rein_is_framework_clone 2>/dev/null || true
for _l in "${_REIN_HOME_DIR}/shared/locate.sh" \
          "$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/../src/shared/locate.sh"; do
  [[ -f "$_l" ]] && { . "$_l"; break; }
done
# Fail-open: these hooks must still run without the resolver (a missing helper is a
# degraded gate, an aborted hook is a broken session). The fallback is the install
# mirror alone — it never falls back to the visited repo.
if ! declare -f rein_locate >/dev/null 2>&1; then
  rein_locate() { local _c="${_REIN_HOME_DIR}/${1}"; [[ -f "$_c" ]] && { printf '%s' "$_c"; return 0; }; return 1; }
fi

INPUT=$(cat)

# ── Universal Telemetry (E-105) ──────────────────────────────────────────────
# Background-record every tool execution. Resolution is install-first via rein_locate
# (E-223): the ~/.rein mirror, with the dev tree consulted only inside the framework
# clone. The order used to be the reverse — ${PROJECT_ROOT}/src/... first — which meant
# any visited repo could supply this helper.
# Fail-open: all errors swallowed. <50ms synchronous hook budget preserved by
# putting BOTH the python schema-translation AND the node write inside the
# detached subshell — only the cheap helper-locator runs on the hot path.
{
  TELEMETRY_HELPER=""
  TELEMETRY_HELPER="$(rein_locate shared/telemetry.mjs || true)"
  if [[ -n "$TELEMETRY_HELPER" ]] && command -v node >/dev/null 2>&1; then
    (
      # Translate Claude Code PostToolUse schema → blueprint flat schema
      # ({tool_name, execution_time_ms, status}). tool_input/tool_response
      # bodies are NEVER forwarded — only the three privacy-safe fields
      # the CLI persists.
      TELEMETRY_JSON="$(HOOK_INPUT="$INPUT" python3 - <<'PY' 2>/dev/null
import json, os, sys
try:
    d = json.loads(os.environ.get("HOOK_INPUT", ""))
except Exception:
    sys.exit(0)
tool_name = d.get("tool_name") or ""
if not tool_name:
    sys.exit(0)
# E-154 (telemetry-hardening.md): MCP tools (mcp__<server>__<tool>) are now recorded
# SERVER-SIDE by the global telemetry interceptor (E-153, src/shared/mcp-telemetry.mjs)
# with accurate SUCCESS/ERROR status. Skip them here so a single MCP call is counted ONCE.
# The hook remains the sole recorder for harness built-ins (Bash/Read/Edit/...). Trade-off:
# third-party MCP servers we cannot instrument (filesystem/memory/...) lose hook telemetry —
# an accepted gap (we cannot instrument code we do not own; they are rarely used).
if tool_name.startswith("mcp__"):
    sys.exit(0)
tr = d.get("tool_response") or {}
status = "ERROR" if tr.get("isError") else "SUCCESS"
exec_ms = tr.get("duration_ms")
if not isinstance(exec_ms, (int, float)):
    exec_ms = 0
print(json.dumps({
    "tool_name": tool_name,
    "execution_time_ms": int(exec_ms),
    "status": status,
    "source": "hook",  # E-261: the emitting path, so hook and interceptor latency never mix
}))
PY
)"
      [[ -n "$TELEMETRY_JSON" ]] \
        && echo "$TELEMETRY_JSON" | node "$TELEMETRY_HELPER" --record-tool
    ) >/dev/null 2>&1 &
    disown 2>/dev/null || true
  fi
} 2>/dev/null

# ── Task velocity from the transcript (E-259, D-077) ─────────────────────────
# On a SUCCESSFUL update_task_status(DONE), measure the task's window of the Claude Code
# transcript (src/shared/task-usage.mjs) and write one task_velocity row. Every other tool
# call pays one string comparison. Detached and fail-open: a telemetry failure never blocks
# a DONE. The reader is located install-first (a cloned repo never supplies it), and the
# payload goes to it on STDIN — argv is visible in `ps` (security_engineer E-259 P1).
# The success check, the transcript-path confinement and the task-id validation all run in
# the reader; this branch only selects the event and forwards three fields.
# Rollback: REIN_TASK_USAGE=0. AI_TELEMETRY_DISABLE=1 also turns it off.
if [[ "$INPUT" == *'mcp__task-synchronizer-mcp__update_task_status'* \
      && "${REIN_TASK_USAGE:-1}" != "0" && "${AI_TELEMETRY_DISABLE:-0}" != "1" ]]; then
  {
    TASK_USAGE_HELPER="$(rein_locate shared/task-usage.mjs || true)"
    if [[ -n "$TASK_USAGE_HELPER" ]] && command -v node >/dev/null 2>&1; then
      (
        TU_JSON="$(HOOK_INPUT="$INPUT" python3 - <<'PY' 2>/dev/null
import json, os, sys
try:
    d = json.loads(os.environ.get("HOOK_INPUT", ""))
except Exception:
    sys.exit(0)
if d.get("tool_name") != "mcp__task-synchronizer-mcp__update_task_status":
    sys.exit(0)
inp = d.get("tool_input") or {}
if inp.get("status") != "DONE" or not isinstance(inp.get("id"), str):
    sys.exit(0)
tp = d.get("transcript_path")
if not isinstance(tp, str) or not tp:
    sys.exit(0)
print(json.dumps({"transcript_path": tp, "task_id": inp["id"],
                  "tool_response": d.get("tool_response")}))
PY
)"
        [[ -n "$TU_JSON" ]] && printf '%s' "$TU_JSON" | "${REIN_TC_NICE:-nice}" -n 10 "${REIN_TC_NODE:-node}" "$TASK_USAGE_HELPER" --record
      ) >/dev/null 2>&1 &
      disown 2>/dev/null || true
    fi
  } 2>/dev/null
fi

# ── Context-cache rebuild (E-112, caching.md §3.1) ───────────────────────────
# When a blueprint or architect.md is written/edited, rebuild the cache-manager
# System Context cache. This is the blueprint's "post-write hook" trigger — the
# cache rebuilds ONLY when its source files change, not on every tool. Detached
# + fail-open: never blocks the hook. Rollback: REIN_DISABLE_CACHE=1.
{
  CACHE_TRIGGER="$(HOOK_INPUT="$INPUT" python3 - <<'PY' 2>/dev/null
import json, os, sys
try:
    d = json.loads(os.environ.get("HOOK_INPUT", ""))
except Exception:
    sys.exit(0)
if d.get("tool_name") not in ("Write", "Edit"):
    sys.exit(0)
inp = (d.get("tool_input") or {})
fp = inp.get("file_path") or inp.get("path") or ""
if not fp:
    sys.exit(0)
n = "/" + os.path.normpath(fp).replace("\\", "/").lstrip("/")
if "/.ai/blueprints/" in n or n.endswith("/.ai/architect.md"):
    print("REBUILD")
PY
)"
  if [[ "$CACHE_TRIGGER" == "REBUILD" && "${REIN_DISABLE_CACHE:-}" != "1" ]]; then
    CACHE_SERVER=""
    CACHE_SERVER="$(rein_locate mcp/cache-manager-mcp/index.js || true)"
    if [[ -n "$CACHE_SERVER" ]] && command -v node >/dev/null 2>&1; then
      ( node "$CACHE_SERVER" --build >/dev/null 2>&1 ) &
      disown 2>/dev/null || true
    fi
  fi
} 2>/dev/null


# Detect if the modified file is under src/ — pass via env var to avoid injection
RESULT=$(HOOK_INPUT="$INPUT" python3 - <<'PY'
import json, sys, os

try:
    data = json.loads(os.environ.get("HOOK_INPUT", ""))
except Exception:
    sys.exit(0)

tool = data.get("tool_name", "")
inp  = data.get("tool_input", {})

if tool not in ("Write", "Edit"):
    sys.exit(0)

file_path = inp.get("file_path") or inp.get("path") or ""
if not file_path:
    sys.exit(0)

norm = os.path.normpath(os.path.abspath(file_path))
cwd  = os.path.normpath(os.getcwd())
rel  = os.path.relpath(norm, cwd)

if rel.startswith("src" + os.sep) or rel == "src":
    print("RUN_TESTS|" + rel)
PY
)

[[ -z "$RESULT" ]] && exit 0

FILE_REL="${RESULT#*|}"

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
TEST_RUNNER="${PROJECT_ROOT}/tests/run.sh"

[[ -f "$TEST_RUNNER" ]] || exit 0  # No test runner — skip silently

if bash "$TEST_RUNNER" >/dev/null 2>&1; then
  exit 0
else
  echo "[LOCKED - AQG FAILED] Tests failed after editing ${FILE_REL} — fix before proceeding."
  echo "Run: bash tests/run.sh"
  exit 1
fi
