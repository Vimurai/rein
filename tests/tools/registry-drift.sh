#!/usr/bin/env bash
# registry-drift.sh — source registry vs install layer drift guard (P-15; the registry_sync
# rows, kept as ONE copy by E-302).
#
# Catches the failure class diagnosed in the 2026-04-27 audit: the project registry adds a new
# MCP, but ~/.rein/config/registry.json is never refreshed, so `ai sync` regenerates .mcp.json
# from a stale registry and silently drops the new server. Detect the divergence early so the
# contributor remembers to re-run install-rein.sh.
#
# Two callers, one copy of the checks:
#   - hooks/pre-commit.sh (check_registry_sync) RUNS it on a commit that touches the registry:
#     standalone, it sources assert.sh itself, runs from the repository root and exits non-zero
#     on any failed check (assert_summary);
#   - tests/suites/ai_sync_test.sh SOURCES it, so the checks count as that suite's assertions.
# Paths are relative to the repository root; the standalone run cds there.
_rd_standalone=0
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  _rd_standalone=1
  set -uo pipefail
  # The root is this file's own location minus tests/tools — not git's answer, which an
  # exported GIT_DIR / GIT_WORK_TREE can redirect (critic_security P2, E-302).
  _rd_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || exit 1
  _rd_root="${_rd_dir%/tests/tools}"
  [[ "$_rd_root" != "$_rd_dir" && -f "${_rd_root}/tests/lib/assert.sh" ]] || exit 1
  source "${_rd_root}/tests/lib/assert.sh"
  cd "$_rd_root" || exit 1
fi

REG_LOCAL="src/config/registry.json"
REG_GLOBAL="${HOME}/.rein/config/registry.json"
REG_TEMPLATE="src/templates/.mcp.json"

assert_exists "$REG_LOCAL"

# 1. Local registry must parse and contain mcp_servers.
assert_status 0 "local registry parses as JSON" \
  bash -c "python3 -c 'import json,sys; sys.exit(0 if json.load(open(\"$REG_LOCAL\")).get(\"mcp_servers\") else 1)'"

# 2. Template .mcp.json must list every path-based MCP from the registry.
#    (Drift here breaks the python3-missing fallback path in generate_mcp_json.)
#    Template is gitignored (regenerated locally), so skip if absent (CI/clones).
if [[ -f "$REG_TEMPLATE" ]]; then
  assert_status 0 "template .mcp.json covers every registry MCP" \
    bash -c "python3 - <<'PY'
import json, sys
reg = json.load(open('$REG_LOCAL')).get('mcp_servers', {})
expected = {n for n, info in reg.items() if 'path' in info}
tmpl = set(json.load(open('$REG_TEMPLATE')).get('mcpServers', {}).keys())
missing = expected - tmpl
sys.exit(0 if not missing else (sys.stderr.write(f'missing from template: {sorted(missing)}\n') or 1))
PY"
else
  echo "  ⚠  src/templates/.mcp.json absent (gitignored, regenerated locally) — skipping template drift check"
fi

# 3. If a global install exists, every local registry MCP must be present.
if [[ -f "$REG_GLOBAL" ]]; then
  assert_status 0 "global registry covers every local MCP (run install-rein.sh if this fails)" \
    bash -c "python3 - <<'PY'
import json, sys
local  = set(json.load(open('$REG_LOCAL')).get('mcp_servers', {}).keys())
glob   = set(json.load(open('$REG_GLOBAL')).get('mcp_servers', {}).keys())
missing = local - glob
sys.exit(0 if not missing else (sys.stderr.write(f'global registry missing: {sorted(missing)}\n') or 1))
PY"
else
  echo "  ⚠  ~/.rein/config/registry.json absent — skipping global drift check"
fi

# 4. Active .mcp.json (if generated) must wire every registry MCP.
if [[ -f .mcp.json ]]; then
  assert_status 0 ".mcp.json wires every path-based registry MCP" \
    bash -c "python3 - <<'PY'
import json, sys
reg = json.load(open('$REG_LOCAL')).get('mcp_servers', {})
expected = {n for n, info in reg.items() if 'path' in info}
active   = set(json.load(open('.mcp.json')).get('mcpServers', {}).keys())
missing  = expected - active
sys.exit(0 if not missing else (sys.stderr.write(f'.mcp.json missing: {sorted(missing)} — run: ai sync\n') or 1))
PY"
fi

# 5. E-38: Sandbox env propagation. If a registry entry declares an `env` block, the generated
#    .mcp.json must carry every key/value verbatim. Catches the D-002 regression where `ai sync`
#    silently stripped a server's declared sandbox env (the original case, the GUI server, was
#    retired by E-279; the mechanism stays for any server that declares env).
if [[ -f .mcp.json ]]; then
  assert_status 0 "registry env blocks propagated to .mcp.json (D-002 sandbox)" \
    bash -c "python3 - <<'PY'
import json, sys
reg = json.load(open('$REG_LOCAL')).get('mcp_servers', {})
mcp = json.load(open('.mcp.json')).get('mcpServers', {})
errs = []
for name, info in reg.items():
    expected_env = info.get('env')
    if not isinstance(expected_env, dict) or not expected_env:
        continue
    actual_env = (mcp.get(name) or {}).get('env') or {}
    for k, v in expected_env.items():
        if actual_env.get(k) != v:
            errs.append(f'{name}.env.{k}: expected {v!r}, got {actual_env.get(k)!r}')
sys.exit(0 if not errs else (sys.stderr.write('\n'.join(errs) + '\n') or 1))
PY"
fi

# Standalone, the exit status IS the gate: assert_summary only prints the counts, so the
# registry_sync suite the hook used to run exited 0 on a failed check and the drift gate never
# blocked (found in E-302). Sourced, the counts belong to the caller.
if [[ "$_rd_standalone" -eq 1 ]]; then assert_summary; [[ "$FAIL_COUNT" -eq 0 ]]; exit $?; fi
