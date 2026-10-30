#!/usr/bin/env bash
# orchestrator_dispatch_test.sh — Tests for E-92 run_dispatch (DAG-aware
# dispatch planner) in orchestrator-mcp, per ecc-integrations.md §Components 4.
#
# Builds a real dependency graph via task-synchronizer-mcp (E-91 add_task /
# update_task_status) then queries the real orchestrator-mcp run_dispatch tool.
# Covers: ready frontier classification, blocked tasks with unmet deps,
# parallel/sequential/idle dispatch_mode, the post-cascade frontier, owner
# filtering, and the empty-state idle case.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/mcp-client.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SYNC="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"
ORCH="${REPO_ROOT}/src/mcp/orchestrator-mcp/index.js"

echo "── Suite: orchestrator_dispatch_test (E-92) ────────────────────────"

unset REIN_WORKSPACE REIN_WORKSPACE_DISABLE 2>/dev/null || true

TMP="$(mktemp -d)"
PROJECT="${TMP}/proj"
mkdir -p "${PROJECT}/.ai"
cat > "${PROJECT}/.ai/state.json" <<'JSON'
{
  "version": "1.0",
  "project": { "current_tier": null, "release_verdict": null, "focus": null },
  "tasks": [], "stamps": [], "deltas": [],
  "digest_stale": false, "digest_stale_reason": null
}
JSON
cd "${PROJECT}"

# call <server> <tool> <args_json> → tool text payload (content[0].text)
call() {
  printf '%s' "$(mcp_call_tool "$1" "$2" "$3")" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
c=d.get("content",[{}]); print(c[0].get("text","") if c else "")'
}

# summarise run_dispatch JSON → "mode|readyIds|blockedIds"
dispatch_summary() {
  python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("ERR||"); sys.exit(0)
print(d.get("dispatch_mode","?")+"|"+",".join(t["id"] for t in d.get("ready",[]))+"|"+",".join(t["id"] for t in d.get("blocked",[])))' <<<"$1"
}
# blocked_by ids for a given task id in a run_dispatch payload
blocked_by_of() {
  TID="$2" python3 -c 'import json,sys,os
try: d=json.load(sys.stdin)
except Exception: print("ERR"); sys.exit(0)
t=next((x for x in d.get("blocked",[]) if x["id"]==os.environ["TID"]),None)
print("MISSING" if t is None else ",".join(t.get("blocked_by",[])))' <<<"$1"
}

OWNER='Engineer (Claude)'
ARCH='Architect (Claude)'

# ── T-92.00: run_dispatch is registered in orchestrator allowed-tools (v3.0 W1-T1).
# Regression guard — it was implemented but unlisted before v3.0. ─────────────
reg=$(node -e "const r=require('${REPO_ROOT}/src/config/registry.json'); process.stdout.write((r.mcp_servers['orchestrator-mcp']['allowed-tools']||[]).join(','))")
assert_contains "T-92.00: run_dispatch in registry allowed-tools" "run_dispatch" "$reg"

# ── T-92.01: empty state (no state.sqlite yet) → idle ────────────────────────
r=$(call "${ORCH}" run_dispatch "{}")
assert_contains "T-92.01: idle when no state.sqlite" '"dispatch_mode": "idle"' "$r"

# ── Build the graph: E-1 (root), E-2 deps[E-1], E-3 (independent) ────────────
call "${SYNC}" add_task "{\"owner\":\"${OWNER}\",\"description\":\"root\",\"tier\":2}"                       >/dev/null  # E-1 OPEN
call "${SYNC}" add_task "{\"owner\":\"${OWNER}\",\"description\":\"needs E-1\",\"tier\":2,\"depends_on\":[\"E-1\"]}" >/dev/null  # E-2 BLOCKED
call "${SYNC}" add_task "{\"owner\":\"${OWNER}\",\"description\":\"independent\",\"tier\":2}"                 >/dev/null  # E-3 OPEN

# ── T-92.02: two independent ready tasks → parallel; E-2 blocked ─────────────
sum=$(dispatch_summary "$(call "${ORCH}" run_dispatch "{}")")
assert_contains "T-92.02: dispatch_mode parallel" "parallel|" "$sum"
assert_contains "T-92.02: E-1 in ready frontier"  "E-1" "${sum#*|}"
assert_contains "T-92.02: E-3 in ready frontier"  "E-3" "${sum#*|}"
assert_contains "T-92.02: E-2 is blocked"         "E-2" "${sum##*|}"

# ── T-92.03: E-2 blocked_by lists E-1 ────────────────────────────────────────
r=$(call "${ORCH}" run_dispatch "{}")
assert_contains "T-92.03: E-2 blocked_by E-1" "E-1" "$(blocked_by_of "$r" E-2)"

# ── T-92.04: completing E-1 cascades E-2 into the ready frontier ─────────────
call "${SYNC}" update_task_status "{\"id\":\"E-1\",\"status\":\"DONE\",\"summary\":\"done\"}" >/dev/null
r=$(call "${ORCH}" run_dispatch "{}")
sum=$(dispatch_summary "$r")
assert_contains "T-92.04: still parallel"   "parallel|"      "$sum"
assert_contains "T-92.04: E-2 now ready"    "E-2"            "${sum#*|}"
assert_contains "T-92.04: E-3 still ready"  "E-3"            "${sum#*|}"
assert_contains "T-92.04: nothing blocked"  '"blocked": 0'   "$r"

# ── T-92.05: completing all OPEN tasks → idle ────────────────────────────────
call "${SYNC}" update_task_status "{\"id\":\"E-2\",\"status\":\"DONE\",\"summary\":\"done\"}" >/dev/null
call "${SYNC}" update_task_status "{\"id\":\"E-3\",\"status\":\"DONE\",\"summary\":\"done\"}" >/dev/null
r=$(call "${ORCH}" run_dispatch "{}")
assert_contains "T-92.05: idle when all DONE" '"dispatch_mode": "idle"' "$r"

# ── T-92.06: owner filter isolates the dispatch frontier by role ─────────────
# Both roles run on the same provider (E-254), so the filter must key on the ROLE half of
# the owner label — a provider-name filter could no longer tell them apart.
call "${SYNC}" add_task "{\"owner\":\"${OWNER}\",\"description\":\"eng task\",\"tier\":2}"                 >/dev/null  # E-4 (Engineer)
call "${SYNC}" add_task "{\"owner\":\"${ARCH}\",\"description\":\"arch task\",\"prefix\":\"P\",\"tier\":2}" >/dev/null  # P-1 (Architect)
sum_eng=$(dispatch_summary "$(call "${ORCH}" run_dispatch "{\"owner\":\"engineer\"}")")
sum_arch=$(dispatch_summary "$(call "${ORCH}" run_dispatch "{\"owner\":\"architect\"}")")
assert_contains "T-92.06: engineer filter → E-4 ready"      "E-4" "${sum_eng#*|}"
assert_not_contains "T-92.06: engineer filter excludes P-1" "P-1" "${sum_eng#*|}"
assert_contains "T-92.06: architect filter → P-1 ready"      "P-1" "${sum_arch#*|}"
assert_not_contains "T-92.06: architect filter excludes E-4" "E-4" "${sum_arch#*|}"

cd "${REPO_ROOT}"
rm -rf "${TMP}"
assert_summary
