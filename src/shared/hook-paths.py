#!/usr/bin/env python3
"""hook-paths.py — where a project's .claude/settings.json points Rein's hooks (E-391, D-132
addenda 4 r2 and 5).

A Rein hook entry is recognised by the hook's FILE NAME, whatever directory it names, so an
entry written by an earlier install under another home directory is still ours: a hook whose
script is gone exits 127, Claude Code blocks only on exit 2, and the gate would be off
without a word. One module, three readers — `rein doctor`, `rein sync` and the installer's
final report — so the rule cannot drift between them.

  check <settings.json> <install hooks dir>
      one TAB line per finding, nothing when clean:
        MISSING   <event> <path>  a Rein-named entry whose script does not exist
        FOREIGN   <event> <path>  a Rein-named script outside the install's hooks dir
        FORM      <event> <name>  ours, but not the exec form /bin/bash -p <absolute path>
        UNREGISTERED              no PreToolUse entry resolves to the install's pre-tool-use.sh
        UNPARSEABLE               the file is not JSON (doctor reports it; nothing else said)
  projects <clone> <install hooks dir>
      the projects Claude Code's session directories name (D-132 addendum 5) whose settings
      name a MISSING Rein hook path, one per line. Read-only and bounded: per directory the
      newest *.jsonl, its first 50 lines, the first string `cwd`; every other field is dropped
      on the spot. REIN_NO_PROJECT_SCAN=1 prints nothing.

Import (sync): load this file by path and call is_ours(entry, script, hooks_dir).
"""
import glob
import json
import os
import re
import subprocess
import sys

HOOK_NAMES = ("stop-hook.sh", "pre-tool-use.sh", "session-start.sh",
              "post-tool-log.sh", "post-tool-use.sh", "permission-denied.sh")
_PATH = re.compile(r"""(?P<p>[^\s"';|&()]*/(?P<n>""" + "|".join(re.escape(n) for n in HOOK_NAMES)
                   + r"""))(?=[\s"';|&)]|$)""")


def _real(p):
    return os.path.realpath(p)


def _expand(p):
    home = os.path.expanduser("~")
    for pre in ("${HOME}", "$HOME"):
        if p.startswith(pre):
            return home + p[len(pre):]
    return os.path.expanduser(p)


def _paths(h):
    """(path, name) for every Rein-named script an entry runs — as written, and expanded."""
    text = " ".join([str(h.get("command") or "")] + [str(a) for a in (h.get("args") or [])])
    return [(_expand(m.group("p")), m.group("n")) for m in _PATH.finditer(text)]


def _status(path, hooks_dir):
    if not os.path.isfile(path):
        return "MISSING"
    if os.path.dirname(_real(path)) != _real(hooks_dir):
        return "FOREIGN"
    return "OURS"


def is_ours(h, script, hooks_dir):
    """True when `rein sync` may replace this entry: it runs `script` from the install's hooks
    dir, or from a path that no longer exists. An existing script elsewhere is the user's."""
    return any(n == script and _status(p, hooks_dir) in ("OURS", "MISSING") for p, n in _paths(h))


def check(settings, hooks_dir):
    try:
        with open(settings, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return [("UNPARSEABLE",)]
    out, gate = [], False
    want_gate = _real(os.path.join(hooks_dir, "pre-tool-use.sh"))
    for ev, lst in ((d.get("hooks") or {}) if isinstance(d.get("hooks"), dict) else {}).items():
        for e in lst or []:
            for h in (e.get("hooks") or []) if isinstance(e, dict) else []:
                if not isinstance(h, dict):
                    continue
                for p, n in _paths(h):
                    s = _status(p, hooks_dir)
                    if s in ("MISSING", "FOREIGN"):
                        out.append((s, ev, p))
                        continue
                    args = [str(a) for a in (h.get("args") or [])]
                    exec_form = (h.get("command") == "/bin/bash" and args[:1] == ["-p"] and len(args) >= 2
                                 and os.path.isabs(args[1]) and os.path.dirname(args[1]) == hooks_dir)
                    if not exec_form:
                        out.append(("FORM", ev, n))
                    if ev == "PreToolUse" and _real(p) == want_gate:
                        gate = True
    if not gate:
        out.append(("UNREGISTERED",))
    return out


def _session_cwds():
    """`cwd` values from Claude Code's per-project session dirs (D-132 addendum 5 r1-r2)."""
    home = os.path.expanduser("~")
    roots = [os.path.join(home, ".claude", "projects")]
    try:
        with open(os.path.join(home, ".rein", "accounts.json"), encoding="utf-8") as f:
            accts = json.load(f).get("accounts") or {}
        for a in accts.values():
            cd = a.get("config_dir") if isinstance(a, dict) else None
            if isinstance(cd, str) and cd:
                roots.append(os.path.join(os.path.expanduser(cd), "projects"))
    except Exception:
        pass
    for root in roots:
        for d in sorted(glob.glob(os.path.join(glob.escape(root), "*", ""))):
            try:
                files = [f for f in glob.glob(os.path.join(glob.escape(d), "*.jsonl")) if os.path.isfile(f)]
                if not files:
                    continue
                newest = max(files, key=os.path.getmtime)
                with open(newest, encoding="utf-8", errors="replace") as f:
                    for i, line in enumerate(f):
                        if i >= 50:
                            break
                        try:
                            cwd = json.loads(line).get("cwd")
                        except Exception:
                            continue
                        if isinstance(cwd, str):
                            yield cwd
                            break
            except Exception:
                continue


def _qualifies(p):
    return (os.path.isabs(p) and os.path.isdir(p) and os.path.isdir(os.path.join(p, ".ai"))
            and os.path.isfile(os.path.join(p, ".claude", "settings.json")))


def _toplevel(p):
    try:
        r = subprocess.run(["git", "-C", p, "rev-parse", "--show-toplevel"], capture_output=True,
                           text=True, timeout=5, stdin=subprocess.DEVNULL)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def projects(clone, hooks_dir):
    if os.environ.get("REIN_NO_PROJECT_SCAN") == "1":
        return []
    found = set()
    for c in list(_session_cwds()) + [clone]:
        if any(ch in c for ch in "\n\r\t\0") or not _qualifies(c):
            continue
        found.add(_real(c))
        top = _toplevel(c)
        if top and _qualifies(top):
            found.add(_real(top))
    return [p for p in sorted(found)
            if any(r[0] == "MISSING" for r in check(os.path.join(p, ".claude", "settings.json"), hooks_dir))]


def main(argv):
    if len(argv) == 4 and argv[1] == "check":
        for r in check(argv[2], argv[3]):
            print("\t".join(r))
        return 0
    if len(argv) == 4 and argv[1] == "projects":
        for p in projects(argv[2], argv[3]):
            print(p)
        return 0
    print("usage: hook-paths.py check <settings.json> <hooks dir> | projects <clone> <hooks dir>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
