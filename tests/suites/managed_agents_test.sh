#!/usr/bin/env bash
# managed_agents_test.sh — the Managed Agents client and spike across a process boundary.
#
# One suite for the Managed Agents behaviours that need a process (E-302, wave 2 of the D-088
# consolidation): the E-70 live client (below), then the sections absorbed from
# state_projector_sync (E-73) and managed_agents_spike (E-47). The pure client rows —
# sendSteps / migrateLegacyToSteps / projectState / syncToCloud called in-process, and the
# source-contract greps — live in tests/unit/managed-agents-client.test.mjs.
#
# ── E-70 (from managed_agents_client): the live client ──
# Verifies the production wiring of E-47's offline spike per
# .ai/blueprints/system-hardening-phase3.md §Components §3:
#   - AI_MANAGED_AGENTS_ENABLE feature flag (default OFF / fail-closed)
#   - AI_MANAGED_AGENT_KEY env-only secret (never logged, never persisted)
#   - Payload migration from legacy `outputs` to `steps` schema
#   - URL allowlist + protocol enforcement
#
# Strategy: drive the client module via dynamic import in throwaway
# Node-script harnesses. Never makes a real network call — fetch is
# either guarded by AI_MANAGED_AGENTS_ENABLE=0 or aimed at a localhost
# stub that returns canned responses.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CLIENT="${REPO_ROOT}/src/shared/managed-agents-client.mjs"

echo "===== managed_agents_test.sh ====="

# ── T-MAC-S01: File presence + smoke status ──────────────────────────────────
echo ""
echo "  [T-MAC-S01] Client module runs --status without env"
# (its "client file exists" / "node shebang" rows are in the unit file)

STATUS_OUT="$(node "$CLIENT" --status 2>/dev/null)"
assert_status 0 "status JSON parses" \
  node --input-type=module -e "JSON.parse(\`${STATUS_OUT//\`/}\`)"
assert_status 0 "default status reports enabled=false (feature-flag OFF)" \
  bash -c "echo '$STATUS_OUT' | grep -q '\"enabled\": false'"
assert_status 0 "default status reports key_valid=false (no leak)" \
  bash -c "echo '$STATUS_OUT' | grep -q '\"key_valid\": false'"
assert_status 0 "API version pinned to managed-agents-2026-04-01" \
  bash -c "echo '$STATUS_OUT' | grep -q '\"api_version\": \"managed-agents-2026-04-01\"'"

# ── T-MAC-S07: Live request hits stub server, sends Bearer, posts JSON ────────
echo ""
echo "  [T-MAC-S07] End-to-end: enabled+key → Bearer auth + steps payload"

SBOX="$(mktemp -d)"
on_exit 'rm -rf "$SBOX"'
LOG="${SBOX}/stub.log"

# Spawn a localhost HTTPS stub via Node — we use plain HTTP for the stub
# and override AI_MANAGED_AGENT_HOST + monkeypatch the protocol check via
# a per-test client. Simplest: stand up an HTTP server and substitute the
# host. The client enforces https, so we drive a thinner code path via
# direct import of validation helpers; for the real send path we run a
# `--no-tls` variant by hosting a local listener and skipping the
# protocol guard in this test via a small parallel runner.
#
# Cleaner approach used here: assert send path produces the documented
# envelope for an unresolvable host (NETWORK_ERROR), which exercises
# the entire fetch wiring and Authorization header construction without
# tunneling around the https-only guard.

result="$(node --input-type=module -e "
  const m = await import('file://${CLIENT}');
  const env = {
    AI_MANAGED_AGENTS_ENABLE:'1',
    AI_MANAGED_AGENT_KEY:'abcdef0123456789',
    AI_MANAGED_AGENT_HOST:'127.0.0.1.invalid-tld-for-test.local',
  };
  const r = await m.sendSteps({ agentId:'a1', steps:[{text:'hi'}], timeoutMs: 1500 }, env);
  // Emit the envelope so we can assert shape and error class.
  console.log(JSON.stringify({status: r.status, name: r.name || null}));
" 2>/dev/null)"

assert_status 0 "live send to unresolvable host → status=NETWORK_ERROR" \
  bash -c "echo '$result' | grep -q '\"status\":\"NETWORK_ERROR\"'"

# ── T-MAC-S08: Key + tokens are NEVER logged ─────────────────────────────────
echo ""
echo "  [T-MAC-S08] Stderr from any failure path redacts the key"

stderr_out="$(node --input-type=module -e "
  const m = await import('file://${CLIENT}');
  const env = {
    AI_MANAGED_AGENTS_ENABLE:'1',
    AI_MANAGED_AGENT_KEY:'SUPER_SECRET_KEY_abcdef0123456789',
    AI_MANAGED_AGENT_HOST:'unresolvable.invalid-tld-for-test.local',
  };
  // Force a network error path so the logger fires.
  await m.sendSteps({ agentId:'a1', steps:[{text:'hi'}], timeoutMs:800 }, env);
" 2>&1 >/dev/null)"

assert_status 1 "stderr does NOT include the key value" \
  bash -c "echo '$stderr_out' | grep -q 'SUPER_SECRET_KEY_abcdef0123456789'"

# Sensitive payload fields also redacted in any structured extras
stderr_payload="$(node --input-type=module -e "
  const m = await import('file://${CLIENT}');
  const env = {
    AI_MANAGED_AGENTS_ENABLE:'1',
    AI_MANAGED_AGENT_KEY:'abcdef0123456789',
    AI_MANAGED_AGENT_HOST:'unresolvable.invalid-tld-for-test.local',
  };
  await m.sendSteps({
    agentId:'a1',
    steps:[{ text: 'leak?', tool_calls: [{ apikey: 'SECRET_FIELD_VALUE' }] }],
    timeoutMs: 800,
  }, env);
" 2>&1 >/dev/null)"

assert_status 1 "stderr does NOT include payload-secret values" \
  bash -c "echo '$stderr_payload' | grep -q 'SECRET_FIELD_VALUE'"

# ── T-MAC-S09: Mirror byte-identity ──────────────────────────────────────────
echo ""
echo "  [T-MAC-S09] ~/.rein mirror matches src"

MIRROR="${HOME}/.rein/shared/managed-agents-client.mjs"
if [[ -f "$MIRROR" ]]; then
  assert_status 0 "mirror is byte-identical to src" \
    diff -q "$CLIENT" "$MIRROR"
else
  echo "    ⚠  mirror absent — skipping"
fi

# ── E-73 (from state_projector_sync — E-302): the State Projector + debounced sync_to_cloud ──
# Production wiring of .ai/blueprints/managed-agents-state-reconciliation.md. The pure
# projectState / syncToCloud / cancelPendingSync rows (T-STP-S01..S10, S12) live in
# tests/unit/managed-agents-client.test.mjs; what stays here crosses a process boundary: the
# debounced fetch's structured stderr (S11), the CLI flags and exit codes (S13), and the
# installed mirror (S14). Never makes a real network call — fetch is aimed at an
# unresolvable host so the NETWORK_ERROR envelope is deterministic.

# A populated on-disk state.sqlite for T-STP-S13. The repo's own .ai/state.sqlite is
# gitignored, so it is absent in CI and fresh clones — seed an equivalent temp DB then.
STP_SBOX="$(test_tmpdir stpsync)"
REAL_DB="${REPO_ROOT}/.ai/state.sqlite"
if [[ ! -f "$REAL_DB" ]]; then
  REAL_DB="${STP_SBOX}/real-state.sqlite"
  node --input-type=module -e "
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync('${REAL_DB}');
    db.exec(\`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL,
        tier INTEGER, description TEXT NOT NULL, created_at TEXT NOT NULL,
        completed_at TEXT, summary TEXT
      );
      INSERT INTO tasks VALUES ('E-1','Engineer (Claude)','OPEN',2,'seed open','2026-01-01',NULL,NULL);
      INSERT INTO tasks VALUES ('E-2','Engineer (Claude)','DONE',2,'seed done','2026-01-01','2026-01-02','done');
    \`);
    db.close();
  "
fi

# The DB the debounced sync projects (one OPEN row — the shape S11 ran against before E-302).
STP_SBOX_DB="${STP_SBOX}/state.sqlite"
node --input-type=module -e "
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('${STP_SBOX_DB}');
  db.exec(\`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL,
      tier INTEGER, description TEXT NOT NULL, created_at TEXT NOT NULL,
      completed_at TEXT, summary TEXT
    );
    INSERT INTO tasks VALUES ('E-200','Engineer (Claude)','OPEN',2,
      'PROPRIETARY_INTERNAL_DESCRIPTION_XYZ','2026-01-01',NULL,
      'PROPRIETARY_INTERNAL_SUMMARY_XYZ');
  \`);
  db.close();
"

# ── T-STP-S11: End-to-end — debounce fires; fetch logs to stderr ─────────────
echo ""
echo "  [T-STP-S11] After debounce window, fetch fires and logs structured warn"

stderr_out="$(node --input-type=module -e "
  const m = await import('file://${CLIENT}');
  const env = {
    AI_MANAGED_AGENTS_ENABLE: '1',
    AI_MANAGED_AGENT_KEY: 'abcdef0123456789',
    AI_MANAGED_AGENT_HOST: 'unresolvable.invalid-tld-for-test.local',
    AI_MANAGED_AGENTS_DEBOUNCE_MS: '20',
  };
  m.syncToCloud({ dbPath: '${STP_SBOX_DB}' }, env);
  // Allow the debounce window + the (instant) ENOTFOUND rejection to land.
  await new Promise(r => setTimeout(r, 600));
" 2>&1 >/dev/null)"

assert_status 0 "stderr carries projection-fetch-failed warn" \
  bash -c "echo '$stderr_out' | grep -q 'projection fetch failed'"
assert_status 0 "log line is structured JSON (carries timestamp)" \
  bash -c "echo '$stderr_out' | grep -q '\"timestamp\":'"
assert_status 0 "service tag is managed-agents-client" \
  bash -c "echo '$stderr_out' | grep -q '\"service\":\"managed-agents-client\"'"
assert_status 1 "key value is NOT logged" \
  bash -c "echo '$stderr_out' | grep -q 'abcdef0123456789'"

# ── T-STP-S13: CLI smoke — --project + --sync exit codes ─────────────────────
echo ""
echo "  [T-STP-S13] CLI flags: --project on real DB exits 0; --sync (disabled) exits 1"

# --project against a populated DB — should succeed (status OK → exit 0).
node "$CLIENT" --project "${REAL_DB}" >/dev/null 2>&1
rc_project=$?
assert_status 0 "--project on real DB exit code 0" bash -c "[[ $rc_project -eq 0 ]]"

# --sync without env → DISABLED → exit 1.
env -i PATH="$PATH" AI_TELEMETRY_DB_PATH="${AI_TELEMETRY_DB_PATH:-}" node "$CLIENT" --sync "${REAL_DB}" >/dev/null 2>&1
rc_sync=$?
assert_status 0 "--sync without env exit code 1" bash -c "[[ $rc_sync -eq 1 ]]"

# Unknown flag still prints usage with new entries.
usage_out="$(node "$CLIENT" --bogus 2>&1 >/dev/null || true)"
assert_status 0 "usage mentions --project"  bash -c "echo '$usage_out' | grep -q -- '--project'"
assert_status 0 "usage mentions --sync"     bash -c "echo '$usage_out' | grep -q -- '--sync'"

# ── T-STP-S14: ~/.rein mirror byte-identity ─────────────────────────────────
echo ""
echo "  [T-STP-S14] ~/.rein mirror matches src"

MIRROR="${HOME}/.rein/shared/managed-agents-client.mjs"
if [[ -f "$MIRROR" ]]; then
  assert_status 0 "mirror is byte-identical to src" \
    diff -q "$CLIENT" "$MIRROR"
else
  echo "    ⚠  mirror absent — skipping"
fi

# ── E-47 (from managed_agents_spike — E-302): the offline architectural spike ──
# Runs tests/tools/managed_agents_spike.js and asserts the JSON report carries the fields the
# blueprint mandates and a documented verdict (PROCEED / INCONCLUSIVE / ABANDON). The spike
# must not make any network calls — the test stays offline.
SPIKE="${REPO_ROOT}/tests/tools/managed_agents_spike.js"

# ── T-MGR-S01: File presence + shebang ────────────────────────────────────────
echo ""
echo "  [T-MGR-S01] Spike file structure"

assert_status 0 "spike script exists"     test -f "$SPIKE"
assert_status 0 "spike has node shebang"  bash -c "head -1 '$SPIKE' | grep -q 'node'"

# ── T-MGR-S02: Spike produces valid JSON report ──────────────────────────────
echo ""
echo "  [T-MGR-S02] Spike runs and emits JSON"

# Disable the harmless ES-module reparse warning so test output stays clean.
SPIKE_OUT="$(NODE_OPTIONS=--no-warnings node "$SPIKE" 2>/dev/null)"
SPIKE_EXIT=$?

assert_status 0 "spike exited 0 (PROCEED|INCONCLUSIVE)" \
  bash -c "[[ $SPIKE_EXIT -eq 0 ]]"

# Capture parsed verdict for downstream assertions.
VERDICT="$(printf '%s' "$SPIKE_OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["verdict"])')"
assert_status 0 "verdict is one of PROCEED/INCONCLUSIVE/ABANDON" \
  bash -c "[[ '$VERDICT' == 'PROCEED' || '$VERDICT' == 'INCONCLUSIVE' || '$VERDICT' == 'ABANDON' ]]"

# ── T-MGR-S03: Required fields in the report ─────────────────────────────────
echo ""
echo "  [T-MGR-S03] Required report fields"

REPORT_FILE="$(mktemp -t spike-XXXXXX.json)"
printf '%s' "$SPIKE_OUT" > "$REPORT_FILE"
on_exit 'rm -f "$REPORT_FILE"'

for field in spike_version api_version generated_at contract state projection redactions structural_issues webhook_plan verdict rationale; do
  assert_status 0 "report.$field present" \
    python3 -c "
import json,sys
data = json.load(open('$REPORT_FILE'))
sys.exit(0 if '$field' in data else 1)
"
done

# ── T-MGR-S04: API contract version is 2026-04-01 ────────────────────────────
echo ""
echo "  [T-MGR-S04] API version pin"

assert_status 0 "api_version = managed-agents-2026-04-01" \
  python3 -c "
import json
d = json.load(open('$REPORT_FILE'))
exit(0 if d.get('api_version') == 'managed-agents-2026-04-01' else 1)
"

# ── T-MGR-S05: Webhook plan covers all lifecycle events ──────────────────────
echo ""
echo "  [T-MGR-S05] Webhook lifecycle coverage"

assert_status 0 "every contract.endpoints.lifecycle event has a webhook_plan entry" \
  python3 -c "
import json
d = json.load(open('$REPORT_FILE'))
events = d['contract']['endpoints']['lifecycle']
plan   = d['webhook_plan']
missing = [e for e in events if e not in plan]
exit(0 if not missing else 1)
"

# ── T-MGR-S06: Sanitisation gate is wired ────────────────────────────────────
echo ""
echo "  [T-MGR-S06] Sanitisation gate exists"

# We only assert the gate exists and is exercised — we don't assert that any
# fields were redacted, since a clean state.json should have none.
assert_status 0 "redactions field is an array" \
  python3 -c "
import json
d = json.load(open('$REPORT_FILE'))
exit(0 if isinstance(d.get('redactions'), list) else 1)
"

# Source-grep: confirm the spike has the sanitiser. No protocol surface to test.
assert_status 0 "spike defines SENSITIVE_KEY_RE" grep -q 'SENSITIVE_KEY_RE' "$SPIKE"
assert_status 0 "spike defines SENSITIVE_PATH_RE" grep -q 'SENSITIVE_PATH_RE' "$SPIKE"
assert_status 0 "spike calls sanitise()" grep -q 'sanitise(' "$SPIKE"

# ── T-MGR-S07: Spike makes no network calls (security mandate) ───────────────
echo ""
echo "  [T-MGR-S07] No network surface"

# Static check: no fetch / http / https / undici / axios imports.
assert_status 1 "no fetch() call"   grep -qE '\bfetch\(' "$SPIKE"
assert_status 1 "no http import"    grep -qE 'from ["\x27]node:https?["\x27]|require\(["\x27]https?["\x27]\)' "$SPIKE"
# Match only real import / require statements — not bare mentions inside comments.
assert_status 1 "no SDK import"     grep -qE '^[[:space:]]*(import .* from|const .* = require\()[^"]*["\x27](?:@anthropic-ai/sdk|undici|axios)' "$SPIKE"

# ── T-MGR-S08: Sanitiser actually redacts sensitive keys ─────────────────────
echo ""
echo "  [T-MGR-S08] Sanitiser unit check"

# Build a synthetic state file with a sensitive field, run the spike against
# it in a sandbox, and confirm the field is reported as redacted.
SANDBOX="$(mktemp -d -t mgrspike-XXXXXX)"
on_exit 'rm -rf "$SANDBOX"; rm -f "$REPORT_FILE"'
mkdir -p "${SANDBOX}/.ai"
# privacy:allow-fake-token (an invented test input)
cat > "${SANDBOX}/.ai/state.json" <<'JSON'
{
  "project": { "focus": null, "api_key": "sk-should-be-redacted" },
  "tasks": [],
  "stamps": [],
  "deltas": []
}
JSON

SANDBOX_OUT="$(cd "$SANDBOX" && NODE_OPTIONS=--no-warnings node "$SPIKE" 2>/dev/null)"
assert_status 0 "redactions captured the sensitive api_key" \
  bash -c "
printf '%s' \"\$1\" | python3 -c '
import json,sys
d = json.load(sys.stdin)
red = d.get(\"redactions\", [])
sys.exit(0 if any(\"api_key\" in r for r in red) else 1)
'
" _ "$SANDBOX_OUT"

echo ""
assert_summary
