// gate-self-disable-cases.test.mjs — GATE_SELF_DISABLE (`ai gate`, the override file, a write
// under the install root) as one contract table, run in process (E-301, D-088, test-economics.md
// §Consolidation Map). The rows were gate_override's E-291.05f/g loops, one `--check` spawn each;
// the spawn path is probed once for this table in safe_exec_test. Extends gate-guard-home.test.mjs
// (the HOME-relative forms) — together they are the whole rule.
//
// The verdict needs a HOME and a cwd, as `--check` has: a throwaway HOME holding an install root,
// and a project directory as the cwd. Frozen at landing (D-089 r5): the sha256 is pinned below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TABLE = resolve(repo, "tests/fixtures/gate-self-disable-cases.json");
const SHA256 = "960a01f72f6c45c66d17417165df2895f425d2a9c081da05955128c587cc08d5";

const home = realpathSync(mkdtempSync(join(tmpdir(), "rein-t-gsd-")));
mkdirSync(join(home, ".ai-" + "os", "hooks"), { recursive: true });
mkdirSync(join(home, "proj"), { recursive: true });
const savedHome = process.env.HOME;
const savedCwd = process.cwd();
process.env.HOME = home;
process.chdir(join(home, "proj"));
const { runAnalysis } = await import(resolve(repo, "src/mcp/safe-exec-mcp/index.js"));

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

for (const c of cases) {
  test(`${c.role} ${c.want}: ${c.label} — ${c.cmd}`, () => {
    const r = runAnalysis(c.cmd, c.role);
    const ids = [...r.blocked.map((x) => x.id), ...r.sovereignty.map((x) => x.id)];
    assert.equal(r.verdict === "BLOCK" ? "BLOCK" : "pass", c.want, `rules: ${ids.join(", ") || "(none)"}`);
    if (c.want === "BLOCK") assert.ok(ids.includes("GATE_SELF_DISABLE"), `blocked, but not by GATE_SELF_DISABLE: ${ids}`);
  });
}
