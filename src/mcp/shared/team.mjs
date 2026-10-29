/**
 * team.mjs — the team registry and per-developer id ranges (E-327, D-102 §Component 3)
 *
 * `.ai/team.json` (tracked) names the planner and gives every member disjoint id ranges per
 * prefix. Two developers then never mint the same E-### — a collision is structurally
 * impossible, so two clones that each add tasks merge as distinct files with no add/add
 * conflict. Without team.json nothing here applies and nextId keeps its v1 max+1 path.
 *
 *   { "schema": 1, "planner": "<email>", "claim_ttl_days": 7, "shared_log": false,
 *     "members": { "<email>": { "ranges": { "E": [[325, 424]], "P": [[45, 64]] } } } }
 *
 * Optional `"trunk": "<branch>"` (E-341, D-105 r1): the branch claims are published to and the
 * hosted check guards. Absent, trunk.mjs falls back to origin/HEAD, then main|master.
 *
 * team.json arrives by `git pull`, so it is validated on every read; an invalid file is an
 * error, never a silently empty registry. The caller is `git config user.email` — as
 * trustworthy as the commit author, which is the D-102 trust boundary.
 */

import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync, appendFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { gitEmail, listRecords } from "./record-store.mjs";
import { redact } from "../../shared/publish-scan.mjs"; // E-379 (D-130)

export const TEAM_SCHEMA = 1;
const PREFIX_RE = /^[A-Z]{1,4}$/;
const EMAIL_RE  = /^[^\s@"'\\]{1,64}@[^\s@"'\\]{1,190}$/;

export class TeamError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const teamPath = (aiDir) => resolve(aiDir, "team.json");

/**
 * E-341 (D-105 r1): a plain branch name — what `git check-ref-format --branch` accepts, minus
 * the forms it also takes that are not a branch: a full ref (refs/heads/x), an @{-N} shorthand
 * (resolved against whatever repo it runs in, so it is run in tmpdir and refused outright),
 * and HEAD. A leading "-" would read as an option.
 */
export function isBranchName(name) {
  if (typeof name !== "string" || !/^[^-@\s][^\s]{0,199}$/.test(name)) return false;
  if (name === "HEAD" || name.startsWith("refs/") || name.includes("@{")) return false;
  try {
    execFileSync("git", ["check-ref-format", "--branch", name], { cwd: tmpdir(), stdio: "ignore", timeout: 5000 });
    return true;
  } catch { return false; }
}

/** The validated registry, or null when the project has none. Throws TeamError on a bad file. */
export function readTeam(aiDir) {
  const p = teamPath(aiDir);
  if (!existsSync(p)) return null;
  let t;
  try { t = JSON.parse(readFileSync(p, "utf8")); } catch { throw new TeamError("TEAM_INVALID", ".ai/team.json is not valid JSON (a merge conflict?)"); }
  validateTeam(t);
  return t;
}

export function validateTeam(t) {
  const bad = (why) => { throw new TeamError("TEAM_INVALID", `.ai/team.json: ${why}`); };
  if (!t || typeof t !== "object" || Array.isArray(t)) bad("not an object");
  if (t.schema !== TEAM_SCHEMA) bad(`schema must be ${TEAM_SCHEMA}`);
  if (!EMAIL_RE.test(t.planner ?? "")) bad("planner must be an email");
  if (!Number.isInteger(t.claim_ttl_days) || t.claim_ttl_days < 1) bad("claim_ttl_days must be a positive integer");
  if (typeof t.shared_log !== "boolean") bad("shared_log must be true or false");
  if (!t.members || typeof t.members !== "object" || Array.isArray(t.members)) bad("members must be an object");
  for (const [email, m] of Object.entries(t.members)) {
    if (!EMAIL_RE.test(email)) bad(`member ${JSON.stringify(email).slice(0, 60)} is not an email`);
    if (!m || typeof m.ranges !== "object" || Array.isArray(m.ranges)) bad(`${email}: ranges must be an object`);
    for (const [prefix, list] of Object.entries(m.ranges)) {
      if (!PREFIX_RE.test(prefix)) bad(`${email}: bad prefix ${JSON.stringify(prefix).slice(0, 10)}`);
      if (!Array.isArray(list)) bad(`${email}: ${prefix} ranges must be a list`);
      for (const r of list) {
        if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => Number.isInteger(n) && n > 0) || r[0] > r[1]) {
          bad(`${email}: ${prefix} range ${JSON.stringify(r).slice(0, 30)} must be [from, to] with 0 < from ≤ to`);
        }
      }
    }
  }
  const clash = findOverlap(t);
  if (clash) bad(clash);
  if (t.trunk !== undefined && !isBranchName(t.trunk)) bad("trunk must be a valid branch name");
  // E-335 (D-103 r4): the hosted check's record. rein_source is rendered into a wrapper's
  // shell line, so it is held to a plain https URL here as well as at render time.
  if (t.ci !== undefined) {
    const c = t.ci;
    if (!c || typeof c !== "object" || Array.isArray(c)) bad("ci must be an object");
    if (!["github", "azure", "gitlab", "bitbucket"].includes(c.provider)) bad("ci.provider must be github|azure|gitlab|bitbucket");
    if (typeof c.required_check !== "string" || !/^[\w .-]{1,64}$/.test(c.required_check)) bad("ci.required_check must be a short name");
    // E-386/E-384 (D-135 r3): how many shards the rendered matrix runs (1 = one leg).
    if (c.shards !== undefined && !(Number.isInteger(c.shards) && c.shards >= 1 && c.shards <= 8)) bad("ci.shards must be a whole number 1..8");
    if (c.rein_source !== undefined && !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~-]+)+$/.test(c.rein_source)) bad("ci.rein_source must be a plain https git URL");
  }
}

// "<a> E:[1-10] overlaps <b> E:[5-20]" for the first overlap between any two ranges, or null.
function findOverlap(t, extra = null) {
  const all = [];
  for (const [email, m] of Object.entries(t.members)) {
    for (const [prefix, list] of Object.entries(m.ranges)) for (const r of list) all.push({ email, prefix, r });
  }
  if (extra) all.push(extra);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.prefix === b.prefix && a.r[0] <= b.r[1] && b.r[0] <= a.r[1]) {
        return `${b.email} ${b.prefix}:${b.r[0]}-${b.r[1]} overlaps ${a.email} ${a.prefix}:${a.r[0]}-${a.r[1]}`;
      }
    }
  }
  return null;
}

export function writeTeam(aiDir, t) {
  validateTeam(t);
  const p = teamPath(aiDir);
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(t, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  renameSync(tmp, p);
}

/** A fresh registry: the operator is the planner and owns the first ranges. */
export function newTeam(planner, ranges, trunk = null) {
  return { schema: TEAM_SCHEMA, planner, claim_ttl_days: 7, shared_log: false, ...(trunk ? { trunk } : {}), members: { [planner]: { ranges } } };
}

/**
 * Add a range for a member (creating the member). Overlap with anyone — the member
 * included — is refused naming the clash. @returns the updated registry (not written).
 */
export function addRange(t, email, prefix, from, to) {
  if (!EMAIL_RE.test(email)) throw new TeamError("BAD_EMAIL", `not an email: ${JSON.stringify(email).slice(0, 60)}`);
  if (!PREFIX_RE.test(prefix)) throw new TeamError("BAD_RANGE", `bad prefix ${JSON.stringify(prefix).slice(0, 10)}`);
  if (!(Number.isInteger(from) && Number.isInteger(to) && from > 0 && from <= to)) {
    throw new TeamError("BAD_RANGE", `range must be <from>-<to> with 0 < from ≤ to`);
  }
  const clash = findOverlap(t, { email, prefix, r: [from, to] });
  if (clash) throw new TeamError("RANGE_OVERLAP", clash);
  const next = structuredClone(t);
  const m = (next.members[email] ??= { ranges: {} });
  (m.ranges[prefix] ??= []).push([from, to]);
  m.ranges[prefix].sort((a, b) => a[0] - b[0]);
  return next;
}

export const isPlanner = (t, email) => !t || t.planner === email;

// Every id of a prefix that is taken anywhere this clone can see: the index, the record
// files (a pulled task the index has not imported yet still owns its id), the tracked
// archive and the legacy archive files.
function _takenIds(aiDir, db, prefix) {
  const taken = new Set();
  const add = (id) => {
    const m = typeof id === "string" && new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    if (m) taken.add(Number(m[1]));
  };
  for (const r of db.prepare("SELECT id FROM tasks WHERE id LIKE ?").all(`${prefix}-%`)) add(r.id);
  // E-109's high-water mark: every id at or below it was issued on this machine once, even
  // if its row has since gone without an archive — never hand one out again.
  const hw = parseInt(db.prepare("SELECT value FROM project WHERE key = ?").get(`last_id_${prefix}`)?.value, 10) || 0;
  for (let n = 1; n <= hw; n++) taken.add(n);
  for (const { id } of listRecords(aiDir, "task")) add(id);
  for (const { record } of listRecords(aiDir, "task-archive")) add(record.id);
  const arch = resolve(aiDir, "archive");
  if (existsSync(arch)) {
    for (const f of readdirSync(arch)) {
      if (!/^state-done-.*\.json$/.test(f)) continue;
      try { for (const t of JSON.parse(readFileSync(resolve(arch, f), "utf8"))) add(t?.id); } catch { /* fail-soft, as nextId */ }
    }
  }
  return taken;
}

/**
 * The lowest unused id inside the caller's ranges. Throws TeamError ID_RANGE_MISSING (no
 * range for this prefix) or ID_RANGE_EXHAUSTED (naming the last id used). Pure: nothing
 * is written until the task row exists, as with nextId.
 */
export function nextTeamId(aiDir, db, team, prefix, email = gitEmail(aiDir)) {
  const ranges = team.members[email]?.ranges?.[prefix];
  if (!ranges || ranges.length === 0) {
    throw new TeamError("ID_RANGE_MISSING",
      `${email} has no ${prefix} range in .ai/team.json — ask the planner (${team.planner}): ai team add ${email} --range ${prefix}:<from>-<to>`);
  }
  const taken = _takenIds(aiDir, db, prefix);
  for (const [from, to] of ranges) {
    for (let n = from; n <= to; n++) if (!taken.has(n)) return `${prefix}-${n}`;
  }
  const last = ranges[ranges.length - 1][1];
  throw new TeamError("ID_RANGE_EXHAUSTED",
    `${email}'s ${prefix} ranges are used up (last used ${prefix}-${last}) — ask the planner (${team.planner}) for another range`);
}

/** The ranges and their use, for `ai team show`. */
export function describeTeam(aiDir, db, team) {
  const lines = [`planner: ${team.planner}   claim_ttl_days: ${team.claim_ttl_days}   shared_log: ${team.shared_log}`];
  for (const [email, m] of Object.entries(team.members)) {
    const parts = Object.entries(m.ranges).map(([prefix, list]) => {
      const taken = _takenIds(aiDir, db, prefix);
      return list.map(([f, t]) => {
        let used = 0;
        for (let n = f; n <= t; n++) if (taken.has(n)) used++;
        return `${prefix}:${f}-${t} (${used}/${t - f + 1} used)`;
      }).join(", ");
    });
    lines.push(`  ${email}${email === team.planner ? " (planner)" : ""}  ${parts.join("  ")}`);
  }
  return lines.join("\n");
}

// ── E-333 (D-102 §8): the shared log ───────────────────────────────────────────────────────
// With team.json shared_log: true, each developer's LOG entries go to the TRACKED
// .ai/log/<email-localpart>.md (one file per writer, so two developers never conflict on a
// line); otherwise the gitignored .ai/LOG.md, as before. A bad team.json falls back to LOG.md:
// a log line is never the reason a handover fails.

const ENTRY_RE = /^\d{4}-\d{2}-\d{2}\b/;

function _sharedLog(aiDir) {
  try { return readTeam(aiDir)?.shared_log === true; } catch { return false; }
}

/** The file a LOG entry goes to for <email> (default: this checkout's git email). */
export function logPath(aiDir, email = gitEmail(aiDir)) {
  if (!_sharedLog(aiDir)) return resolve(aiDir, "LOG.md");
  const local = String(email).split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[.-]+/, "") || "unknown";
  return resolve(aiDir, "log", `${local}.md`);
}

/**
 * Append one entry. The shared file is created (it is tracked, one per developer); the local
 * LOG.md is appended only when it exists, as run_handover always did. @returns the path, or null.
 */
export function appendLog(aiDir, line, email = gitEmail(aiDir)) {
  const p = logPath(aiDir, email);
  const shared = _sharedLog(aiDir);
  if (!shared && !existsSync(p)) return null;
  if (shared) mkdirSync(resolve(aiDir, "log"), { recursive: true });
  line = redact(line, { file: p.slice(resolve(aiDir).length + 1) || "LOG.md", aiDir });   // E-379: every log writer
  appendFileSync(p, line.endsWith("\n") ? line : line + "\n");
  return p;
}

/**
 * The newest <n> entries — across every .ai/log/*.md in a shared-log team, else LOG.md. An
 * entry is a line starting YYYY-MM-DD; a stable sort on that date keeps each file's own order.
 */
export function recentLog(aiDir, n = 5) {
  const files = _sharedLog(aiDir)
    ? (existsSync(resolve(aiDir, "log")) ? readdirSync(resolve(aiDir, "log")).filter((f) => f.endsWith(".md")).sort().map((f) => resolve(aiDir, "log", f)) : [])
    : [resolve(aiDir, "LOG.md")];
  const entries = [];
  for (const f of files) {
    let text = "";
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    for (const l of text.split("\n")) if (ENTRY_RE.test(l)) entries.push(l);
  }
  entries.sort((a, b) => (a.slice(0, 10) < b.slice(0, 10) ? -1 : a.slice(0, 10) > b.slice(0, 10) ? 1 : 0));
  return entries.slice(-Math.max(0, n));
}
