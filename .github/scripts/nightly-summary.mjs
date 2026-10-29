#!/usr/bin/env node
// nightly-summary.mjs — the Nightly workflow's job summary (E-384, D-133, public-ci.md
// §Component 2; the drift rule is D-118 r1, ci-budget.js budgetDrift — reused, not copied).
//
//   node .github/scripts/nightly-summary.mjs <logs dir> <history file>
// Reads every `ai ci run` log under <logs dir> (the matrix artefacts), takes the UNSHARDED
// leg's `[ci] budget` line (a shard's budget has no full_seconds), compares it with the last
// five lines in <history file> and prints markdown on stdout; then appends the line to the
// history, keeping five. Information only: exit 0 whatever it finds.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseBudgetLine, DRIFT_FIELDS, DRIFT_PCT } from "../../src/mcp/shared/ci-budget.js";

const [logsDir, historyFile] = process.argv.slice(2);
const logs = [];
const walk = (d) => {
  let ents = [];
  try { ents = readdirSync(d); } catch { return; }
  for (const e of ents) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith(".log")) logs.push(readFileSync(p, "utf8"));
  }
};
walk(logsDir);

const out = ["## Nightly", ""];
const legs = logs.map((t) => ({
  shard: (t.match(/^\[ci\] shard (\S+)$/m) || [])[1] || null,
  os: (t.match(/^\[ci\] toolchain .* os=(.*)$/m) || [])[1] || "?",
  node: (t.match(/^\[ci\] toolchain node=(\S+)/m) || [])[1] || "?",
  result: (t.match(/^\[ci\] result (.*)$/m) || [])[1] || "",
  resources: (t.match(/^\[ci\] resources (.*)$/m) || [])[1] || "",
  budget: t.split("\n").filter((l) => l.startsWith("[ci] budget ")).pop() || null,
}));
out.push("| leg | node | os | result | resources |", "|---|---|---|---|---|");
for (const l of legs) out.push(`| ${l.shard || "full"} | ${l.node} | ${l.os} | ${l.result} | ${l.resources} |`);
const skips = legs.reduce((n, l) => n + Number((l.result.match(/ skip=(\d+)/) || [])[1] || 0), 0);
out.push("", `Skipped assertions across the legs: ${skips} (one-commit-checkout skips shrink as history grows — D-129 addendum r5).`, "");

const full = legs.find((l) => !l.shard && l.budget);
let history = [];
try { history = readFileSync(historyFile, "utf8").split("\n").filter(Boolean); } catch { /* the first nightly */ }
if (!full) {
  out.push("No unsharded leg with a budget line — no drift measured tonight.");
} else {
  const now = parseBudgetLine(full.budget);
  out.push(`Budget (unsharded leg): \`${full.budget.replace(/^\[ci\] budget /, "")}\``);
  const prior = history.slice(-5).map(parseBudgetLine);
  if (prior.length < 5) {
    out.push(`Drift: ${prior.length} earlier nightly line(s) recorded — the median-of-5 comparison starts at five.`);
  } else {
    let drift = 0;
    for (const f of DRIFT_FIELDS) {
      const vals = prior.map((b) => b[f]).filter(Number.isFinite).sort((a, b) => a - b);
      if (vals.length < 5 || !Number.isFinite(now[f])) continue;
      const median = vals[2];
      if (median > 0 && now[f] > median * (1 + DRIFT_PCT)) {
        out.push(`[BUDGET_DRIFT] ${f} ${now[f]} vs median-of-5 ${median} (+${Math.round((now[f] / median - 1) * 100)}%)`);
        drift++;
      }
    }
    if (!drift) out.push("Drift: none (every recorded field within +25 % of the median of the last five nightlies).");
  }
  history = [...history, full.budget].slice(-5);
  mkdirSync(dirname(historyFile), { recursive: true });
  writeFileSync(historyFile, `${history.join("\n")}\n`);
}
process.stdout.write(`${out.join("\n")}\n`);
