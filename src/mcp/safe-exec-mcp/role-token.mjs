// role-token.mjs — E-294 (D-083 r9, D-087; sovereignty-hardening.md Components 8d–8e): the
// session role token, v2. ONE implementation of the mint and the verify, consumed by the
// safe-exec gate modes (--check, --check-path, --verify-role, --mint-token), and through
// --verify-role by `pre-commit` and caller-role.mjs.
//
// Invariant (D-087): a role may only move toward restriction.
//   - The ROLE never comes from argv or the environment: the mint asks the launch-record
//     module (src/shared/launch-record.py, Component 8a) for the most restricted live launch
//     record on the process chain.
//   - The token is BOUND to its session process: {v:2, role, session_id, launch, pid, started,
//     hmac}, HMAC over `v2|role|sid|launch|pid|started`. It verifies only for a descendant of
//     that process (whose start time still matches), so CLAUDE_CODE_SESSION_ID is a selector,
//     never an authority (T-GITLANE-001 residual 2, closed).
//   - v1 tokens never verify; v1 is recognised only in mint-table row 4.
//
// Same-uid ceiling (T-ROLE-001): the key, the token and the record are files the operator's uid
// can write; the gate (GATE_SELF_DISABLE, ~/.rein/** write block) and the classifier backstop
// raise the cost of touching them. Removing both a record and a token returns a pane to the
// plain-launch default — never to a less restricted role than that.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  renameSync, unlinkSync, writeFileSync, constants as FS,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ARCHITECT = "architect";
export const ENGINEER = "engineer";
const RANK = { engineer: 1, architect: 2 };
const MAX_BYTES = 4096;

const _SECRETS_DIR = join(homedir(), ".rein", "secrets");
const _RUN_DIR = join(homedir(), ".rein", "run");
const _KEY_PATH = join(_SECRETS_DIR, "role-hmac.key");

// ── the launch-record module (8a) ────────────────────────────────────────────
// Resolved beside THIS module (repo: src/mcp/safe-exec-mcp → src/shared; install:
// ~/.rein/mcp/safe-exec-mcp → ~/.rein/shared), never from the cwd or the environment.
const LAUNCH_RECORD = fileURLToPath(new URL("../../shared/launch-record.py", import.meta.url));

// The interpreter: the install-time pin (E-286) when recorded, else the system python3. Never
// PATH — an MCP server's PATH is whatever its launch environment said, and a decoy python3
// that prints "engineer" would be a role.
function _python() {
  try {
    const raw = readFileSync(join(homedir(), ".rein", "shared", "toolchain.sh"), "utf8");
    const m = raw.match(/^REIN_TC_PYTHON3=([A-Za-z0-9._/@+:-]+)$/m);
    if (m && m[1].startsWith("/") && existsSync(m[1])) return m[1];
  } catch { /* fall through */ }
  return "/usr/bin/python3";
}

/** Run the launch-record CLI. Returns { status, stdout } — never throws. */
export function launchRecord(args) {
  if (!existsSync(LAUNCH_RECORD)) return { status: 127, stdout: "" };
  try {
    // -I: isolated (no PYTHON* env, no cwd on sys.path); -S: no site import — not needed, and
    // it is most of the interpreter's start-up on this path (SessionStart, pre-commit, doctor).
    const stdout = execFileSync(_python(), ["-I", "-S", LAUNCH_RECORD, ...args], {
      encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
    });
    return { status: 0, stdout };
  } catch (e) {
    // A spawn failure (EAGAIN under a process limit) or a timeout kill has no numeric status:
    // that is UNKNOWN (127), never the module's own exit 1 ("not alive" / "not an ancestor") —
    // reading it as 1 let a refused mint delete a LIVE token (critic_security 2nd pass, P2-1).
    return { status: typeof e.status === "number" ? e.status : 127, stdout: String(e.stdout || "") };
  }
}

// ── key, signing, paths ──────────────────────────────────────────────────────
export function getMachineKey() {
  try {
    if (existsSync(_KEY_PATH)) return readFileSync(_KEY_PATH, "utf8").trim();
    mkdirSync(_SECRETS_DIR, { recursive: true, mode: 0o700 });
    const key = randomBytes(32).toString("hex");
    writeFileSync(_KEY_PATH, key, { mode: 0o600, flag: "wx" });
    return key;
  } catch {
    try { return readFileSync(_KEY_PATH, "utf8").trim() || null; } catch { return null; }
  }
}

function _hmac(key, text) {
  return createHmac("sha256", Buffer.from(key, "hex")).update(text).digest("hex");
}
function _sameHex(a, b) {
  const x = Buffer.from(String(a), "hex");
  const y = Buffer.from(String(b), "hex");
  return x.length === 32 && x.length === y.length && timingSafeEqual(x, y);
}
export function signV2(t, key) {
  return _hmac(key, `v2|${t.role}|${t.session_id}|${t.launch}|${t.pid}|${t.started}`);
}
function _signV1(role, sid, key) {
  return _hmac(key, `v1|${role}|${sid}`);
}

export function sanitizeSid(sid) {
  return String(sid || "").replace(/[^A-Za-z0-9._-]/g, "");
}
export function tokenPath(sid) {
  return join(_RUN_DIR, `role-${sanitizeSid(sid)}.lock`);
}

/**
 * Read the token at a session id's path. lstat first; the file is opened O_NOFOLLOW and
 * checked on the descriptor. Returns {state, tok}:
 *   "absent" — nothing at the path;
 *   "v2" / "v1" — HMAC-valid token of that version;
 *   "bad" — anything else (not a regular file, wrong owner, nlink != 1, oversize,
 *           unparsable, wrong session id, bad HMAC). Mint-table row 5: never replaced.
 */
export function readToken(sid, key = getMachineKey()) {
  const clean = sanitizeSid(sid);
  const p = tokenPath(clean);
  let lst;
  try { lst = lstatSync(p); } catch { return { state: "absent" }; }
  if (!lst.isFile()) return { state: "bad", why: "not a regular file" };
  if (!key) return { state: "bad", why: "no machine key" };
  let fd;
  try {
    fd = openSync(p, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return { state: "bad", why: "not a regular file" };
    if (typeof process.geteuid === "function" && st.uid !== process.geteuid()) return { state: "bad", why: "not owned by you" };
    if (st.nlink !== 1) return { state: "bad", why: "more than one link" };
    if (st.size > MAX_BYTES) return { state: "bad", why: "larger than 4 KB" };
    const buf = Buffer.alloc(MAX_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const tok = JSON.parse(buf.subarray(0, n).toString("utf8"));
    if (!tok || typeof tok !== "object" || tok.session_id !== clean || !RANK[tok.role]) {
      return { state: "bad", why: "malformed token" };
    }
    if (tok.v === 2) {
      if (!["record", "unverified"].includes(tok.launch) || !Number.isInteger(tok.pid) || tok.pid <= 1
          || typeof tok.started !== "string" || !tok.started) return { state: "bad", why: "malformed v2 token" };
      return _sameHex(signV2(tok, key), tok.hmac) ? { state: "v2", tok } : { state: "bad", why: "HMAC mismatch" };
    }
    if (tok.v === 1) {
      return _sameHex(_signV1(tok.role, clean, key), tok.hmac) ? { state: "v1", tok } : { state: "bad", why: "HMAC mismatch" };
    }
    return { state: "bad", why: "unknown token version" };
  } catch {
    return { state: "bad", why: "unreadable token" };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

// ── mint (8d) ────────────────────────────────────────────────────────────────
function _refuse(why) {
  process.stderr.write(`[safe-exec] mint refused: ${why} (E-294, D-087).\n`);
  return { minted: false, why };
}

/**
 * `--mint-token <sid> <session pid>`. The role comes from the walk; nothing in argv names it.
 * Returns {minted, role?, launch?, why?}. Refuse = file untouched, one stderr line.
 */
export function mintToken(sid, sessionPidArg) {
  const clean = sanitizeSid(sid);
  if (!clean || clean !== String(sid)) return _refuse("missing or malformed session id");
  if (RANK[String(sid).toLowerCase()]) return _refuse("a role word is not a session id — the role is derived, never passed");
  if (!/^[0-9]{1,10}$/.test(String(sessionPidArg || ""))) return _refuse("missing or malformed session pid");
  const spid = Number(sessionPidArg);
  const key = getMachineKey();
  if (!key) return _refuse("no machine key");

  const cur = readToken(clean, key);
  // critic_security P2-2: a refused mint must not leave a DEAD process's v2 token in place —
  // under pid reuse the hot path (pid equality) could honour it. Deleting it only moves the
  // session toward the union. Alive status 2 (unknown) is never read as dead.
  const refuseDropDead = (why) => {
    if (cur.state === "v2" && launchRecord(["alive", String(cur.tok.pid), cur.tok.started]).status === 1) {
      try { unlinkSync(tokenPath(clean)); } catch { /* already gone */ }
    }
    return _refuse(why);
  };

  const ctxRun = launchRecord(["mint-context", String(spid)]);
  let ctx;
  try { ctx = JSON.parse(ctxRun.stdout); } catch { return refuseDropDead("launch-record module unavailable"); }
  if (!ctx.session_on_chain || !ctx.session_started) return refuseDropDead(`session pid ${spid} is not an ancestor of the minter`);
  const w = ctx.walk || {};
  if (w.result !== "role" || !RANK[w.role]) return refuseDropDead(`no role on this chain (${w.why || "union"})`);

  const want = { v: 2, role: w.role, session_id: clean, launch: w.launch, pid: spid, started: ctx.session_started };
  if (cur.state === "bad") return _refuse(`a token already exists and is not valid (${cur.why}) — it is never replaced`);
  if (cur.state === "v2" && cur.tok.pid === spid && cur.tok.started === want.started) {
    return { minted: false, role: cur.tok.role, launch: cur.tok.launch, why: "already bound to this session process" };
  }
  if (cur.state === "v2" && launchRecord(["alive", String(cur.tok.pid), cur.tok.started]).status === 0) {
    return _refuse(`session id is bound to another live process (pid ${cur.tok.pid})`);
  }
  if (cur.state === "v2" || cur.state === "v1") {
    if (RANK[want.role] < RANK[cur.tok.role]) {
      return refuseDropDead(`would move ${cur.tok.role} → ${want.role}; a role only moves toward restriction`);
    }
  }
  try {
    mkdirSync(_RUN_DIR, { recursive: true, mode: 0o700 });
    want.hmac = signV2(want, key);
    const tmp = `${tokenPath(clean)}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(want), { mode: 0o600, flag: "wx" });
    renameSync(tmp, tokenPath(clean));
  } catch (e) {
    return _refuse(`write failed: ${e.message}`);
  }
  return { minted: true, role: want.role, launch: want.launch };
}

// ── verify (8e) ──────────────────────────────────────────────────────────────
/**
 * The HMAC-verified role for a session id, or null.
 * `sessionPid` (the PreToolUse hot path) — the hook's own PPID: equality with the token's pid
 * suffices and no process table is read. Without it, the token's pid must be an ancestor of
 * this process with the recorded start time.
 */
export function verifyToken(sid, { sessionPid = null } = {}) {
  const r = readToken(sid);
  if (r.state !== "v2") {
    if (r.state === "bad") process.stderr.write(`[safe-exec] role token for ${sanitizeSid(sid)} rejected (${r.why}).\n`);
    return null;
  }
  const t = r.tok;
  if (sessionPid !== null) {
    return /^[0-9]{1,10}$/.test(String(sessionPid)) && Number(sessionPid) === t.pid ? t.role : null;
  }
  // Off the hot path: the token's session process must be an ANCESTOR of this process with the
  // recorded start time, AND the role is the more restrictive of the token's and the walk from
  // here (critic_security P2-1): an `ai pane architect` started inside a plain session sits
  // BETWEEN the plain session's token and this process, and must win. A union walk → no role.
  const r2 = launchRecord(["verify-context", String(t.pid), t.started]);
  let ctx;
  try { ctx = JSON.parse(r2.stdout); } catch { return null; }
  if (!ctx.ancestor) return null;
  const w = ctx.walk || {};
  if (w.result !== "role" || !RANK[w.role]) return null;
  return RANK[w.role] > RANK[t.role] ? w.role : t.role;
}

export const ROLE_UNVERIFIED_LINE =
  "[ROLE_UNVERIFIED] no verified role token for this session — every role's blocks apply. run: ai pane <role>";
