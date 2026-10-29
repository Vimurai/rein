// select-suites.test.mjs — the runner's tier and change selection (E-298, D-088), tested as the
// pure function it is. tests/run.sh only prints what selectSuites returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSuites, UNIT_BRIDGE } from "../tools/select-suites.mjs";

const S = (name, text = "") => ({ name, text });
const suites = [
  S("alpha_test.sh"),
  S("arch_gate_test.sh", 'node tests/lib/x.mjs "${R}/tests/fixtures/arch-write-cases.json"'),
  S(UNIT_BRIDGE),
  S("gate_test.sh"),
  S("telemetry_test.sh"),
  S("orphan_test.sh"),
];
const census = { suites: [
  { name: "gate", file: "tests/suites/gate_test.sh", footprint: ["src/mcp/safe-exec-mcp/index.js", "hooks/pre-tool-use.sh"] },
  { name: "telemetry", file: "tests/suites/telemetry_test.sh", footprint: ["src/shared/telemetry.mjs"] },
  { name: "alpha", file: "tests/suites/alpha_test.sh", footprint: [] },
] };

test("full (default) is today's matrix: every suite, unchanged order", () => {
  assert.deepEqual(selectSuites({ suites }).selected, suites.map((s) => s.name));
});

test("full honours an explicit pattern exactly like find -name", () => {
  assert.deepEqual(selectSuites({ suites, pattern: "gate_*" }).selected, ["gate_test.sh"]);
});

test("fast = the unit bridge + every contract-table suite, nothing else", () => {
  assert.deepEqual(selectSuites({ suites, tier: "fast" }).selected, ["arch_gate_test.sh", UNIT_BRIDGE]);
});

test("--changed on a safe-exec file selects the gate suite + fast, nothing unrelated", () => {
  const r = selectSuites({ suites, tier: "fast", changed: ["src/mcp/safe-exec-mcp/index.js"], census });
  assert.deepEqual(r.selected, ["arch_gate_test.sh", UNIT_BRIDGE, "gate_test.sh"]);
});

test("--changed selects a suite whose own file changed", () => {
  const r = selectSuites({ suites, changed: ["tests/suites/orphan_test.sh"], census });
  assert.ok(r.selected.includes("orphan_test.sh"));
});

test("--changed never selects a suite with no footprint entry (unknown ⇒ full only) and says so", () => {
  const r = selectSuites({ suites, changed: ["src/anything.mjs"], census });
  assert.ok(!r.selected.includes("orphan_test.sh"));
  assert.ok(!r.selected.includes("alpha_test.sh"));   // an EMPTY footprint is no evidence either
  assert.match(r.notes.join("\n"), /no census footprint and run in the full tier only/);
});

test("--changed with no census falls back to the FULL matrix and says so", () => {
  const r = selectSuites({ suites, changed: ["src/x.mjs"], census: null });
  assert.deepEqual(r.selected, suites.map((s) => s.name));
  assert.match(r.notes.join("\n"), /no census file — running the FULL matrix/);
});

test("a suite missing from the census is never dropped from full", () => {
  assert.ok(selectSuites({ suites, census }).selected.includes("orphan_test.sh"));
});
