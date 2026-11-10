#!/usr/bin/env bash
# REIN_INSTALLER_SUBJECT: the installer's mirror and rein init's provisioning (E-311, D-092)
# REIN_SUITE_TIMEOUT=492   (E-401, D-138 r3: 3x the slowest green hosted run — 87 s Linux / 164 s macOS, CENSUS_SUITE ms over 10 main CI runs 41145231705..42041035881, 2026-11-06)
# mirror_hygiene_test.sh — E-273 (D-074, version-lifecycle.md §Component 5): the install
# mirror and project provisioning under the same hygiene as everything else.
#
#   * the installer mirrors src/mcp and hooks/ with --delete: an orphaned server dir and an
#     orphaned hook are removed, while npm's node_modules/ and package-lock.json inside a
#     LIVE server survive, and so does config/rein-workspace.txt (installer-written);
#     `rein doctor` reported the orphans beforehand; REIN_INSTALL_NO_DELETE=1 keeps them;
#   * the installer's "Next steps" no longer names deprecated commands;
#   * .claude/agents is pruned by the E-220 evidence rule: an agent sync wrote and the
#     manifest no longer provides goes, an agent the user added stays;
#   * settings.json loses mcp__<server>__* allows for a server in registry_history but not
#     registry.json, and keeps allows for a server name never shipped (the user's own);
#   * `rein sync` reaps dead-pid build records and week-old role locks, keeping live ones.
#
# Fixture HOME installed by the real installer from a neutral cwd (E-270's lesson: from the
# repo root, `rein install` rewrote this repository's .mcp.json); `npm` stubbed (no network).
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
M="${FAKE_HOME}/.rein"
AI_BIN="${M}/bin/rein"
BASE_PATH="${STUBS}:${M}/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)")"

_install() { ( cd "$FAKE_TMP" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" "$@" bash "${REPO_ROOT}/install-rein.sh" ) 2>&1; }
_ai() { ( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "$AI_BIN" "$@" ) 2>&1; }

# ── E-273.1: the installer's mirror hygiene ───────────────────────────────────
_i1="$(_install env)"
assert_contains "E-273.01a: a first install into a fixture HOME succeeds" "installed at" "$_i1"
assert_not_contains "E-273.01b: Next steps no longer name 'rein preflight'" "rein preflight" "$_i1"
assert_not_contains "E-273.01c: …nor 'rein update'" "rein update" "$_i1"

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
  'mirror orphans: [1-9][0-9]* — run: rein clean' "$_doc"

_i_keep="$(_install env REIN_INSTALL_NO_DELETE=1)"
assert_status 0 "E-273.01e: REIN_INSTALL_NO_DELETE=1 keeps the orphans (rollback)" \
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
assert_status 0 "E-273.01l: config/rein-workspace.txt (installer-written) survives" \
  test -f "${M}/config/rein-workspace.txt"
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

# ── E-273.4: rein sync reaps dead ~/.rein/run/ records ──────────────────────────
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
assert_contains "E-273.04e: sync says what it reaped and how to undo it" "Reaped 2 dead ~/.rein/run/ record(s)" "$_s"
assert_status 0 "E-273.04f: the reaped records are in the trash, not deleted" \
  test -f "${M}/trash/$(date -u +%Y-%m-%d)/${M#/}/run/build-dead.json"

# ── E-273.6: critic_security findings, each pinned ─────────────────────────────
# The installer's helpers, extracted so each failure mode can be driven directly.
_fn() { sed -n "/^$1() {/,/^}/p" "${REPO_ROOT}/install-rein.sh"; }
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
( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" node "${M}/shared/rein-clean.mjs" apply --only "" --json ) >/dev/null 2>&1
assert_status 0 "E-273.06f: --only \"\" moves nothing" test -f "${M}/run/build-dead2.json"
( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" node "${M}/shared/rein-clean.mjs" apply --json --only ) >/dev/null 2>&1
assert_status 0 "E-273.06g: a trailing --only with no value moves nothing" test -f "${M}/run/build-dead2.json"

# ── E-304 (D-089 r2): the installer is the one installer ─────────────────────────────────
# (a) `rein sync` writes nothing into the installed code trees (it still reaps run records, E-273).
_code_sum() { ( cd "$M" && find hooks bin mcp shared claude config contracts templates scripts \
    -type f -not -path '*/node_modules/*' -not -name 'package-lock.json' 2>/dev/null | sort | xargs shasum 2>/dev/null | shasum ); }
_before="$(_code_sum)"; _ai sync >/dev/null; _after="$(_code_sum)"
assert_status 0 "E-304.01a: rein sync changes nothing under the installed code trees (checksum before == after)" test "$_before" = "$_after"
assert_status 1 "E-304.01b: rein sync no longer carries a hook-propagation step" grep -q 'Hooks propagated from framework workspace' "$AI_BIN"

# (c) the persisted record beats an exported REIN_WORKSPACE.
printf '%s\n' "${PROJ}" > "${M}/config/rein-workspace.txt"
_ws="$( eval "$(sed -n '/^_resolve_rein_workspace() {/,/^}/p' "${REPO_ROOT}/src/bin/rein")"; REIN="$M" REIN_WORKSPACE=/nonexistent/env-path _resolve_rein_workspace )"
assert_status 0 "E-304.02a: with both set to different paths, the file wins (got ${_ws})" test "$_ws" = "$PROJ"
_ws="$( eval "$(sed -n '/^_resolve_rein_workspace() {/,/^}/p' "${REPO_ROOT}/src/bin/rein")"; REIN="${FAKE_TMP}/no-such-rein" REIN_WORKSPACE=/env/only _resolve_rein_workspace )"
assert_status 0 "E-304.02b: with no file, the exported value is honoured" test "$_ws" = "/env/only"
_dw="$( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" REIN_WORKSPACE=/elsewhere bash "$AI_BIN" doctor 2>&1 )"
assert_contains "E-304.02c: rein doctor warns when the export and the record disagree" "disagrees with the installed record" "$_dw"

# The rc cleanup removes ONLY the exact lines an earlier install wrote, and is idempotent.
RC="${FAKE_TMP}/rc"
printf '%s\n' '# mine' 'export REIN_WORKSPACE="/old/clone"' 'export REIN_WORKSPACE=$HOME/custom' 'alias x=y' > "$RC"
( eval "$(sed -n '/^_rein_remove_workspace_export() {/,/^}/p' "${REPO_ROOT}/install-rein.sh")"
  _rein_remove_workspace_export "$RC"; _rein_remove_workspace_export "$RC" )
assert_status 0 "E-304.03a: the installer-shaped export is removed; every other line is untouched, in order (twice = once)" \
  test "$(cat "$RC")" = "$(printf '%s\n' '# mine' 'export REIN_WORKSPACE=$HOME/custom' 'alias x=y')"
assert_status 1 "E-304.03b: the installer no longer writes the export into profiles" \
  grep -qE 'ensure_env_line[[:space:]]+".*"[[:space:]]+"REIN_WORKSPACE"' "${REPO_ROOT}/install-rein.sh"

# (b) a dirty gate tree is refused, naming the files; --allow-dirty installs loudly + stamps dirty.
DW="$(test_tmpdir hyg-dirty)"; rmdir "$DW"
git -C "$REPO_ROOT" worktree add -q --detach "$DW" HEAD 2>/dev/null
register_cleanup "git -C '${REPO_ROOT}' worktree remove --force '${DW}' 2>/dev/null || true"
if [[ -d "$DW/hooks" ]]; then
  # npm artifacts are NOT dirt (`rein ci run` installs server deps before the installer runs).
  mkdir -p "$DW/src/mcp/safe-exec-mcp/node_modules/x"; echo '{}' > "$DW/src/mcp/safe-exec-mcp/package-lock.json"
  echo x > "$DW/src/mcp/safe-exec-mcp/node_modules/x/i.js"
  DH0="$(test_tmpdir hyg-npm-home)"
  ( cd "$FAKE_TMP" && HOME="$DH0" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "$DW/install-rein.sh" ) >/dev/null 2>&1; _nrc=$?
  assert_status 0 "E-304.04z: untracked npm artifacts under src/mcp do not make the tree dirty (rc=${_nrc})" test "$_nrc" -eq 0

  # E-417 (D-155 r1, release-artifact.md §Component 1): extends E-304.04z — the same worktree,
  # its untracked npm artifacts still in place, staged instead of installed. The stage must be
  # the install minus what the install writes for its host, and --stage writes nothing in HOME.
  _tree_list() {  # <root> → "rel x|- sha256" per file under the ten mirrored dirs, npm's files and the host records excluded
    python3 -I - "$1" <<'PYLIST'
import hashlib, os, sys
root = sys.argv[1]
skip = {"config/rein-workspace.txt", "config/install-stamp.json", "shared/toolchain.sh"}
for top in ("contracts", "templates", "shared", "claude", "copilot", "config", "mcp", "bin", "scripts", "hooks"):
    for d, dirs, files in os.walk(os.path.join(root, top)):
        dirs[:] = [x for x in dirs if x != "node_modules"]
        for f in files:
            p = os.path.join(d, f); rel = os.path.relpath(p, root)
            if rel in skip or f == "package-lock.json":
                continue
            x = "x" if os.stat(p).st_mode & 0o111 else "-"
            print(rel, x, hashlib.sha256(open(p, "rb").read()).hexdigest())
PYLIST
  }
  _home_sum() { ( cd "$1" && find . -print | sort; find . -type f -print0 | sort -z | xargs -0 shasum 2>/dev/null ) | shasum; }
  SH="$(test_tmpdir hyg-stage-home)"; tc_fixture_home "$SH"
  ST="$(test_tmpdir hyg-stage)"; rmdir "$ST"
  _sh_before="$(_home_sum "$SH")"
  _sout="$( cd "$FAKE_TMP" && HOME="$SH" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "$DW/install-rein.sh" --stage "$ST" 2>&1 )"; _src=$?
  assert_status 0 "E-417.01a: --stage of a clean checkout exits 0 (rc=${_src})" test "$_src" -eq 0
  assert_status 0 "E-417.01b: …and the fixture HOME is byte-unchanged" test "$(_home_sum "$SH")" = "$_sh_before"
  assert_status 0 "E-417.01c: the stage holds exactly the ten mirrored directories" \
    test "$(cd "$ST" 2>/dev/null && find . -mindepth 1 -maxdepth 1 | sed 's|^\./||' | sort | tr '\n' ' ')" = "bin claude config contracts copilot hooks mcp scripts shared templates "
  _ldiff="$(diff <(_tree_list "$ST") <(_tree_list "${DH0}/.rein") 2>&1)"
  assert_status 0 "E-417.01d: same file set, bytes and execute bits as a normal install of the same tree${_ldiff:+ — ${_ldiff:0:400}}" test -z "$_ldiff"
  assert_status 1 "E-417.01e: the untracked src/mcp/safe-exec-mcp/package-lock.json is not staged" \
    test -e "${ST}/mcp/safe-exec-mcp/package-lock.json"
  assert_status 1 "E-417.01f: nor is node_modules/" test -e "${ST}/mcp/safe-exec-mcp/node_modules"
  _nout="$( cd "$FAKE_TMP" && HOME="$SH" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "$DW/install-rein.sh" --stage "$ST" 2>&1 )"; _nrc2=$?
  assert_status 0 "E-417.01g: a non-empty stage directory is refused with exit 3 (rc=${_nrc2})" test "$_nrc2" -eq 3
  assert_contains "E-417.01h: …naming the refusal" "[INSTALL_STAGE_NOT_EMPTY]" "$_nout"
  # `rein release stage`: the checkout's own rein stages; a mirror with no clone refuses.
  ST2="$(test_tmpdir hyg-stage2)"; rmdir "$ST2"
  ( cd "$FAKE_TMP" && HOME="$SH" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" env -u REIN_WORKSPACE bash "$DW/src/bin/rein" release stage "$ST2" ) >/dev/null 2>&1; _rrc=$?
  assert_status 0 "E-417.02a: rein release stage from the checkout writes the same stage (rc=${_rrc})" \
    test "$_rrc" -eq 0 -a "$(_tree_list "$ST2")" = "$(_tree_list "$ST")"
  _mout="$( cd "$FAKE_TMP" && HOME="$SH" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" env -u REIN_WORKSPACE bash "${DH0}/.rein/bin/rein" release stage "${FAKE_TMP}/never" 2>&1 )"; _mrc=$?
  assert_status 0 "E-417.02b: from a mirror with no clone it refuses with exit 2 (rc=${_mrc})" test "$_mrc" -eq 2
  assert_contains "E-417.02c: …saying it needs a checkout" "rein release stage: needs a checkout" "$_mout"
  assert_status 0 "E-417.02d: rein help lists rein release stage" \
    bash -c "grep < <(bash '$DW/src/bin/rein' help 2>&1) -q '^  rein release stage'"

  # E-418 (D-153 r2, D-155 r1-r2): extends E-417.01 — the contract row over the real stage.
  # The unit rows (tests/unit/release-manifest.test.mjs) cover each refusal and each verify
  # finding; this one is the process boundary: the CLI, the checkout's version, a real tree.
  _rm() { ( cd "$FAKE_TMP" && HOME="$SH" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" env -u REIN_WORKSPACE bash "$DW/src/bin/rein" release "$@" ) 2>&1; }
  RO1="$(test_tmpdir hyg-rel1)"; RO2="$(test_tmpdir hyg-rel2)"
  _m1="$(_rm manifest "$ST" --out "$RO1" --pubkey "$DW/docs/contract/release-key.pub")"; _m1rc=$?
  _rm manifest "$ST" --out "$RO2" --pubkey "$DW/docs/contract/release-key.pub" >/dev/null
  _ver="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$DW/package.json" | head -1)"
  assert_status 0 "E-418.06a: rein release manifest of the stage exits 0 and writes rein-${_ver}.tar.gz (rc=${_m1rc})" \
    test "$_m1rc" -eq 0 -a -f "${RO1}/rein-${_ver}.tar.gz" -a -f "${RO1}/manifest.json"
  assert_status 0 "E-418.06b: two runs give a byte-identical manifest.json" cmp -s "${RO1}/manifest.json" "${RO2}/manifest.json"
  _v="$(_rm verify "${RO1}/rein-${_ver}.tar.gz")"; _vrc=$?
  assert_status 0 "E-418.06c: rein release verify of that tarball exits 0 (rc=${_vrc})" test "$_vrc" -eq 0
  assert_contains "E-418.06d: …and says the signature was not checked" "signature not checked" "$_v"
  # E-422 (D-153, D-155; release-artifact.md §Component 6): extends E-418.06 — the manifest of the
  # real stage against the published schema, and its layout against the pinned layout-v1.json.
  _mval="$(node "$REPO_ROOT/tests/lib/json-schema-lite.mjs" "$DW/docs/contract/manifest.schema.json" "${RO1}/manifest.json" 2>&1)"; _mvrc=$?
  assert_status 0 "E-422.01a: the stage's manifest.json is valid against docs/contract/manifest.schema.json${_mval:+ — ${_mval:0:300}}" test "$_mvrc" -eq 0
  _lay="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1])); const p=JSON.parse(fs.readFileSync(process.argv[2])); process.stdout.write(JSON.stringify(m.layout)===JSON.stringify(p)?"same":"a layout change is a breaking version — contract §2.2")' "${RO1}/manifest.json" "$DW/tests/fixtures/release/layout-v1.json" 2>&1)"
  assert_status 0 "E-422.01b: the stage's layout equals tests/fixtures/release/layout-v1.json${_lay:+ (${_lay})}" test "$_lay" = "same"
  assert_status 0 "E-418.06f: rein help lists rein release manifest and verify" \
    bash -c "grep < <(bash '$DW/src/bin/rein' help 2>&1) -q '^  rein release manifest' && grep < <(bash '$DW/src/bin/rein' help 2>&1) -q '^  rein release verify'"
  # E-420 (D-155 r4, addenda r1-r3): extends E-418.06 — the tarball above, unpacked into a fixture
  # HOME by the §Data Model installer rule (tests/lib/release-unpack.mjs), finished by `rein
  # install`, then used: init, sync and doctor in a project with no workspace record. The tree
  # must equal the clone install of the same commit (DH0, E-304.04z), both taken after `rein install`.
  _ai_in() {  # <home> <cwd> <rein args…>
    local h="$1" d="$2"; shift 2
    ( cd "$d" && HOME="$h" TMPDIR="$FAKE_TMP" CI=1 REIN_NO_PROJECT_SCAN=1 PATH="${STUBS}:${h}/.rein/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)")" \
        env -u REIN_WORKSPACE bash "${h}/.rein/bin/rein" "$@" ) </dev/null 2>&1
  }
  AH="$(test_tmpdir hyg-art-home)"; APROJ="$(test_tmpdir hyg-art-proj)"; ( cd "$APROJ" && git init -q )
  node "$REPO_ROOT/tests/lib/release-unpack.mjs" "$DW" "${RO1}/rein-${_ver}.tar.gz" "${AH}/.rein"
  _ai_out="$(_ai_in "$AH" "$FAKE_TMP" install)"; _ai_rc=$?
  assert_status 0 "E-420.01a: rein install finishes the unpacked artifact (rc=${_ai_rc})" test "$_ai_rc" -eq 0
  assert_contains "E-420.01b: …after checking it against its manifest" "matches its manifest (manifest key_id 5C9C75A7C8FA8056) and is finished" "$_ai_out"
  _adiff="$(diff <(_tree_list "${AH}/.rein") <(_tree_list "${DH0}/.rein") 2>&1)"
  assert_status 0 "E-420.01c: the same files under the mirrored directories as the clone install${_adiff:+ — ${_adiff:0:400}}" test -z "$_adiff"
  assert_status 0 "E-420.01d: the hook toolchain is pinned" grep -q '^REIN_TC_NODE=' "${AH}/.rein/shared/toolchain.sh"
  assert_status 0 "E-420.01e: the stamp says artifact, with the key id" \
    python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["source"]=="artifact" and d["key_id"]=="5C9C75A7C8FA8056" and d["version"]==sys.argv[2], d' \
    "${AH}/.rein/config/install-stamp.json" "$_ver"
  assert_status 1 "E-420.01f: and there is no clone record" test -e "${AH}/.rein/config/rein-workspace.txt"
  _ai_in "$AH" "$APROJ" init >/dev/null; _ai_in "$AH" "$APROJ" sync >/dev/null
  _adoc="$(_ai_in "$AH" "$APROJ" doctor)"; _adrc=$?
  assert_status 0 "E-420.01g: rein doctor in the project exits 0 (rc=${_adrc})" test "$_adrc" -eq 0
  assert_contains "E-420.01h: …and reports the artifact install" "install: artifact ${_ver} (key 5C9C75A7C8FA8056)" "$_adoc"
  # A flipped byte in a gate hook is refused before anything is pinned or stamped.
  AH2="$(test_tmpdir hyg-art-home2)"
  node "$REPO_ROOT/tests/lib/release-unpack.mjs" "$DW" "${RO1}/rein-${_ver}.tar.gz" "${AH2}/.rein"
  python3 -I -c 'import sys; p=sys.argv[1]; b=bytearray(open(p,"rb").read()); b[10]^=1; open(p,"wb").write(b)' "${AH2}/.rein/hooks/pre-tool-use.sh"
  _ai2="$(_ai_in "$AH2" "$FAKE_TMP" install)"; _ai2rc=$?
  assert_status 0 "E-420.02a: a flipped byte in hooks/pre-tool-use.sh exits 3 (rc=${_ai2rc})" test "$_ai2rc" -eq 3
  assert_contains "E-420.02b: …naming the mismatch and the file" "hooks/pre-tool-use.sh" "$_ai2"
  assert_contains "E-420.02c: …as [INSTALL_TREE_MISMATCH]" "[INSTALL_TREE_MISMATCH]" "$_ai2"
  assert_status 1 "E-420.02d: …before any pin or stamp is written" \
    test -e "${AH2}/.rein/shared/toolchain.sh" -o -e "${AH2}/.rein/config/install-stamp.json"
  # security_engineer E-420 F1: a second name for a gate hook is refused the same way.
  AH3="$(test_tmpdir hyg-art-home3)"
  node "$REPO_ROOT/tests/lib/release-unpack.mjs" "$DW" "${RO1}/rein-${_ver}.tar.gz" "${AH3}/.rein"
  ln "${AH3}/.rein/hooks/pre-tool-use.sh" "${AH3}/hard-link"
  _ai3="$(_ai_in "$AH3" "$FAKE_TMP" install)"; _ai3rc=$?
  assert_status 0 "E-420.02e: a hard-linked hooks/pre-tool-use.sh exits 3 (rc=${_ai3rc})" test "$_ai3rc" -eq 3
  assert_status 1 "E-420.02f: …before any pin is written" test -e "${AH3}/.rein/shared/toolchain.sh"
  # A clone install over the artifact install leaves no manifest.json and a clone stamp.
  ( cd "$FAKE_TMP" && HOME="$AH" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" REIN_NO_PROJECT_SCAN=1 bash "$DW/install-rein.sh" ) >/dev/null 2>&1
  assert_status 1 "E-420.03a: a clone install afterwards removes manifest.json" test -e "${AH}/.rein/manifest.json"
  assert_status 0 "E-420.03b: …and stamps the clone" \
    python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["source"]==sys.argv[2] and "key_id" not in d, d' \
    "${AH}/.rein/config/install-stamp.json" "$DW"
  # D-155 addendum r3: a stamp that contradicts the tree ("artifact" with no manifest.json, as a
  # rollback to an older snapshot leaves) is rewritten as "restored", and doctor says so.
  printf '{"source": "artifact", "version": "%s", "key_id": "5C9C75A7C8FA8056"}' "$_ver" > "${AH}/.rein/config/install-stamp.json"
  _ai_in "$AH" "$FAKE_TMP" install >/dev/null
  assert_status 0 "E-420.03c: rein install rewrites a contradicting stamp as restored" \
    python3 -I -c 'import json,sys; assert json.load(open(sys.argv[1]))["source"]=="restored"' "${AH}/.rein/config/install-stamp.json"
  assert_contains "E-420.03d: …and doctor reports a restored tree" "install: restored tree, origin not recorded" "$(_ai_in "$AH" "$APROJ" doctor)"
  assert_status 0 "E-418.06e: the manifest lists every staged file, no more" \
    test "$(python3 -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["files"]))' "${RO1}/manifest.json")" = "$(cd "$ST" && find . -type f | wc -l | tr -d ' ')"
  echo "# uncommitted" >> "$DW/hooks/stop-hook.sh"
  DH="$(test_tmpdir hyg-dirty-home)"
  _dout="$( cd "$FAKE_TMP" && HOME="$DH" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "$DW/install-rein.sh" 2>&1 )"; _drc=$?
  assert_status 0 "E-304.04a: a dirty hooks/ makes the installer exit non-zero (rc=${_drc})" test "$_drc" -ne 0
  assert_contains "E-304.04b: …naming the refusal" "[INSTALL_DIRTY_TREE]" "$_dout"
  assert_contains "E-304.04c: …and the file" "hooks/stop-hook.sh" "$_dout"
  assert_status 1 "E-304.04d: …and nothing was installed" test -e "${DH}/.rein/bin/rein"
  _aout="$( cd "$FAKE_TMP" && HOME="$DH" TMPDIR="$FAKE_TMP" PATH="$BASE_PATH" bash "$DW/install-rein.sh" --allow-dirty 2>&1 )"
  assert_contains "E-304.04e: --allow-dirty installs with a loud banner" "--allow-dirty: installing UNCOMMITTED gate code" "$_aout"
  assert_status 0 "E-304.04f: …and records dirty=true in the install stamp" \
    python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["dirty"] is True' "${DH}/.rein/config/install-stamp.json"
  _dd="$( cd "$PROJ" && HOME="$DH" TMPDIR="$FAKE_TMP" PATH="${STUBS}:${DH}/.rein/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v node)")" bash "${DH}/.rein/bin/rein" doctor 2>&1 )"
  assert_contains "E-304.04g: rein doctor reports the uncommitted install" "installed from an UNCOMMITTED tree" "$_dd"
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
