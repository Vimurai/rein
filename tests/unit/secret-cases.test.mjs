// secret-cases.test.mjs — SECRET_IN_COMMAND's contract table (E-287, D-078/D-080), in process
// (E-301, D-088). Replaces safe_exec_test's spawn-driver run (one `--check` per case through
// tests/lib/secret-cases.mjs, which the mutation probe still uses). Carries E-287.01-03: every row
// both ways, the over-block ratio printed and zero, at least 45 rows, the scan budget on 80 KB of
// prose, and fail-closed above SCAN_LIMIT.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { analyse, commandOf, gateInProcess, repo, tableTests } from "../lib/check-table.mjs";

const { runAnalysis } = await gateInProcess();
const rows = tableTests(runAnalysis, "secret");
const { containsSecret, SCAN_LIMIT } = await import(resolve(repo, "src/mcp/safe-exec-mcp/secret-rule.mjs"));

test("E-287.02/03: the over-block ratio is printed and zero; the table is not vacuous", () => {
  const allow = rows.filter((c) => c.want === "pass");
  const over = allow.filter((c) => analyse(runAnalysis, commandOf(c), c.role || "engineer").verdict === "BLOCK");
  console.log(`  OVER_BLOCK_RATIO ${over.length}/${allow.length}  CASES ${rows.length}`);
  assert.equal(over.length, 0);
  assert.ok(rows.length >= 45, `${rows.length} rows`);
});

// Rule 2 of the harness: the absolute 100 ms applies under CI=true; elsewhere it moves with a
// same-run baseline.
const msOf = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
test("E-287.01: 80 KB of keyword-brushing prose is scanned inside the budget and not flagged", () => {
  const big = "token usage secret santa password policy a_ api-key docs ".repeat(1400);
  const base = msOf(() => containsSecret("token usage ".repeat(100)));
  const budget = process.env.CI === "true" ? 100 : 100 + 50 * base;
  let hit;
  const ms = msOf(() => { hit = containsSecret(big); });
  console.log(`  BUDGET ${ms.toFixed(1)} ms for ${big.length} chars (budget ${budget.toFixed(1)}, baseline ${base.toFixed(2)})`);
  assert.equal(hit, false);
  assert.ok(ms < budget, `${ms.toFixed(1)} ms ≥ ${budget.toFixed(1)} ms`);
});

test("E-287.01: an input above SCAN_LIMIT fails closed without being scanned", () => {
  assert.equal(containsSecret("x".repeat(SCAN_LIMIT + 1)), true);
});
