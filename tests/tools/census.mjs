#!/usr/bin/env node
// tests/tools/census.mjs — the test census (E-297, D-088, test-economics.md §Component 1)
//
//   node tests/tools/census.mjs [--json <path>] [--since <ref>]
//        [--repo <dir>] [--ci-logs <dir>] [--input <census-input.tsv>]... [--no-tmp-inputs]
//
// One pass over the suite: per suite the assertion count, task-label density, wall time,
// FOOTPRINT (the src/ and hooks/ files it ran — recorded by tests/lib/footprint.sh — plus the
// ones its text names), spawn shape, and the last real failure from the CI logs; then the
// derived lists the Architect's Consolidation Map (P-44) starts from. Writes the JSON
// (default ~/.rein/ci/census-<date>.json) and prints a markdown summary. Exit 0.
//
// INPUTS (all read-only):
//   - CI logs (default ~/.rein/ci/logs/*.log, only those of THIS repository): the
//     `CENSUS_*` lines tests/run.sh prints under `rein ci run`, and the Results block (✓/✗ per
//     suite) for the failure history;
//   - census input files tests/run.sh leaves in $TMPDIR (rein-census-*.tsv) after a plain run;
//   - the previous census JSON beside the output, so failure history outlives log retention
//     (the CI log directory keeps 14 runs across ALL projects).
// The --repo / --ci-logs / --input / --no-tmp-inputs flags exist so tests can point the
// census at fixtures; they are additive to the blueprint's API.
//
// --since <ref>: list only the suites whose own file or footprint is among the files changed
// between <ref> and the working tree (the selection E-298's --changed will make); totals stay
// whole. Its default output is census-<date>.since.json, so it never replaces the full census
// that carries the failure history forward.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ── constants (the rules the blueprint names, one place) ────────────────────
export const MERGE_OVERLAP = 0.8;                       // footprint overlap for merge:<suite>
export const MISNAMED_RE = /^e\d+|_e\d+|p\d+_/;         // task id in a suite name (Component 3)
export const LABEL_RE = /\b(?:[EPD]-\d+(?:\.\d+[a-z]?)*|T-[A-Z0-9]+-\d+)\b/g;
const ASSERT_RE = /(?:^|[\s;&|({])(assert_(?!summary\b)[a-z_]+|_pass|_fail)\s/;
const PATH_RE = /(?:^|[^A-Za-z0-9_.-])((?:src|hooks)\/[A-Za-z0-9_./-]*[A-Za-z0-9_-])/g;
const CODE_EXT = /\.(mjs|js|cjs|sh|py)$/;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
// E-386 (D-135 r2): the committed census rows tests/run.sh reads when no local CI log exists.
export const CENSUS_BASELINE = "tests/census-baseline.tsv";

// ── repository inventory ────────────────────────────────────────────────────
function walk(root, rel, out) {
  let ents;
  try { ents = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (SKIP_DIRS.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, r, out);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

const lineCount = (text) => {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

/** Every file under src/, hooks/ and tests/ (repo-relative), plus the line totals. */
export function inventory(repo) {
  const srcFiles = [...walk(repo, "src", []), ...walk(repo, "hooks", [])];
  const testFiles = walk(repo, "tests", []);
  let srcLines = 0, testLines = 0;
  for (const f of srcFiles) {
    if (CODE_EXT.test(f) || /^src\/bin\/[^/.]+$/.test(f)) srcLines += lineCount(readFileSync(join(repo, f), "utf8"));
  }
  // E-386: the census baseline is scheduling data `rein ci run` rewrites, not test code.
  for (const f of testFiles) if (f !== CENSUS_BASELINE) testLines += lineCount(readFileSync(join(repo, f), "utf8"));
  return {
    srcSet: new Set(srcFiles),
    suites: testFiles.filter((f) => /^tests\/suites\/[^/]+_test\.sh$/.test(f)).sort(),
    unitFiles: testFiles.filter((f) => /^tests\/unit\/[^/]+\.test\.mjs$/.test(f)),
    srcLines, testLines,
  };
}

// ── static analysis of one suite file ───────────────────────────────────────
export function staticFacts(text, srcSet) {
  let assertions = 0, labels = 0, sleepsAllowed = 0, sleepsUnmarked = 0;
  const refs = new Set();
  for (const raw of text.split("\n")) {
    // E-307 (D-091): a fixed `sleep N` is allowed only on a line that says why
    // (`# REIN_SLEEP_ALLOWED: <reason>`) — the same grep as the acceptance, comments included.
    if (/sleep [0-9]/.test(raw)) { if (raw.includes("REIN_SLEEP_ALLOWED")) sleepsAllowed++; else sleepsUnmarked++; }
    const line = raw.trimStart();
    if (line.startsWith("#")) continue;
    if (ASSERT_RE.test(line) && !/^\s*(assert_[a-z_]+|_pass|_fail)\s*\(\)/.test(line)) {
      assertions++;
      labels += (line.match(LABEL_RE) || []).length;
    }
    for (const m of raw.matchAll(PATH_RE)) {
      const p = m[1].replace(/[./]+$/, "");
      if (srcSet.has(p)) refs.add(p);
    }
  }
  const tableRunner = /[-_]cases\.(json|mjs)\b/.test(text);
  // E-311 (D-092): a suite whose SUBJECT is the installer or `rein init` says so in its header
  // (first 10 lines, the runner's REIN_SUITE_TIMEOUT scope).
  const installerSubject = text.split("\n").slice(0, 10).some((l) => /^# REIN_INSTALLER_SUBJECT\b/.test(l));
  return { assertions, labels, refs: [...refs].sort(), tableRunner, sleepsAllowed, sleepsUnmarked, installerSubject };
}

// ── dynamic footprint: one recorded target → a repo file (or null) ──────────
export function resolveTarget(cmd, arg, srcSet) {
  if (cmd === "rein") return srcSet.has("src/bin/rein") ? "src/bin/rein" : null;
  let p = String(arg || "");
  const colon = p.match(/^-[ecp]:(.+)$|^--(?:eval|print):(.+)$/);
  if (colon) p = colon[1] || colon[2];
  else if (p.startsWith("-") || p === "<inline>") return null;
  p = p.replace(/^\.\//, "").replace(/[./]+$/, "");
  if (srcSet.has(p)) return p;
  // An absolute (or otherwise prefixed) path: a CI worktree, an installed mirror under a
  // sandbox HOME (~/.rein/shared/x.mjs ← src/shared/x.mjs). Longest suffix that names a
  // repo file wins.
  const segs = p.split("/").filter(Boolean);
  for (let k = segs.length; k >= 1; k--) {
    const tail = segs.slice(-k).join("/");
    for (const cand of [tail, `src/${tail}`, `hooks/${tail}`]) {
      if ((cand.startsWith("src/") || cand.startsWith("hooks/")) && srcSet.has(cand)) return cand;
    }
  }
  return null;
}

/** process | pure-node | mixed | none — pure-node = every spawn is `node <src module>`. */
export function spawnShape(entries, srcSet) {
  if (!entries) return null;
  if (entries.length === 0) return "none";
  let pure = 0;
  for (const e of entries) {
    const f = e.cmd === "node" ? resolveTarget(e.cmd, e.arg, srcSet) : null;
    if (f && f.startsWith("src/") && /\.(mjs|js|cjs)$/.test(f)) pure++;
  }
  if (pure === entries.length) return "pure-node";
  return pure === 0 ? "process" : "mixed";
}

// ── run records: tests/run.sh census input + rein ci run logs ─────────────────
/** Parse CENSUS_* lines (a census input file, or the block inside a CI log). */
export function parseCensusLines(text) {
  const out = { started_at: null, commit: null, pattern: null, suites: new Map(), fp: new Map(), total: null };
  let seen = false;
  for (const line of String(text).split("\n")) {
    if (!line.startsWith("CENSUS_")) continue;
    const f = line.split("\t");
    seen = true;
    if (f[0] === "CENSUS_RUN") Object.assign(out, { started_at: f[1] || null, commit: f[2] || null, pattern: f[3] || null });
    else if (f[0] === "CENSUS_SUITE") {
      out.suites.set(f[1], { wall_ms: +f[2], pass: +f[3], fail: +f[4], skip: +f[5], exit: +f[6] });
    } else if (f[0] === "CENSUS_FP") {
      if (!out.fp.has(f[1])) out.fp.set(f[1], []);
      out.fp.get(f[1]).push({ count: +f[2], cmd: f[3], arg: f.slice(4).join("\t") });
    } else if (f[0] === "CENSUS_TOTAL") out.total = { suites: +f[1], pass: +f[2], fail: +f[3], skip: +f[4] };
  }
  return seen ? out : null;
}

/**
 * installerLane(homes) → { lane: "shared"|"exclusive", reason } for a suite that runs the
 * installer / `rein init` (E-312, D-093). Shared only when its measured spawns ALL had a HOME of
 * their own — a harness temp dir ("tmp") or the suite's starting HOME ("run", which a lane
 * clones under CI). tests/run.sh applies the same rule (its _installer_lane); the
 * `# REIN_EXCLUSIVE: installer` header overrides both.
 */
export function installerLane(homes) {
  const keys = Object.keys(homes || {});
  if (!keys.length) return { lane: "exclusive", reason: "no measured installer footprint" };
  const bad = keys.filter((h) => h !== "tmp" && h !== "run");
  if (bad.length) return { lane: "exclusive", reason: `installer HOME ${bad.join(", ")}` };
  return { lane: "shared", reason: null };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** One `rein ci run` log → { repo, sha, dirty, started_at, passed, failed, census }. */
export function parseCiLogForCensus(text) {
  const lines = String(text).split("\n");
  const run = { repo: null, sha: null, dirty: false, started_at: null, passed: new Set(), failed: new Set(), census: null };
  for (const l of lines) {
    if (l.startsWith("[ci] sha=")) {
      const kv = Object.fromEntries(l.slice(5).split(/\s+/).map((t) => t.split("=")));
      Object.assign(run, { sha: kv.sha || null, dirty: kv.dirty === "1", started_at: kv.started_at || null });
    } else if (l.startsWith("[ci] repo=")) run.repo = l.slice("[ci] repo=".length).trim();
  }
  // The LAST Results block is the outer run's (a suite may print a nested runner's output).
  let r = -1;
  lines.forEach((l, i) => { if (l.startsWith("━━ Results")) r = i; });
  if (r >= 0) {
    for (let i = r + 1; i < lines.length; i++) {
      const m = lines[i].replace(ANSI, "").match(/^\s*([✓✗])\s+(\S+_test\.sh)\s+\(/);
      if (m) (m[1] === "✓" ? run.passed : run.failed).add(m[2]);
    }
  }
  run.census = parseCensusLines(text);
  if (run.census) {
    for (const [s, v] of run.census.suites) (v.fail > 0 || v.exit !== 0 ? run.failed : run.passed).add(s);
  }
  return run.sha && run.started_at ? run : null;
}

/**
 * E-386 (D-135 r2, ci-throughput.md §Component 2): the census baseline from one `rein ci run`
 * log — the CENSUS_RUN / CENSUS_SUITE / CENSUS_FP rows of its suite step (the first census
 * block after `[ci] ── suite:`; a nested runner prints none, the fast tier's comes later),
 * header first. Host-specific paths are what a fresh runner cannot use and what would churn
 * the file on every rewrite: a path inside the run's worktree becomes repo-relative, an
 * installer HOME `foreign:<path>` becomes `foreign` (it classifies the same), and a row still
 * naming an absolute path is dropped. → the file's text, or null when the log has no suite census.
 */
export const BASELINE_HEADER = "# census-baseline — tests/run.sh lane hints when no local CI log exists (E-386, D-135 r2). Written by `rein ci run` after a full unsharded PASS; do not edit.";
export function baselineFromLog(text) {
  const lines = String(text).split("\n");
  const s = lines.findIndex((l) => l.startsWith("[ci] ── suite:"));
  const c = s < 0 ? -1 : lines.findIndex((l, i) => i > s && l.startsWith("── census input (E-297) ──"));
  if (c < 0) return null;
  const rows = [];
  for (let i = c + 1; i < lines.length && lines[i].startsWith("CENSUS_"); i++) {
    const f = lines[i].split("\t");
    if (f[0] === "CENSUS_RUN" || f[0] === "CENSUS_SUITE") { rows.push(lines[i]); continue; }
    if (f[0] !== "CENSUS_FP") continue;
    if (f[3] === "installer" && /^foreign:/.test(f[5] || "")) f[5] = "foreign";
    for (let k = 4; k < f.length; k++) f[k] = f[k].replace(/(^|:)\/\S*?\/wt\//g, "$1");
    if (f.slice(4).some((v) => /(^|:)\//.test(v))) continue;
    rows.push(f.join("\t"));
  }
  return rows.some((r) => r.startsWith("CENSUS_SUITE\t")) ? `${[BASELINE_HEADER, ...rows].join("\n")}\n` : null;
}

/**
 * Failure history per suite file name → { last, failures, rerun_passed }.
 *
 * `last` (last_real_failure) is the newest CI run in which the suite failed. A failure is
 * presumed REAL (D-062, test-harness rules): "it passed on the rerun" is explicitly NOT
 * evidence of a flake, and no record today marks a failure environmental — so none is
 * dropped. What the records CAN say is reported beside it instead of silently applied:
 * `rerun_passed` counts failures that a LATER non-dirty run of the SAME commit passed, the
 * shape of a flake the Consolidation Map may want to look at. Dirty runs test a working
 * tree; nothing later can match them.
 */
export function failureHistory(runs) {
  const sorted = [...runs].sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  const out = new Map();
  sorted.forEach((r, i) => {
    for (const s of r.failed) {
      const h = out.get(s) || { last: null, failures: 0, rerun_passed: 0 };
      h.failures++;
      if (!r.dirty && sorted.slice(i + 1).some((l) => !l.dirty && l.sha === r.sha && l.passed.has(s))) h.rerun_passed++;
      if (!h.last || h.last < r.started_at) h.last = r.started_at;
      out.set(s, h);
    }
  });
  return out;
}

// ── derived lists ───────────────────────────────────────────────────────────
export function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  const inter = a.filter((x) => B.has(x)).length;
  return inter / (a.length + b.length - inter);   // Jaccard: symmetric, 1.0 = same footprint
}

const covers = (big, small) => { const B = new Set(big); return small.every((x) => B.has(x)); };

/**
 * HUB files: in more than HUB_SHARE of the suites (src/bin/rein is in most of them). A
 * footprint of {src/bin/rein} says "drives the CLI", not which behaviour, so hubs are left out
 * of the MERGE overlap and the DELETE coverage — otherwise every CLI suite is a merge (and
 * delete) candidate of every other. A suite whose footprint is ONLY hubs gets neither: file
 * granularity has no evidence about it. Hubs stay in `footprint`.
 */
export const HUB_SHARE = 0.2;
const HUB_MIN = 4;      // a small suite set must not turn every shared file into a hub
export function hubFiles(suites) {
  const n = new Map();
  for (const s of suites) for (const f of s.footprint) n.set(f, (n.get(f) || 0) + 1);
  const min = Math.max(HUB_MIN, suites.length * HUB_SHARE);
  return new Set([...n].filter(([, k]) => k > min).map(([f]) => f));
}

/**
 * candidates per suite (mutates `suites`):
 *   merge:<other>  footprint overlap (Jaccard, hub files excluded) ≥ MERGE_OVERLAP
 *   move-to-unit   spawn_shape pure-node — a pure function driven through a process
 *   delete:<by>    never failed in a non-empty history AND its footprint is covered by
 *                  <other> suite or by the contract-table runners together (<by> = table).
 *                  Two suites with the SAME footprint: only the one with fewer assertions
 *                  (then the later name) is offered for deletion, never both.
 *   misnamed       a task id in the suite name
 */
export function deriveCandidates(suites, { historyRuns = 0 } = {}) {
  const tableFp = new Set(suites.filter((s) => s.table_runner).flatMap((s) => s.footprint));
  const hubs = hubFiles(suites);
  const core = new Map(suites.map((s) => [s, s.footprint.filter((f) => !hubs.has(f))]));
  for (const s of suites) {
    const c = [];
    for (const o of suites) {
      if (o !== s && overlap(core.get(s), core.get(o)) >= MERGE_OVERLAP) c.push(`merge:${o.name}`);
    }
    if (s.spawn_shape === "pure-node") c.push("move-to-unit");
    const mine = core.get(s);
    if (historyRuns > 0 && s.ran_in_history && s.last_real_failure === null && mine.length && !s.table_runner) {
      const by = suites.find((o) => o !== s && core.get(o).length && covers(core.get(o), mine) &&
        (!covers(mine, core.get(o)) || o.assertions > s.assertions ||
          (o.assertions === s.assertions && o.name < s.name)));
      if (by) c.push(`delete:${by.name}`);
      else if (mine.every((f) => tableFp.has(f))) c.push("delete:table");
    }
    if (MISNAMED_RE.test(basename(s.file))) c.push("misnamed");
    s.candidates = c;
  }
  return suites;
}

// ── sources discovery ───────────────────────────────────────────────────────
function git(repo, args) {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** Does a CI log's `[ci] repo=` belong to this repository (same path, or same git store)? */
function sameRepoFn(repo) {
  const mine = real(repo);
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const memo = new Map();
  return (run) => {
    if (!run.repo) return false;
    if (real(run.repo) === mine) return true;
    if (!common) return false;
    if (!memo.has(run.repo)) {
      const theirs = existsSync(run.repo) ? git(run.repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) : null;
      // A removed worktree: the commit it tested is still in this store.
      memo.set(run.repo, theirs ? real(theirs) === real(common)
        : git(repo, ["cat-file", "-e", `${run.sha}^{commit}`]) !== null);
    }
    return memo.get(run.repo);
  };
}

function listFiles(dir, re) {
  try {
    return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f));
  } catch { return []; }
}

// ── the census ──────────────────────────────────────────────────────────────
export function buildCensus({ repo, ciLogs, inputs = [], previous = null, since = null, now = new Date() }) {
  const inv = inventory(repo);
  const sameRepo = sameRepoFn(repo);

  // Runs, newest first. A CI log with census lines is both a history run and a data run.
  const history = [];
  const dataRuns = [];
  for (const p of listFiles(ciLogs, /\.log$/)) {
    let run;
    try { run = parseCiLogForCensus(readFileSync(p, "utf8")); } catch { continue; }
    if (!run || !sameRepo(run)) continue;
    if (run.passed.size || run.failed.size) history.push(run);
    if (run.census) dataRuns.push({ at: run.started_at, census: run.census, source: p });
  }
  for (const p of inputs) {
    let c;
    try { c = parseCensusLines(readFileSync(p, "utf8")); } catch { continue; }
    if (c) dataRuns.push({ at: c.started_at || statSync(p).mtime.toISOString(), census: c, source: p });
  }
  dataRuns.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const failures = failureHistory(history);
  const prev = new Map((previous?.suites || []).map((s) => [s.name, s]));

  const sleeps = { allowed: 0, unmarked: 0 };
  let suites = inv.suites.map((file) => {
    const fname = basename(file);
    const name = fname.replace(/_test\.sh$/, "");
    const facts = staticFacts(readFileSync(join(repo, file), "utf8"), inv.srcSet);
    sleeps.allowed += facts.sleepsAllowed; sleeps.unmarked += facts.sleepsUnmarked;
    const data = dataRuns.find((d) => d.census.suites.has(fname));
    const last = data?.census.suites.get(fname) || null;
    const all = data ? (data.census.fp.get(fname) || []) : null;
    // E-311: the recorder's "installer" lines mark an installer / `rein init` run; they are not
    // spawns of their own (the bash line beside each one is), so they stay out of the footprint.
    const entries = all ? all.filter((e) => e.cmd !== "installer") : null;
    const installs = all ? all.filter((e) => e.cmd === "installer").reduce((n, e) => n + e.count, 0) : null;
    // E-312 (D-093): each installer line's 2nd field is its spawn's HOME class (tests/lib/
    // footprint.sh _rein_fp_home_class); a line from before E-312 has none → "unrecorded".
    const homes = all ? all.filter((e) => e.cmd === "installer").reduce((m, e) => {
      const h = e.arg.split("\t")[1] || "unrecorded";
      m[h] = (m[h] || 0) + e.count;
      return m;
    }, {}) : null;
    let dyn = entries ? [...new Set(entries.map((e) => resolveTarget(e.cmd, e.arg, inv.srcSet)).filter(Boolean))].sort() : null;
    let shape = spawnShape(entries, inv.srcSet);
    let wall = last ? last.wall_ms : null;
    let dynFrom = data ? data.at : null;
    const p = prev.get(name);
    if (!data && p && p.footprint_dynamic) {          // carry the last measured footprint
      dyn = p.footprint_dynamic; shape = p.spawn_shape; wall = p.wall_ms; dynFrom = p.dynamic_from || previous.generated;
    }
    const h = failures.get(fname) || { last: null, failures: 0, rerun_passed: 0 };
    let lrf = h.last;
    if (p && p.last_real_failure && (!lrf || p.last_real_failure > lrf)) lrf = p.last_real_failure;
    const footprint = [...new Set([...(dyn || []), ...facts.refs])].sort();
    return {
      name, file,
      assertions: last ? last.pass + last.fail + last.skip : facts.assertions,
      assertions_static: facts.assertions,
      labels: facts.labels,
      label_density: facts.assertions ? +(facts.labels / facts.assertions).toFixed(2) : 0,
      wall_ms: wall,
      footprint,
      footprint_dynamic: dyn,
      footprint_static: facts.refs,
      spawns: entries ? entries.reduce((n, e) => n + e.count, 0) : null,
      spawn_shape: shape,
      dynamic_from: dynFrom,
      last_real_failure: lrf,
      failures_in_history: h.failures,
      rerun_passed: h.rerun_passed,
      ran_in_history: history.some((r) => r.passed.has(fname) || r.failed.has(fname)) || !!(p && p.ran_in_history),
      table_runner: facts.tableRunner,
      installer_spawns: installs ?? (p ? p.installer_spawns ?? null : null),
      installer_subject: facts.installerSubject,
      installer_homes: homes && Object.keys(homes).length ? homes : (p ? p.installer_homes ?? null : null),
      candidates: [],
    };
  });
  deriveCandidates(suites, { historyRuns: history.length || previous?.history?.runs || 0 });
  // E-311: totals over the whole suite (before any --since filter). A suite that runs the
  // installer without declaring it as its subject is the finding; so is a declared subject
  // that, measured, never ran it.
  const installer = {
    spawns: suites.reduce((n, x) => n + (x.installer_spawns || 0), 0),
    by_suite: Object.fromEntries(suites.filter((x) => x.installer_spawns).map((x) => [x.name, x.installer_spawns])),
    unheadered: suites.filter((x) => x.installer_spawns && !x.installer_subject).map((x) => x.name),
    headered_not_measured: suites.filter((x) => x.installer_subject && !x.installer_spawns).map((x) => x.name),
    // E-312: the lane each installer-running suite may take — the same rule tests/run.sh
    // applies (installerLane), printed so the classification is visible before a run uses it.
    lanes: Object.fromEntries(suites.filter((x) => x.installer_spawns || x.installer_subject)
      .map((x) => [x.name, { homes: x.installer_homes || {}, ...installerLane(x.installer_homes)}])),
  };

  let sinceInfo = null;
  if (since) {
    // Files changed between <ref> and the working tree. An unknown ref is an error, never
    // "nothing changed" — an empty selection would read as "no suite is affected".
    const diff = git(repo, ["diff", "--name-only", since, "--"]);
    if (diff === null) throw new Error(`--since: '${since}' is not a revision in ${repo}`);
    const changed = new Set(diff.split("\n").filter(Boolean));
    suites = suites.filter((s) => changed.has(s.file) || s.footprint.some((f) => changed.has(f)));
    sinceInfo = { ref: since, changed_files: changed.size, suites: suites.length };
  }

  const at = history.map((r) => r.started_at).sort();
  return {
    generated: now.toISOString(),
    commit: git(repo, ["rev-parse", "HEAD"]),
    sources: { ci_logs: history.length, data_runs: dataRuns.map((d) => d.source) },
    history: {
      runs: history.length,
      carried_from: previous ? previous.generated : null,
      oldest: [previous?.history?.oldest, at[0]].filter(Boolean).sort()[0] || null,
      newest: at[at.length - 1] || previous?.history?.newest || null,
    },
    since: sinceInfo,
    suites,
    totals: { suites: inv.suites.length, unit_files: inv.unitFiles.length, test_lines: inv.testLines, src_lines: inv.srcLines,
      fixed_sleeps: sleeps, installer },
  };
}

// ── markdown summary ────────────────────────────────────────────────────────
export function renderMarkdown(c) {
  const t = c.totals;
  const by = (k) => c.suites.filter((s) => s.candidates.some((x) => x === k || x.startsWith(`${k}:`)));
  const list = (arr, f) => (arr.length ? arr.map(f).join("\n") : "- (none)");
  const measured = c.suites.filter((s) => s.wall_ms !== null);
  const out = [
    `# Test census — ${c.generated.slice(0, 10)} (${(c.commit || "no commit").slice(0, 7)})`,
    "",
    `| suites | unit files | test lines | src lines | test/src |`,
    `|---:|---:|---:|---:|---:|`,
    `| ${t.suites} | ${t.unit_files} | ${t.test_lines} | ${t.src_lines} | ${t.src_lines ? (t.test_lines / t.src_lines).toFixed(2) : "-"} |`,
    "",
    `Dynamic footprint for ${measured.length}/${c.suites.length} suites; failure history: ${c.history.runs} CI run(s)` +
      (c.history.oldest ? ` since ${c.history.oldest}` : "") + ".",
    t.installer ? `Installer / rein init runs: ${t.installer.spawns} (${Object.entries(t.installer.by_suite).map(([k, v]) => `${k} ${v}`).join(", ") || "none measured"}); ` +
      `unheadered spawners: ${t.installer.unheadered.join(", ") || "none"}` +
      (t.installer.headered_not_measured.length ? `; REIN_INSTALLER_SUBJECT but no measured run: ${t.installer.headered_not_measured.join(", ")}` : "") + "." : "",
    t.installer && t.installer.lanes && Object.keys(t.installer.lanes).length
      ? `Installer HOMEs → lane: ${Object.entries(t.installer.lanes).map(([k, v]) =>
        `${k} ${Object.entries(v.homes).map(([h, n]) => `${h}×${n}`).join("+") || "none"} → ${v.lane}${v.reason ? ` (${v.reason})` : ""}`).join("; ")}.`
      : "",
    t.fixed_sleeps ? `Fixed sleeps in suites: ${t.fixed_sleeps.allowed} allowed (REIN_SLEEP_ALLOWED), ${t.fixed_sleeps.unmarked} unmarked.` : "",
    c.since ? `Filtered to ${c.since.suites} suite(s) touching ${c.since.changed_files} file(s) changed since ${c.since.ref}.` : "",
    "",
    `## Merge candidates (footprint overlap ≥ ${MERGE_OVERLAP * 100}%)`,
    list(by("merge"), (s) => `- ${s.name} → ${s.candidates.filter((x) => x.startsWith("merge:")).map((x) => x.slice(6)).join(", ")}`),
    "",
    "## Move-to-unit candidates (every spawn is `node <src module>`)",
    list(by("move-to-unit"), (s) => `- ${s.name} (${s.spawns} spawns)`),
    "",
    "## Delete candidates (never failed, footprint covered)",
    c.history.runs || c.history.carried_from ? list(by("delete"), (s) => `- ${s.name} — covered by ${s.candidates.find((x) => x.startsWith("delete:")).slice(7)}`)
      : "- (no CI history yet — \"never failed\" cannot be claimed)",
    "",
    "## Misnamed (task id in the suite name)",
    list(by("misnamed"), (s) => `- ${s.file}`),
    "",
    "## Slowest suites",
    list([...measured].sort((a, b) => b.wall_ms - a.wall_ms).slice(0, 10), (s) => `- ${s.name}: ${(s.wall_ms / 1000).toFixed(1)} s`),
    "",
    "## Highest task-label density (labels per assertion)",
    list([...c.suites].sort((a, b) => b.label_density - a.label_density).slice(0, 10), (s) => `- ${s.name}: ${s.label_density} (${s.labels}/${s.assertions_static})`),
    "",
  ];
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--json") o.json = val();
    else if (a === "--since") o.since = val();
    else if (a === "--repo") o.repo = val();
    else if (a === "--ci-logs") o.ciLogs = val();
    else if (a === "--input") o.inputs.push(val());
    else if (a === "--no-tmp-inputs") o.noTmp = true;
    else if (a === "--baseline-from") o.baselineFrom = val();
    else if (a === "--baseline-out") o.baselineOut = val();
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`unknown argument '${a}'`);
  }
  return o;
}

// Only FULL censuses carry history forward: a --since census lists a subset of the suites.
function newestCensusJson(dir) {
  const files = listFiles(dir, /^census-\d{4}-\d{2}-\d{2}\.json$/).sort();
  for (const f of files.reverse()) {
    try { return JSON.parse(readFileSync(f, "utf8")); } catch { /* next */ }
  }
  return null;
}

export function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) {
    process.stderr.write(`census: ${e.message}\n`); return 2;
  }
  if (o.help) {
    process.stdout.write("usage: node tests/tools/census.mjs [--json <path>] [--since <ref>] [--repo <dir>] [--ci-logs <dir>] [--input <file>]... [--no-tmp-inputs]\n       node tests/tools/census.mjs --baseline-from <rein ci log> [--baseline-out <file>]\n");
    return 0;
  }
  const repo = resolve(o.repo || join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  // E-386: `--baseline-from <ci log> [--baseline-out <file>]` writes the census baseline only.
  if (o.baselineFrom) {
    let text;
    try { text = baselineFromLog(readFileSync(o.baselineFrom, "utf8")); } catch (e) {
      process.stderr.write(`census: ${e.message}\n`); return 2;
    }
    if (!text) { process.stderr.write("census: the log has no suite census — baseline not written\n"); return 1; }
    const out = resolve(o.baselineOut || join(repo, CENSUS_BASELINE));
    const tmp = `${out}.tmp-${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, out);
    process.stdout.write(`${out}\n`);
    return 0;
  }
  const ciHome = join(homedir(), ".rein", "ci");
  const now = new Date();
  const json = resolve(o.json || join(ciHome, `census-${now.toISOString().slice(0, 10)}${o.since ? ".since" : ""}.json`));
  const inputs = [...o.inputs, ...(o.noTmp ? [] : listFiles(tmpdir(), /^rein-census-.*\.tsv$/))];
  const previous = newestCensusJson(dirname(json));
  let census;
  try {
    census = buildCensus({ repo, ciLogs: o.ciLogs || join(ciHome, "logs"), inputs, previous, since: o.since, now });
  } catch (e) {
    process.stderr.write(`census: ${e.message}\n`); return 2;
  }
  mkdirSync(dirname(json), { recursive: true });
  writeFileSync(json, `${JSON.stringify(census, null, 2)}\n`);
  process.stdout.write(`${renderMarkdown(census)}\nJSON: ${json}\n`);
  return 0;
}

const isMain = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
