// role-verdict-cases.test.mjs — the Write/Edit path gate (`--check-path`) as a function of role ×
// path class (E-301, D-088, D-113). Contract table: tests/fixtures/role-verdict-cases.json, one row
// per (role, path) → verdict, run in process through pathAnalysis — the function the CLI calls.
// Carries pane_binding's E-208.05/.06/.08/.10/.11 path verdicts, E-294.05i2 (the union) and
// gate_override's E-291.05h (~/.ai-os/** for every role); the hook's tool-name branch, the
// claim gate, an unverified or re-minted token and the fault injection stay with their suites.
//
// Roles are the D-087 model: a verified `architect` or `engineer` token, or `none` — no verified
// token, which the gate answers as the union (the Architect's rules). Paths name a class:
// `<proj>/…` (a project with .ai/), `<home>/…` (HOME, holding the install root), `<outside>/…`
// (neither); a bare relative path resolves against the project, the cwd. The fixture project
// carries the traps the audit rows need, under the names the suites planted them with.
// The table is byte-pinned at landing (D-113): a changed verdict is a new ruling, not an edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repo } from "../lib/check-table.mjs";

const FILE = resolve(repo, "tests/fixtures/role-verdict-cases.json");
const SHA256 = "34182edf23ab0cfeb61c596f88625145786d6ce949f213d076905eaca5333d54";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aios-t-rv-")));
const proj = join(root, "proj"), home = join(root, "home"), outside = join(root, "outside");
const saved = { home: process.env.HOME, cwd: process.cwd() };
test.after(() => {
  process.chdir(saved.cwd);
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  rmSync(root, { recursive: true, force: true });
});
// The fixture's source file is a plain file named like the CLI; nothing here runs it (the
// fixture-home census reads the literal path as a loader, so it is spelt as segments).
const BIN = join("src", "bin", "ai");
for (const d of [".ai/blueprints", "plans", "src/bin", "src/__e208_deep", "tests"]) mkdirSync(join(proj, d), { recursive: true });
mkdirSync(join(home, ".ai-" + "os", "shared"), { recursive: true });
mkdirSync(outside);
for (const f of [BIN, "tests/run.sh", "ENGINEER.md", ".ai/DECISIONS.md"]) writeFileSync(join(proj, f), "x\n");
symlinkSync(join(proj, BIN), join(proj, ".ai/__e208_seclink"));
symlinkSync(join(proj, "src"), join(proj, ".ai/__e208_secdir"));
symlinkSync(join(proj, "src/__e208_deep"), join(proj, ".ai/__e208_d2"));
symlinkSync(outside, join(proj, ".ai/__e208_out"));
symlinkSync(join(proj, BIN), join(proj, ".ai/__e208_leaf"));
linkSync(join(proj, BIN), join(proj, ".ai/__e208_hl"));
process.env.HOME = home;
process.chdir(proj);
const { pathAnalysis } = await import(resolve(repo, "src/mcp/safe-exec-mcp/index.js"));

const bytes = readFileSync(FILE);
const rows = JSON.parse(bytes);
const pathOf = (p) => p.replace(/^<proj>/, proj).replace(/^<home>/, home).replace(/^<outside>/, outside);

test("role-verdict-cases.json is byte-pinned (D-113)", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SHA256);
});
test("every role answers both verdicts (the table cannot pass empty)", () => {
  for (const role of ["architect", "engineer", "none"]) {
    for (const want of ["pass", "BLOCK"]) assert.ok(rows.some((c) => c.role === role && c.want === want), `no ${role}/${want} row`);
  }
});
for (const c of rows) {
  test(`${c.role} ${c.want}: ${c.label}`, () => {
    let got, why = "";
    try {
      const v = pathAnalysis(pathOf(c.path), c.role === "engineer" ? "engineer" : "architect", { projectRoot: proj, home });
      got = v.blocked ? "BLOCK" : "pass";
      why = v.blocked ? `${v.id}: ${v.reason}` : "";
    } catch (e) {
      got = "BLOCK"; why = `THREW: ${e.message}`;   // the CLI fails closed
    }
    assert.equal(got, c.want, `${c.path} ${why}`);
  });
}
