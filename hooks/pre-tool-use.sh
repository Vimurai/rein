#!/usr/bin/env bash
# pre-tool-use.sh — E-125 (sovereignty-hardening.md / THREAT_MODEL T-HITL-004):
# FAIL-CLOSED pre-execution gate. Runs every Bash tool command through
# safe-exec-mcp's analysis (`--check`) BEFORE it executes and BLOCKS it (exit 2)
# on a BLOCK verdict — turning safe-exec from advisory into enforcing.
#
# Claude Code PreToolUse contract: exit 2 BLOCKS the tool call and feeds this
# hook's stderr back to the model; exit 0 ALLOWS. The tool call arrives as a JSON
# object on stdin ({ tool_name, tool_input: { command } }).
#
# Defense in depth (T-HITL-004 "gate circumvention"): if the node analyzer is
# unavailable, a hardcoded backstop still blocks the most catastrophic patterns,
# so the gate cannot be silently bypassed by breaking node. If the analyzer is
# present but CRASHES, `--check` itself exits 2 (FAIL-CLOSED, E-128) and this hook
# blocks — an internal error can no longer be used to bypass the gate.
#
# E-208 (D-054, role-abstraction.md §Components 5): the gate also covers the WRITE
# tools (Write|Edit|MultiEdit|NotebookEdit). When the HMAC-verified session role is
# `architect`, a write to any path outside .ai/ or plans/ is BLOCKED. The Engineer
# path is unchanged: for role=engineer the write gate is a fast no-op.
#
# SCOPE (widened by E-216 / D-055 R1). The Architect write gate now has THREE layers:
#   1. this hook — the native Write/Edit tools, path-checked against .ai//plans/
#   2. safe-exec analyzeArchitectWrites — shell redirections, tee/cp/mv/install/ln/
#      rsync/dd/truncate/patch, sed -i / perl -i, git apply; inline interpreters
#      (python3 -c, node -e, bash -c, eval, heredoc-fed) blocked outright
#   3. permissions.deny in .claude/settings.architect.json — the MCP write tools
# STATED RESIDUAL: exotic encodings, git plumbing (hash-object/update-index), and
# interactive editors are NOT covered. Strong defence in depth; not airtight. The Git
# Lane (E-214) remains the last checkpoint before anything reaches history.
#
# Operator escape (E-291, D-081 r2 / D-083): `rein gate off [--minutes N] [--reason …]` in the
# operator's own terminal writes a time-boxed ~/.rein/gate-override.json; there is NO
# environment rollback (a project's settings `env` could set one). Under an override the
# catastrophic set and the self-disable guard still block, and every bypassed call is loud.
#
# ── E-292 (D-082 r2): an ABORTED gate is a BLOCKED call ──────────────────────────────
# Claude Code treats every exit other than 2 as "allow", so an unbound variable (rc 1) or a
# syntax error (258) in this file used to let the call through. The trap is an inline STRING
# on the first executable line: builtins only, nothing the prologue's `unset -f` can delete,
# nothing PATH resolves (-p already ignored BASH_ENV and imported functions). A deliberate
# exit is `exit` WITH this hook's own codes (0 allow, 2 block); anything else — `exit $UNSET`
# included — is an abort and becomes exit 2 with one line. TERM/HUP/INT/PIPE would kill the
# shell without running EXIT, so they block too. SIGKILL and Claude Code's own hook timeout
# are the accepted residual (THREAT_MODEL T-HOOKABORT-001). This is the hook's ONLY EXIT
# trap (nothing it sources sets one — pinned by a test); a later one must chain to it.
trap '_rein_rc=$?; trap - EXIT; case "$_rein_rc:$BASH_COMMAND" in 0:*|2:exit|2:exit[[:space:]]*) exit "$_rein_rc" ;; esac; printf "[GATE_INTERNAL_ERROR] pre-tool-use aborted (rc %s near line %s) — run: rein doctor\n" "$_rein_rc" "$LINENO" >&2; exit 2' EXIT
trap 'trap "" PIPE; printf "[GATE_INTERNAL_ERROR] pre-tool-use interrupted by a signal — run: rein doctor\n" >&2; exit 2' TERM HUP INT PIPE
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
# Exported so a child process — a `rein` subcommand spawned from this hook — inherits
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

PAYLOAD="$(cat 2>/dev/null)"
[[ -z "$PAYLOAD" ]] && exit 0

# ── Repair exemption (D-081 ruling 4, D-082 ruling 3) ───────────────────────
# _is_repair_cmd <command> — the ONE place that decides "this is the repair command",
# used by both [TOOLCHAIN_STALE] and [SAFE_EXEC_UNAVAILABLE]. It lives INLINE here, not in
# the shared pin: when the pin itself is unreachable (a partial mirror) the repair command
# must still pass. Exempt is exactly the literal `bash install-rein.sh`, from the
# directory that holds a regular install-rein.sh, with no other arguments, separators or
# prefixes. Nothing else.
_is_repair_cmd() {
  local c="$1"
  c="${c#"${c%%[![:space:]]*}"}"; c="${c%"${c##*[![:space:]]}"}"   # trim surrounding space only
  [[ "$c" == "bash install-rein.sh" && -f "${PWD}/install-rein.sh" && ! -L "${PWD}/install-rein.sh" ]]
}

# The catastrophic set — narrow, false-positive-averse, truly irreversible. Used by the
# analyzer-not-located backstop at the end AND under an operator override (D-083 r8).
# E-292: here-strings, not `printf | grep -q` — under pipefail a grep -q that matched and
# exited early SIGPIPEs the printf on a command larger than the pipe buffer, the pipeline
# returns 141, and a catastrophic match read as "no match" (fail-open on a padded command).
_catastrophic() {
  local c="$1"
  # rm with recursive AND force (combined -rf/-fr/-Rfv… OR split -r … -f OR
  # --no-preserve-root) targeting a root/home path (/ ~ ~/ $HOME ${HOME} /*).
  if grep -qE '(^|[;&|[:space:]])rm([[:space:]]|$)' <<< "$c"; then
    if grep -qE '(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR]|--no-preserve-root)' <<< "$c" \
       || { grep -qE '(-[rR]([[:space:]]|$)|--recursive)' <<< "$c" \
            && grep -qE '(-f([[:space:]]|$)|--force)' <<< "$c"; }; then
      grep -qE '([[:space:]=])(/|~|~/|\$HOME|\$\{HOME\})([[:space:]/]|$)' <<< "$c" && return 0
      grep -qE '[[:space:]]/\*([[:space:]]|$)' <<< "$c" && return 0
    fi
  fi
  grep -qE '(curl|wget)[[:space:]].*\|[[:space:]]*(ba|z|d)?sh' <<< "$c" && return 0
  grep -qE ':[[:space:]]*\(\)[[:space:]]*\{[[:space:]]*:[[:space:]]*\|[[:space:]]*:' <<< "$c" && return 0   # fork bomb
  grep -qE '\bmkfs(\.[a-z0-9]+)?\b' <<< "$c" && return 0
  grep -qE '\bdd\b.*[[:space:]]of=/dev/' <<< "$c" && return 0
  return 1
}

# E-339 (D-107 r3): the analyzer invocation — the E-292 wall clock, the flags, the verdict
# parse — lives in shared/gate-probe.sh, which `rein sync` (gate_check) and `rein doctor` source
# too, so the probe they run cannot drift from this gate. Install mirror only (E-223). When
# the file is missing the functions are undefined, the call exits 127 = no verdict, and both
# branches below block (fail closed) — the repair command stays exempt as before.
_GATE_PROBE="$(rein_locate shared/gate-probe.sh 2>/dev/null || true)"
# shellcheck source=src/shared/gate-probe.sh
[[ -n "$_GATE_PROBE" ]] && . "$_GATE_PROBE"

# ── E-286 (D-081 rulings 3+4): a gate with no interpreter has no verdict, and no verdict
# is a block. python3 parses the payload and node runs the analyzer; if the pin found
# neither recorded nor fallback copy of one, block with [TOOLCHAIN_STALE] — except the
# literal repair command (_is_repair_cmd above). With no python3 there is no parser, so
# the repair candidate is read from the raw JSON: the payload must carry exactly that
# command string and the Bash tool.
if ! declare -f rein_tc_missing >/dev/null 2>&1; then
  # The pin itself is unreachable (no mirror, no dev tree): judge from the fixed PATH.
  rein_tc_missing() { command -v node >/dev/null 2>&1 || { printf 'node'; return 0; }
                       command -v python3 >/dev/null 2>&1 || { printf 'python3'; return 0; }; return 1; }
fi
_TC_MISSING="$(rein_tc_missing || true)"
if [[ -n "$_TC_MISSING" ]]; then
  # Anchored to the payload's SHAPE (critic_security P1): two free-floating regexes were
  # satisfied by a Write/MCP call nesting {"tool_name":"Bash"} and {"command":"…"} inside
  # some other object. Require exactly one "tool_name" and one "command" key in the whole
  # payload, tool_name Bash, and the command sitting FLAT inside tool_input (no nested
  # object or array between the braces). Valid JSON cannot hold an unescaped quote inside
  # a string, so a key name smuggled in a value never matches `"command"`.
  _tc_rest_tool="${PAYLOAD//\"tool_name\"/}"; _tc_rest_cmd="${PAYLOAD//\"command\"/}"
  _tc_n_tool=$(( (${#PAYLOAD} - ${#_tc_rest_tool}) / 11 ))
  _tc_n_cmd=$(( (${#PAYLOAD} - ${#_tc_rest_cmd}) / 9 ))
  _tc_re_tool='"tool_name"[[:space:]]*:[[:space:]]*"Bash"'
  _tc_re_cmd='"tool_input"[[:space:]]*:[[:space:]]*\{[^][{}]*"command"[[:space:]]*:[[:space:]]*"bash install-rein\.sh"[^][{}]*\}'
  if [[ "$_tc_n_tool" -eq 1 && "$_tc_n_cmd" -eq 1 && "$PAYLOAD" =~ $_tc_re_tool && "$PAYLOAD" =~ $_tc_re_cmd ]] \
     && _is_repair_cmd "bash install-rein.sh"; then
    exit 0
  fi
  echo "[TOOLCHAIN_STALE] ${_TC_MISSING} missing — run: bash install-rein.sh (E-286)" >&2
  exit 2
fi

# Extract tool_name + the Bash command. The command is base64-encoded so it
# survives newlines / quotes / shell metacharacters intact across the boundary.
# E-292 (security_engineer P0-1): a parse that fails is NO verdict, and no verdict blocks.
# Before, any exception (malformed JSON, a lone surrogate in `command` or `file_path` that
# made .encode() raise after "Bash" was already printed) left TOOL or CMD empty and the hook
# exited 0. Now every field is validated and encoded FIRST, printed in one write, and closed
# by an "OK" sentinel; anything else — a non-zero exit, a missing sentinel, a field that
# decodes to nothing — blocks with [GATE_INTERNAL_ERROR].
PARSED="$(printf '%s' "$PAYLOAD" | python3 -c '
import json, sys, base64, re
try:
    d = json.load(sys.stdin)
    if not isinstance(d, dict):
        sys.exit(3)
    tool = d.get("tool_name", "") or ""
    sid = d.get("session_id", "") or ""     # E-129: tamper-resistant role token key
    ti = d.get("tool_input") or {}
    cmd = ti.get("command", "") if isinstance(ti, dict) else ""
    # E-208: Write/Edit/MultiEdit carry file_path; NotebookEdit carries notebook_path.
    fp = (ti.get("file_path") or ti.get("notebook_path") or "") if isinstance(ti, dict) else ""
    if not all(isinstance(v, str) for v in (tool, sid, cmd, fp)):
        sys.exit(3)
    # bash drops NUL from $( … ), so the analyzer would read other text than what runs.
    if "\x00" in cmd or "\x00" in fp:
        sys.exit(3)
    # One line each: a newline in tool or sid would shift every field after it.
    if not re.fullmatch(r"[A-Za-z0-9_.:-]+", tool) or not re.fullmatch(r"[A-Za-z0-9_.:-]*", sid):
        sys.exit(3)
    out = "\n".join([tool, base64.b64encode(cmd.encode()).decode(), sid,
                     base64.b64encode(fp.encode()).decode(), "OK"]) + "\n"
except SystemExit:
    raise
except BaseException:
    sys.exit(3)
sys.stdout.write(out)
' 2>/dev/null)"
_P_RC=$?

TOOL="$(printf '%s\n' "$PARSED" | sed -n '1p')"
_CMD_B64="$(printf '%s\n' "$PARSED" | sed -n '2p')"
CMD="$(printf '%s' "$_CMD_B64" | base64 --decode 2>/dev/null)"
SID="$(printf '%s\n' "$PARSED" | sed -n '3p')"   # E-129: session id (from harness, not env)
_FP_B64="$(printf '%s\n' "$PARSED" | sed -n '4p')"
FILE_PATH="$(printf '%s' "$_FP_B64" | base64 --decode 2>/dev/null)"
if [[ "$_P_RC" -ne 0 || "$(printf '%s\n' "$PARSED" | sed -n '5p')" != "OK" || -z "$TOOL" \
      || ( -n "$_CMD_B64" && -z "$CMD" ) || ( -n "$_FP_B64" && -z "$FILE_PATH" ) ]]; then
  echo "[GATE_INTERNAL_ERROR] pre-tool-use could not parse the tool call (rc ${_P_RC}) — blocked; run: rein doctor" >&2
  exit 2
fi
unset _CMD_B64 _FP_B64

# ── E-291 (D-081 r2, D-083 r5-8): the operator's time-boxed override ───────────
# Honoured ONLY through src/shared/gate-override.py (O_NOFOLLOW + fstat, owner = you, no
# group/other write, one link, <= 4 KB, `now < until <= now + 3600`). Python is spawned only
# when the file exists, so the normal path pays nothing. An invalid file is IGNORED with
# one stderr notice and the gate runs as if it were absent — never "allow on error".
# Under an active override the analyzer still runs, in --override mode: the catastrophic
# set and the self-disable guard keep blocking (r8), so an override cannot extend itself.
_ESCAPE="Operator escape — in YOUR terminal, not through the agent: rein gate off"
_GO_FILE="${HOME}/.rein/gate-override.json"
_GO_ACTIVE=0; _GO_UNTIL=""; _GO_REASON=""
if [[ -e "$_GO_FILE" || -L "$_GO_FILE" ]]; then
  _GO_PY="$(rein_locate shared/gate-override.py || true)"
  if [[ -n "$_GO_PY" ]]; then
    _GO_OUT="$(python3 -I "$_GO_PY" check "$_GO_FILE" 2>/dev/null)"; _GO_RC=$?
    if [[ "$_GO_RC" -eq 0 ]]; then
      _GO_ACTIVE=1
      IFS=$'\t' read -r _ _GO_UNTIL _GO_REASON <<< "$_GO_OUT"
    elif [[ "$_GO_RC" -eq 1 ]]; then
      echo "[GATE_OVERRIDE] ignored (${_GO_OUT#IGNORED$'\t'}) — the gate runs normally" >&2
    fi
  fi
fi
# A call let through ONLY because of the override is LOUD (D-083 r7): a user-visible
# systemMessage on stdout (stderr is not shown on exit 0) plus one telemetry BYPASS row.
_go_bypass() {
  printf '{"systemMessage":"[GATE_OVERRIDE] safe-exec bypassed until %s (%s) — operator: rein gate on"}\n' \
    "$_GO_UNTIL" "$_GO_REASON"
  (
    _th="$(rein_locate shared/telemetry.mjs || true)"
    [[ -n "$_th" ]] && command -v node >/dev/null 2>&1 \
      && printf '{"tool_name":"%s","execution_time_ms":0,"status":"BYPASS","source":"hook"}' "$TOOL" \
         | node "$_th" --record-tool
  ) >/dev/null 2>&1 &
  disown 2>/dev/null || true
  exit 0
}

# ── E-208: Architect write-scope gate (Write|Edit|MultiEdit|NotebookEdit) ──────
# Delegates to safe-exec `--check-path`, which resolves the role from the SAME
# HMAC-verified session token the Bash gate uses and exits 0 immediately for a
# non-architect role. Fail-open ONLY when the analyzer is missing (no node / not
# installed) — an analyzer that is present but crashes exits 2 and blocks (E-128).
case "$TOOL" in
  Write|Edit|MultiEdit|NotebookEdit)
    [[ -z "$FILE_PATH" ]] && exit 0
    SE_W=""
    SE_W="$(rein_locate mcp/safe-exec-mcp/index.js || true)"
    if [[ -n "$SE_W" ]] && command -v node >/dev/null 2>&1; then
      # Argument order is fixed: <path> --session <sid> --session-pid <our PPID>. safe-exec
      # anchors its flag scan past the path, so a target path literally named "--session"
      # cannot hijack the parse (E-208 audit). E-294 (D-087): no role argument — the role is
      # the verified token's, bound to the claude process, which is our PPID (bash sets it).
      W_REPORT="$(rein_gate_analyze_path "$SE_W" "$FILE_PATH" --session "$SID" --session-pid "$PPID" 2>/dev/null)"
      W_RC=$?   # 4 = the E-292 wall clock fired (TIMEOUT); 127 = gate-probe.sh missing
      # ANY non-zero exit blocks, not just 2. A module that fails to LOAD exits 1,
      # and E-128's in-JS fail-closed guarantee cannot cover a file that never ran —
      # so treating only 2 as a block left a fail-open hole (E-208 audit).
      if [[ "$W_RC" -ne 0 ]]; then
        # Under an override the Architect scope is lifted — but ~/.rein/** never is (r6).
        # Lifted only on a real verdict (rc 2): with none (crash, timeout) the self-disable
        # guard never ran, and a text test on the path is no substitute (case-insensitive
        # APFS, symlinked parents, `..` — critic_security P1), so no verdict = blocked (E-292).
        if [[ "$_GO_ACTIVE" -eq 1 && "$W_RC" -eq 2 ]] && ! grep -q 'GATE_SELF_DISABLE' <<< "$W_REPORT"; then
          _go_bypass
        fi
        {
          echo "[SOVEREIGNTY_BLOCK] write gate blocked this ${TOOL} (rc ${W_RC}$([[ "$W_RC" -eq 4 ]] && printf ' TIMEOUT')):"
          echo "$W_REPORT"
          echo "$_ESCAPE"
        } >&2
        exit 2
      fi
    fi
    exit 0
    ;;
esac

# Only gate shell execution below this point. Other tools pass through.
[[ "$TOOL" != "Bash" ]] && exit 0
[[ -z "$CMD" ]] && exit 0


# ── Primary: the node analyzer (single source of truth with the MCP tool) ─────
SE=""
SE="$(rein_locate mcp/safe-exec-mcp/index.js || true)"

if [[ -n "$SE" ]] && command -v node >/dev/null 2>&1; then
  # --no-warnings keeps node module-type noise out of the report; report is on
  # stdout, exit code carries the verdict (2 = BLOCK).
  # E-129/E-294: the role is the HMAC-verified session token's, bound to our PPID (the claude
  # process); no verified token → the union. No role argument and no environment input.
  _OV=(); [[ "$_GO_ACTIVE" -eq 1 ]] && _OV=(--override)
  REPORT="$(rein_gate_analyze "$SE" "$CMD" --session "$SID" --session-pid "$PPID" ${_OV[@]+"${_OV[@]}"} 2>/dev/null)"
  rc=$?   # 4 = the E-292 wall clock fired (TIMEOUT, no verdict → blocked below)
  if [[ "$rc" -eq 2 ]]; then
    {
      echo "[SAFE_EXEC_BLOCK] safe-exec fail-closed gate (E-125) blocked this command:"
      echo "$REPORT"
      [[ "$_GO_ACTIVE" -eq 1 ]] && echo "(blocked even under the operator override: catastrophic or self-disabling — D-083 r8)"
      echo "$_ESCAPE"
    } >&2
    exit 2
  fi
  # E-289 (D-080 ruling 3): the analyzer was LOCATED but produced no verdict. Exit 1 is a
  # module that failed to load (e.g. a mirror missing a sibling like secret-rule.mjs),
  # 126/127 an interpreter that vanished, 134/137/139 abort/kill/segfault. Before E-289
  # all of these fell through to "allow" — only 2 blocked — so a broken install silently
  # disabled the gate. No verdict is a block, matching the Write/Edit branch above. The
  # one exemption is the literal repair command, decided by the SAME helper the
  # [TOOLCHAIN_STALE] branch uses (_is_repair_cmd, inline above — D-082 ruling 3).
  # rc 0 with no `Verdict:` line is no verdict either (critic_security P2): an index.js older
  # than E-125 has no --check mode, starts its stdio server on a drained stdin and exits 0.
  if [[ "$rc" -ne 0 ]] || ! rein_gate_has_verdict "$REPORT"; then
    _is_repair_cmd "$CMD" && exit 0
    # D-083 (E-289 escape hatch #2 = the override file): with an ACTIVE override a broken
    # analyzer does not strand the operator — the catastrophic backstop still blocks, the
    # rest passes loudly. Without one, no verdict is a block.
    if [[ "$_GO_ACTIVE" -eq 1 ]]; then
      if _catastrophic "$CMD"; then
        echo "[SAFE_EXEC_BLOCK] catastrophic pattern — blocked even under the operator override (D-083 r8)." >&2
        exit 2
      fi
      # critic_security P1-1: a command padded past ARG_MAX makes node exit 126 with no
      # verdict, so GATE_SELF_DISABLE never ran. Without the analyzer, err BROAD: anything
      # naming `rein gate`, the override file or the mirror is refused here.
      if grep -qE "r[\"'\\\\]?e[\"'\\\\]?i[\"'\\\\]?n[\"']?[[:space:]]+[\"']?gate|gate-override\.json|\.rein" <<< "$CMD"; then
        echo "[SAFE_EXEC_BLOCK] no analyzer verdict and the command touches the gate or ~/.rein — blocked even under the operator override (E-291)." >&2
        exit 2
      fi
      _go_bypass
    fi
    [[ "$rc" -eq 0 ]] && rc="0 without a verdict"
    [[ "$rc" == 4 ]] && rc="4 (TIMEOUT — no verdict within 10 s)"
    {
      echo "[SAFE_EXEC_UNAVAILABLE] safe-exec exited ${rc}: run bash install-rein.sh"
      echo "$_ESCAPE"
    } >&2
    exit 2
  fi
  # Under an override the policy rules were NOT applied to this call — say so, every time.
  [[ "$_GO_ACTIVE" -eq 1 ]] && _go_bypass
  exit 0   # PASS / WARN → allow (warnings are advisory, only BLOCK is enforced)
fi

# ── Backstop: analyzer unavailable → still block CATASTROPHIC patterns ─────────
# Narrow, false-positive-averse set (truly irreversible). The full ruleset lives
# in the node analyzer above; this only guarantees fail-closed on the worst cases.
if _catastrophic "$CMD"; then
  echo "[SAFE_EXEC_BLOCK] safe-exec analyzer unavailable; backstop blocked a catastrophic pattern (E-125)." >&2
  exit 2
fi
exit 0
