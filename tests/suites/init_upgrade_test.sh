#!/usr/bin/env bash
# REIN_INSTALLER_SUBJECT: rein init upgrades a project in place (and runs the installer it upgrades from) (E-311, D-092)
# init_upgrade_test.sh — E-270 (D-074, version-lifecycle.md §Components 1, 2, 6): one version
# stamped twice, and `rein init` as an idempotent UPGRADE.
#
# The merge rules themselves are pinned in tests/unit/project-upgrade.test.mjs. What has to
# be proved end to end is what an operator sees when they re-run `rein init` on an old
# project:
#
#   * the installer writes ~/.rein/VERSION from package.json, and `ai --version` reads it;
#   * a fresh `rein init` stamps the project and `rein init --check` then has nothing to do;
#   * a 3.0-shaped project (no tester role, the architect on a removed provider, agy and
#     gemini in providers.json, a stale bootloader, an outdated hook stub) is upgraded to
#     the current shape with its custom values and user-added provider intact, the
#     .pre-<version> copies present and the authored .ai/ files BYTE-IDENTICAL;
#   * a second `rein init` is a no-op (--check exits 0) and re-running `rein init` no longer
#     dies at the state re-seed (it used to `exit 1` on every populated project);
#   * the doctor version line and the `rein on PATH` shadow line, both branches each.
#
# Everything runs against a fixture HOME (installed by the real installer), a fixture
# project and a fixture TMPDIR. `npm` is stubbed: `rein init` runs `npm install` for every
# MCP server, and a test must not depend on the network (a named nondeterminism).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"

echo "── Suite: init_upgrade_test (E-270) ─────────────────────────────────"

skip_unless_cmd rsync "E-270 installer fixture" || { assert_summary; exit 0; }
skip_unless_cmd sqlite3 "E-270 stamp fixture" || { assert_summary; exit 0; }

FAKE_HOME="$(test_tmpdir upg-home)"
tc_fixture_home "$FAKE_HOME"   # E-345 (D-109 r1): the toolchain record the hooks pin
FAKE_TMP="$(test_tmpdir upg-tmp)"
PROJ="$(test_tmpdir upg-proj)"
STUBS="$(test_tmpdir upg-stubs)"
printf '#!/bin/sh\nexit 0\n' > "${STUBS}/npm"; chmod +x "${STUBS}/npm"
AI_BIN="${FAKE_HOME}/.rein/bin/rein"
BASE_PATH="${STUBS}:${FAKE_HOME}/.rein/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)")"
PKG_VERSION="$(node -p 'require(process.argv[1]).version' "${REPO_ROOT}/package.json")"

# _ai <args…> — the INSTALLED rein, run inside the fixture project with the fixture env.
_ai() { ( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "$AI_BIN" "$@" ) 2>&1; }
_ai_rc() { _ai "$@" >/dev/null 2>&1; echo $?; }
assert_rc() {  # <expected> <label> <ai args…>
  local exp="$1" label="$2"; shift 2
  local got; got="$(_ai_rc "$@")"
  if [[ "$got" == "$exp" ]]; then _pass "${label} (exit=${got})"
  else _fail "${label} (expected exit=${exp}, got ${got})"; fi
}
_authored() { ( cd "${PROJ}/.ai" && cksum BRIEF.md RULES.md SEED.md DIGEST.md TASKS.md LOG.md architect.md ) 2>&1; }

# ── E-270.1: the installer records the version ────────────────────────────────
# From a NEUTRAL cwd: the installer ends with `rein install`, which regenerates the .mcp.json
# of the project it is run in. Run from the repo root, it rewrote THIS repository's
# .mcp.json with the fixture HOME's paths (found by the first run of this suite, E-240).
# E-391 (D-132 addendum 2 r1, rein-rename.md §Component 6): this install is also the rename's
# install proof — a bin/ entry left by the pre-rename install must not survive it.
_old_cmd=ai
mkdir -p "${FAKE_HOME}/.rein/bin"; printf '#!/bin/sh\nexit 0\n' > "${FAKE_HOME}/.rein/bin/${_old_cmd}"
_inst="$( cd "$FAKE_TMP" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "${REPO_ROOT}/install-rein.sh" 2>&1 )"
_irc=$?
if [[ "$_irc" -ne 0 ]]; then
  _fail "E-270.01a: the installer runs in a fixture HOME (exit=${_irc})"
  printf '%s\n' "$_inst" | tail -15
  assert_summary; exit 1
fi
_pass "E-270.01a: the installer runs in a fixture HOME"
assert_status 0 "E-391.01a: the installer installs the command as ~/.rein/bin/rein" test -x "${FAKE_HOME}/.rein/bin/rein"
assert_status 1 "E-391.01b: the pre-rename command beside it is removed" test -e "${FAKE_HOME}/.rein/bin/${_old_cmd}"
assert_contains "E-391.01c: the installer says the command is rein" "The command is rein" "$_inst"
assert_rc 0 "E-391.01d: rein doctor exits 0 on the fresh install" doctor
# D-132 addendum 4 r5 (security_engineer F4): a symlinked ~/.rein/bin is refused before
# anything is mirrored or pruned into it, and whatever it points at is left alone.
_sb_home="$(test_tmpdir upg-symbin)"; tc_fixture_home "$_sb_home"
_sb_target="$(test_tmpdir upg-symbin-target)"; echo keep > "${_sb_target}/keep"
mkdir -p "${_sb_home}/.rein"; ln -s "$_sb_target" "${_sb_home}/.rein/bin"
_sb_out="$( cd "$FAKE_TMP" && HOME="$_sb_home" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "${REPO_ROOT}/install-rein.sh" 2>&1 )"; _sb_rc=$?
assert_status 0 "E-391.01e: a symlinked ~/.rein/bin is refused with exit 3 (got ${_sb_rc})" test "$_sb_rc" -eq 3
assert_contains "E-391.01f: …naming it" "[INSTALL_BIN_SYMLINK]" "$_sb_out"
assert_status 0 "E-391.01g: …and the directory it points at is untouched" \
  test "$(command ls -A "$_sb_target")" = "keep"
assert_status 0 "E-270.01b: ~/.rein/VERSION equals package.json (${PKG_VERSION})" \
  test "$(cat "${FAKE_HOME}/.rein/VERSION")" = "$PKG_VERSION"
assert_contains "E-270.01c: the installer banner prints the package.json version" \
  "Rein v${PKG_VERSION} installed at" "$_inst"
assert_status 0 "E-270.01d: rein --version reads the stamp" \
  test "$(_ai --version)" = "rein ${PKG_VERSION}"
echo "9.8.7" > "${FAKE_HOME}/.rein/VERSION"
assert_status 0 "E-270.01e: rein --version follows ~/.rein/VERSION, not a literal" \
  test "$(_ai --version)" = "rein 9.8.7"
printf '%s\n' "$PKG_VERSION" > "${FAKE_HOME}/.rein/VERSION"

# ── E-270.2: a fresh init stamps; --check then has nothing to do ──────────────
( cd "$PROJ" && git init -q )
assert_rc 1 "E-270.02a: --check outside a project says rein init would provision" init --check
_init1="$(_ai init)"
assert_status 0 "E-270.02b: a fresh rein init stamps project.rein_version" \
  test "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["project"].get("rein_version",""))' "${PROJ}/.ai/state.json")" = "$PKG_VERSION"
assert_status 0 "E-270.02c: the fresh stamp records provisioned_at" \
  python3 -c 'import json,sys;assert json.load(open(sys.argv[1]))["project"]["provisioned_at"]' "${PROJ}/.ai/state.json"
assert_rc 0 "E-270.02d: --check after a fresh init has nothing to do" init --check
assert_rc 0 "E-270.02e: a second rein init exits 0 (the re-seed no longer exits the script)" init
_init2="$(_ai init)"
assert_contains "E-270.02f: the re-init prints the upgrade summary" "Upgrade: 0 refreshed, 0 merged" "$_init2"

# ── E-270.3: a 3.0-shaped project is upgraded ─────────────────────────────────
cat > "${PROJ}/.ai/roles.json" <<'J'
{
  "roles": {
    "architect": { "provider": "agy", "pane_identifier": "1" },
    "engineer": { "provider": "claude", "pane_identifier": "0", "model": "opus", "custom_note": "keep me" }
  },
  "x_user_key": 42
}
J
cat > "${PROJ}/.ai/providers.json" <<'J'
{
  "providers": {
    "claude": { "mcp_config_path": ".claude.json", "workspace_dir": ".claude", "mcp_key": "mcpServers", "launch": ["--my-flag"] },
    "agy": { "workspace_dir": ".agents" },
    "gemini": { "workspace_dir": ".gemini" },
    "myllm": { "workspace_dir": ".myllm" }
  }
}
J
ORIG_ROLES="$(cat "${PROJ}/.ai/roles.json")"
sqlite3 "${PROJ}/.ai/state.sqlite" "UPDATE project SET value='3.0.0' WHERE key='rein_version'"
python3 - "${PROJ}/.ai/state.json" <<'P'
import json, sys
p = sys.argv[1]; s = json.load(open(p)); s["project"]["rein_version"] = "3.0.0"
json.dump(s, open(p, "w"), indent=2)
P
echo "stale" >> "${PROJ}/ENGINEER.md"
sed -i.bak 's/is always upgraded by/is upgraded by/' "${PROJ}/.git/hooks/pre-push" && rm -f "${PROJ}/.git/hooks/pre-push.bak"
echo "# the operator's own brief" >> "${PROJ}/.ai/BRIEF.md"

_check="$(_ai init --check)"
assert_rc 1 "E-270.03a: --check exits 1 with changes pending" init --check
assert_contains "E-270.03b: --check names the version step" "project 3.0.0 → installed ${PKG_VERSION}" "$_check"
assert_contains "E-270.03c: --check lists the roles merge" "merge    .ai/roles.json" "$_check"
assert_contains "E-270.03d: --check lists the stale bootloader" "refresh  ENGINEER.md" "$_check"
assert_contains "E-270.03e: --check lists the outdated hook stub" "hooks/pre-push" "$_check"
assert_status 0 "E-270.03f: --check wrote nothing" test "$(cat "${PROJ}/.ai/roles.json")" = "$ORIG_ROLES"

AUTH_BEFORE="$(_authored)"
_up="$(_ai init)"
assert_contains "E-270.03g: init announces the upgrade" "Upgrading: project 3.0.0 → installed ${PKG_VERSION}" "$_up"
assert_match "E-270.03h: init ends with the upgrade summary" \
  'Upgrade: [0-9]+ refreshed, 2 merged, [0-9?]+ legacy items' "$_up"
assert_contains "E-270.03i: the hook stub was refreshed" "Refreshed pre-push stub" "$_up"
assert_status 0 "E-270.03j: the authored .ai/ files are byte-identical" test "$(_authored)" = "$AUTH_BEFORE"

_roles() { python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))' "${PROJ}/.ai/roles.json" "$1"; }
_prov() { python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))' "${PROJ}/.ai/providers.json" "$1"; }
assert_status 0 "E-270.03k: roles.json gained the tester role" test "$(_roles "d['roles']['tester']['model']")" = "sonnet"
assert_status 0 "E-270.03l: the agy-bound architect is back on the template default" \
  test "$(_roles "d['roles']['architect']['provider']")" = "claude"
assert_status 0 "E-270.03m: the engineer's custom value survives" \
  test "$(_roles "d['roles']['engineer']['custom_note']")" = "keep me"
assert_status 0 "E-270.03n: an unknown top-level key survives" test "$(_roles "d['x_user_key']")" = "42"
assert_status 0 "E-270.03o: providers.json dropped agy and gemini, kept the user's myllm" \
  test "$(_prov "','.join(sorted(d['providers']))")" = "claude,myllm"
assert_status 0 "E-270.03p: the claude provider keeps its custom launch argv" \
  test "$(_prov "d['providers']['claude']['launch'][0]")" = "--my-flag"
assert_status 0 "E-270.03q: roles.pre-<version>.json is the ORIGINAL file" \
  test "$(cat "${PROJ}/.ai/roles.pre-${PKG_VERSION}.json")" = "$ORIG_ROLES"
assert_exists "${PROJ}/.ai/providers.pre-${PKG_VERSION}.json"
assert_status 0 "E-270.03r: the stale bootloader was refreshed" \
  cmp -s "${PROJ}/ENGINEER.md" "${FAKE_HOME}/.rein/templates/ENGINEER.md"
assert_status 0 "E-270.03s: the project is stamped with the installed version" \
  test "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["project"]["rein_version"])' "${PROJ}/.ai/state.json")" = "$PKG_VERSION"

# ── E-270.4: idempotent — a second init is a no-op ────────────────────────────
assert_rc 0 "E-270.04a: --check after the upgrade has nothing to do" init --check
AUTH_2="$(_authored)"
_again="$(_ai init)"
assert_contains "E-270.04b: the second init refreshes and merges nothing" "Upgrade: 0 refreshed, 0 merged" "$_again"
assert_status 0 "E-270.04c: the second init left the authored files alone" test "$(_authored)" = "$AUTH_2"
assert_status 0 "E-270.04d: the backup still holds the original after a re-run" \
  test "$(cat "${PROJ}/.ai/roles.pre-${PKG_VERSION}.json")" = "$ORIG_ROLES"

# ── E-274: user-added MCP servers survive rein init and rein sync ─────────────────
python3 - "${PROJ}/.mcp.json" <<'P'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); s = d["mcpServers"]
s["my-own-server"] = {"command": "uvx", "args": ["my-own"], "env": {"K": "v"}}
s["task-synchronizer-mcp"]["env"] = {"REIN_DEBUG": "1"}
s["github-bridge-mcp"] = {"command": "node", "args": ["/old/github-bridge-mcp/index.js"]}
json.dump(d, open(p, "w"), indent=2)
P
_mq() { python3 -c 'import json,sys;d=json.load(open(sys.argv[1]))["mcpServers"];print(eval(sys.argv[2]))' "${PROJ}/.mcp.json" "$1"; }
_ai init >/dev/null
assert_status 0 "E-274.e2e.a: rein init keeps a user-added server" test "$(_mq "d['my-own-server']['env']['K']")" = "v"
assert_status 0 "E-274.e2e.b: rein init keeps a user env on an owned server" \
  test "$(_mq "d['task-synchronizer-mcp']['env']['REIN_DEBUG']")" = "1"
assert_status 0 "E-274.e2e.c: rein init removes a retired registry_history server" \
  test "$(_mq "'github-bridge-mcp' in d")" = "False"
_ai sync >/dev/null
assert_status 0 "E-274.e2e.d: rein sync keeps them too" \
  test "$(_mq "d['my-own-server']['args'][0] + d['task-synchronizer-mcp']['env']['REIN_DEBUG']")" = "my-own1"
assert_rc 0 "E-274.e2e.e: --check does not report the user's servers as pending" init --check

# ── E-270.5: doctor — the version line and the PATH line, both branches ───────
_ver_line() { printf '%s\n' "$1" | grep -E '^  [✓✗] version:' | head -1; }
_path_line() { printf '%s\n' "$1" | grep -E '^  [✓✗] rein on PATH:' | head -1; }
_doc="$(_ai doctor)"
assert_contains "E-270.05a: doctor: every copy agrees" \
  "✓ version: clone ${PKG_VERSION} · mirror ${PKG_VERSION} · project ${PKG_VERSION}" "$(_ver_line "$_doc")"
assert_contains "E-270.05b: doctor: rein on PATH is the installed one" "✓ rein on PATH: ~/.rein/bin/rein" "$(_path_line "$_doc")"
sqlite3 "${PROJ}/.ai/state.sqlite" "UPDATE project SET value='3.0.0' WHERE key='rein_version'"
python3 - "${PROJ}/.ai/state.json" <<'P'
import json, sys
p = sys.argv[1]; s = json.load(open(p)); s["project"]["rein_version"] = "3.0.0"
json.dump(s, open(p, "w"), indent=2)
P
assert_contains "E-270.05c: doctor: a project behind the mirror points at rein init" \
  "project 3.0.0 — run: rein init" "$(_ver_line "$(_ai doctor)")"
SHADOW="$(test_tmpdir upg-shadow)"
printf '#!/bin/sh\necho shadow\n' > "${SHADOW}/rein"; chmod +x "${SHADOW}/rein"
_shadowed="$( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="${SHADOW}:${BASE_PATH}" bash "$AI_BIN" doctor 2>&1 )"
assert_contains "E-270.05d: doctor: another rein earlier on PATH is reported as shadowing" \
  "(shadowed by ${SHADOW}/rein)" "$(_path_line "$_shadowed")"

# ── E-391.03 (D-132 addendum 4 r2): doctor and sync know a Rein hook by its file name ──
# A hook entry under a home directory that no longer exists (what removing an earlier
# install's directory leaves) is reported, fails doctor, and is rewritten by sync; a script
# with a Rein hook name elsewhere that DOES exist is the user's — reported, never touched.
_HP="${FAKE_HOME}/.rein/shared/hook-paths.py"
_set_hook() {  # <event> <script path> — add one exec-form entry to the fixture's settings
  python3 - "${PROJ}/.claude/settings.json" "$1" "$2" <<'PY'
import json, sys
p, ev, script = sys.argv[1:4]
d = json.load(open(p))
d.setdefault("hooks", {}).setdefault(ev, []).append(
    {"matcher": ".*", "hooks": [{"type": "command", "command": "/bin/bash", "args": ["-p", script], "timeout": 30}]})
json.dump(d, open(p, "w"), indent=2)
PY
}
_gone="${FAKE_TMP}/gone-home/.oldname/hooks"
_set_hook PreToolUse "${_gone}/pre-tool-use.sh"
_doc="$(_ai doctor)"
assert_contains "E-391.03a: doctor reports a Rein hook whose script is gone" "[HOOK_PATH_MISSING] ${_gone}/pre-tool-use.sh" "$_doc"
assert_rc 1 "E-391.03b: …and doctor exits non-zero" doctor
_ai sync >/dev/null
assert_not_contains "E-391.03c: sync rewrites the missing-path entry to the install path" "${_gone}" "$(cat "${PROJ}/.claude/settings.json")"
assert_not_contains "E-391.03d: …and doctor is clean of it" "[HOOK_PATH_MISSING]" "$(_ai doctor)"
_mine="$(test_tmpdir upg-own-hooks)"; printf '#!/bin/sh\nexit 0\n' > "${_mine}/post-tool-use.sh"
_set_hook PostToolUse "${_mine}/post-tool-use.sh"
assert_contains "E-391.03e: a Rein hook name outside the install dir is reported" "[HOOK_PATH_FOREIGN] ${_mine}/post-tool-use.sh" "$(_ai doctor)"
_ai sync >/dev/null
assert_contains "E-391.03f: …and sync leaves the user's own script registered" "${_mine}/post-tool-use.sh" "$(cat "${PROJ}/.claude/settings.json")"
python3 - "${PROJ}/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["hooks"].pop("PreToolUse", None); json.dump(d, open(p, "w"), indent=2)
PY
assert_contains "E-391.03g: no PreToolUse entry for the install's gate is [GATE_UNREGISTERED]" "[GATE_UNREGISTERED]" "$(_ai doctor)"
assert_rc 1 "E-391.03h: …and doctor exits non-zero" doctor
_ai sync >/dev/null

# ── E-391.04 (D-132 addendum 5): the installer's "projects to sync" list ──────────────
# Candidates come from Claude Code's per-project session dirs: the newest *.jsonl, its first
# 50 lines, the first string `cwd`. The fixture HOME carries four session dirs.
_cp="${FAKE_HOME}/.claude/projects"; mkdir -p "${_cp}/a" "${_cp}/b" "${_cp}/c" "${_cp}/locked"
printf '%s\n' '{"type":"summary"}' "{\"type\":\"user\",\"cwd\":\"${PROJ}\"}" > "${_cp}/a/s1.jsonl"
_plain="$(test_tmpdir upg-plain)"; mkdir -p "${_plain}/.claude"; printf '{}\n' > "${_plain}/.claude/settings.json"
printf '%s\n' "{\"cwd\":\"${_plain}\"}" > "${_cp}/b/s1.jsonl"
printf '%s\n' '{"cwd":"/nonexistent/project"}' > "${_cp}/c/s1.jsonl"
printf '%s\n' "{\"cwd\":\"${PROJ}\"}" > "${_cp}/locked/s1.jsonl"; chmod 000 "${_cp}/locked"
_set_hook PreToolUse "${_gone}/pre-tool-use.sh"
_scan() { ( cd "$FAKE_TMP" && HOME="$FAKE_HOME" PATH="$BASE_PATH" "$@" python3 -I "$_HP" projects "$FAKE_TMP" "$(cd "${FAKE_HOME}/.rein/hooks" && pwd -P)" ) 2>&1; }
_list="$(_scan env)"
_projreal="$(cd "$PROJ" && pwd -P)"
assert_contains "E-391.04a: a cwd found after the transcript's first record is listed (its hook path is missing)" "$_projreal" "$_list"
assert_not_contains "E-391.04b: a cwd without .ai/ is not a candidate" "$_plain" "$_list"
assert_not_contains "E-391.04c: a cwd that does not exist is not a candidate" "/nonexistent/project" "$_list"
assert_status 0 "E-391.04d: an unreadable session dir is skipped, the scan still answers" test "$(printf '%s\n' "$_list" | grep -c .)" -eq 1
assert_status 0 "E-391.04e: REIN_NO_PROJECT_SCAN=1 prints nothing" test -z "$(_scan env REIN_NO_PROJECT_SCAN=1)"
_inst3="$( cd "$FAKE_TMP" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "${REPO_ROOT}/install-rein.sh" 2>&1 )"
assert_contains "E-391.04f: the installer lists the project with run: rein sync" "${_projreal} — run: rein sync" "$_inst3"
assert_contains "E-391.04g: …under a heading that says the list may be incomplete" "others may exist" "$_inst3"
chmod 700 "${_cp}/locked"; _ai sync >/dev/null

# ── E-270.6: the suite left the repository alone ─────────────────────────────
# E-364: .mcp.json is generated and untracked, so a clean checkout may have none (grep would
# then exit 2, not the 1 this row expects); it is searched when it exists.
_e270_files=("${REPO_ROOT}/.claude"); [[ -f "${REPO_ROOT}/.mcp.json" ]] && _e270_files+=("${REPO_ROOT}/.mcp.json")
assert_status 1 "E-270.06a: no repository file points at the fixture HOME" \
  grep -rqF "$FAKE_HOME" "${_e270_files[@]}"

assert_summary
