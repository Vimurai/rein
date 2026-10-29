#!/usr/bin/env bash
# mcp_servers_test.sh — the custom MCP servers as processes: each exists, parses, is registered
# and answers real JSON-RPC (E-49, E-27); a long-running server announces a stale build (E-249)
# and reloads a changed policy (E-237); then each server's own contract — blueprint-aligner
# (E-45), verification (E-111), vibe-check's opt-in browser (E-235), token-budget (E-140) and
# the P-7..P-12 bounded reads. E-302 merged these suites here; each section names its source.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/mcp-client.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MCP_DIR="${REPO_ROOT}/src/mcp"
REGISTRY="${REPO_ROOT}/src/config/registry.json"

echo "── Suite: mcp_servers_test ──────────────────────────────────────────"

# ── 1. All custom MCP servers exist and pass Node.js syntax check ─────────────
for server in vibe-check-mcp task-synchronizer-mcp safe-exec-mcp \
              blueprint-aligner-mcp context-guardian-mcp risk-analyzer-mcp; do
  index="${MCP_DIR}/${server}/index.js"
  assert_exists "$index"
  assert_status 0 "${server}: syntax valid" node --check "$index"
done

# ── 2. Each server registers its expected tools ───────────────────────────────
# E-30: replaced 12 grep-against-source assertions (cat $SRC | assert_contains "tool")
# with behavioral roundtrips (the E-27 section below, from mcp_behavioral_test), which spawn
# each server and assert against the real tools/list response. Removes the ghost-assertion
# class that masked obsolete tool names (sync_tasks, append_tasks) for releases.
# Tool registration coverage lives exclusively in that section.

# ── 3. Registry lists all 8 custom servers with correct path fields ───────────
custom_servers=$(python3 -c "
import json, sys
reg = json.load(open(sys.argv[1]))
names = [n for n, v in reg.get('mcp_servers', {}).items() if 'path' in v]
print(' '.join(names))
" "$REGISTRY")

for server in vibe-check-mcp task-synchronizer-mcp safe-exec-mcp \
              blueprint-aligner-mcp context-guardian-mcp risk-analyzer-mcp; do
  assert_contains "registry has entry for ${server}" "$server" "$custom_servers"
done

# ── 4. E-276 (D-075): context-invoker-mcp is retired ──────────────────────────
# Its only job was loading skills/agents over MCP; the Skill and Agent tools do that
# natively. Gone from disk AND from the registry, so no generated .mcp.json names it.
assert_status 1 "context-invoker-mcp removed from src/mcp" test -e "${MCP_DIR}/context-invoker-mcp"
assert_not_contains "context-invoker-mcp removed from registry.json" "context-invoker-mcp" "$custom_servers"


# ── E-27 (from mcp_behavioral_test — E-302): behavioral JSON-RPC roundtrips ──
# Demonstrates the alternative to grep-against-source assertions: spawn each
# server, exchange real MCP frames, and assert against the protocol response.
# These tests survive cosmetic source changes (quote style, whitespace,
# comment edits) because they only depend on the public contract.
set +e


ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Each row: server-name : tool that must appear in tools/list

declare -a CASES=(
  "advisor-mcp:ask_architect"
  "approval-mcp:request_approval"
  "cache-manager-mcp:build_cache"
  "cache-manager-mcp:get_cached_context"
  "cache-manager-mcp:invalidate_cache"
  "cache-manager-mcp:get_cache_status"
  "task-synchronizer-mcp:get_state"
  "task-synchronizer-mcp:add_task"
  "task-synchronizer-mcp:update_task_status"
  "task-synchronizer-mcp:validate_payload"
  "orchestrator-mcp:run_handover"
  "orchestrator-mcp:run_review"
  "verification-mcp:verify_compliance"
  "safe-exec-mcp:analyze_command"
  "risk-analyzer-mcp:classify_risk"
  "risk-analyzer-mcp:get_tier_actions"
  "context-guardian-mcp:check_workspace"
  "memory-manager-mcp:export_signature"
  "memory-manager-mcp:query_signatures"
  "blueprint-aligner-mcp:align_diff"
  "blueprint-aligner-mcp:validate_blueprint_section"
  "patch-mcp:patch_file"
  "patch-mcp:get_file_md5"
  "propose-patch-mcp:propose_patch"
  "propose-patch-mcp:confirm_patch"
  "token-budget-mcp:get_token_budget"
  "token-budget-mcp:report_cost"
  "archive-manager-mcp:check_context_health"
  "archive-manager-mcp:execute_archive"
  "vibe-check-mcp:run_vibe_audit"
  "vibe-check-mcp:run_chaos_test"
  "vibe-check-mcp:get_performance_metrics"
)

for row in "${CASES[@]}"; do
  srv="${row%%:*}"
  tool="${row##*:}"
  server="${ROOT}/src/mcp/${srv}/index.js"
  if [[ ! -f "$server" ]]; then
    echo "  ⚠  skipped ${srv} (not installed)"
    continue
  fi
  assert_status 0 "${srv} → tools/list advertises ${tool}" \
    mcp_assert_tool_listed "$server" "$tool"
done

# Retired tools must NOT be advertised: a server still listing one would invite a call to
# a path that no longer exists. Each row: server-name : retired tool (the ruling in a comment).
# Non-vacuity: a server that failed to start also "does not list" the tool, so each row's
# server must have answered a positive row in CASES above (task-synchronizer-mcp does, 4x).
declare -a RETIRED=(
  "task-synchronizer-mcp:handoff_control"   # D-099 (E-322): the wake is the skills' SendMessage
)
for row in "${RETIRED[@]}"; do
  srv="${row%%:*}"
  tool="${row##*:}"
  assert_status 1 "${srv} → tools/list no longer advertises ${tool}" \
    mcp_assert_tool_listed "${ROOT}/src/mcp/${srv}/index.js" "$tool"
done

# ── E-249 (from booted_build_test — E-302): booted-build staleness is ANNOUNCED ──
# THE DEFECT. ESM caches a module for the lifetime of the process, and an MCP server is a
# long-lived process. `bash install-rein.sh` rewrites ~/.rein and `git pull` rewrites
# src/; neither reaches a server that is already running. The task synchroniser served the
# pre-E-245 projector and stripped the archive pointer on every write; run_review reported
# a P0 the shipped checker no longer emitted. Both times the gate was reporting on code
AI="${REPO_ROOT}/src/bin/ai"
INSTALLER="${REPO_ROOT}/install-rein.sh"
STAMP="${REPO_ROOT}/src/shared/build-stamp.mjs"
SYNCHRONIZER="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"


export REIN_DISABLE_REPO_MAP=1

# ── §1: LIVE — one server, held open across a source rewrite ─────────────────
#
# A copy of the framework's server-side tree, so the rewrite below touches a throwaway file
# and never the repo. node_modules is SYMLINKED rather than copied: the vendored SDK is the
# bulk of src/mcp, and module resolution follows the link.
_live_root=""
_prepare_live_tree() {
  local d; d="$(test_tmpdir e249-live)"
  mkdir -p "$d/mcp"
  cp -R "${REPO_ROOT}/src/shared"  "$d/shared"
  cp -R "${REPO_ROOT}/src/mcp/shared" "$d/mcp/shared"
  cp -R "${REPO_ROOT}/src/mcp/task-synchronizer-mcp" "$d/mcp/task-synchronizer-mcp"
  # E-379 (D-130): the task store redacts through shared/publish-scan.mjs, which reads the
  # credential detector from safe-exec-mcp — a self-contained module with no imports.
  mkdir -p "$d/mcp/safe-exec-mcp"
  cp "${REPO_ROOT}/src/mcp/safe-exec-mcp/secret-rule.mjs" "$d/mcp/safe-exec-mcp/"
  rm -rf "$d/mcp/task-synchronizer-mcp/node_modules"
  # The SDK is hoisted to the workspace root (npm workspaces), so the copy needs a
  # node_modules at ITS root — Node walks up from the importing file, and a per-server link
  # is never reached. Symlinked rather than copied: the vendored SDK is the bulk of the tree.
  ln -sfn "${REPO_ROOT}/node_modules" "$d/node_modules" 2>/dev/null || true
  printf '%s' "$d"
}

if skip_unless_cmd node "live MCP server layer"; then
  _live_root="$(_prepare_live_tree)"
  _live_entry="${_live_root}/mcp/task-synchronizer-mcp/index.js"
  _live_home="$(test_tmpdir e249-home)"          # HOME is redirected: the boot record must
  tc_fixture_home "$_live_home"   # E-345 (D-109 r1): the toolchain record the hooks pin
  _live_proj="$(test_tmpdir e249-proj)"          # never land in (or reap from) the real run dir
  mkdir -p "${_live_proj}/.ai"
  printf '# TASKS (Generated from state.json)\n' > "${_live_proj}/.ai/TASKS.md"

  # The driver. One child process, two tool calls, a source rewrite in between — expressed
  # in node because a persistent JSON-RPC session is not something the per-call bash client
  # can express, and expressing it here keeps the shared client unchanged.
  cat > "${_live_root}/driver.mjs" <<'DRIVER'
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [entry, cwd, touchFile] = process.argv.slice(2);
const srv = spawn(process.execPath, ["--no-warnings", entry], {
  cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env },
});

let buf = "";
const waiters = new Map();
srv.stdout.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});

let id = 0;
function rpc(method, params) {
  const myId = ++id;
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout on ${method}`)), 20000);
    waiters.set(myId, (m) => { clearTimeout(t); res(m); });
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "e249-driver", version: "1.0" },
  });
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const first = await rpc("tools/call", { name: "verify_markdown_sync", arguments: {} });
  console.log("__FIRST__ " + JSON.stringify(first.result ?? first));

  // The rewrite. Appending keeps the module valid — the point is that its BYTES changed
  // while a process that already imported it keeps serving the old copy.
  appendFileSync(touchFile, "\n// E-249 live rewrite\n");
  await sleep(50);

  const second = await rpc("tools/call", { name: "verify_markdown_sync", arguments: {} });
  console.log("__SECOND__ " + JSON.stringify(second.result ?? second));
} catch (e) {
  console.log("__ERROR__ " + e.message);
} finally {
  srv.kill("SIGKILL");
}
DRIVER

  _live_out="$(HOME="${_live_home}" node --no-warnings "${_live_root}/driver.mjs" \
                 "${_live_entry}" "${_live_proj}" "${_live_root}/mcp/shared/state-db.js" 2>/dev/null || true)"
  _first="$(printf '%s\n'  "$_live_out" | grep -m1 '^__FIRST__ '  | cut -c11-)"
  _second="$(printf '%s\n' "$_live_out" | grep -m1 '^__SECOND__ ' | cut -c12-)"

  assert_status 0 "E-249.01a: the live server answered both calls" \
    bash -c "[[ -n '${_first:-}' && -n '${_second:-}' ]]"

  # Every tool result carries the build the SERVER PROCESS booted with.
  assert_contains "E-249.01b: the first result carries _meta.booted_build" "booted_build" "${_first:-}"
  assert_contains "E-249.01c: so does the result after the rewrite" "booted_build" "${_second:-}"

  # The stamp reports what the process BOOTED with, not what is on disk now. If it tracked
  # disk it would always agree with disk, and could never report a stale server.
  _h1="$(printf '%s' "${_first:-}"  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("_meta",{}).get("booted_build",{}).get("hash",""))' 2>/dev/null || true)"
  _h2="$(printf '%s' "${_second:-}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("_meta",{}).get("booted_build",{}).get("hash",""))' 2>/dev/null || true)"
  assert_status 0 "E-249.01d: booted_build is UNCHANGED by the rewrite (it reports the boot, not disk)" \
    bash -c "[[ -n '${_h1}' && '${_h1}' == '${_h2}' ]]"

  # ACCEPTANCE: the same tool, on the same process, reports the staleness the rewrite created.
  assert_status 1 "E-249.01e: verify_markdown_sync was CLEAN before the rewrite" \
    bash -c "printf '%s' \"\${_first}\" | grep -q STALE_SERVER"
  assert_contains "E-249.01f: and reports [STALE_SERVER] after it" "STALE_SERVER" "${_second:-}"
  assert_contains "E-249.01g: the notice names the restart requirement" "restart required" "${_second:-}"
  # The structured tail carries it too, for the skills and hooks that parse rather than read.
  assert_contains "E-249.01h: __SYNC_RESULT__ carries stale_servers" "stale_servers" "${_second:-}"
  # Staleness is an operational notice, NOT a sync verdict: folding it into SYNC_FAIL would
  # make that verdict mean two different things.
  _verdict="$(printf '%s' "${_second:-}" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(json.loads(d["content"][0]["text"].split("__SYNC_RESULT__ ")[1])["status"])
' 2>/dev/null || echo "PARSE_FAILED")"
  assert_contains "E-249.01i: the SYNC verdict itself is unaffected by staleness" "PASS" "${_verdict}"
fi

# ── §2: the rollback ─────────────────────────────────────────────────────────
_stale_fixture() {   # → a run dir holding one stale record for a throwaway "server"
  local d; d="$(test_tmpdir e249-run)"
  mkdir -p "$d/run" "$d/srv"
  printf '// v1\n' > "$d/srv/index.js"
  # The record must name a LIVE pid. writeBootRecord() stamps process.pid, and a helper
  # invoked with `node -e` is gone by the time the scan runs — so the scan would (correctly)
  # reap it as dead and report nothing, and the assertion below would pass for the wrong
  # reason in one direction and fail in the other. `$$` is this suite's own shell: alive for
  # as long as the assertions are.
  local hash
  hash="$(node --no-warnings "$STAMP" --stamp "$d/srv/index.js" \
          | python3 -c 'import json,sys; print(json.load(sys.stdin)["hash"])' 2>/dev/null || echo "")"
  printf '{"server":"rollback-mcp","pid":%s,"entry":"%s","hash":"%s","booted_at":"%s"}\n' \
    "$$" "$d/srv/index.js" "$hash" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$d/run/build-rollback-mcp.json"
  printf '// v2\n' >> "$d/srv/index.js"
  printf '%s' "$d"
}
_rb="$(_stale_fixture)"
assert_contains "E-249.02a: the fixture is stale while the stamp is enabled" "STALE_SERVER" \
  "$(E249_MOD="$STAMP" E249_RUN="${_rb}/run" node --no-warnings -e '
      import(process.env.E249_MOD).then(m => console.log(m.staleServerReport({ runDir: process.env.E249_RUN }).join("\n")));
    ' 2>/dev/null || true)"
assert_status 1 "E-249.02b: REIN_BUILD_STAMP=0 silences it" \
  bash -c "REIN_BUILD_STAMP=0 E249_MOD='$STAMP' E249_RUN='${_rb}/run' node --no-warnings -e '
      import(process.env.E249_MOD).then(m => console.log(m.staleServerReport({ runDir: process.env.E249_RUN }).join(\"\n\")));
    ' 2>/dev/null | grep -q STALE_SERVER"

# The CLI must ALWAYS exit 0. `ai sync` runs under `set -euo pipefail`, and a non-zero exit
# from an advisory probe is the exact class of defect E-247 had just finished removing.
node --no-warnings "$STAMP" --stale >/dev/null 2>&1
assert_contains "E-249.02c: the CLI exits 0 even with nothing to report" "0" "$?"
assert_status 0 "E-249.02d: --stale-json is machine-readable" \
  bash -c "node --no-warnings '$STAMP' --stale-json 2>/dev/null | python3 -c 'import json,sys; json.load(sys.stdin)'"

# ── §3: the five consumers are WIRED ─────────────────────────────────────────
# Source-level, because each consumer's own report is covered where it lives; what these
# assert is that the scan is actually reached from all five surfaces named in D-067 §3.
assert_status 0 "E-249.03a: verify_markdown_sync calls the scan" \
  grep -q 'staleServerReport()' "${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"
# E-276 (D-075) retired orchestrator::run_preflight; the ai-preflight skill's `!` injection
# is the preflight path now, and it runs the same scan through the CLI.
assert_status 0 "E-249.03b: the ai-preflight skill runs the scan" \
  grep -q 'build-stamp.mjs 2>/dev/null)"; r=""; \[ -n "\$c" \] && r="\$(node --no-warnings "\$c" --stale' "${REPO_ROOT}/src/shared/skills/ai-preflight/SKILL.md"
assert_status 0 "E-249.03c: ai sync runs it as a fail-open step" \
  grep -qE '_sync_step +stale_servers +_report_stale_servers' "$AI"
assert_status 0 "E-249.03d: ai doctor reports it" grep -q '_stale_server_lines' "$AI"
assert_status 0 "E-249.03e: install-rein.sh reports it at the end" \
  grep -q 'build-stamp.mjs" --stale' "$INSTALLER"
# Doctor prints the CLEAN case too — a diagnostic that is silent when healthy cannot be
# told apart from one that did not run.
assert_status 0 "E-249.03f: doctor names the healthy case explicitly" \
  grep -q 'every running server booted the build that is on disk' "$AI"
# The install notice must not be able to fail the install.
assert_status 0 "E-249.03g: the installer's probe is guarded and non-fatal" \
  bash -c "grep -A1 'build-stamp.mjs\" --stale' '$INSTALLER' | grep -q '|| true'"

# The interceptor stamps every server, not a hand-maintained list of them.
assert_status 0 "E-249.03h: the stamp rides on the shared instrument() interceptor" \
  grep -q 'bootedBuild(serverName)' "${REPO_ROOT}/src/shared/mcp-telemetry.mjs"
_instrumented="$(grep -lE '^\s*instrument\(server' "${REPO_ROOT}"/src/mcp/*/index.js | wc -l | tr -d ' ')"
# Compared with the registry, not a literal: D-075 retires servers (E-276..E-279), and a
# hard-coded floor of 20 failed the moment the count legitimately dropped below it. The
# per-server check also lives in tests/unit/telemetry.test.mjs (E-277, the mcp_telemetry rows); >=10 guards a vacuous glob.
# Every REGISTRY server must be instrumented; extras are fine (ast-parser-mcp is run as a
# CLI by `ai sync` for REPO_MAP.md and is deliberately unregistered, yet instrumented).
_uninstrumented="$(node -e "const r=require(process.argv[1]); for (const [n,v] of Object.entries(r.mcp_servers)) if (v.path) console.log(n)" "${REPO_ROOT}/src/config/registry.json" \
  | while read -r _s; do grep -qE '^\s*instrument\(server' "${REPO_ROOT}/src/mcp/${_s}/index.js" 2>/dev/null || printf '%s ' "$_s"; done)"
assert_status 0 "E-249.03i: every registry server is instrumented (${_instrumented} instrumented; missing: ${_uninstrumented:-none})" \
  bash -c "[[ -z '${_uninstrumented}' && '${_instrumented}' -ge 10 ]]"

# ── §4: THE REFUSAL (D-067 §3) — state-db and the projectors are not hot-reloaded ──
# E-237 hot-reloads four POLICY modules. The ruling refuses to extend that to state. This
# is asserted because the tempting "fix" for everything above is to hot-reload the lot, and
# nothing else in the tree would object.
assert_status 1 "E-249.04a: state-db is not in the hot-reload set" \
  grep -qE 'loadPolicy\(.*state-db' "${REPO_ROOT}/src/mcp/shared/load-policy.mjs" \
    "${REPO_ROOT}"/src/mcp/*/index.js
assert_status 0 "E-249.04b: the refusal is recorded where the mechanism lives" \
  grep -q 'never patched live' "$STAMP"

# ── §5: the completion gate, BOTH WAYS, through the real tool ────────────────
#
# The gate lives in update_task_status because that is what `skill: ai-task` calls; a
# markdown skill cannot refuse anything. Driving the real tool is what proves the gate is
# reachable from the path the Engineer actually uses.
#
# isFrameworkClone() decides whether a repo is one the mirror is a copy OF. With HOME
# redirected there is no persisted workspace file, so it falls back to package.json's name
# — which is what makes a self-contained fixture possible here.
_gate_fixture() {   # <mirror-matches: yes|no> → project dir, with $HOME/.rein as the mirror
  local matches="$1"
  local h; h="$(test_tmpdir e249-gate-home)"
  tc_fixture_home "$h"   # E-345 (D-109 r1): the toolchain record the hooks pin
  local d; d="$(test_tmpdir e249-gate-proj)"
  mkdir -p "$d/.ai" "$d/src/mcp/probe" "$d/src/bin" "$h/.rein/mcp/probe" "$h/.rein/bin"
  printf '{"name":"@vimurai/rein"}\n' > "$d/package.json"
  printf '// probe v1\n' > "$d/src/mcp/probe/index.js"
  printf '#!/usr/bin/env bash\n' > "$d/src/bin/ai"
  cp "$d/src/bin/ai" "$h/.rein/bin/ai"
  if [[ "$matches" == "yes" ]]; then
    cp "$d/src/mcp/probe/index.js" "$h/.rein/mcp/probe/index.js"
  else
    printf '// probe v0 — the mirror is a build behind\n' > "$h/.rein/mcp/probe/index.js"
  fi
  ( cd "$d" && git init -q . && git config user.email t@t && git config user.name t ) >/dev/null 2>&1
  printf '%s' "$d|$h"
}

_gate_verdict() {   # <matches> → the update_task_status result text
  local pair; pair="$(_gate_fixture "$1")"
  local d="${pair%%|*}" h="${pair##*|}"
  # E-236 / the E-248 tail: `REIN_WORKSPACE` is EXPORTED into a Rein shell and points at
  # the real framework clone. isFrameworkClone() consults it before falling back to
  # package.json, so an inherited value makes every fixture below read as "not the
  # framework" and the gate never fires — the assertions would pass only in the direction
  # that proves nothing. Second instance of an inherited launch variable deciding a verdict
  # in two consecutive tasks. E-264: stripped centrally now (tests/lib/launch-vars.sh);
  # REIN_HOME is an operator override, not a launch variable, and stays stripped here.
  ( cd "$d" && env -u REIN_HOME HOME="$h" bash -c "
      source '${SCRIPT_DIR}/../lib/mcp-client.sh'
      mcp_call_tool '$SYNCHRONIZER' add_task '{\"owner\":\"Engineer (Claude)\",\"description\":\"E-249 gate probe\",\"prefix\":\"E\"}' >/dev/null 2>&1
      mcp_call_tool '$SYNCHRONIZER' update_task_status '{\"id\":\"E-1\",\"status\":\"DONE\",\"summary\":\"probe\"}' 2>/dev/null
    " )
}

assert_status 1 "E-264: REIN_WORKSPACE is not in the environment the gate inherits" \
  bash -c '[[ -n "${REIN_WORKSPACE+x}" ]]'
_gate_dirty="$(_gate_verdict no)"
assert_contains "E-249.05a: DONE is REFUSED while the mirror is a build behind" "BUILD_STALE" "${_gate_dirty}"
assert_contains "E-249.05b: the refusal names the file that was not installed" "src/mcp/probe/index.js" "${_gate_dirty}"
assert_contains "E-249.05c: and says how to fix it" "install-rein.sh" "${_gate_dirty}"
assert_contains "E-249.05d: and names its own rollback" "REIN_BUILD_STAMP=0" "${_gate_dirty}"

# NON-VACUITY. Without this, deleting the gate entirely, or breaking it so it refuses
# nothing, would leave 05a-05d passing only if they were also deleted — but a gate that
# refuses EVERYTHING passes them all while making the tool unusable.
_gate_clean="$(_gate_verdict yes)"
assert_status 1 "E-249.05e: DONE is ALLOWED when the mirror is current" \
  bash -c "printf '%s' \"\${_gate_clean}\" | grep -q BUILD_STALE"
assert_contains "E-249.05f: and the task really transitions" "DONE" "${_gate_clean}"

# The rollback releases the gate rather than requiring the mirror to be fixed.
_gate_pair="$(_gate_fixture no)"
_gp_d="${_gate_pair%%|*}"; _gp_h="${_gate_pair##*|}"
_gate_off="$( cd "$_gp_d" && env -u REIN_HOME HOME="$_gp_h" REIN_BUILD_STAMP=0 bash -c "
    source '${SCRIPT_DIR}/../lib/mcp-client.sh'
    mcp_call_tool '$SYNCHRONIZER' add_task '{\"owner\":\"Engineer (Claude)\",\"description\":\"probe\",\"prefix\":\"E\"}' >/dev/null 2>&1
    mcp_call_tool '$SYNCHRONIZER' update_task_status '{\"id\":\"E-1\",\"status\":\"DONE\"}' 2>/dev/null
  " )"
assert_status 1 "E-249.05g: REIN_BUILD_STAMP=0 releases the gate" \
  bash -c "printf '%s' \"\${_gate_off}\" | grep -q BUILD_STALE"

# A refusal must leave NOTHING behind: the gate runs before the dependency-revision write,
# so a blocked DONE is not a half-applied mutation. This needs its OWN fixture — the
# rollback pair above deliberately let its DONE through, and checking that one would have
# asserted the opposite of what it reads.
_h8="$(_gate_fixture no)"; _h8d="${_h8%%|*}"; _h8h="${_h8##*|}"
( cd "$_h8d" && env -u REIN_HOME HOME="$_h8h" bash -c "
    source '${SCRIPT_DIR}/../lib/mcp-client.sh'
    mcp_call_tool '$SYNCHRONIZER' add_task '{\"owner\":\"Engineer (Claude)\",\"description\":\"probe\",\"prefix\":\"E\"}' >/dev/null 2>&1
    mcp_call_tool '$SYNCHRONIZER' update_task_status '{\"id\":\"E-1\",\"status\":\"DONE\",\"summary\":\"probe\"}' >/dev/null 2>&1
  " )
assert_status 0 "E-249.05h: the refused task is still listed OPEN in TASKS.md" \
  grep -q '^- \[ \] E-1' "${_h8d}/.ai/TASKS.md"
assert_status 1 "E-249.05i: and is NOT recorded done" \
  grep -q '^- \[x\] E-1' "${_h8d}/.ai/TASKS.md"

echo ""

# ── E-237 (from policy_hot_reload_test — E-302): a long-running server must not serve a stale policy ──
# An MCP server is spawned once and lives for the whole session, and ESM caches a module by
# URL forever — so a policy refreshed by `ai sync` never reached the running process.
# Throughout the 2026-09-09 sprint `run_review` reported a P0 PATH_TRAVERSAL on
# `source "${SCRIPT_DIR}/../lib/assert.sh"` while the on-disk traversal-policy.mjs graded
LOADER="${REPO_ROOT}/src/mcp/shared/load-policy.mjs"


assert_status 0 "E-237.01a: the loader exists" test -f "$LOADER"
assert_status 0 "E-237.01b: it exports loadPolicy"      grep -q "export async function loadPolicy" "$LOADER"
assert_status 0 "E-237.01c: and a staleness reporter"   grep -q "export function policyStaleness" "$LOADER"
assert_status 0 "E-237.01d: rollback env is honoured"   grep -q "REIN_POLICY_HOT_RELOAD" "$LOADER"

# ── E-237.2: a rewritten policy is picked up, and an unchanged one is not ──
# Both halves matter. The first is the bug; the second is the leak the fix must not cause.
_reload_probe() {  # <mode> → observed values, space separated
  MODE="$1" node --input-type=module -e '
    const { writeFileSync, mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { pathToFileURL } = await import("url");

    // A throwaway policy module of our own, so the real ones are never touched.
    const dir = mkdtempSync(join(tmpdir(), "e237-"));
    const file = join(dir, "policy.mjs");
    const write = (v) => writeFileSync(file, `export const verdict = ${JSON.stringify(v)};\n`);

    const { loadPolicy, POLICY_PATHS, policyLoadCounts } =
      await import(pathToFileURL(process.env.LOADER).href);
    POLICY_PATHS["e237-probe"] = file;

    write("P0");
    const first = (await loadPolicy("e237-probe")).verdict;

    // Unchanged: must NOT re-import.
    const again = (await loadPolicy("e237-probe")).verdict;
    const countAfterSame = policyLoadCounts()["e237-probe"];

    // Rewritten — the `ai sync` event. mtimeMs is sub-millisecond, but bump the clock a
    // little so the test does not depend on filesystem timestamp granularity: a
    // whole-second stamp is exactly what made the E-229 re-exec inert.
    await new Promise((r) => setTimeout(r, 20));
    write("P1");
    const third = (await loadPolicy("e237-probe")).verdict;
    const countAfterChange = policyLoadCounts()["e237-probe"];

    console.log([first, again, third, countAfterSame, countAfterChange].join(" "));
  ' 2>/dev/null
}
export LOADER

_out="$(_reload_probe hot)"
read -r _first _again _third _cSame _cChange <<< "$_out"
assert_contains "E-237.02a: the first load returns the policy on disk"        "P0" "${_first:-}"
assert_contains "E-237.02b: an unchanged file returns the same policy"        "P0" "${_again:-}"
assert_contains "E-237.02c: a REWRITTEN file is picked up (the actual bug)"   "P1" "${_third:-}"
# The leak guard: one import for the first load, and still one after a no-change call.
assert_contains "E-237.02d: an unchanged file is NOT re-imported (no leak)"   "1"  "${_cSame:-}"
assert_contains "E-237.02e: a changed file is imported exactly once more"     "2"  "${_cChange:-}"

# ── E-237.3: the rollback pins the first load ─────────────────────────────
_pinned="$(REIN_POLICY_HOT_RELOAD=0 _reload_probe pinned)"
read -r _p1 _p2 _p3 _pc1 _pc2 <<< "$_pinned"
assert_contains "E-237.03a: pinned, the first load still works"              "P0" "${_p1:-}"
assert_contains "E-237.03b: pinned, a rewrite is IGNORED (pre-E-237 behaviour)" "P0" "${_p3:-}"
assert_contains "E-237.03c: pinned, the module is imported exactly once"     "1"  "${_pc2:-}"

# ── E-237.4: the real consumers ask per request ───────────────────────────
assert_status 0 "E-237.04a: orchestrator loads the traversal policy per request" \
  grep -q 'await loadPolicy("traversal-policy")' "${REPO_ROOT}/src/mcp/orchestrator-mcp/index.js"
assert_status 1 "E-237.04b: and no longer statically imports it" \
  grep -q 'import { classifyDiffTraversal } from' "${REPO_ROOT}/src/mcp/orchestrator-mcp/index.js"
assert_status 0 "E-237.04c: patch-mcp refreshes at the top of the handler" \
  grep -q 'await refreshPolicies();' "${REPO_ROOT}/src/mcp/patch-mcp/index.js"
assert_status 0 "E-237.04d: propose-patch-mcp does too" \
  grep -q 'await refreshPolicies();' "${REPO_ROOT}/src/mcp/propose-patch-mcp/index.js"
# FAIL-SAFE: a reload that throws must leave the PREVIOUS policy deciding, never an
# undefined guard. A gate that disappears is far worse than one a version behind.
assert_status 0 "E-237.04e: patch-mcp keeps the last good policy on a failed reload" \
  grep -q 'keep the last good policy' "${REPO_ROOT}/src/mcp/patch-mcp/index.js"
assert_status 0 "E-237.04f: and starts from the static import, never undefined" \
  grep -q '_staticScopeGuard' "${REPO_ROOT}/src/mcp/patch-mcp/index.js"

# ── E-237.5: `ai sync` reports a running server on an older policy ────────
assert_status 0 "E-237.05a: ai sync has the staleness notice" \
  grep -q '_report_policy_staleness' "${REPO_ROOT}/src/bin/ai"

# ── E-237.6: mirrors ─────────────────────────────────────────────────────
if [[ -f "${HOME}/.rein/mcp/shared/load-policy.mjs" ]]; then
  assert_status 0 "E-237.06a: ~/.rein mirror of the loader matches src" \
    diff -q "$LOADER" "${HOME}/.rein/mcp/shared/load-policy.mjs"
else
  # E-236: an absent install is a SKIP, counted separately. A pass here would claim the
  # mirror had been verified when nothing was compared.
  _skip "E-237.06a: ~/.rein mirror comparison (framework not installed)"
fi

echo ""

# ── E-45 (from blueprint_aligner_test — E-302): blueprint-aligner-mcp secret detection ──
set -e


# Helper: test the HARDCODED_SECRET regex against a diff line
# The pattern from blueprint-aligner-mcp/index.js:
#   /^\+[^+].*\b(password|passwd|api.?key|secret|token|private.?key)\s*=\s*["'][^"']{4,}/gim
test_secret_pattern() {
  local label="$1" input="$2" expect="$3"
  local result
  result=$(node -e "
const line = $(printf '%s' "$input" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))');
const pattern = /^\+[^+].*\b(password|passwd|api.?key|secret|token|private.?key)\s*=\s*[\"'][^\"']{4,}/gim;
const matches = [...line.matchAll(pattern)];
process.stdout.write(matches.length > 0 ? 'match' : 'nomatch');
" 2>/dev/null || echo "error")
  if [[ "$result" == "$expect" ]]; then
    _pass "$label"
  else
    _fail "$label (expected $expect, got $result)"
  fi
}

# ── HARDCODED_SECRET detections ───────────────────────────────────────────────
test_secret_pattern "password= with double quotes detected" \
  '+  password = "supersecret123"' \
  'match'

test_secret_pattern "passwd= with single quotes detected" \
  "+  passwd = 'mypassword!'" \
  'match'

test_secret_pattern "api_key= detected" \
  '+  api_key = "ghp_abcdef1234567890"' \
  'match'

# privacy:allow-fake-token (an invented test input)
test_secret_pattern "apikey= detected (no separator)" \
  '+  apikey = "AKIAIOSFODNN7EXAMPLE"' \
  'match'

test_secret_pattern "secret= detected" \
  '+  secret = "s3cr3t_v4lu3"' \
  'match'

test_secret_pattern "token= detected" \
  '+  token = "eyJhbGciOiJIUzI1NiJ9"' \
  'match'

test_secret_pattern "private_key= detected" \
  '+  private_key = "-----BEGIN"' \
  'match'

# ── Should NOT trigger ────────────────────────────────────────────────────────
test_secret_pattern "comment line not detected (no leading +)" \
  '#  password = "supersecret"' \
  'nomatch'

test_secret_pattern "deletion line not detected (starts with -)" \
  '-  password = "oldsecret123"' \
  'nomatch'

test_secret_pattern "context line not detected (++ header)" \
  '++ password = "something"' \
  'nomatch'

test_secret_pattern "safe variable name not detected" \
  '+  username = "admin"' \
  'nomatch'

test_secret_pattern "short value not detected (< 4 chars)" \
  '+  password = "abc"' \
  'nomatch'

test_secret_pattern "placeholder value not detected (empty string)" \
  '+  password = ""' \
  'nomatch'

# ── CAPABILITIES_BYPASS path traversal ───────────────────────────────────────
test_traversal_pattern() {
  local label="$1" input="$2" expect="$3"
  local result
  result=$(node -e "
const line = $(printf '%s' "$input" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))');
const pattern = /^\+[^+].*(\.\.\/|\/etc\/|\/root\/|\/home\/\w+\/\.)/gm;
const matches = [...line.matchAll(pattern)];
process.stdout.write(matches.length > 0 ? 'match' : 'nomatch');
" 2>/dev/null || echo "error")
  if [[ "$result" == "$expect" ]]; then
    _pass "$label"
  else
    _fail "$label (expected $expect, got $result)"
  fi
}

test_traversal_pattern "path traversal ../ detected" \
  '+  const path = "../../etc/passwd"' \
  'match'

test_traversal_pattern "/etc/ path detected" \
  '+  readFile("/etc/shadow")' \
  'match'

test_traversal_pattern "/root/ path detected" \
  '+  exec("cat /root/.ssh/id_rsa")' \
  'match'

test_traversal_pattern "safe relative path not detected" \
  '+  const file = "./config/settings.json"' \
  'nomatch'

# ── CAPABILITIES_BYPASS — E-42 ESM/CJS module-specifier whitelist ─────────────
# The aligner rule now post-filters traversal hits: any line whose ../ appears
# inside import/from/require/dynamic-import quoted module specifier is allowed
# (canonical Node sibling import per D-005 / E-18). Real path traversal must
# still trigger.
test_bypass_rule() {
  local label="$1" input="$2" expect="$3"
  local result
  result=$(node -e "
const diff = $(printf '%s' "$input" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))');
const traversalLineRe   = /^\+[^+].*(?:\.\.\/|\/etc\/|\/root\/|\/home\/\w+\/\.)/;
const moduleSpecifierRe = /(?:from|require|import)\s*\(?\s*([\"'])\.\.\/[^\"']*\1/;
const matches = [];
for (const line of diff.split('\n')) {
  if (!traversalLineRe.test(line)) continue;
  if (moduleSpecifierRe.test(line)) continue;
  matches.push(line);
}
process.stdout.write(matches.length > 0 ? 'flag' : 'allow');
" 2>/dev/null || echo "error")
  if [[ "$result" == "$expect" ]]; then
    _pass "$label"
  else
    _fail "$label (expected $expect, got $result)"
  fi
}

# Whitelisted ESM/CJS sibling imports — must be allowed.
test_bypass_rule "ESM static import allowed" \
  '+import { createLogger } from "../shared/logger.js";' \
  'allow'

test_bypass_rule "ESM static import single-quoted allowed" \
  "+import x from '../shared/util.js';" \
  'allow'

test_bypass_rule "ESM dynamic import allowed" \
  '+const m = await import("../helpers/foo.js");' \
  'allow'

test_bypass_rule "CommonJS require allowed" \
  '+const x = require("../shared/util.js");' \
  'allow'

test_bypass_rule "named-export re-export allowed" \
  '+export { foo } from "../shared/foo.js";' \
  'allow'

# Real traversal — must still trigger.
test_bypass_rule "literal cat ../../../etc/passwd flagged" \
  '+exec("cat ../../../etc/passwd")' \
  'flag'

test_bypass_rule "string-concat traversal still flagged" \
  '+const p = base + "../../etc/shadow";' \
  'flag'

test_bypass_rule "/etc absolute path still flagged" \
  '+readFile("/etc/shadow")' \
  'flag'

test_bypass_rule "fs.readFile with ../ still flagged (no quotes around ../)" \
  '+fs.readFileSync(`${root}/../secret`)' \
  'flag'

# ── ARCHITECT_FILE_MODIFIED — E-42 UACS handoff stamp gate ───────────────────
# When the diff modifies architect.md or BRIEF.md, the rule fires FAIL by
# default. If state.json or LOG.md carries a recent ARCHITECT_HANDOFF stamp,
# severity downgrades to WARN.
#
# E-254: exercise the REAL detectArchitectHandoffStamp — its source is sliced out of
# index.js (the function is not exported and the module starts a server) and evaluated
# with the same fs/path bindings, so an inline copy can never drift from src.
ALIGNER_SRC="${REPO_ROOT}/src/mcp/blueprint-aligner-mcp/index.js"

assert_status 0 "ARCHITECT_FILE_MODIFIED rule id present in aligner" \
  grep -q 'id: "ARCHITECT_FILE_MODIFIED"' "$ALIGNER_SRC"

test_handoff_stamp() {
  local label="$1" sandbox="$2" expect="$3"
  local result
  result=$(node -e "
const fs = require('node:fs');
const { resolve } = require('node:path');
const src = fs.readFileSync(process.argv[1], 'utf8');
const m = src.match(/^function detectArchitectHandoffStamp\(cwd\) \{[\s\S]*?^\}$/m);
if (!m) { process.stdout.write('nosource'); process.exit(0); }
const existsSync = fs.existsSync;
const readFileSafe = (p) => { try { return existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; } };
const detect = new Function('resolve', 'existsSync', 'readFileSafe', m[0] + '\nreturn detectArchitectHandoffStamp;')(resolve, existsSync, readFileSafe);
process.stdout.write(detect(process.argv[2]) ?? 'none');
" "$ALIGNER_SRC" "$sandbox" 2>/dev/null || echo "error")
  if [[ "$expect" == "none" && "$result" == "none" ]] || [[ "$expect" != "none" && "$result" == *"$expect"* ]]; then
    _pass "$label"
  else
    _fail "$label (expected $expect, got $result)"
  fi
}

SBOX="$(mktemp -d -t rein-aligner-XXXXXX)"
mkdir -p "${SBOX}/.ai"

# No state.json, no LOG.md → no stamp → FAIL severity preserved.
test_handoff_stamp "no stamp present" "$SBOX" "none"

# Recent state.json stamp → detected.
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "${SBOX}/.ai/state.json" <<JSON
{"tasks":[],"stamps":[{"type":"ARCHITECT_HANDOFF","timestamp":"${NOW_ISO}","summary":"P-17 architect.md edit"}]}
JSON
test_handoff_stamp "recent ARCHITECT_HANDOFF stamp detected" "$SBOX" "state.json stamp [ARCHITECT_HANDOFF]"

# A recent stamp of any OTHER type does not authorise the edit.
cat > "${SBOX}/.ai/state.json" <<JSON
{"tasks":[],"stamps":[{"type":"CRITIC_STAMP","timestamp":"${NOW_ISO}","summary":"unrelated"}]}
JSON
test_handoff_stamp "recent non-handoff stamp type not detected" "$SBOX" "none"

# Stale stamp (>24h old) → not detected.
OLD_ISO="$(date -u -v-2d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '2 days ago' +%Y-%m-%dT%H:%M:%SZ)"
cat > "${SBOX}/.ai/state.json" <<JSON
{"tasks":[],"stamps":[{"type":"ARCHITECT_HANDOFF","timestamp":"${OLD_ISO}","summary":"old"}]}
JSON
test_handoff_stamp "stale (>24h) stamp not detected" "$SBOX" "none"

# LOG.md marker fallback → detected.
rm -f "${SBOX}/.ai/state.json"
{
  for i in $(seq 1 10); do echo "filler line $i"; done
  echo "[ARCHITECT_HANDOFF] 2026-05-06 P-17 architect.md edit"
} > "${SBOX}/.ai/LOG.md"
test_handoff_stamp "LOG.md marker detected" "$SBOX" "LOG.md marker [ARCHITECT_HANDOFF]"

# LOG.md marker outside last-20-line window → not detected.
{
  for i in $(seq 1 30); do echo "noise $i"; done
  echo "[ARCHITECT_HANDOFF] way back"
  for i in $(seq 1 30); do echo "filler $i"; done
} > "${SBOX}/.ai/LOG.md"
test_handoff_stamp "LOG.md marker outside last-20 ignored" "$SBOX" "none"

rm -rf "$SBOX"

# ── validate_blueprint_section (E-83 / P-41 §28) ────────────────────────────
ALIGNER="${REPO_ROOT}/src/mcp/blueprint-aligner-mcp/index.js"

# Create a test helper that extracts the validation logic
VALIDATE_HELPER="${SCRIPT_DIR}/../.validate_helper.mjs"
cat > "$VALIDATE_HELPER" << 'HELPEREOF'
// Extracted from blueprint-aligner-mcp for testing
const BLUEPRINT_SCHEMA = [
  {
    id: "CONCEPT", label: "Core Concept & Value Prop",
    patterns: [/(?:^|\n)#+\s*.*(?:concept|value|motivation|background|purpose|why|overview)/i, /(?:^|\n)#+\s*\d+\.\d+\s+(?:background|motivation)/i],
    contentCheck: (text) => text.split(/\s+/).length >= 30,
  },
  {
    id: "DATA_MODEL", label: "Data Model / State",
    patterns: [/(?:^|\n)#+\s*.*(?:data\s*model|state|schema|types|entities|structure)/i, /(?:^|\n)```(?:json|typescript|ts|graphql|sql)/i],
    contentCheck: (text) => /```/.test(text) || /\b(?:field|column|property|attribute|key)\b/i.test(text),
  },
  {
    id: "API_CONTRACT", label: "API Contract / Interfaces",
    patterns: [/(?:^|\n)#+\s*.*(?:api|interface|contract|endpoint|signature|tool|method)/i, /(?:^|\n)#+\s*.*(?:extending|implement)/i],
    contentCheck: (text) => /\(.*\)/.test(text) || /→|->|returns?/i.test(text) || /input|output|param/i.test(text),
  },
  {
    id: "EXECUTION_FLOW", label: "Execution Flow / Logic",
    patterns: [/(?:^|\n)#+\s*.*(?:flow|logic|execution|mechanism|step|process|algorithm|workflow)/i, /(?:^|\n)#+\s*.*(?:proposed\s*solution|implementation)/i, /(?:^|\n)\d+\.\s+/m],
    contentCheck: (text) => { const hasSteps = (text.match(/(?:^|\n)\d+\.\s+/g) || []).length >= 2; return hasSteps || /\b(?:then|next|after|before|first|finally|step)\b/i.test(text); },
  },
  {
    id: "ERROR_HANDLING", label: "Error Handling & Edge Cases",
    patterns: [/(?:^|\n)#+\s*.*(?:error|edge\s*case|failure|fallback|recovery|exception)/i, /\b(?:if\s+.*fail|when\s+.*fail|error\s+handling|graceful)/i],
    contentCheck: (text) => /\b(?:fail|error|exception|invalid|reject|block|deny|corrupt|missing|timeout)\b/i.test(text),
  },
  {
    id: "SECURITY", label: "Security & Validation",
    patterns: [/(?:^|\n)#+\s*.*(?:security|validation|trust|auth|permission|capability|sanitiz)/i, /\b(?:validate|sanitize|escape|boundary|permission|capability)\b/i],
    contentCheck: (text) => /\b(?:validat|sanitiz|escap|trust|boundary|permission|inject|xss|csrf)\b/i.test(text),
  },
];

function validateBlueprint(content) {
  if (!content || content.trim().length < 50) {
    return { valid: false, missing: BLUEPRINT_SCHEMA.map(s => s.label), feedback: "Content is too short." };
  }
  const missing = [];
  const found = [];
  for (const component of BLUEPRINT_SCHEMA) {
    const hasHeader = component.patterns.some(p => p.test(content));
    const hasContent = component.contentCheck(content);
    if (hasHeader && hasContent) { found.push(component.label); }
    else if (hasHeader) { missing.push(`${component.label} (shallow)`); }
    else if (hasContent) { found.push(component.label); }
    else { missing.push(component.label); }
  }
  return { valid: missing.length <= 2 && found.length >= 4, found, missing };
}

const testName = process.argv[2];
const content = process.argv[3] || '';

if (testName === 'lazy') {
  const r = validateBlueprint('Add a feature. It should work.');
  console.log(r.valid ? 'valid' : 'invalid');
} else if (testName === 'empty') {
  const r = validateBlueprint('');
  console.log(r.valid ? 'valid' : 'invalid');
} else if (testName === 'missing') {
  const r = validateBlueprint('');
  console.log(r.missing.join(','));
} else if (testName === 'validate') {
  const r = validateBlueprint(content);
  console.log(r.valid ? 'valid' : 'invalid');
}
HELPEREOF

# T-03.01: Lazy blueprint (too short) → INVALID
lazy_check=$(node "$VALIDATE_HELPER" lazy)
assert_contains "T-03.01: lazy blueprint (short) → INVALID" "invalid" "$lazy_check"

# T-03.02: Comprehensive blueprint → VALID
# Write test blueprints to temp files to avoid heredoc quoting issues
FULL_BP_FILE=$(mktemp)
cat > "$FULL_BP_FILE" << 'BPEOF'
## 1. Background & Motivation
This feature provides automated validation of blueprint sections before task generation.
The core concept is to enforce structural depth at the planning stage, not after implementation.
We need this because shallow blueprints cause hallucinations and implementation drift.

### 1.1 Data Model
The validation schema contains 6 components. Each component has an id field, label, patterns
array, and contentCheck function attribute. The state is stored in BLUEPRINT_SCHEMA constant.

### 1.2 API Contract
Tool: validate_blueprint_section({ content: string })
Returns { valid: boolean, found: string[], missing: string[] }
The tool is exposed via blueprint-aligner-mcp and returns VALID or INVALID verdict.

### 1.3 Execution Flow
1. First, parse the markdown content for structural headers matching each schema component.
2. Then, run contentCheck functions to verify depth beyond just having headers.
3. Next, classify each component as found, shallow, or missing.
4. Finally, return VALID if at least 4 of 6 components pass.

### 1.4 Error Handling & Edge Cases
If content is empty or too short, the validator returns INVALID immediately with feedback.
If a header exists but content is shallow, it reports with an advisory to the architect.
When validation fails, actionable feedback tells exactly what sections to expand.

### 1.5 Security & Validation
Input content is validated for minimum length. No file system access is performed.
The tool sanitizes output to prevent injection into downstream markdown renders.
Trust boundary: only the Architect agent should call this tool during planning phase.
BPEOF
comprehensive_check=$(node "$VALIDATE_HELPER" validate "$(cat "$FULL_BP_FILE")")
assert_contains "T-03.02: comprehensive blueprint → VALID" "valid" "$comprehensive_check"
rm -f "$FULL_BP_FILE"

# T-03.03: Blueprint with only 2 components → INVALID
PARTIAL_BP_FILE=$(mktemp)
cat > "$PARTIAL_BP_FILE" << 'BPEOF'
## Background & Motivation
This feature does something important for the system. It adds value by providing
a mechanism for automated checking of blueprint quality before generating engineering tasks.

## Execution Flow
1. First read the content
2. Then check patterns
3. Finally return result
BPEOF
partial_check=$(node "$VALIDATE_HELPER" validate "$(cat "$PARTIAL_BP_FILE")")
assert_contains "T-03.03: blueprint with only 2 components → INVALID" "invalid" "$partial_check"
rm -f "$PARTIAL_BP_FILE"

# T-03.04: Empty content → INVALID
empty_check=$(node "$VALIDATE_HELPER" empty)
assert_contains "T-03.04: empty content → INVALID" "invalid" "$empty_check"

# T-03.05: Missing components are listed in output
missing_list=$(node "$VALIDATE_HELPER" missing)
assert_contains "T-03.05: empty blueprint lists Core Concept" "Core Concept" "$missing_list"
assert_contains "T-03.05b: lists Data Model" "Data Model" "$missing_list"
assert_contains "T-03.05c: lists Security" "Security" "$missing_list"

# Cleanup helper
rm -f "$VALIDATE_HELPER"

# ── E-55/E-56: Hunk-aware introspectors (file-path-aware filtering) ──────────
# Build a minimal unified-diff snippet with `+++ b/<path>` headers, then run
# the real ALIGNMENT_RULES check from the live aligner module. Asserts the
# rule fires only when the file path is in scope.

ALIGNER_MODULE="${REPO_ROOT}/src/mcp/blueprint-aligner-mcp/index.js"

# Helper: returns "flag" if CAPABILITIES_BYPASS fires on the synthetic diff,
# otherwise "allow". The synthetic diff has a single file hunk with one
# added line.
test_capabilities_bypass_file() {
  local label="$1" file="$2" line="$3" expect="$4"
  local result
  result=$(node --input-type=module -e "
import { parseDiffByFile, isMarkdownFile, isTestHelperFile } from '${ALIGNER_MODULE}';
const diff = '+++ b/${file}\n@@ -0,0 +1 @@\n${line//\'/\\\'}';
const traversalRe       = /(?:\.\.\/|\/etc\/|\/root\/|\/home\/\\w+\/\.)/;
const moduleSpecifierRe = /(?:from|require|import)\s*\(?\s*([\"'])\.\.\/[^\"']*\1/;
const matches = [];
for (const [f, lines] of parseDiffByFile(diff)) {
  if (isMarkdownFile(f)) continue;
  if (isTestHelperFile(f)) continue;
  for (const l of lines) {
    if (!traversalRe.test(l)) continue;
    if (moduleSpecifierRe.test(l)) continue;
    matches.push(l);
  }
}
process.stdout.write(matches.length > 0 ? 'flag' : 'allow');
" 2>/dev/null || echo "error")
  if [[ "$result" == "$expect" ]]; then
    _pass "$label"
  else
    _fail "$label (expected $expect, got $result)"
  fi
}

# Helper: dependency rule fires only on package.json files.
test_dependency_scope() {
  local label="$1" file="$2" line="$3" expect="$4"
  local result
  result=$(node --input-type=module -e "
import { parseDiffByFile, isPackageJsonFile } from '${ALIGNER_MODULE}';
const diff = '+++ b/${file}\n@@ -0,0 +1 @@\n${line//\'/\\\'}';
const pkgPattern = /^\\+\\s+\"[a-z@][a-z0-9\\-@/.]+\"\\s*:/;
const newDeps = [];
for (const [f, lines] of parseDiffByFile(diff)) {
  if (!isPackageJsonFile(f)) continue;
  for (const l of lines) {
    const m = l.match(pkgPattern);
    if (m) newDeps.push(m[0]);
  }
}
process.stdout.write(newDeps.length > 0 ? 'flag' : 'allow');
" 2>/dev/null || echo "error")
  if [[ "$result" == "$expect" ]]; then
    _pass "$label"
  else
    _fail "$label (expected $expect, got $result)"
  fi
}

# E-55 — Markdown introspector: prose `../` in .md files is documentation, skip.
test_capabilities_bypass_file "E-55: ../ in TASKS.md prose ignored" \
  ".ai/TASKS.md" "+- See ../shared/skills/ for the canonical copy" "allow"

test_capabilities_bypass_file "E-55: /etc reference in DIGEST.md ignored" \
  ".ai/DIGEST.md" "+Touches /etc/hosts when configuring." "allow"

# E-55 — same line in actual code still flags.
test_capabilities_bypass_file "E-55: literal cat ../../etc/passwd in .js still flagged" \
  "src/foo/index.js" "+exec(\"cat ../../../etc/passwd\")" "flag"

# E-56 — TestPathExcluder: tests/{suites,lib}/*.sh sibling imports allowed.
test_capabilities_bypass_file "E-56: \${SCRIPT_DIR}/../lib/assert.sh in tests/suites allowed" \
  "tests/suites/sample_test.sh" "+source \"\${SCRIPT_DIR}/../lib/assert.sh\"" "allow"

test_capabilities_bypass_file "E-56: \${SCRIPT_DIR}/../.. in tests/lib allowed" \
  "tests/lib/helper.sh" "+REPO=\"\${SCRIPT_DIR}/../..\"" "allow"

# E-56 — same path-traversal in a non-test bash script still flags.
test_capabilities_bypass_file "E-56: scope is strict — scripts/foo.sh still flagged" \
  "scripts/foo.sh" "+source \"\${SCRIPT_DIR}/../lib/assert.sh\"" "flag"

# E-55 — JSON introspector: state.json keys are not deps.
test_dependency_scope "E-55: state.json key \"summary\" ignored" \
  ".ai/state.json" "+    \"summary\": \"foo\"," "allow"

test_dependency_scope "E-55: TASKS.md prose with JSON-shaped keys ignored" \
  ".ai/TASKS.md" "+    \"status\": \"DONE\"," "allow"

# E-55 — real package.json deps still flag.
test_dependency_scope "E-55: package.json dep flagged" \
  "package.json" "+    \"left-pad\": \"^1.0.0\"," "flag"

test_dependency_scope "E-55: nested package.json (workspace) dep flagged" \
  "src/mcp/foo/package.json" "+    \"@scope/lib\": \"^2.0.0\"," "flag"

# ── v3.0 W4-T8: internal path-builder introspector (isInternalPathBuilder) ────
# resolve/join("..") path math must NOT trip CAPABILITIES_BYPASS, but sensitive
# absolute paths + shell traversal must still FAIL. Tests the REAL exported fn.
ALIGNER="${REPO_ROOT}/src/mcp/blueprint-aligner-mcp/index.js"
test_path_builder() {
  local label="$1" line="$2" expect="$3"  # expect: whitelist|flag
  local result
  result=$(node --input-type=module -e "
import { isInternalPathBuilder } from 'file://${ALIGNER}';
const line = $(printf '%s' "$line" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))');
process.stdout.write(isInternalPathBuilder(line) ? 'whitelist' : 'flag');
" 2>/dev/null || echo "error")
  if [[ "$result" == "$expect" ]]; then _pass "$label"; else _fail "$label (expected $expect, got $result)"; fi
}

# FP cases that motivated W4-T8 — must be whitelisted.
test_path_builder "W4-T8: resolve(SCRIPT_DIR, '../..') whitelisted" \
  '  const repoRoot = resolve(SCRIPT_DIR, "../..");' 'whitelist'
test_path_builder "W4-T8: join(base, '../x') whitelisted" \
  '  const p = join(base, "../x");' 'whitelist'
test_path_builder "W4-T8: single-quoted resolve('../..') whitelisted" \
  "  const r = resolve(dir, '../..');" 'whitelist'

# Must STILL flag (fail-closed preserved).
test_path_builder "W4-T8: resolve('/etc/passwd') NOT whitelisted (sensitive abs)" \
  '  const r = resolve("/etc/passwd");' 'flag'
test_path_builder "W4-T8: readFile('/etc/shadow') NOT whitelisted" \
  '  readFile("/etc/shadow");' 'flag'
test_path_builder "W4-T8: shell cat ../../etc/passwd NOT whitelisted (no path-builder)" \
  '  exec("cat ../../etc/passwd");' 'flag'
test_path_builder "W4-T8: bare string-concat ../ NOT whitelisted" \
  '  const p = base + "../../secret";' 'flag'

# ── E-111 (from verification_test — E-302): verification-mcp (§32) ──
# Validates: PASS/FAIL/WARN frontmatter audit, Ghost Tool detection,
# mcp__-prefix allowance, and bulk scan of src/claude/agents/.
VERIFY_MCP="${REPO_ROOT}/src/mcp/verification-mcp/index.js"


# T-05.01: MCP file exists and is syntactically valid
assert_exists "$VERIFY_MCP"
assert_status 0 "T-05.01: verification-mcp syntax OK" \
  node -e "import('file://${VERIFY_MCP}').catch(e => { if (e instanceof SyntaxError) process.exit(1); })"

# Helper: audit agent markdown content (inlines parseFrontmatter + auditAgent logic)
# $1 = content, $2 = optional path hint (e.g. "/claude/agents/foo.md")
audit_agent() {
  local content="$1"
  local path_hint="${2:-/claude/skills/test.md}"
  local MD_FILE
# `mktemp <tmpl>` only substitutes X's at the END of the template on BSD/macOS, so a
# suffixed template like `/tmp/name_XXXXXX.mjs` is a FIXED, PREDICTABLE path — it does not
# randomise at all. Two concurrent runs collide (`mkstemp failed: File exists`) and the
# suite dies before its summary. A temp DIRECTORY plus a named file inside randomises on
# both BSD and GNU and keeps the extension, which node needs to pick the ESM loader.
  MD_DIR=$(mktemp -d); MD_FILE="$MD_DIR/verify.md"
  printf '%s' "$content" > "$MD_FILE"
  node -e "
    import { readFileSync } from 'fs';
    const BUILTIN_TOOLS = new Set([
      'Read','Write','Edit','Glob','Grep','Bash','WebSearch','WebFetch',
      'Agent','TodoRead','TodoWrite','NotebookEdit','ExitPlanMode','EnterPlanMode',
    ]);
    function parseFrontmatter(text) {
      if (!text.startsWith('---')) return null;
      const end = text.indexOf('---', 3);
      if (end === -1) return null;
      const fm = text.slice(3, end);
      const result = {};
      const lines = fm.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const inline = lines[i].match(/^([\w-]+):\s*(.+)$/);
        if (inline) { result[inline[1].trim()] = inline[2].trim(); continue; }
        const keyOnly = lines[i].match(/^([\w-]+):\s*$/);
        if (keyOnly) {
          const items = [];
          let j = i + 1;
          while (j < lines.length && /^\s*-\s+/.test(lines[j])) { items.push(lines[j].replace(/^\s*-\s+/, '').trim()); j++; }
          if (items.length) { result[keyOnly[1].trim()] = items.join(', '); i = j - 1; }
        }
      }
      return result;
    }
    function isToolAvailable(tool) {
      if (BUILTIN_TOOLS.has(tool)) return true;
      if (tool === '*') return true;
      if (tool.startsWith('mcp__')) return true;
      return false;
    }
    const mdPath = '${path_hint}';
    const isAgentPath = mdPath.includes('/agents/'); // E-254: agent personas = lenient (mirrors src/mcp/verification-mcp)
    const requiredFields = isAgentPath
      ? ['name','description']
      : ['name','description','disable-model-invocation','user-invocable','allowed-tools'];
    const text = readFileSync('${MD_FILE}', 'utf8');
    const fm = parseFrontmatter(text);
    if (!fm) { console.log('NO_FRONTMATTER'); process.exit(0); }
    const violations = [];
    const warnings   = [];
    for (const field of requiredFields) {
      if (!fm[field]) warnings.push('MISSING_FIELD:' + field);
    }
    const tools = (fm['allowed-tools'] || '').split(',').map(t => t.trim()).filter(Boolean);
    for (const tool of tools) {
      if (!isToolAvailable(tool)) violations.push('GHOST:' + tool);
    }
    const status = violations.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARN' : 'PASS';
    console.log(status + '|violations=' + violations.join(';') + '|warnings=' + warnings.join(';'));
  " --input-type=module 2>/dev/null || echo "node_error"
  rm -rf "$MD_DIR"
}

# T-05.02: Valid frontmatter (all §17.1.2 fields) returns PASS
VALID='---
name: test-agent
description: A test agent for verification
disable-model-invocation: false
user-invocable: false
allowed-tools: Read, Write, Bash
---
# Test Agent body'
result=$(audit_agent "$VALID")
assert_contains "T-05.02: valid frontmatter returns PASS" "PASS" "$result"
assert_not_contains "T-05.02b: no Ghost Tool violations" "GHOST" "$result"

# T-05.03: Ghost Tool returns FAIL with tool name
GHOST='---
name: ghost-agent
description: Agent with a non-existent ghost tool
disable-model-invocation: false
user-invocable: false
allowed-tools: Read, NonExistentTool123
---
# Ghost Agent'
result=$(audit_agent "$GHOST")
assert_contains "T-05.03: Ghost Tool detection returns FAIL" "FAIL" "$result"
assert_contains "T-05.03b: Ghost Tool name included in output" "NonExistentTool123" "$result"

# T-05.04: Missing required §17.1.2 fields returns WARN
WARN='---
name: partial-agent
allowed-tools: Read
---
# Partial Agent'
result=$(audit_agent "$WARN")
assert_contains "T-05.04: missing required fields returns WARN" "WARN" "$result"
assert_contains "T-05.04b: missing description reported" "MISSING_FIELD:description" "$result"
assert_contains "T-05.04c: missing disable-model-invocation reported" "MISSING_FIELD:disable-model-invocation" "$result"

# T-05.05: No frontmatter is silently skipped
NO_FM='# Just a markdown file without frontmatter

Some body content here.'
result=$(audit_agent "$NO_FM")
assert_contains "T-05.05: no frontmatter is skipped (NO_FRONTMATTER)" "NO_FRONTMATTER" "$result"

# T-05.06: mcp__-prefixed tools are NOT Ghost Tools
MCP_TOOLS='---
name: mcp-tool-agent
description: Uses MCP tools
disable-model-invocation: false
user-invocable: false
allowed-tools: Read, mcp__task-synchronizer-mcp__add_task, mcp__orchestrator-mcp__run_handover
---
# MCP Tool Agent'
result=$(audit_agent "$MCP_TOOLS")
assert_contains "T-05.06: mcp__ prefixed tools pass as non-Ghost" "PASS" "$result"

# T-05.06b: YAML list-form allowed-tools with a ghost tool must still FAIL.
# Regression: the old same-line-only parser dropped list-form keys → 0 tools
# audited → silent Ghost-Tool bypass.
LISTFORM_GHOST='---
name: listform-ghost
description: list-form allowed-tools hiding a ghost tool
disable-model-invocation: false
user-invocable: false
allowed-tools:
  - Read
  - NonExistentTool123
---
# List-form Ghost'
result=$(audit_agent "$LISTFORM_GHOST")
assert_contains "T-05.06b: list-form ghost tool detected (FAIL)" "FAIL" "$result"
assert_contains "T-05.06c: list-form ghost tool name reported" "NonExistentTool123" "$result"

# T-05.06d: list-form with only valid tools passes.
LISTFORM_OK='---
name: listform-ok
description: list-form allowed-tools, all valid
disable-model-invocation: false
user-invocable: false
allowed-tools:
  - Read
  - Bash
---
# List-form OK'
result=$(audit_agent "$LISTFORM_OK")
assert_contains "T-05.06d: list-form valid tools PASS" "PASS" "$result"

# T-05.06e: the REAL module parses list-form frontmatter (source anchor, so the
# inlined helpers above can't silently diverge from src/mcp/verification-mcp).
assert_status 0 "T-05.06e: real parseFrontmatter handles list-form" \
  grep -q 'keyOnly' "$VERIFY_MCP"
# T-05.06f (E-254): the lenient-path rule in the inlined helper matches the real module.
assert_status 0 "T-05.06f: real auditAgent keys leniency on /agents/ (isAgentPath)" \
  grep -qF 'const isAgentPath = mdPath.includes("/agents/");' "$VERIFY_MCP"
# T-05.06g (E-254): default scan roots are the claude + shared trees only. Every
# resolve(cwd, "src", X) / join(rein, X) root must name claude or shared.
roots=$(grep -oE 'resolve\(cwd, "src", "[a-z_-]+"|join\(rein, "[a-z_-]+"' "$VERIFY_MCP" | grep -oE '"[a-z_-]+"$' | grep -v '"config"' | sort -u | tr '\n' ' ')
assert_match "T-05.06g: default scan roots are claude/shared only (got: ${roots})" \
  '^("claude" |"shared" )+$' "$roots"

# T-05.07: Bulk scan of src/claude/agents/ — zero CRITICAL violations
AGENTS_DIR="${REPO_ROOT}/src/claude/agents"
if [[ -d "$AGENTS_DIR" ]]; then
  bulk=$(node -e "
    import { readFileSync, readdirSync, statSync } from 'fs';
    import { join } from 'path';
    const BUILTIN_TOOLS = new Set([
      'Read','Write','Edit','Glob','Grep','Bash','WebSearch','WebFetch',
      'Agent','TodoRead','TodoWrite','NotebookEdit','ExitPlanMode','EnterPlanMode',
    ]);
    function parseFrontmatter(text) {
      if (!text.startsWith('---')) return null;
      const end = text.indexOf('---', 3);
      if (end === -1) return null;
      const fm = text.slice(3, end);
      const result = {};
      const lines = fm.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const inline = lines[i].match(/^([\w-]+):\s*(.+)$/);
        if (inline) { result[inline[1].trim()] = inline[2].trim(); continue; }
        const keyOnly = lines[i].match(/^([\w-]+):\s*$/);
        if (keyOnly) {
          const items = [];
          let j = i + 1;
          while (j < lines.length && /^\s*-\s+/.test(lines[j])) { items.push(lines[j].replace(/^\s*-\s+/, '').trim()); j++; }
          if (items.length) { result[keyOnly[1].trim()] = items.join(', '); i = j - 1; }
        }
      }
      return result;
    }
    function isToolAvailable(tool) {
      if (BUILTIN_TOOLS.has(tool)) return true;
      if (tool === '*') return true;
      if (tool.startsWith('mcp__')) return true;
      return false;
    }
    function walk(dir) {
      const files = [];
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) { files.push(...walk(p)); continue; }
        if (e.endsWith('.md')) files.push(p);
      }
      return files;
    }
    const files = walk('${AGENTS_DIR}');
    let criticals = 0;
    for (const f of files) {
      const fm = parseFrontmatter(readFileSync(f, 'utf8'));
      if (!fm) continue;
      for (const tool of (fm['allowed-tools']||'').split(',').map(t=>t.trim()).filter(Boolean)) {
        if (!isToolAvailable(tool)) criticals++;
      }
    }
    console.log('criticals=' + criticals + ' files=' + files.length);
  " --input-type=module 2>/dev/null || echo "error")
  assert_contains "T-05.07: bulk scan of src/claude/agents/ — zero CRITICAL violations" "criticals=0" "$bulk"
fi

# ── E-3 / E-254: agent-persona path conditionalization ──────────────────────

# T-05.08: agent persona with only name+description → PASS (skill fields not required)
PERSONA_MINIMAL='---
name: blueprint-writer
description: Enforce blueprint structure before writing to .ai/blueprints/.
context: default
agent: default
---
# Blueprint Writer body'
result=$(audit_agent "$PERSONA_MINIMAL" "/claude/agents/blueprint-writer.md")
assert_contains "T-05.08: agent persona missing skill fields → PASS (not WARN)" "PASS" "$result"
assert_not_contains "T-05.08b: disable-model-invocation not required for /agents/" "MISSING_FIELD:disable-model-invocation" "$result"
assert_not_contains "T-05.08c: user-invocable not required for /agents/" "MISSING_FIELD:user-invocable" "$result"
assert_not_contains "T-05.08d: allowed-tools not required for /agents/" "MISSING_FIELD:allowed-tools" "$result"

# T-05.08e: the SAME content under a skills path is held to all 5 fields.
result=$(audit_agent "$PERSONA_MINIMAL" "/claude/skills/blueprint-writer/SKILL.md")
assert_contains "T-05.08e: same content as a skill → WARN (strict path)" "WARN" "$result"
assert_contains "T-05.08f: disable-model-invocation required for skills" "MISSING_FIELD:disable-model-invocation" "$result"

# T-05.09: agent persona missing name → WARN (name is always required)
PERSONA_NO_NAME='---
description: An agent persona without a name field.
---
# No name'
result=$(audit_agent "$PERSONA_NO_NAME" "/claude/agents/no-name.md")
assert_contains "T-05.09: agent persona missing name → WARN" "WARN" "$result"
assert_contains "T-05.09b: name reported as missing" "MISSING_FIELD:name" "$result"

# T-05.10: Claude skill missing disable-model-invocation → WARN (Claude path enforces all 5)
CLAUDE_PARTIAL='---
name: partial-claude-skill
description: A Claude skill missing Claude-specific fields.
allowed-tools: Read
---
# Partial Claude skill'
result=$(audit_agent "$CLAUDE_PARTIAL" "/claude/skills/partial/SKILL.md")
assert_contains "T-05.10: Claude skill missing disable-model-invocation → WARN" "WARN" "$result"
assert_contains "T-05.10b: disable-model-invocation reported missing for Claude" "MISSING_FIELD:disable-model-invocation" "$result"

# T-05.11 moved to the REAL server below (T-05.13f, E-295): it exercised the inline copy of the
# checker, which still read `allowed-tools` — a field subagents do not have.

# ── T-05.12 (E-254): real server — the E-68 snake_case alias table is gone ────
# Roundtrip against the actual verify_compliance handler (no inlined copy). HOME points at
# an empty dir so no installed registry.json can whitelist the names, and `paths` is
# relative to the server cwd (D-009 bounds it there).
VERIFY_ABS="$(cd "$(dirname "$VERIFY_MCP")" && pwd -P)/index.js"
VT="$(test_tmpdir verify)"
mkdir -p "$VT/skills/aliased" "$VT/agents"
cat > "$VT/skills/aliased/SKILL.md" <<'MD'
---
name: aliased
description: Declares former snake_case alias names.
disable-model-invocation: false
user-invocable: false
allowed-tools: Read, run_shell_command, google_web_search
---
# aliased
MD
cat > "$VT/agents/persona.md" <<'MD'
---
name: persona
description: Minimal agent persona.
---
# persona
MD
real=$(cd "$VT" && HOME="$VT" mcp_call_tool "$VERIFY_ABS" verify_compliance '{"paths":["skills","agents"]}' 2>/dev/null || echo '{}')
assert_contains "T-05.12: former alias run_shell_command is now a Ghost Tool" "Ghost Tool: 'run_shell_command'" "$real"
assert_contains "T-05.12b: former alias google_web_search is now a Ghost Tool" "Ghost Tool: 'google_web_search'" "$real"
assert_not_contains "T-05.12c: builtin Read is still accepted" "Ghost Tool: 'Read'" "$real"
assert_contains "T-05.12d: minimal /agents/ persona passes (1 PASS, 1 FAIL)" "PASS: 1 | WARN: 0 | FAIL: 1" "$real"
assert_status 1 "T-05.12e: alias table removed from source" \
  grep -qE 'TOOL_ALIASES|ALIAS_VALUES|normaliseToolName' "$VERIFY_MCP"

# ── T-05.13 (E-295, D-084 r3): the subagent frontmatter Claude Code actually enforces ───────
# Real server, real files. The parent's .mcp.json connects task-synchronizer-mcp only.
VT2="$(test_tmpdir verify295)"; mkdir -p "$VT2/agents"
printf '{"mcpServers":{"task-synchronizer-mcp":{"command":"node"}}}\n' > "$VT2/.mcp.json"
_agent() { printf -- '---\nname: %s\ndescription: fixture\n%b\n---\nbody\n' "$1" "$2" > "$VT2/agents/$1.md"; }
_agent legacy_agent 'allowed-tools: Read, Grep'
_agent critic_arch 'mcpServers:\n  - task-synchronizer-mcp'
_agent stray_server 'tools: Read, mcp__nowhere-mcp__thing'
_agent self_removal 'tools: Read, mcp__task-synchronizer-mcp__add_stamp\ndisallowedTools: mcp__*'
_agent good_agent 'tools: Read, Grep, mcp__task-synchronizer-mcp__add_stamp\ndisallowedTools: Write, Edit, NotebookEdit'
_agent ghost_agent 'tools: Read, GhostTool999'
r295=$(cd "$VT2" && HOME="$VT2" mcp_call_tool "$VERIFY_ABS" verify_compliance '{"paths":["agents"]}' 2>/dev/null || echo '{}')
assert_contains "T-05.13a: an agent carrying allowed-tools FAILS (the field is ignored by Claude Code)" "'allowed-tools' is not a subagent field" "$r295"
assert_contains "T-05.13b: a scoped agent (critic_*) with no tools allowlist FAILS" "scoped agent has no 'tools' allowlist" "$r295"
assert_contains "T-05.13c: tools naming a server neither in mcpServers nor the parent's .mcp.json FAILS" "names mcp server 'nowhere-mcp'" "$r295"
assert_contains "T-05.13d: disallowedTools mcp__* removing a server tools needs FAILS" "removes server 'task-synchronizer-mcp'" "$r295"
assert_contains "T-05.13e: a correct agent passes (parent-connected server, reviewer denies writes)" "PASS: 1 | WARN: 0 | FAIL: 5" "$r295"
assert_contains "T-05.13f: a Ghost Tool in an agent's tools allowlist is detected" "Ghost Tool: 'GhostTool999'" "$r295"

# ── E-235 (from browser_optin_test — E-302): the browser download is opt-in and bounded ──
# `ai mcp-setup` ran `npx playwright install chromium` unconditionally, inside the path
# that install-rein.sh — and so every user install and every CI run — depends on. It is an
# unbounded ~150MB fetch, and on 2026-09-09 it ran for over an HOUR on a developer machine
# without finishing.
# The `|| true` that wrapped it was worthless: the failure mode is HANGING, not erroring,
set +e
AI_BO="${REPO_ROOT}/src/bin/ai"
VC="${REPO_ROOT}/src/mcp/vibe-check-mcp"


# ── E-235.1: the default path no longer downloads ─────────────────────────
assert_status 0 "E-235.01a: the default branch tells the operator how to opt in" \
  grep -q "skipping Playwright browsers — run: ai mcp-setup --browsers" "$AI_BO"
assert_status 0 "E-235.01b: the download is gated on WANT_BROWSERS" \
  grep -q 'if \[\[ "$WANT_BROWSERS" -eq 1 \]\]; then' "$AI_BO"
# NON-VACUITY: the download must still EXIST — this task moves it, it does not delete the
# capability. An assertion that only checked for absence would pass on a broken removal.
assert_status 0 "E-235.01c: the download still exists, inside the bounded helper" \
  grep -q 'npx playwright install chromium' "$AI_BO"
assert_status 0 "E-235.01d: and lives in _install_browsers, not the install loop" \
  bash -c "sed -n '/^_install_browsers()/,/^}/p' '$AI_BO' | grep -q 'npx playwright install chromium'"

# ── E-235.2: --browsers and the env rollback both opt in ──────────────────
assert_status 0 "E-235.02a: --browsers sets the flag" \
  grep -q '\[\[ "$_a" == "--browsers" \]\] && WANT_BROWSERS=1' "$AI_BO"
assert_status 0 "E-235.02b: REIN_INSTALL_BROWSERS=1 restores the old behaviour" \
  grep -q 'REIN_INSTALL_BROWSERS:-0' "$AI_BO"

# ── E-235.3: the download is BOUNDED, and the bound is enforced not assumed ─
# `timeout(1)` is absent on macOS by default, so a script that merely CALLS timeout has a
# limit only on some hosts. A bound that silently is not applied is worse than none,
# because it is believed. This asserts a watchdog is actually used.
assert_status 0 "E-235.03a: a timeout budget exists and is configurable" \
  grep -q 'REIN_BROWSER_TIMEOUT:-600' "$AI_BO"
assert_status 0 "E-235.03b: enforced by a watchdog, not by the absent timeout(1)" \
  bash -c "sed -n '/^_install_browsers()/,/^}/p' '$AI_BO' | grep -q 'kill -TERM'"
assert_status 1 "E-235.03c: it does NOT rely on timeout(1) being installed" \
  bash -c "sed -n '/^_install_browsers()/,/^}/p' '$AI_BO' | grep -qE '^\s*timeout '"
# Progress: output piped through `tail -2` made a long download look exactly like a hung
# one. Nothing tells an operator less than a silent process.
assert_status 1 "E-235.03d: progress is not swallowed by tail" \
  bash -c "sed -n '/^_install_browsers()/,/^}/p' '$AI_BO' | grep -q 'tail -2'"
assert_status 0 "E-235.03e: the operator is told what is happening and for how long" \
  bash -c "sed -n '/^_install_browsers()/,/^}/p' '$AI_BO' | grep -q 'bounded to'"
# An optional browser must never fail the install.
assert_status 0 "E-235.03f: a failed download does not fail the install" \
  bash -c "sed -n '/^_install_browsers()/,/^}/p' '$AI_BO' | grep -q 'return 0'"

# ── E-235.4: first use fails FAST and says what to run ────────────────────
assert_status 0 "E-235.04a: the browser-check helper exists" test -f "${VC}/browser-check.mjs"
assert_status 0 "E-235.04b: every launch site is guarded" \
  bash -c "[[ \"\$(grep -c 'assertBrowserAvailable(chromium)' '${VC}/index.js')\" -eq 3 ]]"
assert_status 0 "E-235.04c: the rejection is machine-greppable" \
  grep -q 'BROWSER_MISSING' "${VC}/browser-check.mjs"
# A diagnostic that does not tell you what to run is half a message.
assert_status 0 "E-235.04d: and names the one command that fixes it" \
  grep -q 'ai mcp-setup --browsers' "${VC}/browser-check.mjs"

# The helper's logic, exercised rather than grepped.
_probe() {  # <mode> → ok|missing
  MODE_BO="$1" node --input-type=module -e '
    const { browserStatus } = await import(process.env.BC);
    // A stub chromium that behaves like Playwright with no browser downloaded.
    const missing = { executablePath: () => { throw new Error("Executable doesn'"'"'t exist"); } };
    const present = { executablePath: () => process.env.BC.replace("file://", "") };
    const c = process.env.MODE_BO === "present" ? present : missing;
    console.log(browserStatus(c).ok ? "ok" : "missing");
  ' 2>/dev/null
}
export BC="file://${VC}/browser-check.mjs"
assert_contains "E-235.04e: a missing executable is detected"        "missing" "$(_probe missing)"
assert_contains "E-235.04f: a present executable is accepted"        "ok"      "$(_probe present)"
assert_contains "E-235.04g: REIN_SKIP_BROWSER_CHECK=1 bypasses the probe" "ok" \
  "$(REIN_SKIP_BROWSER_CHECK=1 _probe missing)"

# ── E-235.5: doctor reports browser status ────────────────────────────────
assert_status 0 "E-235.05a: doctor has a browser section" \
  grep -q 'Vibe-check browsers' "$AI_BO"
assert_status 0 "E-235.05b: and tells the operator how to fix it" \
  bash -c "grep -A12 'Vibe-check browsers' '$AI_BO' | grep -q 'ai mcp-setup --browsers'"

# ── E-235.6: CI installs them explicitly, and caches ──────────────────────
# E-268 (D-072): the GitHub workflow that used to do this is gone — `ai ci run` is CI now,
# and its `browsers` step keeps the same two properties: explicit install, persistent cache.
AI_BIN="${REPO_ROOT}/src/bin/ai"
assert_status 0 "E-235.06a: the local CI runner installs Chromium explicitly" \
  bash -c "sed -n '/── browsers ──/,/── install ──/p' '$AI_BIN' | grep -q 'playwright install chromium'"
assert_status 0 "E-235.06b: cached under ~/.rein/ci, so it is a download once per version" \
  grep -q 'PLAYWRIGHT_BROWSERS_PATH=\${ci_home}/cache/ms-playwright' "$AI_BIN"
assert_status 0 "E-235.06c: a cache hit is reported rather than silently re-downloaded" \
  bash -c "sed -n '/── browsers ──/,/── install ──/p' '$AI_BIN' | grep -q 'cache hit'"
# E-332 (D-103): the hosted master check runs `ai ci run`, so the browsers step above is the
# only place Chromium is installed — no workflow downloads it on its own.
assert_status 1 "E-235.06d: no workflow installs browsers itself" \
  grep -rqiE 'playwright +install' "${REPO_ROOT}/.github/workflows"

# ── E-235.7: DEVOPS.md records the change (ci_gate) ───────────────────────
assert_status 0 "E-235.07a: DEVOPS-006 exists" \
  grep -q 'DEVOPS-006' "${REPO_ROOT}/.ai/DEVOPS.md"
assert_status 0 "E-235.07b: with a rollback plan" \
  bash -c "grep -A4 'Rollback plan' '${REPO_ROOT}/.ai/DEVOPS.md' | grep -q 'REIN_INSTALL_BROWSERS=1'"

echo ""

# ── E-140 (from e140_e141_e142_test — E-302): token-budget-mcp source contract ──
# Its tools, the usage.sqlite path, BUDGET_WARN and parameterised SQL.
set -e
TOKEN_BUDGET_JS="${REPO_ROOT}/src/mcp/token-budget-mcp/index.js"
TOKEN_BUDGET_PKG="${REPO_ROOT}/src/mcp/token-budget-mcp/package.json"

assert_exists "$TOKEN_BUDGET_JS"
assert_exists "$TOKEN_BUDGET_PKG"

# Source file contains all required tools
TB_CONTENT=$(cat "$TOKEN_BUDGET_JS")
assert_contains "token-budget-mcp: report_cost tool defined"    "report_cost"    "$TB_CONTENT"
assert_contains "token-budget-mcp: get_token_budget tool defined" "get_token_budget" "$TB_CONTENT"
assert_contains "token-budget-mcp: get_usage_report tool defined" "get_usage_report" "$TB_CONTENT"
assert_contains "token-budget-mcp: set_budget tool defined"     "set_budget"     "$TB_CONTENT"
assert_contains "token-budget-mcp: reset_session tool defined"  "reset_session"  "$TB_CONTENT"

# SQLite path uses ~/.rein/usage.sqlite (not hardcoded user path)
assert_contains "token-budget-mcp: DB path uses .rein dir"  ".rein" "$TB_CONTENT"
assert_contains "token-budget-mcp: DB file is usage.sqlite"  "usage.sqlite" "$TB_CONTENT"

# BUDGET_WARN is emitted when threshold exceeded
assert_contains "token-budget-mcp: emits BUDGET_WARN"  "BUDGET_WARN" "$TB_CONTENT"

# Parameterized queries (no injection: uses .run() not string concat in SQL)
assert_contains "token-budget-mcp: uses parameterized SQL" ".run(" "$TB_CONTENT"

# package.json declares @modelcontextprotocol/sdk
TB_PKG=$(cat "$TOKEN_BUDGET_PKG")
assert_contains "token-budget-mcp: package.json has sdk" "@modelcontextprotocol/sdk" "$TB_PKG"

# ── P-7..P-12 (from robustness_p7_p12_test — E-302): the bounded reads each MCP server ships ──
# (issue.body bounding, readHead, the iterative added-line regex, the blueprints fallback, the
# statSync size guard). The helpers' own behaviour moved to tests/unit/bounded-reads.test.mjs.
MEMORY_MCP="${REPO_ROOT}/src/mcp/memory-manager-mcp/index.js"
ALIGNER_MCP="${REPO_ROOT}/src/mcp/blueprint-aligner-mcp/index.js"
ORCH_MCP="${REPO_ROOT}/src/mcp/orchestrator-mcp/index.js"
PATCH_MCP="${REPO_ROOT}/src/mcp/patch-mcp/index.js"


# ── P-7: issue.body is bounded (E-279: now in `ai sync --github`) ─────────────
# The GitHub MCP bridge that capped bodies at 5000 chars was retired (D-075); the only
# issue-ingestion path left is `ai sync --github`, which caps each body at 800 chars.
# Behavioural coverage (a stubbed gh, a 5000-char body) lives in propose_patch_test.sh.
assert_contains "P-7: ai sync --github bounds issue bodies" \
  '(issue.get("body") or "(no description)")[:800]' "$(cat "${REPO_ROOT}/src/bin/ai")"

# ── P-8: readHead helper in memory-manager-mcp ────────────────────────────────

assert_exists "$MEMORY_MCP"
MEMORY=$(cat "$MEMORY_MCP")

assert_contains "P-8: readHead function defined" \
  "function readHead" "$MEMORY"

assert_contains "P-8: openSync used in readHead" \
  "openSync" "$MEMORY"

assert_contains "P-8: readSync used in readHead" \
  "readSync" "$MEMORY"

assert_contains "P-8: closeSync used in readHead" \
  "closeSync" "$MEMORY"

assert_contains "P-8: readHead called for architect_v extraction" \
  "readHead(archPath)" "$MEMORY"

assert_not_contains "P-8: full readFileSync no longer used for architect_v" \
  'readFileSync(archPath, "utf8").split' "$MEMORY"


# ── P-9: Iterative regex in blueprint-aligner-mcp generateDelta ───────────────

assert_exists "$ALIGNER_MCP"
ALIGNER_RB=$(cat "$ALIGNER_MCP")

assert_contains "P-9: iterative addedRe regex defined" \
  "addedRe" "$ALIGNER_RB"

assert_contains "P-9: regex exec loop used" \
  "addedRe.exec(diff)" "$ALIGNER_RB"

assert_not_contains "P-9: diff.split no longer used for added lines" \
  'diff.split("\n").filter' "$ALIGNER_RB"


# ── P-10/P-11: retired with run_preflight (E-276, D-075) ──────────────────────
# readBoundedLines and the blueprints pointer existed only for orchestrator::run_preflight.
# The ai-preflight skill (with its `!` injection) is the only preflight path now; what is
# asserted here is that the tool is really gone, not merely unlisted.

assert_exists "$ORCH_MCP"
ORCH=$(cat "$ORCH_MCP")

assert_not_contains "E-276: run_preflight tool removed from orchestrator-mcp" \
  'run_preflight' "$ORCH"

assert_contains "P-11: .md filter present in run_review" \
  ".endsWith(\".md\")" "$ORCH"

# ── E-169: run_review sovereignty blocks the whole .ai/blueprints/ tree ───────
# Regression guard: the Engineer must not author Architect-owned blueprints. The
# sovereignty check must cover the .ai/blueprints/ directory prefix (not just the
# exact architect.md / BRIEF.md files) so any file beneath it trips a P0 FAIL.
assert_contains "E-169: run_review still blocks architect.md (regression guard)" \
  ".ai/architect.md" "$ORCH"
assert_contains "E-169: run_review blocks the .ai/blueprints/ tree" \
  ".ai/blueprints/" "$ORCH"


# ── P-12: statSync 5MB size guard in patch-mcp ────────────────────────────────

assert_exists "$PATCH_MCP"
PATCH=$(cat "$PATCH_MCP")

assert_contains "P-12: FILE_TOO_LARGE error token present" \
  "FILE_TOO_LARGE" "$PATCH"

assert_contains "P-12: statSync imported" \
  "statSync" "$PATCH"

assert_contains "P-12: 5MB limit enforced" \
  "5 * 1024 * 1024" "$PATCH"

assert_contains "P-12: size check before readFileSync" \
  "statSync(abs).size" "$PATCH"


echo ""

assert_summary
