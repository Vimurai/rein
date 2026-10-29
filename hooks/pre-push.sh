#!/usr/bin/env bash
# AI-OS pre-push — Local CI gate (E-267, D-072, local-ci.md §Components 5b)
# Logic: every pushed tip needs a green, non-dirty `ai ci run` row in the project's
#        .ai/state.sqlite — or a green row for an ancestor that differs from the tip only
#        under .ai/ (the bookkeeping commits ai-task makes after a DONE). In a team project
#        (.ai/team.json, E-328 / D-102 §5a) a member's PASS record .ai/ci/<sha>.json counts
#        the same way, so the local sqlite row is not required; ci-record.mjs gate decides.
# Bypass: AI_OS_CI_SKIP=1 AI_OS_CI_SKIP_REASON="<why>" git push — ONE push; the skip is
#         written to ci_runs as a SKIPPED row with the reason. No reason, no skip.
# Install: `ai init` / `ai sync` write a stub to .git/hooks/pre-push that execs this file.
# stdin (git): "<local ref> <local sha> <remote ref> <remote sha>" per pushed ref.

# ── E-292 (D-082 r2): an ABORTED gate is a BLOCKED call ─────────────────────────────
# git blocks on any non-zero exit, but an abort (unbound variable = 1, syntax error = 258)
# must SAY so instead of reading like a policy refusal. Inline string on the first
# executable line (builtins only; the prologue's `unset -f` cannot delete it). A deliberate
# exit is `exit` with this hook's own codes (0 allow, 1 block); anything else is an abort and
# exits 2 with one line. The hook's ONLY EXIT trap — a later one must chain to it.
trap '_aios_rc=$?; trap - EXIT; case "$_aios_rc:$BASH_COMMAND" in 0:*|1:exit|1:exit[[:space:]]*) exit "$_aios_rc" ;; esac; printf "[GATE_INTERNAL_ERROR] pre-push aborted (rc %s near line %s) — run: ai doctor\n" "$_aios_rc" "$LINENO" >&2; exit 2' EXIT
trap 'trap "" PIPE; printf "[GATE_INTERNAL_ERROR] pre-push interrupted by a signal — run: ai doctor\n" >&2; exit 2' TERM HUP INT PIPE
# ── E-286 (D-078/D-081, T-HOOKENV-001): toolchain pin — FIRST, before any external command.
# A project's settings `env` reaches this process. Drop inherited functions and the
# variables that steer an interpreter, fix PATH, then load the pin (install mirror first,
# this script's own tree second — never the visited repo). Since E-290 the hooks run as
# exec-form `/bin/bash -p` (no BASH_ENV, no imported functions, no SHELLOPTS); these unsets
# remain for what -p leaves alone (CDPATH, GLOBIGNORE, POSIXLY_CORRECT, BASH_COMPAT, interpreter
# variables). See src/shared/toolchain-pin.sh.
unset -f $(compgen -A function) 2>/dev/null
for _v in $(compgen -e); do
  case "$_v" in NODE_*|PYTHON*|PERL*|DYLD_*|LD_*|AI_OS_TC_*|BASH_ENV|ENV|CDPATH|GLOBIGNORE|POSIXLY_CORRECT|BASH_COMPAT) unset "$_v" ;; esac
done
PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
for _p in "${HOME}/.ai-os/shared/toolchain-pin.sh" "${BASH_SOURCE[0]%/*}/../src/shared/toolchain-pin.sh"; do
  [[ -f "$_p" ]] && { . "$_p"; break; }
done
unset _v _p

# Install-mirror-only helper resolution (E-223): the visited repo never supplies the code
# that decides whether its own push may leave the machine. Unlike pre-commit.sh there is no
# script-relative fallback — a missing mirror fails this gate closed below anyway.
export AI_OS_LOCATE_UNTRUSTED_ENV=1
_AI_OS_HOME_DIR="${HOME}/.ai-os"
unset -f ai_os_locate ai_os_locate_enable_dev_tree ai_os_is_framework_clone 2>/dev/null || true
[[ -f "${_AI_OS_HOME_DIR}/shared/locate.sh" ]] && . "${_AI_OS_HOME_DIR}/shared/locate.sh"
if ! declare -f ai_os_locate >/dev/null 2>&1; then
  ai_os_locate() { local _c="${_AI_OS_HOME_DIR}/${1}"; [[ -f "$_c" ]] && { printf '%s' "$_c"; return 0; }; return 1; }
fi

ZERO_SHA="0000000000000000000000000000000000000000"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
AI_DIR="${ROOT}/.ai"

# Not an AI-OS project: nothing to enforce.
[[ -d "$AI_DIR" ]] || exit 0

# Fail CLOSED from here on: a gate that silently lets everything through when its helper
# is missing is the pre-D-060 state with a hook that looks authoritative.
HELPER="$(ai_os_locate shared/ci-record.mjs 2>/dev/null || true)"
if [[ -z "$HELPER" ]] || ! command -v node >/dev/null 2>&1; then
  echo "[CI_GATE] pre-push: ci-record.mjs or node unavailable — run: bash install-ai-os.sh" >&2
  exit 1
fi
NODE_FLAGS=(--disable-warning=MODULE_TYPELESS_PACKAGE_JSON --disable-warning=ExperimentalWarning)

skip="${AI_OS_CI_SKIP:-0}"
reason="${AI_OS_CI_SKIP_REASON:-}"
# D-087 r3: a kept opt-out is a recorded residual, and it is LOUD when honoured.
[[ "$skip" == "1" ]] && echo "[GATE_SKIPPED] AI_OS_CI_SKIP=1 — local-CI push gate skipped for this push (reason: ${reason:-none given}); the skip is recorded" >&2
rc=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [[ -z "${local_ref:-}" ]] && continue
  # A deletion pushes no content.
  [[ "$local_sha" == "$ZERO_SHA" ]] && continue
  if [[ "$skip" == "1" ]]; then
    node "${NODE_FLAGS[@]}" "$HELPER" skip --ai-dir "$AI_DIR" --sha "$local_sha" \
      --ref "$remote_ref" --reason "$reason" || rc=1
  else
    node "${NODE_FLAGS[@]}" "$HELPER" gate --ai-dir "$AI_DIR" --sha "$local_sha" \
      --ref "$remote_ref" || rc=1
  fi
done
exit "$rc"
