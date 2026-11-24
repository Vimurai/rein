#!/usr/bin/env bash
# Rein waiting signal — E-433 (D-160; .ai/blueprints/release-artifact.md §Component 7).
# Sets and clears the tmux pane options an app reads to know this pane's agent is waiting on
# the operator (@rein_signals, @rein_waiting, @rein_waiting_since). Registered by `rein sync`
# on PermissionRequest, Notification, PreToolUse (AskUserQuestion|ExitPlanMode), PostToolUse,
# PostToolUseFailure, UserPromptSubmit, Stop, SessionStart, SessionEnd and PermissionDenied.
# Contract: FAIL-OPEN. Prints NOTHING on stdout and exits 0 on every path — on PermissionRequest
# and PreToolUse a printed decision would answer the prompt, and this hook never has one.
# Installed to ~/.rein/hooks/waiting-signal.sh

# ── E-292 (D-082 r2): the hook's ONLY EXIT trap; an abort still exits 0 (fail-open) ──
trap '_rein_rc=$?; trap - EXIT; case "$_rein_rc:$BASH_COMMAND" in 0:*) exit "$_rein_rc" ;; esac; rein_hook_incident waiting-signal "$_rein_rc" "$LINENO" >/dev/null 2>&1; exit 0' EXIT

# Builtins only until the toolchain pin: read the payload and, on the per-tool-call events
# (PostToolUse, PostToolUseFailure), leave at once when no wait is recorded for any pane — that
# path then costs a bash start. Stop, UserPromptSubmit and PermissionDenied always take the full
# path: they fire once per turn, and the id files are keyed by pane digits, which two tmux
# servers can share — so a turn's end clears its own pane whatever the files say (bound 2;
# security review 878445a P3-1). TMUX and TMUX_PANE are never read: the pane and server come from
# the launch record (D-160 addendum 2, T-WAITSIG-001).
INPUT=""
IFS= read -r -d '' INPUT || true
# The key must occur exactly once (17 = its quoted length): a nested copy inside tool_input
# cannot steer this shortcut; with two, the full parse below decides.
_k="${INPUT//\"hook_event_name\"/}"
if (( ${#INPUT} - ${#_k} == 17 )) \
   && [[ "$INPUT" =~ \"hook_event_name\"[[:space:]]*:[[:space:]]*\"(PostToolUse|PostToolUseFailure)\" ]]; then
  _any=0
  for _f in "${HOME}/.rein/run/waiting/"*; do [[ -e "$_f" || -L "$_f" ]] && { _any=1; break; }; done
  [[ "$_any" -eq 1 ]] || exit 0
fi

# ── E-286 (D-078/D-081, T-HOOKENV-001): toolchain pin before any external command ──
unset -f $(compgen -A function) 2>/dev/null
for _v in $(compgen -e); do
  case "$_v" in NODE_*|PYTHON*|PERL*|DYLD_*|LD_*|REIN_TC_*|BASH_ENV|ENV|CDPATH|GLOBIGNORE|POSIXLY_CORRECT|BASH_COMPAT) unset "$_v" ;; esac
done
PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
_sd="${BASH_SOURCE[0]%/*}"   # this script's own directory (builtin; no dirname before the pin)
_tree="${_sd%/*}"            # its tree: hooks/ sits beside src/ in a clone and the mirror
for _p in "${HOME}/.rein/shared/toolchain-pin.sh" "${_tree}/src/shared/toolchain-pin.sh"; do
  [[ -f "$_p" ]] && { . "$_p"; break; }
done
unset _v _p

# ── E-223: the helper comes from the install mirror, else this script's own tree — never the
# visited repo. No rein_locate: it can run git, and this path must stay short.
_WS=""
for _p in "${HOME}/.rein/shared/waiting-signal.sh" "${_tree}/src/shared/waiting-signal.sh"; do
  [[ -f "$_p" ]] && { _WS="$_p"; break; }
done
[[ -n "$_WS" ]] || exit 0
. "$_WS"

# The session's tmux target from its launch record (D-160 addendum 2): no record, or one
# without a socket, means this session does not report.
command -v python3 >/dev/null 2>&1 || exit 0
_LR=""
for _p in "${HOME}/.rein/shared/launch-record.py" "${_tree}/src/shared/launch-record.py"; do
  [[ -f "$_p" ]] && { _LR="$_p"; break; }
done
[[ -n "$_LR" ]] || exit 0
_T="$(python3 -I "$_LR" tmux-target 2>/dev/null)" || exit 0
IFS=$'\t' read -r REIN_WS_SOCKET REIN_WS_PANE <<< "$_T"
[[ "$REIN_WS_SOCKET" == /* && "$REIN_WS_PANE" =~ ^%[0-9]+$ ]] || exit 0

# Parse the payload once (python3, hooks contract). Only the event, the notification type, the
# tool name and the tool-use id are read; each is printed only when it is a plain identifier.
_F="$(printf '%s' "$INPUT" | python3 -I -c '
import json, re, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(d, dict):
    sys.exit(0)
ok = re.compile(r"[A-Za-z0-9_-]{1,128}")
out = []
for k in ("hook_event_name", "notification_type", "tool_name", "tool_use_id"):
    v = d.get(k)
    out.append(v if isinstance(v, str) and ok.fullmatch(v) else "")
print("\x1f".join(out))
' 2>/dev/null)" || exit 0
[[ -n "$_F" ]] || exit 0
IFS=$'\x1f' read -r _EV _NT _TOOL _ID <<< "$_F"   # \x1f: not IFS whitespace, so an empty field keeps its place
rein_ws_dispatch "$_EV" "$_NT" "$_TOOL" "$_ID" >/dev/null 2>&1
exit 0
