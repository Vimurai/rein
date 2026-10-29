#!/usr/bin/env bash
# Rein PostToolUse Hook — appends a one-liner to .ai/LOG.md when .ai/ files are written.
# Also logs [SECURITY] prefix for EXECUTE/write system-state operations.
# Installed to ~/.rein/hooks/post-tool-log.sh

# ── E-292 (D-082 r2): a FAIL-OPEN hook that aborts on its own bug still exits 0 ──────
# (it never blocks the session) but leaves ONE incident record via rein_hook_incident
# (src/shared/toolchain-pin.sh; absent before the pin loads → nothing recorded). Inline
# string on the first executable line, builtins only. A deliberate exit keeps its code.
# The hook's ONLY EXIT trap — a later one must chain to it.
trap '_rein_rc=$?; trap - EXIT; case "$_rein_rc:$BASH_COMMAND" in 0:*) exit "$_rein_rc" ;; esac; rein_hook_incident post-tool-log "$_rein_rc" "$LINENO" >/dev/null 2>&1; exit 0' EXIT
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

INPUT=$(cat)

# Pass input via env var — avoids shell injection from embedding $INPUT in Python source
RESULT=$(HOOK_INPUT="$INPUT" python3 - <<'PY'
import json, sys, os

try:
    data = json.loads(os.environ.get("HOOK_INPUT", ""))
except Exception:
    print("")
    sys.exit(0)

tool = data.get("tool_name", "")
inp  = data.get("tool_input", {})

# ── SECURITY: detect EXECUTE operations ──────────────────────────────────────
# Tools that modify system state beyond .ai/ file edits
EXECUTE_TOOLS = {
    "run_shell_command",
    "execute_python",
    "execute_bash",
    "Bash",
    "computer",
}

# Read-only shell patterns — these do NOT get [SECURITY] tags
READ_ONLY_PATTERNS = [
    "cat ", "ls ", "find ", "echo ", "pwd", "which ", "head ", "tail ",
    "grep ", "rg ", "wc ", "stat ", "file ", "diff ", "git log",
    "git status", "git diff", "git show", "git branch", "git remote",
    "curl -s", "curl --silent", "wget -q",
]

def is_read_only_cmd(cmd):
    cmd = cmd.strip()
    for pattern in READ_ONLY_PATTERNS:
        if cmd.startswith(pattern):
            return True
    return False

# Check if this is an EXECUTE-tier operation
is_security_event = False
security_detail = ""

if tool in EXECUTE_TOOLS:
    cmd = inp.get("command") or inp.get("cmd") or inp.get("code") or ""
    if cmd and not is_read_only_cmd(cmd):
        is_security_event = True
        security_detail = cmd[:120].replace("\n", " ")

# ── Determine file path for .ai/ logging ─────────────────────────────────────
file_path = inp.get("file_path") or inp.get("path") or ""

ai_file = ""
if file_path:
    norm = os.path.normpath(os.path.abspath(file_path))
    if "/.ai/" in norm or norm.endswith("/.ai"):
        ai_file = os.path.basename(file_path)

# Output format: type|tool|detail
if is_security_event:
    print(f"SECURITY|{tool}|{security_detail}")
elif ai_file:
    print(f"LOG|{tool}|{ai_file}")
else:
    print("")
PY
)

[[ -z "$RESULT" ]] && exit 0

TYPE="${RESULT%%|*}"
REST="${RESULT#*|}"
TOOL="${REST%%|*}"
DETAIL="${REST#*|}"

AI_DIR="$(pwd)/.ai"
LOG_FILE="${AI_DIR}/LOG.md"

[[ -f "$LOG_FILE" ]] || exit 0

TIMESTAMP=$(date '+%Y-%m-%d %H:%M %Z')

if [[ "$TYPE" == "SECURITY" ]]; then
  printf "- %s | Claude | [SECURITY] %s | %s\n" "$TIMESTAMP" "$TOOL" "$DETAIL" >> "$LOG_FILE"
else
  printf "- %s | Claude | %s | %s\n" "$TIMESTAMP" "$TOOL" "$DETAIL" >> "$LOG_FILE"
fi

# ── E-54: Semi-Verbose Warn & Wait (P-27 §23) ────────────────────────────────
# After every LOG write, check if LOG.md has grown past the archive threshold.
# CLEAN workspace → auto-archive; DIRTY workspace → warn only.
#
# DIRTY detection implements the equivalent of context-guardian-mcp check_workspace:
#   DIRTY  = open [ ] tasks in TASKS.md  (maps to context-guardian DIRTY severity)
#   WARN   = uncommitted non-.ai/ changes (in-progress code work)
#   CLEAN  = no open tasks AND no active code changes
# MCP servers cannot be invoked from bash hooks; direct filesystem checks are used
# to replicate context-guardian's DIRTY determination (TASKS.md open task count).
LOG_LINE_COUNT=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
ARCHIVE_THRESHOLD=200

if (( LOG_LINE_COUNT >= ARCHIVE_THRESHOLD )); then
  # sqlite3 is the mandatory source of truth for open task count (P-32 — no TASKS.md fallback)
  OPEN_TASKS=0
  SQLITE_FILE="${AI_DIR}/state.sqlite"
  if [[ -f "$SQLITE_FILE" ]] && command -v sqlite3 &>/dev/null; then
    OPEN_TASKS=$(sqlite3 "$SQLITE_FILE" "SELECT COUNT(*) FROM tasks WHERE status='OPEN'" 2>/dev/null || echo 0)
  else
    printf "[MISSING_DEP] sqlite3 not found — cannot check open task count for auto-archive trigger\n" >&2
  fi
  OPEN_TASKS="${OPEN_TASKS:-0}"

  # Secondary DIRTY signal: uncommitted non-.ai/ changes mean work is in progress
  GIT_DIRTY=0
  if git -C "$(pwd)" rev-parse --git-dir >/dev/null 2>&1; then
    _dirty_count=$(git -C "$(pwd)" status --porcelain 2>/dev/null \
      | grep -v "^.. \.ai/" | wc -l | tr -d ' ')
    [[ "${_dirty_count:-0}" -gt 0 ]] && GIT_DIRTY=1
  fi

  if (( OPEN_TASKS == 0 && GIT_DIRTY == 0 )); then
    # Workspace CLEAN — trigger archive automatically
    printf "[AUTO-ARCHIVE] LOG.md reached %d lines — archiving .ai/ logs...\n" "$LOG_LINE_COUNT" >&2
    AI_BIN=""
    for _p in "/usr/local/bin/rein" "${HOME}/.rein/bin/rein"; do
      [[ -x "$_p" ]] && AI_BIN="$_p" && break
    done
    if [[ -n "$AI_BIN" ]]; then
      bash "$AI_BIN" archive >/dev/null 2>&1 || printf "[AUTO-ARCHIVE] Archive command failed — run: rein archive\n" >&2
    else
      printf "[AUTO-ARCHIVE] 'rein' binary not found — run: rein archive manually\n" >&2
    fi
  elif (( OPEN_TASKS > 0 )); then
    # Workspace DIRTY — open tasks remain
    printf "[WARNING] .ai/ logs are bloated (%d lines) but workspace is DIRTY (%d open task(s)). Archiving postponed.\n" \
      "$LOG_LINE_COUNT" "$OPEN_TASKS" >&2
  else
    # Workspace DIRTY — uncommitted code changes in progress
    printf "[WARNING] .ai/ logs are bloated (%d lines) but workspace has uncommitted changes. Archiving postponed.\n" \
      "$LOG_LINE_COUNT" >&2
  fi
fi

exit 0
