#!/usr/bin/env bash
# meta_cognition_test.sh — the meta-cognition pipeline's agent, skill and probe surfaces
# (meta-cognition.md, ecc-integrations.md): the meta_analyst agent + ai-insights skill (E-85);
# the insights-staleness CLI and its ai-preflight Step 7 wiring (E-86, from insights_staleness);
# the meta_analyst Instinct-Extraction (E-93, from instinct_stager) and promotion (E-94, from
# skill_promoter) contracts. Merged in E-302; the pure stager, promoter and probe rows are
# tests/unit/{instinct-stager,skill-promoter,insights-staleness}.test.mjs.
#
# E-85:
# Verifies the contract demanded by .ai/blueprints/meta-cognition.md §Components
# 2 + 3:
#
#   • src/claude/agents/meta_analyst.md — restricted toolset, read-only over
#     telemetry, write-only over INSIGHTS.md, SQL-aggregates-only contract.
#   • Anti-drift: no source-code edits, no add_task, no proxy_call.
#   • Cross-reference with E-84 telemetry helper (locator chain).
#   • src/shared/skills/ai-insights/SKILL.md — single trigger surface,
#     delegates to meta_analyst, never queries the DB directly.
#   • Frontmatter parses cleanly (description quoted — colon-parse guard
#     mirrors E-49 / E-65 / E-77 / E-78).
#   • Mirrors byte-identical to .claude/ + ~/.rein/.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"


REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AGENT_SRC="${REPO_ROOT}/src/claude/agents/meta_analyst.md"
AGENT_CLAUDE="${REPO_ROOT}/.claude/agents/meta_analyst.md"
AGENT_MIRROR="${HOME}/.rein/claude/agents/meta_analyst.md"
SKILL_SRC="${REPO_ROOT}/src/shared/skills/ai-insights/SKILL.md"
SKILL_CLAUDE="${REPO_ROOT}/.claude/skills/ai-insights/SKILL.md"
SKILL_MIRROR="${HOME}/.rein/shared/skills/ai-insights/SKILL.md"
BLUEPRINT="${REPO_ROOT}/.ai/blueprints/meta-cognition.md"
TELEMETRY="${REPO_ROOT}/src/shared/telemetry.mjs"

echo "── Suite: meta_cognition_test ───────────────────────────────────────"

# ── T-META-S01: meta_analyst frontmatter ──────────────────────────────────────
echo ""
echo "  [T-META-S01] meta_analyst.md frontmatter parses cleanly"

assert_status 0 "src/ agent file exists"             test -f "$AGENT_SRC"
assert_status 0 "frontmatter opens on line 1"        bash -c "head -1 '$AGENT_SRC' | grep -q '^---$'"
assert_status 0 "name: meta_analyst"                 grep -q '^name: meta_analyst$' "$AGENT_SRC"
assert_status 0 "description double-quoted (no colon-parse trap)" \
  bash -c "head -10 '$AGENT_SRC' | grep -q '^description: \"'"
assert_status 0 "description names blueprint"        \
  grep -q 'meta-cognition\.md' "$AGENT_SRC"
assert_status 0 "description names E-85"             \
  grep -q 'E-85' "$AGENT_SRC"
assert_status 0 "instinct proposals staged as Claude skills under .claude/skills/proposed (E-254)" \
  grep -q 'PROPOSED Claude skills (staged under .claude/skills/proposed)' "$AGENT_SRC"

# YAML closes on second --- (between line 2 and 12).
assert_status 0 "frontmatter terminates within first 10 lines" \
  bash -c "head -10 '$AGENT_SRC' | awk '/^---$/{c++} END{exit c<2}'"

# ── T-META-S02: anti-drift Forbidden block ────────────────────────────────────
echo ""
echo "  [T-META-S02] anti-drift forbidden block names code/aggregate/scope rules"

assert_status 0 "Forbidden section present"          grep -q '^## Forbidden' "$AGENT_SRC"
assert_status 0 "forbids source-code generation"     \
  grep -qiE 'do NOT write source code' "$AGENT_SRC"
assert_status 0 "forbids SELECT * — aggregates only" \
  grep -qE 'SELECT \*' "$AGENT_SRC"
assert_status 0 "writes only ~/.rein/INSIGHTS.md"   \
  grep -qE '~/\.rein/INSIGHTS\.md' "$AGENT_SRC"
assert_status 0 "names blueprint §Execution Constraints contract" \
  grep -qE 'Execution Constraints' "$AGENT_SRC"

# Defence-in-depth: no add_task / no proxy_call statements
assert_status 0 "no add_task surface in agent contract" \
  bash -c "! grep -qE '\\<add_task\\>' '$AGENT_SRC' || grep -qE 'Not a task planner|does NOT call .add_task.' '$AGENT_SRC'"

# ── T-META-S03: five canonical SQL aggregates present ─────────────────────────
echo ""
echo "  [T-META-S03] five canonical aggregates per blueprint §API/Read"

assert_status 0 "Aggregate A — error hotspots"       grep -qE -e '-- A\. Tool-error hotspots' "$AGENT_SRC"
assert_status 0 "Aggregate B — latency outliers"     grep -qE -e '-- B\. Latency outliers'    "$AGENT_SRC"
assert_status 0 "Aggregate C — frequency cohort"     grep -qE -e '-- C\. Tool-frequency'      "$AGENT_SRC"
assert_status 0 "Aggregate D — cross-project breadth" grep -qE -e '-- D\. Cross-project'       "$AGENT_SRC"
assert_status 0 "Aggregate E — task velocity"        grep -qE -e '-- E\. Task velocity'       "$AGENT_SRC"
assert_status 0 "Aggregate F — usage-friction (E-180)" grep -qE -e '-- F\. Usage-friction'    "$AGENT_SRC"

# Each query has a hard LIMIT — bounded result set per blueprint §Token Limits.
LIMIT_COUNT="$(grep -cE '^LIMIT [0-9]+;' "$AGENT_SRC")"
assert_status 0 "every aggregate carries a LIMIT clause (5+)" \
  bash -c "[[ $LIMIT_COUNT -ge 5 ]]"

# 30-day window per Step 2 default. E-261 (D-070 §5): the bound is written in the stored
# ISO-8601 'T' form. datetime() yields '2026-09-01 12:00:00' and the rows hold
# '2026-09-01T12:00:00.000Z'; compared as TEXT, ' ' < 'T' puts every row of the boundary day
# inside the window, so the window drifted by up to a day.
assert_status 0 "30-day window in queries" \
  grep -qF "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')" "$AGENT_SRC"
assert_status 1 "E-261: no space-form datetime() bound is left in the aggregates" \
  grep -qE "datetime\('now'" "$AGENT_SRC"
assert_status 0 "E-261: latency outliers group by source (hook vs interceptor)" \
  grep -qE "^GROUP BY tool_name, source$" "$AGENT_SRC"

# Three recommendation classes per Step 3.
assert_status 0 "CLI automation candidate class"     grep -qE 'CLI automation candidate'    "$AGENT_SRC"
assert_status 0 "Tool deprecation candidate class"   grep -qE 'Tool deprecation candidate'  "$AGENT_SRC"
assert_status 0 "Usage-friction candidate class (E-180)" grep -qE 'Usage-friction candidate' "$AGENT_SRC"
assert_status 0 "Latency hardening candidate class"  grep -qE 'Latency hardening candidate' "$AGENT_SRC"
# E-180: REJECTED is a distinct, recognised status in the analysis SQL (not folded into ERROR/SUCCESS).
assert_status 0 "REJECTED status referenced in aggregates" grep -qE "status = 'REJECTED'" "$AGENT_SRC"

# Empty / steady fast-path sentinel.
assert_status 0 "[INSIGHTS_EMPTY] sentinel"          grep -qE '\[INSIGHTS_EMPTY\]'   "$AGENT_SRC"
assert_status 0 "[INSIGHTS_STABLE] sentinel"         grep -qE '\[INSIGHTS_STABLE\]'  "$AGENT_SRC"
assert_status 0 "[INSIGHTS_PAUSED] sentinel"         grep -qE '\[INSIGHTS_PAUSED\]'  "$AGENT_SRC"

# ── T-META-S04: stamp wiring + restricted toolset ─────────────────────────────
echo ""
echo "  [T-META-S04] agent stamps via task-synchronizer-mcp::add_stamp"

assert_status 0 "names INSIGHTS_GENERATED stamp type" grep -q 'INSIGHTS_GENERATED' "$AGENT_SRC"
assert_status 0 "stamps via task-synchronizer-mcp::add_stamp" \
  grep -qE 'task-synchronizer-mcp::add_stamp' "$AGENT_SRC"
assert_status 0 "restricted toolset declared"        grep -qE 'restricted toolset' "$AGENT_SRC"
assert_status 0 "no proxy_call surface in agent"     \
  bash -c "! grep -qE 'proxy_call' '$AGENT_SRC' || grep -qE 'No proxy_call' '$AGENT_SRC'"

# ── T-META-S05: locator chain references E-84 telemetry helper ────────────────
echo ""
echo "  [T-META-S05] meta_analyst references telemetry.mjs locator chain"

assert_status 0 "names telemetry.mjs by path"        grep -qE 'src/shared/telemetry\.mjs' "$AGENT_SRC"
assert_status 0 "installed mirror in locator chain"  \
  grep -qE '~/\.rein/shared/telemetry\.mjs' "$AGENT_SRC"
assert_status 0 "uses getTelemetryStats helper"      grep -qE 'getTelemetryStats' "$AGENT_SRC"

# ── T-META-S06: ai-insights skill frontmatter ─────────────────────────────────
echo ""
echo "  [T-META-S06] ai-insights skill frontmatter parses cleanly"

assert_status 0 "src/ skill file exists"             test -f "$SKILL_SRC"
assert_status 0 "name: ai-insights"                  grep -q '^name: ai-insights$' "$SKILL_SRC"
assert_status 0 "description double-quoted"          \
  bash -c "head -10 '$SKILL_SRC' | grep -q '^description: \"'"
assert_status 0 "user-invocable: true"               grep -q '^user-invocable: true$' "$SKILL_SRC"
assert_status 0 "agent: meta_analyst declared"       grep -q '^agent: meta_analyst$' "$SKILL_SRC"
assert_status 0 "allowed-tools includes Bash"        grep -qE '^allowed-tools:.*Bash' "$SKILL_SRC"
assert_status 0 "allowed-tools includes add_stamp"   grep -qE 'add_stamp' "$SKILL_SRC"

# Frontmatter closes within first 12 lines.
assert_status 0 "frontmatter terminates within first 12 lines" \
  bash -c "head -12 '$SKILL_SRC' | awk '/^---$/{c++} END{exit c<2}'"

# ── T-META-S07: skill delegates to meta_analyst, does NOT query DB itself ─────
echo ""
echo "  [T-META-S07] skill delegates to meta_analyst (no direct DB queries)"

assert_status 0 "skill runs meta_analyst with the Agent tool (E-276)" \
  grep -qE 'subagent_type: "meta_analyst"' "$SKILL_SRC"

# Skill must NOT contain raw SQL — that is the agent's job.
assert_status 1 "skill carries no raw SELECT statements" \
  grep -qE 'SELECT ' "$SKILL_SRC"

# Locator chain for the telemetry helper smoke check.
assert_status 0 "skill references telemetry.mjs locator chain" \
  grep -qE 'src/shared/telemetry\.mjs' "$SKILL_SRC"
# E-225: the skill no longer spells the mirror path itself — it asks the resolver, which
# is install-first by policy. Same INTENT (the installed helper is reachable), asserted
# where the code now decides it.
assert_status 0 "skill resolves telemetry via the shared install-first locator" \
  grep -q 'rein_locate shared/telemetry.mjs' "$SKILL_SRC"

# Skill respects AI_TELEMETRY_DISABLE rollback wiring.
assert_status 0 "skill documents AI_TELEMETRY_DISABLE rollback" \
  grep -qE 'AI_TELEMETRY_DISABLE' "$SKILL_SRC"

# Stamp re-emission rule (skill only re-stamps if agent failed).
assert_status 0 "skill documents add_stamp re-emit rule" \
  grep -qE 're-emit' "$SKILL_SRC"

# ── T-META-S08: blueprint cross-reference ─────────────────────────────────────
echo ""
echo "  [T-META-S08] blueprint exists + meta-cognition.md cross-ref"

assert_status 0 "blueprint exists" test -f "$BLUEPRINT"
assert_status 0 "blueprint names meta_analyst"       grep -qE 'meta_analyst' "$BLUEPRINT"
assert_status 0 "blueprint names ai insights / ai-insights" \
  bash -c "grep -qE 'ai-insights|ai insights' '$BLUEPRINT'"
assert_status 0 "blueprint names INSIGHTS.md"        grep -qE 'INSIGHTS\.md' "$BLUEPRINT"

# Telemetry helper must exist (E-84 prereq).
assert_status 0 "E-84 telemetry helper exists"       test -f "$TELEMETRY"

# ── T-META-S09: telemetry tooling smoke ───────────────────────────────────────
echo ""
echo "  [T-META-S09] telemetry --path / --stats smoke (used by skill Step 1)"

# E-257: the harness redirects telemetry with AI_TELEMETRY_DB_PATH, so the DEFAULT is
# checked with the override removed — and the override itself is checked beside it.
PATHOUT="$(env -u AI_TELEMETRY_DB_PATH node "$TELEMETRY" --path)"
assert_contains "telemetry --path emits expected suffix" ".rein/telemetry.sqlite" "$PATHOUT"
_PROBE="$(cd "${TMPDIR:-/tmp}" && pwd -P)/rein-e257-probe.sqlite"   # overrides live under the temp dir
PATHOVR="$(AI_TELEMETRY_DB_PATH="$_PROBE" node "$TELEMETRY" --path 2>/dev/null)"
assert_contains "telemetry --path honours AI_TELEMETRY_DB_PATH (E-257)" "$_PROBE" "$PATHOVR"

STATS="$(node "$TELEMETRY" --stats)"
assert_contains "telemetry --stats emits status key" "\"status\":" "$STATS"

# ── T-META-S10: mirrors byte-identical ────────────────────────────────────────
echo ""
echo "  [T-META-S10] mirrors byte-identical"

assert_status 0 "meta_analyst → .claude mirror"    diff -q "$AGENT_SRC" "$AGENT_CLAUDE"
# E-248 (D-067 §2): the installed copy is canonical — byte identity, and the three
# Claude agent-contract keys PRESENT.
# E-236 (D-061 §4): the INSTALL is genuinely optional — a clone with no `ai install` has
# no ~/.rein to compare against. Asserting unconditionally made the verdict depend on
# whether this machine happened to be installed, which is the pattern this sprint kept
# removing. Absent install → SKIP, counted separately; never a fabricated pass.
if [[ -f "$AGENT_MIRROR" ]]; then
  assert_status 0 "meta_analyst → ~/.rein copy is byte-identical to src/" \
    diff -q "$AGENT_SRC" "$AGENT_MIRROR"
  assert_status 0 "meta_analyst → ~/.rein copy KEEPS the Claude-only keys (E-248)" \
    grep -qE '^(disable-model-invocation|user-invocable|allowed-tools):' "$AGENT_MIRROR"
else
  _skip "meta_analyst → ~/.rein copy comparison (framework not installed)"
  _skip "meta_analyst → ~/.rein Claude-key check (framework not installed)"
fi
assert_status 0 "ai-insights  → .claude mirror"     diff -q "$SKILL_SRC" "$SKILL_CLAUDE"
# E-236: same reasoning as the agent mirror above — an uninstalled clone has nothing to
# compare, and asserting anyway makes the verdict a property of the machine.
if [[ -f "$SKILL_MIRROR" ]]; then
  assert_status 0 "ai-insights  → ~/.rein mirror"  diff -q "$SKILL_SRC" "$SKILL_MIRROR"
else
  _skip "ai-insights → ~/.rein mirror comparison (framework not installed)"
fi

echo ""

# ── E-86 (from insights_staleness — E-302): the staleness probe's CLI and the ai-preflight Step 7 wiring ──
# Tests for E-86 insights-staleness.mjs probe
# and the ai-preflight Step 7 wiring per .ai/blueprints/meta-cognition.md
# §Components 4.
#
#   • Helper source contract: pure node:* imports, no shell-out, fail-open.
#   • Behavioural envelope: DISABLED / EMPTY / FRESH / STALE / UNAVAILABLE.
#   • Threshold of 200 new rows (DEFAULT_THRESHOLD) is the staleness trigger.
#   • AI_TELEMETRY_DISABLE=1 AND AI_INSIGHTS_STALENESS_DISABLE=1 both short-
#     circuit to status:DISABLED.
#   • ai-preflight SKILL.md Step 7 documents the locator chain, the verbatim
#     [INSIGHTS_STALE] block, and the rollback flag.
#   • Mirrors byte-identical to ~/.rein.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PROBE="${REPO_ROOT}/src/shared/insights-staleness.mjs"
PREFLIGHT_SKILL_SRC="${REPO_ROOT}/src/shared/skills/ai-preflight/SKILL.md"


# ── T-INS-S02: AI_INSIGHTS_STALENESS_DISABLE=1 → DISABLED ─────────────────────
echo ""
echo "  [T-INS-S02] rollback flag short-circuits to DISABLED"

OUT="$(AI_INSIGHTS_STALENESS_DISABLE=1 node "$PROBE")"
assert_contains "AI_INSIGHTS_STALENESS_DISABLE→DISABLED" "\"status\":\"DISABLED\"" "$OUT"

OUT2="$(AI_TELEMETRY_DISABLE=1 node "$PROBE")"
assert_contains "AI_TELEMETRY_DISABLE→DISABLED"          "\"status\":\"DISABLED\"" "$OUT2"

# T-INS-S01 (source contract) and S03..S07 (the EMPTY/FRESH/STALE envelope) run in process in
# tests/unit/insights-staleness.test.mjs.

# ── T-INS-S08: CLI emits envelope to stdout + exits 0 ─────────────────────────
echo ""
echo "  [T-INS-S08] CLI emits envelope to stdout + exits 0"

assert_status 0 "CLI exits 0 even with no telemetry" \
  bash -c "AI_INSIGHTS_STALENESS_DISABLE=1 node '$PROBE' >/dev/null"

OUT_CLI="$(node "$PROBE" 2>/dev/null)"
assert_contains "CLI emits JSON envelope" "\"status\":" "$OUT_CLI"

# --quiet suppresses stdout but still exits 0.
QUIET_OUT="$(node "$PROBE" --quiet 2>/dev/null)"
assert_status 0 "--quiet still exits 0" \
  bash -c "node '$PROBE' --quiet >/dev/null"
assert_status 0 "--quiet produces no stdout" \
  bash -c "[[ -z '$QUIET_OUT' ]]"

# ── T-INS-S09: ai-preflight Step 7 wiring ─────────────────────────────────────
echo ""
echo "  [T-INS-S09] ai-preflight Step 7 documents the staleness check"

assert_status 0 "Step 7 heading present"               \
  grep -qE '^### 7\. INSIGHTS\.md Staleness Check' "$PREFLIGHT_SKILL_SRC"
assert_status 0 "Step 7 names E-86"                    grep -q  'E-86' "$PREFLIGHT_SKILL_SRC"
assert_status 0 "Step 7 references blueprint"          \
  grep -qE 'meta-cognition' "$PREFLIGHT_SKILL_SRC"
# E-225 REMOVED the in-repo candidate deliberately: `for c in src/shared/...` executed
# the VISITED project's copy, and this skill runs at session start. The assertion is
# rewritten to the policy that replaced it rather than relaxed — pinning the old text
# would have been pinning the bug.
assert_status 0 "Step 7 resolves the probe via the shared install-first locator" \
  grep -q 'rein_locate shared/insights-staleness.mjs' "$PREFLIGHT_SKILL_SRC"
assert_status 1 "Step 7 no longer names a cwd-relative candidate" \
  grep -qE 'for c in src/shared/insights-staleness\.mjs' "$PREFLIGHT_SKILL_SRC"
assert_status 0 "Step 7 names locator chain (installed)" \
  grep -qE '\.rein/shared/insights-staleness\.mjs' "$PREFLIGHT_SKILL_SRC"
assert_status 0 "Step 7 documents AI_INSIGHTS_STALENESS_DISABLE" \
  grep -qE 'AI_INSIGHTS_STALENESS_DISABLE' "$PREFLIGHT_SKILL_SRC"
assert_status 0 "Step 7 emits [INSIGHTS_STALE] block"  \
  grep -qE '\[INSIGHTS_STALE\]' "$PREFLIGHT_SKILL_SRC"
assert_status 0 "Step 7 prompts skill: ai-insights"    \
  grep -qE 'skill: \`?ai-insights\`?' "$PREFLIGHT_SKILL_SRC"
assert_status 0 "Step 7 acknowledges other-status silence" \
  grep -qE 'FRESH.*EMPTY.*DISABLED.*UNAVAILABLE' "$PREFLIGHT_SKILL_SRC"

# ── T-INS-S10: mirrors byte-identical ─────────────────────────────────────────
echo ""
echo "  [T-INS-S10] ~/.rein mirrors byte-identical"

assert_status 0 "insights-staleness.mjs mirror"   diff -q "$PROBE"   "${HOME}/.rein/shared/insights-staleness.mjs"
assert_status 0 "ai-preflight SKILL.md mirror"    diff -q "$PREFLIGHT_SKILL_SRC" "${HOME}/.rein/shared/skills/ai-preflight/SKILL.md"
assert_status 0 "ai-preflight .claude mirror"     diff -q "$PREFLIGHT_SKILL_SRC" "${REPO_ROOT}/.claude/skills/ai-preflight/SKILL.md"

# ── E-93 (from instinct_stager — E-302): the meta_analyst Instinct-Extraction prompt ──
# The stager itself is tests/unit/instinct-stager.test.mjs; these rows read the agent text.
meta=$(cat "$AGENT_SRC")
assert_contains "T-93.10: Instinct Extraction section"  "Instinct Extraction Mode" "$meta"
assert_contains "T-93.10: extract_instincts contract"   "extract_instincts"        "$meta"
assert_contains "T-93.10: references the stager"        "instinct-stager.mjs"      "$meta"
assert_contains "T-93.10: HITL gate forward-ref (E-94)" "approval-mcp"             "$meta"

# ── E-94 (from skill_promoter — E-302): meta_analyst documents the approval-gated promotion ──
# The promoter itself is tests/unit/skill-promoter.test.mjs.
assert_contains "T-94.09: promotion section present"   "Promotion to active (E-94" "$meta"
assert_contains "T-94.09: uses request_approval"       "request_approval"          "$meta"
assert_contains "T-94.09: references skill-promoter"   "skill-promoter.mjs"        "$meta"
assert_contains "T-94.09: notes fail-closed NON_TTY"   "NON_TTY"                   "$meta"

assert_summary
