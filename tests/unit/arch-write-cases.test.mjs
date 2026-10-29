// arch-write-cases.test.mjs — the Architect's shell write policy (E-216, D-055 R1), in process
// (E-301, D-088). Replaces architect_write_gate's E-216.11 spawn driver (tests/lib/arch-write-cases.mjs):
// the same table, answered by runAnalysis (the function `--check` calls), a row's role defaulting to
// architect as the driver's did. The spawn path is probed once for it in safe_exec_test.
// D-056: the table is the frozen contract — the byte pin moved here from E-294.11y.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gateInProcess, repo, tableTests } from "../lib/check-table.mjs";

const SHA256 = "26f7da12faaf12c305b284e3af99b4dd41115d6ad3ba760b3ef6705d444f0a77";

test("arch-write-cases.json is byte-identical to the E-216 contract (D-056)", () => {
  const bytes = readFileSync(resolve(repo, "tests/fixtures/arch-write-cases.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA256);
});

const { runAnalysis } = await gateInProcess();
tableTests(runAnalysis, "arch-write", { role: "architect" });
