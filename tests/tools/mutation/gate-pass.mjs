#!/usr/bin/env node
// gate-pass.mjs — E-300 (D-088 §Component 5) pass B. The unit layer (pass A) is not the gate's
// contract: the gate is pinned by its contract tables (tests/fixtures/*-cases.json). A gate
// mutant that survives pass A is re-tested here against those tables; one that survives both is
// a MISSING contract-table row.
//
// 1. One coverage run of the tables (NODE_V8_COVERAGE, child processes included) decides which
//    gate offsets the tables EXECUTE. A mutant no table executes survives without a run.
// 2. Every executed survivor is applied as text to a private sandbox copy of src/ and the tables
//    run against it (gate-tables.sh, first failing table wins), N workers in parallel —
//    in-process (inproc-tables.mjs) except for index.js's CLI glue, cross-checked against the
//    spawn path on the first AIOS_MUTATION_CROSSCHECK mutants (default 20).
//
// Usage: node gate-pass.mjs <pass-a.json> <out.json> <workdir>   (HOME must be throwaway —
// probe.sh sets it; AIOS_MUTATION_CONCURRENCY workers, default 4)
// Read-only over the repo: every write is under <workdir> or <out.json>.

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE_DIR = "src/mcp/safe-exec-mcp/";
const TABLES = join(REPO, "tests/tools/mutation/gate-tables.sh");
const MUTANT_DEADLINE_MS = 600_000;
const INPROC_DEADLINE_MS = 120_000;

const [, , passA, outFile, work] = process.argv;
if (!passA || !outFile || !work) {
  process.stderr.write("usage: gate-pass.mjs <pass-a.json> <out.json> <workdir>\n");
  process.exit(2);
}
if (!process.env.AIOS_MUTATION_HOME_OK || process.env.HOME === userInfo().homedir) {
  process.stderr.write("gate-pass.mjs: run through probe.sh (throwaway HOME, never the real one)\n");
  process.exit(2);
}

// Offsets from 1-based line/column (mutation-testing-report-schema).
const lineStarts = (src) => {
  const s = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") s.push(i + 1);
  return s;
};
const offset = (starts, { line, column }) => starts[line - 1] + column - 1;

const sandbox = (name) => {
  const root = join(work, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(REPO, "src"), join(root, "src"), {
    recursive: true,
    filter: (p) => !p.includes("/node_modules"),
  });
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  return root;
};

// Each run is its own process group (so a deadline kills the whole table run); an interrupt to
// this process must reach them too, or they would outlive it until their deadline.
const groups = new Set();
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch {} }
    process.exit(130);
  });
}
const run = (cmd, args, env, deadline) =>
  new Promise((done) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"], detached: true });
    groups.add(p.pid);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const t = setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch {} }, deadline);
    p.on("close", (code, signal) => { clearTimeout(t); groups.delete(p.pid); done({ code, signal, out }); });
  });

const workerHome = (name) => {
  const h = join(work, `home-${name}`);
  rmSync(h, { recursive: true, force: true });
  mkdirSync(join(h, ".ai-os"), { recursive: true });
  return h;
};

// ── 1. Which gate offsets do the tables execute? ────────────────────────────────────────────
const report = JSON.parse(readFileSync(passA, "utf8"));
const candidates = [];
for (const [file, entry] of Object.entries(report.files)) {
  if (!file.startsWith(GATE_DIR)) continue;
  for (const m of entry.mutants) {
    if (m.status === "Survived" || m.status === "NoCoverage") candidates.push({ file, m });
  }
}
process.stderr.write(`gate-pass: ${candidates.length} gate mutant(s) survived pass A\n`);

const covRoot = sandbox("cov");
const covDir = join(work, "v8cov");
rmSync(covDir, { recursive: true, force: true });
mkdirSync(covDir, { recursive: true });
const base = await run("bash", [TABLES, join(covRoot, GATE_DIR, "index.js"), "--all"],
  { HOME: workerHome("cov"), NODE_V8_COVERAGE: covDir }, MUTANT_DEADLINE_MS);
if (base.code !== 0) {
  process.stderr.write(`gate-pass: the UNMUTATED tables fail (${base.out.trim()}) — no verdict possible\n`);
  process.exit(1);
}

// url → one range list PER PROCESS. Within a process V8 nests block ranges inside function
// ranges, so a position's count is its innermost containing range's; a position is executed
// when ANY process executed it.
const ranges = new Map();
const gateUrl = pathToFileURL(join(covRoot, GATE_DIR)).href;
for (const f of readdirSync(covDir)) {
  for (const s of JSON.parse(readFileSync(join(covDir, f), "utf8")).result || []) {
    if (!s.url.startsWith(gateUrl)) continue;
    const perProcess = ranges.get(s.url) || [];
    perProcess.push(s.functions.flatMap((fn) => fn.ranges));
    ranges.set(s.url, perProcess);
  }
}
const innermost = (list, off) => {
  let best = null;
  for (const r of list) {
    if (r.startOffset > off || r.endOffset <= off) continue;
    if (!best || r.endOffset - r.startOffset < best.endOffset - best.startOffset) best = r;
  }
  return best;
};
const executed = (file, off) =>
  (ranges.get(pathToFileURL(join(covRoot, file)).href) || []).some((list) => (innermost(list, off)?.count || 0) > 0);

const sources = new Map();
const src = (file) => {
  if (!sources.has(file)) {
    const text = readFileSync(join(REPO, file), "utf8");
    sources.set(file, { text, starts: lineStarts(text) });
  }
  return sources.get(file);
};

const results = [];
const queue = [];
for (const c of candidates) {
  const { starts } = src(c.file);
  const at = offset(starts, c.m.location.start);
  if (executed(c.file, at)) queue.push(c);
  else results.push({ file: c.file, id: c.m.id, status: "Survived", reason: "no table executes it", killedBy: null });
}
process.stderr.write(`gate-pass: ${queue.length} executed by a table → testing; ${results.length} unexecuted\n`);

// ── 2. Test every executed survivor against the tables ──────────────────────────────────────
// In-process (inproc-tables.mjs) unless the mutant sits in index.js's CLI glue (from
// _gateFlags on), which only a real `--check` process exercises. The first CROSSCHECK
// in-process mutants also run the spawn path; any disagreement is reported and recorded.
const INDEX = `${GATE_DIR}index.js`;
const EXPORT = "\nexport { runAnalysis as __probeRunAnalysis };\n";
const cliLine = src(INDEX).text.split("\n").findIndex((l) => l.startsWith("function _gateFlags")) + 1;
if (cliLine < 1) { process.stderr.write("gate-pass: _gateFlags not found in index.js\n"); process.exit(1); }
const spawnOnly = (file, m) => file === INDEX && m.location.start.line >= cliLine;
const N = Number(process.env.AIOS_MUTATION_CONCURRENCY || 4);
let crossLeft = Number(process.env.AIOS_MUTATION_CROSSCHECK ?? 20);
const disagreements = [];
const verdictOf = (r) => (r.signal ? "Timeout" : r.code === 0 ? "Survived" : "Killed");
let next = 0, doneCount = 0;
const worker = async (w) => {
  const root = sandbox(`w${w}`);
  const indexText = (t) => t + EXPORT;
  writeFileSync(join(root, INDEX), indexText(src(INDEX).text));
  const home = workerHome(`w${w}`);
  const tables = (mode) => run("bash", [TABLES, join(root, INDEX), ...(mode === "inproc" ? ["--inproc"] : [])],
    { HOME: home }, mode === "inproc" ? INPROC_DEADLINE_MS : MUTANT_DEADLINE_MS);
  while (next < queue.length) {
    const { file, m } = queue[next++];
    const { text, starts } = src(file);
    const a = offset(starts, m.location.start), b = offset(starts, m.location.end);
    const mutated = text.slice(0, a) + m.replacement + text.slice(b);
    const target = join(root, file);
    writeFileSync(target, file === INDEX ? indexText(mutated) : mutated);
    const mode = spawnOnly(file, m) ? "spawn" : "inproc";
    const r = await tables(mode);
    if (mode === "inproc" && crossLeft > 0) {
      crossLeft--;
      const s = await tables("spawn");
      if (verdictOf(s) !== verdictOf(r)) disagreements.push({ file, id: m.id, inproc: verdictOf(r), spawn: verdictOf(s) });
    }
    writeFileSync(target, file === INDEX ? indexText(text) : text);
    const killer = (r.out.match(/^(\S+) FAIL$/m) || [])[1] || null;
    results.push({
      file, id: m.id, mode,
      status: verdictOf(r),
      reason: r.signal ? "deadline" : r.code === 0 ? "every table passed" : `table ${killer || "?"} failed`,
      killedBy: killer,
    });
    doneCount++;
    if (doneCount % 50 === 0) process.stderr.write(`gate-pass: ${doneCount}/${queue.length}\n`);
  }
};
await Promise.all(Array.from({ length: N }, (_, i) => worker(i)));
process.stderr.write(`gate-pass: cross-check ${disagreements.length} disagreement(s)\n`);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ tables: ["secret", "pipe-shell", "gate-relative-home", "arch-write"], disagreements, results }, null, 2));
process.stderr.write(`gate-pass: wrote ${outFile}\n`);
