#!/usr/bin/env bash
# locate.sh — the ONE helper resolver (E-223, D-057 §3). Sourceable by the hooks and by
# `ai`; `locate.mjs` is its twin for node callers.
#
# WHY THIS EXISTS:
#   Every hook and half of `ai` carried its own locator chain shaped like
#       "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/src/mcp/<server>/index.js"
#   then the install mirror. `git rev-parse --show-toplevel` names the USER's repository,
#   not the AI-OS install. So any project that happened to contain
#   `src/mcp/safe-exec-mcp/index.js` had THAT file executed by node — inside a PreToolUse
#   hook, with its stdout trusted to decide whether a write is allowed. Cloning a repo was
#   enough to run its code and disable the gate that was supposed to stop it. Same shape as
#   E-219 F3, found again in E-220, and present at 8 sites across all six hooks.
#
# THE RULE (D-057 §3): resolve from the install mirror. The dev tree is consulted ONLY
# when the current repo IS the framework clone, because that is the one case where
# "the source next to me" and "the framework" are the same thing.
#
#   framework clone  → dev tree first, then install   (dogfooding: editing src/ takes effect)
#   anything else    → install mirror ONLY            (a downstream src/ is never executed)
#
# `AI_OS_LOCATE_DEV=1` forces dev-first for framework development from an unusual cwd.
#
# RESIDUAL, stated rather than hidden: the framework test falls back to the toplevel
# package.json `name`, so a repo that deliberately names itself the framework package can
# reach its own dev tree. `AIOS_WORKSPACE` is checked first precisely so that fallback is
# only reached when the install has no recorded workspace at all.

# ── TRUSTED vs UNTRUSTED ENVIRONMENT ─────────────────────────────────────────
# A caller sets AI_OS_LOCATE_UNTRUSTED_ENV=1 (as an assignment in its OWN script text, so
# it beats anything inherited) to say "the environment I am running in may have been
# chosen by the repository I am visiting". Every hook does.
#
# This exists because the first cut of E-223 was defeated by three env vars, all settable
# from a file the untrusted repo SHIPS: a project's `.claude/settings.json` carries an
# `env` block that the CLI applies to the session, and hooks inherit it. `ai init` writes
# that key, so it is the normal shape, not a suspicious one. Proven against the hooks:
#   AI_OS_LOCATE_DEV=1     → dev-first, no framework check at all → decoy executed
#   AIOS_WORKSPACE=<decoy> → the decoy reads as the framework clone → decoy executed
#   AI_OS_HOME=<decoy>     → the decoy's own locate.sh is SOURCED into the hook shell,
#                            which is arbitrary shell in a fail-closed gate process
# The third was strictly new exposure that E-223 itself introduced: the pre-E-223 hooks
# hardcoded ${HOME}/.ai-os and never read AI_OS_HOME. Cloning a repo was still enough —
# it just needed one more file in the clone.
#
# So under untrusted env: AI_OS_HOME, AIOS_WORKSPACE and AI_OS_LOCATE_DEV are ignored, and
# the workspace is read ONLY from the file the installer wrote. HOME itself is still
# honoured; that is pre-existing (the old hooks used ${HOME}/.ai-os too) and redirecting it
# breaks far more than this.
if [[ "${AI_OS_LOCATE_UNTRUSTED_ENV:-0}" == "1" ]]; then
  AI_OS_LOCATE_HOME="${HOME}/.ai-os"
else
  AI_OS_LOCATE_HOME="${AI_OS_HOME:-${HOME}/.ai-os}"
fi

# ── The dev-tree override is a FUNCTION, not a variable ──────────────────────
# Round 3 of the E-223 audit: I first implemented "argv-only" as another env var
# (`_AI_OS_LOCATE_DEV_ARGV`) that each caller promised to reset before reading argv. That
# is the same channel wearing a different name. `bin/ai` did reset it; the five hooks never
# mentioned it — so supplying it through a project's `.claude/settings.json` env block made
# a hook resolve the visited repo's own safe-exec analyzer AND the gate then allowed
# everything. The original vulnerability, restored in full by the fix for it.
#
# The invariant now lives here rather than in six callers. The state is reset
# UNCONDITIONALLY at source time, so no inherited value of any name survives, and the only
# way to turn it on is to CALL this function — which a settings.json cannot do.
_AI_OS_LOCATE_DEV_TREE=0

# Call AFTER parsing argv, only for an explicit user-supplied flag.
ai_os_locate_enable_dev_tree() { _AI_OS_LOCATE_DEV_TREE=1; }

# ai_os_is_framework_clone — 0 when the current git toplevel is the AI-OS framework clone.
ai_os_is_framework_clone() {
  local top; top="$(git rev-parse --show-toplevel 2>/dev/null)" || return 1
  [[ -n "$top" ]] || return 1

  # 1. The workspace the installer recorded. The FILE is authoritative and the env var is
  #    only a convenience: the env can be chosen by the repository being visited, the file
  #    cannot. The first cut had this precedence backwards — env first — which is exactly
  #    how `AIOS_WORKSPACE=$(pwd)` in a downstream repo made it read as the framework clone.
  local ws=""
  if [[ -f "${AI_OS_LOCATE_HOME}/config/aios-workspace.txt" ]]; then
    ws="$(head -n 1 "${AI_OS_LOCATE_HOME}/config/aios-workspace.txt" 2>/dev/null | tr -d '\n')"
  fi
  if [[ -z "$ws" && "${AI_OS_LOCATE_UNTRUSTED_ENV:-0}" != "1" ]]; then
    ws="${AIOS_WORKSPACE:-}"
  fi
  if [[ -n "$ws" ]]; then
    # Compare canonically: a symlinked checkout must not read as a different repo.
    local a b
    a="$(cd "$ws" 2>/dev/null && pwd -P)" || a="$ws"
    b="$(cd "$top" 2>/dev/null && pwd -P)" || b="$top"
    [[ "$a" == "$b" ]] && return 0
    return 1
  fi

  # 2. No recorded workspace — fall back to the package name. Reachable only when the
  #    install never recorded a workspace (see RESIDUAL above).
  #
  # PARSED, not grepped. The first cut used a substring grep, which the node twin's
  # `JSON.parse(...).name === "ai-os-v2"` does not agree with: a repo named
  # `totally-innocent-app` carrying `"bundledMeta": {"vendored": {"name": "ai-os-v2"}}`
  # anywhere in its package.json satisfied the grep and not the parse — and the shell side
  # is the one every hook uses. A nested key, a workspaces entry or a vendored manifest
  # fragment all reach it. Two implementations of one policy must not disagree, and when
  # they do the permissive one is the one that decides.
  [[ -f "${top}/package.json" ]] || return 1
  local name=""
  if command -v python3 >/dev/null 2>&1; then
    name="$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1])).get("name",""))
except Exception:
    pass' "${top}/package.json" 2>/dev/null)"
  elif command -v node >/dev/null 2>&1; then
    name="$(node -e 'try{process.stdout.write(String(require(process.argv[1]).name||""))}catch(e){}' "${top}/package.json" 2>/dev/null)"
  else
    return 1   # cannot parse → cannot claim this is the framework clone
  fi
  [[ "$name" == "ai-os-v2" ]]
}

# ai_os_locate <logical-path> — print the resolved absolute path, or return 1.
ai_os_locate() {
  local logical="${1:-}"
  [[ -n "$logical" ]] || return 1

  local -a candidates=()
  local install="${AI_OS_LOCATE_HOME}/${logical}"
  local dev="" dev_alt=""
  local top; top="$(git rev-parse --show-toplevel 2>/dev/null)" || top=""
  if [[ -n "$top" ]]; then
    dev="${top}/src/${logical}"
    # Not everything the install mirror holds lives under src/ in the repo — `scripts/`
    # sits at the root. Only ever consulted in the framework-clone branch, so this adds
    # no candidate a downstream project could supply.
    dev_alt="${top}/${logical}"
  fi

  # AI_OS_LOCATE_DEV bypasses the framework-clone test entirely, so it is honoured only
  # when the environment is trusted. Under an untrusted env it is ignored outright.
  # The dev tree is reachable two ways: AI_OS_LOCATE_DEV in a TRUSTED env, or an explicit
  # `ai_os_locate_enable_dev_tree` call (i.e. `ai --dev-tree`), which is honoured under an
  # untrusted env because a function call is not an environment value.
  if [[ ( "${AI_OS_LOCATE_DEV:-0}" == "1" && "${AI_OS_LOCATE_UNTRUSTED_ENV:-0}" != "1" ) \
        || "${_AI_OS_LOCATE_DEV_TREE}" == "1" ]] && [[ -n "$dev" ]]; then
    candidates=("$dev" "$dev_alt" "$install")
  elif [[ -n "$dev" ]] && ai_os_is_framework_clone; then
    candidates=("$dev" "$dev_alt" "$install")
  else
    # The security-relevant branch: a downstream project's own src/ is NOT a candidate.
    candidates=("$install")
  fi

  local c
  for c in "${candidates[@]}"; do
    [[ -f "$c" ]] && { printf '%s' "$c"; return 0; }
  done
  return 1
}
