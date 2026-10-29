#!/usr/bin/env bash
# tests/lib/mcp-client.sh — Behavioral MCP client for stdio JSON-RPC roundtrips.
#
# Replaces string-search assertions (E-27). Spawns a server, exchanges the
# minimum JSON-RPC frames required to reach `tools/list` or `tools/call`,
# and writes each response to stdout as a single JSON line.
#
# Requires: bash, node (for the helper script invoked as the server), python3
# (for json parsing). All deps are already required by the broader suite.
#
# Public functions:
#   mcp_list_tools  <server.js>                      → JSON: { tools: [...] }
#   mcp_call_tool   <server.js> <tool> <args_json>   → JSON: tool result
#
# Exit code 0 on success, non-zero on protocol or transport failure. The
# stdout payload is always a single JSON object (or "{}" on failure).

_mcp_send() {
  # $1 = server path, $2 = method, $3 = args JSON ("" → no arguments)
  local server="$1" method="$2" args="${3:-}"
  python3 - "$server" "$method" "$args" <<'PY'
import json, os, subprocess, sys, time

server, method, args_raw = sys.argv[1], sys.argv[2], sys.argv[3]

# Transport-flake guard: cold `node` spawns + the initialize→tools handshake
# occasionally miss under CPU load (parallel suites), returning an empty result
# that upstream asserts misread as "tool not advertised". Retry the whole
# roundtrip a few times before declaring failure. Tunable via env for CI.
ATTEMPTS = max(1, int(os.environ.get("MCP_CLIENT_RETRIES", "3")))
TIMEOUT_S = float(os.environ.get("MCP_CLIENT_TIMEOUT", "10"))

initialize = {
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "mcp-client.sh", "version": "1.0"},
    },
}
initialized = {"jsonrpc": "2.0", "method": "notifications/initialized"}

if method == "tools/list":
    call = {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
elif method == "tools/call":
    name, _, rest = args_raw.partition(":")
    arguments = json.loads(rest) if rest.strip() else {}
    call = {
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
else:
    print("{}"); sys.exit(2)

frames = "\n".join(json.dumps(m) for m in (initialize, initialized, call)) + "\n"

last_exit = 4
last_stderr = ""
for attempt in range(ATTEMPTS):
    if attempt:
        time.sleep(0.25 * attempt)  # brief backoff before a retry
    # Capture stderr rather than discarding it. A server that dies on startup or throws
    # inside a handler explains itself there, and DEVNULL turned every such failure into
    # an unactionable "0 passed, 1 failed" on CI with no output whatsoever.
    proc = subprocess.Popen(
        ["node", server],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True,
    )
    try:
        stdout, stderr_txt = proc.communicate(frames, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            _, late = proc.communicate(timeout=5)
            last_stderr = late or last_stderr
        except Exception:
            proc.wait()
        last_exit = 3  # transport timeout — retry
        continue

    # Find the response with id == 2
    for line in stdout.splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("id") == 2:
            print(json.dumps(obj.get("result", {})))
            sys.exit(0)
    last_exit = 4  # id==2 response missing — retry
    last_stderr = stderr_txt

# Every attempt failed. Report WHY on stderr — the caller's own stderr is captured by
# tests/run.sh, so this reaches the CI log instead of vanishing.
if last_stderr:
    tail = "\n".join(last_stderr.strip().splitlines()[-15:])
    print(f"[mcp-client] {server} failed after {ATTEMPTS} attempt(s), exit={last_exit}. "
          f"Server stderr:\n{tail}", file=sys.stderr)
else:
    print(f"[mcp-client] {server} failed after {ATTEMPTS} attempt(s), exit={last_exit} "
          f"(no stderr; 3=timeout after {TIMEOUT_S}s, 4=no id==2 response).", file=sys.stderr)

print("{}"); sys.exit(last_exit)
PY
}

mcp_list_tools() {
  _mcp_send "$1" "tools/list" ""
}

mcp_call_tool() {
  # $1=server.js  $2=tool_name  $3=args_json
  _mcp_send "$1" "tools/call" "$2:$3"
}

# Convenience: assert that a tool is listed by name. Exit 0 if present, 1 if not.
mcp_assert_tool_listed() {
  # $1=server.js  $2=tool_name
  # Pipes JSON through stdin and passes the tool name via env so embedded
  # quotes/newlines in rich tool descriptions (vibe-check-mcp) cannot break
  # the Python parse — fixes the inline-string-literal corruption mode.
  local result
  result=$(mcp_list_tools "$1")
  printf '%s' "$result" | TOOL="$2" python3 -c "
import json, os, sys
raw = sys.stdin.read() or '{}'
try:
    data = json.loads(raw)
except Exception:
    sys.exit(2)
names = [t.get('name') for t in data.get('tools', [])]
sys.exit(0 if os.environ.get('TOOL') in names else 1)
"
}

# E-37: assert that a tool's inputSchema lists a parameter as required.
# Replaces source-grep assertions like grep -q '"action"' "$SERVER" which were
# false-positive prone (matched comments / unrelated string literals).
# Args: $1=server.js  $2=tool_name  $3=param_name
mcp_assert_tool_param_required() {
  local result
  result=$(mcp_list_tools "$1")
  printf '%s' "$result" | TOOL="$2" PARAM="$3" python3 -c "
import json, os, sys
raw = sys.stdin.read() or '{}'
try:
    data = json.loads(raw)
except Exception:
    sys.exit(2)
tool = next((t for t in data.get('tools', []) if t.get('name') == os.environ.get('TOOL')), None)
if tool is None:
    sys.exit(3)  # tool not advertised
required = (tool.get('inputSchema') or {}).get('required') or []
sys.exit(0 if os.environ.get('PARAM') in required else 1)
"
}
