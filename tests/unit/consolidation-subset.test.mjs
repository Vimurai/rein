// consolidation-subset.test.mjs — the wave-1 subset proof (E-301, D-113; test-economics.md
// §Consolidation Map "Wave 1 proof"). Every (mode, input, verdict) the 24 pre-wave gate sources
// sent to safe-exec — recorded once through an instrumented throwaway worktree (tests/tools/
// README.md, "Recording a wave's gate inputs") — is a row of tests/fixtures/wave1-inputs.json,
// classed:
//   table              pure: the row exists in a post-wave table its mode maps to, matched on the
//                      normalised input and the verdict (the recording carries no role, so any
//                      role's row with that input and verdict matches);
//   boundary:<suite>   context-bound (an active override, the claim gate, a token that does not
//                      verify, fault injection, argv): the carrier is a kept suite that exists
//                      post-wave and still contains the input; its own assertion keeps the verdict.
// The two classes partition the set; an unclassed row fails. Paths are normalised to
// `<proj>/…`, `<home>/…`, `<outside>/…`; a boundary carrier is searched for the input with that
// placeholder prefix stripped (the suite spells the root as its own fixture variable).
//
// Mode map (D-113, as amended on the Engineer's note of 2026-10-28): arch-write's rows are
// `--check` commands, so it is read for `--check`; `--check-path` is role-verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (n) => JSON.parse(readFileSync(resolve(repo, "tests/fixtures", n), "utf8"));
const MODE_TABLES = {
  "--check": ["block-rules", "operand-scope", "secret", "pipe-shell", "gate-self-disable", "gate-relative-home", "arch-write"],
  "--check-path": ["role-verdict"],
};
const fenced = (file, n) => [...readFileSync(resolve(repo, file), "utf8").matchAll(/```\n([\s\S]*?)\n```/g)][n - 1]?.[1];
const inputOf = (c) => (c.cmd_from ? fenced(c.cmd_from.file, c.cmd_from.block) : (c.cmd ?? c.path)?.repeat?.(c.repeat ?? 1));

const carried = {};
for (const [mode, tables] of Object.entries(MODE_TABLES)) {
  carried[mode] = new Set();
  for (const t of tables) {
    for (const c of fixture(`${t}-cases.json`)) {
      const x = inputOf(c);
      if (x != null) carried[mode].add(JSON.stringify([x, c.want === "BLOCK" ? "BLOCK" : "pass"]));
    }
  }
}
// A recorded input that is a verbatim fenced block a table already cites by reference (cmd_from)
// is cited the same way here (`input_from`), not copied: the block lives outside the grep roots.
const rows = fixture("wave1-inputs.json").map((r) => (r.input_from ? { ...r, input: fenced(r.input_from.file, r.input_from.block) } : r));

test("the recorded set is whole: 443 triples, both modes, both verdicts", () => {
  assert.equal(rows.length, 443);
  for (const mode of Object.keys(MODE_TABLES)) {
    for (const v of ["BLOCK", "pass"]) assert.ok(rows.some((r) => r.mode === mode && r.verdict === v), `${mode} ${v}`);
  }
  assert.equal(new Set(rows.map((r) => JSON.stringify([r.mode, r.input, r.verdict]))).size, rows.length, "a duplicate row");
});

test("the classes partition the set: table or boundary:<suite> with a context, nothing else", () => {
  for (const r of rows) {
    assert.equal(typeof r.input, "string", `no input: ${JSON.stringify(r.input_from)}`);
    assert.ok(r.class === "table" || /^boundary:[a-z0-9_]+$/.test(r.class), `unclassed: ${JSON.stringify(r)}`);
    if (r.class !== "table") assert.ok(r.context, `boundary without a context: ${r.input}`);
  }
});

for (const r of rows.filter((x) => x.class === "table")) {
  test(`table ${r.mode} ${r.verdict}: ${r.input.slice(0, 80)}`, () => {
    assert.ok(carried[r.mode].has(JSON.stringify([r.input, r.verdict])),
      `no ${MODE_TABLES[r.mode].join("/")} row carries it (from ${r.from.join(", ")})`);
  });
}

for (const r of rows.filter((x) => x.class !== "table")) {
  const suite = r.class.slice("boundary:".length);
  test(`boundary ${suite} (${r.context}) ${r.mode} ${r.verdict}: ${r.input}`, () => {
    const file = resolve(repo, "tests/suites", `${suite}_test.sh`);
    assert.ok(existsSync(file), `carrier ${suite}_test.sh does not exist post-wave`);
    const needle = r.input.replace(/^<(proj|home|outside)>\//, "");
    assert.ok(readFileSync(file, "utf8").includes(needle), `${suite}_test.sh no longer contains ${needle}`);
  });
}
