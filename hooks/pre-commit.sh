#!/usr/bin/env bash
# Rein Gate 2 — Quality Gate (pre-commit hook)
# Logic: the lane, machine-local file and publish checks only (D-170 r4): machine-local files,
#        the privacy scan (its secret class in every project, D-172 r3), record parity for a
#        team project (team mode, r7) and the Architect's git lane, each with its own message.
#        E-467 removed the conflict-marker and .ai/*.json gate, markdown sync, the co-modification
#        warning, registry drift, MCP stdout purity and the standards gate.
# E-464 (D-169 r8, D-170 r9): no review stamp is asked for here. Review is sized by tier and is
#        checked when the task closes (src/shared/completion-gates.mjs); `rein review <tier>`
#        names the agents to dispatch.
# Install: rein init copies this to .git/hooks/pre-commit in the project repo.

# ── E-292 (D-082 r2): an ABORTED gate is a BLOCKED call ─────────────────────────────
# git blocks on any non-zero exit, but an abort (unbound variable = 1, syntax error = 258)
# must SAY so instead of reading like a policy refusal. Inline string on the first
# executable line (builtins only; the prologue's `unset -f` cannot delete it). A deliberate
# exit is `exit` with this hook's own codes (0 allow, 1 block); anything else is an abort and
# exits 2 with one line. The hook's ONLY EXIT trap — a later one must chain to it.
trap '_rein_rc=$?; trap - EXIT; case "$_rein_rc:$BASH_COMMAND" in 0:*|1:exit|1:exit[[:space:]]*) exit "$_rein_rc" ;; esac; printf "[GATE_INTERNAL_ERROR] pre-commit aborted (rc %s near line %s) — run: rein doctor\n" "$_rein_rc" "$LINENO" >&2; exit 2' EXIT
trap 'trap "" PIPE; printf "[GATE_INTERNAL_ERROR] pre-commit interrupted by a signal — run: rein doctor\n" >&2; exit 2' TERM HUP INT PIPE
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
# names the USER's repository, not the Rein install: any project carrying a file at that
# path had it executed from inside this hook — cloning a repo was enough to run its code.
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

AI_DIR="$(git rev-parse --show-toplevel 2>/dev/null)/.ai"

# Not a Rein project — skip gate entirely
[[ -d "$AI_DIR" ]] || exit 0

# ── E-448 (D-165): machine-local generated files never travel (BLOCKING, every Rein project) ──
# r2: a staged add or modify of a path on shared/machine-local.list is refused (the list is the
# one copy — r1); a staged DELETION passes: it is the fix. r3: a staged blob under .claude/ or a
# staged .mcp.json holding the literal "$HOME/" is refused; no other path is scanned. r4: no
# opt-out. Fail closed: without the list nothing can be judged, so the commit is refused.
_machine_local_gate() {
  local list path st bad=0 hit q
  # Install mirror first, then this hook's own tree (as the toolchain-pin bootstrap above) —
  # never the visited repo (E-223).
  list="$(rein_locate shared/machine-local.list 2>/dev/null || true)"
  [[ -z "$list" && -f "${BASH_SOURCE[0]%/*}/../src/shared/machine-local.list" ]] && list="${BASH_SOURCE[0]%/*}/../src/shared/machine-local.list"
  if [[ -z "$list" ]]; then
    echo "[COMMIT_BLOCKED] [MACHINE_LOCAL] shared/machine-local.list unavailable — run: bash install-rein.sh" >&2
    return 1
  fi
  local -a local_paths=()
  while IFS= read -r path; do
    [[ -z "$path" || "$path" == \#* ]] && continue
    local_paths+=("$path")
  done < "$list"
  while IFS= read -r -d '' st && IFS= read -r -d '' path; do
    [[ "$st" == D ]] && continue
    # E-454 (D-167 r15): the path is printed through %q, so a newline in it stays on one line.
    printf -v q '%q' "$path"
    for hit in "${local_paths[@]}"; do
      if [[ "$path" == "$hit" ]]; then
        echo "[COMMIT_BLOCKED] [MACHINE_LOCAL] ${q} is generated for this machine and never committed — run: git rm --cached ${q}" >&2
        bad=1
      fi
    done
    if [[ -n "${HOME:-}" && "$HOME" != "/" ]] && [[ "$path" == .claude/* || "$path" == .mcp.json ]]; then
      if grep -qF -- "${HOME}/" < <(git show ":${path}" 2>/dev/null); then
        echo "[COMMIT_BLOCKED] [MACHINE_LOCAL] ${q} contains this machine's home directory as a path — remove it before committing" >&2
        bad=1
      fi
    fi
  done < <(git diff --cached --name-status --no-renames -z)
  return "$bad"
}
_machine_local_gate || exit 1

# ── E-378 (D-129 §Component 9): the public repository's privacy gate (BLOCKING) ──
# .ai/publish.json marks the public repository. Every staged file is scanned (five classes with
# the operator's list, the structural ones without it) and, on the operator's machine, the
# commit identity must be the public one. Fail closed: no helper or no node refuses. No
# opt-out: an env switch is the project's switch (E-291), so it sits outside the E-238 one.
# Active when the work tree, the index or HEAD carries the marker: deleting it from the work
# tree does not turn the gate off, and staging its deletion is refused by the gate itself.
if [[ -f "${AI_DIR}/publish.json" ]] || git cat-file -e :.ai/publish.json 2>/dev/null || git cat-file -e HEAD:.ai/publish.json 2>/dev/null; then
  _e378_ps="$(rein_locate shared/publish-scan.mjs 2>/dev/null || true)"
  if [[ -z "$_e378_ps" ]] || ! command -v node >/dev/null 2>&1; then
    echo "[COMMIT_BLOCKED] [PUBLISH_GATE] shared/publish-scan.mjs or node unavailable — run: bash install-rein.sh" >&2
    exit 1
  fi
  # The helper must say [PRIVACY_GATE_OK]: an older helper without this subcommand, or one that
  # ran nothing, exits without it and is a refusal (security_engineer E-378 P0-3).
  _e378_out="$(node --no-warnings "$_e378_ps" precommit "${AI_DIR%/.ai}")" || exit 1
  if [[ "$_e378_out" != "[PRIVACY_GATE_OK]"* ]]; then
    echo "[COMMIT_BLOCKED] [PUBLISH_GATE] the privacy gate gave no verdict — run: bash install-rein.sh" >&2
    exit 1
  fi
  echo "  ✓ privacy gate: staged files clean, public identity"
fi

# ── E-326 (D-102 §Component 2): record ↔ index parity for a team project (BLOCKING) ──
# A team project's views are generated and untracked, so the checks below have nothing to
# say about it; what must hold is that every task record file agrees with state.sqlite.
# After a pull the post-merge hook has already imported them; when it has not (hooks not
# installed, REIN_STATE_IMPORT=0) the commit stops and names the one command that fixes it.
check_record_parity() {
  local cs out
  cs="$(rein_locate shared/cli-state.mjs || true)"
  if [[ -z "$cs" ]] || ! command -v node >/dev/null 2>&1; then
    echo "[Rein GATE 2] team project but cli-state.mjs (or node) is missing — run: bash install-rein.sh" >&2
    exit 1   # fail closed: a gate whose helper is missing does not wave commits through
  fi
  if ! out="$(cd "${AI_DIR%/.ai}" && node --no-warnings "$cs" state parity 2>&1)"; then
    printf '\n[Rein GATE 2] SYNC GATE — COMMIT BLOCKED\n%s\n\n' "$out" >&2
    exit 1
  fi
}


# A team project: every task record file agrees with state.sqlite (team mode, D-170 r7).
if [[ -f "${AI_DIR}/project.json" ]]; then check_record_parity; fi

# ── E-214: Architect-scoped Git Lane (architect-provider-parity.md §Git Lane) ──
# The Architect HAS git — so the D-053 proxy-commit workaround (the Engineer commits the
# Architect's .ai/ edits) is no longer needed. The ruling: an Architect may commit ONLY when every staged path is under
# .ai/ or plans/. Anything else is implementation work and belongs to the Engineer.
#
# ROLE RESOLUTION — E-294 (D-087 r5, sovereignty-hardening.md Component 8g). A git hook gets
# no PreToolUse payload. Two sources, in order (E-463 retired the session token with the gate):
#   1. A live launch record on THIS process's ancestor chain (launch-record.py walk) →
#      `chain:<most restricted role>`. Restrict-only, and it needs no environment at all.
#   2. The advisory env (restrict-only), then `engineer` — the operator's own terminal (no
#      session id, no record) keeps today's behaviour.
#
# Residual (D-087 r3): REIN_SKIP_GIT_LANE=1 skips the lane — same strength as --no-verify
# (D-081 r5) — and says so on stderr.
# Prints "<source>:<role>" (chain | union | env), then a TAB and the walk's reason when the
# source is union (E-471): a fail-closed fallback must not read as a real Architect.
#
# It PRINTS both rather than setting a global: the caller invokes this in a command
# substitution, so any variable assigned inside is set in the SUBSHELL and lost.
# The path-scope BLOCK may act on any source — restricting is safe in the strict direction.
_resolve_commit_role() {
  if [[ "${REIN_SKIP_GIT_LANE:-0}" == "1" ]]; then
    echo "[GATE_SKIPPED] REIN_SKIP_GIT_LANE=1 — Architect git lane skipped for this commit (D-087 r3 residual)" >&2
    printf 'env:engineer'; return 0
  fi

  local lr line

  # 1. A live launch record on this process chain — most restricted wins, restrict-only.
  # `role` is the walk as one hook line (E-463): "<role>\t<record|unverified>" or
  # "union\t<why>". A role with no record ("unverified") falls through to the env.
  lr="$(rein_locate shared/launch-record.py || true)"
  if [[ -n "$lr" ]] && command -v python3 >/dev/null 2>&1; then
    line="$(python3 -I "$lr" role 2>/dev/null)"
    case "$line" in
      union$'\t'*|union) [[ "$line" == union ]] && line=$'union\t'
                                printf 'union:architect\t%s' "${line#union$'\t'}"; return 0 ;;
      architect$'\t'record) printf 'chain:architect'; return 0 ;;
      engineer$'\t'record)  printf 'chain:engineer';  return 0 ;;
    esac
  fi

  # 2. Advisory env (restrict-only), then the default — unchanged Engineer behaviour.
  # Normalised like the lane's own comparison (E-214.10h): `Architect` or `architect ` restricts too.
  local _pr _cr
  _pr="$(printf '%s' "${REIN_PANE_ROLE:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  _cr="$(printf '%s' "${REIN_CALLER_ROLE:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if [[ "$_pr" == "architect" || "$_cr" == "architect" ]]; then
    printf 'env:architect'; return 0
  fi
  printf 'env:engineer'
}

# The walk's reason, fit to print (E-471): it comes from another program's output, so it is one
# line, with no control characters (C0, DEL, C1 as UTF-8) and at most 160 characters. The C1
# removal loops: one pass would rejoin `\xc2\xc2\x9b\x9b` into a C1 (F-471-1).
_lane_why() {
  local w
  w="$(printf '%s' "$1" | LC_ALL=C tr '\n\r\t' '   ' | LC_ALL=C tr -d '\000-\037\177' \
       | LC_ALL=C sed -e ':a' -e $'s/\xc2[\x80-\x9f]//' -e 'ta' -e 's/  */ /g' -e 's/^ //' -e 's/ $//')" || w=""
  printf '%s' "${w:0:160}"
}

check_architect_git_lane() {
  local resolved; resolved="$(_resolve_commit_role)"
  local why=""
  if [[ "$resolved" == *$'\t'* ]]; then
    why="$(_lane_why "${resolved#*$'\t'}")"
    resolved="${resolved%%$'\t'*}"
  fi
  local ROLE_SOURCE="${resolved%%:*}"
  local role="${resolved#*:}"
  # Normalize before comparing: an exact match meant `Architect` or a trailing space
  # silently DISABLED the lane for a real Architect. (A silently un-laned Architect is
  # exactly the drift this check exists to catch.)
  role="$(printf '%s' "$role" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  [[ "$role" == "architect" ]] || return 0

  # Every staged path must be under .ai/ or plans/. --name-status is used (rather than
  # --name-only) so a RENAME's BOTH sides are checked: moving a file OUT of .ai/ is
  # exactly the escape a name-only check would miss.
  # FAIL CLOSED on a broken diff. Reading straight from a process substitution meant
  # git's exit status was never seen: a failed `git diff` produced ZERO records, the
  # out-of-scope list stayed empty, and the lane passed — so any diff hiccup silently
  # let arbitrary staged content through. Proven with a stubbed non-zero `git diff`.
  # An error must BLOCK, never allow.
  local records
  if ! records="$(git diff --cached --name-status -M 2>/dev/null)"; then
    {
      echo ""
      echo "[GIT_LANE] Could not read the staged file list (git diff failed)."
      echo "Blocking rather than assuming the commit is in scope (fail-closed)."
      echo "Rollback (only if you are certain): REIN_SKIP_GIT_LANE=1 git commit ..."
    } >&2
    exit 1
  fi

  # Nothing staged: nothing to restrict.
  [[ -z "$records" ]] && return 0

  local out_of_scope="" classified=0
  while IFS=$'\t' read -r _status path1 path2 rest; do
    [[ -z "${_status:-}" ]] && continue
    # `read` folds every EXTRA tab field into the last variable, so a 4-field record
    # would hide a path inside path2 — `.ai/b<TAB>src/c` matches the .ai/* arm and the
    # src/ path is never classified, while the counter still reports progress. git's
    # --name-status emits at most 3 fields today (renames/copies), so this is not
    # reachable from git — but an unexpected shape is exactly what this loop must not
    # wave through, and the counter cannot catch it because it counts fields, not paths.
    if [[ -n "${rest:-}" ]]; then
      echo "[GIT_LANE] Unexpected diff record shape — blocking (fail-closed)." >&2
      exit 1
    fi
    local p
    for p in "$path1" "$path2"; do
      [[ -z "$p" ]] && continue
      classified=$((classified + 1))
      case "$p" in
        # NOTE: no bare `.ai` / `plans` arms. Git emits a bare entry only when the
        # path is NOT a directory — i.e. .ai/ was replaced by a file or a symlink,
        # which stages the deletion of every .ai/ file at once. That is precisely the
        # change that must NOT ride through the lane.
        .ai/*|plans/*) ;;
        *) out_of_scope="${out_of_scope}  ${p}"$'\n' ;;
      esac
    done
  done <<< "$records"

  # Belt-and-braces: records were present but nothing was classified (an unexpected
  # diff shape). Never pass an unparsed diff.
  if [[ "$classified" -eq 0 ]]; then
    echo "[GIT_LANE] Staged changes could not be classified — blocking (fail-closed)." >&2
    exit 1
  fi

  if [[ -n "$out_of_scope" ]]; then
    {
      echo ""
      echo "╔══════════════════════════════════════════════════════════════════════════╗"
      echo "║  [SOVEREIGNTY_BLOCK] ARCHITECT GIT LANE — COMMIT BLOCKED                 ║"
      echo "╚══════════════════════════════════════════════════════════════════════════╝"
      echo ""
      if [[ "$ROLE_SOURCE" == "union" ]]; then
        echo "Session role: architect (source: union${why:+ — ${why}})."
        echo "A launch record could not be trusted, so the lane fails closed to architect. If the record"
        echo "is for another project, relaunch with \`rein pane <role>\` from the repo you are committing in."
      else
        echo "Session role: architect (source: ${ROLE_SOURCE})."
      fi
      echo "An Architect may commit only paths under .ai/ or plans/."
      echo "These staged paths are outside that scope:"
      echo ""
      printf '%s' "$out_of_scope"
      echo ""
      echo "The Architect designs; the Engineer implements (§35 ANTI-DRIFT, D-054)."
      echo "Hand the change list to the Engineer:  rein handoff --to engineer --file <entry> (then SendMessage the wake line, D-099)"
      echo "Then unstage the out-of-scope paths:   git restore --staged <path>"
      echo ""
      echo "Rollback (only if you are certain): REIN_SKIP_GIT_LANE=1 git commit ..."
    } >&2
    exit 1
  fi

  # In scope. Every gate above has already run (machine-local files and the privacy scan).
  echo "[ARCHITECT_LANE] All staged paths are within .ai//plans/ (role source: ${ROLE_SOURCE})." >&2
}

check_architect_git_lane

# D-172 r3 (round F4): without .ai/publish.json, the scan's `secret` class (vendor token, private key)
# still runs — last, so a lane refusal keeps its message. No opt-out (fake-token mark). Fails closed.
if [[ ! -f "${AI_DIR}/publish.json" ]] && ! git cat-file -e :.ai/publish.json 2>/dev/null && ! git cat-file -e HEAD:.ai/publish.json 2>/dev/null; then
  _sec_ps="$(rein_locate shared/publish-scan.mjs 2>/dev/null || true)"
  if [[ -z "$_sec_ps" ]] || ! command -v node >/dev/null 2>&1; then
    echo "[COMMIT_BLOCKED] [SECRET_SCAN] shared/publish-scan.mjs or node unavailable — run: bash install-rein.sh" >&2
    exit 1
  fi
  _sec_out="$(node --no-warnings "$_sec_ps" secrets "${AI_DIR%/.ai}")" || exit 1
  if [[ "$_sec_out" != "[SECRET_SCAN_OK]"* ]]; then
    echo "[COMMIT_BLOCKED] [SECRET_SCAN] the secret check gave no verdict — run: bash install-rein.sh" >&2
    exit 1
  fi
fi

# ── E-464 (D-169 r8, D-170 r9): no review stamp at commit time ───────────────────────────
# Gate 2 used to refuse a commit without a [CRITIC_STAMP] for its parent HEAD (E-329). Review is
# now sized by tier and checked when the task closes (src/shared/completion-gates.mjs:
# [REVIEW_GATE], [ACCEPT_GATE], [SEC_GATE]); every deterministic check above has passed.
exit 0
