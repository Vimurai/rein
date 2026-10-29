#!/usr/bin/env bash
# REIN_INSTALLER_SUBJECT: the installer writes the exec-form hook commands (E-311, D-092)
# exec_form_hooks_test.sh — E-290 (D-081 r1, D-083 r1–4; THREAT_MODEL T-HOOKENV-002).
#
# The E-286 pin lives INSIDE the hook file, so four channels that belong to the SHELL
# running the hook act before or around it: BASH_ENV, an exported function (it can shadow
# `unset` itself, defeating the prologue), SHELLOPTS=xtrace + PS4='$(…)', and a decoy
# `bash` on PATH. E-290 runs every hook as the documented EXEC form — no shell — under
# `/bin/bash -p`. Each fixture below leaves a marker under the OLD command line (proving the
# gap) and none under the NEW argv `/bin/bash -p <absolute hook>` — the shape E-290.01a
# asserts the generator writes (the fixture types that argv; 01a is the link).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
source "${SCRIPT_DIR}/../lib/generated-settings.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AI_BIN="${REPO_ROOT}/src/bin/ai"
INSTALL="${REPO_ROOT}/install-rein.sh"

echo "── Suite: exec_form_hooks_test (E-290) ──────────────────────────────"

skip_unless_cmd python3 "E-290 exec-form hooks" || { assert_summary; exit 0; }
[[ -x /bin/bash ]] || { _skip "E-290: this host has no /bin/bash"; assert_summary; exit 0; }

# The harness prefix (E-312): the installer's HOME under it is this suite's own, which lets the
# runner place it in a shared lane; a bare mktemp -d HOME reads as foreign.
T="$(test_tmpdir efh)"
T="$(cd -P "$T" && pwd -P)"

# ── E-290.1: generated settings — six exec-form entries, old forms removed ─────
P="$T/proj"; mkdir -p "$P/.claude"
cat > "$P/.claude/settings.json" <<'JSON'
{ "hooks": {
  "Stop": [ { "matcher": ".*", "hooks": [
     { "type": "command", "command": "bash $HOME/.rein/hooks/stop-hook.sh" },
     { "type": "command", "command": "echo users-own-stop-hook" } ] } ],
  "PreToolUse": [ { "matcher": "Bash", "hooks": [
     { "type": "command", "command": "bash $HOME/.rein/hooks/pre-tool-use.sh" },
     { "type": "command", "command": "bash \"$HOME/.rein/hooks/pre-tool-use.sh\"" } ] } ] } }
JSON
SET="$(gen_project_settings "$P")"
_entries() { python3 - "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for ev, lst in d.get("hooks", {}).items():
    for e in lst:
        for h in e.get("hooks", []):
            print("%s\t%s\t%s\t%s\t%s" % (ev, e.get("matcher"), h.get("command"),
                  "|".join(h.get("args") or []), h.get("timeout", "")))
PY
}
E="$(_entries "$SET")"
for spec in "Stop:stop-hook.sh" "PreToolUse:pre-tool-use.sh" "SessionStart:session-start.sh" \
            "PostToolUse:post-tool-log.sh" "PostToolUse:post-tool-use.sh" "PermissionDenied:permission-denied.sh"; do
  ev="${spec%%:*}"; sc="${spec#*:}"
  assert_match "E-290.01a: ${sc} is exec-form /bin/bash -p <absolute path> with timeout 30" \
    "^${ev}	[^	]*	/bin/bash	-p\|/[^	]*/\.rein/hooks/${sc}(\|engineer)?	30$" "$E"
done
assert_status 1 "E-290.01b: no shell-form Rein line survives (incl. a quoted path)" bash -c "printf '%s\n' \"\$1\" | grep -q 'bash .*HOME/.rein/hooks'" _ "$E"
assert_contains "E-290.01c: the user's own hook entry is untouched" "echo users-own-stop-hook" "$E"
assert_status 1 "E-290.01d: no Rein hook line mentions \$HOME" bash -c "printf '%s\n' \"\$1\" | grep '.rein/hooks' | grep -qF '\$HOME'" _ "$E"
cp "$SET" "$T/s1"; ( cd "$P" && REIN_DISABLE_REPO_MAP=1 bash "$AI_BIN" sync >/dev/null 2>&1 )
assert_status 0 "E-290.01e: a second sync is byte-identical (idempotent)" cmp -s "$T/s1" "$SET"

# ── E-290.2: the four shell channels — marker under OLD line, none under NEW argv ─
# A fake HOME whose mirror holds the checkout's hooks + shared tree, so both lines run the
# same hook file; the only difference is HOW it is launched.
FH="$T/home"; mkdir -p "$FH/.rein"
tc_fixture_home "$FH"   # E-345 (D-109 r1): the toolchain record the hooks pin
cp -R "${REPO_ROOT}/hooks" "$FH/.rein/hooks"; cp -R "${REPO_ROOT}/src/shared" "$FH/.rein/shared"
NEW_HOOK="$FH/.rein/hooks/post-tool-log.sh"     # fail-open, quick: payload `{}` does nothing
M="$T/markers"; mkdir -p "$M" "$T/decoy"
printf '#!/bin/sh\ntouch "%s/decoy-bash"\nexec /bin/bash "$@"\n' "$M" > "$T/decoy/bash"; chmod +x "$T/decoy/bash"
printf 'touch "%s/bash-env"\n' "$M" > "$T/bashenv.sh"
_marks() { ls "$M" 2>/dev/null | tr '\n' ' '; }
_old() {  # <env assignments…> — the pre-E-290 command line, run as Claude Code ran it: sh -c
  ( cd "$T" && printf '{}' | env -i HOME="$FH" PATH="$T/decoy:/usr/bin:/bin" "$@" \
      /bin/sh -c 'bash $HOME/.rein/hooks/post-tool-log.sh' >/dev/null 2>&1 )
}
_new() {  # <env assignments…> — the exec-form argv: no shell, /bin/bash -p, absolute path
  ( cd "$T" && printf '{}' | env -i HOME="$FH" PATH="$T/decoy:/usr/bin:/bin" "$@" \
      /bin/bash -p "$NEW_HOOK" >/dev/null 2>&1 )
}
_case() {  # <label> <marker> <env assignments…>
  local label="$1" mk="$2"; shift 2
  rm -f "$M"/*; _old "$@"
  assert_status 0 "E-290.02 [${label}]: the OLD shell-form line is hijacked (marker '${mk}'; got: $(_marks))" test -f "$M/$mk"
  rm -f "$M"/*; _new "$@"
  assert_status 0 "E-290.02 [${label}]: the NEW exec-form argv leaves NO marker (got: $(_marks))" test -z "$(_marks)"
}
_case "decoy bash on PATH" decoy-bash
_case "BASH_ENV" bash-env BASH_ENV="$T/bashenv.sh"
# The OLD line reaches bash through two /bin/sh hops (sh -c, the #!/bin/sh decoy). dash drops
# BASH_FUNC_* entries — not valid variable names — so where /bin/sh is not bash this channel
# does not exist for the old line (E-332, Linux); the exec-form row still runs everywhere.
if /bin/sh -c 'case "$BASH_VERSION" in "") exit 1;; esac' 2>/dev/null; then
  _case "exported function shadowing unset" fn-unset "BASH_FUNC_unset%%=() { touch $M/fn-unset; builtin unset \"\$@\"; }"
else
  _skip "E-290.02 [exported function shadowing unset]: OLD line — /bin/sh here is not bash; it drops BASH_FUNC_* before bash starts"
  # Positive control (critic_security P3-2): the same function DOES fire under /bin/bash
  # without -p, so the exec-form row below proves -p, not a channel that never opened.
  rm -f "$M"/*
  ( cd "$T" && printf '{}' | env -i HOME="$FH" PATH="$T/decoy:/usr/bin:/bin" \
      "BASH_FUNC_unset%%=() { touch $M/fn-unset; builtin unset \"\$@\"; }" /bin/bash "$NEW_HOOK" >/dev/null 2>&1 )
  assert_status 0 "E-290.02 [exported function shadowing unset]: control — /bin/bash WITHOUT -p is hijacked (got: $(_marks))" test -f "$M/fn-unset"
  rm -f "$M"/*; _new "BASH_FUNC_unset%%=() { touch $M/fn-unset; builtin unset \"\$@\"; }"
  assert_status 0 "E-290.02 [exported function shadowing unset]: the NEW exec-form argv leaves NO marker (got: $(_marks))" test -z "$(_marks)"
fi
_case "SHELLOPTS=xtrace + PS4" ps4 SHELLOPTS=xtrace "PS4=\$(touch $M/ps4)"
# Why exec form and not merely `/bin/bash -p` on a shell-form line: the outer sh runs PS4.
if /bin/sh -c 'case "$BASH_VERSION" in "") exit 1;; esac' 2>/dev/null; then
  rm -f "$M"/*
  ( cd "$T" && printf '{}' | env -i HOME="$FH" PATH=/usr/bin:/bin SHELLOPTS=xtrace "PS4=\$(touch $M/ps4-shellform)" \
      /bin/sh -c "/bin/bash -p '$NEW_HOOK'" >/dev/null 2>&1 )
  assert_status 0 "E-290.02e: a SHELL-form '/bin/bash -p' line is still hijacked via PS4 (why exec form)" test -f "$M/ps4-shellform"
else
  _skip "E-290.02e: /bin/sh here is not bash (e.g. dash) — the shell-form PS4 channel does not exist on this host"
fi

# ── E-290.3: git stubs run privileged bash by absolute path ─────────────────
G="$T/gitproj"; mkdir -p "$G"; ( cd "$G" && git init -q && printf '#!/bin/sh\nexit 0\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit )
gen_project_settings "$G" >/dev/null
for stub in pre-commit pre-push post-commit; do
  f="$G/.git/hooks/${stub}"
  assert_status 0 "E-290.03a: ${stub} stub shebang is #!/bin/bash -p" bash -c "head -1 '$f' | grep -qx '#!/bin/bash -p'"
  assert_status 0 "E-290.03b: ${stub} stub runs the canonical via /bin/bash -p" grep -q '/bin/bash -p "\$CANONICAL"' "$f"
  assert_status 1 "E-290.03c: ${stub} stub never names \$HOME for the canonical" grep -q 'CANONICAL="\$HOME' "$f"
done
assert_status 0 "E-290.03d: a chained user hook also runs under /bin/bash -p" grep -q '/bin/bash -p "\$USER_HOOK"' "$G/.git/hooks/pre-commit"

# ── E-290.4: gitignore + doctor ─────────────────────────────────────────────
printf '.vscode/settings.json\n' > "$G/.gitignore"
gen_project_settings "$G" >/dev/null
assert_status 0 "E-290.04a: .claude/settings.json is gitignored even beside another dir/settings.json line" \
  grep -qx '.claude/settings.json' "$G/.gitignore"
_d="$(cd "$G" && bash "$AI_BIN" doctor 2>&1)"
assert_contains "E-290.04b: doctor reports the exec form" "Rein hooks in exec form" "$_d"
python3 - "$G/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["hooks"]["Stop"].append({"matcher": ".*", "hooks": [{"type": "command", "command": "bash $HOME/.rein/hooks/stop-hook.sh"}]})
json.dump(d, open(p, "w"))
PY
_d="$(cd "$G" && bash "$AI_BIN" doctor 2>&1)"
assert_contains "E-290.04c: doctor names a stale shell-form entry and the fix" "stale Rein hook entries" "$_d"
# A pre-E-290 stub: the stub marker the generator writes, under the old shebang.
_marker="$(grep -m1 'Rein' "$G/.git/hooks/post-commit")"
printf '#!/usr/bin/env bash\n%s\n' "$_marker" > "$G/.git/hooks/post-commit"
_d="$(cd "$G" && bash "$AI_BIN" doctor 2>&1)"
assert_contains "E-290.04d: doctor names a stub that predates E-290" "git post-commit stub predates E-290" "$_d"

# ── E-290.5: every hook's prologue clears what -p leaves alone ───────────────
for h in "${REPO_ROOT}"/hooks/*.sh; do
  assert_status 0 "E-290.05: ${h##*/} unsets POSIXLY_CORRECT and BASH_COMPAT" grep -q 'POSIXLY_CORRECT|BASH_COMPAT) unset' "$h"
done

# ── E-290.6: the installer refuses the hooks without a privileged /bin/bash ──
SB="$T/install"; mkdir -p "$SB/home"
( cd "$SB" && env HOME="$SB/home" _REIN_TEST_HOOK_BASH="$SB/no-such-bash" REIN_SKIP_NODE_CHECK=1 bash "$INSTALL" ) \
  >"$SB/out" 2>"$SB/err"; rc=$?
assert_status 0 "E-290.06a: the installer exits non-zero when /bin/bash is unusable (rc=${rc})" test "$rc" -ne 0
assert_contains "E-290.06b: with the named error" "[HOOK_BASH_MISSING]" "$(cat "$SB/err")"
assert_status 1 "E-290.06c: and NO hook was installed" bash -c "compgen -G '$SB/home/.rein/hooks/*.sh' >/dev/null"   # not ls: GNU exits 2, BSD 1
assert_status 0 "E-290.06d: the rest of the install still ran (version stamp written)" test -f "$SB/home/.rein/VERSION"

assert_summary
