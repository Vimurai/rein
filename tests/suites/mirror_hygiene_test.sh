#!/usr/bin/env bash
# AIOS_INSTALLER_SUBJECT: the installer's mirror and ai init's provisioning (E-311, D-092)
# AIOS_SUITE_TIMEOUT=300   (E-307: ~140 s on an idle host; the 180 s default leaves too little headroom)
# mirror_hygiene_test.sh — E-273 (D-074, version-lifecycle.md §Component 5): the install
# mirror and project provisioning under the same hygiene as everything else.
#
#   * the installer mirrors src/mcp and hooks/ with --delete: an orphaned server dir and an
#     orphaned hook are removed, while npm's node_modules/ and package-lock.json inside a
#     LIVE server survive, and so does config/aios-workspace.txt (installer-written);
#     `ai doctor` reported the orphans beforehand; AI_OS_INSTALL_NO_DELETE=1 keeps them;
#   * the installer's "Next steps" no longer names deprecated commands;
#   * .claude/agents is pruned by the E-220 evidence rule: an agent sync wrote and the
#     manifest no longer provides goes, an agent the user added stays;
#   * settings.json loses mcp__<server>__* allows for a server in registry_history but not
#     registry.json, and keeps allows for a server name never shipped (the user's own);
#   * `ai sync` reaps dead-pid build records and week-old role locks, keeping live ones.
#
# Fixture HOME installed by the real installer from a neutral cwd (E-270's lesson: from the
# repo root, `ai install` rewrote this repository's .mcp.json); `npm` stubbed (no network).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"

echo "── Suite: mirror_hygiene_test (E-273) ───────────────────────────────"

skip_unless_cmd rsync "E-273 installer fixture" || { assert_summary; exit 0; }

FAKE_HOME="$(test_tmpdir hyg-home)"
tc_fixture_home "$FAKE_HOME"   # E-345 (D-109 r1): the toolchain record the hooks pin
FAKE_TMP="$(test_tmpdir hyg-tmp)"
PROJ="$(test_tmpdir hyg-proj)"
STUBS="$(test_tmpdir hyg-stubs)"
printf '#!/bin/sh\nexit 0\n' > "${STUBS}/npm"; chmod +x "${STUBS}/npm"
M="${FAKE_HOME}/.ai-os"
AI_BIN="${M}/bin/ai"
BASE_PATH="${STUBS}:${M}/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)")"

_install() { ( cd "$FAKE_TMP" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" "$@" bash "${REPO_ROOT}/install-ai-os.sh" ) 2>&1; }
_ai() { ( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "$AI_BIN" "$@" ) 2>&1; }

# ── E-273.1: the installer's mirror hygiene ───────────────────────────────────
_i1="$(_install env)"
assert_contains "E-273.01a: a first install into a fixture HOME succeeds" "installed at" "$_i1"
assert_not_contains "E-273.01b: Next steps no longer name 'ai preflight'" "ai preflight" "$_i1"
assert_not_contains "E-273.01c: …nor 'ai update'" "ai update" "$_i1"

# Litter the mirror the way earlier versions did, and give a live server npm's files.
mkdir -p "${M}/mcp/retired-mcp/node_modules/dep" "${M}/mcp/task-synchronizer-mcp/node_modules/dep"
echo x > "${M}/mcp/retired-mcp/index.js"
echo x > "${M}/mcp/retired-mcp/node_modules/dep/i.js"
echo keep > "${M}/mcp/task-synchronizer-mcp/node_modules/dep/i.js"
echo '{}' > "${M}/mcp/task-synchronizer-mcp/package-lock.json"
echo x > "${M}/hooks/retired-hook.sh"
mkdir -p "${M}/shared/nested"; echo x > "${M}/shared/nested/orphan.mjs"

( cd "$PROJ" && git init -q )
_ai init >/dev/null
_doc="$(_ai doctor)"
assert_match "E-273.01d: doctor reports the mirror orphans before the install" \
  'mirror orphans: [1-9][0-9]* — run: ai clean' "$_doc"

_i_keep="$(_install env AI_OS_INSTALL_NO_DELETE=1)"
assert_status 0 "E-273.01e: AI_OS_INSTALL_NO_DELETE=1 keeps the orphans (rollback)" \
  test -f "${M}/mcp/retired-mcp/index.js" -a -f "${M}/hooks/retired-hook.sh"

_i2="$(_install env)"
assert_status 1 "E-273.01f: the orphaned server dir is gone (node_modules and all)" test -e "${M}/mcp/retired-mcp"
assert_contains "E-273.01g: the removal is announced" "Removed retired MCP server mirror" "$_i2"
assert_status 1 "E-273.01h: the orphaned hook is gone" test -e "${M}/hooks/retired-hook.sh"
assert_status 1 "E-273.01i: a nested orphan in shared/ is gone" test -e "${M}/shared/nested/orphan.mjs"
assert_status 0 "E-273.01j: a live server's node_modules survive" \
  test -f "${M}/mcp/task-synchronizer-mcp/node_modules/dep/i.js"
assert_status 0 "E-273.01k: a live server's package-lock.json survives" \
  test -f "${M}/mcp/task-synchronizer-mcp/package-lock.json"
assert_status 0 "E-273.01l: config/aios-workspace.txt (installer-written) survives" \
  test -f "${M}/config/aios-workspace.txt"
assert_status 0 "E-273.01m: the live servers are all still mirrored" \
  test -f "${M}/mcp/task-synchronizer-mcp/index.js" -a -f "${M}/mcp/shared/state-db.js"
assert_contains "E-273.01n: doctor is clean afterwards" "✓ mirror orphans: none" "$(_ai doctor)"

# ── E-273.2: .claude/agents pruned by evidence ────────────────────────────────
printf -- '---\nname: zz_retiring\n---\nbody\n' > "${M}/claude/agents/zz_retiring.md"
_ai sync >/dev/null
assert_status 0 "E-273.02a: a new source agent is provisioned" test -f "${PROJ}/.claude/agents/zz_retiring.md"
printf -- '---\nname: my_agent\n---\nmine\n' > "${PROJ}/.claude/agents/my_agent.md"
_ai sync >/dev/null
rm -f "${M}/claude/agents/zz_retiring.md"      # removed from the role manifest's source
_ai sync >/dev/null
assert_status 1 "E-273.02b: the agent sync wrote and upstream dropped is pruned" \
  test -e "${PROJ}/.claude/agents/zz_retiring.md"
_ai sync >/dev/null
assert_status 0 "E-273.02c: the user's own agent survives repeated syncs" test -f "${PROJ}/.claude/agents/my_agent.md"
assert_status 0 "E-273.02d: the canonical agents are still there" test -f "${PROJ}/.claude/agents/critic_arch.md"
assert_status 1 "E-273.02e: the agents manifest never claims the user's agent" \
  grep -q '"my_agent.md"' "${PROJ}/.claude/agents/_SYNC_MANIFEST.json"

# ── E-273.3: settings.json allows for retired servers ─────────────────────────
python3 - "${PROJ}/.claude/settings.json" <<'P'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); a = d.setdefault("permissions", {}).setdefault("allow", [])
a += ["mcp__mcp-router__activate_domain", "mcp__context-invoker-mcp__*", "mcp__my-own-server__do_it", "Bash(ls *)"]
json.dump(d, open(p, "w"), indent=2)
P
cp "${PROJ}/.claude/settings.json" "${FAKE_TMP}/settings.before.json"
echo '{"permissions":{"allow":["mcp__mcp-router__activate_domain"]}}' > "${PROJ}/.claude/settings.local.json"
_ai sync >/dev/null
_allow() { python3 -c 'import json,sys;print("\n".join(json.load(open(sys.argv[1]))["permissions"]["allow"]))' "${PROJ}/.claude/settings.json"; }
_al="$(_allow)"
assert_not_contains "E-273.03a: a retired server's allow is removed" "mcp__mcp-router__activate_domain" "$_al"
assert_not_contains "E-273.03b: a retired server's wildcard allow is removed" "mcp__context-invoker-mcp__" "$_al"
assert_contains "E-273.03c: an allow for a server never shipped (the user's) is kept" "mcp__my-own-server__do_it" "$_al"
assert_contains "E-273.03d: unrelated allows are kept" "Bash(ls *)" "$_al"
assert_contains "E-273.03e: a live server's allows are kept" "mcp__task-synchronizer-mcp__" "$_al"
assert_contains "E-273.03f: settings.local.json is never edited" "mcp__mcp-router__activate_domain" \
  "$(cat "${PROJ}/.claude/settings.local.json")"

# ── E-273.4: ai sync reaps dead ~/.ai-os/run/ records ──────────────────────────
mkdir -p "${M}/run"
printf '{"server":"x","pid":2147480000}' > "${M}/run/build-dead.json"
printf '{"server":"y","pid":%s}' "$$" > "${M}/run/build-live.json"
printf '{"v":1,"role":"engineer"}' > "${M}/run/role-old.lock"
touch -t "$(date -v-10d +%Y%m%d%H%M 2>/dev/null || date -d '10 days ago' +%Y%m%d%H%M)" "${M}/run/role-old.lock"
printf '{"v":1,"role":"engineer"}' > "${M}/run/role-new.lock"
_s="$(_ai sync)"
assert_status 1 "E-273.04a: a build record whose pid is dead is reaped" test -e "${M}/run/build-dead.json"
assert_status 0 "E-273.04b: a build record whose pid is alive is kept" test -f "${M}/run/build-live.json"
assert_status 1 "E-273.04c: a week-old role lock is reaped" test -e "${M}/run/role-old.lock"
assert_status 0 "E-273.04d: a fresh role lock is kept" test -f "${M}/run/role-new.lock"
assert_contains "E-273.04e: sync says what it reaped and how to undo it" "Reaped 2 dead ~/.ai-os/run/ record(s)" "$_s"
assert_status 0 "E-273.04f: the reaped records are in the trash, not deleted" \
  test -f "${M}/trash/$(date -u +%Y-%m-%d)/${M#/}/run/build-dead.json"

# ── E-273.6: critic_security findings, each pinned ─────────────────────────────
# The installer's helpers, extracted so each failure mode can be driven directly.
_fn() { sed -n "/^$1() {/,/^}/p" "${REPO_ROOT}/install-ai-os.sh"; }
FX="$(test_tmpdir 'hyg-fx[1]')"          # a bracket in the path: a glob if unquoted
mkdir -p "${FX}/src/keep" "${FX}/dst/keep" "${FX}/dst/gone"
echo a > "${FX}/src/keep/a.js"; echo a > "${FX}/dst/keep/a.js"; echo b > "${FX}/dst/gone/b.js"
( eval "$(_fn purge_tree_orphans)"; purge_tree_orphans "${FX}/src" "${FX}/dst" ) >/dev/null 2>&1
assert_status 0 "E-273.06a: under a [..] path a LIVE file survives the orphan pass (quoted pattern)" \
  test -f "${FX}/dst/keep/a.js"
assert_status 1 "E-273.06b: …and the orphan is still removed" test -e "${FX}/dst/gone/b.js"

mkdir -p "${FX}/emptysrc" "${FX}/mirror/live-mcp/node_modules"
echo x > "${FX}/mirror/live-mcp/index.js"
_o6="$( ( eval "$(_fn purge_retired_mcp_mirrors)"; purge_retired_mcp_mirrors "${FX}/emptysrc" "${FX}/mirror" ) 2>&1 )"
assert_status 0 "E-273.06c: a src/mcp with no servers never wipes the mirror (partial clone)" \
  test -f "${FX}/mirror/live-mcp/index.js"
assert_contains "E-273.06d: and says why it skipped" "retired-mirror cleanup skipped" "$_o6"
( eval "$(_fn purge_retired_mcp_mirrors)"; purge_retired_mcp_mirrors "${FX}/nonexistent" "${FX}/mirror" ) >/dev/null 2>&1
assert_status 0 "E-273.06e: nor does a MISSING src/mcp" test -f "${FX}/mirror/live-mcp/index.js"

# `--only` present but empty must match nothing, never widen to the whole registry.
printf '{"server":"x","pid":2147480000}' > "${M}/run/build-dead2.json"
( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" node "${M}/shared/ai-clean.mjs" apply --only "" --json ) >/dev/null 2>&1
assert_status 0 "E-273.06f: --only \"\" moves nothing" test -f "${M}/run/build-dead2.json"
( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" node "${M}/shared/ai-clean.mjs" apply --json --only ) >/dev/null 2>&1
assert_status 0 "E-273.06g: a trailing --only with no value moves nothing" test -f "${M}/run/build-dead2.json"

# ── E-304 (D-089 r2): the installer is the one installer ─────────────────────────────────
# (a) `ai sync` writes nothing into the installed code trees (it still reaps run records, E-273).
_code_sum() { ( cd "$M" && find hooks bin mcp shared claude config contracts templates scripts \
    -type f -not -path '*/node_modules/*' -not -name 'package-lock.json' 2>/dev/null | sort | xargs shasum 2>/dev/null | shasum ); }
_before="$(_code_sum)"; _ai sync >/dev/null; _after="$(_code_sum)"
assert_status 0 "E-304.01a: ai sync changes nothing under the installed code trees (checksum before == after)" test "$_before" = "$_after"
assert_status 1 "E-304.01b: ai sync no longer carries a hook-propagation step" grep -q 'Hooks propagated from framework workspace' "$AI_BIN"

# (c) the persisted record beats an exported AIOS_WORKSPACE.
printf '%s\n' "${PROJ}" > "${M}/config/aios-workspace.txt"
_ws="$( eval "$(sed -n '/^_resolve_aios_workspace() {/,/^}/p' "${REPO_ROOT}/src/bin/ai")"; AIOS="$M" AIOS_WORKSPACE=/nonexistent/env-path _resolve_aios_workspace )"
assert_status 0 "E-304.02a: with both set to different paths, the file wins (got ${_ws})" test "$_ws" = "$PROJ"
_ws="$( eval "$(sed -n '/^_resolve_aios_workspace() {/,/^}/p' "${REPO_ROOT}/src/bin/ai")"; AIOS="${FAKE_TMP}/no-such-aios" AIOS_WORKSPACE=/env/only _resolve_aios_workspace )"
assert_status 0 "E-304.02b: with no file, the exported value is honoured" test "$_ws" = "/env/only"
_dw="$( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" AIOS_WORKSPACE=/elsewhere bash "$AI_BIN" doctor 2>&1 )"
assert_contains "E-304.02c: ai doctor warns when the export and the record disagree" "disagrees with the installed record" "$_dw"

# The rc cleanup removes ONLY the exact lines an earlier install wrote, and is idempotent.
RC="${FAKE_TMP}/rc"
printf '%s\n' '# mine' 'export AIOS_WORKSPACE="/old/clone"' 'export AIOS_WORKSPACE=$HOME/custom' 'alias x=y' > "$RC"
( eval "$(sed -n '/^_aios_remove_workspace_export() {/,/^}/p' "${REPO_ROOT}/install-ai-os.sh")"
  _aios_remove_workspace_export "$RC"; _aios_remove_workspace_export "$RC" )
assert_status 0 "E-304.03a: the installer-shaped export is removed; every other line is untouched, in order (twice = once)" \
  test "$(cat "$RC")" = "$(printf '%s\n' '# mine' 'export AIOS_WORKSPACE=$HOME/custom' 'alias x=y')"
assert_status 1 "E-304.03b: the installer no longer writes the export into profiles" \
  grep -qE 'ensure_env_line[[:space:]]+".*"[[:space:]]+"AIOS_WORKSPACE"' "${REPO_ROOT}/install-ai-os.sh"

# (b) a dirty gate tree is refused, naming the files; --allow-dirty installs loudly + stamps dirty.
DW="$(test_tmpdir hyg-dirty)"; rmdir "$DW"
git -C "$REPO_ROOT" worktree add -q --detach "$DW" HEAD 2>/dev/null
register_cleanup "git -C '${REPO_ROOT}' worktree remove --force '${DW}' 2>/dev/null || true"
if [[ -d "$DW/hooks" ]]; then
  # npm artifacts are NOT dirt (`ai ci run` installs server deps before the installer runs).
  mkdir -p "$DW/src/mcp/safe-exec-mcp/node_modules/x"; echo '{}' > "$DW/src/mcp/safe-exec-mcp/package-lock.json"
  echo x > "$DW/src/mcp/safe-exec-mcp/node_modules/x/i.js"
  DH0="$(test_tmpdir hyg-npm-home)"
  ( cd "$FAKE_TMP" && HOME="$DH0" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "$DW/install-ai-os.sh" ) >/dev/null 2>&1; _nrc=$?
  assert_status 0 "E-304.04z: untracked npm artifacts under src/mcp do not make the tree dirty (rc=${_nrc})" test "$_nrc" -eq 0
  echo "# uncommitted" >> "$DW/hooks/stop-hook.sh"
  DH="$(test_tmpdir hyg-dirty-home)"
  _dout="$( cd "$FAKE_TMP" && HOME="$DH" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "$DW/install-ai-os.sh" 2>&1 )"; _drc=$?
  assert_status 0 "E-304.04a: a dirty hooks/ makes the installer exit non-zero (rc=${_drc})" test "$_drc" -ne 0
  assert_contains "E-304.04b: …naming the refusal" "[INSTALL_DIRTY_TREE]" "$_dout"
  assert_contains "E-304.04c: …and the file" "hooks/stop-hook.sh" "$_dout"
  assert_status 1 "E-304.04d: …and nothing was installed" test -e "${DH}/.ai-os/bin/ai"
  _aout="$( cd "$FAKE_TMP" && HOME="$DH" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "$DW/install-ai-os.sh" --allow-dirty 2>&1 )"
  assert_contains "E-304.04e: --allow-dirty installs with a loud banner" "--allow-dirty: installing UNCOMMITTED gate code" "$_aout"
  assert_status 0 "E-304.04f: …and records dirty=true in the install stamp" \
    python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["dirty"] is True' "${DH}/.ai-os/config/install-stamp.json"
  _dd="$( cd "$PROJ" && HOME="$DH" TMPDIR="$FAKE_TMP" PATH="${STUBS}:${DH}/.ai-os/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)")" bash "${DH}/.ai-os/bin/ai" doctor 2>&1 )"
  assert_contains "E-304.04g: ai doctor reports the uncommitted install" "installed from an UNCOMMITTED tree" "$_dd"
else
  _skip "E-304.04: could not create a scratch worktree of HEAD"
fi
assert_status 0 "E-304.05a: a clean install records dirty=false" \
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["dirty"] is False' "${M}/config/install-stamp.json"

# ── E-273.5: the suite left the repository alone ──────────────────────────────
# E-364: .mcp.json is generated and untracked; it is searched when it exists (grep exits 2 on a
# missing file, not the 1 this row expects).
_e273_files=("${REPO_ROOT}/.claude"); [[ -f "${REPO_ROOT}/.mcp.json" ]] && _e273_files+=("${REPO_ROOT}/.mcp.json")
assert_status 1 "E-273.05a: no repository file points at the fixture HOME" \
  grep -rqF "$FAKE_HOME" "${_e273_files[@]}"

assert_summary
