// gate-self-disable-cases.test.mjs — GATE_SELF_DISABLE (`rein gate`, the override file, a write
// under the install root) as one contract table, run in process (E-301, D-088, test-economics.md
// §Consolidation Map). The rows were gate_override's E-291.05f/g loops, one `--check` spawn each;
// the spawn path is probed once for this table in safe_exec_test. Extends gate-guard-home.test.mjs
// (the HOME-relative forms) — together they are the whole rule.
//
// The verdict needs a HOME and a cwd, as `--check` has: a throwaway HOME holding an install root,
// and a project directory as the cwd. Frozen at landing (D-089 r5): the sha256 is pinned below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tcFixtureHome } from "../lib/toolchain-fixture.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TABLE = resolve(repo, "tests/fixtures/gate-self-disable-cases.json");
// E-383 (D-132): re-pinned for the rename (rows name the new install root; pre-rename rows
// added). The D-089 r5 pin moves only by ruling — the D-ruling that closes E-383 ratifies it.
// E-393 (D-163 r10, addendum 1): re-pinned again, 29 → 225 rows (179 BLOCK, 46 pass). The lock is
// the three-word predicate (namesGateOff); every round-1 and round-2 security payload is a row with
// the verdict D-163 gives it; 11 PASS rows marked `residual` (r3; three are D-084 rule 4 implicit-run sinks); two r9 flips (PASS → BLOCK: commit
// messages naming rein, gate and off). Old 63c2cac95f95…, new below.
const SHA256 = "80ab99d0495180464e5612f07ecd9aee4c7487518df32962ff71dd9a86afdcb5";

const home = realpathSync(mkdtempSync(join(tmpdir(), "rein-t-gsd-")));
mkdirSync(join(home, ".re" + "in", "hooks"), { recursive: true });
mkdirSync(join(home, "proj"), { recursive: true });
tcFixtureHome(home);   // D-109 r1: the record the install writes (this file reads the hook's fallback predicate)
const savedHome = process.env.HOME;
const savedCwd = process.cwd();
process.env.HOME = home;
process.chdir(join(home, "proj"));
const { runAnalysis } = await import(resolve(repo, "src/mcp/safe-exec-mcp/index.js"));
const { namesGateOff } = await import(resolve(repo, "src/shared/shell-word.mjs"));

test.after(() => {
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const raw = readFileSync(TABLE);
const cases = JSON.parse(raw);

test("the table is byte-pinned (D-089 r5: the rule is frozen; a change is a D-ruling)", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"), SHA256);
});

test("the table has both verdicts (it cannot pass empty)", () => {
  assert.ok(cases.some((c) => c.want === "BLOCK") && cases.some((c) => c.want === "pass"));
});

// D-163 r1: the hook's no-verdict fallback (`_names_gate_off`, hooks/pre-tool-use.sh) is the same
// definition as namesGateOff — checked on every row's raw text in ONE bash process (the analyzer
// applies the inert-heredoc strip first; the fallback cannot, so both are compared on the raw text).
// Moved here from gate_override_test, which a table reference had pulled into the fast tier.
test("the hook fallback and namesGateOff agree on every row", () => {
  const hook = readFileSync(resolve(repo, "hooks/pre-tool-use.sh"), "utf8");
  const fn = /^_names_gate_off\(\) \{\n[\s\S]*?\n\}\n/m.exec(hook)?.[0];
  assert.ok(fn, "_names_gate_off not found in the hook");
  const script = fn + 'while IFS= read -r -d "" c; do if _names_gate_off "$c"; then echo 1; else echo 0; fi; done\n';
  const r = spawnSync("/bin/bash", ["-c", script], { input: cases.map((c) => c.cmd + "\0").join(""), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const got = r.stdout.trim().split("\n");
  assert.equal(got.length, cases.length, "one answer per row");
  const differs = cases.filter((c, i) => (namesGateOff(c.cmd) ? "1" : "0") !== got[i]).map((c) => c.cmd.slice(0, 80));
  assert.deepEqual(differs, [], `bash and JS disagree on ${differs.length} row(s)`);
});

for (const c of cases) {
  test(`${c.role} ${c.want}: ${c.label} — ${c.cmd}`, () => {
    const r = runAnalysis(c.cmd, c.role);
    const ids = [...r.blocked.map((x) => x.id), ...r.sovereignty.map((x) => x.id)];
    assert.equal(r.verdict === "BLOCK" ? "BLOCK" : "pass", c.want, `rules: ${ids.join(", ") || "(none)"}`);
    if (c.want === "BLOCK") assert.ok(ids.includes("GATE_SELF_DISABLE"), `blocked, but not by GATE_SELF_DISABLE: ${ids}`);
  });
}
