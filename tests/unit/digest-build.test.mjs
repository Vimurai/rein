// digest-build.test.mjs — E-429 (D-159; harness-fitness.md §Component 1): the digest builder.
// New file: no test covered .ai/DIGEST.md before (the model-written skill had no test). The rows
// live in tests/fixtures/digest-cases.json; this file only builds each fixture project and runs
// the CLI steps. Needs `git` on PATH (a tag and a commit per fixture); SKIPPED without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, readlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILDER = join(repo, "src/shared/digest-build.mjs");
const { base, rows } = JSON.parse(readFileSync(join(repo, "tests/fixtures/digest-cases.json"), "utf8"));
const hasGit = spawnSync("git", ["--version"]).status === 0;

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};
const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { env: gitEnv, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

function makeProject(root, row) {
  const p = { ...base, ...(row.project || {}) };
  const state = structuredClone(base.state);
  for (let i = 0; i < (p.manyArchitect || 0); i++) {
    state.tasks.push({ id: `P-${100 + i}`, owner: "Architect (Claude)", status: "OPEN", tier: 2, description: `Open fixture task ${i}`, created_at: "2026-01-03T10:00:00Z", completed_at: null, summary: null });
  }
  mkdirSync(join(root, ".ai"), { recursive: true });
  writeFileSync(join(root, ".ai/state.json"), p.stateRaw ?? `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(join(root, ".ai/DECISIONS.md"), `# DECISIONS\n\n${p.decisions.map((h) => `${h}\nbody text\n`).join("\n")}`);
  writeFileSync(join(root, ".ai/BRIEF.md"), p.brief);
  writeFileSync(join(root, "package.json"), `${JSON.stringify(p.package, null, 2)}\n`);
  if (p.digestSymlink) {
    writeFileSync(join(root, "elsewhere.md"), "not the digest\n");
    symlinkSync(join(root, "elsewhere.md"), join(root, ".ai/DIGEST.md"));
  }
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  if (p.tag) git(root, "tag", p.tag);
}

function run(dir, cmd) {
  const r = spawnSync(process.execPath, ["--no-warnings", BUILDER, cmd, dir], { encoding: "utf8" });
  return { line: r.stdout.split("\n")[0], code: r.status };
}

function closeTask(dir, id) {
  const f = join(dir, ".ai/state.json");
  const s = JSON.parse(readFileSync(f, "utf8"));
  const t = s.tasks.find((x) => x.id === id);
  Object.assign(t, { status: "DONE", completed_at: "2026-02-01T10:00:00Z", summary: "closed by the fixture" });
  writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`);
}

function runSteps(dir, steps) {
  for (const [op, prefix, code] of steps) {
    if (op === "commit") { git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "step"); continue; }
    if (op.startsWith("close:")) { closeTask(dir, op.slice(6)); continue; }
    const r = run(dir, op);
    assert.ok(r.line.startsWith(prefix), `${op}: expected ${prefix}…, got ${r.line}`);
    assert.equal(r.code, code, `${op} exit code (${r.line})`);
  }
}

test("the table carries each acceptance row (it cannot pass empty)", () => {
  for (const id of ["E-429.01", "E-429.02", "E-429.03", "E-429.04", "E-429.05"]) assert.ok(rows.some((r) => r.label.startsWith(id)), id);
});

for (const row of rows) {
  test(row.label, { skip: !hasGit && "git not on PATH" }, (t) => {
    const tmp = mkdtempSync(join(tmpdir(), "rein-digest-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const dirs = row.twin ? [join(tmp, "a"), join(tmp, "nested", "b")] : [join(tmp, "p")];
    for (const d of dirs) { mkdirSync(d, { recursive: true }); makeProject(d, row); runSteps(d, row.steps); }
    const dir = dirs[0];
    if (row.twin) {
      assert.equal(readFileSync(join(dirs[0], ".ai/DIGEST.md"), "utf8"), readFileSync(join(dirs[1], ".ai/DIGEST.md"), "utf8"));
    }
    const e = row.expect || {};
    if (e.symlinkIntact) {
      assert.ok(lstatSync(join(dir, ".ai/DIGEST.md")).isSymbolicLink());
      assert.equal(readlinkSync(join(dir, ".ai/DIGEST.md")), join(dir, "elsewhere.md"));
      assert.equal(readFileSync(join(dir, "elsewhere.md"), "utf8"), "not the digest\n");
      return;
    }
    if (e.gitClean) assert.equal(git(dir, "status", "--porcelain", "--", ".ai/DIGEST.md"), "");
    if (!e.contains && !e.absent && !e.maxLines) return;
    const text = readFileSync(join(dir, ".ai/DIGEST.md"), "utf8");
    if (e.maxLines) assert.ok(text.split("\n").length - 1 <= e.maxLines, `${text.split("\n").length - 1} lines`);
    for (const s of e.contains || []) assert.ok(text.includes(s), `missing: ${s}\n---\n${text}`);
    for (const s of e.absent || []) assert.ok(!text.includes(s), `present: ${s}`);
  });
}
