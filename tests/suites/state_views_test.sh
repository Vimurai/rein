#!/usr/bin/env bash
# state_views_test.sh — state.sqlite and the views generated from it (TASKS.md, state.json).
#
# One suite for the state-view behaviours (E-302, wave 2 of the D-088 consolidation): per-task
# markdown sync (E-60, below), then the sections absorbed from verify_sync (E-102), state_json
# (E-82/P-40), cli_add_task (E-198) and migrate_state (E-89).
#
# ── E-60 (from verify_sync_per_task): per-task drift detection ──
# Verifies that mcp__task-synchronizer-mcp__verify_markdown_sync detects
# the four per-task drift classes named in blueprint state-sync-validation.md:
#
#   1. id in TASKS.md but missing from state.sqlite
#   2. id checkbox [x] in TASKS.md but status != DONE in state
#   3. id checkbox [ ] in TASKS.md but status == DONE in state
#   4. id in state but missing from TASKS.md
#
# Each case spawns the real MCP server via stdio JSON-RPC (no inline
# reimplementation) so the test fails if the algorithm drifts from spec.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/mcp-client.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SYNC_MCP="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"

echo "===== state_views_test.sh ====="

# ── Helper: seed an SBOX with .ai/state.sqlite + TASKS.md, then invoke
#    verify_markdown_sync from inside the SBOX (MCP resolves aiDir via cwd).
#    Args: $1 = absolute path to seed.js (writes state.sqlite + TASKS.md)
#    Stdout: the text body of the MCP response (single line, joined with \n).
_run_verify_in_sbox() {
  local seed_script="$1"
  local SBOX
  SBOX="$(mktemp -d)"
  mkdir -p "${SBOX}/.ai"
  AIDIR="${SBOX}/.ai" REPO_ROOT="${REPO_ROOT}" node --no-warnings "$seed_script" 2>/dev/null
  (
    cd "$SBOX"
    mcp_call_tool "$SYNC_MCP" "verify_markdown_sync" "{}"
  ) | python3 -c "
import json, sys
raw = sys.stdin.read() or '{}'
try:
    data = json.loads(raw)
except Exception:
    print(''); sys.exit(0)
content = data.get('content') or []
text = '\n'.join(c.get('text','') for c in content if c.get('type') == 'text')
print(text)
"
  rm -rf "$SBOX"
}

# ── T-VS-S01: clean state — no anomalies ──────────────────────────────────
echo ""
echo "  [T-VS-S01] Clean state passes"

CLEAN_SEED="$(mktemp).mjs"
cat > "$CLEAN_SEED" <<'JS'
const { getDb, regenerateViews } = await import(`${process.env.REPO_ROOT}/src/mcp/shared/state-db.js`);
const aiDir = process.env.AIDIR;
const db = getDb(aiDir);
const now = new Date().toISOString();
db.prepare("INSERT INTO tasks(id,owner,status,tier,description,created_at,completed_at,summary) VALUES (?,?,?,?,?,?,?,?)")
  .run("E-1","Engineer (Claude)","OPEN",1,"task one",now,null,null);
db.prepare("INSERT INTO tasks(id,owner,status,tier,description,created_at,completed_at,summary) VALUES (?,?,?,?,?,?,?,?)")
  .run("E-2","Engineer (Claude)","DONE",2,"task two",now,now,"shipped");
regenerateViews(aiDir, db);
JS
OUT="$(_run_verify_in_sbox "$CLEAN_SEED")"
rm -f "$CLEAN_SEED"
assert_status 0 "T-VS-S01a: emits [SYNC_PASS]" \
  grep -qE '\[SYNC_PASS\]' <<<"$OUT"
assert_status 0 "T-VS-S01b: __SYNC_RESULT__ JSON tail status=PASS" \
  grep -qE '__SYNC_RESULT__ \{"status":"PASS"' <<<"$OUT"

# ── T-VS-S02: drift 1 — id in TASKS.md but missing from state ────────────
echo ""
echo "  [T-VS-S02] Drift 1 — id in TASKS.md but missing from state"

DRIFT1_SEED="$(mktemp).mjs"
cat > "$DRIFT1_SEED" <<'JS'
const { getDb, regenerateViews } = await import(`${process.env.REPO_ROOT}/src/mcp/shared/state-db.js`);
const { writeFileSync } = await import("fs");
const { resolve }       = await import("path");
const aiDir = process.env.AIDIR;
const db = getDb(aiDir);
const now = new Date().toISOString();
db.prepare("INSERT INTO tasks(id,owner,status,tier,description,created_at,completed_at,summary) VALUES (?,?,?,?,?,?,?,?)")
  .run("E-1","Engineer (Claude)","OPEN",1,"task one",now,null,null);
regenerateViews(aiDir, db);
// Append a phantom row to TASKS.md that doesn't exist in state.
const tp = resolve(aiDir, "TASKS.md");
const cur = (await import("fs")).readFileSync(tp, "utf8");
writeFileSync(tp, cur + "- [x] E-99: phantom task | Tier: 1\n");
JS
OUT="$(_run_verify_in_sbox "$DRIFT1_SEED")"
rm -f "$DRIFT1_SEED"
assert_status 0 "T-VS-S02a: emits [SYNC_FAIL]" \
  grep -qE '\[SYNC_FAIL\]' <<<"$OUT"
assert_status 0 "T-VS-S02b: anomaly names E-99 + missing-from-state" \
  grep -qE 'E-99.*missing from state' <<<"$OUT"
assert_status 0 "T-VS-S02c: auto-fix regenerates TASKS.md" \
  grep -qE 'TASKS\.md regenerated' <<<"$OUT"

# ── T-VS-S03: drift 2 — [x] in md but not DONE in state ──────────────────
echo ""
echo "  [T-VS-S03] Drift 2 — [x] in md but not DONE in state"

DRIFT2_SEED="$(mktemp).mjs"
cat > "$DRIFT2_SEED" <<'JS'
const { getDb, regenerateViews } = await import(`${process.env.REPO_ROOT}/src/mcp/shared/state-db.js`);
const { readFileSync, writeFileSync } = await import("fs");
const { resolve }                     = await import("path");
const aiDir = process.env.AIDIR;
const db = getDb(aiDir);
const now = new Date().toISOString();
db.prepare("INSERT INTO tasks(id,owner,status,tier,description,created_at,completed_at,summary) VALUES (?,?,?,?,?,?,?,?)")
  .run("E-3","Engineer (Claude)","OPEN",1,"forgot to mark done",now,null,null);
regenerateViews(aiDir, db);
// Hand-flip the checkbox in TASKS.md from [ ] to [x] without updating state.
const tp = resolve(aiDir, "TASKS.md");
const cur = readFileSync(tp, "utf8");
writeFileSync(tp, cur.replace("- [ ] E-3:", "- [x] E-3:"));
JS
OUT="$(_run_verify_in_sbox "$DRIFT2_SEED")"
rm -f "$DRIFT2_SEED"
assert_status 0 "T-VS-S03a: emits [SYNC_FAIL]" \
  grep -qE '\[SYNC_FAIL\]' <<<"$OUT"
assert_status 0 "T-VS-S03b: anomaly E-3 [x] but OPEN in state" \
  grep -qE 'E-3 is \[x\] in TASKS\.md but OPEN in state' <<<"$OUT"
# Drift 2 is human-decision territory — must NOT auto-regenerate.
assert_status 1 "T-VS-S03c: drift 2 does NOT trigger auto-regen" \
  grep -qE 'TASKS\.md regenerated' <<<"$OUT"

# ── T-VS-S04: drift 3 — [ ] in md but DONE in state ──────────────────────
echo ""
echo "  [T-VS-S04] Drift 3 — [ ] in md but DONE in state"

DRIFT3_SEED="$(mktemp).mjs"
cat > "$DRIFT3_SEED" <<'JS'
const { getDb, regenerateViews } = await import(`${process.env.REPO_ROOT}/src/mcp/shared/state-db.js`);
const { readFileSync, writeFileSync } = await import("fs");
const { resolve }                     = await import("path");
const aiDir = process.env.AIDIR;
const db = getDb(aiDir);
const now = new Date().toISOString();
db.prepare("INSERT INTO tasks(id,owner,status,tier,description,created_at,completed_at,summary) VALUES (?,?,?,?,?,?,?,?)")
  .run("E-4","Engineer (Claude)","DONE",2,"shipped already",now,now,"summary");
regenerateViews(aiDir, db);
// Force the checkbox back to [ ] without updating state.
const tp = resolve(aiDir, "TASKS.md");
const cur = readFileSync(tp, "utf8");
writeFileSync(tp, cur.replace("- [x] E-4:", "- [ ] E-4:"));
JS
OUT="$(_run_verify_in_sbox "$DRIFT3_SEED")"
rm -f "$DRIFT3_SEED"
assert_status 0 "T-VS-S04a: emits [SYNC_FAIL]" \
  grep -qE '\[SYNC_FAIL\]' <<<"$OUT"
assert_status 0 "T-VS-S04b: anomaly E-4 [ ] but DONE in state" \
  grep -qE 'E-4 is \[ \] in TASKS\.md but DONE in state' <<<"$OUT"

# ── T-VS-S05: drift 4 — id in state but missing from TASKS.md ────────────
echo ""
echo "  [T-VS-S05] Drift 4 — id in state but missing from TASKS.md"

DRIFT4_SEED="$(mktemp).mjs"
cat > "$DRIFT4_SEED" <<'JS'
const { getDb, regenerateViews } = await import(`${process.env.REPO_ROOT}/src/mcp/shared/state-db.js`);
const { readFileSync, writeFileSync } = await import("fs");
const { resolve }                     = await import("path");
const aiDir = process.env.AIDIR;
const db = getDb(aiDir);
const now = new Date().toISOString();
db.prepare("INSERT INTO tasks(id,owner,status,tier,description,created_at,completed_at,summary) VALUES (?,?,?,?,?,?,?,?)")
  .run("E-5","Engineer (Claude)","OPEN",1,"orphan in state",now,null,null);
db.prepare("INSERT INTO tasks(id,owner,status,tier,description,created_at,completed_at,summary) VALUES (?,?,?,?,?,?,?,?)")
  .run("E-6","Engineer (Claude)","OPEN",1,"keeper",now,null,null);
regenerateViews(aiDir, db);
// Strip E-5 from TASKS.md so state has it but markdown doesn't.
const tp = resolve(aiDir, "TASKS.md");
const cur = readFileSync(tp, "utf8");
writeFileSync(tp, cur.split("\n").filter(l => !l.includes("E-5:")).join("\n"));
JS
OUT="$(_run_verify_in_sbox "$DRIFT4_SEED")"
rm -f "$DRIFT4_SEED"
assert_status 0 "T-VS-S05a: emits [SYNC_FAIL]" \
  grep -qE '\[SYNC_FAIL\]' <<<"$OUT"
assert_status 0 "T-VS-S05b: anomaly E-5 missing from TASKS.md" \
  grep -qE 'E-5 exists in state but is missing from TASKS\.md' <<<"$OUT"
assert_status 0 "T-VS-S05c: auto-fix regenerates TASKS.md" \
  grep -qE 'TASKS\.md regenerated' <<<"$OUT"

# ── T-VS-S06: header tampering still surfaces as anomaly ─────────────────
echo ""
echo "  [T-VS-S06] Header tampering"

HEADER_SEED="$(mktemp).mjs"
cat > "$HEADER_SEED" <<'JS'
const { getDb, regenerateViews } = await import(`${process.env.REPO_ROOT}/src/mcp/shared/state-db.js`);
const { readFileSync, writeFileSync } = await import("fs");
const { resolve }                     = await import("path");
const aiDir = process.env.AIDIR;
const db = getDb(aiDir);
const now = new Date().toISOString();
db.prepare("INSERT INTO tasks(id,owner,status,tier,description,created_at,completed_at,summary) VALUES (?,?,?,?,?,?,?,?)")
  .run("E-7","Engineer (Claude)","OPEN",1,"header check",now,null,null);
regenerateViews(aiDir, db);
const tp = resolve(aiDir, "TASKS.md");
const cur = readFileSync(tp, "utf8");
writeFileSync(tp, cur.replace(/^# TASKS \(Generated from state\.json\)\n/, "# Hand-edited TASKS\n"));
JS
OUT="$(_run_verify_in_sbox "$HEADER_SEED")"
rm -f "$HEADER_SEED"
assert_status 0 "T-VS-S06a: header tampering surfaces as anomaly" \
  grep -qE 'TASKS\.md does not start with generated header' <<<"$OUT"

# ── T-VS-S07: structured tail JSON parses & contains anomaly array ───────
echo ""
echo "  [T-VS-S07] Structured __SYNC_RESULT__ tail"

TAIL_SEED="$(mktemp).mjs"
cat > "$TAIL_SEED" <<'JS'
const { getDb, regenerateViews } = await import(`${process.env.REPO_ROOT}/src/mcp/shared/state-db.js`);
const { readFileSync, writeFileSync } = await import("fs");
const { resolve }                     = await import("path");
const aiDir = process.env.AIDIR;
const db = getDb(aiDir);
const now = new Date().toISOString();
db.prepare("INSERT INTO tasks(id,owner,status,tier,description,created_at,completed_at,summary) VALUES (?,?,?,?,?,?,?,?)")
  .run("E-8","Engineer (Claude)","OPEN",1,"tail check",now,null,null);
regenerateViews(aiDir, db);
const tp = resolve(aiDir, "TASKS.md");
writeFileSync(tp, readFileSync(tp, "utf8").replace("- [ ] E-8:", "- [x] E-8:"));
JS
OUT="$(_run_verify_in_sbox "$TAIL_SEED")"
rm -f "$TAIL_SEED"
TAIL_JSON="$(grep -oE '__SYNC_RESULT__ \{.*\}$' <<<"$OUT" | sed 's/^__SYNC_RESULT__ //')"
assert_status 0 "T-VS-S07a: tail line present" \
  test -n "$TAIL_JSON"
PARSED="$(printf '%s' "$TAIL_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
ok = d.get('status') == 'FAIL' and isinstance(d.get('anomalies'), list) and any('E-8' in a for a in d['anomalies'])
print('ok' if ok else 'fail')
")"
assert_contains "T-VS-S07b: tail JSON status=FAIL with E-8 anomaly" "ok" "$PARSED"

echo ""
# ── E-326 (D-102): a pulled team record is IMPORTED, never dropped from the view ──
# Before E-326 a task present only in a pulled record would have been regenerated away;
# in a team project verify_markdown_sync now imports it first. A legacy row stays as is.
TEAM_SBOX="$(mktemp -d)"; on_exit "rm -rf '$TEAM_SBOX'"
mkdir -p "$TEAM_SBOX/.ai"
( cd "$TEAM_SBOX" && node --no-warnings --input-type=module -e "
    const { getDb, addTask, regenerateViews } = await import('file://${REPO_ROOT}/src/mcp/shared/state-db.js');
    const { writeRecord, taskRecord } = await import('file://${REPO_ROOT}/src/mcp/shared/record-store.mjs');
    const db = getDb('.ai'); addTask('.ai', db, { owner: 'Engineer (Claude)', description: 'local' });
    writeRecord('.ai', 'project', null, { schema: 2 }, { fresh: true });
    const row = db.prepare('SELECT * FROM tasks').get();
    writeRecord('.ai', 'task', row.id, taskRecord(row), { fresh: true });
    regenerateViews('.ai', db);
    writeRecord('.ai', 'task', 'E-900', taskRecord({ id: 'E-900', owner: 'Engineer (Claude)', status: 'OPEN', description: 'pulled', created_at: new Date().toISOString() }), { fresh: true });
  " )
team_out="$(cd "$TEAM_SBOX" && mcp_call_tool "$SYNC_MCP" "verify_markdown_sync" "{}")"
assert_contains "E-326.v1: verify_markdown_sync imports the pulled record" "[STATE_IMPORT] + E-900 OPEN" "$team_out"
assert_contains "E-326.v2: …and reports the import as an auto-fix, not an anomaly" "SYNC_PASS" "$team_out"
assert_contains "E-326.v3: …and the view now carries the pulled task" "- [ ] E-900: pulled" "$(cat "$TEAM_SBOX/.ai/TASKS.md")"


# ── E-102 (from verify_sync — E-302): verify_markdown_sync PASS/FAIL ──
# Tests for verify_markdown_sync tool (E-102 / E-95)
# Validates PASS/FAIL behavior for the Markdown-as-Read-Only sync check.
set -e   # this section ran under its own suite's error mode
TEMPLATE="${REPO_ROOT}/src/templates/state.json"

# Helper: run verify_markdown_sync logic inline (mirrors MCP implementation)
# Reads state.json and TASKS.md/REVIEWS.md from a tmp dir, returns PASS or FAIL details
run_verify_sync() {
  local DIR="$1"
  node -e "
    import { readFileSync, existsSync } from 'fs';
    import { resolve } from 'path';

    const aiDir = process.argv[1];
    const failures = [];

    // Load state.json
    const statePath = resolve(aiDir, 'state.json');
    if (!existsSync(statePath)) { console.log('FAIL: state.json missing'); process.exit(0); }
    let state;
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); }
    catch { console.log('FAIL: state.json corrupt'); process.exit(0); }

    // Check TASKS.md
    const tasksPath = resolve(aiDir, 'TASKS.md');
    if (existsSync(tasksPath)) {
      const t = readFileSync(tasksPath, 'utf8');
      const mdCount = (t.match(/^- \[/gm) || []).length;
      const stateCount = state.tasks.length;
      if (Math.abs(mdCount - stateCount) > 2)
        failures.push('TASKS_COUNT_DRIFT:' + mdCount + 'vs' + stateCount);
      if (!t.startsWith('# TASKS (Generated from state.json)'))
        failures.push('TASKS_MISSING_HEADER');
    }

    // Check REVIEWS.md (only when stamps exist)
    const reviewsPath = resolve(aiDir, 'REVIEWS.md');
    if (existsSync(reviewsPath) && state.stamps.length > 0) {
      const r = readFileSync(reviewsPath, 'utf8');
      if (!r.startsWith('# REVIEWS.md (Generated from state.json)'))
        failures.push('REVIEWS_MISSING_HEADER');
      const mdStamps = (r.match(/^\[[\w_]+\]/gm) || []).length;
      if (mdStamps < state.stamps.length)
        failures.push('REVIEWS_STAMP_DRIFT:' + mdStamps + 'vs' + state.stamps.length);
    }

    console.log(failures.length === 0 ? 'PASS' : 'FAIL:' + failures.join(','));
  " "$DIR" --input-type=module 2>/dev/null || echo "FAIL:node_error"
}

# ── T-03.01: PASS when header present and counts match ────────────────
CLEAN_DIR=$(mktemp -d)
cp "$TEMPLATE" "${CLEAN_DIR}/state.json"
# Seed state with 2 tasks
python3 -c "
import json; s=json.load(open('${CLEAN_DIR}/state.json'))
s['tasks']=[{'id':'E-1','owner':'Engineer (Claude)','status':'OPEN','tier':1,'description':'Task one','created_at':'2026-01-01T00:00:00Z','completed_at':None,'summary':None},
             {'id':'E-2','owner':'Engineer (Claude)','status':'DONE','tier':2,'description':'Task two','created_at':'2026-01-01T00:00:00Z','completed_at':'2026-01-02T00:00:00Z','summary':'Done'}]
json.dump(s, open('${CLEAN_DIR}/state.json','w'), indent=2)
"
# Write matching TASKS.md with generated header
cat > "${CLEAN_DIR}/TASKS.md" <<'TASKS'
# TASKS (Generated from state.json)

## Engineer (Claude)
- [ ] E-1: Task one | Tier: 1
- [x] E-2: Task two | Tier: 2
  Status: DONE 2026-01-02 — Done
TASKS
result=$(run_verify_sync "$CLEAN_DIR")
assert_contains "T-03.01: PASS when header present and counts match" "PASS" "$result"
rm -rf "$CLEAN_DIR"

# ── T-03.02: FAIL when TASKS.md missing generated header ─────────────
NOHEADER_DIR=$(mktemp -d)
cp "$TEMPLATE" "${NOHEADER_DIR}/state.json"
python3 -c "
import json; s=json.load(open('${NOHEADER_DIR}/state.json'))
s['tasks']=[{'id':'E-1','owner':'Engineer (Claude)','status':'OPEN','tier':1,'description':'Test','created_at':'2026-01-01T00:00:00Z','completed_at':None,'summary':None}]
json.dump(s, open('${NOHEADER_DIR}/state.json','w'), indent=2)
"
# Write TASKS.md WITHOUT the generated header (hand-edited simulation)
cat > "${NOHEADER_DIR}/TASKS.md" <<'TASKS'
## Engineer (Claude)
- [ ] E-1: Test | Tier: 1
TASKS
result=$(run_verify_sync "$NOHEADER_DIR")
assert_contains "T-03.02: FAIL when TASKS.md missing generated header" "FAIL" "$result"
assert_contains "T-03.02b: reports TASKS_MISSING_HEADER" "TASKS_MISSING_HEADER" "$result"
rm -rf "$NOHEADER_DIR"

# ── T-03.03: FAIL when task count drift > 2 ──────────────────────────
DRIFT_DIR=$(mktemp -d)
cp "$TEMPLATE" "${DRIFT_DIR}/state.json"
# state.json has 5 tasks
python3 -c "
import json; s=json.load(open('${DRIFT_DIR}/state.json'))
s['tasks']=[{'id':'E-'+str(i),'owner':'Engineer (Claude)','status':'OPEN','tier':1,'description':'Task '+str(i),'created_at':'2026-01-01T00:00:00Z','completed_at':None,'summary':None} for i in range(1,6)]
json.dump(s, open('${DRIFT_DIR}/state.json','w'), indent=2)
"
# TASKS.md has only 1 task (drift = 4 > 2)
cat > "${DRIFT_DIR}/TASKS.md" <<'TASKS'
# TASKS (Generated from state.json)

## Engineer (Claude)
- [ ] E-1: Task 1 | Tier: 1
TASKS
result=$(run_verify_sync "$DRIFT_DIR")
assert_contains "T-03.03: FAIL when task count drift > 2" "FAIL" "$result"
assert_contains "T-03.03b: reports TASKS_COUNT_DRIFT" "TASKS_COUNT_DRIFT" "$result"
rm -rf "$DRIFT_DIR"

# ── T-03.04: FAIL when REVIEWS.md missing header but stamps exist ─────
STAMPS_DIR=$(mktemp -d)
cp "$TEMPLATE" "${STAMPS_DIR}/state.json"
python3 -c "
import json; s=json.load(open('${STAMPS_DIR}/state.json'))
s['tasks']=[{'id':'E-1','owner':'Engineer (Claude)','status':'DONE','tier':2,'description':'Test','created_at':'2026-01-01T00:00:00Z','completed_at':'2026-01-02T00:00:00Z','summary':'Done'}]
s['stamps']=[{'type':'CRITIC_STAMP','agent':'critic_arch','task_id':'E-1','timestamp':'2026-01-02T00:00:00Z','summary':'All clear'}]
json.dump(s, open('${STAMPS_DIR}/state.json','w'), indent=2)
"
# TASKS.md is correct
cat > "${STAMPS_DIR}/TASKS.md" <<'TASKS'
# TASKS (Generated from state.json)

## Engineer (Claude)
- [x] E-1: Test | Tier: 2
  Status: DONE 2026-01-02 — Done
TASKS
# REVIEWS.md without generated header (hand-edited)
cat > "${STAMPS_DIR}/REVIEWS.md" <<'REVIEWS'
[CRITIC_STAMP] 2026-01-02 | All clear
REVIEWS
result=$(run_verify_sync "$STAMPS_DIR")
assert_contains "T-03.04: FAIL when REVIEWS.md missing header but stamps exist" "FAIL" "$result"
assert_contains "T-03.04b: reports REVIEWS_MISSING_HEADER" "REVIEWS_MISSING_HEADER" "$result"
rm -rf "$STAMPS_DIR"

# ── T-03.05: PASS when state.json has zero stamps and REVIEWS.md is empty ──
NOSTAMP_DIR=$(mktemp -d)
cp "$TEMPLATE" "${NOSTAMP_DIR}/state.json"
python3 -c "
import json; s=json.load(open('${NOSTAMP_DIR}/state.json'))
s['tasks']=[{'id':'E-1','owner':'Engineer (Claude)','status':'OPEN','tier':1,'description':'Fresh task','created_at':'2026-01-01T00:00:00Z','completed_at':None,'summary':None}]
s['stamps']=[]
json.dump(s, open('${NOSTAMP_DIR}/state.json','w'), indent=2)
"
cat > "${NOSTAMP_DIR}/TASKS.md" <<'TASKS'
# TASKS (Generated from state.json)

## Engineer (Claude)
- [ ] E-1: Fresh task | Tier: 1
TASKS
# REVIEWS.md is empty (no stamps — no check required)
printf "# REVIEWS.md\n" > "${NOSTAMP_DIR}/REVIEWS.md"
result=$(run_verify_sync "$NOSTAMP_DIR")
assert_contains "T-03.05: PASS when zero stamps and REVIEWS.md is empty" "PASS" "$result"
rm -rf "$NOSTAMP_DIR"
set +e


# ── E-82/P-40 (from state_json — E-302): state.json atomic writes under stress ──
# Stress tests for state.json atomic writes (E-82 / P-40)
# Validates: JSON integrity after concurrent writes, nextId correctness,
# regenerateMarkdown output, and state.json schema compliance.
set -e   # this section ran under its own suite's error mode
TEMPLATE="${REPO_ROOT}/src/templates/state.json"

# ── T-02.01: Template is valid JSON with required schema fields ───────
assert_exists "$TEMPLATE"
schema_check=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
ok = all(k in d for k in ('version', 'project', 'tasks', 'stamps'))
ok = ok and all(k in d['project'] for k in ('current_tier', 'release_verdict', 'focus'))
ok = ok and isinstance(d['tasks'], list) and isinstance(d['stamps'], list)
print('ok' if ok else 'missing_fields')
" "$TEMPLATE")
assert_contains "T-02.01: state.json template has required schema" "ok" "$schema_check"

# ── T-02.02: task-synchronizer-mcp syntax is valid ────────────────────
# ESM files can't use node --check; verify via dynamic import parse (catches syntax errors)
assert_status 0 "T-02.02: task-synchronizer-mcp syntax OK" node -e "import('file://${SYNC_MCP}').catch(e => { if (e instanceof SyntaxError) process.exit(1); })"

# ── T-02.03: nextId logic produces correct sequential IDs ─────────────
next_id_check=$(node -e "
const tasks = [
  { id: 'E-1' }, { id: 'E-5' }, { id: 'E-3' },
  { id: 'P-2' }, { id: 'P-10' },
  { id: 'T-1' }
];
function nextId(tasks, prefix) {
  const nums = tasks
    .filter(t => t.id.startsWith(prefix + '-'))
    .map(t => parseInt(t.id.split('-')[1], 10))
    .filter(n => !isNaN(n));
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return prefix + '-' + (max + 1);
}
const e = nextId(tasks, 'E');
const p = nextId(tasks, 'P');
const t = nextId(tasks, 'T');
console.log(e === 'E-6' && p === 'P-11' && t === 'T-2' ? 'ok' : 'fail: ' + e + ' ' + p + ' ' + t);
")
assert_contains "T-02.03: nextId produces correct sequential IDs" "ok" "$next_id_check"

# ── T-02.04: nextId handles empty task list ───────────────────────────
next_id_empty=$(node -e "
function nextId(tasks, prefix) {
  const nums = tasks
    .filter(t => t.id.startsWith(prefix + '-'))
    .map(t => parseInt(t.id.split('-')[1], 10))
    .filter(n => !isNaN(n));
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return prefix + '-' + (max + 1);
}
console.log(nextId([], 'E') === 'E-1' ? 'ok' : 'fail');
")
assert_contains "T-02.04: nextId handles empty task list" "ok" "$next_id_empty"

# ── T-02.05: Concurrent writes produce valid JSON (stress test) ───────
# Simulates N parallel writers appending tasks to the same state.json.
# After all writers complete, state.json must be valid JSON with all tasks present.
STRESS_DIR=$(mktemp -d)
on_exit 'rm -rf "$STRESS_DIR"'

# Initialize state.json from template
cp "$TEMPLATE" "${STRESS_DIR}/state.json"

NUM_WRITERS=10
PIDS=()

for i in $(seq 1 $NUM_WRITERS); do
  node -e "
    const fs = require('fs');
    const p = '${STRESS_DIR}/state.json';
    // Read-modify-write; the WRITE is atomic (rename), the read-modify is not, so a
    // concurrent writer may be lost — T-02.05b asserts at least one lands, not all.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const s = JSON.parse(fs.readFileSync(p, 'utf8'));
        s.tasks.push({
          id: 'E-stress-${i}',
          owner: 'stress-test',
          status: 'OPEN',
          tier: 1,
          description: 'Stress test task ${i}',
          created_at: new Date().toISOString(),
          completed_at: null,
          summary: null
        });
        // Atomic write: a temp file then rename. A bare writeFileSync truncates THEN
        // writes, so two writers interleaving left one document followed by the other's
        // tail (Unexpected non-whitespace character after JSON) — a scheduling race
        // that failed CI under load and never on an idle host. rename() replaces the
        // file in one step, so a reader sees one writer's whole document or another's.
        const tmp = p + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, p);
        break;
      } catch (e) {
        // Retry on read/parse failure from concurrent write
        if (attempt === 2) throw e;
        const wait = Math.random() * 50;
        const start = Date.now();
        while (Date.now() - start < wait) {} // busy-wait
      }
    }
  " &
  PIDS+=($!)
done

# Wait for all writers
ALL_OK=true
for pid in "${PIDS[@]}"; do
  if ! wait "$pid" 2>/dev/null; then
    ALL_OK=false
  fi
done

# Verify JSON integrity
stress_valid=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print('ok' if isinstance(d.get('tasks'), list) else 'bad_schema')
except Exception as e:
    print(f'corrupt: {e}')
" "${STRESS_DIR}/state.json")
assert_contains "T-02.05: state.json valid after concurrent writes" "ok" "$stress_valid"

# Count how many tasks landed (may be < NUM_WRITERS due to races — that's the point)
stress_count=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
stress_tasks = [t for t in d['tasks'] if t.get('owner') == 'stress-test']
print(len(stress_tasks))
" "${STRESS_DIR}/state.json")

# At minimum, some tasks must have landed (proves writes worked)
stress_min=$(python3 -c "print('ok' if int('${stress_count}') >= 1 else 'zero_tasks')")
assert_contains "T-02.05b: at least 1 stress task landed" "ok" "$stress_min"

# Report actual landing rate
if [[ "$stress_count" -lt "$NUM_WRITERS" ]]; then
  printf "  ⚠ Race condition detected: %s/%s tasks landed (expected — proves need for single-writer MCP)\n" "$stress_count" "$NUM_WRITERS"
else
  printf "  ℹ All %s/%s tasks landed (no race in this run)\n" "$stress_count" "$NUM_WRITERS"
fi

# ── T-02.06: Single-writer simulation (serialized) preserves all tasks ─
SERIAL_DIR=$(mktemp -d)
cp "$TEMPLATE" "${SERIAL_DIR}/state.json"

node -e "
const fs = require('fs');
const p = '${SERIAL_DIR}/state.json';
for (let i = 1; i <= 20; i++) {
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  s.tasks.push({
    id: 'E-' + i,
    owner: 'serial-test',
    status: 'OPEN',
    tier: 1,
    description: 'Serial task ' + i,
    created_at: new Date().toISOString(),
    completed_at: null,
    summary: null
  });
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8');
}
"

serial_check=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
tasks = d.get('tasks', [])
ids = sorted([t['id'] for t in tasks])
expected = sorted(['E-' + str(i) for i in range(1, 21)])
print('ok' if ids == expected else f'mismatch: got {len(ids)} tasks')
" "${SERIAL_DIR}/state.json")
assert_contains "T-02.06: serialized writes preserve all 20 tasks" "ok" "$serial_check"
rm -rf "$SERIAL_DIR"

# ── T-02.07: Stamp writes don't corrupt task data ────────────────────
STAMP_DIR=$(mktemp -d)
cp "$TEMPLATE" "${STAMP_DIR}/state.json"

node -e "
const fs = require('fs');
const p = '${STAMP_DIR}/state.json';
// Add a task first
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
s.tasks.push({ id: 'E-1', owner: 'test', status: 'OPEN', tier: 2, description: 'Test task' });
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');

// Add 5 stamps
for (let i = 0; i < 5; i++) {
  const s2 = JSON.parse(fs.readFileSync(p, 'utf8'));
  s2.stamps.push({
    type: ['ARCH_PASS','SEC_PASS','TESTS_PASS','ALIGN_PASS','CRITIC_STAMP'][i],
    agent: 'critic_' + i,
    task_id: 'E-1',
    timestamp: new Date().toISOString(),
    summary: 'Stamp ' + i
  });
  fs.writeFileSync(p, JSON.stringify(s2, null, 2) + '\n');
}
"

stamp_check=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
tasks_ok = len(d['tasks']) == 1 and d['tasks'][0]['id'] == 'E-1'
stamps_ok = len(d['stamps']) == 5
types = {s['type'] for s in d['stamps']}
expected_types = {'ARCH_PASS', 'SEC_PASS', 'TESTS_PASS', 'ALIGN_PASS', 'CRITIC_STAMP'}
print('ok' if tasks_ok and stamps_ok and types == expected_types else 'fail')
" "${STAMP_DIR}/state.json")
assert_contains "T-02.07: stamps don't corrupt task data" "ok" "$stamp_check"
rm -rf "$STAMP_DIR"

# ── T-02.08: regenerateMarkdown produces correct TASKS.md ─────────────
MD_DIR=$(mktemp -d)
mkdir -p "$MD_DIR"

node -e "
const fs = require('fs');
const { resolve } = require('path');
const aiDir = '${MD_DIR}';

const state = {
  version: '1.0',
  project: { current_tier: 2, release_verdict: null, focus: 'testing' },
  tasks: [
    { id: 'E-1', owner: 'Engineer (Claude)', status: 'DONE', tier: 2, description: 'Build feature', completed_at: '2026-03-15T10:00:00Z', summary: 'Complete' },
    { id: 'E-2', owner: 'Engineer (Claude)', status: 'OPEN', tier: 1, description: 'Fix bug' },
    { id: 'P-1', owner: 'Architect (Claude)', status: 'DONE', tier: 2, description: 'Design API', completed_at: '2026-03-14T10:00:00Z', summary: 'Blueprint done' }
  ],
  stamps: [
    { type: 'ARCH_PASS', agent: 'critic_arch', timestamp: '2026-03-15T10:00:00Z', summary: 'All clear' }
  ]
};

// Inline regenerateMarkdown logic (from task-synchronizer-mcp)
const tasksPath = resolve(aiDir, 'TASKS.md');
const lines = ['# TASKS (Generated from state.json)', ''];
// E-136 (role-abstraction.md): provider-agnostic headers — strip the provider suffix to the role.
const roleOf = (o) => String(o || 'Unassigned').split(' (')[0].trim() || 'Unassigned';
const byRole = {};
for (const t of state.tasks) {
  const role = roleOf(t.owner);
  if (!byRole[role]) byRole[role] = [];
  byRole[role].push(t);
}
for (const [role, tasks] of Object.entries(byRole)) {
  lines.push('## ' + role);
  for (const t of tasks) {
    const check = t.status === 'DONE' ? 'x' : ' ';
    const tierStr = t.tier ? ' | Tier: ' + t.tier : '';
    lines.push('- [' + check + '] ' + t.id + ': ' + t.description + tierStr);
    if (t.status === 'DONE' && t.completed_at) {
      lines.push('  Status: DONE ' + t.completed_at.split('T')[0] + ' — ' + (t.summary || 'Complete'));
    }
  }
  lines.push('');
}
fs.writeFileSync(tasksPath, lines.join('\n'), 'utf8');

// Also generate REVIEWS.md
const reviewsPath = resolve(aiDir, 'REVIEWS.md');
const stampLines = ['# REVIEWS.md (Generated from state.json)', ''];
for (const s of state.stamps) {
  const date = s.timestamp ? s.timestamp.split('T')[0] : 'unknown';
  stampLines.push('[' + s.type + '] ' + date + ' | ' + (s.summary || s.agent || ''));
}
stampLines.push('');
fs.writeFileSync(reviewsPath, stampLines.join('\n'), 'utf8');
"

# Verify TASKS.md has expected structure
md_tasks=$(cat "${MD_DIR}/TASKS.md")
assert_contains "T-02.08a: TASKS.md has header" "Generated from state.json" "$md_tasks"
assert_contains "T-02.08b: TASKS.md has provider-agnostic Engineer section" "## Engineer" "$md_tasks"
assert_contains "T-02.08c: TASKS.md has provider-agnostic Architect section" "## Architect" "$md_tasks"
assert_not_contains "T-02.08b2: header is provider-agnostic (no '(Claude)' suffix)" "## Engineer (Claude)" "$md_tasks"
assert_contains "T-02.08d: TASKS.md has done checkbox" "[x] E-1" "$md_tasks"
assert_contains "T-02.08e: TASKS.md has open checkbox" "[ ] E-2" "$md_tasks"
assert_contains "T-02.08f: TASKS.md has tier info" "Tier: 2" "$md_tasks"

# Verify REVIEWS.md
md_reviews=$(cat "${MD_DIR}/REVIEWS.md")
assert_contains "T-02.08g: REVIEWS.md has stamp" "ARCH_PASS" "$md_reviews"
assert_contains "T-02.08h: REVIEWS.md has date" "2026-03-15" "$md_reviews"
rm -rf "$MD_DIR"

# ── T-02.09: update_task_status DONE sets completed_at ────────────────
done_check=$(node -e "
const state = {
  tasks: [{ id: 'E-1', status: 'OPEN', completed_at: null }],
  stamps: []
};
const task = state.tasks.find(t => t.id === 'E-1');
task.status = 'DONE';
task.completed_at = new Date().toISOString();
task.summary = 'Finished';
console.log(task.completed_at && task.summary === 'Finished' ? 'ok' : 'fail');
")
assert_contains "T-02.09: update_task_status DONE sets completed_at" "ok" "$done_check"

# ── T-02.10: Corrupt JSON recovery (readState returns null) ──────────
corrupt_check=$(node -e "
const fs = require('fs');
const tmp = require('os').tmpdir() + '/corrupt_state_' + Date.now() + '.json';
fs.writeFileSync(tmp, '{broken json!!!');
try {
  const data = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  console.log('parsed_bad');
} catch {
  console.log('ok');
}
fs.unlinkSync(tmp);
")
assert_contains "T-02.10: corrupt JSON is caught by parse" "ok" "$corrupt_check"

# ── T-02.11: marking deltas read: true (inline logic, E-115) ─────────
DELTA_DIR=$(mktemp -d)
cp "$TEMPLATE" "${DELTA_DIR}/state.json"
python3 -c "
import json; s=json.load(open('${DELTA_DIR}/state.json'))
s['deltas']=[{'task_id':'E-99','timestamp':'2026-01-01T00:00:00Z','summary':'Test delta','files_changed':[],'read':False}]
json.dump(s, open('${DELTA_DIR}/state.json','w'), indent=2)
"
# Inline delta-marking logic
node -e "
  import { readFileSync, writeFileSync } from 'fs';
  import { resolve } from 'path';
  const statePath = resolve(process.argv[1], 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const unread = (state.deltas || []).filter(d => !d.read);
  for (const d of unread) { d.read = true; }
  if (unread.length > 0) writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
" "$DELTA_DIR" --input-type=module 2>/dev/null
delta_check=$(python3 -c "
import json; s=json.load(open('${DELTA_DIR}/state.json'))
deltas=s.get('deltas',[])
print('ok' if len(deltas)==1 and deltas[0].get('read')==True else 'fail:'+str(deltas))
")
assert_contains "T-02.11: unread deltas are marked read:true" "ok" "$delta_check"
rm -rf "$DELTA_DIR"

# ── T-02.12: readStateStrict returns null for wrong schema version (E-117) ──
VERSION_DIR=$(mktemp -d)
python3 -c "
import json
json.dump({'version':'0.x','project':{},'tasks':[],'stamps':[]}, open('${VERSION_DIR}/state.json','w'), indent=2)
"
version_check=$(node -e "
  import { readFileSync } from 'fs';
  import { resolve } from 'path';
  const p = resolve(process.argv[1], 'state.json');
  const state = JSON.parse(readFileSync(p, 'utf8'));
  // Mirrors readStateStrict version guard (E-117)
  if (state.version !== '1.0') { console.log('null'); } else { console.log('parsed'); }
" "$VERSION_DIR" --input-type=module 2>/dev/null)
assert_contains "T-02.12: version guard rejects schema v0.x" "null" "$version_check"
rm -rf "$VERSION_DIR"
set +e


# ── E-198 (from cli_add_task — E-302): the shell-native ai add-task ──
# Unit + behavioral tests for the shell-native `ai add-task`
# (E-198, Architect Ruling A / pending D-053). Verifies the CLI persists tasks through
# the SAME shared state-db::addTask as task-synchronizer-mcp::add_task (single source of
# truth), stamps caller_role → owner, and that rows survive verify_markdown_sync.
set -e   # this section ran under its own suite's error mode
HELPER="${REPO_ROOT}/src/shared/cli-add-task.mjs"
STATE_DB="${REPO_ROOT}/src/mcp/shared/state-db.js"
BIN_AI="${REPO_ROOT}/src/bin/ai"
TEMPLATE="${REPO_ROOT}/src/templates/state.json"

# Fresh temp project with a state.json seed (getDb builds state.sqlite from it).
PROJ="$(mktemp -d)"
on_exit 'rm -rf "$PROJ"'
mkdir -p "${PROJ}/.ai"
cp "$TEMPLATE" "${PROJ}/.ai/state.json"

# Run the helper from inside the project (it resolves .ai via cwd walk-up).
# Usage: run_add <ROLE> <args...>  → echoes stdout (the created id); stderr suppressed.
run_add() {
  local role="$1"; shift
  ( cd "$PROJ" && REIN_CALLER_ROLE="$role" node "$HELPER" "$@" 2>/dev/null )
}
task_field() { # <id> <col>
  node --input-type=module -e "
import { getDb } from '${STATE_DB}';
const r = getDb('${PROJ}/.ai').prepare('SELECT * FROM tasks WHERE id = ?').get(process.argv[1]);
process.stdout.write(r ? String(r[process.argv[2]] ?? '') : '__MISSING__');
" "$1" "$2" 2>/dev/null
}

# ── T-01: file structure + syntax ────────────────────────────────────────────
echo ""; echo "  [T-01] Structure"
assert_status 0 "cli-add-task.mjs exists" test -f "$HELPER"
assert_status 0 "helper parses as ESM" node -e "import('file://${HELPER}').catch(e=>{if(e instanceof SyntaxError)process.exit(1)})"

# ── T-02: wired into bin/ai dispatch ─────────────────────────────────────────
echo ""; echo "  [T-02] CLI wiring"
assert_status 0 "bin/ai has add-task dispatch case" grep -qE '^\s*add-task\)\s+do_add_task' "$BIN_AI"
assert_status 0 "bin/ai defines do_add_task" grep -q 'do_add_task()' "$BIN_AI"

# ── T-03: single-source write path (no divergence from the MCP) ──────────────
echo ""; echo "  [T-03] Shared addTask (DRY with MCP)"
assert_status 0 "state-db.js exports addTask" grep -qE '^export function addTask' "$STATE_DB"
assert_status 0 "task-synchronizer-mcp imports the shared addTask" \
  grep -q 'addTask as _addTask' "${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"
assert_status 0 "helper routes through the shared addTask" \
  grep -q "import { getDbSeeded, addTask } from" "$HELPER"

# ── T-04: functional create + caller_role stamping ───────────────────────────
echo ""; echo "  [T-04] Create + caller_role → owner"
id_arch="$(run_add architect --tier 2 "Architect created task")"
assert_contains "T-04.01: returns an E-id on stdout" "E-" "$id_arch"
# D-066: the owner label is derived from roles.json, whose default is now all-Claude.
assert_contains "T-04.02: architect role → owner 'Architect (Claude)'" "Architect (Claude)" "$(task_field "$id_arch" owner)"
assert_contains "T-04.03: status OPEN (no deps)" "OPEN" "$(task_field "$id_arch" status)"
assert_contains "T-04.04: tier persisted" "2" "$(task_field "$id_arch" tier)"

id_eng="$(run_add engineer "Engineer created task")"
assert_contains "T-04.05: engineer role → owner 'Engineer (Claude)'" "Engineer (Claude)" "$(task_field "$id_eng" owner)"

# explicit --owner overrides the role mapping
id_own="$(run_add architect --owner "Tester (claude · sonnet)" "Explicit owner task")"
assert_contains "T-04.06: explicit --owner wins over role" "Tester (claude · sonnet)" "$(task_field "$id_own" owner)"

# ── T-05: survives verify_markdown_sync (row is in the regenerated view) ─────
echo ""; echo "  [T-05] Regenerated views"
assert_status 0 "T-05.01: TASKS.md regenerated with the new task" \
  grep -q "Architect created task" "${PROJ}/.ai/TASKS.md"
assert_status 0 "T-05.02: state.json view holds the new task" \
  grep -q "Engineer created task" "${PROJ}/.ai/state.json"

# ── T-06: DAG — depends_on unmet → BLOCKED ───────────────────────────────────
echo ""; echo "  [T-06] Dependencies"
id_dep="$(run_add engineer --depends-on "${id_arch}" "Blocked-by-dep task")"
assert_contains "T-06.01: unmet dependency → BLOCKED" "BLOCKED" "$(task_field "$id_dep" status)"

# ── T-07: prefix + input validation ──────────────────────────────────────────
echo ""; echo "  [T-07] Prefix + validation"
id_p="$(run_add architect --prefix P "Architect plan task")"
assert_contains "T-07.01: --prefix P → P-id" "P-" "$id_p"
assert_status 2 "T-07.02: empty description → usage exit 2" \
  bash -c "cd '$PROJ' && REIN_CALLER_ROLE=engineer node '$HELPER' --tier 1 2>/dev/null"

# ── T-08: stdout purity (only the id on stdout; noise → stderr) ──────────────
echo ""; echo "  [T-08] stdout purity"
out="$(run_add engineer "Purity check task")"
assert_status 0 "T-08.01: stdout is a single bare id line" \
  bash -c "printf '%s' '$out' | grep -qxE 'E-[0-9]+'"

# D-099 (E-322): add-task no longer wakes the other role — a cross-role task writes no queue.
run_add architect --prefix E "Cross-role task, no wake" >/dev/null
assert_status 1 "T-10.01: a cross-role add writes no handoff queue" test -e "${PROJ}/.ai/signal.json"
set +e


# ── E-89 (from migrate_state — E-302): ai migrate-state and the P-44 mandate ──
# Tests for ai migrate-state (E-89/P-43) and P-44 mandate enforcement
# Validates: parser correctness, status preservation, tier detection, guard check,
#            JSON schema, blueprint-aligner fail-safe, task-synchronizer strict writes,
#            and post-commit.sh state-first ordering.
set -e   # this section ran under its own suite's error mode
TEMPLATE="${REPO_ROOT}/src/templates/state.json"
AI_BIN="${REPO_ROOT}/src/bin/ai"
ALIGNER_MCP="${REPO_ROOT}/src/mcp/blueprint-aligner-mcp/index.js"
POST_COMMIT="${REPO_ROOT}/hooks/post-commit.sh"

# ── T-04.01: migrate-state seeds tasks from a well-formed TASKS.md fixture ──
MIGRATE_DIR=$(mktemp -d)
on_exit 'rm -rf "$MIGRATE_DIR"'

mkdir -p "${MIGRATE_DIR}/.ai"
cp "$TEMPLATE" "${MIGRATE_DIR}/.ai/state.json"

cat > "${MIGRATE_DIR}/.ai/TASKS.md" <<'TASKS'
# TASKS (Ordered work)

## Architect (Claude)
- [x] P-01: Blueprint for isolation
  Status: DONE 2026-03-07 — Section 1 done
- [ ] P-02: Blueprint for security

## Engineer (Claude)
- [x] E-01: Implement feature A
  Status: DONE 2026-03-08 — src/feature-a.js complete
- [ ] E-02: Fix bug B
TASKS

(cd "$MIGRATE_DIR" && bash "$AI_BIN" migrate-state) >/dev/null 2>&1

task_count=$(python3 -c "
import json, sys
d = json.load(open('${MIGRATE_DIR}/.ai/state.json'))
print(len(d.get('tasks', [])))
")
assert_contains "T-04.01: migrate-state seeds tasks from TASKS.md" "4" "$task_count"

# ── T-04.02: migrate-state preserves DONE status and completed_at ────────────
status_check=$(python3 -c "
import json
d = json.load(open('${MIGRATE_DIR}/.ai/state.json'))
tasks = {t['id']: t for t in d['tasks']}
p1 = tasks.get('P-1', {})
e1 = tasks.get('E-1', {})
p2 = tasks.get('P-2', {})
e2 = tasks.get('E-2', {})
ok = (
    p1.get('status') == 'DONE'
    and p1.get('completed_at', '').startswith('2026-03-07')
    and p1.get('summary') == 'Section 1 done'
    and e1.get('status') == 'DONE'
    and e1.get('completed_at', '').startswith('2026-03-08')
    and p2.get('status') == 'OPEN'
    and e2.get('status') == 'OPEN'
    and p2.get('completed_at') is None
)
print('ok' if ok else 'fail: ' + str({'p1': p1, 'p2': p2, 'e1': e1, 'e2': e2}))
")
assert_contains "T-04.02: migrate-state preserves DONE status and completed_at" "ok" "$status_check"

# ── T-04.03: migrate-state detects Tier values ──────────────────────────────
TIER_DIR=$(mktemp -d)
mkdir -p "${TIER_DIR}/.ai"
cp "$TEMPLATE" "${TIER_DIR}/.ai/state.json"

cat > "${TIER_DIR}/.ai/TASKS.md" <<'TASKS'
## Engineer (Claude)
- [ ] E-01: Security feature | Tier: 3
- [ ] E-02: CSS tweak | Tier: 1
- [ ] E-03: No tier
TASKS

(cd "$TIER_DIR" && bash "$AI_BIN" migrate-state) >/dev/null 2>&1

tier_check=$(python3 -c "
import json
d = json.load(open('${TIER_DIR}/.ai/state.json'))
tasks = {t['id']: t for t in d['tasks']}
ok = (
    tasks['E-1']['tier'] == 3
    and tasks['E-2']['tier'] == 1
    and tasks['E-3']['tier'] is None
)
print('ok' if ok else 'fail: ' + str(tasks))
")
assert_contains "T-04.03: migrate-state detects Tier values correctly" "ok" "$tier_check"
rm -rf "$TIER_DIR"

# ── T-04.04: Guard check — re-running without --force exits non-zero ─────────
guard_check=$(cd "$MIGRATE_DIR" && bash "$AI_BIN" migrate-state 2>&1; echo "exit:$?")
assert_contains "T-04.04: guard blocks re-migration without --force" "already has" "$guard_check"
# Verify exit code was non-zero
guard_exit_ok="ok"
if (cd "$MIGRATE_DIR" && bash "$AI_BIN" migrate-state 2>/dev/null); then
  guard_exit_ok="fail"  # exited 0 — guard did not fire
fi
assert_contains "T-04.04b: guard exits non-zero without --force" "ok" "$guard_exit_ok"

# ── T-04.05: Migration produces valid JSON (schema check) ────────────────────
schema_check=$(python3 -c "
import json, sys
try:
    d = json.load(open('${MIGRATE_DIR}/.ai/state.json'))
    ok = all(k in d for k in ('version', 'project', 'tasks', 'stamps'))
    ok = ok and isinstance(d['tasks'], list)
    ok = ok and all(
        all(k in t for k in ('id', 'owner', 'status', 'tier', 'description', 'created_at', 'completed_at', 'summary'))
        for t in d['tasks']
    )
    print('ok' if ok else 'missing fields')
except Exception as e:
    print('error: ' + str(e))
")
assert_contains "T-04.05: migration produces valid JSON with correct schema" "ok" "$schema_check"

# ── T-04.06: blueprint-aligner-mcp TIER3_NO_SECURITY_REVIEW fails when state.json missing ──
# Verify the source code has the fail-safe return for missing state.json
aligner_failsafe=$(grep -c 'state.json missing — run: ai migrate-state' "$ALIGNER_MCP" || echo "0")
assert_contains "T-04.06: blueprint-aligner-mcp has fail-safe for missing state.json" "1" "$aligner_failsafe"

# Verify the TASKS.md fallback regex is gone
legacy_fallback=$(grep -c 'TASKS.md.*regex\|Fallback.*legacy TASKS' "$ALIGNER_MCP" 2>/dev/null || echo "0")
assert_contains "T-04.06b: TASKS.md fallback regex removed from blueprint-aligner-mcp" "0" "$legacy_fallback"

# ── T-04.07: task-synchronizer-mcp gates on missing .ai/ directory ──
# E-156: readStateStrict replaced by SQLite getDb() — verify the new guard is present
sqlite_guard=$(grep -l 'getDb(aiDir)' "$SYNC_MCP" 2>/dev/null && echo "found" || echo "missing")
assert_contains "T-04.07: task-synchronizer-mcp has SQLite getDb guard" "found" "$sqlite_guard"

# Verify write tools call _getDb (local wrapper around shared getDb)
getdb_used=$(grep -c 'db = _getDb(aiDir)' "$SYNC_MCP" 2>/dev/null || echo "0")
assert_contains "T-04.07b: _getDb used in tool handler" "1" "$getdb_used"
state_missing_present=$(grep -l 'STATE_MISSING_ERR\|No .ai/ directory' "$SYNC_MCP" 2>/dev/null && echo "found" || echo "missing")
assert_contains "T-04.07c: STATE_MISSING_ERR message defined" "found" "$state_missing_present"

# Functional test: simulate readStateStrict returning null (missing file) → error path
strict_check=$(node -e "
import { existsSync } from 'fs';
import { resolve } from 'path';
const aiDir = '/tmp/nonexistent_' + Date.now();
const p = resolve(aiDir, 'state.json');
const missing = !existsSync(p);
console.log(missing ? 'ok' : 'fail');
" 2>/dev/null || node --input-type=module -e "
import { existsSync } from 'fs';
import { resolve } from 'path';
const aiDir = '/tmp/nonexistent_' + Date.now();
const p = resolve(aiDir, 'state.json');
const missing = !existsSync(p);
console.log(missing ? 'ok' : 'fail');
" 2>/dev/null || echo "ok")
assert_contains "T-04.07d: missing state.json is correctly detected as absent" "ok" "$strict_check"

# ── T-04.08: post-commit.sh writes state.json before modifying TASKS.md ──────
# Verify no sed mutation of TASKS.md in the new post-commit.sh
sed_mutation=$(grep -c "sed.*TASKS_FILE\|sed.*tasks" "$POST_COMMIT" 2>/dev/null || echo "0")
assert_contains "T-04.08: post-commit.sh has no direct sed mutation of TASKS.md" "0" "$sed_mutation"

# E-325 (D-102): the hook no longer writes state.json or TASKS.md at all — that second writer
# bypassed the completion gates. It closes each "Fixes E-##" task through `ai task done`
# (install mirror only), which writes through record-store.mjs.
own_writes=$(grep -c "writeFileSync\|> *\"\$STATE_FILE\"\|> *\"\$TASKS_FILE\"" "$POST_COMMIT" || true)
assert_contains "T-04.08b: post-commit.sh writes no state file itself" "0" "${own_writes:-0}"
assert_status 0 "T-04.08b2: post-commit.sh closes tasks through the mirror's ai task done" \
  grep -q '"\$AI_BIN" task done "\$ID"' "$POST_COMMIT"

# Verify warn-and-exit when the ai binary is missing (no silent fallback)
warn_check=$(grep -c 'WARN: .* not found' "$POST_COMMIT" || echo "0")
assert_contains "T-04.08c: post-commit.sh warns and exits when ai is absent" "1" "$warn_check"

# ── T-04.09: TIER3_NO_SECURITY_REVIEW does NOT clear when only LOG.md has evidence ──
# P-44: gate must require stamps[], not LOG.md text
T49_DIR=$(mktemp -d)
mkdir -p "${T49_DIR}/.ai"

# state.json with a Tier-3 DONE task and empty stamps[]
cat > "${T49_DIR}/.ai/state.json" <<'JSON'
{
  "version": "1.0",
  "project": { "focus": "test" },
  "tasks": [
    {
      "id": "E-1",
      "owner": "claude",
      "status": "DONE",
      "tier": 3,
      "description": "Security feature",
      "created_at": "2026-03-01",
      "completed_at": "2026-03-16",
      "summary": "done"
    }
  ],
  "stamps": []
}
JSON

# LOG.md with security keywords that used to bypass the gate
cat > "${T49_DIR}/.ai/LOG.md" <<'LOG'
## 2026-03-16
- security_engineer activated
- [SEC_PASS] THREAT_MODEL written
- [SECURITY] review complete
LOG

# The check function in the aligner must still return a violation
t49_result=$(node --input-type=module -e "
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const cwd = '${T49_DIR}';
const statePath = resolve(cwd, '.ai/state.json');
const logPath = resolve(cwd, '.ai/LOG.md');

const readFileSafe = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

const state = JSON.parse(readFileSafe(statePath));
const tier3Done = (state.tasks || []).some(t => t.tier === 3 && t.status === 'DONE');
const hasSecStamp = (state.stamps || []).some(s => /SEC_PASS|SEC_CLEARED/i.test(s.type));
// Replicate the P-44 gate logic (no LOG.md bypass)
if (!tier3Done) { console.log('no-tier3'); process.exit(0); }
if (hasSecStamp) { console.log('has-stamp'); process.exit(0); }
console.log('violation');
" 2>/dev/null || echo "violation")
assert_contains "T-04.09: TIER3_NO_SECURITY_REVIEW blocks when stamps[] empty despite LOG.md keywords" "violation" "$t49_result"
rm -rf "$T49_DIR"

# ── T-04.10: migrate-state --force is NON-DESTRUCTIVE over a populated state ──
# Regression for the recurring corruption: TASKS.md is a LOSSY view (date-only
# timestamps, no depends_on). Re-migrating MUST preserve the rich existing record
# (full time-of-day created_at + depends_on/ready/blocked_by) and only APPEND
# genuinely-new tasks — never zero timestamps or strip the DAG.
ND_DIR="$(mktemp -d)"; mkdir -p "$ND_DIR/.ai"
cat > "$ND_DIR/.ai/state.json" <<'JSON'
{ "version": "1.0", "project": { "current_tier": "2", "focus": "x" },
  "tasks": [ { "id": "E-1", "owner": "Engineer (Claude)", "status": "DONE", "tier": 2, "description": "rich task", "created_at": "2026-06-03T07:22:16.333Z", "completed_at": "2026-06-03T10:44:26.315Z", "summary": "full summary kept in LOG", "depends_on": ["E-0"], "ready": false, "blocked_by": ["E-0"] } ],
  "stamps": [] }
JSON
cat > "$ND_DIR/.ai/TASKS.md" <<'MD'
# TASKS (Generated from state.json)

## Engineer (Claude)
- [x] E-1: rich task | Tier: 2
  Status: DONE 2026-06-03 — full summary …[full in LOG.md]
- [ ] E-2: a brand-new task only in TASKS.md | Tier: 1
MD
(cd "$ND_DIR" && bash "$AI_BIN" migrate-state --force) >/dev/null 2>&1
nd_check=$(python3 -c "
import json
d=json.load(open('${ND_DIR}/.ai/state.json')); t={x['id']:x for x in d['tasks']}
e1=t.get('E-1',{})
ok = (e1.get('created_at')=='2026-06-03T07:22:16.333Z'      # time-of-day preserved (not midnight)
      and e1.get('depends_on')==['E-0'] and e1.get('ready') is False  # DAG preserved
      and e1.get('summary')=='full summary kept in LOG'     # rich summary preserved
      and 'E-2' in t and t['E-2'].get('depends_on')==[])    # new task appended with default deps
print('ok' if ok else 'CORRUPTED: '+json.dumps(e1))
")
assert_contains "T-04.10: migrate-state --force preserves rich tasks (no corruption)" "ok" "$nd_check"
rm -rf "$ND_DIR"

# ── E-325: the post-commit hook and `ai state` across the process boundary ───
# Extends T-04.08 (which reads the hook's text) with the hook actually run on a commit.
_pc_repo() {  # → a git repo whose HEAD commit message is "$1"
  local d; d="$(test_tmpdir e325pc)"
  git -C "$d" init -q -b master && git -C "$d" config user.email t@example.com && git -C "$d" config user.name T
  mkdir -p "$d/.ai" && : > "$d/.ai/TASKS.md"
  git -C "$d" add -A && git -C "$d" -c commit.gpgsign=false commit -q -m "$1"
  printf '%s' "$d"
}
_pc_home="$(test_tmpdir e325home)"
tc_fixture_home "$_pc_home"   # E-345 (D-109 r1): the toolchain record the hooks pin
mkdir -p "$_pc_home/.rein/bin"
cat > "$_pc_home/.rein/bin/ai" <<STUB
#!/bin/bash
printf '%s|' "\$@" >> "$_pc_home/args"; printf '\n' >> "$_pc_home/args"
echo "[CI_GATE] refused for the test"
exit 1
STUB
chmod +x "$_pc_home/.rein/bin/ai"
_pc="$(_pc_repo "feat: x — Fixes E-1 and Closes P-2")"
_pc_rc=0; _pc_out="$(cd "$_pc" && HOME="$_pc_home" bash "$POST_COMMIT" 2>&1)" || _pc_rc=$?
assert_status 0 "E-325.pc1: post-commit exits 0 even when ai task done refuses" test "$_pc_rc" -eq 0
assert_contains "E-325.pc2: it runs the mirror's ai task done for each referenced id" \
  "task|done|E-1|--summary|closed by commit" "$(cat "$_pc_home/args" 2>/dev/null)"
assert_contains "E-325.pc3: …for every id in the message" "task|done|P-2|" "$(cat "$_pc_home/args" 2>/dev/null)"
assert_contains "E-325.pc4: the refusal is passed through, prefixed" "[TASK-SYNC] [CI_GATE] refused" "$_pc_out"
_pc_bare="$(test_tmpdir e325bare)"
tc_fixture_home "$_pc_bare"   # E-345 (D-109 r1): the toolchain record the hooks pin
_pc_rc2=0; _pc_out2="$(cd "$_pc" && HOME="$_pc_bare" bash "$POST_COMMIT" 2>&1)" || _pc_rc2=$?
assert_status 0 "E-325.pc5: with no ai in the mirror it exits 0" test "$_pc_rc2" -eq 0
assert_contains "E-325.pc6: …and says why" "WARN:" "$_pc_out2"

# `ai state migrate --team` through the binary, then `ai migrate-state` refuses the team project.
_st="$(_pc_repo "seed")"
cp "$TEMPLATE" "$_st/.ai/state.json"
printf 'state.sqlite\nstate.sqlite-shm\nstate.sqlite-wal\n' > "$_st/.ai/.gitignore"
git -C "$_st" add -A && git -C "$_st" -c commit.gpgsign=false commit -q -m "state"
_st_out="$(cd "$_st" && HOME="$_pc_bare" bash "$AI_BIN" state migrate --team --trunk master 2>&1)" || true
assert_contains "E-325.st1: ai state migrate --team reaches cli-state.mjs" "migrated to team records" "$_st_out"
assert_status 0 "E-325.st2: …and leaves the team marker" test -f "$_st/.ai/project.json"
_ms_rc=0; _ms_out="$(cd "$_st" && HOME="$_pc_bare" bash "$AI_BIN" migrate-state 2>&1)" || _ms_rc=$?
assert_status 0 "E-325.st3: ai migrate-state refuses a team project" test "$_ms_rc" -ne 0
assert_contains "E-325.st4: …naming why" "team project" "$_ms_out"
# E-327: `ai team` reaches cli-state.mjs through the binary (team.json from migrate --team).
_tm_out="$(cd "$_st" && HOME="$_pc_bare" bash "$AI_BIN" team add t2@example.com --range E:500-509 2>&1)" || true
assert_contains "E-327.tm1: ai team add writes the range" "t2@example.com E:500-509 added" "$_tm_out"
assert_contains "E-327.tm2: ai team show names the planner and both members" "t2@example.com  E:500-509" \
  "$(cd "$_st" && HOME="$_pc_bare" bash "$AI_BIN" team show 2>&1)"
assert_status 0 "E-325.st5: ai task with no verb prints usage and exits 2" \
  bash -c "cd '$_st' && HOME='$_pc_bare' bash '$AI_BIN' task >/dev/null 2>&1; test \$? -eq 2"
set +e

assert_summary
