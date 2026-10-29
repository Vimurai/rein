#!/usr/bin/env node
// shard-plan.mjs — E-386 (D-135 r3, .ai/blueprints/ci-throughput.md §Component 3): which suites
// one shard of a run takes. tests/run.sh calls it; the partition is a pure function (shardPlan)
// so it is tested in tests/unit, not through the runner.
//
//   node tests/tools/shard-plan.mjs --shard i/N [--hints <wall-hints.tsv>] [--pin <suite>]… [--seed <suite>] < classes
// stdin: one "<suite>\t<shared|exclusive>" line per suite of the run (the runner's lane classes).
// --hints: "<suite>\t<wall_ms>" lines (the runner's wall-hints.tsv); the last value per suite wins.
// stdout: the suites of shard i, one per line, then "#SHARD <shared> <exclusive> <est_seconds>".
// Exit 0; 2 on bad arguments.
//
// Rules: shared and exclusive suites are partitioned separately (a shard's exclusive phase is
// serial, its shared phase runs in lanes — their loads do not add); each class sorted by hint
// descending, then name, and assigned greedily to the lightest bin (ties → the lowest index).
// A suite with no hint counts as the median of the known hints (30 s when none is known). A
// pinned suite (the node unit layer) goes to shard 1 before the greedy pass, in its own class.
// E-389 (D-135 addendum 2 r4): --seed <suite> starts bin 1's shared load at that suite's hint —
// `rein ci run` runs the unit layer once more on shard 1 (its coverage step), serially, so the
// greedy pass must see shard 1 as already that much heavier. With no hint known at all the
// seed is 0 and the partition is exactly the unseeded one.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UNKNOWN_HINT_MS = 30000;   // tests/run.sh _wall_hint's default, when nothing is known

/** "i/N" → { i, n }, or null when it is not 1 ≤ i ≤ N. */
export function parseShard(spec) {
  const m = String(spec ?? "").match(/^([1-9][0-9]*)\/([1-9][0-9]*)$/);
  if (!m) return null;
  const i = Number(m[1]), n = Number(m[2]);
  return i <= n ? { i, n } : null;
}

function _median(values) {
  if (!values.length) return UNKNOWN_HINT_MS;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Pure partition. `suites`: [{ name, cls: "shared"|"exclusive" }]; `hints`: Map name → ms;
 * `pin`: names forced into shard 1. Returns N bins, index 0 = shard 1:
 * [{ shared: [names], exclusive: [names], shared_ms, exclusive_ms }]. Every suite lands in
 * exactly one bin; the same inputs give the same bins on every host.
 */
export function shardPlan({ suites, n, hints = new Map(), pin = [], seed = null }) {
  if (!Number.isInteger(n) || n < 1) throw new Error("shardPlan: n must be a positive integer");
  const names = new Set();
  for (const s of suites) {
    if (names.has(s.name)) throw new Error(`shardPlan: suite ${s.name} listed twice`);
    names.add(s.name);
  }
  const known = suites.map((s) => hints.get(s.name)).filter((v) => Number.isFinite(v) && v >= 0);
  const median = _median(known);
  const hintOf = (name) => (Number.isFinite(hints.get(name)) && hints.get(name) >= 0 ? hints.get(name) : median);
  const bins = Array.from({ length: n }, () => ({ shared: [], exclusive: [], shared_ms: 0, exclusive_ms: 0, seed_ms: 0 }));
  if (seed && known.length) { bins[0].seed_ms = hintOf(seed); bins[0].shared_ms = bins[0].seed_ms; }
  const pinned = new Set(pin);
  for (const cls of ["shared", "exclusive"]) {
    const of = suites.filter((s) => s.cls === cls);
    for (const s of of.filter((s) => pinned.has(s.name))) {
      bins[0][cls].push(s.name); bins[0][`${cls}_ms`] += hintOf(s.name);
    }
    const rest = of.filter((s) => !pinned.has(s.name))
      .sort((a, b) => hintOf(b.name) - hintOf(a.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const s of rest) {
      let best = 0;
      for (let k = 1; k < n; k++) if (bins[k][`${cls}_ms`] < bins[best][`${cls}_ms`]) best = k;
      bins[best][cls].push(s.name); bins[best][`${cls}_ms`] += hintOf(s.name);
    }
  }
  return bins;
}

function main(argv) {
  let spec = null, hintsFile = null, seed = null;
  const pin = [];
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === "--shard") spec = argv[++k];
    else if (argv[k] === "--hints") hintsFile = argv[++k];
    else if (argv[k] === "--pin") pin.push(argv[++k]);
    else if (argv[k] === "--seed") seed = argv[++k];
    else { process.stderr.write(`shard-plan: unknown argument '${argv[k]}'\n`); return 2; }
  }
  const sh = parseShard(spec);
  if (!sh) { process.stderr.write("shard-plan: --shard needs i/N with 1 ≤ i ≤ N\n"); return 2; }
  const hints = new Map();
  if (hintsFile) {
    let text = "";
    try { text = readFileSync(hintsFile, "utf8"); } catch { /* no hints: every suite is the median */ }
    for (const line of text.split("\n")) {
      const [name, ms] = line.split("\t");
      if (name && /^[0-9]+$/.test(ms || "")) hints.set(name, Number(ms));
    }
  }
  const suites = readFileSync(0, "utf8").split("\n").filter(Boolean).map((line) => {
    const [name, cls] = line.split("\t");
    return { name, cls: cls === "exclusive" ? "exclusive" : "shared" };
  });
  const bin = shardPlan({ suites, n: sh.n, hints, pin, seed })[sh.i - 1];
  // The shared phase runs in lanes, the exclusive one serially: the estimate is their sum at
  // one lane, an upper bound the run's own Lanes: line then improves on.
  const est = Math.round((bin.shared_ms + bin.exclusive_ms) / 1000);
  process.stdout.write([...bin.shared, ...bin.exclusive, `#SHARD ${bin.shared.length} ${bin.exclusive.length} ${est}`].join("\n") + "\n");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
