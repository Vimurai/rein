#!/usr/bin/env bash
# classifier_backstop_test.sh — E-293 (D-083 r5(iii), D-086): `ai install` OFFERS one
# autoMode.hard_deny rule in the operator's ~/.claude/settings.json; `ai doctor` reports it.
#
# Every case runs against a throwaway HOME — never the operator's settings. The helper
# (src/shared/classifier-backstop.py) is exercised directly for the JSON contract; the bash
# glue (_classifier_offer / _classifier_report, sourced from src/bin/ai) under a pseudo-terminal
# from script(1), because the offer must never prompt without one.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"
source "${SCRIPT_DIR}/../lib/toolchain-fixture.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PY="${REPO_ROOT}/src/shared/classifier-backstop.py"

echo "── Suite: classifier_backstop_test (E-293) ──────────────────────────"

skip_unless_cmd python3 "E-293 classifier backstop" || { assert_summary; exit 0; }
# The in-process imports below would write src/shared/__pycache__ (which the installer would then
# mirror) — critic_tests P1. Set here, in the suite's own text, for its own python3 calls only.
export PYTHONDONTWRITEBYTECODE=1

T="$(mktemp -d)"; on_exit "rm -rf '$T'"
T="$(cd -P "$T" && pwd -P)"
_home() { rm -rf "$T/h"; mkdir -p "$T/h/.claude"; S="$T/h/.claude/settings.json"; tc_fixture_home "$T/h"; }   # E-345: the record the hooks pin
_sha() { [[ -e "$1" ]] && shasum -a 256 "$1" | cut -d' ' -f1 || echo none; }
_hd() { python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["autoMode"]["hard_deny"]))' "$1"; }
RULE="$(python3 -c 'import importlib.util,sys; s=importlib.util.spec_from_file_location("cb", sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.RULE)' "$PY")"

# ── E-293.01 / E-306 / E-318 / E-324: the constant is the CURRENT ruling's text, verbatim (D-101) ──
_ruling() {  # <D-###> → that ruling's "AI-OS Gate Tamper (D-###): …" paragraph — a "> " quote (D-086..D-097)
             # or an indented fenced block (D-101)
  python3 - "${REPO_ROOT}/.ai/DECISIONS.md" "$1" <<'PY'
import re, sys
t = open(sys.argv[1], encoding="utf-8").read(); d = sys.argv[2]
# The ruling's OWN section only (critic_security P2): header anchored so D-101 never matches
# D-1010, slice ends at the next "## ", so a later ruling quoting the text cannot stand in.
h = re.search(r"^## " + d + r"\b", t, re.M)
sec = t[h.start():] if h else ""
nxt = sec.find("\n## ", 1)
m = re.search(r"^(?:> |[ \t]+)(AI-OS Gate Tamper \(" + d + r"\): .*)$", sec[:nxt] if nxt > 0 else sec, re.M)
print(m.group(1) if m else "")
PY
}
D101="$(_ruling D-101)"; D097="$(_ruling D-097)"; D086="$(_ruling D-086)"
assert_status 0 "E-306.01a: D-101's quoted rule was found (${#D101} chars)" test "${#D101}" -gt 500
assert_status 0 "E-306.01b: RULE in the helper equals D-101's paragraph byte-for-byte" test "$RULE" = "$D101"
assert_status 0 "E-306.01c: …same sha256" test "$(printf '%s' "$RULE" | shasum -a 256 | cut -c1-64)" = "$(printf '%s' "$D101" | shasum -a 256 | cut -c1-64)"
assert_status 0 "E-324.01a: …and it is NOT D-097's paragraph (the pin moved with the ruling)" test "$RULE" != "$D097"
assert_status 0 "E-324.01b: D-101 = D-097 with exactly two changes: the label, and 'ai watch' out of Exempt" python3 - "$D097" "$D101" <<'PY'
import sys
old, new = sys.argv[1], sys.argv[2]
assert "`ai watch`" in old and "`ai watch`" not in new
assert old.replace("(D-097)", "(D-101)", 1).replace("`ai pane`, `ai watch`, ", "`ai pane`, ", 1) == new
PY
assert_status 0 "E-318.01a: the superseded D-097 paragraph is still found (the refresh rows below need it)" test "${#D097}" -gt 500
assert_contains "E-318.01b: D-101 names the account registry" '~/.ai-os/accounts.json' "$D101"  # D-101 as ruled (pre-rename path)
assert_contains "E-318.01c: …and exempts ai account" '`ai account`' "$D101"
assert_status 0 "E-306.01d: the superseded D-086 paragraph is still found (the replacement fixture below needs it)" test "${#D086}" -gt 500

# ── E-293.02: no autoMode → exactly "$defaults" + the rule ────────────────────────────
_home
printf '{\n  "model": "opus"\n}\n' > "$S"
python3 -I "$PY" apply "$S" >/dev/null; rc=$?
assert_status 0 "E-293.02a: apply on a file with no autoMode succeeds (rc=${rc})" test "$rc" -eq 0
want="$(python3 -c 'import json,sys; print(json.dumps(["$defaults", sys.argv[1]]))' "$RULE")"
assert_status 0 "E-293.02b: hard_deny is exactly [\"\$defaults\", rule]" test "$(_hd "$S")" = "$want"
assert_status 0 "E-293.02c: the other keys are untouched" \
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["model"]=="opus" and set(d)=={"model","autoMode"} and set(d["autoMode"])=={"hard_deny"}' "$S"
# No file at all (the directory exists) → created 0600 with the same content.
_home
python3 -I "$PY" apply "$S" >/dev/null
assert_status 0 "E-293.02d: an absent settings.json is created with [\"\$defaults\", rule]" test "$(_hd "$S")" = "$want"
_m="$(file_mode "$S")"
assert_status 0 "E-293.02e: …mode 600 (got ${_m})" test "$_m" = "600"

# ── E-293.03: existing lists keep every entry byte-identical; only the rule is added ─────
_home
cat > "$S" <<'JSON'
{
  "permissions": {
    "defaultMode": "auto"
  },
  "autoMode": {
    "environment": [
      "Trusted repo — github.com/me/x (non-ASCII kept: ü, 🔒)"
    ],
    "allow": [
      "$defaults",
      "Local builds: running make in this repo"
    ],
    "soft_deny": [
      "$defaults",
      "Prod deploys: anything touching prod"
    ],
    "hard_deny": [
      "$defaults",
      "Mine: never touch ~/secrets"
    ]
  }
}
JSON
cp "$S" "$T/orig"
python3 -I "$PY" plan "$S" > "$T/plan"; rc=$?
assert_status 0 "E-293.03a: plan says CHANGE, formatting NOT normalised for Claude-shaped JSON (rc=${rc})" \
  test "$rc" -eq 0 -a "$(sed -n 1p "$T/plan")" = "$(printf 'CHANGE\t0')"
python3 -I "$PY" apply "$S" >/dev/null
assert_status 0 "E-293.03b: every pre-existing value is identical; hard_deny gained ONLY the rule at the end" python3 - "$T/orig" "$S" "$RULE" <<'PY'
import json, sys
a, b, rule = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), sys.argv[3]
assert b["autoMode"]["hard_deny"] == a["autoMode"]["hard_deny"] + [rule]
b["autoMode"]["hard_deny"] = b["autoMode"]["hard_deny"][:-1]
assert a == b
PY
assert_status 0 "E-293.03c: …and the bytes of the file are the original plus the one inserted line" python3 - "$T/orig" "$S" <<'PY'
import sys
a, b = open(sys.argv[1], encoding="utf-8").read().splitlines(), open(sys.argv[2], encoding="utf-8").read().splitlines()
# Adding an entry gives the previous last entry a trailing comma; compare with commas stripped.
a2, b2 = [l.rstrip(",") for l in a], [l.rstrip(",") for l in b]
extra = [l for l in b2 if l not in a2]
assert len(b2) == len(a2) + 1 and len(extra) == 1 and extra[0].strip().startswith('"AI-OS Gate Tamper (D-101)'), extra
assert [l for l in b2 if l != extra[0]] == a2
PY
assert_status 0 "E-293.03d: one .bak beside the file, equal to the original" cmp -s "$S.bak" "$T/orig"
_bm="$(file_mode "$S.bak")"
assert_status 0 "E-293.03d2: the .bak is 0600 (got ${_bm})" test "$_bm" = "600"
# A pre-planted .bak symlink is never followed (critic_security: O_EXCL|O_NOFOLLOW / lexists).
_home; printf '{}\n' > "$S"; printf 'victim\n' > "$T/victim"; ln -s "$T/victim" "$S.bak"
python3 -I "$PY" apply "$S" >/dev/null
assert_status 0 "E-293.03d3: a planted .bak symlink's target is left alone" test "$(cat "$T/victim")" = "victim"
rm -f "$T/victim"
# D-086 r2: an existing list WITHOUT "$defaults" keeps that shape.
_home
printf '{\n  "autoMode": {\n    "hard_deny": [\n      "Mine: x"\n    ]\n  }\n}\n' > "$S"
python3 -I "$PY" apply "$S" >/dev/null
want="$(python3 -c 'import json,sys; print(json.dumps(["Mine: x", sys.argv[1]]))' "$RULE")"
assert_status 0 "E-293.03e: a list without \$defaults gets only the rule (no \$defaults added)" test "$(_hd "$S")" = "$want"
# Idempotent: a second apply changes nothing (not even the mtime).
_mt="$(python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_mtime_ns)' "$S")"
python3 -I "$PY" apply "$S" >/dev/null; rc=$?
assert_status 0 "E-293.03f: a second apply is NOCHANGE (rc=${rc})" test "$rc" -eq 1
assert_status 0 "E-293.03g: …and does not touch the file" \
  test "$_mt" = "$(python3 -c 'import os,sys; print(os.stat(sys.argv[1]).st_mtime_ns)' "$S")"
# An OUTDATED copy (same label, other text) is replaced in place, never duplicated.
python3 - "$S" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["autoMode"]["hard_deny"][1] = "AI-OS Gate Tamper: an older wording"
open(p, "w").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
PY
assert_contains "E-293.03h: an older labelled copy reads OUTDATED" "OUTDATED" "$(python3 -I "$PY" status "$S")"
python3 -I "$PY" apply "$S" >/dev/null
assert_status 0 "E-293.03i: …and is replaced in place (still 2 entries, the current rule second)" test "$(_hd "$S")" = "$want"

# ── E-293.04: malformed files are left untouched with a named error ───────────────────
_bad() {  # <label> <content> <expected error fragment>
  _home; printf '%s' "$2" > "$S"; local sha; sha="$(_sha "$S")"
  local out rc=0; out="$(python3 -I "$PY" apply "$S")" || rc=$?
  assert_status 0 "E-293.04: $1 → refused rc 3 (rc=${rc})" test "$rc" -eq 3
  assert_contains "E-293.04: $1 → named error" "$3" "$out"
  assert_status 0 "E-293.04: $1 → file untouched, no .bak" test "$(_sha "$S")" = "$sha" -a ! -e "$S.bak"
}
_bad "JSONC comment" $'{\n  // note\n  "a": 1\n}\n' "Claude Code itself silently ignore this whole file"
_bad "trailing comma" $'{\n  "a": [1,],\n}\n' "not valid JSON"
_bad "duplicate key" '{"a": 1, "a": 2}' "duplicate key 'a'"
_bad "NaN" '{"a": NaN}' "non-JSON number NaN"
_bad "array root" '[1]' "top level is not an object"
_bad "autoMode not an object" '{"autoMode": []}' "autoMode is not an object"
_bad "hard_deny not a list" '{"autoMode": {"hard_deny": "x"}}' "hard_deny is not a list of strings"
_bad "hard_deny with a number" '{"autoMode": {"hard_deny": ["$defaults", 3]}}' "hard_deny is not a list of strings"
# critic_security P1: an overflowing float would be written as `Infinity` — Claude Code would then
# ignore the WHOLE file (hooks, permissions, autoMode). Underflow would silently change a value.
_bad "float overflow (1e400)" '{"x": 1e400}' "out of range (it would be written as Infinity)"
_bad "float underflow (1e-400)" '{"x": 1e-400}' "underflows to 0"
# critic_security P2: encoding errors are refusals, never rc 1 (= "no change / present").
_bad "lone surrogate" '{"u": "\ud800"}' "cannot be written back unchanged"
_home; printf '{"a":"\xff"}' > "$S"; sha="$(_sha "$S")"
out="$(python3 -I "$PY" apply "$S")"; rc=$?
assert_status 0 "E-293.04: invalid UTF-8 → refused rc 3, untouched (rc=${rc})" test "$rc" -eq 3 -a "$(_sha "$S")" = "$sha"
assert_contains "E-293.04: invalid UTF-8 → named error" "not valid UTF-8" "$out"
# An unexpected failure gets its own code (6), never 1.
_home; printf '{}\n' > "$S"; chmod 000 "$S"
out="$(python3 -I "$PY" status "$S")"; rc=$?
chmod 600 "$S"
assert_status 0 "E-293.04: an unreadable file → ERROR rc 6, not 1 (rc=${rc})" test "$rc" -eq 6
assert_contains "E-293.04: …with an ERROR line" "ERROR" "$out"
# A plain float that round-trips is kept (not refused).
_home; printf '{\n  "x": 1.5\n}\n' > "$S"
python3 -I "$PY" apply "$S" >/dev/null; rc=$?
assert_status 0 "E-293.04: an ordinary float is fine (rc=${rc})" test "$rc" -eq 0
assert_contains "E-293.04: …and kept as 1.5" '"x": 1.5' "$(cat "$S")"

# ── E-293.05: symlinks, hard links, a missing ~/.claude ─────────────────────────────
_home; mkdir -p "$T/dots"; printf '{}\n' > "$T/dots/settings.json"; ln -s "$T/dots/settings.json" "$S"
python3 -I "$PY" apply "$S" >/dev/null
assert_status 0 "E-293.05a: a symlinked settings.json is written THROUGH (link kept)" test -L "$S"
assert_contains "E-293.05b: …the target carries the rule" "AI-OS Gate Tamper (D-101)" "$(cat "$T/dots/settings.json")"
rm -f "$T/dots/settings.json" "$T/dots/settings.json.bak"
out="$(python3 -I "$PY" apply "$S")"
assert_contains "E-293.05c: a dangling symlink is refused" "dangling symlink" "$out"
_home; printf '{}\n' > "$S"; ln "$S" "$T/hardlink"
out="$(python3 -I "$PY" apply "$S")"
assert_contains "E-293.05d: a hard-linked settings.json is refused" "more than one hard link" "$out"
rm -f "$T/hardlink"
out="$(python3 -I "$PY" plan "$T/nohome/.claude/settings.json")"; rc=$?
assert_status 0 "E-293.05e: no ~/.claude at all → NODIR, nothing created (rc=${rc})" test "$rc" -eq 5 -a ! -e "$T/nohome"

# ── E-293.06: concurrent change between read and rename → nothing written ──────────────
_home; printf '{}\n' > "$S"
out="$(python3 - "$PY" "$S" <<'PY'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("cb", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
real = m._plan
def racing(path):
    p = real(path)
    with open(path, "a") as f: f.write(" ")     # another writer lands after our read
    return p
m._plan = racing
sys.exit(m.cmd_apply(sys.argv[2]))
PY
)"; rc=$?
assert_status 0 "E-293.06a: a concurrent write aborts the apply (rc 4, got ${rc})" test "$rc" -eq 4
assert_status 0 "E-293.06b: …the other writer's content stands, no rule written, no temp left" \
  bash -c "! grep -q 'AI-OS Gate Tamper' '$S' && ! ls '$T/h/.claude/'.settings.*.tmp >/dev/null 2>&1"

# ── E-293.07: the `ai install` offer (bash glue) ──────────────────────────────────────
# The offer runs only with a terminal on stdin. Python's pty module gives it one, waits for
# the [y/N] prompt to APPEAR before typing the answer, and reads until EOF — deterministic.
# (A script(1) harness was tried first: it lost the session depending on how the suite's own
# stdio was wired, and a bare `printf | script` lost the answer, so N cases passed vacuously.)
cat > "$T/pty-drive.py" <<'PY'
import os, pty, select, sys, time
answer, cmd = sys.argv[1], sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", "-c", cmd])
buf, sent, deadline = b"", False, time.time() + 60
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if fd not in r:
        continue
    try:
        data = os.read(fd, 4096)
    except OSError:          # EIO: the child closed the pty
        break
    if not data:
        break
    buf += data
    if not sent and b"[y/N]" in buf:
        os.write(fd, (answer + "\n").encode())
        sent = True
if time.time() >= deadline:
    os.kill(pid, 9)          # never hang the suite on a lost answer (critic_tests P2)
os.waitpid(pid, 0)
sys.stdout.write(buf.decode("utf-8", "replace").replace("\r", ""))
PY
_pty() {  # <answer> — run _classifier_offer on a pty with HOME=$T/h, answer typed at the prompt
  python3 -I "$T/pty-drive.py" "$1" "cd '$T' && unset CI REIN_CI && HOME='$T/h' bash -c 'source \"${REPO_ROOT}/src/bin/ai\" >/dev/null 2>&1; _cb_py() { printf %s \"${PY}\"; }; _classifier_offer; echo OFFER_DONE'"
}
if true; then   # python3 (required above) provides the pty
  for ans in n "" maybe; do
    _home; printf '{\n  "a": 1\n}\n' > "$S"; sha="$(_sha "$S")"
    out="$(_pty "$ans")"
    assert_contains "E-293.07a: the offer prompts [y/N] (answer '${ans}')" "Add the classifier backstop? [y/N]" "$out"
    assert_contains "E-293.07b0: answer '${ans}' was read (the offer reports skipped)" "classifier backstop: skipped" "$out"
    assert_contains "E-293.07b1: …the pty echoed '${ans}' right after the prompt" "[y/N] ${ans}"$'\n' "$out"
    assert_status 0 "E-293.07b: answer '${ans}' changes nothing" test "$(_sha "$S")" = "$sha" -a ! -e "$S.bak"
  done
  _home; printf '{\n  "a": 1\n}\n' > "$S"
  out="$(_pty y)"
  assert_contains "E-293.07c: 'y' adds it and points at critique" "claude auto-mode critique" "$out"
  assert_contains "E-293.07d: …and the file now has the rule" "AI-OS Gate Tamper (D-101)" "$(cat "$S")"
  out="$(_pty y)"
  assert_contains "E-293.07e: with the rule present there is no prompt" "Classifier backstop present" "$out"
  assert_contains "E-293.07e0: …the offer ran to completion" "OFFER_DONE" "$out"
  assert_not_contains "E-293.07f: …no [y/N]" "[y/N]" "$out"
  _home; printf '{ // c\n}\n' > "$S"; sha="$(_sha "$S")"
  out="$(_pty y)"
  assert_contains "E-293.07g: a JSONC file is reported, not prompted for" "left untouched" "$out"
  assert_status 0 "E-293.07h: …and stays byte-identical" test "$(_sha "$S")" = "$sha"
  # No ~/.claude at all → a pointer, no prompt, nothing created.
  rm -rf "$T/h"; mkdir -p "$T/h"
  out="$(_pty y)"
  assert_contains "E-293.07k: no ~/.claude → told to run Claude Code once" "~/.claude does not exist yet" "$out"
  assert_status 0 "E-293.07l: …and nothing is created" test ! -e "$T/h/.claude"
fi
assert_status 0 "E-293.07m: install_global calls _classifier_offer" \
  bash -c "awk '/^install_global\\(\\) \\{/,/^}/' '${REPO_ROOT}/src/bin/ai' | grep -q '^  _classifier_offer$'"
# Without a terminal / under CI: never prompts, never writes.
for envset in "" "CI=1" "REIN_CI=local"; do
  _home; printf '{}\n' > "$S"; sha="$(_sha "$S")"
  out="$(printf 'y\n' | env HOME="$T/h" ${envset:+"$envset"} bash -c "source '${REPO_ROOT}/src/bin/ai' >/dev/null 2>&1; _cb_py() { printf %s '${PY}'; }; _classifier_offer" 2>&1)"
  assert_not_contains "E-293.07i: no terminal${envset:+ + ${envset}} → no prompt" "[y/N]" "$out"
  assert_status 0 "E-293.07j: no terminal${envset:+ + ${envset}} → file unchanged even with 'y' on stdin" test "$(_sha "$S")" = "$sha"
done

# ── E-293.08: ai doctor lines ──────────────────────────────────────────────────────
_doctor() { env HOME="$T/h" bash -c "source '${REPO_ROOT}/src/bin/ai' >/dev/null 2>&1; _cb_py() { printf %s '${PY}'; }; _classifier_report" 2>&1; }
_home; printf '{}\n' > "$S"
assert_contains "E-293.08a: not configured" "○ classifier backstop: not configured — ai install offers it" "$(_doctor)"
python3 -I "$PY" apply "$S" >/dev/null
assert_contains "E-293.08b: present" "✓ classifier backstop: present" "$(_doctor)"
assert_contains "E-293.08c: the effective default mode is reported" "default permission mode: default" "$(_doctor)"
_home; printf '{\n  "a": 1,\n}\n' > "$S"
assert_contains "E-293.08d: unparsable → Claude Code ignores it, no autoMode active" "NO autoMode rules are active" "$(_doctor)"
_home; printf '{"permissions": {"allow": ["Bash(ai gate:*)"], "defaultMode": "auto"}, "autoMode": {"hard_deny": ["x"]}}\n' > "$S"
out="$(_doctor)"
assert_contains "E-293.08e: a Bash(ai… allow rule is warned about" "allow rules are resolved BEFORE the classifier" "$out"
assert_contains "E-293.08f: a list without \$defaults is reported (D-086 r2)" 'hard_deny omits "$defaults"' "$out"
assert_contains "E-293.08g: auto mode reported without the hook-only caveat" "default permission mode: auto" "$out"
assert_not_contains "E-293.08h: …and no 'only gate' caveat in auto mode" "the hook is the only gate" "$out"
_home; printf '{"autoMode": {"hard_deny": ["AI-OS Gate Tamper: older text"]}}\n' > "$S"
assert_contains "E-293.08j: an outdated copy is reported" "outdated wording — ai install offers the current rule" "$(_doctor)"

# ── E-306: an installed older rule (D-086) is replaced IN PLACE by the current one — exactly one Rein rule ──
_home
python3 - "$S" "$D086" <<'PY'
import json, sys
json.dump({"permissions": {"defaultMode": "auto"},
           "autoMode": {"hard_deny": ["$defaults", "keep-before", sys.argv[2], "keep-after"],
                        "soft_deny": ["$defaults", "mine"]}},
          open(sys.argv[1], "w"), indent=2, ensure_ascii=False)
PY
assert_contains "E-306.02a: an installed D-086 rule reads OUTDATED and names its ruling" $'OUTDATED\tD-086' "$(python3 -I "$PY" status "$S")"
assert_contains "E-306.02b: ai doctor says 'outdated (D-086)'" "outdated (D-086) wording" "$(_doctor)"
python3 -I "$PY" apply "$S" >/dev/null
assert_status 0 "E-306.02c: after apply: exactly one Rein rule, the current one, in the D-086 one's place; every other entry untouched" python3 - "$S" "$D101" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["autoMode"]["hard_deny"] == ["$defaults", "keep-before", sys.argv[2], "keep-after"], d["autoMode"]["hard_deny"]
assert d["autoMode"]["soft_deny"] == ["$defaults", "mine"] and d["permissions"] == {"defaultMode": "auto"}
PY
python3 - "$S" "$D086" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["autoMode"]["hard_deny"] = ["$defaults", sys.argv[2], "x", "AI-OS Gate Tamper: an even older copy"]
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
PY
python3 -I "$PY" apply "$S" >/dev/null
assert_status 0 "E-306.02d: two labelled copies collapse to ONE current rule (first position kept)" python3 - "$S" "$D101" <<'PY'
import json, sys
hd = json.load(open(sys.argv[1]))["autoMode"]["hard_deny"]
assert hd == ["$defaults", sys.argv[2], "x"], hd
PY
_home; printf '{}\n' > "$S"; chmod 000 "$S"
out="$(_doctor)"; chmod 600 "$S"
assert_contains "E-293.08k: an unreadable file → ✗ could not check (not 'not configured')" "✗ classifier backstop: could not check" "$out"
assert_contains "E-293.08i: ai doctor calls the report" "_classifier_report" "$(grep -n '_classifier_report$' "${REPO_ROOT}/src/bin/ai")"

# ── E-314 (D-095, accounts.md §4): the report covers every registered account's directory ──
# A second config directory has its own settings.json, so a rule present in ~/.claude says
# nothing about it. Extends the E-293.08 rows: same report, one line per account.
_home; printf '{}\n' > "$S"; python3 -I "$PY" apply "$S" >/dev/null
mkdir -p "$T/h/.claude-work" "$T/h/.rein"; printf '{}\n' > "$T/h/.claude-work/settings.json"
printf '{"accounts": {"work": {"config_dir": "%s", "added": "2026-10-13"}}}\n' "$T/h/.claude-work" > "$T/h/.rein/accounts.json"
out="$(_doctor)"
assert_contains "E-314.01a: the default directory is still reported" "✓ classifier backstop: present" "$out"
assert_contains "E-314.01b: a registered account without the rule is reported, with the fix" \
  "○ classifier backstop [account work]: not configured in ~/.claude-work/settings.json — run: ai account sync work" "$out"
python3 -I "$PY" apply "$T/h/.claude-work/settings.json" >/dev/null
assert_contains "E-314.01c: …and reads present once it has it" "✓ classifier backstop [account work]: present" "$(_doctor)"

# ── E-318 (D-097, accounts.md §4 "never goes stale"): REPLACE-ONLY refresh in every account ──
# ~/.claude PRESENT (current), account "old" carrying the D-097 label mid-list (E-324: the
# version D-101 superseded), account "none"
# without the rule. The files are in Claude Code's own format, so a rewrite that changed
# anything but the one entry would show in the bytes.
_refresh() { env HOME="$T/h" bash -c "source '${REPO_ROOT}/src/bin/ai' >/dev/null 2>&1; _cb_py() { printf %s '${PY}'; }; _classifier_refresh_all $*" 2>&1; }
_cc_json() {  # <path> <hard_deny JSON> — write a settings.json the way Claude Code does
  python3 - "$1" "$2" <<'PYW'
import json, sys
d = {"model": "opus", "permissions": {"defaultMode": "auto", "allow": ["Bash(ls *)"]},
     "autoMode": {"soft_deny": ["$defaults", "mine"], "hard_deny": json.loads(sys.argv[2])}, "theme": "dark ü"}
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
PYW
}
_home; mkdir -p "$T/h/.claude-old" "$T/h/.claude-none" "$T/h/.rein"
_cc_json "$S" "$(python3 -c 'import json,sys; print(json.dumps(["$defaults", sys.argv[1]]))' "$D101")"
_cc_json "$T/h/.claude-old/settings.json" "$(python3 -c 'import json,sys; print(json.dumps(["$defaults", "keep-before", sys.argv[1], "keep-after"]))' "$D097")"
_cc_json "$T/h/.claude-none/settings.json" '["$defaults", "x"]'
printf '{"accounts": {"none": {"config_dir": "%s", "added": "2026-10-14"}, "old": {"config_dir": "%s", "added": "2026-10-14"}}}\n' \
  "$T/h/.claude-none" "$T/h/.claude-old" > "$T/h/.rein/accounts.json"
sha_claude="$(_sha "$S")"; sha_none="$(_sha "$T/h/.claude-none/settings.json")"
assert_contains "E-318.02a: before: doctor reads the account's D-097 copy as outdated" \
  "○ classifier backstop [account old]: outdated (D-097) wording" "$(_doctor)"
out="$(_refresh)"
assert_contains "E-318.02b: the outdated account copy is replaced, one line naming it" \
  "✓ classifier backstop [account old]: outdated copy in ~/.claude-old/settings.json replaced with the current rule" "$out"
assert_status 0 "E-318.02c: …at its original position; every other key byte-identical (the file equals the original with ONE entry swapped)" \
  python3 - "$T/h/.claude-old/settings.json" "$D101" <<'PY2'
import json, sys
d = {"model": "opus", "permissions": {"defaultMode": "auto", "allow": ["Bash(ls *)"]},
     "autoMode": {"soft_deny": ["$defaults", "mine"], "hard_deny": ["$defaults", "keep-before", sys.argv[2], "keep-after"]}, "theme": "dark ü"}
assert open(sys.argv[1], encoding="utf-8").read() == json.dumps(d, indent=2, ensure_ascii=False) + "\n"
PY2
assert_contains "E-318.02d: the ABSENT account is reported…" "○ classifier backstop [account none]: not configured in ~/.claude-none/settings.json" "$out"
assert_status 0 "E-318.02e: …and never added (byte-identical)" test "$(_sha "$T/h/.claude-none/settings.json")" = "$sha_none"
assert_status 0 "E-318.02f: ~/.claude (current) is byte-identical" test "$(_sha "$S")" = "$sha_claude"
assert_not_contains "E-318.02g: a current copy prints nothing" "classifier backstop: " "$out"
assert_contains "E-318.02h: after: doctor reads it present" "✓ classifier backstop [account old]: present" "$(_doctor)"
assert_status 0 "E-318.02i: a second refresh changes nothing" test -z "$(_refresh | grep -v 'account none')"
# Unparsable → reported, left alone.
printf '{\n  "a": 1,\n}\n' > "$T/h/.claude-old/settings.json"; sha_bad="$(_sha "$T/h/.claude-old/settings.json")"
out="$(_refresh)"
assert_contains "E-318.02j: an unparsable account file is reported, not repaired" "✗ classifier backstop [account old]: ~/.claude-old/settings.json left untouched" "$out"
assert_status 0 "E-318.02k: …byte-identical" test "$(_sha "$T/h/.claude-old/settings.json")" = "$sha_bad"
# D-098: `ai install` refreshes ~/.claude too, before the y/N offer — so an install with no
# terminal (the offer declines to ask) still leaves no outdated copy behind.
_cc_json "$S" "$(python3 -c 'import json,sys; print(json.dumps(["$defaults", "keep", sys.argv[1]]))' "$D097")"
out="$(env HOME="$T/h" bash -c "source '${REPO_ROOT}/src/bin/ai' >/dev/null 2>&1; _cb_py() { printf %s '${PY}'; }; _classifier_refresh_all; _classifier_offer" </dev/null 2>&1)"
assert_contains "E-318.02l: a non-TTY install sequence replaces an outdated ~/.claude copy…" "AI-OS Gate Tamper (D-101)" "$(cat "$S")"
assert_contains "E-318.02l2: …and the offer still declines to prompt without a terminal" "not offered (no terminal)" "$out"
assert_status 0 "E-318.02l3: …the ABSENT account stays untouched" test "$(_sha "$T/h/.claude-none/settings.json")" = "$sha_none"
assert_contains "E-318.02m: ai sync runs the refresh as a step" "_classifier_refresh_all" "$(grep -nE '_sync_step +classifier +_classifier_refresh_all' "${REPO_ROOT}/src/bin/ai")"
assert_status 0 "E-318.02n: ai install runs the refresh immediately before the offer" \
  bash -c "sed -n '/^install_global() {/,/^}/p' '${REPO_ROOT}/src/bin/ai' | grep -A3 -E '^  _classifier_refresh_all( \|\| :)?\$' | grep -qE '^  _classifier_offer\$'"

# `ai account add` copies ~/.claude's settings, so an outdated label there would be seeded —
# the new directory is refreshed after seeding.
_home; rm -rf "$T/h/.rein" "$T/h/.claude-work"
_cc_json "$S" "$(python3 -c 'import json,sys; print(json.dumps(["$defaults", sys.argv[1]]))' "$D097")"
out="$(env HOME="$T/h" PATH="/usr/bin:/bin" bash -c "source '${REPO_ROOT}/src/bin/ai' >/dev/null 2>&1; _cb_py() { printf %s '${PY}'; }; do_account add work" </dev/null 2>&1)"
assert_contains "E-318.03a: ai account add reports the refresh of the seeded copy" "✓ classifier backstop [account work]: outdated copy" "$out"
assert_contains "E-318.03b: …the new directory carries the D-101 text" "AI-OS Gate Tamper (D-101)" "$(cat "$T/h/.claude-work/settings.json" 2>/dev/null)"
assert_not_contains "E-318.03c: …and ~/.claude keeps its own (outdated) copy for the offer" "AI-OS Gate Tamper (D-101)" "$(cat "$S")"

assert_summary
