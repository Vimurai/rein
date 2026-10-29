// ci-summary.mjs — read a test runner's own summary out of a suite step's output (E-310,
// D-091, test-economics.md §CI Resources Component 11). `ai ci run` used to read only the
// Rein runner's `Total: N passed, M failed` line, so a downstream project whose
// tests/run.sh drives vitest (a downstream project) recorded pass=0 on every green run.
//
//   node ci-summary.mjs <log> [--after "<marker line prefix>"]
//     → `runner=<r> pass=<n> fail=<n> skip=<n>` on stdout; `runner=none pass=0 fail=0 skip=0`
//       when nothing matched. Only the text after the LAST line starting with the marker is
//       read (ai ci passes its "[ci] ── suite:" header). The log is read as text and never
//       executed.
//
// Precedence: the Rein line, when present, IS the run's total (its runner already folds
// every suite in) — its last occurrence wins. Otherwise every vitest / node --test / pytest /
// jest summary in the section is SUMMED: one tests/run.sh may invoke a runner more than once
// (that project runs vitest twice), and each invocation prints its own summary.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Counts named in a "3 failed | 10 passed | 1 skipped" / "1 failed, 10 passed" list. */
function _counts(list) {
  const c = { pass: 0, fail: 0, skip: 0 };
  for (const m of list.matchAll(/(\d+)\s+(passed|failed|skipped|todo|pending)\b/g)) {
    const n = Number(m[1]);
    if (m[2] === "passed") c.pass += n;
    else if (m[2] === "failed") c.fail += n;
    else c.skip += n;   // skipped, todo, pending: tests that did not run
  }
  return c;
}

// One entry per runner: a line test and the counts it carries. Order is the report order.
const SHAPES = [
  // vitest:  "      Tests  3 failed | 2513 passed | 7 skipped (2523)"  (never "Test Files")
  { runner: "vitest", match: (l) => /^\s*Tests\s{2,}\d+\s+(passed|failed|skipped|todo)\b/.test(l) && /\(\d+\)\s*$/.test(l),
    counts: (l) => _counts(l) },
  // jest:    "Tests:       1 failed, 2 skipped, 10 passed, 13 total"
  { runner: "jest", match: (l) => /^\s*Tests:\s+.*\b\d+ total\b/.test(l), counts: (l) => _counts(l) },
  // pytest:  "==== 3 failed, 10 passed, 1 skipped, 2 warnings in 2.31s ====" (or the bare -q form)
  { runner: "pytest", match: (l) => /\b\d+ (passed|failed)\b.*\bin [\d.]+s\b/.test(l) && !/^\s*Tests[:\s]/.test(l),
    counts: (l) => _counts(l) },
];

// node --test prints its totals on separate lines: TAP "# pass 196" or spec "ℹ pass 196".
const NODE_TEST = /^\s*(?:#|ℹ)\s+(pass|fail|skipped|todo|cancelled)\s+(\d+)\s*$/;

/**
 * parseSummary(text) → { runner, pass, fail, skip } or null when no known summary is present.
 * `runner` is "rein", one of the SHAPES names / "node-test", or several joined by "+".
 */
export function parseSummary(text) {
  const lines = String(text).replace(ANSI, "").split("\n");

  let rein = null;
  for (const l of lines) {
    const m = l.match(/^\s*Total: (\d+) passed, (\d+) failed(?:, (\d+) skipped)?/);
    if (m) rein = { runner: "rein", pass: +m[1], fail: +m[2], skip: +(m[3] || 0) };
  }
  if (rein) return rein;

  const sum = { pass: 0, fail: 0, skip: 0 };
  const seen = [];
  const add = (runner, c) => {
    sum.pass += c.pass; sum.fail += c.fail; sum.skip += c.skip;
    if (!seen.includes(runner)) seen.push(runner);
  };
  let node = null;   // one node --test report = the consecutive "# pass/# fail/…" block
  const flushNode = () => { if (node) { add("node-test", node); node = null; } };
  for (const l of lines) {
    const n = l.match(NODE_TEST);
    if (n) {
      node = node || { pass: 0, fail: 0, skip: 0, keys: new Set() };
      if (node.keys.has(n[1])) { flushNode(); node = { pass: 0, fail: 0, skip: 0, keys: new Set() }; }
      node.keys.add(n[1]);
      if (n[1] === "pass") node.pass += +n[2];
      else if (n[1] === "fail") node.fail += +n[2];
      else if (n[1] !== "cancelled") node.skip += +n[2];
      else node.fail += +n[2];   // a cancelled test did not pass
      continue;
    }
    flushNode();
    const shape = SHAPES.find((s) => s.match(l));
    if (shape) add(shape.runner, shape.counts(l));
  }
  flushNode();
  if (!seen.length) return null;
  return { runner: seen.join("+"), ...sum };
}

/** The text after the LAST line that starts with `marker` (the whole text when absent). */
export function sectionAfter(text, marker) {
  if (!marker) return String(text);
  const lines = String(text).split("\n");
  let at = -1;
  lines.forEach((l, i) => { if (l.startsWith(marker)) at = i; });
  return at < 0 ? String(text) : lines.slice(at + 1).join("\n");
}

function _isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (_isMain()) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--after");
  const marker = i >= 0 ? args[i + 1] : null;
  const file = args.find((a, k) => !a.startsWith("--") && args[k - 1] !== "--after");
  let r = null;
  try { r = parseSummary(sectionAfter(readFileSync(file, "utf8"), marker)); } catch { r = null; }
  r = r || { runner: "none", pass: 0, fail: 0, skip: 0 };
  process.stdout.write(`runner=${r.runner} pass=${r.pass} fail=${r.fail} skip=${r.skip}\n`);
}
