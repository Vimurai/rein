// markdown-exec.test.mjs — E-224 (D-058 §3): which markdown lines are CODE. Moved from
// tests/suites/markdown_exec_test.sh (E-301, D-088: pure markdown-exec.mjs / traversal-policy.mjs
// belong in the unit layer); the rows and their ids are unchanged.
//
// `run_review` graded every added line alike, so the Architect's own D-057 prose in
// `.ai/DECISIONS.md` tripped a P0 — it QUOTES `join(req.path, "../")` as the example of what
// must stay blocking. The obvious fix, skipping `.md`, is the dangerous one: skill files carry
// `!`-prefixed lines the harness AUTO-EXECUTES at session start, and one of them resolved a
// helper cwd-relative (T-LOCATOR-001 — its carriers are locator_policy and skill_lines). So the
// rows run in BOTH directions: the prose that must stop blocking, beside the executable markdown
// that must keep blocking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { classifyDiffTraversal } = await import(resolve(repo, "src/shared/traversal-policy.mjs"));
const MDX = readFileSync(resolve(repo, "src/shared/markdown-exec.mjs"), "utf8");
const ORCH = readFileSync(resolve(repo, "src/mcp/orchestrator-mcp/index.js"), "utf8");

// The SHIPPED classifyDiffTraversal — the function run_review calls — against a synthetic
// one-file diff whose file IS the added content. → "<severity>|<proseExec>"
function review(file, content, strict = false) {
  const body = content.split("\n");
  const diff = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n` +
    `@@ -1,0 +1,${body.length} @@\n` + body.map((l) => "+" + l).join("\n") + "\n";
  const r = classifyDiffTraversal(diff, { strict, readFile: () => body.join("\n") });
  return `${r.traversal?.severity ?? "none"}|${r.proseExec.join(",")}`;
}
// The file→verdict rows (E-224.01–.09) are a table: tests/fixtures/markdown-exec-cases.json.
// JSON, because the review gate's traversal check reads every `../` in a source file as code
// and JSON values as data (E-55). A row passes when the review contains `want`.
const cases = JSON.parse(readFileSync(resolve(repo, "tests/fixtures/markdown-exec-cases.json"), "utf8"));
test("the table carries every verdict (it cannot pass empty)", () => {
  for (const want of ["P0|", "P1|", "none|"]) assert.ok(cases.some((c) => c.want === want), want);
});
for (const c of cases) {
  test(c.label, () => { const got = review(c.file, c.content, c.strict); assert.ok(got.includes(c.want), `got ${got}`); });
}
// What only the source can show: run_review emits the !-line as a P0, and the generated-record
// allowlist is exact-path, not by extension.
test("E-224.05c: run_review emits it as a P0 FAIL", () => assert.match(ORCH, /EXECUTABLE_IN_PROSE/));
test("E-224.08c: the allowlist is exact-path, not by extension", () =>
  assert.ok(MDX.includes('GENERATED_RECORDS = new Set([".ai/state.json"])')));
