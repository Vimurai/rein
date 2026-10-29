/**
 * state-db.js — Shared SQLite state helper (P-13)
 *
 * Extracted from task-synchronizer-mcp so that orchestrator-mcp and any
 * future MCP server can access the ACID-safe primary store without
 * duplicating schema or WAL setup.
 *
 * Exports: getDb, readState, regenerateViews, nextId
 *
 * E-325 (D-102): every task/stamp/project mutation is written through record-store.mjs,
 * which writes the record file first in a team project and is the only view writer.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "fs";
import { resolve } from "path";
import { DatabaseSync } from "node:sqlite";
import { migrateCiRuns } from "./ci-runs.js";
import { isRecordStore, rebuildIndex, renderViews, renderStateJson, insertTask, updateTask, setProject, archiveRecords, gitEmail } from "./record-store.mjs";
import { readTeam, nextTeamId, isPlanner, TeamError } from "./team.mjs";
import { checkBehindHead } from "./legacy-import.mjs";

const _dbCache = new Map();

/**
 * Open (or return cached) the state.sqlite DatabaseSync instance for `aiDir`.
 * Each distinct aiDir gets its own connection so that multiple consumers
 * within the same process can address different state stores without
 * silently sharing the first-opened one. Connections are keyed by the
 * resolved absolute path.
 */
export function getDb(aiDir) {
  const dbPath = resolve(aiDir, "state.sqlite");
  const cached = _dbCache.get(dbPath);
  if (cached) return cached;

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  // E-88: migrate the legacy SEO Keyword-Multiplier tables to the Topic
  // Cluster Engine vocabulary before the CREATE block runs. Idempotent and
  // safe on fresh DBs (no-op when the legacy tables are absent).
  _migrateSeoSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS project (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id           TEXT PRIMARY KEY,
      owner        TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'OPEN',
      tier         INTEGER,
      description  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      completed_at TEXT,
      summary      TEXT,
      depends_on   TEXT
    );
    CREATE TABLE IF NOT EXISTS stamps (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      type      TEXT NOT NULL,
      agent     TEXT,
      task_id   TEXT,
      timestamp TEXT NOT NULL,
      summary   TEXT
    );
    CREATE TABLE IF NOT EXISTS deltas (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT NOT NULL,
      summary    TEXT,
      files      TEXT,
      read       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS patches (
      id           TEXT PRIMARY KEY,
      path         TEXT NOT NULL,
      diff_content TEXT NOT NULL,
      description  TEXT,
      caller_role  TEXT,
      created_at   TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      -- E-221: the root that 'path' was resolved against, plus the path RELATIVE
      -- to it. confirm_patch re-derives its own root and refuses unless they agree.
      project_root TEXT,
      rel_path     TEXT
    );
    -- E-88: Multi-Variation-State-Tracker tables for the SEO Topic Cluster
    -- Engine (.ai/blueprints/seo-keyword-multiplier.md §Data Model).
    -- TopicSeed (formerly KeywordSeed) + ClusterPage (formerly
    -- ContentVariation). Idempotent — CREATE IF NOT EXISTS preserves any
    -- pre-existing rows on schema reopen. Legacy DBs are renamed in place
    -- by _migrateSeoSchema() above.
    CREATE TABLE IF NOT EXISTS topic_seeds (
      id            TEXT PRIMARY KEY,
      term          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'OPEN'
                      CHECK(status IN ('OPEN','IN_PROGRESS','COMPLETED','ARCHIVED')),
      target_volume INTEGER NOT NULL DEFAULT 10
                      CHECK(target_volume > 0 AND target_volume <= 10),
      created_at    TEXT NOT NULL,
      completed_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS cluster_pages (
      id                  TEXT PRIMARY KEY,
      seed_id             TEXT NOT NULL,
      intent_type         TEXT NOT NULL,
      content_blob        TEXT,
      performance_metrics TEXT,
      published_at        TEXT,
      created_at          TEXT NOT NULL,
      FOREIGN KEY (seed_id) REFERENCES topic_seeds(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cluster_pages_seed
      ON cluster_pages(seed_id);
    CREATE INDEX IF NOT EXISTS idx_cluster_pages_intent
      ON cluster_pages(seed_id, intent_type);
    INSERT OR IGNORE INTO meta(key, value) VALUES ('version', '1.0');
    INSERT OR IGNORE INTO meta(key, value) VALUES ('digest_stale', 'false');
    INSERT OR IGNORE INTO meta(key, value) VALUES ('digest_stale_reason', '');
    INSERT OR IGNORE INTO project(key, value) VALUES ('current_tier', NULL);
    INSERT OR IGNORE INTO project(key, value) VALUES ('release_verdict', NULL);
    INSERT OR IGNORE INTO project(key, value) VALUES ('focus', NULL);
  `);
  // E-91: add the DAG `depends_on` column to pre-existing tasks tables.
  // CREATE TABLE IF NOT EXISTS never alters an existing table, so DBs created
  // before E-91 need this idempotent ALTER. Safe + no-op on fresh DBs.
  _migrateTaskDag(db);
  // E-221: pending patches must carry the root they were resolved against.
  _migratePatchProjectRoot(db);
  // E-266 (D-072): the local CI run record (ci-runs.js owns the table).
  migrateCiRuns(db);
  // E-329 (D-102 §6): a stamp names the commit it reviewed and who stamped it.
  _migrateStampSha(db);
  // E-331 (D-102 §4): a claimed task names its holder.
  _migrateTaskClaims(db);
  // E-342 (D-106 r3): a legacy task write records when it happened, so an import can tell
  // which side of a record present on two machines is newer.
  _migrateTaskUpdatedAt(db);

  _dbCache.set(dbPath, db);
  return db;
}

/**
 * getDb + the one-time state.json → state.sqlite import on first open.
 *
 * Moved here from task-synchronizer-mcp (E-270) so every caller that may be the FIRST to
 * open a project's store — the MCP server, and `rein init`'s version stamp — seeds it the
 * same way. Opening a fresh store WITHOUT the import and then regenerating views would
 * rewrite state.json from an empty database.
 *
 * @param {string} aiDir
 * @param {{warn?:Function, info?:Function}} [log]
 */
export function getDbSeeded(aiDir, log = {}) {
  const dbPath   = resolve(aiDir, "state.sqlite");
  const jsonPath = resolve(aiDir, "state.json");
  const isNew    = !existsSync(dbPath);
  const db       = getDb(aiDir);
  // E-344 (D-108 r6): an index that exists but was never written — no tasks, no stamps, no
  // import on record — is unseeded too. A plain getDb() opener (a read-only MCP call) used to
  // create exactly that file, and the next regeneration rewrote the views from it.
  const unseeded = isNew || _neverWritten(db);
  // E-325 (D-102): in a team project the record files are the truth and state.json is a
  // gitignored view, so a fresh index is built from the files, never from the view.
  if (unseeded && isRecordStore(aiDir)) {
    rebuildIndex(aiDir, db);
  } else if (unseeded && existsSync(jsonPath)) {
    importStateJson(jsonPath, db, log);
  }
  return db;
}

// No task rows and no import recorded. A project whose state.json lists zero tasks reseeds
// on every open and imports zero rows; importStateJson skips stamps and deltas it already has.
function _neverWritten(db) {
  if (db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n > 0) return false;
  return db.prepare("SELECT value FROM project WHERE key = 'last_import_blob'").get()?.value == null;
}

/** E-344: the index for an observer (rein doctor) — null when state.sqlite does not exist, never seeded. */
export function openIndexIfExists(aiDir) {
  return existsSync(resolve(aiDir, "state.sqlite")) ? getDb(aiDir) : null;
}

/**
 * One-time import of state.json into SQLite on first run.
 * state.json is preserved for backwards compat (orchestrator-mcp reads it).
 */
export function importStateJson(jsonPath, db, { warn = () => {}, info = () => {} } = {}) {
  let state;
  try {
    state = JSON.parse(readFileSync(jsonPath, "utf8"));
    if (!state || state.version !== "1.0") {
      warn("state.json has unexpected version — skipping migration", { version: state?.version });
      return;
    }
  } catch {
    warn("state.json parse error — skipping migration");
    return;
  }

  const setProj = db.prepare("INSERT OR REPLACE INTO project(key, value) VALUES (?, ?)");
  const proj = state.project || {};
  setProj.run("current_tier",    proj.current_tier   != null ? String(proj.current_tier) : null);
  setProj.run("release_verdict", proj.release_verdict ?? null);
  setProj.run("focus",           proj.focus          ?? null);
  // E-270: the provisioning stamp survives a re-import.
  if (proj.rein_version   != null) setProj.run("rein_version",   String(proj.rein_version));
  if (proj.provisioned_at != null) setProj.run("provisioned_at", String(proj.provisioned_at));

  const insertTask = db.prepare(`
    INSERT OR IGNORE INTO tasks(id, owner, status, tier, description, created_at, completed_at, summary, depends_on, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of (state.tasks || [])) {
    // E-91: preserve dependency edges across the one-time JSON→SQLite import.
    const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
    insertTask.run(t.id, t.owner, t.status, t.tier ?? null,
                   t.description, t.created_at, t.completed_at ?? null, t.summary ?? null,
                   deps.length ? JSON.stringify(deps) : null, t.updated_at ?? null);
  }

  const insertStamp = db.prepare(
    "INSERT INTO stamps(type, agent, task_id, timestamp, summary, sha, author) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  // E-344: a reseed of an index that already holds stamps or deltas adds only the missing ones.
  const haveStamps = new Set(db.prepare("SELECT type, task_id, timestamp FROM stamps").all().map((r) => `${r.timestamp}|${r.type}|${r.task_id ?? ""}`));
  for (const s of (state.stamps || [])) {
    if (haveStamps.has(`${s.timestamp}|${s.type}|${s.task_id ?? ""}`)) continue;
    insertStamp.run(s.type, s.agent ?? null, s.task_id ?? null, s.timestamp, s.summary ?? null,
                    s.sha ?? null, s.author ?? null);
  }

  const insertDelta = db.prepare(
    "INSERT INTO deltas(task_id, summary, files, read, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const haveDeltas = new Set(db.prepare("SELECT task_id, summary, created_at FROM deltas").all().map((r) => `${r.task_id}|${r.created_at}|${r.summary ?? ""}`));
  for (const d of (state.deltas || [])) {
    if (haveDeltas.has(`${d.task_id}|${d.created_at || d.timestamp || ""}|${d.summary ?? ""}`)) continue;
    insertDelta.run(
      d.task_id,
      d.summary ?? null,
      d.files || d.files_changed ? JSON.stringify(d.files || d.files_changed) : null,
      d.read ? 1 : 0,
      d.created_at || d.timestamp || new Date().toISOString()
    );
  }

  const setMeta = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
  setMeta.run("digest_stale",        state.digest_stale ? "true" : "false");
  setMeta.run("digest_stale_reason", state.digest_stale_reason ?? "");

  info("imported state.json → state.sqlite");
}

/**
 * E-91 (ecc-integrations.md §Components 3): add the `depends_on` column to a
 * legacy tasks table that predates DAG support. Idempotent — checks
 * table_info before altering. Mirrors the _migrateSeoSchema pattern.
 */
function _migrateTaskDag(db) {
  const cols = db.prepare("PRAGMA table_info(tasks)").all();
  if (!cols.some((c) => c.name === "depends_on")) {
    db.exec("ALTER TABLE tasks ADD COLUMN depends_on TEXT;");
  }
}

// E-329: `sha` (HEAD when stamped) and `author` (git email). Rows stamped earlier keep
// NULL — pre-commit Gate 2 then finds no stamp for HEAD, which is the point of the change.
// A column another opener added between the PRAGMA and the ALTER is the state we wanted.
function _migrateStampSha(db) {
  const have = new Set(db.prepare("PRAGMA table_info(stamps)").all().map((c) => c.name));
  for (const col of ["sha", "author"]) {
    if (have.has(col)) continue;
    try { db.exec(`ALTER TABLE stamps ADD COLUMN ${col} TEXT`); }
    catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; }
  }
}

// E-331: assignee, claimed_at, claim_sha, claim_prev — NULL on every unclaimed task.
function _migrateTaskClaims(db) {
  const have = new Set(db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name));
  for (const col of ["assignee", "claimed_at", "claim_sha", "claim_prev"]) {
    if (have.has(col)) continue;
    try { db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`); }
    catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; }
  }
}

function _migrateTaskUpdatedAt(db) {
  if (db.prepare("PRAGMA table_info(tasks)").all().some((c) => c.name === "updated_at")) return;
  try { db.exec("ALTER TABLE tasks ADD COLUMN updated_at TEXT"); }
  catch (e) { if (!/duplicate column/i.test(String(e.message))) throw e; }
}

/**
 * E-221 (D-057 §1): add `project_root` + `rel_path` to a legacy patches table.
 *
 * A pending patch used to store only an ABSOLUTE path, resolved against whatever cwd
 * the PROPOSING process had. `confirm_patch` then wrote to that path without re-checking
 * it against its own root, so confirming from elsewhere landed the write outside the
 * confirming project. Recording the root the path was resolved against is what makes
 * the confirm-side check possible at all.
 *
 * Idempotent — mirrors _migrateTaskDag. Rows written before this migration keep both
 * columns NULL, which is exactly how confirm_patch recognises a legacy record and
 * refuses it rather than guessing which project it belonged to.
 */
function _migratePatchProjectRoot(db) {
  const cols = db.prepare("PRAGMA table_info(patches)").all();
  // Each ALTER is guarded individually. table_info is read ONCE, but 25 MCP servers can
  // call getDb() concurrently on a pre-migration DB: the loser of the race throws
  // "duplicate column name", which propagates out of getDb, and propose-patch's bare
  // catch turns that into "state.sqlite not found — run: rein init". Fail-closed, but
  // diagnosed as a missing database when the real cause is a concurrent migration.
  for (const col of ["project_root", "rel_path"]) {
    if (cols.some((c) => c.name === col)) continue;
    try {
      db.exec(`ALTER TABLE patches ADD COLUMN ${col} TEXT;`);
    } catch (e) {
      // Another process won the race and added it — the desired end state either way.
      if (!/duplicate column name/i.test(e.message)) throw e;
    }
  }
}

/**
 * Parse a JSON-encoded `files` column safely. Corrupt rows return [] and
 * write a single-line warning to stderr instead of crashing readState().
 */
function _safeParseFiles(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    process.stderr.write(`[WARN] state-db: corrupt deltas.files JSON — defaulting to []: ${e.message}\n`);
    return [];
  }
}

/**
 * E-91: parse the JSON-encoded `depends_on` column into a string array.
 * Corrupt or absent values degrade to [] (a task with no parseable
 * dependencies is treated as having none, never crashes readState).
 */
export function parseDeps(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Reconstruct the canonical state object from SQLite tables.
 */
export function readState(db) {
  const meta   = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map(r => [r.key, r.value]));
  const proj   = Object.fromEntries(db.prepare("SELECT key, value FROM project").all().map(r => [r.key, r.value]));
  const tasks  = db.prepare("SELECT * FROM tasks ORDER BY rowid").all();
  // E-329: sha/author are projected only when set, so a stamp written before them reads as before.
  const stamps = db.prepare(
    "SELECT type, agent, task_id, timestamp, summary, sha, author FROM stamps ORDER BY id"
  ).all().map(({ sha, author, ...s }) => ({
    ...s, ...(sha != null ? { sha } : {}), ...(author != null ? { author } : {}),
  }));
  const deltas = db.prepare(
    "SELECT task_id, summary, files, read, created_at FROM deltas ORDER BY id"
  ).all().map(d => ({
    task_id:    d.task_id,
    summary:    d.summary,
    files:      _safeParseFiles(d.files),
    read:       !!d.read,
    created_at: d.created_at,
  }));

  return {
    version: meta.version || "1.0",
    project: {
      current_tier:    proj.current_tier != null ? Number(proj.current_tier) : null,
      release_verdict: proj.release_verdict ?? null,
      focus:           proj.focus ?? null,
      // E-270 (D-074 §Components 1): the framework version that last provisioned this
      // project. Projected only once stamped, so an unstamped project's view is unchanged.
      ...(proj.rein_version   != null ? { rein_version:   proj.rein_version }   : {}),
      ...(proj.provisioned_at != null ? { provisioned_at: proj.provisioned_at } : {}),
    },
    tasks:               (() => {
      // E-91: enrich every task with parsed dependencies and DAG readiness.
      // `ready` is true when all depends_on tasks are DONE (or none exist);
      // `blocked_by` lists the still-unmet dependency ids. The Orchestrator
      // (E-92) dispatches only tasks that are OPEN and ready.
      const statusById = new Map(tasks.map(t => [t.id, t.status]));
      return tasks.map(({ assignee, claimed_at, claim_sha, claim_prev, updated_at, ...t }) => {
        const depends_on = parseDeps(t.depends_on);
        const blocked_by = depends_on.filter(d => statusById.get(d) !== "DONE");
        // E-331: the claim fields are projected only while set, so an unclaimed task reads as before.
        const claim = Object.fromEntries(Object.entries({ assignee, claimed_at, claim_sha, claim_prev }).filter(([, v]) => v != null));
        // E-342: updated_at likewise, so a task last written before it reads as before.
        return { ...t, tier: t.tier ?? null, depends_on, ready: blocked_by.length === 0, blocked_by, ...claim, ...(updated_at != null ? { updated_at } : {}) };
      });
    })(),
    stamps,
    deltas,
    digest_stale:        meta.digest_stale === "true",
    digest_stale_reason: meta.digest_stale_reason || null,
  };
}

/**
 * E-136 (role-abstraction.md): derive the provider-agnostic semantic role from an
 * owner string for TASKS.md section headers. "Engineer (Claude)" -> "Engineer",
 * "Architect (Claude)" -> "Architect", bare "Engineer" -> "Engineer". state.json
 * retains the full owner string; only the generated TASKS.md header is normalized,
 * so rebinding a role to another provider never churns the section headers.
 */
export function roleFromOwner(owner) {
  return String(owner || "Unassigned").split(" (")[0].trim() || "Unassigned";
}

/**
 * Regenerate the three backwards-compat views: TASKS.md, REVIEWS.md, state.json.
 * Must be called after every SQLite mutation so file-based consumers stay in sync.
 */
/**
 * E-245 (D-066 §5): the archive pointer for the generated TASKS.md view.
 *
 * `archive_done_tasks` rotates old DONE rows into .ai/archive/state-done-YYYY-MM.json and
 * keeps the last ten. That is the right trade — this repo's TASKS.md went from 261 lines
 * to 25 — but it left NO TRAIL: a reader saw ten completed tasks with no way to know that
 * 117 more existed, or where they went. History nobody can find has been lost as far as
 * the next person is concerned.
 *
 * E-325: the second projector (state-writer.js) is gone; record-store.mjs renderViews is
 * now the only producer of TASKS.md and calls this.
 *
 * Emits nothing when no archive file exists, so a project that has never rotated gets no
 * phantom section. An unreadable directory is silent: this is a generated VIEW, and a
 * filesystem hiccup must not stop it being written.
 */
export function archivePointerLines(aiDir) {
  // E-330 (D-102 §7): a team project's archive is tracked — point at its month directories.
  if (isRecordStore(aiDir)) {
    try {
      const base = resolve(aiDir, "tasks", "archive");
      const months = existsSync(base) ? readdirSync(base).filter((d) => /^\d{4}-\d{2}$/.test(d)).sort() : [];
      if (months.length === 0) return [];
      return [
        "## Archived",
        "",
        "Completed tasks beyond the most recent ten are rotated out of this view.",
        "Each one's full record — description, summary and completion date — is a tracked file in:",
        "",
        ...months.map((m) => `- \`.ai/tasks/archive/${m}/\` (${readdirSync(resolve(base, m)).filter((f) => f.endsWith(".json")).length} tasks)`),
        "",
        "`.ai/LOG.md` carries the narrative for every one of them.",
        "",
      ];
    } catch {
      return [];
    }
  }
  try {
    const files = readdirSync(resolve(aiDir, "archive"))
      .filter((f) => /^state-done-\d{4}-\d{2}\.json$/.test(f))
      .sort();
    if (files.length === 0) return [];
    return [
      "## Archived",
      "",
      "Completed tasks beyond the most recent ten are rotated out of this view.",
      "The full record — description, summary and completion date — is in:",
      "",
      ...files.map((f) => `- \`.ai/archive/${f}\``),
      "",
      "`.ai/LOG.md` carries the narrative for every one of them.",
      "",
    ];
  } catch {
    return [];
  }
}

export function regenerateViews(aiDir, db) {
  renderViews(aiDir, db);
}

// ── E-91: DAG dependency engine (ecc-integrations.md §Components 3) ──────────

/** Maximum dependency chain depth. Beyond this the LLM context gets confused
 *  by deep state trees (blueprint §Execution Constraints). */
export const MAX_DAG_DEPTH = 5;

/**
 * Read the full dependency graph from the tasks table.
 * Returns { deps: Map<id, string[]>, status: Map<id, status> }.
 */
export function readDependencyGraph(db) {
  const rows   = db.prepare("SELECT id, status, depends_on FROM tasks").all();
  const deps   = new Map();
  const status = new Map();
  for (const r of rows) {
    deps.set(r.id, parseDeps(r.depends_on));
    status.set(r.id, r.status);
  }
  return { deps, status };
}

/**
 * Validate that giving task `id` the dependency list `candidateDeps` keeps the
 * graph acyclic, within depth, and references only existing tasks. `id` may be
 * a brand-new task (not yet inserted) or an existing one whose deps are being
 * revised. Pure read — performs no writes.
 *
 * @returns {{ok: true, depth: number}} on success,
 *          {{ok: false, code: "DAG_FAIL", error: string}} on violation.
 */
export function validateDag(db, id, candidateDeps, opts = {}) {
  const maxDepth = opts.maxDepth ?? MAX_DAG_DEPTH;
  const unique   = [...new Set(Array.isArray(candidateDeps) ? candidateDeps : [])];
  const { deps: graph } = readDependencyGraph(db);

  // Self-reference is the degenerate 1-node cycle.
  if (unique.includes(id)) {
    return { ok: false, code: "DAG_FAIL", error: `Task ${id} cannot depend on itself.` };
  }
  // Every dependency must already exist — you cannot depend on a task that
  // was never created (catches typos and out-of-order task drops).
  const missing = unique.filter(d => !graph.has(d));
  if (missing.length) {
    return { ok: false, code: "DAG_FAIL", error: `Unknown dependency task(s): ${missing.join(", ")}.` };
  }

  // Overlay the candidate edges (covers both new and revised tasks).
  graph.set(id, unique);

  // Cycle detection via DFS from `id`, tracking the recursion stack.
  const onStack = new Set();
  const seen    = new Set();
  const path    = [];
  let   cycle   = null;
  (function dfs(node) {
    if (cycle) return;
    if (onStack.has(node)) { cycle = [...path, node]; return; }
    if (seen.has(node)) return;
    onStack.add(node); path.push(node);
    for (const d of (graph.get(node) || [])) dfs(d);
    onStack.delete(node); path.pop(); seen.add(node);
  })(id);
  if (cycle) {
    return { ok: false, code: "DAG_FAIL", error: `Circular dependency detected: ${cycle.join(" → ")}.` };
  }

  // Longest dependency chain length from `id` (graph is proven acyclic above).
  const memo = new Map();
  const depthOf = (node) => {
    if (memo.has(node)) return memo.get(node);
    const ds = graph.get(node) || [];
    const d  = ds.length === 0 ? 1 : 1 + Math.max(...ds.map(depthOf));
    memo.set(node, d);
    return d;
  };
  const depth = depthOf(id);
  if (depth > maxDepth) {
    return { ok: false, code: "DAG_FAIL", error: `Dependency chain depth ${depth} exceeds max ${maxDepth}.` };
  }

  return { ok: true, depth };
}

/**
 * Execute a callback inside a single ACID transaction.
 * Automatically COMMITs on success or ROLLBACKs on throw.
 *
 * @param {DatabaseSync} db
 * @param {function(db): any} callback
 * @returns the return value of callback
 */
export function withTransaction(db, callback) {
  db.exec("BEGIN");
  try {
    const result = callback(db);
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Compute the next sequential ID for a given prefix (E, P, T).
 */
// Highest numeric suffix among `<prefix>-N` ids, or 0 when none match.
function _maxIdNum(ids, prefix) {
  let max = 0;
  for (const id of ids) {
    if (typeof id !== "string" || !id.startsWith(`${prefix}-`)) continue;
    const n = parseInt(id.split("-")[1], 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max;
}

// E-109 (drift-resolution-2026.md): highest `<prefix>-N` id across every
// .ai/archive/state-done-*.json. Archived tasks have been DELETEd from the live
// table, so their ids must still bound the sequence or nextId can re-issue a
// retired id (the state-json-db-mismatch incident). Fail-soft on missing/corrupt
// archives — a bad file must never block task creation.
function _archivedMaxId(aiDir, prefix) {
  if (!aiDir) return 0;
  // E-330 (D-102 §7): a team project's archive is the tracked .ai/tasks/archive/<YM>/<id>.json
  // — the filename is the id. Read alongside the legacy JSON below, so an id archived either
  // way (or still sitting in a teammate's pre-migration file) is never issued again.
  let tracked = 0;
  try {
    const base = resolve(aiDir, "tasks", "archive");
    if (existsSync(base)) {
      for (const ym of readdirSync(base)) {
        if (!/^\d{4}-\d{2}$/.test(ym)) continue;
        const ids = readdirSync(resolve(base, ym)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
        tracked = Math.max(tracked, _maxIdNum(ids, prefix));
      }
    }
  } catch { /* fail-soft, as below: nextId still has the live rows and the high-water mark */ }
  try {
    const dir = resolve(aiDir, "archive");
    if (!existsSync(dir)) return tracked;
    let max = tracked;
    for (const f of readdirSync(dir)) {
      if (!/^state-done-.*\.json$/.test(f)) continue;
      let rows;
      try { rows = JSON.parse(readFileSync(resolve(dir, f), "utf8")); } catch { continue; }
      if (!Array.isArray(rows)) continue;
      const m = _maxIdNum(rows.map(t => t && t.id), prefix);
      if (m > max) max = m;
    }
    return max;
  } catch {
    return tracked;
  }
}

// E-109: allocate the next task id without ever colliding with an archived or
// previously-issued id. The next number is max(live, archived, high-water) + 1.
// PURE — it never writes, so a speculative nextId() for an add_task that later
// fails validation does not burn an id. The caller persists the high-water via
// recordIdHighWater() only after the row is actually inserted.
export function nextId(db, prefix, aiDir) {
  const liveRows = db.prepare("SELECT id FROM tasks WHERE id LIKE ?").all(`${prefix}-%`);
  const liveMax  = _maxIdNum(liveRows.map(r => r.id), prefix);
  const archMax  = _archivedMaxId(aiDir, prefix);

  const hwRow = db.prepare("SELECT value FROM project WHERE key = ?").get(`last_id_${prefix}`);
  const hwMax = hwRow ? (parseInt(hwRow.value, 10) || 0) : 0;

  return `${prefix}-${Math.max(liveMax, archMax, hwMax) + 1}`;
}

// E-109: persist the per-prefix high-water mark AFTER a task row is committed, so
// the sequence stays monotonic even if the row is later DELETEd from the live
// table without being archived. Idempotent: only advances, never regresses.
export function recordIdHighWater(db, id) {
  if (typeof id !== "string" || !id.includes("-")) return;
  const [prefix, numStr] = id.split("-");
  const num = parseInt(numStr, 10);
  if (isNaN(num)) return;
  const key = `last_id_${prefix}`;
  const row = db.prepare("SELECT value FROM project WHERE key = ?").get(key);
  const cur = row ? (parseInt(row.value, 10) || 0) : 0;
  if (num > cur) db.prepare("INSERT OR REPLACE INTO project(key, value) VALUES (?, ?)").run(key, String(num));
}

// ── Task creation (E-198: single-source write path) ─────────────────────────
// The one place a task row is created. Both task-synchronizer-mcp::add_task AND
// the shell-native `rein add-task` CLI (E-198, Ruling A / pending D-053) route
// through this, so state.sqlite stays the single writer and the two callers can
// never drift (the src/shared-reuse discipline). The sequence mirrors the historical add_task
// handler exactly: nextId → DAG validate → derive OPEN/BLOCKED → INSERT →
// advance id high-water (only after the row commits, E-109) → regenerate the
// TASKS.md/state.json/REVIEWS.md views so the row survives verify_markdown_sync.
//
// Framework-workspace routing (is_framework_task) and cloud-projection sync stay
// in the MCP handler — the caller resolves {aiDir, db} and passes them in.
//
// @param {{owner:string, description:string, tier?:number|null, prefix?:string,
//          depends_on?:string[]}} opts
// @returns {{ok:true, task:object} | {ok:false, code:string, error:string}}
export function addTask(aiDir, db, { owner, description, tier = null, prefix = "E", depends_on = [] } = {}) {
  if (typeof owner !== "string" || !owner.trim()) {
    return { ok: false, code: "INVALID_OWNER", error: "owner is required (non-empty string)." };
  }
  if (typeof description !== "string" || !description.trim()) {
    return { ok: false, code: "INVALID_DESCRIPTION", error: "description is required (non-empty string)." };
  }
  // E-342 (D-106 r4): a legacy index behind HEAD would mint an id HEAD already holds.
  const behind = checkBehindHead(aiDir, db);
  if (behind) return { ok: false, code: "STATE_BEHIND_HEAD", error: behind };

  // E-327 (D-102 §Component 3): with .ai/team.json the id comes from the caller's own
  // range (two developers can never mint the same id) and only the planner adds P tasks.
  // Without it, the v1 max+1 path below is unchanged.
  let id;
  let team;
  try {
    team = readTeam(aiDir);
    if (team) {
      const email = gitEmail(aiDir);
      if ((prefix || "E") === "P" && !isPlanner(team, email)) {
        return { ok: false, code: "NOT_PLANNER", error: `${email} is not the planner (${team.planner}) — P tasks are the planner's (.ai/team.json).` };
      }
      id = nextTeamId(aiDir, db, team, prefix || "E", email);
    }
  } catch (e) {
    if (e instanceof TeamError) return { ok: false, code: e.code, error: e.message };
    throw e;
  }
  if (!team) id = nextId(db, prefix || "E", aiDir);
  const deps = [...new Set(Array.isArray(depends_on) ? depends_on : [])];

  // E-91: validate dependency edges (existence, no self-ref, acyclic, depth ≤ 5)
  // before insert. A new task starts BLOCKED when any dependency is not yet DONE.
  if (deps.length) {
    const dag = validateDag(db, id, deps);
    if (!dag.ok) return { ok: false, code: dag.code, error: dag.error };
  }
  const allDepsDone = deps.every(d => {
    const r = db.prepare("SELECT status FROM tasks WHERE id = ?").get(d);
    return r && r.status === "DONE";
  });
  const initialStatus = deps.length && !allDepsDone ? "BLOCKED" : "OPEN";

  const task = {
    id,
    owner,
    status:       initialStatus,
    tier:         tier || null,
    description,
    created_at:   new Date().toISOString(),
    completed_at: null,
    summary:      null,
    depends_on:   deps,
  };

  insertTask(aiDir, db, task);

  // E-109: advance the per-prefix high-water mark only now that the row is
  // committed, so a rejected/failed add never burns an id.
  recordIdHighWater(db, task.id);
  regenerateViews(aiDir, db);
  return { ok: true, task };
}

// ── Task completion (E-325: one path for update_task_status and `rein task done`) ──
// Marks `id` DONE with its summary, then runs the E-91 unblock cascade: every BLOCKED task
// whose whole depends_on set is now DONE becomes OPEN. The completion GATES are the
// caller's (src/shared/completion-gates.mjs) and must pass before this is called; views
// are not regenerated here so the caller can batch further writes first.
// @returns {string[]} the ids that were unblocked
export function completeTask(aiDir, db, id, summary = null) {
  // E-331: DONE clears the claim (assignee and the rest) in the record and the row.
  updateTask(aiDir, db, id, {
    status: "DONE", completed_at: new Date().toISOString(), summary,
    assignee: null, claimed_at: null, claim_sha: null, claim_prev: null,
  });
  const unblocked = [];
  const { deps: graph, status } = readDependencyGraph(db);
  for (const [tid, tdeps] of graph) {
    if (status.get(tid) === "BLOCKED" && tdeps.includes(id) && tdeps.every(d => status.get(d) === "DONE")) {
      updateTask(aiDir, db, tid, { status: "OPEN" });
      unblocked.push(tid);
    }
  }
  return unblocked;
}

// ── E-270 (D-074 §Components 1): the provisioning stamp ──────────────────────
// `rein init` and `rein sync` record which framework version provisioned the project. It is
// written here, through the same handle and view regeneration as every other state
// mutation, because state.json is a VIEW of state.sqlite: an edit to state.json would be
// overwritten by the next regenerateViews.
//
// @returns {{ok:true, changed:boolean, previous:string|null, version:string, provisioned_at:string|null}
//          | {ok:false, code:string, error:string}}
export function stampProvisioning(aiDir, db, { version, at = new Date().toISOString() } = {}) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
    return { ok: false, code: "INVALID_VERSION", error: `version must be semver, got ${JSON.stringify(version)}.` };
  }
  const prev = db.prepare("SELECT value FROM project WHERE key = 'rein_version'").get();
  // Idempotent: re-provisioning with the same version keeps the original provisioned_at,
  // so a second `rein init` writes nothing (its --check must then report no changes).
  if (prev?.value === version) {
    const at0 = db.prepare("SELECT value FROM project WHERE key = 'provisioned_at'").get();
    return { ok: true, changed: false, previous: version, version, provisioned_at: at0?.value ?? null };
  }
  withTransaction(db, (d) => setProject(aiDir, d, { rein_version: version, provisioned_at: at }));
  // Only the state.json view carries project.* — TASKS.md and REVIEWS.md are left exactly
  // as they were, so `rein init` never rewrites them as a side effect of the stamp.
  renderStateJson(aiDir, db);
  return { ok: true, changed: true, previous: prev?.value ?? null, version, provisioned_at: at };
}

// ── Archive rotation (E-111: single-source ownership) ───────────────────────
// The SQLite-aware rotation for DONE tasks and audit stamps lives here so both
// task-synchronizer-mcp (the archive_done_tasks tool) and archive-manager-mcp
// (execute_archive) share ONE implementation — no more byte-duplicated copies,
// and no writes to the regenerated state.json view. Both regenerate the .ai/
// markdown views from SQLite after mutating, preserving the ACID contract.
export const DONE_ARCHIVE_THRESHOLD  = 50;
export const DONE_KEEP_RECENT        = 10;
export const STAMP_ARCHIVE_THRESHOLD = 50;
export const STAMP_KEEP_RECENT       = 10;

// Generic JSON-array archive append + delete for one table. Returns
// { archived, kept, archivePath } or null when at/below threshold.
function _rotateToArchive(aiDir, db, { table, orderBy, fileStem, threshold, keep }) {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
  if (rows.length <= threshold) return null;

  const toArchive  = rows.slice(0, rows.length - keep);
  const archiveIds = toArchive.map(r => r.id);

  const ym          = new Date().toISOString().slice(0, 7);
  const archiveDir  = resolve(aiDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const archivePath = resolve(archiveDir, `${fileStem}-${ym}.json`);

  let existing = [];
  if (existsSync(archivePath)) {
    try { existing = JSON.parse(readFileSync(archivePath, "utf8")); } catch { existing = []; }
  }
  writeFileSync(archivePath, JSON.stringify([...existing, ...toArchive], null, 2) + "\n", "utf8");
  // E-325: a team project's record files leave the live store before their rows do.
  archiveRecords(aiDir, table === "tasks" ? "task" : "stamp", toArchive, ym);

  const ph = archiveIds.map(() => "?").join(",");
  db.prepare(`DELETE FROM ${table} WHERE id IN (${ph})`).run(...archiveIds);

  regenerateViews(aiDir, db);
  return { archived: toArchive.length, kept: keep, archivePath };
}

// Move old DONE tasks (beyond the last DONE_KEEP_RECENT) to
// .ai/archive/state-done-YYYY-MM.json — a team project: the tracked
// .ai/tasks/archive/YYYY-MM/ (E-330) — when the count exceeds the threshold.
export function archiveDoneTasks(aiDir, db) {
  const done = db.prepare("SELECT * FROM tasks WHERE status = 'DONE' ORDER BY rowid").all();
  if (done.length <= DONE_ARCHIVE_THRESHOLD) return null;
  // Reuse the generic rotator but scoped to DONE rows (it re-selects with the
  // same predicate via a temp view would be overkill; inline the DONE slice).
  const toArchive   = done.slice(0, done.length - DONE_KEEP_RECENT);
  const archiveIds  = toArchive.map(t => t.id);
  const ym          = new Date().toISOString().slice(0, 7);
  let archivePath;
  if (isRecordStore(aiDir)) {
    // E-330 (D-102 §7): the tracked .ai/tasks/archive/<YM>/ IS the archive. The gitignored
    // .ai/archive/ copy made a teammate's clone see a different archived set (and its view
    // flip on the next mutation); it now keeps only LOG/SESSION rotation.
    archivePath = resolve(aiDir, "tasks", "archive", ym);
  } else {
    const archiveDir = resolve(aiDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    archivePath = resolve(archiveDir, `state-done-${ym}.json`);
    let existing = [];
    if (existsSync(archivePath)) {
      try { existing = JSON.parse(readFileSync(archivePath, "utf8")); } catch { existing = []; }
    }
    writeFileSync(archivePath, JSON.stringify([...existing, ...toArchive], null, 2) + "\n", "utf8");
  }
  archiveRecords(aiDir, "task", toArchive, ym); // E-325: record files move before the rows go
  const ph = archiveIds.map(() => "?").join(",");
  db.prepare(`DELETE FROM tasks WHERE id IN (${ph})`).run(...archiveIds);
  regenerateViews(aiDir, db);
  return { archived: toArchive.length, kept: DONE_KEEP_RECENT, archivePath };
}

// Rotate the oldest audit stamps to .ai/archive/stamps-YYYY-MM.json once the
// stamps table exceeds STAMP_ARCHIVE_THRESHOLD, keeping the newest in state.
export function archiveStamps(aiDir, db) {
  return _rotateToArchive(aiDir, db, {
    table: "stamps", orderBy: "id", fileStem: "stamps",
    threshold: STAMP_ARCHIVE_THRESHOLD, keep: STAMP_KEEP_RECENT,
  });
}

/**
 * E-88: next sequential TopicSeed id (`TS-N`). Separate namespace from the
 * task-id sequence so seeds and tasks never collide.
 */
export function nextTopicSeedId(db) {
  const rows = db.prepare("SELECT id FROM topic_seeds WHERE id LIKE ?").all("TS-%");
  const nums = rows.map(r => parseInt(r.id.split("-")[1], 10)).filter(n => !isNaN(n));
  return `TS-${nums.length > 0 ? Math.max(...nums) + 1 : 1}`;
}

/**
 * E-88: next sequential ClusterPage id (`CP-N`). Distinct from E-/P-/T-
 * task ids — pages are tracked by their topic cluster and intent_type, not
 * as Engineer/Architect/Tester work items.
 */
export function nextClusterPageId(db) {
  const rows = db.prepare("SELECT id FROM cluster_pages WHERE id LIKE ?").all("CP-%");
  const nums = rows.map(r => parseInt(r.id.split("-")[1], 10)).filter(n => !isNaN(n));
  return `CP-${nums.length > 0 ? Math.max(...nums) + 1 : 1}`;
}

/**
 * E-88: in-place migration of the legacy Keyword-Multiplier schema to the
 * Topic Cluster Engine vocabulary. Idempotent and safe on fresh DBs:
 *   keyword_seeds       → topic_seeds
 *   content_variations  → cluster_pages
 *   cluster_pages.approach_type → intent_type
 * Existing rows (and their target_volume CHECK from the legacy schema) are
 * preserved; the MCP layer enforces the lifted cap via MAX_CLUSTER_PAGES_PER_SEED.
 */
function _migrateSeoSchema(db) {
  const hasTable = (name) =>
    !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

  if (hasTable("keyword_seeds") && !hasTable("topic_seeds")) {
    db.exec("ALTER TABLE keyword_seeds RENAME TO topic_seeds;");
  }
  if (hasTable("content_variations") && !hasTable("cluster_pages")) {
    db.exec("ALTER TABLE content_variations RENAME TO cluster_pages;");
  }
  if (hasTable("cluster_pages")) {
    const cols = db.prepare("PRAGMA table_info(cluster_pages)").all();
    if (cols.some((c) => c.name === "approach_type")) {
      db.exec("ALTER TABLE cluster_pages RENAME COLUMN approach_type TO intent_type;");
    }
  }
  // Drop the legacy index names so the CREATE INDEX IF NOT EXISTS below
  // installs the renamed indices without leaving orphans behind.
  db.exec("DROP INDEX IF EXISTS idx_variations_seed;");
  db.exec("DROP INDEX IF EXISTS idx_variations_approach;");
}
