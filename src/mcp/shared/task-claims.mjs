/**
 * task-claims.mjs — task claims on origin/<trunk> (E-331, D-102 §Component 4; E-341, D-105)
 *
 * An Engineer claims a task before writing source for it. A claim is ONE bookkeeping commit
 * on top of origin/<trunk> that rewrites `.ai/tasks/<id>.json` (status IN_PROGRESS, assignee,
 * claimed_at, claim_sha = the trunk sha it was built on), pushed straight to the trunk: every
 * teammate sees it with a fetch, and the first push wins — a non-fast-forward is a lost race.
 * The commit is built with plumbing on a throwaway index, so the working tree, the branch and
 * the local index are never touched; the claim reaches this clone's record files the next
 * time the trunk is merged in, like any other teammate's change.
 *
 * The trunk comes from trunk.mjs (team.json "trunk" → origin/HEAD → main|master), resolved
 * once per call; an unresolved trunk is a [NO_TRUNK] refusal, never a guess.
 *
 * Release and DONE clear the claim the same way. Offline nothing is published: the claim is
 * pending, and a pending claim does not satisfy the claim gate (claimGate below, called by
 * safe-exec for an Engineer writing on an engineer/e<N>-* branch).
 *
 * Without .ai/team.json none of this applies: no fetch, no gate, claim_task refuses.
 */

import { execFileSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { resolve, dirname, isAbsolute } from "path";
import { gitEmail, readRecord, assertTaskRecord, CLAIM_KEYS } from "./record-store.mjs";
import { readTeam } from "./team.mjs";
import { resolveTrunk } from "./trunk.mjs";

const TASK_ID_RE   = /^[A-Z]+-\d+$/;
const META         = ["rev", "updated_at", "origin"];
const DAY_MS       = 86_400_000;
const PUSH_RETRIES = 2;

// Never prompt (a hook or an MCP server has no terminal) and never hang on a dead host.
// ssh's BatchMode/ConnectTimeout go in GIT_SSH_COMMAND only when neither the
// environment nor the repo (core.sshCommand, e.g. a custom -i key) already chose the command.
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };
const _sshEnv = new Map();
function _sshFor(root) {
  if (!_sshEnv.has(root)) {
    let own = !!process.env.GIT_SSH_COMMAND || !!process.env.GIT_SSH;
    if (!own) {
      try {
        own = execFileSync("git", ["config", "core.sshCommand"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim() !== "";
      } catch { own = false; }
    }
    _sshEnv.set(root, own ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5" });
  }
  return _sshEnv.get(root);
}

const _root = (aiDir) => dirname(resolve(aiDir));

function _git(root, args, { input, env = {}, timeout = 15000 } = {}) {
  return execFileSync("git", args, {
    cwd: root, encoding: "utf8", input, timeout,
    env: { ...process.env, ...GIT_ENV, ..._sshFor(root), ...env },
    stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

function _gitTry(root, args, opts) {
  try { return _git(root, args, opts); } catch { return null; }
}

// One line, bounded: this text reaches a commit message and the model's context.
const _oneLine = (s, n = 200) => String(s ?? "").replace(/[\r\n\x00-\x1f\x7f]+/g, " ").trim().slice(0, n);

/** {name, ref} for the resolved trunk, or {refusal} carrying the [NO_TRUNK] line. */
export function trunkOf(root, team) {
  const t = resolveTrunk(root, { team });
  if (!t.name) return { refusal: { ok: false, code: "NO_TRUNK", message: t.message } };
  return { name: t.name, ref: `refs/remotes/origin/${t.name}` };
}

/**
 * Refresh origin/<trunk>. "ok" | "offline" (no origin, no network) | "missing" (origin
 * answered and has no such branch — D-105 r4's [TRUNK_MISSING]).
 */
export function fetchTrunk(root, trunk, { timeoutMs = 15000 } = {}) {
  try {
    _git(root, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${trunk.name}:${trunk.ref}`], { timeout: timeoutMs });
    return "ok";
  } catch (e) {
    return /couldn't find remote ref/i.test(String(e.stderr || "")) ? "missing" : "offline";
  }
}

export function trunkSha(root, trunk) {
  const sha = _gitTry(root, ["rev-parse", "--verify", "--quiet", `${trunk.ref}^{commit}`]);
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** The task's record on origin/<trunk> as last fetched (no network). null when absent; throws on a bad record. */
export function trunkRecord(root, trunk, id, sha = trunkSha(root, trunk)) {
  if (!sha || !TASK_ID_RE.test(id)) return null;
  const text = _gitTry(root, ["cat-file", "blob", `${sha}:.ai/tasks/${id}.json`]);
  if (text == null) return null;
  let rec;
  try { rec = JSON.parse(text); } catch { throw new Error(`origin/${trunk.name} .ai/tasks/${id}.json is not valid JSON`); }
  assertTaskRecord(id, rec);
  return rec;
}

const _missing = (trunk) => ({ ok: false, code: "TRUNK_MISSING", message: `[TRUNK_MISSING] origin has no branch ${trunk.name}` });

const _expired = (rec, team, now) =>
  !rec.claimed_at || now.getTime() - Date.parse(rec.claimed_at) > team.claim_ttl_days * DAY_MS;

const _held = (rec) => rec && rec.status === "IN_PROGRESS" && rec.assignee;

function _strip(rec) {
  const out = { ...rec };
  for (const k of [...META, ...CLAIM_KEYS]) delete out[k];
  return out;
}

// Build "<parent> + .ai/tasks/<id>.json = rec" on a private index and push it to the trunk.
// @returns {"pushed"|"lost"|{failed:string}}
function _publish(root, trunk, id, rec, message, parent) {
  const gitDirRaw = _git(root, ["rev-parse", "--git-dir"]);
  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(root, gitDirRaw);
  const index = resolve(gitDir, `aios-claim-index-${process.pid}-${Date.now()}`);
  let commit;
  try {
    const env = { GIT_INDEX_FILE: index };
    const blob = _git(root, ["hash-object", "-w", "--stdin"], { input: JSON.stringify(rec, null, 2) + "\n" });
    _git(root, ["read-tree", parent], { env });
    _git(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},.ai/tasks/${id}.json`], { env });
    const tree = _git(root, ["write-tree"], { env });
    commit = _git(root, ["commit-tree", tree, "-p", parent, "-m", message]);
  } finally {
    rmSync(index, { force: true });
  }
  try {
    // The pre-push hook runs: a commit that only changes .ai/ rides on the trunk's CI (D-072 §5a).
    _git(root, ["push", "--quiet", "origin", `${commit}:refs/heads/${trunk.name}`], { timeout: 120000 });
    _gitTry(root, ["update-ref", trunk.ref, commit]);
    return "pushed";
  } catch (e) {
    const err = String(e.stderr || e.message || "");
    // A push that lost the race: the trunk moved before ours (non-fast-forward), or while ours
    // was in flight (the remote refuses the ref update it was told to expect).
    if (/non-fast-forward|fetch first|\[rejected\]|\[remote rejected\]|stale info|cannot lock ref|failed to update ref/i.test(err)) return "lost";
    return { failed: _oneLine(err.split("\n").filter((l) => l.trim()).slice(-2).join(" "), 300) };
  }
}

function _who(rec) {
  return `${rec.assignee} since ${String(rec.claimed_at || "").slice(0, 10) || "?"}`;
}

/**
 * Publish a new version of a task record on the trunk, rebuilding on the new tip when it
 * moved for an unrelated reason. `make(base, sha)` returns the record to publish, or a
 * refusal {ok:false,…}. @returns {{ok:boolean, code:string, message:string, record?:object}}
 */
function _update(aiDir, trunk, id, verb, make, message) {
  const root = _root(aiDir);
  const on = `origin/${trunk.name}`;
  for (let attempt = 0; attempt <= PUSH_RETRIES; attempt++) {
    const fetched = fetchTrunk(root, trunk);
    if (fetched === "missing") return _missing(trunk);
    if (fetched !== "ok") {
      // The blueprint's [OFFLINE]: the claim is pending — nothing is published or stored, so it
      // cannot satisfy the gate; running it again once online publishes it.
      return { ok: false, code: "OFFLINE", message: `[OFFLINE] ${id} — ${on} could not be fetched; the ${verb.toLowerCase()} is pending: nothing was published, so it does not count yet. Run it again when online.` };
    }
    const sha = trunkSha(root, trunk);
    if (!sha) return _missing(trunk);
    const onTrunk = trunkRecord(root, trunk, id, sha);
    const base = onTrunk || readRecord(aiDir, "task", id);
    if (!base) return { ok: false, code: "NOT_FOUND", message: `${id} is not a task on ${on} or in this clone.` };
    const next = make(base, sha);
    if (next.ok === false) return next;
    const rec = { ...next, rev: (Number.isInteger(base.rev) ? base.rev : 0) + 1, updated_at: new Date().toISOString(), origin: gitEmail(aiDir) };
    assertTaskRecord(id, rec);
    const res = _publish(root, trunk, id, rec, message, sha);
    if (res === "pushed") return { ok: true, code: verb, message: "", record: rec };
    if (res !== "lost") return { ok: false, code: `${verb}_PENDING`, message: `[${verb}_PENDING] ${id} — the push to ${trunk.name} was refused: ${res.failed}` };
    // The trunk moved under us. Someone else's claim → lost; anything else → rebuild on the new tip.
    fetchTrunk(root, trunk);
    const now = trunkRecord(root, trunk, id);
    if (verb === "CLAIM" && _held(now) && now.assignee !== gitEmail(aiDir)) {
      return { ok: false, code: "CLAIM_LOST", message: `[CLAIM_LOST] ${id} — ${_who(now)} pushed first.` };
    }
  }
  return { ok: false, code: `${verb}_PENDING`, message: `[${verb}_PENDING] ${id} — ${on} kept moving; run it again.` };
}

function _teamOrRefusal(aiDir) {
  const team = readTeam(aiDir);
  if (!team) return { refusal: { ok: false, code: "NO_TEAM", message: "claims need .ai/team.json (a team project) — a single-operator project has no claims." } };
  const email = gitEmail(aiDir);
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return { refusal: { ok: false, code: "NO_GIT_EMAIL", message: "set `git config user.email` first — a claim names its holder by it." } };
  const trunk = trunkOf(_root(aiDir), team);
  if (trunk.refusal) return trunk;
  return { team, email, trunk };
}

/** `ai task claim <id>` / claim_task. */
export function claimTask(aiDir, id, { now = () => new Date() } = {}) {
  if (!TASK_ID_RE.test(id || "")) return { ok: false, code: "BAD_ID", message: `invalid task id ${JSON.stringify(id)}` };
  const { team, email, trunk, refusal } = _teamOrRefusal(aiDir);
  if (refusal) return refusal;
  let already = false;
  const res = _update(aiDir, trunk, id, "CLAIM", (base, sha) => {
    if (base.status === "DONE") return { ok: false, code: "ALREADY_DONE", message: `${id} is DONE — nothing to claim.` };
    if (base.status === "BLOCKED") return { ok: false, code: "TASK_BLOCKED", message: `${id} is BLOCKED by its dependencies — claim it once it is OPEN.` };
    const t = now();
    if (_held(base) && base.assignee === email) { already = true; return { ok: false, code: "ALREADY_CLAIMED" }; }
    if (_held(base) && !_expired(base, team, t)) {
      return { ok: false, code: "CLAIM_HELD", message: `[CLAIM_HELD] ${id} by ${_who(base)}` };
    }
    const prev = _held(base) ? base.assignee : null;   // an expired claim is taken over
    return { ..._strip(base), status: "IN_PROGRESS", assignee: email, claimed_at: t.toISOString(), claim_sha: sha, ...(prev ? { claim_prev: prev } : {}) };
  }, `chore(.ai): claim ${id}`);
  if (already) return { ok: true, code: "ALREADY_CLAIMED", message: `${id} is already claimed by you on origin/${trunk.name}.` };
  if (!res.ok) return res;
  const over = res.record.claim_prev ? ` (taken over from ${res.record.claim_prev}, whose claim was older than ${team.claim_ttl_days} days)` : "";
  return { ...res, message: `✓ ${id} claimed by ${email} on origin/${trunk.name}${over} — the claim gate now lets you write source on engineer/e${id.split("-")[1]}-*` };
}

/** `ai task release <id> [reason]` / release_task. Only the holder releases; an expired claim is taken over instead. */
export function releaseTask(aiDir, id, reason = null) {
  if (!TASK_ID_RE.test(id || "")) return { ok: false, code: "BAD_ID", message: `invalid task id ${JSON.stringify(id)}` };
  const { email, trunk, refusal } = _teamOrRefusal(aiDir);
  if (refusal) return refusal;
  const why = _oneLine(reason);
  const res = _update(aiDir, trunk, id, "RELEASE", (base) => {
    if (!_held(base)) return { ok: false, code: "NOT_CLAIMED", message: `${id} is not claimed on origin/${trunk.name}.` };
    if (base.assignee !== email) return { ok: false, code: "NOT_HOLDER", message: `${id} is held by ${_who(base)}, not by you.` };
    return { ..._strip(base), status: "OPEN" };
  }, `chore(.ai): release ${id}${why ? ` — ${why}` : ""}`);
  return res.ok ? { ...res, message: `✓ ${id} released on origin/${trunk.name} — OPEN for anyone to claim` } : res;
}

/**
 * After a DONE in this clone: publish the DONE record on the trunk, clearing the claim there.
 * Returns null when there is nothing to do (no team.json, or the trunk holds no claim of ours),
 * else a result whose message is one line for the DONE output.
 */
export function publishDone(aiDir, id) {
  const team = readTeam(aiDir);
  if (!team) return null;
  const email = gitEmail(aiDir);
  const local = readRecord(aiDir, "task", id);
  if (!local || local.status !== "DONE") return null;
  const root = _root(aiDir);
  const trunk = trunkOf(root, team);
  if (trunk.refusal) return { ...trunk.refusal, message: `${trunk.refusal.message} — a claim on ${id} cannot be cleared` };
  // Cheap look first, with what was last fetched: a task this user never claimed costs no push.
  let seen;
  try { seen = trunkRecord(root, trunk, id); } catch { seen = null; }
  if (!_held(seen) || seen.assignee !== email) {
    if (fetchTrunk(root, trunk) === "ok") {
      try { seen = trunkRecord(root, trunk, id); } catch { seen = null; }
    }
    if (!_held(seen) || seen.assignee !== email) return null;
  }
  const res = _update(aiDir, trunk, id, "DONE", (base) => {
    if (!_held(base) || base.assignee !== email) return { ok: false, code: "NOT_HOLDER", message: "" };
    return { ..._strip(local), status: "DONE" };
  }, `chore(.ai): done ${id}`);
  if (res.ok) return { ...res, message: `claim on origin/${trunk.name} cleared (${id} DONE there)` };
  if (res.code === "NOT_HOLDER") return null;
  return { ...res, message: `${res.message} — origin/${trunk.name} still shows your claim; run: ai task release ${id}` };
}

/**
 * The Engineer claim gate. null = allow; else {code, message} = block.
 * Active only with .ai/team.json, on a branch named engineer/e<N>-*: E-<N> must be claimed by
 * this git user on origin/<trunk> as last fetched. No network: the session-start fetch and the
 * claim's own push keep it current. The LOCAL record is not trusted (critic_security
 * P2): writes under .ai/ are open, so a hand-written IN_PROGRESS record would open the gate
 * without publishing anything. A published claim reaches the local record only by merging
 * the trunk, so origin/<trunk> always has it too. An unresolved trunk keeps the gate closed
 * and says why (D-105 r2: the lock is never silent).
 */
export function claimGate(root) {
  const aiDir = resolve(root, ".ai");
  if (!existsSync(resolve(aiDir, "team.json"))) return null;
  const branch = _gitTry(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || "";
  const m = /^engineer\/e(\d+)-/.exec(branch);
  if (!m) return null;
  const id = `E-${Number(m[1])}`;
  let team;
  try { team = readTeam(aiDir); } catch (e) {
    return { code: "TEAM_INVALID", message: `[CLAIM_REQUIRED] ${id} — .ai/team.json is invalid, so the claim cannot be checked: ${_oneLine(e.message)}` };
  }
  if (!team) return null;
  const email = gitEmail(aiDir);
  const required = `[CLAIM_REQUIRED] ${id} — branch ${_oneLine(branch, 80)} writes source for ${id}`;
  const trunk = trunkOf(root, team);
  if (trunk.refusal) return { code: "CLAIM_REQUIRED", message: `${required}, and no claim can be checked: ${trunk.refusal.message}` };
  const mine = (r) => r && r.status === "IN_PROGRESS" && r.assignee === email && r.claim_sha;
  let seen = null;
  try { seen = trunkRecord(root, trunk, id); } catch { seen = null; }
  if (mine(seen)) return null;
  const holder = _held(seen) ? `; held by ${_who(seen)}` : "";
  return {
    code: "CLAIM_REQUIRED",
    message: `${required}, which is not claimed by ${email} on origin/${trunk.name}${holder}. Claim it first: ai task claim ${id}`,
  };
}

/**
 * The IN_PROGRESS tasks on origin/<trunk> with their holders, for the preflight banner and
 * session start. One line each; nothing without team.json.
 */
export function listClaims(aiDir, { fetch = false, fetchTimeoutMs = 3000, now = new Date() } = {}) {
  let team;
  try { team = readTeam(aiDir); } catch (e) { return [`[CLAIMS] .ai/team.json is invalid: ${_oneLine(e.message)}`]; }
  if (!team) return [];
  const root = _root(aiDir);
  const trunk = trunkOf(root, team);
  if (trunk.refusal) return [`[CLAIMS] ${trunk.refusal.message}`];
  const on = `origin/${trunk.name}`;
  const lines = [];
  if (fetch) {
    const fetched = fetchTrunk(root, trunk, { timeoutMs: fetchTimeoutMs });
    if (fetched === "missing") return [`[CLAIMS] ${_missing(trunk).message} — nothing is claimed`];
    if (fetched !== "ok") lines.push(`[CLAIMS] ${on} not fetched (offline?) — showing the last fetched state`);
  }
  const sha = trunkSha(root, trunk);
  if (!sha) return [...lines, `[CLAIMS] no ${on} yet — nothing is claimed`];
  const names = (_gitTry(root, ["ls-tree", "--name-only", sha, ".ai/tasks/"]) || "")
    .split("\n").map((p) => p.replace(/^\.ai\/tasks\//, "")).filter((f) => /^[A-Z]+-\d+\.json$/.test(f));
  if (names.length === 0) return lines;
  let out;
  try {
    out = execFileSync("git", ["cat-file", "--batch"], {
      cwd: root, input: names.map((f) => `${sha}:.ai/tasks/${f}`).join("\n") + "\n",
      env: { ...process.env, ...GIT_ENV, ..._sshFor(root) }, stdio: ["pipe", "pipe", "ignore"], timeout: 15000, maxBuffer: 64 << 20,
    });
  } catch {
    return [...lines, `[CLAIMS] could not read ${on}'s task records`];
  }
  const email = gitEmail(aiDir);
  // --batch: "<oid> blob <size>\n<content>\n" per object — sizes are BYTES, so walk the Buffer.
  let at = 0;
  const held = [];
  for (const f of names) {
    const nl = out.indexOf(0x0a, at);
    const head = nl < 0 ? null : /^[0-9a-f]{40} blob (\d+)$/.exec(out.subarray(at, nl).toString("latin1"));
    if (!head) break;
    const body = out.subarray(nl + 1, nl + 1 + Number(head[1])).toString("utf8");
    at = nl + 1 + Number(head[1]) + 1;
    const id = f.slice(0, -5);
    try {
      const rec = JSON.parse(body);
      assertTaskRecord(id, rec);
      if (_held(rec)) held.push(rec);
    } catch { lines.push(`[CLAIMS] ${id}: unreadable record on ${on} — skipped`); }
  }
  for (const r of held) {
    const exp = _expired(r, team, now) ? ` (older than ${team.claim_ttl_days} days — claimable)` : "";
    const you = r.assignee === email ? " (you)" : "";
    lines.push(`[CLAIMS] ${r.id} IN_PROGRESS by ${_who(r)}${you}${exp}`);
    if (r.claim_prev === email) lines.push(`[CLAIM_TAKEN_OVER] ${r.id} — your claim expired and ${r.assignee} took it over on ${String(r.claimed_at).slice(0, 10)}`);
  }
  return lines;
}
