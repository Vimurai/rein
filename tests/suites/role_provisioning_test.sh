#!/usr/bin/env bash
# role_provisioning_test.sh — E-212 (architect-provider-parity.md §Components 1-2):
# role-aware provisioning. `do_sync` used to provision by PROVIDER DIRECTORY, which
# silently equated provider with role — fine while each vendor served one role, wrong
# under D-054 where one provider can serve both. These assertions pin the join:
# registry.json `roles` (which dirs serve which role) x .ai/roles.json (which provider
# holds which role). E-254 (D-069): both roles are served from src/claude/*, so the
# join is now visible in the SERVED-ROLES output rather than in distinct directories.
#
# E-302 folds in the rest of the role surface: the runtime rulefiles and `ai doctor` role
# lines (E-215/E-254), the roles.json template (E-135), the provider adapter (E-138) and the
# headless Tester role (E-255).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AI_BIN="${REPO_ROOT}/src/bin/ai"
MANIFEST="${REPO_ROOT}/src/shared/role-manifest.mjs"
REGISTRY="${REPO_ROOT}/src/config/registry.json"

echo "── Suite: role_provisioning_test (E-212) ────────────────────────────"

# ── E-212.1: the manifest exists and names the one source adapter (D-069) ────
assert_status 0 "E-212.01a: registry.json declares a roles manifest" \
  bash -c "python3 -c \"import json;d=json.load(open('$REGISTRY'));assert 'roles' in d\""
assert_status 0 "E-212.01b: architect maps to claude/skills" \
  bash -c "python3 -c \"import json;d=json.load(open('$REGISTRY'));assert d['roles']['architect']['skill_dirs']==['claude/skills']\""
assert_status 0 "E-212.01c: engineer maps to claude/*" \
  bash -c "python3 -c \"import json;d=json.load(open('$REGISTRY'));assert d['roles']['engineer']['agent_dirs']==['claude/agents']\""
assert_status 0 "E-212.01d: each role names its rulefile" \
  bash -c "python3 -c \"import json;d=json.load(open('$REGISTRY'));assert d['roles']['architect']['rulefile']=='ARCHITECT.md' and d['roles']['engineer']['rulefile']=='ENGINEER.md'\""

# ── E-212.2: the join — provider -> source dirs ──────────────────────────────
_dual="$(mktemp -d)"; mkdir -p "$_dual"
cat > "$_dual/roles.json" <<'JSON'
{ "roles": { "architect": { "provider": "claude", "pane_identifier": "1" },
             "engineer":  { "provider": "claude", "pane_identifier": "0" } } }
JSON
# A role bound to a provider OTHER than claude. `acme` is a neutral declared name; the
# manifest must still join on it, whatever the provider is called.
_split="$(mktemp -d)"; mkdir -p "$_split"
cat > "$_split/roles.json" <<'JSON'
{ "roles": { "architect": { "provider": "acme",   "pane_identifier": "1" },
             "engineer":  { "provider": "claude", "pane_identifier": "0" } } }
JSON

_src() { node --no-warnings "$MANIFEST" "$1" "$REGISTRY" "$2" "${3:-}" 2>/dev/null | tr '\n' ' '; }

# All-Claude: one provider serves BOTH roles, so it receives the union.
assert_contains "E-212.02a: dual-claude — claude gets the role skill dir" "claude/skills" "$(_src "$_dual" claude)"
assert_contains "E-212.02c: dual-claude — shared is always included" "shared/skills" "$(_src "$_dual" claude)"
assert_contains "E-212.02e: dual-claude — claude gets the role agent dir" "claude/agents" "$(_src "$_dual" claude --agents)"
assert_contains "E-212.02f: dual-claude — both roles reported as served" "architect engineer" "$(_src "$_dual" claude --roles)"
# UNION, deduped: both roles name claude/skills, and a doubled entry would sync it twice
# (the second pass through the no-clobber path, reporting every skill as a collision).
assert_status 0 "E-254.02g: the union is deduped — claude/skills listed exactly once" \
  bash -c "[ \"\$(node --no-warnings '$MANIFEST' '$_dual' '$REGISTRY' claude | grep -cx 'claude/skills')\" -eq 1 ]"

# Split: the provider holding ONE role must be reported as serving only that role.
assert_contains "E-212.03a: split — claude serves the Engineer" "engineer" "$(_src "$_split" claude --roles)"
assert_not_contains "E-212.03b: split — claude does NOT serve the Architect" "architect" "$(_src "$_split" claude --roles)"
assert_contains "E-212.03c: split — the Architect's provider gets the role skill dir" "claude/skills" "$(_src "$_split" acme)"
assert_contains "E-212.03d: split — and still gets shared" "shared/skills" "$(_src "$_split" acme)"

# A provider bound to no role gets shared only — a normal state, not an error.
assert_contains "E-212.04a: an unserved provider still receives shared" "shared/skills" "$(_src "$_split" nosuchprovider)"
assert_not_contains "E-212.04b: an unserved provider receives no role dirs" "claude/skills" "$(_src "$_split" nosuchprovider)"
assert_status 0 "E-212.04c: an unserved provider is not an error" \
  bash -c "node --no-warnings '$MANIFEST' '$_split' '$REGISTRY' nosuchprovider >/dev/null 2>&1"

# Corrupt / missing config degrades to shared rather than throwing.
_bad="$(mktemp -d)"; echo 'not json{' > "$_bad/roles.json"
assert_contains "E-212.05a: corrupt roles.json degrades to shared, never throws" "shared/skills" "$(_src "$_bad" claude)"
assert_contains "E-212.05b: absent roles.json degrades to shared" "shared/skills" "$(_src "$(mktemp -d)" claude)"

# ── E-212.6: bash 3.2 — empty arrays under `set -u` ──────────────────────────
# macOS ships bash 3.2.57, where expanding an EMPTY array as "${arr[@]}" raises
# "unbound variable" (safe only from 4.4). An unserved provider produces exactly that
# empty list, so this is the common path. Caught live: sync aborted mid-run and left
# workspaces unprovisioned.
assert_status 0 "E-212.06a: src/bin/ai parses under bash 3.2" /bin/bash -n "$AI_BIN"
assert_status 0 "E-212.06b: array expansions are count-guarded, not bare" \
  grep -q 'NOTE ON BASH 3.2' "$AI_BIN"
assert_status 0 "E-212.06c: agent_dirs expansion is count-guarded" \
  grep -q 'agent_dirs\[@\]}" -gt 0' "$AI_BIN"
assert_status 0 "E-212.06d: skill_dirs expansion is count-guarded" \
  grep -q 'skill_dirs\[@\]}" -gt 0' "$AI_BIN"

# BEHAVIOURAL: a real sync in a project where claude serves only ONE role. This is the
# shape of the original abort — a source-text assertion alone would not catch it,
# because the expansion is still present, just guarded.
_e212_ws="$(mktemp -d)"
mkdir -p "$_e212_ws/.ai"
cat > "$_e212_ws/.ai/roles.json" <<'JSON'
{ "roles": { "architect": { "provider": "acme", "pane_identifier": "1" },
             "engineer":  { "provider": "claude", "pane_identifier": "0" } } }
JSON
# E-244: run the WORKING TREE's ai, not ${HOME}/.ai-os/bin/ai. These are assertions about
# how the code BEHAVES, and the installed mirror is whatever version was last installed —
# so on a developer machine they silently tested the previous release. That is not
# hypothetical: with the mirror one release behind, a case here passed locally and failed
# on CI, where `ai install` runs from HEAD. An environment-dependent assertion (E-236) in
# the suite that exists to prove provisioning works.
_e212_out="$(cd "$_e212_ws" && /bin/bash "$AI_BIN" sync 2>&1)"; _e212_rc=$?
assert_not_contains "E-212.06e: sync completes with no unbound-variable abort (bash 3.2)" \
  "unbound variable" "$_e212_out"
assert_status 0 "E-212.06e2: and exits 0" test "$_e212_rc" -eq 0
assert_status 0 "E-212.06g: the Engineer's workspace is still provisioned" \
  test -f "$_e212_ws/.claude/skills/ai-task/SKILL.md"
assert_contains "E-212.06h: and it reports serving the Engineer role" \
  ".claude/ serves role(s): engineer" "$_e212_out"

# ── E-212.7: the 7 Architect agents meet the Claude frontmatter contract ─────
for a in ux_reviewer docs-architect knowledge_architect meta_analyst memory_curator seo_manager seo_content_generator; do
  f="${REPO_ROOT}/src/claude/agents/${a}.md"
  assert_status 0 "E-212.07 [$a]: declares a tools allowlist (E-295)" grep -qE '^tools:' "$f"
  assert_status 0 "E-212.07 [$a]: declares context: fork" grep -qE '^context: fork$' "$f"
  assert_status 0 "E-212.07 [$a]: declares agent: general-purpose" grep -qE '^agent: general-purpose$' "$f"
  # NOT widened: these are advisory Architect personas (Forbidden Zone), so the contract
  # must not hand them Bash/Write/Edit.
  assert_status 1 "E-212.07 [$a]: allowed-tools does not add Bash" \
    bash -c "grep -E '^allowed-tools:' '$f' | grep -q 'Bash'"
  assert_status 1 "E-212.07 [$a]: allowed-tools does not add Write/Edit" \
    bash -c "grep -E '^allowed-tools:' '$f' | grep -qE '\\bWrite\\b|\\bEdit\\b'"
done

# ── E-217 (D-055 R2): collision resolved by renaming; guard is now fatal ────
echo "  [E-217] skill-name collision resolution"

# The Architect's task/history skills are RENAMED, not deduplicated — they do a
# different job for a different role. Same reason arch-review is not ai-review (E-149).
assert_status 0 "E-217.01a: arch-task exists in the Architect set" \
  test -f "${REPO_ROOT}/src/claude/skills/arch-task/SKILL.md"
assert_status 0 "E-217.01b: arch-oracle exists in the Architect set" \
  test -f "${REPO_ROOT}/src/claude/skills/arch-oracle/SKILL.md"
assert_status 1 "E-217.01c: the Architect set no longer ships ai-task" \
  test -e "${REPO_ROOT}/src/claude/skills/ai-task"
assert_status 1 "E-217.01d: the Architect set no longer ships repo-oracle" \
  test -e "${REPO_ROOT}/src/claude/skills/repo-oracle"
# The ENGINEER keeps the original names — that is the point of the rename.
assert_status 0 "E-217.01e: the Engineer keeps ai-task" \
  test -f "${REPO_ROOT}/src/shared/skills/ai-task/SKILL.md"
assert_status 0 "E-217.01f: the Engineer keeps repo-oracle" \
  test -f "${REPO_ROOT}/src/shared/skills/repo-oracle/SKILL.md"
# Frontmatter name must match the directory, or the skill loads under the old name.
assert_status 0 "E-217.01g: arch-task frontmatter name matches" \
  grep -qE '^name: arch-task$' "${REPO_ROOT}/src/claude/skills/arch-task/SKILL.md"
assert_status 0 "E-217.01h: arch-oracle frontmatter name matches" \
  grep -qE '^name: arch-oracle$' "${REPO_ROOT}/src/claude/skills/arch-oracle/SKILL.md"

# References must follow the rename, and ARCHITECT.md must explain WHY the names
# differ so nobody "corrects" them back to match the Engineer's.
assert_status 0 "E-217.02a: ARCHITECT.md points at arch-task" \
  grep -q 'arch-task' "${REPO_ROOT}/src/templates/ARCHITECT.md"
assert_status 0 "E-217.02b: ARCHITECT.md records why the names differ" \
  grep -q 'must not collide' "${REPO_ROOT}/src/templates/ARCHITECT.md"
assert_status 0 "E-217.02c: task-planner hands back to arch-task" \
  grep -q 'skill: arch-task' "${REPO_ROOT}/src/claude/skills/task-planner/SKILL.md"
assert_status 0 "E-217.02d: root ARCHITECT.md matches its template" \
  diff -q "${REPO_ROOT}/src/templates/ARCHITECT.md" "${REPO_ROOT}/ARCHITECT.md"

# All 20 agents now satisfy the frontmatter contract (seo_engineer lacked `context:`
# since E-90 — the only one failing, deliberately left alone in E-212 and fixed here).
assert_status 0 "E-217.03a: seo_engineer declares context:" \
  grep -qE '^context: fork$' "${REPO_ROOT}/src/claude/agents/seo_engineer.md"
_E217_BAD=0
for _f in "${REPO_ROOT}"/src/claude/agents/*.md; do
  for _k in name description tools context agent; do   # E-295: tools, not allowed-tools
    grep -qE "^${_k}:" "$_f" || _E217_BAD=$((_E217_BAD + 1))
  done
done
assert_contains "E-217.03b: every agent satisfies the frontmatter contract" "0" "$_E217_BAD"

# The guard is FATAL in a multi-role workspace and inert in a single-role one.
assert_status 0 "E-217.04a: sync returns non-zero on an unresolved collision" \
  grep -q 'unresolved skill-name collision' "$AI_BIN"
assert_status 0 "E-217.04b: the error names the rename precedent" \
  grep -q 'arch-task, arch-oracle, arch-review' "$AI_BIN"
# A name already on DISK is not a collision — it may be a stale copy from an earlier
# sync. Only a name claimed by ANOTHER SOURCE in the same run counts; comparing against
# disk residue reported task-planner, which exists in exactly one source dir.
assert_status 0 "E-217.04c: collisions compare sources within a run, not disk residue" \
  grep -q '_SKILL_CLAIMS' "$AI_BIN"
assert_status 0 "E-217.04d: sync returns success explicitly (no stray git status)" \
  grep -q 'Explicit success: without it do_sync returns' "$AI_BIN"


# ── E-215 (from role_runtime_test — E-302): role runtime — rulefiles and the doctor role report ──
# ARCHITECT.md runtime ladder (the Skill tool for skills, the Agent tool for agents — E-276) +
# the `ai doctor` per-role provisioning report.
ARCH_TPL="${REPO_ROOT}/src/templates/ARCHITECT.md"
ENG_TPL="${REPO_ROOT}/src/templates/ENGINEER.md"
# ── E-215.1: Session Start ladder mirrors ENGINEER.md ───────────────────────
assert_status 0 "E-215.01a: ARCHITECT.md step 1 is the Skill tool" \
  grep -q 'skill: "ai-preflight"' "$ARCH_TPL"
# E-276: the retired MCP rungs are gone from BOTH rulefiles, not merely reordered.
for _tpl in "$ARCH_TPL" "$ENG_TPL"; do
  assert_status 1 "E-276.01b: no run_preflight rung in ${_tpl##*/}" grep -q 'run_preflight' "$_tpl"
  assert_status 1 "E-276.01c: no activate_skill/activate_agent in ${_tpl##*/}" \
    grep -qE 'activate_skill|activate_agent|context-invoker' "$_tpl"
done
# The manual read order must survive as the floor when every layer fails.
assert_status 0 "E-215.01d: the DIGEST-first manual read order is retained" \
  grep -q 'DIGEST.md → .ai/architect.md → .ai/TASKS.md' "$ARCH_TPL"
# Both rulefiles must name the same single path — that is what "mirror" means here.
assert_status 0 "E-215.01e: ENGINEER.md also starts with the Skill tool" \
  grep -qF 'skill: "ai-preflight"' "$ENG_TPL"
for _tpl in "$ARCH_TPL" "$ENG_TPL"; do
  assert_status 0 "E-276.01f: §36 in ${_tpl##*/} reads 'Skill tool for skills, Agent tool for agents'" \
    grep -qF '**HOW — the Skill tool for skills, the Agent tool for agents** (D-075)' "$_tpl"
done

# ── E-215.2: Skill Invocation is runtime-aware ─────────────────────────────
assert_status 0 "E-215.02a: the Skill tool is the stated invocation path" \
  grep -q 'Use the \*\*Skill tool\*\*' "$ARCH_TPL"
assert_status 0 "E-276.02b: the MCP invoker is stated as retired, not offered" \
  grep -qF 'there is no MCP invoker' "$ARCH_TPL"
assert_status 0 "E-283.02c: the compact pattern points at the native /compact" \
  grep -qF 'Do this with `/compact`' "$ARCH_TPL"

# ── E-215.3 / E-254: no provider-specific section survives (D-069) ─────────
# v4 is Claude-native: the Architect runs on claude · fable, so a "Provider notes" block
# or a vendor Model Mandate would be instructions for a runtime that no longer exists.
assert_status 1 "E-254.03a: no Provider notes heading remains" \
  grep -qE '^## Provider notes' "$ARCH_TPL"
assert_status 1 "E-254.03b: no Model Mandate heading at any level" \
  grep -qE '^#+ .*Model Mandate' "$ARCH_TPL"
# Non-vacuity: the model the Architect DOES run on is still stated, so 03a/03b cannot
# pass merely because the header block was emptied.
assert_status 0 "E-254.03c: the header names the claude provider on model fable" \
  grep -q 'the `claude` provider on model `fable`' "$ARCH_TPL"

# ── E-215.4: sovereign text untouched ──────────────────────────────────────
assert_status 0 "E-215.04a: the Forbidden Zone section is intact" \
  grep -qE '^## The Forbidden Zone$' "$ARCH_TPL"
assert_status 0 "E-215.04b: the §35 ANTI-DRIFT section is intact" \
  grep -qE '^## ANTI-DRIFT PROTOCOL' "$ARCH_TPL"
assert_status 0 "E-215.04c: the Role Resolution clause (E-208) is intact" \
  grep -q 'Role Resolution (D-054' "$ARCH_TPL"
# CLAUDE.md is the one load-bearing shim (D-051): Claude Code auto-loads it.
# E-254: no template imports ARCHITECT.md any more — the vendor shim that did is gone, and
# the Architect pane receives its rulefile via --append-system-prompt-file instead.
assert_status 1 "E-254.04d: no template is an @import shim for ARCHITECT.md" \
  bash -c "grep -rlx '@ARCHITECT.md' '${REPO_ROOT}/src/templates'"
assert_status 0 "E-215.04e: CLAUDE.md is still a pure @import shim" \
  grep -q '@ENGINEER.md' "${REPO_ROOT}/src/templates/CLAUDE.md"

# The project root copies are what an agent actually loads — keep them in step.
assert_status 0 "E-215.04f: root ARCHITECT.md matches its template" \
  diff -q "$ARCH_TPL" "${REPO_ROOT}/ARCHITECT.md"

# ── E-215.5: role-manifest CLI vs import (the _isMain trap) ────────────────
# argv[1] IS the module path when the module is imported dynamically, so a filename
# suffix test wrongly concluded "I am the CLI" and printed usage + exit 2 into the
# importing caller. `ai doctor` aborted mid-report because of it.
assert_status 0 "E-215.05a: the CLI path still prints source dirs" \
  bash -c "node --no-warnings '$MANIFEST' '${REPO_ROOT}/.ai' '${REPO_ROOT}/src/config/registry.json' claude | grep -q 'shared/skills'"
# A tiny probe script keeps the quoting readable — the point is that IMPORTING the
# module must print only the returned value, with no CLI usage banner leaking in.
# .cjs extension: node needs it to pick a module format for a temp file.
_PROBE="$(mktemp).cjs"
cat > "$_PROBE" <<'PROBE'
const { pathToFileURL } = require("node:url");
// slice(2): argv[0] is node, argv[1] is THIS probe script.
const [mod, registry, role] = process.argv.slice(2);
import(pathToFileURL(mod).href).then((m) => {
  process.stdout.write(m.rulefileForRole(registry, role) || "(empty)");
});
PROBE
_rulefile() {  # <role> → resolved rulefile, plus anything the import leaked
  node --no-warnings "$_PROBE" "$MANIFEST" "${REPO_ROOT}/src/config/registry.json" "$1" 2>&1
}
assert_contains "E-215.05b: importing resolves the architect rulefile" "ARCHITECT.md" "$(_rulefile architect)"
assert_not_contains "E-215.05c: importing leaks no CLI usage banner" "usage: role-manifest.mjs" "$(_rulefile architect)"
assert_contains "E-215.05d: importing resolves the engineer rulefile" "ENGINEER.md" "$(_rulefile engineer)"
assert_contains "E-215.05e: an unknown role resolves to empty, not a crash" "(empty)" "$(_rulefile nosuchrole)"
rm -f "$_PROBE"

# ── E-215.6: the doctor per-role report ────────────────────────────────────
_DOC="$(cd "$REPO_ROOT" && bash "$AI_BIN" doctor 2>&1)"
assert_contains "E-215.06a: doctor prints a per-role section" "Per-role provisioning" "$_DOC"
assert_contains "E-215.06b: it reports the architect's provider" "architect →" "$_DOC"
assert_contains "E-215.06c: it reports the engineer's provider" "engineer →" "$_DOC"
assert_contains "E-215.06d: it reports skills" "skills" "$_DOC"
assert_contains "E-215.06e: it reports agents" "agents" "$_DOC"
assert_contains "E-215.06f: it reports the settings overlay" "overlay" "$_DOC"
assert_contains "E-215.06g: it reports the rulefile" "rulefile" "$_DOC"
# The report must reach the END of both roles — it previously aborted after the
# overlay line because a failing node lookup tripped `set -e`.
assert_contains "E-215.06h: the report completes through the engineer's rulefile" "ENGINEER.md" "$_DOC"
assert_contains "E-215.06i: and the architect's rulefile" "ARCHITECT.md" "$_DOC"
assert_contains "E-215.06j: doctor continues past the report" "Project-Scoped" "$_DOC"

# It is diagnostic only — it must never change the tree.
_BEFORE="$(cd "$REPO_ROOT" && git status --porcelain | md5 -q)"
( cd "$REPO_ROOT" && bash "$AI_BIN" doctor >/dev/null 2>&1 )
_AFTER="$(cd "$REPO_ROOT" && git status --porcelain | md5 -q)"
assert_status 0 "E-215.06k: doctor is read-only (working tree unchanged)" \
  bash -c "[[ '$_BEFORE' == '$_AFTER' ]]"

# A role bound to a provider with no known workspace is REPORTED, and the report goes on
# to the next role rather than aborting. `acme` is a neutral non-claude provider name.
_ACME="$(mktemp -d)"; mkdir -p "$_ACME/.ai"
cat > "$_ACME/.ai/roles.json" <<'JSON'
{ "roles": { "architect": { "provider": "acme", "pane_identifier": "1" },
             "engineer":  { "provider": "claude", "pane_identifier": "0" } } }
JSON
_DOC_ACME="$( cd "$_ACME" && bash "$AI_BIN" doctor 2>&1 )"
assert_contains "E-215.06l: a non-claude architect is reported as such" "architect → acme" "$_DOC_ACME"
assert_contains "E-254.06m: its workspace is reported unknown, not probed" \
  "no known workspace directory for provider 'acme'" "$_DOC_ACME"
assert_contains "E-254.06n: the report continues to the engineer" "engineer → claude" "$_DOC_ACME"
rm -rf "$_ACME"

# No roles.json: the D-050 fallback is now all-Claude (D-069).
_NOROLES="$(mktemp -d)"; mkdir -p "$_NOROLES/.ai"
_DOC_NR="$( cd "$_NOROLES" && bash "$AI_BIN" doctor 2>&1 )"
assert_contains "E-254.06o: a missing roles.json falls back to architect=claude, engineer=claude" \
  "architect=claude, engineer=claude" "$_DOC_NR"
rm -rf "$_NOROLES"

# ── E-135 (from role_config_test — E-302): the roles.json template and its overrides ──
# Role Configuration Store (.ai/roles.json) + install flags: sources src/bin/ai to exercise
# _parse_role_flags / _write_roles_json and validates the template default mapping.
ROLES_TEMPLATE="${REPO_ROOT}/src/templates/roles.json"
export AIOS="${HOME}/.ai-os"
# T-1: template exists + is valid JSON with the documented schema
assert_exists "$ROLES_TEMPLATE"
assert_status 0 "T-1: roles.json template is valid JSON" \
  node -e "JSON.parse(require('fs').readFileSync('${ROLES_TEMPLATE}','utf8'))"
tmpl=$(node -e "const r=require('${ROLES_TEMPLATE}').roles; process.stdout.write([r.architect.provider,r.architect.pane_identifier,r.engineer.provider,r.engineer.pane_identifier].join(','))")
# D-066 supersedes the D-050 default: the all-Claude Triad is the DEFAULT topology
# (architect claude:1 · fable, engineer claude:0 · opus). Roles stay provider-abstract (D-069).
assert_contains "T-1b: template defaults architect=claude:1 engineer=claude:0 (D-066)" "claude,1,claude,0" "$tmpl"

# T-2: _parse_role_flags accepts valid <provider:pane> flags
assert_status 0 "T-2: parses --architect claude:1 --engineer acme:0 (any provider name)" \
  bash -c "source '$AI_BIN'; _parse_role_flags --architect claude:1 --engineer acme:0; [[ \"\$ROLE_ARCHITECT\" == claude:1 && \"\$ROLE_ENGINEER\" == acme:0 ]]"

# T-3: malformed role values abort with exit 2 (fail-closed)
assert_status 2 "T-3a: rejects missing pane (no colon)" \
  bash -c "source '$AI_BIN'; _parse_role_flags --architect badformat"
assert_status 2 "T-3b: rejects non-numeric pane (claude:x)" \
  bash -c "source '$AI_BIN'; _parse_role_flags --engineer claude:x"

# T-4: _write_roles_json honors explicit overrides
tmp_over="$(mktemp -d)"
( cd "$tmp_over" && mkdir -p .ai && bash -c "source '$AI_BIN'; ROLE_ARCHITECT=claude:1; ROLE_ENGINEER=claude:0; _write_roles_json" >/dev/null )
assert_status 0 "T-4: override roles.json is valid JSON" \
  node -e "JSON.parse(require('fs').readFileSync('${tmp_over}/.ai/roles.json','utf8'))"
over=$(node -e "const r=require('${tmp_over}/.ai/roles.json').roles; process.stdout.write([r.architect.provider,r.architect.pane_identifier,r.engineer.provider,r.engineer.pane_identifier].join(','))")
assert_contains "T-4b: dual-claude override architect=claude:1 engineer=claude:0" "claude,1,claude,0" "$over"

# T-5: _write_roles_json falls back to the default mapping when no flags set (D-066/D-069)
tmp_def="$(mktemp -d)"
( cd "$tmp_def" && mkdir -p .ai && bash -c "source '$AI_BIN'; _write_roles_json" >/dev/null )
def=$(node -e "const r=require('${tmp_def}/.ai/roles.json').roles; process.stdout.write([r.architect.provider,r.architect.pane_identifier,r.engineer.provider,r.engineer.pane_identifier].join(','))")
assert_contains "T-5: default architect=claude:1 engineer=claude:0 (D-066)" "claude,1,claude,0" "$def"

# T-6: _write_roles_json is a silent no-op outside a project (.ai/ absent)
tmp_noai="$(mktemp -d)"
assert_status 0 "T-6: no-op (exit 0) when .ai/ absent" \
  bash -c "cd '$tmp_noai' && source '$AI_BIN'; _write_roles_json"
assert_status 1 "T-6b: no roles.json written without .ai/" test -f "${tmp_noai}/.ai/roles.json"

# T-7: ensure_ai_templates scaffolds .ai/roles.json from the template (idempotent)
assert_status 0 "T-7: ensure_ai_templates wires roles.json scaffold" \
  grep -q 'ensure_file_if_missing "$T/roles.json"' "$AI_BIN"

rm -rf "$tmp_over" "$tmp_def" "$tmp_noai"

# ── E-138 / E-254 (from provider_adapter_test — E-302): the providers.json template and adapter ──
# AI-OS v4 is Claude-native (D-069): the template and built-in adapters declare `claude` only.
PROV_TEMPLATE="${REPO_ROOT}/src/templates/providers.json"
ADAPTER="${REPO_ROOT}/src/shared/provider-adapter.mjs"
# ── T-1: providers.json template valid + declares exactly the claude provider ──
assert_exists "$PROV_TEMPLATE"
assert_status 0 "T-1: providers.json template is valid JSON" \
  node -e "JSON.parse(require('fs').readFileSync('${PROV_TEMPLATE}','utf8'))"
keys=$(node -e "process.stdout.write(Object.keys(require('${PROV_TEMPLATE}').providers).sort().join(','))")
assert_match "T-1b: template declares exactly one provider (claude)" "^claude$" "$keys"
cl=$(node -e "const a=require('${PROV_TEMPLATE}').providers.claude; process.stdout.write(a.mcp_config_path+'|'+a.mcp_key)")
assert_contains "T-1c: claude → .claude.json|mcpServers" ".claude.json|mcpServers" "$cl"
builtin=$(node --input-type=module -e "const m=await import('file://${ADAPTER}'); process.stdout.write(Object.keys(m.DEFAULT_ADAPTERS).sort().join(','))")
assert_match "T-1d: built-in DEFAULT_ADAPTERS declare exactly claude" "^claude$" "$builtin"

# ── T-2: ensure_ai_templates scaffolds .ai/providers.json ────────────────────
assert_status 0 "T-2: providers.json wired into ensure_ai_templates" \
  grep -q 'ensure_file_if_missing "$T/providers.json"' "$AI_BIN"

# ── T-3: `ai provider` is removed — exits 2 and points at .ai/providers.json ──
PROJ="$(mktemp -d)"; mkdir -p "${PROJ}/.ai"
out=$(cd "$PROJ" && "$AI_BIN" provider add foo --config-path config/foo.json --mcp-key mcpServers 2>&1; echo "rc=$?")
assert_contains "T-3a: ai provider add exits 2" "rc=2" "$out"
assert_contains "T-3b: the refusal names .ai/providers.json" \
  "providers are configured in .ai/providers.json" "$out"
# The removed subcommand must not have half-run: no registry entry, no generated config.
assert_status 1 "T-3c: no providers.json written by the removed subcommand" \
  test -f "${PROJ}/.ai/providers.json"
assert_status 1 "T-3d: no provider MCP config generated" test -f "${PROJ}/config/foo.json"
bare=$(cd "$PROJ" && "$AI_BIN" provider 2>&1; echo "rc=$?")
assert_contains "T-3e: bare ai provider also exits 2" "rc=2" "$bare"
rm -rf "$PROJ"

# ── T-5: generate_mcp_json honors a custom output path + top-level key ────────
GP="$(mktemp -d)"
( source "$AI_BIN" 2>/dev/null; cd "$GP"; generate_mcp_json "." "custom.json" "serverList" )
key=$(node -e "const c=require('${GP}/custom.json'); process.stdout.write(Object.keys(c)[0]||'')" 2>/dev/null)
assert_contains "T-5: generate_mcp_json writes the requested top-level key" "serverList" "$key"
rm -rf "$GP"

# ── E-255 (from headless_tester_test — E-302): the headless Tester role (claude, sonnet, no pane) ──
# Template/writer, `ai start`/`ai pane`/overlays ignore a headless role, derived labels, ai-test
# command detection and --fast model selection, and TestSprite gone from registry and .mcp.json.
AI="${REPO_ROOT}/src/bin/ai"
TESTCMD="${REPO_ROOT}/src/shared/test-command.mjs"
SBOX="$(mktemp -d -t headless-tester-XXXXXX)"
register_cleanup "rm -rf '$SBOX'"

# _proj <name> <roles-json> → project dir with .ai/roles.json
_proj() {
  local d="${SBOX}/$1"; mkdir -p "$d/.ai"
  printf '%s' "$2" > "$d/.ai/roles.json"
  printf '%s' "$d"
}
V4_ROLES='{ "roles": {
  "architect": { "provider": "claude", "pane_identifier": "1", "model": "fable" },
  "engineer":  { "provider": "claude", "pane_identifier": "0", "model": "opus" },
  "tester":    { "provider": "claude", "model": "sonnet", "headless": true } } }'

# ── E-255.1: the template and the writer carry the headless tester ──────────
echo "  [E-255.1] roles.json template + _write_roles_json"
_t="$(node -e "const r=require('${REPO_ROOT}/src/templates/roles.json').roles.tester||{}; process.stdout.write([r.provider,r.model,r.headless,r.pane_identifier===undefined].join(','))")"
assert_contains "E-255.01a: template tester = claude · sonnet, headless, no pane" "claude,sonnet,true,true" "$_t"

_w="${SBOX}/writer"; mkdir -p "$_w/.ai"
( cd "$_w" && bash -c "source '$AI'; _write_roles_json" >/dev/null )
_t="$(node -e "const r=require('${_w}/.ai/roles.json').roles; process.stdout.write([r.architect.provider,r.engineer.provider,r.tester.provider,r.tester.model,r.tester.headless].join(','))")"
assert_contains "E-255.01b: _write_roles_json emits the headless tester beside both panes" "claude,claude,claude,sonnet,true" "$_t"

# ── E-255.2: ai start ignores headless roles ────────────────────────────────
echo "  [E-255.2] ai start / _start_roles"
# _start_roles is defined past bin/ai's source guard (E-53), so drive it through the
# dry run — the same path an operator's `ai start` takes.
_p="$(_proj start "$V4_ROLES")"
_out="$(cd "$_p" && bash "$AI" start --dry-run 2>&1)"
assert_match "E-255.02a: dry run binds the engineer to the first pane" 'send-keys -t pane0 ai.\ pane.\ engineer' "$_out"
assert_match "E-255.02b: …and the architect to the second" 'send-keys -t pane1 ai.\ pane.\ architect' "$_out"
assert_not_contains "E-255.02c: no third pane is addressed (the tester occupies none)" "pane2" "$_out"
assert_not_contains "E-255.02d: the tester is never sent 'ai pane'" 'pane\ tester' "$_out"

# Non-vacuity: the headless FLAG is what excludes a role, not the name "tester". An
# architect marked headless disappears from the layout too.
_p2="$(_proj start-headless-arch '{ "roles": {
  "architect": { "provider": "claude", "pane_identifier": "1", "headless": true },
  "engineer":  { "provider": "claude", "pane_identifier": "0" } } }')"
_out2="$(cd "$_p2" && bash "$AI" start --dry-run 2>&1)"
assert_match "E-255.02e: headless:true — the engineer is still bound" 'ai.\ pane.\ engineer' "$_out2"
assert_not_contains "E-255.02f: headless:true removes any role from the layout, the architect included" 'pane\ architect' "$_out2"

# ── E-255.3: ai pane tester refuses with the pointer to ai-test ─────────────
echo "  [E-255.3] ai pane tester"
assert_status 2 "E-255.03a: ai pane tester exits 2" bash -c "cd '$_p' && bash '$AI' pane tester 2>/dev/null"
assert_contains "E-255.03b: the message says headless and names skill: ai-test" \
  "tester is headless; run skill: ai-test" "$(cd "$_p" && bash "$AI" pane tester 2>&1)"

# ── E-255.4: no settings overlay for a headless role ────────────────────────
echo "  [E-255.4] settings overlays"
_ov="$(_proj overlay "$V4_ROLES")"; mkdir -p "$_ov/.claude"
( cd "$_ov" && bash -c "source '$AI'; _write_role_settings_overlays .claude .ai" >/dev/null 2>&1 )
assert_exists "${_ov}/.claude/settings.engineer.json"
assert_exists "${_ov}/.claude/settings.architect.json"
assert_status 1 "E-255.04a: no settings.tester.json is written" test -e "${_ov}/.claude/settings.tester.json"

# ── E-255.5: labels are derived for all three roles ─────────────────────────
echo "  [E-255.5] derived labels"
_lab() {
  AI_OS_MOD="file://${ADAPTER}" node --input-type=module -e '
const m = await import(process.env.AI_OS_MOD);
const d = process.argv[1];
process.stdout.write(["architect","engineer","tester"].map(r => m.roleLabel(d, r)).join("|") + "|" +
  ["architect","engineer","tester"].map(r => m.isHeadless(d, r)).join(","));
' "$1"
}
assert_contains "E-255.05a: v4 roles → claude · fable / opus / sonnet, only tester headless" \
  "Architect (claude · fable)|Engineer (claude · opus)|Tester (claude · sonnet)|false,false,true" "$(_lab "$_p/.ai")"
_cust="$(_proj custom '{ "roles": { "tester": { "provider": "claude", "model": "opus", "headless": false } } }')"
assert_contains "E-255.05b: a re-bound tester model changes the label (never a literal)" \
  "Tester (claude · opus)" "$(_lab "$_cust/.ai")"
assert_contains "E-255.05c: explicit headless:false wins over the default" "false,false,false" "$(_lab "$_cust/.ai")"
assert_contains "E-255.05d: no roles.json falls back to the defaults" \
  "Tester (claude · sonnet)|false,false,true" "$(_lab "${SBOX}/nonexistent/.ai")"

_bl="$(cd "$_cust" && bash -c "source '$AI'; _roles_banner_labels")"
assert_contains "E-255.05e: banner labels carry three fields, tester from roles.json" "claude·fable|claude·opus|claude·opus" "$_bl"
assert_status 1 "E-255.05f: the init banner no longer hard-codes a Tester vendor" \
  grep -qE "Tester +%-18s.*\"\\((TestSprite|[A-Za-z]+)\\)\"" "$AI"

# ── E-255.6: ai-test resolves the real test command ─────────────────────────
echo "  [E-255.6] test-command detection"
_tc() { node "$TESTCMD" "$@" 2>/dev/null; }
_d="${SBOX}/npm"; mkdir -p "$_d/tests"; echo '{"scripts":{"test":"vitest run"}}' > "$_d/package.json"; : > "$_d/tests/run.sh"
assert_contains "E-255.06a: package.json test wins over tests/run.sh" '"command":"npm test","source":"package.json"' "$(_tc "$_d")"
_d="${SBOX}/placeholder"; mkdir -p "$_d/tests"; : > "$_d/tests/run.sh"
echo '{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}' > "$_d/package.json"
assert_contains "E-255.06b: the npm init placeholder is skipped → tests/run.sh" '"command":"bash tests/run.sh"' "$(_tc "$_d")"
_d="${SBOX}/py"; mkdir -p "$_d"; printf '[tool.pytest.ini_options]\n' > "$_d/pyproject.toml"
assert_contains "E-255.06c: pyproject [tool.pytest] → pytest" '"command":"pytest"' "$(_tc "$_d")"
_d="${SBOX}/pytests"; mkdir -p "$_d/tests"; : > "$_d/tests/test_app.py"
assert_contains "E-255.06d: tests/test_*.py → pytest" '"command":"pytest"' "$(_tc "$_d")"
_d="${SBOX}/go"; mkdir -p "$_d"; echo 'module x' > "$_d/go.mod"
assert_contains "E-255.06e: go.mod → go test ./..." '"command":"go test ./..."' "$(_tc "$_d")"
_d="${SBOX}/none"; mkdir -p "$_d"; printf '[tool.black]\n' > "$_d/pyproject.toml"
assert_status 3 "E-255.06f: no test command → exit 3, never a guess" node "$TESTCMD" "$_d"
assert_contains "E-255.06g: …and command is null" '"command":null' "$(_tc "$_d")"
assert_contains "E-255.06h: this repository resolves to its own harness" '"command":"npm test"' "$(_tc "$REPO_ROOT")"

# ── E-255.7: model selection — sonnet by default, haiku under --fast ────────
echo "  [E-255.7] tester model"
_d="${SBOX}/npm"
assert_contains "E-255.07a: default Tester model is sonnet" '"model":"sonnet"' "$(_tc "$_d")"
assert_contains "E-255.07b: --fast runs the Tester on haiku" '"model":"haiku"' "$(_tc --fast "$_d")"
mkdir -p "$_d/.ai"; echo '{ "roles": { "tester": { "provider": "claude", "model": "opus", "headless": true } } }' > "$_d/.ai/roles.json"
assert_contains "E-255.07c: roles.json tester model is honoured" '"model":"opus"' "$(_tc "$_d")"
assert_contains "E-255.07d: --fast still wins over roles.json" '"model":"haiku"' "$(_tc --fast "$_d")"

# ── E-255.8: the agent and the skill ────────────────────────────────────────
echo "  [E-255.8] test_engineer agent + ai-test skill"
AGENT="${REPO_ROOT}/src/claude/agents/test_engineer.md"
SKILL="${REPO_ROOT}/src/shared/skills/ai-test/SKILL.md"
assert_exists "$AGENT"
assert_status 0 "E-255.08a: test_engineer frontmatter pins model: sonnet" \
  bash -c "sed -n '1,/^---\$/{/^---\$/!p;}' '$AGENT' | sed -n '1,12p' | grep -qx 'model: sonnet'"
# D-110 r1/r2: the rule-matchers pin sonnet, every other agent inherits — the pinned set is
# exactly this list, and no agent pins below sonnet.
_pinned="$(cd "${REPO_ROOT}/src/claude/agents" && for _f in *.md; do
  sed -n '2,/^---$/p' "$_f" | grep -qE '^model:' && printf '%s=%s ' "${_f%.md}" "$(sed -n '2,/^---$/p' "$_f" | sed -n 's/^model: *//p')"
done)"
_want="critic_arch=sonnet critic_clean_code=sonnet critic_security=sonnet critic_tests=sonnet docs-architect=sonnet memory_curator=sonnet sre_responder=sonnet test_engineer=sonnet "
assert_status 0 "D-110.01: exactly the seven rule-matchers and test_engineer pin model: sonnet (got: ${_pinned})" \
  test "$_pinned" = "$_want"
assert_status 0 "E-255.08b: test_engineer stamps through add_stamp, and only that MCP tool" \
  bash -c "grep -E '^tools:' '$AGENT' | grep -q 'mcp__task-synchronizer-mcp__add_stamp' && [ \"\$(grep -E '^tools:' '$AGENT' | grep -oE 'mcp__[a-z-]+__[a-z_]+' | wc -l | tr -d ' ')\" = 1 ]"
assert_status 0 "E-255.08c: test_engineer writes only under tests/" grep -q 'Write ONLY under `tests/`' "$AGENT"
for _flag in -- --generate --fast --vibe; do
  [[ "$_flag" == "--" ]] && continue
  assert_status 0 "E-255.08d: ai-test documents ${_flag}" grep -q -- "## ${_flag}\|(${_flag} flag)" "$SKILL"
done
assert_status 0 "E-255.08e: ai-test resolves the command through test-command.mjs" grep -q 'shared/test-command.mjs' "$SKILL"
assert_mirror_if_present "E-255.08f: .claude/agents/test_engineer.md mirrors src" "$AGENT" "${REPO_ROOT}/.claude/agents/test_engineer.md"

# ── E-255.9: TestSprite is gone from every generated surface ────────────────
echo "  [E-255.9] third-party test cloud removed"
_ts='testsprite'   # written plainly (D-076): this file is on tests/fixtures/legacy-mention-allowlist.json
assert_status 1 "E-255.09a: registry.json has no ${_ts} server" grep -qi "$_ts" "${REPO_ROOT}/src/config/registry.json"
assert_status 0 "E-255.09b: the Quality domain lists only real local servers" \
  node --input-type=module -e "
const m = await import('file://${REPO_ROOT}/src/mcp/shared/mcp-domains.mjs');
const all = Object.values(m.DOMAINS ?? m.default ?? {}).flatMap(d => d.servers ?? []);
process.exit(all.length > 0 && !all.some(s => /${_ts}/i.test(s)) ? 0 : 1);"
_mcp="${SBOX}/mcp"; mkdir -p "$_mcp"
( cd "$_mcp" && bash -c "source '$AI'; DEST_DIR='$_mcp'; generate_mcp_json" >/dev/null 2>&1 )
if [[ -f "${_mcp}/.mcp.json" ]]; then
  assert_status 1 "E-255.09c: a generated .mcp.json carries no ${_ts} entry" grep -qi "$_ts" "${_mcp}/.mcp.json"
  assert_status 0 "E-255.09d: …but still carries the filesystem server (non-vacuous)" grep -q '"filesystem"' "${_mcp}/.mcp.json"
else
  assert_status 0 "E-255.09c: generate_mcp_json produced a file" test -f "${_mcp}/.mcp.json"
fi

assert_summary
