// tests/unit/mutation-report.test.mjs — node:test unit suite for tests/tools/mutation/report.mjs
// (E-300, D-088). New: no existing test covers the probe; it extends nothing.
//
// The report is what P-44 deletes and adds table rows on, so its two classifications are pinned
// against a fixture pass-A/pass-B pair whose answer is known by construction: a gate mutant the
// TABLES kill is detected (not a missing row), one they execute and do not kill survived (even
// when no unit test covered it), one they never execute has no coverage; both are MISSING table
// rows, a non-gate survivor never is; a unit test file whose ids kill nothing is a deletion
// candidate.
//
// Run standalone: node --test tests/unit/mutation-report.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPORT = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "mutation", "report.mjs");
const at = (line) => ({ start: { line, column: 1 }, end: { line, column: 2 } });

test("gate survivors split by the tables' verdict; kill-nothing test files are listed", () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "rein-t-mutreport-")));
  try {
    const passA = {
      testFiles: {
        "tests/unit/a.test.mjs": { tests: [{ id: "0", name: "tests/unit/a.test.mjs" }] },
        "tests/unit/idle.test.mjs": { tests: [{ id: "1", name: "tests/unit/idle.test.mjs" }] },
      },
      files: {
        "src/shared/x.mjs": { mutants: [
          { id: "1", status: "Killed", killedBy: ["0"], coveredBy: ["0", "1"], location: at(1), mutatorName: "M", replacement: "a" },
          { id: "2", status: "Survived", coveredBy: ["0"], location: at(2), mutatorName: "M", replacement: "b" },
        ] },
        "src/mcp/safe-exec-mcp/index.js": { mutants: [
          { id: "3", status: "NoCoverage", location: at(10), mutatorName: "M", replacement: "c" },
          { id: "4", status: "Survived", location: at(11), mutatorName: "M", replacement: "d" },
          { id: "5", status: "Timeout", location: at(12), mutatorName: "M", replacement: "e" },
          { id: "6", status: "NoCoverage", location: at(13), mutatorName: "M", replacement: "f" },
          { id: "7", status: "NoCoverage", location: at(14), mutatorName: "M", replacement: "g" },
        ] },
      },
    };
    const passB = { tables: ["secret"], results: [
      { file: "src/mcp/safe-exec-mcp/index.js", id: "3", status: "Killed", reason: "table secret failed", killedBy: "secret" },
      { file: "src/mcp/safe-exec-mcp/index.js", id: "4", status: "Survived", reason: "every table passed", killedBy: null },
      { file: "src/mcp/safe-exec-mcp/index.js", id: "6", status: "Survived", reason: "every table passed", killedBy: null },
      { file: "src/mcp/safe-exec-mcp/index.js", id: "7", status: "Survived", reason: "no table executes it", killedBy: null },
    ] };
    writeFileSync(join(d, "a.json"), JSON.stringify(passA));
    writeFileSync(join(d, "b.json"), JSON.stringify(passB));
    const md = execFileSync("node", [REPORT, join(d, "a.json"), join(d, "b.json"), join(d, "out.json"), "abc1234"], { encoding: "utf8" });
    const r = JSON.parse(readFileSync(join(d, "out.json"), "utf8"));

    const gate = r.modules.find((m) => m.gate);
    // id 6: unit NoCoverage, but a table executed it and passed → survived, not "no coverage".
    assert.deepEqual([gate.killed_unit, gate.killed_tables, gate.survived, gate.no_coverage], [1, 1, 2, 1]);
    assert.equal(gate.score, 40);
    assert.equal(r.modules.find((m) => !m.gate).score, 50);

    assert.deepEqual(r.survivors.map((s) => [s.line, s.missing_table_row, s.table_executed]),
      [[11, true, true], [13, true, true], [14, true, false], [2, false, null]]);
    assert.equal(r.missing_table_rows, 3);

    assert.deepEqual(r.kill_nothing, ["tests/unit/idle.test.mjs"]);
    assert.match(md, /src\/mcp\/safe-exec-mcp\/index\.js:11 \(1\)/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
