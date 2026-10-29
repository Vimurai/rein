/**
 * legacy-import.mjs — import HEAD's tracked state.json into a legacy project's index (E-342, D-106)
 *
 * A project without .ai/team.json keeps `.ai/state.json` tracked: it is the only thing that
 * travels between machines, and state.sqlite is this machine's index of it. Before E-342 the
 * index imported the file once, when the database was created, so a pull that brought new
 * tasks left the index behind and the next view regeneration rewrote the committed views from
 * it — silently undoing the pull (D-106 finding 5).
 *
 *   importLegacy()     merges HEAD:.ai/state.json into the index per record (D-106 r3): absent
 *                      tasks are inserted, a task on both sides takes HEAD's version only when
 *                      HEAD's is newer, stamps and deltas are inserted by natural key, nothing
 *                      local is ever deleted. Keyed on the blob id (r2) — `last_import_blob` in
 *                      the project table, mirrored to gitignored .ai/.last-import-blob so the
 *                      git hooks compare two strings in bash before starting node.
 *   checkBehindHead()  the guard (r4): does HEAD hold a task or a newer stamp the index lacks?
 *                      Cached by blob id; never writes. Every view regeneration refuses while
 *                      it answers, and verify_markdown_sync returns [SYNC_FAIL] with its line.
 *
 * A team project (record store) is out of scope here — record-import.mjs imports its files.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import { isRecordStore } from "./record-store.mjs";

export const BLOB_MIRROR = ".last-import-blob";
const ID_RE     = /^[A-Z]+-\d+$/;
const STATUSES  = new Set(["OPEN", "BLOCKED", "IN_PROGRESS", "DONE"]);
const FOCUS_KEYS = ["focus", "current_tier", "release_verdict"];
const TASK_BODY  = ["owner", "status", "tier", "description", "created_at", "completed_at", "summary", "depends_on"];

/** The guard's refusal. `line` is the one [STATE_BEHIND_HEAD] line. */
export class StateBehindHeadError extends Error {
  constructor(line) {
    super(line);
    this.name = "StateBehindHeadError";
    this.code = "STATE_BEHIND_HEAD";
  }
}

function _git(aiDir, args) {
  try {
    return execFileSync("git", args, {
      cwd: aiDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** The blob id of HEAD:.ai/state.json, or null (no repository, no commit, file not tracked). */
export function headBlob(aiDir) {
  if (!existsSync(aiDir)) return null;
  const b = (_git(aiDir, ["rev-parse", "-q", "--verify", "HEAD:./state.json"]) || "").trim();
  return /^[0-9a-f]{40,64}$/.test(b) ? b : null;
}

function _headDoc(aiDir, blob) {
  const text = _git(aiDir, ["cat-file", "blob", blob]);
  if (text == null) return null;
  try {
    const doc = JSON.parse(text);
    return doc && typeof doc === "object" && doc.version === "1.0" ? doc : null;
  } catch {
    return null;
  }
}

const _str = (v) => typeof v === "string";
function _validTask(t) {
  return t && ID_RE.test(t.id) && _str(t.owner) && _str(t.description) && _str(t.created_at) && STATUSES.has(t.status);
}
const _deps = (d) => {
  if (Array.isArray(d)) return d.filter((x) => _str(x));
  if (_str(d)) { try { const a = JSON.parse(d); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [];
};
const _body = (t) => JSON.stringify(TASK_BODY.map((k) => (k === "depends_on" ? _deps(t[k]) : t[k] ?? null)));
const _stampKey = (s) => `${s.timestamp}|${s.type}|${s.task_id ?? ""}`;
const _deltaKey = (d) => `${d.task_id}|${d.created_at ?? d.timestamp ?? ""}|${d.summary ?? ""}`;
const _idNum = (id) => Number(id.split("-")[1]);
const _byId = (a, b) => (a.split("-")[0] === b.split("-")[0] ? _idNum(a) - _idNum(b) : a < b ? -1 : 1);

// What this machine rotated into the gitignored .ai/archive/: a HEAD document written on
// another machine still lists those records, and importing them would resurrect them.
function _localArchive(aiDir) {
  const tasks = new Set(), stamps = new Set();
  let files = [];
  try { files = readdirSync(resolve(aiDir, "archive")); } catch { return { tasks, stamps }; }
  for (const f of files) {
    const kind = /^state-done-\d{4}-\d{2}\.json$/.test(f) ? "task" : /^stamps-\d{4}-\d{2}\.json$/.test(f) ? "stamp" : null;
    if (!kind) continue;
    let rows;
    try { rows = JSON.parse(readFileSync(resolve(aiDir, "archive", f), "utf8")); } catch { continue; }
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (kind === "task" && r && _str(r.id)) tasks.add(r.id);
      if (kind === "stamp" && r && _str(r.timestamp)) stamps.add(_stampKey(r));
    }
  }
  return { tasks, stamps };
}

/**
 * HEAD wins a record present on both sides when its updated_at is newer (D-106 r3). Without
 * updated_at on either side, HEAD wins only when it carries a completed_at the local record
 * lacks or has an older one.
 */
function _headWins(local, head) {
  if (local.updated_at && head.updated_at) return String(head.updated_at) > String(local.updated_at);
  if (!head.completed_at) return false;
  return !local.completed_at || String(local.completed_at) < String(head.completed_at);
}

const _range = (ids) => (ids.length === 1 ? ids[0] : `${ids[0]}..${ids[ids.length - 1]}`);

// ── the guard ────────────────────────────────────────────────────────────────

const _guardCache = new Map();   // `${aiDir}|${blob}` → { ids:string[], maxStamp:string }

/**
 * @returns {string|null} the [STATE_BEHIND_HEAD] line when HEAD:.ai/state.json holds a task id
 * the index (or this machine's archive) lacks, or a stamp newer than the index's newest; else
 * null. A team project, or one whose state.json is not committed, is never behind.
 */
export function checkBehindHead(aiDir, db) {
  if (isRecordStore(aiDir)) return null;
  const blob = headBlob(aiDir);
  if (!blob) return null;
  const last = db.prepare("SELECT value FROM project WHERE key = 'last_import_blob'").get()?.value ?? null;
  const key = `${resolve(aiDir)}|${blob}`;
  let head = _guardCache.get(key);
  if (!head) {
    const doc = _headDoc(aiDir, blob);
    if (!doc) return null;
    const ids = (doc.tasks || []).filter(_validTask).map((t) => t.id);
    const maxStamp = (doc.stamps || []).map((s) => (s && _str(s.timestamp) ? s.timestamp : "")).sort().pop() || "";
    head = { ids, maxStamp };
    _guardCache.set(key, head);
  }
  const have = new Set(db.prepare("SELECT id FROM tasks").all().map((r) => r.id));
  const archived = head.ids.some((id) => !have.has(id)) ? _localArchive(aiDir).tasks : new Set();
  const missing = head.ids.filter((id) => !have.has(id) && !archived.has(id)).sort(_byId);
  if (missing.length) return `[STATE_BEHIND_HEAD] HEAD has ${_range(missing)} the index lacks — run: ai state import`;
  // An imported blob's stamps are in the index (or archived here): only the task check applies.
  if (blob === last || !head.maxStamp) return null;
  const idxMax = db.prepare("SELECT MAX(timestamp) AS t FROM stamps").get()?.t || "";
  if (head.maxStamp > idxMax) return `[STATE_BEHIND_HEAD] HEAD has stamps newer than the index (${head.maxStamp.slice(0, 19)}Z) — run: ai state import`;
  return null;
}

/** Throws StateBehindHeadError when the index is behind HEAD — the view writers call this first. */
export function assertNotBehindHead(aiDir, db) {
  const line = checkBehindHead(aiDir, db);
  if (line) throw new StateBehindHeadError(line);
}

// ── the import ───────────────────────────────────────────────────────────────

function _writeMirror(aiDir, blob) {
  try {
    const p = resolve(aiDir, BLOB_MIRROR);
    if (!existsSync(p) || readFileSync(p, "utf8").trim() !== blob) writeFileSync(p, blob + "\n", "utf8");
  } catch { /* the mirror only saves a node start; the index row is the record */ }
}

/**
 * Merge HEAD:.ai/state.json into the index (D-106 r3). Never throws.
 * @param {{force?:boolean, dryRun?:boolean, render?:Function, transaction?:Function}} opts
 *   force ignores last_import_blob; render(aiDir, db) regenerates the views after a change.
 * @returns {{status:"TEAM"|"NO_HEAD"|"NOOP"|"OK"|"DRY_RUN"|"ERROR", lines:string[], changed:boolean}}
 *   NO_HEAD: nothing committed to import, and the index is not empty (or the working state.json is).
 */
export function importLegacy(aiDir, db, opts = {}) {
  try {
    return _importLegacy(aiDir, db, opts);
  } catch (e) {
    const msg = String(e?.message ?? e).replace(/[\r\n]+/g, " ").slice(0, 200);
    return { status: "ERROR", lines: [`[STATE_IMPORT] not imported — ${msg}; the index is unchanged`], changed: false };
  }
}

function _importLegacy(aiDir, db, { force = false, dryRun = false, render = null, transaction = null } = {}) {
  if (isRecordStore(aiDir)) return { status: "TEAM", lines: [], changed: false };
  const blob = headBlob(aiDir);
  const getProj = (k) => db.prepare("SELECT value FROM project WHERE key = ?").get(k)?.value ?? null;
  let doc;
  if (!blob) {
    // E-344 (D-108 r7): no commit to import from (no git, or state.json untracked). An EMPTY
    // index then takes the working state.json — the lossless source left; any other index is
    // the newer side and is left alone.
    if (db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n > 0) return { status: "NO_HEAD", lines: [], changed: false };
    try { doc = JSON.parse(readFileSync(resolve(aiDir, "state.json"), "utf8")); } catch { doc = null; }
    if (!doc || doc.version !== "1.0" || !(doc.tasks || []).length) return { status: "NO_HEAD", lines: [], changed: false };
  } else {
    if (!force && getProj("last_import_blob") === blob) {
      if (!dryRun) _writeMirror(aiDir, blob);
      return { status: "NOOP", lines: [], changed: false };
    }
    doc = _headDoc(aiDir, blob);
  }
  if (!doc) return { status: "ERROR", lines: ["[STATE_IMPORT] not imported — HEAD:.ai/state.json is not a version 1.0 state document; the index is unchanged"], changed: false };

  const archive = _localArchive(aiDir);
  const rows = new Map(db.prepare("SELECT * FROM tasks").all().map((r) => [r.id, r]));
  const headIds = new Set();
  const inserts = [], updates = [], keptLocal = [];
  for (const t of doc.tasks || []) {
    if (!_validTask(t) || headIds.has(t.id) || archive.tasks.has(t.id)) continue;
    headIds.add(t.id);
    const local = rows.get(t.id);
    if (!local) inserts.push(t);
    else if (_body(local) !== _body(t)) (_headWins(local, t) ? updates : keptLocal).push(t);
  }

  const haveStamps = new Set([...db.prepare("SELECT type, task_id, timestamp FROM stamps").all().map(_stampKey), ...archive.stamps]);
  const newStamps = [];
  for (const s of doc.stamps || []) {
    if (!s || !_str(s.type) || !_str(s.timestamp)) continue;
    const k = _stampKey(s);
    if (haveStamps.has(k)) continue;
    haveStamps.add(k);
    newStamps.push(s);
  }
  const haveDeltas = new Set(db.prepare("SELECT task_id, summary, created_at FROM deltas").all().map(_deltaKey));
  const newDeltas = [];
  for (const d of doc.deltas || []) {
    if (!d || !_str(d.task_id)) continue;
    const k = _deltaKey(d);
    if (haveDeltas.has(k)) continue;
    haveDeltas.add(k);
    newDeltas.push(d);
  }

  // Project focus (and tier, verdict) take HEAD's value only while the local one is what the
  // last import left; with no import on record yet, HEAD's tracked value is taken.
  let base = null;
  try { base = JSON.parse(getProj("last_import_project") || "null"); } catch { base = null; }
  const headProj = doc.project || {};
  const projWant = {};
  for (const k of FOCUS_KEYS) {
    const hv = headProj[k] != null ? String(headProj[k]) : null;
    const lv = getProj(k);
    if (hv !== lv && (!base || (base[k] ?? null) === lv)) projWant[k] = hv;
  }

  const localOnly = [...rows.keys()].filter((id) => !headIds.has(id));
  const changed = inserts.length + updates.length + newStamps.length + newDeltas.length + Object.keys(projWant).length > 0;
  const lines = [];
  if (changed) {
    const from = blob ? `HEAD ${(_git(aiDir, ["rev-parse", "--short=7", "HEAD"]) || "").trim() || "?"}` : "the working state.json";
    const ids = inserts.map((t) => t.id).sort(_byId);
    lines.push(`[STATE_IMPORT] legacy: +${inserts.length} tasks${ids.length ? ` (${_range(ids)})` : ""}, ~${updates.length} updated, +${newStamps.length} stamps from ${from}`);
  }
  if (keptLocal.length || (inserts.length && localOnly.length)) {
    const kept = keptLocal.map((t) => t.id).sort(_byId);
    lines.push(`[STATE_DIVERGED] this index and HEAD both changed records (${kept.length ? `kept local: ${kept.join(", ")}` : `local-only: ${localOnly.sort(_byId).join(", ")}`}) — consider: ai state migrate --team`);
  }
  if (dryRun) return { status: "DRY_RUN", lines, changed };

  const write = () => {
    const ins = db.prepare(`INSERT INTO tasks(id, owner, status, tier, description, created_at, completed_at, summary, depends_on, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const upd = db.prepare(`UPDATE tasks SET owner = ?, status = ?, tier = ?, description = ?, created_at = ?, completed_at = ?,
                            summary = ?, depends_on = ?, updated_at = ? WHERE id = ?`);
    const vals = (t) => {
      const deps = _deps(t.depends_on);
      return [t.owner, t.status, t.tier ?? null, t.description, t.created_at, t.completed_at ?? null,
              t.summary ?? null, deps.length ? JSON.stringify(deps) : null, t.updated_at ?? null];
    };
    for (const t of inserts) ins.run(t.id, ...vals(t));
    for (const t of updates) upd.run(...vals(t), t.id);
    const st = db.prepare("INSERT INTO stamps(type, agent, task_id, timestamp, summary, sha, author) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const s of newStamps) st.run(s.type, s.agent ?? null, s.task_id ?? null, s.timestamp, s.summary ?? null, s.sha ?? null, s.author ?? null);
    const dl = db.prepare("INSERT INTO deltas(task_id, summary, files, read, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const d of newDeltas) {
      const files = d.files || d.files_changed;
      dl.run(d.task_id, d.summary ?? null, files ? JSON.stringify(files) : null, d.read ? 1 : 0, d.created_at || d.timestamp || new Date().toISOString());
    }
    const setP = db.prepare("INSERT OR REPLACE INTO project(key, value) VALUES (?, ?)");
    for (const [k, v] of Object.entries(projWant)) setP.run(k, v);
    setP.run("last_import_project", JSON.stringify(Object.fromEntries(FOCUS_KEYS.map((k) => [k, headProj[k] != null ? String(headProj[k]) : null]))));
    if (blob) setP.run("last_import_blob", blob);
  };
  if (transaction) transaction(db, write); else write();
  if (changed && render) render(aiDir, db);
  if (blob) _writeMirror(aiDir, blob);
  return { status: "OK", lines, changed };
}

// ── E-344 (D-108 r8): the State Health verdict for ai doctor and ai-preflight ──────────────

const _count = (doc) => (doc && Array.isArray(doc.tasks) ? doc.tasks.length : 0);

/**
 * Compare the index with HEAD:.ai/state.json, the working state.json and TASKS.md. `db` is the
 * index or null when there is none (the caller never seeds it — this only observes).
 * @returns {{lines:string[], action:"import"|"migrate"|null}} action names the one command a
 *   repair runs: the lossless import whenever HEAD or the working state.json holds tasks, the
 *   lossy TASKS.md migration only when the view is all there is.
 */
export function stateHealth(aiDir, db) {
  if (isRecordStore(aiDir)) return { lines: ["  team project — the record files are the truth (check: ai state parity)"], action: null };
  const blob = headBlob(aiDir);
  const head = blob ? _count(_headDoc(aiDir, blob)) : null;
  let working = 0;
  try { working = _count(JSON.parse(readFileSync(resolve(aiDir, "state.json"), "utf8"))); } catch { working = 0; }
  let listed = 0;
  try { listed = (readFileSync(resolve(aiDir, "TASKS.md"), "utf8").match(/^- \[[ xX]\] [A-Z]+-\d+:/gm) || []).length; } catch { listed = 0; }
  const idx = db ? db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n : null;
  const stamps = db ? db.prepare("SELECT COUNT(*) AS n FROM stamps").get().n : 0;
  const lines = [`  index: ${idx == null ? "absent" : `tasks=${idx}, stamps=${stamps}`} · HEAD state.json: ${head == null ? "not committed" : `tasks=${head}`} · working state.json: tasks=${working} · TASKS.md: ${listed} listed`];
  if (!idx && (head || working)) {
    lines.push(`  WARN: the index is ${idx == null ? "absent" : "empty"} but ${head ? `HEAD has ${head}` : `the working state.json has ${working}`} task(s) — run: ai state import`);
    return { lines, action: "import" };
  }
  const behind = db ? checkBehindHead(aiDir, db) : null;
  if (behind) {
    lines.push(`  WARN: ${behind}`);
    return { lines, action: "import" };
  }
  if (!idx && listed > 0) {
    lines.push(`  WARN: no state source holds tasks but TASKS.md lists ${listed} — run: ai migrate-state (rebuilds from the view; lossy)`);
    return { lines, action: "migrate" };
  }
  lines.push(idx ? "  OK — the index is in step with HEAD" : "  index, state.json and TASKS.md all empty (clean slate)");
  return { lines, action: null };
}
