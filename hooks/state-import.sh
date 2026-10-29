#!/usr/bin/env bash
# AI-OS state import hook — post-merge / post-checkout / post-rewrite (E-326, D-102 §Component 2)
# A pull, checkout or rebase changes the tracked record files of a team project — or, in a
# legacy project, the tracked state.json (E-342) — and this runs `ai state import` so
# state.sqlite and the views follow them without a manual step.
# Usage (from the git stubs): state-import.sh <post-merge|post-checkout|post-rewrite> [git args…]
# Fail-open: it never blocks git. AI_OS_STATE_IMPORT=0 makes it a no-op with a telemetry row.

# ── E-292 (D-082 r2): a FAIL-OPEN hook that aborts on its own bug still exits 0 ──────
# (it never blocks the session) but leaves ONE incident record via ai_os_hook_incident
# (src/shared/toolchain-pin.sh; absent before the pin loads → nothing recorded). Inline
# string on the first executable line, builtins only. A deliberate exit keeps its code.
# The hook's ONLY EXIT trap — a later one must chain to it.
trap '_aios_rc=$?; trap - EXIT; case "$_aios_rc:$BASH_COMMAND" in 0:*) exit "$_aios_rc" ;; esac; ai_os_hook_incident state-import "$_aios_rc" "$LINENO" >/dev/null 2>&1; exit 0' EXIT
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

HOOK="${1:-post-merge}"
case "$HOOK" in post-merge|post-checkout|post-rewrite) ;; *) exit 0 ;; esac
# post-checkout's third argument is 1 for a branch checkout, 0 for `git checkout -- <file>`.
[[ "$HOOK" == "post-checkout" && "${4:-1}" == "0" ]] && exit 0

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
[[ -n "$REPO_ROOT" ]] || exit 0
[[ -d "${REPO_ROOT}/.ai" ]] || exit 0
# E-342 (D-106 r2): a legacy project (no record store) imports HEAD's tracked state.json. The
# blob id is compared with the one the last import recorded in bash, so a commit, checkout or
# rebase that did not change state.json starts no node.
if [[ ! -f "${REPO_ROOT}/.ai/project.json" ]]; then
  _blob="$(git -C "$REPO_ROOT" rev-parse -q --verify HEAD:.ai/state.json 2>/dev/null || true)"
  [[ -n "$_blob" ]] || exit 0
  _last=""
  [[ -f "${REPO_ROOT}/.ai/.last-import-blob" ]] && IFS= read -r _last < "${REPO_ROOT}/.ai/.last-import-blob"
  [[ "$_blob" == "$_last" ]] && exit 0
fi

# Install mirror only (E-223): never an `ai` resolved from the visited repo or its env.
AI_BIN="${HOME}/.ai-os/bin/ai"
if [[ ! -x "$AI_BIN" ]]; then
  printf "[STATE_IMPORT] WARN: %s not found — run: bash install-ai-os.sh, then: ai state import\n" "$AI_BIN" >&2
  exit 0
fi

( cd "$REPO_ROOT" && "$AI_BIN" state import --hook "$HOOK" ) >&2 2>&1 || true
exit 0
