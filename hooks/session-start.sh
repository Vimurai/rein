#!/usr/bin/env bash
# session-start.sh — E-126 (caching.md §3) + E-129 (sovereignty-hardening.md §Security).
#   E-126: inject the compiled Rein System Context Cache as a prompt-prefix.
#   E-129: mint a tamper-resistant role token for this session so the safe-exec
#          gate (--check) reads the role from an HMAC-verified file, not the
#          mutable REIN_CALLER_ROLE env var.
#
# Claude Code SessionStart contract: a hook that prints JSON with
# hookSpecificOutput.additionalContext has that text added to the session context.
# Fail-open everywhere — emit nothing / skip the mint rather than block a session.
# Arg $1 (the role the settings file names) is accepted and IGNORED; the session id comes
# from the harness payload, never the env (no circularity).
#
# E-294 (D-083 r9, D-087): the role comes from a LAUNCH RECORD, never from the environment.
# `ai pane <role>` writes ~/.rein/run/launch/<pid>.json before exec'ing the provider; the
# mint walks this process chain and the most restricted live record wins. The launch
# environment (REIN_PANE_ROLE) used to decide the role here, and a project's settings `env`
# could set it — the T-LOCATOR-001 class this closes.
# ── E-292 (D-082 r2): a FAIL-OPEN hook that aborts on its own bug still exits 0 ──────
# (it never blocks the session) but leaves ONE incident record via rein_hook_incident
# (src/shared/toolchain-pin.sh; absent before the pin loads → nothing recorded). Inline
# string on the first executable line, builtins only. A deliberate exit keeps its code.
# The hook's ONLY EXIT trap — a later one must chain to it.
trap '_rein_rc=$?; trap - EXIT; case "$_rein_rc:$BASH_COMMAND" in 0:*) exit "$_rein_rc" ;; esac; rein_hook_incident session-start "$_rein_rc" "$LINENO" >/dev/null 2>&1; exit 0' EXIT
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

# ── E-223 (D-057 §3): install-first helper resolution ────────────────────────
# The locators below used to start at "$(git rev-parse --show-toplevel)/src/...", which
# names the USER's repository, not the Rein install. Any project containing
# src/mcp/safe-exec-mcp/index.js had THAT file executed by node from inside this hook,
# with its stdout trusted to decide whether a write is allowed — cloning a repo was
# enough to run its code and disable the gate meant to stop it.
#
# Bootstrapping the shared resolver must not repeat the mistake, so it is install-mirror
# first and script-relative second — never the visited repo.
# The env here may have been chosen by the repo we are visiting (a project's
# .claude/settings.json `env` block is inherited by hooks), so REIN_HOME is NOT read:
# pointing it at a decoy made this bootstrap SOURCE the decoy's own locate.sh, i.e.
# arbitrary shell inside a fail-closed gate. Assigned here, in the hook's own text, so it
# overrides anything inherited.
# Exported so a child process — an `ai` subcommand spawned from this hook — inherits
# the same judgement rather than defaulting back to trusting the environment.
export REIN_LOCATE_UNTRUSTED_ENV=1
_REIN_HOME_DIR="${HOME}/.rein"
# The guard below asks `declare -f rein_locate`, which means "is a name defined", NOT
# "did my source succeed". bash imports exported functions from the environment at
# startup, so an inherited `rein_locate` satisfies it, the safe inline fallback is never
# installed, and the attacker's function IS the resolver — reachable whenever
# shared/locate.sh is absent, i.e. exactly the degraded install the fallback exists for.
unset -f rein_locate rein_locate_enable_dev_tree rein_is_framework_clone 2>/dev/null || true
for _l in "${_REIN_HOME_DIR}/shared/locate.sh" \
          "$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/../src/shared/locate.sh"; do
  [[ -f "$_l" ]] && { . "$_l"; break; }
done
# Fail-open: these hooks must still run without the resolver (a missing helper is a
# degraded gate, an aborted hook is a broken session). The fallback is the install
# mirror alone — it never falls back to the visited repo.
if ! declare -f rein_locate >/dev/null 2>&1; then
  rein_locate() { local _c="${_REIN_HOME_DIR}/${1}"; [[ -f "$_c" ]] && { printf '%s' "$_c"; return 0; }; return 1; }
fi

set -uo pipefail

# E-294 (D-087, sovereignty-hardening.md Components 8c–8d): the role is NOT read here. Neither
# the positional argument the settings file passes nor REIN_PANE_ROLE is a gate input any more
# (a project's settings `env` reaches this process). safe-exec derives the role from the
# launch records on this process chain — the most restricted live one wins; none at all is the
# plain-launch default, `engineer`, marked unverified — and binds the token to this session's
# process: our PPID, the claude process (measured stable across startup, resume, clear,
# compact and a subagent's tool call, LOG 2026-10-04). bash sets PPID itself.
ROLE=""
ROLE_LAUNCH=""

# Read the SessionStart payload ONCE for the E-129 session id. (The E-126 cache
# step below sources its content from `--emit-context`, not stdin, so consuming
# stdin here does not affect it.)
PAYLOAD="$(cat 2>/dev/null || true)"

# ── E-129/E-294: mint the per-session role token ──────────────────────────────
# Fail-open: a refused or failed mint never blocks session start — the GATE is where a
# missing token blocks (the union, [ROLE_UNVERIFIED]). The stamp below names the role that
# is actually BOUND, read back from safe-exec, so the persona and the gate cannot disagree.
if command -v node >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  _SID="$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("session_id","") or "")
except Exception: pass' 2>/dev/null)"
  _s="$(rein_locate mcp/safe-exec-mcp/index.js || true)"
  if [[ -n "$_SID" && -n "$_s" ]]; then
    IFS=$'\t' read -r ROLE ROLE_LAUNCH < <(node --no-warnings "$_s" --mint-token "$_SID" "$PPID" 2>/dev/null) || true
    if [[ -z "$ROLE" ]]; then
      ROLE="$(node --no-warnings "$_s" --verify-role "$_SID" 2>/dev/null)" || ROLE=""
    fi
  fi
fi
case "$ROLE" in architect|engineer) : ;; *) ROLE="" ;; esac

# ── E-126 + E-208: emit additionalContext ─────────────────────────────────────
# E-208 (D-054, role-abstraction.md §Components 2): the FIRST line of the injected
# context is an `[REIN_ROLE] <role>` stamp naming the role this session actually
# minted. The Role Resolution clause at the top of ENGINEER.md / ARCHITECT.md keys
# off it, so a Claude pane bound to `architect` is governed by ARCHITECT.md even
# though CLAUDE.md statically imports ENGINEER.md (gap G1 — @import cannot branch).
#
# The stamp is emitted even when the E-126 cache is unavailable or disabled: the
# persona layer must never silently lose its role binding just because the cache is
# off. Only a missing python3 (no way to build the JSON envelope) skips it.
# No verified role → the stamp says so and names the fix; the persona layer then follows
# ARCHITECT.md (any stamp other than `engineer`), matching the gate's union.
if [[ -n "$ROLE" ]]; then
  ROLE_STAMP="[REIN_ROLE] ${ROLE}"
  [[ "$ROLE_LAUNCH" == "unverified" ]] && ROLE_STAMP="${ROLE_STAMP}
[REIN_LAUNCH] unverified — no launch record on this process chain (plain launch); \`ai pane <role>\` binds one"
else
  ROLE_STAMP="[REIN_ROLE] unverified
[ROLE_UNVERIFIED] no verified role token for this session — every role's blocks apply. run: ai pane <role>"
fi

command -v python3 >/dev/null 2>&1 || exit 0

# E-291 (D-083 r7): an active operator override is announced at session start, beside the
# role stamp, so neither the operator nor the agent can miss that the gate is lifted.
_GO_PY="$(rein_locate shared/gate-override.py || true)"
if [[ -n "$_GO_PY" ]] && [[ -e "${HOME}/.rein/gate-override.json" || -L "${HOME}/.rein/gate-override.json" ]]; then
  _GO_OUT="$(python3 -I "$_GO_PY" check "${HOME}/.rein/gate-override.json" 2>/dev/null)" && {
    IFS=$'\t' read -r _ _GO_UNTIL _GO_REASON <<< "$_GO_OUT"
    ROLE_STAMP="${ROLE_STAMP}
[GATE_OVERRIDE] the operator lifted the safe-exec policy gate until ${_GO_UNTIL} (${_GO_REASON}). Catastrophic commands and gate self-disable still block. Do not extend or renew it."
  }
fi

# E-326 (D-102 §Component 2): bring a team project's index up to the record files a pull
# brought in while no session was running. E-342 (D-106 r2): a legacy project imports HEAD's
# tracked state.json, and starts node only when its blob id differs from the last import's.
# The import never fails the session; its lines reach the model's context.
_IMP_RUN=0
if [[ -f ".ai/project.json" ]]; then
  _IMP_RUN=1
elif [[ -d ".ai" ]]; then
  _IMP_BLOB="$(git rev-parse -q --verify HEAD:.ai/state.json 2>/dev/null || true)"
  _IMP_LAST=""
  [[ -f ".ai/.last-import-blob" ]] && IFS= read -r _IMP_LAST < ".ai/.last-import-blob"
  [[ -n "$_IMP_BLOB" && "$_IMP_BLOB" != "$_IMP_LAST" ]] && _IMP_RUN=1
fi
if [[ "$_IMP_RUN" == "1" ]] && command -v node >/dev/null 2>&1; then
  _CS="$(rein_locate shared/cli-state.mjs || true)"
  if [[ -n "$_CS" ]]; then
    _IMP="$(node --no-warnings "$_CS" state import --hook session-start 2>&1 || true)"
    [[ -n "$_IMP" ]] && ROLE_STAMP="${ROLE_STAMP}
${_IMP}"
  fi
fi

# E-331 (D-102 §4): a team project fetches origin/<trunk> (E-341; bounded to 3 s, skipped offline —
# git's own failure) so the claim gate and the banner below see teammates' claims, and lists
# the IN_PROGRESS tasks there with their holders. No team.json: no fetch, no node.
if [[ -f ".ai/team.json" ]] && command -v node >/dev/null 2>&1; then
  _CS="$(rein_locate shared/cli-state.mjs || true)"
  if [[ -n "$_CS" ]]; then
    _CLM="$(node --no-warnings "$_CS" task claims --fetch 2>/dev/null || true)"
    [[ -n "$_CLM" ]] && ROLE_STAMP="${ROLE_STAMP}
${_CLM}"
  fi
fi

BLOB=""
if [[ "${REIN_DISABLE_CACHE:-0}" != "1" ]] && command -v node >/dev/null 2>&1; then
  CM=""
  CM="$(rein_locate mcp/cache-manager-mcp/index.js || true)"
  [[ -n "$CM" ]] && BLOB="$(node --no-warnings "$CM" --emit-context 2>/dev/null)"
fi

printf '%s\n\n%s' "$ROLE_STAMP" "$BLOB" | python3 -c '
import json, sys
blob = sys.stdin.read()
sys.stdout.write(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": blob,
    }
}))
' 2>/dev/null || exit 0
exit 0
