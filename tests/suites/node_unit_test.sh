#!/usr/bin/env bash
# node_unit_test.sh — bridge the node:test unit layer into the master runner (E-206)
#
# Runs every tests/unit/*.test.mjs file through Node's built-in test runner and
# reflects its TAP pass/fail tally into the bash harness counters so the unit
# suites contribute to the aggregate `tests/run.sh` result. No new dependency —
# the runner and coverage are built into Node 22+.
#
# Env:
#   UNIT_COVERAGE=1   also print Node's built-in line/branch/func coverage table
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
UNIT_DIR="${REPO_ROOT}/tests/unit"

echo "── Suite: node_unit (node:test) ─────────────────────────────────────"

# Nothing to run is a pass, not a failure (keeps a fresh checkout green).
if ! ls "${UNIT_DIR}"/*.test.mjs >/dev/null 2>&1; then
  _pass "no node:test unit files present (skipped)"
  assert_summary
  exit 0
fi

cov_flag=""
[ "${UNIT_COVERAGE:-0}" = "1" ] && cov_flag="--experimental-test-coverage"

# Run from the repo root so the relative imports inside the .mjs files resolve.
out="$(cd "${REPO_ROOT}" && node --test ${cov_flag} --test-reporter=tap tests/unit/*.test.mjs 2>&1)"
node_exit=$?

# Pull the machine-readable tallies from the TAP epilogue.
pass="$(printf '%s\n' "$out" | grep -E '^# pass '  | grep -oE '[0-9]+' | tail -1)"
fail="$(printf '%s\n' "$out" | grep -E '^# fail '  | grep -oE '[0-9]+' | tail -1)"
pass="${pass:-0}"; fail="${fail:-0}"

# Reflect Node's tally into the assert.sh counters that assert_summary reports.
PASS_COUNT="$pass"
FAIL_COUNT="$fail"

# Print status lines directly — do NOT use _pass/_fail here, they would increment
# the counters on top of the authoritative Node tally set above.
if [ "$fail" -ne 0 ]; then
  # Surface each failing point for the runner's inline output.
  printf '%s\n' "$out" | grep -E '^not ok ' | sed 's/^not ok [0-9]* - /  ✗ /'
elif [ "$node_exit" -ne 0 ]; then
  # Node crashed before/around the run (import error, bad flag) with no countable
  # failure — book exactly one so the master runner flags the suite.
  FAIL_COUNT=1
  printf "  ✗ node:test runner exited %s with no TAP failures (harness/import error)\n" "$node_exit"
  printf '%s\n' "$out" | grep -iE 'error|cannot|throw' | head -5 | sed 's/^/    /'
else
  printf "  ✓ node:test unit suites — %s assertions across tests/unit/*.test.mjs\n" "$pass"
fi

[ "${UNIT_COVERAGE:-0}" = "1" ] && printf '%s\n' "$out" | sed -n '/start of coverage report/,/end of coverage report/p'

assert_summary
[ "$FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
