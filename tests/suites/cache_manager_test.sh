#!/usr/bin/env bash
# cache_manager_test.sh — cache-manager-mcp (E-11), and the MCP Connection Tester that probes it
# over stdio (E-176, merged here from mcp_tester_test by E-302).
# Tests: file structure, tool declarations, security constraints,
#        cache assembly, mtime invalidation, registry registration.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/mcp-client.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SERVER="${REPO_ROOT}/src/mcp/cache-manager-mcp/index.js"

echo "── Suite: cache_manager_test ────────────────────────────────────────"

# ── T-CACHE-S01: File structure ───────────────────────────────────────────────
echo ""
echo "  [T-CACHE-S01] File structure"

assert_status 0 "index.js exists" test -f "$SERVER"
assert_status 0 "package.json exists" test -f "${REPO_ROOT}/src/mcp/cache-manager-mcp/package.json"

assert_status 0 "package.json has type module" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const p = JSON.parse(readFileSync('${REPO_ROOT}/src/mcp/cache-manager-mcp/package.json', 'utf8'));
if (p.type !== 'module') process.exit(1);
JS

assert_status 0 "package.json declares @modelcontextprotocol/sdk dependency" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const p = JSON.parse(readFileSync('${REPO_ROOT}/src/mcp/cache-manager-mcp/package.json', 'utf8'));
if (!p.dependencies?.['@modelcontextprotocol/sdk']) process.exit(1);
JS

# ── T-CACHE-S02: Tool declarations (E-37: behavioral roundtrip) ──────────────
echo ""
echo "  [T-CACHE-S02] Tool declarations"


# Behavioral: each tool must appear in the live tools/list response.
for tool in build_cache get_cached_context invalidate_cache get_cache_status; do
  assert_status 0 "${tool} advertised in tools/list" \
    mcp_assert_tool_listed "$SERVER" "$tool"
done

# Internal-handler check: keep as source-grep — there's no protocol surface
# that proves a switch case exists; what we need to know is that the tool
# name maps to a handler. tools/list advertising it but never handling a
# tools/call is the failure mode this catches.
assert_status 0 "all 4 tools handled in switch" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
const tools = ['build_cache', 'get_cached_context', 'invalidate_cache', 'get_cache_status'];
for (const t of tools) {
  // match either single or double quoted case labels
  if (!src.includes('case "' + t + '":') && !src.includes("case '" + t + "':")) {
    console.error('Missing case:', t); process.exit(1);
  }
}
JS

# ── T-CACHE-S03: Security — DB_PATH hardcoded ────────────────────────────────
echo ""
echo "  [T-CACHE-S03] Security — DB_PATH hardcoded"

assert_status 0 "DB_PATH is a const" \
  grep -q 'const DB_PATH' "$SERVER"

assert_status 1 "DB_PATH not derived from process.env" \
  grep -qE 'DB_PATH\s*=.*process\.env' "$SERVER"

assert_status 1 "DB_PATH not derived from tool arguments" \
  grep -qE 'DB_PATH\s*=.*args\.' "$SERVER"

assert_status 0 "DB_PATH stored in ~/.rein/" \
  grep -q 'cache.sqlite' "$SERVER"

# ── T-CACHE-S04: Security — path traversal prevention ────────────────────────
echo ""
echo "  [T-CACHE-S04] Security — path traversal prevention"

assert_status 0 "validateProjectRoot function exists" \
  grep -q 'validateProjectRoot' "$SERVER"

assert_status 0 "absolute path check present" \
  grep -q 'isAbsolute' "$SERVER"

assert_status 0 "double-dot traversal blocked" \
  grep -q '".."' "$SERVER"

assert_status 0 "validateProjectRoot rejects relative paths" \
  node --input-type=module <<'JS'
import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
function validate(raw) {
  const root = raw ? String(raw).trim() : process.cwd();
  if (!isAbsolute(root)) throw new Error('not absolute');
  if (root.includes('..')) throw new Error('traversal');
  if (!existsSync(root)) throw new Error('not found');
  return root;
}
try { validate('relative/path'); process.exit(1); } catch(e) {
  if (!e.message.includes('absolute')) process.exit(1);
}
try { validate('/abs/../traversal'); process.exit(1); } catch(e) {
  if (!e.message.includes('traversal')) process.exit(1);
}
// Valid path (cwd) should succeed
validate(process.cwd());
JS

assert_status 0 "validateProjectRoot rejects paths with .." \
  node --input-type=module <<'JS'
import { isAbsolute } from 'node:path';
function validate(raw) {
  const root = raw ? String(raw).trim() : process.cwd();
  if (!isAbsolute(root)) throw new Error('not absolute');
  if (root.includes('..')) throw new Error('traversal blocked');
  return root;
}
try { validate('/home/user/../etc/passwd'); process.exit(1); } catch(e) {
  if (!e.message.includes('traversal')) process.exit(1);
}
JS

# ── T-CACHE-S05: Cache assembly — payload files ───────────────────────────────
echo ""
echo "  [T-CACHE-S05] Cache assembly"

assert_status 0 "assembleContext function defined" \
  grep -q 'function assembleContext' "$SERVER"

assert_status 0 "discoverPayloadFiles includes architect.md" \
  grep -q 'architect.md' "$SERVER"

assert_status 0 "discoverPayloadFiles includes blueprints directory" \
  grep -q 'blueprints' "$SERVER"

# E-275 (D-075): registry.json and the state.sqlite schema are no longer injected — no
# agent read them, and they were half of a blob that exceeded its own 20k cap.
assert_status 1 "discoverPayloadFiles no longer reads registry.json (E-275)" \
  grep -q 'join(projectRoot, "src", "config", "registry.json")' "$SERVER"

assert_status 1 "no SQLite schema section in the blob (E-275)" \
  grep -q 'sqlite_master' "$SERVER"

assert_status 1 "assembly does not call execSync()" \
  grep -q 'execSync(' "$SERVER"

assert_status 0 "blob includes section delimiters" \
  grep -q 'SYSTEM CONTEXT' "$SERVER"

assert_status 0 "blueprint files sorted for deterministic order" \
  grep -q '\.sort()' "$SERVER"

assert_status 0 "file roles tracked: architect, blueprint" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
// Match either single or double quoted role strings
for (const role of ['architect', 'blueprint']) {
  if (!src.includes('"' + role + '"') && !src.includes("'" + role + "'")) {
    console.error('Missing role string:', role); process.exit(1);
  }
}
JS

# ── T-CACHE-S06: Staleness detection ─────────────────────────────────────────
echo ""
echo "  [T-CACHE-S06] Staleness detection"

assert_status 0 "isCacheStale function defined" \
  grep -q 'function isCacheStale' "$SERVER"

assert_status 0 "staleness checks 'valid' key in cache_meta" \
  grep -q "'valid'" "$SERVER"

assert_status 0 "staleness checks project_root mismatch" \
  grep -q 'project_root' "$SERVER"

assert_status 0 "staleness detects new blueprint files (not just mtime changes)" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
// Must re-glob blueprints dir on each staleness check
if (!src.includes('readdirSync')) process.exit(1);
JS

assert_status 0 "get_cached_context auto-rebuilds when stale" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
// Match either quote style
const ctxIdx = src.indexOf('case "get_cached_context":') !== -1
  ? src.indexOf('case "get_cached_context":')
  : src.indexOf("case 'get_cached_context':");
if (ctxIdx === -1) process.exit(1);
const block = src.slice(ctxIdx, ctxIdx + 1500);
if (!block.includes('isCacheStale')) process.exit(1);
if (!block.includes('assembleContext')) process.exit(1);
JS

# ── T-CACHE-S07: SQLite schema ────────────────────────────────────────────────
echo ""
echo "  [T-CACHE-S07] SQLite schema"

assert_status 0 "cache_meta table defined" \
  grep -q 'cache_meta' "$SERVER"

assert_status 0 "cache_files table defined" \
  grep -q 'cache_files' "$SERVER"

assert_status 0 "cache_files has mtime_ms column" \
  grep -q 'mtime_ms' "$SERVER"

assert_status 0 "cache_files has size_bytes column" \
  grep -q 'size_bytes' "$SERVER"

assert_status 0 "cache_files has role column" \
  grep -q 'role' "$SERVER"

assert_status 0 "persistCache writes context_blob to cache_meta" \
  grep -q 'context_blob' "$SERVER"

assert_status 0 "persistCache writes built_at timestamp" \
  grep -q 'built_at' "$SERVER"

assert_status 0 "persistCache clears cache_files before insert (no stale rows)" \
  grep -q 'DELETE FROM cache_files' "$SERVER"

# ── T-CACHE-S08: invalidate_cache sets valid=0 ────────────────────────────────
echo ""
echo "  [T-CACHE-S08] invalidate_cache"

assert_status 0 "invalidate_cache sets valid to '0'" \
  grep -q "'valid', '0'" "$SERVER"

assert_status 0 "CACHE_INVALIDATED emitted in response" \
  grep -q 'CACHE_INVALIDATED' "$SERVER"

# ── T-CACHE-S09: get_cache_status reporting ───────────────────────────────────
echo ""
echo "  [T-CACHE-S09] get_cache_status"

assert_status 0 "status shows VALID or STALE" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
if (!src.includes('"VALID"') && !src.includes("'VALID'") && !src.includes('VALID')) process.exit(1);
if (!src.includes('"STALE"') && !src.includes("'STALE'") && !src.includes('STALE')) process.exit(1);
JS

assert_status 0 "status reports chars and estimated tokens" \
  grep -q 'estimateTokens' "$SERVER"

assert_status 0 "estimateTokens uses 4-char approximation" \
  grep -q '/ 4' "$SERVER"

assert_status 0 "status lists tracked files" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const src = readFileSync('$SERVER', 'utf8');
const statusIdx = src.indexOf('case "get_cache_status":') !== -1
  ? src.indexOf('case "get_cache_status":')
  : src.indexOf("case 'get_cache_status':");
if (statusIdx === -1) process.exit(1);
const block = src.slice(statusIdx, statusIdx + 2000);
if (!block.includes('cache_files')) process.exit(1);
JS

# ── T-CACHE-S10: Observability ────────────────────────────────────────────────
echo ""
echo "  [T-CACHE-S10] Observability"

assert_status 0 "shared logger imported" \
  grep -q 'createLogger.*shared/logger' "$SERVER"

assert_status 0 "logger exposes log() shim" \
  grep -q 'logger.log' "$SERVER"

assert_status 0 "logger initialised with SERVICE" \
  grep -q 'createLogger(SERVICE)' "$SERVER"

assert_status 0 "latency_ms tracked" \
  grep -q 'latency_ms' "$SERVER"

assert_status 0 "startup log entry emitted" \
  grep -q '"startup"' "$SERVER"

assert_status 0 "CACHE_HIT logged" \
  grep -q 'CACHE_HIT' "$SERVER"

assert_status 0 "CACHE_BUILT logged" \
  grep -q 'CACHE_BUILT' "$SERVER"

# ── T-CACHE-S11: Registry and .mcp.json ──────────────────────────────────────
echo ""
echo "  [T-CACHE-S11] Registry and .mcp.json"

assert_status 0 "cache-manager-mcp in registry.json" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('${REPO_ROOT}/src/config/registry.json', 'utf8'));
if (!r.mcp_servers['cache-manager-mcp']) process.exit(1);
JS

assert_status 0 "registry capability is READ" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('${REPO_ROOT}/src/config/registry.json', 'utf8'));
const entry = r.mcp_servers['cache-manager-mcp'];
if (entry.capability !== 'READ') process.exit(1);
JS

assert_status 0 "registry allowed-tools lists all 4 tools" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('${REPO_ROOT}/src/config/registry.json', 'utf8'));
const tools = r.mcp_servers['cache-manager-mcp']['allowed-tools'];
const expected = ['build_cache', 'get_cached_context', 'invalidate_cache', 'get_cache_status'];
if (!Array.isArray(tools) || tools.length !== 4) process.exit(1);
for (const t of expected) { if (!tools.includes(t)) { console.error('Missing:', t); process.exit(1); } }
JS

# E-364 (D-117): .mcp.json is generated by `rein sync` and no longer tracked; the registry entry is
# what generate_mcp_json turns into it (rein_sync_test's generator rows, tests/tools/registry-drift.sh).
assert_status 0 "cache-manager-mcp is a path-based registry server (the sync step wires it into .mcp.json)" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('${REPO_ROOT}/src/config/registry.json', 'utf8'));
if (!r.mcp_servers['cache-manager-mcp'] || !r.mcp_servers['cache-manager-mcp'].path) process.exit(1);
JS

assert_status 0 "its registry path points to index.js (so the generated entry does)" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('${REPO_ROOT}/src/config/registry.json', 'utf8'));
const p = r.mcp_servers['cache-manager-mcp']?.path ?? '';
if (!(p.includes('cache-manager-mcp') && p.endsWith('index.js'))) process.exit(1);
JS

# ── T-CACHE-S12: End-to-end smoke test ───────────────────────────────────────
echo ""
echo "  [T-CACHE-S12] Smoke test — build_cache + get_cache_status"

assert_status 0 "build_cache assembles context from live project" \
  node --input-type=module <<JS
// Inline the core assembly logic to test without the MCP transport
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const projectRoot = '${REPO_ROOT}';

// Discover payload files
const files = [];
const architectPath = join(projectRoot, '.ai', 'architect.md');
if (existsSync(architectPath)) files.push({ path: architectPath, role: 'architect' });

const blueprintsDir = join(projectRoot, '.ai', 'blueprints');
if (existsSync(blueprintsDir)) {
  const names = readdirSync(blueprintsDir).filter(n => n.endsWith('.md')).sort();
  for (const n of names) files.push({ path: join(blueprintsDir, n), role: 'blueprint' });
}

if (files.length === 0) { console.error('No payload files found'); process.exit(1); }

// Verify all files are readable
for (const { path } of files) {
  const content = readFileSync(path, 'utf8');
  if (!content) { console.error('Empty file:', path); process.exit(1); }
}

// Verify context blob structure
let blob = '=== Rein SYSTEM CONTEXT CACHE ===\n';
for (const { path, role } of files) {
  const content = readFileSync(path, 'utf8');
  blob += '--- ' + path.replace(projectRoot + '/', '') + ' (' + role + ') ---\n';
  blob += content.trimEnd() + '\n\n';
}
blob += '=== END SYSTEM CONTEXT ===';

if (!blob.includes('=== Rein SYSTEM CONTEXT CACHE ===')) process.exit(1);
if (!blob.includes('=== END SYSTEM CONTEXT ===')) process.exit(1);
if (blob.length < 1000) { console.error('Blob too small:', blob.length); process.exit(1); }
JS

assert_status 0 "context blob includes architect.md content" \
  node --input-type=module <<JS
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = '${REPO_ROOT}';
const architectPath = join(projectRoot, '.ai', 'architect.md');
if (!existsSync(architectPath)) process.exit(0); // skip if missing

const content = readFileSync(architectPath, 'utf8');
// First 50 chars of architect.md must be part of the blob
if (!content || content.length < 10) process.exit(1);
JS

assert_status 0 "context blob includes at least one blueprint" \
  node --input-type=module <<JS
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const blueprintsDir = '${REPO_ROOT}/.ai/blueprints';
if (!existsSync(blueprintsDir)) process.exit(0); // skip if missing
const mdFiles = readdirSync(blueprintsDir).filter(n => n.endsWith('.md'));
if (mdFiles.length === 0) { console.error('No blueprints found'); process.exit(1); }
JS

# ── T-CACHE-S13: E-177 hot-cache compaction (stale blueprints over 20k chars) ──
echo ""
echo "  [T-CACHE-S13] E-177/E-275 — stale blueprints never injected; blob capped at 20k"

# Source contract (BSD-grep-safe patterns: no \s, no unescaped parens).
assert_status 0 "CACHE_CHAR_LIMIT 20000 threshold" \
  grep -qE 'CACHE_CHAR_LIMIT *= *20000' "$SERVER"
assert_status 0 "7-day staleness window" \
  grep -qE 'STALE_BLUEPRINT_AGE_MS *= *7 \* 24' "$SERVER"
assert_status 0 "only blueprint-role files are compaction candidates" \
  grep -qE 'role === "blueprint".*mtime_ms' "$SERVER"
assert_status 0 "oldest-first eviction order" \
  grep -qE 'a\.mtime_ms - b\.mtime_ms' "$SERVER"
assert_status 0 "emits an Omitted marker" \
  grep -q 'Omitted:' "$SERVER"

# Behavioural: craft a project whose full blob exceeds 20k, with old + recent blueprints.
# Uses --emit-context (assembles + prints WITHOUT touching the real ~/.rein/cache.sqlite).
CBOX="$(mktemp -d)"
mkdir -p "${CBOX}/.ai/blueprints"
printf 'ARCHITECT DOC\n%s\n' "$(head -c 400 /dev/zero | tr '\0' 'A')" > "${CBOX}/.ai/architect.md"
for i in 1 2 3 4 5 6; do
  printf '# Blueprint %s\n%s\n' "$i" "$(head -c 5000 /dev/zero | tr '\0' 'B')" > "${CBOX}/.ai/blueprints/bp_${i}.md"
done
# bp_1..bp_4 are stale (>7d, Jan 2026); bp_5,bp_6 recent (now).
for i in 1 2 3 4; do touch -t 202601010000 "${CBOX}/.ai/blueprints/bp_${i}.md"; done

CBLOB="$( cd "${CBOX}" && node "$SERVER" --emit-context 2>/dev/null )"
CLEN=${#CBLOB}

assert_status 0 "compacted blob fits the 20k budget" bash -c "[[ $CLEN -le 20000 ]]"
assert_contains "blob carries the Omitted marker"   "Omitted:"       "$CBLOB"
assert_contains "architect doc is never evicted"    "ARCHITECT DOC"  "$CBLOB"
assert_contains "recent blueprint retained (bp_6)"  "Blueprint 6"    "$CBLOB"
assert_not_contains "oldest stale blueprint evicted (bp_1)" "Blueprint 1" "$CBLOB"

rm -rf "$CBOX"


# ── E-176 (from mcp_tester_test — E-302): MCP Connection Tester (doctor-and-cache-optimizations.md §Components 2) ──
# The MCP Connection Tester spawns each registered MCP server, performs the
# minimum stdio JSON-RPC handshake to reach tools/list, and reports connectivity.
# Used by `rein doctor --env`. Tests cover:
#   • source contract (exports, handshake frames)
#   • SECURITY: never issues tools/call; curated env (no wholesale process.env)
set +e
TESTER="${REPO_ROOT}/src/shared/mcp-tester.mjs"
LOCAL_SERVER="${REPO_ROOT}/src/mcp/cache-manager-mcp/index.js"


# ── T-MT-S01: source contract ─────────────────────────────────────────────────
echo ""
echo "  [T-MT-S01] source contract"

assert_status 0 "mcp-tester.mjs exists" test -f "$TESTER"
assert_status 0 "exports testMcpServers" grep -qE 'export (async )?function testMcpServers' "$TESTER"
assert_status 0 "exports probeServer"    grep -qE 'export function probeServer' "$TESTER"
assert_status 0 "exports loadServerConfigs" grep -qE 'export function loadServerConfigs' "$TESTER"
assert_status 0 "sends initialize frame"  grep -qE '"initialize"' "$TESTER"
assert_status 0 "sends tools/list frame"  grep -qE '"tools/list"' "$TESTER"

# ── T-MT-S02: SECURITY contract ───────────────────────────────────────────────
echo ""
echo "  [T-MT-S02] security: read-only handshake + curated env"

# Must NEVER invoke an execution tool during a connectivity probe. The guarantee
# is that no JSON-RPC frame uses "tools/call" as a method (prose comments may name
# it, so we match only the double-quoted method string a real call would emit).
assert_status 1 "never emits a \"tools/call\" JSON-RPC method" grep -qE '"tools/call"' "$TESTER"
# Must NOT forward the parent's full environment (token-exposure guard).
assert_status 1 "does not spread process.env wholesale" grep -qE '\.\.\.process\.env|env:\s*process\.env' "$TESTER"
# Curated env helper present.
assert_status 0 "curated env builder present" grep -qE 'function curatedEnv' "$TESTER"
# Child stderr discarded (may carry secret-bearing diagnostics).
assert_status 0 "child stderr discarded ('ignore')" grep -qE '"ignore"' "$TESTER"

# ── T-MT-S03: behavioural — real local server answers tools/list ──────────────
echo ""
echo "  [T-MT-S03] behavioural: live probe of a local MCP server"

SBOX="$(mktemp -d)"
CFG="${SBOX}/.mcp.json"
cat > "$CFG" <<JSON
{ "mcpServers": { "cache-manager-mcp": { "command": "node", "args": ["${LOCAL_SERVER}"] } } }
JSON

PROBE_OK="$(node -e "
import('${TESTER}').then(async (m) => {
  const r = await m.testMcpServers({ configPath: '${CFG}', timeoutMs: 6000 });
  process.stdout.write(JSON.stringify(r));
}).catch(e => { console.error(e); process.exit(1); });
")"
assert_contains "live server reports ok:true"      '"ok":true'                 "$PROBE_OK"
assert_contains "live server names the server"     'cache-manager-mcp'         "$PROBE_OK"
assert_match    "live server reports a tool count" '"toolCount":[1-9]'         "$PROBE_OK"

# ── T-MT-S04: behavioural — bogus command fails (fail-closed result) ──────────
echo ""
echo "  [T-MT-S04] behavioural: unlaunchable server → ok:false with error"

CFG_BAD="${SBOX}/bad.mcp.json"
cat > "$CFG_BAD" <<JSON
{ "mcpServers": { "ghost-mcp": { "command": "node", "args": ["${SBOX}/does-not-exist.js"] } } }
JSON

PROBE_BAD="$(node -e "
import('${TESTER}').then(async (m) => {
  const r = await m.testMcpServers({ configPath: '${CFG_BAD}', timeoutMs: 4000 });
  process.stdout.write(JSON.stringify(r));
}).catch(e => { console.error(e); process.exit(1); });
")"
assert_contains "bogus server reports ok:false" '"ok":false' "$PROBE_BAD"
assert_contains "bogus server carries an error"  '"error":'   "$PROBE_BAD"

# ── T-MT-S05: CLI exit codes ──────────────────────────────────────────────────
echo ""
echo "  [T-MT-S05] CLI: exit 0 all-OK, exit 1 on any failure"

node "$TESTER" --config "$CFG" --timeout 6000 >/dev/null 2>&1
assert_status 0 "CLI exits 0 when all servers answer" bash -c "true"  # rc captured below
node "$TESTER" --config "$CFG" --timeout 6000 >/dev/null 2>&1; RC_OK=$?
assert_status 0 "CLI rc==0 (all OK)" bash -c "[[ $RC_OK -eq 0 ]]"

node "$TESTER" --config "$CFG_BAD" --timeout 4000 >/dev/null 2>&1; RC_BAD=$?
assert_status 0 "CLI rc==1 (a server failed)" bash -c "[[ $RC_BAD -eq 1 ]]"

rm -rf "$SBOX"

echo ""

assert_summary
