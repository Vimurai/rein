// select-suites.test.mjs — the runner's tier and change selection (E-298, D-088), tested as the
// pure function it is. tests/run.sh only prints what selectSuites returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSuites, UNIT_BRIDGE } from "../tools/select-suites.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

// E-384 (D-135 addendum r2): extends the no-census test above — a fresh clone has no
// ~/.ai-os/ci census, so the CLI reads the committed tests/census-baseline.tsv's footprints.
test("CLI --changed with no local census selects by the committed baseline, and says so", (t) => {
  const r = mkdtempSync(join(tmpdir(), "aios-t-select-"));
  t.after(() => rmSync(r, { recursive: true, force: true }));
  const put = (p, body) => { mkdirSync(dirname(join(r, p)), { recursive: true }); writeFileSync(join(r, p), body); };
  put("src/shared/x.mjs", "export const x = 1;\n");
  put("src/shared/y.mjs", "export const y = 1;\n");
  for (const n of ["x_test.sh", "y_test.sh", UNIT_BRIDGE]) put(`tests/suites/${n}`, "#!/usr/bin/env bash\n");
  put("tests/census-baseline.tsv", "# census-baseline\nCENSUS_RUN\t2026-10-29T00:00:00Z\tabc\t*_test.sh\n" +
    "CENSUS_SUITE\tx_test.sh\t100\t1\t0\t0\t0\nCENSUS_SUITE\ty_test.sh\t100\t1\t0\t0\t0\n" +
    "CENSUS_FP\tx_test.sh\t2\tnode\tsrc/shared/x.mjs\nCENSUS_FP\ty_test.sh\t2\tnode\tsrc/shared/y.mjs\n");
  const g = (...a) => execFileSync("git", ["-C", r, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
  g("init", "-q"); g("add", "-A"); g("commit", "-qm", "seed");
  put("src/shared/x.mjs", "export const x = 2;\n");
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "select-suites.mjs");
  const out = execFileSync("node", ["--no-warnings", cli, "--suites-dir", join(r, "tests", "suites"), "--tier", "fast", "--changed", "HEAD"],
    { encoding: "utf8", env: { ...process.env, HOME: join(r, "no-home") } });
  const picked = out.split("\n").filter((l) => l.endsWith(".sh")).map((l) => l.split("/").pop());
  assert.deepEqual(picked, [UNIT_BRIDGE, "x_test.sh"], "the suite whose footprint changed, not y");
  assert.match(out, /#NOTE --changed: footprints from the committed tests\/census-baseline\.tsv/);
});
