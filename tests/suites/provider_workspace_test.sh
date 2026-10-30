#!/usr/bin/env bash
# REIN_INSTALLER_SUBJECT: rein init in a non-git directory (E-311, D-092)
# provider_workspace_test.sh — E-244 (D-066 §4): workspaces follow the role binding.
#
# `rein sync` used to provision every vendor workspace on every project, unconditionally,
# regardless of what .ai/roles.json said. v4 (D-069) ships one built-in provider, `claude`;
# a provider declared in .ai/providers.json with a `workspace_dir` is still classified, and
# its workspace is stale when no role is bound to it. The fixtures below use a neutral
# declared provider, `acme` (workspace .acme/), for that half.
#
# THE DANGEROUS HALF IS THE PRUNE, and it is weighted accordingly below. "Delete the
# directory of a provider nobody uses" is one careless `rm -rf` away from deleting a
# user's own skill, so the prune reuses E-220's evidence rules with an EMPTY source set:
# sync wrote it, nobody edited it, nothing upstream provides it. Everything else is
# reported and kept, and the directory survives if anything is left in it.
#
# .claude/ IS NEVER STALE even when roles.json does not name claude — the git hooks,
# settings.json and the SessionStart role stamp live there. A corrupt roles.json must not
# take the hook wiring with it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PW="${REPO_ROOT}/src/shared/provider-workspace.mjs"
# The AST repo map is irrelevant to provider workspaces and is the most expensive thing
# a sync does; every `rein sync` below runs the full pipeline otherwise.
export REIN_DISABLE_REPO_MAP=1
AI="${REPO_ROOT}/src/bin/rein"

echo "── Suite: provider_workspace_test (E-244) ──────────────────────────"

# A project fixture: <architect-provider> <engineer-provider>, with the workspace dirs
# that exist named after them.
_proj() {  # <arch> <eng> [dirs-to-create...]
  local arch="$1" eng="$2"; shift 2
  local d; d="$(test_tmpdir e244)"
  mkdir -p "$d/.ai"
  cat > "$d/.ai/roles.json" <<JSON
{ "roles": { "architect": {"provider":"${arch}","pane_identifier":"1"},
             "engineer":  {"provider":"${eng}","pane_identifier":"0"} } }
JSON
  # The shipped template (claude only) plus one declared non-claude provider.
  python3 - "${REPO_ROOT}/src/templates/providers.json" "$d/.ai/providers.json" <<'PYJ'
import json, sys
p = json.load(open(sys.argv[1]))
p["providers"]["acme"] = {"workspace_dir": ".acme"}
json.dump(p, open(sys.argv[2], "w"), indent=2)
PYJ
  local x; for x in "$@"; do mkdir -p "$d/$x"; done
  printf '%s' "$d"
}

_classify() { ( cd "$1" && node "$PW" list .ai . 2>/dev/null ); }
_stale()    { ( cd "$1" && node "$PW" stale .ai . 2>/dev/null ); }

# ── E-244.1: classification follows .ai/roles.json ────────────────────────────
_all_claude="$(_proj claude claude .claude .acme)"
_c="$(_classify "$_all_claude")"
assert_contains "E-244.01a: claude is 'always' (hooks + settings live there)" \
  $'claude\t.claude\talways' "$_c"
assert_contains "E-244.01b: an unbound declared provider's workspace is STALE" \
  $'acme\t.acme\tstale' "$_c"

# Bound, it must classify exactly the other way, or the rule is just "delete .acme".
_split="$(_proj acme claude .claude .acme)"
_s="$(_classify "$_split")"
assert_contains "E-244.01d: with the Architect on acme, .acme/ is MAPPED, not stale" \
  $'acme\t.acme\tmapped' "$_s"
assert_status 1 "E-244.01e: and acme does not appear in the stale list" \
  bash -c "_o=\$(cd '$_split' && node '$PW' stale .ai . 2>/dev/null); printf '%s' \"\$_o\" | grep -q '^acme'"

# A directory that does not exist is not stale — there is nothing to clean up.
_none="$(_proj claude claude .claude)"
assert_status 1 "E-244.01f: an ABSENT workspace is never reported as stale" \
  bash -c "cd '$_none' && node '$PW' stale .ai . >/dev/null 2>&1"

# ── E-244.2: FAIL-SAFE — an unreadable roles.json prunes nothing ──────────────
# Deleting a live workspace because a config failed to parse is the one outcome this
# feature must never produce.
_corrupt="$(_proj claude claude .claude .acme)"
printf '{ "roles": { ' > "${_corrupt}/.ai/roles.json"
assert_status 1 "E-244.02a: a CORRUPT roles.json yields no stale workspaces" \
  bash -c "cd '$_corrupt' && node '$PW' stale .ai . >/dev/null 2>&1"
_missing="$(_proj claude claude .claude .acme)"
rm -f "${_missing}/.ai/roles.json"
assert_status 1 "E-244.02b: a MISSING roles.json yields no stale workspaces either" \
  bash -c "cd '$_missing' && node '$PW' stale .ai . >/dev/null 2>&1"
# And claude survives even when roles.json names nobody at all.
_empty="$(_proj claude claude .claude .acme)"
printf '{ "roles": {} }' > "${_empty}/.ai/roles.json"
assert_contains "E-244.02c: .claude/ is never stale, even with an EMPTY roles map" \
  $'claude\t.claude\talways' "$(_classify "$_empty")"
assert_status 1 "E-244.02d: and .claude is absent from the stale list" \
  bash -c "_o=\$(cd '$_empty' && node '$PW' stale .ai . 2>/dev/null); printf '%s' \"\$_o\" | grep -q '^claude'"

# ── E-244.3: THE PRUNE — evidence, not absence ───────────────────────────────
# The whole feature turns on this block. A sync-written, unmodified skill goes; a
# user-authored one beside it stays and is reported.
_pp="$(_proj claude claude .claude)"
mkdir -p "${_pp}/.acme/skills/synced-skill" "${_pp}/.acme/skills/my-own-skill"
printf '# synced\n' > "${_pp}/.acme/skills/synced-skill/SKILL.md"
printf '# mine\n'   > "${_pp}/.acme/skills/my-own-skill/SKILL.md"
# Record ONLY the synced one, the way a real sync would.
( cd "$_pp" && node "${REPO_ROOT}/src/shared/sync-manifest.mjs" record .acme/skills >/dev/null 2>&1 )
# Then make the user's skill un-recorded by rewriting the manifest without it.
python3 - "${_pp}/.acme/skills/_SYNC_MANIFEST.json" <<'PY'
import json, sys
p = sys.argv[1]
m = json.load(open(p))
m["entries"].pop("my-own-skill", None)
json.dump(m, open(p, "w"), indent=2)
PY
_pout="$( cd "$_pp" && bash "$AI" sync --prune-providers 2>&1 )"

assert_status 1 "E-244.03a: the sync-written skill is GONE" \
  test -d "${_pp}/.acme/skills/synced-skill"
# THE ASSERTION THIS FEATURE EXISTS TO SATISFY.
assert_status 0 "E-244.03b: the USER'S skill survives the prune" \
  test -f "${_pp}/.acme/skills/my-own-skill/SKILL.md"
assert_contains "E-244.03c: and the surviving directory is REPORTED, not silently left" \
  ".acme/ kept" "$_pout"
assert_contains "E-244.03d: the prune names the provider and the reason" \
  "no role is bound to 'acme'" "$_pout"

# With nothing left un-prunable, the directory itself goes.
_pq="$(_proj claude claude .claude)"
mkdir -p "${_pq}/.acme/skills/only-synced"
printf '# s\n' > "${_pq}/.acme/skills/only-synced/SKILL.md"
( cd "$_pq" && node "${REPO_ROOT}/src/shared/sync-manifest.mjs" record .acme/skills >/dev/null 2>&1 )
_qout="$( cd "$_pq" && bash "$AI" sync --prune-providers 2>&1 )"
assert_status 1 "E-244.03e: a fully-prunable workspace directory is removed" \
  test -d "${_pq}/.acme"
assert_contains "E-244.03f: and the removal is announced" ".acme/ removed" "$_qout"

# NO MANIFEST = NO EVIDENCE. A workspace sync has never recorded must survive whole.
_pr="$(_proj claude claude .claude)"
mkdir -p "${_pr}/.acme/skills/unrecorded"
printf '# u\n' > "${_pr}/.acme/skills/unrecorded/SKILL.md"
( cd "$_pr" && bash "$AI" sync --prune-providers >/dev/null 2>&1 )
assert_status 0 "E-244.03g: with NO manifest, nothing is pruned (first run has no evidence)" \
  test -f "${_pr}/.acme/skills/unrecorded/SKILL.md"

# A MAPPED provider's workspace is never touched BY THIS COMMAND. The skill here is
# deliberately USER-AUTHORED (never recorded), because a recorded skill that is no longer
# in the source set is prunable by ORDINARY sync (E-220) whether or not the provider is
# mapped — asserting on one would test E-220's rule, not this one, and would fail for a
# reason that has nothing to do with provider workspaces.
_pm="$(_proj acme claude .claude)"
mkdir -p "${_pm}/.acme/skills/live-skill"
printf '# live\n' > "${_pm}/.acme/skills/live-skill/SKILL.md"
( cd "$_pm" && bash "$AI" sync --prune-providers >/dev/null 2>&1 )
assert_status 0 "E-244.03h: a MAPPED provider's workspace is untouched by the prune" \
  test -f "${_pm}/.acme/skills/live-skill/SKILL.md"
assert_status 1 "E-244.03i: and acme is not even listed as stale while it holds a role" \
  bash -c "_o=\$(cd '$_pm' && node '$PW' stale .ai . 2>/dev/null); printf '%s' \"\$_o\" | grep -q '^acme'"

# ── E-244.4: the prune is EXPLICIT — a plain sync never deletes ───────────────
# A cleanup that happens on a command people run reflexively is an incident waiting.
_ps="$(_proj claude claude .claude)"
mkdir -p "${_ps}/.acme/skills/only-synced"
printf '# s\n' > "${_ps}/.acme/skills/only-synced/SKILL.md"
( cd "$_ps" && node "${REPO_ROOT}/src/shared/sync-manifest.mjs" record .acme/skills >/dev/null 2>&1 )
_plain="$( cd "$_ps" && bash "$AI" sync 2>&1 )"
assert_status 0 "E-244.04a: a PLAIN 'rein sync' deletes nothing" \
  test -f "${_ps}/.acme/skills/only-synced/SKILL.md"
assert_contains "E-244.04b: but it does SAY the workspace is stale" \
  "stale provider workspace: .acme/" "$_plain"
assert_contains "E-244.04c: and names the command that would remove it" \
  "rein sync --prune-providers" "$_plain"

# ── E-244.5 / E-254: provisioning is .claude/ and nothing else ───────────────
# v4 (D-069) has one adapter. A sync must provision .claude/ and must not invent a
# workspace for anything else — not for a retired vendor, and not for a declared provider
# that has no source adapter to fill it from.
_hidden_dirs() { ( cd "$1" && find . -mindepth 1 -maxdepth 1 -type d -name '.*' | sed 's|^\./||' | sort | tr '\n' ' ' ); }
_pv="$(_proj claude claude)"
( cd "$_pv" && bash "$AI" sync >/dev/null 2>&1 )
assert_status 0 "E-244.05c: .claude/ is provisioned (skills)" test -d "${_pv}/.claude/skills"
assert_status 0 "E-244.05c2: .claude/ is provisioned (agents)" test -d "${_pv}/.claude/agents"
_hd="$(_hidden_dirs "$_pv")"
assert_status 0 "E-254.05a: an all-Claude sync creates no workspace besides .ai/ and .claude/ (got: ${_hd})" \
  test "$_hd" = ".ai .claude "
# A role bound to a declared provider still gets no invented workspace: there is no
# source tree for it, and an empty directory would only look like a live workspace.
_pg="$(_proj acme claude)"
( cd "$_pg" && bash "$AI" sync >/dev/null 2>&1 )
assert_status 1 "E-254.05b: binding the Architect to a declared provider invents no .acme/" \
  test -d "${_pg}/.acme"
assert_status 0 "E-254.05d: and .claude/ is still provisioned for the Engineer" \
  test -d "${_pg}/.claude/skills"

# ── E-244.6 / E-254: one source adapter (D-069) ─────────────────────────────
# Both roles are served from src/claude/*; the registry's role manifest must name nothing
# outside claude/ and shared/, or sync would look for a tree that no longer ships.
assert_status 0 "E-254.06a: the Architect's skills ship under src/claude/skills" \
  test -f "${REPO_ROOT}/src/claude/skills/arch-task/SKILL.md"
assert_status 0 "E-254.06b: the Architect's agents ship under src/claude/agents" \
  test -f "${REPO_ROOT}/src/claude/agents/docs-architect.md"
assert_status 0 "E-254.06c: the role manifest names only claude/ and shared/ source dirs" \
  python3 -c "
import json,sys
r=json.load(open('${REPO_ROOT}/src/config/registry.json'))['roles']
dirs=[d for k,v in r.items() if isinstance(v,dict) for f in ('skill_dirs','agent_dirs') for d in v.get(f,[])]
sys.exit(0 if dirs and all(d.split('/')[0] in ('claude','shared') for d in dirs) else 1)"

# ── E-244.7: doctor reports it, and repairs nothing ──────────────────────────
_pd="$(_proj claude claude .claude .acme)"
_dout="$( cd "$_pd" && bash "$AI" doctor 2>&1 )"
assert_contains "E-244.07a: doctor reports the stale workspace" \
  "stale provider workspace: .acme/" "$_dout"
assert_status 0 "E-244.07b: and doctor does NOT remove it (diagnose ≠ repair)" \
  test -d "${_pd}/.acme"
_pdc="$(_proj claude claude .claude)"
_dcout="$( cd "$_pdc" && bash "$AI" doctor 2>&1 )"
assert_contains "E-244.07c: a clean project says so explicitly" \
  "every provider workspace present serves a bound role" "$_dcout"

# ── E-244.8: `git rev-parse` no longer aborts the script outside a repo ──────
# `GIT_HOOKS_DIR="$(git rev-parse --git-dir 2>/dev/null)/hooks"` is a PLAIN assignment,
# so under `set -euo pipefail` it carried git's exit 128 and killed the whole script —
# three lines above the "not a git repo" branch that was written to handle exactly this.
# That is the long-standing `rein init` exit-128 in a fresh directory.
_pn="$(test_tmpdir e244ng)"   # deliberately NOT a git repository
assert_status 0 "E-244.08a: 'rein init' completes in a NON-git directory (was exit 128)" \
  bash -c "cd '$_pn' && bash '$AI' init >/dev/null 2>&1"
assert_status 0 "E-244.08b: and it scaffolded .ai/ rather than dying first" \
  test -f "${_pn}/.ai/roles.json"
assert_status 0 "E-244.08c: the guard is the empty-string one, not a swallowed 128" \
  bash -c "sed -n '/^install_git_hooks() {/,/^}/p' '$AI' | grep -q 'git rev-parse --git-dir 2>/dev/null || true'"

# ── E-244.9: what became of the two defects this task found ─────────────────
# These began as pins: assertions holding a defect in place so it could not be quietly
# tidied away without a decision. D-067 ruled on both, so they now assert the RULING
# rather than the defect — a pin that outlives its subject starts protecting the wrong
# thing, and a stale one would have failed the moment E-247 landed. It did.
#
# (1) do_sync's unreachable second half → E-247 restored it under fail-open guards.
#     Reachability itself is asserted by rein_sync_test.sh, which reads the
#     OUTPUT of a real sync; a source-text assertion could not tell the difference
#     between "the call is present" and "the call runs" — that was the whole outage.
assert_status 1 "E-244.09a: the dead-code note is GONE — E-247 removed its subject" \
  bash -c "grep -q 'DELIBERATELY NOT FIXED HERE' '$AI'"
assert_status 0 "E-244.09b: and the steps run inside the .ai branch, before the return" \
  bash -c "sed -n '/^do_sync() {/,/^}/p' '$AI' | grep -q '_sync_step policy_report'"
assert_status 1 "E-244.09c: the policy note no longer word-splits (unquoted \$stale is gone)" \
  bash -c "grep -q \"printf '  %s..n' .stale\" '$AI'"

echo ""
assert_summary
if [[ "${FAIL_COUNT:-0}" -eq 0 ]]; then
  echo "===== provider_workspace_test.sh PASS ====="
else
  echo "===== provider_workspace_test.sh FAIL (${FAIL_COUNT}) ====="
fi
