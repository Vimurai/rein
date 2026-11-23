#!/usr/bin/env bash
# Rein Gate 2 — Quality Gate (pre-commit hook)
# Logic: the deterministic checks only — conflict markers and .ai/*.json, machine-local files,
#        the privacy scan, record parity, markdown sync, registry drift, MCP stdout purity, the
#        engineering standards (secrets included) and the Architect's git lane. Each blocks with
#        its own message.
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

AI_DIR="$(git rev-parse --show-toplevel 2>/dev/null)/.ai"

# Not a Rein project — skip gate entirely
[[ -d "$AI_DIR" ]] || exit 0

# ── E-238 (D-062): conflict-marker + .ai/*.json parse gate ───────────────────
#
# On 2026-09-09 a conflicted `git stash pop` left conflict markers inside
# .ai/state.json. Git reported the conflict; the file was staged and committed to master
# unread (44243bc). Master carried INVALID JSON for four commits, and every task read goes
# through that file. Two cheap, deterministic checks would have stopped it.
#
# MATCHING IS ANCHORED AT LINE START, and that is the whole difficulty. This repository's
# own prose QUOTES these markers — .ai/DECISIONS.md documents the gate using them inside
# backticks — so a substring search would make the gate reject the document describing it.
# That is the same trap E-224 hit when a P0 blocked the Architect's text for quoting the
# example it was defining.
#
# `=======` is deliberately NOT sufficient on its own: exactly seven '=' at line start is
# also a valid Markdown setext H2 underline. It counts only in a file that ALSO carries an
# unambiguous `<<<<<<< ` or `>>>>>>> ` marker. Rejecting on it alone would fail any
# document that happens to underline a heading.
_conflict_marker_gate() {
  local staged f bad=0
  staged="$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null)"
  [[ -z "$staged" ]] && return 0

  while IFS= read -r f; do
    [[ -z "$f" || ! -f "$f" ]] && continue
    # Binary files have no lines to inspect and grep would be noise.
    if ! grep < <(git diff --cached --numstat -- "$f" 2>/dev/null) -qv '^-'; then
      continue
    fi
    # The unambiguous halves: 7 markers followed by a space+label, or alone on the line.
    if grep -nE '^(<<<<<<<|>>>>>>>)( .*)?$' -- "$f" >/dev/null 2>&1; then
      echo "  ✗ ${f}: contains a git conflict marker at line start" >&2
      grep -nE '^(<<<<<<<|>>>>>>>)( .*)?$' -- "$f" 2>/dev/null | head -3 | sed 's/^/      /' >&2
      bad=1
    fi
  done <<< "$staged"

  if [[ "$bad" -eq 1 ]]; then
    echo "" >&2
    echo "  A conflicted merge/rebase/stash was staged without being resolved." >&2
    echo "  Open each file above, resolve it, and stage the NAMED paths (not 'git add -A')." >&2
    echo "  D-062: move bookkeeping between branches by commit + cherry-pick, never stash." >&2
    echo "  Rollback (only if you are certain): REIN_SKIP_CONFLICT_GATE=1" >&2
    return 1
  fi
  return 0
}

# A staged .ai/*.json that does not parse is the specific damage D-062 was ruled over:
# state.json is the store every task read goes through, and a fresh clone fails outright.
_ai_json_parse_gate() {
  command -v python3 >/dev/null 2>&1 || return 0
  local staged f bad=0
  staged="$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep -E '^\.ai/.*\.json$' || true)"
  [[ -z "$staged" ]] && return 0

  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    # Read the STAGED blob, not the worktree file: what is being committed is what matters,
    # and the two differ whenever only part of a file is staged.
    if ! git show ":${f}" 2>/dev/null | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
      echo "  ✗ ${f}: staged content is not valid JSON" >&2
      git show ":${f}" 2>/dev/null | python3 -c 'import json,sys
try:
    json.load(sys.stdin)
except Exception as e:
    print("      " + str(e))' 2>/dev/null >&2
      bad=1
    fi
  done <<< "$staged"

  if [[ "$bad" -eq 1 ]]; then
    echo "" >&2
    echo "  .ai/*.json is machine state — an unparseable file breaks every task read and" >&2
    echo "  fails a fresh clone outright (D-062; master carried invalid JSON for 4 commits)." >&2
    echo "  Rollback (only if you are certain): REIN_SKIP_CONFLICT_GATE=1" >&2
    return 1
  fi
  return 0
}

if [[ "${REIN_SKIP_CONFLICT_GATE:-0}" != "1" ]]; then
  echo "Conflict-marker + .ai JSON gate (E-238)..."
  _cm_ok=0
  _conflict_marker_gate || _cm_ok=1
  _ai_json_parse_gate   || _cm_ok=1
  if [[ "$_cm_ok" -ne 0 ]]; then
    echo "[COMMIT_BLOCKED] E-238 gate" >&2
    exit 1
  fi
  echo "  ✓ no conflict markers; staged .ai/*.json parses"
else
  # D-087 r3: a kept opt-out is a recorded residual, and it is LOUD when honoured.
  echo "[GATE_SKIPPED] REIN_SKIP_CONFLICT_GATE=1 — conflict-marker + .ai JSON gate (E-238) skipped for this commit" >&2
fi

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

# ── E-96: Markdown-as-Read-Only sync check (BLOCKING) ────────────────────────
check_markdown_sync() {
  local SQLITE_FILE="${AI_DIR}/state.sqlite"
  local TASKS_FILE="${AI_DIR}/TASKS.md"
  if [[ -f "${AI_DIR}/project.json" ]]; then check_record_parity; return 0; fi
  [[ -f "$TASKS_FILE" ]] || return 0  # skip if TASKS.md missing

  # Check 1: Verify TASKS.md has the generated header (indicates it wasn't hand-edited)
  if ! grep < <(head -1 "$TASKS_FILE" 2>/dev/null) -q "Generated from state.json"; then
    cat >&2 <<'SYNC_BLOCK'

╔══════════════════════════════════════════════════════════════════════════╗
║  Rein GATE 2: SYNC GATE — COMMIT BLOCKED                              ║
╠══════════════════════════════════════════════════════════════════════════╣
║  TASKS.md is missing the generated header.                              ║
║  It may have been hand-edited, violating the Read-Only contract.        ║
║                                                                          ║
║  Fix: run `rein migrate-state --force` to regenerate TASKS.md from        ║
║       state.json, then re-stage and commit.                              ║
╚══════════════════════════════════════════════════════════════════════════╝

SYNC_BLOCK
    exit 1
  fi

  # Check 2 (P-30, the ±2 task-count comparison) was removed by E-326 (D-102): after a pull
  # the tracked TASKS.md legitimately runs ahead of the local index, so the count blocked
  # every commit that followed a pull adding three tasks. Team projects check parity above.
  if [[ -f "$SQLITE_FILE" ]] && command -v sqlite3 &>/dev/null; then
    local STATE_STAMPS
    STATE_STAMPS=$(sqlite3 "$SQLITE_FILE" "SELECT COUNT(*) FROM stamps" 2>/dev/null || echo 0)

    # Check 3 (E-100): REVIEWS.md header check — only when state.json has stamps
    if [[ "$STATE_STAMPS" -gt 0 ]]; then
      local REVIEWS_FILE="${AI_DIR}/REVIEWS.md"
      if [[ -f "$REVIEWS_FILE" ]]; then
        if ! grep < <(head -1 "$REVIEWS_FILE" 2>/dev/null) -q "Generated from state.json"; then
          cat >&2 <<'REVIEWS_BLOCK'

╔══════════════════════════════════════════════════════════════════════════╗
║  Rein GATE 2: SYNC GATE — COMMIT BLOCKED                              ║
╠══════════════════════════════════════════════════════════════════════════╣
║  REVIEWS.md is missing the generated header but state.json has stamps.  ║
║  REVIEWS.md may have been hand-edited, violating the Read-Only contract.║
║                                                                          ║
║  Fix: regenerate REVIEWS.md via task-synchronizer-mcp::writeState, or   ║
║       run `rein migrate-state --force` to resync, then re-stage + commit. ║
╚══════════════════════════════════════════════════════════════════════════╝

REVIEWS_BLOCK
          exit 1
        fi

        # Check 4 (E-113): Block if REVIEWS.md has manually-appended sections
        # Generated REVIEWS.md uses only [STAMP] lines — any ## heading signals hand-editing
        if grep -qE "^#{2,}" "$REVIEWS_FILE" 2>/dev/null; then
          cat >&2 <<'APPEND_BLOCK'

╔══════════════════════════════════════════════════════════════════════════╗
║  Rein GATE 2: SYNC GATE — COMMIT BLOCKED                              ║
╠══════════════════════════════════════════════════════════════════════════╣
║  REVIEWS.md has manually-appended sections (## headings detected).      ║
║  D-001: REVIEWS.md is a generated view — direct edits are forbidden.   ║
║                                                                          ║
║  Fix: run `rein migrate-state --force` to regenerate REVIEWS.md from      ║
║       state.json and remove hand-appended content. Then re-stage.       ║
╚══════════════════════════════════════════════════════════════════════════╝

APPEND_BLOCK
          exit 1
        fi
      fi
    fi
  fi
}

check_markdown_sync

# ── E-122: architect.md + src/ co-modification warning (§35) ─────────────────
check_architect_src_comodification() {
  local staged_files
  staged_files=$(git diff --cached --name-only 2>/dev/null)

  local has_src=0 has_architect=0
  while IFS= read -r f; do
    [[ "$f" == src/* ]] && has_src=1
    [[ "$f" == .ai/architect.md ]] && has_architect=1
  done <<< "$staged_files"

  if [[ "$has_src" -eq 1 && "$has_architect" -eq 1 ]]; then
    # Allow if LOG.md staged change contains an implementation delta marker
    local log_staged
    log_staged=$(git diff --cached -- .ai/LOG.md 2>/dev/null)
    if grep -qiE "\[IMPL_DELTA\]|\[APPROVED\]|implementation delta" <<< "$log_staged"; then
      return 0
    fi
    cat >&2 <<'ARCH_WARN'

⚠  Rein GATE 2: ARCHITECT CO-MODIFICATION WARNING
   Both src/ and .ai/architect.md are staged in the same commit.
   This may indicate the Engineer rewrote the blueprint to match flawed logic (§35).

   If intentional, add an [IMPL_DELTA] marker to .ai/LOG.md explaining the
   approved blueprint update, then re-stage LOG.md before committing.

ARCH_WARN
    # Warning only — does not block (exit 0 continues to Gate 2 check)
  fi
}

check_architect_src_comodification

# ── E-33: Registry drift guard ───────────────────────────────────────────────
# Root cause of 2026-04-27 audit: src/config/registry.json gained a new MCP but
# ~/.rein/config/registry.json was never refreshed, so `rein sync` regenerated
# .mcp.json from a stale registry and silently dropped the server.
# Run the targeted drift suite only when registry-relevant files are staged.
check_registry_sync() {
  local staged_files
  staged_files=$(git diff --cached --name-only 2>/dev/null)

  local touches_registry=0
  while IFS= read -r f; do
    case "$f" in
      src/config/registry.json|src/templates/.mcp.json|install-rein.sh|src/bin/rein)
        touches_registry=1
        ;;
    esac
  done <<< "$staged_files"

  [[ "$touches_registry" -eq 0 ]] && return 0

  local repo_root
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
  # E-302: the drift checks moved from tests/suites/registry_sync_test.sh into one file the
  # hook runs and rein_sync_test sources. A project that is not Rein itself has neither.
  local suite="${repo_root}/tests/tools/registry-drift.sh"
  [[ -f "$suite" ]] || return 0  # checker missing — nothing to enforce

  local out
  if ! out=$(bash "$suite" 2>&1); then
    cat >&2 <<REGISTRY_BLOCK

╔══════════════════════════════════════════════════════════════════════════╗
║  Rein GATE 2: REGISTRY DRIFT — COMMIT BLOCKED                         ║
╠══════════════════════════════════════════════════════════════════════════╣
║  registry-drift.sh failed. The local registry, template .mcp.json,      ║
║  or installer is out of sync — shipping this commit would reproduce     ║
║  the 2026-04-27 silent-drop class of regression.                         ║
║                                                                          ║
║  Fix: run \`bash install-rein.sh\` to refresh ~/.rein/config/registry, ║
║       then re-run \`bash tests/tools/registry-drift.sh\` locally.       ║
╚══════════════════════════════════════════════════════════════════════════╝

REGISTRY_BLOCK
    echo "$out" >&2
    exit 1
  fi
}

check_registry_sync

# ── E-48: MCP Stdout Purity Gate ─────────────────────────────────────────────
# Forbids newly added console.log / console.info calls under src/mcp/. Those
# calls would corrupt the JSON-RPC stdout stream MCP clients parse.
# console.error / stderr writes are permitted (shared NDJSON logger).
check_mcp_stdout_purity() {
  local staged_files
  staged_files=$(git diff --cached --name-only --diff-filter=AM 2>/dev/null)
  grep -qE '^src/mcp/.*\.(js|mjs|cjs|ts)$' <<< "$staged_files" || return 0

  local repo_root checker
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
  checker="${repo_root}/tests/lib/mcp_purity_check.sh"
  [[ -f "$checker" ]] || return 0  # checker missing — nothing to enforce

  local out
  if ! out=$(bash "$checker" 2>&1); then
    cat >&2 <<MCP_PURITY_BLOCK

╔══════════════════════════════════════════════════════════════════════════╗
║  Rein GATE 2: MCP STDOUT PURITY — COMMIT BLOCKED                      ║
╠══════════════════════════════════════════════════════════════════════════╣
║  Newly added console.log / console.info found in src/mcp/.              ║
║  MCP servers must keep stdout reserved for JSON-RPC traffic; logging    ║
║  belongs on stderr via the shared NDJSON logger.                        ║
║                                                                          ║
║  Fix: replace with                                                       ║
║      import { createLogger } from "../shared/logger.js";                ║
║      const log = createLogger("my-mcp");                                ║
║      log.info("tool", "message", { extras });                           ║
╚══════════════════════════════════════════════════════════════════════════╝

MCP_PURITY_BLOCK
    echo "$out" >&2
    exit 1
  fi
}

check_mcp_stdout_purity

# ── E-82: Engineering-Standards Gate ────────────────────────────────────────
# Invokes the E-80 standards-checker CLI against the staged diff. The CLI
# encapsulates every rule (file size, mcp stdout purity, secrets, tmp-cruft,
# kebab-case naming, shared-helper reuse) defined in src/shared/standards.json.
#
# Honors the blueprint §Rollback Plan escape hatch: REIN_SKIP_STANDARDS=1
# bypasses the gate (the CLI itself also handles this; we short-circuit
# here to skip the subprocess fork entirely).
#
# Per blueprint §Execution Constraints: this gate runs in <200ms on a
# typical commit; the CLI emits its own perf-warn to stderr if exceeded.
check_standards_gate() {
  # Rollback flag — silent skip (CLI prints its own STANDARDS_SKIPPED notice
  # when invoked with the flag, but we don't need to spawn the subprocess
  # at all if it's set).
  if [[ "${REIN_SKIP_STANDARDS:-0}" == "1" ]]; then
    echo "[GATE_SKIPPED] REIN_SKIP_STANDARDS=1 — engineering-standards gate skipped for this commit (D-087 r3 residual)" >&2
    return 0
  fi

  # Node 22+ baseline (mirrors E-69 installer guard). If absent, skip the
  # gate rather than break commits — degrade gracefully.
  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  local repo_root
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
  [[ -n "$repo_root" ]] || return 0

  # Locator chain (mirrors E-58 / E-65 / E-75 patterns): in-tree → installed.
  local cli=""
  if [[ -f "${repo_root}/scripts/standards.mjs" ]]; then
    cli="${repo_root}/scripts/standards.mjs"
  elif [[ -f "${HOME}/.rein/scripts/standards.mjs" ]]; then
    cli="${HOME}/.rein/scripts/standards.mjs"
  else
    # Pre-E-80 install: gate not yet wired. Skip rather than fail.
    return 0
  fi

  # Run the CLI from the repo root so its `--staged` git query resolves
  # against the actual project.
  local out rc
  out=$(cd "$repo_root" && node "$cli" check --staged 2>&1)
  rc=$?

  if [[ $rc -eq 0 ]]; then
    return 0
  fi

  cat >&2 <<'STANDARDS_BLOCK'

╔══════════════════════════════════════════════════════════════════════════╗
║  Rein GATE 2: ENGINEERING-STANDARDS — COMMIT BLOCKED                  ║
╠══════════════════════════════════════════════════════════════════════════╣
║  scripts/standards.mjs flagged one or more error-severity violations    ║
║  in the staged diff. The full report follows.                            ║
║                                                                          ║
║  Common fixes:                                                           ║
║    • Split files over 1000 lines into focused modules under src/shared/ ║
║    • Replace console.log/info in src/mcp/** with the shared NDJSON      ║
║      logger (src/mcp/shared/logger.js).                                 ║
║    • Remove .tmp / .bak / .swp / .orig editor cruft before staging.    ║
║    • Rename files to kebab-case / camelCase / PascalCase (no            ║
║      Mixed_Snake) for ESM resolver safety.                              ║
║    • Strip leaked secret patterns (AWS / Stripe / Slack / GitHub PATs / ║
║      PRIVATE KEY blocks).                                                ║
║                                                                          ║
║  Rollback (last resort): re-run with REIN_SKIP_STANDARDS=1.            ║
╚══════════════════════════════════════════════════════════════════════════╝

STANDARDS_BLOCK
  echo "$out" >&2
  exit 1
}

check_standards_gate


# ── E-214: Architect-scoped Git Lane (architect-provider-parity.md §Git Lane) ──
# The Architect HAS git — so the D-053 proxy-commit workaround (the Engineer commits the
# Architect's .ai/ edits) is no longer needed. The ruling: an Architect may commit ONLY when every staged path is under
# .ai/ or plans/. Anything else is implementation work and belongs to the Engineer.
#
# ROLE RESOLUTION — E-294 (D-087 r5, sovereignty-hardening.md Component 8g). A git hook gets
# no PreToolUse payload. Four sources, in order (E-464 removed the stamp waiver the first unlocked):
#   1. CLAUDE_CODE_SESSION_ID names a token that VERIFIES (safe-exec --verify-role: HMAC, and
#      its session process is an ancestor of this hook with the recorded start time) →
#      `record:<role>`. The session id is a SELECTOR: borrowing another session's id
#      (CLAUDE_CODE_SESSION_ID=<theirs> git commit) verifies nothing (T-GITLANE-001 r2, closed).
#   2. A live launch record on THIS process's ancestor chain (launch-record.py walk) →
#      `chain:<most restricted role>`. Restrict-only, and it needs no environment at all, so
#      clearing the session id no longer drops a `rein pane` session out of its lane.
#   3. A session id that is present but does not verify → `union:architect` — the lane
#      restriction applies.
#   4. The advisory env (restrict-only), then `engineer` — the operator's own terminal (no
#      session id, no record) keeps today's behaviour.
#
# Residual (D-087 r3): REIN_SKIP_GIT_LANE=1 skips the lane — same strength as --no-verify
# (D-081 r5) — and says so on stderr.
# Prints "<source>:<role>" (record | chain | union | env).
#
# It PRINTS both rather than setting a global: the caller invokes this in a command
# substitution, so any variable assigned inside is set in the SUBSHELL and lost.
# The path-scope BLOCK may act on any source — restricting is safe in the strict direction.
_resolve_commit_role() {
  if [[ "${REIN_SKIP_GIT_LANE:-0}" == "1" ]]; then
    echo "[GATE_SKIPPED] REIN_SKIP_GIT_LANE=1 — Architect git lane skipped for this commit (D-087 r3 residual)" >&2
    printf 'env:engineer'; return 0
  fi

  local se sid role lr walk
  sid="${CLAUDE_CODE_SESSION_ID:-}"
  se="$(rein_locate mcp/safe-exec-mcp/index.js || true)"
  # 1. Verified session token.
  if [[ -n "$sid" && -n "$se" && -f "$se" ]] && command -v node >/dev/null 2>&1; then
    role="$(node --no-warnings "$se" --verify-role "$sid" 2>/dev/null)" && [[ -n "$role" ]] && {
      printf 'record:%s' "$role"; return 0; }
  fi

  # 2. A live launch record on this process chain — most restricted wins, restrict-only.
  lr="$(rein_locate shared/launch-record.py || true)"
  if [[ -n "$lr" ]] && command -v python3 >/dev/null 2>&1; then
    walk="$(python3 -I "$lr" walk 2>/dev/null)"
    case "$walk" in
      *'"result": "union"'*) printf 'union:architect'; return 0 ;;
      *'"launch": "record"'*)
        case "$walk" in
          *'"role": "architect"'*) printf 'chain:architect'; return 0 ;;
          *'"role": "engineer"'*)  printf 'chain:engineer';  return 0 ;;
        esac ;;
    esac
  fi

  # 3. A session id that does not verify → the union: lane restriction.
  if [[ -n "$sid" ]]; then printf 'union:architect'; return 0; fi

  # 4. Advisory env (restrict-only), then the default — unchanged Engineer behaviour.
  # Normalised like the lane's own comparison (E-214.10h): `Architect` or `architect ` restricts too.
  local _pr _cr
  _pr="$(printf '%s' "${REIN_PANE_ROLE:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  _cr="$(printf '%s' "${REIN_CALLER_ROLE:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  if [[ "$_pr" == "architect" || "$_cr" == "architect" ]]; then
    printf 'env:architect'; return 0
  fi
  printf 'env:engineer'
}

check_architect_git_lane() {
  local resolved; resolved="$(_resolve_commit_role)"
  local ROLE_SOURCE="${resolved%%:*}"
  local role="${resolved#*:}"
  # Normalize before comparing: an exact match meant `Architect` or a trailing space
  # silently DISABLED the lane for a real Architect. safe-exec already lower-cases its
  # role comparison; match that. (A silently un-laned Architect is exactly the drift
  # this gate exists to catch.)
  role="$(printf '%s' "$role" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  [[ "$role" == "architect" ]] || return 0

  # Every staged path must be under .ai/ or plans/. --name-status is used (rather than
  # --name-only) so a RENAME's BOTH sides are checked: moving a file OUT of .ai/ is
  # exactly the escape a name-only check would miss.
  # FAIL CLOSED on a broken diff. Reading straight from a process substitution meant
  # git's exit status was never seen: a failed `git diff` produced ZERO records, the
  # out-of-scope list stayed empty, and the lane passed — so any diff hiccup silently
  # let arbitrary staged content through. Proven with a stubbed non-zero `git diff`.
  # This is the same rule already codified for --check-path in safe-exec: an error
  # must BLOCK, never allow.
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
      echo "Session role: architect. An Architect may commit only paths under .ai/ or plans/."
      echo "These staged paths are outside that scope:"
      echo ""
      printf '%s' "$out_of_scope"
      echo ""
      echo "The Architect designs; the Engineer implements (§35 ANTI-DRIFT, D-054)."
      echo "Hand the change list to the Engineer:  skill: rein-handoff (wakes it with SendMessage, D-099)"
      echo "Then unstage the out-of-scope paths:   git restore --staged <path>"
      echo ""
      echo "Rollback (only if you are certain): REIN_SKIP_GIT_LANE=1 git commit ..."
    } >&2
    exit 1
  fi

  # In scope. Every gate above has already run (markdown sync, co-modification warning,
  # registry drift, MCP stdout purity, and the standards gate, where the credential scan lives).
  echo "[ARCHITECT_LANE] All staged paths are within .ai//plans/ (role source: ${ROLE_SOURCE})." >&2
}

check_architect_git_lane

# ── E-464 (D-169 r8, D-170 r9): no review stamp at commit time ───────────────────────────
# Gate 2 used to refuse a commit without a [CRITIC_STAMP] for its parent HEAD (E-329). Review is
# now sized by tier and checked when the task closes (src/shared/completion-gates.mjs:
# [REVIEW_GATE], [ACCEPT_GATE], [SEC_GATE]); every deterministic check above has passed.
exit 0
