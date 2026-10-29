// project-upgrade.mjs — the data half of `ai init` as an idempotent upgrade (E-270, D-074
// §Components 1-2, .ai/blueprints/version-lifecycle.md).
//
// `ai init` used to create only what was MISSING, so a project provisioned by 3.0 kept a
// roles.json without the `tester` role and a providers.json naming providers v4 removed,
// forever. This helper owns the two things bash should not do by hand:
//
//   merge   — schema-bearing templates (.ai/roles.json, .ai/providers.json). ADDITIVE for
//             what the template has and the project lacks; SUBTRACTIVE only for entries
//             the framework itself once shipped and has since retired (provider_history in
//             src/config/legacy-artefacts.json — the same owned-vs-user-added rule E-274
//             applies to .mcp.json). Existing values and unknown keys are preserved; a
//             changed file is first copied to <name>.pre-<version>.json.
//   stamp   — project.rein_version / provisioned_at, written through state-db (state.json
//             is a view of state.sqlite; a hand edit would be overwritten).
//   version — the stamped version, read without side effects (doctor, the init banner).
//   rename  — E-383: the pre-rename lines in .ai/.gitattributes and .ai/.gitignore, and the old
//             keys in .ai/project.json and .ai/team.json (until 0.5).
//
// Output is one TAB-separated record per line so the CLI can count and print them:
//   merged|pending|stamped|skipped|error <TAB> <file> <TAB> <detail>
// Exit 0 always for merge/stamp/version (a finding is data, not a failure); exit 2 on a
// usage error. --check never writes anything.
//
// Rollback: the .pre-<version>.json copies; removing the rein_version/provisioned_at keys
// is safe (nothing gates on them).

import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const MERGED_FILES = ["roles.json", "providers.json"];

function _readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function _isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Providers the framework once shipped and no longer does. A provider name never shipped
 * is USER-ADDED and is never removed. Missing/unreadable registry → nothing is retired
 * (fail toward keeping the user's data).
 */
export function retiredProviders(templateProviders, legacyRegistry) {
  const history = Array.isArray(legacyRegistry?.provider_history) ? legacyRegistry.provider_history : [];
  const current = new Set(Object.keys(templateProviders || {}));
  return new Set(history.filter((p) => typeof p === "string" && !current.has(p)));
}

/**
 * Merge providers.json. Returns {doc, changes[]}; `doc` is a new object, the input is not
 * mutated. Existing provider entries are kept byte-for-byte in value.
 */
export function mergeProviders(project, template, retired) {
  const changes = [];
  const out = { ...project };
  const cur = _isObj(project.providers) ? { ...project.providers } : {};
  for (const name of Object.keys(cur)) {
    if (retired.has(name)) { delete cur[name]; changes.push(`-${name} (retired provider)`); }
  }
  for (const [name, spec] of Object.entries(template.providers || {})) {
    if (!(name in cur)) { cur[name] = spec; changes.push(`+${name}`); }
  }
  out.providers = cur;
  return { doc: out, changes };
}

/**
 * Merge roles.json against the MERGED provider set: a role bound to a provider that no
 * longer exists is dropped first, so the template can then re-add it with its default
 * binding (an architect bound to agy comes back as claude:1, not as nothing).
 */
export function mergeRoles(project, template, providerNames) {
  const changes = [];
  const out = { ...project };
  const cur = _isObj(project.roles) ? { ...project.roles } : {};
  for (const [name, spec] of Object.entries(cur)) {
    const p = _isObj(spec) ? spec.provider : undefined;
    if (typeof p === "string" && !providerNames.has(p)) {
      delete cur[name];
      changes.push(`-${name} (provider '${p}' is gone)`);
    }
  }
  for (const [name, spec] of Object.entries(template.roles || {})) {
    if (!(name in cur)) {
      cur[name] = spec;
      changes.push(changes.some((c) => c.startsWith(`-${name} `)) ? `~${name} → template default` : `+${name}`);
    }
  }
  // A drop immediately re-added is one change, not two.
  const readded = new Set(changes.filter((c) => c.startsWith("~")).map((c) => c.slice(1).split(" ")[0]));
  const final = changes.filter((c) => !(c.startsWith("-") && readded.has(c.slice(1).split(" ")[0])));
  out.roles = cur;
  return { doc: out, changes: final };
}

function _writeAtomic(path, text) {
  const tmp = `${path}.rein-tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/**
 * Plan (and unless check, apply) the template merges. Returns records
 * [{kind, file, detail}].
 */
export function runMerge({ aiDir, templatesDir, legacyPath, version, check = false }) {
  const records = [];
  const tplProvidersPath = join(templatesDir, "providers.json");
  const tplRolesPath = join(templatesDir, "roles.json");
  let tplProviders, tplRoles, legacy = null;
  try {
    tplProviders = _readJson(tplProvidersPath);
    tplRoles = _readJson(tplRolesPath);
  } catch (e) {
    return [{ kind: "error", file: "templates", detail: `unreadable template (${e.message}) — run: ai install` }];
  }
  try { if (legacyPath && existsSync(legacyPath)) legacy = _readJson(legacyPath); } catch { legacy = null; }
  const retired = retiredProviders(tplProviders.providers, legacy);

  // providers.json first: the role merge needs the provider set it produces.
  const docs = {};
  const plans = {};
  for (const file of MERGED_FILES) {
    const p = join(aiDir, file);
    if (!existsSync(p)) continue;               // ensure_file_if_missing created it or it is absent by choice
    try { docs[file] = _readJson(p); }
    catch (e) { records.push({ kind: "error", file, detail: `invalid JSON — left untouched (${e.message})` }); }
  }

  let providerNames = new Set(Object.keys(tplProviders.providers || {}));
  if (docs["providers.json"]) {
    plans["providers.json"] = mergeProviders(docs["providers.json"], tplProviders, retired);
    providerNames = new Set(Object.keys(plans["providers.json"].doc.providers));
  } else {
    // No project providers.json: the resolver falls back to the template's set.
    for (const r of retired) providerNames.delete(r);
  }
  if (docs["roles.json"]) {
    plans["roles.json"] = mergeRoles(docs["roles.json"], tplRoles, providerNames);
  }

  for (const file of MERGED_FILES) {
    const plan = plans[file];
    if (!plan || plan.changes.length === 0) continue;
    const detail = plan.changes.join(", ");
    if (check) { records.push({ kind: "pending", file: `.ai/${file}`, detail }); continue; }
    const p = join(aiDir, file);
    const stem = file.replace(/\.json$/, "");
    const backup = join(aiDir, `${stem}.pre-${version}.json`);
    // Keep the FIRST pre-merge copy for this version: a re-run must not overwrite the
    // original with an already-merged file.
    if (!existsSync(backup)) copyFileSync(p, backup);
    _writeAtomic(p, JSON.stringify(plan.doc, null, 2) + "\n");
    records.push({ kind: "merged", file: `.ai/${file}`, detail: `${detail} (was: .ai/${stem}.pre-${version}.json)` });
  }
  return records;
}

/** Read the stamped version with no side effects: the state.json view, then sqlite read-only. */
export function readProjectVersion(aiDir) {
  try {
    const s = _readJson(join(aiDir, "state.json"));
    const v = s?.project?.rein_version ?? s?.project?.aios_version; // rename:legacy-fallback (E-383, until 0.5)
    if (v) return v;
  } catch { /* fall through */ }
  const dbPath = join(aiDir, "state.sqlite");
  if (!existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // A store not yet opened read-write since the rename still holds the old row name.
    const r = db.prepare("SELECT value FROM project WHERE key = 'rein_version'").get()
      ?? db.prepare("SELECT value FROM project WHERE key = 'aios_version'").get(); // rename:legacy-fallback
    return r?.value ?? null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export async function runStamp({ aiDir, version, check = false }) {
  const hasDb = existsSync(join(aiDir, "state.sqlite"));
  const hasJson = existsSync(join(aiDir, "state.json"));
  if (!hasDb && !hasJson) {
    // Nothing to stamp yet (a project whose state was never seeded) — not a failure.
    return [{ kind: "skipped", file: ".ai/state.json", detail: "absent — version not stamped" }];
  }
  if (!hasDb) {
    // The first open will import state.json. If the import would be skipped (unparsable, or
    // a schema version it does not know), the store starts EMPTY and the stamp's view
    // regeneration would overwrite state.json with nothing — refuse instead.
    let ok = false;
    try { ok = _readJson(join(aiDir, "state.json"))?.version === "1.0"; } catch { ok = false; }
    if (!ok) return [{ kind: "error", file: ".ai/state.json", detail: "unreadable or unknown schema version — not stamped (state left untouched)" }];
  }
  const current = readProjectVersion(aiDir);
  if (current === version) return [];
  if (check) return [{ kind: "pending", file: ".ai/state.json", detail: `project.rein_version ${current ?? "(unstamped)"} → ${version}` }];
  // getDbSeeded, not getDb: when this is the first open of the store it imports state.json
  // exactly as task-synchronizer-mcp does, so the stamp can never regenerate state.json
  // from an empty database.
  const { getDbSeeded, stampProvisioning } = await import("../mcp/shared/state-db.js");
  const res = stampProvisioning(aiDir, getDbSeeded(aiDir), { version });
  if (!res.ok) return [{ kind: "error", file: ".ai/state.json", detail: res.error }];
  return res.changed
    ? [{ kind: "stamped", file: ".ai/state.json", detail: `project.rein_version ${res.previous ?? "(unstamped)"} → ${version}` }]
    : [];
}

// E-383 (D-132 r4, rein-rename.md §Component 4): the two .ai/ files `ai state migrate
// --team` wrote under the old name. Each old line is rewritten in place (a hand-added line
// is never touched); everything else in the file is kept. Removed in 0.5.
const LEGACY_LINES = { // rename:legacy-fallback
  ".gitattributes": [
    ["# AI-OS team records (D-102): both-sides changes resolve by the DONE > IN_PROGRESS > OPEN policy", "ATTRIBUTES_HEADER"], // rename:legacy-fallback
    [/ merge=aios-record$/, " merge=rein-record"], // rename:legacy-fallback
  ],
  ".gitignore": [
    ["# AI-OS team views (D-102): generated from the record files, never tracked", "IGNORE_BEGIN"], // rename:legacy-fallback
  ],
};

/** Files under aiDir that still carry a pre-rename line, rewritten unless --check. */
export async function runRename({ aiDir, check = false }) {
  const { ATTRIBUTES, IGNORE_BEGIN } = await import("../mcp/shared/record-migrate.mjs");
  const named = { ATTRIBUTES_HEADER: ATTRIBUTES.split("\n")[0], IGNORE_BEGIN };
  const records = [];
  for (const [file, rules] of Object.entries(LEGACY_LINES)) {
    const p = join(aiDir, file);
    if (!existsSync(p)) continue;
    const before = readFileSync(p, "utf8");
    let n = 0;
    const after = before.split("\n").map((line) => {
      for (const [from, to] of rules) {
        if (typeof from === "string" ? line === from : from.test(line)) {
          n++;
          return typeof from === "string" ? named[to] : line.replace(from, to);
        }
      }
      return line;
    }).join("\n");
    if (n === 0) continue;
    const detail = `${n} pre-rename line(s) rewritten (AI-OS → Rein, aios-record → rein-record)`; // rename:legacy-fallback
    if (check) { records.push({ kind: "pending", file: `.ai/${file}`, detail }); continue; }
    _writeAtomic(p, after);
    records.push({ kind: "merged", file: `.ai/${file}`, detail });
  }
  const keyDetail = (old, now) => `key ${old} → ${now}`;
  // state.json is a view: opening the store renames the row (state-db), rendering the view
  // drops the old key. A project E-382 stamped 0.4.0 under the old key is never restamped,
  // so the stamp alone would leave it.
  let view = null;
  try { view = existsSync(join(aiDir, "state.json")) ? _readJson(join(aiDir, "state.json")) : null; } catch { view = null; }
  if (view?.project && "aios_version" in view.project && view.version === "1.0") { // rename:legacy-fallback
    const detail = keyDetail("project.aios_version", "project.rein_version"); // rename:legacy-fallback
    if (check) records.push({ kind: "pending", file: ".ai/state.json", detail });
    else {
      const { getDbSeeded } = await import("../mcp/shared/state-db.js");
      const { renderStateJson } = await import("../mcp/shared/record-store.mjs");
      renderStateJson(aiDir, getDbSeeded(aiDir));
      records.push({ kind: "merged", file: ".ai/state.json", detail });
    }
  }
  // The two tracked JSON files that name an old key, rewritten through their own writers.
  const projectPath = join(aiDir, "project.json");
  if (existsSync(projectPath)) {
    const { readRecord, writeRecord, legacyProjectKeys } = await import("../mcp/shared/record-store.mjs");
    const rec = readRecord(aiDir, "project", null);
    if (rec && "aios_version" in rec) { // rename:legacy-fallback
      const detail = keyDetail("aios_version", "rein_version"); // rename:legacy-fallback
      if (check) records.push({ kind: "pending", file: ".ai/project.json", detail });
      else {
        const { rev, updated_at, origin, ...body } = legacyProjectKeys(rec);
        writeRecord(aiDir, "project", null, body);
        records.push({ kind: "merged", file: ".ai/project.json", detail });
      }
    }
  }
  const teamPath = join(aiDir, "team.json");
  let rawTeam = null;
  try { rawTeam = existsSync(teamPath) ? _readJson(teamPath) : null; } catch { rawTeam = null; }
  if (rawTeam?.ci && typeof rawTeam.ci === "object" && "aios_source" in rawTeam.ci) { // rename:legacy-fallback
    const detail = keyDetail("ci.aios_source", "ci.rein_source"); // rename:legacy-fallback
    if (check) records.push({ kind: "pending", file: ".ai/team.json", detail });
    else {
      const { readTeam, writeTeam } = await import("../mcp/shared/team.mjs");
      try {
        writeTeam(aiDir, readTeam(aiDir));
        records.push({ kind: "merged", file: ".ai/team.json", detail });
      } catch (e) {
        records.push({ kind: "error", file: ".ai/team.json", detail: `${e.message} — left untouched` });
      }
    }
  }
  return records;
}

function _parseArgs(argv) {
  const o = { cmd: argv[0], check: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") o.check = true;
    else if (a === "--ai-dir") o.aiDir = argv[++i];
    else if (a === "--templates") o.templatesDir = argv[++i];
    else if (a === "--legacy") o.legacyPath = argv[++i];
    else if (a === "--version") o.version = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function _emit(records) {
  for (const r of records) process.stdout.write(`${r.kind}\t${r.file}\t${r.detail}\n`);
}

async function main() {
  let o;
  try { o = _parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`project-upgrade: ${e.message}\n`); return 2; }
  const aiDir = resolve(o.aiDir || ".ai");
  const semver = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
  switch (o.cmd) {
    case "version": {
      process.stdout.write(`${readProjectVersion(aiDir) ?? ""}\n`);
      return 0;
    }
    case "merge": {
      if (!o.templatesDir || !semver.test(o.version || "")) {
        process.stderr.write("usage: project-upgrade.mjs merge --ai-dir D --templates T --version X.Y.Z [--legacy F] [--check]\n");
        return 2;
      }
      _emit(runMerge({ aiDir, templatesDir: resolve(o.templatesDir), legacyPath: o.legacyPath, version: o.version, check: o.check }));
      return 0;
    }
    case "stamp": {
      if (!semver.test(o.version || "")) {
        process.stderr.write("usage: project-upgrade.mjs stamp --ai-dir D --version X.Y.Z [--check]\n");
        return 2;
      }
      _emit(await runStamp({ aiDir, version: o.version, check: o.check }));
      return 0;
    }
    case "rename": {
      _emit(await runRename({ aiDir, check: o.check }));
      return 0;
    }
    default:
      process.stderr.write("usage: project-upgrade.mjs <merge|stamp|rename|version> …\n");
      return 2;
  }
}

// Main-module check on REAL paths (E-265): argv[1] may be spelled through a symlink
// (macOS /var → /private/var) while import.meta.url is resolved.
function _isMain() {
  try {
    return !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (_isMain()) {
  main().then((code) => { process.exitCode = code; },
              (e) => { process.stderr.write(`project-upgrade: ${e.stack || e}\n`); process.exitCode = 2; });
}
