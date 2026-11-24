#!/usr/bin/env bash
# generated-settings.sh — E-290 (D-083 r2): .claude/settings.json is GENERATED and gitignored.
#
# It carries install-time absolute exec-form hook paths, so it is machine-specific and no
# longer committed — a suite that read "${REPO_ROOT}/.claude/settings.json" now reads a file
# that does not exist in a `rein ci run` worktree (and silently skipped or passed vacuously).
# Suites that assert what the settings CONTAIN generate it the way production does: the
# real `rein sync` of this checkout, in a fresh fixture project.
#
#   gen_project_settings <dir>  → creates a minimal Rein project under <dir>, runs
#                                 `rein sync`, prints the path of the generated settings file
#                                 (empty output + status 1 if generation failed).

#
# D-172 r22: `rein sync` writes the role settings under ~/.rein/roles/, so the sync runs under a
# scratch Rein home built from this checkout (gen_rein_home), never the operator's ~/.rein.

_GS_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
declare -F tc_link_shared >/dev/null || source "${_GS_REPO}/tests/lib/toolchain-fixture.sh"

# gen_rein_home <home> → a scratch HOME whose ~/.rein is this checkout's install layout, linked
# (shared/ through tc_link_shared; hooks/ a real directory of COPIES: doctor and sync judge a hook
# by its real path, which must stay inside the scratch home). Idempotent.
gen_rein_home() {
  local h="$1" e
  tc_link_shared "$h"
  for e in bin claude config contracts copilot mcp templates; do
    [[ -e "$h/.rein/$e" ]] || ln -s "${_GS_REPO}/src/$e" "$h/.rein/$e"
  done
  mkdir -p "$h/.rein/hooks"
  for e in "${_GS_REPO}"/hooks/*; do [[ -e "$h/.rein/hooks/${e##*/}" ]] || cp -p "$e" "$h/.rein/hooks/${e##*/}"; done
  [[ -e "$h/.rein/scripts" ]] || ln -s "${_GS_REPO}/scripts" "$h/.rein/scripts"
}

gen_project_settings() {
  local d="$1"
  mkdir -p "$d/.ai"
  [[ -f "$d/.ai/roles.json" ]] || printf '%s\n' \
    '{ "roles": { "architect": {"provider":"claude","pane_identifier":"1","model":"fable"},' \
    '             "engineer":  {"provider":"claude","pane_identifier":"0","model":"opus"} } }' > "$d/.ai/roles.json"
  local h="${d%/}.home"
  gen_rein_home "$h"
  ( cd "$d" && HOME="$h" bash "${_GS_REPO}/src/bin/rein" sync >/dev/null 2>&1 )
  [[ -f "$d/.claude/settings.json" ]] || return 1
  printf '%s' "$d/.claude/settings.json"
}
