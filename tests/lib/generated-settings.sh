#!/usr/bin/env bash
# generated-settings.sh — E-290 (D-083 r2): .claude/settings.json is GENERATED and gitignored.
#
# It carries install-time absolute exec-form hook paths, so it is machine-specific and no
# longer committed — a suite that read "${REPO_ROOT}/.claude/settings.json" now reads a file
# that does not exist in an `ai ci run` worktree (and silently skipped or passed vacuously).
# Suites that assert what the settings CONTAIN generate it the way production does: the
# real `ai sync` of this checkout, in a fresh fixture project.
#
#   gen_project_settings <dir>  → creates a minimal AI-OS project under <dir>, runs
#                                 `ai sync`, prints the path of the generated settings file
#                                 (empty output + status 1 if generation failed).

_GS_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

gen_project_settings() {
  local d="$1"
  mkdir -p "$d/.ai"
  [[ -f "$d/.ai/roles.json" ]] || printf '%s\n' \
    '{ "roles": { "architect": {"provider":"claude","pane_identifier":"1","model":"fable"},' \
    '             "engineer":  {"provider":"claude","pane_identifier":"0","model":"opus"} } }' > "$d/.ai/roles.json"
  ( cd "$d" && AI_OS_DISABLE_REPO_MAP=1 bash "${_GS_REPO}/src/bin/ai" sync >/dev/null 2>&1 )
  [[ -f "$d/.claude/settings.json" ]] || return 1
  printf '%s' "$d/.claude/settings.json"
}
