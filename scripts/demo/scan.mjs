// scan.mjs — the demo cast through the privacy gate (D-139, demo-video.md §Component 4).
// Runs the commit gate's own check (precommitProblems) on <cast> as if it were staged at
// docs/assets/demo.cast, with this repository's lists, so a clean scan here is the verdict the
// pre-commit hook will give. Prints each finding (class and line, never the value); exit 1 on
// any finding, 0 when clean.
//   node scripts/demo/scan.mjs <cast> [repo root]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { precommitProblems } from "../../src/shared/publish-scan.mjs";

const [cast, rootArg] = process.argv.slice(2);
if (!cast) { console.error("usage: scan.mjs <cast> [repo root]"); process.exit(2); }
const root = resolve(rootArg || process.cwd());
const AS = "docs/assets/demo.cast";
const buf = readFileSync(cast);
// Identity is not this scan's business (the commit gate checks it on the commit itself): only
// the content classes count.
const hits = precommitProblems(root, {
  files: [AS],
  read: (f) => (f === AS ? buf : readFileSync(resolve(root, f))),
}).filter((p) => p.startsWith("[PUBLISH_SCAN_HIT]"));
for (const h of hits) console.error(h);
if (hits.length) {
  console.error(`[DEMO_SCAN_HIT] ${hits.length} finding(s) in the cast — fix the cause and re-record; never edit the cast`);
  process.exit(1);
}
console.log(`[DEMO_SCAN_OK] ${cast.replace(process.env.HOME || "\0", "~")}`);
