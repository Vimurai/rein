#!/usr/bin/env bash
# state_archive_test.sh — `rein archive`, the rotated task archives, and finding them again.
#
# One suite for the state-archive behaviours (E-302, wave 2 of the D-088 consolidation):
# `rein archive` (E-111 → E-467 → E-466, below), then the sections absorbed from archive_pointer (E-245),
# archive_tasks (E-112) and sqlite_wal_checkpoint (E-53).
#
# ── E-111 → E-467 → E-466: `rein archive` no longer rotates SQLite state. E-466 (D-169,
# lean-core.md §Component 7) keeps every task and stamp in state — a closed task is read with
# `rein task show`, and the DONE gates read the stamps — and moves record text instead
# (COMM/SECURITY/REVIEWS → .ai/archive/<FILE>-<year>.md; tests/unit/bookkeeping-commands.test.mjs).
# This suite keeps the process boundary: the CLI exit codes and the --logs move.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AI_BIN="${REPO_ROOT}/src/bin/rein"

echo "── Suite: state_archive_test ───────────────────────────────────────"

unset REIN_WORKSPACE REIN_WORKSPACE_DISABLE 2>/dev/null || true
TMP="$(mktemp -d)"; on_exit 'rm -rf "$TMP"'
PROJECT="${TMP}/proj"; mkdir -p "${PROJECT}/.ai"
echo '{"version":"1.0","project":{},"tasks":[],"stamps":[],"deltas":[]}' > "${PROJECT}/.ai/state.json"
cd "${PROJECT}"

# Seed 60 stamps directly into the same state.sqlite.
node --input-type=module -e "import { getDb } from '${REPO_ROOT}/src/mcp/shared/state-db.js'; const db=getDb('${PROJECT}/.ai'); const ins=db.prepare('INSERT INTO stamps(type,agent,task_id,timestamp,summary) VALUES (?,?,?,?,?)'); for(let i=0;i<60;i++) ins.run('T','t',null,'2026-01-01T00:00:00Z','s'+i);" 2>/dev/null

r="$(bash "$AI_BIN" archive 2>&1)"; rc=$?
assert_status 0 "E-467.01: rein archive exits 0 (rc=${rc})" test "$rc" -eq 0
assert_contains "E-466.01: reports the record archive" "[RECORD-ARCHIVE]" "$r"
YM="$(date -u +%Y-%m)"
REMAIN=$(node --input-type=module -e "import { getDb } from '${REPO_ROOT}/src/mcp/shared/state-db.js'; console.log(getDb('${PROJECT}/.ai').prepare('SELECT COUNT(*) n FROM stamps').get().n);" 2>/dev/null)
assert_status 0 "E-466.02: every stamp stays in state (60, was rotated to 10 before E-466)" \
  bash -c "[ \"$REMAIN\" -eq 60 ]"
assert_status 1 "E-466.03: no stamps-<month>.json rotation file is written" test -e "${PROJECT}/.ai/archive/stamps-${YM}.json"

# ── E-467.02: --logs moves LOG.md and SESSION.md, never overwrites, starts a fresh LOG.md ──
printf '# LOG\nold line\n' > "${PROJECT}/.ai/LOG.md"
printf 'session notes\n' > "${PROJECT}/.ai/SESSION.md"
r="$(bash "$AI_BIN" archive --logs 2>&1)"; rc=$?
assert_status 0 "E-467.02a: rein archive --logs exits 0 (rc=${rc})" test "$rc" -eq 0
_moved="$(ls "${PROJECT}/.ai/archive/${YM}/" 2>/dev/null)"
assert_contains "E-467.02b: LOG.md moved to the month directory" "LOG." "$_moved"
assert_contains "E-467.02c: SESSION.md moved too" "SESSION." "$_moved"
assert_contains "E-467.02d: the moved LOG keeps its content" "old line" "$(cat "${PROJECT}"/.ai/archive/"${YM}"/LOG.*.md 2>/dev/null)"
assert_not_contains "E-467.02e: the fresh LOG.md does not carry the old lines" "old line" "$(cat "${PROJECT}/.ai/LOG.md")"
assert_contains "E-467.02f: the fresh LOG.md records the archive" "| rein | Archive |" "$(cat "${PROJECT}/.ai/LOG.md")"
assert_status 1 "E-467.02g: SESSION.md is not recreated" test -e "${PROJECT}/.ai/SESSION.md"
assert_status 2 "E-467.02h: an unknown flag is a usage error" bash "$AI_BIN" archive --bogus

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
  bash -c "grep -q 'stamps-2026-09' <<< '$_mout'"
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
  bash -c "grep < <(sed -n '/^export function renderViews/,/^}/p' '$STORE') -q 'archivePointerLines(aiDir)'"
assert_status 0 "E-245.03b: state-db.js regenerateViews delegates to renderViews" \
  bash -c "grep < <(sed -n '/^export function regenerateViews/,/^}/p' '$DB') -q 'renderViews(aiDir, db)'"
assert_status 1 "E-245.03c: the second projector (state-writer.js) is gone" \
  test -e "${REPO_ROOT}/src/mcp/shared/state-writer.js"

# ── E-245.4: the hygiene items ───────────────────────────────────────────────
assert_status 1 "E-245.04a: the stray root file 'bash' is no longer tracked" \
  bash -c "cd '$REPO_ROOT' && git ls-files --error-unmatch bash >/dev/null 2>&1"
assert_status 0 "E-245.04b: .DS_Store is gitignored at every depth" \
  bash -c "grep -qx '\*\*/.DS_Store' '${REPO_ROOT}/.gitignore'"
assert_status 1 "E-245.04c: and no .DS_Store is tracked" \
  bash -c "cd '$REPO_ROOT' && grep < <(git ls-files) -q 'DS_Store'"
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


# ── E-112 (T-06.01–06) deleted with archive_done_tasks (D-172 r14): it exercised an inline copy of the
# rotation, and the tool and get_state's auto-archive are retired — nothing rotates state any more.

# ── E-53 (from sqlite_wal_checkpoint — E-302): the SQLite WAL checkpoint ──
# Tests for E-53 SQLite WAL flush hook.
#
# Verifies the contract demanded by drift-resolution-2026.md §State Singularity:
#   • src/bin/rein defines _wal_checkpoint_state_db() with a hardcoded path.
#   • do_sync() invokes it at the end of the sync cycle.
#   • doctor() invokes it during the project-scoped diagnostics block.
#   • Behaviour: when sqlite3 is on PATH and .ai/state.sqlite exists with a
#     WAL, calling the helper truncates the WAL.
#   • Fail-open: missing sqlite3 CLI does not crash bin/rein.
#   • Path is hardcoded — never derived from $1 / $PWD-injection / env.
set +e   # this section ran under its own suite's error mode
BIN_AI="${REPO_ROOT}/src/bin/rein"

# ── T-WAL-S01: helper exists with hardcoded path ─────────────────────────────
echo ""
echo "  [T-WAL-S01] _wal_checkpoint_state_db helper present + hardcoded path"

assert_status 0 "bin/rein defines _wal_checkpoint_state_db()" \
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

# E-223 REVERSED this order: the chain used to start cwd-relative, so running `rein sync`
# in any directory containing src/shared/wal-flusher.mjs handed THAT file to node.
# Resolution now goes through the shared install-first helper.
assert_status 0 "helper resolves wal-flusher via the shared install-first locator" \
  grep -q '_rein_helper shared/wal-flusher.mjs' "$BIN_AI"
assert_status 1 "helper no longer prefers a cwd-relative wal-flusher" \
  bash -c "grep < <(sed 's/[[:space:]]*#.*\$//' '$BIN_AI') -qE '\"src/shared/wal-flusher'"

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
# E-421: doctor() is the --json wrapper; the checks it runs are in _doctor_text.
m=re.search(r'^_doctor_text\(\)\s*\{(.*?)^\}', src, re.S|re.M)
sys.exit(0 if m and '_wal_checkpoint_state_db' in m.group(1) else 1)
"

# ── T-WAL-S03: dispatch guard lets the file be sourced ───────────────────────
echo ""
echo "  [T-WAL-S03] sourcing bin/rein loads helpers without invoking usage()"

# When sourced, bin/rein must short-circuit before running the dispatch case.
# Validate by sourcing in a subshell and checking that _wal_checkpoint_state_db
# is callable while no usage banner has been printed to stdout.
SOURCE_OUT="$(bash -c "source '$BIN_AI' >/dev/null 2>&1; type -t _wal_checkpoint_state_db")"
assert_status 0 "helper is loaded as a bash function after sourcing bin/rein" \
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
# A node-free PATH, not an empty one: sourcing bin/rein runs dirname/tr/head under set -e, and
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
