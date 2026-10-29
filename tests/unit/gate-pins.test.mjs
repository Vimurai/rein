// gate-pins.test.mjs — E-305 (D-089 r3): the gate path's dependencies are pinned exactly, the
// install must hold exactly them, and the pinned parser's view of the redirect shapes the
// Architect write gate depends on is recorded (b36a818's two-parser-generation regression pin).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "shell-quote";
import { checkPins, gatePins, GATE_SERVERS } from "../../src/shared/gate-pins.mjs";
import { analyzeArchitectWrites } from "../../src/mcp/safe-exec-mcp/architect-writes.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "aios-t-pins-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function fixtureMcp(name, deps, installed) {
  const mcp = join(tmp, name, "mcp");
  mkdirSync(join(mcp, "safe-exec-mcp"), { recursive: true });
  writeFileSync(join(mcp, "safe-exec-mcp", "package.json"), JSON.stringify({ dependencies: deps }));
  for (const [pkg, ver] of Object.entries(installed)) {
    const d = join(mcp, "safe-exec-mcp", "node_modules", pkg);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: pkg, version: ver }));
  }
  return mcp;
}

test("the repo's gate servers carry exact versions only (no ^ or ~)", () => {
  for (const server of GATE_SERVERS) {
    const deps = JSON.parse(readFileSync(join(REPO, "src", "mcp", server, "package.json"), "utf8")).dependencies;
    for (const [pkg, spec] of Object.entries(deps)) assert.match(spec, /^\d+\.\d+\.\d+/, `${server}: ${pkg}@${spec}`);
    assert.doesNotMatch(JSON.stringify(deps), /"[\^~*]/);
  }
});

test("installed == pinned passes", () => {
  const mcp = fixtureMcp("ok", { "shell-quote": "1.8.3" }, { "shell-quote": "1.8.3" });
  assert.deepEqual(checkPins(mcp).map((r) => r.ok), [true]);
});

test("a tampered installed version is a mismatch the installer refuses", () => {
  const mcp = fixtureMcp("bad", { "shell-quote": "1.8.3" }, { "shell-quote": "1.12.0" });
  const [r] = checkPins(mcp);
  assert.equal(r.ok, false);
  assert.equal(r.installed, "1.12.0");
});

test("a missing dependency is a mismatch too", () => {
  const mcp = fixtureMcp("missing", { "shell-quote": "1.8.3" }, {});
  assert.equal(checkPins(mcp)[0].installed, null);
});

test("a RANGE in a gate server's package.json is refused outright", () => {
  const mcp = fixtureMcp("range", { "shell-quote": "^1.8.1" }, { "shell-quote": "1.8.3" });
  assert.throws(() => gatePins(mcp), /must be an exact version/);
});

// ── the two-parser-generation regression pin (b36a818) ───────────────────────────────────
test("the pinned parser's tokens for the redirect shapes are the recorded ones", () => {
  // shell-quote 1.8.3 splits `&>` and `>|`; >= 1.10 returns them as ONE operator. A bump that
  // changes these shapes must come with the gate's contract tables re-run (mcp-servers rule).
  assert.deepEqual(parse("echo x &> f"), ["echo", "x", { op: "&" }, { op: ">" }, "f"]);
  assert.deepEqual(parse("echo x >| f"), ["echo", "x", { op: ">" }, { op: "|" }, "f"]);
});

test("the Architect write gate blocks every redirect shape into src/ (either parser generation)", () => {
  for (const c of ["echo x &> src/x", "echo x >| src/x", "echo x &>> src/x", "echo x > src/x", "echo x >> src/x"]) {
    assert.ok(analyzeArchitectWrites(c.split(/\s+/), c).length > 0, c);
  }
  for (const c of ["echo x &> .ai/x", "make 2>&1 | tail", "ls 2>/dev/null"]) {
    assert.equal(analyzeArchitectWrites(c.split(/\s+/), c).length, 0, c);
  }
});
