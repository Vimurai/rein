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
        UNREGISTERED              no PreToolUse entry runs the install's pre-tool-use.sh in exec form
                                  under a matcher that covers Bash
        DISABLED                  the file sets disableAllHooks: no hook runs at all
        UNPARSEABLE               the file is not JSON (doctor reports it; nothing else said)
  projects <clone> <install hooks dir>
      the projects Claude Code's session directories name (D-132 addendum 5) whose settings
      name a MISSING Rein hook path, one per line. Read-only and bounded: per directory the
      newest *.jsonl, its first 50 lines, the first string `cwd`; every other field is dropped
      on the spot. REIN_NO_PROJECT_SCAN=1 prints nothing.

Import (sync): load this file by path and call is_ours(entry, script, hooks_dir, project_root).
An entry counts by the ONE script it runs (exec form's script argument, or the command's first
word / the word after a shell), with $HOME, ~ and $CLAUDE_PROJECT_DIR expanded; anything else is
unknown — never MISSING, never ours (security re-review N1).
"""
import glob
import json
import os
import re
import shlex
import sys

HOOK_NAMES = ("stop-hook.sh", "pre-tool-use.sh", "session-start.sh",
              "post-tool-log.sh", "post-tool-use.sh", "permission-denied.sh")
_SHELLS = ("bash", "sh", "zsh", "dash")
# Control (C0, DEL, C1) and bidi characters: a path carrying one is never printed (N5).
_UNSAFE = re.compile("[\x00-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩]")
_LINE, _FILE = 1 << 20, 4 << 20   # per-line and per-file read caps for a transcript (N4)


def _real(p):
    return os.path.realpath(p)


def _hooks_ok(hooks_dir):
    """An empty or relative hooks dir names nothing: realpath("") is the cwd (N3)."""
    return isinstance(hooks_dir, str) and os.path.isabs(hooks_dir)


def _expand(p, project):
    """The variables a hook command may carry, and nothing else: $HOME (an earlier install's
    shell-form entry), ~ and $CLAUDE_PROJECT_DIR (the form Claude Code documents). A path
    left with another `$`, a quote or a relative start is unknown — None (N1)."""
    home = os.path.expanduser("~")
    for var, val in (("${CLAUDE_PROJECT_DIR}", project), ("$CLAUDE_PROJECT_DIR", project),
                     ("${HOME}", home), ("$HOME", home)):
        if p.startswith(var):
            if not val:
                return None
            p = val + p[len(var):]
            break
    p = os.path.expanduser(p)
    if "$" in p or "'" in p or '"' in p or not os.path.isabs(p):
        return None
    return p


def _runs(h, project):
    """(path, name) of the ONE script this entry runs, when it is a Rein hook name — else
    None. Exec form: `/bin/bash -p <script>`; shell form: the command's first word, or the
    first non-flag word after a shell. A Rein name mentioned anywhere else in the line is an
    argument, not what runs (N1)."""
    cmd = str(h.get("command") or "")
    args = [str(a) for a in (h.get("args") or [])]
    try:
        words = ([cmd] + args) if args else shlex.split(cmd)
    except ValueError:
        return None
    if not words:
        return None
    script = words[0]
    if os.path.basename(script) in _SHELLS:
        rest = [w for w in words[1:] if not w.startswith("-")]
        if not rest:
            return None
        script = rest[0]
    name = os.path.basename(script)
    if name not in HOOK_NAMES:
        return None
    path = _expand(script, project)
    return (path, name) if path else None


def _status(path, hooks_dir):
    if not os.path.isfile(path):
        return "MISSING"
    if os.path.dirname(_real(path)) != _real(hooks_dir):
        return "FOREIGN"
    return "OURS"


def is_ours(h, script, hooks_dir, project=None):
    """True when `rein sync` may replace this entry: the script it runs is `script` in the
    install's hooks dir, or at a path that no longer exists. An existing script elsewhere is
    the user's; an entry whose script cannot be read off its command is never ours."""
    if not _hooks_ok(hooks_dir):
        return False
    r = _runs(h, project)
    return bool(r) and r[1] == script and _status(r[0], hooks_dir) in ("OURS", "MISSING")


def _covers_bash(matcher):
    """A PreToolUse matcher under which the gate fires for Bash (N2)."""
    if matcher in (None, "", "*"):
        return True
    try:
        return re.fullmatch(str(matcher), "Bash") is not None
    except re.error:
        return False


def check(settings, hooks_dir):
    try:
        with open(settings, encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return [("UNPARSEABLE",)]
    if not isinstance(d, dict):
        return [("UNPARSEABLE",)]
    if not _hooks_ok(hooks_dir):
        return [("UNREGISTERED",)]
    project = os.path.dirname(os.path.dirname(os.path.abspath(settings)))
    out, gate = [], False
    want_gate = _real(os.path.join(hooks_dir, "pre-tool-use.sh"))
    if d.get("disableAllHooks") is True:
        out.append(("DISABLED",))
    for ev, lst in ((d.get("hooks") or {}) if isinstance(d.get("hooks"), dict) else {}).items():
        for e in lst or []:
            if not isinstance(e, dict):
                continue
            for h in e.get("hooks") or []:
                if not isinstance(h, dict):
                    continue
                r = _runs(h, project)
                if not r:
                    continue
                p, n = r
                s = _status(p, hooks_dir)
                if s in ("MISSING", "FOREIGN"):
                    out.append((s, ev, p))
                    continue
                args = [str(a) for a in (h.get("args") or [])]
                exec_form = (h.get("command") == "/bin/bash" and args[:1] == ["-p"] and len(args) >= 2
                             and os.path.isabs(args[1]) and os.path.dirname(args[1]) == hooks_dir)
                if not exec_form:
                    out.append(("FORM", ev, n))
                # The gate counts only as it ships: exec form, under a matcher that covers
                # Bash (a `true <gate path>` or a NoSuchTool matcher never blocks — N2).
                if ev == "PreToolUse" and _real(p) == want_gate and exec_form and _covers_bash(e.get("matcher")):
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
                    # Bounded in lines AND bytes (N4): a line longer than _LINE is skipped
                    # unread, and nothing past _FILE bytes is read at all.
                    used = 0
                    for _ in range(50):
                        line = f.readline(_LINE)
                        if not line or used >= _FILE:
                            break
                        used += len(line)
                        if not line.endswith("\n") and len(line) >= _LINE:
                            while line and not line.endswith("\n") and used < _FILE:
                                line = f.readline(_LINE); used += len(line)
                            continue
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
    """The nearest ancestor holding .git, found by walking directories — no git process, so a
    candidate's .git/config (core.worktree, fsmonitor, hooksPath) is never read or run."""
    d = _real(p)
    for _ in range(40):
        if os.path.exists(os.path.join(d, ".git")):
            return d
        up = os.path.dirname(d)
        if up == d:
            break
        d = up
    return ""


def projects(clone, hooks_dir):
    if os.environ.get("REIN_NO_PROJECT_SCAN") == "1":
        return []
    found = set()
    for c in list(_session_cwds()) + [clone]:
        if _UNSAFE.search(c) or not _qualifies(c):
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
