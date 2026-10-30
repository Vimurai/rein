# shellcheck shell=bash
# rein-account.sh — E-314 (D-095, accounts.md §Components 1 and 4): Claude accounts.
#
# Sourced by src/bin/rein (never executed: it has no top level beyond definitions). One account
# = one Claude Code config directory = one claude.ai login. The project will name an account
# (E-315); the operator's registry ${REIN}/accounts.json maps the name to the directory; every
# read and every validation goes through src/shared/accounts.py, resolved beside this file
# (bin/ → shared/, the same layout in the clone and in ~/.rein), so `rein account`, `rein pane`,
# `rein start` and `rein doctor` share one resolver.
#
# "default" is reserved: it is ~/.claude with CLAUDE_CONFIG_DIR left as the operator's shell
# has it. Proven on 2.1.296 (E-314 probe): exporting CLAUDE_CONFIG_DIR=~/.claude EXPLICITLY
# reads as logged out — the Keychain entry is keyed to the variable — so default is never an
# export and never a registry row.

_ACCT_BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
_acct_py() { printf '%s' "${_ACCT_BIN_DIR%/*}/shared/accounts.py"; }
_acct_registry() { printf '%s' "${REIN}/accounts.json"; }
_acct_today() { date +%Y-%m-%d; }
_acct_tilde() { case "$1" in "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }

# _account_dir <name> → the account's config directory on stdout (empty for "default" or no
# name: inherit). Non-zero, with the reason and the fixing command on stderr, when the name is
# invalid, unregistered, its directory is invalid or missing, or the registry is unreadable —
# a caller must refuse on that, never fall back to default (D-095).
_account_dir() {
  local name="${1:-}" out rc
  [[ -z "$name" || "$name" == "default" ]] && return 0
  if ! command -v python3 >/dev/null 2>&1; then
    echo "rein: account '${name}': python3 is required to read $(_acct_registry)" >&2; return 7
  fi
  # stdout only: the result is a path a caller exports (E-315) — stderr noise must never join it.
  out="$(python3 -I "$(_acct_py)" resolve "$(_acct_registry)" "$HOME" "$name" 2>/dev/null)" && rc=0 || rc=$?
  case "$rc" in
    0) printf '%s\n' "$out" ;;
    4) echo "rein: account '${name}' is not registered — run: rein account add ${name}" >&2 ;;
    6) echo "rein: account '${name}': its directory ${out#MISSING$'\t'} is missing — run: rein account remove ${name} && rein account add ${name}" >&2 ;;
    3) echo "rein: $(_acct_registry) is unreadable (${out#UNPARSABLE$'\t'}) — fix or remove it" >&2 ;;
    *) echo "rein: account '${name}': ${out#*$'\t'}" >&2 ;;
  esac
  return "$rc"
}

# _account_rows → "<name>\t<dir>\t<added>" per registered account (data only). A registry the
# resolver refuses prints nothing here; `rein account list` and the doctor report it themselves.
_account_rows() {
  command -v python3 >/dev/null 2>&1 || return 0
  python3 -I "$(_acct_py)" list "$(_acct_registry)" "$HOME" 2>/dev/null || true
}

# _acct_login <dir|""> → "<state>" for the list's login column, from `claude auth status`
# (JSON: loggedIn, authMethod, configDirectory — Claude Code ≥ 2.1.268). Empty dir = the
# default account, probed with the operator's environment as is. Never prints a credential:
# only the three fields are read.
_acct_login() {
  local dir="$1" want json
  command -v claude >/dev/null 2>&1 || { echo "unknown (claude not found)"; return 0; }
  want="${dir:-${CLAUDE_CONFIG_DIR:-${HOME}/.claude}}"
  if [[ -n "$dir" ]]; then
    json="$(CLAUDE_CONFIG_DIR="$dir" claude auth status 2>/dev/null || true)"
  else
    json="$(claude auth status 2>/dev/null || true)"
  fi
  printf '%s' "$json" | python3 -I -c '
import json, os, sys
want = os.path.normpath(sys.argv[1])
try:
    d = json.loads(sys.stdin.read())
except ValueError:
    d = None
if not isinstance(d, dict) or "configDirectory" not in d:
    print("unknown (claude < 2.1.268)")
elif os.path.normpath(str(d["configDirectory"])) != want:
    print("MISMATCH (claude reports %s)" % "".join(c if c.isprintable() else "?" for c in str(d["configDirectory"])))
elif d.get("loggedIn"):
    print(str(d.get("authMethod") or "logged in"))
else:
    print("logged out")
' "$want" 2>/dev/null || echo "unknown"
}

# _acct_settings <dir> → same | differs | missing: the account's settings.json against
# ~/.claude's (the copy may have diverged on purpose — reported, never re-synced here).
_acct_settings() {
  local mine="$1/settings.json" base="${HOME}/.claude/settings.json"
  [[ -f "$mine" ]] || { echo missing; return 0; }
  [[ -f "$base" ]] && cmp -s "$mine" "$base" && { echo same; return 0; }
  echo differs
}

# _acct_seed <dir> — COPY the operator layer from ~/.claude into a new account's directory:
# settings.json, keybindings.json, the user CLAUDE.md. Never a symlink (Claude Code rewrites
# these files atomically, which would silently un-share a link), never overwriting a file the
# directory already has, and nothing else: no credentials, history, projects/, sessions/,
# skills/plugins synced from claude.ai.
_acct_seed() {
  local dir="$1" f src out
  for f in settings.json keybindings.json CLAUDE.md; do
    src="${HOME}/.claude/${f}"
    [[ -f "$src" ]] || continue
    # `|| true`: EXISTS is exit 1, and under the caller's `set -e` a bare assignment would end
    # `rein account add` silently before the registry write (seeding a directory that exists).
    out="$(python3 -I "$(_acct_py)" copy "$src" "${dir}/${f}" 2>&1)" || true
    case "$out" in
      COPIED) echo "  ✓ ${f}: copied from ~/.claude" ;;
      EXISTS) echo "  ○ ${f}: kept the one already in $(_acct_tilde "$dir")" ;;
      *)      echo "  ✗ ${f}: not copied (${out#*$'\t'})" ;;
    esac
  done
}

# ── E-315 (D-095, accounts.md §Components 2 and 3): the project binding ─────────────────────

# _start_account_file <ai_dir> → the file an account binding is written to (DATA). E-333
# (D-102 §8): in a team project (.ai/team.json) the account is per developer, so it goes to the
# gitignored start.local.json; a single-operator project keeps start.json (unchanged).
_start_account_file() {
  if [[ -f "${1}/team.json" ]]; then printf 'start.local.json'; else printf 'start.json'; fi
}

# _start_account_set <ai_dir> <name|default> [keep] [file] — STATE: write or replace the
# `account` key of <file> (default start.json), every other key kept as it was; "default"
# removes the key unless `keep` is given (the pick records an explicit default). Called as a
# plain command.
_start_account_set() {
  python3 -I - "${1}/${4:-start.json}" "$2" "${3:-}" <<'PY'
import json, os, sys, tempfile
path, name, keep = sys.argv[1], sys.argv[2], sys.argv[3] == "keep"
d = {}
if os.path.exists(path):
    with open(path) as f:
        d = json.load(f)
    if not isinstance(d, dict):
        sys.exit(os.path.basename(path) + ": top level must be an object")
if name == "default" and not keep:
    if "account" not in d:
        sys.exit(0)
    d.pop("account")
else:
    d["account"] = name
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix="." + os.path.basename(path) + ".")
with os.fdopen(fd, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
}

# _start_account_pick <ai_dir> <dry> — STATE: with no `account` key and >=1 registered account,
# ask on a TTY (default first) and write the choice; with no TTY use default and say so once —
# a pipeline or a hook never waits on a prompt (the _start_kill precedent). Returns 2 on a
# choice that is not on the list. Called as a plain command, never in $(…).
_start_account_pick() {
  local ai_dir="$1" dry="$2" rows name dir _rest i=1 choice
  local -a names=(default)
  rows="$(_account_rows)"
  [[ -n "$rows" ]] || return 0
  if [[ ! -t 0 ]]; then
    echo "rein start: no account bound for this project — using default (bind one: rein start --account <name>)"
    return 0
  fi
  echo "rein start: which Claude account should this project use?"
  echo "  1) default ($(_acct_tilde "${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"))"
  while IFS=$'\t' read -r name dir _rest; do
    [[ -n "$name" ]] || continue
    i=$((i + 1)); names+=("$name")
    echo "  ${i}) ${name} ($(_acct_tilde "$dir"))"
  done <<< "$rows"
  if [[ "$dry" -eq 1 ]]; then
    echo "rein start: (dry run) a real run asks here and writes the choice to .ai/$(_start_account_file "$ai_dir")"
    return 0
  fi
  printf 'choice [1]: '
  read -r choice || choice=""
  choice="${choice:-1}"
  if ! [[ "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#names[@]} )); then
    echo "rein start: '${choice}' is not one of 1-${#names[@]} — nothing written" >&2
    return 2
  fi
  # The pick writes "default" explicitly (unlike --account default, which removes the key), so
  # an operator who chose default is not asked again on every start.
  local _f; _f="$(_start_account_file "$ai_dir")"
  _start_account_set "$ai_dir" "${names[$((choice - 1))]}" keep "$_f" || return 2
  echo "rein start: bound this project to account '${names[$((choice - 1))]}' (.ai/${_f})"
}

# _account_launch_check <name> <dir> — the account's user-level copy, checked at launch
# (D-097, accounts.md §3): OUTDATED backstop → refuse naming `rein sync` (a stale copy only Rein
# refreshes); settings.json missing or unparsable → refuse naming `rein account sync <name>`;
# ABSENT → the doctor's notice, then continue (the backstop is the operator's y/N choice).
_account_launch_check() {
  local name="$1" dir="$2" py out
  py="$(_cb_py 2>/dev/null)"
  if [[ ! -f "$py" ]] || ! command -v python3 >/dev/null 2>&1; then
    echo "rein pane: account '${name}': cannot check ${dir}/settings.json (helper or python3 missing — run: bash install-rein.sh)" >&2
    return 2
  fi
  out="$(python3 -I "$py" status "${dir}/settings.json" 2>/dev/null | sed -n '1p')"
  case "$out" in
    PRESENT) return 0 ;;
    ABSENT)
      echo "rein pane: ○ classifier backstop [account ${name}]: not configured in $(_acct_tilde "$dir")/settings.json — run: rein account sync ${name} (copies ~/.claude/settings.json)" >&2
      return 0 ;;
    OUTDATED*)
      echo "rein pane: account '${name}': the classifier backstop in $(_acct_tilde "$dir")/settings.json is outdated — run: rein sync" >&2
      return 2 ;;
    *)
      echo "rein pane: account '${name}': $(_acct_tilde "$dir")/settings.json is missing or unreadable (${out:-no answer}) — run: rein account sync ${name}" >&2
      return 2 ;;
  esac
}

_acct_in_use() {  # <name> → 0 when a tmux pane is running under it (@rein_account, E-315)
  command -v tmux >/dev/null 2>&1 || return 1
  tmux list-panes -a -F '#{@rein_account}' 2>/dev/null | grep -qxF "$1"
}

do_account() {
  local sub="${1:-list}"; shift || true
  if ! command -v python3 >/dev/null 2>&1; then
    echo "rein account: python3 is required" >&2; return 2
  fi
  local py reg out rc
  py="$(_acct_py)"; reg="$(_acct_registry)"
  case "$sub" in
    list)
      out="$(python3 -I "$py" list "$reg" "$HOME" 2>&1)" && rc=0 || rc=$?
      if [[ "$rc" -ne 0 ]]; then
        echo "rein account: ${reg} is unreadable (${out#*$'\t'}) — fix or remove it" >&2; return 2
      fi
      printf '%-12s %-36s %-7s %-28s %s\n' NAME DIR EXISTS LOGIN SETTINGS
      local ddir="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}" ex
      ex=no; [[ -d "$ddir" ]] && ex=yes
      printf '%-12s %-36s %-7s %-28s %s\n' default "$(_acct_tilde "$ddir")" "$ex" "$(_acct_login "")" -
      local name dir added
      while IFS=$'\t' read -r name dir added; do
        [[ -n "$name" ]] || continue
        ex=no; [[ -d "$dir" ]] && ex=yes
        printf '%-12s %-36s %-7s %-28s %s\n' "$name" "$(_acct_tilde "$dir")" "$ex" \
          "$([[ "$ex" == yes ]] && _acct_login "$dir" || echo -)" "$(_acct_settings "$dir")"
      done <<< "$out"
      ;;
    add)
      local name="${1:-}" dir=""; shift || true
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --dir) dir="${2:-}"; shift 2 || { echo "rein account add: --dir needs a path" >&2; return 2; } ;;
          *) echo "rein account add: unexpected argument '$1'" >&2; return 2 ;;
        esac
      done
      [[ -n "$name" ]] || { echo "usage: rein account add <name> [--dir <path>]" >&2; return 2; }
      dir="${dir:-${HOME}/.claude-${name}}"
      out="$(python3 -I "$py" check "$HOME" "$name" "$dir" 2>&1)" && rc=0 || rc=$?
      [[ "$rc" -eq 0 ]] || { echo "rein account add: ${out#*$'\t'}" >&2; return 2; }
      dir="$out"
      out="$(python3 -I "$py" list "$reg" "$HOME" 2>&1)" && rc=0 || rc=$?
      [[ "$rc" -eq 0 ]] || { echo "rein account add: ${reg} is unreadable (${out#*$'\t'}) — fix or remove it" >&2; return 2; }
      if printf '%s\n' "$out" | cut -f1 | grep -qxF "$name"; then
        echo "rein account add: '${name}' is already registered — see: rein account list" >&2; return 2
      fi
      mkdir -p "$dir" 2>/dev/null && [[ -d "$dir" ]] || { echo "rein account add: could not create ${dir}" >&2; return 3; }
      chmod 700 "$dir" 2>/dev/null || true
      # Again on the directory that now exists: owner, mode and where it really resolves to.
      out="$(python3 -I "$py" check "$HOME" "$name" "$dir" 2>&1)" && rc=0 || rc=$?
      [[ "$rc" -eq 0 ]] || { echo "rein account add: ${out#*$'\t'} — nothing seeded or registered" >&2; return 2; }
      echo "rein account add: ${name} → $(_acct_tilde "$dir")"
      _acct_seed "$dir"
      out="$(python3 -I "$py" add "$reg" "$HOME" "$name" "$dir" "$(_acct_today)" 2>&1)" && rc=0 || rc=$?
      [[ "$rc" -eq 0 ]] || { echo "rein account add: not registered — ${out#*$'\t'}" >&2; return 2; }
      echo "  ✓ registered in $(_acct_tilde "$reg")"
      # E-318 (D-097): the seeded copy may carry an outdated backstop label — replace it in place.
      declare -F _classifier_refresh_one >/dev/null && _classifier_refresh_one "${dir}/settings.json" "$name"
      echo "  ⓘ Claude Code's auto memory is per account (<dir>/projects/<project>/memory/): a"
      echo "    project moved to '${name}' starts with an empty memory there."
      echo "  ⓘ Accounts are claude.ai logins (Pro/Max/Team). A Console sign-in without an API key"
      echo "    is stored outside the config directory and is not separated."
      local state; state="$(_acct_login "$dir")"
      case "$state" in
        claude.ai|console|"logged in"|oauth*) echo "  ✓ already logged in (${state})"; return 0 ;;
      esac
      if [[ -t 0 && -t 1 && -z "${CI:-}" && -z "${REIN_CI:-}" ]] && command -v claude >/dev/null 2>&1; then
        echo "  → starting Claude Code under $(_acct_tilde "$dir"): type /login, sign in, then /exit"
        CLAUDE_CONFIG_DIR="$dir" claude || true
        echo "  login: $(_acct_login "$dir")"
      else
        echo "  → now log in: CLAUDE_CONFIG_DIR=${dir} claude   (then /login)"
      fi
      ;;
    remove)
      local name="${1:-}"
      [[ -n "$name" ]] || { echo "usage: rein account remove <name>" >&2; return 2; }
      out="$(python3 -I "$py" list "$reg" "$HOME" 2>&1)" && rc=0 || rc=$?
      [[ "$rc" -eq 0 ]] || { echo "rein account remove: ${reg} is unreadable (${out#*$'\t'})" >&2; return 2; }
      printf '%s\n' "$out" | cut -f1 | grep -qxF "$name" \
        || { echo "rein account remove: '${name}' is not registered" >&2; return 2; }
      if _acct_in_use "$name"; then
        echo "rein account remove: '${name}' is in use by a running pane — exit it first" >&2; return 3
      fi
      out="$(python3 -I "$py" remove "$reg" "$HOME" "$name" 2>&1)" && rc=0 || rc=$?
      [[ "$rc" -eq 0 ]] || { echo "rein account remove: ${out#*$'\t'}" >&2; return 2; }
      echo "rein account remove: '${name}' unregistered; ${out#REMOVED$'\t'} and its login are kept"
      ;;
    sync)
      local name="${1:-}" dir f
      [[ -n "$name" ]] || { echo "usage: rein account sync <name>" >&2; return 2; }
      dir="$(_account_dir "$name")" || return 2
      [[ -n "$dir" ]] || { echo "rein account sync: 'default' is ~/.claude itself" >&2; return 2; }
      for f in settings.json keybindings.json; do
        if [[ -f "${HOME}/.claude/${f}" ]]; then
          if [[ "$(python3 -I "$(_acct_py)" copy "${HOME}/.claude/${f}" "${dir}/${f}" --replace 2>&1)" == COPIED ]]; then
            echo "  ✓ ${f}: re-copied from ~/.claude"
          else
            echo "  ✗ ${f}: not re-copied" >&2; return 2
          fi
        else
          echo "  ○ ${f}: none in ~/.claude"
        fi
      done
      ;;
    use)
      # E-333 (D-102 §8): this developer's account for THIS project — the gitignored
      # .ai/start.local.json, read before the committed start.json by rein pane / rein start.
      local name="${1:-}" ai_dir
      [[ -n "$name" && $# -le 1 ]] || { echo "usage: rein account use <name|default>" >&2; return 2; }
      ai_dir="$(_find_ai_dir)"
      [[ -d "$ai_dir" ]] || { echo "rein account use: not inside a Rein project (no .ai/)" >&2; return 2; }
      _account_dir "$name" >/dev/null || return 2
      _start_account_set "$ai_dir" "$name" keep start.local.json || { echo "rein account use: could not write .ai/start.local.json" >&2; return 2; }
      echo "rein account use: this checkout launches under '${name}' (.ai/start.local.json — gitignored, yours only)"
      ;;
    -h|--help|help)
      echo "usage: rein account list | add <name> [--dir <path>] | remove <name> | sync <name> | use <name|default>"
      ;;
    *) echo "rein account: unknown subcommand '${sub}' — list | add | remove | sync | use" >&2; return 2 ;;
  esac
}
