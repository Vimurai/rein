#!/usr/bin/env bash
# session-start.sh — E-460 (lean-core.md §Component 3) + E-129 (sovereignty-hardening.md §Security).
#   E-460: inject one brief of at most 2 KB — the role stamp, the branch, the role's next five
#          open tasks, the heading of the last COMM.md handoff and one line per anomaly. It
#          replaced the preflight skill and the E-126 blueprint cache; no blueprint text
#          is injected (a blueprint is read when a task names it).
#   E-463: the role stamp reads the launch record `rein pane` left on this process chain
#          (shared/launch-record.py role); the HMAC role token went with the command gate.
#
# Claude Code SessionStart contract: a hook that prints JSON with
# hookSpecificOutput.additionalContext has that text added to the session context.
# Fail-open everywhere — emit nothing / skip the mint rather than block a session.
# Arg $1 (the role the settings file names) is accepted and IGNORED; the session id comes
# from the harness payload, never the env (no circularity).
#
# E-294 (D-083 r9, D-087): the role comes from a LAUNCH RECORD, never from the environment.
# `rein pane <role>` writes ~/.rein/run/launch/<pid>.json before exec'ing the provider; the
# mint walks this process chain and the most restricted live record wins. The launch
# environment (REIN_PANE_ROLE) used to decide the role here, and a project's settings `env`
# could set it — the T-LOCATOR-001 class this closes.
# ── E-292 (D-082 r2): a FAIL-OPEN hook that aborts on its own bug still exits 0 ──────
# (it never blocks the session). Inline
# string on the first executable line, builtins only. A deliberate exit keeps its code.
# The hook's ONLY EXIT trap — a later one must chain to it.
trap '_rein_rc=$?; trap - EXIT; case "$_rein_rc:$BASH_COMMAND" in 0:*) exit "$_rein_rc" ;; esac; exit 0' EXIT
# ── E-286 (D-078/D-081, T-HOOKENV-001): toolchain pin — FIRST, before any external command.
# A project's settings `env` reaches this process. Drop inherited functions and the
# variables that steer an interpreter, fix PATH, then load the pin (install mirror first,
# this script's own tree second — never the visited repo). Since E-290 the hooks run as
# exec-form `/bin/bash -p` (no BASH_ENV, no imported functions, no SHELLOPTS); these unsets
# remain for what -p leaves alone (CDPATH, GLOBIGNORE, POSIXLY_CORRECT, BASH_COMPAT, interpreter
# variables). See src/shared/toolchain-pin.sh.
unset -f $(compgen -A function) 2>/dev/null
for _v in $(compgen -e); do
  case "$_v" in NODE_*|PYTHON*|PERL*|DYLD_*|LD_*|REIN_TC_*|BASH_ENV|ENV|CDPATH|GLOBIGNORE|POSIXLY_CORRECT|BASH_COMPAT) unset "$_v" ;; esac
done
PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
for _p in "${HOME}/.rein/shared/toolchain-pin.sh" "${BASH_SOURCE[0]%/*}/../src/shared/toolchain-pin.sh"; do
  [[ -f "$_p" ]] && { . "$_p"; break; }
done
unset _v _p

# ── E-223 (D-057 §3): install-first helper resolution ────────────────────────
# The locators below used to start at "$(git rev-parse --show-toplevel)/src/...", which
# names the USER's repository, not the Rein install: any project carrying a file at that
# path had it executed from inside this hook — cloning a repo was enough to run its code.
#
# Bootstrapping the shared resolver must not repeat the mistake, so it is install-mirror
# first and script-relative second — never the visited repo.
# The env here may have been chosen by the repo we are visiting (a project's
# .claude/settings.json `env` block is inherited by hooks), so REIN_HOME is NOT read:
# pointing it at a decoy made this bootstrap SOURCE the decoy's own locate.sh, i.e.
# arbitrary shell inside a fail-closed gate. Assigned here, in the hook's own text, so it
# overrides anything inherited.
# Exported so a child process — a `rein` subcommand spawned from this hook — inherits
# the same judgement rather than defaulting back to trusting the environment.
export REIN_LOCATE_UNTRUSTED_ENV=1
_REIN_HOME_DIR="${HOME}/.rein"
# The guard below asks `declare -f rein_locate`, which means "is a name defined", NOT
# "did my source succeed". bash imports exported functions from the environment at
# startup, so an inherited `rein_locate` satisfies it, the safe inline fallback is never
# installed, and the attacker's function IS the resolver — reachable whenever
# shared/locate.sh is absent, i.e. exactly the degraded install the fallback exists for.
unset -f rein_locate rein_locate_enable_dev_tree rein_is_framework_clone 2>/dev/null || true
for _l in "${_REIN_HOME_DIR}/shared/locate.sh" \
          "$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/../src/shared/locate.sh"; do
  [[ -f "$_l" ]] && { . "$_l"; break; }
done
# Fail-open: these hooks must still run without the resolver (a missing helper is a
# degraded gate, an aborted hook is a broken session). The fallback is the install
# mirror alone — it never falls back to the visited repo.
if ! declare -f rein_locate >/dev/null 2>&1; then
  rein_locate() { local _c="${_REIN_HOME_DIR}/${1}"; [[ -f "$_c" ]] && { printf '%s' "$_c"; return 0; }; return 1; }
fi

set -uo pipefail
# D-172 r2a: the Architect's session (and so this hook) starts in <project>/.ai: step up to the root.
[[ ! -d .ai && "${PWD##*/}" == ".ai" ]] && { cd .. || exit 0; }

# E-463: the role is NOT read from an argument or the environment (a project's settings `env`
# reaches this process). It is the most restricted live launch record on this process chain
# (shared/launch-record.py role); none at all is the plain-launch default, `engineer`, marked
# unverified. Fail-open: a missing helper leaves the stamp `unverified`, never a blocked start.
ROLE=""
ROLE_LAUNCH=""

# Read the SessionStart payload once.
PAYLOAD="$(cat 2>/dev/null || true)"

_LR="$(rein_locate shared/launch-record.py || true)"
if [[ -n "$_LR" ]] && command -v python3 >/dev/null 2>&1; then
  IFS=$'\t' read -r ROLE ROLE_LAUNCH < <(python3 -I "$_LR" role 2>/dev/null) || true
fi
case "$ROLE" in architect|engineer) : ;; *) ROLE="" ;; esac

# ── E-208: the role stamp ─────────────────────────────────────────────────────
# E-208 (D-054, role-abstraction.md §Components 2): the FIRST line of the injected
# context is an `[REIN_ROLE] <role>` stamp naming the role this session actually
# holds. The Role Resolution clause at the top of ENGINEER.md / ARCHITECT.md keys
# off it, so a Claude pane bound to `architect` is governed by ARCHITECT.md even
# though CLAUDE.md statically imports ENGINEER.md (gap G1 — @import cannot branch).
#
# The stamp is emitted even when node is missing: the persona layer must never silently
# lose its role binding. Only a missing python3 (no way to build the JSON envelope) skips it.
# No verified role → the stamp says so and names the fix; the persona layer then follows
# ARCHITECT.md (any stamp other than `engineer`), the restricted reading.
if [[ -n "$ROLE" ]]; then
  ROLE_STAMP="[REIN_ROLE] ${ROLE}"
  [[ "$ROLE_LAUNCH" == "unverified" ]] && ROLE_STAMP="${ROLE_STAMP}
[REIN_LAUNCH] unverified — no launch record on this process chain (plain launch); \`rein pane <role>\` binds one"
else
  ROLE_STAMP="[REIN_ROLE] unverified
[ROLE_UNVERIFIED] the launch records on this process chain disagree or cannot be read. run: rein pane <role>"
fi

command -v python3 >/dev/null 2>&1 || exit 0

# E-326 (D-102 §Component 2): bring a team project's index up to the record files a pull
# brought in while no session was running. E-342 (D-106 r2): a legacy project imports HEAD's
# tracked state.json, and starts node only when its blob id differs from the last import's.
# The import never fails the session; its lines reach the model's context.
_IMP_RUN=0
if [[ -f ".ai/project.json" ]]; then
  _IMP_RUN=1
elif [[ -d ".ai" ]]; then
  _IMP_BLOB="$(git rev-parse -q --verify HEAD:.ai/state.json 2>/dev/null || true)"
  _IMP_LAST=""
  [[ -f ".ai/.last-import-blob" ]] && IFS= read -r _IMP_LAST < ".ai/.last-import-blob"
  [[ -n "$_IMP_BLOB" && "$_IMP_BLOB" != "$_IMP_LAST" ]] && _IMP_RUN=1
fi
if [[ "$_IMP_RUN" == "1" ]] && command -v node >/dev/null 2>&1; then
  _CS="$(rein_locate shared/cli-state.mjs || true)"
  if [[ -n "$_CS" ]]; then
    _IMP="$(node --no-warnings "$_CS" state import --hook session-start 2>&1 || true)"
    [[ -n "$_IMP" ]] && ROLE_STAMP="${ROLE_STAMP}
${_IMP}"
  fi
fi

# E-430 (D-159 r3, harness-fitness.md §Component 1 Triggers): rebuild .ai/DIGEST.md before the
# context is emitted, so no session reads a stale digest. The builder comes from the install
# mirror (rein_locate, E-225), never from the project tree. Fail-open and silent on success:
# the file is rewritten only when its inputs changed; an error leaves the old file and adds one
# context line.
if [[ -d ".ai" ]] && command -v node >/dev/null 2>&1; then
  _DG="$(rein_locate shared/digest-build.mjs || true)"
  if [[ -n "$_DG" ]]; then
    _DGO="$(node --no-warnings "$_DG" build "$PWD" 2>/dev/null)" || {
      _DGR="${_DGO#\[DIGEST_BUILD_FAILED\] }"
      ROLE_STAMP="${ROLE_STAMP}
[DIGEST_BUILD_FAILED] ${_DGR:-builder exited non-zero} — run: rein digest build"
    }
  fi
fi

# E-331 (D-102 §4): a team project fetches origin/<trunk> (E-341; bounded to 3 s, skipped offline —
# git's own failure) so the claim gate and the banner below see teammates' claims, and lists
# the IN_PROGRESS tasks there with their holders. No team.json: no fetch, no node.
if [[ -f ".ai/team.json" ]] && command -v node >/dev/null 2>&1; then
  _CS="$(rein_locate shared/cli-state.mjs || true)"
  if [[ -n "$_CS" ]]; then
    _CLM="$(node --no-warnings "$_CS" task claims --fetch 2>/dev/null || true)"
    [[ -n "$_CLM" ]] && ROLE_STAMP="${ROLE_STAMP}
${_CLM}"
  fi
fi

# ── E-460 (D-169, lean-core.md §Component 3): the anomaly checks the preflight skill ran ──
# Deterministic, and silent when nothing is wrong: each adds ONE line only on a failure.
# (The fourth anomaly, a failed digest build, is the [DIGEST_BUILD_FAILED] line above.)
ANOM=""
_add_anom() { [[ -n "$1" ]] && ANOM="${ANOM}${ANOM:+
}$1"; return 0; }
if [[ -d ".ai" ]] && command -v node >/dev/null 2>&1; then
  # State behind HEAD: the index lags the tracked state.json (E-344's verdict line).
  _CS="$(rein_locate shared/cli-state.mjs || true)"
  if [[ -n "$_CS" ]]; then
    _SH="$(node --no-warnings "$_CS" state health --short 2>/dev/null || true)"
    case "$_SH" in
      "WARN: ["*) _add_anom "${_SH#WARN: }" ;;
      WARN:*)     _add_anom "[STATE_HEALTH] ${_SH#WARN: }" ;;
    esac
  fi
  # Stale build: a running MCP server booted older code than the install mirror holds.
  _BS="$(rein_locate shared/build-stamp.mjs || true)"
  if [[ -n "$_BS" ]]; then
    _ST="$(node --no-warnings "$_BS" --stale 2>/dev/null || true)"
    [[ -n "$_ST" ]] && _add_anom "${_ST} — restart the MCP servers before trusting their answers"
  fi
  # D-172 addendum 1 r24 (F8, accepted residual): a file under .ai/ or plans/ that is not a
  # record can be run by a tool the Engineer points at the root. The Engineer is told; the
  # rule lives in src/shared/lane-code.mjs only (`rein handoff` prints the same line).
  if [[ "$ROLE" == "engineer" ]]; then
    _LC="$(rein_locate shared/lane-code.mjs || true)"
    [[ -n "$_LC" ]] && _add_anom "$(node --no-warnings "$_LC" "$PWD" 2>/dev/null || true)"
  fi
fi
# Uncommitted COMM.md (D-104 r4): the handoff channel must be committed to reach the other role.
_CMS="$(rein_locate shared/comm-status.sh || true)"
if [[ -d ".ai" && -n "$_CMS" ]]; then
  # shellcheck source=src/shared/comm-status.sh
  . "$_CMS"
  _CM_ST="$(rein_comm_status .)"
  case "$_CM_ST" in
    UNCOMMITTED*) _add_anom "[COMM_UNCOMMITTED] .ai/COMM.md has ${_CM_ST#UNCOMMITTED } line(s) not in HEAD — commit it: git add .ai/COMM.md && git commit --only .ai/COMM.md" ;;
    IGNORED)      _add_anom "[COMM_IGNORED] .ai/COMM.md is git-ignored, so a handoff never reaches the other role — run: rein sync" ;;
  esac
fi

_BRANCH="$(git symbolic-ref -q --short HEAD 2>/dev/null || true)"
[[ -z "$_BRANCH" ]] && _BRANCH="$(git rev-parse -q --short HEAD 2>/dev/null)" && _BRANCH="detached at ${_BRANCH}"

# The brief: the stamp first, then the branch, the role's next five open tasks, the last
# handoff's heading and the anomalies. Capped at 2048 bytes (UTF-8) on a line boundary; the
# stamp's first line always survives. Built in python3, which the envelope needs anyway.
REIN_BRIEF_STAMP="$ROLE_STAMP" REIN_BRIEF_ANOM="$ANOM" REIN_BRIEF_ROLE="$ROLE" \
REIN_BRIEF_BRANCH="${_BRANCH:-}" python3 -I -c '
import json, os, re
LIMIT, TASK_W = 2048, 160
env = os.environ
role = env.get("REIN_BRIEF_ROLE", "")
prefix = "P-" if role == "architect" else "E-"
out = [l[:300] for l in env.get("REIN_BRIEF_STAMP", "").splitlines() if l.strip()]
if env.get("REIN_BRIEF_BRANCH"):
    out.append("Branch: " + env["REIN_BRIEF_BRANCH"])
def read(p):
    try:
        with open(p, encoding="utf-8", errors="replace") as f: return f.read()
    except OSError: return None
# D-172 r15: OPEN tasks of this role (not BLOCKED), highest id first, from the state.json view (it
# has the status); without it, the TASKS.md rows (open or blocked: that view shows no status).
try:
    st = json.loads(read(".ai/state.json") or "null")
    rows = [(t["id"], str(t.get("description") or ""), t.get("tier")) for t in st.get("tasks", [])
            if isinstance(t, dict) and t.get("status") == "OPEN" and re.fullmatch(re.escape(prefix) + r"\d+", str(t.get("id", "")))]
except (ValueError, AttributeError, TypeError, KeyError):
    rows, tasks = None, read(".ai/TASKS.md")
    if tasks is not None:
        rows = []
        for tid, text in re.findall(r"^- \[ \] (" + re.escape(prefix) + r"\d+): (.*)$", tasks, re.M):
            m = re.search(r"\s*\|\s*Tier:\s*(\d)\s*$", text)
            rows.append((tid, text[:m.start()] if m else text, int(m.group(1)) if m else None))
if rows is not None:
    rows.sort(key=lambda r: int(r[0][len(prefix):]), reverse=True)
    out.append(f"Next {prefix}## tasks ({min(5, len(rows))} of {len(rows)} open, highest id first; orders: .ai/TASKS.md):" if rows else f"No open {prefix}## tasks in .ai/TASKS.md.")
    for tid, body, tier in rows[:5]:
        body = " ".join(body.split())
        if len(body) > TASK_W: body = body[:TASK_W - 1].rstrip() + "…"
        out.append(f"- {tid}: {body}" + (f" | Tier {tier}" if tier in (1, 2, 3) else ""))
comm = read(".ai/COMM.md")
if comm:
    heads = re.findall(r"^## .*$", comm, re.M)
    if heads: out.append("Last handoff (.ai/COMM.md): " + heads[-1][3:].strip()[:200])
out += [l[:400] for l in env.get("REIN_BRIEF_ANOM", "").splitlines() if l.strip()]
text = "\n".join(out)
if len(text.encode()) > LIMIT:
    mark = "[BRIEF_TRUNCATED] the session brief passed 2048 bytes"
    keep = []
    for l in out:
        if len(("\n".join(keep + [l, mark])).encode()) > LIMIT: break
        keep.append(l)
    text = "\n".join((keep or [out[0][:LIMIT - len(mark) - 1]]) + [mark])
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}), end="")
' 2>/dev/null || exit 0
exit 0
