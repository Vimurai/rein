#!/usr/bin/env bash
# mcp_servers_test.sh — the custom MCP servers as processes: each exists, parses, is registered
# and answers real JSON-RPC (E-49, E-27); a long-running server announces a stale build (E-249)
# and reloads a changed policy (E-237); the P-7 bounded read. E-302 merged these suites here;
# each section names its source. E-467 (D-170 r5) retired every server but task-synchronizer-mcp,
# and E-463 retired safe-exec-mcp as a server (the seatbelt CLI is src/shared/seatbelt.mjs, D-172 r26).
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
for server in task-synchronizer-mcp; do
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

# ── 3. Registry lists the kept servers with correct path fields ───────────────
custom_servers=$(python3 -c "
import json, sys
reg = json.load(open(sys.argv[1]))
names = [n for n, v in reg.get('mcp_servers', {}).items() if 'path' in v]
print(' '.join(names))
" "$REGISTRY")

for server in task-synchronizer-mcp; do
  assert_contains "registry has entry for ${server}" "$server" "$custom_servers"
done
# E-463: safe-exec-mcp is not a server any more; no generated .mcp.json names it.
assert_not_contains "safe-exec-mcp removed from registry.json" "safe-exec-mcp" "$custom_servers"
assert_status 1 "safe-exec-mcp ships no server entry point" test -e "${MCP_DIR}/safe-exec-mcp/index.js"

# ── 4. E-276 (D-075): context-invoker-mcp is retired ──────────────────────────
# Its only job was loading skills/agents over MCP; the Skill and Agent tools do that
# natively. Gone from disk AND from the registry, so no generated .mcp.json names it.
assert_status 1 "context-invoker-mcp removed from src/mcp" test -e "${MCP_DIR}/context-invoker-mcp"
assert_not_contains "context-invoker-mcp removed from registry.json" "context-invoker-mcp" "$custom_servers"


# ── 5. E-467 (D-170 r5): the retired servers are gone from disk AND from the registry ──
for server in advisor-mcp approval-mcp archive-manager-mcp ast-parser-mcp blueprint-aligner-mcp \
              cache-manager-mcp context-guardian-mcp memory-manager-mcp orchestrator-mcp patch-mcp \
              propose-patch-mcp risk-analyzer-mcp token-budget-mcp verification-mcp vibe-check-mcp; do
  assert_status 1 "${server} removed from src/mcp" test -e "${MCP_DIR}/${server}"
  assert_not_contains "${server} removed from registry.json" "$server" "$custom_servers"
done


# ── E-27 (from mcp_behavioral_test — E-302): behavioral JSON-RPC roundtrips ──
# Demonstrates the alternative to grep-against-source assertions: spawn each
# server, exchange real MCP frames, and assert against the protocol response.
# These tests survive cosmetic source changes (quote style, whitespace,
# comment edits) because they only depend on the public contract.
set +e


ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Each row: server-name : tool that must appear in tools/list

declare -a CASES=(
  "task-synchronizer-mcp:get_state"
  "task-synchronizer-mcp:add_task"
  "task-synchronizer-mcp:update_task_status"
  "task-synchronizer-mcp:validate_payload"
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
  "task-synchronizer-mcp:add_topic_seed"    # E-467 (D-170 r5): the SEO units are retired
  "task-synchronizer-mcp:add_cluster_page"
  "task-synchronizer-mcp:report_performance"
  "task-synchronizer-mcp:get_topic_cluster"
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
AI="${REPO_ROOT}/src/bin/rein"
INSTALLER="${REPO_ROOT}/install-rein.sh"
STAMP="${REPO_ROOT}/src/shared/build-stamp.mjs"
SYNCHRONIZER="${REPO_ROOT}/src/mcp/task-synchronizer-mcp/index.js"



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
  # E-379 (D-130): the task store redacts through shared/publish-scan.mjs, whose credential
  # detector (shared/secret-rule.mjs) came over with the shared/ copy above.
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
    bash -c "grep -q STALE_SERVER <<< \"\${_first}\""
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
  bash -c "grep -q STALE_SERVER < <(REIN_BUILD_STAMP=0 E249_MOD='$STAMP' E249_RUN='${_rb}/run' node --no-warnings -e '
      import(process.env.E249_MOD).then(m => console.log(m.staleServerReport({ runDir: process.env.E249_RUN }).join(\"\n\")));
    ' 2>/dev/null)"

# The CLI must ALWAYS exit 0. `rein sync` runs under `set -euo pipefail`, and a non-zero exit
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
# E-460 (D-169) removed the preflight skill; the SessionStart hook runs the same scan through
# the CLI and prints it only when a server is stale (hooks_surface_test.sh S03 observes it).
assert_status 0 "E-249.03b: the session-start hook runs the scan" \
  grep -q '"$_BS" --stale' "${REPO_ROOT}/hooks/session-start.sh"
assert_status 0 "E-249.03c: rein sync runs it as a fail-open step" \
  grep -qE '_sync_step +stale_servers +_report_stale_servers' "$AI"
assert_status 0 "E-249.03d: rein doctor reports it" grep -q '_stale_server_lines' "$AI"
assert_status 0 "E-249.03e: install-rein.sh reports it at the end" \
  grep -q 'build-stamp.mjs" --stale' "$INSTALLER"
# Doctor prints the CLEAN case too — a diagnostic that is silent when healthy cannot be
# told apart from one that did not run.
assert_status 0 "E-249.03f: doctor names the healthy case explicitly" \
  grep -q 'every running server booted the build that is on disk' "$AI"
# The install notice must not be able to fail the install.
assert_status 0 "E-249.03g: the installer's probe is guarded and non-fatal" \
  bash -c "grep < <(grep -A1 'build-stamp.mjs\" --stale' '$INSTALLER') -q '|| true'"

# The interceptor stamps every server, not a hand-maintained list of them.
assert_status 0 "E-249.03h: the stamp rides on the shared instrument() interceptor" \
  grep -q 'bootedBuild(serverName)' "${REPO_ROOT}/src/shared/mcp-telemetry.mjs"
_instrumented="$(grep -lE '^\s*instrument\(server' "${REPO_ROOT}"/src/mcp/*/index.js | wc -l | tr -d ' ')"
# Compared with the registry, not a literal: D-075 retires servers (E-276..E-279), and a
# hard-coded floor of 20 failed the moment the count legitimately dropped below it. The
# per-server check also lives in tests/unit/telemetry.test.mjs (E-277, the mcp_telemetry rows); >=1 guards a
# vacuous glob (E-463 left one server). Every REGISTRY server must be instrumented.
_uninstrumented="$(node -e "const r=require(process.argv[1]); for (const [n,v] of Object.entries(r.mcp_servers)) if (v.path) console.log(n)" "${REPO_ROOT}/src/config/registry.json" \
  | while read -r _s; do grep -qE '^\s*instrument\(server' "${REPO_ROOT}/src/mcp/${_s}/index.js" 2>/dev/null || printf '%s ' "$_s"; done)"
assert_status 0 "E-249.03i: every registry server is instrumented (${_instrumented} instrumented; missing: ${_uninstrumented:-none})" \
  bash -c "[[ -z '${_uninstrumented}' && '${_instrumented}' -ge 1 ]]"

# ── §4: THE REFUSAL (D-067 §3) — state-db and the projectors are not hot-reloaded ──
# E-237 hot-reloads four POLICY modules. The ruling refuses to extend that to state. This
# is asserted because the tempting "fix" for everything above is to hot-reload the lot, and
# nothing else in the tree would object.
assert_status 1 "E-249.04a: state-db is not in the hot-reload set" \
  grep -qE 'loadPolicy\(.*state-db' "${REPO_ROOT}"/src/mcp/*/index.js
assert_status 0 "E-249.04b: the refusal is recorded where the mechanism lives" \
  grep -q 'never patched live' "$STAMP"

# ── §5: the completion gate, BOTH WAYS, through the real tool ────────────────
#
# The gate lives in update_task_status because `rein done` and the MCP path both reach it; a
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
  printf '#!/usr/bin/env bash\n' > "$d/src/bin/rein"
  cp "$d/src/bin/rein" "$h/.rein/bin/rein"
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
      mcp_call_tool '$SYNCHRONIZER' add_task '{\"owner\":\"Engineer (Claude)\",\"description\":\"Add E-249 gate probe. Acceptance: TASKS.md lists it.\",\"tier\":2,\"prefix\":\"E\"}' >/dev/null 2>&1
      mcp_call_tool '$SYNCHRONIZER' update_task_status '{\"id\":\"E-1\",\"status\":\"DONE\",\"summary\":\"probe\"}' 2>/dev/null
    " )
}

assert_status 1 "E-264: REIN_WORKSPACE is not in the environment the gate inherits" \
  bash -c '[[ -n "${REIN_WORKSPACE+x}" ]]'
_gate_dirty="$(_gate_verdict no)"
# E-461 (D-169 r7): a stale build no longer refuses DONE; it prints one [BUILD_STALE] line.
assert_contains "E-249.05a: a build behind the mirror prints [BUILD_STALE]" "[BUILD_STALE] 1 file(s) under src/mcp/ or src/bin/ differ" "${_gate_dirty}"
assert_contains "E-249.05b: and the task still transitions" 'E-1 \u2192 DONE' "${_gate_dirty}"   # raw JSON: the arrow is escaped
assert_contains "E-249.05c: the line says how to fix it" "install-rein.sh" "${_gate_dirty}"
assert_status 0 "E-249.05d: it is printed once" bash -c "test \"\$(grep -o 'BUILD_STALE' <<< \"\$1\" | wc -l)\" -eq 1" _ "${_gate_dirty}"

# NON-VACUITY. Without this, deleting the gate entirely, or breaking it so it refuses
# nothing, would leave 05a-05d passing only if they were also deleted — but a gate that
# refuses EVERYTHING passes them all while making the tool unusable.
_gate_clean="$(_gate_verdict yes)"
assert_status 1 "E-249.05e: DONE is ALLOWED when the mirror is current" \
  bash -c "grep -q BUILD_STALE <<< \"\${_gate_clean}\""
assert_contains "E-249.05f: and the task really transitions" "DONE" "${_gate_clean}"

# The rollback releases the gate rather than requiring the mirror to be fixed.
_gate_pair="$(_gate_fixture no)"
_gp_d="${_gate_pair%%|*}"; _gp_h="${_gate_pair##*|}"
_gate_off="$( cd "$_gp_d" && env -u REIN_HOME HOME="$_gp_h" REIN_BUILD_STAMP=0 bash -c "
    source '${SCRIPT_DIR}/../lib/mcp-client.sh'
    mcp_call_tool '$SYNCHRONIZER' add_task '{\"owner\":\"Engineer (Claude)\",\"description\":\"Add probe. Acceptance: TASKS.md lists it.\",\"tier\":2,\"prefix\":\"E\"}' >/dev/null 2>&1
    mcp_call_tool '$SYNCHRONIZER' update_task_status '{\"id\":\"E-1\",\"status\":\"DONE\"}' 2>/dev/null
  " )"
assert_status 1 "E-249.05g: REIN_BUILD_STAMP=0 releases the gate" \
  bash -c "grep -q BUILD_STALE <<< \"\${_gate_off}\""


echo ""

# ── E-237: the policy hot-reload loader went with its last consumer (E-463; E-464 and E-467 retired
# the others). What stays is sync's staleness notice. ──
# ── E-237.5: `rein sync` reports a running server on an older policy ────────
assert_status 0 "E-237.05a: rein sync has the staleness notice" \
  grep -q '_report_policy_staleness' "${REPO_ROOT}/src/bin/rein"

echo ""

# ── P-7 (from robustness_p7_p12_test — E-302): the bounded read that is left. P-8, P-9 and P-12
# went with memory-manager-mcp, blueprint-aligner-mcp and patch-mcp (E-467).
# ── P-7: issue.body is bounded (E-279: now in `rein sync --github`) ─────────────
# The GitHub MCP bridge that capped bodies at 5000 chars was retired (D-075); the only
# issue-ingestion path left is `rein sync --github`, which caps each body at 800 chars.
# Behavioural coverage (a stubbed gh, a 5000-char body) lives in sync_github_test.sh.
assert_contains "P-7: rein sync --github bounds issue bodies" \
  '(issue.get("body") or "(no description)")[:800]' "$(cat "${REPO_ROOT}/src/bin/rein")"

echo ""

assert_summary
