#!/usr/bin/env bash
# incident_tracker_test.sh — the incident tracker (incident-tracker.md): the append helper and
# ai-incident skill (E-65), and the aggregator plus its ai-preflight wiring (E-66, E-67, from
# incident_aggregator — E-302).
#
# E-65 — verifies the incident-append.mjs helper + ai-incident skill contract:
#   • Helper rejects malformed payloads (missing field / non-JSON / wrong shape)
#   • Helper sanitises PII (HOME paths → ~, emails → [email], tokens → [token])
#   • Required-field defaults (timestamp injected, source_agent normalised)
#   • Append + rotate behaviour @ INCIDENT_ROTATE_LINES threshold
#   • AI_INCIDENT_TRACKER_DISABLE=1 short-circuits with exit 0
#   • Skill SKILL.md frontmatter + invocation contract intact
#   • ~/.rein mirror byte-identical

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HELPER="${REPO_ROOT}/src/shared/incident-append.mjs"
SKILL="${REPO_ROOT}/src/shared/skills/ai-incident/SKILL.md"
SKILL_MIRROR="${HOME}/.rein/shared/skills/ai-incident/SKILL.md"
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
  bash -c "head -1 '$HELPER' | grep -q '#!/usr/bin/env node'"

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
  bash -c "echo '$LAST' | grep -q '~/foo'"
assert_status 0 "email redacted" \
  bash -c "echo '$LAST' | grep -q '\[email\]'"
assert_status 0 "sk_ token redacted" \
  bash -c "echo '$LAST' | grep -q '\[token\]'"
assert_status 0 "32-char hex stack_signature redacted" \
  bash -c "echo '$LAST' | grep -q '\[hex\]'"

# ── T-IN-S07: source_agent normalisation ────────────────────────────────────
echo ""
echo "  [T-IN-S07] unknown source_agent normalised to 'unknown'"

run_helper '{"incident_type":"X","message":"y","stack_signature":"z:1","source_agent":"BogusBot"}' \
  >/dev/null 2>"$SBOX/err" || true
assert_status 0 "BogusBot normalised to unknown" \
  bash -c "tail -n1 '$SBOX/.rein/incidents.ndjson' | grep -q '\"source_agent\":\"unknown\"'"

# E-255: the allow-list is Claude | Tester (the headless Claude Tester role, D-069). Pin that allowed agents are PRESERVED, so
# the BogusBot case above cannot pass merely because every agent became 'unknown'.
for _agent in Claude Tester; do
  run_helper "{\"incident_type\":\"X\",\"message\":\"y\",\"stack_signature\":\"z:1\",\"source_agent\":\"${_agent}\"}" \
    >/dev/null 2>"$SBOX/err" || true
  assert_status 0 "${_agent} preserved (not normalised to unknown)" \
    bash -c "tail -n1 '$SBOX/.rein/incidents.ndjson' | grep -q '\"source_agent\":\"${_agent}\"'"
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

# ── T-IN-S10: skill contract ────────────────────────────────────────────────
echo ""
echo "  [T-IN-S10] ai-incident SKILL.md publishes the contract"

assert_status 0 "skill file exists" \
  test -f "$SKILL"
assert_status 0 "frontmatter has name: ai-incident" \
  grep -q '^name: ai-incident' "$SKILL"
assert_status 0 "skill names the NDJSON path" \
  grep -q 'incidents.ndjson' "$SKILL"
assert_status 0 "skill enumerates incident_type values" \
  grep -q 'MCP_CRASH' "$SKILL"
assert_status 0 "skill calls out sanitisation contract" \
  grep -q 'Sanitisation contract' "$SKILL"
assert_status 0 "skill documents disable flag" \
  grep -q 'AI_INCIDENT_TRACKER_DISABLE' "$SKILL"

# ── T-IN-S11: ~/.rein mirrors ──────────────────────────────────────────────
echo ""
echo "  [T-IN-S11] ~/.rein mirrors are byte-identical"

if [[ -f "$SKILL_MIRROR" ]]; then
  assert_status 0 "skill mirror identical to src" \
    cmp -s "$SKILL" "$SKILL_MIRROR"
fi
if [[ -f "$HELPER_MIRROR" ]]; then
  assert_status 0 "helper mirror identical to src" \
    cmp -s "$HELPER" "$HELPER_MIRROR"
fi


# ── E-66 / E-67 (from incident_aggregator — E-302): the aggregator and its preflight wiring ──
# Tests for E-66 + E-67.
#
# E-66: incident-aggregate.mjs reads ~/.rein/incidents.ndjson, groups by
#       stack_signature, surfaces THRESHOLD_REACHED at >=3 occurrences.
# E-67: ai-preflight SKILL.md wires the aggregator and emits the
#       [INCIDENT_THRESHOLD_REACHED] context block when the threshold trips.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AGGR="${REPO_ROOT}/src/shared/incident-aggregate.mjs"
APPEND="${REPO_ROOT}/src/shared/incident-append.mjs"
PREFLIGHT_SKILL="${REPO_ROOT}/src/shared/skills/ai-preflight/SKILL.md"
PREFLIGHT_SKILL_MIRROR="${HOME}/.rein/shared/skills/ai-preflight/SKILL.md"
AGGR_MIRROR="${HOME}/.rein/shared/incident-aggregate.mjs"


AGG_SBOX="$(mktemp -d -t aggr-XXXXXX)"
on_exit 'rm -rf "$AGG_SBOX"'

run_aggr() {
  HOME="$AGG_SBOX" node "$AGGR"
}

run_append() {
  HOME="$AGG_SBOX" node "$APPEND" "$1" >/dev/null 2>&1 || true
}

# ── T-AG-S01: helper exists ──────────────────────────────────────────────────
echo ""
echo "  [T-AG-S01] aggregator file present"

assert_status 0 "incident-aggregate.mjs exists" \
  test -f "$AGGR"

# ── T-AG-S02: NO_INCIDENTS when log absent ──────────────────────────────────
echo ""
echo "  [T-AG-S02] missing log → status NO_INCIDENTS"

OUT="$(run_aggr)"
assert_status 0 "status NO_INCIDENTS reported" \
  bash -c "echo '$OUT' | grep -q '\"status\": \"NO_INCIDENTS\"'"

# ── T-AG-S03: DISABLED short-circuit ─────────────────────────────────────────
echo ""
echo "  [T-AG-S03] AI_INCIDENT_TRACKER_DISABLE=1 → status DISABLED"

OUT="$(HOME="$AGG_SBOX" AI_INCIDENT_TRACKER_DISABLE=1 node "$AGGR")"
assert_status 0 "status DISABLED reported" \
  bash -c "echo '$OUT' | grep -q '\"status\": \"DISABLED\"'"

# ── T-AG-S04: OK when below threshold ────────────────────────────────────────
echo ""
echo "  [T-AG-S04] count < threshold → status OK"

run_append '{"incident_type":"X","message":"first","stack_signature":"foo:1"}'
run_append '{"incident_type":"X","message":"second","stack_signature":"foo:1"}'
OUT="$(run_aggr)"
assert_status 0 "status OK when distinct sig has count=2" \
  bash -c "echo '$OUT' | grep -q '\"status\": \"OK\"'"
assert_status 0 "total_incidents reflects appended rows" \
  bash -c "echo '$OUT' | grep -q '\"total_incidents\": 2'"

# ── T-AG-S05: THRESHOLD_REACHED at 3 occurrences ────────────────────────────
echo ""
echo "  [T-AG-S05] count >= threshold trips THRESHOLD_REACHED"

run_append '{"incident_type":"X","message":"third","stack_signature":"foo:1"}'
OUT="$(run_aggr)"
assert_status 0 "status THRESHOLD_REACHED at count=3" \
  bash -c "echo '$OUT' | grep -q '\"status\": \"THRESHOLD_REACHED\"'"
assert_status 0 "stack_signature foo:1 listed in groups" \
  bash -c "echo '$OUT' | grep -q '\"stack_signature\": \"foo:1\"'"
assert_status 0 "threshold_reached: true on the offending group" \
  bash -c "echo '$OUT' | grep -q '\"threshold_reached\": true'"

# ── T-AG-S06: distinct signatures grouped independently ─────────────────────
echo ""
echo "  [T-AG-S06] distinct signatures counted independently"

run_append '{"incident_type":"Y","message":"alt","stack_signature":"bar:42"}'
OUT="$(run_aggr)"
assert_status 0 "two distinct signatures reported" \
  bash -c "echo '$OUT' | grep -q '\"distinct_signatures\": 2'"
assert_status 0 "bar:42 still below threshold" \
  bash -c "echo '$OUT' | python3 -c \"import json,sys; d=json.load(sys.stdin); print([g for g in d['groups'] if g['stack_signature']=='bar:42'][0]['threshold_reached'])\" | grep -qx False"

# ── T-AG-S07: malformed lines skipped ────────────────────────────────────────
echo ""
echo "  [T-AG-S07] malformed NDJSON lines are skipped, not fatal"

echo "{not-json" >> "$AGG_SBOX/.rein/incidents.ndjson"
echo ""        >> "$AGG_SBOX/.rein/incidents.ndjson"
OUT="$(run_aggr)"
assert_status 0 "aggregator still returns valid JSON" \
  bash -c "echo '$OUT' | python3 -c 'import json,sys; json.loads(sys.stdin.read())'"

# ── T-AG-S08: budget — under 200ms even with 100 records ────────────────────
echo ""
echo "  [T-AG-S08] aggregator stays inside reasonable budget on a populated log"

# Seed 100 fresh records into a clean sandbox so the timing is meaningful.
AGG_SBOX2="$(mktemp -d -t aggr-bench-XXXXXX)"
for i in $(seq 1 100); do
  HOME="$AGG_SBOX2" node "$APPEND" \
    "{\"incident_type\":\"X\",\"message\":\"m${i}\",\"stack_signature\":\"sig:${i}\"}" >/dev/null 2>&1
done
START_NS=$(python3 -c 'import time; print(time.time_ns())')
HOME="$AGG_SBOX2" node "$AGGR" >/dev/null
END_NS=$(python3 -c 'import time; print(time.time_ns())')
ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
# E-239 (D-062 §2): host-relative. The work here is ONE `node` spawn reading a 100-record
# log, so the cost the code cannot avoid is a bare node spawn on this same host — that is
# the baseline. The absolute 200ms is still enforced on CI, where the hardware is known.
#
# This assertion is why the rule exists: it measured 381ms on a developer laptop while
# passing on CI, and then passed on the SAME laptop once 54 leaked tmux servers and a
# wedged download were cleared. It was tracking machine load, not the aggregator.
assert_perf "aggregator on a 100-record log" "$ELAPSED_MS" 200 "$(perf_baseline_node)"
rm -rf "$AGG_SBOX2"

# ── T-AG-S09: ai-preflight SKILL.md wires the aggregator (E-67) ─────────────
echo ""
echo "  [T-AG-S09] ai-preflight skill consumes the aggregator"

assert_status 0 "skill names incident-aggregate.mjs in locator chain" \
  grep -q 'incident-aggregate.mjs' "$PREFLIGHT_SKILL"

assert_status 0 "skill names ${HOME}/.rein/shared mirror" \
  grep -q 'shared/incident-aggregate.mjs' "$PREFLIGHT_SKILL"

assert_status 0 "skill emits [INCIDENT_THRESHOLD_REACHED] context block" \
  grep -q '\[INCIDENT_THRESHOLD_REACHED\]' "$PREFLIGHT_SKILL"

assert_status 0 "skill adds Bash to allowed-tools (needed for node invocation)" \
  grep -qE '^allowed-tools:.*Bash' "$PREFLIGHT_SKILL"

assert_status 0 "skill defers blueprint drafting to Architect (anti-drift §35)" \
  grep -q 'Architect' "$PREFLIGHT_SKILL"

assert_status 0 "skill documents AI_INCIDENT_TRACKER_DISABLE rollback" \
  grep -q 'AI_INCIDENT_TRACKER_DISABLE' "$PREFLIGHT_SKILL"

# ── T-AG-S10: ~/.rein mirrors byte-identical ───────────────────────────────
echo ""
echo "  [T-AG-S10] ~/.rein/ mirrors track src/ verbatim"

if [[ -f "$PREFLIGHT_SKILL_MIRROR" ]]; then
  assert_status 0 "ai-preflight skill mirror identical" \
    cmp -s "$PREFLIGHT_SKILL" "$PREFLIGHT_SKILL_MIRROR"
fi
if [[ -f "$AGGR_MIRROR" ]]; then
  assert_status 0 "incident-aggregate.mjs mirror identical" \
    cmp -s "$AGGR" "$AGGR_MIRROR"
fi

assert_summary
