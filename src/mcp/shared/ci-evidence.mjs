/**
 * ci-evidence.mjs — portable CI evidence (E-328, D-102 §Component 5a)
 *
 * In a team project (`.ai/team.json`) `ai ci run` writes a tracked `.ai/ci/<sha>.json` beside
 * its ci_runs row, so a run on one machine certifies the commit on every clone that pulls it:
 *
 *   { schema, sha, verdict: PASS|FAIL|SKIPPED, suites, tests: {passed, failed, skipped},
 *     started, finished, runner: <git email>, host, rein_version }
 *
 * Counts only — never log text. A record arrives by `git pull`, so every read validates it:
 * a filename that is not its own sha, a verdict outside the enum, a runner who is not a
 * member of team.json, a symlinked path or an oversized file is IGNORED with a warning (it
 * certifies nothing). Without team.json nothing here is read or written, so a single-operator
 * project's `ai ci` behaves exactly as before.
 *
 * One file per sha: two members who run the same commit write the same path. preferRecord()
 * decides which one stays, both for a local overwrite and in the rein-record merge driver —
 * a PASS beats a FAIL or SKIPPED (the same tree passed somewhere), else the later finish.
 */

import { readFileSync, existsSync, readdirSync, lstatSync, mkdirSync, writeFileSync, renameSync } from "fs";
import { resolve, join } from "path";
import { hostname } from "os";
import { readTeam } from "./team.mjs";
import { gitEmail } from "./record-store.mjs";
import { redact } from "../../shared/publish-scan.mjs"; // E-379 (D-130)

export const CI_RECORD_SCHEMA = 1;
export const CI_VERDICTS = ["PASS", "FAIL", "SKIPPED"];
const SHA_RE = /^[0-9a-f]{40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const MAX_CI_RECORD_BYTES = 16 * 1024;
// How many records the ancestor search considers, newest first — as ci-runs.js bounds rows.
const ANCESTOR_SEARCH_RECORDS = 50;

const ciDir = (aiDir) => resolve(aiDir, "ci");

/** .ai/ci/<sha>.json — the sha is validated, so a hostile value never addresses another path. */
export function ciRecordPath(aiDir, sha) {
  if (!SHA_RE.test(String(sha))) throw new Error(`invalid CI record sha: ${JSON.stringify(sha).slice(0, 50)}`);
  return join(ciDir(aiDir), `${sha}.json`);
}

/**
 * The team, when the project is one, else null. An invalid team.json is NOT a team for the
 * gates: they fall back to the local ci_runs rows (fail closed — no pulled record counts).
 */
function _team(aiDir, warnings) {
  try { return readTeam(aiDir); }
  catch (e) { warnings.push(`[CI_RECORD] ignoring .ai/ci/ records: ${e.message}`); return null; }
}

// No control character at all: these fields are printed to a terminal and to the model, and
// ESC would rewrite the one as surely as a newline forges a line in the other (critic_security).
const _line = (v, max) => typeof v === "string" && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
// A pulled filename quoted in a warning, reduced to something that cannot forge a line.
const _quoteName = (f) => JSON.stringify(f.slice(0, 60)).replace(/[\x00-\x1f\x7f]/g, "?");
const _count = (v) => v === null || (Number.isInteger(v) && v >= 0);

/** null when `rec` is a valid record for `sha` written by a member of `team`, else why not. */
export function validateCiRecord(rec, sha, team) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return "not an object";
  if (rec.sha !== sha) return `its sha ${_line(rec.sha, 64) ? String(rec.sha).slice(0, 12) : "?"} does not match the filename`;
  if (rec.schema !== CI_RECORD_SCHEMA) return `schema must be ${CI_RECORD_SCHEMA}`;
  if (!CI_VERDICTS.includes(rec.verdict)) return "verdict must be PASS, FAIL or SKIPPED";
  // Membership is not authentication: `runner` is as trustworthy as the commit author (D-102
  // §Security); hosted CI on the trunk (E-332) is the guard against a forged record.
  if (!_line(rec.runner, 255) ||!team || !Object.prototype.hasOwnProperty.call(team.members, rec.runner)) {
    return "its runner is not a member of .ai/team.json";
  }
  if (!_line(rec.started, 40) || !ISO_RE.test(rec.started)) return "started must be an ISO-8601 UTC time";
  if (rec.finished != null && !(_line(rec.finished, 40) && ISO_RE.test(rec.finished))) return "finished must be an ISO-8601 UTC time";
  if (!_count(rec.suites ?? null)) return "suites must be a count";
  const t = rec.tests;
  if (!t || typeof t !== "object" || !["passed", "failed", "skipped"].every((k) => _count(t[k] ?? null))) return "tests must be counts";
  if (!_line(rec.host ?? "", 255) || !_line(rec.rein_version ?? "", 64)) return "host and rein_version must be one short line";
  return null;
}

// Record files are pulled, so any committer controls them: a symlink on the path would aim
// the read (or a local write) outside .ai/ci/.
function _isPlain(p) {
  try { return !lstatSync(p).isSymbolicLink(); } catch { return true; }   // absent = nothing to follow
}

/**
 * The validated record for `sha`, or null. `warnings` collects one line per ignored file.
 * Callers pass `team` when they already read it.
 */
export function readCiRecord(aiDir, sha, { warnings = [], team } = {}) {
  team = team === undefined ? _team(aiDir, warnings) : team;
  if (!team) return null;
  if (!existsSync(ciRecordPath(aiDir, sha))) return null;
  return _load(aiDir, sha, team, warnings);
}

function _load(aiDir, sha, team, warnings) {
  const p = ciRecordPath(aiDir, sha);
  const name = `.ai/ci/${sha.slice(0, 12)}….json`;
  if (!_isPlain(ciDir(aiDir)) || !_isPlain(p)) { warnings.push(`[CI_RECORD] ignoring ${name}: a symlink`); return null; }
  let rec;
  try {
    if (lstatSync(p).size > MAX_CI_RECORD_BYTES) { warnings.push(`[CI_RECORD] ignoring ${name}: larger than ${MAX_CI_RECORD_BYTES} bytes`); return null; }
    rec = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    warnings.push(`[CI_RECORD] ignoring ${name}: not valid JSON (a merge conflict?)`);
    return null;
  }
  const why = validateCiRecord(rec, sha, team);
  if (why) { warnings.push(`[CI_RECORD] ignoring ${name}: ${why}`); return null; }
  return rec;
}

/** Every valid record, newest finish first (bounded). Invalid files are skipped with a warning. */
export function listCiRecords(aiDir, { warnings = [], team, limit = ANCESTOR_SEARCH_RECORDS } = {}) {
  team = team === undefined ? _team(aiDir, warnings) : team;
  const dir = ciDir(aiDir);
  if (!team || !existsSync(dir) || !_isPlain(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const sha = f.slice(0, -5);
    if (!SHA_RE.test(sha)) { warnings.push(`[CI_RECORD] ignoring .ai/ci/${_quoteName(f)}: the filename is not a commit sha`); continue; }
    const rec = _load(aiDir, sha, team, warnings);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => String(b.finished || b.started).localeCompare(String(a.finished || a.started)));
  return out.slice(0, limit);
}

/** Does the project have any CI evidence file? (the DONE gate's adoption test, with ci_runs) */
export function hasCiRecords(aiDir) {
  const dir = ciDir(aiDir);
  try { return existsSync(resolve(aiDir, "team.json")) && readdirSync(dir).some((f) => f.endsWith(".json")); }
  catch { return false; }
}

/**
 * The merge driver's choice between two sides of .ai/ci/<sha>.json: a side that validates
 * beats one that does not (an invalid PASS must not erase a valid FAIL), then preferRecord.
 * `pathname` is the path git passes (%P); `root` the repository whose team.json applies.
 */
export function mergeCiRecords(ours, theirs, pathname, root) {
  const sha = String(pathname).replace(/^.*\//, "").replace(/\.json$/, "");
  let team = null;
  try { team = readTeam(resolve(root, ".ai")); } catch { /* invalid: neither side validates */ }
  const ok = (r) => SHA_RE.test(sha) && validateCiRecord(r, sha, team) === null;
  if (ok(ours) !== ok(theirs)) return ok(ours) ? ours : theirs;
  return preferRecord(ours, theirs) ? ours : theirs;
}

/** a is kept over b: a PASS beats anything else, else the later finish (ties keep a). */
export function preferRecord(a, b) {
  if ((a.verdict === "PASS") !== (b.verdict === "PASS")) return a.verdict === "PASS";
  return String(a.finished || a.started || "") >= String(b.finished || b.started || "");
}

/** The evidence record for a ci_runs row (an ERROR run is a FAIL to everyone else). */
export function ciRecordFromRow(row, { runner, suites = null, reinVersion = "", host = "-" } = {}) {
  const verdict = row.status === "PASS" ? "PASS" : row.status === "SKIPPED" ? "SKIPPED" : "FAIL";
  const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  return {
    schema: CI_RECORD_SCHEMA, sha: row.sha, verdict, suites: int(suites),
    tests: { passed: int(row.suite_pass), failed: int(row.suite_fail), skipped: int(row.suite_skip) },
    started: row.started_at, finished: row.finished_at || null,
    runner, host: String(host).replace(/[\r\n\0]/g, "").slice(0, 255), rein_version: String(reinVersion || "").slice(0, 64),
  };
}

/**
 * Write the evidence for a recorded run. Team projects only; a dirty run certifies nothing
 * and is never written. A valid record already on disk that preferRecord() keeps (a
 * teammate's PASS over this machine's FAIL) is left in place.
 * @returns {{written: boolean, path?: string, reason?: string, warnings: string[]}}
 */
export function writeCiRecord(aiDir, row, opts = {}) {
  const warnings = [];
  const team = _team(aiDir, warnings);
  if (!team) return { written: false, reason: "not a team project", warnings };
  if (row.dirty) return { written: false, reason: "a dirty run certifies nothing", warnings };
  // E-386: nor does one shard — and a client that predates the shard field would read a
  // record as a certification of the whole commit, so a shard is never written at all.
  if (row.shard) return { written: false, reason: `shard ${row.shard} certifies nothing`, warnings };
  // E-379 (security P2-4): the host names a personal device; it is recorded only when
  // .ai/team.json says `"ci_record_host": true`, and is "-" otherwise.
  const rec = ciRecordFromRow(row, { runner: gitEmail(aiDir), ...(team.ci_record_host === true ? { host: hostname() } : {}), ...opts });
  const p = ciRecordPath(aiDir, rec.sha);
  if (!Object.prototype.hasOwnProperty.call(team.members, rec.runner)) {
    warnings.push(`[CI_RECORD] ${rec.runner} is not a member of .ai/team.json — teammates will ignore this record`);
  }
  const have = existsSync(p) ? _load(aiDir, rec.sha, team, warnings) : null;
  if (have && !preferRecord(rec, have)) {
    return { written: false, path: p, reason: `kept the ${have.verdict} record from ${have.runner}`, warnings };
  }
  const dir = ciDir(aiDir);
  if (!_isPlain(dir) || !_isPlain(p)) return { written: false, reason: ".ai/ci is a symlink", warnings };
  mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  // E-379 (D-130): `host` is free text; `runner` is identity metadata matched against
  // .ai/team.json members (as a stamp's author is commit metadata) and is not redacted.
  const out = { ...rec, host: redact(rec.host, { file: `.ai/ci/${rec.sha}.json`, aiDir }) };
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  renameSync(tmp, p);
  return { written: true, path: p, warnings };
}
