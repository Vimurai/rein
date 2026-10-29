#!/usr/bin/env bash
# state_archive_test.sh — rotating finished state out of the live store, and finding it again.
#
# One suite for the state-archive behaviours (E-302, wave 2 of the D-088 consolidation):
# execute_archive (E-111, below), then the sections absorbed from archive_pointer (E-245),
# archive_tasks (E-112) and sqlite_wal_checkpoint (E-53).
#
# ── E-111 (from archive_manager_state): archive-manager execute_archive rotates
# SQLite state (DONE tasks + audit stamps) through the shared, ACID-safe owner
# instead of shelling the removed `ai archive` verb or writing the regenerated
# state.json view.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/mcp-client.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SERVER="${REPO_ROOT}/src/mcp/archive-manager-mcp/index.js"
AM="${REPO_ROOT}/src/mcp/archive-manager-mcp/index.js"

echo "── Suite: state_archive_test ───────────────────────────────────────"

# ── Source contract: no removed `ai archive` shell-out, no state.json view write ─
assert_status 1 "execute_archive no longer shells 'ai archive'" \
  grep -qE 'spawnSync|aiBin|"archive"\]' "$AM"
assert_status 1 "no archiveStateDoneTasks function remains" \
  grep -qE '^function archiveStateDoneTasks' "$AM"
assert_status 0 "uses shared SQLite-aware rotation" \
  grep -qE 'archiveDoneTasks|archiveStamps' "$AM"

# ── Behavioural: execute_archive rotates stamps via SQLite ───────────────────
unset REIN_WORKSPACE REIN_WORKSPACE_DISABLE 2>/dev/null || true
TMP="$(mktemp -d)"; on_exit 'rm -rf "$TMP"'
PROJECT="${TMP}/proj"; mkdir -p "${PROJECT}/.ai"
echo '{"version":"1.0","project":{},"tasks":[],"stamps":[],"deltas":[]}' > "${PROJECT}/.ai/state.json"
cd "${PROJECT}"

callam() { mcp_call_tool "${SERVER}" "$1" "$2" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
c=d.get("content",[{}]); print(c[0].get("text","") if c else "")'; }

# Seed 60 stamps directly into the same state.sqlite.
node --input-type=module -e "import { getDb } from '${REPO_ROOT}/src/mcp/shared/state-db.js'; const db=getDb('${PROJECT}/.ai'); const ins=db.prepare('INSERT INTO stamps(type,agent,task_id,timestamp,summary) VALUES (?,?,?,?,?)'); for(let i=0;i<60;i++) ins.run('T','t',null,'2026-01-01T00:00:00Z','s'+i);" 2>/dev/null

r=$(callam execute_archive "{}")
assert_contains "E-111.01: reports archived_stamps"        '"archived_stamps"' "$r"
assert_contains "E-111.01b: 50 stamps rotated (60-10)"     "50 stamps"         "$r"
assert_contains "E-111.02: points to skill: ai-archive for logs" "skill: ai-archive" "$r"
# Archive file is dated by the current month (rotation stamp), not the row timestamp.
YM="$(date -u +%Y-%m)"
assert_exists "${PROJECT}/.ai/archive/stamps-${YM}.json"

REMAIN=$(node --input-type=module -e "import { getDb } from '${REPO_ROOT}/src/mcp/shared/state-db.js'; console.log(getDb('${PROJECT}/.ai').prepare('SELECT COUNT(*) n FROM stamps').get().n);" 2>/dev/null)
assert_status 0 "E-111.03: 10 most-recent stamps kept in active SQLite state" \
  bash -c "[ \"$REMAIN\" -eq 10 ]"

# state.json was NOT hand-mutated as a view-write — it is regenerated from SQLite.
# Confirm a second run below threshold is a clean no-op.
r=$(callam execute_archive "{}")
assert_contains "E-111.04: below-threshold run reports no rotation needed" "No state rotation needed" "$r"

cd "${REPO_ROOT}"

# ── E-245 (from archive_pointer — E-302): the TASKS.md archive pointer ──
# E-245 (D-066 §5): rotated history stays findable.
#
# `archive_done_tasks` moves DONE rows beyond the last ten into
# .ai/archive/state-done-YYYY-MM.json. In this repository that took TASKS.md from 261
# lines to 25 — the right trade, and the reason the rotation exists. What it left behind
# was a view showing ten completed tasks and NO INDICATION that 117 more existed or where
# they went. History nobody can find has been lost as far as the next reader is concerned.
#
# THE POINTER MUST SURVIVE A REGENERATION, which is the whole difficulty: TASKS.md is a
# generated view, and a projector that omits the pointer deletes it on its next run. Since
# E-325 there is ONE projector (record-store.mjs renderViews; state-db.js regenerateViews
# delegates to it) — state-writer.js, the second one, is gone.
set +e   # this section ran under its own suite's error mode
DB="${REPO_ROOT}/src/mcp/shared/state-db.js"

_ai() {  # <archive-filenames...> → an .ai dir with those archive files
  local d; d="$(test_tmpdir e245)"
  mkdir -p "$d/archive"
  local f; for f in "$@"; do printf '{"tasks":[]}' > "$d/archive/$f"; done
  printf '%s' "$d"
}
_pointer() { node --input-type=module -e "
  const { archivePointerLines } = await import('file://${DB}');
  process.stdout.write(archivePointerLines('$1').join('\n'));
" 2>/dev/null; }

# ── E-245.1: the pointer names every archive file, sorted ────────────────────
_a="$(_ai state-done-2026-09.json state-done-2026-05.json state-done-2026-06.json)"
_out="$(_pointer "$_a")"
assert_contains "E-245.01a: the section is headed" "## Archived" "$_out"
assert_contains "E-245.01b: an archive file is named with its path" \
  '`.ai/archive/state-done-2026-05.json`' "$_out"
assert_contains "E-245.01c: and so is every other one" \
  '`.ai/archive/state-done-2026-09.json`' "$_out"
# Chronological order, not readdir order: the list is read by a person looking for a date.
_first="$(printf '%s\n' "$_out" | grep 'state-done' | head -1)"
assert_contains "E-245.01d: files are listed in sorted order, not filesystem order" \
  "2026-05" "$_first"
# The narrative lives in LOG.md; a pointer to the JSON alone sends the reader to a file
# that answers 'what' and not 'why'.
assert_contains "E-245.01e: it points at LOG.md for the narrative" "LOG.md" "$_out"

# ── E-245.2: nothing is emitted when there is nothing to point at ────────────
# A project that has never rotated must not grow a phantom section.
_empty="$(_ai)"
_eout="$(_pointer "$_empty")"
assert_status 0 "E-245.02a: no archive files → no section at all" \
  bash -c "[[ -z '$_eout' ]]"
# An .ai/ with no archive DIRECTORY at all is the fresh-project case and must not throw.
_noarch="$(test_tmpdir e245bare)"
assert_status 0 "E-245.02b: a missing archive/ directory is not an error" \
  bash -c "node --input-type=module -e \"
    const { archivePointerLines } = await import('file://${DB}');
    archivePointerLines('$_noarch');
  \" >/dev/null 2>&1"
# Only the DONE-task archives — stamps rotate into the same directory and are not tasks.
_mixed="$(_ai state-done-2026-09.json stamps-2026-09.json)"
_mout="$(_pointer "$_mixed")"
assert_status 1 "E-245.02c: a stamps archive is not listed as task history" \
  bash -c "printf '%s' '$_mout' | grep -q 'stamps-2026-09'"
assert_contains "E-245.02d: while the task archive beside it still is" \
  'state-done-2026-09.json' "$_mout"

# ── E-330 (D-102 §7): a team project points at its TRACKED archive ───────────
# project.json marks the team project; its archive is .ai/tasks/archive/<YM>/, and a leftover
# gitignored state-done file is not what a teammate's clone has — it is not pointed at.
_team="$(_ai state-done-2026-05.json)"
printf '{"schema":2}\n' > "${_team}/project.json"
mkdir -p "${_team}/tasks/archive/2026-10" "${_team}/tasks/archive/2026-09"
printf '{}' > "${_team}/tasks/archive/2026-10/E-1.json"; printf '{}' > "${_team}/tasks/archive/2026-10/E-2.json"
printf '{}' > "${_team}/tasks/archive/2026-09/E-3.json"
_tout="$(_pointer "$_team")"
assert_contains "E-330.01a: a month directory of the tracked archive is named, with its count" \
  '`.ai/tasks/archive/2026-10/` (2 tasks)' "$_tout"
_tfirst="$(printf '%s\n' "$_tout" | grep 'tasks/archive' | head -1)"
assert_contains "E-330.01b: months are listed in sorted order" "2026-09" "$_tfirst"
assert_not_contains "E-330.01c: the gitignored state-done file is not pointed at" "state-done" "$_tout"

# ── E-245.3: the projector emits it ──────────────────────────────────────────
# E-325: the one projector is record-store.mjs renderViews; regenerateViews delegates to it.
STORE="${REPO_ROOT}/src/mcp/shared/record-store.mjs"
assert_status 0 "E-245.03a: record-store.mjs renderViews emits the pointer" \
  bash -c "sed -n '/^export function renderViews/,/^}/p' '$STORE' | grep -q 'archivePointerLines(aiDir)'"
assert_status 0 "E-245.03b: state-db.js regenerateViews delegates to renderViews" \
  bash -c "sed -n '/^export function regenerateViews/,/^}/p' '$DB' | grep -q 'renderViews(aiDir, db)'"
assert_status 1 "E-245.03c: the second projector (state-writer.js) is gone" \
  test -e "${REPO_ROOT}/src/mcp/shared/state-writer.js"

# ── E-245.4: the hygiene items ───────────────────────────────────────────────
assert_status 1 "E-245.04a: the stray root file 'bash' is no longer tracked" \
  bash -c "cd '$REPO_ROOT' && git ls-files --error-unmatch bash >/dev/null 2>&1"
assert_status 0 "E-245.04b: .DS_Store is gitignored at every depth" \
  bash -c "grep -qx '\*\*/.DS_Store' '${REPO_ROOT}/.gitignore'"
assert_status 1 "E-245.04c: and no .DS_Store is tracked" \
  bash -c "cd '$REPO_ROOT' && git ls-files | grep -q 'DS_Store'"
# The live view carries the pointer WHEN THIS CHECKOUT HAS AN ARCHIVE. It usually does not:
# .ai/archive/ is untracked, so a CI checkout has no archive files at all — and the
# projector is then CORRECT to emit no section. Asserting unconditionally made this test
# depend on whether a directory survived the clone; it passed locally and failed on CI, the
# exact environment dependence E-236 exists to remove, written into the suite that adds the
# feature. Gated on the evidence the pointer is derived from.
if compgen -G "${REPO_ROOT}/.ai/archive/state-done-*.json" >/dev/null 2>&1; then
  assert_status 0 "E-245.04e: this repo's own TASKS.md carries the pointer" \
    grep -q '^## Archived' "${REPO_ROOT}/.ai/TASKS.md"
else
  _skip "E-245.04e: this checkout has no .ai/archive/ — nothing for the view to point at"
fi
set -e


# ── E-112 (from archive_tasks — E-302): archiving DONE tasks ──
# Tests for archive_done_tasks tool (E-112)
# Validates: threshold logic, archive file creation, live state pruning,
# OPEN task preservation, and archive JSON integrity.
TEMPLATE="${REPO_ROOT}/src/templates/state.json"

DONE_THRESHOLD=50
DONE_KEEP=10
# UTC, like the archiver (state-db.js archiveDoneTasks: new Date().toISOString()). A local
# month made this fail for the first hours of every month east of UTC (ai ci run e1ff248,
# 2026-10-01 00:10 CEST = 2026-09-30 22:10 UTC).
YM=$(date -u '+%Y-%m')

# Helper: inline archiveDoneTasks logic (mirrors task-synchronizer-mcp)
run_archive() {
  local AI_DIR="$1"
  node -e "
    import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
    import { resolve } from 'path';
    const aiDir = process.argv[1];
    const THRESHOLD = 50;
    const KEEP = 10;
    const statePath = resolve(aiDir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const done = state.tasks.filter(t => t.status === 'DONE');
    if (done.length <= THRESHOLD) { console.log('null'); process.exit(0); }
    const toArchive = done.slice(0, done.length - KEEP);
    const toKeep    = done.slice(done.length - KEEP);
    const open      = state.tasks.filter(t => t.status !== 'DONE');
    const ym = new Date().toISOString().slice(0, 7);
    const archiveDir = resolve(aiDir, 'archive');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = resolve(archiveDir, 'state-done-' + ym + '.json');
    let existing = [];
    if (existsSync(archivePath)) {
      try { existing = JSON.parse(readFileSync(archivePath, 'utf8')); } catch {}
    }
    writeFileSync(archivePath, JSON.stringify([...existing, ...toArchive], null, 2) + '\n', 'utf8');
    state.tasks = [...open, ...toKeep];
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ archived: toArchive.length, kept: toKeep.length, archivePath }));
  " "$AI_DIR" --input-type=module 2>/dev/null || echo "node_error"
}

# T-06.01: No archive when DONE count == threshold (50) — boundary value
BELOW_DIR=$(mktemp -d)
cp "$TEMPLATE" "${BELOW_DIR}/state.json"
python3 -c "
import json; s=json.load(open('${BELOW_DIR}/state.json'))
s['tasks']=[{'id':'E-'+str(i),'owner':'Engineer (Claude)','status':'DONE','tier':1,'description':'Task '+str(i),'created_at':'2026-01-01T00:00:00Z','completed_at':'2026-01-02T00:00:00Z','summary':'Done'} for i in range(1,51)]
json.dump(s, open('${BELOW_DIR}/state.json','w'), indent=2)
"
result=$(run_archive "$BELOW_DIR")
assert_contains "T-06.01: no archive when DONE count == 50 (at threshold)" "null" "$result"
rm -rf "$BELOW_DIR"

# T-06.02: Archive triggered when DONE count > threshold (55 DONE tasks)
ABOVE_DIR=$(mktemp -d)
cp "$TEMPLATE" "${ABOVE_DIR}/state.json"
python3 -c "
import json; s=json.load(open('${ABOVE_DIR}/state.json'))
s['tasks']=[{'id':'E-'+str(i),'owner':'Engineer (Claude)','status':'DONE','tier':1,'description':'Task '+str(i),'created_at':'2026-01-01T00:00:00Z','completed_at':'2026-01-02T00:00:00Z','summary':'Done'} for i in range(1,56)]
json.dump(s, open('${ABOVE_DIR}/state.json','w'), indent=2)
"
result=$(run_archive "$ABOVE_DIR")
assert_contains "T-06.02: archive result contains archived key" '"archived"' "$result"
assert_exists "${ABOVE_DIR}/archive/state-done-${YM}.json"

# T-06.03: Live state retains exactly DONE_KEEP (10) DONE tasks after archive
live_done=$(python3 -c "
import json; s=json.load(open('${ABOVE_DIR}/state.json'))
print(len([t for t in s['tasks'] if t['status']=='DONE']))
")
assert_contains "T-06.03: live state retains exactly 10 DONE tasks" "10" "$live_done"

# T-06.04: Archived count is correct (55 - 10 = 45)
archived_count=$(python3 -c "
import json
d=json.load(open('${ABOVE_DIR}/archive/state-done-${YM}.json'))
print(len(d))
")
assert_contains "T-06.04: archive file contains 45 tasks (55 - 10 kept)" "45" "$archived_count"
rm -rf "$ABOVE_DIR"

# T-06.05: OPEN tasks are preserved after archive (not touched)
MIXED_DIR=$(mktemp -d)
cp "$TEMPLATE" "${MIXED_DIR}/state.json"
python3 -c "
import json; s=json.load(open('${MIXED_DIR}/state.json'))
done=[{'id':'E-'+str(i),'owner':'Engineer (Claude)','status':'DONE','tier':1,'description':'Done '+str(i),'created_at':'2026-01-01T00:00:00Z','completed_at':'2026-01-02T00:00:00Z','summary':'Complete'} for i in range(1,52)]
open_=[{'id':'E-'+str(i),'owner':'Engineer (Claude)','status':'OPEN','tier':1,'description':'Open '+str(i),'created_at':'2026-01-01T00:00:00Z','completed_at':None,'summary':None} for i in range(52,57)]
s['tasks']=done+open_
json.dump(s, open('${MIXED_DIR}/state.json','w'), indent=2)
"
run_archive "$MIXED_DIR" >/dev/null
open_count=$(python3 -c "
import json; s=json.load(open('${MIXED_DIR}/state.json'))
print(len([t for t in s['tasks'] if t['status']=='OPEN']))
")
assert_contains "T-06.05: all 5 OPEN tasks preserved after archive" "5" "$open_count"
rm -rf "$MIXED_DIR"

# T-06.06: Archive file is valid JSON array
VALID_DIR=$(mktemp -d)
cp "$TEMPLATE" "${VALID_DIR}/state.json"
python3 -c "
import json; s=json.load(open('${VALID_DIR}/state.json'))
s['tasks']=[{'id':'E-'+str(i),'owner':'Engineer (Claude)','status':'DONE','tier':1,'description':'Task '+str(i),'created_at':'2026-01-01T00:00:00Z','completed_at':'2026-01-02T00:00:00Z','summary':'Done'} for i in range(1,56)]
json.dump(s, open('${VALID_DIR}/state.json','w'), indent=2)
"
run_archive "$VALID_DIR" >/dev/null
archive_valid=$(python3 -c "
import json
try:
    d=json.load(open('${VALID_DIR}/archive/state-done-${YM}.json'))
    print('ok' if isinstance(d,list) else 'not_array')
except Exception as e:
    print('corrupt:'+str(e))
")
assert_contains "T-06.06: archive file is valid JSON array" "ok" "$archive_valid"
rm -rf "$VALID_DIR"


# ── E-53 (from sqlite_wal_checkpoint — E-302): the SQLite WAL checkpoint ──
# Tests for E-53 SQLite WAL flush hook.
#
# Verifies the contract demanded by drift-resolution-2026.md §State Singularity:
#   • src/bin/ai defines _wal_checkpoint_state_db() with a hardcoded path.
#   • do_sync() invokes it at the end of the sync cycle.
#   • doctor() invokes it during the project-scoped diagnostics block.
#   • Behaviour: when sqlite3 is on PATH and .ai/state.sqlite exists with a
#     WAL, calling the helper truncates the WAL.
#   • Fail-open: missing sqlite3 CLI does not crash bin/ai.
#   • Path is hardcoded — never derived from $1 / $PWD-injection / env.
set +e   # this section ran under its own suite's error mode
BIN_AI="${REPO_ROOT}/src/bin/ai"

# ── T-WAL-S01: helper exists with hardcoded path ─────────────────────────────
echo ""
echo "  [T-WAL-S01] _wal_checkpoint_state_db helper present + hardcoded path"

assert_status 0 "bin/ai defines _wal_checkpoint_state_db()" \
  grep -qE '^_wal_checkpoint_state_db\(\)' "$BIN_AI"

# Path must be the literal '.ai/state.sqlite'. Reject any user-input forms.
assert_status 0 "helper hardcodes DB=.ai/state.sqlite" \
  grep -qE 'local DB="\.ai/state\.sqlite"' "$BIN_AI"

# Negative: helper must not pull the DB path from a positional arg or env var.
assert_status 1 "helper does not accept positional DB arg" \
  grep -qE '_wal_checkpoint_state_db\(\) \{\s*local DB="\$\{?1' "$BIN_AI"

# E-58: helper now delegates the PRAGMA to the node:sqlite-backed
# wal-flusher.mjs script, so the bash side only needs to call node + the
# script path. The PRAGMA itself lives in src/shared/wal-flusher.mjs.
assert_status 0 "helper invokes wal-flusher.mjs via node" \
  grep -qE 'node "\$SCRIPT" "\$DB"' "$BIN_AI"

assert_status 0 "wal-flusher.mjs calls PRAGMA wal_checkpoint(TRUNCATE)" \
  grep -qE 'PRAGMA wal_checkpoint\(TRUNCATE\)' "${REPO_ROOT}/src/shared/wal-flusher.mjs"

# Fail-open: helper checks for node availability before calling it.
assert_status 0 "helper guards on node availability (fail-open)" \
  grep -qE 'command -v node' "$BIN_AI"

# E-223 REVERSED this order: the chain used to start cwd-relative, so running `ai sync`
# in any directory containing src/shared/wal-flusher.mjs handed THAT file to node.
# Resolution now goes through the shared install-first helper.
assert_status 0 "helper resolves wal-flusher via the shared install-first locator" \
  grep -q '_ai_os_helper shared/wal-flusher.mjs' "$BIN_AI"
assert_status 1 "helper no longer prefers a cwd-relative wal-flusher" \
  bash -c "sed 's/[[:space:]]*#.*\$//' '$BIN_AI' | grep -qE '\"src/shared/wal-flusher'"

# ── T-WAL-S02: do_sync() and doctor() both call the helper ───────────────────
echo ""
echo "  [T-WAL-S02] do_sync() and doctor() invoke the helper"

assert_status 0 "do_sync() body invokes _wal_checkpoint_state_db" \
  python3 -c "
import re,sys
src=open('${BIN_AI}').read()
m=re.search(r'^do_sync\(\)\s*\{(.*?)^\}', src, re.S|re.M)
sys.exit(0 if m and '_wal_checkpoint_state_db' in m.group(1) else 1)
"

assert_status 0 "doctor() body invokes _wal_checkpoint_state_db" \
  python3 -c "
import re,sys
src=open('${BIN_AI}').read()
m=re.search(r'^doctor\(\)\s*\{(.*?)^\}', src, re.S|re.M)
sys.exit(0 if m and '_wal_checkpoint_state_db' in m.group(1) else 1)
"

# ── T-WAL-S03: dispatch guard lets the file be sourced ───────────────────────
echo ""
echo "  [T-WAL-S03] sourcing bin/ai loads helpers without invoking usage()"

# When sourced, bin/ai must short-circuit before running the dispatch case.
# Validate by sourcing in a subshell and checking that _wal_checkpoint_state_db
# is callable while no usage banner has been printed to stdout.
SOURCE_OUT="$(bash -c "source '$BIN_AI' >/dev/null 2>&1; type -t _wal_checkpoint_state_db")"
assert_status 0 "helper is loaded as a bash function after sourcing bin/ai" \
  test "$SOURCE_OUT" = "function"

# ── T-WAL-S04: behavioural — helper runs cleanly against a WAL-mode DB ──────
echo ""
echo "  [T-WAL-S04] behavioural: helper PRAGMAs a WAL-mode DB and DB stays queryable"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "  (skip — sqlite3 not on PATH in this environment)"
else
  SBOX="$(mktemp -d)"
  pushd "$SBOX" >/dev/null

  mkdir -p .ai
  sqlite3 .ai/state.sqlite \
    "PRAGMA journal_mode=WAL; CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT); INSERT INTO t(v) VALUES ('alpha'),('beta'),('gamma');" \
    >/dev/null

  HELPER_OUT="$(bash -c "
    set +e
    cd '$SBOX'
    source '$BIN_AI' >/dev/null 2>&1
    _wal_checkpoint_state_db
  " 2>&1)"

  assert_status 0 "helper emits 'WAL checkpoint complete' on success" \
    grep -qE 'WAL checkpoint complete' <<<"$HELPER_OUT"

  # Post-checkpoint DB must still be queryable — confirms PRAGMA was non-destructive.
  ROW_COUNT="$(sqlite3 .ai/state.sqlite 'SELECT COUNT(*) FROM t;')"
  assert_status 0 "DB rows readable after checkpoint (count=${ROW_COUNT})" \
    test "$ROW_COUNT" = "3"

  popd >/dev/null
  rm -rf "$SBOX"
fi

# ── T-WAL-S05: fail-open when node missing (E-58 — was sqlite3 in E-53) ─────
echo ""
echo "  [T-WAL-S05] missing node binary returns 2 — skipped by design (E-339, D-107 r1)"

SBOX2="$(mktemp -d)"
mkdir -p "$SBOX2/.ai"
: > "$SBOX2/.ai/state.sqlite"

EMPTY_PATH="$(mktemp -d)"
# A node-free PATH, not an empty one: sourcing bin/ai runs dirname/tr/head under set -e, and
# with none of them the source itself exited 1 before the helper was ever called.
for _c in dirname tr head; do ln -s "$(command -v "$_c")" "$EMPTY_PATH/$_c"; done
assert_status 2 "helper exits 2 (skipped) when node is not on PATH" \
  bash -c "
    set +e
    cd '$SBOX2'
    export PATH='$EMPTY_PATH'
    source '$BIN_AI' >/dev/null 2>&1
    _wal_checkpoint_state_db
  "

rm -rf "$SBOX2" "$EMPTY_PATH"
set -e

assert_summary
