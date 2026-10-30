#!/usr/bin/env bash
# toolchain-pin.sh — E-286 (D-078, D-081, sovereignty-hardening.md §Hook Toolchain Pinning,
# THREAT_MODEL T-HOOKENV-001): the PIN half. Sourced by every hook right after its inline
# prologue (which drops inherited functions and interpreter-steering variables and sets a
# fixed system PATH), before the hook runs any external command.
#
# It reads ~/.rein/shared/toolchain.sh — PARSED line by line against a strict pattern,
# never sourced, so the file can only ever set the four REIN_TC_* values — and:
#   - recorded node AND python3 executable → PATH=<node dir>:<python3 dir>:/usr/bin:/bin:/usr/sbin:/sbin
#   - file missing, partial, or an interpreter gone (nvm/brew upgrade) → the fixed fallback
#     PATH, REIN_TC_STALE=1, and the missing interpreter resolved from that fallback only.
# Either way the inherited PATH is never consulted. `node` and `python3` then become shell
# functions that call the ABSOLUTE recorded path (`python3 -I`: isolated mode ignores
# PYTHON* variables and keeps the project's cwd off sys.path — a repo-supplied json.py
# replaced the pre-tool-use parser before this). With no interpreter, no function is
# defined, so the hooks' existing `command -v node` branches see it as absent.
#
# STATED RESIDUAL until E-290 (D-081 ruling 1): BASH_ENV, exported functions (which can
# shadow `unset` itself), SHELLOPTS/PS4 and a decoy `bash` act before or around this file;
# only `/bin/bash -p` on the hook command line closes them. The prologue's unsets are
# best-effort defence in depth.

REIN_TC_FALLBACK_PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"

_rein_tc_load() {
  local file="${HOME}/.rein/shared/toolchain.sh" line key val
  local re='^(REIN_TC_NODE|REIN_TC_PYTHON3|REIN_TC_NICE|REIN_TC_RECORDED)=([A-Za-z0-9._/@+:-]+)$'
  REIN_TC_NODE=""; REIN_TC_PYTHON3=""; REIN_TC_NICE=""; REIN_TC_RECORDED=""; REIN_TC_STALE=0
  if [[ -f "$file" && ! -L "$file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ "$line" =~ $re ]] || continue
      key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
      case "$key" in
        REIN_TC_NODE)     REIN_TC_NODE="$val" ;;
        REIN_TC_PYTHON3)  REIN_TC_PYTHON3="$val" ;;
        REIN_TC_NICE)     REIN_TC_NICE="$val" ;;
        REIN_TC_RECORDED) REIN_TC_RECORDED="$val" ;;
      esac
    done < "$file"
  fi
  # A recorded value must still be an absolute, executable file; anything else is stale.
  [[ "$REIN_TC_NODE" == /* && -f "$REIN_TC_NODE" && -x "$REIN_TC_NODE" ]] || { REIN_TC_NODE=""; REIN_TC_STALE=1; }
  [[ "$REIN_TC_PYTHON3" == /* && -f "$REIN_TC_PYTHON3" && -x "$REIN_TC_PYTHON3" ]] || { REIN_TC_PYTHON3=""; REIN_TC_STALE=1; }
  [[ "$REIN_TC_NICE" == /* && -x "$REIN_TC_NICE" ]] || REIN_TC_NICE=""

  if [[ "$REIN_TC_STALE" -eq 0 ]]; then
    PATH="${REIN_TC_NODE%/*}:${REIN_TC_PYTHON3%/*}:/usr/bin:/bin:/usr/sbin:/sbin"
  else
    PATH="$REIN_TC_FALLBACK_PATH"
    # Resolve what is missing from the FIXED fallback only — never the inherited PATH.
    local d
    for d in /usr/bin /bin /usr/local/bin /opt/homebrew/bin; do
      [[ -z "$REIN_TC_NODE" && -x "${d}/node" ]] && REIN_TC_NODE="${d}/node"
      [[ -z "$REIN_TC_PYTHON3" && -x "${d}/python3" ]] && REIN_TC_PYTHON3="${d}/python3"
    done
  fi
  [[ -n "$REIN_TC_NICE" ]] || { [[ -x /usr/bin/nice ]] && REIN_TC_NICE=/usr/bin/nice; }
  export PATH
}

_rein_tc_load

if [[ -n "$REIN_TC_NODE" ]]; then node() { "$REIN_TC_NODE" "$@"; }; fi
if [[ -n "$REIN_TC_PYTHON3" ]]; then python3() { "$REIN_TC_PYTHON3" -I "$@"; }; fi

# rein_tc_missing → the first interpreter a fail-closed gate cannot run, or nothing.
rein_tc_missing() {
  [[ -n "$REIN_TC_NODE" ]] || { printf 'node'; return 0; }
  [[ -n "$REIN_TC_PYTHON3" ]] || { printf 'python3'; return 0; }
  return 1
}

# rein_hook_incident <hook> <rc> <line> — E-292 (D-082 r2): a FAIL-OPEN hook that aborted on
# its own bug still exits 0 but leaves ONE incident record (~/.rein/incidents.ndjson via
# incident-append.mjs). Fixed fields only — never the payload, the command or stderr. Detached
# with every stream closed, so neither the hook's latency budget nor Claude Code's wait on the
# hook's pipes is touched. The tracker's env opt-out is dropped for this one write: a project's
# settings `env` reaches hooks and must not be able to hide a hook's own failure.
rein_hook_incident() {
  [[ -n "$REIN_TC_NODE" && "$1" =~ ^[a-z-]+$ && "$2" =~ ^[0-9]+$ && "$3" =~ ^[0-9]+$ ]] || return 0
  # Install-first like rein_locate; a hook that aborts BEFORE sourcing locate.sh (most source
  # it after this pin) still reaches the install mirror.
  local w=""
  declare -f rein_locate >/dev/null 2>&1 && w="$(rein_locate shared/incident-append.mjs 2>/dev/null)"
  [[ -n "$w" ]] || w="${HOME}/.rein/shared/incident-append.mjs"
  [[ -f "$w" ]] || return 0
  ( unset AI_INCIDENT_TRACKER_DISABLE INCIDENT_ROTATE_LINES
    exec "$REIN_TC_NODE" "$w" "{\"incident_type\":\"HOOK_ABORT\",\"message\":\"${1} aborted (rc ${2} near line ${3})\",\"stack_signature\":\"hooks/${1}.sh:${3}\",\"source_agent\":\"Claude\"}"
  ) </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
  return 0
}

# The repair-command exemption is NOT here: it lives inline in hooks/pre-tool-use.sh
# (D-082 ruling 3) so it still works when this file is unreachable.
