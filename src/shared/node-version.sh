# shellcheck shell=bash
# src/shared/node-version.sh — is this Node new enough for Rein? (E-405, D-140 r8)
#
# One comparison for the installer's preflight and both `rein doctor` Node lines, so the
# floor cannot drift between them again (the installer said 22 while node:sqlite needs 22.5).
# Sourced, never executed; it defines one constant and one function and changes nothing.
#
#   REIN_NODE_FLOOR                 the minimum, as printed in messages ("22.5")
#   rein_node_supported <version>   → 0 when <version> (`v22.5.0` or `22.5.0`) is 22.5.0 or
#                                     newer: major 22 with minor ≥ 5, or major ≥ 23;
#                                     1 otherwise, including an empty or unparsable string.

REIN_NODE_FLOOR="22.5"

rein_node_supported() {
  local v="${1#v}" major minor
  major="${v%%.*}"
  minor="${v#*.}"; minor="${minor%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  (( 10#$major > 22 || (10#$major == 22 && 10#$minor >= 5) ))
}
