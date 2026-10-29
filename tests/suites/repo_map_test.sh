#!/usr/bin/env bash
# repo_map_test.sh — the AST repository map (ast-repository-map.md): ast-parser-mcp symbol
# extraction (E-95), centrality ranking (E-96), REPO_MAP.md serialisation (E-97) and the wiring
# below (E-98); E-302 merged the four suites into this one.
#
# E-98 wiring (§Components 3): --generate-map CLI, the `rein sync` hook, ai-preflight Step 8,
# vendored grammars, and the lazy-SDK invariant that keeps the CLI path
# self-contained for the installed ~/.rein server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/mcp-client.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SERVER="${REPO_ROOT}/src/mcp/ast-parser-mcp/index.js"
AI_BIN="${REPO_ROOT}/src/bin/rein"
PREFLIGHT="${REPO_ROOT}/src/shared/skills/ai-preflight/SKILL.md"
PKG="${REPO_ROOT}/src/mcp/ast-parser-mcp/package.json"
EXTRACTOR="${REPO_ROOT}/src/mcp/ast-parser-mcp/extractor.mjs"

echo "── Suite: repo_map_test ─────────────────────────────────────────────"
unset REIN_WORKSPACE REIN_WORKSPACE_DISABLE 2>/dev/null || true

# ── T-98.01: --generate-map CLI writes .ai/REPO_MAP.md ───────────────────────
TMP="$(mktemp -d)"; mkdir -p "${TMP}/src"
printf 'export class A{ run(x){} }\nimport b from "./b.js";\n' > "${TMP}/src/a.js"
printf 'export const b = 1;\n'                                 > "${TMP}/src/b.js"
out=$(cd "${TMP}" && node "${SERVER}" --generate-map 2>&1)
assert_contains "T-98.01: CLI reports REPO_MAP write" "REPO_MAP" "$out"
assert_exists   "${TMP}/.ai/REPO_MAP.md"

# ── T-98.02: REIN_DISABLE_REPO_MAP=1 → CLI no-op, no write ───────────────────
TMP2="$(mktemp -d)"; mkdir -p "${TMP2}/src"; printf 'export const x=1;\n' > "${TMP2}/src/x.js"
out2=$(cd "${TMP2}" && REIN_DISABLE_REPO_MAP=1 node "${SERVER}" --generate-map 2>&1)
assert_contains "T-98.02: disabled flag short-circuits CLI" "REPO_MAP_DISABLED" "$out2"
if [ -f "${TMP2}/.ai/REPO_MAP.md" ]; then _fail "T-98.02b: no REPO_MAP.md when disabled"; else _pass "T-98.02b: no REPO_MAP.md when disabled"; fi
rm -rf "${TMP}" "${TMP2}"

# ── T-98.03: rein sync wires the repo-map hook ─────────────────────────────────
ai_src=$(cat "${AI_BIN}")
assert_contains "T-98.03: _generate_repo_map helper defined" "_generate_repo_map()" "$ai_src"
assert_contains "T-98.03b: helper invoked inside do_sync"     "  _generate_repo_map" "$ai_src"
assert_contains "T-98.04: hook honors REIN_DISABLE_REPO_MAP" "REIN_DISABLE_REPO_MAP" "$ai_src"
assert_contains "T-98.04b: hook fail-open on missing node"    "node not found — skipping REPO_MAP" "$ai_src"

# ── T-98.05: ai-preflight Step 8 documents REPO_MAP loading ──────────────────
pf=$(cat "${PREFLIGHT}")
assert_contains "T-98.05: Step 8 present"             "### 8. Load REPO_MAP.md" "$pf"
assert_contains "T-98.05b: names E-98"               "E-98" "$pf"
assert_contains "T-98.05c: names blueprint"          "ast-repository-map" "$pf"
assert_contains "T-98.05d: documents rollback flag"  "REIN_DISABLE_REPO_MAP" "$pf"

# ── T-98.06: ai-preflight SKILL mirrors are byte-identical ───────────────────
assert_status 0 "T-98.06a: .claude mirror identical" diff -q "${PREFLIGHT}" "${REPO_ROOT}/.claude/skills/ai-preflight/SKILL.md"

# ── T-98.07: grammars are vendored, tree-sitter-wasms is NOT a runtime dep ───
ext=$(cat "${EXTRACTOR}")
assert_contains "T-98.07: extractor loads vendored grammars dir" "GRAMMARS_DIR" "$ext"
assert_not_contains "T-98.07b: no runtime tree-sitter-wasms resolve" "tree-sitter-wasms/package.json" "$ext"
runtime_dep=$(node -e "const p=require('${PKG}'); console.log(Object.keys(p.dependencies||{}).includes('tree-sitter-wasms'))")
assert_contains "T-98.07c: tree-sitter-wasms not a runtime dep" "false" "$runtime_dep"
dev_dep=$(node -e "const p=require('${PKG}'); console.log(Object.keys(p.devDependencies||{}).includes('tree-sitter-wasms'))")
assert_contains "T-98.07d: tree-sitter-wasms is a devDependency" "true" "$dev_dep"

# ── T-98.08: vendored grammar .wasm files exist ──────────────────────────────
assert_exists "${REPO_ROOT}/src/mcp/ast-parser-mcp/grammars/tree-sitter-javascript.wasm"
assert_exists "${REPO_ROOT}/src/mcp/ast-parser-mcp/grammars/tree-sitter-typescript.wasm"

# ── T-98.09: SDK is lazy-loaded (not a top-level static import) ──────────────
srv=$(cat "${SERVER}")
assert_contains "T-98.09: SDK imported lazily (await import)" 'await import("@modelcontextprotocol/sdk/server/index.js")' "$srv"
assert_not_contains "T-98.09b: no top-level static SDK import" 'import { Server } from "@modelcontextprotocol/sdk' "$srv"


# ── E-95 (from ast_parser_test — E-302): ast-parser-mcp (ast-repository-map.md ──
# §Components 1, §API): Tree-sitter (WASM) symbol extraction + parse_workspace.
# Unit-tests the extractor on sample TS/JS source, then drives the REAL
# ast-parser-mcp server over stdio against an isolated temp workspace to verify
# .gitignore / node_modules / secret exclusion and path containment.

EXTRACTOR_AP="${REPO_ROOT}/src/mcp/ast-parser-mcp/extractor.mjs"
SERVER_AP="${REPO_ROOT}/src/mcp/ast-parser-mcp/index.js"



# ── Extractor unit tests (deterministic) ─────────────────────────────────────
UNIT=$(node --input-type=module -e "
import { extractFromSource, languageForFile } from '${EXTRACTOR_AP}';
const js = await extractFromSource('import fs from \"fs\";\nimport {join} from \"path\";\nexport function add(a,b){return a+b;}\nexport class Router{ dispatch(req,timeoutMs){} register(name){} }\nconst dep=require(\"./registry.json\");\nexport default Router;\nmodule.exports.helper=function(){};', 'javascript');
const ts = await extractFromSource('import {X} from \"./x\";\nexport interface Opts{a:number}\nexport type Id=string;\nexport class Svc{ run(opts:Opts):void {} }\nexport const VERSION=\"1\";', 'typescript');
const none = await extractFromSource('print(1)', 'python');
console.log(JSON.stringify({ js, ts, none,
  lang: { ts: languageForFile('a.ts'), tsx: languageForFile('a.tsx'), mjs: languageForFile('a.mjs'), py: languageForFile('a.py') } }));
")
# Single single-quoted python program (no shell escaping); pipe-split fields.
IFS='|' read -r U_EXP U_SIGS U_IMP U_TSEXP U_NONE U_LTS U_LTSX U_LPY <<<"$(python3 -c '
import json,sys
d=json.loads(sys.argv[1]); js=d["js"]; ts=d["ts"]
print("|".join([
  ",".join(js["exports"]),
  ",".join(m["signature"] for c in js["classes"] for m in c["methods"]),
  ",".join(js["imports"]),
  ",".join(ts["exports"]),
  str(d["none"]),
  str(d["lang"]["ts"]), str(d["lang"]["tsx"]), str(d["lang"]["py"]),
]))' "$UNIT")"

assert_contains "T-95.01: JS exports (fn/class/default/cjs)"       "add,Router,default,helper" "$U_EXP"
assert_contains "T-95.02: JS class Router + dispatch sig"          "dispatch(req,timeoutMs)"   "$U_SIGS"
assert_contains "T-95.03: JS imports incl require target"          "./registry.json"           "$U_IMP"
assert_contains "T-95.03b: JS imports incl es-module"              "fs"                        "$U_IMP"
assert_contains "T-95.04: TS exports (interface/type/class/const)" "Opts,Id,Svc,VERSION"       "$U_TSEXP"
assert_contains "T-95.05: unsupported lang → null"                 "None"        "$U_NONE"
assert_contains "T-95.06a: .ts → typescript"                       "typescript"  "$U_LTS"
assert_contains "T-95.06b: .tsx → tsx"                             "tsx"         "$U_LTSX"
assert_contains "T-95.06c: .py → null"                             "None"        "$U_LPY"

# ── parse_workspace integration (real MCP, isolated temp workspace) ──────────
TMP_AP="$(mktemp -d)"
WS="${TMP_AP}/ws"
mkdir -p "${WS}/src" "${WS}/node_modules/pkg"
printf 'import bar from "./bar.ts";\nexport function foo(){ return 1; }\n' > "${WS}/src/foo.js"
printf 'export class Bar { m(x){ return x; } }\n'                          > "${WS}/src/bar.ts"
printf 'export const SHOULD_BE_IGNORED = 1;\n'                              > "${WS}/ignored.js"
printf 'export function shouldNotAppear(){}\n'                             > "${WS}/node_modules/pkg/index.js"
printf 'KEY=supersecret\n'                                                 > "${WS}/.env"
printf 'ignored.js\n'                                                      > "${WS}/.gitignore"

call() {
  printf '%s' "$(mcp_call_tool "$1" "$2" "$3")" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
c=d.get("content",[{}]); print(c[0].get("text","") if c else "")'
}

RES=$(cd "${WS}" && call "${SERVER_AP}" parse_workspace '{"dir_path":"."}')
files=$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(",".join(s["file_path"] for s in d.get("symbols",[])))' <<<"$RES")

assert_contains   "T-95.07: foo.js parsed"            "src/foo.js" "$files"
assert_contains   "T-95.08: bar.ts class parsed"      "src/bar.ts" "$files"
assert_not_contains "T-95.09: .gitignored file excluded" "ignored.js" "$files"
assert_not_contains "T-95.10: node_modules excluded"     "node_modules" "$files"
# Bar's method captured
bar_methods=$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read())
b=next((s for s in d["symbols"] if s["file_path"]=="src/bar.ts"),{})
print(",".join(m["name"] for c in b.get("classes",[]) for m in c.get("methods",[])))' <<<"$RES")
assert_contains   "T-95.08b: Bar.m method extracted"  "m" "$bar_methods"

# ── path containment ─────────────────────────────────────────────────────────
DENY=$(cd "${WS}" && printf '%s' "$(mcp_call_tool "${SERVER_AP}" parse_workspace '{"dir_path":"../../.."}')")
assert_contains   "T-95.11: path escape denied"       "PATH_DENIED" "$DENY"

rm -rf "${TMP_AP}"

# ── E-97 (from repo_map_generate_test — E-302): generate_map / REPO_MAP.md ──
# serialization (ast-repository-map.md §API, §Execution Constraints token budget).
# Unit-tests the serializer (skeleton format, ⋮ elision, budget trimming) then
# drives the real ast-parser-mcp generate_map tool to confirm it writes
# .ai/REPO_MAP.md and honours the budget + REIN_DISABLE_REPO_MAP rollback.

SER="${REPO_ROOT}/src/mcp/ast-parser-mcp/serializer.mjs"
SERVER_RG="${REPO_ROOT}/src/mcp/ast-parser-mcp/index.js"


# ── Serializer unit tests ────────────────────────────────────────────────────
OUT=$(node --input-type=module -e "
import { serializeRepoMap, estimateTokens } from '${SER}';
const syms=[
 {file_path:'src/hub.js',centrality_score:1,exports:['helper'],classes:[{name:'Hub',methods:[{name:'go',signature:'go(x,y)'}]}],imports:[]},
 {file_path:'src/a.js',centrality_score:0.5,exports:['A'],classes:[],imports:['./hub.js']},
 {file_path:'src/z.js',centrality_score:0.1,exports:['Z'],classes:[],imports:['./hub.js']},
];
const full=serializeRepoMap(syms,{maxTokens:2048});
console.log('FULL_INCLUDED='+full.included+'/'+full.total);
console.log('HAS_ELISION='+full.markdown.includes('go(x,y) ⋮'));
console.log('HAS_CLASS='+full.markdown.includes('class Hub'));
console.log('HUB_FIRST='+(full.markdown.indexOf('src/hub.js')<full.markdown.indexOf('src/z.js')));
const tiny=serializeRepoMap(syms,{maxTokens:60});
console.log('TINY_INCLUDED='+tiny.included);
console.log('TINY_KEEPS_HUB='+tiny.markdown.includes('src/hub.js'));
console.log('TINY_TRIMS_Z='+(!tiny.markdown.includes('src/z.js')));
console.log('EST='+estimateTokens('abcdefgh'));
")
assert_contains "T-97.01: full map includes all files"     "FULL_INCLUDED=3/3"  "$OUT"
assert_contains "T-97.02: function body elided with ⋮"      "HAS_ELISION=true"   "$OUT"
assert_contains "T-97.03: class skeleton rendered"          "HAS_CLASS=true"     "$OUT"
assert_contains "T-97.04: ranked hub-first ordering"        "HUB_FIRST=true"     "$OUT"
assert_contains "T-97.05: tiny budget trims to 1 file"      "TINY_INCLUDED=1"    "$OUT"
assert_contains "T-97.06: budget keeps highest-centrality"  "TINY_KEEPS_HUB=true" "$OUT"
assert_contains "T-97.07: budget trims lowest-centrality"   "TINY_TRIMS_Z=true"  "$OUT"
assert_contains "T-97.08: estimateTokens ~chars/4"          "EST=2"              "$OUT"

# ── generate_map integration (real MCP) ──────────────────────────────────────
TMP_RG="$(mktemp -d)"; WS="${TMP_RG}/ws"; mkdir -p "${WS}/src"
printf 'export function helper(){ return 1; }\nexport class Hub { go(x,y){ return x+y; } }\n' > "${WS}/src/hub.js"
printf 'import {helper} from "./hub.js";\nexport function useIt(){ return helper(); }\n'     > "${WS}/src/importer.js"
call_rg() {
  printf '%s' "$(mcp_call_tool "$1" "$2" "$3")" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
c=d.get("content",[{}]); print(c[0].get("text","") if c else "")'
}

RES_RG=$(cd "${WS}" && call_rg "${SERVER_RG}" generate_map '{"dir_path":"."}')
assert_contains "T-97.09: generate_map reports REPO_MAP.md path" '".ai/REPO_MAP.md"' "$RES_RG"
assert_contains "T-97.10: reports files_included"               '"files_included"'   "$RES_RG"
assert_exists   "${WS}/.ai/REPO_MAP.md"
MAP=$(cat "${WS}/.ai/REPO_MAP.md" 2>/dev/null || echo "")
assert_contains "T-97.11: REPO_MAP.md lists hub.js"   "src/hub.js" "$MAP"
assert_contains "T-97.12: REPO_MAP.md elides body"    "⋮"          "$MAP"
assert_contains "T-97.13: REPO_MAP.md auto-gen header" "AST Repository Map" "$MAP"

# Budget: tiny max_tokens → fewer files than the full run.
RES_TINY=$(cd "${WS}" && call_rg "${SERVER_RG}" generate_map '{"dir_path":".","max_tokens":50}')
inc_tiny=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["files_included"])' <<<"$RES_TINY" 2>/dev/null || echo "?")
assert_match "T-97.14: small budget includes ≤1 file" "^[01]$" "$inc_tiny"

# Rollback: REIN_DISABLE_REPO_MAP=1 → no-op, no write.
TMP2_RG="$(mktemp -d)"; WS2="${TMP2_RG}/ws"; mkdir -p "${WS2}/src"
printf 'export const X=1;\n' > "${WS2}/src/x.js"
RES_OFF=$(cd "${WS2}" && export REIN_DISABLE_REPO_MAP=1 && call_rg "${SERVER_RG}" generate_map '{"dir_path":"."}')
assert_contains "T-97.15: disabled flag short-circuits" "REPO_MAP_DISABLED" "$RES_OFF"
if [ -f "${WS2}/.ai/REPO_MAP.md" ]; then _fail "T-97.16: no REPO_MAP.md written when disabled"; else _pass "T-97.16: no REPO_MAP.md written when disabled"; fi

rm -rf "${TMP_RG}" "${TMP2_RG}"

# ── E-96 (from repo_mapper_test — E-302): dependency-graph centrality ranking ──
# (ast-repository-map.md §Components 2, §Core Concept): src/mcp/ast-parser-mcp/
# repo-mapper.mjs + its wiring into parse_workspace.
# Unit-tests the pure ranking module (import resolution, PageRank centrality,
# sorting) via labeled node output, then drives the real ast-parser-mcp server
# to confirm parse_workspace now returns centrality_score.

MAPPER="${REPO_ROOT}/src/mcp/ast-parser-mcp/repo-mapper.mjs"
SERVER_RM="${REPO_ROOT}/src/mcp/ast-parser-mcp/index.js"


# ── Unit tests (deterministic; node prints KEY=value lines) ──────────────────
OUT_RM=$(node --input-type=module -e "
import { rankSymbols, resolveImport, normalizePath, buildDependencyGraph } from '${MAPPER}';
const syms=[
 {file_path:'src/util.js',exports:['helper'],classes:[],imports:[]},
 {file_path:'src/a.js',exports:['A'],classes:[],imports:['./util.js']},
 {file_path:'src/b.js',exports:['B'],classes:[],imports:['./util']},
 {file_path:'src/c.js',exports:['C'],classes:[],imports:['./util.js','fs']},
 {file_path:'src/lonely.js',exports:['L'],classes:[],imports:[]},
];
const r=rankSymbols(syms);
const util=r.find(s=>s.file_path==='src/util.js');
const a=r.find(s=>s.file_path==='src/a.js');
console.log('TOP='+r[0].file_path);
console.log('UTIL='+util.centrality_score);
console.log('HUB_GT_LEAF='+(util.centrality_score>a.centrality_score));
console.log('SORTED='+r.every((s,i)=>i===0||r[i-1].centrality_score>=s.centrality_score));
console.log('INRANGE='+r.every(s=>s.centrality_score>=0&&s.centrality_score<=1));
console.log('RESOLVE_NOEXT='+resolveImport('src/b.js','./util',new Set(['src/util.js'])));
console.log('RESOLVE_INDEX='+resolveImport('src/a/b.js','../util',new Set(['src/util/index.js'])));
console.log('RESOLVE_EXTERNAL='+resolveImport('src/b.js','fs',new Set(['src/util.js'])));
console.log('NORM='+normalizePath('a/./b/../c'));
console.log('EMPTY='+JSON.stringify(rankSymbols([])));
console.log('EDGE='+[...(buildDependencyGraph(syms).edges.get('src/a.js')||[])].join(','));
")

assert_contains "T-96.01: hub (util) ranks first"        "TOP=src/util.js"        "$OUT_RM"
assert_contains "T-96.02: hub centrality normalized to 1" "UTIL=1"                "$OUT_RM"
assert_contains "T-96.03: hub outranks a leaf"           "HUB_GT_LEAF=true"       "$OUT_RM"
assert_contains "T-96.04: output sorted desc"            "SORTED=true"            "$OUT_RM"
assert_contains "T-96.05: scores within [0,1]"           "INRANGE=true"           "$OUT_RM"
assert_contains "T-96.06: resolves extension-less import" "RESOLVE_NOEXT=src/util.js" "$OUT_RM"
assert_contains "T-96.07: resolves dir/index import"     "RESOLVE_INDEX=src/util/index.js" "$OUT_RM"
assert_contains "T-96.08: external import → null"        "RESOLVE_EXTERNAL=null"  "$OUT_RM"
assert_contains "T-96.09: normalizePath collapses ./.."  "NORM=a/c"               "$OUT_RM"
assert_contains "T-96.10: empty input → []"              "EMPTY=[]"               "$OUT_RM"
assert_contains "T-96.11: graph edge a→util built"       "EDGE=src/util.js"       "$OUT_RM"

# ── Integration: parse_workspace now returns centrality_score ────────────────
TMP_RM="$(mktemp -d)"; WS="${TMP_RM}/ws"; mkdir -p "${WS}/src"
printf 'export function helper(){ return 1; }\n'                 > "${WS}/src/hub.js"
printf 'import {helper} from "./hub.js";\nexport function useIt(){ return helper(); }\n' > "${WS}/src/importer.js"
call_rm() {
  printf '%s' "$(mcp_call_tool "$1" "$2" "$3")" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
c=d.get("content",[{}]); print(c[0].get("text","") if c else "")'
}
RES_RM=$(cd "${WS}" && call_rm "${SERVER_RM}" parse_workspace '{"dir_path":"."}')
# hub.js (imported by importer.js) must have a centrality_score and outrank importer
verdict=$(python3 -c 'import json,sys
d=json.loads(sys.stdin.read()); m={s["file_path"]:s.get("centrality_score") for s in d["symbols"]}
hub=m.get("src/hub.js"); imp=m.get("src/importer.js")
print("HAS_SCORE="+str(hub is not None)+" HUB_TOP="+str(hub is not None and imp is not None and hub>=imp))' <<<"$RES_RM")
assert_contains "T-96.12: parse_workspace emits centrality_score" "HAS_SCORE=True" "$verdict"
assert_contains "T-96.13: imported hub outranks importer"         "HUB_TOP=True"   "$verdict"

rm -rf "${TMP_RM}"

assert_summary
