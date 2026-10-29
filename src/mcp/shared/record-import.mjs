/**
 * record-import.mjs — import pulled record files into the index (E-326, D-102 §Component 2)
 *
 * A pull, checkout or rebase changes `.ai/tasks/**`, `.ai/stamps/**` and `.ai/project.json`
 * under a team project; state.sqlite still holds the previous state. importRecords() brings
 * the index back to the files:
 *
 *   - a record whose row is missing or different → the row is rebuilt from the file
 *     (record-store.mjs writes the file before the row, so a row never legitimately runs
 *     ahead of a file that is present);
 *   - a row with no file → archived on another machine (its file is under tasks/archive/)
 *     and dropped, or else a local task whose file is missing and is rewritten from the row;
 *   - git conflicts on one record are resolved at merge time by the `rein-record` merge
 *     driver (mergeRecord below) under the D-102 policy — DONE beats IN_PROGRESS beats
 *     OPEN, else the later updated_at — which logs each resolution to the git dir; the
 *     import prints one `[STATE_CONFLICT] <id> kept <side>` line per entry and writes a
 *     STATE_CONFLICT stamp.
 *
 * The imported HEAD is kept in the project table (last_import_head), so a second call for
 * the same HEAD with no pending conflict is a no-op. Nothing here throws to the caller: an
 * import runs from git hooks and must never block a pull.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, rmSync } from "fs";
import { resolve, dirname, isAbsolute } from "path";
import { execFileSync } from "child_process";
import {
  PROJECT_KEYS, isRecordStore, headSha, listRecords, readRecord, writeRecord, taskRecord,
  insertStamp, rebuildIndex, renderViews,
} from "./record-store.mjs";
import { mergeCiRecords } from "./ci-evidence.mjs";

const CONFLICT_LOG = "rein-state-conflicts";
// Everything that reaches the conflict log came from a pulled file. It is reduced to these
// shapes when written AND when read: a log line becomes a stamp record and a line in the
// model's session context (critic_security P1, E-326).
const LOG_ID_RE   = /^[A-Z]+-\d+$|^[0-9a-f]{7}-[A-Za-z0-9_]{1,40}-\d+$|^project$|^record$/;
const _safeStatus = (s) => (Object.prototype.hasOwnProperty.call(STATUS_RANK, s) ? s : "?");
const STATUS_RANK = { DONE: 3, IN_PROGRESS: 2, OPEN: 1, BLOCKED: 1 };
const META = new Set(["rev", "updated_at", "origin", "seq"]);

// JSON with sorted keys and without the bookkeeping fields — "the same record".
function _body(r) {
  if (r == null) return null;
  const pick = (x) => (x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().filter((k) => !META.has(k)).map((k) => [k, x[k]]))
    : x);
  return JSON.stringify(pick(r));
}

function _gitDir(root) {
  try {
    const d = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
    return d ? (isAbsolute(d) ? d : resolve(root, d)) : null;
  } catch {
    return null;
  }
}

function _readConflicts(gitDir) {
  if (!gitDir) return [];
  const p = resolve(gitDir, CONFLICT_LOG);
  if (!existsSync(p)) return [];
  const out = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      if (typeof c.id !== "string" || !LOG_ID_RE.test(c.id) || !/^(local|remote)$/.test(c.kept)) continue;
      const detail = typeof c.detail === "string" && /^[A-Z_?]+ local vs [A-Z_?]+ remote$|^both changed$/.test(c.detail) ? c.detail : "";
      out.push({ id: c.id, kept: c.kept, detail });
    } catch { /* a torn line is skipped, never fatal */ }
  }
  return out;
}

const _projectRows = (db) =>
  Object.fromEntries(db.prepare("SELECT key, value FROM project").all().map((r) => [r.key, r.value]));
const _stampKey = (s) => `${s.timestamp ?? s.created_at}|${s.type}|${s.task_id ?? ""}`;

/**
 * @param {{force?:boolean, dryRun?:boolean}} [opts] force ignores last_import_head.
 * @returns {{status:"LEGACY"|"NOOP"|"OK"|"DRY_RUN"|"ERROR", lines:string[], changed:boolean}}
 */
export function importRecords(aiDir, db, opts = {}) {
  try {
    return _importRecords(aiDir, db, opts);
  } catch (e) {
    // A hook must never see a throw; the message is cut to one short line because it can
    // quote pulled text and is shown in the session context.
    const msg = String(e?.message ?? e).replace(/[\r\n]+/g, " ").slice(0, 200);
    return { status: "ERROR", lines: [`[STATE_IMPORT] not imported — ${msg}; the index is unchanged`], changed: false };
  }
}

function _importRecords(aiDir, db, { force = false, dryRun = false } = {}) {
  if (!isRecordStore(aiDir)) return { status: "LEGACY", lines: [], changed: false };
  const root   = dirname(resolve(aiDir));
  const gitDir = _gitDir(root);
  const head   = headSha(aiDir);
  const conflicts = _readConflicts(gitDir);
  const last = db.prepare("SELECT value FROM project WHERE key = 'last_import_head'").get()?.value ?? null;
  if (!force && head && head === last && conflicts.length === 0) return { status: "NOOP", lines: [], changed: false };

  // A corrupt or hostile record throws here, before anything is written; importRecords
  // turns it into one capped ERROR line (it can quote a pulled filename).
  const tasks    = listRecords(aiDir, "task").map((e) => e.record);
  const archived = new Set(listRecords(aiDir, "task-archive").map((e) => e.record.id));
  const stamps   = listRecords(aiDir, "stamp").map((e) => e.record);
  const project  = readRecord(aiDir, "project", null) || {};

  const lines = [];
  let changed = false;
  const rows = new Map(db.prepare("SELECT * FROM tasks").all().map((r) => [r.id, r]));
  for (const rec of tasks) {
    const row = rows.get(rec.id);
    rows.delete(rec.id);
    if (!row) {
      lines.push(`[STATE_IMPORT] + ${rec.id} ${rec.status}`);
      changed = true;
    } else if (_body(taskRecord(row)) !== _body(rec)) {
      lines.push(`[STATE_IMPORT] ~ ${rec.id}${row.status !== rec.status ? ` ${row.status} → ${rec.status}` : ""}`);
      changed = true;
    }
  }
  const restore = [];
  for (const row of rows.values()) {
    if (archived.has(row.id)) {
      lines.push(`[STATE_IMPORT] - ${row.id} archived`);
    } else {
      lines.push(`[STATE_IMPORT] ↺ ${row.id} record file missing — rewritten from the index`);
      restore.push(row);
    }
    changed = true;
  }

  const rowStamps = db.prepare("SELECT type, task_id, timestamp FROM stamps").all().map(_stampKey).sort();
  const fileStamps = stamps.map(_stampKey).sort();
  if (rowStamps.join("\n") !== fileStamps.join("\n")) {
    const added = fileStamps.filter((k) => !rowStamps.includes(k)).length;
    lines.push(`[STATE_IMPORT] stamps: ${added} new, ${fileStamps.length} in all`);
    changed = true;
  }

  const proj = _projectRows(db);
  for (const k of PROJECT_KEYS) {
    const want = k in project && project[k] != null ? String(project[k]) : null;
    if ((proj[k] ?? null) !== want && (k in project || proj[k] != null)) {
      lines.push(`[STATE_IMPORT] project.${k} updated`);
      changed = true;
    }
  }

  for (const c of conflicts) lines.push(`[STATE_CONFLICT] ${c.id} kept ${c.kept}`);
  if (dryRun) return { status: "DRY_RUN", lines, changed };

  for (const row of restore) writeRecord(aiDir, "task", row.id, taskRecord(row));
  for (const c of conflicts) {
    insertStamp(aiDir, db, {
      type: "STATE_CONFLICT", agent: "state-import", task_id: /^[A-Z]+-\d+$/.test(c.id) ? c.id : null,
      timestamp: new Date().toISOString(), summary: `${c.id} kept ${c.kept}${c.detail ? ` (${c.detail})` : ""}`,
    });
  }
  if (gitDir && conflicts.length) rmSync(resolve(gitDir, CONFLICT_LOG), { force: true });
  if (changed || conflicts.length) {
    rebuildIndex(aiDir, db);
    renderViews(aiDir, db);
  }
  if (head) db.prepare("INSERT OR REPLACE INTO project(key, value) VALUES ('last_import_head', ?)").run(head);
  return { status: "OK", lines, changed: changed || conflicts.length > 0 };
}

/**
 * Record↔index parity for the pre-commit gate: the ids and statuses of the task records
 * equal the index's. @returns {{ok:boolean, lines:string[]}}
 */
export function checkParity(aiDir, db) {
  if (!isRecordStore(aiDir)) return { ok: true, lines: [] };
  let tasks;
  try {
    tasks = listRecords(aiDir, "task").map((e) => e.record);
  } catch (e) {
    return { ok: false, lines: [e.message] };
  }
  const rows = new Map(db.prepare("SELECT id, status FROM tasks").all().map((r) => [r.id, r.status]));
  const lines = [];
  for (const t of tasks) {
    if (!rows.has(t.id)) lines.push(`${t.id} has a record file but no index row`);
    else if (rows.get(t.id) !== t.status) lines.push(`${t.id} is ${t.status} in its record, ${rows.get(t.id)} in the index`);
    rows.delete(t.id);
  }
  for (const id of rows.keys()) lines.push(`${id} is in the index but has no record file`);
  return { ok: lines.length === 0, lines };
}

// ── the merge driver ─────────────────────────────────────────────────────────

function _readSide(p) {
  try {
    const t = readFileSync(p, "utf8");
    return t.trim() ? JSON.parse(t) : null;
  } catch {
    return undefined; // unreadable or not JSON: git keeps its own conflict
  }
}

const _isCiRecord = (r) => r && typeof r === "object" && typeof r.verdict === "string" && typeof r.sha === "string" && !("status" in r);

// During a rebase git's "ours" is the branch being rebased onto (the remote side).
function _rebasing(gitDir) {
  return !!gitDir && (existsSync(resolve(gitDir, "rebase-merge")) || existsSync(resolve(gitDir, "rebase-apply")));
}

/**
 * git merge driver for one record (`merge.rein-record.driver ... %O %A %B %P`). Writes the
 * result to `oursPath` and returns 0, or returns 1 to leave git's conflict in place (a side
 * that is not a JSON record, or a deletion against a change).
 */
export function mergeRecord(basePath, oursPath, theirsPath, pathname = "", { cwd = process.cwd() } = {}) {
  const base = _readSide(basePath), ours = _readSide(oursPath), theirs = _readSide(theirsPath);
  if (ours === undefined || theirs === undefined || ours === null || theirs === null) return 1;
  const write = (r) => writeFileSync(oursPath, JSON.stringify(r, null, 2) + "\n", "utf8");
  // E-328: two members ran the same sha (.ai/ci/<sha>.json). Evidence, not state: no rev,
  // no conflict entry — a valid side beats an invalid one, then a PASS beats a FAIL or
  // SKIPPED, else the later finish.
  if (_isCiRecord(ours) && _isCiRecord(theirs)) { write(mergeCiRecords(ours, theirs, pathname, cwd)); return 0; }
  const rev =Math.max(Number(ours.rev) || 0, Number(theirs.rev) || 0) + 1;

  if (_body(ours) === _body(theirs)) { write({ ...(ours.updated_at >= theirs.updated_at ? ours : theirs), rev }); return 0; }
  if (base && _body(base) === _body(ours)) { write(theirs); return 0; }
  if (base && _body(base) === _body(theirs)) { write(ours); return 0; }

  // Both sides changed the record: the D-102 policy.
  const ro = STATUS_RANK[ours.status] ?? 0, rt = STATUS_RANK[theirs.status] ?? 0;
  const keepOurs = ro !== rt ? ro > rt : String(ours.updated_at || "") >= String(theirs.updated_at || "");
  write({ ...(keepOurs ? ours : theirs), rev });

  const gitDir = _gitDir(cwd);
  const oursIsLocal = !_rebasing(gitDir);
  const kept = keepOurs === oursIsLocal ? "local" : "remote";
  const fileId = String(pathname).replace(/^.*\//, "").replace(/\.json$/, "");
  const id = [ours.id, theirs.id, fileId].find((x) => typeof x === "string" && LOG_ID_RE.test(x)) || "record";
  const [lo, re] = oursIsLocal ? [ours.status, theirs.status] : [theirs.status, ours.status];
  const detail = ours.status && theirs.status ? `${_safeStatus(lo)} local vs ${_safeStatus(re)} remote` : "both changed";
  if (gitDir) appendFileSync(resolve(gitDir, CONFLICT_LOG), JSON.stringify({ id, kept, detail, path: pathname }) + "\n");
  return 0;
}
