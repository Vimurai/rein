#!/usr/bin/env bash
# as-session.sh — run a command as a child of a real AI-OS SESSION PROCESS (E-294, D-087).
#
#   bash tests/lib/as-session.sh <architect|engineer|none> <session_id> -- <command...>
#
# Since E-294 the gate's role has no environment input: it is the HMAC-verified token, minted
# from the launch records on the process chain and bound to the session process (in production
# the claude process; here, THIS script's process). So a fixture that wants a role does what
# production does instead of exporting a variable:
#   1. <architect|engineer>: write a launch record for this pid (src/shared/launch-record.py —
#      the cwd must be inside an AI-OS project, i.e. under a directory holding .ai/);
#      `none` writes no record — the plain-launch default, engineer / launch: unverified;
#   2. mint <session_id>'s token bound to this pid (safe-exec --mint-token, no role in argv);
#   3. run <command> as a DIRECT CHILD, with this script's stdin (a hook's JSON event) — so a hook's own PPID is this pid (the --session-pid hot
#      path) and any deeper process has it as an ancestor (the --verify-role path);
#   4. remove the record and the token, so the next call with the same id starts clean.
# Everything lives under $HOME/.ai-os: run it with a throwaway HOME (rule 6).
# Exit: the command's status; 97 when the record or the mint failed (never a silent no-role).
set -uo pipefail
_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_repo="$(cd "${_here}/../.." && pwd)"
role="${1:-}"; sid="${2:-}"; shift 2 || { echo "usage: as-session.sh <role|none> <sid> -- <cmd...>" >&2; exit 2; }
[[ "${1:-}" == "--" ]] && shift
case "$role" in architect|engineer|none) ;; *) echo "as-session.sh: bad role '${role}'" >&2; exit 2 ;; esac

_lr="${_repo}/src/shared/launch-record.py"
_se="${_repo}/src/mcp/safe-exec-mcp/index.js"
if [[ "$role" != "none" ]]; then
  python3 -I "$_lr" write "$$" "$role" </dev/null >/dev/null || { echo "as-session.sh: launch record not written" >&2; exit 97; }
fi
_minted="$(node --no-warnings "$_se" --mint-token "$sid" "$$" </dev/null 2>/dev/null)"
if [[ -z "$_minted" ]]; then
  echo "as-session.sh: token for '${sid}' not minted" >&2
  rm -f "${HOME}/.ai-os/run/launch/$$.json"
  exit 97
fi

"$@"
rc=$?
rm -f "${HOME}/.ai-os/run/launch/$$.json" "${HOME}/.ai-os/run/role-${sid}.lock"
exit "$rc"
