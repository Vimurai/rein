/**
 * record-migrate.mjs — `ai state migrate --team | --legacy` (E-325, D-102 §Component 1)
 *
 * --team explodes the single-operator store (state.sqlite, seeded from state.json when
 * absent) into one tracked record file per task and stamp plus `.ai/project.json`,
 * moves the rotated DONE tasks of `.ai/archive/state-done-*.json` to `.ai/tasks/archive/<YYYY-MM>/` (E-330),
 * and untracks the three generated views. project.json is written LAST: it is the marker
 * isRecordStore() keys on, so a migration that dies half way is still a legacy project and
 * running it again starts over.
 *
 * --legacy is the exact inverse: the index is rebuilt from the records (they are the truth),
 * the record files and team.json are removed, the views are rendered and tracked again.
 *
 * Both are idempotent and refuse on a dirty worktree, so the before/after is one commit.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync, lstatSync } from "fs";
import { resolve, dirname } from "path";
import { execFileSync } from "child_process";
import { getDbSeeded, nextId } from "./state-db.js";
import { readTeam, writeTeam, newTeam } from "./team.mjs";
import { discoverTrunk } from "./trunk.mjs";
import {
  PROJECT_SCHEMA, PROJECT_KEYS, isRecordStore, writeRecord, gitEmail, listRecords, taskRecord, stampRecord, stampRecordId,
  rebuildIndex, renderViews,
} from "./record-store.mjs";

export const VIEW_FILES   = ["state.json", "TASKS.md", "REVIEWS.md"];
// E-326: record files merge through the `aios-record` driver (record-import.mjs mergeRecord,
// configured per clone by `ai sync`); a clone without it falls back to git's text merge.
export const ATTRIBUTES = [
  "# AI-OS team records (D-102): both-sides changes resolve by the DONE > IN_PROGRESS > OPEN policy",
  "tasks/**/*.json merge=aios-record",
  "stamps/**/*.json merge=aios-record",
  "project.json merge=aios-record",
  "ci/*.json merge=aios-record",   // E-328: two members' runs of one sha — PASS first
].join("\n") + "\n";
// What an earlier `migrate --team` wrote; `--legacy` removes any version it wrote, never a hand-edited file.
const WRITTEN_ATTRIBUTES = new Set([ATTRIBUTES, ATTRIBUTES.replace("ci/*.json merge=aios-record\n", "")]);
export const IGNORE_BEGIN = "# AI-OS team views (D-102): generated from the record files, never tracked";

function _git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
}

// null when the worktree is clean, else the refusal. Untracked files do not count: they are
// not part of either side of the migration commit until the operator adds them.
function _refuseDirty(root) {
  let out;
  try {
    out = _git(root, ["status", "--porcelain", "--untracked-files=no"]);
  } catch {
    return { ok: false, code: "NOT_A_GIT_REPO", message: `${root} is not a git worktree — the migration is meant to be one commit.` };
  }
  if (out.trim()) {
    return {
      ok: false, code: "DIRTY_WORKTREE",
      message: `the worktree has uncommitted changes — commit or restore them first:\n${out.trimEnd()}`,
    };
  }
  return null;
}

// E-330: the template's `archive/` matches at any depth, so it hid the tracked
// .ai/tasks/archive/ too. The block re-includes it (it is appended after that rule).
const ARCHIVE_UNIGNORE = "!tasks/archive/";

function _ignoreBlock() {
  return [IGNORE_BEGIN, ...VIEW_FILES, ARCHIVE_UNIGNORE];
}

function _addIgnoreBlock(aiDir) {
  const p = resolve(aiDir, ".gitignore");
  const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (cur.split("\n").includes(IGNORE_BEGIN)) {
    // A project migrated before E-330 has the block without the re-include line.
    if (!cur.split("\n").includes(ARCHIVE_UNIGNORE)) {
      writeFileSync(p, cur + (cur.endsWith("\n") ? "" : "\n") + ARCHIVE_UNIGNORE + "\n", "utf8");
    }
    return;
  }
  const sep = cur === "" || cur.endsWith("\n") ? "" : "\n";
  writeFileSync(p, cur + sep + (cur ? "\n" : "") + _ignoreBlock().join("\n") + "\n", "utf8");
}

function _removeIgnoreBlock(aiDir) {
  const p = resolve(aiDir, ".gitignore");
  if (!existsSync(p)) return;
  const lines = readFileSync(p, "utf8").split("\n");
  const at = lines.indexOf(IGNORE_BEGIN);
  if (at < 0) return;
  const block = _ignoreBlock();
  let n = 0;
  while (n < block.length && lines[at + n] === block[n]) n++;
  // The blank separator line _addIgnoreBlock put in front of the block goes with it.
  const from = at > 0 && lines[at - 1] === "" ? at - 1 : at;
  lines.splice(from, at - from + n);
  writeFileSync(p, lines.join("\n"), "utf8");
}

// The readable .ai/archive/state-done-<YM>.json files. One that does not parse, or holds a
// row without a task id, is left in place (and out of this list), so a migration never
// deletes what it could not carry over.
function _archiveFiles(aiDir) {
  const dir = resolve(aiDir, "archive");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().filter((f) => {
    if (!/^state-done-\d{4}-\d{2}\.json$/.test(f)) return false;
    try {
      const rows = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
      return Array.isArray(rows) && rows.every((r) => r && /^[A-Z]+-\d+$/.test(r.id));
    } catch { return false; }
  });
}

function _archivedTasks(aiDir) {
  const out = [];
  for (const f of _archiveFiles(aiDir)) {
    const ym = f.slice("state-done-".length, -".json".length);
    for (const r of JSON.parse(readFileSync(resolve(aiDir, "archive", f), "utf8"))) out.push({ ym, row: r });
  }
  return out;
}

// --legacy: the tracked archive back into .ai/archive/state-done-<YM>.json (merged by id with
// any file already there), so folding a team project back loses no archived task.
function _foldArchive(aiDir) {
  const byMonth = new Map();
  for (const { id, record } of listRecords(aiDir, "task-archive")) {
    const ym = id.split("/")[0];
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push(record);
  }
  // Plan every write first: a file that is a symlink or does not hold an array is never
  // overwritten — the fold refuses before it has changed anything.
  const writes = [];
  for (const [ym, rows] of byMonth) {
    const p = resolve(aiDir, "archive", `state-done-${ym}.json`);
    let existing = [];
    if (existsSync(p) || _isLink(p) || _isLink(dirname(p))) {
      try {
        if (_isLink(p) || _isLink(dirname(p))) throw new Error("symlink");
        existing = JSON.parse(readFileSync(p, "utf8"));
        if (!Array.isArray(existing)) throw new Error("not an array");
      } catch (e) {
        return { error: `.ai/archive/state-done-${ym}.json cannot be merged into (${e.message}) — fix or move it, then run again.` };
      }
    }
    const have = new Set(existing.map((r) => r && r.id));
    writes.push([p, [...existing, ...rows.filter((r) => !have.has(r.id))]]);
  }
  for (const [p, rows] of writes) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(rows, null, 2) + "\n", "utf8");
  }
  return { folded: [...byMonth.values()].reduce((n, rows) => n + rows.length, 0) };
}

function _isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** @returns {{ok:boolean, code?:string, message:string}} */
export function migrateTeam(aiDir, { trunk: trunkFlag = null } = {}) {
  if (isRecordStore(aiDir)) {
    _addIgnoreBlock(aiDir);   // E-330: brings a pre-E-330 block's archive re-include line
    return { ok: true, code: "ALREADY_TEAM", message: "already a team project — nothing to do." };
  }
  const root = dirname(resolve(aiDir));
  const dirty = _refuseDirty(root);
  if (dirty) return dirty;

  // E-327: the migrating operator becomes the planner, so their git email must be real.
  const planner = gitEmail(aiDir);
  if (!/^[^\s@]+@[^\s@]+$/.test(planner)) {
    return { ok: false, code: "NO_GIT_EMAIL", message: "set `git config user.email` first — it names the planner in .ai/team.json and every record's origin." };
  }
  // E-341 (D-105 r1): a NEW team.json records the trunk; refused before anything is written.
  let trunk = null;
  if (!readTeam(aiDir)) {
    trunk = discoverTrunk(root, trunkFlag);
    if (!trunk.name) return { ok: false, code: "NO_TRUNK", message: trunk.message };
  }

  const db     = getDbSeeded(aiDir);
  const tasks  = db.prepare("SELECT rowid AS seq, * FROM tasks ORDER BY rowid").all();
  const stamps = db.prepare("SELECT * FROM stamps ORDER BY id").all();
  const proj   = Object.fromEntries(db.prepare("SELECT key, value FROM project").all().map((r) => [r.key, r.value]));

  for (const t of tasks) writeRecord(aiDir, "task", t.id, taskRecord(t), { fresh: true });
  // E-342 (D-106 r3): updated_at is the legacy row's transport field; a record carries its own.
  db.exec("UPDATE tasks SET updated_at = NULL");
  // Stamps made before D-102 were not bound to a commit: sha null, filename sha 0000000.
  // E-329: a stamp keeps the commit it reviewed (null for one stamped before E-329).
  for (const s of stamps) {
    writeRecord(aiDir, "stamp", stampRecordId(aiDir, s, s.sha ?? null), stampRecord({ ...s, seq: s.id }, s.sha ?? null), { fresh: true });
  }
  const archived = _archivedTasks(aiDir);
  for (const { ym, row } of archived) writeRecord(aiDir, "task-archive", `${ym}/${row.id}`, taskRecord(row), { fresh: true });
  // E-330 (D-102 §7): MOVED, not copied — the tracked records are the archive from here on,
  // and .ai/archive/ keeps only LOG/SESSION rotation. --legacy writes the JSON back.
  for (const f of _archiveFiles(aiDir)) rmSync(resolve(aiDir, "archive", f));

  _addIgnoreBlock(aiDir);
  writeFileSync(resolve(aiDir, ".gitattributes"), ATTRIBUTES, "utf8");
  // E-327 (D-102 §Component 3): the first ranges start after every id already issued
  // (nextId: live, archived and the high-water mark) — E gets 100, P gets 20.
  let teamNote = "  .ai/team.json kept as it was";
  if (!readTeam(aiDir)) {
    const first = (prefix, size) => { const n = Number(nextId(db, prefix, aiDir).split("-")[1]); return [[n, n + size - 1]]; };
    const ranges = { E: first("E", 100), P: first("P", 20) };
    writeTeam(aiDir, newTeam(planner, ranges, trunk.name));
    teamNote = `  .ai/team.json: planner ${planner}, ranges E:${ranges.E[0].join("-")} P:${ranges.P[0].join("-")}, trunk ${trunk.name} (from ${trunk.source}) — add teammates with: ai team add <email> --range E:<from>-<to>`;
  }
  _git(root, ["rm", "--cached", "--quiet", "--ignore-unmatch", ...VIEW_FILES.map((f) => `.ai/${f}`)]);

  const project = { schema: PROJECT_SCHEMA };
  for (const k of PROJECT_KEYS) {
    if (!(k in proj) && (k === "aios_version" || k === "provisioned_at")) continue;
    project[k] = k === "current_tier" && proj[k] != null ? Number(proj[k]) : proj[k] ?? null;
  }
  writeRecord(aiDir, "project", null, project, { fresh: true });
  renderViews(aiDir, db);

  return {
    ok: true,
    message:
      `migrated to team records: ${tasks.length} task(s), ${stamps.length} stamp(s), ${archived.length} archived task(s).\n` +
      `  views untracked and gitignored: ${VIEW_FILES.map((f) => `.ai/${f}`).join(", ")}\n` +
      `${teamNote}\n` +
      `  next: git add .ai && git commit -m "chore(.ai): migrate state to team records (D-102)"`,
  };
}

/** @returns {{ok:boolean, code?:string, message:string}} */
export function migrateLegacy(aiDir) {
  if (!isRecordStore(aiDir)) return { ok: true, code: "ALREADY_LEGACY", message: "not a team project — nothing to do." };
  const root = dirname(resolve(aiDir));
  const dirty = _refuseDirty(root);
  if (dirty) return dirty;

  // E-330: the tracked archive goes back to .ai/archive/ before .ai/tasks/ is removed.
  const fold = _foldArchive(aiDir);
  if (fold.error) return { ok: false, code: "ARCHIVE_FOLD", message: fold.error };
  const folded = fold.folded;

  const db = getDbSeeded(aiDir);
  const counts = rebuildIndex(aiDir, db);

  const notes = [];
  const teamPath = resolve(aiDir, "team.json");
  if (existsSync(teamPath)) {
    notes.push(`  removed .ai/team.json, which held:\n${readFileSync(teamPath, "utf8").trimEnd()}`);
    rmSync(teamPath);
  }
  rmSync(resolve(aiDir, "project.json"), { force: true });
  rmSync(resolve(aiDir, "tasks"), { recursive: true, force: true });
  rmSync(resolve(aiDir, "stamps"), { recursive: true, force: true });
  if (existsSync(resolve(aiDir, ".gitattributes")) && WRITTEN_ATTRIBUTES.has(readFileSync(resolve(aiDir, ".gitattributes"), "utf8"))) {
    rmSync(resolve(aiDir, ".gitattributes"));
  }
  _removeIgnoreBlock(aiDir);
  renderViews(aiDir, db);

  return {
    ok: true,
    message:
      `folded team records back into state.json: ${counts.tasks} task(s), ${counts.stamps} stamp(s), ${folded} archived task(s) into .ai/archive/.\n` +
      (notes.length ? notes.join("\n") + "\n" : "") +
      `  next: git add .ai && git commit -m "chore(.ai): fold team records back into state.json (D-102)"`,
  };
}
