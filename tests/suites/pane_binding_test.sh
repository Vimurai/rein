#!/usr/bin/env bash
# pane_binding_test.sh — E-208 (D-054, role-abstraction.md §Same-Provider Triad):
# per-pane role binding. Covers the `rein pane <role>` launcher, the per-role settings
# overlay, the launch-time role reaching the SessionStart mint, and the Write/Edit
# sovereignty gate that makes §35 ANTI-DRIFT enforced rather than merely prompted.
#
# No tmux required: the launcher is exercised through its resolution helper and its
# argument validation, and the gate is driven with synthetic PreToolUse payloads.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AI_BIN="${REPO_ROOT}/src/bin/rein"
HOOK="${REPO_ROOT}/hooks/pre-tool-use.sh"
SS_HOOK="${REPO_ROOT}/hooks/session-start.sh"
SAFE_EXEC="${REPO_ROOT}/src/mcp/safe-exec-mcp/index.js"
# E-216 split the Architect scope/write policy into its own module (index.js passed
# the 1000-line standards limit); the scope notes moved with it.
ARCH_WRITES="${REPO_ROOT}/src/mcp/safe-exec-mcp/architect-writes.mjs"
ADAPTER="${REPO_ROOT}/src/shared/provider-adapter.mjs"
AS="${REPO_ROOT}/tests/lib/as-session.sh"
LR="${REPO_ROOT}/src/shared/launch-record.py"

# E-294 (D-087): the role comes from a launch record + a token bound to the session process —
# never from REIN_PANE_ROLE / REIN_CALLER_ROLE. Every hook, mint and `rein pane` run below uses
# this throwaway HOME (rule 6) whose ~/.rein/{shared,mcp} are this checkout's src/, so the
# install-first locator answers with the code under test, and no launch record or token on the
# operator's own machine (or process chain) can reach a verdict. Sessions come from as-session.sh.
PB_HOME="$(test_tmpdir pbhome)"
mkdir -p "${PB_HOME}/.rein"
tc_link_shared "$PB_HOME"   # E-345 (D-109 r1): mirror = this tree + the toolchain record the hooks pin
ln -s "${REPO_ROOT}/src/mcp" "${PB_HOME}/.rein/mcp"
PB_RUN="${PB_HOME}/.rein/run"

echo "── Suite: pane_binding_test (E-208) ─────────────────────────────────"

# ── E-208.1: `rein pane` argument contract ─────────────────────────────────────
assert_status 0 "E-208.01a: 'rein pane --help' prints usage" \
  bash -c "bash '$AI_BIN' pane --help | grep -q 'Usage: rein pane'"
assert_status 2 "E-208.01b: unknown role exits 2" \
  bash -c "bash '$AI_BIN' pane bogus 2>/dev/null"
assert_contains "E-208.01c: unknown role names the valid roles" "architect | engineer" \
  "$(bash "$AI_BIN" pane bogus 2>&1)"
assert_status 0 "E-208.01d: 'pane' is wired into the CLI dispatch table" \
  grep -qE '^\s*pane\)\s+do_pane' "$AI_BIN"

# ── E-208.2: role → provider → argv resolution (shared module, E-210 reuse) ──
# The launcher and advisor-mcp MUST resolve through the SAME module so the bridge
# and the pane binding can never disagree about which provider owns a role.
assert_status 0 "E-208.02a: launcher resolves through the shared resolve-launch seam" \
  grep -q '_locate_resolve_launch' "$AI_BIN"
assert_status 0 "E-208.02a2: the seam imports the same adapter advisor-mcp uses" \
  grep -q 'from "./provider-adapter.mjs"' "${REPO_ROOT}/src/shared/resolve-launch.mjs"

# Drive the SAME seam do_pane uses (src/shared/resolve-launch.mjs), not a
# reimplementation — otherwise the launcher and these assertions can drift apart
# without any test failing (E-208 critic_tests P2).
RESOLVER="${REPO_ROOT}/src/shared/resolve-launch.mjs"
_resolve() {  # <role> <aidir> → newline argv flattened to a single quoted string
  node --no-warnings "$RESOLVER" "$1" "$2" 2>/dev/null | tr '\n' '|'
}

TMP_AI="$(mktemp -d)/.ai"; mkdir -p "$TMP_AI"
cp "${REPO_ROOT}/src/templates/providers.json" "$TMP_AI/providers.json"
cat > "$TMP_AI/roles.json" <<'JSON'
{ "roles": {
    "architect": { "provider": "claude", "pane_identifier": "1", "model": "claude-opus-5" },
    "engineer":  { "provider": "claude", "pane_identifier": "0" } } }
JSON

assert_contains "E-208.02b: architect resolves to its own settings overlay" \
  ".claude/settings.architect.json" "$(_resolve architect "$TMP_AI")"
assert_contains "E-208.02c: architect gets ARCHITECT.md appended (else it boots ENGINEER — G1)" \
  "ARCHITECT.md" "$(_resolve architect "$TMP_AI")"
assert_contains "E-208.02d: engineer gets ENGINEER.md appended" \
  "ENGINEER.md" "$(_resolve engineer "$TMP_AI")"
assert_contains "E-208.02e: per-role model is forwarded when configured" \
  "--model|claude-opus-5" "$(_resolve architect "$TMP_AI")"
assert_not_contains "E-208.02f: no dangling --model when the role has none" \
  '--model' "$(_resolve engineer "$TMP_AI")"

# An architect bound to another provider (neutral 'acme', no adapter entry) must NOT get
# claude's flags — proves the argv is adapter-driven, not hardcoded to claude.
cat > "$TMP_AI/roles.json.acme" <<'JSON'
{ "roles": { "architect": { "provider": "acme", "pane_identifier": "1" } } }
JSON
mv "$TMP_AI/roles.json" "$TMP_AI/roles.json.claude"
mv "$TMP_AI/roles.json.acme" "$TMP_AI/roles.json"
assert_contains "E-208.02g: acme-bound architect resolves to the acme provider" \
  "acme" "$(_resolve architect "$TMP_AI")"
assert_not_contains "E-208.02h: acme-bound architect gets no claude launch flags" \
  "settings.architect.json" "$(_resolve architect "$TMP_AI")"
mv "$TMP_AI/roles.json.claude" "$TMP_AI/roles.json"

# ── E-288 (D-079): every Triad session is named '<project basename> · <Role>' ──
# The remote app lists sessions by display name; unnamed, the two panes are
# indistinguishable. TMP_AI's project root is its parent temp dir.
E288_BASE="$(basename "$(dirname "$TMP_AI")")"
# assert.sh has no equality helper; exact match, reported with both values on failure.
_e288_eq() {  # <label> <expected> <actual>
  assert_status 0 "$1" test "$2" = "$3"
  [[ "$2" == "$3" ]] || echo "      expected: [$2]  actual: [$3]"
}
assert_contains "E-288.01a: architect argv carries --name '<basename> · Architect'" \
  "|--name|${E288_BASE} · Architect" "|$(_resolve architect "$TMP_AI")"
assert_contains "E-288.01b: engineer argv carries --name '<basename> · Engineer'" \
  "|--name|${E288_BASE} · Engineer" "|$(_resolve engineer "$TMP_AI")"
_e288_eq "E-288.01c: the template path emits --name exactly once" "1" \
  "$(_resolve architect "$TMP_AI" | tr '|' '\n' | grep -cx -- '--name')"

# A project whose providers.json predates {session_name} (e.g. a downstream clone)
# still gets the name — the resolver injects it (E-242 precedent).
E288_STALE="$(mktemp -d)/stale-proj"; mkdir -p "$E288_STALE/.ai"
cp "$TMP_AI/roles.json" "$E288_STALE/.ai/roles.json"
sed 's/, "--name", "{session_name}"//' "${REPO_ROOT}/src/templates/providers.json" > "$E288_STALE/.ai/providers.json"
assert_status 1 "E-288.02a: the stale fixture really lacks {session_name}" \
  grep -q 'session_name' "$E288_STALE/.ai/providers.json"
assert_contains "E-288.02b: a stale providers.json still resolves with --name (injection)" \
  "|--name|stale-proj · Architect" "|$(_resolve architect "$E288_STALE/.ai")"
_e288_eq "E-288.02c: the injection adds the flag once, not twice" "1" \
  "$(_resolve architect "$E288_STALE/.ai" | tr '|' '\n' | grep -cx -- '--name')"
# Everything else in the argv is byte-identical to the pre-E-288 resolution.
_e288_eq "E-288.02d: the non-name argv is unchanged between template and injection paths" \
  "$(_resolve architect "$TMP_AI" | sed "s#${E288_BASE} · Architect##; s#$(dirname "$TMP_AI")##g")" \
  "$(_resolve architect "$E288_STALE/.ai" | sed "s#stale-proj · Architect##; s#${E288_STALE}##g")"
# A non-claude provider is never injected — its flag of that spelling could mean anything.
printf '{ "providers": { "acme": { "launch": ["--flag"] } } }' > "$E288_STALE/.ai/providers.json"
echo '{ "roles": { "architect": { "provider": "acme" } } }' > "$E288_STALE/.ai/roles.json"
assert_not_contains "E-288.02e: a non-claude provider gets no injected --name" \
  "--name" "$(_resolve architect "$E288_STALE/.ai")"

# print_mode (headless Tester, advisor bridge) stays untitled.
assert_not_contains "E-288.03a: print_mode template carries no --name" "--name" \
  "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["providers"]["claude"]["print_mode"])' "${REPO_ROOT}/src/templates/providers.json")"

# `rein pane` end to end through a stub `claude` that prints its argv: the resolver's
# name is used by default, and an operator --name after `--` wins (exactly one --name).
E288_PROJ="$(mktemp -d)/pane-proj"; mkdir -p "$E288_PROJ/.ai" "$E288_PROJ/.claude"
cp "$TMP_AI/roles.json" "$E288_PROJ/.ai/roles.json"
cp "${REPO_ROOT}/src/templates/providers.json" "$E288_PROJ/.ai/providers.json"
echo '{}' > "$E288_PROJ/.claude/settings.architect.json"
E288_BIN="$(mktemp -d)"
printf '#!/usr/bin/env bash\nprintf "ARG:%%s\\n" "$@"\n' > "$E288_BIN/claude"; chmod +x "$E288_BIN/claude"
# A throwaway HOME whose install mirror is THIS checkout (PB_HOME) — otherwise the real
# install answers and the test measures whatever was last installed (E-236 environment
# dependence). It also keeps the pane — and, since E-294, its launch record — off the real
# ~/.rein. (An EMPTY HOME no longer works: `rein pane` refuses to launch without
# launch-record.py, which it locates install-first.)
E288_HOME="$PB_HOME"
_e288_pane() { (cd "$E288_PROJ" && env -u TMUX -u TMUX_PANE HOME="$E288_HOME" PATH="$E288_BIN:$PATH" bash "$AI_BIN" pane architect "$@" 2>/dev/null); }
E288_OUT="$(_e288_pane)"
assert_contains "E-288.04a: rein pane execs claude with the derived name" \
  "ARG:pane-proj · Architect" "$E288_OUT"
E288_OUT="$(_e288_pane -- --name X)"
assert_contains "E-288.04b: an operator --name after -- reaches the CLI" "ARG:X" "$E288_OUT"
assert_not_contains "E-288.04c: the derived name is dropped when the operator names the session" \
  "pane-proj · Architect" "$E288_OUT"
_e288_eq "E-288.04d: exactly one --name reaches the CLI" "1" \
  "$(printf '%s\n' "$E288_OUT" | grep -cx 'ARG:--name')"
E288_OUT="$(_e288_pane -- -n Y)"
assert_contains "E-288.04e: the short -n form also wins" "ARG:Y" "$E288_OUT"
assert_not_contains "E-288.04f: no derived --name alongside an operator -n" "ARG:--name" "$E288_OUT"

# ── E-294 (Component 8b): `rein pane` is the one writer of launch records ─────────
# The record is written for `rein pane`'s own pid immediately before exec, so the PROVIDER
# holds it (same pid, same start time) — a stub provider prints its $$ and the record dir.
E294_BIN="$(test_tmpdir pbstub)"
cat > "$E294_BIN/claude" <<'STUB'
#!/usr/bin/env bash
printf 'PID:%s\n' "$$"
for f in "$HOME"/.rein/run/launch/*.json; do printf 'REC:%s\n' "${f##*/}"; done
python3 -c 'import json,sys; print("ROLE:" + json.load(open(sys.argv[1]))["role"])' "$HOME/.rein/run/launch/$$.json" 2>/dev/null
STUB
chmod +x "$E294_BIN/claude"
E294_OUT="$(cd "$E288_PROJ" && env -u TMUX -u TMUX_PANE HOME="$PB_HOME" PATH="$E294_BIN:$PATH" bash "$AI_BIN" pane architect 2>/dev/null)"
E294_PID="$(printf '%s\n' "$E294_OUT" | sed -n 's/^PID://p')"
assert_status 0 "E-294.P01a: the provider ran under rein pane (fixture)" test -n "$E294_PID"
assert_contains "E-294.P01b: record pid == provider pid after exec" "REC:${E294_PID:-none}.json" "$E294_OUT"
assert_contains "E-294.P01c: …and that record names the bound role" "ROLE:architect" "$E294_OUT"

# Nested `rein pane` under a live record (here: an Architect session) is refused — exit 2,
# [PANE_NESTED], nothing written: a nested `rein pane engineer` would otherwise mint a less
# restricted role than the session it runs in (D-087 r1).
_nest_before="$(ls "${PB_RUN}/launch" 2>/dev/null | sort | tr '\n' ' ')"
E294_OUT="$(cd "$E288_PROJ" && HOME="$PB_HOME" bash "$AS" architect pb-nest -- \
  bash -c 'ls "$HOME/.rein/run/launch" | sort | tr "\n" " "; echo; env -u TMUX -u TMUX_PANE PATH="$1:$PATH" bash "$2" pane engineer; echo "RC:$?"; ls "$HOME/.rein/run/launch" | sort | tr "\n" " "; echo' \
  _ "$E294_BIN" "$AI_BIN" 2>&1)"
assert_contains "E-294.P02a: nested rein pane under a live record exits 2" "RC:2" "$E294_OUT"
assert_contains "E-294.P02b: …with [PANE_NESTED]" "[PANE_NESTED]" "$E294_OUT"
assert_not_contains "E-294.P02c: …and never reaches the provider" "PID:" "$E294_OUT"
_nest_in="$(printf '%s\n' "$E294_OUT" | sed -n '1p')"; _nest_after="$(printf '%s\n' "$E294_OUT" | tail -1)"
assert_status 0 "E-294.P02d: …and writes no launch record (dir unchanged: [${_nest_in}] → [${_nest_after}])" \
  test -n "$_nest_in" -a "$_nest_in" = "$_nest_after"
assert_status 0 "E-294.P02e: the session's own record is gone afterwards (fixture)" \
  test "$(ls "${PB_RUN}/launch" 2>/dev/null | sort | tr '\n' ' ')" = "$_nest_before"

# ── E-315 (D-095, accounts.md §3): `rein pane` launches under the project's account ──
# Extends the E-288/E-294 stub-provider rows: the stub prints the CLAUDE_CONFIG_DIR it was
# exec'd with. Own HOME (install mirror = this checkout, like PB_HOME) holding the registry.
AC_HOME="$(test_tmpdir pbacct)"
mkdir -p "${AC_HOME}/.rein" "${AC_HOME}/.claude-work"; chmod 700 "${AC_HOME}/.claude-work"
tc_link_shared "$AC_HOME"   # E-345 (D-109 r1): mirror = this tree + the toolchain record the hooks pin
ln -s "${REPO_ROOT}/src/mcp" "${AC_HOME}/.rein/mcp"
echo '{}' > "${AC_HOME}/.claude-work/settings.json"
HOME="$AC_HOME" python3 -I "${REPO_ROOT}/src/shared/accounts.py" add "${AC_HOME}/.rein/accounts.json" \
  "$AC_HOME" work "${AC_HOME}/.claude-work" 2026-10-14 >/dev/null
AC_PROJ="$(test_tmpdir pbacctproj)"; mkdir -p "$AC_PROJ/.ai" "$AC_PROJ/.claude"
cp "$E288_PROJ/.ai/roles.json" "$E288_PROJ/.ai/providers.json" "$AC_PROJ/.ai/"
echo '{}' > "$AC_PROJ/.claude/settings.architect.json"; echo '{}' > "$AC_PROJ/.claude/settings.engineer.json"
AC_BIN="$(test_tmpdir pbacctbin)"
printf '#!/usr/bin/env bash\necho "CCD:${CLAUDE_CONFIG_DIR:-<unset>}"\n' > "$AC_BIN/claude"; chmod +x "$AC_BIN/claude"
_ac_pane() {  # <role> → output + "RC:<n>"
  (cd "$AC_PROJ" && env -u TMUX -u TMUX_PANE -u CLAUDE_CONFIG_DIR HOME="$AC_HOME" PATH="$AC_BIN:$PATH" \
    bash "$AI_BIN" pane "$1" 2>&1; echo "RC:$?")
}

_ac_out="$(_ac_pane engineer)"
assert_contains "E-315.P01a: no account key → the provider runs" "RC:0" "$_ac_out"
assert_contains "E-315.P01b: …with no CLAUDE_CONFIG_DIR export" "CCD:<unset>" "$_ac_out"

echo '{"session":"acct","account":"work"}' > "$AC_PROJ/.ai/start.json"
for _r in engineer architect; do
  _ac_out="$(_ac_pane "$_r")"
  assert_contains "E-315.P02 ($_r): account=work → exec carries CLAUDE_CONFIG_DIR=<dir>" \
    "CCD:${AC_HOME}/.claude-work" "$_ac_out"
done
assert_contains "E-315.P02c: an ABSENT backstop is a notice, not a refusal" "rein account sync work" "$_ac_out"

echo '{"account":"default"}' > "$AC_PROJ/.ai/start.json"
assert_contains "E-315.P03: an explicit default exports nothing" "CCD:<unset>" "$(_ac_pane engineer)"

echo '{"account":"nope"}' > "$AC_PROJ/.ai/start.json"
_ac_out="$(_ac_pane engineer)"
assert_contains "E-315.P04a: an unregistered account exits 2" "RC:2" "$_ac_out"
assert_contains "E-315.P04b: …naming rein account add" "rein account add nope" "$_ac_out"
assert_not_contains "E-315.P04c: …and never reaches the provider" "CCD:" "$_ac_out"

echo '{"account":"work"}' > "$AC_PROJ/.ai/start.json"
# E-324 (D-101): the fixture is the real D-097 paragraph — the version D-101 superseded.
python3 - "${REPO_ROOT}/.ai/DECISIONS.md" "${AC_HOME}/.claude-work/settings.json" <<'PY'
import json, re, sys
t = open(sys.argv[1], encoding="utf-8").read()
rule = re.search(r"^> ([A-Za-z][A-Za-z-]* Gate Tamper \(D-097\): .*)$", t[t.index("## D-097"):], re.M).group(1)  # D-097 as ruled, any product word
json.dump({"autoMode": {"hard_deny": ["$defaults", rule]}}, open(sys.argv[2], "w"), indent=2)
PY
assert_contains "E-324.P05f: the fixture carries the D-097 label" " Gate Tamper (D-097)" "$(cat "${AC_HOME}/.claude-work/settings.json")"
_ac_out="$(_ac_pane engineer)"
assert_contains "E-315.P05a: an OUTDATED (D-097) account backstop refuses with exit 2" "RC:2" "$_ac_out"
assert_contains "E-315.P05b: …naming rein sync" "run: rein sync" "$_ac_out"
assert_not_contains "E-315.P05c: …before the provider" "CCD:" "$_ac_out"
HOME="$AC_HOME" python3 -I "${REPO_ROOT}/src/shared/classifier-backstop.py" refresh "${AC_HOME}/.claude-work/settings.json" >/dev/null
_ac_out="$(_ac_pane engineer)"
assert_contains "E-324.P05d: after the refresh (D-101 label) the same pane launches" "CCD:${AC_HOME}/.claude-work" "$_ac_out"
assert_contains "E-324.P05e: …with exit 0" "RC:0" "$_ac_out"

rm -f "${AC_HOME}/.claude-work/settings.json"
_ac_out="$(_ac_pane engineer)"
assert_contains "E-315.P06a: a missing account settings.json refuses with exit 2" "RC:2" "$_ac_out"
assert_contains "E-315.P06b: …naming rein account sync" "rein account sync work" "$_ac_out"

mv "${AC_HOME}/.claude-work" "${AC_HOME}/.claude-work-gone"
_ac_out="$(_ac_pane engineer)"
assert_contains "E-315.P07a: a missing account directory refuses with exit 2 (never default)" "RC:2" "$_ac_out"
assert_not_contains "E-315.P07b: …and never reaches the provider" "CCD:" "$_ac_out"
mv "${AC_HOME}/.claude-work-gone" "${AC_HOME}/.claude-work"

# ── E-333 (D-102 §8): the account is per developer — .ai/start.local.json wins ─────────
# Extends the E-315 rows above: a second registered account, a committed start.json with NO
# account, and each developer's gitignored override. (P06 removed work's settings.json.)
echo '{}' > "${AC_HOME}/.claude-work/settings.json"
mkdir -p "${AC_HOME}/.claude-home"; chmod 700 "${AC_HOME}/.claude-home"; echo '{}' > "${AC_HOME}/.claude-home/settings.json"
HOME="$AC_HOME" python3 -I "${REPO_ROOT}/src/shared/accounts.py" add "${AC_HOME}/.rein/accounts.json" \
  "$AC_HOME" home "${AC_HOME}/.claude-home" 2026-10-22 >/dev/null
echo '{"session":"acct"}' > "$AC_PROJ/.ai/start.json"
echo '{"account":"work"}' > "$AC_PROJ/.ai/start.local.json"
_ac_out="$(_ac_pane engineer)"
assert_contains "E-333.P08a: committed start.json without an account + a local override → that account" \
  "CCD:${AC_HOME}/.claude-work" "$_ac_out"
# A second developer: another clone of the same commit, their own override.
AC_PROJ2="$(test_tmpdir pbacctproj2)"; cp -R "$AC_PROJ/." "$AC_PROJ2/"
echo '{"account":"home"}' > "$AC_PROJ2/.ai/start.local.json"
_ac_out2="$(cd "$AC_PROJ2" && env -u TMUX -u TMUX_PANE -u CLAUDE_CONFIG_DIR HOME="$AC_HOME" PATH="$AC_BIN:$PATH" \
  bash "$AI_BIN" pane engineer 2>&1; echo "RC:$?")"
assert_contains "E-333.P08b: a second developer's override on the same commit → their own account" \
  "CCD:${AC_HOME}/.claude-home" "$_ac_out2"
assert_contains "E-333.P08b2: …while the first still launches under theirs" "CCD:${AC_HOME}/.claude-work" "$(_ac_pane engineer)"
echo '{"account":"work"}' > "$AC_PROJ/.ai/start.json"; echo '{"account":"default"}' > "$AC_PROJ/.ai/start.local.json"
assert_contains "E-333.P08c: a local \"default\" beats a committed account" "CCD:<unset>" "$(_ac_pane engineer)"
echo '{"account":"work","session":"x"}' > "$AC_PROJ/.ai/start.local.json"
_ac_out="$(_ac_pane engineer)"
assert_contains "E-333.P08d: the local file may carry only account — anything else exits 2" "RC:2" "$_ac_out"
assert_contains "E-333.P08d2: …naming start.local.json" "start.local.json rejected" "$_ac_out"
rm -f "$AC_PROJ/.ai/start.local.json"; echo '{"session":"acct"}' > "$AC_PROJ/.ai/start.json"
_sj_before="$(cat "$AC_PROJ/.ai/start.json")"
_use="$(cd "$AC_PROJ" && HOME="$AC_HOME" bash "$AI_BIN" account use home 2>&1)"
assert_contains "E-333.P08e: rein account use writes the local file" "start.local.json" "$_use"
assert_status 0 "E-333.P08e2: …and leaves the committed start.json alone" test "$(cat "$AC_PROJ/.ai/start.json")" = "$_sj_before"
assert_contains "E-333.P08e3: …and the pane launches under it" "CCD:${AC_HOME}/.claude-home" "$(_ac_pane engineer)"
_use="$(cd "$AC_PROJ" && HOME="$AC_HOME" bash "$AI_BIN" account use nope 2>&1; echo "RC:$?")"
assert_contains "E-333.P08f: rein account use refuses an unregistered name" "RC:2" "$_use"
# A team project: rein start --account binds the developer's local file, not the committed one.
echo '{"schema":1,"planner":"a@example.com","claim_ttl_days":7,"shared_log":false,"members":{"a@example.com":{"ranges":{"E":[[1,9]]}}}}' > "$AC_PROJ/.ai/team.json"
_st="$(cd "$AC_PROJ" && HOME="$AC_HOME" bash "$AI_BIN" start --account work --dry-run 2>&1)"
assert_contains "E-333.P08g: in a team project rein start --account targets start.local.json" "would bind account 'work' in .ai/start.local.json" "$_st"
rm -f "$AC_PROJ/.ai/team.json"
_st="$(cd "$AC_PROJ" && HOME="$AC_HOME" bash "$AI_BIN" start --account work --dry-run 2>&1)"
assert_contains "E-333.P08g2: a single-operator project keeps start.json (unchanged)" "would bind account 'work' in .ai/start.json" "$_st"
rm -f "$AC_PROJ/.ai/start.local.json"; echo '{"account":"work"}' > "$AC_PROJ/.ai/start.json"
# rein init / rein sync keep the override out of git.
GI_REPO="$(test_tmpdir pbgitignore)"; git -C "$GI_REPO" init -q
bash -c "source '$AI_BIN' 2>/dev/null; _ensure_generated_gitignore '$GI_REPO'" >/dev/null 2>&1
assert_status 0 "E-333.P08h: the generated-artefact gitignore covers .ai/start.local.json" \
  git -C "$GI_REPO" check-ignore -q .ai/start.local.json

# ── E-208.3: per-role settings overlay (env only, NEVER a second hook) ───────
OV_DIR="$(mktemp -d)/.claude"; mkdir -p "$OV_DIR"
bash -c "source '$AI_BIN' 2>/dev/null; _write_role_settings_overlays '$OV_DIR' '$TMP_AI'" >/dev/null 2>&1

assert_status 0 "E-208.03a: architect overlay generated" test -f "$OV_DIR/settings.architect.json"
assert_status 0 "E-208.03b: engineer overlay generated" test -f "$OV_DIR/settings.engineer.json"
assert_contains "E-208.03c: architect overlay carries its own caller role" '"REIN_CALLER_ROLE": "architect"' \
  "$(cat "$OV_DIR/settings.architect.json")"
# CRITICAL (D-054 §Alternatives option 3): Claude Code MERGES hook arrays, so a second
# SessionStart registration here would mint two role tokens for one session id.
assert_not_contains "E-208.03d: overlay registers NO hooks (double-mint guard)" '"hooks"' \
  "$(cat "$OV_DIR/settings.architect.json")"
assert_not_contains "E-208.03e: overlay registers no SessionStart" 'SessionStart' \
  "$(cat "$OV_DIR/settings.architect.json")"

# A non-claude role gets no claude overlay.
NO_OV="$(mktemp -d)/.claude"; mkdir -p "$NO_OV"
ACME_AI="$(mktemp -d)/.ai"; mkdir -p "$ACME_AI"
echo '{ "roles": { "architect": { "provider": "acme", "pane_identifier": "1" } } }' > "$ACME_AI/roles.json"
bash -c "source '$AI_BIN' 2>/dev/null; _write_role_settings_overlays '$NO_OV' '$ACME_AI'" >/dev/null 2>&1
assert_status 1 "E-208.03f: no overlay for a role bound to a non-claude provider" \
  test -f "$NO_OV/settings.architect.json"

# ── E-208.4 → E-294: the LAUNCH RECORD reaches the SessionStart mint ─────────
# Was: "REIN_PANE_ROLE binds the session". Since E-294 (D-087 r3) the role comes from the
# launch record on the hook's process chain; REIN_PANE_ROLE and the positional role are
# ignored. _stamp writes a record (or none) for a bash process and runs the hook as its DIRECT
# child, so the hook's PPID is that process — exactly what `rein pane` + claude look like.
_stamp() {  # <record role|none> <REIN_PANE_ROLE> <positional> [sid] → the first two stamp lines
  local rec="$1" pane="$2" pos="$3" sid="${4:-e208t-$RANDOM$RANDOM}"
  ( cd "$REPO_ROOT" && HOME="$PB_HOME" bash -c '
      [ "$1" != none ] && python3 -I "$2" write $$ "$1" >/dev/null
      printf "{\"session_id\":\"%s\"}" "$3" | REIN_DISABLE_CACHE=1 REIN_PANE_ROLE="$4" bash "$5" "$6"
      rc=$?; rm -f "$HOME/.rein/run/launch/$$.json"; exit $rc' _ "$rec" "$LR" "$sid" "$pane" "$SS_HOOK" "$pos" 2>/dev/null ) \
    | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)["hookSpecificOutput"]["additionalContext"].splitlines()[:2]))' 2>/dev/null
}
assert_contains "E-208.04a: an architect launch record binds the session to architect (env says engineer)" \
  "[REIN_ROLE] architect" "$(_stamp architect engineer engineer)"
_S04="$(_stamp none architect architect)"
assert_contains "E-294.04a2: REIN_PANE_ROLE=architect + positional architect, no record → engineer (env no longer binds)" \
  "[REIN_ROLE] engineer" "$_S04"
assert_contains "E-294.04a3: …marked as an unverified (plain) launch" "[REIN_LAUNCH] unverified" "$_S04"
assert_contains "E-208.04b: plain launch still mints engineer (the plain-launch default)" "[REIN_ROLE] engineer" \
  "$(_stamp none '' engineer)"
assert_contains "E-208.04c: an unknown pane role never mints a bogus role" "[REIN_ROLE] engineer" \
  "$(_stamp none hacker hacker)"
_S04="$(_stamp engineer architect architect)"
assert_contains "E-294.04c2: an engineer launch record binds engineer whatever the env says" "[REIN_ROLE] engineer" "$_S04"
assert_not_contains "E-294.04c3: …as a recorded (not unverified) launch" "[REIN_LAUNCH] unverified" "$_S04"

# The stamp and the minted token must agree — the stamp drives the persona, the
# token drives enforcement; a mismatch would mean a pane that reads as one role and
# is gated as another.
SID_M="e208-mint-$RANDOM$RANDOM"
_S04="$(_stamp architect engineer engineer "$SID_M")"
assert_contains "E-208.04d: minted role matches the emitted stamp" '"role":"architect"' \
  "$(tr -d ' ' < "${PB_RUN}/role-${SID_M}.lock" 2>/dev/null)"
assert_contains "E-208.04d2: …and the stamp said architect" "[REIN_ROLE] architect" "$_S04"
rm -f "${PB_RUN}/role-${SID_M}.lock"

# ── E-208.5: --check-path verdicts (the enforcement primitive) ──────────────
# E-208.05a–j (the path verdicts per role) are rows of the role-verdict contract table in the unit
# layer (E-301, D-088); what stays needs the CLI argv, the message, or the fault injection.
# E-294 (D-087 r3, 8f): no verified token → the UNION, whatever a positional role word says;
# E-294.05i2 (the union blocks src/ whatever the env says) is a role-verdict row.
assert_contains "E-294.05i3: a positional role word after the path is ignored (union)" "2" \
  "$(cd "$REPO_ROOT" && HOME="$PB_HOME" node --no-warnings "$SAFE_EXEC" --check-path "$REPO_ROOT/src/bin/rein" engineer >/dev/null 2>&1; echo $?)"
assert_contains "E-294.05i4: the union block names itself [ROLE_UNVERIFIED]" "[ROLE_UNVERIFIED]" \
  "$(cd "$REPO_ROOT" && HOME="$PB_HOME" node --no-warnings "$SAFE_EXEC" --check-path "$REPO_ROOT/src/bin/rein" --session pb-no-such 2>/dev/null)"

# Fail-closed on analyzer crash — a crash must never become an allow (T-HITL-004).
( cd "$REPO_ROOT" && HOME="$PB_HOME" bash "$AS" architect pb-throw -- env REIN_SAFE_EXEC_SELFTEST_THROW=1 \
  node --no-warnings "$SAFE_EXEC" --check-path "$REPO_ROOT/.ai/ok.md" --session pb-throw >/dev/null 2>&1 )
assert_contains "E-208.05k: analyzer crash FAILS CLOSED (blocks, never allows)" "2" "$?"

# ── E-208.6: hook end-to-end — the token must beat the mutable env ──────────
# E-294: SID_A / SID_E name a ROLE now — each _gate call runs the hook as the DIRECT child of a
# real session process of that role (as-session.sh), so the hook's PPID is the token's pid: the
# --session-pid hot path, exactly as under claude.
SID_A="architect"; SID_E="engineer"
_gate() {  # <role> <tool> <pathkey> <path> → exit code
  printf '{"tool_name":"%s","tool_input":{"%s":"%s"},"session_id":"pb-g-%s"}' "$2" "$3" "$4" "$1" \
    | ( cd "$REPO_ROOT" && HOME="$PB_HOME" bash "$AS" "$1" "pb-g-$1" -- env REIN_CALLER_ROLE=engineer REIN_PANE_ROLE=engineer \
        bash "$HOOK" >/dev/null 2>&1 )
  echo $?
}
# REIN_CALLER_ROLE=engineer is exported in every call below: if the env could win,
# these would all pass. They must not — E-129's whole point.
assert_contains "E-208.06a: Write to src/ BLOCKED in an architect session" "2" \
  "$(_gate "$SID_A" Write file_path "$REPO_ROOT/src/bin/rein")"
assert_contains "E-208.06b: Edit to tests/ BLOCKED in an architect session" "2" \
  "$(_gate "$SID_A" Edit file_path "$REPO_ROOT/tests/run.sh")"
assert_contains "E-208.06c: MultiEdit BLOCKED in an architect session" "2" \
  "$(_gate "$SID_A" MultiEdit file_path "$REPO_ROOT/src/x.js")"
assert_contains "E-208.06d: NotebookEdit (notebook_path) BLOCKED in an architect session" "2" \
  "$(_gate "$SID_A" NotebookEdit notebook_path "$REPO_ROOT/src/n.ipynb")"
assert_contains "E-208.06e: Write to .ai/ ALLOWED in an architect session" "0" \
  "$(_gate "$SID_A" Write file_path "$REPO_ROOT/.ai/blueprints/new.md")"
assert_contains "E-208.06f: Read is never gated" "0" \
  "$(_gate "$SID_A" Read file_path "$REPO_ROOT/src/bin/rein")"
assert_contains "E-208.06g: engineer session — Write to src/ ALLOWED (no new restriction)" "0" \
  "$(_gate "$SID_E" Write file_path "$REPO_ROOT/src/bin/rein")"
assert_contains "E-208.06h: engineer session — Edit to tests/ ALLOWED" "0" \
  "$(_gate "$SID_E" Edit file_path "$REPO_ROOT/tests/run.sh")"

# E-291 (D-081 r2): the environment escape hatch is GONE — a project's settings `env` could
# set it. Setting it must not bypass the write gate. (The operator's escape is now the
# `rein gate off` file, covered with a fixture HOME in gate_override_test.)
_V_GATE="REIN_SAFE""_EXEC_GATE"
printf '{"tool_name":"Write","tool_input":{"file_path":"%s"},"session_id":"pb-g6i"}' "$REPO_ROOT/src/bin/rein" \
  | ( cd "$REPO_ROOT" && HOME="$PB_HOME" bash "$AS" architect pb-g6i -- env "${_V_GATE}=0" bash "$HOOK" >/dev/null 2>&1 )
assert_contains "E-208.06i: the removed env switch no longer bypasses the write gate (E-291)" "2" "$?"
# E-294 (8e): the token is bound to its session process. The SAME session id presented by a
# hook whose parent is NOT that process (one level deeper here, as a borrowing process would
# be) fails the --session-pid hot path → the union blocks, though the token is an engineer's.
printf '{"tool_name":"Write","tool_input":{"file_path":"%s"},"session_id":"pb-g6j"}' "$REPO_ROOT/src/bin/rein" \
  | ( cd "$REPO_ROOT" && HOME="$PB_HOME" bash "$AS" engineer pb-g6j -- bash -c 'bash "$1"; exit $?' _ "$HOOK" >/dev/null 2>&1 )
assert_contains "E-294.06j: an engineer token presented by a non-session parent (pid mismatch) → union, BLOCKED" "2" "$?"

# ── E-208.7: registration + rulefile clause ────────────────────────────────
assert_status 0 "E-208.07a: PreToolUse matcher covers the write tools" \
  grep -q 'Bash|Write|Edit|MultiEdit|NotebookEdit' "$AI_BIN"
assert_status 0 "E-208.07b: hook branches on the write tools" \
  grep -qE '^\s*Write\|Edit\|MultiEdit\|NotebookEdit\)' "$HOOK"
assert_status 0 "E-208.07c: ENGINEER.md carries the Role Resolution clause" \
  grep -q 'Role Resolution (D-054' "${REPO_ROOT}/src/templates/ENGINEER.md"
assert_status 0 "E-208.07d: ARCHITECT.md carries the Role Resolution clause" \
  grep -q 'Role Resolution (D-054' "${REPO_ROOT}/src/templates/ARCHITECT.md"
# E-294 (D-087 r2/r3): was "session-start prefers the launch-time pane role". The role is now
# derived inside safe-exec from the launch records; the hook reads neither REIN_PANE_ROLE nor
# its positional argument, and mints with `<sid> <its PPID>` — no role in argv.
assert_status 1 "E-294.07e: session-start no longer reads REIN_PANE_ROLE or a positional role" \
  grep -qE 'REIN_PANE_ROLE:-|\$\{1:-' "$SS_HOOK"
assert_status 0 "E-294.07f: session-start mints with <sid> <PPID>, no role word" \
  grep -qF -- '--mint-token "$_SID" "$PPID"' "$SS_HOOK"

# ── E-208.8: security-audit regressions (2026-09-05) ────────────────────────
# Each assertion below reproduces an attack that WORKED against the first cut of
# this gate. They are exploit regressions, not hypotheticals.
echo "  [E-208.8] security-audit regressions"

# (a) SYMLINK ESCAPE — E-208.08a–c are role-verdict rows (the table's fixture project plants
# the links); the hook's Write branch reaching --check-path is E-208.06 above.

# (b) RE-MINT PRIVILEGE ESCALATION (P0) — the token gates writes as of E-208, so an
# unguarded re-mint of the same session id was a full architect→engineer role swap.
# E-294: the mint takes no role (D-087 r2); the swap attempt is now a mint of the SAME session
# id from a process whose chain carries an ENGINEER record, while the Architect session that
# owns the id is still alive (mint-table row 3: bound to another live process → refuse).
_tok_role() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['role'])" "${PB_RUN}/role-$1.lock" 2>/dev/null; }
_RM_STOP="${PB_HOME}/stop-pb-remint"
( cd "$REPO_ROOT" && HOME="$PB_HOME" exec bash "$AS" architect pb-remint -- \
    bash -c 'i=0; while [ ! -e "$1" ] && [ -d "${1%/*}" ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done' _ "$_RM_STOP" ) >/dev/null 2>&1 &   # REIN_SLEEP_ALLOWED: keep-alive loop of a child session shell (no assert.sh there); ends on the stop file
_RM_PID=$!
on_exit "touch '${_RM_STOP}'; wait_for '! kill -0 ${_RM_PID} 2>/dev/null' 3000 100 2>/dev/null; kill ${_RM_PID} 2>/dev/null || true"
wait_for "[ -e \"${PB_RUN}/role-pb-remint.lock\" ]" 10000 100 || true
( cd "$REPO_ROOT" && HOME="$PB_HOME" bash -c 'python3 -I "$1" write $$ engineer >/dev/null; node --no-warnings "$2" --mint-token pb-remint $$ >/dev/null 2>&1; rm -f "$HOME/.rein/run/launch/$$.json"' _ "$LR" "$SAFE_EXEC" )
assert_contains "E-208.08d: re-minting a bound live session from an engineer chain is refused" "architect" \
  "$(_tok_role pb-remint)"
assert_contains "E-208.08e: the write stays BLOCKED after an attempted role swap (session pid hot path)" "2" \
  "$(cd "$REPO_ROOT" && HOME="$PB_HOME" node --no-warnings "$SAFE_EXEC" --check-path "$REPO_ROOT/src/bin/rein" --session pb-remint --session-pid "$_RM_PID" >/dev/null 2>&1; echo $?)"
assert_contains "E-294.08e2: …and the same check allows .ai/ (the token still verifies, as architect)" "0" \
  "$(cd "$REPO_ROOT" && HOME="$PB_HOME" node --no-warnings "$SAFE_EXEC" --check-path "$REPO_ROOT/.ai/blueprints/x.md" --session pb-remint --session-pid "$_RM_PID" >/dev/null 2>&1; echo $?)"
touch "$_RM_STOP"; wait "$_RM_PID" 2>/dev/null || true
# Same-role re-mint must still work — SessionStart re-fires on resume, clear and compact
# in the SAME process (mint-table row 2: no-op, prints the bound role) …
assert_contains "E-208.08f: same-process re-mint still succeeds (resume/clear/compact path intact)" "architect" \
  "$(cd "$REPO_ROOT" && HOME="$PB_HOME" bash "$AS" architect pb-refire -- \
       bash -c 'node --no-warnings "$1" --mint-token pb-refire "$PPID"' _ "$SAFE_EXEC" 2>/dev/null)"
# … and a resume in a NEW process re-binds a token whose process is gone (row 4), same role
# only: the dead Architect token is NOT taken over by an engineer chain.
( cd "$REPO_ROOT" && HOME="$PB_HOME" bash "$AS" architect pb-resume -- \
    cp -p "${PB_RUN}/role-pb-resume.lock" "${PB_HOME}/saved-pb-resume.lock" )
cp -p "${PB_HOME}/saved-pb-resume.lock" "${PB_RUN}/role-pb-resume.lock"
assert_contains "E-294.08f2: a dead process's architect token re-binds to a new architect session" "architect" \
  "$(cd "$REPO_ROOT" && HOME="$PB_HOME" bash "$AS" architect pb-resume -- node --no-warnings "$SAFE_EXEC" --verify-role pb-resume 2>/dev/null)"
cp -p "${PB_HOME}/saved-pb-resume.lock" "${PB_RUN}/role-pb-resume.lock"
( cd "$REPO_ROOT" && HOME="$PB_HOME" bash "$AS" engineer pb-resume -- true ) >/dev/null 2>&1
assert_contains "E-294.08f3: …but an engineer chain cannot take it over (mint refused: as-session exits 97)" "97" "$?"
# The refused mint DROPS a dead process's token (critic_security P2-2: under pid reuse the hot
# path could honour it) — so "not taken over" means: no engineer token at that path.
assert_not_contains "E-294.08f4: …and no engineer token was left at that session id" "engineer" "$(_tok_role pb-resume)"
rm -f "${PB_RUN}/role-pb-resume.lock"

# (c) ARGV CONFUSION — a target literally named "--session" hijacked the flag scan
# and dropped the check to the env fallback.
# E-294: the env fallback is gone; with no token the union applies — and inside an Architect
# session the flags after a path named "--session" still bind to the real session.
assert_contains "E-208.08g: a path named '--session' cannot hijack the flag parse (no token → union)" "2" \
  "$(cd "$REPO_ROOT" && HOME="$PB_HOME" node --no-warnings "$SAFE_EXEC" --check-path "--session" >/dev/null 2>&1; echo $?)"
assert_contains "E-294.08g2: …nor inside an Architect session" "2" \
  "$(cd "$REPO_ROOT" && HOME="$PB_HOME" bash "$AS" architect pb-hj -- node --no-warnings "$SAFE_EXEC" --check-path "--session" --session pb-hj >/dev/null 2>&1; echo $?)"

# (d) FAIL-OPEN ON NON-2 EXIT — a module that fails to LOAD exits 1, and the hook
# used to treat only 2 as a block.
assert_status 0 "E-208.08h: hook blocks on ANY non-zero check-path exit, not just 2" \
  grep -q 'W_RC" -ne 0' "$HOOK"

# (e) UNTRUSTED role key / provider name — both files are ARCHITECT-writable, so one
# feeds a path join and the other an exec target.
EVIL_AI="$(mktemp -d)/.ai"; mkdir -p "$EVIL_AI"
# Nest the output dir inside a root WE own, so the "did anything escape?" probe below
# globs a directory this test controls. Globbing the shared system temp dir two levels
# up would let an unrelated suite's stray settings.*.json fail this security assertion,
# or — worse — mask a real escape by making the check pass for the wrong reason.
EVIL_ROOT="$(mktemp -d)"
EVIL_OUT="${EVIL_ROOT}/nest/.claude"; mkdir -p "$EVIL_OUT"
cat > "$EVIL_AI/roles.json" <<'JSON'
{ "roles": { "../../escape": { "provider": "claude", "pane_identifier": "0" },
             "engineer":     { "provider": "claude", "pane_identifier": "0" } } }
JSON
bash -c "source '$AI_BIN' 2>/dev/null; _write_role_settings_overlays '$EVIL_OUT' '$EVIL_AI'" >/dev/null 2>&1
# `ls` exit codes are NOT portable: GNU coreutils returns 2 for a missing path where
# BSD/macOS returns 1, so this asserted the mac value and failed on Linux CI from the
# day it was written. `compgen -G` is a bash builtin — it returns 1 for "no match"
# everywhere, and answers the question being asked (does any such file exist?) directly
# rather than inferring it from a tool's error convention.
assert_status 1 "E-208.08i: a traversal role key writes nothing outside the target dir" \
  bash -c "compgen -G \"${EVIL_ROOT}/settings.*.json\" >/dev/null"
assert_status 0 "E-208.08j: the valid sibling role is still generated" \
  test -f "$EVIL_OUT/settings.engineer.json"
assert_status 0 "E-208.08k: launcher validates the provider name before exec" \
  grep -q "refusing to exec provider" "$AI_BIN"

# (f) SCOPE HONESTY — E-216/D-055 widened the gate to three layers, so the old
# "NARROWED, not closed" wording no longer applies. What must still hold is that the
# code names its REMAINING residual instead of claiming the channel is airtight.
assert_status 0 "E-208.08l: the scope note enumerates all three write channels" \
  grep -q "analyzeArchitectWrites" "$ARCH_WRITES"
assert_status 0 "E-208.08l2: and still states a residual rather than claiming closure" \
  grep -q "STATED RESIDUAL" "$ARCH_WRITES"
# Assert the honest statement POSITIVELY. A keyword-absence test was worse than
# useless here: it matched the word "airtight" inside the sentence that correctly says
# the channel is NOT airtight, i.e. it failed on the very wording it existed to require.
assert_status 0 "E-208.08l3: the code states plainly that the channel is not airtight" \
  grep -q "not airtight" "$ARCH_WRITES"


# ── E-208.9: do_pane error branches + _find_ai_dir walk (critic_tests P2) ────
echo "  [E-208.9] launcher error paths"
# E-294: every `rein pane` run uses PB_HOME — launch-record.py is located install-first (an
# un-installed HOME now refuses before these checks run), and the [PANE_NESTED] check must not
# see a launch record on the operator's own process chain.

# Outside a Rein project: must refuse, not launch anything.
OUTSIDE="$(mktemp -d)"
assert_status 2 "E-208.09a: refuses to bind outside a Rein project" \
  bash -c "cd '$OUTSIDE' && HOME='$PB_HOME' bash '$AI_BIN' pane architect 2>/dev/null"
assert_contains "E-208.09b: the message names the missing .ai/ and the fix" "rein init" \
  "$(cd "$OUTSIDE" && HOME="$PB_HOME" bash "$AI_BIN" pane architect 2>&1)"

# Role mapped to a provider with no launch adapter → distinct message from "unmapped".
NOLAUNCH="$(mktemp -d)"; mkdir -p "$NOLAUNCH/.ai"
echo '{ "roles": { "architect": { "provider": "ghostcli", "pane_identifier": "1" } } }' > "$NOLAUNCH/.ai/roles.json"
echo '{ "providers": { "ghostcli": { "mcp_config_path": "x", "mcp_key": "y" } } }' > "$NOLAUNCH/.ai/providers.json"
assert_status 2 "E-208.09c: a provider with no launch template exits 2" \
  bash -c "cd '$NOLAUNCH' && HOME='$PB_HOME' bash '$AI_BIN' pane architect 2>/dev/null"
assert_contains "E-208.09d: that error names 'launch', not a bogus roles.json mapping" "launch" \
  "$(cd "$NOLAUNCH" && HOME="$PB_HOME" bash "$AI_BIN" pane architect 2>&1)"

# Provider adapter present but the CLI is not installed.
NOCLI="$(mktemp -d)"; mkdir -p "$NOCLI/.ai"
echo '{ "roles": { "architect": { "provider": "ghostcli", "pane_identifier": "1" } } }' > "$NOCLI/.ai/roles.json"
printf '{ "providers": { "ghostcli": { "launch": ["--flag"], "print_mode": ["-p","{prompt}"] } } }' > "$NOCLI/.ai/providers.json"
assert_status 2 "E-208.09e: a provider CLI missing from PATH exits 2" \
  bash -c "cd '$NOCLI' && HOME='$PB_HOME' bash '$AI_BIN' pane architect 2>/dev/null"
assert_contains "E-208.09f: that error names PATH" "PATH" \
  "$(cd "$NOCLI" && HOME="$PB_HOME" bash "$AI_BIN" pane architect 2>&1)"

# An invalid provider name must never reach exec.
BADPROV="$(mktemp -d)"; mkdir -p "$BADPROV/.ai"
echo '{ "roles": { "architect": { "provider": "../../bin/sh", "pane_identifier": "1" } } }' > "$BADPROV/.ai/roles.json"
printf '{ "providers": { "../../bin/sh": { "launch": ["-c","echo pwned"] } } }' > "$BADPROV/.ai/providers.json"
assert_status 2 "E-208.09g: a path-shaped provider name is refused before exec" \
  bash -c "cd '$BADPROV' && HOME='$PB_HOME' bash '$AI_BIN' pane architect 2>/dev/null"
assert_contains "E-208.09h: refusal names the invalid provider" "refusing to exec provider" \
  "$(cd "$BADPROV" && HOME="$PB_HOME" bash "$AI_BIN" pane architect 2>&1)"

# The .ai/ ancestor walk (git-style discovery) — asserted BEHAVIOURALLY via the
# launcher, because sourcing src/bin/rein aborts partway under `set -e` and never
# defines the late helpers. Running from a nested subdirectory must resolve the
# project root, which the error message then names.
SUBDIR="$(mktemp -d)"; mkdir -p "$SUBDIR/.ai" "$SUBDIR/a/b/c"
echo '{ "roles": { "architect": { "provider": "ghostcli", "pane_identifier": "1" } } }' > "$SUBDIR/.ai/roles.json"
echo '{ "providers": { "ghostcli": { "mcp_config_path": "x", "mcp_key": "y" } } }' > "$SUBDIR/.ai/providers.json"
assert_contains "E-208.09i: ancestor walk finds the project .ai/ from a nested subdir" "$SUBDIR/.ai/providers.json" \
  "$(cd "$SUBDIR/a/b/c" && HOME="$PB_HOME" bash "$AI_BIN" pane architect 2>&1)"


# ── E-208.10: round-2 audit regressions (symlink + lexical '..') ─────────────
# The round-1 fix resolved symlinks but still collapsed `..` LEXICALLY first, and the
# two orders disagree: `normalize` is a string op, the kernel is not. With
# `.ai/d2 -> src/deep`, the string `.ai/d2/../bin/rein` collapses to `.ai/bin/rein`
# (allowed) while the kernel resolves it to `src/bin/rein`. That wrote real bytes to a
# real source file through the native Write tool.
echo "  [E-208.10] symlink + '..' regressions"

# E-208.10a–h (symlink + '..', trailing slash, the '..' class, the over-block guards and the
# engineer) are role-verdict rows.

# Scope honesty must hold at ALL THREE sites, not just the one that was pinned.
assert_status 0 "E-208.10i: the policy module names its residual (E-216 wording)" \
  grep -q "STATED RESIDUAL" "$ARCH_WRITES"
assert_status 0 "E-208.10j: the check-path CLI comment does not claim G2 is closed" \
  bash -c "! grep -q 'only closes gap G2' '$SAFE_EXEC'"
assert_status 0 "E-208.10k: the hook comment does not claim G2 is closed" \
  bash -c "! grep -q 'This closes gap G2' '$HOOK'"
assert_status 0 "E-208.10l: the hook enumerates the three layers and the residual" \
  bash -c "grep -q 'THREE layers' '$HOOK' && grep -q 'STATED RESIDUAL' '$HOOK'"
# The mint guard must not be described as immutability — it is a partial guard.
# E-294: the mint moved to role-token.mjs; its stated limitation is now the same-uid ceiling
# (T-ROLE-001) — removing a pane's record and token returns it to the plain-launch default.
assert_status 0 "E-208.10m: mint refusal does not over-claim immutability" \
  bash -c "! grep -q \"role is immutable for its lifetime\" '$SAFE_EXEC' '${REPO_ROOT}/src/mcp/safe-exec-mcp/role-token.mjs'"
assert_status 0 "E-294.10n: the mint states its own limitation (same-uid ceiling, T-ROLE-001)" \
  grep -q "Same-uid ceiling" "${REPO_ROOT}/src/mcp/safe-exec-mcp/role-token.mjs"


# ── E-208.11: hardlink blind spot (round-3 audit) ───────────────────────────
# A hardlink is not a REFERENCE to a file, it IS the file under a second equally
# canonical name — realpath has nothing to see through, and every path-based check
# agrees the target sits inside .ai/. `ln src/bin/rein .ai/h` + `Write .ai/h` wrote
# real bytes to src/bin/rein. Only an inode property can distinguish it.
echo "  [E-208.11] hardlink blind spot"

# E-208.11a–e (the nlink check and its false-positive guards) are role-verdict rows.

# The scope block must name path gating's own limits, not just uncovered channels.
assert_status 0 "E-208.11f: scope note documents the hardlink limit" \
  grep -q "HARDLINKS are handled below by an nlink check" "$ARCH_WRITES"
assert_status 0 "E-208.11g: scope note documents the TOCTOU limit" \
  grep -q "TOCTOU" "$ARCH_WRITES"



# ── E-269 (from pane_option_binding_test — E-302): the binding lands on the pane that ran `rein pane` ──
# `rein pane <role>` once pinned its role with an UNTARGETED `select-pane -T`, so the title landed
# on whichever pane was ACTIVE. Reproduced on a private tmux server: `rein pane engineer` runs in a
# pane that is NOT the active one, and the binding must land on the pane that ran it.
AI="${REPO_ROOT}/src/bin/rein"
if skip_unless_cmd tmux "live tmux pane-option binding"; then
  SOCK="$(test_tmux_socket e269)"
  register_cleanup "tmux -L '${SOCK}' kill-server 2>/dev/null || true"
  PROJ="$(test_tmpdir e269-proj)"
  BIN="$(test_tmpdir e269-bin)"
  mkdir -p "${PROJ}/.ai"
  cat > "${PROJ}/.ai/roles.json" <<'JSON'
{ "roles": { "engineer":  { "provider": "claude", "pane_identifier": "0" },
             "architect": { "provider": "claude", "pane_identifier": "1" } } }
JSON
  # A stand-in provider: `rein pane` execs it, and it must keep the pane alive while we look.
  printf '#!/usr/bin/env bash\nexec sleep 30\n' > "${BIN}/claude"   # REIN_SLEEP_ALLOWED: a stand-in claude binary, not a wait
  chmod +x "${BIN}/claude"
  # tmux resolves `tmux` inside the pane through PATH, so the pane must reach THIS server.
  printf '#!/usr/bin/env bash\nexec %s -L %s "$@"\n' "$(command -v tmux)" "$SOCK" > "${BIN}/tmux"
  chmod +x "${BIN}/tmux"

  T="$(command -v tmux)"
  "$T" -L "$SOCK" new-session -d -s e269 -x 160 -y 40 -c "$PROJ"
  AGENT="$("$T" -L "$SOCK" list-panes -t e269 -F '#{pane_id}' | head -1)"
  "$T" -L "$SOCK" split-window -t "$AGENT" -c "$PROJ"
  OTHER="$("$T" -L "$SOCK" list-panes -t e269 -F '#{pane_id}' | tail -1)"
  "$T" -L "$SOCK" select-pane -t "$OTHER"    # the OTHER pane is ACTIVE
  # Set the sentinel only once the other pane's shell has drawn its prompt: an operator's shell
  # config may retitle a pane at its first prompt (zsh precmd → `user@host:cwd`), and a sentinel
  # set before that is overwritten by the shell, not by `rein pane` (E-315: L4 raced it once
  # `rein pane` read start.json before labelling).
  _po_prompt() { [[ -n "$("$T" -L "$SOCK" capture-pane -p -t "$OTHER" 2>/dev/null | tr -d '[:space:]')" ]]; }
  wait_for _po_prompt 6000 100 || true
  "$T" -L "$SOCK" select-pane -t "$OTHER" -T "untouched"

  # E-294: `rein pane` writes a launch record through launch-record.py, located in the install
  # mirror — so the throwaway HOME carries `.rein/shared` pointing at this tree's src/shared.
  E269_HOME="$(test_tmpdir e269-home)"; mkdir -p "${E269_HOME}/.rein"
  tc_link_shared "$E269_HOME"   # E-345 (D-109 r1): mirror = this tree + the toolchain record the hooks pin
  # Run `rein pane engineer` IN the non-active agent pane (TMUX_PANE is that pane's id).
  "$T" -L "$SOCK" send-keys -t "$AGENT" \
    "PATH='${BIN}':\$PATH HOME='${E269_HOME}' bash '${AI}' pane engineer" C-m

  _opt=""
  _po_role() { _opt="$("$T" -L "$SOCK" show-options -p -v -t "$AGENT" @rein_role 2>/dev/null || true)"; [[ -n "$_opt" ]]; }
  wait_for _po_role 6000 100 || true
  assert_contains "E-269.L1: rein pane sets @rein_role on the pane that ran it" "engineer" "$_opt"
  assert_status 0 "E-269.L2: the ACTIVE (other) pane carries no role option" \
    test -z "$("$T" -L "$SOCK" show-options -p -v -t "$OTHER" @rein_role 2>/dev/null)"
  # rein pane sets the option and the title in two tmux calls (option first), so waiting for the
  # option above does not mean the title has landed yet; under host load it read stale (E-263).
  _title=""
  _po_title() { _title="$("$T" -L "$SOCK" display-message -p -t "$AGENT" '#{pane_title}' 2>/dev/null || true)"; [[ "$_title" == *engineer* ]]; }
  wait_for _po_title 6000 100 || true
  assert_contains "E-269.L3: the cosmetic title is on the agent pane" "engineer" "$_title"
  assert_contains "E-269.L4: the other pane's title is left alone" "untouched" \
    "$("$T" -L "$SOCK" display-message -p -t "$OTHER" '#{pane_title}')"

  # Claude Code retitles its pane; the option must survive that.
  "$T" -L "$SOCK" select-pane -t "$AGENT" -T "✳ Summarise the diff"
  assert_contains "E-269.L7: the option survives a retitle" "engineer" \
    "$("$T" -L "$SOCK" show-options -p -v -t "$AGENT" @rein_role 2>/dev/null)"

  # `rein start --status` reports the role from the option, not the title. (Its live output
  # is covered by rein_start_test's session; here the format string is pinned. E-315 added the
  # @rein_account column between them.)
  assert_status 0 "E-269.L8: --status reads @rein_role" \
    grep -q "#{pane_index}|#{@rein_role}|#{@rein_account}|#{pane_current_command}" "$AI"
fi

echo ""

# ── E-242 (from overlay_path_test — E-302, D-066): launch paths are absolute, overlays self-heal ──
# Project-relative settings/rulefile paths resolved only when the CLI cwd was the project root;
# a missing rulefile is SILENT (the Architect pane boots the ENGINEER — gap G1), so it is asserted first.
RESOLVE="${REPO_ROOT}/src/shared/resolve-launch.mjs"
# A project fixture with both roles mapped to claude, per the D-066 default.
_proj() {
  local d; d="$(test_tmpdir e242)"
  mkdir -p "$d/.ai" "$d/.claude"
  cat > "$d/.ai/roles.json" <<'JSON'
{ "roles": { "architect": {"provider":"claude","pane_identifier":"1","model":"fable"},
             "engineer":  {"provider":"claude","pane_identifier":"0","model":"opus"} } }
JSON
  : > "$d/.claude/settings.architect.json"
  : > "$d/.claude/settings.engineer.json"
  : > "$d/ARCHITECT.md"; : > "$d/ENGINEER.md"
  printf '%s' "$d"
}

_argv() {  # <cwd> <role> <aiDir> → argv on one line
  ( cd "$1" && node "$RESOLVE" "$2" "$3" 2>/dev/null | tr '\n' ' ' )
}

# ── E-242.1: every path operand is ABSOLUTE, from any cwd ─────────────────
_p="$(_proj)"
_from_root="$(_argv "$_p" architect "$_p/.ai")"
mkdir -p "$_p/deep/nested"
_from_sub="$(_argv "$_p/deep/nested" architect "$_p/.ai")"
_from_out="$(_argv / architect "$_p/.ai")"

assert_contains "E-242.01a: settings path is absolute (from the project root)" \
  "--settings ${_p}/.claude/settings.architect.json" "$_from_root"
# THE SILENT HALF: a relative rulefile yields the wrong persona, not an error.
assert_contains "E-242.01b: rulefile path is absolute — a relative one boots the WRONG PERSONA (G1)" \
  "--append-system-prompt-file ${_p}/ARCHITECT.md" "$_from_root"
assert_contains "E-242.01c: identical from a SUBDIRECTORY (the reported failure)" \
  "--settings ${_p}/.claude/settings.architect.json" "$_from_sub"
assert_contains "E-242.01d: and the rulefile too, from a subdirectory" \
  "--append-system-prompt-file ${_p}/ARCHITECT.md" "$_from_sub"
assert_contains "E-242.01e: identical from a cwd OUTSIDE the project" \
  "--settings ${_p}/.claude/settings.architect.json" "$_from_out"
# The strongest form of the property: cwd cannot change the argv at all.
assert_status 0 "E-242.01f: the argv does not depend on cwd (root == subdir == outside)" \
  bash -c "[[ '$_from_root' == '$_from_sub' && '$_from_sub' == '$_from_out' ]]"
# NON-VACUITY: a relative path must be absent, or 01a-f could pass on a broken build that
# emitted both forms.
assert_status 1 "E-242.01g: no bare relative '.claude/settings' survives (non-vacuity)" \
  bash -c "printf '%s' '$_from_root' | grep -q -- '--settings \.claude/'"

# The engineer role resolves the same way, with its own model.
_eng="$(_argv "$_p/deep/nested" engineer "$_p/.ai")"
assert_contains "E-242.01h: engineer overlay is absolute too" \
  "--settings ${_p}/.claude/settings.engineer.json" "$_eng"
assert_contains "E-242.01i: and carries its own model (D-066: opus)" "--model opus" "$_eng"
assert_contains "E-242.01j: architect carries fable" "--model fable" "$_from_root"

# ── E-242.2: an ALREADY-absolute operand is left alone ────────────────────
# The rewrite must not mangle a path an author anchored deliberately.
_abs="$(node --input-type=module -e '
  const { absolutisePathOperands } = await import(process.env.PA);
  const a = ["--settings", "/etc/x.json", "--append-system-prompt-file", "~/R.md", "--model", "opus"];
  console.log(absolutisePathOperands(a, "/proj").join(" "));
' 2>/dev/null)"
export PA="file://${REPO_ROOT}/src/shared/provider-adapter.mjs"
_abs="$(PA="file://${REPO_ROOT}/src/shared/provider-adapter.mjs" node --input-type=module -e '
  const { absolutisePathOperands } = await import(process.env.PA);
  const a = ["--settings", "/etc/x.json", "--append-system-prompt-file", "~/R.md", "--model", "opus"];
  console.log(absolutisePathOperands(a, "/proj").join(" "));
' 2>/dev/null)"
assert_contains "E-242.02a: an absolute operand is untouched" "/etc/x.json" "$_abs"
assert_contains "E-242.02b: a ~-anchored operand is untouched" "~/R.md" "$_abs"
assert_status 1 "E-242.02c: and neither was rewritten under the project root" \
  bash -c "printf '%s' '$_abs' | grep -q '/proj/'"
# A non-path flag's operand must never be treated as a path.
_np="$(PA="file://${REPO_ROOT}/src/shared/provider-adapter.mjs" node --input-type=module -e '
  const { absolutisePathOperands } = await import(process.env.PA);
  console.log(absolutisePathOperands(["--model","opus","-p","hello world"], "/proj").join("|"));
' 2>/dev/null)"
assert_contains "E-242.02d: --model's operand is not a path and is untouched" "opus" "$_np"
assert_status 1 "E-242.02e: a prompt is not rewritten either" \
  bash -c "printf '%s' '$_np' | grep -q '/proj/hello'"

# ── E-242.3: self-heal — a MISSING overlay is regenerated ─────────────────
# Distinct from the path bug: a project cloned before E-208, or one whose .claude/ was
# cleaned, produces the same message for a genuinely absent file.
# A REAL run, not --dry-run: a dry run DESCRIBES and must not write, so it cannot be used
# to exercise the self-heal. Driven through a private tmux socket so no real session is
# touched, and torn down by the registered cleanup.
_h="$(_proj)"
rm -f "$_h/.claude/settings.architect.json"
if skip_unless_cmd tmux "E-242.03 self-heal (needs a real rein start)"; then
  _hs="$(test_tmux_socket e242)"
  _hshim="$(test_tmpdir e242shim)"
  printf '#!/usr/bin/env bash\nexec %s -L %s "$@"\n' "$(command -v tmux)" "$_hs" > "${_hshim}/tmux"
  chmod +x "${_hshim}/tmux"
  _out="$( cd "$_h" && PATH="${_hshim}:$PATH" bash "$AI" start --detach 2>&1 )"
  assert_contains "E-242.03a: a real rein start reports it is regenerating the overlay" \
    "regenerating missing per-role settings overlays" "$_out"
  assert_status 0 "E-242.03b: and the overlay actually exists afterwards" \
    test -f "$_h/.claude/settings.architect.json"
else
  _skip "E-242.03b: self-heal overlay check (tmux not installed)"
fi

# --dry-run DESCRIBES and must never write. A "show me what you would do" invocation that
# modifies the project is the one thing a dry run promises not to be.
_dr="$(_proj)"
rm -f "$_dr/.claude/settings.architect.json"
_dout="$( cd "$_dr" && bash "$AI" start --dry-run 2>&1 )"
assert_contains "E-242.03a-dry: a dry run SAYS the overlays are missing" \
  "(dry run) per-role settings overlays are missing" "$_dout"
assert_status 1 "E-242.03b-dry: and does NOT write the overlay" \
  test -f "$_dr/.claude/settings.architect.json"
# It must NOT rewrite settings.json — that file carries hooks and env, a far larger side
# effect than "start a pane" implies.
assert_status 0 "E-242.03c: rein pane self-heals the same way" \
  grep -q 'missing — regenerating it' "$AI"
assert_status 0 "E-242.03d: only the ROLE overlay is written, never settings.json" \
  bash -c "grep -A3 'missing — regenerating it' '$AI' | grep -q '_write_role_settings_overlays'"

# ── E-242.4: nothing regenerates when the overlays are already present ────
# A pre-check that fires every run would rewrite files on every launch.
_q="$(_proj)"
_quiet="$( cd "$_q" && bash "$AI" start --dry-run 2>&1 )"
assert_status 1 "E-242.04a: no regeneration when both overlays exist" \
  bash -c "printf '%s' '$_quiet' | grep -q 'regenerating missing'"

echo ""

# ── E-213 (from role_identity_test — E-302): the Architect settings overlay and role-correct identity labels ──
# Owner labels and the Stop hook stamp resolve the provider from .ai/roles.json instead of a
# hardcoded vendor label (an all-Claude Triad attributed Architect tasks to a provider not running).
STOP_HOOK="${REPO_ROOT}/hooks/stop-hook.sh"
ADD_TASK="${REPO_ROOT}/src/shared/cli-add-task.mjs"
# ── E-213.1: owner labels carry the bound provider ─────────────────────────
_owner() {  # <role> <aiDir> → owner label
  REIN_R="$1" REIN_D="$2" node --input-type=module -e '
const m = await import(process.env.REIN_MOD);
process.stdout.write(m.resolveOwner({ role: process.env.REIN_R, aiDir: process.env.REIN_D }));
' 2>/dev/null
}
export REIN_MOD="file://${ADD_TASK}"

_DUAL="$(mktemp -d)"
cat > "$_DUAL/roles.json" <<'JSON'
{ "roles": { "architect": { "provider": "claude", "pane_identifier": "1" },
             "engineer":  { "provider": "claude", "pane_identifier": "0" } } }
JSON
_SPLIT="$(mktemp -d)"
cat > "$_SPLIT/roles.json" <<'JSON'
{ "roles": { "architect": { "provider": "acme",   "pane_identifier": "1" },
             "engineer":  { "provider": "claude", "pane_identifier": "0" } } }
JSON

assert_contains "E-213.01a: dual-claude architect is attributed to Claude" \
  "Architect (Claude)" "$(_owner architect "$_DUAL")"
assert_contains "E-213.01b: dual-claude engineer label unchanged" \
  "Engineer (Claude)" "$(_owner engineer "$_DUAL")"
# `acme` is a neutral non-default provider: the label must follow the explicit binding.
assert_contains "E-213.01c: an explicit non-default binding is attributed to that provider" \
  "Architect (Acme)" "$(_owner architect "$_SPLIT")"
# Fail-soft: an attribution label must never break task creation. The DEFAULT topology
# is all-Claude (D-066, E-254). 01c above still pins that an EXPLICIT binding is honoured,
# so the fallback cannot be hiding a hardcoded label.
assert_contains "E-213.01d: a missing roles.json falls back to the D-066 default (claude)" \
  "Architect (Claude)" "$(_owner architect "/nonexistent-dir")"

# roleFromOwner splits on " (", so the generated TASKS.md headers must NOT churn
# when the provider half changes — that is what makes this change safe.
_ROLEOF="$(node --input-type=module -e '
const m = await import("file://'"${REPO_ROOT}"'/src/mcp/shared/state-db.js");
process.stdout.write([m.roleFromOwner("Architect (Claude)"), m.roleFromOwner("Architect (Acme)"), m.roleFromOwner("Engineer (Claude)")].join(","));
' 2>/dev/null)"
assert_contains "E-213.01e: section headers are provider-agnostic (no churn)" \
  "Architect,Architect,Engineer" "$_ROLEOF"

# An explicit --owner still wins over any role mapping.
assert_contains "E-213.01f: explicit --owner still wins" "QA (External)" \
  "$(REIN_MOD="file://${ADD_TASK}" node --input-type=module -e '
const m = await import(process.env.REIN_MOD);
process.stdout.write(m.resolveOwner({ owner: "QA (External)", role: "architect" }));
' 2>/dev/null)"

# ── E-213.2: the Architect overlay carries its allow rules ─────────────────
_OV="$(mktemp -d)/.claude"; mkdir -p "$_OV"
bash -c "source '$AI_BIN' 2>/dev/null; _write_role_settings_overlays '$_OV' '$_DUAL'" >/dev/null 2>&1
_ARCH_OV="$(cat "$_OV/settings.architect.json" 2>/dev/null)"
_ENG_OV="$(cat "$_OV/settings.engineer.json" 2>/dev/null)"

for _rule in "Bash(rein add-task *)" "ListAgents" "SendMessage" \
             "mcp__task-synchronizer-mcp__add_topic_seed" \
             "mcp__task-synchronizer-mcp__add_cluster_page" \
             "mcp__context-guardian-mcp__check_role_access"; do
  assert_contains "E-213.02 [$_rule]: present in the architect overlay" "$_rule" "$_ARCH_OV"
done
# The Engineer overlay must stay env-only — these are Architect-side tools.
assert_not_contains "E-213.02g: the engineer overlay gains no permissions block" \
  "permissions" "$_ENG_OV"
# Still no hooks — the E-208 double-mint guard must survive this change.
assert_not_contains "E-213.02h: the architect overlay still registers NO hooks" \
  '"hooks"' "$_ARCH_OV"
# E-216 (D-055 R1) ADDS a deny list for the filesystem-mutating MCP tools — the one
# channel a path-checking hook cannot see, because it never observes a pre-approved
# MCP call's arguments. Deny is a SECOND layer here, not the mechanism.
assert_contains "E-213.02i: the overlay now carries a deny list (E-216)" '"deny"' "$_ARCH_OV"
for _d in "mcp__filesystem__write_file" "mcp__filesystem__edit_file" \
          "mcp__filesystem__move_file" "mcp__filesystem__create_directory" \
          "mcp__patch-mcp__patch_file" "mcp__propose-patch-mcp__propose_patch" \
          "mcp__propose-patch-mcp__confirm_patch"; do
  assert_contains "E-213.02i [$_d]: denied in the architect overlay" "$_d" "$_ARCH_OV"
done
# The Engineer must NOT inherit the deny list — these are its everyday tools.
assert_not_contains "E-213.02j: the engineer overlay carries no deny list" '"deny"' "$_ENG_OV"

# ── E-213.3: the retired vendor shell grant is gone from the base settings ──
# The grant string is read from the generator's own strip list rather than restated
# here, so this suite names no retired vendor. An empty extraction is a FAIL, not a
# skip — without it 03c would assert that an empty string is absent, which is vacuous.
_LEGACY_GRANT="$(python3 -c '
import re,sys
line = next((l for l in open(sys.argv[1]) if "if entry in (" in l), "")
m = re.search(r"\"(Bash\([^\"]* -p \*\))\"", line)
print(m.group(1) if m else "")' "$AI_BIN")"
assert_status 0 "E-213.03-: the generator declares a legacy grant to strip" \
  test -n "$_LEGACY_GRANT"
assert_status 1 "E-213.03a: the generator no longer ADDS the legacy grant" \
  grep -qF "new_allow.append(\"${_LEGACY_GRANT}\")" "$AI_BIN"
assert_status 0 "E-213.03b: the generator PRUNES an existing legacy grant" \
  grep -q 'Removed legacy grant' "$AI_BIN"
# Behavioural: a settings file that already carries the rule loses it on sync.
_LEG="$(mktemp -d)/.claude"; mkdir -p "$_LEG"
printf '{"permissions":{"allow":["%s","mcp__keep-me__tool"]}}' "$_LEGACY_GRANT" > "$_LEG/settings.json"
bash -c "source '$AI_BIN' 2>/dev/null; REIN=\"\$HOME/.rein\"; _configure_project_claude_settings '$_LEG'" >/dev/null 2>&1
assert_not_contains "E-213.03c: sync removes the legacy grant from an existing file" \
  "${_LEGACY_GRANT:-<no-grant-extracted>}" "$(cat "$_LEG/settings.json")"
assert_contains "E-213.03d: unrelated allow rules survive the prune" \
  "mcp__keep-me__tool" "$(cat "$_LEG/settings.json")"

# ── E-213.4: the Stop hook stamps provider AND role ───────────────────────
assert_status 0 "E-213.04a: the Actor stamp is no longer the literal 'Claude'" \
  bash -c "! grep -qE '^- Actor: Claude\$' '$STOP_HOOK'"
assert_status 0 "E-213.04b: the Actor stamp is interpolated" \
  grep -qE '^- Actor: \$\{ACTOR\}$' "$STOP_HOOK"
assert_status 0 "E-213.04c: the role comes from the launch-time pane role" \
  grep -q 'REIN_PANE_ROLE:-' "$STOP_HOOK"
assert_status 0 "E-213.04d: an unknown role falls back rather than being stamped" \
  grep -q 'architect|engineer) ;;' "$STOP_HOOK"

# ── E-213.5: ACCEPTANCE — the Architect session's identity reaches the gate ─────
# The point of the whole task: a session launched as the Architect must have the Architect
# sovereignty rules APPLIED. E-294 (D-087 r3) moves that identity off the environment: the
# enforcing gate (`safe-exec --check`) takes the role from the session's HMAC-verified token
# (minted from the launch record, bound to the session process); the analyze_command MCP tool
# is ADVISORY and reports only the rule set its caller's own caller_role names.
# Was: "REIN_CALLER_ROLE=architect on the server's spawn env applies Architect rules" — now
# asserted as: the env var changes nothing; the session token does.
_analyze() {  # <env role> <command> [caller_role] → the advisory analysis report
  local _cr=""; [[ -n "${3:-}" ]] && _cr=",\"caller_role\":\"$3\""
  ( cd "$REPO_ROOT"
    source tests/lib/mcp-client.sh
    REIN_CALLER_ROLE="$1" mcp_call_tool "$SAFE_EXEC" analyze_command "{\"command\":\"$2\"${_cr}}"
  ) 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["content"][0]["text"])' 2>/dev/null
}
_RI_HOME="$(test_tmpdir rihome)"; mkdir -p "${_RI_HOME}/.rein"
tc_fixture_home "$_RI_HOME"   # E-345 (D-109 r1): the toolchain record the hooks pin
_ri_gate() {  # <architect|engineer> <command> → the enforcing --check report, run inside a real session
  ( cd "$REPO_ROOT" && HOME="$_RI_HOME" bash tests/lib/as-session.sh "$1" "ri-$1" -- \
      node --no-warnings "$SAFE_EXEC" --check "$2" --session "ri-$1" ) 2>/dev/null
}
_ARCH_REPORT="$(_ri_gate architect "git push origin master")"
assert_contains "E-213.05a: an Architect session's gate applies Architect rules" \
  "ARCH_GIT_PUSH" "$_ARCH_REPORT"
assert_contains "E-213.05b: and blocks the forbidden operation" "BLOCK" "$_ARCH_REPORT"
_ENG_REPORT="$(_ri_gate engineer "git push origin master")"
assert_not_contains "E-213.05c: an Engineer session's gate applies NO Architect rules" \
  "ARCH_" "$_ENG_REPORT"
assert_contains "E-213.05d: and the Engineer may push" "PASS" "$_ENG_REPORT"
assert_not_contains "E-294.05e: REIN_CALLER_ROLE=architect on the server env no longer selects Architect rules" \
  "ARCH_GIT_PUSH" "$(_analyze architect "git push origin master")"
assert_contains "E-294.05f: the advisory tool reports Architect rules when its caller_role asks" \
  "ARCH_GIT_PUSH" "$(_analyze engineer "git push origin master" architect)"

assert_summary
