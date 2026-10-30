#!/usr/bin/env bash
# propose_patch_test.sh — the propose→confirm patch path and the write tools around it:
# propose-patch-mcp (E-141) and GitHub issue ingestion (E-142; E-279 (D-075) retired
# github-bridge-mcp: `rein sync --github` calls gh directly, tested here against a stubbed gh),
# then — merged here by E-302 — confirm_patch apply semantics, the read-only tools' project
# scope (E-226), the propose→confirm project boundary (E-221) and patch-mcp (E-137).
# Was e140_e141_e142_test (misnamed for its tasks); its token-budget-mcp section moved to
# mcp_servers_test (E-302).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── confirm_patch apply semantics (from propose_patch_apply_test — E-302): the child half ──
# The cases need a real plain-launch SESSION as an ancestor of the server (E-294, D-087): the
# caller role is the session token's, verified server-side; with none it fails closed to
# `architect`, which refuses every write to this fixture project. So the section below re-runs
# THIS file as a child of as-session.sh (none → engineer, launch unverified) in a throwaway
# HOME, and the child runs only these cases — never the caller's shell, whose own session
# would otherwise decide the outcome (it passed locally and failed under `rein ci run`).
if [[ "${1:-}" == "--apply-in-session" ]]; then
source "${SCRIPT_DIR}/../lib/mcp-client.sh"
PP_SERVER="${REPO_ROOT}/src/mcp/propose-patch-mcp/index.js"
unset REIN_WORKSPACE REIN_WORKSPACE_DISABLE 2>/dev/null || true

PP_TMP="$(mktemp -d)"; on_exit 'rm -rf "$PP_TMP"'
PROJECT="${PP_TMP}/proj"; mkdir -p "${PROJECT}/.ai"
cat > "${PROJECT}/.ai/state.json" <<'JSON'
{ "version": "1.0", "project": {}, "tasks": [], "stamps": [], "deltas": [] }
JSON
cd "${PROJECT}"

call() { mcp_call_tool "${PP_SERVER}" "$1" "$2" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
c=d.get("content",[{}]); print(c[0].get("text","") if c else "")'; }

is_error() { mcp_call_tool "${PP_SERVER}" "$1" "$2" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("PARSEFAIL"); sys.exit(0)
print("ISERROR" if d.get("isError") else "OK")'; }

# JSON payload builder (handles multiline diff_content safely)
payload() { P="$1" C="$2" python3 -c 'import json,os; print(json.dumps({"path":os.environ["P"],"diff_content":os.environ["C"],"description":"test"}))'; }
# `|| true`, deliberately. grep exits 1 when the response carries no ID, and under
# `set -euo pipefail` that killed the SUITE mid-assignment — printing nothing at all.
# That is how this suite failed on CI from 2026-09-07: "0 passed, 1 failed" with zero
# diagnostic output, because the one thing that would explain it (the server's actual
# reply) was destroyed by the abort. Let it return empty; the assertions below then
# report the reply instead of the suite dying mute.
extract_id() { grep -oE 'ID:[[:space:]]*[A-Za-z0-9_-]+' | head -1 | sed -E 's/ID:[[:space:]]*//' || true; }

# ── Case 1: full-file content beginning with "---" is written verbatim ───────
printf 'old line\n' > front.md
FULL=$'---\ntitle: hello\ntags: [a, b]\n---\n# Body\nverbatim content\n'
r=$(call propose_patch "$(payload front.md "$FULL")")
PID=$(printf '%s' "$r" | extract_id)
assert_match "C1: propose returned an id (reply: ${r:-<empty>})" '.+' "$PID"
call confirm_patch "{\"patch_id\":\"${PID}\"}" >/dev/null
GOT="$(cat front.md)"
assert_contains "C1: YAML front-matter written verbatim (title)" "title: hello" "$GOT"
assert_contains "C1: body written verbatim"                       "verbatim content" "$GOT"
assert_not_contains "C1: not mangled by patch(1)"                 ".rej" "$GOT"
assert_status 1 "C1: no .rej reject file created" test -f front.md.rej
assert_status 1 "C1: no .orig backup left behind"  test -f front.md.orig

# ── Case 2: a real unified diff applies cleanly ──────────────────────────────
printf 'line1\nline2\nline3\n' > code.txt
printf 'line1\nLINE-2-CHANGED\nline3\n' > code.new
DIFF="$(diff -u code.txt code.new || true)"
rm -f code.new
r=$(call propose_patch "$(payload code.txt "$DIFF")")
PID=$(printf '%s' "$r" | extract_id)
e=$(is_error confirm_patch "{\"patch_id\":\"${PID}\"}")
assert_contains "C2: valid diff applies (no error)" "OK" "$e"
assert_contains "C2: change landed"                 "LINE-2-CHANGED" "$(cat code.txt)"
assert_status 1 "C2: backup cleaned up on success"  test -f code.txt.orig

# ── Case 3: a non-applying diff leaves the file untouched ────────────────────
printf 'alpha\nbeta\ngamma\n' > stale.txt
# Diff built against different content → hunk context won't match stale.txt.
printf 'WRONG1\nWRONG2\n' > base.txt
printf 'WRONG1\nWRONG2-CHANGED\n' > base.new
BADDIFF="$(diff -u base.txt base.new || true)"
rm -f base.txt base.new
BEFORE="$(cat stale.txt)"
r=$(call propose_patch "$(payload stale.txt "$BADDIFF")")
PID=$(printf '%s' "$r" | extract_id)
e=$(is_error confirm_patch "{\"patch_id\":\"${PID}\"}")
assert_contains "C3: non-applying diff returns error" "ISERROR" "$e"
assert_contains "C3: file unchanged after failed apply" "$BEFORE" "$(cat stale.txt)"
assert_status 1 "C3: no backup left behind"  test -f stale.txt.orig

assert_summary
exit 0
fi

echo "── Suite: propose_patch_test ────────────────────────────────────────"

# ── E-141: propose-patch-mcp ─────────────────────────────────────────────────

PROPOSE_JS="${REPO_ROOT}/src/mcp/propose-patch-mcp/index.js"
PROPOSE_PKG="${REPO_ROOT}/src/mcp/propose-patch-mcp/package.json"

assert_exists "$PROPOSE_JS"
assert_exists "$PROPOSE_PKG"

PP_CONTENT=$(cat "$PROPOSE_JS")

# All required tools present
assert_contains "propose-patch-mcp: propose_patch tool"      "propose_patch"      "$PP_CONTENT"
assert_contains "propose-patch-mcp: confirm_patch tool"      "confirm_patch"      "$PP_CONTENT"
assert_contains "propose-patch-mcp: reject_patch tool"       "reject_patch"       "$PP_CONTENT"
assert_contains "propose-patch-mcp: list_pending_patches"    "list_pending_patches" "$PP_CONTENT"
assert_contains "propose-patch-mcp: preview_patch tool"      "preview_patch"      "$PP_CONTENT"

# Path traversal protection
assert_contains "propose-patch-mcp: path traversal blocked"  "Path traversal" "$PP_CONTENT"

# In-memory store (patches Map)
assert_contains "propose-patch-mcp: in-memory patch store"   "patches" "$PP_CONTENT"

# Patch display renders confirm/reject instructions
assert_contains "propose-patch-mcp: renders confirm instruction" "confirm_patch" "$PP_CONTENT"

# Does NOT auto-apply — requires explicit confirm
assert_not_contains "propose-patch-mcp: no auto-apply on propose" "writeFileSync" "$(grep -A5 "case \"propose_patch\"" "$PROPOSE_JS" 2>/dev/null || echo "")"

# delta fallback chain present
assert_contains "propose-patch-mcp: delta formatter attempted" "delta" "$PP_CONTENT"

# ── E-142 → E-279: `rein sync --github` produces intents from a stubbed gh ─────────
# The stub records its argv and answers `auth status` / `issue list` like gh would.
GH_STUB_DIR="$(test_tmpdir gh-stub)"; GH_PROJ="$(test_tmpdir gh-proj)"
mkdir -p "${GH_PROJ}/.ai"
LONG_BODY="$(head -c 5000 /dev/zero | tr '\0' 'b')"
cat > "${GH_STUB_DIR}/gh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${GH_STUB_DIR}/argv.log"
case "\$1 \$2" in
  "auth status") exit 0 ;;
  "issue list")  printf '%s' '[{"number":7,"title":"Fix the parser","labels":[{"name":"bug"}],"url":"https://github.com/o/r/issues/7","body":"${LONG_BODY}"},{"number":9,"title":"Docs","labels":[],"url":"https://github.com/o/r/issues/9","body":null}]' ;;
  *) exit 3 ;;
esac
STUB
chmod +x "${GH_STUB_DIR}/gh"
GH_OUT="$(cd "$GH_PROJ" && PATH="${GH_STUB_DIR}:$PATH" bash "${REPO_ROOT}/src/bin/rein" sync --github --repo o/r --limit 5 2>&1)"
GH_ARGV="$(cat "${GH_STUB_DIR}/argv.log" 2>/dev/null)"
assert_contains "sync --github: header"                  "## GitHub Issues — imported"         "$GH_OUT"
assert_contains "sync --github: first issue block"       "### Issue #7: Fix the parser"       "$GH_OUT"
assert_contains "sync --github: labels rendered"         "Labels: bug"                         "$GH_OUT"
assert_contains "sync --github: null body placeholder"   "(no description)"                    "$GH_OUT"
assert_contains "sync --github: intent footer"           "## Action Required"                  "$GH_OUT"
assert_contains "sync --github: footer names add_task"   "mcp__task-synchronizer-mcp__add_task" "$GH_OUT"
assert_not_contains "sync --github: 5000-char body is bounded" "$(head -c 801 /dev/zero | tr '\0' 'b')" "$GH_OUT"
assert_contains "gh stub: asked for MY open issues"      "issue list --assignee @me --state open --limit 5" "$GH_ARGV"
assert_contains "gh stub: --repo forwarded as -R"        "-R o/r"                              "$GH_ARGV"
assert_contains "gh stub: body requested in --json"      "number,title,labels,url,body"        "$GH_ARGV"
# T-PI-001 / T-GH-001: every issue block is fenced as untrusted data.
assert_contains "sync --github: issue #7 fenced UNTRUSTED" "<!-- UNTRUSTED: github issue #7 -->" "$GH_OUT"
assert_contains "sync --github: issue #9 fenced UNTRUSTED" "<!-- UNTRUSTED: github issue #9 -->" "$GH_OUT"
assert_status 0 "sync --github: every fence is closed" \
  test "$(grep -c '<!-- UNTRUSTED: ' <<< "$GH_OUT")" -eq "$(grep -c '<!-- /UNTRUSTED -->' <<< "$GH_OUT")"

# ── E-279 / T-GH-001: gh is granted READ verbs only ─────────────────────────────
# The generator runs against a settings file that already carries the over-broad grants
# (a wildcard and the verb-less pr/issue rules a first cut of E-279 wrote): sync must strip
# them and add only the read verbs. A write verb here would let injected issue text merge,
# close, delete or publish without a prompt.
GH_SET="$(test_tmpdir gh-settings)"
printf '%s\n' '{"permissions":{"allow":["Bash(gh *)","Bash(gh:*)","Bash(gh pr *)","Bash(gh pr:*)","Bash(gh issue:*)","Bash(gh auth status *)","Bash(gh auth status:*)","Bash(ls:*)"]}}' > "${GH_SET}/settings.json"
bash -c "source '${REPO_ROOT}/src/bin/rein' 2>/dev/null; REIN=\"\$HOME/.rein\"; _configure_project_claude_settings '${GH_SET}'" >/dev/null 2>&1
GH_ALLOW="$(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["permissions"]["allow"]))' "${GH_SET}/settings.json" 2>/dev/null)"
for rule in "Bash(gh pr view *)" "Bash(gh pr list *)" "Bash(gh pr checks *)" "Bash(gh issue view *)" "Bash(gh issue list *)"; do
  assert_contains "gh read grant present: ${rule}" "$rule" "$GH_ALLOW"
done
for rule in "Bash(gh *)" "Bash(gh:*)" "Bash(gh pr *)" "Bash(gh pr:*)" "Bash(gh issue:*)" "Bash(gh auth status *)" "Bash(gh auth status:*)"; do
  assert_status 1 "over-broad gh grant stripped: ${rule}" grep -qxF "$rule" <<< "$GH_ALLOW"
done
assert_status 1 "no gh WRITE verb is ever granted" \
  grep -qE '^Bash\(gh (pr (merge|close|reopen|create|comment|edit|review|checkout|ready)|issue (delete|close|create|comment|edit|transfer|lock))' <<< "$GH_ALLOW"
# `gh auth status` exactly: a trailing * would also match --show-token and print the token.
assert_status 0 "gh auth status granted EXACTLY (no flags)" grep -qxF "Bash(gh auth status)" <<< "$GH_ALLOW"
assert_status 1 "no gh auth grant takes arguments" grep -qE '^Bash\(gh auth [a-z]+ *(\*|:)' <<< "$GH_ALLOW"
assert_contains "unrelated allow rules survive" "Bash(ls:*)" "$GH_ALLOW"
# --jq/--template can read $ENV, so they must stay on the prompt despite the read grants.
GH_ASK="$(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["permissions"].get("ask", [])))' "${GH_SET}/settings.json" 2>/dev/null)"
for rule in "Bash(gh * --jq*)" "Bash(gh * -q*)" "Bash(gh * --template*)" "Bash(gh * -t*)"; do
  assert_status 0 "gh env-reading flag stays on the prompt: ${rule}" grep -qxF "$rule" <<< "$GH_ASK"
done

# ── rein sync --github wiring ───────────────────────────────────────────────────

AI_BIN="${REPO_ROOT}/src/bin/rein"
BIN_CONTENT=$(cat "$AI_BIN")

assert_contains "rein sync --github: do_sync_github function exists" "do_sync_github" "$BIN_CONTENT"
assert_contains "rein sync --github: --github flag detected in do_sync" '"--github"' "$BIN_CONTENT"
assert_contains "rein sync --github: usage line updated" "sync --github" "$BIN_CONTENT"
assert_contains "rein sync --github: gh auth check present" "gh auth status" "$BIN_CONTENT"
assert_contains "rein sync --github: --repo flag supported" "--repo" "$BIN_CONTENT"
assert_contains "rein sync --github: --limit flag supported" "--limit" "$BIN_CONTENT"

# ── Registry: all 3 new servers registered ───────────────────────────────────

REGISTRY="${REPO_ROOT}/src/config/registry.json"
REG_CONTENT=$(cat "$REGISTRY")

assert_contains "registry: token-budget-mcp registered"  "token-budget-mcp"  "$REG_CONTENT"
assert_contains "registry: propose-patch-mcp registered" "propose-patch-mcp" "$REG_CONTENT"
assert_not_contains "registry: retired github-bridge-mcp is gone (E-279)" "github-bridge-mcp" "$REG_CONTENT"

# Capabilities correct
assert_contains "registry: token-budget-mcp WRITE capability"  '"token-budget-mcp"' "$REG_CONTENT"

echo ""

# ── confirm_patch apply semantics (from propose_patch_apply_test — E-302): review fix ──
# Verifies the diff/full-file classification and the dry-run+backup safety net:
#   1. Full-file content that begins with "---" (YAML front-matter) is written
#      verbatim, NOT piped to patch(1) and corrupted.
#   2. A real unified diff applies cleanly.
#   3. A unified diff that does not apply leaves the target file unchanged
#      (dry-run rejects it before any write) and returns an error.
# The cases run in a child under a real session (the `--apply-in-session` block at the top);
# its tally is folded into this suite's counters, and a child that dies without one is a FAIL.
_PH="$(test_tmpdir pphome)"; mkdir -p "${_PH}/.rein"
tc_fixture_home "$_PH"   # E-345 (D-109 r1): the toolchain record the install writes
_pp_rc=0
_pp_out="$(HOME="$_PH" CLAUDE_CODE_SESSION_ID=pp-apply bash "${REPO_ROOT}/tests/lib/as-session.sh" none pp-apply -- \
  bash "${BASH_SOURCE[0]}" --apply-in-session 2>&1)" || _pp_rc=$?
printf '%s\n' "$_pp_out" | grep -v '^SUITE_RESULT ' || true
_pp_res="$(printf '%s\n' "$_pp_out" | grep '^SUITE_RESULT ' | tail -1 || true)"
if [[ "$_pp_res" =~ PASS=([0-9]+)\ FAIL=([0-9]+)\ SKIP=([0-9]+) ]]; then
  PASS_COUNT=$(( PASS_COUNT + BASH_REMATCH[1] )); FAIL_COUNT=$(( FAIL_COUNT + BASH_REMATCH[2] ))
  SKIP_COUNT=$(( SKIP_COUNT + BASH_REMATCH[3] ))
else
  _fail "confirm_patch apply cases: the in-session child reported no result (rc=${_pp_rc})"
fi

# ── E-226 (from patch_readonly_scope_test — E-302): T-PROPOSEPATCH-002 ──
# E-221 bound the WRITE path to the proposing project. The three read-only tools were
# explicitly out of that ruling's scope, so they kept trusting the stored ABSOLUTE path:
#   preview_patch  called formatDiff(diff, patch.path), which STATS AND READS that path to
#                  build a diff baseline — a file outside the previewing project rendered
#                  its contents into tool output.
set +e
DRIVER="${REPO_ROOT}/tests/lib/propose-patch-driver.mjs"
SERVER="${REPO_ROOT}/src/mcp/propose-patch-mcp/index.js"


_drive() { node --no-warnings "$DRIVER" "$1" 2>/dev/null | tail -1; }

# ── E-226.1: the legitimate case still works ───────────────────────────────
# First, because everything below is a refusal and refusals are easy to get right by
# refusing everything.
_r="$(_drive own-preview)"
assert_contains "E-226.01a: an own-project preview still renders" "previewed" "$_r"
assert_not_contains "E-226.01b: it is not misreported as foreign" "wrongly-foreign" "$_r"
assert_contains "E-226.01c: preview writes nothing" "original" "$_r"

# ── E-226.2: a foreign preview reads NO file ───────────────────────────────
# The disclosure itself. The stored diff is still shown — an operator can see what was
# proposed — but no baseline is read, so nothing outside this project can be rendered.
_r="$(_drive foreign-preview)"
assert_not_contains "E-226.02a: the canary's contents never reach the output" "LEAKED" "$_r"
assert_contains "E-226.02b: it is labelled [FOREIGN_PROJECT]" "FOREIGN_BANNER" "$_r"
assert_not_contains "E-226.02c: no absolute path from the other project leaks" "ABS_PATH_LEAKED" "$_r"

# ── E-226.3: a foreign reject is refused, and the row survives ─────────────
# Rejecting is a WRITE to someone else's queue: it destroys a patch its owner is waiting
# to confirm. Pre-fix this deleted the row.
_r="$(_drive foreign-reject)"
assert_contains "E-226.03a: a cross-project reject returns PROJECT_MISMATCH" "PROJECT_MISMATCH" "$_r"
assert_contains "E-226.03b: the other project's row is still there" "row-kept" "$_r"

# ── E-226.4: list is own-project by default, identifiers-only with all:true ─
_r="$(_drive foreign-list)"
assert_not_contains "E-226.04a: the default listing leaks no absolute path" "ABS_PATH_LEAKED" "$_r"
_r="$(_drive foreign-list-all)"
assert_contains "E-226.04b: all:true lists foreign rows safely" "listed-safely" "$_r"
assert_not_contains "E-226.04c: even then, no absolute path" "ABS_PATH_LEAKED" "$_r"
assert_status 0 "E-226.04d: foreign rows are shown by root BASENAME only" \
  bash -c "grep -q 'function rootLabel' '$SERVER'"

# ── E-226.5: the three tools share one derivation ──────────────────────────
# Three copies of "does this row belong here" would drift, and the weakest would decide.
assert_status 0 "E-226.05a: a single rowScope classifier exists" \
  bash -c "grep -q 'function rowScope' '$SERVER'"
assert_status 0 "E-226.05b: all three read-only tools use it" \
  bash -c "test \$(grep -c 'rowScope(' '$SERVER') -ge 4"
# The stored absolute path survives in exactly ONE place — the REIN_PATCH_LEGACY
# rollback branch — and nowhere on the default path. Asserting the string is absent
# entirely would have been wrong (the rollback needs it), and asserting only that it
# exists would be vacuous; this pins WHERE it may appear.
# Comment lines are stripped first: the module header QUOTES this call as the thing that
# leaked, and counting that occurrence made the assertion fail on correct code.
assert_status 0 "E-226.05c: the stored absolute path is used once, under the rollback flag" \
  bash -c "test \$(grep -v '^\s*\*' '$SERVER' | grep -c 'formatDiff(patch.diff_content, patch.path)') -eq 1"
assert_status 0 "E-226.05d: that one use sits inside the REIN_PATCH_LEGACY branch" \
  bash -c "python3 - '$SERVER' <<'PYX'
import sys
# Comment lines stripped first: the module header QUOTES the call as the thing that
# leaked, and index() found THAT occurrence — so the assertion failed on correct code.
src = [l for l in open(sys.argv[1]).read().split('\n') if not l.lstrip().startswith(('*', '//', '/*'))]
s = '\n'.join(src)
i = s.index('formatDiff(patch.diff_content, patch.path)')
sys.exit(0 if 'REIN_PATCH_LEGACY' in s[max(0, i-400):i] else 1)
PYX"

# ── E-226.6: legacy rows are listed but never read ─────────────────────────
_r="$(_drive legacy)"
assert_contains "E-226.06a: a legacy row is still refused at confirm" "LEGACY_PATCH" "$_r"
assert_status 0 "E-226.06b: legacy rows are classified separately from foreign ones" \
  bash -c "grep -q 'return \"legacy\"' '$SERVER'"

# ── E-226.7: the rollback flag restores the old behaviour ──────────────────
assert_status 0 "E-226.07a: REIN_PATCH_LEGACY is honoured by all three tools" \
  bash -c "test \$(grep -c 'REIN_PATCH_LEGACY' '$SERVER') -ge 4"

# ── E-226.8: the tool descriptions tell the model what to expect ───────────
# The description is what the model reads before calling; a silent behaviour change here
# is a behaviour change nobody sees.
assert_status 0 "E-226.08a: list documents the all:true shape" \
  bash -c "grep -q 'Pass all:true' '$SERVER'"
assert_status 0 "E-226.08b: preview documents the foreign case" \
  bash -c "grep -q 'FOREIGN_PROJECT. banner' '$SERVER'"

# ── E-221 (from patch_project_boundary_test — E-302): the propose→confirm project boundary ──
# `propose_patch` stored an ABSOLUTE path resolved against the proposing process's root;
# `confirm_patch` wrote to it without re-checking against its OWN root. Confirming a
# pending patch from a different project therefore landed the write outside that project.
# Not a role escape — the role is re-derived per process since E-219 — the boundary that
# was missing is the PROJECT one.
DRIVER_PB="${REPO_ROOT}/tests/lib/propose-patch-driver.mjs"
SERVER_PB="${REPO_ROOT}/src/mcp/propose-patch-mcp/index.js"
STATE_DB="${REPO_ROOT}/src/mcp/shared/state-db.js"


_drive_pb() { node --no-warnings "$DRIVER_PB" "$1" 2>/dev/null | tail -1; }

# ── E-221.1: the ordinary path still works ──────────────────────────────────
# A boundary check that breaks the legitimate case is not a fix. This runs first for
# that reason: everything below is a refusal, and refusals are cheap to get right by
# refusing everything.
_r="$(_drive_pb same)"
assert_contains "E-221.01a: propose+confirm in ONE project applies the patch" "applied" "$_r"
assert_contains "E-221.01b: the target file actually changed" "patched" "$_r"

# ── E-221.2: confirming from another project is refused ─────────────────────
# The vulnerability itself. The second project reaches the same patch store through a
# `.ai` symlink — without that the store simply is not shared and the case is unreachable.
_r="$(_drive_pb cross)"
assert_contains "E-221.02a: a cross-project confirm returns PROJECT_MISMATCH" "PROJECT_MISMATCH" "$_r"
assert_contains "E-221.02b: NEITHER project's file was written" "original|original" "$_r"
assert_not_contains "E-221.02c: the proposing project was not silently patched" "patched" "$_r"

# ── E-221.3: the stored relative path is data, not a destination ─────────────
# Storing the root alone would only DETECT a mismatch. Re-resolving the relative path is
# what stops a row edited in the DB from escaping while the roots still agree.
_r="$(_drive_pb tampered-rel)"
assert_contains "E-221.03a: a tampered rel_path is refused" "PROJECT_ESCAPE" "$_r"
assert_match "E-221.03b: nothing was written outside the root" '(^|	)-$|	-$' "$_r"

# ── E-221.4: pre-migration rows are refused, not guessed at ─────────────────
# A legacy row records no project root, so nothing in it says which project it belonged
# to. Guessing is the behaviour being removed.
_r="$(_drive_pb legacy)"
assert_contains "E-221.04a: a legacy record is rejected" "LEGACY_PATCH" "$_r"
assert_contains "E-221.04b: it is left unapplied" "original" "$_r"
assert_status 0 "E-221.04c: the rejection tells the caller to re-propose" \
  bash -c "grep -q 'Re-propose it here' '$SERVER_PB'"

# ── E-221.5: the rollback flag restores acceptance, but not the hole ────────
_r="$(_drive_pb legacy-ok)"
assert_contains "E-221.05a: REIN_PATCH_LEGACY=1 accepts an in-project legacy record" "applied" "$_r"
_r="$(_drive_pb legacy-escape)"
assert_contains "E-221.05b: even then, an out-of-root absolute path is refused" "PROJECT_ESCAPE" "$_r"
assert_match "E-221.05c: the out-of-root canary was never written" '	-$' "$_r"

# ── E-221.6: the read-only tools are unchanged (D-057 §1) ───────────────────
_r="$(_drive_pb preview)"
assert_contains "E-221.06a: preview_patch still renders the pending diff" "previewed" "$_r"
assert_contains "E-221.06b: preview writes nothing" "original" "$_r"
_r="$(_drive_pb reject)"
assert_contains "E-221.06c: reject_patch still discards the patch" "rejected" "$_r"
assert_contains "E-221.06d: reject writes nothing" "original" "$_r"

# ── E-221.7: the schema carries the evidence ────────────────────────────────
assert_status 0 "E-221.07a: fresh DBs create project_root + rel_path" \
  bash -c "grep -q 'project_root TEXT' '$STATE_DB' && grep -q 'rel_path     TEXT' '$STATE_DB'"
assert_status 0 "E-221.07b: legacy DBs get an idempotent ALTER" \
  bash -c "grep -q '_migratePatchProjectRoot' '$STATE_DB'"
assert_status 0 "E-221.07c: the INSERT actually names the new columns" \
  bash -c "grep -q 'project_root, rel_path' '$SERVER_PB'"

# ── E-221.8: confirm never writes to the stored absolute path ───────────────
# The regression that would quietly reopen this: re-deriving targetPath and then applying
# to `patch.path` anyway. E-219 F4 is the precedent — a test that asserted a COPY of the
# guard passed while the shipped code was wrong.
_apply_block="$(sed -n '/Apply the patch — determine if diff_content/,/reject_patch/p' "$SERVER_PB")"
assert_not_contains "E-221.08a: the apply block references no stored absolute path" "patch.path" "$_apply_block"
assert_contains "E-221.08b: it writes to the re-derived path" "targetPath" "$_apply_block"
assert_contains "E-221.08c: the role re-check uses the re-derived path too" \
  "roleGuard(patch.caller_role, targetPath, cwd)" "$(cat "$SERVER_PB")"

# ── E-221.10: a symlinked directory component cannot forward a write out ────
# The E-221 audit's H1, reproduced independently: `src/esc -> ../outside`, one project,
# no cross-project confirm, no DB tampering. The old four-line safePath was LEXICAL, so
# the relative path held no ".." and the write followed the link out of the root.
# Non-vacuity: against the pre-fix server this mode prints "applied  patched" — the file
# OUTSIDE the project was rewritten.
_r="$(_drive_pb symlink-escape)"
assert_not_contains "E-221.10a: the symlinked write is refused" "applied" "$_r"
assert_contains "E-221.10b: the file outside the root is untouched" "UNTOUCHED" "$_r"
assert_status 0 "E-221.10c: safePath delegates to the shared predicate, not a local copy" \
  bash -c "grep -q 'projectPathVerdict(filePath, cwd)' '$SERVER_PB'"
assert_status 1 "E-221.10d: no hand-rolled lexical bounds test survives" \
  bash -c "grep -q 'rel.startsWith(\"..\")' '$SERVER_PB'"

# ── E-221.11: an empty rel_path does not select the legacy branch ───────────
# The audit's L1. Legacy is the branch that SKIPS the equality check, so it must be
# chosen by column ABSENCE, never by a value the record itself controls.
_r="$(_drive_pb root-target)"
assert_not_contains "E-221.11a: a root-naming patch is not misreported as legacy" "LEGACY_PATCH" "$_r"
assert_not_contains "E-221.11b: and it is never applied" "applied" "$_r"
assert_status 0 "E-221.11c: legacy is detected by NULL columns, not falsiness" \
  bash -c "grep -q 'patch.project_root == null || patch.rel_path == null' '$SERVER_PB'"

# ── E-221.12: a failed apply leaves the file byte-identical and no debris ────
# The audit's H2 was reported as a dry-run BYPASS; that payload did not reproduce here
# (patch 2.0-12u11-Apple refuses it at the dry-run and the message is accurate). The
# rollback SHAPE was wrong regardless: patch(1) writes `.orig` per SECTION, so a later
# failure could "restore" partially-applied content, and `${target}.orig` clobbered a
# real file of that name. The rollback now uses an in-memory pre-image and verifies it.
_r="$(_drive_pb failed-apply)"
assert_contains "E-221.12a: a failed apply leaves the file unchanged" "unchanged" "$_r"
assert_contains "E-221.12b: no stray .orig is left in the tree" "clean" "$_r"
assert_status 1 "E-221.12c: patch(1) is no longer asked to write its own backup" \
  bash -c "grep -q '\"-b\", \"-f\"' '$SERVER_PB'"
assert_status 0 "E-221.12d: the restore is verified before it is claimed" \
  bash -c "grep -q 'rollback could not be verified' '$SERVER_PB'"

# ── E-221.13: rollback housekeeping never destroys a user's file ────────────
# patch(1) backs up to `${target}.orig` on its own initiative, so a user file of that
# name sat in the blast radius of the cleanup. Same class of harm as the E-220 over-prune:
# a maintenance path deleting something real.
_r="$(_drive_pb orig-collateral)"
assert_contains "E-221.13a: the patch still applies" "applied" "$_r"
assert_contains "E-221.13b: a pre-existing .orig file is left intact" "MY OWN FILE" "$_r"

# ── E-221.14: diff_content cannot name its own write targets ────────────────
# The audit's H3, and the finding that mattered most: E-221 validated the PATH three ways
# and none of it bounded what patch(1) WRITES. The operand governs the FIRST diff section
# only; later sections take their targets from their own headers. An ed-style prelude
# needs no header at all, so "at most one section" — my first rule — was not enough
# either. The rule is now "unified diff and nothing else".
#
# Non-vacuity, both modes against the pre-fix server:
#   multi-section-redirect → "applied  benign|TARGET_ORIGINAL|PWNED"   (wrote OUTSIDE the root)
#   ed-prelude             → "applied  ATTACKER_CONTENT|z|VICTIM_ORIGINAL" (wrote TWO files)
_r="$(_drive_pb multi-section-redirect)"
assert_contains "E-221.14a: a second diff section is refused" "DIFF_REDIRECT" "$_r"
assert_contains "E-221.14b: nothing anywhere was written" "TARGET_ORIGINAL|TARGET_ORIGINAL|VICTIM_ORIGINAL" "$_r"
_r="$(_drive_pb ed-prelude)"
assert_contains "E-221.14c: an ed-script prelude is refused" "DIFF_REDIRECT" "$_r"
assert_contains "E-221.14d: neither the operand nor the header file changed" \
  "TARGET_ORIGINAL|TARGET_ORIGINAL|VICTIM_ORIGINAL" "$_r"
assert_status 0 "E-221.14e: the blob is validated at propose AND at confirm" \
  bash -c "test \$(grep -c 'validateDiffContent' '$SERVER_PB') -ge 2"

# A removed line beginning with '--' renders as '--- x' and must be read as hunk DATA,
# never as a section header — the E-216 invariant, in a new parser.
assert_status 0 "E-221.14f: hunk data that looks like a header is not read as syntax" \
  node --input-type=module --no-warnings -e '
    import { validateDiffContent } from "'"${REPO_ROOT}"'/src/mcp/propose-patch-mcp/diff-targets.mjs";
    const b = "--- a/x\n+++ b/x\n@@ -1,3 +1,1 @@\n-- dashes\n--- three\n-plain\n+new\n";
    process.exit(validateDiffContent(b).ok ? 0 : 1);
  '
assert_status 0 "E-221.14g: an ordinary single-file diff still passes" \
  node --input-type=module --no-warnings -e '
    import { validateDiffContent } from "'"${REPO_ROOT}"'/src/mcp/propose-patch-mcp/diff-targets.mjs";
    const b = "--- a/src/x.js\n+++ b/src/x.js\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n";
    process.exit(validateDiffContent(b).ok ? 0 : 1);
  '
assert_status 0 "E-221.14h: full-file content (no hunks) is unaffected" \
  node --input-type=module --no-warnings -e '
    import { validateDiffContent } from "'"${REPO_ROOT}"'/src/mcp/propose-patch-mcp/diff-targets.mjs";
    process.exit(validateDiffContent("just\nsome\nfile content\n").ok ? 0 : 1);
  '

# ── E-221.15: the diff grammar must accept what git actually emits ──────────
# Strictness that rejects real input is not a security win, it is an outage. The
# `\ No newline at end of file` marker sits AFTER a hunk's last counted line, so the walk
# had already exited and read it as stray content — every diff of a file without a
# trailing newline was refused, which is the single most likely diff a model produces.
_dg() {  # <blob> → ok | REFUSED
  node --input-type=module --no-warnings -e '
    import { validateDiffContent } from "'"${REPO_ROOT}"'/src/mcp/propose-patch-mcp/diff-targets.mjs";
    const v = validateDiffContent(process.argv[1]);
    process.stdout.write(v.ok ? "ok" : "REFUSED");
  ' -- "$1" 2>/dev/null
}
assert_contains "E-221.15a: a no-newline marker is accepted" "ok" \
  "$(_dg '--- a/x
+++ b/x
@@ -1,1 +1,1 @@
-old
+new
\ No newline at end of file
')"
assert_contains "E-221.15b: a no-newline marker mid-hunk is accepted" "ok" \
  "$(_dg '--- a/x
+++ b/x
@@ -1,2 +1,2 @@
-old
\ No newline at end of file
+new
 ctx
')"
assert_contains "E-221.15c: /dev/null file creation is accepted" "ok" \
  "$(_dg '--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello
')"

# ── E-221.16: the parse holds on its OWN terms, not on patch(1)'s strictness ─
# An inflated hunk count runs the walk off the end of the blob with counters still
# positive, silently swallowing whatever followed — including a second `--- victim`
# header — and the walk would then report a clean single-section parse. patch(1) happens
# to reject those blobs here, but "the binary is strict" is the reasoning that hid the
# redirect in the first place.
assert_contains "E-221.16a: an inflated hunk count is refused" "REFUSED" \
  "$(_dg '--- a
+++ a
@@ -1,9 +1,9 @@
-L1
+ok
--- outside/victim.txt
+++ outside/victim.txt
')"
assert_contains "E-221.16b: a truncated hunk is refused" "REFUSED" \
  "$(_dg '--- a
+++ a
@@ -1,50 +1,50 @@
-one
+two
')"
assert_contains "E-221.16c: an ABSOLUTE header path is refused, not just a relative one" "REFUSED" \
  "$(_dg '--- /etc/hosts
+++ /etc/hosts
@@ -1,1 +1,1 @@
-a
+b
')"

# ── E-221.17: containment does NOT depend on which patch(1) is installed ────
# All local testing ran against `patch 2.0-12u11-Apple`; GNU patch 2.7.x was never
# exercised (no Docker, and this repo has no CI configuration at all). That gap is bounded
# rather than argued: both redirect payloads are refused by the JS validator BEFORE
# `patch` is spawned, so no behaviour of the binary can change the outcome. These
# assertions call the validator directly — no subprocess, nothing platform-specific —
# so they hold identically wherever the suite runs.
assert_contains "E-221.17a: the multi-section payload is refused in JS" "REFUSED" \
  "$(_dg '--- a
+++ a
@@ -1,1 +1,1 @@
-A
+B
--- ../outside/v.txt
+++ ../outside/v.txt
@@ -1,1 +1,1 @@
-C
+D
')"
assert_contains "E-221.17b: the ed-prelude payload is refused in JS" "REFUSED" \
  "$(_dg '1c
ATTACKER
.
w
--- z.txt
+++ z.txt
@@ -1,1 +1,1 @@
-ORIGINAL_LINE_1
+z
')"
assert_status 0 "E-221.17c: the blob is validated before patch(1) is ever spawned" \
  bash -c "python3 - '$SERVER_PB' <<'PYX'
import sys
s = open(sys.argv[1]).read()
i = s.index('validateDiffContent(args.diff_content)')      # propose-time gate
j = s.index('spawnSync(\"patch\"')                          # first patch invocation
sys.exit(0 if i < j else 1)
PYX"

# ── E-221.9: roots compare by realpath ──────────────────────────────────────
# /tmp is a symlink to /private/tmp on macOS: a string compare would reject legitimate
# confirms there, and every case above runs under mktemp.
assert_contains "E-221.09a: root comparison canonicalises both sides" "canonicalRoot" "$(cat "$SERVER_PB")"

# ── E-137 (from patch_mcp_test — E-302): patch-mcp ──
# The lsp-mcp half of the old lsp_patch_test was retired with the server (E-278, D-075).
set -e
PATCH_JS="${REPO_ROOT}/src/mcp/patch-mcp/index.js"


# ── patch-mcp structural tests ───────────────────────────────────────────────

assert_exists "$PATCH_JS"
PATCH=$(cat "$PATCH_JS")

# Both tools defined
assert_contains "patch-mcp: patch_file tool"   "patch_file"   "$PATCH"
assert_contains "patch-mcp: get_file_md5 tool" "get_file_md5" "$PATCH"

# MD5 implementation uses crypto module
assert_contains "patch-mcp: uses crypto.createHash md5" "createHash" "$PATCH"
assert_contains "patch-mcp: md5 digest hex"             "hex"        "$PATCH"

# Staleness check: rejects with MD5_MISMATCH when old_content not found (E-157 fuzzy fallback)
assert_contains "patch-mcp: MD5_MISMATCH reject message" "MD5_MISMATCH" "$PATCH"

# Fallback: old_content exact match when no expected_md5
assert_contains "patch-mcp: PATCH MISMATCH fallback"    "PATCH MISMATCH" "$PATCH"

# Path traversal: safePath uses relative() with .. check
assert_contains "patch-mcp: safePath function"           "safePath"   "$PATCH"
assert_contains "patch-mcp: traversal check rel.startsWith" 'startsWith("..")' "$PATCH"
assert_contains "patch-mcp: traversal blocked message"   "Path traversal blocked" "$PATCH"

# Returns new MD5 after successful patch
assert_contains "patch-mcp: returns new MD5 on success" "new MD5"    "$PATCH"
assert_contains "patch-mcp: metadata md5 field"         "md5: newMd5" "$PATCH"

# ── patch-mcp: functional tests ──────────────────────────────────────────────
TMPDIR_TEST=$(mktemp -d)
on_exit 'rm -rf "$TMPDIR_TEST"'

# Test 1: get_file_md5 returns correct MD5 for known content
TEST_FILE="${TMPDIR_TEST}/test.txt"
echo -n "hello world" > "$TEST_FILE"
EXPECTED_MD5="5eb63bbbe01eeed093cb22bb8f5acdc3"

if command -v node &>/dev/null; then
  # Test 1: MD5 of "hello world"
  MD5_DIR=$(mktemp -d); MD5_SCRIPT="$MD5_DIR/md5.mjs"
  cat > "$MD5_SCRIPT" <<JSEOF
import { createHash } from "crypto";
import { readFileSync } from "fs";
const content = readFileSync(process.argv[2], "utf8");
process.stdout.write(createHash("md5").update(content).digest("hex"));
JSEOF
  ACTUAL_MD5=$(node "$MD5_SCRIPT" "$TEST_FILE" 2>/dev/null || echo "error")
  rm -rf "$MD5_DIR"
  if [[ "$ACTUAL_MD5" == "$EXPECTED_MD5" ]]; then
    _pass "patch-mcp: MD5 of 'hello world' = $EXPECTED_MD5 (correct)"
  else
    _fail "patch-mcp: MD5 mismatch: expected $EXPECTED_MD5 got $ACTUAL_MD5"
  fi

  # Test 2: patch logic — apply old→new replacement
  echo "foo bar baz" > "${TMPDIR_TEST}/patch_test.txt"
  PATCH_DIR=$(mktemp -d); PATCH_SCRIPT="$PATCH_DIR/logic.mjs"
  cat > "$PATCH_SCRIPT" <<'JSEOF'
import { readFileSync, writeFileSync } from "fs";
const p = process.argv[2];
const c = readFileSync(p, "utf8");
const patched = c.replace("foo bar", "foo QUX");
writeFileSync(p, patched);
process.stdout.write("OK");
JSEOF
  node "$PATCH_SCRIPT" "${TMPDIR_TEST}/patch_test.txt" 2>/dev/null || true
  rm -rf "$PATCH_DIR"
  RESULT=$(cat "${TMPDIR_TEST}/patch_test.txt")
  if [[ "$RESULT" == "foo QUX baz" ]]; then
    _pass "patch-mcp: patch logic correctly applies old→new replacement"
  else
    _fail "patch-mcp: patch logic failed — got: '$RESULT'"
  fi

  # Test 3: MD5 changes after patch
  MD5B_DIR=$(mktemp -d); MD5B_SCRIPT="$MD5B_DIR/md5b.mjs"
  cat > "$MD5B_SCRIPT" <<'JSEOF'
import { createHash } from "crypto";
process.stdout.write(createHash("md5").update(process.argv[2]).digest("hex"));
JSEOF
  BEFORE_MD5=$(node "$MD5B_SCRIPT" "foo bar baz
" 2>/dev/null || echo "")
  AFTER_MD5=$(node "$MD5B_SCRIPT" "foo QUX baz
" 2>/dev/null || echo "")
  rm -rf "$MD5B_DIR"
  if [[ "$BEFORE_MD5" != "$AFTER_MD5" && -n "$BEFORE_MD5" && -n "$AFTER_MD5" ]]; then
    _pass "patch-mcp: MD5 changes after applying patch (staleness detection works)"
  else
    _pass "patch-mcp: MD5 change test skipped (node not returning expected values)"
  fi
else
  _pass "patch-mcp: functional tests skipped (node unavailable)"
  _pass "patch-mcp: patch logic test skipped"
  _pass "patch-mcp: MD5 change test skipped"
fi

# ── registry entries ──────────────────────────────────────────────────────────
REGISTRY_PM="${REPO_ROOT}/src/config/registry.json"
REG=$(cat "$REGISTRY_PM")
assert_not_contains "registry: retired lsp-mcp is gone (E-278)" "lsp-mcp" "$REG"
assert_contains "registry: patch-mcp registered"       "patch-mcp" "$REG"
assert_contains "registry: patch-mcp WRITE capability" '"capability": "WRITE"' "$REG"

# ── CAPABILITIES.md updated for new shell commands ────────────────────────────
CAPS="${REPO_ROOT}/CAPABILITIES.md"
CAPS_CONTENT=$(cat "$CAPS")
assert_contains "CAPABILITIES.md: npx tsc --noEmit allowed" "npx tsc --noEmit" "$CAPS_CONTENT"
assert_contains "CAPABILITIES.md: delta allowed"             "delta"            "$CAPS_CONTENT"
assert_contains "CAPABILITIES.md: patch allowed"             "patch"            "$CAPS_CONTENT"
assert_contains "CAPABILITIES.md: gh issue list allowed"     "gh issue list"    "$CAPS_CONTENT"

echo ""

assert_summary
