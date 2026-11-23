#!/usr/bin/env bash
# sync_github_test.sh — `rein sync --github` (E-142 → E-279): issues from a stubbed gh become
# fenced intents, and the project settings grant gh READ verbs only (T-GH-001). Kept from
# propose_patch_test.sh when E-467 (D-170 r5) retired propose-patch-mcp and patch-mcp.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "── Suite: sync_github_test ──────────────────────────────────────────"

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

echo ""
assert_summary
