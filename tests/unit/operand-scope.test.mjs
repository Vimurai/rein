// operand-scope.test.mjs — RM_RF_ROOT ignores a safe leading `cd <dir>`, and the Architect
// sovereignty rules skip an inert heredoc body when every later line is provably read-only
// (E-340, finding 6). Contract table: tests/fixtures/operand-scope-cases.json, one row per
// (command, role) → verdict, run in-process via runAnalysis — the function the --check gate
// itself calls. Extends the whole-line cases the gate tables already pin (arch-write, and the
// E-216 / E-102 / E-123 rows below: every existing row keeps its verdict); the over-blocks of
// 2026-10-23 are rows by reference to tests/fixtures/operand-scope-verbatim.md. Rows marked
// "(not narrowed)" pin what E-340 deliberately leaves on the whole-line match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { runAnalysis } = await import(resolve(repo, "src/mcp/safe-exec-mcp/index.js"));
const { stripInertHeredocs, readOnlyLine } = await import(resolve(repo, "src/mcp/safe-exec-mcp/heredoc.mjs"));
const { boundedRel } = await import(resolve(repo, "src/mcp/safe-exec-mcp/architect-writes.mjs"));
const cases = JSON.parse(readFileSync(resolve(repo, "tests/fixtures/operand-scope-cases.json"), "utf8"));

const fenced = (file, n) => {
  const blocks = [...readFileSync(resolve(repo, file), "utf8").matchAll(/```\n([\s\S]*?)\n```/g)];
  assert.ok(blocks[n - 1], `${file} has no fenced block ${n}`);
  return blocks[n - 1][1];
};

test("the table covers both roles and both verdicts (it cannot pass empty)", () => {
  for (const role of ["engineer", "architect"]) {
    for (const want of ["pass", "BLOCK"]) {
      assert.ok(cases.some((c) => c.role === role && c.want === want), `no ${role}/${want} row`);
    }
  }
});

for (const c of cases) {
  test(`${c.role} ${c.want}: ${c.label}`, () => {
    // E-351: `repeat` builds an over-cap input without a 64 KB row; `message` is the exact block
    // line the hook prints (the report carries it unchanged).
    const cmd = c.cmd_from ? fenced(c.cmd_from.file, c.cmd_from.block) : c.cmd.repeat(c.repeat ?? 1);
    // E-301: role "none" is the advisory tool's call without a caller_role; `rule` must fire and
    // `not_rule` must not (the E-123 rows name the rule, not only the verdict).
    const r = runAnalysis(cmd, c.role === "none" ? undefined : c.role);
    const got = r.verdict === "BLOCK" ? "BLOCK" : "pass";
    const ids = [...r.blocked, ...r.warned, ...r.sovereignty].map((x) => x.id);
    const why = ids.join(", ");
    assert.equal(got, c.want, `${c.label}\n  rules: ${why || "(none)"}`);
    if (c.rule) assert.ok(ids.includes(c.rule), `${c.label}: ${c.rule} did not fire — ${why}`);
    if (c.not_rule) assert.ok(!ids.includes(c.not_rule), `${c.label}: ${c.not_rule} fired — ${why}`);
    if (c.message) {
      assert.ok(r.blocked.some((x) => x.message === c.message), `${c.label}\n  got: ${r.blocked.map((x) => x.message).join(" | ")}`);
      assert.ok(r.report.includes(c.message), `${c.label}: the report does not carry the line`);
    }
  });
}

// The relaxation is opt-in: the three content rules (D-085 r1) keep the strict strip, and the
// D-105 body stays scanned for them. Non-vacuity for the D-105 rows: the body really names pushing.
test("the D-105 body is stripped only under the read-only relaxation", () => {
  const cmd = fenced("tests/fixtures/operand-scope-verbatim.md", 2);
  assert.ok(cmd.includes("git push"), "the verbatim body names pushing");
  assert.ok(stripInertHeredocs(cmd).includes("git push"), "the strict strip keeps it (content rules)");
  const relaxed = stripInertHeredocs(cmd, { readOnlyLines: true });
  assert.ok(!relaxed.includes("git push"), "the relaxed strip removes it (sovereignty rules)");
  assert.ok(relaxed.includes('echo "appended'), "and the trailing line is kept and scanned");
});

// readOnlyLine is an allowlist: anything it does not model is "not read-only" (= scanned as before).
const RO = [
  [`echo "appended; D count: $(grep -c '^## D-' .ai/DECISIONS.md)"; tail -3 .ai/DECISIONS.md | head -1`, true],
  ["test -f x && echo ok", true],
  ["grep -c x f || true", true],
  ["bash .ai/x", false],
  ["echo hi > .ai/x", false],
  ["$b .ai/x", false],
  ["echo $(bash x)", false],
  ['echo "$(sh x)"', false],
  ["grep x f | sh", false],
  ["cat f &", false],
  ["echo `x`", false],
  ["echo $((1+2))", false],
  ["( ls )", false],
  ["{ ls; }", false],
  ['echo "a\\"b"', false],
  ["ls; ", false],
  ["'ls' x", false],
];
for (const [line, want] of RO) {
  test(`readOnlyLine ${want ? "accepts" : "refuses"}: ${line}`, () => assert.equal(readOnlyLine(line), want));
}

// E-350 (D-111 r6 iv): the tokenizer is quadratic in tokens, so a 50k-group line took ~100 s and
// relied on the hook's timeout. Past the cap the analyzer refuses before tokenizing.
// D-137 r5 (E-399): the budget is a linear-time tripwire, not an SLA — the same-run baseline form
// on every host (a slower runner gets proportionally more headroom, rule 1: no host-conditional
// budget), and 1000 ms, the denial-of-service bound for a 50k-group input, caps it everywhere.
const msOf = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
const CEILING_MS = 1000;
const budgetOf = (base) => 200 + 20 * base;
const assertInside = (ms, budget, label) => {
  assert.ok(ms < budget, `${label}: ${ms.toFixed(1)} ms ≥ ${budget.toFixed(1)} ms (baseline-relative)`);
  assert.ok(ms < CEILING_MS, `${label}: ${ms.toFixed(1)} ms ≥ the ${CEILING_MS} ms ceiling`);
};
test("a 50k-group input is refused [INPUT_TOO_LARGE] inside the budget, for every role", () => {
  const base = msOf(() => runAnalysis("true; ".repeat(50), "engineer"));
  const budget = budgetOf(base);
  for (const [shape, unit] of [["{ :; }", "{ :; } "], ["$( : )", "echo $( : ); "], ["true;", "true; "], ["words", "a "],
    ["a< (one word, redirections split it)", "a<"], ["one 100k-char word", "ab"]]) {
    for (const role of ["engineer", "architect"]) {
      let r;
      const ms = msOf(() => { r = runAnalysis(unit.repeat(50000), role); });
      console.log(`  ${shape} ×50k ${role}: ${ms.toFixed(1)} ms (budget ${budget.toFixed(1)}, baseline ${base.toFixed(2)})`);
      assert.equal(r.verdict, "BLOCK");
      assert.ok(r.blocked.some((b) => b.id === "INPUT_TOO_LARGE"), `${shape}: rules ${r.blocked.map((b) => b.id)}`);
      assertInside(ms, budget, `${shape} ${role}`);
    }
  }
});
test("…and an operator override does not lift it (nothing was analysed)", () => {
  const r = runAnalysis("true; ".repeat(50000), "engineer", { override: true });
  assert.ok(r.blocked.some((b) => b.id === "INPUT_TOO_LARGE"));
});
test("…while a long ordinary command below the cap is still analysed, not refused", () => {
  const r = runAnalysis("echo a && echo b; ".repeat(300), "engineer");
  assert.equal(r.verdict, "PASS");
});

// E-397: the inputs CodeQL cites against the regexes the git-redirect rules and the write-path
// trim used (js/redos, js/polynomial-redos), below the cap so they are analysed: same verdict,
// inside the 50k test's budget. The other spellings are the table's E-350 (iii) rows.
test("CodeQL's pathological git and path inputs keep their verdict and stay inside the budget", () => {
  const base = msOf(() => runAnalysis("true; ".repeat(50), "engineer"));
  const budget = budgetOf(base);
  for (const [cmd, rule] of [["git " + "-C -! ".repeat(400) + "--git-dir=x status", "ARCH_GIT_DIR_OVERRIDE"],
    ["GIT_CONFIG_KEY_0=" + "(GIT_CONFIG_KEY_0=".repeat(400) + "core.hooksPath git status", "ARCH_GIT_HOOKS_PATH"]]) {
    let r;
    const ms = msOf(() => { r = runAnalysis(cmd, "architect"); });
    console.log(`  ${rule}: ${ms.toFixed(1)} ms (budget ${budget.toFixed(1)}, baseline ${base.toFixed(2)})`);
    assert.equal(r.verdict, "BLOCK");
    assert.ok(r.sovereignty.some((b) => b.id === rule), `rules ${r.sovereignty.map((b) => b.id)}`);
    assertInside(ms, budget, rule);
  }
  const ms = msOf(() => boundedRel(".ai/" + "/".repeat(50000) + "x", repo));
  assertInside(ms, budget, "trailing-separator trim");
});
