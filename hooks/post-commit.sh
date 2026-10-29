#!/usr/bin/env bash
# Rein post-commit Hook — "Fixes E-##" closes the task through `ai task done` (E-325, D-102)
# Parses the latest commit message for task IDs and marks each DONE with `ai task done`, which
# writes through the same library and the same completion gates as task-synchronizer-mcp. The
# hook used to rewrite state.json and TASKS.md itself — a second writer that bypassed the gates
# and whose state.json write the next regeneration from state.sqlite discarded anyway.
#
# Syntax recognised in commit messages:
#   Fixes E-12 / Closes P-03 / Implemented T-07
#   (case-insensitive; multiple IDs per commit are all processed)

# ── E-292 (D-082 r2): a FAIL-OPEN hook that aborts on its own bug still exits 0 ──────
# (it never blocks the session) but leaves ONE incident record via rein_hook_incident
# (src/shared/toolchain-pin.sh; absent before the pin loads → nothing recorded). Inline
# string on the first executable line, builtins only. A deliberate exit keeps its code.
# The hook's ONLY EXIT trap — a later one must chain to it.
trap '_rein_rc=$?; trap - EXIT; case "$_rein_rc:$BASH_COMMAND" in 0:*) exit "$_rein_rc" ;; esac; rein_hook_incident post-commit "$_rein_rc" "$LINENO" >/dev/null 2>&1; exit 0' EXIT
# ── E-286 (D-078/D-081, T-HOOKENV-001): toolchain pin — FIRST, before any external command.
# A project's settings `env` reaches this process. Drop inherited functions and the
# variables that steer an interpreter, fix PATH, then load the pin (install mirror first,
# this script's own tree second — never the visited repo). Since E-290 the hooks run as
# exec-form `/bin/bash -p` (no BASH_ENV, no imported functions, no SHELLOPTS); these unsets
# remain for what -p leaves alone (CDPATH, GLOBIGNORE, POSIXLY_CORRECT, BASH_COMPAT, interpreter
# variables). See src/shared/toolchain-pin.sh.
unset -f $(compgen -A function) 2>/dev/null
for _v in $(compgen -e); do
  case "$_v" in NODE_*|PYTHON*|PERL*|DYLD_*|LD_*|REIN_TC_*|BASH_ENV|ENV|CDPATH|GLOBIGNORE|POSIXLY_CORRECT|BASH_COMPAT) unset "$_v" ;; esac
done
PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
for _p in "${HOME}/.rein/shared/toolchain-pin.sh" "${BASH_SOURCE[0]%/*}/../src/shared/toolchain-pin.sh"; do
  [[ -f "$_p" ]] && { . "$_p"; break; }
done
unset _v _p

COMMIT_MSG=$(git log -1 --format="%s %b" 2>/dev/null || true)
[[ -z "$COMMIT_MSG" ]] && exit 0

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
[[ -d "${REPO_ROOT}/.ai" ]] || exit 0

# Extract all task IDs referenced with Fixes/Closes/Implemented keywords
IDS=$(printf '%s' "$COMMIT_MSG" \
  | grep -oiE '(fixes|closes|implemented)[[:space:]]+(E|P|T)-[0-9]+' \
  | grep -oE '(E|P|T)-[0-9]+' || true)

[[ -z "$IDS" ]] && exit 0

# Install mirror only (E-223): never an `ai` resolved from the visited repo or its env.
AI_BIN="${HOME}/.rein/bin/ai"
if [[ ! -x "$AI_BIN" ]]; then
  printf "[TASK-SYNC] WARN: %s not found — run: bash install-rein.sh. Not closing: %s\n" "$AI_BIN" "$(tr '\n' ' ' <<< "$IDS")" >&2
  exit 0
fi

# The gates' env rollbacks never reach `ai task done` (it drops them as well).
unset REIN_CI_GATE REIN_BUILD_STAMP
SHA7=$(git rev-parse --short HEAD 2>/dev/null || true)
for ID in $IDS; do
  # A refusal (e.g. no green CI run for this commit yet) is printed and the task stays open.
  ( cd "$REPO_ROOT" && "$AI_BIN" task done "$ID" --summary "closed by commit ${SHA7}" ) 2>&1 \
    | sed 's/^/[TASK-SYNC] /' >&2 || true
done

exit 0
