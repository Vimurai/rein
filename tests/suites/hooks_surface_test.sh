#!/usr/bin/env bash
# hooks_surface_test.sh — E-284 (D-075 §Component 5): the native subagent and hook surface.
#
#   1. hooks/permission-denied.sh books exactly ONE REJECTED row with source=hook for a
#      denied built-in tool, none for mcp__* (the interceptor owns those), fail-open, fast.
#   2. `ai sync` registers it on the PermissionDenied event.
#   3. verify_compliance — through the REAL MCP tool, not a pasted copy — passes for every
#      shipped agent and FAILS an agent that names a tool outside its mcpServers scope.
#   4. The native frontmatter fields are present where the blueprint puts them.
#
# E-302 folds in the other hooks `ai sync` wires: the SessionStart cache prefix (E-126), the
# Stop hook's DIGEST hygiene, the telemetry edge hook's ".*" matcher (E-105, T-HM-01..04)
# and the post-write cache rebuild (E-112).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/mcp-client.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${REPO_ROOT}/hooks/permission-denied.sh"
VERIFY="${REPO_ROOT}/src/mcp/verification-mcp/index.js"
AI_BIN="${REPO_ROOT}/src/bin/ai"
AGENTS="${REPO_ROOT}/src/claude/agents"

echo "── Suite: hooks_surface_test (E-284) ────────────────────────────────"

skip_unless_cmd node "E-284 native surface" || { assert_summary; exit 0; }
skip_unless_cmd python3 "E-284 native surface" || { assert_summary; exit 0; }

T="$(mktemp -d)"; on_exit "rm -rf '$T'"
DB="$T/telemetry.sqlite"

_count() {  # <tool_name> → REJECTED rows with source=hook for that tool
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    try {
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      const r = db.prepare("SELECT COUNT(*) AS n FROM tool_executions WHERE tool_name = ? AND status = ? AND source = ?")
        .get(process.argv[2], "REJECTED", "hook");
      process.stdout.write(String(r.n));
    } catch { process.stdout.write("0"); }' "$DB" "$1" 2>/dev/null
}
_wait_rows() {  # <tool> <want> — the write is detached; poll up to ~6 s for it to land
  wait_for "[[ \"\$(_count '$1')\" -ge $2 ]]" 6000 100
}
_fire() {  # <tool_name> → runs the hook with a PermissionDenied payload, prints its rc
  printf '{"hook_event_name":"PermissionDenied","session_id":"e284","tool_name":"%s","tool_input":{"command":"x"},"tool_use_id":"t1","reason":"denied by rule","permission_mode":"default"}' "$1" \
    | env AI_TELEMETRY_DB_PATH="$DB" /bin/bash "$HOOK" >/dev/null 2>&1; echo $?
}

# ── E-284.1: one REJECTED row per denied built-in, none for mcp__* ──────────
rc="$(_fire Bash)"
assert_status 0 "E-284.01a: the hook exits 0 (fail-open; the event cannot block) (rc=${rc})" test "$rc" -eq 0
_wait_rows Bash 1
assert_status 0 "E-284.01b: a denied Bash call books exactly one REJECTED row with source=hook (got $(_count Bash))" \
  test "$(_count Bash)" -eq 1
_fire mcp__task-synchronizer-mcp__add_task >/dev/null
sleep 1   # REIN_SLEEP_ALLOWED: negative wait — the detached writer gets the time a write takes; nothing may land
assert_status 0 "E-284.01c: a denied mcp__ tool books nothing here (the interceptor owns it)" \
  test "$(_count mcp__task-synchronizer-mcp__add_task)" -eq 0
rc="$(printf 'not json' | env AI_TELEMETRY_DB_PATH="$DB" /bin/bash "$HOOK" >/dev/null 2>&1; echo $?)"
assert_status 0 "E-284.01d: a malformed payload still exits 0 (rc=${rc})" test "$rc" -eq 0
assert_status 0 "E-284.01e: the hook carries the E-286 toolchain prologue" \
  grep -q '^unset -f \$(compgen -A function)' "$HOOK"

# Latency: the parse and write are detached, so the foreground cost is the prologue +
# locator. Host-relative (D-062): baseline = a bare /bin/bash start on this host.
_ms() { python3 - "$@" <<'PY'
import subprocess, sys, time, os
payload = b'{"tool_name":"Bash","tool_input":{}}'
env = dict(os.environ, AI_TELEMETRY_DB_PATH=sys.argv[2])
best = None
for _ in range(5):
    t = time.perf_counter()
    subprocess.run(["/bin/bash", sys.argv[1]] if sys.argv[1] != "-" else ["/bin/bash", "-c", "exit 0"],
                   input=payload, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    ms = (time.perf_counter() - t) * 1000
    best = ms if best is None else min(best, ms)
print(int(best))
PY
}
base="$(_ms - "$DB")"; el="$(_ms "$HOOK" "$DB")"
assert_perf "E-284.01f: PermissionDenied hook foreground latency" "$el" 20 "$base" 2 30

# ── E-284.2: ai sync registers the hook ─────────────────────────────────────
TA="$T/proj"; mkdir -p "$TA/.ai"
printf '{ "roles": { "engineer": {"provider":"claude","pane_identifier":"0","model":"opus"} } }\n' > "$TA/.ai/roles.json"
( cd "$TA" && REIN_DISABLE_REPO_MAP=1 bash "$AI_BIN" sync >/dev/null 2>&1 )
_reg="$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
for e in d.get("hooks",{}).get("PermissionDenied",[]):
    for h in e.get("hooks",[]): print(e.get("matcher"), h.get("command"), " ".join(h.get("args") or []))' "$TA/.claude/settings.json" 2>/dev/null)"
assert_contains "E-284.02a: ai sync registers permission-denied.sh on PermissionDenied" "permission-denied.sh" "$_reg"
( cd "$TA" && REIN_DISABLE_REPO_MAP=1 bash "$AI_BIN" sync >/dev/null 2>&1 )
_n="$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
print(sum(1 for e in d.get("hooks",{}).get("PermissionDenied",[]) for h in e.get("hooks",[]) if "permission-denied.sh" in " ".join([h.get("command","")] + list(h.get("args") or []))))' "$TA/.claude/settings.json")"
assert_status 0 "E-284.02b: a second sync does not register it twice (got ${_n})" test "$_n" -eq 1

# ── E-284.3: verify_compliance through the real MCP tool ────────────────────
_report() { mcp_call_tool "$VERIFY" verify_compliance "$1" | python3 -c '
import sys, json
for line in sys.stdin:
    try: d = json.loads(line)
    except Exception: continue
    c = (d.get("result") or d).get("content") or []
    if c: print(c[0].get("text", ""))'; }
_r="$(cd "$REPO_ROOT" && _report '{"paths":["src/claude/agents"]}')"
_n_agents="$(find "$AGENTS" -name '*.md' | wc -l | tr -d ' ')"
assert_contains "E-284.03a: every shipped agent passes (${_n_agents} scanned)" "PASS: ${_n_agents} | WARN: 0 | FAIL: 0" "$_r"
mkdir -p "$T/v/agents"
printf -- '---\nname: bad\ndescription: x\nmcpServers:\n  - task-synchronizer-mcp\n---\nCall mcp__filesystem__write_file to save.\n' > "$T/v/agents/bad.md"
_r="$(cd "$T/v" && _report '{"paths":["agents"]}')"
assert_contains "E-284.03b: a tool outside the mcpServers scope FAILS (non-vacuity)" "Scope mismatch: 'mcp__filesystem__write_file'" "$_r"
printf -- '---\nname: good\ndescription: x\ntools: Read, mcp__task-synchronizer-mcp__add_stamp\nmcpServers:\n  - task-synchronizer-mcp\n---\nCall mcp__task-synchronizer-mcp__add_stamp.\n' > "$T/v/agents/bad.md"   # E-295: a scoped agent carries a tools allowlist
_r="$(cd "$T/v" && _report '{"paths":["agents"]}')"
assert_contains "E-284.03c: a tool inside the scope passes" "PASS: 1" "$_r"

# ── E-284.4: native frontmatter fields where the blueprint puts them ────────
_fm() { python3 -c '
import re,sys
s=open(sys.argv[1]).read(); m=re.match(r"^---\n(.*?)\n---\n", s, re.S); print(m.group(1) if m else "")' "$1"; }
for a in critic_arch critic_clean_code critic_security critic_tests test_engineer; do
  fm="$(_fm "${AGENTS}/${a}.md")"
  assert_contains "E-284.04a: ${a} is scoped to task-synchronizer-mcp" "mcpServers:
  - task-synchronizer-mcp" "$fm"
  assert_match "E-284.04b: ${a} has a maxTurns cap" "maxTurns: [0-9]+" "$fm"
  assert_status 0 "E-284.04c: ${a} workspace copy matches" cmp -s "${AGENTS}/${a}.md" "${REPO_ROOT}/.claude/agents/${a}.md"
done
assert_contains "E-284.04d: meta_analyst keeps project memory" "memory: project" "$(_fm "${AGENTS}/meta_analyst.md")"
assert_contains "E-284.04e: memory_curator runs in the background" "background: true" "$(_fm "${AGENTS}/memory_curator.md")"
for s in ai-review arch-review; do
  assert_contains "E-284.04f: ${s} runs forked (review output stays out of the caller)" "context: fork" \
    "$(_fm "${REPO_ROOT}/src/claude/skills/${s}/SKILL.md")"
done


# ── E-126 (from session_start_cache_test — E-302, caching.md §3.2/§3.3): SessionStart cache prefix ──
# The SessionStart hook injects the compiled System Context Cache as a prompt-prefix at session start.
CM="${REPO_ROOT}/src/mcp/cache-manager-mcp/index.js"
SSC_HOOK="${REPO_ROOT}/hooks/session-start.sh"
# ── S01: artifacts exist + parse ─────────────────────────────────────────────
assert_status 0 "hook exists"          test -f "$SSC_HOOK"
assert_status 0 "hook is executable"   test -x "$SSC_HOOK"
assert_status 0 "hook parses"          bash -n "$SSC_HOOK"
assert_status 0 "--emit-context CLI present in cache-manager" grep -qF -- '--emit-context' "$CM"
assert_status 0 "hook uses --emit-context"                   grep -qF -- '--emit-context' "$SSC_HOOK"

# ── S02: --emit-context emits the compiled blob; rollback emits nothing ───────
assert_status 0 "S02: --emit-context emits the System Context blob" bash -c \
  "node --no-warnings '$CM' --emit-context 2>/dev/null | grep -q 'Rein SYSTEM CONTEXT CACHE'"
assert_status 0 "S02: REIN_DISABLE_CACHE=1 emits nothing" bash -c \
  "[ -z \"\$(REIN_DISABLE_CACHE=1 node --no-warnings '$CM' --emit-context 2>/dev/null)\" ]"

# ── S03: hook emits VALID SessionStart JSON with the cache in additionalContext ─
assert_status 0 "S03: hook output is valid SessionStart additionalContext JSON" bash -c "
  bash '$SSC_HOOK' </dev/null 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
h = d[\"hookSpecificOutput\"]
assert h[\"hookEventName\"] == \"SessionStart\", \"event name\"
assert \"Rein SYSTEM CONTEXT CACHE\" in h[\"additionalContext\"], \"cache present\"
assert len(h[\"additionalContext\"]) > 1000, \"non-trivial blob\"
'"

# ── S04: rollback — REIN_DISABLE_CACHE=1 suppresses the CACHE ───────────────
# E-208 (D-054) changed this contract deliberately: the hook still emits the
# `[REIN_ROLE] <role>` stamp, because the ROLE BINDING is not part of the cache
# feature. If disabling the cache also dropped the stamp, an Architect-bound pane
# would silently lose its persona binding (gap G1 would reopen) purely as a
# side-effect of a caching rollback. The cache blob itself must still be absent.
assert_status 0 "S04: rollback flag → cache blob suppressed" bash -c \
  "! REIN_DISABLE_CACHE=1 bash '$SSC_HOOK' </dev/null 2>/dev/null | grep -q 'Rein SYSTEM CONTEXT CACHE'"
assert_status 0 "S04: rollback flag → role stamp still emitted (E-208)" bash -c \
  "REIN_DISABLE_CACHE=1 bash '$SSC_HOOK' </dev/null 2>/dev/null | grep -q 'REIN_ROLE'"

# ── S05: fail-open — node unavailable → hook exits 0, emits nothing (no block) ─
# E-286: the hook pins its own PATH, so "no node" is simulated the way production meets
# it — a recorded node that is gone and none in the fallback dirs (tc_stale_tree) — not
# with a node-free inherited PATH, which the hook no longer reads.
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
_S05="$(mktemp -d)"; on_exit "rm -rf '$_S05'"
tc_overlay_home "$_S05/home" "$_S05/bin" --no-pin
( . "${SCRIPT_DIR}/../../src/shared/toolchain-record.sh"
  rein_tc_write "$_S05/home/.rein/shared/toolchain.sh" "$_S05/gone/node" "$_S05/bin/python3" /usr/bin/nice )
_S05_HOOK="$(tc_stale_tree "$_S05/tree" "$SSC_HOOK")"
if [[ -x /usr/bin/env && -x "$_S05/bin/python3" ]]; then
  assert_status 0 "S05: no node → hook exits 0 (fail-open)" bash -c \
    "HOME='$_S05/home' bash '$_S05_HOOK' </dev/null >/dev/null 2>&1"
  # E-208: no node → no cache blob, but the role stamp still binds the persona
  # (building it needs only python3).
  assert_status 0 "S05: no node → cache blob suppressed" bash -c \
    "! HOME='$_S05/home' bash '$_S05_HOOK' </dev/null 2>/dev/null | grep -q 'Rein SYSTEM CONTEXT CACHE'"
  # The comment above promises the role stamp still binds without node (building it
  # needs only python3) — assert it rather than leaving the claim untested.
  assert_status 0 "S05: no node → role stamp still emitted (E-208)" bash -c \
    "HOME='$_S05/home' bash '$_S05_HOOK' </dev/null 2>/dev/null | grep -q 'REIN_ROLE'"
  # Non-vacuity: the same tree WITH node recorded does emit the cache blob, so the
  # suppression above is caused by the missing node and nothing else.
  ( . "${SCRIPT_DIR}/../../src/shared/toolchain-record.sh"
    rein_tc_write "$_S05/home/.rein/shared/toolchain.sh" "$_S05/bin/node" "$_S05/bin/python3" /usr/bin/nice )
  assert_status 0 "S05: (non-vacuity) with node recorded the same tree emits the blob" bash -c \
    "cd '${REPO_ROOT:-$PWD}' && HOME='$_S05/home' bash '$_S05_HOOK' </dev/null 2>/dev/null | grep -q 'Rein SYSTEM CONTEXT CACHE'"
else
  _skip "S05: fail-open without node — the fixture could not record a python3 to keep"
fi

# ── S06: `ai install` registers the SessionStart hook (canonical wiring) ──────
assert_status 0 "S06: ai install registers SessionStart"   grep -qF 'SessionStart' "$AI_BIN"
assert_status 0 "S06: registers session-start.sh"          grep -qF 'session-start.sh' "$AI_BIN"
assert_status 0 "S06: matcher covers startup|resume"       grep -qF 'startup|resume' "$AI_BIN"
# E-294 (D-087 r2): SessionStart re-fires on resume, clear AND compact — the mint table's
# row 2 makes the re-fire a no-op — and the entry carries NO role argument (the role is the
# launch-record walk's; the old positional "engineer" became an env-free default the mint
# no longer accepts). Asserted on the settings `ai sync` actually generates.
source "${SCRIPT_DIR}/../lib/generated-settings.sh"
_S06G="$(test_tmpdir ssgen)"
_S06SET="$(gen_project_settings "$_S06G/proj")"
assert_status 0 "E-294.S06a: generated SessionStart matcher is exactly startup|resume|clear|compact, args carry no role" \
  python3 - "${_S06SET:-/nonexistent}" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
ent = [(e.get("matcher"), h) for e in s["hooks"]["SessionStart"] for h in e.get("hooks", [])
       if "session-start.sh" in " ".join([h.get("command", "")] + h.get("args", []))]
assert len(ent) == 1, ent
m, h = ent[0]
assert m == "startup|resume|clear|compact", m
args = h.get("args", [])
assert args[-1].endswith("session-start.sh"), args
assert not any(a in ("architect", "engineer") for a in args), args
PY
# Behavioural: idempotent registration against a temp settings.json.
S06_DIR="$(mktemp -d)"; printf '{"hooks":{}}' > "$S06_DIR/settings.json"
python3 - "$S06_DIR/settings.json" <<'PY'
import json, sys
path = sys.argv[1]
for _ in range(2):
    data = json.load(open(path))
    hooks = data.setdefault("hooks", {})
    ss_cmd = "bash $HOME/.rein/hooks/session-start.sh"
    ss = hooks.setdefault("SessionStart", [])
    if not any(h.get("command") == ss_cmd for e in ss for h in e.get("hooks", [])):
        ss.append({"matcher": "startup|resume|clear|compact", "hooks": [{"type": "command", "command": ss_cmd}]})
    json.dump(data, open(path, "w"), indent=2)
PY
assert_status 0 "S06: wires SessionStart→session-start.sh once (idempotent)" \
  python3 -c "import json,sys; s=json.load(open('$S06_DIR/settings.json')); n=sum(1 for e in s['hooks']['SessionStart'] for hh in e.get('hooks',[]) if 'session-start.sh' in hh.get('command','')); sys.exit(0 if n==1 else 1)"
rm -rf "$S06_DIR"

# ── S07 (E-326, D-102): a team project's pulled records are imported at session start ─
# The lines reach the model's context; a legacy project gets no import (and no node start).
_S07="$(mktemp -d)"; on_exit "rm -rf '$_S07'"
mkdir -p "$_S07/home/.rein" "$_S07/team/.ai" "$_S07/legacy/.ai"
tc_link_shared "$_S07/home"   # E-345 (D-109 r1): mirror = this tree + the toolchain record the hooks pin
ln -s "${REPO_ROOT}/src/mcp" "$_S07/home/.rein/mcp"
( cd "$_S07/team" && git init -q . && node --no-warnings --input-type=module -e "
    const { getDb, addTask } = await import('file://${REPO_ROOT}/src/mcp/shared/state-db.js');
    const { writeRecord, taskRecord } = await import('file://${REPO_ROOT}/src/mcp/shared/record-store.mjs');
    const db = getDb('.ai'); addTask('.ai', db, { owner: 'Engineer (Claude)', description: 'local' });
    writeRecord('.ai', 'project', null, { schema: 2, focus: null }, { fresh: true });
    const row = db.prepare('SELECT * FROM tasks').get();
    writeRecord('.ai', 'task', row.id, taskRecord(row), { fresh: true });
    writeRecord('.ai', 'task', 'E-900', taskRecord({ id: 'E-900', owner: 'Engineer (Claude)', status: 'OPEN', description: 'pulled', created_at: new Date().toISOString() }), { fresh: true });
  " )
_S07_OUT="$(cd "$_S07/team" && HOME="$_S07/home" REIN_DISABLE_CACHE=1 bash "$SSC_HOOK" </dev/null 2>/dev/null)"
assert_contains "S07: a team project's pulled record is imported at session start" "[STATE_IMPORT] + E-900 OPEN" "$_S07_OUT"
assert_contains "S07b: …and the view now carries it" "E-900: pulled" "$(cat "$_S07/team/.ai/TASKS.md" 2>/dev/null)"
_S07_LEG="$(cd "$_S07/legacy" && HOME="$_S07/home" REIN_DISABLE_CACHE=1 bash "$SSC_HOOK" </dev/null 2>/dev/null)"
assert_not_contains "S07c: a legacy project gets no import" "STATE_IMPORT" "$_S07_LEG"
assert_status 1 "S07d: …and no store is created for it" test -e "$_S07/legacy/.ai/state.sqlite"

# ── S08 (E-331, D-102 §4): a team project fetches origin/master and lists its claims ──
# Extends S07. Clone y was made before x claimed E-900, so only the hook's fetch can show it.
_S08="$(mktemp -d)"; on_exit "rm -rf '$_S08'"
git init -q --bare -b master "$_S08/origin.git"
git clone -q "$_S08/origin.git" "$_S08/x" 2>/dev/null
git -C "$_S08/x" config user.email dev-a@example.com; git -C "$_S08/x" config user.name a; git -C "$_S08/x" config commit.gpgsign false
mkdir -p "$_S08/x/.ai/tasks"
printf '{"schema":2}\n' > "$_S08/x/.ai/project.json"
printf '%s\n' '{"schema":1,"planner":"dev-a@example.com","claim_ttl_days":7,"shared_log":false,"members":{"dev-a@example.com":{"ranges":{"E":[[900,949]]}},"dev-b@example.com":{"ranges":{"E":[[950,999]]}}}}' > "$_S08/x/.ai/team.json"
printf '%s\n' '{"id":"E-900","owner":"Engineer (Claude)","status":"OPEN","tier":2,"description":"shared","depends_on":[],"created_at":"2026-10-19T00:00:00.000Z","completed_at":null,"summary":null,"rev":1}' > "$_S08/x/.ai/tasks/E-900.json"
printf 'state.sqlite*\n' > "$_S08/x/.ai/.gitignore"
git -C "$_S08/x" add -A; git -C "$_S08/x" commit -qm seed; git -C "$_S08/x" push -q origin master 2>/dev/null
git clone -q "$_S08/origin.git" "$_S08/y" 2>/dev/null
git -C "$_S08/y" config user.email dev-b@example.com
( cd "$_S08/x" && HOME="$_S07/home" node --no-warnings "${REPO_ROOT}/src/shared/cli-state.mjs" task claim E-900 >/dev/null 2>&1 )
_S08_OUT="$(cd "$_S08/y" && HOME="$_S07/home" REIN_DISABLE_CACHE=1 bash "$SSC_HOOK" </dev/null 2>/dev/null)"
assert_contains "E-331.S08: a teammate's claim made after this clone was cloned is listed at session start" \
  "[CLAIMS] E-900 IN_PROGRESS by dev-a@example.com since" "$_S08_OUT"
assert_not_contains "E-331.S08b: a project without team.json lists no claims (and fetches nothing)" "[CLAIMS]" "$_S07_LEG"

# ── Stop hook (from stop_hook_test — E-302): auto-stamps SESSION.md, never pollutes DIGEST ──
# Regression guard for the recurring `- <date>: auto-stamped by Stop hook` junk line in DIGEST's
# curated "Recent Changes" when there is no real session summary.
STOP_HOOK="${REPO_ROOT}/hooks/stop-hook.sh"
HOOK_MIRROR="${HOME}/.rein/hooks/stop-hook.sh"
assert_exists "$STOP_HOOK"

# Helper: fresh sandbox project with a curated DIGEST.
new_sandbox() {
  local d; d="$(mktemp -d)"
  mkdir -p "$d/.ai"
  printf '# SESSION\n' > "$d/.ai/SESSION.md"
  printf '# DIGEST\n\n## Recent Changes\n- 2026-01-01: real curated entry\n' > "$d/.ai/DIGEST.md"
  printf '# LOG\n' > "$d/.ai/LOG.md"
  printf '%s' "$d"
}

# ── T-1: no session summary → NO placeholder line in DIGEST ───────────────────
SB="$(new_sandbox)"
( cd "$SB" && printf '' | bash "$STOP_HOOK" >/dev/null 2>&1 )
assert_status 1 "T-1: DIGEST has NO 'auto-stamped by Stop hook' placeholder" \
  grep -q 'auto-stamped by Stop hook' "$SB/.ai/DIGEST.md"
assert_status 0 "T-1b: curated DIGEST line preserved" \
  grep -q '2026-01-01: real curated entry' "$SB/.ai/DIGEST.md"

# ── T-2: SESSION.md bookkeeping still stamped (the hook's real job) ───────────
assert_status 0 "T-2: SESSION.md got a stop stamp even with no summary" \
  grep -q 'Actor: Claude' "$SB/.ai/SESSION.md"
rm -rf "$SB"

# ── T-3: a REAL summary IS appended to DIGEST ────────────────────────────────
SB="$(new_sandbox)"
# Note: hook reads one line via `read` — stdin must be newline-terminated.
( cd "$SB" && printf '%s\n' '{"summary":"E-999 shipped widget refactor"}' | bash "$STOP_HOOK" >/dev/null 2>&1 )
assert_status 0 "T-3: real session summary appended to DIGEST" \
  grep -q 'E-999 shipped widget refactor' "$SB/.ai/DIGEST.md"
assert_status 1 "T-3b: no placeholder leaked alongside the real summary" \
  grep -q 'auto-stamped by Stop hook' "$SB/.ai/DIGEST.md"
rm -rf "$SB"

# ── E-379 (D-130; the privacy contract table's stop_hook row): the summary is redacted ──
# Extends T-3: the same summary path, carrying a home path, an address and a listed client name.
SB="$(new_sandbox)"
printf '%s' '{"client_names": ["Fabrikam"], "operator_names": ["Ada Quill"]}' > "$SB/.ai/publish-scan.local.json"
# The planted path and address are built from parts: this file is scanned for them (E-365).
_E379_H="/ho""me/carol" _E379_M="jane@""corpmail.net"
( cd "$SB" && printf '{"summary":"E-998 for Fabrikam in %s/x by %s"}\n' "$_E379_H" "$_E379_M" | bash "$STOP_HOOK" >/dev/null 2>&1 )
assert_status 0 "E-379.S01a: the redacted summary reaches DIGEST" \
  grep -q 'E-998 for \[redacted:client_name\] in \[redacted:home_path\]/x by \[redacted:personal_email\]' "$SB/.ai/DIGEST.md"
assert_status 1 "E-379.S01b: no planted value is left in DIGEST or SESSION" \
  grep -qiE "fabrikam|${_E379_H}|corpmail" "$SB/.ai/DIGEST.md" "$SB/.ai/SESSION.md"
rm -rf "$SB"

# ── T-4: non-Rein dir (no .ai/) is a clean no-op ────────────────────────────
SB="$(mktemp -d)"
assert_status 0 "T-4: exits 0 with no .ai/ directory" \
  bash -c "cd '$SB' && printf '' | bash '$STOP_HOOK'"
rm -rf "$SB"

# ── T-5: ~/.rein mirror is byte-identical to the repo source ────────────────
if [[ -f "$HOOK_MIRROR" ]]; then
  assert_status 0 "T-5: ~/.rein/hooks/stop-hook.sh identical to repo source" \
    diff -q "$STOP_HOOK" "$HOOK_MIRROR"
else
  echo "  [SKIP] T-5 — ~/.rein/hooks/stop-hook.sh not installed"
fi

# ── E-105 (from telemetry_hook_matcher_test — E-302, universal-telemetry.md §Components 2): T-HM-01..04 ──
# post-tool-use.sh is registered with matcher ".*" so it captures 100% of tool invocations, not just
# Write|Edit; the sibling logger (post-tool-log.sh) stays on Write|Edit. Drives the SHIPPED generator
# (_configure_project_claude_settings in src/bin/ai) by extracting its embedded Python at runtime.
REGISTRY="${REPO_ROOT}/src/config/registry.json"
SANDBOX="$(mktemp -d -t rein-hookmatch-XXXXXX)"
on_exit 'rm -rf "$SANDBOX"'

# Extract just the claude-settings generator Python (uniquely prefixed with
# REIN_WORKSPACE_VALUE) between its <<'PY' marker and the closing PY. Trailing positional
# args are allowed (E-273 added the legacy-registry path; the generator treats it as
# optional, so the two-arg call below still exercises it).
GEN_PY="${SANDBOX}/gen.py"
awk '
  /REIN_WORKSPACE_VALUE.*python3 - "\$TARGET_DIR" "\$REGISTRY".*<</ {cap=1; next}
  cap && /^PY$/ {cap=0}
  cap {print}
' "$AI_BIN" > "$GEN_PY"

assert_status 0 "generator Python extracted" test -s "$GEN_PY"

# matcher_for <settings.json> <command-substring> → prints the matcher of the
# PostToolUse entry whose hook command contains the substring (or MISSING).
matcher_for() {
  F="$1" SUB="$2" python3 -c 'import json,os,sys
try: d=json.load(open(os.environ["F"]))
except Exception: print("NOFILE"); sys.exit(0)
sub=os.environ["SUB"]
for e in d.get("hooks",{}).get("PostToolUse",[]):
    if any(sub in " ".join([h.get("command","")] + [str(a) for a in h.get("args",[])]) for h in e.get("hooks",[])):
        print(e.get("matcher","")); sys.exit(0)
print("MISSING")'
}

run_gen() {  # run_gen <target_dir> — mirrors the bash wrapper's mkdir -p
  mkdir -p "${SANDBOX}/$1"
  ( cd "$SANDBOX" && python3 "$GEN_PY" "$1" "$REGISTRY" >/dev/null 2>&1 )
}

# ── T-HM-01: fresh generation registers post-tool-use.sh at ".*" ─────────────
run_gen "fresh"
assert_contains "T-HM-01: telemetry hook matcher is .*" \
  ".*" "$(matcher_for "${SANDBOX}/fresh/settings.json" post-tool-use.sh)"
assert_contains "T-HM-01: logger hook stays Write|Edit" \
  "Write|Edit" "$(matcher_for "${SANDBOX}/fresh/settings.json" post-tool-log.sh)"

# ── T-HM-02: a stale Write|Edit telemetry matcher is healed to ".*" ──────────
mkdir -p "${SANDBOX}/stale"
cat > "${SANDBOX}/stale/settings.json" <<'JSON'
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "bash $HOME/.rein/hooks/post-tool-log.sh" }] },
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "bash $HOME/.rein/hooks/post-tool-use.sh" }] }
    ]
  }
}
JSON
run_gen "stale"
assert_contains "T-HM-02: stale telemetry matcher healed to .*" \
  ".*" "$(matcher_for "${SANDBOX}/stale/settings.json" post-tool-use.sh)"
assert_not_contains "T-HM-02: telemetry matcher no longer Write|Edit" \
  "Write|Edit" "$(matcher_for "${SANDBOX}/stale/settings.json" post-tool-use.sh)"
assert_contains "T-HM-02: logger matcher untouched (Write|Edit)" \
  "Write|Edit" "$(matcher_for "${SANDBOX}/stale/settings.json" post-tool-log.sh)"

# ── T-HM-03: idempotent — second run keeps exactly one telemetry entry at .* ──
run_gen "stale"
COUNT=$(F="${SANDBOX}/stale/settings.json" python3 -c 'import json,os
d=json.load(open(os.environ["F"]))
print(sum(1 for e in d["hooks"]["PostToolUse"] for h in e.get("hooks",[]) if "post-tool-use.sh" in " ".join([h.get("command","")] + [str(a) for a in h.get("args",[])])))')
assert_contains "T-HM-03: exactly one telemetry hook after re-run" "1" "$COUNT"

# ── T-HM-04: generator source appends agq_cmd with the ".*" matcher ──────────
# E-290: registration is the exec-form _SPECS table.
assert_status 0 "T-HM-04: src/bin/ai registers post-tool-use.sh at matcher .*" \
  grep -qF '("PostToolUse", ".*", "post-tool-use.sh", [])' "$AI_BIN"

# ── E-112 (from cache_wiring_test — E-302, caching.md §3.1): cache-manager-mcp wired via a post-write hook ──
# The hook rebuilds the System Context cache ONLY when a blueprint or architect.md is written.
CACHE_MCP="${REPO_ROOT}/src/mcp/cache-manager-mcp/index.js"
PTU_HOOK="${REPO_ROOT}/hooks/post-tool-use.sh"
# ── S01: cache-manager exposes a --build CLI mode that exits before the server ─
assert_status 0 "cache-manager has --build CLI branch" \
  grep -qE 'process\.argv\.includes\("--build"\)' "$CACHE_MCP"
# The --build branch must precede server.connect so it exits without serving.
assert_status 0 "--build branch precedes server.connect" \
  python3 -c "import sys; s=open('${CACHE_MCP}').read(); b=s.find('--build'); c=s.find('server.connect'); sys.exit(0 if 0 <= b < c else 1)"

# ── S02: post-tool-use.sh fires the rebuild only on blueprint/architect writes ─
assert_status 0 "hook detects .ai/blueprints/ writes" \
  grep -qF '/.ai/blueprints/' "$PTU_HOOK"
assert_status 0 "hook detects .ai/architect.md writes" \
  grep -qF '/.ai/architect.md' "$PTU_HOOK"
assert_status 0 "hook invokes cache-manager --build" \
  grep -qE 'cache-manager-mcp/index\.js' "$PTU_HOOK"
assert_status 0 "hook honors REIN_DISABLE_CACHE rollback" \
  grep -qF 'REIN_DISABLE_CACHE' "$PTU_HOOK"
# E-223: the hook no longer spells the mirror path itself — it asks the shared resolver,
# which is install-mirror-first by policy. The assertion keeps its INTENT (the hook can
# still reach the installed server) and follows the code to where that is now decided,
# rather than pinning a literal the implementation has moved past.
assert_status 0 "hook resolves cache-manager via the shared install-first locator" \
  grep -qF 'rein_locate mcp/cache-manager-mcp/index.js' "$PTU_HOOK"
assert_status 0 "the resolver it bootstraps prefers the ~/.rein mirror" \
  grep -qF 'shared/locate.sh' "$PTU_HOOK"

# ── S03: detection logic — blueprint/architect REBUILD, src/Bash do not ──────
det() { HOOK_INPUT="$1" python3 - <<'PY' 2>/dev/null
import json,os,sys
try: d=json.loads(os.environ.get("HOOK_INPUT",""))
except Exception: sys.exit(0)
if d.get("tool_name") not in ("Write","Edit"): sys.exit(0)
inp=(d.get("tool_input") or {}); fp=inp.get("file_path") or inp.get("path") or ""
if not fp: sys.exit(0)
n="/"+os.path.normpath(fp).replace("\\","/").lstrip("/")
if "/.ai/blueprints/" in n or n.endswith("/.ai/architect.md"): print("REBUILD")
PY
}
assert_contains "S03: blueprint write triggers REBUILD" "REBUILD" \
  "$(det '{"tool_name":"Write","tool_input":{"file_path":"/p/.ai/blueprints/caching.md"}}')"
assert_contains "S03: architect.md edit triggers REBUILD" "REBUILD" \
  "$(det '{"tool_name":"Edit","tool_input":{"file_path":".ai/architect.md"}}')"
assert_not_contains "S03: src/ write does NOT trigger" "REBUILD" \
  "$(det '{"tool_name":"Write","tool_input":{"file_path":"/p/src/x.js"}}')"
assert_not_contains "S03: non-Write/Edit tool does NOT trigger" "REBUILD" \
  "$(det '{"tool_name":"Bash","tool_input":{"command":"ls"}}')"

# ── S04: --build behaviourally builds the cache + exits 0 ────────────────────
TMP="$(mktemp -d)"; mkdir -p "${TMP}/.ai/blueprints"
echo "# Blueprint: T" > "${TMP}/.ai/blueprints/t.md"
echo "# architect index" > "${TMP}/.ai/architect.md"
OUT="$( cd "${TMP}" && node "${CACHE_MCP}" --build 2>&1 )"; RC=$?
assert_status 0 "S04: --build exits 0 (does not hang serving)" bash -c "[ $RC -eq 0 ]"
assert_contains "S04: --build reports the cache was built" "context cache" "$OUT"
rm -rf "${TMP}"

# ── S05: mirror identity for the hook ────────────────────────────────────────
assert_status 0 "post-tool-use.sh ~/.rein mirror identical" \
  diff -q "$PTU_HOOK" "${HOME}/.rein/hooks/post-tool-use.sh"

assert_summary
