#!/usr/bin/env bash
# ai_clean_test.sh — E-272 (D-074, version-lifecycle.md §Components 3-4): `ai clean`.
#
# The end-to-end layer for the one command in AI-OS that REMOVES things. The registry's
# data faults are pinned in tests/unit/legacy-registry.test.mjs; what has to be proved
# here is the behaviour an operator's data depends on:
#
#   * the dry run changes NOTHING (it is the default, so it is what most runs do);
#   * --apply moves exactly the safe class, and the manifest describes what it moved;
#   * --all needs consent, and a non-interactive stdin without --yes is a REFUSAL (2),
#     never an assumed yes;
#   * --restore brings every item back BYTE-IDENTICAL, and refuses rather than overwrite;
#   * a live watcher survives while an orphaned one is signalled;
#   * ~/.gemini/ and settings.local.json are never touched by any flag.
#
# Everything runs against a fixture HOME, a fixture project and a fixture TMPDIR, so the
# suite never reads or writes the operator's own artefacts (E-240: what a previous run
# left). The watcher processes are registered for cleanup BEFORE they are started.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AI="${REPO_ROOT}/src/bin/ai"

echo "── Suite: ai_clean_test (E-272) ─────────────────────────────────────"

FAKE_HOME="$(test_tmpdir clean-home)"
tc_fixture_home "$FAKE_HOME"   # E-345 (D-109 r1): the toolchain record the hooks pin
PROJ="$(test_tmpdir clean-proj)"
FAKE_TMP="$(test_tmpdir clean-tmp)"
TODAY="$(date -u +%Y-%m-%d)"

# `ai clean` with the fixture HOME/TMPDIR, run from inside the fixture project.
_clean() { ( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" bash "$AI" clean "$@" ) 2>&1; }
_rc() { _clean "$@" >/dev/null 2>&1; echo $?; }
# assert_rc <expected> <label> [ai clean args…] — grade `ai clean`'s OWN exit code.
# assert_status grades the command IT runs, so `assert_status 2 … test "$(_rc)" -eq 2`
# asserts that `test` exited 2, which it never does.
assert_rc() {
  local exp="$1" label="$2"; shift 2
  local got; got="$(_rc "$@")"
  if [[ "$got" == "$exp" ]]; then _pass "${label} (exit=${got})"
  else _fail "${label} (expected exit=${exp}, got ${got})"; fi
}
_sha() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }

# ── the fixture: one item of every kind and class ─────────────────────────────
mkdir -p "${FAKE_HOME}/.ai-os/run" "${FAKE_HOME}/.ai-os/mcp/retired-mcp" \
         "${FAKE_HOME}/.ai-os/ci" "${FAKE_HOME}/.gemini" \
         "${PROJ}/.ai" "${PROJ}/.claude" "${PROJ}/.gemini/skills/mine"

# safe · file · rule stale-mtime (backdated past the 7-day window)
printf '{"v":1,"role":"engineer"}' > "${FAKE_HOME}/.ai-os/run/role-stale.lock"
touch -t "$(date -u -v-20d +%Y%m%d%H%M 2>/dev/null || date -u -d '20 days ago' +%Y%m%d%H%M)" \
  "${FAKE_HOME}/.ai-os/run/role-stale.lock"
# safe · file · rule dead-pid (2147480000 cannot be a live pid on any supported host)
printf '{"server":"x","pid":2147480000}' > "${FAKE_HOME}/.ai-os/run/build-dead.json"
# safe · file · rule dead-pid, but its pid is THIS process: never a finding
printf '{"server":"y","pid":%s}' "$$" > "${FAKE_HOME}/.ai-os/run/build-live.json"
# safe · dir · rule not-in-src (src/mcp does not ship retired-mcp)
echo x > "${FAKE_HOME}/.ai-os/mcp/retired-mcp/index.js"
# prompt · file · a HOME copy of the old installer
echo '# old installer' > "${FAKE_HOME}/install-ai-os.sh"
# prompt · dir · a provider workspace that may hold the operator's own skill
echo 'my own skill' > "${PROJ}/.gemini/skills/mine/SKILL.md"
# setting · report only · one retired allow and one the operator added
cat > "${PROJ}/.claude/settings.json" <<'JSON'
{ "permissions": { "allow": ["mcp__intent-refiner-mcp__*", "mcp__semrush__*", "Bash(ls:*)"] } }
JSON
cp "${PROJ}/.claude/settings.json" "${PROJ}/.claude/settings.local.json"
SETTINGS_LOCAL_SHA="$(_sha "${PROJ}/.claude/settings.local.json")"
# not-ours · dir · Antigravity's own user data, OAuth credentials included
echo 'oauth' > "${FAKE_HOME}/.gemini/credentials.json"
# the project log the apply must annotate
printf '# LOG\n' > "${PROJ}/.ai/LOG.md"

# safe · file · known_hashes: the exact bytes `ai sync` shipped as the GEMINI.md shim.
# 343cd5b is the E-254 commit that deleted the template; its parent holds the last
# version. Recorded as a skip rather than a failure if history is unavailable (a shallow
# clone), because the hash mechanism itself is unit-tested.
HAVE_SHIM=0
if git -C "$REPO_ROOT" show '343cd5b^:src/templates/GEMINI.md' > "${PROJ}/GEMINI.md" 2>/dev/null; then
  HAVE_SHIM=1
  GEMINI_SHA="$(_sha "${PROJ}/GEMINI.md")"
  # The same shim WITH an operator edit: the class must drop to prompt.
  git -C "$REPO_ROOT" show '343cd5b^:src/templates/AGENTS.md' > "${PROJ}/AGENTS.md" 2>/dev/null
  echo '# my own additions' >> "${PROJ}/AGENTS.md"
else
  rm -f "${PROJ}/GEMINI.md"
fi

# ── E-272.1: the dry run lists everything and changes nothing ─────────────────
BEFORE="$(cd "$FAKE_HOME" && find . -type f | sort; cd "$PROJ" && find . -type f | sort)"
OUT="$(_clean)"
assert_contains "E-272.01a: the safe group is listed" "safe — reproducible from src/" "$OUT"
assert_contains "E-272.01b: the prompt group is listed" "prompt — may hold your content" "$OUT"
assert_contains "E-272.01c: the not-ours group is listed" "not ours — reported only" "$OUT"
assert_contains "E-272.01d: a stale role lock is found with its reason" "role-stale.lock" "$OUT"
assert_contains "E-272.01e: the reason names the age rule" "over 7d" "$OUT"
assert_contains "E-272.01f: a dead build record is found" "build-dead.json" "$OUT"
assert_contains "E-272.01g: the mirror orphan is found" "retired-mcp" "$OUT"
assert_contains "E-272.01h: the provider workspace is found" "${PROJ}/.gemini" "$OUT"
assert_contains "E-272.01i: ~/.gemini is reported, not removable" "report only" "$OUT"
assert_contains "E-272.01j: the retired settings allow is reported" "mcp__intent-refiner-mcp__*" "$OUT"
assert_not_contains "E-272.01k: a live build record is NOT a finding" "build-live.json" "$OUT"
assert_not_contains "E-272.01l: a user-added server's allow is left alone" "mcp__semrush__*" "$OUT"
assert_not_contains "E-272.01m: settings.local.json is never even scanned" "settings.local.json" "$OUT"
AFTER="$(cd "$FAKE_HOME" && find . -type f | sort; cd "$PROJ" && find . -type f | sort)"
assert_status 0 "E-272.01n: the dry run changed nothing on disk" test "$BEFORE" = "$AFTER"
assert_rc 1 "E-272.01o: a dry run with findings exits 1"

if [[ "$HAVE_SHIM" -eq 1 ]]; then
  assert_contains "E-272.01p: an unmodified shim is safe, by hash" "byte-identical to a version AI-OS shipped" "$OUT"
  assert_contains "E-272.01q: an edited shim is downgraded to prompt" "edited since AI-OS wrote it" "$OUT"
else
  _skip "E-272.01p/q: shim hash cases (git history for 343cd5b unavailable)"
fi

# ── E-272.2: --json is the full, uncollapsed list ─────────────────────────────
JSON="$(_clean --json)"
assert_status 0 "E-272.02a: --json emits parseable JSON with counts" \
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); assert d['counts']['safe']>=int(sys.argv[2]), d['counts']" "$JSON" "$((3 + HAVE_SHIM))"
# E-378: the unmodified shim counts as safe only when its known hash could be read from history.
assert_status 0 "E-272.02b: report-only findings are counted apart from actionable ones" \
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); assert d['counts']['report_only']>=2, d['counts']" "$JSON"

# ── E-272.3: --project-only / --home-only narrow the scan ─────────────────────
PONLY="$(_clean --project-only)"
assert_not_contains "E-272.03a: --project-only skips the mirror" "retired-mcp" "$PONLY"
assert_contains "E-272.03b: --project-only keeps the project workspace" "${PROJ}/.gemini" "$PONLY"
HONLY="$(_clean --home-only)"
assert_contains "E-272.03c: --home-only keeps the mirror orphan" "retired-mcp" "$HONLY"
assert_not_contains "E-272.03d: --home-only skips the project" "skills/mine" "$HONLY"

# ── E-272.4: consent — a non-interactive stdin is a refusal, not a yes ────────
assert_rc 2 "E-272.04a: --apply --all without --yes on a pipe exits 2" --apply --all
assert_contains "E-272.04b: the refusal says why and how to proceed" "pass --yes to confirm" "$(_clean --apply --all)"
UNTOUCHED="$(cd "$FAKE_HOME" && find . -type f | sort; cd "$PROJ" && find . -type f | sort)"
assert_status 0 "E-272.04c: the refused run changed nothing" test "$BEFORE" = "$UNTOUCHED"
assert_rc 2 "E-272.04d: an unknown option exits 2" --delete-everything
assert_rc 2 "E-272.04e: --restore with a malformed date exits 2" --restore yesterday --yes
assert_rc 2 "E-272.04f: --restore and --purge cannot be combined" --restore "$TODAY" --purge

# ── E-272.5: AI_OS_CLEAN_DISABLE=1 degrades every form to a report ────────────
DIS="$( ( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" AI_OS_CLEAN_DISABLE=1 bash "$AI" clean --apply --all --yes ) 2>&1 )"
assert_contains "E-272.05a: the rollback flag says nothing was touched" "AI_OS_CLEAN_DISABLE=1" "$DIS"
DIS_AFTER="$(cd "$FAKE_HOME" && find . -type f | sort; cd "$PROJ" && find . -type f | sort)"
assert_status 0 "E-272.05b: nothing was removed under the rollback flag" test "$BEFORE" = "$DIS_AFTER"

# ── E-272.6: --apply moves exactly the safe class ─────────────────────────────
GEMINI_PROJ_SHA=""
[[ "$HAVE_SHIM" -eq 1 ]] && GEMINI_PROJ_SHA="$GEMINI_SHA"
APPLY="$(_clean --apply)"
TRASH="${FAKE_HOME}/.ai-os/trash/${TODAY}"
assert_contains "E-272.06a: the apply reports where each item went" "moved" "$APPLY"
assert_contains "E-272.06b: the apply prints the undo command" "ai clean --restore ${TODAY}" "$APPLY"
assert_status 0 "E-272.06c: the stale role lock is gone from the mirror" \
  test ! -e "${FAKE_HOME}/.ai-os/run/role-stale.lock"
assert_status 0 "E-272.06d: the dead build record is gone" \
  test ! -e "${FAKE_HOME}/.ai-os/run/build-dead.json"
assert_status 0 "E-272.06e: the live build record was left alone" test -e "${FAKE_HOME}/.ai-os/run/build-live.json"
assert_status 0 "E-272.06f: the mirror orphan is gone" test ! -e "${FAKE_HOME}/.ai-os/mcp/retired-mcp"
assert_status 0 "E-272.06g: the prompt-class workspace survives --apply" test -e "${PROJ}/.gemini/skills/mine/SKILL.md"
assert_status 0 "E-272.06h: the prompt-class installer copy survives --apply" test -e "${FAKE_HOME}/install-ai-os.sh"
assert_status 0 "E-272.06i: ~/.gemini is never touched" test -e "${FAKE_HOME}/.gemini/credentials.json"
assert_status 0 "E-272.06j: settings.local.json is byte-identical" \
  test "$(_sha "${PROJ}/.claude/settings.local.json")" = "$SETTINGS_LOCAL_SHA"
assert_status 0 "E-272.06k: settings.json was not edited" \
  grep -q "mcp__intent-refiner-mcp__\*" "${PROJ}/.claude/settings.json"
assert_status 0 "E-272.06l: the trash manifest exists" test -e "${TRASH}/manifest.json"
assert_rc 1 "E-272.06m: prompt items left behind exit 1"

MANI="$(cat "${TRASH}/manifest.json")"
assert_status 0 "E-272.06n: the manifest records origin, class, entry and hash per item" \
  python3 -c "
import json,sys
items=json.loads(sys.argv[1])
assert items, 'empty manifest'
for i in items:
    assert i['class']=='safe', i
    for k in ('origin','entry_id','kind','moved_at','trash'):
        assert i.get(k), (k, i)
    if i['kind']=='file':
        assert i['sha256'] and len(i['sha256'])==64, i
ids={i['entry_id'] for i in items}
assert 'dead-role-lock' in ids and 'dead-build-record' in ids and 'mirror-orphan-mcp' in ids, ids
" "$MANI"
assert_status 0 "E-272.06o: one clean.log line per apply" \
  test "$(grep -c 'apply' "${FAKE_HOME}/.ai-os/clean.log")" -eq 1
assert_status 0 "E-272.06p: one LOG.md line per apply" \
  test "$(grep -c '| ai clean |' "${PROJ}/.ai/LOG.md")" -eq 1

# ── E-272.7: --apply --all --yes moves the prompt class ───────────────────────
ALL="$(_clean --apply --all --yes)"
assert_status 0 "E-272.07a: the provider workspace is gone" test ! -e "${PROJ}/.gemini"
assert_status 0 "E-272.07b: the HOME installer copy is gone" test ! -e "${FAKE_HOME}/install-ai-os.sh"
assert_status 0 "E-272.07c: ~/.gemini STILL survives --all" test -e "${FAKE_HOME}/.gemini/credentials.json"
assert_contains "E-272.07d: the second apply logged its own line" "moved" "$ALL"
assert_rc 0 "E-272.07e: only report-only findings remain, so the exit is 0"
assert_status 0 "E-272.07f: the retired allow is still reported after --all" \
  test -n "$(_clean | grep 'intent-refiner')"

# ── E-272.8: --restore returns every item byte-identical ──────────────────────
assert_rc 2 "E-272.08a: --restore without --yes on a pipe exits 2" --restore "$TODAY"
# One origin is re-created before the restore: the item must be REFUSED, not overwritten.
printf 'a different installer\n' > "${FAKE_HOME}/install-ai-os.sh"
RESTORE="$(_clean --restore "$TODAY" --yes)"
assert_contains "E-272.08b: an existing origin is refused" "refused" "$RESTORE"
assert_status 0 "E-272.08c: the re-created file was NOT overwritten" \
  grep -q "a different installer" "${FAKE_HOME}/install-ai-os.sh"
assert_status 0 "E-272.08d: the mirror orphan is back" test -e "${FAKE_HOME}/.ai-os/mcp/retired-mcp/index.js"
assert_status 0 "E-272.08e: the role lock is back" test -e "${FAKE_HOME}/.ai-os/run/role-stale.lock"
assert_status 0 "E-272.08f: the provider workspace is back with its content" test -e "${PROJ}/.gemini/skills/mine/SKILL.md"
assert_status 0 "E-272.08g: the restored skill is byte-identical" \
  test "$(cat "${PROJ}/.gemini/skills/mine/SKILL.md")" = "my own skill"
if [[ "$HAVE_SHIM" -eq 1 ]]; then
  assert_status 0 "E-272.08h: the restored shim is byte-identical" \
    test "$(_sha "${PROJ}/GEMINI.md")" = "$GEMINI_PROJ_SHA"
else
  _skip "E-272.08h: shim restore (git history for 343cd5b unavailable)"
fi
assert_rc 1 "E-272.08i: a refused item leaves the restore at exit 1" --restore "$TODAY" --yes
assert_rc 2 "E-272.08j: a date with nothing recorded exits 2" --restore 1999-01-01 --yes

# ── E-272.9: --purge empties trash older than the retention window ────────────
OLD_DAY="$(date -u -v-40d +%Y-%m-%d 2>/dev/null || date -u -d '40 days ago' +%Y-%m-%d)"
mkdir -p "${FAKE_HOME}/.ai-os/trash/${OLD_DAY}/stuff"
echo x > "${FAKE_HOME}/.ai-os/trash/${OLD_DAY}/stuff/f"
PURGE="$(_clean --purge)"
assert_status 0 "E-272.09a: a 40-day-old day folder is purged" test ! -e "${FAKE_HOME}/.ai-os/trash/${OLD_DAY}"
assert_status 0 "E-272.09b: today's trash is kept" test -e "${TRASH}"
assert_contains "E-272.09c: the purge says what it removed" "purged ${OLD_DAY}" "$PURGE"
mkdir -p "${FAKE_HOME}/.ai-os/trash/${OLD_DAY}"
assert_rc 2 "E-272.09d: --older-than needs a number of days" --purge --older-than soon
assert_rc 0 "E-272.09e: --older-than 1d takes the same folder" --purge --older-than 1d
assert_status 0 "E-272.09f: and it is gone" test ! -e "${FAKE_HOME}/.ai-os/trash/${OLD_DAY}"

# ── E-272.10: processes — the orphan is signalled, the lock holder is not ─────
# An ai-watch fixture is `exec -a ai-watch sleep`, started from a subshell that exits
# immediately so the child is reparented to init (ppid 1) — the shape the scan looks for.
# register_cleanup runs BEFORE the process exists (E-240): a failing assertion below must
# not leak a sleeper.
if command -v pgrep >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  ORPHAN_CWD="${FAKE_TMP}/orphan-proj"
  LIVE_CWD="${FAKE_TMP}/live-proj"
  WATCH_BIN="${FAKE_TMP}/bin/ai-watch"
  mkdir -p "${ORPHAN_CWD}" "${LIVE_CWD}/.ai/.ai-watch.lock" "${FAKE_TMP}/bin"
  register_cleanup "pkill -f '${FAKE_TMP}/bin/ai-watch' 2>/dev/null || true"
  # A SCRIPT NAMED ai-watch. The scan matches the program name in the command line, so the
  # fixture has to carry that name, and its path makes it unambiguous which processes are
  # ours (the operator's own watchers must not be matched by pgrep). It is a script and
  # not a copy of /bin/sleep because macOS SIGKILLs a copied system binary — its code
  # signature no longer matches — which made this fixture "could not orphan a process"
  # rather than a test.
  printf '#!/usr/bin/env python3\nimport sys, time\ntime.sleep(int(sys.argv[1]))\n' > "$WATCH_BIN"
  chmod +x "$WATCH_BIN"

  # The orphan: started from a subshell that exits at once. Its ppid is NOT reliably 1 —
  # bash has not reaped the subshell, so the zombie is still its parent — which is exactly
  # why the scan keys on "cwd in the temp root, holds no watcher lock" instead.
  ( cd "$ORPHAN_CWD" && "$WATCH_BIN" 120 >/dev/null 2>&1 & )
  # The live one: records its own pid in the watcher lock, then becomes the watcher.
  ( cd "$LIVE_CWD" && bash -c 'echo $$ > .ai/.ai-watch.lock/pid; exec "$0" 120' "$WATCH_BIN" >/dev/null 2>&1 & )
  _ac_both_up() {  # the live watcher wrote its pid AND a second (orphaned) watcher is running
    local lp; lp="$(cat "${LIVE_CWD}/.ai/.ai-watch.lock/pid" 2>/dev/null)"; [[ -n "$lp" ]] || return 1
    pgrep -f "${FAKE_TMP}/bin/ai-watch" 2>/dev/null | grep -qv "^${lp}$"
  }
  wait_for _ac_both_up 5000 100 || true
  LIVE_PID="$(cat "${LIVE_CWD}/.ai/.ai-watch.lock/pid" 2>/dev/null || echo 0)"
  ORPHAN_PID="$(pgrep -f "${FAKE_TMP}/bin/ai-watch" 2>/dev/null | grep -v "^${LIVE_PID}$" | head -1 || true)"

  if [[ -n "$ORPHAN_PID" && "${LIVE_PID:-0}" -gt 0 ]] && kill -0 "$ORPHAN_PID" 2>/dev/null; then
    PROCOUT="$(_clean)"
    assert_contains "E-272.10a: the watcher census names live and orphaned counts" \
      "orphan-watcher:" "$PROCOUT"
    assert_contains "E-272.10b: the orphan is listed with its pid" "pid ${ORPHAN_PID}" "$PROCOUT"
    assert_not_contains "E-272.10c: the lock-holding watcher is not listed" "pid ${LIVE_PID}" "$PROCOUT"
    _clean --apply >/dev/null 2>&1
    wait_for "! kill -0 ${ORPHAN_PID} 2>/dev/null" 5000 100 || true
    assert_status 1 "E-272.10d: the orphaned watcher was signalled" kill -0 "$ORPHAN_PID"
    assert_status 0 "E-272.10e: the lock-holding watcher is still running" kill -0 "$LIVE_PID"
    kill -TERM "$LIVE_PID" 2>/dev/null || true
  else
    _skip "E-272.10a-e: watcher fixtures (could not orphan a process on this host)"
  fi
else
  _skip "E-272.10a-e: watcher fixtures (pgrep or python3 unavailable)"
fi

# ── E-272.11: the doctor lines ────────────────────────────────────────────────
DOC="$( ( cd "$PROJ" && HOME="$FAKE_HOME" TMPDIR="$FAKE_TMP" bash "$AI" doctor ) 2>&1 )"
assert_contains "E-272.11a: doctor carries the legacy-artefact line" "legacy artefacts:" "$DOC"
assert_contains "E-272.11b: doctor carries the watcher census" "watchers:" "$DOC"
# D-099 (E-322): the handoff-bridge queue line went with the watcher; only the legacy census
# above (leftover processes for `ai clean`) still names watchers.
assert_not_contains "E-322.D1: doctor prints no handoff-bridge queue line" "Handoff bridge" "$DOC"
assert_not_contains "E-322.D2: …and no queued-handoff count" "queued:" "$DOC"

# ── E-272.12: the dry run stays under the blueprint's 3 s budget ──────────────
# §Execution Constraints names 3 s absolutely. The scan is registry globs plus one ps
# scan, so the baseline here is `node -e ''` — if node itself is slow on this host the
# budget moves with it rather than reporting a regression that is not one.
BASE_MS="$(perf_time_ms node -e '')"
DRY_MS="$(perf_time_ms bash -c "cd '$PROJ' && HOME='$FAKE_HOME' TMPDIR='$FAKE_TMP' bash '$AI' clean")"
assert_perf "E-272.12a: ai clean dry run" "$DRY_MS" 3000 "$BASE_MS" 30 1500

# ── E-346 (D-109 r3): concurrent reapers ──────────────────────────────────────
# Every `ai sync` reaps dead ~/.ai-os/run/ records, and four CI lanes share one HOME. A record
# another reaper moved between this one's scan and its move is gone, not failed: four racing
# over 300 dead build records all exit 0 and move each exactly once. Before, the losers
# reported "already exists in today's trash" / ENOENT and exited 2 (reliably at this size).
RACE_HOME="$(test_tmpdir clean-race)"
mkdir -p "$RACE_HOME/.ai-os/run"
for i in $(seq 1 300); do printf '{"pid":999999%d}' "$i" > "$RACE_HOME/.ai-os/run/build-$i.json"; done
for k in 1 2 3 4; do
  ( HOME="$RACE_HOME" node "${REPO_ROOT}/src/shared/ai-clean.mjs" apply --only dead-build-record --json \
      > "$RACE_HOME/out$k" 2>&1; echo $? > "$RACE_HOME/rc$k" ) &
done
wait
RACE="$(node -e 'const fs=require("fs");let m=0,f=0,rc=[];for(const k of [1,2,3,4]){rc.push(fs.readFileSync(process.argv[1]+"/rc"+k,"utf8").trim());
  try{const j=JSON.parse(fs.readFileSync(process.argv[1]+"/out"+k,"utf8"));m+=j.moved.length;f+=j.failures.length}catch{f=-1}}
  console.log(`rc=${rc.join(",")} moved=${m} failures=${f}`)' "$RACE_HOME")"
assert_contains "E-346.R1: four concurrent reapers all exit 0, each record moved once, no failures" \
  "rc=0,0,0,0 moved=300 failures=0" "$RACE"
# E-352 (D-112 r6): each reaper read today's manifest, appended its own moves and wrote it back,
# so the last writer won and the other moves had no manifest entry (no --restore for them).
_entries="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' \
  "$RACE_HOME/.ai-os/trash/$(date -u +%Y-%m-%d)/manifest.json" 2>&1)"
assert_contains "E-352.01: …and today's manifest keeps all 300 entries" "entries=300" "entries=${_entries}"
assert_status 0 "E-352.02: …and no lock is left behind" \
  bash -c "! ls -d '$RACE_HOME'/.ai-os/trash/*/manifest.json.lock 2>/dev/null"

# A reaper killed while it held the lock leaves it behind; a lock older than 60 s is taken over
# and reported once, and the apply goes on.
STALE_HOME="$(test_tmpdir clean-stale)"
_sdir="$STALE_HOME/.ai-os/trash/$(date -u +%Y-%m-%d)"
mkdir -p "$STALE_HOME/.ai-os/run" "$_sdir/manifest.json.lock"
touch -d '2 minutes ago' "$_sdir/manifest.json.lock"
printf '{"pid":99999901}' > "$STALE_HOME/.ai-os/run/build-s.json"
_stale="$(HOME="$STALE_HOME" node "${REPO_ROOT}/src/shared/ai-clean.mjs" apply --only dead-build-record --json 2>&1 >/dev/null; echo "rc=$?")"
assert_contains "E-352.03: a stale lock is taken over and the apply exits 0" "rc=0" "$_stale"
_n="$(grep -c 'stale lock' <<<"$_stale")"
assert_status 0 "E-352.04: …reported once (got ${_n})" test "$_n" = 1
assert_status 0 "E-352.05: …and the move is in the manifest, the lock gone" \
  bash -c "grep -q build-s.json '$_sdir/manifest.json' && [[ ! -e '$_sdir/manifest.json.lock' ]]"

# A build record is named per server, so the same path dies again the same day (every MCP
# restart). The second reap found today's trash slot taken and FAILED — every later `ai sync`
# that day exited 1 (CI: E-212.06e2 / E-220.09a). It moves beside the first copy instead,
# never over it, and --restore puts back one copy and keeps the other.
AGAIN_HOME="$(test_tmpdir clean-again)"
mkdir -p "$AGAIN_HOME/.ai-os/run"
_again() {
  printf '{"pid":9999990%s}' "$1" > "$AGAIN_HOME/.ai-os/run/build-x-mcp.json"
  HOME="$AGAIN_HOME" node "${REPO_ROOT}/src/shared/ai-clean.mjs" apply --only dead-build-record --json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(`moved=${j.moved.length} failures=${j.failures.length}`)})'
}
_a1="$(_again 1)"; _a2="$(_again 2)"
_slots="$(find "$AGAIN_HOME/.ai-os/trash" -name 'build-x-mcp.json*' -type f | wc -l | tr -d ' ')"
assert_contains "E-346.R2: a record reaped twice in one day moves both times, no failure" \
  "1:moved=1 failures=0 2:moved=1 failures=0 slots=2" "1:${_a1} 2:${_a2} slots=${_slots}"
_r="$(HOME="$AGAIN_HOME" node "${REPO_ROOT}/src/shared/ai-clean.mjs" restore --date "$(date -u +%Y-%m-%d)" 2>&1)"
assert_contains "E-346.R2b: --restore puts one copy back" "restored ${AGAIN_HOME}/.ai-os/run/build-x-mcp.json" "$_r"
assert_contains "E-346.R2c: …and keeps the other, never overwriting" "exists again" "$_r"

assert_summary
