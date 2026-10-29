#!/usr/bin/env bash
# AI-OS Installer — thin copier (the version comes from package.json, E-270)
# Source files live in src/; this script copies them to ~/.ai-os/ and sets up PATH.

# Guard: require real bash (NOT bash invoked as `sh`).
#
# Process substitution `< <(find ...)` is disabled in two modes:
#   (a) Running under sh/dash/posh — $BASH_VERSION is unset.
#   (b) Running under bash POSIX mode — happens when `/bin/sh` is a copy
#       of bash (default on macOS) and the user runs `sh install-ai-os.sh`.
#       In that case $BASH_VERSION IS set, but `set -o posix` is on and
#       process substitution still fails.
#
# Re-exec under proper bash for both cases so the user can run the
# installer either way without hitting a cryptic "syntax error near `<`".
_aios_need_reexec=0
if [ -z "${BASH_VERSION:-}" ]; then
  _aios_need_reexec=1
else
  case ":${SHELLOPTS:-}:" in
    *:posix:*) _aios_need_reexec=1 ;;
  esac
fi
if [ "$_aios_need_reexec" = 1 ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi
  echo "Error: This installer requires bash (not sh/POSIX mode)." >&2
  echo "Install bash and re-run:  bash install-ai-os.sh" >&2
  exit 1
fi
unset _aios_need_reexec

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AIOS="${HOME}/.ai-os"

# E-69: Fail-closed Node.js availability check (system-hardening-phase3.md §Security).
# Runs BEFORE any file copy or env-line append. Node 22+ is required by:
#   - src/shared/wal-flusher.mjs       (node:sqlite, prevents WAL bloat)
#   - scripts/generate_mcp_docs.mjs    (regenerates .ai/blueprints/mcp.md on `ai sync`)
#   - src/shared/incident-append.mjs   (PII-sanitised telemetry)
#   - src/shared/incident-aggregate.mjs (preflight aggregator)
# Skipping this check on degraded systems risks silent WAL bloat (gigabytes)
# and missed compliance gates. Set AI_OS_SKIP_NODE_CHECK=1 only for CI
# packaging-only flows where the artifact is staged on a non-target host.
if [[ "${AI_OS_SKIP_NODE_CHECK:-0}" != "1" ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js is required but not found in PATH." >&2
    echo "        Install Node 22+ before running this installer." >&2
    echo "        See: https://nodejs.org/  or  brew install node" >&2
    exit 1
  fi
  _node_version="$(node --version 2>/dev/null || echo "v0.0.0")"
  _node_major="${_node_version#v}"; _node_major="${_node_major%%.*}"
  if [[ -z "${_node_major}" ]] || ! [[ "${_node_major}" =~ ^[0-9]+$ ]] || (( _node_major < 22 )); then
    echo "[ERROR] Node.js 22+ required (found ${_node_version})." >&2
    echo "        node:sqlite (used by wal-flusher.mjs) ships in Node 22." >&2
    exit 1
  fi
  echo "✓ Node.js ${_node_version} detected (Node 22+ required)"
fi

# E-270 (D-074 §Components 1): package.json is the ONLY place the version is typed. It
# used to be repeated here and in src/bin/ai, and the three copies drifted; now the
# installer reads it and records it as ~/.ai-os/VERSION, which `ai --version`, `ai init`
# and `ai doctor` read. Unreadable → refuse: an install that cannot say what it is would
# stamp every project it provisions with nothing.
AIOS_VERSION="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "${REPO_DIR}/package.json" 2>/dev/null | head -1)"
if [[ ! "${AIOS_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "[ERROR] cannot read a semver \"version\" from ${REPO_DIR}/package.json (got '${AIOS_VERSION}')." >&2
  exit 1
fi

echo "AI-OS v${AIOS_VERSION} installer"
echo "Source: ${REPO_DIR}/src"
echo "Target: ${AIOS}"
echo ""

# ── 0a) E-304 (D-089 r2): install only a COMMITTED tree ─────────────────────────────
# On 2026-10-04 uncommitted gate code went live machine-wide twice. The installer refuses a
# working tree with uncommitted changes under the gate paths, naming them; --allow-dirty is the
# one override — it prints a loud banner and records dirty=true in the install stamp, so
# `ai doctor` keeps saying "installed from an uncommitted tree" until a clean reinstall.
_AIOS_ALLOW_DIRTY=0
for _a in "$@"; do [[ "$_a" == "--allow-dirty" ]] && _AIOS_ALLOW_DIRTY=1; done
_AIOS_COMMIT=""; _AIOS_DIRTY=0
if git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  _AIOS_COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)"
  _aios_dirty_files="$(git -C "$REPO_DIR" status --porcelain --untracked-files=all -- \
      hooks src/mcp src/shared src/bin install-ai-os.sh 2>/dev/null \
      | grep -vE '/node_modules/|/package-lock\.json$|/__pycache__/' || true)"
  # npm's own artifacts (an `npm install` in a server dir writes node_modules/ and an untracked
  # package-lock.json — `ai ci run` does exactly that) and Python's bytecode cache are not
  # source. Untracked SOURCE still counts: on 2026-10-04 launch-record.py was untracked.
  if [[ -n "$_aios_dirty_files" ]]; then
    _AIOS_DIRTY=1
    if [[ "$_AIOS_ALLOW_DIRTY" -ne 1 ]]; then
      echo "[INSTALL_DIRTY_TREE] refusing to install uncommitted gate code from ${REPO_DIR}:" >&2
      printf '%s\n' "$_aios_dirty_files" | sed 's/^/    /' >&2
      echo "  Commit (or stash) these first. To install anyway: bash install-ai-os.sh --allow-dirty" >&2
      exit 2
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ⚠ --allow-dirty: installing UNCOMMITTED gate code from ${REPO_DIR}"
    printf '%s\n' "$_aios_dirty_files" | sed 's/^/    /'
    echo "  ai doctor will report this install as dirty until a clean reinstall."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  fi
fi

# ── 0b) E-290 (D-081 r1, D-083): the hooks run under PRIVILEGED /bin/bash ──────────
# Every generated hook entry is the exec form {"command":"/bin/bash","args":["-p",…]}
# and every git stub is `#!/bin/bash -p`. A host without a /bin/bash that accepts -p (e.g.
# NixOS) gets NO hooks rather than hooks resolved through PATH: a gate's interpreter never
# falls back to PATH. The rest of the install proceeds; the exit status says it failed.
# _AI_OS_TEST_HOOK_BASH lets the test suite simulate such a host — it is read by THIS
# installer only, never by a hook (the T-LOCATOR-001 lesson).
_HOOK_BASH="${_AI_OS_TEST_HOOK_BASH:-/bin/bash}"
_HOOKS_REFUSED=0
if ! { [[ -f "$_HOOK_BASH" && -x "$_HOOK_BASH" ]] \
       && env -i "$_HOOK_BASH" -p -c 'case $- in *p*) exit 0 ;; esac; exit 1' >/dev/null 2>&1; }; then
  _HOOKS_REFUSED=1
  echo "[HOOK_BASH_MISSING] ${_HOOK_BASH} not found, not executable, or rejects -p — AI-OS hooks NOT installed (no PATH fallback, D-081/D-083). On NixOS link /bin/bash (e.g. a systemd tmpfile or environment.binsh) and re-run: bash install-ai-os.sh" >&2
fi

# ── 1) Copy src tree to ~/.ai-os ─────────────────────────────────────────────

mkdir -p "${AIOS}"

# E-229: a MIRROR WRITE MUST BE ATOMIC PER FILE. bash reads a script by byte offset as it
# runs, so overwriting a bin/ script in place moves the ground under a live process — the
# observed failure was 24 hours of a running-but-broken process after a mirror update.
# rsync already writes to a temporary file and renames (it is only unsafe with --inplace),
# so the rsync path below is correct as written; this makes the `cp` fallback match it.
_atomic_copy_tree() {  # <src-dir> <dst-dir>
  local src="${1%/}" dst="${2%/}" rel target tmp
  mkdir -p "$dst"
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    target="${dst}/${rel}"
    mkdir -p "$(dirname "$target")"
    tmp="$(mktemp "$(dirname "$target")/.aios.XXXXXX")" || return 1
    if cp "${src}/${rel}" "$tmp" 2>/dev/null; then
      chmod --reference="${src}/${rel}" "$tmp" 2>/dev/null || \
        { [[ -x "${src}/${rel}" ]] && chmod +x "$tmp"; }
      mv -f "$tmp" "$target"          # rename is atomic: readers see old or new, never half
    else
      rm -f "$tmp"
    fi
  done < <(cd "$src" && find . -type f | sed 's|^\./||')
}

# ── E-304 (D-089 r2): STAGE the whole tree, VERIFY it, then sync it live — hooks LAST ───
# Every installed piece comes from ONE source tree in one pass, and the live mirror is touched
# only after the staged copy parses: a hook never lands without the mcp/ and shared/ it calls,
# and a tree that does not parse never reaches ~/.ai-os. The live sync stays per-file atomic
# (rsync renames; _atomic_copy_tree below) rather than a directory swap: a renamed-away hooks/
# would leave a window in which every gate hook is missing, and mcp/ carries node_modules the
# source tree does not have.
_STAGE="$(mktemp -d "${AIOS}/.stage.XXXXXX")"
trap 'rm -rf "${_STAGE}"' EXIT
_AIOS_TREES=(contracts templates shared claude copilot config mcp bin)   # src/<tree> → <tree>
_stage_one() {  # <src-dir> <stage-dir>
  if command -v rsync &>/dev/null; then
    rsync -a --delete --exclude='node_modules/' --exclude='__pycache__/' "${1%/}/" "${2%/}/"
  else
    _atomic_copy_tree "$1" "$2"
  fi
}
for _t in "${_AIOS_TREES[@]}"; do _stage_one "${REPO_DIR}/src/${_t}" "${_STAGE}/${_t}"; done
[[ -d "${REPO_DIR}/scripts" ]] && _stage_one "${REPO_DIR}/scripts" "${_STAGE}/scripts"
[[ "$_HOOKS_REFUSED" -eq 0 ]] && _stage_one "${REPO_DIR}/hooks" "${_STAGE}/hooks"

_verify_stage() {  # → 0 when the staged tree is complete and parses; prints what is wrong
  local bad=0 f
  for f in bin/ai bin/ai-account.sh shared/accounts.py shared/locate.sh shared/toolchain-pin.sh shared/launch-record.py shared/gate-probe.sh \
           mcp/safe-exec-mcp/index.js mcp/safe-exec-mcp/role-token.mjs mcp/safe-exec-mcp/gate-guard.mjs; do
    [[ -f "${_STAGE}/${f}" ]] || { echo "  missing: ${f}"; bad=1; }
  done
  if [[ "$_HOOKS_REFUSED" -eq 0 ]]; then
    for f in pre-tool-use.sh session-start.sh pre-commit.sh; do
      [[ -f "${_STAGE}/hooks/${f}" ]] || { echo "  missing: hooks/${f}"; bad=1; }
    done
  fi
  for f in "${_STAGE}"/hooks/*.sh "${_STAGE}/bin/ai" "${_STAGE}/bin/ai-account.sh"; do
    [[ -f "$f" ]] || continue
    bash -n "$f" 2>/dev/null || { echo "  does not parse (bash): ${f#${_STAGE}/}"; bad=1; }
  done
  if command -v node >/dev/null 2>&1; then
    for f in "${_STAGE}"/mcp/*/index.js "${_STAGE}"/mcp/safe-exec-mcp/*.mjs; do
      [[ -f "$f" ]] || continue
      node --check "$f" 2>/dev/null || { echo "  does not parse (node): ${f#${_STAGE}/}"; bad=1; }
    done
  fi
  if command -v python3 >/dev/null 2>&1; then
    for f in "${_STAGE}"/shared/*.py; do
      [[ -f "$f" ]] || continue
      python3 -I -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$f" 2>/dev/null \
        || { echo "  does not parse (python): ${f#${_STAGE}/}"; bad=1; }
    done
  fi
  return "$bad"
}
if ! _verify_report="$(_verify_stage)"; then
  echo "[INSTALL_STAGE_INVALID] the staged tree from ${REPO_DIR} is incomplete or does not parse — nothing was installed:" >&2
  printf '%s\n' "$_verify_report" >&2
  exit 3
fi
echo "✓ Staged and verified the tree from ${REPO_DIR}"

# Live sync, dependencies first, hooks LAST.
_live_one() {  # <tree> [rsync filter args…]
  local t="$1"; shift
  local del=(--delete)
  # E-273 rollback, unchanged in scope: AI_OS_INSTALL_NO_DELETE=1 keeps mcp/ and hooks/ additive.
  [[ "${AI_OS_INSTALL_NO_DELETE:-0}" == "1" && ( "$t" == "mcp" || "$t" == "hooks" ) ]] && del=()
  if command -v rsync &>/dev/null; then
    rsync -a ${del[@]+"${del[@]}"} "$@" "${_STAGE}/${t}/" "${AIOS}/${t}/"
  else
    _atomic_copy_tree "${_STAGE}/${t}" "${AIOS}/${t}"
  fi
}
for _t in contracts templates shared claude copilot config bin; do _live_one "$_t"; done
# E-273: mcp/ mirrors with --delete, but node_modules/ and package-lock.json written by
# `npm install` INTO the mirror are PROTECTED. AI_OS_INSTALL_NO_DELETE=1 keeps the additive copy.
_live_one mcp --filter='P node_modules/' --filter='P package-lock.json'
[[ -d "${_STAGE}/scripts" ]] && _live_one scripts
[[ "$_HOOKS_REFUSED" -eq 0 ]] && _live_one hooks

# E-270: the version stamp. Written after the copy so a failed copy never advertises a
# version whose files are not there; tmp + rename so a reader sees old or new, never half.
printf '%s\n' "${AIOS_VERSION}" > "${AIOS}/VERSION.tmp.$$" && mv -f "${AIOS}/VERSION.tmp.$$" "${AIOS}/VERSION"
echo "✓ Recorded version ${AIOS_VERSION} → ${AIOS}/VERSION"

chmod +x "${AIOS}/bin/ai"
chmod +x "${AIOS}/hooks/"*.sh 2>/dev/null || true

# E-62: Persist canonical AI-OS clone path so bin/ai can recover the
# framework workspace without relying on shell env (e.g. when invoked
# from a non-interactive process). Pure path persistence — no path
# traversal validation here; consumers (task-synchronizer-mcp) enforce
# their own invariants per task-routing.md §Security.
mkdir -p "${AIOS}/config"
printf "%s\n" "${REPO_DIR}" > "${AIOS}/config/aios-workspace.txt"
echo "✓ Recorded AIOS_WORKSPACE=${REPO_DIR}"

# E-304: the install stamp — which tree, which commit, and whether it was dirty. `ai doctor`
# reads it ("installed from an uncommitted tree"). tmp + rename: a reader sees old or new.
python3 - "${AIOS}/config/install-stamp.json" "$REPO_DIR" "$_AIOS_COMMIT" "$_AIOS_DIRTY" "$AIOS_VERSION" <<'PYSTAMP' || true
import json, os, sys, time
p, src, commit, dirty, ver = sys.argv[1:6]
tmp = p + ".tmp.%d" % os.getpid()
json.dump({"source": src, "commit": commit or None, "dirty": dirty == "1", "version": ver,
           "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, open(tmp, "w"))
os.replace(tmp, p)
PYSTAMP

echo "✓ Files copied to ${AIOS}"

# ── 2) Remove orphaned files from installed dirs (dynamic — no hardcoded list) ─

purge_orphans() {
  local src_dir="$1"
  local dst_dir="$2"
  [[ -d "$dst_dir" ]] || return 0
  local removed=0
  while IFS= read -r -d '' dst_file; do
    local rel="${dst_file#"${dst_dir}"/}"
    if [[ ! -f "${src_dir}/${rel}" ]]; then
      rm -f "$dst_file"
      echo "✓ Removed orphaned file: ${dst_dir}/${rel}"
      removed=1
    fi
  done < <(find "$dst_dir" -maxdepth 1 -type f -print0 2>/dev/null)
  [[ $removed -eq 0 ]] && echo "✓ ${dst_dir##*/}/ clean (no orphans)"
}

# E-273: the recursive form, for the cp fallback (rsync --delete already did this on the
# rsync path; running it there too is a cheap no-op). purge_orphans above only looks at
# the top level of three trees, so a nested orphan — or any orphan in the other trees —
# survived the fallback. node_modules/ and package-lock.json are npm's, never orphans.
purge_tree_orphans() {
  local src_dir="$1" dst_dir="$2" rel removed=0
  [[ -d "$dst_dir" && -d "$src_dir" ]] || return 0
  while IFS= read -r -d '' dst_file; do
    rel="${dst_file#"${dst_dir}"/}"   # quoted: a [..] in HOME is a glob otherwise
    case "/${rel}" in */node_modules/*|*/package-lock.json) continue ;; esac
    # Written into the mirror by this installer (E-62), never shipped in src/config.
    [[ "${dst_dir##*/}/${rel}" == "config/aios-workspace.txt" ]] && continue
    [[ "${dst_dir##*/}/${rel}" == "config/install-stamp.json" ]] && continue   # E-304
    if [[ ! -e "${src_dir}/${rel}" ]]; then
      rm -f "$dst_file"
      removed=$((removed + 1))
    fi
  done < <(find "$dst_dir" -path '*/node_modules' -prune -o -type f -print0 2>/dev/null)
  find "$dst_dir" -mindepth 1 -type d -empty -delete 2>/dev/null || true
  [[ $removed -gt 0 ]] && echo "✓ ${dst_dir##*/}/: removed ${removed} orphaned file(s)"
  return 0
}

# A retired MCP server's mirror directory: the protect filter above keeps its node_modules/
# and package-lock.json, so rsync leaves the directory behind. src/mcp is the reference
# (not registry.json: ast-parser-mcp and shared/ are in src/mcp and in no registry — the
# E-272 lesson). Reproducible from src/, nothing user-owned: removed.
# Only when src/mcp really holds servers: on the cp fallback a missing source tree is
# skipped silently, and every mirror dir would then look retired (critic_security, E-273).
# A partial or sparse clone must never wipe the working mirror.
purge_retired_mcp_mirrors() {  # <src-mcp-dir> <mirror-mcp-dir>
  local src="$1" dst="$2" s d n count=0
  for s in "${src}/"*/; do
    if [[ -f "${s}index.js" ]]; then count=$((count + 1)); fi
  done
  if [[ "$count" -eq 0 ]]; then
    echo "⚠  ${src} has no servers — retired-mirror cleanup skipped"
    return 0
  fi
  for d in "${dst}/"*/; do
    [[ -d "$d" ]] || continue
    n="$(basename "$d")"
    if [[ -z "$n" || -d "${src}/${n}" ]]; then continue; fi
    rm -rf -- "${dst:?}/${n:?}"
    echo "✓ Removed retired MCP server mirror ${dst}/${n}"
  done
  return 0
}

# Always run dynamic orphan cleanup (rsync --delete handles this for rsync path;
# purge_orphans covers the cp fallback path and any gap files)
purge_orphans "${REPO_DIR}/src/contracts" "${AIOS}/contracts"
purge_orphans "${REPO_DIR}/src/claude"    "${AIOS}/claude"
purge_orphans "${REPO_DIR}/src/shared"    "${AIOS}/shared"

if [[ "${AI_OS_INSTALL_NO_DELETE:-0}" != "1" ]]; then
  for _t in contracts templates shared claude copilot bin config mcp; do
    purge_tree_orphans "${REPO_DIR}/src/${_t}" "${AIOS}/${_t}"
  done
  purge_tree_orphans "${REPO_DIR}/hooks" "${AIOS}/hooks"
  if [[ -d "${REPO_DIR}/scripts" ]]; then
    purge_tree_orphans "${REPO_DIR}/scripts" "${AIOS}/scripts"
  fi

  purge_retired_mcp_mirrors "${REPO_DIR}/src/mcp" "${AIOS}/mcp"
fi

# E-254 (D-069): v3 mirrored two provider trees that v4 no longer ships. Both were written
# with rsync --delete from src/, so nothing user-owned lives in them — remove on upgrade.
for legacy_mirror in gemini agents; do
  if [[ -d "${AIOS}/${legacy_mirror}" ]]; then
    rm -rf "${AIOS:?}/${legacy_mirror}"
    echo "✓ Removed legacy install mirror ${AIOS}/${legacy_mirror}"
  fi
done

# ── 2b) E-286 (D-078, T-HOOKENV-001): record the hook toolchain ─────────────────
# The hooks no longer resolve node/python3/nice through an inherited PATH (a project's
# settings `env` can set it). The installer resolves them ONCE, here, from the operator's
# own shell, checks each realpath (not inside the project or the framework clone; owner
# root/you and no unsafe group/world write on it or any ancestor) and writes
# ~/.ai-os/shared/toolchain.sh atomically. AFTER the copy and the orphan purges above,
# both of which would otherwise delete it (it is not in src/shared/).
# A refused interpreter is NOT recorded: the hooks then use the fixed fallback PATH and a
# fail-closed gate blocks with [TOOLCHAIN_STALE] rather than run something unvetted.
_record_hook_toolchain() {
  # shellcheck source=src/shared/toolchain-record.sh
  . "${REPO_DIR}/src/shared/toolchain-record.sh" || return 1
  # Project roots: the framework clone, the git toplevel of the cwd, and the cwd only when
  # it IS an AI-OS project — an installer run from $HOME must not refuse ~/.nvm's node.
  local -a roots=("$REPO_DIR")
  local top; top="$(git rev-parse --show-toplevel 2>/dev/null)" && roots+=("$top")
  [[ -d .ai ]] && roots+=("$(pwd -P)")
  local n p nc rn rp rnc ok=1
  n="$(command -v node 2>/dev/null)"; p="$(command -v python3 2>/dev/null)"
  nc="$(command -v nice 2>/dev/null)"; [[ -n "$nc" ]] || nc=/usr/bin/nice
  rn="$(ai_os_tc_check "$n" "${roots[@]}")"   || { echo "✗ hook toolchain: node not recorded (${n:-not found})" >&2; ok=0; }
  rp="$(ai_os_tc_check "$p" "${roots[@]}")"   || { echo "✗ hook toolchain: python3 not recorded (${p:-not found})" >&2; ok=0; }
  rnc="$(ai_os_tc_check "$nc" "${roots[@]}")" || { echo "✗ hook toolchain: nice not recorded (${nc})" >&2; ok=0; }
  if [[ "$ok" -eq 1 ]] && ai_os_tc_write "${AIOS}/shared/toolchain.sh" "$rn" "$rp" "$rnc"; then
    echo "✓ Hook toolchain pinned: node ${rn} · python3 ${rp}"
    # E-305 (D-089 r3): the gate path's pinned dependencies, recorded beside the interpreters
    # (readers skip any line they do not recognise; `ai doctor` prints the set).
    if command -v node >/dev/null 2>&1 && [[ -f "${AIOS}/shared/gate-pins.mjs" ]]; then
      node --no-warnings "${AIOS}/shared/gate-pins.mjs" list "${AIOS}/mcp" 2>/dev/null \
        | sed 's/^/AI_OS_TC_GATEDEP=/' >> "${AIOS}/shared/toolchain.sh" || true
    fi
  else
    rm -f "${AIOS}/shared/toolchain.sh"
    echo "! Hook toolchain NOT pinned — the hooks fall back to a fixed system PATH and the gate" >&2
    echo "  blocks with [TOOLCHAIN_STALE] if it finds no interpreter there. Fix the path above and re-run." >&2
  fi
}
_record_hook_toolchain

# ── 3) PATH setup ─────────────────────────────────────────────────────────────

ensure_path_line() {
  local rc="$1"
  local line='export PATH="$HOME/.ai-os/bin:$PATH"'
  [[ -f "$rc" ]] || touch "$rc"
  if ! grep -qF "$line" "$rc" 2>/dev/null; then
    printf "\n# AI-OS\n%s\n" "$line" >> "$rc"
    echo "✓ Added PATH to ${rc}"
  fi
}

# E-50: restore native terminal scrollback for tmux users by disabling
# Claude Code's TUI alternate-screen mode at the shell level. This ensures
# `claude` invoked outside an AI-OS project still inherits the flag. Per
# claude-obsidian-optimizations §Rollback: comment the export out if a
# specific OS shows rendering bugs.
ensure_env_line() {
  local rc="$1" var="$2" value="$3"
  local line="export ${var}=\"${value}\""
  [[ -f "$rc" ]] || touch "$rc"
  # Match on the variable name so re-runs don't append duplicates even if
  # the value has been edited.
  if ! grep -qE "^export[[:space:]]+${var}=" "$rc" 2>/dev/null; then
    printf "%s\n" "$line" >> "$rc"
    echo "✓ Added ${var} to ${rc}"
  fi
}

ensure_path_line "${HOME}/.zprofile"
ensure_path_line "${HOME}/.zshrc"
ensure_path_line "${HOME}/.bashrc"

ensure_env_line "${HOME}/.zprofile" "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" "1"
ensure_env_line "${HOME}/.zshrc"    "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" "1"
ensure_env_line "${HOME}/.bashrc"   "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" "1"

# E-304 (D-089 r2): the installer no longer exports AIOS_WORKSPACE from shell profiles. The
# persisted ~/.ai-os/config/aios-workspace.txt is the record (`ai` reads it first, and `ai sync`
# writes it into each project's settings env for the MCP servers); an exported copy in a profile
# outlived reinstalls and pointed `ai sync` at a developer's working tree (2026-10-04).
# Lines an EARLIER install wrote are offered for removal (y/N, terminal only, never under CI) —
# only lines of exactly that shape, `export AIOS_WORKSPACE="…"`; anything else is left alone.
# _aios_remove_workspace_export <rc-file> — drop ONLY lines of the exact shape earlier installs
# wrote; idempotent; keeps the file's inode, owner and mode. (A function, so the suite tests it.)
_aios_remove_workspace_export() {
  local rc="$1" tmp
  [[ -f "$rc" ]] || return 0
  grep -qE '^export AIOS_WORKSPACE="[^"]*"$' "$rc" 2>/dev/null || return 0
  tmp="$(mktemp "${rc}.aios.XXXXXX")" || return 1
  grep -vE '^export AIOS_WORKSPACE="[^"]*"$' "$rc" > "$tmp" || true
  cat "$tmp" > "$rc"; rm -f "$tmp"
}
_aios_rc_with_export=()
for _rc in "${HOME}/.zprofile" "${HOME}/.zshrc" "${HOME}/.bashrc"; do
  [[ -f "$_rc" ]] && grep -qE '^export AIOS_WORKSPACE="[^"]*"$' "$_rc" 2>/dev/null && _aios_rc_with_export+=("$_rc")
done
if [[ "${#_aios_rc_with_export[@]}" -gt 0 ]]; then
  if [[ -t 0 && -z "${CI:-}" && -z "${AI_OS_CI:-}" ]]; then
    printf 'Remove the AIOS_WORKSPACE export an earlier install added to %s? [y/N] ' "${_aios_rc_with_export[*]}"
    _ans=""; read -r _ans || true
    if [[ "$_ans" == "y" || "$_ans" == "Y" ]]; then
      for _rc in "${_aios_rc_with_export[@]}"; do
        _aios_remove_workspace_export "$_rc" && echo "✓ Removed the AIOS_WORKSPACE export from ${_rc}"
      done
    else
      echo "  Kept the AIOS_WORKSPACE export (the installed record still wins; ai doctor warns if they disagree)."
    fi
  else
    echo "  ○ ${_aios_rc_with_export[*]} still export AIOS_WORKSPACE — run the installer in a terminal to remove it"
  fi
fi

# ── 4) Install global configs + hooks + fix settings.json ────────────────────

echo ""
echo "Running: ai install (global configs + hooks + settings.json) ..."
"${AIOS}/bin/ai" install

# ── E-249 (D-067 §3): stale running servers ───────────────────────────────────
#
# This is the moment the defect is created. `install-ai-os.sh` has just rewritten
# ${AIOS}; every MCP server already running is, from this line onward, serving code that
# is no longer on disk — and nothing about the install tells them so. Saying it HERE, in
# the output the operator is already reading, is the difference between a restart now and
# a review cycle later spent on a verdict from a build that no longer exists (E-227).
#
# Never fatal, and never allowed to fail the install: the CLI it calls always exits 0, and
# the whole block is guarded so a missing node or an unreadable run dir is silent.
if command -v node >/dev/null 2>&1 && [[ -f "${AIOS}/shared/build-stamp.mjs" ]]; then
  _stale_after_install="$(node --no-warnings "${AIOS}/shared/build-stamp.mjs" --stale 2>/dev/null || true)"
  if [[ -n "${_stale_after_install}" ]]; then
    echo ""
    echo "⚠  MCP servers running from the previous build (E-249):"
    while IFS= read -r _l; do
      [[ -n "$_l" ]] && echo "   ${_l}"
    done <<< "${_stale_after_install}"
    echo "   These do NOT hot-reload (D-067 §3). Restart the MCP servers, or the session,"
    echo "   before trusting anything they report. Rollback: AI_OS_BUILD_STAMP=0."
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────

cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  AI-OS v${AIOS_VERSION} installed at: ${AIOS}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Next steps:

1) Reload shell:
   source ~/.zprofile && source ~/.zshrc

2) Verify everything:
   ai doctor

3) In any project repo:
   ai init       — scaffold .ai/, or upgrade it to this version (ai init --check: dry run)
   ai start      — open the Triad (Architect + Engineer panes)

4) MCP servers (auto-configured — requires Node.js):
   ai mcp-setup   ← installs deps + regenerates .mcp.json with absolute paths
   ai doctor      ← verify per-server health

5) Relaunch every running Claude pane (E-294, D-087):
   role tokens are now bound to the session process and minted from launch records.
   A session started before this install holds an old token that never verifies, so its
   gate applies EVERY role's blocks until it is relaunched with: ai pane <role>
   (then ai sync in each project, so SessionStart also fires on /clear and /compact)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF

# E-290: the hooks were refused (no privileged /bin/bash) — say so last, and fail.
if [[ "${_HOOKS_REFUSED:-0}" -eq 1 ]]; then
  echo "" >&2
  echo "[HOOK_BASH_MISSING] the install finished WITHOUT the AI-OS hooks — see the message above." >&2
  exit 1
fi
