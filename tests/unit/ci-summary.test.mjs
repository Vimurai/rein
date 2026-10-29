// tests/unit/ci-summary.test.mjs — the suite-step summary parser (E-310, D-091).
//
// One runner over the contract table tests/fixtures/ci-summary-cases.json: one row per
// summary shape (Rein, vitest, node --test TAP and spec, pytest, jest), including the
// downstream-project vitest log shape that `rein ci run` recorded as pass=0 before E-310. Extends nothing:
// the old parser was a bash sed in src/bin/rein with no test of its own.
//
// Run standalone: node --test tests/unit/ci-summary.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseSummary, sectionAfter } from "../../src/shared/ci-summary.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CASES = JSON.parse(readFileSync(join(REPO, "tests", "fixtures", "ci-summary-cases.json"), "utf8"));

test("the table has a row for every runner shape", () => {
  const runners = new Set(CASES.map((c) => c.want?.runner).filter(Boolean).flatMap((r) => r.split("+")));
  for (const r of ["rein", "vitest", "node-test", "pytest", "jest"]) assert.ok(runners.has(r), `no row for ${r}`);
});

for (const c of CASES) {
  test(c.label, () => assert.deepEqual(parseSummary(c.log), c.want));
}

test("sectionAfter reads only the text after the LAST marker line", () => {
  const text = "   Total: 1 passed, 0 failed\n[ci] ── suite: x\nold\n[ci] ── suite: y\n      Tests  4 passed (4)\n";
  assert.deepEqual(parseSummary(sectionAfter(text, "[ci] ── suite:")), { runner: "vitest", pass: 4, fail: 0, skip: 0 });
  assert.equal(sectionAfter("a\nb", "[ci] none"), "a\nb", "no marker → the whole text");
});

test("CLI: one key=value line, runner=none when nothing matched", () => {
  const d = mkdtempSync(join(tmpdir(), "rein-t-cisum-"));
  try {
    const f = join(d, "run.log");
    const cli = join(REPO, "src", "shared", "ci-summary.mjs");
    writeFileSync(f, "[ci] ── deps\n   Total: 9 passed, 9 failed\n[ci] ── suite: /bin/bash tests/run.sh\n Tests:       2 passed, 2 total\n");
    let r = spawnSync(process.execPath, [cli, f, "--after", "[ci] ── suite:"], { encoding: "utf8" });
    assert.equal(r.stdout, "runner=jest pass=2 fail=0 skip=0\n");
    writeFileSync(f, "nothing here\n");
    r = spawnSync(process.execPath, [cli, f], { encoding: "utf8" });
    assert.equal(r.stdout, "runner=none pass=0 fail=0 skip=0\n");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
