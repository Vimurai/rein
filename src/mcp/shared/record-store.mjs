/**
 * record-store.mjs — the single writer of project state (E-325, D-102 §Component 1)
 *
 * Every mutation of a task, a stamp or the project fields goes through this file. In a
 * TEAM project (`.ai/project.json`, created by `rein state migrate --team`)
 * the record FILE is the truth: it is written first (temp-then-rename, rev+1, updated_at,
 * origin), then the sqlite row, which is only an index. A crash between the two leaves a
 * file the row does not reflect yet, and rebuildIndex() repairs it from the files.
 *
 * In a LEGACY project (no record store) only the SQL runs, exactly as before E-325, so a
 * single-operator project's state.sqlite and its views are unchanged byte for byte.
 *
 * renderViews() is the only producer of the generated views state.json, TASKS.md and
 * REVIEWS.md (state-db.js re-exports it as regenerateViews for existing importers).
 *
 * Deltas and the digest_stale flags stay per-machine in sqlite: they are notices between
 * the two panes of ONE developer, and a tracked file would make every handover conflict.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync, lstatSync, statSync } from "fs";
import { resolve, dirname, join } from "path";
import { execFileSync } from "child_process";
import { readState, roleFromOwner, archivePointerLines, parseDeps, recordIdHighWater, withTransaction } from "./state-db.js";
import { assertNotBehindHead } from "./legacy-import.mjs";
import { redact } from "../../shared/publish-scan.mjs";

export const PROJECT_SCHEMA = 2;

const TASK_ID_RE  = /^[A-Z]+-\d+$/;
const YM_RE       = /^\d{4}-\d{2}$/;
const STAMP_ID_RE = /^\d{4}-\d{2}\/[0-9a-f]{7}-[A-Za-z0-9_]{1,40}-\d+$/;
// The project fields a record carries; anything else in the sqlite project table
// (id high-water marks, future per-machine keys) stays local.
export const PROJECT_KEYS = ["focus", "current_tier", "release_verdict", "rein_version", "provisioned_at"];

/**
 * A team project: migrated with `rein state migrate --team`, which writes project.json last.
 * project.json alone is the marker — git does not carry an empty .ai/tasks/, so a fresh
 * clone of a project with no tasks yet has none.
 */
export function isRecordStore(aiDir) {
  return existsSync(resolve(aiDir, "project.json"));
}

// ── git identity ─────────────────────────────────────────────────────────────

const _emailCache = new Map();

function _git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
  } catch {
    return "";
  }
}

/** The writer's git email — a record's `origin`. "unknown" when git has none configured. */
export function gitEmail(aiDir) {
  const root = dirname(resolve(aiDir));
  if (!_emailCache.has(root)) _emailCache.set(root, _git(root, ["config", "user.email"]) || "unknown");
  return _emailCache.get(root);
}

export function headSha(aiDir) {
  const sha = _git(dirname(resolve(aiDir)), ["rev-parse", "HEAD"]);
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// ── record files ─────────────────────────────────────────────────────────────

// kind → path. Ids are validated here so a hostile id can never address a path outside
// the store (a task id comes from the caller, a stamp id from its type string).
export function recordPath(aiDir, kind, id) {
  switch (kind) {
    case "project":
      return resolve(aiDir, "project.json");
    case "task":
      if (!TASK_ID_RE.test(id)) throw new Error(`invalid task record id: ${JSON.stringify(id)}`);
      return resolve(aiDir, "tasks", `${id}.json`);
    case "task-archive": {
      const [ym, tid] = String(id).split("/");
      if (!YM_RE.test(ym) || !TASK_ID_RE.test(tid)) throw new Error(`invalid archived task id: ${JSON.stringify(id)}`);
      return resolve(aiDir, "tasks", "archive", ym, `${tid}.json`);
    }
    case "stamp":
      if (!STAMP_ID_RE.test(id)) throw new Error(`invalid stamp record id: ${JSON.stringify(id)}`);
      return resolve(aiDir, "stamps", `${id}.json`);
    default:
      throw new Error(`unknown record kind: ${kind}`);
  }
}

// Record files arrive by `git pull`, so any committer controls them. A symlink anywhere
// between .ai/ and the record would aim a read or a write outside the store — refuse it.
function _assertPlainPath(aiDir, p) {
  const base = resolve(aiDir);
  const rel  = p.slice(base.length + 1).split("/");
  let cur = base;
  for (const part of rel) {
    cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); } catch { return; } // the rest does not exist yet
    if (st.isSymbolicLink()) throw new Error(`refusing symlinked record path ${cur}`);
  }
}

const MAX_RECORD_BYTES = 1 << 20;

/** The record, or null when it does not exist. A corrupt record throws (fail closed). */
export function readRecord(aiDir, kind, id) {
  const p = recordPath(aiDir, kind, id);
  if (!existsSync(p)) return null;
  _assertPlainPath(aiDir, p);
  if (statSync(p).size > MAX_RECORD_BYTES) throw new Error(`corrupt record ${p}: larger than ${MAX_RECORD_BYTES} bytes`);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // No parser message: on current Node it quotes the file, and this text reaches the model.
    throw new Error(`corrupt record ${p}: not valid JSON (a merge conflict?)`);
  }
}

function _writeAtomic(aiDir, p, obj) {
  _assertPlainPath(aiDir, p);
  mkdirSync(dirname(p), { recursive: true });
  _assertPlainPath(aiDir, p);
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  renameSync(tmp, p);
}

const TASK_STATUSES = new Set(["OPEN", "BLOCKED", "IN_PROGRESS", "DONE"]);
const _str = (v) => typeof v === "string";
const _line = (v) => _str(v) && !/[\r\n]/.test(v);
// E-331: a claim names its holder in the gate's refusal and the preflight banner.
// Printable ASCII only: a bidi override or zero-width character would reach the model's context.
const CLAIM_EMAIL_RE = /^[!#-&(-?A-[\]-_a-~]{1,64}@[!#-&(-?A-[\]-_a-~]{1,190}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** The claim fields a task record carries only while set (E-331, D-102 §Component 4). */
export const CLAIM_KEYS = ["assignee", "claimed_at", "claim_sha", "claim_prev"];

// The shape a record must have before it may enter the index or the views. A pulled file
// whose id differs from its filename, or whose text would add lines to TASKS.md, is refused.
function _assertValid(kind, id, r) {
  const bad = (why) => { throw new Error(`invalid ${kind} record ${id}: ${why}`); };
  if (!r || typeof r !== "object" || Array.isArray(r)) bad("not an object");
  if (kind === "task" || kind === "task-archive") {
    const fileId = kind === "task" ? id : id.split("/")[1];
    // Quoted values are cut short: this text can reach a session context (critic_security).
    if (r.id !== fileId) bad(`id ${JSON.stringify(r.id).slice(0, 40)} does not match its filename`);
    if (!TASK_STATUSES.has(r.status)) bad(`status ${JSON.stringify(r.status).slice(0, 40)}`);
    if (!_line(r.owner) || !_line(r.description) || !_str(r.created_at)) bad("owner, description and created_at must be one-line strings");
    if (r.summary != null && !_line(r.summary)) bad("summary must be a one-line string");
    if (r.depends_on != null && !(Array.isArray(r.depends_on) && r.depends_on.every((d) => TASK_ID_RE.test(d)))) bad("depends_on");
    for (const k of ["assignee", "claim_prev"]) if (r[k] != null && !CLAIM_EMAIL_RE.test(r[k])) bad(`${k} must be an email`);
    if (r.claimed_at != null && !(_str(r.claimed_at) && ISO_RE.test(r.claimed_at))) bad("claimed_at must be an ISO time");
    if (r.claim_sha != null && !/^[0-9a-f]{40}$/.test(r.claim_sha)) bad("claim_sha must be a full commit sha");
  } else if (kind === "stamp") {
    if (!_line(r.type) || !_str(r.created_at)) bad("type and created_at must be one-line strings");
    if (r.summary != null && !_line(r.summary)) bad("summary must be a one-line string");
    // E-329: both reach REVIEWS.md and Gate 2's verdict line.
    if (r.sha != null && !/^[0-9a-f]{40}$/.test(r.sha)) bad("sha must be a full commit sha");
    if (r.author != null && !(_line(r.author) && r.author.length <= 255 && !/[\x00-\x1f\x7f]/.test(r.author))) bad("author must be a one-line string");
  }
}

/** Throws when a task record (e.g. one read from origin/<trunk>) has the wrong shape. */
export function assertTaskRecord(id, r) {
  _assertValid("task", id, r);
}

/**
 * Write a record: rev = previous rev + 1 (1 with fresh), updated_at = now, origin = git email.
 * @returns the record as written
 */
export function writeRecord(aiDir, kind, id, data, { fresh = false } = {}) {
  const p    = recordPath(aiDir, kind, id);
  const prev = fresh ? null : readRecord(aiDir, kind, id);
  const rec  = {
    ...data,
    rev:        (prev && Number.isInteger(prev.rev) ? prev.rev : 0) + 1,
    updated_at: new Date().toISOString(),
    origin:     gitEmail(aiDir),
  };
  _writeAtomic(aiDir, p, rec);
  return rec;
}

/**
 * Every record of a kind, parsed. Tasks are `.ai/tasks/<id>.json` (top level only — the
 * archive below it is not live); stamps are `.ai/stamps/<YYYY-MM>/*.json`; archived tasks
 * are `.ai/tasks/archive/<YYYY-MM>/<id>.json`. Each entry is { id, record }.
 */
export function listRecords(aiDir, kind, { skipInvalid = null } = {}) {
  const out = [];
  // E-329: a reader that must not lose every record to one bad pulled file (pre-commit
  // Gate 2) passes an array; each refused file is noted there instead of throwing.
  // rebuildIndex keeps the default — it must refuse, not silently drop, a record.
  const take = (fn) => {
    if (!skipInvalid) return fn();
    try { return fn(); } catch (e) { skipInvalid.push(e.message); return null; }
  };
  const jsonIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []);
  const monthsIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((d) => YM_RE.test(d)).sort() : []);
  if (kind === "task") {
    for (const f of jsonIn(resolve(aiDir, "tasks"))) {
      const id = f.slice(0, -5);
      if (!TASK_ID_RE.test(id)) continue;
      const record = readRecord(aiDir, "task", id);
      _assertValid("task", id, record);
      out.push({ id, record });
    }
  } else if (kind === "stamp" || kind === "task-archive") {
    const base = kind === "stamp" ? resolve(aiDir, "stamps") : resolve(aiDir, "tasks", "archive");
    for (const ym of monthsIn(base)) {
      for (const f of jsonIn(join(base, ym))) {
        const id = `${ym}/${f.slice(0, -5)}`;
        const record = take(() => { const r = readRecord(aiDir, kind, id); _assertValid(kind, id, r); return r; });
        if (record) out.push({ id, record });
      }
    }
  } else {
    throw new Error(`listRecords: unknown kind ${kind}`);
  }
  return out;
}

// ── record shapes ────────────────────────────────────────────────────────────

/**
 * The task record for a sqlite row (or a state.json task). `seq` is the row's insertion
 * position on the machine that created it: tasks added in the same millisecond (parallel
 * add_task calls) keep their order when an index is rebuilt from the files.
 */
export function taskRecord(row) {
  return {
    ...(Number.isInteger(row.seq) ? { seq: row.seq } : {}),
    id:           row.id,
    owner:        row.owner,
    status:       row.status,
    tier:         row.tier ?? null,
    description:  row.description,
    depends_on:   Array.isArray(row.depends_on) ? row.depends_on : parseDeps(row.depends_on),
    created_at:   row.created_at,
    completed_at: row.completed_at ?? null,
    summary:      row.summary ?? null,
    // E-331: present only while set, so an unclaimed task's record is unchanged.
    ...Object.fromEntries(CLAIM_KEYS.filter((k) => row[k] != null).map((k) => [k, row[k]])),
  };
}

// E-348 (D-111 r1): `seq` is the stamp's insertion position on the machine that made it
// (nextSeq). A stamp file written before E-348 has none.
export function stampRecord(stamp, sha, author = stamp.author ?? null) {
  return {
    ...(Number.isInteger(stamp.seq) ? { seq: stamp.seq } : {}),
    task_id:    stamp.task_id ?? null,
    type:       stamp.type,
    agent:      stamp.agent ?? null,
    summary:    stamp.summary ?? null,
    sha:        sha ?? null,
    author:     author ?? null,
    created_at: stamp.timestamp,
  };
}

// <YYYY-MM>/<sha7>-<type>-<seq>: the next free seq for that sha and type in that month.
export function stampRecordId(aiDir, stamp, sha) {
  const ym   = String(stamp.timestamp).slice(0, 7);
  const sha7 = sha ? sha.slice(0, 7) : "0000000";
  const type = String(stamp.type).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40) || "STAMP";
  const stem = `${sha7}-${type}-`;
  const dir  = resolve(aiDir, "stamps", ym);
  let seq = 1;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(stem) || !f.endsWith(".json")) continue;
      const n = parseInt(f.slice(stem.length, -5), 10);
      if (n >= seq) seq = n + 1;
    }
  }
  return `${ym}/${stem}${seq}`;
}

// ── the single writer ────────────────────────────────────────────────────────

const _TASK_COLS = ["owner", "status", "tier", "description", "created_at", "completed_at", "summary", "depends_on", ...CLAIM_KEYS];

function _depsCol(deps) {
  return Array.isArray(deps) && deps.length ? JSON.stringify(deps) : null;
}

// E-348 (D-111 r1 invariant: `seq` is monotonic per origin). The index alone cannot promise
// that: a fresh clone, or a deleted state.sqlite, rebuilds the index from the LIVE records only,
// so rowids restart at 1..N while this origin's older records (live and archived) carry higher
// seq values — and a new record numbered below them would sort first within its origin
// (review of E-348). The next seq is therefore one past BOTH the index's highest row and every
// seq this origin has already written to a record file, live or archived.
function _jsonFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f)) : [];
}
function _monthDirs(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((d) => YM_RE.test(d)).map((d) => join(dir, d)) : [];
}
export function nextSeq(aiDir, db, kind) {
  const sql = kind === "task" ? "SELECT COALESCE(MAX(rowid), 0) AS n FROM tasks" : "SELECT COALESCE(MAX(id), 0) AS n FROM stamps";
  let hi = db.prepare(sql).get().n;
  const origin = gitEmail(aiDir);
  const files = kind === "task"
    ? [..._jsonFiles(resolve(aiDir, "tasks")), ..._monthDirs(resolve(aiDir, "tasks", "archive")).flatMap(_jsonFiles)]
    : [..._monthDirs(resolve(aiDir, "stamps")), ..._monthDirs(resolve(aiDir, "stamps", "archive"))].flatMap(_jsonFiles);
  for (const f of files) {
    let r;
    try { r = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }   // a bad file is rebuildIndex's to refuse
    if (r && r.origin === origin && Number.isInteger(r.seq) && r.seq > hi) hi = r.seq;
  }
  return hi + 1;
}

// E-379 (D-130): the free-text fields a person or an agent writes pass through redact() before
// the record file, the row and every view built from them (state.json, TASKS.md, REVIEWS.md).
// `author` (the git email) is commit metadata, public in the commit itself, and is not redacted.
function _redactFields(aiDir, obj, kind) {
  const out = { ...obj };
  for (const k of ["description", "summary", "agent"]) {
    if (typeof out[k] === "string") out[k] = redact(out[k], { file: `.ai ${kind} ${k}`, aiDir });
  }
  return out;
}

/** Create a task: record file, then row. `task.depends_on` is an array. */
export function insertTask(aiDir, db, task) {
  task = _redactFields(aiDir, task, "task");   // E-379 (D-130): privacy by construction
  if (isRecordStore(aiDir)) {
    writeRecord(aiDir, "task", task.id, taskRecord({ ...task, seq: nextSeq(aiDir, db, "task") }), { fresh: true });
  }
  // E-342 (D-106 r3): a legacy row carries updated_at — state.json is its only transport and
  // the import compares it. A team row does not: its record file carries it.
  db.prepare(`
    INSERT INTO tasks(id, owner, status, tier, description, created_at, completed_at, summary, depends_on, assignee, claimed_at, claim_sha, claim_prev, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(task.id, task.owner, task.status, task.tier ?? null, task.description,
         task.created_at, task.completed_at ?? null, task.summary ?? null, _depsCol(task.depends_on),
         ...CLAIM_KEYS.map((k) => task[k] ?? null), isRecordStore(aiDir) ? null : new Date().toISOString());
}

/**
 * Change columns of one task: record file, then row. Only the patched columns are
 * written to sqlite, as each call site did before. `patch.depends_on` is an array.
 */
export function updateTask(aiDir, db, id, patch) {
  patch = _redactFields(aiDir, patch, "task");
  const cols = Object.keys(patch).filter((k) => _TASK_COLS.includes(k));
  if (cols.length === 0) return;
  const vals = cols.map((c) => (c === "depends_on" ? _depsCol(patch[c]) : patch[c] ?? null));
  if (isRecordStore(aiDir)) {
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!row) throw new Error(`updateTask: ${id} not found`);
    const prev = readRecord(aiDir, "task", id);
    writeRecord(aiDir, "task", id, taskRecord({ ...row, ...patch, seq: prev?.seq }));
  } else {
    cols.push("updated_at");   // E-342: see insertTask
    vals.push(new Date().toISOString());
  }
  db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...vals, id);
}

/**
 * Append an audit stamp: record file, then row. `stamp.timestamp` is ISO.
 * E-329 (D-102 §6): every stamp — team or legacy — carries `sha` (HEAD when stamped) and
 * `author` (git email), so pre-commit Gate 2 can ask "was THIS commit's parent reviewed?".
 */
export function insertStamp(aiDir, db, stamp) {
  stamp = _redactFields(aiDir, stamp, "stamp");
  const sha    = headSha(aiDir);
  const email  = gitEmail(aiDir);
  const author = email === "unknown" ? null : email;
  if (isRecordStore(aiDir)) {
    const id  = stampRecordId(aiDir, stamp, sha);
    const rec = stampRecord({ ...stamp, seq: nextSeq(aiDir, db, "stamp") }, sha, author);
    _assertValid("stamp", id, rec); // never write a stamp file the next rebuildIndex would refuse
    writeRecord(aiDir, "stamp", id, rec, { fresh: true });
  }
  db.prepare("INSERT INTO stamps(type, agent, task_id, timestamp, summary, sha, author) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(stamp.type, stamp.agent ?? null, stamp.task_id ?? null, stamp.timestamp, stamp.summary ?? null, sha, author);
}

/** Set project fields (focus, current_tier, …): project.json, then the project table. */
export function setProject(aiDir, db, fields) {
  // E-379 (D-130, security P1-2): focus and release_verdict are free text bound for state.json.
  fields = Object.fromEntries(Object.entries(fields).map(([k, v]) =>
    [k, typeof v === "string" ? redact(v, { file: `.ai project ${k}`, aiDir }) : v]));
  const keys = Object.keys(fields).filter((k) => PROJECT_KEYS.includes(k));
  if (keys.length === 0) return;
  if (isRecordStore(aiDir)) {
    const body = { ...(readRecord(aiDir, "project", null) || { schema: PROJECT_SCHEMA }) };
    delete body.rev; delete body.updated_at; delete body.origin;
    for (const k of keys) body[k] = k === "current_tier" && fields[k] != null ? Number(fields[k]) : fields[k] ?? null;
    writeRecord(aiDir, "project", null, body);
  }
  const set = db.prepare("INSERT OR REPLACE INTO project(key, value) VALUES (?, ?)");
  for (const k of keys) set.run(k, fields[k] == null ? null : String(fields[k]));
}

/**
 * Move archived task records to `.ai/tasks/archive/<YYYY-MM>/` and archived stamp records
 * to `.ai/stamps/archive/<YYYY-MM>/` BEFORE their rows are deleted, so rebuildIndex never
 * resurrects them. A no-op in a legacy project.
 */
export function archiveRecords(aiDir, kind, rows, ym) {
  if (!isRecordStore(aiDir) || rows.length === 0) return;
  if (kind === "task") {
    for (const r of rows) {
      const from = recordPath(aiDir, "task", r.id);
      const to = recordPath(aiDir, "task-archive", `${ym}/${r.id}`);
      // E-330: the tracked archive is the only copy now — a row with no live file is
      // written there from the row, never dropped with it.
      if (!existsSync(from)) { writeRecord(aiDir, "task-archive", `${ym}/${r.id}`, taskRecord(r), { fresh: true }); continue; }
      _assertPlainPath(aiDir, from);
      _assertPlainPath(aiDir, to);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
    return;
  }
  // Stamps have no stable id across machines; match on (created_at, type, task_id).
  const want = new Map();
  for (const r of rows) {
    const k = `${r.timestamp}|${r.type}|${r.task_id ?? ""}`;
    want.set(k, (want.get(k) || 0) + 1);
  }
  for (const { id, record } of listRecords(aiDir, "stamp")) {
    const k = `${record.created_at}|${record.type}|${record.task_id ?? ""}`;
    if (!want.get(k)) continue;
    want.set(k, want.get(k) - 1);
    const to = resolve(aiDir, "stamps", "archive", ym, `${id.split("/")[1]}.json`);
    _assertPlainPath(aiDir, to);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(recordPath(aiDir, "stamp", id), to);
  }
}

// ── index ────────────────────────────────────────────────────────────────────

function _idKey(id) {
  const m = /^([A-Z]+)-(\d+)$/.exec(id) || [null, id, "0"];
  return [m[1], parseInt(m[2], 10)];
}

// E-348 (D-111 r1): record order is per-origin insertion, repaired between origins.
// The insertion order a machine recorded (`seq`) is truth for that machine; wall clocks only
// arbitrate BETWEEN machines, and a clock can run backwards (2026-10-23: ~14 h, which made the
// time-first order of the D-102 rebuild disagree with state.json). One pass computes a key per
// record and never rewrites created_at:
//   1. group by origin (the writer's git email);
//   2. within an origin order by the tuple (has seq, seq, created_at, name) — files without a
//      seq predate it (stamp files gained one in E-348) and come first;
//   3. walk that order: order_at = max(created_at, previous order_at) — the monotone repair;
//   4. sort every record by the tuple (order_at, origin, seq, name).
// Every comparison is on a fixed tuple, so the order is total and the same on every clone. A
// comparator that switched keys per pair (seq when origins match, else time) is not transitive.
const _cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function _cmpName(a, b) {
  const [pa, na] = _idKey(a), [pb, nb] = _idKey(b);
  return pa !== pb ? _cmp(pa, pb) : na !== nb ? na - nb : _cmp(a, b);
}
function _seqOf(r) { return Number.isInteger(r.seq) ? r.seq : -1; }
/** items: [{ rec, name }] → the same items in D-111 order. */
export function orderRecords(items) {
  const keyed = items.map((it) => ({ ...it, origin: String(it.rec.origin ?? ""), at: String(it.rec.created_at ?? "") }));
  const byOrigin = new Map();
  for (const k of keyed) {
    if (!byOrigin.has(k.origin)) byOrigin.set(k.origin, []);
    byOrigin.get(k.origin).push(k);
  }
  for (const list of byOrigin.values()) {
    list.sort((a, b) => {
      const ha = _seqOf(a.rec) >= 0 ? 1 : 0, hb = _seqOf(b.rec) >= 0 ? 1 : 0;
      return (ha - hb) || (_seqOf(a.rec) - _seqOf(b.rec)) || _cmp(a.at, b.at) || _cmpName(a.name, b.name);
    });
    let prev = "";
    for (const k of list) { k.order_at = k.at > prev ? k.at : prev; prev = k.order_at; }
  }
  keyed.sort((a, b) => _cmp(a.order_at, b.order_at) || _cmp(a.origin, b.origin)
    || (_seqOf(a.rec) - _seqOf(b.rec)) || _cmpName(a.name, b.name));
  return keyed.map(({ rec, name }) => ({ rec, name }));
}

/**
 * Rebuild the tasks and stamps tables and the project fields from the record files.
 * Every file is parsed BEFORE the transaction opens, so a corrupt record throws and
 * leaves the index as it was. Deltas and digest flags (per-machine) are not touched.
 * @returns {{tasks:number, stamps:number}}
 */
export function rebuildIndex(aiDir, db) {
  const ordered = (kind) => orderRecords(listRecords(aiDir, kind).map((e) => ({ rec: e.record, name: e.id }))).map((x) => x.rec);
  const tasks  = ordered("task");
  const stamps = ordered("stamp");
  const project = readRecord(aiDir, "project", null) || {};

  withTransaction(db, (d) => {
    d.exec("DELETE FROM tasks");
    d.exec("DELETE FROM stamps");
    const insT = d.prepare(`
      INSERT INTO tasks(id, owner, status, tier, description, created_at, completed_at, summary, depends_on, assignee, claimed_at, claim_sha, claim_prev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const t of tasks) {
      insT.run(t.id, t.owner, t.status, t.tier ?? null, t.description, t.created_at,
               t.completed_at ?? null, t.summary ?? null, _depsCol(t.depends_on),
               ...CLAIM_KEYS.map((k) => t[k] ?? null));
    }
    const insS = d.prepare("INSERT INTO stamps(type, agent, task_id, timestamp, summary, sha, author) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const s of stamps) {
      insS.run(s.type, s.agent ?? null, s.task_id ?? null, s.created_at, s.summary ?? null, s.sha ?? null, s.author ?? null);
    }
    const setP = d.prepare("INSERT OR REPLACE INTO project(key, value) VALUES (?, ?)");
    for (const k of PROJECT_KEYS) {
      if (k in project) setP.run(k, project[k] == null ? null : String(project[k]));
      else if (k === "rein_version" || k === "provisioned_at") d.prepare("DELETE FROM project WHERE key = ?").run(k);
      else setP.run(k, null);
    }
    for (const t of tasks) recordIdHighWater(d, t.id);
  });
  return { tasks: tasks.length, stamps: stamps.length };
}

// ── views ────────────────────────────────────────────────────────────────────

/**
 * The one writer of `.ai/state.json`. Everything that produces the file — the views below and
 * the TASKS.md recovery of `rein migrate-state` — calls this.
 */
export function writeStateFile(aiDir, state) {
  writeFileSync(resolve(aiDir, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Write only the state.json view (the provisioning stamp leaves TASKS.md/REVIEWS.md alone). */
export function renderStateJson(aiDir, db) {
  assertNotBehindHead(aiDir, db);
  writeStateFile(aiDir, readState(db));
}

/**
 * Regenerate the three views — TASKS.md, REVIEWS.md, state.json — from state.sqlite.
 * Called after every mutation so file-based consumers stay in sync.
 */
export function renderViews(aiDir, db) {
  // E-342 (D-106 r4): a legacy index behind HEAD:.ai/state.json would rewrite the committed
  // views without the pulled records. Refuse (StateBehindHeadError) and name the import.
  assertNotBehindHead(aiDir, db);
  const state = readState(db);

  // TASKS.md
  if (state.tasks.length > 0) {
    const tasksPath = resolve(aiDir, "TASKS.md");
    const lines = ["# TASKS (Generated from state.json)", ""];
    const byRole = {}; // E-136 (role-abstraction.md): group by provider-agnostic role
    for (const t of state.tasks) {
      const role = roleFromOwner(t.owner);
      if (!byRole[role]) byRole[role] = [];
      byRole[role].push(t);
    }
    for (const [role, roleTasks] of Object.entries(byRole)) {
      lines.push(`## ${role}`);
      for (const t of roleTasks) {
        const check   = t.status === "DONE" ? "x" : " ";
        const tierStr = t.tier ? ` | Tier: ${t.tier}` : "";
        lines.push(`- [${check}] ${t.id}: ${t.description}${tierStr}`);
        if (t.status === "DONE" && t.completed_at) {
          lines.push(`  Status: DONE ${t.completed_at.split("T")[0]} — ${t.summary || "Complete"}`);
        }
      }
      lines.push("");
    }
    lines.push(...archivePointerLines(aiDir));
    writeFileSync(tasksPath, lines.join("\n"), "utf8");
  }

  // REVIEWS.md
  if (state.stamps.length > 0) {
    const reviewsPath = resolve(aiDir, "REVIEWS.md");
    const stampLines  = ["# REVIEWS.md (Generated from state.json)", ""];
    for (const s of state.stamps) {
      const date = s.timestamp ? s.timestamp.split("T")[0] : "unknown";
      // E-329: the reviewed commit and who stamped it, when the stamp carries them.
      const at = s.sha ? `${s.sha.slice(0, 7)}${s.author ? ` ${s.author}` : ""} | ` : "";
      stampLines.push(`[${s.type}] ${date} | ${at}${s.summary || s.agent || ""}`);
    }
    stampLines.push("");
    writeFileSync(reviewsPath, stampLines.join("\n"), "utf8");
  }

  // state.json (backwards-compat for any consumer still reading it directly)
  writeStateFile(aiDir, state);
}
