# shellcheck shell=bash
# src/shared/gate-probe.sh — the ONE safe-exec analyzer invocation (E-339, D-107 r3)
#
# Sourced by hooks/pre-tool-use.sh (install mirror only, E-223) and, through src/bin/ai, by
# the `gate_check` sync step and `ai doctor`. The hook and the probe call the analyzer the
# same way — interpreter, wall clock, flags, verdict parse — so a probe that says PASS means
# the gate the hook runs has a verdict, and the two cannot drift apart. Before this file the
# hook held the only copy and a sync could leave it broken while reporting "13 ok".
#
#   rein_gate_bounded_node <args…>        node under a 10 s wall clock (perl alarm)
#   rein_gate_analyze <se> <cmd> [flags…]  report on stdout, the analyzer's rc (142 → 4)
#   rein_gate_analyze_path <se> <path> [flags…]   the same for --check-path
#   rein_gate_has_verdict <report>         0 when the report carries a `Verdict:` line
#   rein_gate_probe                        runs `true` through the mirror's analyzer;
#                                           prints PASS, or the reason there is no verdict
#
# DATA on stdout and the status as the return code; no state is set in the caller (D-064 §2).
# Stderr of the analyzer is the caller's: the hook discards it, the probe reports it.

# E-292 (D-082 r2): the analyzer's wall clock. safe-exec arms its own 10 s timer (exit 4), but
# a timer only fires while the event loop is free — a catastrophic regex or a synchronous
# wait never yields, so the timer would not fire and Claude Code's 30 s hook timeout (which
# does NOT block) would win. perl's alarm survives exec and kills node from outside: SIGALRM
# = rc 142, reported as rc 4 (TIMEOUT). Without /usr/bin/perl the in-process timer remains.
# perl can only exec a FILE, and after the pin `node` is a shell function — so the analyzer
# is named by its absolute path (the pin's record, else a PATH search on the fixed PATH).
# The hook's prologue drops PERL* (PERL5OPT/PERL5LIB would load a project's code into the gate).
rein_gate_bounded_node() {
  local n="${REIN_TC_NODE:-}"
  [[ -n "$n" ]] || n="$(type -P node 2>/dev/null || true)"
  [[ -n "$n" ]] || return 127
  if [[ -x /usr/bin/perl ]]; then /usr/bin/perl -e 'alarm 10; exec @ARGV or exit 127' "$n" "$@"
  else "$n" "$@"; fi
}

rein_gate_analyze() {
  local se="$1" cmd="$2" rc=0
  shift 2
  rein_gate_bounded_node --no-warnings "$se" --check "$cmd" "$@" || rc=$?
  [[ "$rc" -eq 142 ]] && rc=4   # the wall clock fired = TIMEOUT (no verdict)
  return "$rc"
}

rein_gate_analyze_path() {
  local se="$1" path="$2" rc=0
  shift 2
  rein_gate_bounded_node --no-warnings "$se" --check-path "$path" "$@" || rc=$?
  [[ "$rc" -eq 142 ]] && rc=4
  return "$rc"
}

# rc 0 with no `Verdict:` line is no verdict either (critic_security P2, E-289): an index.js
# older than E-125 has no --check mode, starts its stdio server on a drained stdin, exits 0.
rein_gate_has_verdict() { [[ "$1" == *"Verdict:"* ]]; }

rein_gate_probe() {
  local se report rc=0 errf err
  se="$(rein_locate mcp/safe-exec-mcp/index.js 2>/dev/null || true)"
  [[ -n "$se" ]] || { echo "safe-exec analyzer not installed (mcp/safe-exec-mcp/index.js)"; return 1; }
  errf="$(mktemp "${TMPDIR:-/tmp}/ai-gate-probe.XXXXXX")" || { echo "cannot create a temp file"; return 1; }
  report="$(rein_gate_analyze "$se" true 2>"$errf")" || rc=$?
  err="$(grep -v '^[[:space:]]*$' "$errf" 2>/dev/null | tail -1 | cut -c1-200)"
  rm -f "$errf"
  if [[ "$rc" -eq 0 ]] && rein_gate_has_verdict "$report"; then
    echo PASS; return 0
  fi
  case "$rc" in
    0)   echo "safe-exec exited 0 without a verdict" ;;
    4)   echo "safe-exec timed out (no verdict within 10 s)" ;;
    127) echo "node not found for the analyzer" ;;
    *)   echo "safe-exec exited ${rc}${err:+: ${err}}" ;;
  esac
  return 1
}
