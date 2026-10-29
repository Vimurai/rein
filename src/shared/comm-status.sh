# shellcheck shell=bash
# src/shared/comm-status.sh — is .ai/COMM.md tracked and committed? (E-338, D-104 r4)
#
# One probe for the three detectors D-104 ruling 4 names: `ai doctor`, the ai-preflight
# injection line and the Stop hook. Sourced, never executed; it defines one function and
# changes nothing.
#
#   ai_os_comm_status [root]   → prints exactly one of
#       tracked            committed and clean
#       IGNORED            a .gitignore rule matches it (checked with --no-index, so a rule
#                          still counts when the file is already tracked)
#       UNCOMMITTED <n>    <n> lines not in HEAD (untracked: the whole file)
#       absent             no .ai/COMM.md yet
#       nogit              root is not inside a git work tree
#
# DATA on stdout, no state in the caller (D-064 §2), always returns 0.

ai_os_comm_status() {
  local root="${1:-.}" f=".ai/COMM.md" n
  git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo nogit; return 0; }
  if git -C "$root" check-ignore -q --no-index -- "$f" 2>/dev/null; then
    echo IGNORED; return 0
  fi
  [[ -f "${root%/}/${f}" ]] || { echo absent; return 0; }
  if [[ -z "$(git -C "$root" status --porcelain -- "$f" 2>/dev/null)" ]]; then
    echo tracked; return 0
  fi
  if git -C "$root" ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then
    n="$(git -C "$root" diff --numstat HEAD -- "$f" 2>/dev/null | cut -f1)"
  else
    n="$(wc -l < "${root%/}/${f}" | tr -d ' ')"
  fi
  echo "UNCOMMITTED ${n:-0}"
  return 0
}
