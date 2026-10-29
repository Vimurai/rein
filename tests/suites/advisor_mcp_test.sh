#!/usr/bin/env bash
# advisor_mcp_test.sh — Unit tests for advisor-mcp (E-9)
# Tests A2A bridge logic: prompt construction, LOG.md writes, error handling,
# graceful degradation when the Architect is unavailable, registry registration.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SERVER="${REPO_ROOT}/src/mcp/advisor-mcp/index.js"

echo "── Suite: advisor_mcp ───────────────────────────────────────────────"

# ── T-A2A-01: File structure ─────────────────────────────────────────────────
echo ""
echo "  [T-A2A-01] File structure"

assert_status 0 "index.js exists" test -f "$SERVER"
assert_status 0 "package.json exists" test -f "${REPO_ROOT}/src/mcp/advisor-mcp/package.json"

# ── T-A2A-02: Single tool declared (E-37: behavioral roundtrip) ─────────────
echo ""
echo "  [T-A2A-02] Tool declaration"

# Source the behavioral helper alongside the source-level assertions.
source "${SCRIPT_DIR}/../lib/mcp-client.sh"

assert_status 0 "ask_architect advertised in tools/list" \
  mcp_assert_tool_listed "$SERVER" "ask_architect"

assert_status 0 "query parameter required (inputSchema.required)" \
  mcp_assert_tool_param_required "$SERVER" "ask_architect" "query"

assert_status 1 "blueprint parameter optional (NOT in inputSchema.required)" \
  mcp_assert_tool_param_required "$SERVER" "ask_architect" "blueprint"

# ── T-A2A-03: Read-only constraint — no write flags in Architect invocation ──
echo ""
echo "  [T-A2A-03] Architect read-only constraint"

# E-210 (D-054): the executable is RESOLVED from .ai/roles.json, never a literal.
assert_status 1 "no hardcoded executable literal in execFileSync (E-210)" \
  grep -qE 'execFileSync\("' "$SERVER"
assert_status 0 "execFileSync spawns the resolved provider" \
  grep -q 'execFileSync(provider, args' "$SERVER"
assert_status 0 "architect provider resolved from roles.json" \
  grep -q 'roleProvider(AI_DIR, "architect")' "$SERVER"
assert_status 0 "argv built from the providers.json print_mode template" \
  grep -q 'buildArgv(adapter.print_mode' "$SERVER"

# Match the quoted argv form so the docstring's prose mention of the flag
# (explaining why we omit it) doesn't trip the guard — mirrors --write/--edit below.
assert_status 1 "architect not invoked with --dangerously-skip-permissions (read-only)" \
  grep -q '"--dangerously-skip-permissions"' "$SERVER"

assert_status 1 "architect not invoked with --write flag" \
  grep -q '"--write"' "$SERVER"

assert_status 1 "architect not invoked with --edit flag" \
  grep -q '"--edit"' "$SERVER"

assert_status 0 "print mode (-p) carried by every providers.json print_mode template" \
  bash -c "python3 - <<'PYEOF'
import json,sys
d=json.load(open('src/templates/providers.json'))['providers']
sys.exit(0 if all('-p' in v.get('print_mode',[]) for v in d.values()) else 1)
PYEOF"

assert_status 0 "execFileSync used (not execSync — prevents shell injection)" \
  grep -q 'execFileSync' "$SERVER"

assert_status 1 "execSync not used for architect call" \
  grep -qE '^[^/]*execSync\b' "$SERVER"

# ── T-A2A-04: [A2A_RULING] log format ────────────────────────────────────────
echo ""
echo "  [T-A2A-04] [A2A_RULING] audit log"

assert_status 0 "[A2A_RULING] stamp written to LOG.md" \
  grep -q 'A2A_RULING' "$SERVER"

assert_status 0 "logRuling appends to LOG.md via appendFileSync" \
  grep -q 'appendFileSync' "$SERVER"

assert_status 0 "logRuling includes query in entry" \
  grep -q 'Query:' "$SERVER"

assert_status 0 "logRuling includes ruling in entry" \
  grep -q 'Ruling:' "$SERVER"

# ── T-A2A-05: architect.md pre-loaded as context ─────────────────────────────
echo ""
echo "  [T-A2A-05] architect.md context injection"

assert_status 0 "architect.md path resolved" \
  grep -q 'architect.md' "$SERVER"

assert_status 0 "architect context included in prompt" \
  grep -q 'architect.md (current system blueprint)' "$SERVER"

assert_status 0 "safeRead returns empty string on missing file" \
  node -e "
const safeRead = (path) => {
  try { return require('fs').readFileSync(path, 'utf8'); } catch { return ''; }
};
const result = safeRead('/tmp/definitely_missing_file_xyz.md');
if (result !== '') process.exit(1);
" 2>/dev/null || node --input-type=module <<'JS' 2>/dev/null
import { readFileSync } from 'fs';
const safeRead = (p) => { try { return readFileSync(p,'utf8'); } catch { return ''; } };
if (safeRead('/tmp/definitely_missing_xyz.md') !== '') process.exit(1);
JS

# ── T-A2A-06: Optional blueprint loading ─────────────────────────────────────
echo ""
echo "  [T-A2A-06] Optional domain blueprint loading"

assert_status 0 "blueprint param loads from blueprints dir" \
  grep -q 'BLUEPRINTS_DIR' "$SERVER"

assert_status 0 "blueprint path constructed safely" \
  grep -q '`${blueprint}.md`' "$SERVER"

assert_status 0 "missing blueprint handled gracefully (warn only)" \
  grep -q 'Blueprint not found' "$SERVER"

# ── T-A2A-07: Input validation ───────────────────────────────────────────────
echo ""
echo "  [T-A2A-07] Input validation"

assert_status 0 "empty query rejected" \
  grep -q 'query.trim().length === 0' "$SERVER"

assert_status 0 "non-string query rejected" \
  grep -q "typeof query !== \"string\"" "$SERVER"

# ── T-A2A-08: Graceful degradation when the Architect is unavailable ────────
echo ""
echo "  [T-A2A-08] Graceful degradation"

assert_status 0 "error caught and returned as MCP error response" \
  grep -q 'isError: true' "$SERVER"

assert_status 0 "fallback message provided when Architect unavailable" \
  grep -q 'fallback' "$SERVER"

assert_status 0 "server does not crash on Architect failure (catch block present)" \
  grep -q 'Architect (\${failedProvider}) unavailable' "$SERVER"

# ── T-A2A-09: Project root discovery ─────────────────────────────────────────
echo ""
echo "  [T-A2A-09] Project root discovery"

assert_status 0 "findProjectRoot walks up directory tree" \
  grep -q 'findProjectRoot' "$SERVER"

assert_status 0 "falls back to cwd() if .ai/architect.md not found" \
  grep -q 'process.cwd()' "$SERVER"

# ── T-A2A-10: Observability ──────────────────────────────────────────────────
echo ""
echo "  [T-A2A-10] Observability — structured JSON logging"

assert_status 0 "shared logger imported" \
  grep -q 'createLogger.*shared/logger' "$SERVER"

assert_status 0 "logger initialised with SERVICE" \
  grep -q 'createLogger(SERVICE)' "$SERVER"

assert_status 0 "latency_ms tracked" \
  grep -q 'latency_ms' "$SERVER"

assert_status 0 "startup log entry emitted" \
  grep -q '"startup"' "$SERVER"

# ── T-A2A-11: Registry and .mcp.json registration ────────────────────────────
echo ""
echo "  [T-A2A-11] Registry and .mcp.json"

assert_status 0 "advisor-mcp in registry.json" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('${REPO_ROOT}/src/config/registry.json', 'utf8'));
if (!r.mcp_servers['advisor-mcp']) process.exit(1);
JS

assert_status 0 "registry allows only ask_architect tool" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('${REPO_ROOT}/src/config/registry.json', 'utf8'));
const tools = r.mcp_servers['advisor-mcp']['allowed-tools'];
if (!Array.isArray(tools) || tools.length !== 1 || tools[0] !== 'ask_architect') process.exit(1);
JS

# E-364 (D-117): .mcp.json is generated by `rein sync` and no longer tracked, so a clean checkout
# has none. What it would show is that the registry entry has a path: rein_sync_test's generator
# rows and tests/tools/registry-drift.sh prove every path-based registry server is wired.
assert_status 0 "advisor-mcp is a path-based registry server (the sync step wires it into .mcp.json)" \
  node --input-type=module <<JS
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('${REPO_ROOT}/src/config/registry.json', 'utf8'));
if (!r.mcp_servers['advisor-mcp'] || !r.mcp_servers['advisor-mcp'].path) process.exit(1);
JS

# ── T-A2A-12 (E-210 / D-054): provider-aware argv + nested-session env strip ──
# The bridge must build argv from .ai/providers.json rather than a vendor literal, so
# the bridge consults whichever provider roles.json binds to the architect role.
echo "  [T-A2A-12] Provider-aware bridge (E-210)"

_argv() {  # <provider> <key> [model] → JSON argv from the real shared module
  node --input-type=module -e "
import { providerAdapter, buildArgv } from './src/shared/provider-adapter.mjs';
const a = providerAdapter('.ai', '$1');
console.log(JSON.stringify(buildArgv(a['$2'], { prompt: 'Q', rulefile: 'ARCHITECT.md', role: 'architect', model: '${3:-}' })));
" 2>/dev/null
}

assert_contains "T-A2A-12.01: claude print_mode appends ARCHITECT.md (else it boots ENGINEER — gap G1)" \
  '"--append-system-prompt-file","ARCHITECT.md"' "$(_argv claude print_mode)"
assert_contains "T-A2A-12.02: claude print_mode is read-only print mode" '"-p"' "$(_argv claude print_mode)"
assert_not_contains "T-A2A-12.03: claude print_mode carries NO permission bypass" \
  "dangerously" "$(_argv claude print_mode)"
# E-254: claude is the only built-in adapter; an unknown provider borrows no argv.
assert_match "T-A2A-12.04: built-in adapters are claude only (E-254)" '^\["claude"\]$' \
  "$(node --input-type=module -e "
import { DEFAULT_ADAPTERS } from './src/shared/provider-adapter.mjs';
console.log(JSON.stringify(Object.keys(DEFAULT_ADAPTERS)));
" 2>/dev/null)"
assert_match "T-A2A-12.05: unknown provider (acme) gets an empty print_mode argv, not claude's" \
  '^\[\]$' "$(_argv acme print_mode)"

# Launch argv (consumed by `rein pane`, E-208) — the {model} pair must vanish when unset.
assert_contains "T-A2A-12.06: claude launch forwards a configured model" \
  '"--model","claude-opus-5"' "$(_argv claude launch claude-opus-5)"
assert_not_contains "T-A2A-12.07: unset model drops the whole --model pair (no dangling flag)" \
  "--model" "$(_argv claude launch)"
assert_contains "T-A2A-12.08: claude launch selects the per-role settings overlay" \
  '".claude/settings.architect.json"' "$(_argv claude launch)"

# Nested-session guard: Claude Code refuses to nest while it inherits CLAUDECODE=1.
_child_env() {
  node --input-type=module -e "
import { providerAdapter, childEnv } from './src/shared/provider-adapter.mjs';
console.log(JSON.stringify(childEnv({ PATH: '/p', HOME: '/h', CLAUDECODE: '1' }, providerAdapter('.ai', '$1'))));
" 2>/dev/null
}
assert_not_contains "T-A2A-12.09: CLAUDECODE stripped from a claude child env (nested-session guard)" \
  "CLAUDECODE" "$(_child_env claude)"
assert_contains "T-A2A-12.10: PATH survives the strip" "PATH" "$(_child_env claude)"
assert_contains "T-A2A-12.11: HOME survives the strip" "HOME" "$(_child_env claude)"

# Env must remain an explicit allowlist — never a process.env spread (D-002).
assert_status 1 "T-A2A-12.12: process.env is never spread into the child" \
  grep -qE '\.\.\.process\.env' "$SERVER"
assert_status 0 "T-A2A-12.13: child env routed through childEnv (adapter strip applied)" \
  grep -q 'childEnv(baseEnv, adapter)' "$SERVER"

# USER is load-bearing for a claude Architect: with only PATH+HOME the child exits
# "Not logged in - Please run /login" (bisected against the live CLI, E-210). It is an
# account name, not a secret, so the allowlist stays secret-free.
assert_status 0 "T-A2A-12.13b: USER present in the env allowlist (claude login resolution)" \
  grep -qE 'USER: process\.env\.USER' "$SERVER"
assert_status 0 "T-A2A-12.13c: PATH still allowlisted" \
  grep -qE 'PATH: process\.env\.PATH' "$SERVER"
assert_status 0 "T-A2A-12.13d: HOME still allowlisted" \
  grep -qE 'HOME: process\.env\.HOME' "$SERVER"

# Fallback to the D-066 default when roles.json is absent — the all-Claude Triad.
assert_contains "T-A2A-12.14: unconfigured architect role falls back to claude (D-066)" "claude" \
  "$(node --input-type=module -e "
import { roleProvider } from './src/shared/provider-adapter.mjs';
console.log(roleProvider('/nonexistent-dir', 'architect'));
" 2>/dev/null)"


assert_summary
