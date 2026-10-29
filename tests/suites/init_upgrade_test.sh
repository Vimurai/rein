#!/usr/bin/env bash
# REIN_INSTALLER_SUBJECT: ai init upgrades a project in place (and runs the installer it upgrades from) (E-311, D-092)
# init_upgrade_test.sh — E-270 (D-074, version-lifecycle.md §Components 1, 2, 6): one version
# stamped twice, and `ai init` as an idempotent UPGRADE.
#
# The merge rules themselves are pinned in tests/unit/project-upgrade.test.mjs. What has to
# be proved end to end is what an operator sees when they re-run `ai init` on an old
# project:
#
#   * the installer writes ~/.rein/VERSION from package.json, and `ai --version` reads it;
#   * a fresh `ai init` stamps the project and `ai init --check` then has nothing to do;
#   * a 3.0-shaped project (no tester role, the architect on a removed provider, agy and
#     gemini in providers.json, a stale bootloader, an outdated hook stub) is upgraded to
#     the current shape with its custom values and user-added provider intact, the
#     .pre-<version> copies present and the authored .ai/ files BYTE-IDENTICAL;
#   * a second `ai init` is a no-op (--check exits 0) and re-running `ai init` no longer
#     dies at the state re-seed (it used to `exit 1` on every populated project);
#   * the doctor version line and the `ai on PATH` shadow line, both branches each.
#
# Everything runs against a fixture HOME (installed by the real installer), a fixture
# project and a fixture TMPDIR. `npm` is stubbed: `ai init` runs `npm install` for every
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
AI_BIN="${FAKE_HOME}/.rein/bin/ai"
BASE_PATH="${STUBS}:${FAKE_HOME}/.rein/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)")"
PKG_VERSION="$(node -p 'require(process.argv[1]).version' "${REPO_ROOT}/package.json")"

# _ai <args…> — the INSTALLED ai, run inside the fixture project with the fixture env.
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
# From a NEUTRAL cwd: the installer ends with `ai install`, which regenerates the .mcp.json
# of the project it is run in. Run from the repo root, it rewrote THIS repository's
# .mcp.json with the fixture HOME's paths (found by the first run of this suite, E-240).
# E-383 (D-132 r3, rein-rename.md §Component 6): this first install is also the rename's
# install proof — the fixture home is seeded under the pre-rename name, so the installer
# must move it to ~/.rein once and leave a symlink (no extra install run).
mv "${FAKE_HOME}/.rein" "${FAKE_HOME}/.ai-os"  # rename:legacy-fallback
echo seeded > "${FAKE_HOME}/.ai-os/seed-marker"  # rename:legacy-fallback
_inst="$( cd "$FAKE_TMP" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "${REPO_ROOT}/install-rein.sh" 2>&1 )"
_irc=$?
if [[ "$_irc" -ne 0 ]]; then
  _fail "E-270.01a: the installer runs in a fixture HOME (exit=${_irc})"
  printf '%s\n' "$_inst" | tail -15
  assert_summary; exit 1
fi
_pass "E-270.01a: the installer runs in a fixture HOME"
assert_status 0 "E-383.01a: the pre-rename home moved to ~/.rein with its contents" \
  test "$(cat "${FAKE_HOME}/.rein/seed-marker" 2>/dev/null)" = seeded
assert_status 0 "E-383.01b: the pre-rename home is now a symlink to ~/.rein" \
  test "$(readlink "${FAKE_HOME}/.ai-os")" = "${FAKE_HOME}/.rein"  # rename:legacy-fallback
assert_contains "E-383.01c: doctor reports the link" "[LEGACY_HOME_LINK]" "$(_ai doctor)"
_inst2="$( cd "$FAKE_TMP" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "${REPO_ROOT}/install-rein.sh" 2>&1 | grep -F 'Moved' )"
assert_status 0 "E-383.01d: a re-install leaves the symlink alone (the move happens once)" test -z "$_inst2"
CONFLICT_HOME="$(test_tmpdir upg-conflict)"
mkdir -p "${CONFLICT_HOME}/.ai-os" "${CONFLICT_HOME}/.rein"  # rename:legacy-fallback
_conf="$( cd "$FAKE_TMP" && HOME="$CONFLICT_HOME" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "${REPO_ROOT}/install-rein.sh" 2>&1 )"
_crc=$?
assert_status 0 "E-383.01e: a real pre-rename dir beside ~/.rein is refused with exit 2 (got ${_crc})" test "$_crc" -eq 2
assert_contains "E-383.01e2: the refusal names the conflict" "[LEGACY_HOME_CONFLICT]" "$_conf"
assert_status 0 "E-383.01f: the refused install touched neither directory" \
  test -d "${CONFLICT_HOME}/.ai-os" -a ! -L "${CONFLICT_HOME}/.ai-os" -a -z "$(command ls -A "${CONFLICT_HOME}/.rein")"  # rename:legacy-fallback
assert_status 0 "E-270.01b: ~/.rein/VERSION equals package.json (${PKG_VERSION})" \
  test "$(cat "${FAKE_HOME}/.rein/VERSION")" = "$PKG_VERSION"
assert_contains "E-270.01c: the installer banner prints the package.json version" \
  "Rein v${PKG_VERSION} installed at" "$_inst"
assert_status 0 "E-270.01d: ai --version reads the stamp" \
  test "$(_ai --version)" = "rein ${PKG_VERSION}"
echo "9.8.7" > "${FAKE_HOME}/.rein/VERSION"
assert_status 0 "E-270.01e: ai --version follows ~/.rein/VERSION, not a literal" \
  test "$(_ai --version)" = "rein 9.8.7"
printf '%s\n' "$PKG_VERSION" > "${FAKE_HOME}/.rein/VERSION"

# ── E-270.2: a fresh init stamps; --check then has nothing to do ──────────────
( cd "$PROJ" && git init -q )
assert_rc 1 "E-270.02a: --check outside a project says ai init would provision" init --check
_init1="$(_ai init)"
assert_status 0 "E-270.02b: a fresh ai init stamps project.rein_version" \
  test "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["project"].get("rein_version",""))' "${PROJ}/.ai/state.json")" = "$PKG_VERSION"
assert_status 0 "E-270.02c: the fresh stamp records provisioned_at" \
  python3 -c 'import json,sys;assert json.load(open(sys.argv[1]))["project"]["provisioned_at"]' "${PROJ}/.ai/state.json"
assert_rc 0 "E-270.02d: --check after a fresh init has nothing to do" init --check
assert_rc 0 "E-270.02e: a second ai init exits 0 (the re-seed no longer exits the script)" init
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

# ── E-274: user-added MCP servers survive ai init and ai sync ─────────────────
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
assert_status 0 "E-274.e2e.a: ai init keeps a user-added server" test "$(_mq "d['my-own-server']['env']['K']")" = "v"
assert_status 0 "E-274.e2e.b: ai init keeps a user env on an owned server" \
  test "$(_mq "d['task-synchronizer-mcp']['env']['REIN_DEBUG']")" = "1"
assert_status 0 "E-274.e2e.c: ai init removes a retired registry_history server" \
  test "$(_mq "'github-bridge-mcp' in d")" = "False"
_ai sync >/dev/null
assert_status 0 "E-274.e2e.d: ai sync keeps them too" \
  test "$(_mq "d['my-own-server']['args'][0] + d['task-synchronizer-mcp']['env']['REIN_DEBUG']")" = "my-own1"
assert_rc 0 "E-274.e2e.e: --check does not report the user's servers as pending" init --check

# ── E-270.5: doctor — the version line and the PATH line, both branches ───────
_ver_line() { printf '%s\n' "$1" | grep -E '^  [✓✗] version:' | head -1; }
_path_line() { printf '%s\n' "$1" | grep -E '^  [✓✗] ai on PATH:' | head -1; }
_doc="$(_ai doctor)"
assert_contains "E-270.05a: doctor: every copy agrees" \
  "✓ version: clone ${PKG_VERSION} · mirror ${PKG_VERSION} · project ${PKG_VERSION}" "$(_ver_line "$_doc")"
assert_contains "E-270.05b: doctor: ai on PATH is the installed one" "✓ ai on PATH: ~/.rein/bin/ai" "$(_path_line "$_doc")"
sqlite3 "${PROJ}/.ai/state.sqlite" "UPDATE project SET value='3.0.0' WHERE key='rein_version'"
python3 - "${PROJ}/.ai/state.json" <<'P'
import json, sys
p = sys.argv[1]; s = json.load(open(p)); s["project"]["rein_version"] = "3.0.0"
json.dump(s, open(p, "w"), indent=2)
P
assert_contains "E-270.05c: doctor: a project behind the mirror points at ai init" \
  "project 3.0.0 — run: ai init" "$(_ver_line "$(_ai doctor)")"
SHADOW="$(test_tmpdir upg-shadow)"
printf '#!/bin/sh\necho shadow\n' > "${SHADOW}/ai"; chmod +x "${SHADOW}/ai"
_shadowed="$( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="${SHADOW}:${BASE_PATH}" bash "$AI_BIN" doctor 2>&1 )"
assert_contains "E-270.05d: doctor: another ai earlier on PATH is reported as shadowing" \
  "(shadowed by ${SHADOW}/ai)" "$(_path_line "$_shadowed")"

# ── E-383.2: doctor names what still carries the old name ────────────────────
_legacy_env="$( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" AI_OS_E383_PROBE=1 bash "$AI_BIN" doctor 2>&1 )"  # rename:legacy-fallback
assert_contains "E-383.02a: doctor reports an old-prefix variable" \
  "[LEGACY_ENV] AI_OS_E383_PROBE → REIN_E383_PROBE" "$_legacy_env"  # rename:legacy-fallback
_shadowed_env="$( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" AI_OS_E383_PROBE=1 REIN_E383_PROBE=2 bash "$AI_BIN" doctor 2>&1 )"  # rename:legacy-fallback
assert_contains "E-383.02b: an old variable beside the new one is reported as ignored" \
  "(ignored: REIN_E383_PROBE is set)" "$_shadowed_env"
assert_not_contains "E-383.02c: a project ai init just provisioned has nothing pending" "[RENAME_PENDING]" "$(_ai doctor)"
( cd "$PROJ" && git config merge.aios-record.driver true )  # rename:legacy-fallback
assert_contains "E-383.02d: the pre-rename merge driver is pending until ai sync" \
  "[RENAME_PENDING] .git/config merge driver" "$(_ai doctor)"
( cd "$PROJ" && git config --remove-section merge.aios-record )  # rename:legacy-fallback

# ── E-270.6: the suite left the repository alone ─────────────────────────────
# E-364: .mcp.json is generated and untracked, so a clean checkout may have none (grep would
# then exit 2, not the 1 this row expects); it is searched when it exists.
_e270_files=("${REPO_ROOT}/.claude"); [[ -f "${REPO_ROOT}/.mcp.json" ]] && _e270_files+=("${REPO_ROOT}/.mcp.json")
assert_status 1 "E-270.06a: no repository file points at the fixture HOME" \
  grep -rqF "$FAKE_HOME" "${_e270_files[@]}"

assert_summary
