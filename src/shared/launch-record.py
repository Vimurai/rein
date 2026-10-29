#!/usr/bin/env python3
"""launch-record.py — E-294 (D-083 r9, D-087; sovereignty-hardening.md Component 8a): the ONE
implementation of the launch record, the process start-time read, the file discipline and the
ancestry walk. `rein pane` (writer), the safe-exec mint and verifier, `pre-commit` and `rein doctor`
all call it, so they cannot disagree about which record is live.

Invariant (D-087): a role may only move toward restriction. The walk is exhaustive and the most
restricted live record anywhere on the process chain wins; a nested `rein pane` is refused.

Record: <root>/run/launch/<pid>.json = {"role", "project", "started"}; root = $HOME/.rein, the
gate stack's one root (D-087 r7). Discipline on every read:
  - ~/.rein, run, launch opened in turn with O_DIRECTORY|O_NOFOLLOW (dir_fd chain, no path
    re-traversal); each owned by the euid; run and launch carry no group/other bits (0700),
    the install root none of the write bits (it is 0755 on every install);
  - the record opened with O_NOFOLLOW relative to the launch dir fd: a regular file, owned by
    the euid, nlink 1, <= 4 KB, no group/other bits, a JSON object with exactly those keys,
    role in {architect, engineer}, project an absolute path without control characters.
Start time: ONE method for writer and reader — macOS `LC_ALL=C TZ=UTC0 /bin/ps -o lstart=`
(one `-axo pid=,ppid=,lstart=` snapshot for a walk), Linux /proc/<pid>/stat field 22 (parsed
after the LAST ')'). A record whose `started` differs from the pid's real start time is STALE
(pid reuse) and skipped.

CLI (python3 -I launch-record.py <cmd> ...; JSON or one word on stdout; exit codes are the contract):
  nested <pid>             0 none | 3 "NESTED\t<why>" — an ancestor of <pid> holds a live (or
                           undisciplined) record; <pid> must be the caller (our parent)
  write <pid> <role>       0 "WROTE\t<path>" | 3 NESTED | 2 usage/refused — <pid> must be our parent
  walk                     0 JSON {"result": "role"|"union", "role", "launch", "why"} from OUR chain
  mint-context <spid>      0 JSON {"session_on_chain", "session_started", "walk": {...}}
  ancestor <pid> <started> 0 when <pid> is an ancestor of us with that start time, else 1
  alive <pid> <started>    0 when <pid> is running with that start time, 1 not, 2 unknown
  verify-context <pid> <started>  0 JSON {"ancestor", "walk"} — the verifier's one read
  starttime <pid>          0 "<started>" | 1
  status                   0 JSON: the live records on our chain + counts (doctor)
  prune [--dry-run]        0 JSON {"records": n, "tokens": n, "v1_tokens": n} — removes only
                           records/tokens whose process is gone or whose start time differs
"""
import json
import os
import re
import stat
import subprocess
import sys

ROLES = ("architect", "engineer")
RANK = {"engineer": 1, "architect": 2}          # higher = more restricted
MAX_BYTES = 4096
MAX_HOPS = 64
KEYS = {"role", "project", "started"}
_CTRL = re.compile(r"[\x00-\x1f\x7f]")


# ── process table ────────────────────────────────────────────────────────────
def _norm(s):
    return " ".join(str(s).split())


def _proc_linux(pid):
    """(ppid, started) from /proc, or None."""
    try:
        with open("/proc/%d/stat" % pid, "rb") as f:
            raw = f.read().decode("utf-8", "replace")
    except OSError:
        return None
    rest = raw[raw.rfind(")") + 2:].split()
    # rest[0] = state (field 3), so field N is rest[N - 3]
    try:
        return int(rest[1]), rest[19]
    except (IndexError, ValueError):
        return None


def _ps(args):
    env = {"LC_ALL": "C", "TZ": "UTC0", "PATH": "/usr/bin:/bin"}
    try:
        return subprocess.run(["/bin/ps"] + args, capture_output=True, text=True,
                              env=env, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


class SnapshotError(RuntimeError):
    """The process table could not be read. NEVER read as "nobody is alive": an empty table made
    prune delete live records and the walk fall back to the plain-launch default (critic_security
    P1-1, E-294: `ulimit -u 1` makes /bin/ps fail to start)."""


def snapshot():
    """{pid: (ppid, started)} for every process — one read. Raises SnapshotError unless the
    table is non-empty and contains this process."""
    table = _snapshot_raw()
    if not table or os.getpid() not in table:
        raise SnapshotError("process table unavailable")
    return table


def _snapshot_raw():
    table = {}
    if os.path.isdir("/proc/self"):
        for name in os.listdir("/proc"):
            if name.isdigit():
                r = _proc_linux(int(name))
                if r:
                    table[int(name)] = r
        return table
    for line in _ps(["-axo", "pid=,ppid=,lstart="]).splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            table[int(parts[0])] = (int(parts[1]), _norm(parts[2]))
    return table


def starttime(pid):
    if os.path.isdir("/proc/self"):
        r = _proc_linux(pid)
        return r[1] if r else None
    out = _norm(_ps(["-o", "lstart=", "-p", str(int(pid))]))
    return out or None


def chain(start_pid, table=None):
    """[(pid, started), ...] from start_pid up to pid 1, bounded at MAX_HOPS. Raises
    SnapshotError when start_pid is not in the table (the chain would silently be empty)."""
    table = snapshot() if table is None else table
    if int(start_pid) not in table:
        raise SnapshotError("pid %d is not in the process table" % int(start_pid))
    out, pid, seen = [], int(start_pid), set()
    for _ in range(MAX_HOPS):
        if pid <= 0 or pid in seen or pid not in table:
            break
        seen.add(pid)
        ppid, started = table[pid]
        out.append((pid, started))
        if pid == 1:
            break
        pid = ppid
    return out


# ── the Rein root of a working directory ────────────────────────────────────
def project_root(cwd=None):
    """realpath of the nearest ancestor holding .ai/ (git-style, <= 40 levels), or None."""
    d = os.path.realpath(cwd or os.getcwd())
    for _ in range(40):
        if os.path.isdir(os.path.join(d, ".ai")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return None


# ── file discipline ──────────────────────────────────────────────────────────
def _root():
    return os.path.join(os.environ.get("HOME", ""), ".rein")


def _open_dir(name, dir_fd, private):
    """Open one directory component without following a symlink; return fd or raise."""
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
    st = os.fstat(fd)
    bad = None
    if st.st_uid != os.geteuid():
        bad = "%s not owned by you" % name
    elif private and st.st_mode & 0o077:
        bad = "%s is not 0700" % name
    elif st.st_mode & 0o022:
        bad = "%s is group/other-writable" % name
    if bad:
        os.close(fd)
        raise PermissionError(bad)
    return fd


def _launch_dir_fd(create=False):
    """fd of <root>/run/launch, or None when it does not exist. Raises on a discipline breach."""
    root = _root()
    try:
        rfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        if not create:
            return None
        raise
    fds = [rfd]
    try:
        st = os.fstat(rfd)
        if st.st_uid != os.geteuid() or st.st_mode & 0o022:
            raise PermissionError("install root not owned by you or group/other-writable")
        cur = rfd
        for name in ("run", "launch"):
            try:
                nfd = _open_dir(name, cur, private=True)
            except FileNotFoundError:
                if not create:
                    return None
                old = os.umask(0o077)
                try:
                    os.mkdir(name, 0o700, dir_fd=cur)
                except FileExistsError:
                    pass
                finally:
                    os.umask(old)
                nfd = _open_dir(name, cur, private=True)
            fds.append(nfd)
            cur = nfd
        fds.pop()                                  # keep the launch fd open for the caller
        return cur
    finally:
        for fd in fds:
            os.close(fd)


def read_record(pid, dfd):
    """("ok", rec) | ("absent", None) | ("bad", why) for <pid>.json under the launch dir fd."""
    name = "%d.json" % int(pid)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
    except FileNotFoundError:
        return "absent", None
    except OSError:
        return "bad", "not a plain file (symlink or unreadable)"
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            return "bad", "not a regular file"
        if st.st_uid != os.geteuid():
            return "bad", "not owned by you"
        if st.st_mode & 0o077:
            return "bad", "group/other bits set"
        if st.st_nlink != 1:
            return "bad", "has more than one link"
        if st.st_size > MAX_BYTES:
            return "bad", "larger than 4 KB"
        raw = os.read(fd, MAX_BYTES + 1)
    finally:
        os.close(fd)
    try:
        d = json.loads(raw.decode("utf-8", "strict"))
    except Exception:
        return "bad", "not valid JSON"
    if not isinstance(d, dict) or set(d) != KEYS:
        return "bad", "not exactly {role, project, started}"
    if d["role"] not in ROLES:
        return "bad", "unknown role"
    p = d["project"]
    if not isinstance(p, str) or not p.startswith("/") or _CTRL.search(p):
        return "bad", "project is not an absolute path"
    if not isinstance(d["started"], str) or not d["started"]:
        return "bad", "started is not a string"
    return "ok", d


# ── the walk (8c) ────────────────────────────────────────────────────────────
def walk(start_pid, project, table=None, skip_self=False, any_project=False):
    """Most-restrictive-wins over the live records on start_pid's chain.

    Returns {"result": "role", "role", "launch"} or {"result": "union", "why"}.
    `project` None means the caller is outside any Rein project: every live record is then
    foreign (union), and no record at all is the plain-launch default.
    `any_project` (the VERIFIER's walk, restrict-only): a live record counts by its role whatever
    project it names — the verifier may sit in another directory (a commit in another repo, an
    MCP server's cwd) and only ever ADDS restriction to a token that already verified.
    """
    try:
        table = snapshot() if table is None else table
        links = chain(start_pid, table)
    except SnapshotError as e:
        return {"result": "union", "why": str(e)}
    if skip_self:
        links = links[1:]
    try:
        dfd = _launch_dir_fd()
    except OSError as e:
        return {"result": "union", "why": "launch directory: %s" % e}
    best = None
    try:
        if dfd is not None:
            for pid, started in links:
                status, rec = read_record(pid, dfd)
                if status == "absent":
                    continue
                if status == "bad":
                    return {"result": "union", "why": "record %d: %s" % (pid, rec)}
                if _norm(rec["started"]) != _norm(started):
                    continue                       # stale: the pid was reused
                if not any_project and (project is None or rec["project"] != project):
                    return {"result": "union", "why": "record %d is for another project" % pid}
                if best is None or RANK[rec["role"]] > RANK[best]:
                    best = rec["role"]
    finally:
        if dfd is not None:
            os.close(dfd)
    if best is None:
        return {"result": "role", "role": "engineer", "launch": "unverified"}
    return {"result": "role", "role": best, "launch": "record"}


def nested(pid, table=None):
    """Why <pid> may not write a record: an ancestor holds a live or undisciplined one."""
    try:
        table = snapshot() if table is None else table
        links = chain(pid, table)[1:]
    except SnapshotError as e:
        return "cannot read the process chain (%s)" % e
    try:
        dfd = _launch_dir_fd()
    except OSError as e:
        return "launch directory: %s" % e
    if dfd is None:
        return None
    try:
        for apid, started in links:
            status, rec = read_record(apid, dfd)
            if status == "bad":
                return "ancestor %d has an unreadable record (%s)" % (apid, rec)
            if status == "ok" and _norm(rec["started"]) == _norm(started):
                return "ancestor %d is a live %s session" % (apid, rec["role"])
    finally:
        os.close(dfd)
    return None


def write(pid, role, project):
    started = starttime(pid)
    if not started:
        raise RuntimeError("no start time for pid %d" % pid)
    dfd = _launch_dir_fd(create=True)
    old = os.umask(0o077)
    try:
        tmp = ".%d.%s.tmp" % (pid, os.urandom(6).hex())
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
        try:
            with os.fdopen(fd, "w") as f:
                json.dump({"role": role, "project": project, "started": _norm(started)}, f)
            os.replace(tmp, "%d.json" % pid, src_dir_fd=dfd, dst_dir_fd=dfd)
        except Exception:
            try:
                os.unlink(tmp, dir_fd=dfd)
            except OSError:
                pass
            raise
    finally:
        os.umask(old)
        os.close(dfd)
    return os.path.join(_root(), "run", "launch", "%d.json" % pid)


# ── lifecycle (8h) ───────────────────────────────────────────────────────────
def _alive(pid, started, table):
    cur = table.get(int(pid))
    return cur is not None and _norm(cur[1]) == _norm(started)


def prune(dry_run=False):
    table = snapshot()        # SnapshotError propagates: prune nothing rather than everything
    counts = {"records": 0, "tokens": 0, "v1_tokens": 0}
    try:
        dfd = _launch_dir_fd()
    except OSError:
        dfd = None
    if dfd is not None:
        try:
            for name in os.listdir(dfd):
                m = re.fullmatch(r"(\d+)\.json", name)
                if not m:
                    continue
                pid = int(m.group(1))
                status, rec = read_record(pid, dfd)
                if status == "ok" and _alive(pid, rec["started"], table):
                    continue
                if status == "bad" and (pid in table or rec.startswith("not a plain file")):
                    # A bad record makes its live chain the union; removing it would LOOSEN
                    # that session. Only a record whose pid is gone may go — and never
                    # through a symlink.
                    continue
                counts["records"] += 1
                if not dry_run:
                    os.unlink(name, dir_fd=dfd)
        finally:
            os.close(dfd)
    run = os.path.join(_root(), "run")
    try:
        names = os.listdir(run)
    except OSError:
        names = []
    for name in names:
        if not re.fullmatch(r"role-[A-Za-z0-9._-]+\.lock", name):
            continue
        p = os.path.join(run, name)
        try:
            st = os.lstat(p)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_size > MAX_BYTES:
                continue
            with open(p, "rb") as f:
                d = json.loads(f.read().decode("utf-8", "strict"))
        except Exception:
            continue
        if not isinstance(d, dict):
            continue
        if d.get("v") == 1:
            counts["v1_tokens"] += 1
            continue
        if d.get("v") == 2 and isinstance(d.get("pid"), int) and isinstance(d.get("started"), str):
            if _alive(d["pid"], d["started"], table):
                continue
            counts["tokens"] += 1
            if not dry_run:
                try:
                    os.unlink(p)
                except OSError:
                    pass
    return counts


def status():
    try:
        table = snapshot()
    except SnapshotError as e:
        return {"error": str(e), "live": [], "walk": {"result": "union", "why": str(e)}}
    me = os.getpid()
    out = {"project": project_root(), "live": [], "walk": walk(me, project_root(), table)}
    try:
        dfd = _launch_dir_fd()
    except OSError as e:
        out["error"] = str(e)
        return out
    if dfd is not None:
        try:
            for pid, started in chain(me, table):
                st, rec = read_record(pid, dfd)
                if st == "ok" and _norm(rec["started"]) == _norm(started):
                    out["live"].append({"pid": pid, "role": rec["role"], "project": rec["project"]})
        finally:
            os.close(dfd)
    out.update(prune(dry_run=True))
    return out


# ── CLI ──────────────────────────────────────────────────────────────────────
def _int(s):
    return int(s) if re.fullmatch(r"[0-9]{1,10}", s or "") else None


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd in ("nested", "write"):
        pid = _int(argv[2] if len(argv) > 2 else "")
        if pid is None or pid != os.getppid():
            print("refused: <pid> must be the calling process", file=sys.stderr)
            return 2
        why = nested(pid)
        if why:
            print("NESTED\t%s" % why)
            return 3
        if cmd == "nested":
            return 0
        role = argv[3] if len(argv) > 3 else ""
        project = project_root()
        if role not in ROLES or project is None:
            print("refused: role must be architect|engineer inside a Rein project", file=sys.stderr)
            return 2
        print("WROTE\t%s" % write(pid, role, project))
        return 0
    if cmd == "walk":
        print(json.dumps(walk(os.getpid(), project_root())))
        return 0
    if cmd == "mint-context":
        spid = _int(argv[2] if len(argv) > 2 else "")
        try:
            table = snapshot()
            links = chain(os.getpid(), table)
        except SnapshotError as e:
            print(json.dumps({"session_on_chain": False, "session_started": None,
                              "walk": {"result": "union", "why": str(e)}}))
            return 0
        hit = [s for p, s in links if spid is not None and p == spid]
        print(json.dumps({"session_on_chain": bool(hit), "session_started": hit[0] if hit else None,
                          "walk": walk(os.getpid(), project_root(), table)}))
        return 0
    if cmd == "ancestor":
        pid = _int(argv[2] if len(argv) > 2 else "")
        started = argv[3] if len(argv) > 3 else ""
        if pid is None or not started:
            return 1
        try:
            links = chain(os.getpid())[1:]
        except SnapshotError:
            return 1
        ok = any(p == pid and _norm(s) == _norm(started) for p, s in links)
        return 0 if ok else 1
    if cmd == "verify-context":
        # One read for the verifier (role-token.mjs, off the hot path): is <pid> an ancestor of
        # us with <started>, and what does the walk from US say? The verified role is the more
        # restrictive of the token's and the walk's (critic_security P2-1, E-294).
        pid = _int(argv[2] if len(argv) > 2 else "")
        started = argv[3] if len(argv) > 3 else ""
        try:
            table = snapshot()
            links = chain(os.getpid(), table)
        except SnapshotError as e:
            print(json.dumps({"ancestor": False, "walk": {"result": "union", "why": str(e)}}))
            return 0
        anc = pid is not None and bool(started) and any(
            p == pid and _norm(s) == _norm(started) for p, s in links[1:])
        print(json.dumps({"ancestor": anc,
                          "walk": walk(os.getpid(), project_root(), table, any_project=True)}))
        return 0
    if cmd == "alive":
        pid = _int(argv[2] if len(argv) > 2 else "")
        started = argv[3] if len(argv) > 3 else ""
        if pid is None or not started:
            return 1
        try:
            return 0 if _alive(pid, started, snapshot()) else 1
        except SnapshotError:
            return 2                      # unknown — the caller must not read it as "dead"
    if cmd == "starttime":
        pid = _int(argv[2] if len(argv) > 2 else "")
        s = starttime(pid) if pid is not None else None
        if not s:
            return 1
        print(_norm(s))
        return 0
    if cmd == "status":
        print(json.dumps(status()))
        return 0
    if cmd == "prune":
        try:
            print(json.dumps(prune(dry_run="--dry-run" in argv)))
        except SnapshotError as e:
            print("prune refused: %s" % e, file=sys.stderr)
            return 1
        return 0
    print("usage: launch-record.py nested|write|walk|mint-context|ancestor|starttime|status|prune",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
