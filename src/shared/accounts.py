#!/usr/bin/env python3
"""accounts.py — E-314 (D-095, accounts.md §Components 1 and 4): the Claude account registry.

A project names an ACCOUNT; the operator's registry ~/.rein/accounts.json maps the name to a
Claude Code config directory (the directory holds that account's login). This module is the ONE
reader/writer of the registry and the ONE validator of names and directories, so `ai account`,
`ai pane`, `ai start` and `ai doctor` cannot disagree about what an account is.

  registry := {"accounts": {"<name>": {"config_dir": "<abs dir>", "added": "YYYY-MM-DD"}}}
  name     := ^[a-z][a-z0-9-]{0,23}$ ; "default" is reserved (= ~/.claude, inherited) and never stored
  dir      := absolute, strictly under $HOME, no "." / ".." component, no control character;
              neither lexically nor after resolving symlinks inside ~/.claude or ~/.rein, nor
              inside a git working tree; every existing component below $HOME owned by this uid
              and not group/world-writable (the directory's settings.json is a gate config)

The project side (.ai/start.json) is Architect-writable and committed, so it may only carry a
NAME; the path comes from here and is validated here before anyone exports it (E-208 lesson).
A registry that is not exactly this shape is refused whole — never half-read.

CLI (stdout is tab-separated; exit codes are the contract):
  resolve <registry> <home> <name>  0 "<dir>" (exists) | 2 "INVALID\t<why>" | 3 "UNPARSABLE\t<why>" |
                                    4 "UNREGISTERED" | 5 "BADDIR\t<why>" | 6 "MISSING\t<dir>"
  list    <registry> <home>         0 one "<name>\t<dir>\t<added>" line per account, sorted | 3 UNPARSABLE
  check   <home> <name> <dir>       0 "<normalised dir>" | 2 INVALID | 5 BADDIR   (no registry read)
  add     <registry> <home> <name> <dir> <date>
                                    0 "ADDED\t<dir>" | 2 INVALID / "DUPLICATE" | 3 UNPARSABLE | 5 BADDIR
  remove  <registry> <home> <name>  0 "REMOVED\t<dir>" | 2 INVALID | 3 UNPARSABLE | 4 UNREGISTERED
  copy    <src> <dst> [--replace]   0 "COPIED" | 1 "EXISTS" (no --replace) | 5 "BADDIR\t<why>"
                                    — never writes through a symlink at <dst>; created 0600
  any                               7 "ERROR\t<exception>" — an unexpected failure
"""
import json
import os
import re
import sys
import tempfile

NAME_RE = re.compile(r"[a-z][a-z0-9-]{0,23}")   # fullmatch: "$" would accept a trailing newline
DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
ROW_KEYS = {"config_dir", "added"}
RESERVED = "default"


class Refused(Exception):
    def __init__(self, rc, line):
        super().__init__(line)
        self.rc, self.line = rc, line


def check_name(name):
    if name == RESERVED:
        raise Refused(2, "INVALID\t'default' is reserved (it is ~/.claude, inherited) and never registered")
    if not isinstance(name, str) or not NAME_RE.fullmatch(name):
        raise Refused(2, "INVALID\tname must match ^[a-z][a-z0-9-]{0,23}$")


def _inside(path, root):
    return path == root or path.startswith(root + "/")


def check_dir(home, d):
    """→ the normalised directory, or Refused(5). Lexical, then resolved, then ownership."""
    if not isinstance(d, str) or not d or any(ord(c) < 32 or ord(c) == 127 for c in d):
        raise Refused(5, "BADDIR\tempty or contains a control character")
    if not os.path.isabs(d):
        raise Refused(5, "BADDIR\tnot an absolute path")
    if any(p in (".", "..") for p in d.split("/")):
        raise Refused(5, "BADDIR\tcontains a '.' or '..' component")
    home = os.path.normpath(home)
    nd = os.path.normpath(d)
    # realpath resolves the EXISTING prefix too, so a symlinked parent of a not-yet-created
    # directory cannot lead it out of $HOME.
    rd, rhome = os.path.realpath(nd), os.path.realpath(home)
    for path, h, how in ((nd, home, ""), (rd, rhome, " (after resolving symlinks)")):
        if not path.startswith(h + "/"):
            raise Refused(5, "BADDIR\tnot under $HOME" + how)
        if _inside(path, os.path.join(h, ".claude")):
            raise Refused(5, "BADDIR\tinside ~/.claude, the default account's directory" + how)
        if _inside(path, os.path.join(h, ".rein")):
            raise Refused(5, "BADDIR\tinside ~/.rein, the installed framework" + how)
    # Walk the existing components from the directory up to (not including) $HOME.
    uid = os.getuid()
    p = rd
    while p != rhome and p.startswith(rhome + "/"):
        if os.path.lexists(p):
            if os.path.exists(os.path.join(p, ".git")):
                raise Refused(5, "BADDIR\tinside a git working tree (%s)" % p)
            st = os.stat(p)
            if st.st_uid != uid:
                raise Refused(5, "BADDIR\t%s is not owned by you" % p)
            if st.st_mode & 0o022:
                raise Refused(5, "BADDIR\t%s is group- or world-writable" % p)
        p = os.path.dirname(p)
    return nd


def copy_file(src, dst, replace):
    """Copy src (a regular file, read through links) to dst without ever following a link at
    dst: a new file is created O_EXCL|O_NOFOLLOW 0600; --replace writes a temp file beside it
    and renames over dst (a rename replaces a link, never writes through it)."""
    with open(src, "rb") as f:
        data = f.read()
    if not replace:
        try:
            fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            raise Refused(1, "EXISTS")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        return
    d = os.path.dirname(dst) or "."
    fd, tmp = tempfile.mkstemp(prefix=".seed.", suffix=".tmp", dir=d)   # 0600
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, dst)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _no_dupes(pairs):
    seen = {}
    for k, v in pairs:
        if k in seen:
            raise ValueError("duplicate key %r" % k)
        seen[k] = v
    return seen


def load(path, home):
    """→ {name: {"config_dir", "added"}}; a missing file is an empty registry."""
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except FileNotFoundError:
        return {}
    try:
        doc = json.loads(text, object_pairs_hook=_no_dupes,
                         parse_constant=lambda c: (_ for _ in ()).throw(ValueError("constant %s" % c)))
    except ValueError as e:
        raise Refused(3, "UNPARSABLE\t%s" % e)
    if not isinstance(doc, dict) or set(doc) - {"accounts"} or not isinstance(doc.get("accounts", {}), dict):
        raise Refused(3, "UNPARSABLE\troot must be exactly {\"accounts\": {...}}")
    out = {}
    for name, row in doc.get("accounts", {}).items():
        if not isinstance(row, dict) or not isinstance(row.get("config_dir"), str) or set(row) - ROW_KEYS:
            raise Refused(3, "UNPARSABLE\taccount %r must be {config_dir, added}" % name)
        if "added" in row and not (isinstance(row["added"], str) and DATE_RE.fullmatch(row["added"])):
            raise Refused(3, "UNPARSABLE\taccount %r: added must be YYYY-MM-DD" % name)
        try:
            check_name(name)
            check_dir(home, row["config_dir"])
        except Refused as r:
            raise Refused(3, "UNPARSABLE\taccount %r: %s" % (name, r.line.split("\t", 1)[-1]))
        out[name] = {"config_dir": row["config_dir"], "added": str(row.get("added", ""))}
    return out


def save(path, accounts):
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    body = json.dumps({"accounts": {k: accounts[k] for k in sorted(accounts)}}, indent=2) + "\n"
    fd, tmp = tempfile.mkstemp(prefix=".accounts.", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)          # rename: replaces a symlink, never writes through it
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main(argv):
    if not argv:
        raise Refused(2, "INVALID\tusage: accounts.py resolve|list|check|add|remove ...")
    cmd, a = argv[0], argv[1:]
    if cmd == "resolve" and len(a) == 3:
        reg, home, name = a
        check_name(name)
        accts = load(reg, home)
        if name not in accts:
            raise Refused(4, "UNREGISTERED")
        d = check_dir(home, accts[name]["config_dir"])
        if not os.path.isdir(d):
            raise Refused(6, "MISSING\t%s" % d)
        print(d)
        return 0
    if cmd == "list" and len(a) == 2:
        for name, row in sorted(load(a[0], a[1]).items()):
            print("%s\t%s\t%s" % (name, row["config_dir"], row["added"]))
        return 0
    if cmd == "check" and len(a) == 3:
        home, name, d = a
        check_name(name)
        print(check_dir(home, d))
        return 0
    if cmd == "add" and len(a) == 5:
        reg, home, name, d, date = a
        check_name(name)
        if not DATE_RE.fullmatch(date):
            raise Refused(2, "INVALID\tdate must be YYYY-MM-DD")
        nd = check_dir(home, d)
        accts = load(reg, home)
        if name in accts:
            raise Refused(2, "DUPLICATE")
        accts[name] = {"config_dir": nd, "added": date}
        save(reg, accts)
        print("ADDED\t%s" % nd)
        return 0
    if cmd == "remove" and len(a) == 3:
        reg, home, name = a
        check_name(name)
        accts = load(reg, home)
        if name not in accts:
            raise Refused(4, "UNREGISTERED")
        d = accts.pop(name)["config_dir"]
        save(reg, accts)
        print("REMOVED\t%s" % d)
        return 0
    if cmd == "copy" and len(a) in (2, 3) and a[2:] in ([], ["--replace"]):
        copy_file(a[0], a[1], bool(a[2:]))
        print("COPIED")
        return 0
    raise Refused(2, "INVALID\tunknown command or wrong argument count: %s" % cmd)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Refused as r:
        print(r.line)
        sys.exit(r.rc)
    except Exception as e:  # never read as success or as "not registered"
        print("ERROR\t%s: %s" % (type(e).__name__, e))
        sys.exit(7)
