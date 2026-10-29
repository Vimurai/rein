#!/usr/bin/env bash
# resilience_test.sh — Bootloader Resilience Validation Suite (E-113 / P-52 §34)
# Validates: 3-layer bootloader fallback (orchestrator-mcp → ai-preflight → CLAUDE.md),
# the state.json import's version/corruption guard, and state corruption recovery.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

REPO_ROOT="${SCRIPT_DIR}/../.."
ORCH_MCP="${REPO_ROOT}/src/mcp/orchestrator-mcp/index.js"
SHARED_STATE="${REPO_ROOT}/src/mcp/shared/state-db.js"
PREFLIGHT_SKILL="${REPO_ROOT}/src/shared/skills/ai-preflight/SKILL.md"
# E-183/D-050: Emergency Recovery (Layer 3) lives in the canonical ENGINEER.md bootloader;
# CLAUDE.md is now a thin @import shim that re-exports it.
CLAUDE_MD_TEMPLATE="${REPO_ROOT}/src/templates/ENGINEER.md"

echo "── Suite: resilience_test ─────────────────────────────────────────"

# ── Scenario A: Layer 1 Failure (orchestrator-mcp unavailability) ─────────────

# T-RES-01: orchestrator-mcp syntax is valid (server is startable)
assert_status 0 "T-RES-01: orchestrator-mcp syntax OK" \
  node --check "${ORCH_MCP}"

# T-RES-02: Layer 2 fallback skill exists and is non-empty
assert_exists "$PREFLIGHT_SKILL"

# T-RES-03: ai-preflight skill has valid YAML frontmatter
preflight_name=$(grep "^name:" "$PREFLIGHT_SKILL" | awk '{print $2}')
assert_contains "T-RES-03: ai-preflight skill has correct name" "ai-preflight" "$preflight_name"

# T-RES-04: ai-preflight skill contains bash fallback read instructions
assert_status 0 "T-RES-04: ai-preflight contains bash jq fallback" \
  grep -q "state.json\|jq\|grep" "$PREFLIGHT_SKILL"

# T-RES-05: Layer 3 — global CLAUDE.md has Emergency Recovery section
assert_status 0 "T-RES-05: global CLAUDE.md has Emergency Recovery section (Layer 3)" \
  grep -q "Emergency Recovery\|Bootloader Resilience\|Layer 3\|Absolute last resort" "$CLAUDE_MD_TEMPLATE"

# ── Scenario B: Layer 2 Failure (ai-preflight skill missing) ─────────────────

# T-RES-06: global CLAUDE.md contains manual recovery bash commands
assert_status 0 "T-RES-06: global CLAUDE.md manual recovery has 'grep TASKS.md' fallback" \
  grep -q "TASKS.md" "$CLAUDE_MD_TEMPLATE"

# T-RES-07: global CLAUDE.md contains state.json python/jq read for focus
assert_status 0 "T-RES-07: global CLAUDE.md manual recovery reads state.json focus" \
  grep -q "state.json\|focus\|python3\|jq" "$CLAUDE_MD_TEMPLATE"

# T-RES-08: global CLAUDE.md contains LOG.md tail fallback
assert_status 0 "T-RES-08: global CLAUDE.md manual recovery has LOG.md tail fallback" \
  grep -q "LOG.md" "$CLAUDE_MD_TEMPLATE"

# ── Scenario C: State Corruption (invalid state.json) ────────────────────────

# E-325: these pins moved from state-writer.js readStateStrict (deleted — no production caller
# read through it) to the path that actually reads state.json: getDbSeeded's one-time import.
# A rejected file imports nothing and does not throw, so a corrupt view never seeds the store.
_seed_probe() {  # <state.json content or ""> → number of tasks imported, or "error"
  node --input-type=module -e "
const { getDbSeeded } = await import('file://${SHARED_STATE}');
const fs = await import('fs'); const os = await import('os'); const path = await import('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resilience-'));
if (process.argv[1]) fs.writeFileSync(path.join(tmp, 'state.json'), process.argv[1]);
const db = getDbSeeded(tmp);
console.log('tasks=' + db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n);
fs.rmSync(tmp, { recursive: true, force: true });
" "$1" 2>/dev/null || echo "error"
}

# T-RES-09: a state.json with the wrong version field is not imported
_task='{"id":"E-1","owner":"Engineer","status":"OPEN","description":"x","created_at":"2026-01-01T00:00:00.000Z"}'
assert_contains "T-RES-09: wrong-version state.json is rejected by the import" "tasks=0" \
  "$(_seed_probe "{\"version\":\"99.0\",\"tasks\":[${_task}],\"stamps\":[]}")"

# T-RES-10: syntactically invalid JSON is rejected without throwing
assert_contains "T-RES-10: invalid JSON state.json is rejected by the import" "tasks=0" \
  "$(_seed_probe '{invalid json !!!}')"

# T-RES-11: a missing state.json seeds an empty store (no throw)
assert_contains "T-RES-11: missing state.json seeds an empty store" "tasks=0" "$(_seed_probe '')"

# ── Scenario D: Simulated Node Failure (E-2 / bootloader.md §3) ──────────────

AI_EXEC="${REPO_ROOT}/src/bin/ai-exec"
STATE_SQLITE="${REPO_ROOT}/.ai/state.sqlite"
STATE_JSON="${REPO_ROOT}/.ai/state.json"

# T-RES-12: ai-exec binary exists and is executable (secondary fallback layer)
assert_exists "$AI_EXEC"
assert_status 0 "T-RES-12: ai-exec is executable" \
  test -x "$AI_EXEC"

# T-RES-13: Simulated node failure — chmod orchestrator-mcp to non-executable,
# assert fallback shell cat of TASKS.md still works, then restore.
ORIG_MODE=$(stat -f "%p" "$ORCH_MCP" 2>/dev/null || stat -c "%a" "$ORCH_MCP" 2>/dev/null)
chmod 000 "$ORCH_MCP"
fallback_result=$(cat "${REPO_ROOT}/.ai/TASKS.md" 2>/dev/null | head -1 || echo "FAIL")
chmod 644 "$ORCH_MCP"
assert_contains "T-RES-13: shell cat fallback reads TASKS.md during simulated node failure" \
  "TASKS" "$fallback_result"

# T-RES-14: Fallback verification — state.json is parseable by Python (secondary path)
fallback_json=$(python3 -c "
import json
s = json.load(open('${STATE_JSON}'))
print('ok' if 'tasks' in s else 'fail')
" 2>/dev/null || echo "error")
assert_contains "T-RES-14: Python fallback can parse state.json (secondary fallback path)" \
  "ok" "$fallback_json"

# ── Scenario E: SQLite Integrity Check (E-2 / bootloader.md §3) ──────────────

if [ -f "$STATE_SQLITE" ] && command -v sqlite3 &>/dev/null; then
  # T-RES-15: SQLite integrity_check returns 'ok' (no corruption)
  integrity=$(sqlite3 "$STATE_SQLITE" "PRAGMA integrity_check;" 2>/dev/null || echo "error")
  assert_contains "T-RES-15: state.sqlite PRAGMA integrity_check passes (no corruption)" \
    "ok" "$integrity"

  # T-RES-16: SQLite read-only query succeeds (fallback MUST only read per blueprint §2)
  task_count=$(sqlite3 "$STATE_SQLITE" "SELECT COUNT(*) FROM tasks;" 2>/dev/null || echo "error")
  assert_status 0 "T-RES-16: read-only SELECT on state.sqlite succeeds in fallback mode" \
    test "$task_count" -ge 0
else
  _pass "T-RES-15: state.sqlite integrity check skipped (sqlite3 or db not available)"
  _pass "T-RES-16: state.sqlite read-only query skipped (sqlite3 or db not available)"
fi

assert_summary
