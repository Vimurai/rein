// ci-plan.mjs — how much CI a change needs (E-449, D-166 r1; .ai/blueprints/smart-ci.md §Component 1).
//
// planFromInputs() is the decision: a pure function of the changed paths, the commit subjects in
// base..head and the census built from the committed tests/census-baseline.tsv. ciPlan() gathers
// those inputs from git and the project, then calls it. Levels, lowest first:
//   none     every changed path is bookkeeping (.ai/**, plans/**)
//   fast     docs-class only, and no suite's census footprint reads a changed path
//   affected every changed path is known to the census and none is on the full list
//   full     anything else — and every case the planner cannot prove lower (FAIL-FULL)
// Suite selection is delegated to the project's tests/tools/select-suites.mjs (E-298); this
// module never reimplements it. A project without tests/tools/census.mjs has none, fast
// (docs-only) and full. Any thrown error yields full with a reason starting [PLAN_FALLBACK].
//
//   node ci-plan.mjs [--root <dir>] [--base <ref>] [--head <ref>] [--json]
// exit 0 for a computed plan (a fallback included); 2 on a usage error.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule } from "../mcp/shared/is-main.mjs";

export const LEVELS = ["none", "fast", "affected", "full"];
export const FALLBACK = "[PLAN_FALLBACK]";
// §Component 1. Paths that decide the plan are on it (§Security): a change to them is tested in full.
export const FULL_PATHS = ["tests/run.sh", "tests/lib/**", "tests/tools/**", "tests/census-baseline.tsv",
  "package.json", "package-lock.json", "**/package.json", "install-*.sh", "hooks/**", ".github/**",
  "src/templates/ci/**", "src/shared/ci-plan.mjs", "src/shared/hosted-ci.mjs", ".ai/team.json"];
export const DOCS_PATHS = ["**/*.md", "docs/**", "LICENSE*", "legal/**",
  "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.gif", "**/*.svg", "**/*.webp", "**/*.ico"];
export const BOOKKEEPING_PATHS = [".ai/**", "plans/**"];
const UNIT_BRIDGE = "node_unit_test.sh";
const SHARD_SECONDS = 240;

/** A repo-path glob: `**` any run of characters (with `/`), `**\/` zero or more directories, `*` and `?` within one segment. */
export function globToRe(glob) {
  // critic_security P2: a run of `**` segments is one `**` (each would be another `.*` to backtrack).
  glob = String(glob).replace(/(?:\*\*\/)+/g, "**/").replace(/\*{3,}/g, "**");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += /[.+^${}()|[\]\\]/.test(c) ? "\\" + c : c;
  }
  return new RegExp("^" + re + "$");
}
const matcher = (globs) => { const res = globs.map(globToRe); return (p) => res.some((r) => r.test(p)); };

const plan = (level, reason, x = {}) => ({
  level, reason, base: x.base ?? null, head: x.head ?? null, tree: x.tree ?? null,
  suites: x.suites ?? [], skipped: x.skipped ?? 0, est_seconds: x.est_seconds ?? null,
  shards: x.shards ?? 1, platforms: x.platforms ?? platformsFor(x.event),
});

/** Component 4's answer (E-451 renders it): a pull request runs Linux; a trunk push adds macOS; nightly and release run every leg. */
export function platformsFor(event = "pull_request") {
  return event === "pull_request" ? ["ubuntu-latest"] : ["ubuntu-latest", "macos-latest"];
}

/**
 * The decision. Inputs:
 *   changed      [repo paths] — both sides of a rename
 *   subjects     [commit subjects in base..head]
 *   base, head, tree, event
 *   shallow      true in a shallow clone
 *   team         parsed .ai/team.json or null
 *   censusTool   true when the project has tests/tools/census.mjs
 *   baseline     "FRESH" | "STALE" | "MISSING"
 *   census       { suites: [{ name, file, wall_ms, footprint }] } or null
 *   suites       [{ name, text }] — every suite file, as select-suites reads them
 *   select       the project's selectSuites
 */
export function planFromInputs(i) {
  const at = { base: i.base, head: i.head, tree: i.tree, event: i.event };
  try {
    const ci = i.team?.ci || {};
    const all = (i.suites || []).map((s) => s.name);
    const wall = new Map((i.census?.suites || []).map((s) => [basename(String(s.file || s.name || "")).replace(/(_test)?\.sh$/, "") + "_test.sh", s.wall_ms || 0]));
    const seconds = (names) => Math.round(names.reduce((n, s) => n + (wall.get(s) || 0), 0) / 1000);
    const full = (reason) => plan("full", reason, { ...at, suites: all, skipped: 0, est_seconds: seconds(all),
      shards: seconds(all) < SHARD_SECONDS ? 1 : (ci.shards || 1) });
    if (ci.smart === false) return full("ci.smart is false in .ai/team.json");
    if (!i.base) return full("no base to diff against");
    if (i.shallow) return full("shallow clone — the range cannot be read");
    const t3 = (i.subjects || []).find((s) => /\[TIER_3\]/.test(s));
    if (t3) return full(`a [TIER_3] commit in the range: ${t3.slice(0, 80)}`);

    const isFull = matcher([...FULL_PATHS, ...(ci.full_paths || [])]);
    const isBook = matcher(BOOKKEEPING_PATHS);
    const isDocs = matcher([...DOCS_PATHS, ...(ci.docs_paths || [])]);
    const changed = [...new Set(i.changed || [])];
    const onFull = changed.find(isFull);
    if (onFull) return full(`on the full list: ${onFull}`);
    const rest = changed.filter((p) => !isBook(p));
    if (rest.length === 0) {
      return plan("none", changed.length ? "every changed path is bookkeeping (.ai/, plans/)" : "no changed path", { ...at, skipped: all.length, est_seconds: 0 });
    }
    const docsOnly = rest.every(isDocs);
    const fastSet = i.select({ suites: i.suites, tier: "fast" }).selected;
    const fastPlan = (reason) => plan("fast", reason, { ...at, suites: fastSet, skipped: all.length - fastSet.length, est_seconds: seconds(fastSet) });

    if (!i.censusTool) {
      return docsOnly ? fastPlan("docs-only change (no census in this project)") : full("a non-docs change and no census in this project");
    }
    if (i.baseline === "MISSING") return full("no tests/census-baseline.tsv to read footprints from");
    if (i.baseline === "STALE") return full("[CENSUS_BASELINE_STALE] the committed census baseline is stale");
    if (!i.census || !Array.isArray(i.census.suites)) return full("the census baseline could not be read");

    const known = new Set();
    for (const s of i.census.suites) for (const p of s.footprint || []) known.add(p);
    const suiteFiles = new Set(all.map((n) => `tests/suites/${n}`));
    // A unit test is run by the fast tier itself (the node unit bridge runs every tests/unit file),
    // so it is covered at any level that runs the fast tier — the census lists no footprint for it.
    const unitCovered = (p) => /^tests\/unit\//.test(p) && all.includes(UNIT_BRIDGE);
    const read = rest.filter((p) => known.has(p));
    if (docsOnly && read.length === 0) return fastPlan("docs-only change; no suite's footprint reads it");
    const unknown = rest.find((p) => !isDocs(p) && !known.has(p) && !suiteFiles.has(p) && !unitCovered(p));
    if (unknown) return full(`unknown to the census: ${unknown}`);

    const { selected } = i.select({ suites: i.suites, tier: "fast", changed: rest, census: i.census });
    if (selected.length * 2 > all.length) return full(`${selected.length} of ${all.length} suites selected — more than half`);
    const extra = selected.filter((s) => !fastSet.includes(s));
    const est = seconds(selected);
    return plan("affected", `${extra.length} suite(s) beyond the fast tier read the ${rest.length} changed path(s)`,
      { ...at, suites: selected, skipped: all.length - selected.length, est_seconds: est, shards: est < SHARD_SECONDS ? 1 : (ci.shards || 1) });
  } catch (e) {
    return plan("full", `${FALLBACK} ${String(e?.message || e).split("\n")[0].slice(0, 200)}`, { ...at, suites: (i.suites || []).map((s) => s.name) });
  }
}

const git = (root, ...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 }).trim();

/** The committed baseline's state for the planner: MISSING, or FRESH/STALE by full runs since it (ci-record.mjs). */
async function baselineState(root, headSha) {
  const text = existsSync(join(root, "tests", "census-baseline.tsv")) ? readFileSync(join(root, "tests", "census-baseline.tsv"), "utf8") : "";
  if (!text.split("\n").some((l) => l.startsWith("CENSUS_RUN\t"))) return "MISSING";
  // No local CI history means no full run since the baseline was written: fresh by definition.
  if (!existsSync(join(root, ".ai", "state.sqlite"))) return "FRESH";
  const { censusBaselineAge } = await import("./ci-record.mjs");
  const { getDbSeeded } = await import("../mcp/shared/state-db.js");
  const age = censusBaselineAge(getDbSeeded(join(root, ".ai")), root, headSha);
  return age ? age.state : "MISSING";
}

/**
 * Gather the inputs for base..head in `root` and decide. `opts.select` replaces the project's
 * selector (a test injects one that throws); `opts.event` picks the platforms.
 */
export async function ciPlan(root, base, head = "HEAD", opts = {}) {
  root = resolve(root);
  const at = { base: base || null, head: null, tree: null, event: opts.event };
  const suitesDir = join(root, "tests", "suites");
  let suites = [];
  try {
    suites = existsSync(suitesDir) ? readdirSync(suitesDir).filter((f) => f.endsWith(".sh")).sort()
      .map((name) => ({ name, text: readFileSync(join(suitesDir, name), "utf8") })) : [];
    // critic_security P2: a ref that starts with `-` would reach git as an option.
    if (String(head).startsWith("-")) throw new Error(`head ref ${JSON.stringify(String(head).slice(0, 40))} starts with '-'`);
    if (base && String(base).startsWith("-")) base = null;
    at.head = git(root, "rev-parse", "--verify", `${head}^{commit}`);
    at.tree = git(root, "rev-parse", `${at.head}^{tree}`);
    const shallow = git(root, "rev-parse", "--is-shallow-repository") === "true";
    let mergeBase = null;
    if (base) { try { mergeBase = git(root, "merge-base", base, at.head); } catch { mergeBase = null; } }
    at.base = mergeBase;
    const changed = [], subjects = [];
    if (mergeBase && !shallow) {
      for (const line of git(root, "diff", "--name-status", "-M", `${mergeBase}...${at.head}`).split("\n").filter(Boolean)) {
        changed.push(...line.split("\t").slice(1));
      }
      subjects.push(...git(root, "log", "--format=%s", `${mergeBase}..${at.head}`).split("\n").filter(Boolean));
    }
    let team = null;
    if (existsSync(join(root, ".ai", "team.json"))) {
      const { readTeam } = await import("../mcp/shared/team.mjs");
      team = readTeam(join(root, ".ai"));
    }
    const censusTool = existsSync(join(root, "tests", "tools", "census.mjs"));
    let select = opts.select;
    if (!select) {
      const sel = join(root, "tests", "tools", "select-suites.mjs");
      // A project without the selector has the full matrix and, at the fast tier, nothing.
      select = existsSync(sel) ? (await import(pathToFileURL(sel).href)).selectSuites
        : ({ suites: s, tier }) => ({ selected: tier === "fast" ? [] : s.map((x) => x.name) });
    }
    let census = null, baseline = "MISSING";
    if (censusTool) {
      baseline = await baselineState(root, at.head);
      if (baseline !== "MISSING") {
        const { buildCensus } = await import(pathToFileURL(join(root, "tests", "tools", "census.mjs")).href);
        census = buildCensus({ repo: root, ciLogs: join(root, ".no-ci-logs"), inputs: [join(root, "tests", "census-baseline.tsv")] });
      }
    }
    return planFromInputs({ ...at, changed, subjects, shallow, team, censusTool, baseline, census, suites, select });
  } catch (e) {
    return plan("full", `${FALLBACK} ${String(e?.message || e).split("\n")[0].slice(0, 200)}`, { ...at, suites: suites.map((s) => s.name) });
  }
}

/** The default base: the merge base with the trunk (origin/<trunk>, else <trunk>), or null. */
export async function defaultBase(root) {
  try {
    const { resolveTrunk } = await import("../mcp/shared/trunk.mjs");
    let team = null;
    try { const { readTeam } = await import("../mcp/shared/team.mjs"); team = readTeam(join(root, ".ai")); } catch { team = null; }
    const t = resolveTrunk(root, { team });
    if (!t.name) return null;
    for (const ref of [`origin/${t.name}`, t.name]) {
      try { git(root, "rev-parse", "--verify", `${ref}^{commit}`); return ref; } catch { /* next */ }
    }
  } catch { /* no trunk */ }
  return null;
}

function human(p) {
  return [`[ci] plan level=${p.level} reason=${p.reason}`,
    `     suites=${p.suites.length}/${p.suites.length + p.skipped} est_seconds=${p.est_seconds ?? "?"} shards=${p.shards} platforms=${p.platforms.join(",")}`,
    `     base=${p.base ? p.base.slice(0, 12) : "-"} head=${p.head ? p.head.slice(0, 12) : "-"} tree=${p.tree ? p.tree.slice(0, 12) : "-"}`].join("\n");
}

async function main(argv) {
  const o = { root: process.cwd(), base: null, head: "HEAD", json: false, event: "pull_request" };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k], v = argv[k + 1];
    if (a === "--json") o.json = true;
    else if ((a === "--base" || a === "--head" || a === "--root" || a === "--event") && v && !v.startsWith("--")) { o[a.slice(2)] = v; k++; }
    else { process.stderr.write(`rein ci plan: unknown argument '${a}'\nUsage: rein ci plan [--base <ref>] [--json]\n`); return 2; }
  }
  const base = o.base || await defaultBase(o.root);
  const p = await ciPlan(o.root, base, o.head, { event: o.event });
  process.stdout.write((o.json ? JSON.stringify(p) : human(p)) + "\n");
  return 0;
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2)).then((rc) => process.exit(rc));
