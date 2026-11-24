#!/usr/bin/env bash
# incident_tracker_test.sh — the incident append helper (incident-tracker.md, E-65) that every
# hook's fail-open trap calls (rein_hook_incident). E-467 (D-170 r5) retired the rein-incident
# skill and the aggregator; the writer stays while the hooks' trap uses it.
#
# E-65 — verifies the incident-append.mjs helper contract:
#   • Helper rejects malformed payloads (missing field / non-JSON / wrong shape)
#   • Helper sanitises PII (HOME paths → ~, emails → [email], tokens → [token])
#   • Required-field defaults (timestamp injected, source_agent normalised)
#   • Append + rotate behaviour @ INCIDENT_ROTATE_LINES threshold
#   • AI_INCIDENT_TRACKER_DISABLE=1 short-circuits with exit 0
#   • ~/.rein mirror byte-identical

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HELPER="${REPO_ROOT}/src/shared/incident-append.mjs"
HELPER_MIRROR="${HOME}/.rein/shared/incident-append.mjs"

echo "── Suite: incident_tracker_test ─────────────────────────────────────"

# Sandbox HOME so we don't pollute the real ~/.rein/incidents.ndjson.
SBOX="$(mktemp -d -t incident-XXXXXX)"
on_exit 'rm -rf "$SBOX"'

run_helper() {
  # $1 = json arg ("" for none)
  # extra env via caller
  local arg="${1:-}"
  if [[ -z "$arg" ]]; then
    HOME="$SBOX" node "$HELPER"
  else
    HOME="$SBOX" node "$HELPER" "$arg"
  fi
}

# ── T-IN-S01: helper file exists and is well-formed ──────────────────────────
echo ""
echo "  [T-IN-S01] helper file present"

assert_status 0 "incident-append.mjs exists" \
  test -f "$HELPER"

assert_status 0 "helper has shebang for direct execution" \
  bash -c "grep < <(head -1 '$HELPER') -q '#!/usr/bin/env node'"

# ── T-IN-S02: missing arg rejected ───────────────────────────────────────────
echo ""
echo "  [T-IN-S02] missing arg → exit 1"

run_helper "" >/dev/null 2>"$SBOX/err"; rc=$?
assert_status 0 "exit code 1 when no arg" \
  bash -c "[[ '$rc' == '1' ]]"
assert_status 0 "stderr mentions missing-arg" \
  grep -q 'missing-arg' "$SBOX/err"

# ── T-IN-S03: invalid JSON rejected ──────────────────────────────────────────
echo ""
echo "  [T-IN-S03] invalid JSON → exit 1"

run_helper "not-json" >/dev/null 2>"$SBOX/err"; rc=$?
assert_status 0 "exit code 1 on invalid JSON" \
  bash -c "[[ '$rc' == '1' ]]"
assert_status 0 "stderr mentions invalid-json" \
  grep -q 'invalid-json' "$SBOX/err"

# ── T-IN-S04: missing required field rejected ────────────────────────────────
echo ""
echo "  [T-IN-S04] missing required field → exit 1"

run_helper '{"incident_type":"MCP_CRASH"}' >/dev/null 2>"$SBOX/err"; rc=$?
assert_status 0 "exit 1 when message missing" \
  bash -c "[[ '$rc' == '1' ]]"
assert_status 0 "stderr names the missing field" \
  grep -q 'message' "$SBOX/err"

# ── T-IN-S05: happy path appends a record ────────────────────────────────────
echo ""
echo "  [T-IN-S05] valid payload appends to ~/.rein/incidents.ndjson"

run_helper '{"incident_type":"MCP_CRASH","message":"hello","stack_signature":"foo.js:1","source_agent":"Claude"}' \
  > "$SBOX/out" 2>"$SBOX/err"; rc=$?
assert_status 0 "exit 0 on success" \
  bash -c "[[ '$rc' == '0' ]]"
assert_status 0 "incidents.ndjson created at sandboxed HOME" \
  test -f "$SBOX/.rein/incidents.ndjson"
assert_status 0 "appended line carries incident_type" \
  grep -q '"incident_type":"MCP_CRASH"' "$SBOX/.rein/incidents.ndjson"
assert_status 0 "appended line carries timestamp injected by helper" \
  grep -q '"timestamp":"' "$SBOX/.rein/incidents.ndjson"

# ── T-IN-S06: PII sanitisation ───────────────────────────────────────────────
echo ""
echo "  [T-IN-S06] sanitiser redacts HOME paths, emails, tokens, hex strings"

# privacy:allow-fake-token (an invented test input)
run_helper '{"incident_type":"ENV_ERROR","message":"see '"$SBOX"'/foo and admin@example.com or sk_live_abcdef0123456789abcdef","stack_signature":"deadbeefcafebabe1234567890abcdef","source_agent":"Claude"}' \
  > "$SBOX/out" 2>"$SBOX/err" || true
LAST="$(tail -n1 "$SBOX/.rein/incidents.ndjson")"

assert_status 0 "HOME path replaced with ~" \
  bash -c "grep -q '~/foo' <<< '$LAST'"
assert_status 0 "email redacted" \
  bash -c "grep -q '\[email\]' <<< '$LAST'"
assert_status 0 "sk_ token redacted" \
  bash -c "grep -q '\[token\]' <<< '$LAST'"
assert_status 0 "32-char hex stack_signature redacted" \
  bash -c "grep -q '\[hex\]' <<< '$LAST'"

# ── T-IN-S07: source_agent normalisation ────────────────────────────────────
echo ""
echo "  [T-IN-S07] unknown source_agent normalised to 'unknown'"

run_helper '{"incident_type":"X","message":"y","stack_signature":"z:1","source_agent":"BogusBot"}' \
  >/dev/null 2>"$SBOX/err" || true
assert_status 0 "BogusBot normalised to unknown" \
  bash -c "grep < <(tail -n1 '$SBOX/.rein/incidents.ndjson') -q '\"source_agent\":\"unknown\"'"

# E-255: the allow-list is Claude | Tester (the headless Claude Tester role, D-069). Pin that allowed agents are PRESERVED, so
# the BogusBot case above cannot pass merely because every agent became 'unknown'.
for _agent in Claude Tester; do
  run_helper "{\"incident_type\":\"X\",\"message\":\"y\",\"stack_signature\":\"z:1\",\"source_agent\":\"${_agent}\"}" \
    >/dev/null 2>"$SBOX/err" || true
  assert_status 0 "${_agent} preserved (not normalised to unknown)" \
    bash -c "grep < <(tail -n1 '$SBOX/.rein/incidents.ndjson') -q '\"source_agent\":\"${_agent}\"'"
done

# ── T-IN-S08: rotation threshold ─────────────────────────────────────────────
echo ""
echo "  [T-IN-S08] rotation moves the active log to a monthly archive"

# Reset HOME and lower threshold to make the test fast.
SBOX2="$(mktemp -d -t incident-rot-XXXXXX)"
ACTIVE="$SBOX2/.rein/incidents.ndjson"

# Seed 5 records to the threshold of 5
for i in 1 2 3 4 5; do
  HOME="$SBOX2" INCIDENT_ROTATE_LINES=5 node "$HELPER" \
    "{\"incident_type\":\"X\",\"message\":\"m${i}\",\"stack_signature\":\"sig:${i}\"}" >/dev/null 2>&1
done

# 6th call should rotate (line count >= threshold) before appending.
HOME="$SBOX2" INCIDENT_ROTATE_LINES=5 node "$HELPER" \
  '{"incident_type":"X","message":"m6","stack_signature":"sig:6"}' >/dev/null 2>&1

YM="$(date -u +%Y-%m)"
ARCHIVE="$SBOX2/.rein/incidents-${YM}.ndjson.archive"
assert_status 0 "monthly archive created on rotation" \
  test -f "$ARCHIVE"
assert_status 0 "active log retains only the post-rotation lines" \
  bash -c "[[ \"\$(wc -l < '$ACTIVE' | tr -d ' ')\" == '1' ]]"
assert_status 0 "archive contains the pre-rotation lines" \
  bash -c "[[ \"\$(wc -l < '$ARCHIVE' | tr -d ' ')\" -ge '5' ]]"
rm -rf "$SBOX2"

# ── T-IN-S09: AI_INCIDENT_TRACKER_DISABLE=1 short-circuits ──────────────────
echo ""
echo "  [T-IN-S09] disable flag exits 0 without writing"

SBOX3="$(mktemp -d -t incident-disable-XXXXXX)"
HOME="$SBOX3" AI_INCIDENT_TRACKER_DISABLE=1 node "$HELPER" \
  '{"incident_type":"X","message":"y","stack_signature":"z:1"}' >/dev/null 2>"$SBOX3/err"; rc=$?
assert_status 0 "exit 0 (fail-open)" \
  bash -c "[[ '$rc' == '0' ]]"
assert_status 0 "no incidents.ndjson created" \
  bash -c "[[ ! -f '$SBOX3/.rein/incidents.ndjson' ]]"
assert_status 0 "warning emitted to stderr" \
  grep -q 'AI_INCIDENT_TRACKER_DISABLE' "$SBOX3/err"
rm -rf "$SBOX3"

# ── T-IN-S11: ~/.rein mirrors ──────────────────────────────────────────────
echo ""
echo "  [T-IN-S11] ~/.rein mirrors are byte-identical"

if [[ -f "$HELPER_MIRROR" ]]; then
  assert_status 0 "helper mirror identical to src" \
    cmp -s "$HELPER" "$HELPER_MIRROR"
fi


assert_summary
