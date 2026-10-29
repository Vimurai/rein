#!/usr/bin/env bash
# Rein Stop Hook — auto-stamps .ai/SESSION.md when a Claude session ends.
# Installed to ~/.rein/hooks/stop-hook.sh and referenced in .claude/settings.json

# ── E-292 (D-082 r2): a FAIL-OPEN hook that aborts on its own bug still exits 0 ──────
# (it never blocks the session) but leaves ONE incident record via rein_hook_incident
# (src/shared/toolchain-pin.sh; absent before the pin loads → nothing recorded). Inline
# string on the first executable line, builtins only. A deliberate exit keeps its code.
# The hook's ONLY EXIT trap — a later one must chain to it.
trap '_rein_rc=$?; trap - EXIT; case "$_rein_rc:$BASH_COMMAND" in 0:*) exit "$_rein_rc" ;; esac; rein_hook_incident stop-hook "$_rein_rc" "$LINENO" >/dev/null 2>&1; exit 0' EXIT
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

AI_DIR="$(pwd)/.ai"
SESSION_FILE="${AI_DIR}/SESSION.md"

# Only run if this is a Rein project
[[ -d "$AI_DIR" ]] || exit 0
[[ -f "$SESSION_FILE" ]] || exit 0

TIMESTAMP=$(date '+%Y-%m-%d %H:%M %Z')

# Try to read the session summary from stdin (Claude may pass context as JSON)
SESSION_JSON=""
if read -t 1 -r line 2>/dev/null; then
  SESSION_JSON="$line"
fi

# Extract a brief summary if JSON is available
# Pass JSON via env var — avoids shell injection from embedding $SESSION_JSON in Python source
SUMMARY="auto-stamped by Stop hook"
if [[ -n "$SESSION_JSON" ]] && command -v python3 &>/dev/null; then
  EXTRACTED=$(HOOK_JSON="$SESSION_JSON" python3 - <<'PY'
import json, os
try:
    d = json.loads(os.environ.get("HOOK_JSON", ""))
    msg = d.get("summary") or d.get("message") or ""
    # E-379 (security P2-2): one line, uncut — the cut comes after redaction, so an address
    # is never shortened into something the scan no longer recognises.
    print(" ".join(str(msg).split())[:4000] if msg else "")
except Exception:
    print("")
PY
  )
  [[ -n "$EXTRACTED" ]] && SUMMARY="$EXTRACTED"
fi

# E-379 (D-130): the summary is free text bound for SESSION.md and the tracked DIGEST.md, so it
# passes through the shared redact() first. Without the redactor (or node) no free text is
# written at all — the placeholder below never reaches DIGEST.md.
if [[ "$SUMMARY" != "auto-stamped by Stop hook" ]]; then
  _E379_RED=""
  _E379_PS="$(rein_locate shared/publish-scan.mjs || true)"
  if [[ -n "$_E379_PS" ]] && command -v node >/dev/null 2>&1; then
    _E379_RED="$(printf '%s' "$SUMMARY" | node --no-warnings "$_E379_PS" redact ".ai/DIGEST.md" "$(pwd)" 2>/dev/null || true)"
  fi
  SUMMARY="${_E379_RED:-auto-stamped by Stop hook}"
fi
SUMMARY="${SUMMARY:0:100}"

# E-213 (§Components 4): stamp WHICH provider ran WHICH role, instead of a hardcoded
# "Claude". Under a same-provider Triad both panes are Claude, so the provider alone no
# longer identifies the session. Role comes from the launch-time pane role (set by
# `ai pane`) or the advisory env; provider from .ai/roles.json. Fails soft to "Claude"
# — a session stamp must never break the Stop hook.
ACTOR="Claude"
_E213_ROLE="${REIN_PANE_ROLE:-${REIN_CALLER_ROLE:-engineer}}"
case "$_E213_ROLE" in architect|engineer) ;; *) _E213_ROLE="engineer" ;; esac
if command -v node >/dev/null 2>&1; then
  for _pa in "$(rein_locate shared/provider-adapter.mjs || true)"; do
    if [[ -n "$_pa" && -f "$_pa" ]]; then
      _E213_PROV="$(node --no-warnings -e '
const { pathToFileURL } = require("node:url");
import(pathToFileURL(process.argv[1]).href).then(m =>
  process.stdout.write(m.roleProvider(process.argv[2], process.argv[3]) || ""));
' "$_pa" "$AI_DIR" "$_E213_ROLE" 2>/dev/null || true)"
      break
    fi
  done
fi
[[ -z "${_E213_PROV:-}" ]] && _E213_PROV="claude"
# "claude" -> "Claude" so the stamp reads the way it always has.
_E213_PROV="$(printf '%s' "$_E213_PROV" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
ACTOR="${_E213_PROV} (${_E213_ROLE})"

cat >> "$SESSION_FILE" <<STAMP
---
- Time: ${TIMESTAMP}
- Actor: ${ACTOR}
- Notes: ${SUMMARY}
---
STAMP

# Also append a one-liner to DIGEST.md "Recent changes" section
DIGEST_FILE="${AI_DIR}/DIGEST.md"
if [[ -f "$DIGEST_FILE" ]]; then
  TODAY=$(date '+%Y-%m-%d')
  # Only append if the last entry isn't from today already (avoid duplicate stamps)
  if ! grep -q "^- ${TODAY}:" "$DIGEST_FILE" 2>/dev/null; then
    # Build a meaningful entry: use SUMMARY if it came from Claude, otherwise
    # pull the last written file from LOG.md as a hint
    DIGEST_NOTE="$SUMMARY"
    LOG_FILE="${AI_DIR}/LOG.md"
    if [[ "$DIGEST_NOTE" == "auto-stamped by Stop hook" && -f "$LOG_FILE" ]]; then
      LAST_FILE=$(grep -o '| [A-Z_]*\.md$' "$LOG_FILE" 2>/dev/null | tail -1 | tr -d '| ' || true)
      [[ -n "$LAST_FILE" ]] && DIGEST_NOTE="updated ${LAST_FILE}"
    fi
    # Never pollute DIGEST's curated "Recent Changes" with the generic placeholder
    # (no real session summary AND no LOG-derived note). The curated section is
    # maintained by digest_updater / ai-digest; the stale-warning below prompts a
    # proper regen. Writing "auto-stamped by Stop hook" here was a recurring junk
    # line that had to be hand-reverted before every commit.
    if [[ "$DIGEST_NOTE" != "auto-stamped by Stop hook" ]]; then
      printf -- "- %s: %s\n" "$TODAY" "$DIGEST_NOTE" >> "$DIGEST_FILE"
    fi
  fi
fi

# Reactive Memory (E-138, §24): detect digest_stale flag set by run_handover.
# Read from state.sqlite directly via sqlite3 CLI (P-18 — no python3/state.json dependency).
SQLITE_FILE="${AI_DIR}/state.sqlite"
STALE_REASON=""
if [[ -f "$SQLITE_FILE" ]] && command -v sqlite3 &>/dev/null; then
  DIGEST_STALE=$(sqlite3 "$SQLITE_FILE" "SELECT value FROM meta WHERE key='digest_stale'" 2>/dev/null || echo "false")
  if [[ "$DIGEST_STALE" == "true" ]]; then
    STALE_REASON=$(sqlite3 "$SQLITE_FILE" "SELECT value FROM meta WHERE key='digest_stale_reason'" 2>/dev/null || echo "task completed")
    STALE_REASON="${STALE_REASON:0:80}"
  fi
fi

# E-338 (D-104 r4c): a handoff written and not committed is invisible to the other clone.
# Report it once per stop; never commit — the hook has no role for the message and the
# index may hold half a task (the reason the skills use `git commit --only`).
_COMM_PROBE="$(rein_locate shared/comm-status.sh 2>/dev/null || true)"
if [[ -n "$_COMM_PROBE" ]]; then
  . "$_COMM_PROBE"
  _COMM_ST="$(rein_comm_status "$(pwd)")"
  if [[ "$_COMM_ST" == UNCOMMITTED* ]]; then
    echo "[COMM_UNCOMMITTED] .ai/COMM.md has uncommitted changes — commit it: git add .ai/COMM.md && git commit --only .ai/COMM.md" >&2
  fi
fi

if [[ -n "$STALE_REASON" ]]; then
  cat >&2 <<WARN

╔══════════════════════════════════════════════════════════════╗
║  REACTIVE MEMORY — DIGEST.md IS STALE (§24)                 ║
╠══════════════════════════════════════════════════════════════╣
║  Reason: ${STALE_REASON}
║                                                              ║
║  Regenerate DIGEST.md before the next session:              ║
║    skill: "ai-digest"                                        ║
║    or: skill: "digest_updater"                               ║
╚══════════════════════════════════════════════════════════════╝

WARN
fi

exit 0
