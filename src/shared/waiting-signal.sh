# waiting-signal.sh — E-433 (D-160; .ai/blueprints/release-artifact.md §Component 7).
# Sourced by hooks/waiting-signal.sh. The ONLY place that calls `tmux` for the pane options an
# app reads to know a pane's agent is waiting on the operator:
#   @rein_signals        "waiting" while a reporting session runs (SessionStart → SessionEnd)
#   @rein_waiting        "permission" | "question" while a prompt is open
#   @rein_waiting_since  epoch seconds of that set
# Values are literals from the closed lists below, never text from a hook payload.
# tests/fixtures/release/pane-options.json pins the names and values; a row fails when a list
# here holds a value the fixture does not.
#
# Fail-open: every function returns 0 and prints nothing on stdout. No recorded socket, a
# recorded pane that is not `%<digits>`, or no tmux → nothing is done.
#
# The socket and pane come from the session's launch record (D-160 addendum 2): the hook sets
# REIN_WS_SOCKET and REIN_WS_PANE from `launch-record.py tmux-target` AFTER sourcing this file.
# They start empty here, so an inherited environment value never counts, and $TMUX / $TMUX_PANE
# are never read (a client pointed at a foreign server can be made to execute — T-WAITSIG-001).
#
# The waiting call's id (the payload's tool_use_id, when the event carries one) is kept in a
# per-pane file under ~/.rein/run/waiting/, so a PostToolUse with no wait pending decides with a
# file test and never starts tmux, and a sibling call finishing does not clear a prompt still
# open (an id that differs is not the waiting call). The file never reaches the tmux server.

REIN_WS_SIGNALS=(waiting)
REIN_WS_VALUES=(permission question)
REIN_WS_OPTIONS=(@rein_signals @rein_waiting @rein_waiting_since)
REIN_WS_SOCKET=""
REIN_WS_PANE=""

# The tmux binary, resolved once per process (sets REIN_WS_TMUX; a plain command, never inside
# `$(…)` — D-064 §2). The ONE place the binary is looked up (D-160 addendum 1): the installer's
# record REIN_TC_TMUX in ~/.rein/shared/toolchain.sh — parsed, never sourced, used only when it
# is an absolute path to an executable regular file — else the hook's pinned PATH. Never $TMUX.
REIN_WS_TMUX=""
rein_ws_resolve() {
  [[ -n "$REIN_WS_TMUX" ]] && return 0
  local rec="${HOME}/.rein/shared/toolchain.sh" line t=""
  local re='^REIN_TC_TMUX=(/[A-Za-z0-9._/@+:-]+)$'
  if [[ -f "$rec" && ! -L "$rec" ]]; then   # a symlinked record is refused, as toolchain-pin.sh does
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ "$line" =~ $re ]] && t="${BASH_REMATCH[1]}"
    done < "$rec"
  fi
  if [[ -n "$t" ]]; then
    [[ -f "$t" && -x "$t" ]] && REIN_WS_TMUX="$t"
    return 0   # a recorded tmux that is not executable is no tmux: no fallback past the record
  fi
  REIN_WS_TMUX="$(command -v tmux 2>/dev/null)" || REIN_WS_TMUX=""
  return 0
}

rein_ws_pane() {   # → the validated pane id on stdout, or return 1 (needs rein_ws_resolve first)
  [[ "$REIN_WS_SOCKET" == /* && "$REIN_WS_PANE" =~ ^%[0-9]+$ && -n "$REIN_WS_TMUX" ]] || return 1
  printf '%s' "$REIN_WS_PANE"
}

rein_ws_state_file() {   # <pane> → the id file path, per tmux server AND pane
  # E-436 (D-160 addendum 3, F2): pane ids are per server, so the name carries the recorded
  # socket too — characters outside [A-Za-z0-9._-] become `_`, the last 200 kept (NAME_MAX).
  local s="${REIN_WS_SOCKET//[^A-Za-z0-9._-]/_}"
  (( ${#s} > 200 )) && s="${s: -200}"
  printf '%s/.rein/run/waiting/%s_%s' "${HOME}" "$s" "${1#%}"
}

rein_ws_listed() {   # <value> <list...> → 0 when value is in the list
  local v="$1" x; shift
  for x in "$@"; do [[ "$x" == "$v" ]] && return 0; done
  return 1
}

rein_ws_set() {   # <permission|question> [<tool_use_id>]
  local kind="$1" id="${2:-}" pane f
  rein_ws_listed "$kind" "${REIN_WS_VALUES[@]}" || return 0
  pane="$(rein_ws_pane)" || return 0
  [[ "$id" =~ ^[A-Za-z0-9_-]{1,128}$ ]] || id=""
  f="$(rein_ws_state_file "$pane")"
  # Temp file + rename: a rename replaces a planted symlink or FIFO, never writes through it.
  # The option is set only once the file is there, so no clear can miss a set (bound 2).
  local tmp=""
  # Never create ~/.rein/run itself: the launch-record discipline requires it 0700, and a run/
  # made here at the umask would turn every session's role walk into the union (D-087).
  [[ -d "${f%/*/*}" && ! -L "${f%/*/*}" ]] || return 0
  [[ -d "${f%/*}" ]] || mkdir -m 700 "${f%/*}" 2>/dev/null || return 0
  tmp="$(mktemp "${f%/*}/.w.XXXXXX" 2>/dev/null)" || return 0
  { printf '%s\n' "$id" > "$tmp" && mv -f "$tmp" "$f"; } 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 0; }
  "$REIN_WS_TMUX" -S "$REIN_WS_SOCKET" set-option -p -t "$pane" @rein_waiting "$kind" \; \
       set-option -p -t "$pane" @rein_waiting_since "$(date +%s)" >/dev/null 2>&1
  return 0
}

rein_ws_backstop() {   # <permission|question> — the Notification row: set only when no wait is
  # recorded, so the first set's time and id survive (bound 1: a 7 s prompt is set).
  local pane
  pane="$(rein_ws_pane)" || return 0
  [[ -e "$(rein_ws_state_file "$pane")" ]] && return 0
  rein_ws_set "$1"
}

rein_ws_clear() {   # [<tool_use_id>] — with an id, clears only when it is the waiting call's
  local id="${1:-}" pane f want=""
  pane="$(rein_ws_pane)" || return 0
  f="$(rein_ws_state_file "$pane")"
  if [[ -n "$id" ]]; then
    [[ -e "$f" || -L "$f" ]] || return 0
    # Read only a regular file that is not a link: a planted FIFO would block the hook.
    [[ -f "$f" && ! -L "$f" ]] && IFS= read -r want < "$f" 2>/dev/null
    [[ -n "$want" && "$want" != "$id" ]] && return 0
  fi
  rm -f "$f" 2>/dev/null
  "$REIN_WS_TMUX" -S "$REIN_WS_SOCKET" set-option -pu -t "$pane" @rein_waiting \; \
       set-option -pu -t "$pane" @rein_waiting_since >/dev/null 2>&1
  return 0
}

rein_ws_signals() {   # on|off — @rein_signals for the session's lifetime
  local pane
  pane="$(rein_ws_pane)" || return 0
  if [[ "$1" == "on" ]]; then
    "$REIN_WS_TMUX" -S "$REIN_WS_SOCKET" set-option -p -t "$pane" @rein_signals "${REIN_WS_SIGNALS[*]}" >/dev/null 2>&1
  else
    "$REIN_WS_TMUX" -S "$REIN_WS_SOCKET" set-option -pu -t "$pane" @rein_signals >/dev/null 2>&1
  fi
  return 0
}

# The Component 7 event table. <event> <notification_type> <tool_name> <tool_use_id>
rein_ws_dispatch() {
  local ev="$1" nt="${2:-}" tool="${3:-}" id="${4:-}"
  rein_ws_resolve
  case "$ev" in
    PermissionRequest) rein_ws_set permission "$id" ;;
    Notification)
      case "$nt" in
        permission_prompt)  rein_ws_backstop permission ;;
        elicitation_dialog) rein_ws_backstop question ;;
      esac ;;
    PreToolUse)
      case "$tool" in AskUserQuestion|ExitPlanMode) rein_ws_set question "$id" ;; esac ;;
    # E-436 (F1): a denial clears by id like PostToolUse — the classifier denying a sibling or
    # subagent call must not clear a prompt that is still open.
    PostToolUse|PostToolUseFailure|PermissionDenied) rein_ws_clear "$id" ;;
    UserPromptSubmit|Stop) rein_ws_clear ;;
    SessionStart) rein_ws_clear; rein_ws_signals on ;;
    SessionEnd)   rein_ws_clear; rein_ws_signals off ;;
  esac
  return 0
}
