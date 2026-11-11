#!/usr/bin/env bash
# install-finalize.sh — what an install does after its files are in place (E-420; D-155 r4,
# addenda r1-r3; .ai/blueprints/release-artifact.md §Component 4).
#
# Two callers, one implementation: install-rein.sh sources this from the clone and calls the
# functions in its own order; `rein install` in artifact mode (~/.rein/manifest.json present)
# sources it from ~/.rein/shared and runs them after its tree check. Functions only, no side
# effects on source. Each function either prints its lines or sets state in the caller, never
# both inside $(…) (D-064 §2): rein_fin_probe_hook_bash sets _HOOKS_REFUSED and is called as a
# plain command.
#
#   rein_fin_probe_hook_bash                       → sets _HOOKS_REFUSED=0|1, prints the refusal
#   rein_fin_record_toolchain <rein> <toolchain-record.sh> [root…]
#                                                  → pins node/python3/nice in <rein>/shared/toolchain.sh
#   rein_fin_write_stamp <file> <source> <commit> <dirty 0|1> <version> [key_id]
#   rein_fin_profile_lines                         → PATH and CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN lines
#   rein_fin_purge_retired_mcp <mirror-mcp-dir> <live-name>…
#   rein_fin_purge_legacy_mirrors <rein>

# ── the hooks run under PRIVILEGED /bin/bash (E-290, D-081 r1, D-083) ─────────────────────
# Every generated hook entry is the exec form {"command":"/bin/bash","args":["-p",…]} and every
# git stub is `#!/bin/bash -p`. A host without a /bin/bash that accepts -p (e.g. NixOS) gets NO
# hooks rather than hooks resolved through PATH: a gate's interpreter never falls back to PATH.
# _REIN_TEST_HOOK_BASH lets the test suite simulate such a host — it is read by the installers
# only, never by a hook (the T-LOCATOR-001 lesson).
rein_fin_probe_hook_bash() {
  local hb="${_REIN_TEST_HOOK_BASH:-/bin/bash}"
  _HOOKS_REFUSED=0
  if ! { [[ -f "$hb" && -x "$hb" ]] \
         && env -i "$hb" -p -c 'case $- in *p*) exit 0 ;; esac; exit 1' >/dev/null 2>&1; }; then
    _HOOKS_REFUSED=1
    echo "[HOOK_BASH_MISSING] ${hb} not found, not executable, or rejects -p — Rein hooks NOT installed (no PATH fallback, D-081/D-083). On NixOS link /bin/bash (e.g. a systemd tmpfile or environment.binsh) and re-run: bash install-rein.sh" >&2
  fi
  return 0
}

# ── the hook toolchain (E-286, D-078, T-HOOKENV-001) ────────────────────────────────────────
# The hooks do not resolve node/python3/nice through an inherited PATH (a project's settings
# `env` can set it). The install resolves them ONCE, here, from the operator's own shell, checks
# each realpath (not inside a project root or the framework clone; owner root/you and no unsafe
# group/world write on it or any ancestor) and writes <rein>/shared/toolchain.sh atomically. A
# refused interpreter is NOT recorded: the hooks then use the fixed fallback PATH and a
# fail-closed gate blocks with [TOOLCHAIN_STALE] rather than run something unvetted.
# Roots: the given ones (the installer passes its clone; artifact mode has none), the git
# toplevel of the cwd, and the cwd only when it IS a Rein project — an install run from $HOME
# must not refuse ~/.nvm's node.
rein_fin_record_toolchain() {  # <rein> <toolchain-record.sh> [root…]
  local rein="$1" rec="$2"; shift 2
  # shellcheck source=src/shared/toolchain-record.sh
  . "$rec" || return 1
  local -a roots=("$@")
  local top; top="$(git rev-parse --show-toplevel 2>/dev/null)" && roots+=("$top")
  [[ -d .ai ]] && roots+=("$(pwd -P)")
  local n p nc rn rp rnc ok=1
  n="$(command -v node 2>/dev/null)"; p="$(command -v python3 2>/dev/null)"
  nc="$(command -v nice 2>/dev/null)"; [[ -n "$nc" ]] || nc=/usr/bin/nice
  rn="$(rein_tc_check "$n" ${roots[@]+"${roots[@]}"})"   || { echo "✗ hook toolchain: node not recorded (${n:-not found})" >&2; ok=0; }
  rp="$(rein_tc_check "$p" ${roots[@]+"${roots[@]}"})"   || { echo "✗ hook toolchain: python3 not recorded (${p:-not found})" >&2; ok=0; }
  rnc="$(rein_tc_check "$nc" ${roots[@]+"${roots[@]}"})" || { echo "✗ hook toolchain: nice not recorded (${nc})" >&2; ok=0; }
  if [[ "$ok" -eq 1 ]] && rein_tc_write "${rein}/shared/toolchain.sh" "$rn" "$rp" "$rnc"; then
    echo "✓ Hook toolchain pinned: node ${rn} · python3 ${rp}"
    # E-305 (D-089 r3): the gate path's pinned dependencies, recorded beside the interpreters
    # (readers skip any line they do not recognise; `rein doctor` prints the set).
    if command -v node >/dev/null 2>&1 && [[ -f "${rein}/shared/gate-pins.mjs" ]]; then
      node --no-warnings "${rein}/shared/gate-pins.mjs" list "${rein}/mcp" 2>/dev/null \
        | sed 's/^/REIN_TC_GATEDEP=/' >> "${rein}/shared/toolchain.sh" || true
    fi
  else
    rm -f "${rein}/shared/toolchain.sh"
    echo "! Hook toolchain NOT pinned — the hooks fall back to a fixed system PATH and the gate" >&2
    echo "  blocks with [TOOLCHAIN_STALE] if it finds no interpreter there. Fix the path above and re-run." >&2
  fi
  return 0
}

# ── the install stamp (E-304; D-155 r4 adds source "artifact" and key_id) ─────────────────
# Which tree, which commit, whether it was dirty. `rein doctor` reads it. tmp + rename: a
# reader sees old or new, never half. key_id is written only when given (artifact installs).
rein_fin_write_stamp() {  # <file> <source> <commit> <dirty 0|1> <version> [key_id]
  python3 -I - "$@" <<'PYSTAMP' || true   # -I: no cwd on sys.path (runs from any directory)
import json, os, sys, time
p, src, commit, dirty, ver = sys.argv[1:6]
d = {"source": src, "commit": commit or None, "dirty": dirty == "1", "version": ver,
     "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
if len(sys.argv) > 6 and sys.argv[6]:
    d["key_id"] = sys.argv[6]
tmp = p + ".tmp.%d" % os.getpid()
json.dump(d, open(tmp, "w"))
os.replace(tmp, p)
PYSTAMP
}

# ── PATH and the alternate-screen variable in the shell profiles ───────────────────────────
ensure_path_line() {
  local rc="$1"
  local line='export PATH="$HOME/.rein/bin:$PATH"'
  [[ -f "$rc" ]] || touch "$rc"
  if ! grep -qF "$line" "$rc" 2>/dev/null; then
    printf "\n# Rein\n%s\n" "$line" >> "$rc"
    echo "✓ Added PATH to ${rc}"
  fi
}

# E-50: restore native terminal scrollback for tmux users by disabling
# Claude Code's TUI alternate-screen mode at the shell level. This ensures
# `claude` invoked outside a Rein project still inherits the flag. Per
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

rein_fin_profile_lines() {
  ensure_path_line "${HOME}/.zprofile"
  ensure_path_line "${HOME}/.zshrc"
  ensure_path_line "${HOME}/.bashrc"

  ensure_env_line "${HOME}/.zprofile" "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" "1"
  ensure_env_line "${HOME}/.zshrc"    "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" "1"
  ensure_env_line "${HOME}/.bashrc"   "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" "1"
}

# ── retired MCP server mirrors (E-273; D-155 addendum r1) ──────────────────────────────────
# A directory <mirror>/<name> whose name is not live is a retired server: removed whole,
# node_modules included. Guards: nothing is removed unless at least one live name has an
# index.js in the mirror (a partial clone or an empty manifest never wipes it); an entry that
# is a symlink is unlinked, never followed.
rein_fin_purge_retired_mcp() {  # <mirror-mcp-dir> <live-name>…
  local dst="$1"; shift
  local n e count=0
  # E-420 F1: a symlinked mcp/ would turn the removals below into removals in its target.
  if [[ -L "$dst" ]]; then
    echo "⚠  ${dst} is a symbolic link — retired-mirror cleanup skipped"
    return 0
  fi
  for n in "$@"; do [[ -f "${dst}/${n}/index.js" ]] && count=$((count + 1)); done
  if [[ "$count" -eq 0 ]]; then
    echo "⚠  no live MCP server in the install — retired-mirror cleanup skipped"
    return 0
  fi
  for e in "${dst}/"*; do
    [[ -e "$e" || -L "$e" ]] || continue
    n="${e##*/}"
    case " $* " in *" ${n} "*) continue ;; esac
    if [[ -L "$e" ]]; then
      rm -f -- "$e"
    elif [[ -d "$e" ]]; then
      rm -rf -- "${dst:?}/${n:?}"
    else
      continue
    fi
    echo "✓ Removed retired MCP server mirror ${dst}/${n}"
  done
  return 0
}

# E-254 (D-069): v3 mirrored two provider trees that v4 no longer ships. Both were written
# with rsync --delete from src/, so nothing user-owned lives in them — remove on upgrade.
rein_fin_purge_legacy_mirrors() {  # <rein>
  local legacy_mirror home
  # E-420 F1: resolve a symlinked home once, then work inside it; the entries are checked below.
  home="$(cd -P "$1" 2>/dev/null && pwd)" || return 0
  set -- "$home"
  for legacy_mirror in gemini agents; do
    if [[ -L "${1}/${legacy_mirror}" ]]; then
      rm -f -- "${1:?}/${legacy_mirror}"
      echo "✓ Removed legacy install mirror ${1}/${legacy_mirror}"
    elif [[ -d "${1}/${legacy_mirror}" ]]; then
      rm -rf "${1:?}/${legacy_mirror}"
      echo "✓ Removed legacy install mirror ${1}/${legacy_mirror}"
    fi
  done
}
