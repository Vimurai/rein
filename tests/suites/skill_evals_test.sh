#!/usr/bin/env bash
# skill_evals_test.sh — behavioural evals of the core skills through `claude plugin eval`
# (E-285, D-075, native-first.md §8). New suite: nothing else observes a skill's BEHAVIOUR
# (which tools a model calls, in what order); the structural checks of the same skills live
# in skill_lines_test and friends and are not repeated here.
#
# Two layers:
#   1. static — the plugin manifest and the eval tree are well-formed. Needs only node.
#   2. live   — run the four cases (ai-preflight, ai-task, ai-handoff, task-planner) against
#               the real model, every grader must pass. Needs an AUTHENTICATED `claude` on
#               PATH; anything less is a recorded SKIP (E-236), never a fabricated result.
#               Under `rein ci run` the HOME is a throwaway, so `claude` is never logged in
#               there and this layer always SKIPs: `rein ci evals` runs it under the real HOME.
#
# REIN_SKILL_EVAL_REPORT=<path.json>  where the live layer writes the JSON report (default:
#                                      a per-run temp path — rule 6, nothing under ~/.rein/)
# REIN_SKILL_EVAL_RUNS=<n>            runs per case (default 2, the acceptance count)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MANIFEST="${REPO_ROOT}/.claude-plugin/plugin.json"
EVALS="${REPO_ROOT}/evals"
CASES=(ai-preflight ai-task ai-handoff task-planner)

echo "── Suite: skill_evals_test ──────────────────────────────────────────"

# ── 1. static: manifest + eval tree ───────────────────────────────────────────
echo "  [skill-evals.static] manifest and cases are well-formed"
assert_exists "$MANIFEST"
assert_status 0 "plugin.json parses and names the provisioned skill dir" node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (m.name !== "rein" || !(m.skills || []).includes("./.claude/skills/")) process.exit(1);
' "$MANIFEST"
for c in "${CASES[@]}"; do
  assert_exists "${EVALS}/${c}/case.yaml"
  assert_exists "${REPO_ROOT}/.claude/skills/${c}/SKILL.md"
  n="$(find "${EVALS}/${c}/graders" -name '*.md' -type f 2>/dev/null | wc -l | tr -d ' ')"
  assert_status 0 "${c}: at least two graders (found ${n})" test "$n" -ge 2
  assert_contains "${c}: scaffold seeds the shared fixture" "fixtures/rein-project.sh" "$(cat "${EVALS}/${c}/scaffold.sh")"
done
assert_status 0 "fixture scaffold is valid bash" bash -n "${EVALS}/fixtures/rein-project.sh"
# The preflight case's never-reads-architect grader only means something if the sentinel
# it would see is really in the fixture's architect.md.
assert_contains "fixture architect.md carries the sentinel" "ARCHITECT_SENTINEL_7f3a" "$(cat "${EVALS}/fixtures/rein-project.sh")"

# ── 2. live: the four cases against the model ─────────────────────────────────
echo "  [skill-evals.live] 4 cases × ${REIN_SKILL_EVAL_RUNS:-2} runs, every grader passes"
if skip_unless_cmd claude "live skill evals"; then
  if ! claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
    _skip "live skill evals — claude is not authenticated on this host (HOME=${HOME})"
  else
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/rein-skill-evals.XXXXXX")"
    on_exit "rm -rf '${tmp}'"
    report="${REIN_SKILL_EVAL_REPORT:-${tmp}/report.json}"
    rc=0
    ( cd "$REPO_ROOT" && claude plugin eval . \
        --trust-plugin --scaffold --ablation none --no-publish \
        --runs "${REIN_SKILL_EVAL_RUNS:-2}" --threshold 1 \
        --allow-tools Edit Write Bash ToolSearch ListAgents SendMessage \
        --output-dir "${tmp}/out" --json "$report" ) > "${tmp}/eval.log" 2>&1 || rc=$?
    if [[ "$rc" -ne 0 ]]; then sed 's/^/    | /' "${tmp}/eval.log" | tail -40; fi
    assert_status 0 "claude plugin eval: all cases at threshold 1.0 (exit ${rc})" test "$rc" -eq 0
    assert_exists "$report"
    echo "  ⓘ skill eval report: ${report}"
  fi
fi

assert_summary
