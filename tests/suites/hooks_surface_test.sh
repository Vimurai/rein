#!/usr/bin/env bash
# hooks_surface_test.sh — E-284 (D-075 §Component 5): the native subagent and hook surface.
#
#   1. The native frontmatter fields are present where the blueprint puts them.
#   2. The SessionStart brief (E-460, was E-126) and its team rows (E-331).
#   3. `rein sync` removes the hooks E-467 retired and registers none of them again.
#
# E-467 (D-170 r5) deleted: the permission-denied hook rows (E-284.1-2), verify_compliance through
# verification-mcp (E-284.3), the Stop hook rows (T-1..T-5, E-379.S01), the telemetry edge hook's
# ".*" matcher (E-105, T-HM-01..04) and the post-write cache rebuild (E-112) — each went with the
# hook or server it tested.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AI_BIN="${REPO_ROOT}/src/bin/rein"
AGENTS="${REPO_ROOT}/src/claude/agents"

echo "── Suite: hooks_surface_test (E-284) ────────────────────────────────"

skip_unless_cmd node "E-284 native surface" || { assert_summary; exit 0; }
skip_unless_cmd python3 "E-284 native surface" || { assert_summary; exit 0; }

T="$(mktemp -d)"; on_exit "rm -rf '$T'"

# ── E-284.4: native frontmatter fields where the blueprint puts them ────────
_fm() { python3 -c '
import re,sys
s=open(sys.argv[1]).read(); m=re.match(r"^---\n(.*?)\n---\n", s, re.S); print(m.group(1) if m else "")' "$1"; }
for a in critic_acceptance reviewer test_engineer; do   # E-464: reviewer replaced the four critics
  fm="$(_fm "${AGENTS}/${a}.md")"
  assert_contains "E-284.04a: ${a} is scoped to task-synchronizer-mcp" "mcpServers:
  - task-synchronizer-mcp" "$fm"
  assert_match "E-284.04b: ${a} has a maxTurns cap" "maxTurns: [0-9]+" "$fm"
  assert_status 0 "E-284.04c: ${a} workspace copy matches" cmp -s "${AGENTS}/${a}.md" "${REPO_ROOT}/.claude/agents/${a}.md"
done
# E-431 (D-159 r9): the acceptance evaluator runs commands but never writes, and judges (no model pin).
# E-464 (D-169 r8): so does the reviewer.
for a in critic_acceptance reviewer; do
  _fa="$(_fm "${AGENTS}/${a}.md")"
  _ft="$(grep -E '^tools:' <<< "$_fa")"
  assert_match "E-431.F01a: ${a} has a tools allowlist" "^tools: " "$_ft"
  assert_status 1 "E-431.F01b: ${a} tools list no Write or Edit" grep -qE "Write|Edit" <<< "$_ft"
  assert_status 1 "E-431.F02: ${a} carries no model pin (D-110)" grep -qE "^model:" <<< "$_fa"
done
# E-284.04d-e (meta_analyst, memory_curator) went with those agents; arch-review with its skill (E-467).
for s in rein-review; do
  assert_contains "E-284.04f: ${s} runs forked (review output stays out of the caller)" "context: fork" \
    "$(_fm "${REPO_ROOT}/src/claude/skills/${s}/SKILL.md")"
done


# ── E-460 (D-169, lean-core.md §Component 3; replaces E-126's cache prefix): the session brief ──
# The SessionStart hook injects one brief of at most 2 KB: the role stamp, the branch, the role's
# next five open tasks, the last COMM.md heading and one line per anomaly — no blueprint text.
# E-460 deleted S02 (cache-manager's --emit-context output; the server itself went with E-467)
# and S04 (the REIN_DISABLE_CACHE rollback:
# the hook no longer reads the cache, so there is nothing to roll back).
SSC_HOOK="${REPO_ROOT}/hooks/session-start.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
# ── S01: artifacts exist + parse; the cache is no longer read ─────────────────
assert_status 0 "hook exists"          test -f "$SSC_HOOK"
assert_status 0 "hook is executable"   test -x "$SSC_HOOK"
assert_status 0 "hook parses"          bash -n "$SSC_HOOK"
assert_status 1 "E-460.S01: the hook no longer calls cache-manager --emit-context" \
  grep -qE -- 'cache-manager-mcp|--emit-context' "$SSC_HOOK"

# ── S03: the brief — content, order and the 2 KB cap ─────────────────────────
# A fixture project (git, branch lean-fixture) with 8 open E-## tasks, 2 open P-## tasks, one
# over-long task line and an uncommitted COMM.md with two handoffs; a fixture HOME whose shared/
# links src/shared, so the helpers come from the install path and this repository is not touched.
skip_unless_cmd git "E-460 session brief rows" && {
_B="$(mktemp -d)"; on_exit "rm -rf '$_B'"
tc_link_shared "$_B/home"
_bgit() { git -C "$_B/p" -c user.name=fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
mkdir -p "$_B/p/.ai"
{ printf '# TASKS (Generated from state.json)\n\n## Architect\n'
  printf -- '- [ ] P-1: Plan the first thing. | Tier: 2\n- [x] P-2: Done plan. | Tier: 1\n- [ ] P-3: Plan the second thing. | Tier: 1\n'
  printf '\n## Engineer\n- [x] E-1: Already done. | Tier: 1\n'
  printf -- '- [ ] E-2: %s | Tier: 3\n' "$(printf 'Long text %.0s' {1..60})"
  for i in 3 4 5 6 7 8 9; do printf -- '- [ ] E-%s: Build part %s. | Tier: 2\n' "$i" "$i"; done
} > "$_B/p/.ai/TASKS.md"
printf '# COMM\n\n## Handoff — 2026-01-01 10:00 UTC\nold\n' > "$_B/p/.ai/COMM.md"
printf '.ai/state.sqlite*\n.ai/.last-import-blob\n.ai/DIGEST.md\n' > "$_B/p/.gitignore"
_bgit init -q -b lean-fixture; _bgit add -A; _bgit commit -q -m base
printf '\n## Handoff — 2026-01-02 11:00 UTC (Engineer → Architect)\nnew\n' >> "$_B/p/.ai/COMM.md"
_BRAW="$( cd "$_B/p" && printf '{"session_id":"s-brief"}' | HOME="$_B/home" bash "$SSC_HOOK" 2>/dev/null )"
_BRIEF="$(python3 -c 'import json,sys; h=json.loads(sys.stdin.read())["hookSpecificOutput"]; assert h["hookEventName"]=="SessionStart"; sys.stdout.write(h["additionalContext"])' <<< "$_BRAW" 2>/dev/null)"
echo "    brief: $(printf '%s' "$_BRIEF" | wc -c | tr -d ' ') bytes"
assert_status 0 "E-460.S03a: the hook prints valid SessionStart JSON with a non-empty brief" test -n "$_BRIEF"
assert_status 0 "E-460.S03b: the brief is at most 2048 bytes" test "$(printf '%s' "$_BRIEF" | wc -c)" -le 2048
assert_match "E-460.S03c: the first line is the role stamp" '^\[REIN_ROLE\] ' "$(head -1 <<< "$_BRIEF")"
assert_contains "E-460.S03d: the brief names the branch" "Branch: lean-fixture" "$_BRIEF"
assert_contains "E-460.S03e: it counts the role's open tasks" "Next E-## tasks (5 of 8 open" "$_BRIEF"
assert_status 0 "E-460.S03f: exactly five task lines, E-2 to E-6 in order, no P-## and no closed task" \
  test "$(grep -E '^- [A-Z]+-[0-9]+:' <<< "$_BRIEF" | cut -d: -f1 | tr '\n' ' ')" = "- E-2 - E-3 - E-4 - E-5 - E-6 "
assert_contains "E-460.S03g: an over-long task is cut and keeps its tier" "… | Tier 3" "$_BRIEF"
assert_contains "E-460.S03h: the LAST handoff heading is named" \
  "Last handoff (.ai/COMM.md): Handoff — 2026-01-02 11:00 UTC (Engineer → Architect)" "$_BRIEF"
assert_contains "E-460.S03i: an uncommitted COMM.md is one anomaly line" "[COMM_UNCOMMITTED] .ai/COMM.md has" "$_BRIEF"
assert_not_contains "E-460.S03j: no blueprint cache text" "SYSTEM CONTEXT CACHE" "$_BRIEF"
# Silence on success: commit COMM.md and the anomaly line goes.
_bgit add -A; _bgit commit -q -m comm
_BRIEF2="$( cd "$_B/p" && printf '{}' | HOME="$_B/home" bash "$SSC_HOOK" 2>/dev/null )"
assert_not_contains "E-460.S03k: a committed COMM.md prints no anomaly" "COMM_UNCOMMITTED" "$_BRIEF2"
assert_contains "E-460.S03l: (non-vacuity) the second brief was produced" "Branch: lean-fixture" "$_BRIEF2"
# Latency (lean-core.md §Execution Constraints: the session-start hook stays under 500 ms).
# Declared ceiling 2500 ms (5x the contract, the D-138 r3 floor) above a bare node start
# measured in the same run.
_ss_ms() { local a b; a=$(date +%s%N); ( cd "$_B/p" && printf '{}' | HOME="$_B/home" bash "$SSC_HOOK" >/dev/null 2>&1 ); b=$(date +%s%N); echo $(( (b - a) / 1000000 )); }
_ss_min() { local i t m=999999; for i in 1 2 3; do t=$(_ss_ms); (( t < m )) && m=$t; done; echo "$m"; }
_ss_node() { local i t m=999999 a b; for i in 1 2 3; do a=$(date +%s%N); node --no-warnings -e 0; b=$(date +%s%N); t=$(( (b - a) / 1000000 )); (( t < m )) && m=$t; done; echo "$m"; }
assert_perf "E-460.S03m: the session-start hook on a fixture project" "$(_ss_min)" 2500 "$(_ss_node)" 10 200 _ss_min
}

# ── S05: fail-open — node unavailable → hook exits 0 and still briefs (no block) ─
# E-286: the hook pins its own PATH, so "no node" is simulated the way production meets
# it — a recorded node that is gone and none in the fallback dirs (tc_stale_tree) — not
# with a node-free inherited PATH, which the hook no longer reads.
_S05="$(mktemp -d)"; on_exit "rm -rf '$_S05'"
tc_overlay_home "$_S05/home" "$_S05/bin" --no-pin
( . "${SCRIPT_DIR}/../../src/shared/toolchain-record.sh"
  rein_tc_write "$_S05/home/.rein/shared/toolchain.sh" "$_S05/gone/node" "$_S05/bin/python3" /usr/bin/nice )
_S05_HOOK="$(tc_stale_tree "$_S05/tree" "$SSC_HOOK")"
mkdir -p "$_S05/p/.ai"; printf '## Engineer\n- [ ] E-7: Keep working. | Tier: 1\n' > "$_S05/p/.ai/TASKS.md"
if [[ -x /usr/bin/env && -x "$_S05/bin/python3" ]]; then
  assert_status 0 "S05: no node → hook exits 0 (fail-open)" bash -c \
    "cd '$_S05/p' && HOME='$_S05/home' bash '$_S05_HOOK' </dev/null >/dev/null 2>&1"
  # The brief needs only python3: the role stamp still binds the persona (E-208) and the
  # tasks still list.
  _S05_OUT="$(cd "$_S05/p" && HOME="$_S05/home" bash "$_S05_HOOK" </dev/null 2>/dev/null)"
  assert_contains "S05: no node → role stamp still emitted (E-208)" "REIN_ROLE" "$_S05_OUT"
  assert_contains "E-460.S05: no node → the open tasks still list" "E-7: Keep working." "$_S05_OUT"
else
  _skip "S05: fail-open without node — the fixture could not record a python3 to keep"
fi

# ── E-433 (extends S05): the installer records the toolchain on a host without tmux ───────
# tmux is optional (D-160 addendum 1), but `t="$(command -v tmux)"` under the installer's
# `set -euo pipefail` ended the install with a silent exit 1 on the macOS runner (no tmux).
# A PATH that holds node, python3 and nice and no tmux, under the installer's own shell options.
_TM="$(mktemp -d)"; on_exit "rm -rf '$_TM'"
# The host's /usr/bin and /bin are linked in without tmux (a host may ship it there).
mkdir -p "$_TM/bin" "$_TM/rein/shared"
for _f in /usr/bin/* /bin/*; do [[ "${_f##*/}" == tmux || -e "$_TM/bin/${_f##*/}" ]] || ln -s "$_f" "$_TM/bin/${_f##*/}"; done
for _b in node python3; do _p="$(command -v "$_b")" && ln -sf "$_p" "$_TM/bin/$_b"; done
assert_status 0 "E-433.TM1: with no tmux on PATH the installer's toolchain record completes under set -e" bash -c \
  "set -euo pipefail; cd '$_TM'; PATH='$_TM/bin'; command -v tmux >/dev/null 2>&1 && exit 3
   . '${REPO_ROOT:-$PWD}/src/shared/install-finalize.sh'
   rein_fin_record_toolchain '$_TM/rein' '${REPO_ROOT:-$PWD}/src/shared/toolchain-record.sh' >/dev/null 2>&1
   grep -q '^REIN_TC_NODE=' '$_TM/rein/shared/toolchain.sh' && ! grep -q '^REIN_TC_TMUX=' '$_TM/rein/shared/toolchain.sh'"

# ── E-430 (D-159 r3; extends S03-S05): the hook rebuilds .ai/DIGEST.md before it emits ──
# A fixture project and a fixture HOME whose shared/ links src/shared, so the builder comes
# from the install path (rein_locate) and this repository's own .ai/ is never touched.
skip_unless_cmd git "E-430 session-start digest rows" && {
_D="$(mktemp -d)"; on_exit "rm -rf '$_D'"
tc_link_shared "$_D/home"
_dgit() { git -C "$_D/p" -c user.name=fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
mkdir -p "$_D/p/.ai"
printf '%s\n' '{"version":"3","project":{},"tasks":[{"id":"E-1","owner":"Engineer (Claude)","status":"OPEN","tier":2,"description":"Ship it","created_at":"2026-01-01T00:00:00Z","completed_at":null,"summary":null}],"stamps":[],"deltas":[]}' > "$_D/p/.ai/state.json"
printf '{"name":"fixture","version":"1.0.0"}\n' > "$_D/p/package.json"
# The index files a session start creates are ignored as `rein init` ignores them (_gitignore).
printf '.ai/state.sqlite*\n.ai/.last-import-blob\n' > "$_D/p/.gitignore"
_dgit init -q; _dgit add -A; _dgit commit -q -m base
node --no-warnings "${REPO_ROOT}/src/shared/digest-build.mjs" build "$_D/p" >/dev/null 2>&1
_dgit add -A; _dgit commit -q -m digest
_D_OLD="$(head -1 "$_D/p/.ai/DIGEST.md")"
# A task closes in state.json; nothing rebuilds the digest before the next session starts.
python3 -c 'import json,sys; p=sys.argv[1]; s=json.load(open(p)); s["tasks"][0].update(status="DONE",completed_at="2026-01-02T00:00:00Z",summary="shipped"); json.dump(s,open(p,"w"))' "$_D/p/.ai/state.json"
( cd "$_D/p" && HOME="$_D/home" bash "$SSC_HOOK" </dev/null >/dev/null 2>&1 )
assert_status 0 "E-430.S01a: a session start after state.json changed rewrites the digest header" \
  test "$_D_OLD" != "$(head -1 "$_D/p/.ai/DIGEST.md")"
# Fresh against its inputs after that rebuild: digest-cases.json "E-429.03" (E-444, census D11).
_dgit add -A; _dgit commit -q -m closed
( cd "$_D/p" && HOME="$_D/home" bash "$SSC_HOOK" </dev/null >/dev/null 2>&1 )
assert_status 0 "E-430.S01c: a session start on an unchanged tree leaves .ai/ clean" \
  test -z "$(git -C "$_D/p" status --porcelain -- .ai/)"
# A symlinked DIGEST.md: the hook stays fail-open and says so in one context line.
rm -f "$_D/p/.ai/DIGEST.md"; ln -s "$_D/p/package.json" "$_D/p/.ai/DIGEST.md"
assert_contains "E-430.S01d: a builder refusal is one [DIGEST_BUILD_FAILED] context line" "[DIGEST_BUILD_FAILED]" \
  "$( cd "$_D/p" && HOME="$_D/home" bash "$SSC_HOOK" </dev/null 2>/dev/null )"
# Latency (D-138 rule; harness-fitness.md §Execution Constraints): the builder over THIS
# repository's inputs (copied, so nothing here is written) against a bare node start measured
# in the same run — its work above process start stays inside the declared 60 ms ceiling.
mkdir -p "$_D/r/.ai"
cp "${REPO_ROOT}/.ai/state.json" "${REPO_ROOT}/.ai/DECISIONS.md" "$_D/r/.ai/" 2>/dev/null
cp "${REPO_ROOT}/.ai/BRIEF.md" "$_D/r/.ai/" 2>/dev/null; cp "${REPO_ROOT}/package.json" "$_D/r/"
_ms() { local a b; a=$(date +%s%N); "$@" >/dev/null 2>&1; b=$(date +%s%N); echo $(( (b - a) / 1000000 )); }
_dg_min() { local i t m=999999; for i in 1 2 3; do rm -f "$_D/r/.ai/DIGEST.md"; t=$(_ms node --no-warnings "${REPO_ROOT}/src/shared/digest-build.mjs" build "$_D/r"); (( t < m )) && m=$t; done; echo "$m"; }
_node_min() { local i t m=999999; for i in 1 2 3; do t=$(_ms node --no-warnings -e 0); (( t < m )) && m=$t; done; echo "$m"; }
_DG_BASE="$(_node_min)"
assert_perf "E-430.S01e: digest build on this repo's inputs above a bare node start" "$(_dg_min)" 400 "$_DG_BASE" 1 60 _dg_min
}

# ── S06: `rein install` registers the SessionStart hook (canonical wiring) ──────
assert_status 0 "S06: rein install registers SessionStart"   grep -qF 'SessionStart' "$AI_BIN"
assert_status 0 "S06: registers session-start.sh"          grep -qF 'session-start.sh' "$AI_BIN"
assert_status 0 "S06: matcher covers startup|resume"       grep -qF 'startup|resume' "$AI_BIN"
# E-294 (D-087 r2): SessionStart re-fires on resume, clear AND compact — the mint table's
# row 2 makes the re-fire a no-op — and the entry carries NO role argument (the role is the
# launch-record walk's; the old positional "engineer" became an env-free default the mint
# no longer accepts). Asserted on the settings `rein sync` actually generates.
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
_S07_OUT="$(cd "$_S07/team" && HOME="$_S07/home" bash "$SSC_HOOK" </dev/null 2>/dev/null)"
assert_contains "S07: a team project's pulled record is imported at session start" "[STATE_IMPORT] + E-900 OPEN" "$_S07_OUT"
assert_contains "S07b: …and the view now carries it" "E-900: pulled" "$(cat "$_S07/team/.ai/TASKS.md" 2>/dev/null)"
_S07_LEG="$(cd "$_S07/legacy" && HOME="$_S07/home" bash "$SSC_HOOK" </dev/null 2>/dev/null)"
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
_S08_OUT="$(cd "$_S08/y" && HOME="$_S07/home" bash "$SSC_HOOK" </dev/null 2>/dev/null)"
assert_contains "E-331.S08: a teammate's claim made after this clone was cloned is listed at session start" \
  "[CLAIMS] E-900 IN_PROGRESS by dev-a@example.com since" "$_S08_OUT"
assert_not_contains "E-331.S08b: a project without team.json lists no claims (and fetches nothing)" "[CLAIMS]" "$_S07_LEG"

# ── E-467 (D-170 r5): the retired hooks leave settings.json and never come back ──
# Drives the SHIPPED generator (_configure_project_claude_settings in src/bin/rein) by extracting
# its embedded Python at runtime (the scaffolding of the E-105 rows it replaces).
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

run_gen() {  # run_gen <target_dir> — mirrors the bash wrapper's mkdir -p
  mkdir -p "${SANDBOX}/$1"
  ( cd "$SANDBOX" && python3 "$GEN_PY" "$1" "$REGISTRY" >/dev/null 2>&1 )
}

_hooks_named() {  # <settings.json> <script> → how many hook entries, on any event, run it
  F="$1" SUB="$2" python3 -c 'import json,os
d=json.load(open(os.environ["F"]))
print(sum(1 for lst in d.get("hooks",{}).values() for e in lst for h in e.get("hooks",[])
          if os.environ["SUB"] in " ".join([h.get("command","")] + [str(a) for a in h.get("args",[])])))'
}

# ── E-467.H01: a fresh generation registers none of the retired hooks ────────
run_gen "fresh"
for h in stop-hook.sh post-tool-log.sh post-tool-use.sh permission-denied.sh; do
  assert_status 0 "E-467.H01: a fresh settings.json registers no ${h}" \
    test "$(_hooks_named "${SANDBOX}/fresh/settings.json" "$h")" -eq 0
done
# Non-vacuity: the same generation does register the kept gate and brief.
assert_status 0 "E-467.H01b: …while it registers pre-tool-use.sh" \
  test "$(_hooks_named "${SANDBOX}/fresh/settings.json" pre-tool-use.sh)" -ge 1
assert_status 0 "E-467.H01c: …and session-start.sh" \
  test "$(_hooks_named "${SANDBOX}/fresh/settings.json" session-start.sh)" -ge 1

# ── E-467.H02: an older settings.json loses its retired Rein entries, keeps the user's own ──
mkdir -p "${SANDBOX}/stale"
cat > "${SANDBOX}/stale/settings.json" <<'JSON'
{
  "hooks": {
    "Stop": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "bash $HOME/.rein/hooks/stop-hook.sh" },
                                  { "type": "command", "command": "echo users-own-stop-hook" }] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "bash $HOME/.rein/hooks/post-tool-log.sh" }] },
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "bash $HOME/.rein/hooks/post-tool-use.sh" }] }
    ],
    "PermissionDenied": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "bash $HOME/.rein/hooks/permission-denied.sh" }] }
    ]
  }
}
JSON
run_gen "stale"
for h in stop-hook.sh post-tool-log.sh post-tool-use.sh permission-denied.sh; do
  assert_status 0 "E-467.H02a: the retired ${h} entry is removed" \
    test "$(_hooks_named "${SANDBOX}/stale/settings.json" "$h")" -eq 0
done
assert_status 0 "E-467.H02b: the user's own hook on the same event is kept" \
  test "$(_hooks_named "${SANDBOX}/stale/settings.json" users-own-stop-hook)" -eq 1
assert_status 1 "E-467.H02c: src/bin/rein no longer registers a retired hook" \
  grep -qE '\("(Stop|PostToolUse|PermissionDenied)", "[^"]*", "(stop-hook|post-tool-log|post-tool-use|permission-denied)\.sh"' "$AI_BIN"

assert_summary
