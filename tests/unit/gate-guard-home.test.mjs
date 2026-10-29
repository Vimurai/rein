// gate-guard-home.test.mjs — GATE_SELF_DISABLE for the install root named RELATIVE to HOME,
// where the answer depends on the gate's cwd and on HOME itself (E-294, critic_security P1-2
// second pass). Host-independent cases live in tests/fixtures/gate-relative-home-cases.json,
// driven through the real --check gate by safe_exec_test; THESE cases need a known HOME and cwd,
// so they run in-process (selfDisableHits is a pure function of the text, HOME and the cwd).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const M = ".ai-" + "os"; // the mirror's name, assembled so this file's text names no write into it

const home = realpathSync(mkdtempSync(join(tmpdir(), "aios-t-ggh-")));
const deep = join(home, "a", "b", "c");
mkdirSync(join(home, M), { recursive: true });
mkdirSync(deep, { recursive: true });
const savedHome = process.env.HOME;
const savedCwd = process.cwd();
process.env.HOME = home;      // os.homedir() follows HOME on POSIX
process.chdir(deep);
const { selfDisableHits } = await import("../../src/mcp/safe-exec-mcp/gate-guard.mjs");
const blocks = (cmd) => selfDisableHits(cmd).length > 0;

test.after(() => {
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

test("cd .. chain that resolves to HOME, then a relative write → BLOCK", () => {
  assert.equal(blocks(`cd ../../.. && rm ${M}/run/launch/1.json`), true);
});

test("cd to HOME's parent, then <home basename>/<mirror> → BLOCK", () => {
  assert.equal(blocks(`cd ${dirname(home)} && rm ${basename(home)}/${M}/run/launch/1.json`), true);
});

test("../../.. relative path with no cd at all → BLOCK", () => {
  assert.equal(blocks(`rm ../../../${M}/run/launch/1.json`), true);
});

test("cd .. chain that stops SHORT of HOME → pass (another directory)", () => {
  assert.equal(blocks(`cd ../.. && rm ${M}/x`), false);
});

test("a read after resolving to HOME → pass", () => {
  assert.equal(blocks(`cd ../../.. && cat ${M}/VERSION`), false);
});

test("a cd that resolves to HOME, then a sibling with a longer name → pass", () => {
  assert.equal(blocks(`cd ../../.. && rm ${M}-cache/x`), false);
});
