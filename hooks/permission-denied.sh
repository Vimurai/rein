#!/usr/bin/env bash
# Rein PermissionDenied — REJECTED telemetry for built-in tools (E-284, D-075 §Component 5)
# Claude Code fires PermissionDenied when a tool call is denied by a permission rule, the
# auto-mode classifier or the user. That denial never reaches PostToolUse, so before E-284
# a denied Bash/Write/Edit call left no telemetry at all. This hook books exactly one
# `REJECTED` row with `source=hook` per denied BUILT-IN tool call. `mcp__*` tools are
# skipped: the global interceptor (E-153) already books their rejections server-side, and
# counting them here would double them.
# Contract (hooks.md): the event cannot block (exit 2 is not honoured) — this hook is
# FAIL-OPEN, always exits 0, and returns in well under 20 ms because the parse and the
# write run in a detached background subshell. tool_input is NEVER forwarded.
# Installed to ~/.rein/hooks/permission-denied.sh

# ── E-292 (D-082 r2): a FAIL-OPEN hook that aborts on its own bug still exits 0 ──────
# (it never blocks the session) but leaves ONE incident record via rein_hook_incident
# (src/shared/toolchain-pin.sh; absent before the pin loads → nothing recorded). Inline
# string on the first executable line, builtins only. A deliberate exit keeps its code.
# The hook's ONLY EXIT trap — a later one must chain to it.
trap '_rein_rc=$?; trap - EXIT; case "$_rein_rc:$BASH_COMMAND" in 0:*) exit "$_rein_rc" ;; esac; rein_hook_incident permission-denied "$_rein_rc" "$LINENO" >/dev/null 2>&1; exit 0' EXIT
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
# Exported so a child process — a `rein` subcommand spawned from this hook — inherits
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

# Everything after the stdin read runs DETACHED, the helper lookup included: inside a git
# checkout rein_locate runs `git rev-parse` and a package.json parse, which alone took the
# foreground past the 20 ms budget.
{
  (
    TELEMETRY_HELPER="$(rein_locate shared/telemetry.mjs || true)"
    if [[ -n "$TELEMETRY_HELPER" ]] && command -v node >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
      TELEMETRY_JSON="$(HOOK_INPUT="$INPUT" python3 - <<'PY' 2>/dev/null
import json, os, sys
try:
    d = json.loads(os.environ.get("HOOK_INPUT", ""))
except Exception:
    sys.exit(0)
tool_name = d.get("tool_name") or ""
if not tool_name or tool_name.startswith("mcp__"):
    sys.exit(0)
print(json.dumps({"tool_name": tool_name, "execution_time_ms": 0,
                  "status": "REJECTED", "source": "hook"}))
PY
)"
      [[ -n "$TELEMETRY_JSON" ]] \
        && echo "$TELEMETRY_JSON" | node "$TELEMETRY_HELPER" --record-tool
    fi
  ) >/dev/null 2>&1 &
  disown 2>/dev/null || true
} 2>/dev/null
exit 0
