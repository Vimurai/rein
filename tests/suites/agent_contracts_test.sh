#!/usr/bin/env bash
# agent_contracts_test.sh — every agent/skill file carries its contract (grep the persona or
# SKILL.md for the clauses its blueprint mandates, and check the mirrors). E-302 merged the
# per-agent suites into this one; each section below names the suite it came from.
#
# E-81 critic_clean_code persona: verifies src/claude/agents/critic_clean_code.md against the contract in
# .ai/blueprints/engineering-standards.md §Components 2 and the integration
# pattern documented in src/claude/skills/ai-review/SKILL.md:
#
#   - Persona file exists with parseable YAML frontmatter
#   - Persona invokes scripts/standards.mjs (the E-80 CLI) — single source
#     of truth, never re-implements the rule logic
#   - Persona stamps via task-synchronizer-mcp::add_stamp (never writes
#     REVIEWS.md directly) using CLEAN_PASS / CLEAN_WARN / CLEAN_FAIL types
#   - ai-review SKILL.md Tier 2 + Tier 3 sections wire the persona in
#   - AI_OS_SKIP_STANDARDS=1 rollback path documented in the persona
#   - Severity ladder + verdict table match the E-80 envelope schema
#   - Mirrors byte-identical to .claude/ + ~/.ai-os/claude/

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PERSONA_SRC="${REPO_ROOT}/src/claude/agents/critic_clean_code.md"
PERSONA_CLD="${REPO_ROOT}/.claude/agents/critic_clean_code.md"
PERSONA_MIRROR="${HOME}/.ai-os/claude/agents/critic_clean_code.md"
REVIEW_SRC="${REPO_ROOT}/src/claude/skills/ai-review/SKILL.md"
REVIEW_CLD="${REPO_ROOT}/.claude/skills/ai-review/SKILL.md"
REVIEW_MIRROR="${HOME}/.ai-os/claude/skills/ai-review/SKILL.md"

echo "── Suite: agent_contracts_test ──────────────────────────────────────"

# ── T-CCC-S01: Persona file presence + frontmatter integrity ────────────────
echo ""
echo "  [T-CCC-S01] Persona file exists with parseable frontmatter"

assert_status 0 "src/ persona exists"                test -f "$PERSONA_SRC"
assert_status 0 ".claude/ mirror exists"             test -f "$PERSONA_CLD"
assert_status 0 "frontmatter opens on line 1"        bash -c "head -1 '$PERSONA_SRC' | grep -q '^---$'"
assert_status 0 "name: critic_clean_code"            grep -q '^name: critic_clean_code$' "$PERSONA_SRC"
assert_status 0 "description present"                grep -q '^description: ' "$PERSONA_SRC"
assert_status 0 "description double-quoted (colon-parse guard)" \
  bash -c "head -10 '$PERSONA_SRC' | grep -q '^description: \"'"
assert_status 0 "frontmatter has closing delimiter within 30 lines" \
  bash -c "awk 'NR>1 && /^---$/{print NR; exit}' '$PERSONA_SRC' | grep -qE '^[2-9]$|^[12][0-9]$|^30$'"
assert_status 0 "tools allowlist includes Bash (for shell + git diff; E-295: subagents use tools, not allowed-tools)" \
  grep -q '^tools:.*Bash' "$PERSONA_SRC"
assert_status 0 "context: fork (parallel-spawnable)"  grep -q '^context: fork' "$PERSONA_SRC"

# ── T-CCC-S02: Persona invokes the E-80 standards-checker CLI ───────────────
echo ""
echo "  [T-CCC-S02] Persona uses scripts/standards.mjs (single source of truth)"

assert_status 0 "persona references scripts/standards.mjs" \
  grep -q 'scripts/standards.mjs' "$PERSONA_SRC"
assert_status 0 "persona uses --staged + --json envelope" \
  grep -q 'check --staged --json' "$PERSONA_SRC"
assert_status 0 "persona documents the locator chain (in-tree + ~/.ai-os fallback)" \
  grep -qE '\$\{HOME\}/.ai-os/scripts/standards.mjs|HOME.*ai-os' "$PERSONA_SRC"
assert_status 0 "persona references standards.json (rule registry)" \
  grep -q 'standards.json' "$PERSONA_SRC"
assert_status 0 "persona reads the engineering-standards blueprint" \
  grep -q 'engineering-standards.md' "$PERSONA_SRC"

# ── T-CCC-S03: Stamp contract — uses MCP, never writes REVIEWS.md ───────────
echo ""
echo "  [T-CCC-S03] Persona stamps via task-synchronizer-mcp::add_stamp"

assert_status 0 "persona invokes add_stamp"           grep -q 'mcp__task-synchronizer-mcp__add_stamp' "$PERSONA_SRC"
assert_status 0 "persona explicitly forbids writing REVIEWS.md" \
  grep -qE 'never write[s]? .*REVIEWS.md|do NOT write.*REVIEWS.md|never writes? \`.ai/REVIEWS.md\`' "$PERSONA_SRC"
for stamp in CLEAN_PASS CLEAN_WARN CLEAN_FAIL; do
  assert_status 0 "stamp type ${stamp} documented" \
    grep -q "${stamp}" "$PERSONA_SRC"
done
assert_status 0 "agent string in stamp = critic_clean_code" \
  grep -qE 'agent: *.*critic_clean_code' "$PERSONA_SRC"

# ── T-CCC-S04: Verdict table follows the E-80 envelope semantics ────────────
echo ""
echo "  [T-CCC-S04] Verdict ladder matches summary{error_count,warning_count}"

assert_status 0 "persona references summary.error_count semantic" \
  grep -q 'error_count' "$PERSONA_SRC"
assert_status 0 "persona references warning_count semantic" \
  grep -qE 'warning_count|warn_count' "$PERSONA_SRC"
assert_status 0 "CLEAN_WARN is non-blocking for Tier 2" \
  grep -qiE 'CLEAN_WARN does NOT block|does not block' "$PERSONA_SRC"
assert_status 0 "CLEAN_FAIL is the COMMIT BLOCKED signal" \
  grep -q 'COMMIT BLOCKED' "$PERSONA_SRC"

# ── T-CCC-S05: Rollback path documented per blueprint §Rollback Plan ───────
echo ""
echo "  [T-CCC-S05] AI_OS_SKIP_STANDARDS=1 escape hatch documented"

assert_status 0 "rollback flag named verbatim"       grep -q 'AI_OS_SKIP_STANDARDS=1' "$PERSONA_SRC"
assert_status 0 "STANDARDS_SKIPPED marker referenced" grep -q 'STANDARDS_SKIPPED' "$PERSONA_SRC"
assert_status 0 "skip-path still emits a stamp"      \
  bash -c "awk '/^## Rollback/{f=1; next} /^## /{f=0} f' '$PERSONA_SRC' | grep -q 'add_stamp'"

# ── T-CCC-S06: Pre-flight reads documented (blueprint + standards.json) ─────
echo ""
echo "  [T-CCC-S06] Persona reads the contract files before reviewing"

assert_status 0 "preflight section present"          grep -q '^## Pre-flight' "$PERSONA_SRC"
assert_status 0 "preflight reads engineering-standards.md blueprint" \
  bash -c "awk '/^## Pre-flight/,/^## Step 1/' '$PERSONA_SRC' | grep -q 'engineering-standards.md'"
assert_status 0 "preflight reads standards.json registry" \
  bash -c "awk '/^## Pre-flight/,/^## Step 1/' '$PERSONA_SRC' | grep -q 'standards.json'"
assert_status 0 "no-staged-surface short-circuit documented" \
  grep -qE 'no staged surface|no staged changes' "$PERSONA_SRC"

# ── T-CCC-S07: ai-review SKILL.md wires critic_clean_code at Tier 2 + Tier 3 ─
echo ""
echo "  [T-CCC-S07] ai-review skill invokes critic_clean_code in Tier 2 + Tier 3"

# Tier 2 block — between '## Tier 2' and '## Tier 3'.
assert_status 0 "Tier 2 section spawns critic_clean_code" \
  bash -c "awk '/^## Tier 2/,/^## Tier 3/' '$REVIEW_SRC' | grep -q 'critic_clean_code'"
assert_status 0 "Tier 2 section names CLEAN_PASS|CLEAN_WARN|CLEAN_FAIL" \
  bash -c "awk '/^## Tier 2/,/^## Tier 3/' '$REVIEW_SRC' | grep -qE 'CLEAN_PASS|CLEAN_WARN|CLEAN_FAIL'"
assert_status 0 "Tier 2 documents the pass-gate condition" \
  bash -c "awk '/^## Tier 2/,/^## Tier 3/' '$REVIEW_SRC' | grep -qE 'CLEAN must NOT be .FAIL|CLEAN_FAIL'"

# Tier 3 block — from '## Tier 3' to EOF.
assert_status 0 "Tier 3 spawns critic_clean_code" \
  bash -c "awk '/^## Tier 3/{f=1} f' '$REVIEW_SRC' | grep -q 'critic_clean_code'"
assert_status 0 "Tier 3 expected-stamps list mentions CLEAN_*" \
  bash -c "awk '/^## Tier 3/{f=1} f' '$REVIEW_SRC' | grep -qE 'CLEAN_PASS/WARN/FAIL'"

# ── T-CCC-S08: ~/.ai-os mirrors byte-identical ──────────────────────────────
echo ""
echo "  [T-CCC-S08] Mirrors match src/"

assert_status 0 "persona .claude/ mirror"      diff -q "$PERSONA_SRC" "$PERSONA_CLD"
if [[ -f "$PERSONA_MIRROR" ]]; then
  assert_status 0 "persona ~/.ai-os/ mirror"   diff -q "$PERSONA_SRC" "$PERSONA_MIRROR"
else
  echo "    ⚠  persona ~/.ai-os/ mirror absent — skipping"
fi
assert_status 0 "ai-review .claude/ mirror"   diff -q "$REVIEW_SRC" "$REVIEW_CLD"
if [[ -f "$REVIEW_MIRROR" ]]; then
  assert_status 0 "ai-review ~/.ai-os/ mirror" diff -q "$REVIEW_SRC" "$REVIEW_MIRROR"
else
  echo "    ⚠  ai-review ~/.ai-os/ mirror absent — skipping"
fi

# ── T-CCC-S09: Reference resolution — critic_clean_code points to E-80 files ─
echo ""
echo "  [T-CCC-S09] Persona's referenced files actually exist in the repo"

assert_status 0 "scripts/standards.mjs exists" test -f "${REPO_ROOT}/scripts/standards.mjs"
assert_status 0 "src/shared/standards.json exists" test -f "${REPO_ROOT}/src/shared/standards.json"
assert_status 0 "blueprint exists"             test -f "${REPO_ROOT}/.ai/blueprints/engineering-standards.md"

# ── T-CCC-S10: Anti-drift — persona does not re-implement checks ────────────
echo ""
echo "  [T-CCC-S10] Persona declares it does NOT bypass the CLI"

assert_status 0 "explicit 'do NOT bypass the CLI' guard" \
  grep -qE 'NOT bypass the CLI|reimplement|single source of truth' "$PERSONA_SRC"
assert_status 0 "explicit read-only review constraint" \
  grep -qE 'read-only|Read-only|MUST NOT modify any source file|Do NOT modify any source' "$PERSONA_SRC"

echo ""

# ── E-149..E-152 (from specialist_agents_test — E-302): the four specialist agents ──
# (performance_engineer, db_architect, dependency_manager, sre_responder) + their
# skills (ai-profile, ai-migration, ai-upgrade, ai-triage), authored per the new
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
for s in ai-profile ai-migration ai-upgrade ai-triage; do
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
# dependency: cannot bypass critic_security
assert_status 0 "dep: routes through critic_security" \
  grep -qiE "critic_security|cve|audit" "${REPO_ROOT}/src/claude/agents/dependency_manager.md"
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
# E-290: .claude/settings.json is generated (gitignored) — read the one `ai sync` writes.
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
for s in ai-digest trigger-audit ai-sync-state; do
  assert_contains "T-100: $s source is default" "default" "$(ctx "${REPO_ROOT}/src/shared/skills/$s/SKILL.md")"
  assert_contains "T-100: $s .claude exec copy is default" "default" "$(ctx "${REPO_ROOT}/.claude/skills/$s/SKILL.md")"
done

# ── Review/audit orchestrators legitimately keep context: fork ───────────────
assert_contains "T-100: ai-review stays fork (review orchestrator)" "fork" "$(ctx "${REPO_ROOT}/src/claude/skills/ai-review/SKILL.md")"
assert_contains "T-100: architectural-aligner stays fork" "fork" "$(ctx "${REPO_ROOT}/src/claude/skills/architectural-aligner/SKILL.md")"

# ── Critic personas (agents) legitimately keep fork (parallel-spawnable) ─────
assert_contains "T-100: critic_clean_code agent stays fork" "fork" "$(ctx "${REPO_ROOT}/src/claude/agents/critic_clean_code.md")"

# ── `context: local` (invalid Claude Code value) must appear NOWHERE ─────────
# E-251: the corpus is built with corpus_or_fail — a moved or missing root must fail the
# scan loudly rather than let `grep -rl` report zero hits over zero files.
_ctx_rc=0
_ctx_corpus="$(cd "$REPO_ROOT" && corpus_or_fail 20 src/shared/skills src/claude/skills .claude/skills -- -type f -name SKILL.md)" || _ctx_rc=$?
assert_status 0 "T-100: context corpus built (all roots present, >=20 SKILL.md)" test "$_ctx_rc" -eq 0
local_hits=$(cd "$REPO_ROOT" && printf '%s\n' "$_ctx_corpus" | grep . | xargs grep -lE "^context:[[:space:]]*local" 2>/dev/null | wc -l | tr -d ' ')
assert_match "T-100: no invalid 'context: local' anywhere" '^0$' "$local_hits"

# ── No operational skill still forks ─────────────────────────────────────────
for s in ai-digest trigger-audit ai-sync-state; do   # the compaction skill was retired (E-283)
  if grep -qE "^context:[[:space:]]*fork" "${REPO_ROOT}/.claude/skills/$s/SKILL.md" 2>/dev/null; then
    _fail "T-100: $s must NOT be context: fork"
  else
    _pass "T-100: $s is not context: fork"
  fi
done

# ── In-thread write-capable: ai-digest must hold Write (it persists DIGEST.md) ─
# Under context: default the skill runs in-thread, so it needs its own write
# tools — a read-only allowed-tools cannot satisfy "ai-digest updates DIGEST.md".
assert_contains "T-100: ai-digest can Write (in-thread persistence)" "Write" \
  "$(grep -E '^allowed-tools:' "${REPO_ROOT}/src/shared/skills/ai-digest/SKILL.md")"

# ── E-113 (from vibe_stamp_alignment_test — E-302): ai-test's vibe stamp matches review_synthesizer ──
# review_synthesizer requires for a Tier-3 release.
# Before the fix, ai-test emitted [VIBE_REPORT] (by appending to the regenerated
# REVIEWS.md view) while review_synthesizer gated Tier 3 on [VIBE_CLEARED] — so a
# release could never satisfy the prerequisite. ai-test now records [VIBE_CLEARED]
# via add_stamp (persists through SQLite → REVIEWS.md).
AI_TEST="${REPO_ROOT}/src/shared/skills/ai-test/SKILL.md"
SYNTH="${REPO_ROOT}/src/claude/skills/review_synthesizer/SKILL.md"  # E-141: relocated agent→skill; E-254: src/claude


# ── ai-test emits the stamp review_synthesizer needs ─────────────────────────
assert_status 0 "ai-test emits [VIBE_CLEARED]"            grep -qF 'VIBE_CLEARED' "$AI_TEST"
assert_status 0 "ai-test records vibe verdict via add_stamp" \
  grep -q 'add_stamp' "$AI_TEST"
assert_status 1 "ai-test no longer emits [VIBE_REPORT]"   grep -qF 'VIBE_REPORT' "$AI_TEST"
assert_status 1 "ai-test no longer hand-appends the vibe stamp to REVIEWS.md" \
  grep -qE 'Append .*VIBE.* to .*REVIEWS\.md' "$AI_TEST"

# ── the Tier-3 gate list requires [VIBE_CLEARED] ─────────────────────────────
assert_status 0 "ai-test Tier-3 gate lists [VIBE_CLEARED]" \
  grep -qE '\[VIBE_CLEARED\].*7 days|VIBE_CLEARED.*review_synthesizer' "$AI_TEST"

# ── alignment: review_synthesizer requires exactly that stamp ────────────────
assert_status 0 "review_synthesizer requires [VIBE_CLEARED]" \
  grep -qF 'VIBE_CLEARED' "$SYNTH"

# ── mirror identity for ai-test (.claude + ~/.ai-os) ──────────────────────
assert_status 0 "ai-test .claude mirror identical" \
  diff -q "$AI_TEST" "${REPO_ROOT}/.claude/skills/ai-test/SKILL.md"
assert_status 0 "ai-test ~/.ai-os mirror identical" \
  diff -q "$AI_TEST" "${HOME}/.ai-os/shared/skills/ai-test/SKILL.md"

# ── E-64 (from task_planner_routing_test — E-302): task-planner teaches path classification ──
# Verifies that the task-planner skill (Architect-owned) explicitly teaches
# Step 4 path-classification + the is_framework_task payload contract
# from .ai/blueprints/task-routing.md, and stays in sync with its
# ~/.ai-os/ mirror.
SKILL_SRC="${REPO_ROOT}/src/claude/skills/task-planner/SKILL.md"
SKILL_MIRROR="${HOME}/.ai-os/claude/skills/task-planner/SKILL.md"


# ── T-PR-S01: skill teaches the framework-classification step ─────────────────
echo ""
echo "  [T-PR-S01] task-planner SKILL.md introduces Step 4 — Classify Workspace"

assert_status 0 "skill file exists" \
  test -f "$SKILL_SRC"

assert_status 0 "Step 4 — Classify the Workspace section present" \
  grep -q 'Step 4 — Classify the Workspace' "$SKILL_SRC"

assert_status 0 "explicit framework-path triggers (~/.ai-os/, ai-os-v2/src/**)" \
  grep -q '~/.ai-os/' "$SKILL_SRC"
assert_status 0 "explicit ai-os-v2/src/** trigger documented" \
  grep -q 'ai-os-v2/src' "$SKILL_SRC"

# ── T-PR-S02: payload contract surfaced ──────────────────────────────────────
echo ""
echo "  [T-PR-S02] add_task example carries is_framework_task"

assert_status 0 "skill names is_framework_task in the add_task call" \
  grep -q 'is_framework_task' "$SKILL_SRC"

assert_status 0 "skill warns about [WORKSPACE_NOT_FOUND] failure mode" \
  grep -q 'WORKSPACE_NOT_FOUND' "$SKILL_SRC"

assert_status 0 "skill names \$AIOS_WORKSPACE explicitly" \
  grep -q 'AIOS_WORKSPACE' "$SKILL_SRC"

# ── T-PR-S03: ambiguity guidance documented ──────────────────────────────────
echo ""
echo "  [T-PR-S03] ambiguous-classification fallback rule documented"

assert_status 0 "skill specifies project-level default on ambiguity" \
  grep -qE 'ambiguous|Ambiguous' "$SKILL_SRC"

# ── T-PR-S04: 'What NOT to Do' carries the routing prohibition ───────────────
echo ""
echo "  [T-PR-S04] anti-pattern call-out forbids cross-project leakage"

assert_status 0 "What NOT to Do mentions framework-level routing" \
  grep -qE 'framework-level tasks|framework workspace' "$SKILL_SRC"

# ── T-PR-S05: ~/.ai-os mirror is byte-identical ──────────────────────────────
echo ""
echo "  [T-PR-S05] ~/.ai-os/ mirror tracks src/ verbatim"

if [[ -f "$SKILL_MIRROR" ]]; then
  assert_status 0 "src and ~/.ai-os mirror are byte-identical" \
    cmp -s "$SKILL_SRC" "$SKILL_MIRROR"
else
  echo "  ⚠ mirror absent — install-ai-os.sh hasn't run since E-64; skipping cmp"
fi

# ── E-43 (from ai_debug_skill_test — E-302): ai-debug skill TASK_BUDGET upgrade ──
# Verifies the skill body in src/shared/skills (source of truth) and the tracked
# .claude/skills mirror carry the contract bits
# the workflow-optimizations.md blueprint mandates: 3-cycle budget,
# BUDGET_EXHAUSTED state, advisor-mcp escalation, hypothesis distinctness.
# The canonical source plus the Claude workspace copy — the only workspace in v4 (E-254).
SKILL_FILES=(
  "${REPO_ROOT}/src/shared/skills/ai-debug/SKILL.md"
  "${REPO_ROOT}/.claude/skills/ai-debug/SKILL.md"
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
SRC_HASH_AD="$(md5sum "${REPO_ROOT}/src/shared/skills/ai-debug/SKILL.md" | awk '{print $1}')"
CLAUDE_HASH="$(md5sum "${REPO_ROOT}/.claude/skills/ai-debug/SKILL.md" | awk '{print $1}')"

assert_status 0 ".claude mirror matches src" \
  bash -c "[[ '$SRC_HASH_AD' == '$CLAUDE_HASH' ]]"

assert_summary
