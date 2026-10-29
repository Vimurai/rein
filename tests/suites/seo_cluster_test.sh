#!/usr/bin/env bash
# seo_cluster_test.sh — the SEO Topic Cluster Engine: the Multi-Variation-State-Tracker tables
# and tools (E-88), then the three SEO agent contracts that drive it (E-87 manager, E-90
# engineer, E-88 content generator — merged here by E-302).
#
# Verifies the Multi-Variation-State-Tracker (SEO Topic Cluster Engine)
# bolted onto task-synchronizer-mcp per
# .ai/blueprints/seo-keyword-multiplier.md §Components 3 + §Data Model + §API:
#
#   - Two tables (topic_seeds, cluster_pages) with FK + CHECKs
#   - Four MCP tools: add_topic_seed, add_cluster_page,
#     report_performance, get_topic_cluster
#   - Input validation: term charset/length, target_volume range,
#     intent_type ∈ canonical set, FK enforcement
#   - Cannibalization guard ((seed_id, intent_type) uniqueness) + lifted
#     cluster-page cap (MAX_CLUSTER_PAGES_PER_SEED)
#   - JSON merge-patch semantics on report_performance
#   - Idempotent schema bootstrap (no errors on repeat open)
#   - In-place migration of the legacy keyword_seeds / content_variations
#     schema (approach_type → intent_type) preserving rows
#   - No regression of existing tables (tasks/stamps/deltas/patches)
#   - SEO_ALL_INTENTS single-source-of-truth cross-references
#     src/claude/agents/seo_manager.md exactly (E-87 contract)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/mcp-client.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SYNC_MCP="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"
STATE_DB="${REPO_ROOT}/src/mcp/shared/state-db.js"
INTENT_MOD="${REPO_ROOT}/src/shared/seo-cluster-intents.mjs"
MANAGER="${REPO_ROOT}/src/claude/agents/seo_manager.md"

echo "── Suite: seo_cluster_test ──────────────────────────────────────────"

# ── T-MVS-S01: Source contract — module + handlers + helpers ────────────────
echo ""
echo "  [T-MVS-S01] state-db.js has the new tables + id helpers"

assert_status 0 "topic_seeds CREATE present"           grep -q 'CREATE TABLE IF NOT EXISTS topic_seeds' "$STATE_DB"
assert_status 0 "cluster_pages CREATE present"          grep -q 'CREATE TABLE IF NOT EXISTS cluster_pages' "$STATE_DB"
assert_status 0 "FK constraint declared"                grep -q 'FOREIGN KEY (seed_id) REFERENCES topic_seeds' "$STATE_DB"
assert_status 0 "status CHECK constraint declared"      grep -q "status IN ('OPEN','IN_PROGRESS','COMPLETED','ARCHIVED')" "$STATE_DB"
assert_status 0 "target_volume CHECK ≤ 10"             grep -q "target_volume <= 10" "$STATE_DB"
assert_status 0 "idx_cluster_pages_seed index"          grep -q 'idx_cluster_pages_seed' "$STATE_DB"
assert_status 0 "intent_type column declared"           grep -q 'intent_type' "$STATE_DB"
assert_status 0 "nextTopicSeedId exported"              grep -q 'export function nextTopicSeedId' "$STATE_DB"
assert_status 0 "nextClusterPageId exported"            grep -q 'export function nextClusterPageId' "$STATE_DB"
assert_status 0 "_migrateSeoSchema present"             grep -q '_migrateSeoSchema' "$STATE_DB"

echo ""
echo "  [T-MVS-S01b] task-synchronizer-mcp wires the new tools + handlers"

assert_status 0 "MCP imports SEO_ALL_INTENTS"           grep -q 'SEO_ALL_INTENTS' "$SYNC_MCP"
assert_status 0 "MCP imports MAX_CLUSTER_PAGES_PER_SEED" grep -q 'MAX_CLUSTER_PAGES_PER_SEED' "$SYNC_MCP"
assert_status 0 "add_topic_seed case present"           grep -q 'case "add_topic_seed":' "$SYNC_MCP"
assert_status 0 "add_cluster_page case present"         grep -q 'case "add_cluster_page":' "$SYNC_MCP"
assert_status 0 "report_performance case present"       grep -q 'case "report_performance":' "$SYNC_MCP"
assert_status 0 "get_topic_cluster case present"        grep -q 'case "get_topic_cluster":' "$SYNC_MCP"

# ── T-MVS-S02: SEO cluster intents — frozen, distinct, single-source ────────
echo ""
echo "  [T-MVS-S02] SEO_CLUSTER_INTENTS + SEO_ALL_INTENTS shape + pillar"

cluster_count="$(node --input-type=module -e "
  const m = await import('file://${INTENT_MOD}');
  console.log(m.SEO_CLUSTER_INTENTS.length);
" 2>/dev/null)"
assert_status 0 "cluster intents length == 10" bash -c "[[ '$cluster_count' == '10' ]]"

all_count="$(node --input-type=module -e "
  const m = await import('file://${INTENT_MOD}');
  console.log(m.SEO_ALL_INTENTS.length);
" 2>/dev/null)"
assert_status 0 "all intents length == 11 (pillar + 10 clusters)" bash -c "[[ '$all_count' == '11' ]]"

pillar="$(node --input-type=module -e "
  const m = await import('file://${INTENT_MOD}');
  console.log(m.SEO_PILLAR_INTENT);
" 2>/dev/null)"
assert_status 0 "pillar intent is pillar-overview" bash -c "[[ '$pillar' == 'pillar-overview' ]]"

frozen="$(node --input-type=module -e "
  const m = await import('file://${INTENT_MOD}');
  console.log(Object.isFrozen(m.SEO_CLUSTER_INTENTS) && Object.isFrozen(m.SEO_ALL_INTENTS));
" 2>/dev/null)"
assert_status 0 "intent arrays are frozen" bash -c "[[ '$frozen' == 'true' ]]"

# Cross-reference: every intent in SEO_ALL_INTENTS must appear in the
# seo_manager.md cluster-intent table.
missing="$(python3 -c "
import re, json, subprocess
slugs = subprocess.check_output(['node','--input-type=module','-e',
  \"const m = await import('file://${INTENT_MOD}'); console.log(JSON.stringify([...m.SEO_ALL_INTENTS]));\"
], text=True).strip()
slugs = json.loads(slugs)
mgr = open('${MANAGER}').read()
mgr_slugs = set(re.findall(r'\`([a-z][a-z0-9-]+)\`', mgr))
missing = [s for s in slugs if s not in mgr_slugs]
print(','.join(missing) if missing else 'OK')
")"
assert_status 0 "every SEO_ALL_INTENTS slug exists in seo_manager.md" \
  bash -c "[[ '$missing' == 'OK' ]]"

# ── Set up an isolated sandbox + drive the MCP via stdio JSON-RPC ───────────
SBOX="$(mktemp -d -t e88-XXXXXX)"
on_exit 'rm -rf "$SBOX"'
mkdir -p "${SBOX}/proj/.ai"

# Seed the schema by opening the DB once via state-db.js (CREATE IF NOT EXISTS).
AIDIR="${SBOX}/proj/.ai" REPO_ROOT="${REPO_ROOT}" node --no-warnings --input-type=module -e "
  const { getDb, regenerateViews } = await import(\`\${process.env.REPO_ROOT}/src/mcp/shared/state-db.js\`);
  const db = getDb(process.env.AIDIR);
  regenerateViews(process.env.AIDIR, db);
" 2>/dev/null

# Confirm both new tables exist after the seed.
sqlite_check() {
  node --no-warnings --input-type=module -e "
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync('${SBOX}/proj/.ai/state.sqlite');
    const t = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all();
    console.log(t.map(r=>r.name).join(','));
    db.close();
  " 2>/dev/null
}
TABLES="$(sqlite_check)"
assert_status 0 "topic_seeds table created on first open" \
  bash -c "echo '$TABLES' | grep -q 'topic_seeds'"
assert_status 0 "cluster_pages table created on first open" \
  bash -c "echo '$TABLES' | grep -q 'cluster_pages'"
assert_status 0 "existing tasks table unchanged" \
  bash -c "echo '$TABLES' | grep -q ',tasks'"
assert_status 0 "existing stamps table unchanged" \
  bash -c "echo '$TABLES' | grep -q ',stamps'"

# Helper: drive a tool from the SBOX cwd so the MCP resolves .ai relative there.
_call() {
  # $1=tool, $2=args JSON
  ( cd "${SBOX}/proj" && mcp_call_tool "$SYNC_MCP" "$1" "$2" )
}

# Convenience: extract the text content from a JSON-RPC result.
_text() {
  python3 -c "
import json, sys
d = json.loads(sys.stdin.read() or '{}')
print('\n'.join(c.get('text','') for c in (d.get('content') or [])))
"
}

# ── T-MVS-S03: tools/list advertises all four new tools ─────────────────────
echo ""
echo "  [T-MVS-S03] tools/list advertises the four E-88 tools"

for tool in add_topic_seed add_cluster_page report_performance get_topic_cluster; do
  ( cd "${SBOX}/proj" && mcp_assert_tool_listed "$SYNC_MCP" "$tool" )
  assert_status 0 "tools/list includes ${tool}" bash -c "[[ $? -eq 0 ]]"
done

# ── T-MVS-S04: add_topic_seed happy path ────────────────────────────────────
echo ""
echo "  [T-MVS-S04] add_topic_seed creates TS-1 and returns the row"

resp="$(_call add_topic_seed '{"term":"ai testing","target_volume":10}')"
text="$(echo "$resp" | _text)"
assert_status 0 "response confirms TS-1 created"        bash -c "echo '$text' | grep -q 'TopicSeed TS-1'"
assert_status 0 "response includes term"                bash -c "echo '$text' | grep -q '\"term\": \"ai testing\"'"
assert_status 0 "response includes target_volume=10"    bash -c "echo '$text' | grep -q '\"target_volume\": 10'"

# ── T-MVS-S05: add_topic_seed input validation ──────────────────────────────
echo ""
echo "  [T-MVS-S05] add_topic_seed rejects bad inputs"

for tuple in \
  'empty:{"term":""}:INVALID_TOPIC_TERM' \
  'oversize:{"term":"'"$(python3 -c 'print("x"*300)')"'"}:INVALID_TOPIC_TERM' \
  'shellmeta:{"term":"ai`rm -rf /`"}:INVALID_TOPIC_TERM' \
  'newline:{"term":"line1\nline2"}:INVALID_TOPIC_TERM' \
  'tv_zero:{"term":"ok","target_volume":0}:INVALID_TARGET_VOLUME' \
  'tv_huge:{"term":"ok","target_volume":99}:INVALID_TARGET_VOLUME'; do
  label="${tuple%%:*}"
  rest="${tuple#*:}"
  args="${rest%:*}"
  want="${tuple##*:}"
  resp="$(_call add_topic_seed "$args")"
  text="$(echo "$resp" | _text)"
  assert_status 0 "case=${label} → ${want}" bash -c "echo '$text' | grep -q '${want}'"
done

# ── T-MVS-S06: add_cluster_page happy path (Pillar) ─────────────────────────
echo ""
echo "  [T-MVS-S06] add_cluster_page attaches CP-1 (pillar-overview) to TS-1"

resp="$(_call add_cluster_page '{"seed_id":"TS-1","intent_type":"pillar-overview","content_blob":"# AI Testing: The Complete Guide"}')"
text="$(echo "$resp" | _text)"
assert_status 0 "response confirms CP-1 created" bash -c "echo '$text' | grep -q 'ClusterPage CP-1'"
assert_status 0 "response carries intent_type=pillar-overview" bash -c "echo '$text' | grep -q 'pillar-overview'"

# ── T-MVS-S07: add_cluster_page rejects unknown intent_type ─────────────────
echo ""
echo "  [T-MVS-S07] Unknown intent_type → UNKNOWN_INTENT_TYPE"

resp="$(_call add_cluster_page '{"seed_id":"TS-1","intent_type":"bogus-shape"}')"
text="$(echo "$resp" | _text)"
assert_status 0 "rejects bogus slug"           bash -c "echo '$text' | grep -q 'UNKNOWN_INTENT_TYPE'"
assert_status 0 "error mentions canonical set" bash -c "echo '$text' | grep -q 'cost'"

# ── T-MVS-S08: add_cluster_page enforces FK (seed must exist) ───────────────
echo ""
echo "  [T-MVS-S08] seed_id must exist → SEED_NOT_FOUND"

resp="$(_call add_cluster_page '{"seed_id":"TS-999","intent_type":"how-to"}')"
text="$(echo "$resp" | _text)"
assert_status 0 "missing seed → SEED_NOT_FOUND" bash -c "echo '$text' | grep -q 'SEED_NOT_FOUND'"

# Bad seed_id format
resp="$(_call add_cluster_page '{"seed_id":"notakey","intent_type":"how-to"}')"
text="$(echo "$resp" | _text)"
assert_status 0 "malformed seed_id → INVALID_SEED_ID" bash -c "echo '$text' | grep -q 'INVALID_SEED_ID'"

# ── T-MVS-S09: cannibalization guard ((seed_id, intent_type) uniqueness) ─────
echo ""
echo "  [T-MVS-S09] Duplicate (seed_id, intent_type) → INTENT_ALREADY_USED"

resp="$(_call add_cluster_page '{"seed_id":"TS-1","intent_type":"pillar-overview"}')"
text="$(echo "$resp" | _text)"
assert_status 0 "duplicate intent rejected" bash -c "echo '$text' | grep -q 'INTENT_ALREADY_USED'"

# ── T-MVS-S10: lifted cluster-page cap ──────────────────────────────────────
echo ""
echo "  [T-MVS-S10] 1 Pillar + 10 Cluster pages; cap gate present"

# Fill all 10 distinct cluster intents (CP-1 is the pillar already).
for slug in cost comparison how-to process alternatives best-for-use-case \
             benefits requirements mistakes faq; do
  _call add_cluster_page "{\"seed_id\":\"TS-1\",\"intent_type\":\"${slug}\"}" >/dev/null
done

# TS-1 now holds 1 pillar + 10 cluster pages = 11 total; cluster pages == 10
# (the cap). An 11th cluster page would require an 11th cluster intent, which
# does not exist by design — UNKNOWN_INTENT_TYPE fires first — so the cap is
# structurally bounded by the intent taxonomy. We assert the counts + the
# constant + the source gate.
total="$(node --no-warnings --input-type=module -e "
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('${SBOX}/proj/.ai/state.sqlite');
  console.log(db.prepare(\"SELECT COUNT(*) as n FROM cluster_pages WHERE seed_id='TS-1'\").get().n);
  db.close();
" 2>/dev/null)"
assert_status 0 "TS-1 holds exactly 11 pages (1 pillar + 10 cluster)" bash -c "[[ '$total' == '11' ]]"

cluster="$(node --no-warnings --input-type=module -e "
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('${SBOX}/proj/.ai/state.sqlite');
  console.log(db.prepare(\"SELECT COUNT(*) as n FROM cluster_pages WHERE seed_id='TS-1' AND intent_type != 'pillar-overview'\").get().n);
  db.close();
" 2>/dev/null)"
assert_status 0 "TS-1 holds exactly 10 cluster pages (at cap)" bash -c "[[ '$cluster' == '10' ]]"

assert_status 0 "MAX_CLUSTER_PAGES_PER_SEED constant is 10" \
  bash -c "node --input-type=module -e \"
    const m = await import('file://${INTENT_MOD}');
    console.log(m.MAX_CLUSTER_PAGES_PER_SEED);
  \" 2>/dev/null | grep -q '^10$'"
assert_status 0 "CLUSTER_CAP_REACHED gate present in source" \
  grep -q 'CLUSTER_CAP_REACHED' "$SYNC_MCP"

# ── T-MVS-S11: report_performance merge semantics ───────────────────────────
echo ""
echo "  [T-MVS-S11] report_performance merges JSON keys; idempotent on repeat"

resp="$(_call report_performance '{"page_id":"CP-1","metrics":{"clicks":120,"impressions":4500}}')"
text="$(echo "$resp" | _text)"
assert_status 0 "first call records both metrics" \
  bash -c "echo '$text' | grep -q '\"clicks\": 120'"
assert_status 0 "first call records impressions"  \
  bash -c "echo '$text' | grep -q '\"impressions\": 4500'"

# Second call: add ctr; existing keys remain.
resp="$(_call report_performance '{"page_id":"CP-1","metrics":{"ctr":0.027,"clicks":135}}')"
text="$(echo "$resp" | _text)"
assert_status 0 "second call merges ctr key" bash -c "echo '$text' | grep -q '\"ctr\": 0.027'"
assert_status 0 "second call updates clicks" bash -c "echo '$text' | grep -q '\"clicks\": 135'"
assert_status 0 "previous impressions key preserved" \
  bash -c "echo '$text' | grep -q '\"impressions\": 4500'"

# Bad inputs.
resp="$(_call report_performance '{"page_id":"not-cp","metrics":{}}')"
text="$(echo "$resp" | _text)"
assert_status 0 "malformed page_id → INVALID_PAGE_ID" \
  bash -c "echo '$text' | grep -q 'INVALID_PAGE_ID'"

resp="$(_call report_performance '{"page_id":"CP-999","metrics":{"clicks":1}}')"
text="$(echo "$resp" | _text)"
assert_status 0 "unknown page_id → PAGE_NOT_FOUND" \
  bash -c "echo '$text' | grep -q 'PAGE_NOT_FOUND'"

resp="$(_call report_performance '{"page_id":"CP-1","metrics":"not-an-object"}')"
text="$(echo "$resp" | _text)"
assert_status 0 "non-object metrics → INVALID_METRICS" \
  bash -c "echo '$text' | grep -q 'INVALID_METRICS'"

# ── T-MVS-S12: get_topic_cluster returns nested envelope ────────────────────
echo ""
echo "  [T-MVS-S12] get_topic_cluster returns {seed, pages[], counts}"

resp="$(_call get_topic_cluster '{"seed_id":"TS-1"}')"
text="$(echo "$resp" | _text)"
assert_status 0 "envelope carries the seed object"   bash -c "echo '$text' | grep -q '\"seed\":'"
assert_status 0 "envelope carries pages array"       bash -c "echo '$text' | grep -q '\"pages\":'"
assert_status 0 "counts.total == 11"                 bash -c "echo '$text' | grep -q '\"total\": 11'"
assert_status 0 "counts.pillar == 1"                 bash -c "echo '$text' | grep -q '\"pillar\": 1'"
assert_status 0 "counts.cluster == 10"               bash -c "echo '$text' | grep -q '\"cluster\": 10'"
assert_status 0 "counts.remaining == 0"              bash -c "echo '$text' | grep -q '\"remaining\": 0'"
assert_status 0 "performance_metrics is parsed JSON" bash -c "echo '$text' | grep -q '\"ctr\": 0.027'"

# Missing seed
resp="$(_call get_topic_cluster '{"seed_id":"TS-999"}')"
text="$(echo "$resp" | _text)"
assert_status 0 "missing seed → SEED_NOT_FOUND" \
  bash -c "echo '$text' | grep -q 'SEED_NOT_FOUND'"

# ── T-MVS-S13: Legacy-schema migration preserves rows ───────────────────────
echo ""
echo "  [T-MVS-S13] keyword_seeds/content_variations migrate to topic_seeds/cluster_pages"

MBOX="$(mktemp -d -t e88mig-XXXXXX)"
mkdir -p "${MBOX}/.ai"
# Build a legacy-schema DB with one seed + one variation (approach_type).
node --no-warnings --input-type=module -e "
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync('${MBOX}/.ai/state.sqlite');
  db.exec(\`
    CREATE TABLE keyword_seeds(id TEXT PRIMARY KEY, term TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN', target_volume INTEGER NOT NULL DEFAULT 20 CHECK(target_volume>0 AND target_volume<=20), created_at TEXT NOT NULL, completed_at TEXT);
    CREATE TABLE content_variations(id TEXT PRIMARY KEY, seed_id TEXT NOT NULL, approach_type TEXT NOT NULL, content_blob TEXT, performance_metrics TEXT, published_at TEXT, created_at TEXT NOT NULL, FOREIGN KEY(seed_id) REFERENCES keyword_seeds(id) ON DELETE CASCADE);
    CREATE INDEX idx_variations_seed ON content_variations(seed_id);
    CREATE INDEX idx_variations_approach ON content_variations(seed_id, approach_type);
  \`);
  db.prepare('INSERT INTO keyword_seeds(id,term,status,target_volume,created_at) VALUES (?,?,?,?,?)').run('KS-1','legacy seed','OPEN',20,new Date().toISOString());
  db.prepare('INSERT INTO content_variations(id,seed_id,approach_type,created_at) VALUES (?,?,?,?)').run('CV-1','KS-1','listicle',new Date().toISOString());
  db.close();
" 2>/dev/null

# Open via state-db.js getDb — runs the in-place migration.
MIG="$(AIDIR="${MBOX}/.ai" REPO_ROOT="${REPO_ROOT}" node --no-warnings --input-type=module -e "
  const { getDb } = await import(\`\${process.env.REPO_ROOT}/src/mcp/shared/state-db.js\`);
  const db = getDb(process.env.AIDIR);
  const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name);
  const cols = db.prepare('PRAGMA table_info(cluster_pages)').all().map(c=>c.name);
  const seedTerm = db.prepare('SELECT term FROM topic_seeds WHERE id=?').get('KS-1')?.term;
  const pageIntent = db.prepare('SELECT intent_type FROM cluster_pages WHERE id=?').get('CV-1')?.intent_type;
  console.log(JSON.stringify({
    renamed: tables.includes('topic_seeds') && tables.includes('cluster_pages') && !tables.includes('keyword_seeds') && !tables.includes('content_variations'),
    intentCol: cols.includes('intent_type') && !cols.includes('approach_type'),
    seedTerm, pageIntent,
  }));
" 2>/dev/null)"
assert_status 0 "legacy tables renamed (topic_seeds + cluster_pages)" \
  bash -c "echo '$MIG' | grep -q '\"renamed\":true'"
assert_status 0 "approach_type column renamed to intent_type" \
  bash -c "echo '$MIG' | grep -q '\"intentCol\":true'"
assert_status 0 "legacy seed row preserved" \
  bash -c "echo '$MIG' | grep -q '\"seedTerm\":\"legacy seed\"'"
assert_status 0 "legacy variation row preserved as cluster page" \
  bash -c "echo '$MIG' | grep -q '\"pageIntent\":\"listicle\"'"
rm -rf "$MBOX"

# ── T-MVS-S14: No regression of existing tools (tasks path) ─────────────────
echo ""
echo "  [T-MVS-S14] Existing add_task / update_task_status still work"

resp="$(_call add_task '{"owner":"Engineer (Claude)","description":"e88 regression smoke","tier":1}')"
text="$(echo "$resp" | _text)"
assert_status 0 "add_task still works" bash -c "echo '$text' | grep -q 'Added E-'"

new_id="$(echo "$text" | grep -oE 'E-[0-9]+' | head -1)"
resp="$(_call update_task_status "{\"id\":\"${new_id}\",\"status\":\"DONE\",\"summary\":\"regression\"}")"
text="$(echo "$resp" | _text)"
assert_status 0 "update_task_status still works" \
  bash -c "echo '$text' | grep -q '${new_id} → DONE'"

# ── T-MVS-S15: Mirror byte-identity ─────────────────────────────────────────
echo ""
echo "  [T-MVS-S15] ~/.ai-os mirrors match src/"

assert_status 0 "task-synchronizer-mcp mirror"   diff -q "$SYNC_MCP" "${HOME}/.ai-os/mcp/task-synchronizer-mcp/index.js"
assert_status 0 "state-db.js mirror"             diff -q "$STATE_DB" "${HOME}/.ai-os/mcp/shared/state-db.js"
assert_status 0 "seo-cluster-intents.mjs mirror" diff -q "$INTENT_MOD" "${HOME}/.ai-os/shared/seo-cluster-intents.mjs"

echo ""

# ── E-87 (from seo_manager_test — E-302): SEO-Topic-Cluster-Manager agent ──
# Verifies src/claude/agents/seo_manager.md against the contract in
# .ai/blueprints/seo-keyword-multiplier.md (SEO Topic Cluster Engine):
#   - §Components 1 (SEO-Topic-Cluster-Manager) — orchestration only
#   - §API generateTopicCluster(term) -> task_ids[]
#   - §Execution Constraints (1 Pillar + ≤10 Cluster pages, concurrency 3, <120s)
AGENT_SRC="${REPO_ROOT}/src/claude/agents/seo_manager.md"
AGENT_CLAUDE="${REPO_ROOT}/.claude/agents/seo_manager.md"
AGENT_MIRROR="${HOME}/.ai-os/claude/agents/seo_manager.md"
BLUEPRINT="${REPO_ROOT}/.ai/blueprints/seo-keyword-multiplier.md"


# ── T-SEO-S01: File presence + frontmatter ───────────────────────────────────
echo ""
echo "  [T-SEO-S01] Agent file exists with parseable YAML frontmatter"

assert_status 0 "src/ agent file exists"             test -f "$AGENT_SRC"
assert_status 0 ".claude/ mirror exists"             test -f "$AGENT_CLAUDE"
assert_status 0 "frontmatter opens on line 1"        bash -c "head -1 '$AGENT_SRC' | grep -q '^---$'"
assert_status 0 "name: seo_manager"                  grep -q '^name: seo_manager$' "$AGENT_SRC"
assert_status 0 "description present"                grep -q '^description: ' "$AGENT_SRC"
assert_status 0 "description is double-quoted (no colon-parse trap)" \
  bash -c "head -10 '$AGENT_SRC' | grep -q '^description: \"'"
assert_status 0 "blueprint reference present"        grep -q "seo-keyword-multiplier.md" "$AGENT_SRC"
assert_status 0 "frontmatter has a closing --- delimiter" \
  bash -c "awk 'NR>1 && /^---$/{print NR; exit}' '$AGENT_SRC' | grep -qE '^[2-9]$|^[12][0-9]$|^30$'"
assert_status 0 "description value is properly quoted (no colon-parse trap)" \
  python3 -c "
import re, sys
with open('$AGENT_SRC') as f:
    head = ''.join(f.readlines()[:20])
m = re.search(r'^description:\s*(.+?)\$', head, flags=re.M)
if not m:
    sys.exit(1)
val = m.group(1).strip()
sys.exit(0 if (val.startswith('\"') and val.endswith('\"')) or val.startswith('>') or val.startswith('|') else 2)
"

# ── T-SEO-S02: Blueprint contract sections ───────────────────────────────────
echo ""
echo "  [T-SEO-S02] Agent body references every blueprint contract section"

assert_status 0 "ROLE declaration"                   grep -q '^ROLE: SEO_MANAGER' "$AGENT_SRC"
assert_status 0 "Forbidden section"                  grep -q '^## Forbidden' "$AGENT_SRC"
assert_status 0 "Preflight section"                  grep -q '^## Preflight' "$AGENT_SRC"
assert_status 0 "API contract section"               grep -q 'generateTopicCluster(term: string)' "$AGENT_SRC"
assert_status 0 "Execution Constraints section"      grep -q '^## Execution Constraints' "$AGENT_SRC"
assert_status 0 "Rollback section"                   grep -q '^## Rollback' "$AGENT_SRC"
assert_status 0 "What this agent is NOT (anti-drift)" grep -q '^## What this agent is NOT' "$AGENT_SRC"

# ── T-SEO-S03: Pillar + canonical Cluster intents ────────────────────────────
echo ""
echo "  [T-SEO-S03] The agent enumerates 1 Pillar + 10 distinct Cluster intents"

# Count numbered rows in the cluster-intent table (0 = Pillar, 1..10 = Cluster).
count="$(awk '/^## The Canonical Cluster Intents/,/^## Step 1/' "$AGENT_SRC" \
  | grep -cE '^\| *[0-9]+ *\|')"
assert_status 0 "exactly 11 rows in the intent table (pillar + 10)" bash -c "[[ $count -eq 11 ]]"

# Pillar + a few intents the blueprint calls out (§Goal: pillar, cost, comparison, process).
for slug in pillar-overview cost comparison process; do
  assert_status 0 "intent table includes \`${slug}\`" \
    grep -qE "\`${slug}\`" "$AGENT_SRC"
done

# Distinctness — every intent slug in the table is unique.
uniq_count="$(awk '/^## The Canonical Cluster Intents/,/^## Step 1/' "$AGENT_SRC" \
  | grep -oE '`[a-z][a-z0-9-]+`' \
  | sort -u | wc -l | tr -d ' ')"
assert_status 0 "all intent slugs are distinct (≥ 11 unique)" \
  bash -c "[[ $uniq_count -ge 11 ]]"

# ── T-SEO-S04: Anti-drift mandates (Forbidden + What this agent is NOT) ──────
echo ""
echo "  [T-SEO-S04] Agent forbids content generation and state tracking"

assert_status 0 "Forbidden: no content generation" \
  bash -c "awk '/^## Forbidden/,/^## Preflight/' '$AGENT_SRC' | grep -qi 'generate article content'"
assert_status 0 "Forbidden: no state tracking" \
  bash -c "awk '/^## Forbidden/,/^## Preflight/' '$AGENT_SRC' | grep -qi 'page performance'"
assert_status 0 "Forbidden: cap on MAX_CLUSTER_PAGES_PER_SEED" \
  bash -c "awk '/^## Forbidden/,/^## Preflight/' '$AGENT_SRC' | grep -q 'MAX_CLUSTER_PAGES_PER_SEED'"
assert_status 0 "References the SEO-Content-Generator downstream owner" \
  grep -q 'SEO-Content-Generator' "$AGENT_SRC"
assert_status 0 "References the Multi-Variation-State-Tracker owner" \
  grep -q 'Multi-Variation-State-Tracker' "$AGENT_SRC"
assert_status 0 "References the SEO-Engineer persona (E-90)" \
  grep -q 'SEO-Engineer' "$AGENT_SRC"

# ── T-SEO-S05: Execution Constraints carry the blueprint's exact numbers ─────
echo ""
echo "  [T-SEO-S05] Concurrency 3 / cluster cap / 120s budget surfaced verbatim"

assert_status 0 "concurrency=3 referenced" \
  bash -c "awk '/^## Execution Constraints/,/^## Rollback/' '$AGENT_SRC' | grep -qE 'batches of 3|concurrency.*3'"
assert_status 0 "cluster-page cap referenced" \
  bash -c "awk '/^## Execution Constraints/,/^## Rollback/' '$AGENT_SRC' | grep -qE '10 Cluster pages|11th Cluster'"
assert_status 0 "120-second performance budget referenced" \
  bash -c "awk '/^## Execution Constraints/,/^## Rollback/' '$AGENT_SRC' | grep -q '120s'"

# ── T-SEO-S06: API contract — add_task example references the right tool ─────
echo ""
echo "  [T-SEO-S06] Step 3 wires task-synchronizer-mcp::add_task"

assert_status 0 "Step 3 names add_task tool" \
  grep -q 'mcp__task-synchronizer-mcp__add_task' "$AGENT_SRC"
assert_status 0 "Step 2 persists the seed via add_topic_seed" \
  grep -q 'mcp__task-synchronizer-mcp__add_topic_seed' "$AGENT_SRC"
assert_status 0 "Step 3 specifies tier:2 (per blueprint)" \
  bash -c "awk '/^## Step 3/,/^## Step 4/' '$AGENT_SRC' | grep -q 'tier: *2'"
assert_status 0 "Step 3 uses canonical description prefix" \
  bash -c "awk '/^## Step 3/,/^## Step 4/' '$AGENT_SRC' | grep -q 'SEO cluster page:'"
assert_status 0 "Step 5 returns task_ids[] per blueprint API" \
  bash -c "awk '/^## Step 5/,/^## Step 6/' '$AGENT_SRC' | grep -q 'task_ids'"

# ── T-SEO-S07: Input validation (security — untrusted keyword term) ──────────
echo ""
echo "  [T-SEO-S07] Untrusted keyword input handled per blueprint §Security"

assert_status 0 "Preflight asserts length cap on term" \
  bash -c "awk '/^## Preflight/,/^## API/' '$AGENT_SRC' | grep -qE '256 chars|256 character'"
assert_status 0 "Preflight rejects shell metacharacters" \
  bash -c "awk '/^## Preflight/,/^## API/' '$AGENT_SRC' | grep -q 'shell metacharacters'"
assert_status 0 "INVALID_TOPIC_TERM error tag documented" \
  grep -q 'INVALID_TOPIC_TERM' "$AGENT_SRC"

# ── T-SEO-S08: Rollback section maps to blueprint §Rollback Plan ─────────────
echo ""
echo "  [T-SEO-S08] Rollback section is actionable"

assert_status 0 "Rollback names update_task_status as the unwind tool" \
  bash -c "awk '/^## Rollback/,/^## What this agent is NOT/' '$AGENT_SRC' | grep -q 'update_task_status'"
assert_status 0 "Rollback acknowledges content-file purge is out-of-scope" \
  bash -c "awk '/^## Rollback/,/^## What this agent is NOT/' '$AGENT_SRC' | grep -qE 'git restore|content files'"

# ── T-SEO-S09: Mirror byte-identity ──────────────────────────────────────────
echo ""
echo "  [T-SEO-S09] .claude/ + ~/.ai-os/claude/ mirrors match src/"

assert_status 0 ".claude/ mirror byte-identical to src/" \
  diff -q "$AGENT_SRC" "$AGENT_CLAUDE"
if [[ -f "$AGENT_MIRROR" ]]; then
  # E-248 (D-067 §2): the installed copy is canonical — byte identity, and the three
  # Claude agent-contract keys PRESENT (they tell Claude Code what the agent may do).
  assert_status 0 "~/.ai-os copy is byte-identical to src/ (the mirror is canonical)" \
    diff -q "$AGENT_SRC" "$AGENT_MIRROR"
  assert_status 0 "~/.ai-os copy KEEPS the Claude-only keys (E-248)" \
    grep -qE '^(disable-model-invocation|user-invocable|allowed-tools):' "$AGENT_MIRROR"
else
  # E-236: an absent install is a SKIP, counted separately from PASS — a pass here would
  # claim the mirror had been verified when nothing was compared.
  _skip "~/.ai-os copy comparison (framework not installed)"
fi

# ── T-SEO-S10: Blueprint file presence + bidirectional reference ─────────────
echo ""
echo "  [T-SEO-S10] Blueprint file referenced in agent and vice versa"

assert_status 0 "blueprint file exists"               test -f "$BLUEPRINT"
assert_status 0 "blueprint names E-87 + seo_manager.md target" \
  grep -q "E-87.*seo_manager.md" "$BLUEPRINT"
assert_status 0 "agent description references the blueprint path" \
  grep -q "seo-keyword-multiplier.md" "$AGENT_SRC"

echo ""

# ── E-90 (from seo_engineer_test — E-302): SEO-Engineer Claude persona ──
# Verifies src/claude/agents/seo_engineer.md against the contract in
# .ai/blueprints/seo-keyword-multiplier.md §Components 4:
#   - Technical SEO persona: meta tags, JSON-LD structured data,
#     canonical URLs, pillar↔cluster internal linking
#   - Anti-drift: NOT content generation (generator), NOT orchestration
AGENT_SRC_SE="${REPO_ROOT}/src/claude/agents/seo_engineer.md"
AGENT_CLAUDE_SE="${REPO_ROOT}/.claude/agents/seo_engineer.md"
AGENT_MIRROR_SE="${HOME}/.ai-os/claude/agents/seo_engineer.md"
BLUEPRINT_SE="${REPO_ROOT}/.ai/blueprints/seo-keyword-multiplier.md"


# ── T-SENG-S01: File presence + frontmatter ──────────────────────────────────
echo ""
echo "  [T-SENG-S01] Persona file exists with parseable YAML frontmatter"

assert_status 0 "src/ persona file exists"           test -f "$AGENT_SRC_SE"
assert_status 0 ".claude/ mirror exists"             test -f "$AGENT_CLAUDE_SE"
assert_status 0 "frontmatter opens on line 1"        bash -c "head -1 '$AGENT_SRC_SE' | grep -q '^---$'"
assert_status 0 "name: seo_engineer"                 grep -q '^name: seo_engineer$' "$AGENT_SRC_SE"
assert_status 0 "description present"                grep -q '^description: ' "$AGENT_SRC_SE"
assert_status 0 "description is double-quoted (no colon-parse trap)" \
  bash -c "head -10 '$AGENT_SRC_SE' | grep -q '^description: \"'"
assert_status 0 "tools allowlist declared (E-295)"   grep -q '^tools:' "$AGENT_SRC_SE"
assert_status 0 "allowed-tools permit Write/Edit (implements code)" \
  bash -c "grep '^tools:' '$AGENT_SRC_SE' | grep -qE 'Write|Edit'"
assert_status 0 "blueprint reference present"        grep -q "seo-keyword-multiplier.md" "$AGENT_SRC_SE"
assert_status 0 "frontmatter has a closing --- delimiter" \
  bash -c "awk 'NR>1 && /^---$/{print NR; exit}' '$AGENT_SRC_SE' | grep -qE '^[2-9]$|^[12][0-9]$|^30$'"
assert_status 0 "description value is properly quoted (no colon-parse trap)" \
  python3 -c "
import re, sys
with open('$AGENT_SRC_SE') as f:
    head = ''.join(f.readlines()[:20])
m = re.search(r'^description:\s*(.+?)\$', head, flags=re.M)
if not m:
    sys.exit(1)
val = m.group(1).strip()
sys.exit(0 if (val.startswith('\"') and val.endswith('\"')) or val.startswith('>') or val.startswith('|') else 2)
"

# ── T-SENG-S02: Required contract sections ───────────────────────────────────
echo ""
echo "  [T-SENG-S02] Persona body covers every required section"

assert_status 0 "ROLE declaration"                   grep -q '^ROLE: SEO_ENGINEER' "$AGENT_SRC_SE"
assert_status 0 "Forbidden section"                  grep -q '^## Forbidden' "$AGENT_SRC_SE"
assert_status 0 "Preflight section"                  grep -q '^## Preflight' "$AGENT_SRC_SE"
assert_status 0 "Technical SEO Standards section"    grep -q '^## Technical SEO Standards' "$AGENT_SRC_SE"
assert_status 0 "Execution Constraints section"      grep -q '^## Execution Constraints' "$AGENT_SRC_SE"
assert_status 0 "Rollback section"                   grep -q '^## Rollback' "$AGENT_SRC_SE"
assert_status 0 "What this agent is NOT (anti-drift)" grep -q '^## What this agent is NOT' "$AGENT_SRC_SE"

# ── T-SENG-S03: Technical SEO standards enforced ─────────────────────────────
echo ""
echo "  [T-SENG-S03] Persona enforces meta tags, JSON-LD, canonicals, linking"

assert_status 0 "meta tags (title + meta description)" \
  bash -c "grep -qiE 'meta description|meta tags' '$AGENT_SRC_SE'"
assert_status 0 "Open Graph / Twitter card tags" \
  bash -c "grep -qiE 'Open Graph|og:title|Twitter Card' '$AGENT_SRC_SE'"
assert_status 0 "canonical URL"                      grep -qi 'canonical' "$AGENT_SRC_SE"
assert_status 0 "JSON-LD structured data"            grep -q 'JSON-LD' "$AGENT_SRC_SE"
assert_status 0 "schema.org types (Article/FAQPage/BreadcrumbList)" \
  bash -c "grep -qE 'FAQPage|BreadcrumbList|Article' '$AGENT_SRC_SE'"
assert_status 0 "pillar↔cluster internal linking"   \
  bash -c "grep -qiE 'internal link|Pillar .* Cluster|link graph' '$AGENT_SRC_SE'"

# ── T-SENG-S04: Anti-drift mandates ──────────────────────────────────────────
echo ""
echo "  [T-SENG-S04] Persona forbids content generation + orchestration + tracking"

assert_status 0 "Forbidden: NO article copy" \
  bash -c "awk '/^## Forbidden/,/^## Preflight/' '$AGENT_SRC_SE' | grep -qiE 'article copy|body content'"
assert_status 0 "Forbidden: NO orchestration (E-87)" \
  bash -c "awk '/^## Forbidden/,/^## Preflight/' '$AGENT_SRC_SE' | grep -qE 'orchestrate|SEO-Topic-Cluster-Manager'"
assert_status 0 "Forbidden: NO state tracking" \
  bash -c "awk '/^## Forbidden/,/^## Preflight/' '$AGENT_SRC_SE' | grep -qE 'performance|Multi-Variation-State-Tracker'"
assert_status 0 "References the SEO-Content-Generator owner" \
  grep -q 'SEO-Content-Generator' "$AGENT_SRC_SE"
assert_status 0 "References E-87 orchestrator by id" \
  grep -q 'E-87' "$AGENT_SRC_SE"

# ── T-SENG-S05: Security — untrusted input handling ──────────────────────────
echo ""
echo "  [T-SENG-S05] Topic term treated as untrusted (escape before emit)"

assert_status 0 "untrusted-input handling documented" \
  bash -c "grep -qiE 'untrusted|escape|encode' '$AGENT_SRC_SE'"
assert_status 0 "SEO_ENGINEER_BLOCKED finding tag documented" \
  grep -q 'SEO_ENGINEER_BLOCKED' "$AGENT_SRC_SE"

# ── T-SENG-S06: Idempotency constraint ───────────────────────────────────────
echo ""
echo "  [T-SENG-S06] Execution Constraints require idempotent wiring"

assert_status 0 "idempotent re-run constraint" \
  bash -c "awk '/^## Execution Constraints/,/^## Rollback/' '$AGENT_SRC_SE' | grep -qi 'idempotent'"

# ── T-SENG-S07: Rollback section is actionable ───────────────────────────────
echo ""
echo "  [T-SENG-S07] Rollback maps to git restore of modified files"

assert_status 0 "Rollback references git restore" \
  bash -c "awk '/^## Rollback/,/^## What this agent is NOT/' '$AGENT_SRC_SE' | grep -q 'git restore'"

# ── T-SENG-S08: Mirror byte-identity ─────────────────────────────────────────
echo ""
echo "  [T-SENG-S08] .claude/ + ~/.ai-os/claude/ mirrors match src/"

assert_status 0 ".claude/ mirror byte-identical to src/" \
  diff -q "$AGENT_SRC_SE" "$AGENT_CLAUDE_SE"
if [[ -f "$AGENT_MIRROR_SE" ]]; then
  assert_status 0 "~/.ai-os mirror byte-identical to src/" \
    diff -q "$AGENT_SRC_SE" "$AGENT_MIRROR_SE"
else
  echo "    ⚠  ~/.ai-os mirror absent — skipping"
fi

# ── T-SENG-S09: Bidirectional blueprint reference ────────────────────────────
echo ""
echo "  [T-SENG-S09] Blueprint names E-90 + the persona references the blueprint"

assert_status 0 "blueprint file exists"               test -f "$BLUEPRINT_SE"
assert_status 0 "blueprint names E-90 + seo_engineer.md target" \
  grep -q "E-90.*seo_engineer.md" "$BLUEPRINT_SE"
assert_status 0 "persona description references the blueprint path" \
  grep -q "seo-keyword-multiplier.md" "$AGENT_SRC_SE"

echo ""

# ── E-88 (from seo_content_generator_test — E-302): SEO-Content-Generator agent ──
# Verifies src/claude/agents/seo_content_generator.md against the contract
# in .ai/blueprints/seo-keyword-multiplier.md §Components 2 + §API:
#   - generateClusterContent(seed_id, intent_type) → content_blob
#   - Honors §Execution Constraints (120s, concurrency 3, cluster cap)
#   - Honors §Security (duplicate-content, identity_guardian, critic_security)
AGENT_SRC_SG="${REPO_ROOT}/src/claude/agents/seo_content_generator.md"
AGENT_CLAUDE_SG="${REPO_ROOT}/.claude/agents/seo_content_generator.md"
AGENT_MIRROR_SG="${HOME}/.ai-os/claude/agents/seo_content_generator.md"
MANAGER_SRC="${REPO_ROOT}/src/claude/agents/seo_manager.md"
BLUEPRINT_SG="${REPO_ROOT}/.ai/blueprints/seo-keyword-multiplier.md"


# ── T-SCG-S01: Presence + frontmatter integrity ──────────────────────────────
echo ""
echo "  [T-SCG-S01] Agent file exists with parseable frontmatter"

assert_status 0 "src/ agent file exists"             test -f "$AGENT_SRC_SG"
assert_status 0 ".claude/ mirror exists"             test -f "$AGENT_CLAUDE_SG"
assert_status 0 "frontmatter opens on line 1"        bash -c "head -1 '$AGENT_SRC_SG' | grep -q '^---$'"
assert_status 0 "name: seo_content_generator"        grep -q '^name: seo_content_generator$' "$AGENT_SRC_SG"
assert_status 0 "description present"                grep -q '^description: ' "$AGENT_SRC_SG"
assert_status 0 "description is double-quoted"       \
  bash -c "head -10 '$AGENT_SRC_SG' | grep -q '^description: \"'"
assert_status 0 "blueprint reference in description" grep -q "seo-keyword-multiplier.md" "$AGENT_SRC_SG"
assert_status 0 "frontmatter has closing delimiter within first 30 lines" \
  bash -c "awk 'NR>1 && /^---$/{print NR; exit}' '$AGENT_SRC_SG' | grep -qE '^[2-9]$|^[12][0-9]$|^30$'"
assert_status 0 "description value uses safe quoting (no colon-parse trap)" \
  python3 -c "
import re, sys
with open('$AGENT_SRC_SG') as f:
    head = ''.join(f.readlines()[:20])
m = re.search(r'^description:\s*(.+?)\$', head, flags=re.M)
if not m: sys.exit(1)
val = m.group(1).strip()
sys.exit(0 if (val.startswith('\"') and val.endswith('\"')) or val.startswith('>') or val.startswith('|') else 2)
"

# ── T-SCG-S02: Required §-sections from the blueprint ───────────────────────
echo ""
echo "  [T-SCG-S02] Agent body covers every required blueprint section"

assert_status 0 "ROLE declaration"                   grep -q '^ROLE: SEO_CONTENT_GENERATOR' "$AGENT_SRC_SG"
assert_status 0 "Forbidden section"                  grep -q '^## Forbidden' "$AGENT_SRC_SG"
assert_status 0 "Preflight section"                  grep -q '^## Preflight' "$AGENT_SRC_SG"
assert_status 0 "API contract section"               grep -q 'generateClusterContent(seed_id: string, intent_type: string)' "$AGENT_SRC_SG"
assert_status 0 "Execution Constraints section"      grep -q '^## Execution Constraints' "$AGENT_SRC_SG"
assert_status 0 "Rollback section"                   grep -q '^## Rollback' "$AGENT_SRC_SG"
assert_status 0 "What this agent is NOT (anti-drift)" grep -q '^## What this agent is NOT' "$AGENT_SRC_SG"

# ── T-SCG-S03: Cluster-intent taxonomy is single-sourced ────────────────────
echo ""
echo "  [T-SCG-S03] Generator's template table covers the canonical intents"

# Extract intent slugs from the generator's template table.
gen_count="$(awk '/^## Step 2/,/^## Step 3/' "$AGENT_SRC_SG" \
  | grep -oE '`[a-z][a-z0-9-]+`' | sort -u | wc -l | tr -d ' ')"
assert_status 0 "generator enumerates ≥ 11 distinct intent slugs (pillar + 10)" \
  bash -c "[[ $gen_count -ge 11 ]]"

# Cross-reference: every slug in the generator MUST also exist in the manager.
missing="$(python3 -c "
import re
with open('$AGENT_SRC_SG') as f:
    gen_text = f.read()
with open('$MANAGER_SRC') as f:
    mgr_text = f.read()
# Pull slugs from generator's Step 2 table.
m_block = re.search(r'## Step 2(.+?)## Step 3', gen_text, flags=re.S)
gen_slugs = set(re.findall(r'\`([a-z][a-z0-9-]+)\`', m_block.group(1) if m_block else ''))
# Pull slugs from manager's cluster-intent table.
mgr_block = re.search(r'## The Canonical Cluster Intents(.+?)## Step 1', mgr_text, flags=re.S)
mgr_slugs = set(re.findall(r'\`([a-z][a-z0-9-]+)\`', mgr_block.group(1) if mgr_block else ''))
missing = gen_slugs - mgr_slugs
print(','.join(sorted(missing)) if missing else 'OK')
")"
assert_status 0 "every generator intent exists in the manager taxonomy" \
  bash -c "[[ '$missing' == 'OK' ]]"

# ── T-SCG-S04: Anti-drift mandates ───────────────────────────────────────────
echo ""
echo "  [T-SCG-S04] Generator forbids orchestration + state tracking"

assert_status 0 "Forbidden: NO orchestration (E-87)" \
  bash -c "awk '/^## Forbidden/,/^## Preflight/' '$AGENT_SRC_SG' | grep -qE 'orchestrate|SEO-Topic-Cluster-Manager'"
assert_status 0 "Forbidden: NO state tracking" \
  bash -c "awk '/^## Forbidden/,/^## Preflight/' '$AGENT_SRC_SG' | grep -qE 'state|Multi-Variation-State-Tracker'"
assert_status 0 "Forbidden: NO publish / deploy" \
  bash -c "awk '/^## Forbidden/,/^## Preflight/' '$AGENT_SRC_SG' | grep -qiE 'publish|deploy'"
assert_status 0 "What-this-is-NOT references E-87 by id"  grep -q 'E-87' "$AGENT_SRC_SG"
assert_status 0 "References the Multi-Variation-State-Tracker"  grep -q 'Multi-Variation-State-Tracker' "$AGENT_SRC_SG"

# ── T-SCG-S05: Blueprint Execution Constraints surfaced verbatim ────────────
echo ""
echo "  [T-SCG-S05] 120s budget + concurrency 3 + 1000ms→15000ms backoff"

assert_status 0 "120-second wall-clock budget" \
  bash -c "awk '/^## Execution Constraints/,/^## Rollback/' '$AGENT_SRC_SG' | grep -q '120 seconds\\|120-second'"
assert_status 0 "concurrency cap of 3"         \
  bash -c "awk '/^## Execution Constraints/,/^## Rollback/' '$AGENT_SRC_SG' | grep -qE '3 in-flight|concurrency.*3'"
assert_status 0 "exponential backoff 1000→15000ms" \
  bash -c "awk '/^## Execution Constraints/,/^## Rollback/' '$AGENT_SRC_SG' | grep -qE '1000ms.*15000ms|1000ms → 15000ms'"
assert_status 0 "cluster cap / cannibalization defence-in-depth"      \
  bash -c "awk '/^## Execution Constraints/,/^## Rollback/' '$AGENT_SRC_SG' | grep -qE 'cannibalization|cluster-page cap'"

# ── T-SCG-S06: Security gates (duplicate-content + identity + critic) ───────
echo ""
echo "  [T-SCG-S06] Three security gates referenced per blueprint §Security"

assert_status 0 "Step 4 duplicate-content check (SHA-256 + Jaccard)" \
  grep -q 'SHA-256\|sha256' "$AGENT_SRC_SG"
assert_status 0 "Step 4 references Jaccard shingles for fuzzy match" \
  grep -q 'Jaccard' "$AGENT_SRC_SG"
assert_status 0 "DUPLICATE_REJECTED status documented" \
  grep -q 'DUPLICATE_REJECTED' "$AGENT_SRC_SG"
assert_status 0 "Step 5 invokes identity_guardian" \
  grep -q 'identity_guardian' "$AGENT_SRC_SG"
assert_status 0 "Step 5 invokes critic_security" \
  grep -q 'critic_security' "$AGENT_SRC_SG"
assert_status 0 "REVIEW_BLOCKED status documented" \
  grep -q 'REVIEW_BLOCKED' "$AGENT_SRC_SG"

# ── T-SCG-S07: Backoff / budget envelope statuses ───────────────────────────
echo ""
echo "  [T-SCG-S07] Structured status envelope on every failure path"

for status in OFFLINE UNKNOWN_INTENT_TYPE INVALID_SEED_ID RATE_LIMITED_EXHAUSTED BUDGET_EXCEEDED DUPLICATE_REJECTED REVIEW_BLOCKED; do
  assert_status 0 "status code referenced: ${status}" \
    grep -q "${status}" "$AGENT_SRC_SG"
done

# ── T-SCG-S08: QA + persistence wiring ──────────────────────────────────────
echo ""
echo "  [T-SCG-S08] QA via seo_content_checklist + stamp via add_stamp"

assert_status 0 "Step 6 activates seo_content_checklist skill" \
  grep -q 'seo_content_checklist' "$AGENT_SRC_SG"
assert_status 0 "Step 7 calls task-synchronizer-mcp::add_stamp" \
  grep -q 'task-synchronizer-mcp::add_stamp' "$AGENT_SRC_SG"
assert_status 0 "Stamp type = SEO_VARIATION_GENERATED" \
  grep -q 'SEO_VARIATION_GENERATED' "$AGENT_SRC_SG"
assert_status 0 "Stamp summary carries content_sha256 marker" \
  grep -q 'sha256=' "$AGENT_SRC_SG"

# ── T-SCG-S09: Rollback section is actionable ───────────────────────────────
echo ""
echo "  [T-SCG-S09] Rollback maps to blueprint §Rollback Plan"

assert_status 0 "Rollback names stamp deletion" \
  bash -c "awk '/^## Rollback/,/^## What this agent is NOT/' '$AGENT_SRC_SG' | grep -qE 'stamp|SEO_VARIATION_GENERATED'"
assert_status 0 "Rollback references git restore for staged content" \
  bash -c "awk '/^## Rollback/,/^## What this agent is NOT/' '$AGENT_SRC_SG' | grep -q 'git restore'"

# ── T-SCG-S10: Mirror byte-identity ─────────────────────────────────────────
echo ""
echo "  [T-SCG-S10] .claude/ + ~/.ai-os/claude/ mirrors match src/"

assert_status 0 ".claude/ mirror byte-identical to src/" \
  diff -q "$AGENT_SRC_SG" "$AGENT_CLAUDE_SG"
if [[ -f "$AGENT_MIRROR_SG" ]]; then
  # E-248 (D-067 §2): the installed copy is canonical — byte identity, and the three
  # Claude agent-contract keys PRESENT (they tell Claude Code what the agent may do).
  assert_status 0 "~/.ai-os copy is byte-identical to src/ (the mirror is canonical)" \
    diff -q "$AGENT_SRC_SG" "$AGENT_MIRROR_SG"
  assert_status 0 "~/.ai-os copy KEEPS the Claude-only keys (E-248)" \
    grep -qE '^(disable-model-invocation|user-invocable|allowed-tools):' "$AGENT_MIRROR_SG"
else
  # E-236: an absent install is a SKIP, counted separately from PASS — a pass here would
  # claim the mirror had been verified when nothing was compared.
  _skip "~/.ai-os copy comparison (framework not installed)"
fi

# ── T-SCG-S11: Blueprint reference ──────────────────────────────────────────
echo ""
echo "  [T-SCG-S11] Blueprint names the SEO-Content-Generator + agent references it back"

assert_status 0 "blueprint file exists"               test -f "$BLUEPRINT_SG"
assert_status 0 "blueprint names the SEO-Content-Generator (Component 2)" \
  grep -q "SEO-Content-Generator" "$BLUEPRINT_SG"
assert_status 0 "agent description names blueprint path" \
  grep -q "seo-keyword-multiplier.md" "$AGENT_SRC_SG"

echo ""

assert_summary
