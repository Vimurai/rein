#!/usr/bin/env bash
# agent_contracts_test.sh — every agent/skill file carries its contract (grep the persona or
# SKILL.md for the clauses its blueprint mandates, and check the mirrors). E-302 merged the
# per-agent suites into this one; each section below names the suite it came from.
#
# E-464 (D-169 r8, lean-core.md §Component 5): the reviewer persona replaced critic_arch,
# critic_tests, critic_clean_code, critic_security and review_synthesizer (their sections here
# were retired with them). Verifies src/claude/agents/reviewer.md carries its contract:
#   - frontmatter: read-only tools, add_stamp, forked context
#   - one stamp, REVIEW_PASS or REVIEW_FAIL, through add_stamp (never REVIEWS.md)
#   - reads the task text and the blueprint it names; applies D-088
#   - the workspace copy is byte-identical; only critic_acceptance keeps the critic_ prefix

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PERSONA_SRC="${REPO_ROOT}/src/claude/agents/reviewer.md"
PERSONA_CLD="${REPO_ROOT}/.claude/agents/reviewer.md"

echo "── Suite: agent_contracts_test ──────────────────────────────────────"

echo ""
echo "  [T-REV-S01] reviewer persona: frontmatter, stamp, inputs"
assert_status 0 "src/ persona exists"                test -f "$PERSONA_SRC"
assert_status 0 "name: reviewer"                     grep -q '^name: reviewer$' "$PERSONA_SRC"
assert_status 0 "tools allowlist: Bash and add_stamp" grep -qE '^tools:.*Bash.*mcp__task-synchronizer-mcp__add_stamp' "$PERSONA_SRC"
assert_status 0 "never writes (disallowedTools)"     grep -q '^disallowedTools: Write, Edit, NotebookEdit$' "$PERSONA_SRC"
assert_status 0 "context: fork"                      grep -q '^context: fork' "$PERSONA_SRC"
for stamp in REVIEW_PASS REVIEW_FAIL; do
  assert_status 0 "stamp type ${stamp} documented" grep -q "${stamp}" "$PERSONA_SRC"
done
assert_status 0 "agent string in stamp = reviewer"   grep -qE 'agent: *"reviewer"' "$PERSONA_SRC"
assert_status 0 "forbids writing REVIEWS.md"         grep -q 'never write `.ai/REVIEWS.md`' "$PERSONA_SRC"
assert_status 0 "reads the blueprint the task names" grep -q 'The blueprint' "$PERSONA_SRC"
assert_status 0 "applies D-088 (one test per behaviour, cheapest layer)" \
  grep -q 'One test per changed behaviour, at the cheapest layer' "$PERSONA_SRC"
assert_status 0 "persona .claude/ mirror"            diff -q "$PERSONA_SRC" "$PERSONA_CLD"
assert_contains "only critic_acceptance keeps the critic_ prefix" "critic_acceptance.md" \
  "$(cd "${REPO_ROOT}/src/claude/agents" && ls critic_*)"
assert_match "exactly one critic_ agent" '^1$' "$(cd "${REPO_ROOT}/src/claude/agents" && ls | grep -c critic_)"

echo ""

# ── E-149..E-152 (from specialist_agents_test — E-302): the four specialist agents ──
# (performance_engineer, db_architect, dependency_manager, sre_responder) + their
# skills (rein-profile, rein-migration, rein-upgrade, rein-triage), authored per the new
# .ai/blueprints/*.md. Verifies each persona/skill exists with a matching `name:`
# and carries its blueprint safety invariant. (E-254 removed the separate agent plugin;
# src/claude/agents/ is the only agent tree.)
name_of() { grep -m1 '^name:' "$1" 2>/dev/null | sed 's/^name:[[:space:]]*//'; }

# ── Agents: file exists, name matches filename ──────────────────────────────
for a in performance_engineer db_architect dependency_manager sre_responder; do
  f="${REPO_ROOT}/src/claude/agents/${a}.md"
  assert_status 0 "agent ${a}: persona file exists" test -f "$f"
  assert_contains "agent ${a}: frontmatter name matches" "$a" "$(name_of "$f")"
done

# ── Skills: file exists, name matches ────────────────────────────────────────
for s in rein-profile rein-migration rein-upgrade rein-triage; do
  f="${REPO_ROOT}/src/shared/skills/${s}/SKILL.md"
  assert_status 0 "skill ${s}: SKILL.md exists" test -f "$f"
  assert_contains "skill ${s}: frontmatter name matches" "$s" "$(name_of "$f")"
done

# ── Blueprint safety invariants (each agent must honor its §Security) ─────────
# performance: bounded profiling in a throwaway dir (no host DoS). E-278 (D-075) retired
# the Docker sandbox; the bound is now a finite workload under a CPU cap.
assert_status 0 "perf: profiles in a throwaway dir under a CPU cap" \
  grep -qE 'mktemp -d.*ulimit -t 30' "${REPO_ROOT}/src/claude/agents/performance_engineer.md"
assert_status 1 "perf: no DEFERRED flamegraph banner remains" \
  grep -q 'DEFERRED' "${REPO_ROOT}/src/claude/agents/performance_engineer.md"
# db: mandatory DOWN/rollback migration
assert_status 0 "db: requires DOWN/rollback migration" \
  grep -qiE "down|rollback" "${REPO_ROOT}/src/claude/agents/db_architect.md"
# dependency: cannot bypass the review (E-464: the reviewer replaced critic_security)
assert_status 0 "dep: routes through the reviewer" \
  grep -qiE "reviewer|cve|audit" "${REPO_ROOT}/src/claude/agents/dependency_manager.md"
# sre: READ-ONLY over logs — plans tasks, never edits code itself
assert_status 0 "sre: read-only / plans tasks via add_task" \
  grep -qiE "read-only|add_task|plan" "${REPO_ROOT}/src/claude/agents/sre_responder.md"

# ── E-44 (from security_engineer_agent_test — E-302): active pen-testing upgrade ──
# Verifies the security_engineer agent file (and its tracked mirror) carry the
# contract demanded by workflow-optimizations.md §3:
#   - allowed-tools includes advisor-mcp (E-278: no sandbox MCP tool)
#   - "Active Pen-Testing" section present
#   - Trust boundary policy (throwaway harness: mktemp, env -i, ulimit caps, no egress)
AGENT_FILES=(
  "${REPO_ROOT}/src/claude/agents/security_engineer.md"
  "${REPO_ROOT}/.claude/agents/security_engineer.md"
)

echo ""
echo "  [T-SECENG-S01] Agent files exist (canonical + .claude workspace copy)"
for f in "${AGENT_FILES[@]}"; do
  assert_status 0 "exists: ${f#${REPO_ROOT}/}" test -f "$f"
done

echo ""
echo "  [T-SECENG-S02] Frontmatter advertises required MCP tools"
for f in "${AGENT_FILES[@]}"; do
  assert_status 1 "${f##*/agents/} → no retired sandbox tool in its tools allowlist (E-278, E-295)" \
    grep -qE '^tools:.*execute_code' "$f"
  assert_status 0 "${f##*/agents/} → tools allowlist includes ask_architect" \
    grep -qE '^tools:.*mcp__advisor-mcp__ask_architect' "$f"
done

echo ""
echo "  [T-SECENG-S03] Description names active pen-testing"
for f in "${AGENT_FILES[@]}"; do
  assert_status 0 "${f##*/agents/} → description names the throwaway harness" \
    grep -qE '^description:.*throwaway, resource-capped temp directory' "$f"
done

echo ""
echo "  [T-SECENG-S04] Active Pen-Testing section present"
for f in "${AGENT_FILES[@]}"; do
  assert_status 0 "${f##*/agents/} → Active Pen-Testing heading" \
    grep -q "## Active Pen-Testing" "$f"
done

echo ""
echo "  [T-SECENG-S05] Trust boundary: throwaway harness, fail-closed (E-278)"
for f in "${AGENT_FILES[@]}"; do
  assert_status 0 "${f##*/agents/} → fresh mktemp -d per run"          grep -q 'mktemp -d'              "$f"
  assert_status 0 "${f##*/agents/} → no inherited environment"         grep -q 'env -i PATH='           "$f"
  assert_status 0 "${f##*/agents/} → CPU/process/file caps"            grep -q 'ulimit -t 5 -u 64 -f 10240' "$f"
  assert_status 0 "${f##*/agents/} → wall-clock kill"                  grep -q 'kill -9 "$P"'           "$f"
  assert_status 0 "${f##*/agents/} → references D-008 fail-closed"     grep -q 'D-008'                  "$f"
  assert_status 0 "${f##*/agents/} → egress-dependent payloads not run" grep -q 'No network by rule' "$f"
  # critic_security E-278 P2: the harness enforces RESOURCE limits only; the text must say so.
  assert_status 0 "${f##*/agents/} → states fs/network isolation is NOT enforced" \
    grep -q 'Filesystem and network isolation are' "$f"
  assert_status 1 "${f##*/agents/} → no isolation-by-construction overclaim" \
    grep -q 'isolation-by-construction' "$f"
  assert_status 0 "${f##*/agents/} → A10 probes validation logic only" \
    grep -q 'URL-VALIDATION logic only' "$f"
  assert_status 0 "${f##*/agents/} → never targets the working tree/host shell" grep -qiE 'host shell' "$f"
  assert_status 0 "${f##*/agents/} → temp dir removed on every path"   grep -q "trap 'rm -rf" "$f"
done

echo ""
echo "  [T-SECENG-S06] OWASP Top 10 payload table"
# Check for canonical OWASP IDs A01..A10 in the payload table.
for code in A01 A02 A03 A04 A05 A06 A07 A08 A09 A10; do
  for f in "${AGENT_FILES[@]}"; do
    assert_status 0 "${f##*/agents/} → ${code} listed" grep -q "$code" "$f"
  done
done

echo ""
echo "  [T-SECENG-S07] Reporting + verdict schema present"
for f in "${AGENT_FILES[@]}"; do
  assert_status 0 "${f##*/agents/} → SECURITY.md row schema" \
    grep -q 'OWASP | Surface | Payload' "$f"
  for verdict in RESISTED EXPLOITED INCONCLUSIVE; do
    assert_status 0 "${f##*/agents/} → ${verdict} verdict listed" \
      grep -q "$verdict" "$f"
  done
done

echo ""
echo "  [T-SECENG-S08] Out-of-scope guards (no DoS / no escape probe / no egress)"
for f in "${AGENT_FILES[@]}"; do
  assert_status 0 "${f##*/agents/} → DoS payloads excluded"      grep -qE 'DoS|fork-bomb' "$f"
  assert_status 0 "${f##*/agents/} → escape probes deferred"     grep -q 'Sandbox-escape'  "$f"
  assert_status 0 "${f##*/agents/} → outbound network excluded"  grep -q 'outbound'        "$f"
done

echo ""
echo "  [T-SECENG-S09] Source-of-truth and project mirror byte-identical"
SRC_HASH="$(md5sum "${REPO_ROOT}/src/claude/agents/security_engineer.md" | awk '{print $1}')"
MIRROR_HASH="$(md5sum "${REPO_ROOT}/.claude/agents/security_engineer.md" | awk '{print $1}')"
assert_status 0 ".claude mirror matches src" \
  bash -c "[[ '$SRC_HASH' == '$MIRROR_HASH' ]]"

# T-SECENG-S10 (agents.md named the sandbox server) retired with E-278: that blueprint is
# Architect-owned and its update was handed over, so the suite no longer pins its prose.

echo ""
echo "  [T-SECENG-S11] settings.json no longer grants the retired sandbox tool (E-278)"
# E-290: .claude/settings.json is generated (gitignored) — read the one `rein sync` writes.
source "${SCRIPT_DIR}/../lib/generated-settings.sh"
_GEN_DIR="$(mktemp -d)"; on_exit "rm -rf '$_GEN_DIR'"
GEN_SETTINGS="$(gen_project_settings "$_GEN_DIR/proj")"
assert_status 0 "the generated settings.json exists (non-vacuity for the next check)" test -s "$GEN_SETTINGS"
assert_status 1 "the generated .claude/settings.json has no execute_code allow" \
  grep -q 'execute_code' "$GEN_SETTINGS"

# ── E-100 (from skill_context_test — E-302): operational skills run in the main thread ──
# main thread (context: default), not fork into a summary-returning subagent
# (forked-execution-drift incident). Review/audit orchestrators legitimately
# keep context: fork. `context: local` is NOT a valid Claude Code value and
# must appear nowhere.
ctx() { grep -E '^context:' "$1" 2>/dev/null | head -1 | awk '{print $2}'; }

# ── Operational skills run in-thread (context: default) — source + .claude exec copy
for s in trigger-audit rein-sync-state; do   # rein-digest retired (E-430, D-159)
  assert_contains "T-100: $s source is default" "default" "$(ctx "${REPO_ROOT}/src/shared/skills/$s/SKILL.md")"
  assert_contains "T-100: $s .claude exec copy is default" "default" "$(ctx "${REPO_ROOT}/.claude/skills/$s/SKILL.md")"
done

# ── Review/audit orchestrators legitimately keep context: fork ───────────────
assert_contains "T-100: rein-review stays fork (review orchestrator)" "fork" "$(ctx "${REPO_ROOT}/src/claude/skills/rein-review/SKILL.md")"
assert_contains "T-100: architectural-aligner stays fork" "fork" "$(ctx "${REPO_ROOT}/src/claude/skills/architectural-aligner/SKILL.md")"

# ── Critic personas (agents) legitimately keep fork (parallel-spawnable) ─────
assert_contains "T-100: reviewer agent stays fork" "fork" "$(ctx "${REPO_ROOT}/src/claude/agents/reviewer.md")"

# ── `context: local` (invalid Claude Code value) must appear NOWHERE ─────────
# E-251: the corpus is built with corpus_or_fail — a moved or missing root must fail the
# scan loudly rather than let `grep -rl` report zero hits over zero files.
_ctx_rc=0
_ctx_corpus="$(cd "$REPO_ROOT" && corpus_or_fail 20 src/shared/skills src/claude/skills .claude/skills -- -type f -name SKILL.md)" || _ctx_rc=$?
assert_status 0 "T-100: context corpus built (all roots present, >=20 SKILL.md)" test "$_ctx_rc" -eq 0
local_hits=$(cd "$REPO_ROOT" && printf '%s\n' "$_ctx_corpus" | grep . | xargs grep -lE "^context:[[:space:]]*local" 2>/dev/null | wc -l | tr -d ' ')
assert_match "T-100: no invalid 'context: local' anywhere" '^0$' "$local_hits"

# ── No operational skill still forks ─────────────────────────────────────────
for s in trigger-audit rein-sync-state; do   # the compaction skill (E-283) and rein-digest (E-430) were retired
  if grep -qE "^context:[[:space:]]*fork" "${REPO_ROOT}/.claude/skills/$s/SKILL.md" 2>/dev/null; then
    _fail "T-100: $s must NOT be context: fork"
  else
    _pass "T-100: $s is not context: fork"
  fi
done

# ── E-113 (from vibe_stamp_alignment_test — E-302): rein-test records [VIBE_CLEARED] via add_stamp ──
# Before the fix, rein-test emitted [VIBE_REPORT] by appending to the regenerated REVIEWS.md view.
# E-464 removed review_synthesizer, which gated Tier 3 on [VIBE_CLEARED]; its alignment row went with it.
AI_TEST="${REPO_ROOT}/src/shared/skills/rein-test/SKILL.md"
assert_status 0 "rein-test emits [VIBE_CLEARED]"            grep -qF 'VIBE_CLEARED' "$AI_TEST"
assert_status 0 "rein-test records vibe verdict via add_stamp" \
  grep -q 'add_stamp' "$AI_TEST"
assert_status 1 "rein-test no longer emits [VIBE_REPORT]"   grep -qF 'VIBE_REPORT' "$AI_TEST"
assert_status 1 "rein-test no longer hand-appends the vibe stamp to REVIEWS.md" \
  grep -qE 'Append .*VIBE.* to .*REVIEWS\.md' "$AI_TEST"
assert_status 0 "rein-test's release gate lists [VIBE_CLEARED] (≤ 7 days)" \
  grep -qE '\[VIBE_CLEARED\].*7 days' "$AI_TEST"

# ── mirror identity for rein-test (.claude + ~/.rein) ──────────────────────
assert_status 0 "rein-test .claude mirror identical" \
  diff -q "$AI_TEST" "${REPO_ROOT}/.claude/skills/rein-test/SKILL.md"
assert_status 0 "rein-test ~/.rein mirror identical" \
  diff -q "$AI_TEST" "${HOME}/.rein/shared/skills/rein-test/SKILL.md"

# E-64 T-PR-S01..S05 (the task-planner skill taught framework routing) were deleted by E-461 with
# the skill. The routing itself is pinned by task_synchronizer_test T-FW-S01..S07, and add_task's
# own schema text names is_framework_task and [WORKSPACE_NOT_FOUND].

# ── E-43 (from ai_debug_skill_test — E-302): rein-debug skill TASK_BUDGET upgrade ──
# Verifies the skill body in src/shared/skills (source of truth) and the tracked
# .claude/skills mirror carry the contract bits
# the workflow-optimizations.md blueprint mandates: 3-cycle budget,
# BUDGET_EXHAUSTED state, advisor-mcp escalation, hypothesis distinctness.
# The canonical source plus the Claude workspace copy — the only workspace in v4 (E-254).
SKILL_FILES=(
  "${REPO_ROOT}/src/shared/skills/rein-debug/SKILL.md"
  "${REPO_ROOT}/.claude/skills/rein-debug/SKILL.md"
)

echo ""
echo "  [T-DEBUG-S01] Source and workspace copy exist"
for f in "${SKILL_FILES[@]}"; do
  assert_status 0 "exists: ${f#${REPO_ROOT}/}" test -f "$f"
done

echo ""
echo "  [T-DEBUG-S02] Frontmatter advertises advisor-mcp tool"
for f in "${SKILL_FILES[@]}"; do
  assert_status 0 "${f##*/skills/} → allowed-tools includes advisor-mcp ask_architect" \
    grep -qE 'allowed-tools:.*mcp__advisor-mcp__ask_architect' "$f"
done

echo ""
echo "  [T-DEBUG-S03] Description references TASK_BUDGET"
for f in "${SKILL_FILES[@]}"; do
  assert_status 0 "${f##*/skills/} → description names TASK_BUDGET" \
    grep -qE '^description:.*TASK_BUDGET' "$f"
done

echo ""
echo "  [T-DEBUG-S04] Body enforces 3-cycle budget"
for f in "${SKILL_FILES[@]}"; do
  assert_status 0 "${f##*/skills/} → 'Max iterations: 3'"        grep -qE "Max iterations:\*\*[[:space:]]*3|Max iterations:[[:space:]]*3" "$f"
  assert_status 0 "${f##*/skills/} → BUDGET_EXHAUSTED state"     grep -q "BUDGET_EXHAUSTED"               "$f"
  assert_status 0 "${f##*/skills/} → Iteration N/3 prompt"       grep -q "Iteration N/3"                  "$f"
  assert_status 0 "${f##*/skills/} → Hypotheses must be distinct" grep -q "distinct"                      "$f"
done

echo ""
echo "  [T-DEBUG-S05] Escalation block invokes advisor-mcp"
for f in "${SKILL_FILES[@]}"; do
  assert_status 0 "${f##*/skills/} → BUDGET_EXHAUSTED escalation block present" \
    grep -q "Escalation — BUDGET_EXHAUSTED" "$f"
  assert_status 0 "${f##*/skills/} → calls mcp__advisor-mcp__ask_architect" \
    grep -q "mcp__advisor-mcp__ask_architect" "$f"
  assert_status 0 "${f##*/skills/} → forbids 4th cycle without architect" \
    grep -qE 'Do NOT start a 4th cycle|4th cycle' "$f"
done

echo ""
echo "  [T-DEBUG-S06] Override pathway documented"
for f in "${SKILL_FILES[@]}"; do
  assert_status 0 "${f##*/skills/} → AI_DEBUG_BUDGET env override documented" \
    grep -q "AI_DEBUG_BUDGET" "$f"
done

echo ""
echo "  [T-DEBUG-S07] Source-of-truth and mirrors are byte-identical"
SRC_HASH_AD="$(md5sum "${REPO_ROOT}/src/shared/skills/rein-debug/SKILL.md" | awk '{print $1}')"
CLAUDE_HASH="$(md5sum "${REPO_ROOT}/.claude/skills/rein-debug/SKILL.md" | awk '{print $1}')"

assert_status 0 ".claude mirror matches src" \
  bash -c "[[ '$SRC_HASH_AD' == '$CLAUDE_HASH' ]]"

assert_summary
