#!/usr/bin/env python3
"""gate-override.py — E-291 (D-081 r2, D-083 r5-8): the operator's time-boxed safe-exec override.

Replaces the two environment opt-outs removed in E-291 (the gate switch and the role-token
switch), which a project's
`.claude/settings.json` `env` block could set (the T-LOCATOR-001 channel). The override is a
FILE, ~/.ai-os/gate-override.json, written by `ai gate off` and honoured by the pre-tool-use
hook only when every check below holds. ONE implementation for the writer (`ai gate`), the
reader (the hook, under the pinned `python3 -I`) and the reporters (`ai gate status`,
`ai doctor`, session-start), so they cannot disagree about what "active" means.

CEILING (D-083 r5): the agent runs as the operator's uid, so nothing here can tell them apart —
the gate is tamper-RESISTANT, not tamper-proof. The analyzer's GATE_SELF_DISABLE rule and the
write gate's ~/.ai-os/** block raise the cost; the classifier backstop (E-293) is the layer a
project cannot reach.

Read discipline (security_engineer, E-291 review):
  - O_NOFOLLOW + fstat on the descriptor (no symlink, no TOCTOU between check and read);
  - a regular file, owned by the effective uid, no group/other write, one link, <= 4 KB;
  - its directory owned by the uid and not group/other-writable;
  - `until` a real number (bool rejected) with `now < until <= now + 3600` as ONE comparison —
    the naive two-branch check honoured {"until": NaN}, which every comparison answers False;
  - `reason` reduced to a plain charset, <= 120 chars, at read AND write (it reaches the
    model-visible stderr / systemMessage; a newline or ANSI escape would forge output).
Anything else: the override is IGNORED and the gate runs normally. Never "allow on error".

CLI (stdout is tab-separated; exit codes are the contract):
  check  <path>                    0 active "OK\t<until-iso>\t<reason>" | 1 ignored "IGNORED\t<why>" | 3 absent
  write  <path> <minutes> <reason> 0 "<until-iso>\t<minutes>\t<clamped:0|1>" | 2 usage
  status <path>                    same as check, never fails the caller (exit 0)
"""
import json
import math
import os
import re
import stat
import sys
import tempfile
import time

MAX_MINUTES = 60
DEFAULT_MINUTES = 15
MAX_BYTES = 4096
_REASON_OK = re.compile(r"[^A-Za-z0-9 ._,:/#()-]")


def sanitise_reason(raw):
    s = _REASON_OK.sub("", str(raw or ""))
    s = re.sub(r"\s+", " ", s).strip()[:120]
    return s or "no reason given"


def _iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def _dir_ok(path):
    d = os.path.dirname(os.path.abspath(path)) or "."
    try:
        st = os.lstat(d)
    except OSError:
        return "directory missing"
    if not stat.S_ISDIR(st.st_mode):
        return "directory is not a directory"
    if st.st_uid != os.geteuid():
        return "directory not owned by you"
    if st.st_mode & 0o022:
        return "directory is group/other-writable"
    return None


def check(path, now=None):
    """Return (code, payload): 0 ("OK", until, reason) | 1 ("IGNORED", why) | 3 absent."""
    now = time.time() if now is None else now
    if not os.path.lexists(path):
        return 3, None
    bad = _dir_ok(path)
    if bad:
        return 1, bad
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return 1, "not a plain file (symlink or unreadable)"
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            return 1, "not a regular file"
        if st.st_uid != os.geteuid():
            return 1, "not owned by you"
        if st.st_mode & 0o022:
            return 1, "group/other-writable"
        if st.st_nlink != 1:
            return 1, "has more than one link"
        if st.st_size > MAX_BYTES:
            return 1, "larger than 4 KB"
        raw = os.read(fd, MAX_BYTES + 1)
    finally:
        os.close(fd)
    try:
        d = json.loads(raw.decode("utf-8", "strict"))
    except Exception:
        return 1, "not valid JSON"
    if not isinstance(d, dict):
        return 1, "not a JSON object"
    u = d.get("until")
    try:
        # A huge JSON integer raises OverflowError inside isfinite — caught, not left to
        # crash the reader (critic_security P2): a crash would only be "ignored" by accident.
        if isinstance(u, bool) or not isinstance(u, (int, float)) or not math.isfinite(u):
            return 1, "until is not a finite number"
    except OverflowError:
        return 1, "until is out of range"
    if not (now < u <= now + MAX_MINUTES * 60):
        return 1, "expired" if u <= now else "window longer than 60 minutes"
    return 0, (_iso(u), sanitise_reason(d.get("reason")))


def write(path, minutes, reason, now=None):
    now = time.time() if now is None else now
    clamped = 0
    if minutes > MAX_MINUTES:
        minutes, clamped = MAX_MINUTES, 1
    until = int(now + minutes * 60)
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    old = os.umask(0o077)
    try:
        fd, tmp = tempfile.mkstemp(prefix=".gate-override.", dir=d)   # O_EXCL, 0600
        try:
            with os.fdopen(fd, "w") as f:
                json.dump({"until": until, "reason": sanitise_reason(reason)}, f)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)          # rename: replaces a symlink, never follows it
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    finally:
        os.umask(old)
    return _iso(until), minutes, clamped


def main(argv):
    if len(argv) < 3:
        print("usage: gate-override.py check|status|write <path> [minutes reason]", file=sys.stderr)
        return 2
    cmd, path = argv[1], argv[2]
    if cmd in ("check", "status"):
        code, payload = check(path)
        if code == 0:
            print("OK\t%s\t%s" % payload)
        elif code == 1:
            print("IGNORED\t%s" % payload)
        return 0 if cmd == "status" else code
    if cmd == "write":
        if len(argv) < 5 or not re.fullmatch(r"[0-9]{1,4}", argv[3]) or int(argv[3]) < 1:
            print("minutes must be a whole number >= 1", file=sys.stderr)
            return 2
        until, minutes, clamped = write(path, int(argv[3]), argv[4])
        print("%s\t%d\t%d" % (until, minutes, clamped))
        return 0
    print("unknown command: %s" % cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
