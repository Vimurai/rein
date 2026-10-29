#!/usr/bin/env node
// select-suites.mjs — E-298 (D-088, .ai/blueprints/test-economics.md Component 2): which suites a
// run takes, by tier and by change. tests/run.sh calls it; the decision is a pure function
// (selectSuites) so it is tested in tests/unit, not through the runner.
//
//   node tests/tools/select-suites.mjs --suites-dir <dir> [--tier fast|full] [--changed <ref>]
//        [--census <file.json>] [--repo <dir>] [--pattern <glob>]
// stdout: one suite path per line, then a line "#NOTE <text>" for each decision the runner
// should print (e.g. the --changed fallback). Exit 0; 2 on bad arguments.
//
// Rules:
//   full (default) — every suite matching the pattern: today's matrix, unchanged.
//   fast           — the node unit layer (node_unit_test.sh) + every CONTRACT-TABLE suite, i.e.
//                    a suite that drives a tests/fixtures/*-cases.json table.
//   --changed <ref> — fast, PLUS every suite whose census footprint intersects the files changed
//                    since <ref>, PLUS any suite file that itself changed. No census JSON → the
//                    committed tests/census-baseline.tsv's footprints (E-384, D-135 addendum
//                    r2 — a fresh clone has no ~/.rein/ci); neither → the full matrix, with a
//                    NOTE saying so. A suite with no footprint entry in the census
//                    is never selected by --changed (unknown footprint ⇒ it runs in full only).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UNIT_BRIDGE = "node_unit_test.sh";
const CASES_REF = /tests\/fixtures\/[A-Za-z0-9_-]+-cases\.json/;

function globToRe(glob) {
  return new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

/**
 * Pure decision. `suites`: [{ name, text }] (name = file basename, text = its source);
 * `census`: null or { suites: [{ name|file, footprint: [] }] }; `changed`: null or [repo paths].
 * Returns { selected: [names], notes: [strings] } — order follows `suites`.
 */
export function selectSuites({ suites, tier = "full", changed = null, census = null, pattern = "*_test.sh" }) {
  const re = globToRe(pattern);
  const pool = suites.filter((s) => re.test(s.name));
  const notes = [];
  const isFast = (s) => s.name === UNIT_BRIDGE || CASES_REF.test(s.text || "");
  if (changed === null) {
    if (tier === "fast") return { selected: pool.filter(isFast).map((s) => s.name), notes };
    return { selected: pool.map((s) => s.name), notes };
  }
  if (!census || !Array.isArray(census.suites)) {
    notes.push("--changed: no census file — running the FULL matrix (run `node tests/tools/census.mjs` after an `ai ci run`)");
    return { selected: pool.map((s) => s.name), notes };
  }
  const fp = new Map();
  for (const c of census.suites) {
    const key = basename(String(c.file || c.name || ""));
    const name = key.endsWith(".sh") ? key : `${key}_test.sh`;
    if (Array.isArray(c.footprint) && c.footprint.length) fp.set(name, new Set(c.footprint));
  }
  const changedSet = new Set(changed);
  const picked = pool.filter((s) => {
    if (isFast(s)) return true;
    if (changedSet.has(`tests/suites/${s.name}`)) return true;
    const f = fp.get(s.name);
    if (!f) return false;                       // no footprint entry ⇒ full only
    for (const p of f) if (changedSet.has(p)) return true;
    return false;
  });
  const unknown = pool.filter((s) => !fp.has(s.name) && !isFast(s)).length;
  if (unknown) notes.push(`--changed: ${unknown} suite(s) have no census footprint and run in the full tier only`);
  return { selected: picked.map((s) => s.name), notes };
}

/** Newest census-<date>.json under ~/.rein/ci (the full census, not a .since.json). */
export function newestCensus(dir = join(homedir(), ".rein", "ci")) {
  try {
    const files = readdirSync(dir).filter((f) => /^census-.*\.json$/.test(f) && !f.endsWith(".since.json"));
    files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    return files.length ? join(dir, files[0]) : null;
  } catch {
    return null;
  }
}

function changedSince(ref, repo) {
  const out = execFileSync("git", ["-C", repo, "diff", "--name-only", ref], { encoding: "utf8" });
  const untracked = execFileSync("git", ["-C", repo, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" });
  return [...new Set((out + "\n" + untracked).split("\n").map((l) => l.trim()).filter(Boolean))];
}

async function main(argv) {
  const opt = { tier: "full", changed: null, census: null, repo: null, pattern: "*_test.sh", dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === "--tier" && (v === "fast" || v === "full")) { opt.tier = v; i++; }
    else if (a === "--changed" && v) { opt.changed = v; i++; }
    else if (a === "--census" && v) { opt.census = v; i++; }
    else if (a === "--repo" && v) { opt.repo = v; i++; }
    else if (a === "--pattern" && v) { opt.pattern = v; i++; }
    else if (a === "--suites-dir" && v) { opt.dir = v; i++; }
    else { process.stderr.write(`select-suites: bad argument '${a}'\n`); return 2; }
  }
  if (!opt.dir) { process.stderr.write("select-suites: --suites-dir is required\n"); return 2; }
  const repo = resolve(opt.repo || join(opt.dir, "..", ".."));
  const suites = readdirSync(opt.dir).filter((f) => f.endsWith(".sh")).sort()
    .map((name) => ({ name, text: readFileSync(join(opt.dir, name), "utf8") }));
  let changed = null;
  if (opt.changed) {
    try { changed = changedSince(opt.changed, repo); }
    catch { process.stderr.write(`select-suites: unknown ref '${opt.changed}'\n`); return 2; }
  }
  let census = null;
  const cfile = opt.census || (changed ? newestCensus() : null);
  if (cfile && existsSync(cfile)) { try { census = JSON.parse(readFileSync(cfile, "utf8")); } catch { census = null; } }
  const pre = [];
  const baseline = join(repo, "tests", "census-baseline.tsv");
  if (changed && !census && existsSync(baseline)) {
    try {
      const { buildCensus } = await import("./census.mjs");
      census = buildCensus({ repo, ciLogs: join(repo, ".no-ci-logs"), inputs: [baseline] });
      pre.push("--changed: footprints from the committed tests/census-baseline.tsv (no local census)");
    } catch { census = null; }
  }
  const { selected, notes } = selectSuites({ suites, tier: opt.tier, changed, census, pattern: opt.pattern });
  notes.unshift(...pre);
  for (const s of selected) process.stdout.write(join(opt.dir, s) + "\n");
  for (const n of notes) process.stdout.write(`#NOTE ${n}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((rc) => process.exit(rc));
