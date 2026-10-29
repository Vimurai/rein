// stamp-gate.mjs — pre-commit Gate 2's question (E-329, D-102 §Component 6): was THIS commit's
// parent reviewed? A [CRITIC_STAMP] counts only when its `sha` (HEAD when it was stamped) equals
// the commit's parent HEAD. The seven-day window it replaces let one review unlock a week of
// unrelated commits; a stamp bound to a sha unlocks exactly the commit built on what was
// reviewed, however long ago that was.
//
//   node stamp-gate.mjs --ai-dir <d> --sha <parent HEAD>
//     exit 0 — a CRITIC_STAMP for that sha exists (one line on stderr names it)
//     exit 1 — none (stderr names HEAD and the newest stamped sha, so both are visible)
//     exit 2 — bad arguments
//
// Where a stamp may be: the state.sqlite index (or the state.json view when the index is not
// built yet), the rotated .ai/archive/stamps-*.json, and — in a team project — the record files
// under .ai/stamps/<YYYY-MM>/, so a teammate's pulled stamp counts before `ai state import`
// has run. A corrupt record is skipped with a warning (it never certifies anything).

import { realpathSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getDbSeeded } from "../mcp/shared/state-db.js";
import { isRecordStore, listRecords } from "../mcp/shared/record-store.mjs";

const SHA_RE = /^[0-9a-f]{40}$/;
const TYPE = "CRITIC_STAMP";
// What reaches a terminal and the model: no control character survives.
const _clean = (v, max = 120) => String(v ?? "").replace(/[\x00-\x1f\x7f]/g, "?").slice(0, max);

function _parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[++i];
  return o;
}

/** Every CRITIC_STAMP this clone can see: [{ sha, author, at, source }]. */
export function criticStamps(aiDir, warnings = []) {
  const out = [];
  const add = (s, source) => {
    if (s && s.type === TYPE) out.push({ sha: s.sha ?? null, author: s.author ?? null, at: s.timestamp ?? s.created_at ?? "", source });
  };
  if (existsSync(resolve(aiDir, "state.sqlite"))) {
    for (const s of getDbSeeded(aiDir).prepare("SELECT type, sha, author, timestamp FROM stamps WHERE type = ?").all(TYPE)) add(s, "state");
  } else if (existsSync(resolve(aiDir, "state.json"))) {
    try { for (const s of JSON.parse(readFileSync(resolve(aiDir, "state.json"), "utf8")).stamps || []) add(s, "state.json"); }
    catch { warnings.push("[GATE2] .ai/state.json is not valid JSON — its stamps are not read"); }
  }
  const arch = resolve(aiDir, "archive");
  if (existsSync(arch)) {
    for (const f of readdirSync(arch).filter((n) => /^stamps-\d{4}-\d{2}\.json$/.test(n)).sort()) {
      try { for (const s of JSON.parse(readFileSync(resolve(arch, f), "utf8"))) add(s, `archive/${f}`); }
      catch { warnings.push(`[GATE2] .ai/archive/${f} is not valid JSON — its stamps are not read`); }
    }
  }
  if (isRecordStore(aiDir)) {
    // One bad pulled file is skipped, not every record with it (critic_security P2).
    const bad = [];
    try { for (const { record } of listRecords(aiDir, "stamp", { skipInvalid: bad })) add(record, "record"); }
    catch (e) { bad.push(e.message); }
    for (const m of bad) warnings.push(`[GATE2] stamp record skipped: ${_clean(m, 200)}`);
  }
  return out;
}

/** { ok, match, newest } for the commit whose parent is `sha`. */
export function stampForParent(aiDir, sha, warnings = []) {
  const all = criticStamps(aiDir, warnings);
  const match = all.find((s) => s.sha === sha) || null;
  const bound = all.filter((s) => s.sha && SHA_RE.test(s.sha)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { ok: !!match, match, newest: bound[0] || null, total: all.length };
}

export function run(argv) {
  const o = _parseArgs(argv);
  if (!o["ai-dir"] || !SHA_RE.test(o.sha || "")) {
    process.stderr.write("usage: stamp-gate.mjs --ai-dir <d> --sha <40-hex parent HEAD>\n");
    return 2;
  }
  const warnings = [];
  const r = stampForParent(resolve(o["ai-dir"]), o.sha, warnings);
  for (const w of warnings) process.stderr.write(`${w}\n`);
  const sha7 = o.sha.slice(0, 7);
  if (r.ok) {
    process.stderr.write(`[GATE2] HEAD ${sha7} reviewed: ${TYPE} by ${_clean(r.match.author) || "?"} on ${_clean(r.match.at, 10)}\n`);
    return 0;
  }
  let why = `no ${TYPE} carries a commit sha (all ${r.total} were stamped before E-329)`;
  if (r.total === 0) why = `no ${TYPE} at all`;
  else if (r.newest) why = `the newest ${TYPE} is for ${r.newest.sha.slice(0, 7)} (by ${_clean(r.newest.author) || "?"} on ${_clean(r.newest.at, 10)})`;
  process.stdout.write(`[GATE2] no ${TYPE} for HEAD ${sha7} — ${why}\n`);
  return 1;
}

// Main-module check on REAL paths (E-265): argv[1] may be spelled through a symlink.
function _isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (_isMain()) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`[GATE2] stamp-gate: ${_clean(e.message, 300)}\n`); process.exitCode = 2; }
}
