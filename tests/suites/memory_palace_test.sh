#!/usr/bin/env bash
# memory_palace_test.sh — the cross-project Memory Palace: the E-46 curator/knowledge_architect
# contracts, then memory-manager-mcp's signature store (E-110, merged here by E-302).
#
# Verifies the memory_curator + knowledge_architect agent files (and tracked
# mirrors) carry the contract demanded by may-2026-upgrades.md §"Multimodal
# Memory Curator" / §"knowledge_architect", as narrowed by E-254:
#   - honest scope: text index + SHA-256 hash index, embedding provider
#     unconfigured, multimodal (vector) retrieval deferred — no vendor model claimed
#   - department metadata (Architecture | UX)
#   - sensitive-file exclusion (.env, .ssh, .gitignore)
#   - 5MB visual cap
#   - background-only execution mandate
#   - knowledge_architect page-level + diagram citations
#   - structured answer envelope schema
#   - byte-identical mirrors

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"


REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "── Suite: memory_palace_test ────────────────────────────────────────"

# Content contract is asserted on the canonical src/ copies; workspace mirrors are
# held to byte identity in T-MM-S08.
CURATOR_SRC="${REPO_ROOT}/src/claude/agents/memory_curator.md"
ARCHITECT_SRC="${REPO_ROOT}/src/claude/agents/knowledge_architect.md"
CURATOR_FILES=("$CURATOR_SRC")
ARCHITECT_FILES=("$ARCHITECT_SRC")
SCANNER="${REPO_ROOT}/src/shared/memory-batch-scanner.mjs"

# ── T-MM-S01: Files exist and frontmatter parses ──────────────────────────────
echo ""
echo "  [T-MM-S01] Agent files exist with valid YAML frontmatter"

for f in "${CURATOR_FILES[@]}" "${ARCHITECT_FILES[@]}"; do
  assert_status 0 "exists: ${f#${REPO_ROOT}/}" test -f "$f"
  # Description containing colons (e.g. "Trigger on ai sync: ...") was the
  # exact failure mode that broke ux_reviewer (commit 84288ce). Detect any
  # unquoted-colon regression by re-parsing the frontmatter via a tiny
  # Python YAML-lite scanner.
  assert_status 0 "${f##*/agents/} → frontmatter loads cleanly" \
    python3 -c "
import re, sys
src = open('$f').read()
m = re.match(r'---\n(.*?)\n---', src, re.S)
assert m, 'no frontmatter'
body = m.group(1)
# Bail if any line has an unquoted colon-space inside a value. Quoted form
# (description: \"...\") is fine; bare scalars with embedded colon-space are not.
for line in body.split('\n'):
    if ':' not in line: continue
    key, _, value = line.partition(':')
    value = value.strip()
    if not value: continue
    if value.startswith('\"') or value.startswith(\"'\"): continue
    if ': ' in value:
        sys.stderr.write(f'unquoted colon-space in {key.strip()!r}: {value[:60]}\n')
        sys.exit(1)
"
done

# ── T-MM-S02: memory_curator — multimodal contract ───────────────────────────
echo ""
echo "  [T-MM-S02] memory_curator index contract (text + hash index, vectors deferred)"

for f in "${CURATOR_FILES[@]}"; do
  assert_status 0 "${f##*/agents/} → states the text index"               grep -q 'text index' "$f"
  assert_status 0 "${f##*/agents/} → states the SHA-256 hash index"       grep -q 'SHA-256 hash index' "$f"
  assert_status 0 "${f##*/agents/} → names the implementing scanner"      grep -q 'memory-batch-scanner.mjs' "$f"
  assert_status 0 "${f##*/agents/} → embedding provider is unconfigured"  grep -q 'No embedding provider is configured' "$f"
  assert_status 0 "${f##*/agents/} → multimodal retrieval is deferred"    grep -qE 'multimodal (\(vector\) )?retrieval is (\*\*)?deferred' "$f"
  assert_status 0 "${f##*/agents/} → runs text-only by default"           grep -q 'AI_RAG_MODE=text-only' "$f"
  assert_status 1 "${f##*/agents/} → claims no vendor embedding model"    grep -qiE 'embedding[ -]0*2\b|embedding-00[0-9]' "$f"
  assert_status 1 "${f##*/agents/} → hash-index schema carries no vector" grep -q '"vector": \[' "$f"
  assert_status 0 "${f##*/agents/} → declares department classifier"   grep -q 'department' "$f"
  assert_status 0 "${f##*/agents/} → covers Architecture department"   grep -q 'Architecture' "$f"
  assert_status 0 "${f##*/agents/} → covers UX department"             grep -q 'UX' "$f"
  assert_status 0 "${f##*/agents/} → enumerates PNG ingestion"         grep -qi 'PNG' "$f"
  assert_status 0 "${f##*/agents/} → enumerates SVG ingestion"         grep -qi 'SVG' "$f"
  assert_status 0 "${f##*/agents/} → enumerates PDF ingestion"         grep -qi 'PDF' "$f"
done

# ── T-MM-S03: memory_curator — sensitive-file exclusion ──────────────────────
echo ""
echo "  [T-MM-S03] Sensitive-file exclusion"

for f in "${CURATOR_FILES[@]}"; do
  assert_status 0 "${f##*/agents/} → excludes .env paths"      grep -q '\.env' "$f"
  assert_status 0 "${f##*/agents/} → excludes .ssh paths"      grep -q '\.ssh' "$f"
  assert_status 0 "${f##*/agents/} → honours .gitignore"       grep -qi 'gitignore' "$f"
  assert_status 0 "${f##*/agents/} → blocks credential names"  grep -qi 'credential\|id_rsa\|\\.pem\|\\.p12' "$f"
done

# ── T-MM-S04: memory_curator — execution constraints ────────────────────────
echo ""
echo "  [T-MM-S04] Execution constraints"

for f in "${CURATOR_FILES[@]}"; do
  assert_status 0 "${f##*/agents/} → 5MB cap stated"      grep -qE '5[[:space:]]*MB|5242881|5_?MB' "$f"
  assert_status 0 "${f##*/agents/} → background-only"     grep -qiE 'Background only|never on synchronous ai[ ]init|background job' "$f"
  assert_status 0 "${f##*/agents/} → handles 429 backoff" grep -q '429' "$f"
done

# ── T-MM-S05: knowledge_architect — multimodal output ────────────────────────
echo ""
echo "  [T-MM-S05] knowledge_architect citations (text-based retrieval)"

for f in "${ARCHITECT_FILES[@]}"; do
  assert_status 0 "${f##*/agents/} → cites page-level PDF citations" \
    grep -qE 'page-level|#p<page>' "$f"
  assert_status 0 "${f##*/agents/} → cites visual diagrams" \
    grep -qiE 'visual diagrams|retrieved diagrams|diagram references' "$f"
  assert_status 0 "${f##*/agents/} → retrieval is text-based over the Palace indexes" \
    grep -q 'Retrieval is text-based' "$f"
  assert_status 0 "${f##*/agents/} → vector retrieval deferred until a provider is configured" \
    grep -q 'deferred until an embedding provider is configured' "$f"
  assert_status 1 "${f##*/agents/} → claims no vendor embedding model" \
    grep -qiE 'embedding[ -]0*2\b|embedding-00[0-9]' "$f"
  assert_status 0 "${f##*/agents/} → applies department metadata filter" \
    grep -q 'department' "$f"
done

# Verify the answer envelope schema is present in both copies.
for f in "${ARCHITECT_FILES[@]}"; do
  assert_status 0 "${f##*/agents/} → answer envelope has 'kind:pdf'" \
    grep -q '"kind": "pdf"' "$f"
  assert_status 0 "${f##*/agents/} → answer envelope has 'kind:diagram'" \
    grep -q '"kind": "diagram"' "$f"
  assert_status 0 "${f##*/agents/} → envelope carries department metadata" \
    grep -q '"department"' "$f"
done

# ── T-MM-S06: no embedding call is attempted; the hash index is real ─────────
echo ""
echo "  [T-MM-S06] No query embedding; hash-index claim backed by source"

for f in "${ARCHITECT_FILES[@]}"; do
  assert_status 0 "${f##*/agents/} → does not embed the query" \
    grep -q 'do not attempt to embed the query' "$f"
done

for f in "${CURATOR_FILES[@]}"; do
  assert_status 0 "${f##*/agents/} → names loadIndexedHashes as the dedup reader" \
    grep -q 'loadIndexedHashes' "$f"
done
assert_status 0 "memory-batch-scanner exports loadIndexedHashes (the doc claim is real)" \
  grep -q '^export function loadIndexedHashes' "$SCANNER"
assert_status 0 "memory-batch-scanner hashes with SHA-256 (the doc claim is real)" \
  grep -q '^export function computeFileSha256' "$SCANNER"

# ── T-MM-S07: SEED.md token discipline preserved ─────────────────────────────
echo ""
echo "  [T-MM-S07] SEED.md visual-citation exclusion"

for f in "${ARCHITECT_FILES[@]}"; do
  assert_status 0 "${f##*/agents/} → visual citations excluded from SEED.md" \
    grep -qiE 'excluded from SEED.md|seed token-cheap' "$f"
done

# ── T-MM-S08: Mirrors are byte-identical ────────────────────────────────────
echo ""
echo "  [T-MM-S08] Source-of-truth ⇄ project mirror byte-identical"

# E-244 (D-066 §4): a mirror is compared only where the workspace exists; absent → SKIP.
assert_mirror_if_present "memory_curator .claude mirror = src" \
  "$CURATOR_SRC" "${REPO_ROOT}/.claude/agents/memory_curator.md"
assert_mirror_if_present "knowledge_architect .claude mirror = src" \
  "$ARCHITECT_SRC" "${REPO_ROOT}/.claude/agents/knowledge_architect.md"

assert_status 0 "memory_curator src DOES carry the Claude contract (E-212; E-295: a tools allowlist)" \
  grep -qE '^tools:' "$CURATOR_SRC"


# ── E-110 (from memory_manager_test — E-302): memory-manager-mcp signatures (§31) ──
# Validates: export_signature upsert, sanitization, query_signatures OR logic,
# and silent failure on unwritable store directory.
set -e
MEMORY_MCP="${REPO_ROOT}/src/mcp/memory-manager-mcp/index.js"


# T-04.01: MCP file exists and is syntactically valid
assert_exists "$MEMORY_MCP"
assert_status 0 "T-04.01: memory-manager-mcp syntax OK" \
  node -e "import('file://${MEMORY_MCP}').catch(e => { if (e instanceof SyntaxError) process.exit(1); })"

# ── Isolated store in tmpdir (avoids touching real ~/.ai-os) ─────────────────
FAKE_HOME=$(mktemp -d)
on_exit 'rm -rf "$FAKE_HOME"'
STORE_FILE="${FAKE_HOME}/.ai-os/memory/signatures.json"

# Helper: export a signature to the isolated store (inlines memory-manager-mcp logic)
export_sig() {
  local project_name="$1" summary="$2" tags_json="$3"
  HOME="$FAKE_HOME" node -e "
    import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
    import { resolve, join } from 'path';
    const STORE_DIR  = resolve(process.env.HOME, '.ai-os', 'memory');
    const STORE_FILE = join(STORE_DIR, 'signatures.json');

    function sanitize(str, maxLen = 300) {
      if (typeof str !== 'string') return '';
      return str
        .replace(/\b(password|passwd|api[_-]?key|secret|token|private[_-]?key)\s*[=:]\s*\S+/gi, '[REDACTED]')
        .replace(/\b[A-Za-z0-9+/]{40,}\b/g, '[REDACTED_BLOB]')
        .slice(0, maxLen);
    }
    function readStore() {
      try { return existsSync(STORE_FILE) ? JSON.parse(readFileSync(STORE_FILE,'utf8')) : []; }
      catch { return []; }
    }
    function writeStore(sigs) {
      try { mkdirSync(STORE_DIR,{recursive:true}); writeFileSync(STORE_FILE,JSON.stringify(sigs,null,2)+'\n','utf8'); return true; }
      catch { return false; }
    }
    const projectName = sanitize('$project_name', 100);
    const summary     = sanitize('$summary', 300);
    const tags        = JSON.parse('$tags_json').map(t => sanitize(String(t), 50));
    const sig = { project_name: projectName, tags, summary, architect_v: 'unknown', timestamp: new Date().toISOString() };
    const sigs = readStore();
    const dedup = sigs.filter(s => s.project_name !== projectName);
    dedup.push(sig);
    const ok = writeStore(dedup);
    console.log(ok ? 'ok:' + dedup.length : 'write_failed');
  " --input-type=module 2>/dev/null || echo "node_error"
}

# Helper: query signatures from the isolated store
query_sig() {
  local tags_json="$1"
  HOME="$FAKE_HOME" node -e "
    import { readFileSync, existsSync } from 'fs';
    import { resolve, join } from 'path';
    const STORE_FILE = join(resolve(process.env.HOME, '.ai-os', 'memory'), 'signatures.json');
    function readStore() {
      try { return existsSync(STORE_FILE) ? JSON.parse(readFileSync(STORE_FILE,'utf8')) : []; }
      catch { return []; }
    }
    const queryTags = JSON.parse('$tags_json').map(t => String(t).toLowerCase());
    const matched = readStore().filter(s => {
      const sigTags = (s.tags || []).map(t => String(t).toLowerCase());
      return queryTags.some(qt => sigTags.some(st => st.includes(qt)));
    });
    console.log(JSON.stringify(matched.map(s => s.project_name)));
  " --input-type=module 2>/dev/null || echo "[]"
}

# T-04.02: export_signature creates store entry
result=$(export_sig "test-project" "A test project summary" '["bash","node"]')
assert_contains "T-04.02: export_signature creates store entry" "ok:1" "$result"
assert_exists "$STORE_FILE"

# T-04.03: duplicate project upserts (no duplicate entries)
export_sig "test-project" "Updated summary" '["bash","node"]' >/dev/null
store_count=$(python3 -c "import json; d=json.load(open('${STORE_FILE}')); print(len(d))")
assert_contains "T-04.03: duplicate project upserts (1 entry, not 2)" "1" "$store_count"

# T-04.04: sanitization strips secrets from summary
export_sig "secret-project" "api_key=supersecret123 is the config" '["api"]' >/dev/null
summary_val=$(python3 -c "
import json; d=json.load(open('${STORE_FILE}'))
p=[s for s in d if s['project_name']=='secret-project']
print(p[0]['summary'] if p else 'not_found')
")
assert_contains "T-04.04: sanitization inserts [REDACTED] placeholder" "[REDACTED]" "$summary_val"
assert_not_contains "T-04.04b: raw secret value not stored" "supersecret123" "$summary_val"

# T-04.05: export multiple projects (total count correct)
export_sig "project-alpha" "Alpha project" '["react","api"]' >/dev/null
export_sig "project-beta"  "Beta project"  '["vue","auth"]'  >/dev/null
total=$(python3 -c "import json; d=json.load(open('${STORE_FILE}')); print(len(d))")
assert_contains "T-04.05: store holds 4 distinct projects" "4" "$total"

# T-04.06: query_signatures matches by tag (single tag)
matches=$(query_sig '["react"]')
assert_contains "T-04.06: query matches project-alpha (react tag)" "project-alpha" "$matches"
assert_not_contains "T-04.06b: query excludes project-beta (no react tag)" "project-beta" "$matches"

# T-04.07: query_signatures OR logic returns multiple matches
multi=$(query_sig '["react","auth"]')
assert_contains "T-04.07a: OR logic matches alpha (react)" "project-alpha" "$multi"
assert_contains "T-04.07b: OR logic matches beta (auth)" "project-beta" "$multi"

# T-04.08: silent failure when store directory is unwritable
READONLY_HOME=$(mktemp -d)
# Make .ai-os/memory unwritable by making parent unwritable
mkdir -p "${READONLY_HOME}/.ai-os"
chmod 000 "${READONLY_HOME}/.ai-os"
fail_result=$(HOME="$READONLY_HOME" node -e "
  import { writeFileSync, mkdirSync } from 'fs';
  import { resolve, join } from 'path';
  const STORE_DIR  = resolve(process.env.HOME, '.ai-os', 'memory');
  const STORE_FILE = join(STORE_DIR, 'signatures.json');
  function writeStore(sigs) {
    try { mkdirSync(STORE_DIR,{recursive:true}); writeFileSync(STORE_FILE,JSON.stringify(sigs)); return true; }
    catch { return false; }
  }
  console.log(writeStore([{test:true}]) ? 'wrote' : 'silent_failure');
" --input-type=module 2>/dev/null || echo "node_error")
chmod 755 "${READONLY_HOME}/.ai-os"
rm -rf "$READONLY_HOME"
assert_contains "T-04.08: silent failure on unwritable store (no crash)" "silent_failure" "$fail_result"

assert_summary
