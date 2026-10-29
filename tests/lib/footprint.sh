#!/usr/bin/env bash
# footprint.sh — the dynamic footprint recorder (E-297, D-088, test-economics.md §Component 1)
#
# Sourced by tests/lib/assert.sh, so every suite has it. It answers "which src/ and hooks/
# files did this suite actually RUN" — not which ones it mentions — by recording every
# `node`, `bash`, `python3` and `ai` the suite's shell spawns. tests/tools/census.mjs reads
# the result.
#
# HOW: four shell FUNCTIONS shadow the commands. Each appends one tab-separated line
#   <suite basename> TAB <command word> TAB <target>
# with a builtin printf, then runs the real binary with `command`. A file-based PATH shim was
# measured first and costs 3.6 ms per spawn (an extra exec); a function costs no exec at all.
#
# WHEN: only when REIN_TEST_TMPDIR is set (tests/run.sh exports it: the per-run temp path,
# test-harness rule 6). Otherwise the functions are a pure pass-through. Nothing is written
# anywhere else — never under ~/.rein.
#
# THE CONTRACT — a suite must not be able to tell the functions are there:
#   - exit status, stdin, stdout and stderr are the real binary's (the function's last
#     command IS the binary; the record line goes to the log file only);
#   - `set -e`, `||`/`&&`, `if`, pipelines and PIPESTATUS behave as for the binary;
#   - `VAR=x node …` still exports VAR to node only (bash scopes prefix assignments to a
#     function call and the commands it runs);
#   - `command -v node` still prints the PATH of node (see the `command` shim below).
#
# WHAT IT DOES NOT SEE (documented, accepted):
#   - `exec node …`, `env node …`, `xargs node`, `timeout node`, `nohup node`: those resolve
#     the binary themselves, never through a shell function;
#   - a script run by path (`"$REPO/src/bin/ai" …`, `./hook.sh`): not a command word we own
#     — the census adds the suite's STATIC src/ and hooks/ references for exactly this;
#   - spawns made by a child process (functions are not exported, deliberately: exporting
#     them would change what a hook under test runs).
#   - `node x &` puts a bash subshell between `$!` and node. No suite kills such a `$!`
#     today (they `wait` on it); test_bg in assert.sh bypasses the function for this reason.
# WHAT A SUITE COULD STILL NOTICE (none does today; grep before relying on one):
#   - `type node` / `declare -F` report a function;
#   - a MISSING binary's "command not found" line names footprint.sh, not the suite (the exit
#     status is still 127);
#   - an inline program naming src/ or hooks/ overwrites BASH_REMATCH (see below).
# The first field is the spawning script's name, for reading the log by hand; tests/run.sh
# attributes every line to the suite it was running, whatever script wrote it.
#
# bash 3.2 note: `builtin command node` is NOT used anywhere here. Under bash 3.2 it ignores
# the errexit suppression of `||`/`if` (`builtin command false || echo x` exits a `set -e`
# script), which would change suite behaviour. Plain `command` does not have the bug.

# Repository root, both spellings: a CI worktree lives under /var/… which is /private/var/…
# (E-265), and suites build paths both ways.
_REIN_FP_ROOT="$(cd "${BASH_SOURCE[0]%/*}/../.." 2>/dev/null && pwd)"
_REIN_FP_ROOTP="$(cd "${BASH_SOURCE[0]%/*}/../.." 2>/dev/null && pwd -P)"
_REIN_FP_SUITE="${0##*/}"
_REIN_FP_HOME0="${HOME:-}"   # E-312: the HOME this suite was started with (in a lane, its clone)
_REIN_FP_RE='(src|hooks)/[A-Za-z0-9_./-]+'
# E-311: an installer run inside a `bash -c` program — only in COMMAND POSITION (start of the
# program or after ; & | ( or a newline, past any VAR=value prefixes and an optional `env …`),
# so `echo "run: bash install-rein.sh"` or `grep -q 'ai init'` is not a run (ai_ci_gate's
# pasted stub prints the former).
_REIN_FP_CMD='(^|[;&|(]|'$'\n'')[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*'
_REIN_FP_INST_RE="${_REIN_FP_CMD}(env[[:space:]]+([^;&|]*[[:space:]])?)?(bash|sh)[[:space:]][^;&|]*install-rein\.sh"
# E-312: a `HOME=<value>` assignment in a -c program (bare, "double" or 'single' quoted).
_REIN_FP_HOME_RE='(^|[[:space:];&|(])HOME=("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:];&|]+)'
_REIN_FP_INIT_RE="${_REIN_FP_CMD}((env|bash)[[:space:]]+([^;&|]*[[:space:]])?)?['\"]?[^[:space:];&|'\"]*ai['\"]?[[:space:]]+init([[:space:];&|>)]|\$)"
# _rein_fp_home_class <path> → where an installer / `ai init` spawn's HOME lives (E-312, D-093):
#   tmp      a temp dir carrying the harness prefix (test_tmpdir, mktemp …rein-t-…) — one per
#            suite, so lanes never share it
#   run      the HOME the suite started with — a lane's own clone under CI, shared otherwise
#   unknown  the HOME is only text in a -c program (an unexpanded "$VAR"), or none at all
#   foreign:<path>  anything else — shared by every lane, so the suite stays exclusive
_rein_fp_home_class() {
  local h="$1" pre="${REIN_TEST_TMP_PREFIX:-rein-t-}"
  case "$h" in
    "") printf 'unknown' ;;   # no HOME at all (env -i / -u HOME)
    *'$'*|*'`'*) printf 'unknown' ;;
    # The suite's own HOME first: a lane's HOME clone lives INSIDE the run's rein-test.* dir.
    "$_REIN_FP_HOME0") printf 'run' ;;
    */"$pre"*|*/rein-t-*|*/rein-test.*) printf 'tmp' ;;
    *) printf 'foreign:%s' "$h" ;;
  esac
}

_rein_fp_record() {
  [[ -n "${REIN_TEST_TMPDIR:-}" ]] || return 0
  local _c="$1" _a="" _p _code=""
  shift
  # The target is the first non-option argument. An inline program (-e/-p/--eval for node,
  # -c for bash/python3) is recorded as the flag plus the first src/ or hooks/ path its text
  # names, so `node -e "import … from '$REPO/src/shared/x.mjs'"` is attributed to x.mjs.
  while [[ $# -gt 0 ]]; do
    _p="$1"; shift
    case "$_p" in
      -e|-p|--eval|--print|-c) _a="$_p"; _code="${1-}"; break ;;
      -m) _a="-m ${1-}"; break ;;
      -) _a="-"; break ;;
      -*) continue ;;
      *) _a="$_p"; break ;;
    esac
  done
  if [[ -n "$_code" ]]; then
    # `=~`, not `${code#*src/}`: bash 3.2 matches `#*pat` / `%%pat*` in quadratic time —
    # 38 ms on a 5 KB inline program, measured — while the regex is linear (~0.1 ms).
    # The cost: BASH_REMATCH is overwritten, and bash 3.2 makes it read-only, so it cannot be
    # restored. No suite, and no src/ library a suite sources, reads BASH_REMATCH across a
    # spawn (grep -rn BASH_REMATCH tests/ src/ hooks/ when changing this). The glob pre-check
    # skips the regex (and the clobber) for the common program that names no path.
    case "$_code" in
      *src/*|*hooks/*)
        [[ "$_code" =~ $_REIN_FP_RE ]] && _a="${_a}:${BASH_REMATCH[0]}" ;;
    esac
  else
    case "$_a" in
      "$_REIN_FP_ROOT"/src/*|"$_REIN_FP_ROOT"/hooks/*|"$_REIN_FP_ROOT"/tests/lib/*)
        _a="${_a#"$_REIN_FP_ROOT"/}" ;;
      "$_REIN_FP_ROOTP"/src/*|"$_REIN_FP_ROOTP"/hooks/*|"$_REIN_FP_ROOTP"/tests/lib/*)
        _a="${_a#"$_REIN_FP_ROOTP"/}" ;;
      ./*) _a="${_a#./}" ;;
    esac
  fi
  # E-311 (D-092): an installer run gets its own "installer" line, whichever way it was spawned
  # — `bash <path>/install-rein.sh`, `bash "$AI_BIN" init`, or inside a `bash -c` program —
  # so the census lists every suite that runs the installer or `ai init`, not only the ones a
  # path-shaped target happens to reveal. $1 is the argument after the target here.
  local _inst=""
  if [[ -n "$_code" ]]; then
    if [[ "$_c" == bash ]]; then
      case "$_code" in
        *install-rein.sh*) [[ "$_code" =~ $_REIN_FP_INST_RE ]] && _inst="install-rein.sh" ;;
      esac
      case "$_code" in
        *init*) [[ -z "$_inst" && "$_code" =~ $_REIN_FP_INIT_RE ]] && _inst="ai init" ;;
      esac
    fi
  else
    case "$_a" in
      *install-rein.sh) _inst="install-rein.sh" ;;
      ai|*/ai) [[ "${1-}" == init ]] && _inst="ai init" ;;
    esac
    [[ "$_c" == ai && "$_a" == init ]] && _inst="ai init"
  fi
  # One line per spawn: a tab or newline inside the target would forge a second field/line.
  case "$_a" in *$'\t'*|*$'\n'*) _a="<inline>" ;; esac
  printf '%s\t%s\t%s\n' "$_REIN_FP_SUITE" "$_c" "$_a" 2>/dev/null >> "${REIN_TEST_TMPDIR}/footprint.log" || :
  if [[ -n "$_inst" ]]; then
    # E-312: the spawn's HOME — an env/prefix assignment (_rein_fp_env passes it), else a
    # `HOME=` assignment in the -c program, else the HOME in force here.
    local _home="${_REIN_FP_SPAWN_HOME-$HOME}"
    if [[ -n "$_code" && "$_code" =~ $_REIN_FP_HOME_RE ]]; then
      _home="${BASH_REMATCH[2]}"; _home="${_home#[\"\']}"; _home="${_home%[\"\']}"
    fi
    _home="$(_rein_fp_home_class "$_home")"
    case "$_home" in *$'\t'*|*$'\n'*) _home="foreign:<inline>" ;; esac
    printf '%s\tinstaller\t%s\t%s\n' "$_REIN_FP_SUITE" "$_inst" "$_home" 2>/dev/null >> "${REIN_TEST_TMPDIR}/footprint.log" || :
  fi
  return 0
}

# E-311: `env … node|bash|python3|ai <args>` resolves the binary itself, so the wrappers never
# saw it (exec_form_hooks ran the installer that way, invisibly). This walks env's own options
# and assignments to the command word and records it as if it had been spawned directly.
_rein_fp_env() {
  [[ -n "${REIN_TEST_TMPDIR:-}" ]] || return 0
  local _REIN_FP_SPAWN_HOME="$HOME"   # E-312: what the spawned command will see as HOME
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -u) [[ "${2-}" == HOME ]] && _REIN_FP_SPAWN_HOME=""; shift 2 ;;
      -i|-) _REIN_FP_SPAWN_HOME=""; shift ;;
      -P|-S|-C) shift 2 ;;
      HOME=*) _REIN_FP_SPAWN_HOME="${1#HOME=}"; shift ;;
      -*|*=*) shift ;;
      *) break ;;
    esac
  done
  case "${1-}" in
    node|*/node|bash|*/bash|python3|*/python3|ai|*/ai)
      local _w="${1##*/}"; shift; _rein_fp_record "$_w" "$@" ;;
  esac
  return 0
}

_rein_fp_def_wrappers() {
  node()    { _rein_fp_record node "$@";    command node "$@"; }
  bash()    { _rein_fp_record bash "$@";    command bash "$@"; }
  python3() { _rein_fp_record python3 "$@"; command python3 "$@"; }
  ai()      { _rein_fp_record ai "$@";      command ai "$@"; }
  env()     { _rein_fp_env "$@";            command env "$@"; }
}

# ── The `command` shim ──────────────────────────────────────────────────────
# Once `node` is a function, `command -v node` prints "node" instead of /path/to/node, and
# suites (and src/ libraries they source) build PATHs and realpaths from it.
#
# Every form must reach the real builtin WITHOUT `builtin command` (the bash 3.2 errexit
# bug above), so the shim steps aside for the one call: it removes itself (and, for a
# lookup, the wrappers — so the builtin answers exactly as if they had never existed,
# including a `PATH=… command -v node` that must miss), runs `command`, and puts them back.
# If that call exits the shell (set -e), the shell is gone and nothing needed restoring.
_rein_fp_def_command() {
  command() {
    local _rc
    case "${1-}" in
      -v|-V)
        unset -f command node bash python3 ai env
        command "$@"; _rc=$?
        _rein_fp_def_wrappers ;;
      *)
        unset -f command
        command "$@"; _rc=$? ;;
    esac
    _rein_fp_def_command
    return "$_rc"
  }
}
_rein_fp_def_wrappers
_rein_fp_def_command
