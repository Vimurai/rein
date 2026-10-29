#!/usr/bin/env node
// standards-rule-check.mjs — report whether the E-225 skill-locator rule flags a file.
// Drives the SHIPPED checker so the suite and the pre-commit gate run the same code.
// Usage: standards-rule-check.mjs <repoRoot> <relPath>
import { validateFile, loadStandards } from "../../src/shared/standards-checker.mjs";
import { join } from "node:path";

const parsed = loadStandards();
const rules = Array.isArray(parsed) ? parsed : parsed.rules;
const [, , root, rel] = process.argv;
let r;
try {
  r = validateFile(join(root, rel), rules, { repoRoot: root });
} catch (e) {
  // A throwing handler previously surfaced as "not clean", i.e. indistinguishable from a
  // catch — which made a crashing rule read as a working one across an entire matrix.
  process.stdout.write(`ERROR ${e.message.slice(0, 80)}`);
  process.exit(2);
}
const hits = r.violated_rules.filter((v) => v.rule_id === "skill_locator_install_first");
process.stdout.write(hits.length ? `FLAGGED ${hits.map((h) => h.line).join(",")}` : "clean");
