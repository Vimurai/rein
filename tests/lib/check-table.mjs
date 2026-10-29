// check-table.mjs — run a safe-exec contract table in process with `--check`'s semantics
// (E-301, D-088 r9, test-economics.md §Consolidation Map: "a table runs in process, once, in its
// unit runner"). Shared by the unit runners of the --check tables, so the setup the spawn driver
// (tests/lib/secret-cases.mjs) did per case lives once:
//   - a throwaway HOME holding an install root, set BEFORE the gate is imported (rule 6);
//   - the cwd is the repository, as the suite's `cd "$REPO"` was;
//   - a row's role is its `role`, else the table's default (the drivers ran as a verified
//     Engineer, so "engineer"); "none" is the advisory tool's no-caller_role call;
//   - `cmd_from: {file, block}` is the Nth ``` fenced block of a repo file (E-292); a missing
//     block FAILS, never skips;
//   - verdict BLOCK when runAnalysis says BLOCK or throws (the CLI fails closed, exit 2).
// The spawn path itself is probed once per table, in safe_exec_test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function gateInProcess() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "aios-t-ctab-")));
  mkdirSync(join(home, ".ai-" + "os"), { recursive: true });
  const saved = { home: process.env.HOME, cwd: process.cwd() };
  process.env.HOME = home;
  process.chdir(repo);
  test.after(() => {
    process.chdir(saved.cwd);
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    rmSync(home, { recursive: true, force: true });
  });
  const { runAnalysis } = await import(resolve(repo, "src/mcp/safe-exec-mcp/index.js"));
  return { runAnalysis, home };
}

export const loadTable = (name) => JSON.parse(readFileSync(resolve(repo, "tests/fixtures", `${name}-cases.json`), "utf8"));

const fenced = (file, n) => {
  const blocks = [...readFileSync(resolve(repo, file), "utf8").matchAll(/```\n([\s\S]*?)\n```/g)];
  if (!blocks[n - 1]) throw new Error(`${file} has no fenced block ${n}`);
  return blocks[n - 1][1];
};
export const commandOf = (c) => (c.cmd_from ? fenced(c.cmd_from.file, c.cmd_from.block) : c.cmd);

export function analyse(runAnalysis, cmd, role) {
  try {
    const r = runAnalysis(cmd, role === "none" ? undefined : role);
    return { verdict: r.verdict === "BLOCK" ? "BLOCK" : "pass", ids: [...r.blocked, ...r.warned, ...r.sovereignty].map((x) => x.id) };
  } catch (e) {
    return { verdict: "BLOCK", ids: [`THREW: ${e.message}`] };
  }
}

/** One test per row: the verdict, plus `rule` (must fire) / `not_rule` (must not) when given. */
export function tableTests(runAnalysis, name, { role = "engineer" } = {}) {
  const rows = loadTable(name);
  test(`${name}: the table has both verdicts (it cannot pass empty)`, () => {
    assert.ok(rows.some((c) => c.want === "BLOCK") && rows.some((c) => c.want === "pass"));
  });
  for (const c of rows) {
    const r = c.role || role;
    test(`${name} ${r} ${c.want}: ${c.label}`, () => {
      const got = analyse(runAnalysis, commandOf(c), r);
      const why = `rules: ${got.ids.join(", ") || "(none)"}`;
      assert.equal(got.verdict, c.want, why);
      if (c.rule) assert.ok(got.ids.includes(c.rule), `${c.rule} did not fire — ${why}`);
      if (c.not_rule) assert.ok(!got.ids.includes(c.not_rule), `${c.not_rule} fired — ${why}`);
    });
  }
  return rows;
}
