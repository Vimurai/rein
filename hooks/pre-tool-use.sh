#!/usr/bin/env bash
# pre-tool-use.sh — the seatbelt (E-463, D-169 r2/r5, lean-core.md §Component 2).
# Runs every Bash tool call through mcp/safe-exec-mcp/seatbelt.mjs, which asks the operator
# (`permissionDecision: "ask"`) on a recursive rm of home, root or the project root, a download
# piped into a shell, or a secret in the command. ADVICE, not a security boundary: the role
# sandbox is the boundary (docs/role-sandbox.md). Contract: FAIL-OPEN — every path exits 0, and
# stdout carries only the seatbelt's answer. The waiting signal is its own hook
# (waiting-signal.sh, the rein plugin's PreToolUse entry for AskUserQuestion|ExitPlanMode).
# Installed to ~/.rein/hooks/pre-tool-use.sh and declared by the rein plugin.

# E-292: the hook's ONLY EXIT trap; an abort still exits 0 (fail-open).
trap '_rein_rc=$?; trap - EXIT; exit 0' EXIT

# E-286: a project's settings `env` reaches this process — drop what steers an interpreter and
# fix PATH before any external command, then load the install's toolchain pin.
unset -f $(compgen -A function) 2>/dev/null
for _v in $(compgen -e); do
  case "$_v" in NODE_*|PYTHON*|PERL*|DYLD_*|LD_*|REIN_TC_*|BASH_ENV|ENV|CDPATH|GLOBIGNORE|POSIXLY_CORRECT|BASH_COMPAT) unset "$_v" ;; esac
done
PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
for _p in "${HOME}/.rein/shared/toolchain-pin.sh" "${_here}/../src/shared/toolchain-pin.sh"; do
  [[ -f "$_p" ]] && { . "$_p"; break; }
done

# E-223: install mirror first, this script's own tree second — never the visited repo.
_sb=""
for _c in "${HOME}/.rein/mcp/safe-exec-mcp/seatbelt.mjs" "${_here}/../src/mcp/safe-exec-mcp/seatbelt.mjs"; do
  [[ -f "$_c" ]] && { _sb="$_c"; break; }
done
[[ -n "$_sb" ]] && command -v node >/dev/null 2>&1 || exit 0

node --no-warnings "$_sb" 2>/dev/null
exit 0
