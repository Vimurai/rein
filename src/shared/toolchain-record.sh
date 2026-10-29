#!/usr/bin/env bash
# toolchain-record.sh — E-286 (D-078, sovereignty-hardening.md §Hook Toolchain Pinning,
# THREAT_MODEL T-HOOKENV-001): the RECORDER half of the hook toolchain pin.
#
# The hooks used to call `node`, `python3` and `nice` by bare name, and a project's
# `.claude/settings.json` `env` block can set PATH — so the visited project chose the
# interpreter that runs the gate meant to stop it. The installer now decides instead: it
# resolves the three tools ONCE, from the operator's own shell, checks each one, and writes
# their absolute realpaths to ~/.rein/shared/toolchain.sh. The hooks read that file
# (src/shared/toolchain-pin.sh); they never consult an inherited PATH for an interpreter.
#
# Sourceable (functions only, no side effects) so the safety check is unit-testable.
#   ai_os_tc_realpath <path>                  → absolute realpath on stdout, or status 1
#   ai_os_tc_check <path> [project_root...]   → status 0 safe | 1 refused (reason on stderr)
#   ai_os_tc_write <file> <node> <python3> <nice>  → atomic write of the toolchain file
#
# What "safe" means (security_engineer threat model, E-286):
#   - the value is an absolute path in a plain charset (it is written into a shell file);
#   - the realpath is not inside any given project root (a cloned repo must not be able to
#     supply the interpreter that later judges it) — compared with a trailing slash so
#     /x/proj2 is not "inside" /x/proj;
#   - the file and EVERY ancestor directory up to / are owned by root or the installing user,
#     are not world-writable, and are group-writable only for wheel (0) or admin (80), whose
#     members are already sudo-equivalent. Homebrew's Cellar is admin-group-writable, so a
#     plain "refuse g+w" rule would refuse every Homebrew install; staff-writable is refused.

ai_os_tc_realpath() {
  local p="$1" d b n=0
  [[ -n "$p" ]] || return 1
  if [[ -x /bin/realpath ]]; then /bin/realpath "$p" 2>/dev/null && return 0; fi
  # Portable fallback: resolve file symlinks one hop at a time, then the directory physically.
  while [[ -L "$p" && "$n" -lt 40 ]]; do
    local t; t="$(readlink "$p")" || return 1
    case "$t" in /*) p="$t" ;; *) p="${p%/*}/$t" ;; esac
    n=$((n + 1))
  done
  [[ -e "$p" ]] || return 1
  d="${p%/*}"; b="${p##*/}"; [[ "$d" == "$p" ]] && d="."
  d="$(cd -P "${d:-/}" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "${d%/}" "$b"
}

# <path> → "<octal-mode> <uid> <gid>"
_ai_os_tc_stat() {
  if stat -f '%Lp %u %g' "$1" >/dev/null 2>&1; then stat -f '%Lp %u %g' "$1"
  else stat -c '%a %u %g' "$1" 2>/dev/null; fi
}

_ai_os_tc_safe_node() {  # <path> — one filesystem object (file or directory)
  local st mode uid gid me
  st="$(_ai_os_tc_stat "$1")" || { echo "cannot stat $1" >&2; return 1; }
  read -r mode uid gid <<< "$st"
  me="$(id -u)"
  if [[ "$uid" != "0" && "$uid" != "$me" ]]; then
    echo "$1 is owned by uid $uid (not root or you)" >&2; return 1
  fi
  local perm=$(( 8#$mode ))
  if (( perm & 2 )); then echo "$1 is world-writable" >&2; return 1; fi
  if (( perm & 16 )) && [[ "$gid" != "0" && "$gid" != "80" ]]; then
    echo "$1 is writable by group $gid" >&2; return 1
  fi
  return 0
}

ai_os_tc_check() {
  local raw="$1"; shift
  local re='^/[A-Za-z0-9._/@+-]+$'
  if [[ ! "$raw" =~ $re ]]; then echo "refusing '$raw': not an absolute path in a plain charset" >&2; return 1; fi
  local rp; rp="$(ai_os_tc_realpath "$raw")" || { echo "refusing '$raw': cannot resolve it" >&2; return 1; }
  if [[ ! "$rp" =~ $re ]]; then echo "refusing '$raw': its realpath '$rp' is not in a plain charset" >&2; return 1; fi
  [[ -x "$rp" && -f "$rp" ]] || { echo "refusing '$rp': not an executable file" >&2; return 1; }
  local root r
  for root in "$@"; do
    [[ -n "$root" && -d "$root" ]] || continue
    r="$(cd -P "$root" 2>/dev/null && pwd -P)" || continue
    case "$rp/" in "${r%/}/"*) echo "refusing '$rp': it is inside the project ${r}" >&2; return 1 ;; esac
  done
  local p="$rp"
  while :; do
    _ai_os_tc_safe_node "$p" || { echo "refusing '$rp': an ancestor is unsafe" >&2; return 1; }
    [[ "$p" == "/" ]] && break
    p="${p%/*}"; [[ -z "$p" ]] && p="/"
  done
  printf '%s\n' "$rp"
}

ai_os_tc_write() {  # <file> <node> <python3> <nice>
  local file="$1" dir tmp
  dir="${file%/*}"
  mkdir -p "$dir" || return 1
  tmp="$(mktemp "${dir}/.toolchain.XXXXXX")" || return 1
  {
    echo "# Written by install-rein.sh (E-286). Parsed, never sourced, by the hooks."
    echo "REIN_TC_NODE=$2"
    echo "REIN_TC_PYTHON3=$3"
    echo "REIN_TC_NICE=$4"
    echo "REIN_TC_RECORDED=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 0644 "$tmp" && mv -f "$tmp" "$file"   # rename replaces a symlink, never follows it
}
