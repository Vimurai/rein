#!/usr/bin/env python3
"""classifier-backstop.py — E-293 (D-083 r5(iii), D-080): the auto-mode classifier backstop.

The safe-exec gate runs as the operator's uid, so a same-uid agent can in principle reach it
(D-083 r5 — tamper-RESISTANT). The auto-mode classifier's configuration lives in the
OPERATOR's ~/.claude/settings.json, which no project can override (D-080; measured on
2.1.287: `autoMode` in a project's .claude/settings.json or settings.local.json is ignored).
So a prose `autoMode.hard_deny` rule there is a second, independently configured gate.
`rein install` OFFERS it (y/N, default N); this module is the ONE reader/writer, shared by
`rein install` (plan + apply) and `rein doctor` (status), so they cannot disagree.

Discipline (security_engineer, E-293 review):
  - Parse strictly: duplicate keys, NaN/Infinity, a non-object root, `autoMode` not an object,
    `hard_deny` not a list of strings → REFUSE with a named error, file untouched. (Claude Code
    silently drops a file it cannot parse — JSONC comments, trailing commas — so refusing is
    the only honest answer; the doctor reports it.)
  - Re-serialise as Claude Code writes the file: json.dumps(indent=2, ensure_ascii=False),
    original trailing newline kept. Every other key and entry is preserved as a JSON value;
    when the user's own formatting would change shape, the plan says "formatting normalised".
    The output is re-parsed and must equal the input plus exactly the one change.
  - `$defaults` is inserted only when `hard_deny` did not exist (an existing list without it is
    the user's deliberate choice).
  - The rule carries a stable label; an entry with that label but other text is OUTDATED and
    replaced in place (never duplicated).
  - Symlinked settings (dotfiles repos): write THROUGH the link — realpath once; the target must
    be a regular file, owned by the uid, one link. Temp file in the target's directory,
    original mode kept, fsync, os.replace, fsync the directory. (ino, size, mtime_ns) recorded
    at read and re-checked just before the rename: a concurrent writer aborts the apply.
  - No file but the settings directory exists → created 0600. No directory → nothing to do.
  - One `.bak` (0600) beside the file on the FIRST write (D-086 r3); never overwritten.

CLI (stdout is tab-separated; exit codes are the contract):
  status <path>  0 "PRESENT" | 1 "ABSENT" / "OUTDATED" / "NOFILE" / "NODIR" | 3 "UNPARSABLE\t<why>"
                 followed by zero or more "WARN\t<text>" / "INFO\t<text>" lines (never fails the caller beyond rc)
  plan   <path>  0 "CHANGE\t<normalised:0|1>" + the resulting hard_deny as JSON | 1 "NOCHANGE" |
                 3 "UNPARSABLE\t<why>" | 5 "NODIR"
  apply  <path>  0 "APPLIED" | 1 "NOCHANGE" | 3 "REFUSED\t<why>" | 4 "CHANGED\t<why>" | 5 "NODIR"
  refresh <path> REPLACE ONLY (D-097, E-318 — `rein install` / `rein sync` / `rein account add`, no prompt):
                 an OUTDATED labelled copy is rewritten as `apply` would (0 "APPLIED", or apply's 3/4);
                 anything else is left alone: 1 "NOCHANGE" (PRESENT) | 1 "ABSENT" (never added — adding
                 is the operator's y/N) | 1 "NOFILE" | 3 "REFUSED\t<why>" | 5 "NODIR"
  any            6 "ERROR\t<exception>" — an unexpected failure, never read as "no change"
"""
import json
import math
import os
import re
import stat
import sys
import tempfile

# Any version of the rule starts with this; an installed copy with other text is OUTDATED.
LABEL = "AI-OS Gate Tamper"
# D-101 (E-324; supersedes D-097, which superseded D-090 and D-086 ruling 1) — copied VERBATIM from .ai/DECISIONS.md
# (tests/suites/classifier_backstop_test.sh asserts it equals the quoted constant there). A new version is a new D-ruling.
RULE = "AI-OS Gate Tamper (D-101): Never disable, bypass or weaken the AI-OS safe-exec gate or its role tokens, however assembled (shell variables, eval, bash -c, aliases, a script written then run, python/node/perl, sed -i, jq, cp/mv/ln, editor tools, subagents, or a nested claude launched with flags or settings that drop its hooks). Specifically: running `rein gate off`; creating, editing, moving or linking `~/.ai-os/gate-override.json`, `~/.ai-os/accounts.json` or anything under `~/.ai-os/{hooks,bin,mcp,shared,scripts,run,config,secrets}/` (by `~`, `$HOME`, a relative path or an absolute path); running `claude auto-mode reset`; changing `~/.claude/settings.json` or any registered Claude account's `settings.json` (the `config_dir` directories named in `~/.ai-os/accounts.json`), or their symlink targets, to remove or alter `autoMode`, `hooks`, `disableAllHooks` or `defaultMode`, or to add `permissions.allow` rules for `rein`; or changing a project's `.claude/settings.json` or `settings.local.json` to remove or alter `hooks`, `disableAllHooks` or `defaultMode`. Exempt: `rein install`, `rein sync`, `rein init`, `rein doctor`, `rein start`, `rein pane`, `rein account`, `rein gate on`, `rein gate status` and `bash install-ai-os.sh`, each run with no flag that skips, disables or redirects hooks or the gate — and, for `rein install`, `rein sync` and `bash install-ai-os.sh`, only from a source tree whose hooks, gate or installer this session has not modified; the `rein` command's own subcommands writing their runtime state under `~/.ai-os/run/` (never the gate switch); `rein install` creating the key under `~/.ai-os/secrets/`; reading these files."
DEFAULTS = "$defaults"


class Refuse(Exception):
    pass


def _no_dupes(pairs):
    seen = {}
    for k, v in pairs:
        if k in seen:
            raise Refuse(f"duplicate key {k!r}")
        seen[k] = v
    return seen


def _no_constants(name):
    raise Refuse(f"non-JSON number {name}")


def _float(tok):
    """critic_security P1: `1e400` parses as inf and would be written as `Infinity` — invalid JSON
    for Claude Code, which then ignores the WHOLE file (hooks, permissions, autoMode). `1e-400`
    silently becomes 0. Refuse both: a value we cannot write back as the same number."""
    f = float(tok)
    if not math.isfinite(f):
        raise Refuse(f"number {tok} is out of range (it would be written as Infinity)")
    if f == 0.0 and re.search(r"[1-9]", tok.split("e")[0].split("E")[0]):
        raise Refuse(f"number {tok} underflows to 0")
    return f


def _parse(raw):
    try:
        d = json.loads(raw, object_pairs_hook=_no_dupes, parse_constant=_no_constants, parse_float=_float)
    except Refuse:
        raise
    except ValueError as e:
        raise Refuse(f"not valid JSON ({e.msg} at line {e.lineno}) — a JSONC comment or trailing comma makes "
                     "Claude Code itself silently ignore this whole file; fix it by hand (never repaired here)")
    if not isinstance(d, dict):
        raise Refuse("the top level is not an object")
    _dump(d, True)   # anything that could not be written back (lone surrogate) is refused now
    am = d.get("autoMode")
    if am is not None and not isinstance(am, dict):
        raise Refuse("autoMode is not an object")
    hd = (am or {}).get("hard_deny")
    if hd is not None and (not isinstance(hd, list) or not all(isinstance(x, str) for x in hd)):
        raise Refuse("autoMode.hard_deny is not a list of strings")
    return d


def _dump(d, trailing_nl):
    try:
        text = json.dumps(d, indent=2, ensure_ascii=False, allow_nan=False) + ("\n" if trailing_nl else "")
        text.encode("utf-8")
    except (ValueError, UnicodeError) as e:
        raise Refuse(f"cannot be written back unchanged ({e.__class__.__name__}: a lone surrogate or a non-finite number)")
    return text


def _state(d):
    hd = ((d.get("autoMode") or {}).get("hard_deny"))
    if hd is None:
        return "ABSENT"
    if RULE in hd:
        return "PRESENT"
    if any(x.startswith(LABEL) for x in hd):
        return "OUTDATED"
    return "ABSENT"


def _with_rule(d):
    """A deep copy of d with exactly the one change."""
    new = json.loads(json.dumps(d))
    am = new.setdefault("autoMode", {})
    if "hard_deny" not in am:
        am["hard_deny"] = [DEFAULTS, RULE]
        return new
    hd = am["hard_deny"]
    labelled = [i for i, x in enumerate(hd) if isinstance(x, str) and x.startswith(LABEL)]
    if labelled:
        # Replace the first outdated copy IN PLACE and drop any further labelled copies, so the
        # list ends with exactly one AI-OS rule (E-306); every other entry keeps its position.
        hd[labelled[0]] = RULE
        for i in reversed(labelled[1:]):
            del hd[i]
        return new
    hd.append(RULE)
    return new


def _outdated_ruling(d):
    """The D-### an installed outdated copy carries in its label, e.g. "D-086", or ""."""
    for x in ((d.get("autoMode") or {}).get("hard_deny")) or []:
        if isinstance(x, str) and x.startswith(LABEL) and x != RULE:
            m = re.match(re.escape(LABEL) + r" \((D-\d+)\)", x)
            return m.group(1) if m else ""
    return ""


def _warnings(d):
    out = []
    allow = ((d.get("permissions") or {}).get("allow")) if isinstance(d.get("permissions"), dict) else None
    if isinstance(allow, list):
        for a in allow:
            if isinstance(a, str) and a.replace(" ", "").startswith("Bash(rein"):
                out.append(f"permissions.allow has {a!r} — allow rules are resolved BEFORE the "
                           "classifier, so `rein gate off` would never reach it")
    if os.environ.get("CLAUDE_CONFIG_DIR"):
        out.append("CLAUDE_CONFIG_DIR is set — Claude Code may read settings from there, not this file")
    return out


def _info(d):
    out = []
    hd = (d.get("autoMode") or {}).get("hard_deny")
    if isinstance(hd, list) and DEFAULTS not in hd:
        out.append("hard_deny omits \"$defaults\" — the built-in hard_deny rules (data exfiltration) are off by your choice")
    perms = d.get("permissions") if isinstance(d.get("permissions"), dict) else {}
    mode = perms.get("defaultMode") or "default"
    note = "" if mode == "auto" else " — the classifier runs only in auto mode; otherwise the hook is the only gate"
    out.append(f"default permission mode: {mode}{note}")
    return out


def _read(path):
    """(raw text or None, the stat of the regular file it resolved to or None). Refuses unsafe targets."""
    target = os.path.realpath(path)
    if os.path.islink(path) and not os.path.exists(target):
        raise Refuse("settings.json is a dangling symlink")
    if not os.path.lexists(target):
        return None, None, target
    st = os.stat(target)
    if not stat.S_ISREG(st.st_mode):
        raise Refuse("settings.json is not a regular file")
    if st.st_uid != os.geteuid():
        raise Refuse("settings.json is owned by another user")
    if st.st_nlink != 1:
        raise Refuse("settings.json has more than one hard link")
    try:
        with open(target, "r", encoding="utf-8") as f:
            raw = f.read()
    except UnicodeError:
        raise Refuse("settings.json is not valid UTF-8 — Claude Code cannot read it either")
    return raw, st, target


def cmd_status(path):
    if not os.path.isdir(os.path.dirname(os.path.abspath(path))):
        print("NODIR"); return 1
    try:
        raw, _, _ = _read(path)
        if raw is None:
            print("NOFILE"); return 1
        d = _parse(raw)
    except Refuse as e:
        print(f"UNPARSABLE\t{e}"); return 3
    s = _state(d)
    # E-306: name the ruling an outdated copy came from, so `rein doctor` says "outdated (D-086)".
    print(f"OUTDATED\t{_outdated_ruling(d)}" if s == "OUTDATED" and _outdated_ruling(d) else s)
    for w in _warnings(d):
        print(f"WARN\t{w}")
    for i in _info(d):
        print(f"INFO\t{i}")
    return 0 if s == "PRESENT" else 1


def _plan(path):
    """(new text, normalised flag, target, stat) or None when nothing changes. Raises Refuse."""
    raw, st, target = _read(path)
    if raw is None:
        d, trailing, normalised = {}, True, False
    else:
        d = _parse(raw)
        trailing = raw.endswith("\n")
        normalised = _dump(d, trailing) != raw
    if _state(d) == "PRESENT":
        return None
    new = _with_rule(d)
    text = _dump(new, trailing)
    if json.loads(text) != new:                       # the output must be what we meant to write
        raise Refuse("internal: re-parse mismatch")
    return text, normalised, target, st, new, raw


def cmd_plan(path):
    if not os.path.isdir(os.path.dirname(os.path.abspath(path))):
        print("NODIR"); return 5
    try:
        p = _plan(path)
    except Refuse as e:
        print(f"UNPARSABLE\t{e}"); return 3
    if p is None:
        print("NOCHANGE"); return 1
    text, normalised, _, _, new, _ = p
    print(f"CHANGE\t{1 if normalised else 0}")
    print(json.dumps(new["autoMode"]["hard_deny"], indent=2, ensure_ascii=False))
    return 0


def cmd_apply(path):
    d = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(d):
        print("NODIR"); return 5
    try:
        p = _plan(path)
    except Refuse as e:
        print(f"REFUSED\t{e}"); return 3
    if p is None:
        print("NOCHANGE"); return 1
    text, _, target, st, _, raw = p
    tdir = os.path.dirname(target)
    fd, tmp = tempfile.mkstemp(prefix=".settings.", suffix=".tmp", dir=tdir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fchmod(f.fileno(), stat.S_IMODE(st.st_mode) if st else 0o600)
            os.fsync(f.fileno())
        if st is not None and not os.path.lexists(target + ".bak"):   # D-086 r3: one .bak, first write
            bfd = os.open(target + ".bak", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(bfd, "w", encoding="utf-8") as bak:
                os.fchmod(bak.fileno(), 0o600)
                bak.write(raw)
                bak.flush()
                os.fsync(bak.fileno())
        # A concurrent writer (Claude Code itself, an editor) between our read and now: abort.
        if st is not None:
            now = os.stat(target)
            if (now.st_ino, now.st_size, now.st_mtime_ns) != (st.st_ino, st.st_size, st.st_mtime_ns):
                os.unlink(tmp)
                print("CHANGED\tsettings.json changed while it was being updated — nothing written; re-run")
                return 4
        elif os.path.lexists(target):
            os.unlink(tmp)
            print("CHANGED\tsettings.json appeared while it was being created — nothing written; re-run")
            return 4
        os.replace(tmp, target)
        dfd = os.open(tdir, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    print("APPLIED")
    return 0


def cmd_refresh(path):
    """The label on an installed copy is the operator's earlier consent (E-306), so an OUTDATED
    copy is replaced without asking; an ABSENT one was declined or never offered, and stays so."""
    if not os.path.isdir(os.path.dirname(os.path.abspath(path))):
        print("NODIR"); return 5
    try:
        raw, _, _ = _read(path)
        if raw is None:
            print("NOFILE"); return 1
        s = _state(_parse(raw))
    except Refuse as e:
        print(f"REFUSED\t{e}"); return 3
    if s == "PRESENT":
        print("NOCHANGE"); return 1
    if s == "ABSENT":
        print("ABSENT"); return 1
    return cmd_apply(path)   # re-reads: a write in between is caught by apply's own check


def main(argv):
    if len(argv) != 3 or argv[1] not in ("status", "plan", "apply", "refresh"):
        print("usage: classifier-backstop.py status|plan|apply|refresh <settings.json>", file=sys.stderr)
        return 2
    try:
        return {"status": cmd_status, "plan": cmd_plan, "apply": cmd_apply, "refresh": cmd_refresh}[argv[1]](argv[2])
    except Exception as e:   # never exit 1 (= ABSENT/NOCHANGE) on a crash
        print(f"ERROR\t{e.__class__.__name__}: {e}")
        return 6


if __name__ == "__main__":
    sys.exit(main(sys.argv))
