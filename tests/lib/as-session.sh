#!/usr/bin/env bash
# as-session.sh — run a command as a child of a real Rein SESSION PROCESS (E-294, D-087, E-463).
#
#   bash tests/lib/as-session.sh <architect|engineer|none> <session_id> -- <command...>
#
# The role has no environment input: it is the most restricted launch record on the process
# chain (src/shared/launch-record.py). So a fixture that wants a role does what `rein pane` does
# instead of exporting a variable:
#   1. <architect|engineer>: write a launch record for this pid (the cwd must be inside a Rein
#      project, i.e. under a directory holding .ai/); `none` writes no record — the plain-launch
#      default, engineer / launch: unverified;
#   2. run <command> as a DIRECT CHILD, with this script's stdin (a hook's JSON event), so any
#      process it starts has this pid as an ancestor;
#   3. remove the record, so the next call starts clean.
# <session_id> is exported as CLAUDE_CODE_SESSION_ID (a selector only; no role comes from it).
# Everything lives under $HOME/.rein: run it with a throwaway HOME (rule 6).
# Exit: the command's status; 97 when the record could not be written (never a silent no-role).
set -uo pipefail
_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_repo="$(cd "${_here}/../.." && pwd)"
role="${1:-}"; sid="${2:-}"; shift 2 || { echo "usage: as-session.sh <role|none> <sid> -- <cmd...>" >&2; exit 2; }
[[ "${1:-}" == "--" ]] && shift
case "$role" in architect|engineer|none) ;; *) echo "as-session.sh: bad role '${role}'" >&2; exit 2 ;; esac

_lr="${_repo}/src/shared/launch-record.py"
if [[ "$role" != "none" ]]; then
  python3 -I "$_lr" write "$$" "$role" </dev/null >/dev/null || { echo "as-session.sh: launch record not written" >&2; exit 97; }
fi

CLAUDE_CODE_SESSION_ID="$sid" "$@"
rc=$?
rm -f "${HOME}/.rein/run/launch/$$.json"
exit "$rc"
