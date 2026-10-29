#!/usr/bin/env bash
# rein_start_test.sh — E-227 (D-059, cli-collapse.md §`rein start`): the Triad launcher.
#
# `rein start` COMPOSES one command it does not own — `rein pane <role>` (D-099 removed the
# watcher pane and `ai watch`). The
# properties worth pinning are therefore about composition: which command reaches which
# pane, in what order, and what the launcher refuses to do.
#
# Two layers, because neither alone is enough:
#   - dry-run assertions cover ordering, flags and config rejection without a tmux server;
#   - a LIVE run on a private tmux socket covers what only real tmux reveals. That layer
#     earned its keep immediately: the dry run was green while the real one could not
#     address a single pane, because tmux parses `session:window.pane` and the window name
#     is the project basename — any project with a dot in its name was unusable — and
#     because tmux rejects `@window.0` as a pane target at all.
#
# E-302 also folds in the launcher's surface (--status/--kill, doctor, docs — E-228) and the
# two env injections `rein sync` / the installer make for every pane: E-50's
# CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN and E-62's REIN_WORKSPACE.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AI="${REPO_ROOT}/src/bin/rein"

echo "── Suite: rein_start_test (E-227) ─────────────────────────────────────"

# _proj <engineer_pane> <architect_pane> [start.json] → project dir
# E-255: every fixture carries the headless tester, as the v4 template does — the layout
# assertions below must hold with it present, not only in a two-role project.
_proj() {
  local d; d="$(mktemp -d)"; mkdir -p "$d/.ai"
  cat > "$d/.ai/roles.json" <<EOF
{ "roles": { "engineer":  { "provider": "claude", "pane_identifier": "$1" },
             "architect": { "provider": "claude", "pane_identifier": "$2" },
             "tester":    { "provider": "claude", "model": "sonnet", "headless": true } } }
EOF
  [[ -n "${3:-}" ]] && printf '%s' "$3" > "$d/.ai/start.json"
  printf '%s' "$d"
}
_dry() { ( cd "$1" && shift && bash "$AI" start --dry-run "$@" 2>&1 ); }

# E-384 (D-135 addendum 2, harness rule 1): `rein start` — dry run included — needs tmux to
# plan panes; without it it prints the manual recipe (E-227.7). A host without tmux (the
# macOS runner image) records ONE skip per section instead of failing each assertion.
if skip_unless_cmd tmux "E-227.01–02, E-269.S: rein start --dry-run plans tmux panes"; then
  # ── E-227.1: pane order follows pane_identifier, in BOTH directions ─────────
  # The role with the lower pane_identifier takes the lower pane position, so E-209's
  # ordinal fallback and the visible layout agree by construction rather than by luck.
  _p="$(_proj 0 1)"; _out="$(_dry "$_p")"
  assert_match "E-227.01a: engineer=0 → first pane" \
    'send-keys -t pane0 ai.\ pane.\ engineer' "$_out"
  assert_match "E-227.01b: architect=1 → second pane" \
    'send-keys -t pane1 ai.\ pane.\ architect' "$_out"
  # D-099 (E-322): no watcher pane — two panes, the right column is never split again.
  assert_not_contains "E-227.01c: no third pane is addressed" "pane2" "$_out"
  assert_not_contains "E-227.01g: no watcher command is sent" "ai watch" "$_out"
  assert_not_contains "E-227.01h: the right column is not split for a watcher" "split-window -v" "$_out"
  rm -rf "$_p"

  _p="$(_proj 1 0)"; _out="$(_dry "$_p")"
  assert_match "E-227.01d: REVERSED — architect=0 → first pane" \
    'send-keys -t pane0 ai.\ pane.\ architect' "$_out"
  assert_match "E-227.01e: REVERSED — engineer=1 → second pane" \
    'send-keys -t pane1 ai.\ pane.\ engineer' "$_out"
  assert_match "E-227.01f: titles are pinned in the same order" \
    'select-pane -t pane0 -T architect' "$_out"
  # E-269 (D-073): the role binding is a TARGETED pane option, set before the cosmetic title.
  assert_match "E-269.S1: the re-pin sets @rein_role on the targeted pane" \
    'set-option -p -t pane0 @rein_role architect' "$_out"
  assert_match "E-269.S2: and on the second pane" 'set-option -p -t pane1 @rein_role engineer' "$_out"
  assert_status 1 "E-269.S3: no untargeted select-pane -T remains" \
    bash -c "printf '%s\n' \"\$1\" | grep -E 'select-pane -T'" _ "$_out"
  rm -rf "$_p"

  # ── E-227.2: composition only — never a provider, never a project script ───
  _p="$(_proj 0 1)"; _out="$(_dry "$_p")"
  # Tightened by E-242: the intent is "rein start COMPOSES `rein pane`, it never execs a provider
  # itself". Testing that by the bare substring `claude` also matches the DIRECTORY `.claude/`,
  # which the overlay pre-check legitimately names — so the assertion failed on a path, not on
  # a launch. Match an invocation instead: the provider in command position.
  assert_status 1 "E-227.02a: no provider binary is launched directly" \
    bash -c "printf '%s' \"\$_out\" | grep -qE '(^|[;&|]|send-keys .)[[:space:]]*claude[[:space:]]'"
  # The dry run prints commands through `printf %q`, so the sent string appears as
  # `ai\ pane\ engineer`. An assertion written against a literal space silently matched
  # nothing and passed for the wrong reason.
  assert_status 0 "E-227.02b: every send-keys carries only 'rein pane'" \
    python3 -c "
import re, sys
sent = [l for l in sys.argv[1].splitlines() if 'send-keys' in l]
sys.exit(0 if sent and all(re.search(r'rein\\\\? pane', l) for l in sent) else 1)
" "$_out"
  rm -rf "$_p"
fi

# ── E-227.3: --no-watch is gone with the watcher (D-099) ───────────────────
_p="$(_proj 0 1)"
_nw="$( cd "$_p" && bash "$AI" start --dry-run --no-watch 2>&1 )"; _nwrc=$?
assert_status 0 "E-227.03a: --no-watch is now an unknown option (exit 2, rc=${_nwrc})" test "$_nwrc" -eq 2
assert_contains "E-227.03b: …and the error names it" "unknown option '--no-watch'" "$_nw"
for _verb in watch handoff; do
  _vo="$( cd "$_p" && bash "$AI" "$_verb" engineer hi 2>&1 )"; _vrc=$?
  assert_status 0 "E-322.C1: 'rein ${_verb}' is gone — a non-zero exit (rc=${_vrc})" test "$_vrc" -ne 0
  assert_not_contains "E-322.C2: …and it emits no handoff" "HANDOFF" "$_vo"
done
rm -rf "$_p"

# ── E-227.4: .ai/start.json is an EXEC SURFACE, so it is validated, not sanitised ─
# Every value becomes a tmux argument and the file is Architect-writable, which the E-208
# audit established is attacker-adjacent input. Anything outside the blueprint's shapes is
# refused outright.
while IFS='|' read -r label json; do
  [[ -z "$label" ]] && continue
  _p="$(_proj 0 1 "$json")"
  _out="$(_dry "$_p")"; _rc=$?
  assert_status 0 "E-227.04 rejected ($label)" bash -c "[[ $_rc -eq 2 ]]"
  assert_contains "E-227.04 says why ($label)" "start.json rejected" "$_out"
  rm -rf "$_p"
done <<'CASES'
session with a space|{"session":"has space"}
command substitution in session|{"session":"$(touch /tmp/pwn)"}
unblueprinted layout|{"layout":"quad"}
non-boolean watch|{"watch":"yes"}
out-of-range size|{"sizes":{"main":0}}
string size|{"sizes":{"main":"50"}}
unknown key|{"unknown":1}
account outside the name shape (E-315)|{"account":"Work"}
malformed JSON|not json
non-object top level|[]
CASES

# A VALID config must still be honoured, or the validation is just a wall.
if skip_unless_cmd tmux "E-227.04v–y: a valid start.json reaches the tmux plan"; then
_p="$(_proj 0 1 '{"session":"proj","sizes":{"main":40,"top":70}}')"
_out="$(_dry "$_p")"
assert_contains "E-227.04v: a valid session is used"      "-s proj" "$_out"
# The size, in the modern spelling. tmux 3.4 rejects the deprecated `-p N` with
# "size missing", so `-l N%` is what is emitted now; `-p` survives only as a runtime
# fallback for tmux older than 3.1 and never appears in a dry run.
assert_contains "E-227.04w: a valid main size is applied" "-l 60%" "$_out"
# D-099: `watch` and `sizes.top` configured the removed watcher; a file written before it
# still carries them, so they are accepted and ignored rather than stopping `rein start`.
_w="$(_dry "$(_proj 0 1 '{"watch":false,"sizes":{"top":70}}')")"
assert_contains "E-227.04x: a legacy watch/sizes.top start.json is still accepted" "split-window -h" "$_w"
assert_not_contains "E-227.04y: …and adds no watcher pane" "split-window -v" "$_w"
fi
rm -rf "$_p"

# ── E-227.5: refusals ──────────────────────────────────────────────────────
_d="$(mktemp -d)"
( cd "$_d" && bash "$AI" start --dry-run >/dev/null 2>&1 )
assert_status 0 "E-227.05a: outside a Rein project → exit 2" bash -c "[[ $? -eq 2 ]]"
rm -rf "$_d"
_p="$(_proj 0 1)"
( cd "$_p" && bash "$AI" start --bogus >/dev/null 2>&1 )
assert_status 0 "E-227.05b: unknown option → exit 2" bash -c "[[ $? -eq 2 ]]"
rm -rf "$_p"

# ── E-227.6: LIVE tmux — the layer that caught the targeting bugs ──────────
if command -v tmux >/dev/null 2>&1; then
  # E-240 (D-063 §2): the socket is registered for cleanup BEFORE it is created, and its
  # name carries the sweepable test prefix. The old form set the trap AFTER creating the
  # server and used `$$`, so a mid-suite failure leaked it and a recycled PID later
  # attached to the leftover — 50 servers accumulated that way.
  _tb="$(command -v tmux)"
  _sock="$(test_tmux_socket e227)"
  _shim="$(mktemp -d)"
  printf '#!/usr/bin/env bash\nexec %s -L %s "$@"\n' "$_tb" "$_sock" > "$_shim/tmux"
  chmod +x "$_shim/tmux"
  _lp="$(_proj 0 1)"
  # Keep `rein start`'s own output. Discarding it meant that when only one pane appeared on
  # CI, the suite could say the pane count was wrong but not what the launcher had said
  # about it — which is the only thing that explains a tmux-version difference.
  _startout="$( cd "$_lp" && PATH="$_shim:$PATH" bash "$AI" start --detach 2>&1 )"

  _win="$(basename "$_lp")"
  # Resolve by ID — the window name is the project basename and mktemp names contain a
  # dot, which is exactly the target ambiguity this suite exists to keep closed.
  # E-252 (D-068): the project now gets its OWN session, named after it — this lookup used
  # to hard-code `-t rein`, which is the shared session that no longer exists by default.
  _sess="$(awk '/^_start_session_name\(\) \{/,/^\}$/' "$AI" > "$_shim/fn.sh"; ( . "$_shim/fn.sh"; _start_session_name "$_lp" ))"
  _wid="$("$_tb" -L "$_sock" list-windows -t "$_sess" -F '#{window_id} #{window_name}' 2>/dev/null \
          | awk -v n="$_win" '$2 == n { print $1; exit }')"
  assert_status 0 "E-227.06a: the project window exists" bash -c "[[ -n '$_wid' ]]"

  # Carry the tmux version and the raw listing into the labels. When this failed on CI
  # it reported only "expected to contain: 3" — which does not distinguish "two panes were
  # created" from "list-panes returned nothing", and those have completely different causes.
  _tmuxv="$("$_tb" -V 2>&1 | head -1)"
  _panes="$("$_tb" -L "$_sock" list-panes -t "$_wid" -F '#{pane_index} #{pane_id}' 2>/dev/null | sort -n | awk '{print $2}')"
  _npanes="$(printf '%s\n' "$_panes" | grep -c .)"
  _wins="$("$_tb" -L "$_sock" list-windows -a -F '#{session_name}:#{window_id}:#{window_name}' 2>&1 | tr '\n' ' ')"
  assert_contains "E-227.06b: two panes were created, no watcher pane (${_tmuxv}; wid=${_wid}; panes=[${_panes//$'\n'/,}]; windows=[${_wins}]; start said: ${_startout//$'\n'/ | })" \
    "2" "$_npanes"

  assert_status 1 "E-322.L1: rein start takes no watcher lock in the project" test -e "${_lp}/.ai/.ai-watch.lock"
  assert_status 1 "E-322.L1b: …and writes no signal queue" test -e "${_lp}/.ai/signal.json"
  _titles="$("$_tb" -L "$_sock" list-panes -t "$_wid" -F '#{pane_title}' 2>/dev/null | tr '\n' ' ')"
  assert_contains "E-227.06c: pane 0 titled engineer"  "engineer"  "$_titles"
  assert_contains "E-227.06d: pane 1 titled architect" "architect" "$_titles"

  # Each pane received ITS command — the composition property, verified against real tmux.
  _i=0
  for _want in "rein pane engineer" "rein pane architect"; do
    _pid="$(printf '%s\n' "$_panes" | sed -n "$((_i + 1))p")"
    # Polled: send-keys returns before the pane's shell has echoed the line, so a capture
    # taken at once intermittently sees an empty screen (1 of ~5 full runs).
    _as_recv() {
      # -J joins wrapped lines. The panes are ~40 columns, so a long prompt (macOS bash 3.2's
      # under `rein ci run`) wrapped "rein pane engineer" across two lines and the match missed it.
      # -S - reads from the start of the scrollback, in case a long startup line scrolled
      # the typed command off the visible screen before this capture.
      _body="$("$_tb" -L "$_sock" capture-pane -p -J -S - -t "$_pid" 2>/dev/null || true)"
      [[ "$_body" == *"$_want"* ]]
    }
    wait_for _as_recv 2000 50 || true
    assert_contains "E-227.06e: pane ${_i} received '${_want}'" "$_want" "$_body"
    _i=$((_i + 1))
  done

  # Idempotent: a re-run must not duplicate panes.
  # NON-VACUITY: on CI this passed while comparing 0 panes to 0 panes — "unchanged" is
  # trivially true when nothing was ever created, so the idempotence claim was empty.
  # Pin that there were panes to begin with before comparing counts.
  _before="$_npanes"
  assert_status 0 "E-227.06f-pre: there were panes to duplicate (guards 06f)" \
    bash -c "[[ '$_before' -gt 0 ]]"
  ( cd "$_lp" && PATH="$_shim:$PATH" bash "$AI" start --detach >/dev/null 2>&1 )
  _after="$("$_tb" -L "$_sock" list-panes -t "$_wid" 2>/dev/null | grep -c .)"
  assert_contains "E-227.06f: a re-run does not duplicate panes (before=${_before} after=${_after})" \
    "$_before" "$_after"

  "$_tb" -L "$_sock" kill-server 2>/dev/null
  rm -rf "$_shim" "$_lp"
else
  # E-236: a missing tmux is a SKIP, not a pass. Recording nine passes for a layer that
  # never ran is how a suite reports all-green while testing less than it claims — the
  # totals now say "skipped" so the gap is visible in the run.
  for _n in a b c d e0 e1 e2 f f-pre; do
    _skip "E-227.06${_n}: live tmux layer (tmux not installed)"
  done
fi


# ── E-252 (D-068): one tmux session per project ────────────────────────────
#
# `rein start` used to put every project into ONE shared `rein` session. A tmux session has
# a single CURRENT WINDOW shared by every attached client, so starting project B flipped
# the terminal showing project A; and the project window was found by NAME ONLY, so two
# checkouts with the same basename shared one window.
#
# THE STAMP IS THE IDENTITY, THE NAME IS A LABEL: a session carries REIN_PROJECT and is
# discovered by it, so a suffixed name is still found and a foreign session that merely
# shares a name is never adopted.

# The derivation is a PURE function, so it is driven directly rather than through a live
# server — the cases that matter (a dot, a leading dash, non-ASCII, over-length) are
# exactly the ones that are awkward to create as real directories on every platform.
_sname_direct() {
  # `rein` is a command script, not a library: sourcing it runs main. The function is
  # extracted and run in a subshell instead — which also keeps this honest about testing
  # the SHIPPED definition rather than a copy of it drifting in the test file.
  awk '/^_start_session_name\(\) \{/,/^\}$/' "$AI" > "${_E252_FN:?}"
  ( set -u; REIN_SHARED_SESSION="${REIN_SHARED_SESSION:-0}"; . "${_E252_FN}"; _start_session_name "$1" "${2:-}" )
}
_E252_FN="$(test_tmpdir e252)/fn.sh"

assert_contains "E-252.01a: a dot in the project name becomes a dash (tmux parses session:window.pane)" \
  "my-app" "$(_sname_direct /tmp/my.app)"
assert_contains "E-252.01b: a leading dash is stripped (tmux would read it as a flag)" \
  "weird" "$(_sname_direct /tmp/-weird)"
# Non-ASCII: the exact output matters less than the guarantee — whatever comes out is a
# legal tmux session name, because the rewrite is a WHITELIST rather than a blocklist.
_uber="$(_sname_direct /tmp/über)"
assert_status 0 "E-252.01c: a non-ASCII name yields a legal tmux name ('${_uber}')" \
  bash -c "printf '%s' '${_uber}' | grep -qE '^[A-Za-z0-9_][A-Za-z0-9_-]*$'"
_long="$(_sname_direct "/tmp/$(printf 'a%.0s' $(seq 1 40))")"
assert_contains "E-252.01d: a 40-character name is truncated to 32" "32" "${#_long}"
assert_contains "E-252.01e: an explicit start.json session wins verbatim" \
  "pinned" "$(_sname_direct /tmp/my.app pinned)"
assert_contains "E-252.01f: REIN_SHARED_SESSION=1 restores the single shared session" \
  "rein" "$(REIN_SHARED_SESSION=1 _sname_direct /tmp/my.app)"

# The dry run shows the two commands that make a session a project's own.
if skip_unless_cmd tmux "E-252.02: the dry run's session commands"; then
_p="$(_proj 0 1)"
_out="$(_dry "$_p")"
_derived="$(_sname_direct "$_p")"
assert_contains "E-252.02a: --dry-run creates the DERIVED session, not 'rein'" \
  "new-session -d -s ${_derived}" "$_out"
assert_contains "E-252.02b: and stamps it with the project path" \
  "set-environment -t ${_derived} REIN_PROJECT" "$_out"
assert_status 1 "E-252.02c: select-window is no longer composed (it moves OTHER clients)" \
  bash -c "printf '%s' \"\$_out\" | grep -q 'select-window'"
rm -rf "$_p"
fi

# ── E-252 LIVE: the properties that only a real server can show ────────────
if skip_unless_cmd tmux "E-252 live session-isolation layer"; then
  _tb2="$(command -v tmux)"
  _sock2="$(test_tmux_socket e252)"
  _shim2="$(mktemp -d)"
  register_cleanup "rm -rf '${_shim2}'"
  printf '#!/usr/bin/env bash\nexec %s -L %s "$@"\n' "$_tb2" "$_sock2" > "$_shim2/tmux"
  chmod +x "$_shim2/tmux"
  _t2() { "$_tb2" -L "$_sock2" "$@"; }
  _start2() { ( cd "$1" && PATH="$_shim2:$PATH" bash "$AI" start --detach 2>&1 ); }

  # TWO PROJECTS → TWO SESSIONS. The headline property.
  _pA="$(_proj 0 1)"; _pB="$(_proj 0 1)"
  _outA="$(_start2 "$_pA")"; _outB="$(_start2 "$_pB")"
  _sA="$(_sname_direct "$_pA")"; _sB="$(_sname_direct "$_pB")"
  _sessions="$(_t2 list-sessions -F '#{session_name}' 2>/dev/null | tr '\n' ' ')"
  assert_contains "E-252.03a: project A has its own session (${_sessions})" "$_sA" "$_sessions"
  assert_contains "E-252.03b: project B has its own session" "$_sB" "$_sessions"
  assert_status 1 "E-252.03c: and neither landed in the shared 'rein' session" \
    bash -c "_t2() { '$_tb2' -L '$_sock2' \"\$@\"; }; _t2 has-session -t rein 2>/dev/null"

  # THE STAMP is what makes them findable. Asserted directly, because everything below
  # (reuse, --status, --kill) is a consequence of it.
  assert_contains "E-252.03d: A's session is stamped with A's physical path" \
    "$(cd "$_pA" && pwd -P)" "$(_t2 show-environment -t "$_sA" REIN_PROJECT 2>/dev/null)"

  # REUSE goes through the stamp, so a re-run does not create a second session.
  _nbefore="$(_t2 list-sessions 2>/dev/null | grep -c .)"
  _start2 "$_pA" >/dev/null 2>&1
  _nafter="$(_t2 list-sessions 2>/dev/null | grep -c .)"
  assert_status 0 "E-252.03e-pre: there were sessions to duplicate (guards 03e)" \
    bash -c "[[ '$_nbefore' -ge 2 ]]"
  assert_contains "E-252.03e: a re-run reuses the stamped session (before=${_nbefore} after=${_nafter})" \
    "$_nbefore" "$_nafter"

  # THE ORIGINAL COMPLAINT: starting B must not move the terminal showing A. With separate
  # sessions that is structural rather than careful — a session's current window cannot be
  # changed by an operation on a different session — so what is asserted is the structure:
  # A's session still exists, still holds its own window, and B's start touched neither.
  _aWinBefore="$(_t2 display-message -p -t "$_sA" '#{window_id}' 2>/dev/null || true)"
  _start2 "$_pB" >/dev/null 2>&1
  _aWinAfter="$(_t2 display-message -p -t "$_sA" '#{window_id}' 2>/dev/null || true)"
  assert_status 0 "E-252.03f-pre: A had a current window to lose (guards 03f)" \
    bash -c "[[ -n '${_aWinBefore}' ]]"
  assert_contains "E-252.03f: starting B leaves A's current window alone (${_aWinBefore}→${_aWinAfter})" \
    "$_aWinBefore" "$_aWinAfter"

  # --status and --kill find the session BY STAMP and say how they found it.
  _st="$( cd "$_pA" && PATH="$_shim2:$PATH" bash "$AI" start --status 2>&1 )"
  assert_contains "E-252.04a: --status names the owned session" "$_sA" "$_st"
  # E-315: the account column, read from the @rein_account option the re-pin sets.
  assert_match "E-315.S07: --status prints an account column per pane" 'engineer +default ' "$_st"
  assert_contains "E-252.04b: and reports how it was found" "[owned]" "$_st"

  # A FOREIGN SESSION with the same name is never adopted — it is suffixed around.
  # This is the security property: reuse requires stamp equality, not a name match.
  _pC="$(_proj 0 1)"
  _sC="$(_sname_direct "$_pC")"
  _t2 kill-session -t "$_sC" 2>/dev/null || true
  _t2 new-session -d -s "$_sC" 2>/dev/null   # unstamped: someone else's session
  _outC="$(_start2 "$_pC")"
  _foundC="$(_t2 list-sessions -F '#{session_name}' 2>/dev/null \
             | while IFS= read -r _s; do
                 [[ "$(_t2 show-environment -t "$_s" REIN_PROJECT 2>/dev/null | sed -n 's/^REIN_PROJECT=//p')" == "$(cd "$_pC" && pwd -P)" ]] && printf '%s' "$_s"
               done)"
  assert_status 0 "E-252.05a: a foreign same-name session is NOT adopted (got '${_foundC}')" \
    bash -c "[[ -n '${_foundC}' && '${_foundC}' != '${_sC}' ]]"
  assert_match "E-252.05b: the new name carries a path-derived suffix" \
    "^${_sC:0:25}-[0-9a-f]{6}$" "${_foundC}"
  # The suffix is DERIVED FROM THE PATH, so the same project gets the same name next time —
  # a random suffix would strand the previous session on every run.
  _start2 "$_pC" >/dev/null 2>&1
  _nC="$(_t2 list-sessions -F '#{session_name}' 2>/dev/null | grep -c "^${_sC:0:25}-")"
  assert_contains "E-252.05c: and is stable across runs (one suffixed session, not two)" "1" "$_nC"

  # LEGACY ADOPTION: a pre-D-068 window in the shared session is reused IN PLACE, and the
  # operator is told how to migrate. Without this, an upgrade tears down a live layout.
  _pL="$(_proj 0 1)"
  _pLp="$(cd "$_pL" && pwd -P)"
  _t2 new-session -d -s rein -n "$(basename "$_pLp")" -c "$_pLp"
  _wL_before="$(_t2 list-windows -t rein 2>/dev/null | grep -c .)"
  _outL="$(_start2 "$_pL")"
  _wL_after="$(_t2 list-windows -t rein 2>/dev/null | grep -c .)"
  assert_contains "E-252.06a: the legacy window is adopted, not duplicated (${_wL_before}→${_wL_after})" \
    "$_wL_before" "$_wL_after"
  assert_contains "E-252.06b: and the migration path is printed once" "reusing legacy shared window" "$_outL"
  assert_contains "E-252.06c: naming the session it would move to" "rein start --kill" "$_outL"

  _t2 kill-server 2>/dev/null || true
  rm -rf "$_pA" "$_pB" "$_pC" "$_pL"
fi

# ── E-227.7: non-tmux hosts get the manual recipe, not a stack trace ───────
_p="$(_proj 0 1)"
# A PATH that still has coreutils but NOT tmux. The previous version hard-coded
# `PATH=/usr/bin:/bin` with the comment "tmux lives in /opt/homebrew/bin here" — true on
# macOS, false on Linux, where tmux IS /usr/bin/tmux. So on CI this experiment left tmux
# on the PATH and tested nothing at all, while asserting it had. Derive the PATH by
# REMOVING whichever directories actually provide tmux, then verify the condition holds
# before relying on it — an experiment that can silently stop being the experiment is
# worse than no test.
# Removing the whole directory that provides tmux is not an option on Linux, where tmux is
# /usr/bin/tmux — dropping /usr/bin takes python3, basename and the rest with it, and the
# script died with 127 for the wrong reason (my first attempt did exactly that). Instead,
# for each PATH entry that provides tmux, substitute a symlink FARM of that directory with
# tmux alone omitted. Everything else stays reachable and only tmux disappears.
_farmroot="$(mktemp -d)"
_notmux=""
_fi=0
while IFS= read -r _d; do
  [[ -z "$_d" || ! -d "$_d" ]] && continue
  if [[ -x "${_d}/tmux" ]]; then
    _fi=$((_fi + 1))
    _farm="${_farmroot}/f${_fi}"; mkdir -p "$_farm"
    for _f in "$_d"/*; do
      _b="${_f##*/}"
      [[ "$_b" == "tmux" ]] && continue
      [[ -e "${_farm}/${_b}" ]] && continue
      ln -s "$_f" "${_farm}/${_b}" 2>/dev/null || true
    done
    _notmux="${_notmux}${_farm}:"
  else
    _notmux="${_notmux}${_d}:"
  fi
done < <(printf '%s\n' "$PATH" | tr ':' '\n')
_notmux="${_notmux%:}"
# `command` is a shell BUILTIN, so `env PATH=... command -v tmux` asks env to exec a
# binary called `command`. macOS happens to ship /usr/bin/command and Linux does not, so
# that spelling returned 127 on CI and the guard failed for its own reasons. Run it inside
# a shell instead.
assert_status 1 "E-227.07pre: the no-tmux PATH really has no tmux (guards the experiment)" \
  bash -c "PATH='$_notmux' command -v tmux"
assert_status 0 "E-227.07pre2: but coreutils are still reachable (guards the guard)" \
  bash -c "PATH='$_notmux' command -v python3 >/dev/null && PATH='$_notmux' command -v basename >/dev/null"
_out="$( cd "$_p" && PATH="$_notmux" bash "$AI" start 2>&1 )"; _rc=$?
assert_status 0 "E-227.07a: no tmux → exit 2 (rc=$_rc)" bash -c "[[ $_rc -eq 2 ]]"
assert_contains "E-227.07b: the recipe names rein pane engineer"  "rein pane engineer"  "$_out"
assert_contains "E-227.07c: the recipe names rein pane architect" "rein pane architect" "$_out"
assert_not_contains "E-227.07d: the recipe no longer names ai watch (D-099)" "ai watch" "$_out"
# ── E-315 (D-095, accounts.md §2): binding a project to a Claude account ─────────────
# Own HOME holding the registry (one account, work). Writes run on the no-tmux PATH, so the
# launch stops at the tmux check (exit 2) after the binding — nothing reaches a tmux server.
_ah="$(test_tmpdir startacct)"
tc_fixture_home "$_ah"   # E-345 (D-109 r1): the toolchain record the hooks pin
mkdir -p "${_ah}/.rein" "${_ah}/.claude-work"; chmod 700 "${_ah}/.claude-work"
HOME="$_ah" python3 -I "${REPO_ROOT}/src/shared/accounts.py" add "${_ah}/.rein/accounts.json" \
  "$_ah" work "${_ah}/.claude-work" 2026-10-14 >/dev/null
_ast() {  # <proj> <PATH> <args…> → output + "RC:<n>", stdin not a TTY
  local d="$1" p="$2"; shift 2
  ( cd "$d" && env -u CLAUDE_CONFIG_DIR HOME="$_ah" PATH="$p" bash "$AI" start "$@" </dev/null 2>&1; echo "RC:$?" )
}
_p="$(_proj 0 1 '{"session":"keep","sizes":{"main":40}}')"
cp "$_p/.ai/start.json" "$_p/.ai/start.json.before"
_out="$(_ast "$_p" "$PATH" --account work --dry-run)"
assert_status 0 "E-315.S01a: --dry-run --account leaves start.json byte-identical" \
  cmp -s "$_p/.ai/start.json" "$_p/.ai/start.json.before"
assert_contains "E-315.S01b: …and says what it would bind" "would bind account 'work'" "$_out"
assert_contains "E-315.S01c: the banner names the account and its dir" "account work (~/.claude-work)" "$_out"
if skip_unless_cmd tmux "E-315.S01d–e: the account in the planned tmux panes"; then
  assert_contains "E-315.S01d: the pane option carries the account" "@rein_account work" "$_out"
  assert_contains "E-315.S01e: the title reads <role> · <account>" '-T engineer\ ·\ work' "$_out"
fi

_out="$(_ast "$_p" "$_notmux" --account work)"
assert_contains "E-315.S02a: --account work writes the key" '"account": "work"' "$(cat "$_p/.ai/start.json")"
assert_contains "E-315.S02b: …keeping every other key" '"session": "keep"' "$(cat "$_p/.ai/start.json")"
assert_contains "E-315.S02c: …and the launch continues (to the tmux check)" "RC:2" "$_out"

_ast "$_p" "$_notmux" --account default >/dev/null
assert_not_contains "E-315.S03a: --account default removes the key" '"account"' "$(cat "$_p/.ai/start.json")"
assert_contains "E-315.S03b: …and keeps the rest" '"main": 40' "$(cat "$_p/.ai/start.json")"

cp "$_p/.ai/start.json" "$_p/.ai/start.json.before"
_out="$(_ast "$_p" "$_notmux" --account nope)"
assert_contains "E-315.S04a: an unregistered --account exits 2" "RC:2" "$_out"
assert_contains "E-315.S04b: …naming rein account add" "rein account add nope" "$_out"
assert_status 0 "E-315.S04c: …and writes nothing" cmp -s "$_p/.ai/start.json" "$_p/.ai/start.json.before"
printf '{"account":"nope"}' > "$_p/.ai/start.json"
_out="$(_ast "$_p" "$PATH" --dry-run)"
assert_contains "E-315.S04d: an unregistered name in start.json is rejected like an unknown key" \
  "start.json rejected — account 'nope' is not registered" "$_out"
rm -rf "$_p"

_p="$(_proj 0 1)"
_out="$(_ast "$_p" "$_notmux")"
assert_contains "E-315.S05a: no key + no TTY → default with one notice line" "using default" "$_out"
assert_status 1 "E-315.S05b: …and nothing is written" test -e "$_p/.ai/start.json"

# The pick on a real TTY (python pty): option 2 is the first registered account.
_out="$(cd "$_p" && env -u CLAUDE_CONFIG_DIR HOME="$_ah" PATH="$_notmux" python3 -c '
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", sys.argv[1], "start"])
os.write(fd, b"2\n")
out = b""
while True:
    try:
        b = os.read(fd, 4096)
    except OSError:
        break
    if not b:
        break
    out += b
os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf-8", "replace"))
' "$AI" 2>&1)"
assert_contains "E-315.S06a: a TTY start lists default first" "1) default" "$_out"
assert_contains "E-315.S06b: …then the registered accounts" "2) work" "$_out"
assert_contains "E-315.S06c: …and writes the choice" '"account": "work"' "$(cat "$_p/.ai/start.json" 2>/dev/null)"
rm -rf "$_p"

rm -rf "$_farmroot"
rm -rf "$_p"


# ── E-228 (from ai_start_surface_test — E-302): --status, --kill, doctor line, docs ──
# --kill is DESTRUCTIVE, so the assertions are weighted toward refusing rather than acting.
# With no TTY there is no prompt to answer, and "no answer" must never read as consent.
_sf_proj() {  # → a project dir with two roles
  local d; d="$(mktemp -d)"; mkdir -p "$d/.ai"
  cat > "$d/.ai/roles.json" <<'JSON'
{ "roles": { "engineer":  {"provider":"claude","pane_identifier":"0"},
             "architect": {"provider":"claude","pane_identifier":"1"} } }
JSON
  printf '%s' "$d"
}

# A tmux shim bound to a socket with NO SERVER on it. The "nothing is running" cases below
# must test exactly that, and they cannot be left to the ambient host: on a developer
# machine a tmux server is usually already up, so those assertions passed locally while
# `rein start --status` was exiting 1 and printing nothing on CI, which has no server. A test
# whose subject depends on whether the machine happens to be running tmux is not a test of
# the code.
_nosrv_shim() {  # → dir containing a `tmux` that talks to an empty socket
  local dir; dir="$(mktemp -d)"
  printf '#!/usr/bin/env bash\nexec %s -L rein-nosrv-%s "$@"\n' "$(command -v tmux)" "$$" > "${dir}/tmux"
  chmod +x "${dir}/tmux"
  printf '%s' "$dir"
}

# ── E-228.1: the flags are parsed and documented ───────────────────────────
_help="$(bash "$AI" start --help 2>&1)"
assert_contains "E-228.01a: --help documents --status" "--status" "$_help"
assert_contains "E-228.01b: --help documents --kill"   "--kill"   "$_help"
assert_contains "E-228.01c: --help says --kill asks first" "unless --yes" "$_help"

_p="$(_sf_proj)"
( cd "$_p" && bash "$AI" start --status --kill >/dev/null 2>&1 )
assert_status 0 "E-228.01d: --status and --kill together are refused (exit 2)" \
  bash -c "[[ $? -eq 2 ]]"
rm -rf "$_p"

# ── E-228.2: --status reports, and answers 0 when nothing runs ─────────────
# "Nothing is up" is a true answer to a status question. A non-zero exit would force every
# caller to write `|| true`, which is how a status command stops being usable in scripts.
_p="$(_sf_proj)"
_said="not running"
if command -v tmux >/dev/null 2>&1; then
  _ns="$(_nosrv_shim)"
  _out="$( cd "$_p" && PATH="$_ns:$PATH" bash "$AI" start --status 2>&1 )"; _rc=$?
  rm -rf "$_ns"
else
  _out="$( cd "$_p" && bash "$AI" start --status 2>&1 )"; _rc=$?
  _said="tmux is not installed"   # E-384: the no-tmux answer (src/bin/rein _start_status)
fi
assert_status 0 "E-228.02a: --status exits 0 when nothing is running (rc=${_rc})" bash -c "[[ $_rc -eq 0 ]]"
assert_contains "E-228.02b: it says so rather than printing nothing" "$_said" "$_out"
assert_not_contains "E-228.02c: and reports no watcher (D-099 removed it)" "watcher" "$_out"
rm -rf "$_p"

# ── E-228.3: LIVE tmux — status sees real panes, kill removes them ─────────
if command -v tmux >/dev/null 2>&1; then
  # E-240 (D-063 §2): the socket is registered for cleanup BEFORE it is created, and its
  # name carries the sweepable test prefix. The old form set the trap AFTER creating the
  # server and used `$$`, so a mid-suite failure leaked it and a recycled PID later
  # attached to the leftover — 50 servers accumulated that way.
  _tb="$(command -v tmux)"
  _sock="$(test_tmux_socket e228)"
  _shim="$(mktemp -d)"
  printf '#!/usr/bin/env bash\nexec %s -L %s "$@"\n' "$_tb" "$_sock" > "$_shim/tmux"
  chmod +x "$_shim/tmux"
  _lp="$(_sf_proj)"
  ( cd "$_lp" && PATH="$_shim:$PATH" bash "$AI" start --detach >/dev/null 2>&1 )

  _st="$( cd "$_lp" && PATH="$_shim:$PATH" bash "$AI" start --status 2>&1 )"
  assert_contains "E-228.03a: --status names the engineer pane"  "engineer"  "$_st"
  assert_contains "E-228.03b: --status names the architect pane" "architect" "$_st"
  assert_not_contains "E-228.03c: --status prints no watcher line" "watcher" "$_st"

  # THE SAFETY CASE. stdin is /dev/null here, exactly as in a pipeline or a hook.
  _ko="$( cd "$_lp" && PATH="$_shim:$PATH" bash "$AI" start --kill </dev/null 2>&1 )"; _krc=$?
  assert_status 0 "E-228.03d: --kill without --yes and without a TTY REFUSES (exit 2)" \
    bash -c "[[ $_krc -eq 2 ]]"
  assert_contains "E-228.03e: and says why" "without --yes" "$_ko"
  # NON-VACUITY: the refusal must have actually preserved the window, not merely printed.
  _still="$("$_tb" -L "$_sock" list-windows -a 2>/dev/null | grep -c .)"
  assert_status 0 "E-228.03f: the window SURVIVED the refused kill (windows=${_still})" \
    bash -c "[[ '${_still:-0}' -ge 1 ]]"

  # --dry-run states the plan and changes nothing.
  _sf_dry="$( cd "$_lp" && PATH="$_shim:$PATH" bash "$AI" start --kill --dry-run </dev/null 2>&1 )"
  assert_contains "E-228.03g: --kill --dry-run names kill-window" "kill-window" "$_sf_dry"
  _still2="$("$_tb" -L "$_sock" list-windows -a 2>/dev/null | grep -c .)"
  assert_status 0 "E-228.03h: dry run changed nothing (windows=${_still2})" \
    bash -c "[[ '${_still2:-0}' -eq '${_still:-0}' ]]"

  # --yes is the explicit consent, and it must actually tear down.
  _kill="$( cd "$_lp" && PATH="$_shim:$PATH" bash "$AI" start --kill --yes </dev/null 2>&1 )"
  assert_contains "E-228.03i: --kill --yes reports the window killed" "killed" "$_kill"
  # `grep -c` PRINTS the count and exits 1 when it is zero, so a `|| printf 0` fallback
  # appends a SECOND zero and the value becomes "0\n0" — which then fails an integer test
  # while the label reads "windows=0". The exit code is not the answer here; the count is.
  _gone="$("$_tb" -L "$_sock" list-windows -a 2>/dev/null | grep -c .)"
  assert_status 0 "E-228.03j: the window is actually gone (windows=${_gone})" \
    bash -c "[[ '${_gone:-1}' -eq 0 ]]"

  "$_tb" -L "$_sock" kill-server 2>/dev/null
  rm -rf "$_shim" "$_lp"
else
  # E-236: SKIP, not a fabricated pass — see tests/lib/assert.sh.
  for _n in a b c d e f g h i j; do
    _skip "E-228.03${_n}: live tmux layer (tmux not installed)"
  done
fi

# ── E-228.4: --kill with nothing to kill is a no-op, not an error ──────────
_p="$(_sf_proj)"
if command -v tmux >/dev/null 2>&1; then
  _ns="$(_nosrv_shim)"
  _out="$( cd "$_p" && PATH="$_ns:$PATH" bash "$AI" start --kill --yes </dev/null 2>&1 )"; _rc=$?
  rm -rf "$_ns"
  assert_status 0 "E-228.04a: --kill on an idle project exits 0 (rc=${_rc})" bash -c "[[ $_rc -eq 0 ]]"
  assert_contains "E-228.04b: and says there was nothing to do" "nothing to tear down" "$_out"
else
  _skip "E-228.04a: --kill on an idle project (no tmux)"
  _skip "E-228.04b: nothing-to-do message (no tmux)"
fi
rm -rf "$_p"

# ── E-228.5: doctor reports launcher readiness ────────────────────────────
_doc="$(cd "$REPO_ROOT" && bash "$AI" doctor 2>&1)"
assert_contains "E-228.05a: doctor has a Triad launcher section" "Triad launcher" "$_doc"
assert_contains "E-228.05b: it reports tmux"   "tmux" "$_doc"
assert_contains "E-228.05c: it reports roles"  "roles mapped" "$_doc"
# Each role's provider is checked against PATH: a missing provider yields a pane that
# opens and then fails at the first keystroke, which reads as a launcher bug.
assert_contains "E-228.05d: and each role's provider" "engineer →" "$_doc"

# ── E-228.6: the docs point at the launcher, and keep the fallback ────────
assert_status 0 "E-228.06a: README documents rein start"        grep -q '^rein start$' "${REPO_ROOT}/README.md"
assert_status 0 "E-228.06b: README documents --status"        grep -q 'rein start --status' "${REPO_ROOT}/README.md"
assert_status 0 "E-228.06c: README documents --kill"          grep -q 'rein start --kill' "${REPO_ROOT}/README.md"
# The manual recipe must SURVIVE: hosts without tmux still need it, and `rein start` exits 2
# and prints it. Replacing the docs with "just run rein start" would strand those users.
assert_status 0 "E-228.06d: README keeps the manual fallback" \
  grep -q 'Manual fallback' "${REPO_ROOT}/README.md"
# E-252 (D-068): the recipe is now PER PROJECT. It used to read `tmux new-session -s
# rein` — a single shared session, which is the arrangement D-068 removed because one
# session has one current window shared by every attached client. The assertion follows the
# recipe rather than pinning the old literal, and checks BOTH halves: the recipe still
# exists (tmux-less hosts depend on it) and it no longer hands every project one session.
assert_status 0 "E-228.06e: README still shows a manual tmux recipe" \
  grep -q 'tmux new-session -s' "${REPO_ROOT}/README.md"
assert_status 0 "E-252.07a: and the recipe is per-project, not one shared session" \
  grep -q 'tmux new-session -s "\$(basename "\$PWD")"' "${REPO_ROOT}/README.md"
assert_status 1 "E-252.07b: the shared 'rein' session name is gone from the recipe" \
  grep -q 'new-session -s rein' "${REPO_ROOT}/README.md"
assert_status 0 "E-228.06f: CONTRIBUTING points at rein start" \
  grep -q 'rein start' "${REPO_ROOT}/CONTRIBUTING.md"
# E-256 (D-069): the manual recipe binds each pane through `rein pane <role>`, as `rein start`
# does. It used to send a bare one-word CLI name to each pane, which launches an UNBOUND
# session: no role token, no model, no permission overlay — the recipe that tmux-less hosts
# depend on would have produced a Triad with no roles in it.
_recipe="$(sed -n '/Manual fallback/,/<\/details>/p' "${REPO_ROOT}/README.md")"
assert_contains "E-256.01a: the recipe binds the Engineer pane" "rein pane engineer" "$_recipe"
assert_contains "E-256.01b: the recipe binds the Architect pane" "rein pane architect" "$_recipe"
# D-099 (E-323): the watcher is removed — the recipe is two panes and must not start it.
assert_not_contains "E-256.01c: the recipe does not start the removed watcher" "ai watch" "$_recipe"
assert_status 1 "E-256.01d: no pane is sent a bare CLI name" \
  bash -c "printf '%s\n' \"\$1\" | grep -qE \"send-keys( -t [0-9]+)? '[a-z]+'\"" _ "$_recipe"
assert_status 0 "E-256.01e: ai --help lists rein start and rein pane" \
  bash -c "'$AI' --help | grep -q '^  rein start' && '$AI' --help | grep -q '^  rein pane'"

# ── E-228.7: init/sync surface the launcher ───────────────────────────────
assert_status 0 "E-228.07a: rein init prints an 'rein start' hint" \
  grep -q 'Or let the launcher do it:  rein start' "$AI"
assert_status 0 "E-228.07b: the sync tail hints too, only when tmux exists" \
  grep -q "Tip: 'rein start' opens the Triad layout" "$AI"

echo ""

# ── E-50 (from alternate_screen_env_test — E-302): CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 ──
# propagates through bin/rein _configure_project_claude_settings (.claude/settings.json env)
# and install-rein.sh (shell rc files) without clobbering pre-existing user values.
# ── T-ALT-S01: bin/rein injects the env into project settings.json ──────────────
echo ""
echo "  [T-ALT-S01] bin/rein injects via _configure_project_claude_settings"

assert_status 0 "bin/rein sets CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" \
  grep -q 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN' "${REPO_ROOT}/src/bin/rein"

# Use setdefault so user-set values are preserved across `rein sync` runs.
assert_status 0 "bin/rein uses setdefault (preserves user override)" \
  grep -qE 'env.setdefault\(\s*["\x27]CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN' "${REPO_ROOT}/src/bin/rein"

# ── T-ALT-S02: Active .claude/settings.json carries the flag ─────────────────
echo ""
echo "  [T-ALT-S02] Active .claude/settings.json reflects the pin"

# E-290: .claude/settings.json is generated (gitignored) — read the one `rein sync` writes.
source "${SCRIPT_DIR}/../lib/generated-settings.sh"
_GEN_DIR="$(mktemp -d)"; on_exit "rm -rf '$_GEN_DIR'"
GEN_SETTINGS="$(gen_project_settings "$_GEN_DIR/proj")"
if [[ -f "$GEN_SETTINGS" ]]; then
  assert_status 0 "settings.json env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1'" \
    node --input-type=module <<JS
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync('${GEN_SETTINGS}', 'utf8'));
if (s?.env?.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN !== '1') process.exit(1);
JS
else
  _fail "T-ALT-S02: rein sync did not generate .claude/settings.json"
fi

# ── T-ALT-S03: install-rein.sh exports the env via shell rc ─────────────────
echo ""
echo "  [T-ALT-S03] install-rein.sh writes shell rc export"

ALT_INSTALL="${REPO_ROOT}/install-rein.sh"
assert_status 0 "install script defines ensure_env_line helper" \
  grep -q 'ensure_env_line()' "$ALT_INSTALL"

assert_status 0 "ensure_env_line is invoked for the new var" \
  grep -qE 'ensure_env_line[[:space:]]+\".*\"[[:space:]]+\"CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN\"' "$ALT_INSTALL"

assert_status 0 "ensure_env_line writes to .zprofile" \
  grep -q '\.zprofile.*CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN' "$ALT_INSTALL"

assert_status 0 "ensure_env_line writes to .zshrc" \
  grep -q '\.zshrc.*CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN' "$ALT_INSTALL"

assert_status 0 "ensure_env_line writes to .bashrc" \
  grep -q '\.bashrc.*CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN' "$ALT_INSTALL"

# ── T-ALT-S04: ensure_env_line is idempotent + non-clobbering ────────────────
echo ""
echo "  [T-ALT-S04] ensure_env_line idempotency + override preservation"

# Sandbox: extract just the helper from install-rein.sh, source it, drive it
# against a temp rc file, and assert behaviour matches the spec.
ALT_SANDBOX="$(mktemp -d -t alt-screen-XXXXXX)"
on_exit 'rm -rf "$ALT_SANDBOX"'
cat > "${ALT_SANDBOX}/helper.sh" <<'HELPER'
ensure_env_line() {
  local rc="$1" var="$2" value="$3"
  local line="export ${var}=\"${value}\""
  [[ -f "$rc" ]] || touch "$rc"
  if ! grep -qE "^export[[:space:]]+${var}=" "$rc" 2>/dev/null; then
    printf "%s\n" "$line" >> "$rc"
    echo "added"
  else
    echo "kept"
  fi
}
HELPER
source "${ALT_SANDBOX}/helper.sh"

RC="${ALT_SANDBOX}/fake.rc"
> "$RC"

# First run → adds the line.
RES1="$(ensure_env_line "$RC" "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" "1")"
assert_status 0 "first run reports added"        bash -c "[[ '$RES1' == 'added' ]]"
assert_status 0 "rc now exports the var"          grep -q 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN="1"' "$RC"

# Second run → no-op.
RES2="$(ensure_env_line "$RC" "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" "1")"
assert_status 0 "second run is idempotent"        bash -c "[[ '$RES2' == 'kept' ]]"
LINES="$(grep -c 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN' "$RC")"
assert_status 0 "no duplicate lines"              bash -c "[[ '$LINES' == '1' ]]"

# Pre-existing user override is respected (different value).
echo 'export CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN="0"' > "$RC"
RES3="$(ensure_env_line "$RC" "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" "1")"
assert_status 0 "user override is preserved"      bash -c "[[ '$RES3' == 'kept' ]]"
assert_status 0 "value still '0' (not clobbered)" grep -q 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN="0"' "$RC"

# ── E-62 (from rein_workspace_env_test — E-302): REIN_WORKSPACE injection ──
# install-rein.sh persists the workspace to config/rein-workspace.txt; bin/rein resolves
# env > persisted file > "" and threads it into settings.json env via setdefault.
# ── T-WS-S01: bin/rein defines _resolve_rein_workspace ──────────────────────────
echo ""
echo "  [T-WS-S01] bin/rein exposes _resolve_rein_workspace helper"

assert_status 0 "bin/rein defines _resolve_rein_workspace()" \
  grep -q '^_resolve_rein_workspace()' "${REPO_ROOT}/src/bin/rein"

# Order: env first, then persisted file, then empty.
assert_status 0 "resolver reads \$REIN_WORKSPACE first" \
  grep -q 'REIN_WORKSPACE:-' "${REPO_ROOT}/src/bin/rein"

assert_status 0 "resolver falls back to config/rein-workspace.txt" \
  grep -q 'rein-workspace.txt' "${REPO_ROOT}/src/bin/rein"

# ── T-WS-S02: _configure_project_claude_settings propagates REIN_WORKSPACE ───
echo ""
echo "  [T-WS-S02] settings.json env carries REIN_WORKSPACE via setdefault"

assert_status 0 "bin/rein uses setdefault for REIN_WORKSPACE (preserves override)" \
  grep -qE 'env\.setdefault\(\s*["\x27]REIN_WORKSPACE' "${REPO_ROOT}/src/bin/rein"

assert_status 0 "bin/rein threads REIN_WORKSPACE through to python heredoc" \
  grep -q 'REIN_WORKSPACE="\${REIN_WORKSPACE_VALUE}" python3' "${REPO_ROOT}/src/bin/rein"

WS_INSTALL="${REPO_ROOT}/install-rein.sh"
# ── T-WS-S03 (E-304, D-089 r2): the installer NO LONGER exports REIN_WORKSPACE from profiles ──
# The persisted ~/.rein/config/rein-workspace.txt is the record; an exported copy in a profile
# outlived reinstalls and pointed `rein sync` at a working tree (2026-10-04).
echo "  [T-WS-S03] install-rein.sh writes no REIN_WORKSPACE export; offers to remove old ones"
assert_status 1 "install never invokes ensure_env_line for REIN_WORKSPACE (E-304)" \
  grep -qE 'ensure_env_line[[:space:]]+".*"[[:space:]]+"REIN_WORKSPACE"' "$WS_INSTALL"
assert_status 0 "install offers to remove an earlier export (y/N, terminal only)" \
  grep -q 'Remove the REIN_WORKSPACE export an earlier install added' "$WS_INSTALL"
assert_status 0 "…and only lines of the exact shape it used to write" \
  grep -qF "'^export REIN_WORKSPACE=\"[^\"]*\"\$'" "$WS_INSTALL"
assert_status 0 "…never without a terminal or under CI" \
  grep -qE '\[\[ -t 0 && -z "\$\{CI:-\}" && -z "\$\{REIN_CI:-\}" \]\]' "$WS_INSTALL"

assert_status 0 "install writes config/rein-workspace.txt" \
  grep -q 'rein-workspace.txt' "$WS_INSTALL"

assert_status 0 "install creates \${REIN}/config dir before write" \
  grep -qE 'mkdir -p[[:space:]]+"\$\{REIN\}/config"' "$WS_INSTALL"

# Functional check: live install (if present) should have the file.
if [[ -f "${HOME}/.rein/config/rein-workspace.txt" ]]; then
  PERSISTED="$(head -n 1 "${HOME}/.rein/config/rein-workspace.txt" | tr -d '\n')"
  assert_status 0 "persisted rein-workspace.txt is non-empty" \
    bash -c "[[ -n '${PERSISTED}' ]]"
  assert_status 0 "persisted path resolves to a directory" \
    bash -c "[[ -d '${PERSISTED}' ]]"
else
  echo "  ⚠ ~/.rein/config/rein-workspace.txt absent — install hasn't run since E-62; skipping live checks"
fi

# ── T-WS-S05: _resolve_rein_workspace behavioural test (sandbox) ─────────────
echo ""
echo "  [T-WS-S05] _resolve_rein_workspace honours env > file > empty"

WS_SANDBOX="$(mktemp -d -t rein-ws-XXXXXX)"
on_exit 'rm -rf "$WS_SANDBOX"'

# Extract just the function to keep the sandbox hermetic.
cat > "${WS_SANDBOX}/helper.sh" <<'HELPER'
REIN="${REIN_DIR}"
_resolve_rein_workspace() {
  if [[ -n "${REIN_WORKSPACE:-}" ]]; then
    printf "%s" "${REIN_WORKSPACE}"
    return 0
  fi
  local persisted="${REIN}/config/rein-workspace.txt"
  if [[ -f "$persisted" ]]; then
    head -n 1 "$persisted" 2>/dev/null | tr -d '\n'
    return 0
  fi
  printf ""
}
HELPER

# (a) env wins
REIN_DIR="${WS_SANDBOX}" REIN_WORKSPACE="/from/env" \
  bash -c "source ${WS_SANDBOX}/helper.sh; _resolve_rein_workspace" \
  > "${WS_SANDBOX}/out_env" 2>&1
assert_status 0 "env value wins" \
  bash -c "[[ \"\$(cat ${WS_SANDBOX}/out_env)\" == '/from/env' ]]"

# (b) file fallback when env unset
mkdir -p "${WS_SANDBOX}/config"
echo "/from/file" > "${WS_SANDBOX}/config/rein-workspace.txt"
unset REIN_WORKSPACE
REIN_DIR="${WS_SANDBOX}" \
  bash -c "unset REIN_WORKSPACE; source ${WS_SANDBOX}/helper.sh; _resolve_rein_workspace" \
  > "${WS_SANDBOX}/out_file" 2>&1
assert_status 0 "persisted file used when env unset" \
  bash -c "[[ \"\$(cat ${WS_SANDBOX}/out_file)\" == '/from/file' ]]"

# (c) empty when neither
rm -f "${WS_SANDBOX}/config/rein-workspace.txt"
REIN_DIR="${WS_SANDBOX}" \
  bash -c "unset REIN_WORKSPACE; source ${WS_SANDBOX}/helper.sh; _resolve_rein_workspace" \
  > "${WS_SANDBOX}/out_none" 2>&1
assert_status 0 "empty string when neither source present" \
  bash -c "[[ \"\$(cat ${WS_SANDBOX}/out_none)\" == '' ]]"

assert_summary
