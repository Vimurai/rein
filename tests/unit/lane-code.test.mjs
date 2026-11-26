// tests/unit/lane-code.test.mjs — the [LANE_CODE] report (D-172 addendum 1 r24, E-462,
// T-SANDBOXLANE-001 F8): every file under .ai/ and plans/, tracked or not, whose extension is
// not a record's. New: the rule had no test; the hook row (hooks_surface_test.sh) and the
// handoff row (bookkeeping-commands.test.mjs) pin only that their callers print it.
//
// Run standalone: node --test tests/unit/lane-code.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

import { laneAllowed, laneCodeFiles, laneCodeLine } from "../../src/shared/lane-code.mjs";

function tree(t, files) {
  const root = mkdtempSync(join(tmpdir(), "rein-lane-code-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const f of files) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), "x\n"); }
  return root;
}

test("laneAllowed: the record extensions and sqlite's -wal/-shm pass; code, dotfiles and other sides do not", () => {
  for (const n of ["a.md", "a.json", "a.txt", "a.yml", "a.yaml", "a.tsv", "state.sqlite", "a.log", "A.MD",
    "state.sqlite-wal", "state.sqlite-shm", "a.svg", "a.dc.html", "a.png", "a.gif", "a.jpg", "a.pdf"])
    assert.equal(laneAllowed(n), true, n);   // D-172 a1 r25 added the drawing and document extensions
  for (const n of ["zz.test.mjs", "conftest.py", "p.cjs", "x.sh", ".gitignore", "Makefile", "a.md.mjs",
    "state.sqlite-journal", "a.json-wal", "a.js", "a.htm"]) assert.equal(laneAllowed(n), false, n);
});

test("laneCodeFiles / laneCodeLine: the empty case prints nothing", (t) => {
  const root = tree(t, [".ai/TASKS.md", ".ai/state.json", ".ai/state.sqlite", ".ai/state.sqlite-wal",
    ".ai/state.sqlite-shm", ".ai/archive/COMM-2026.md", "plans/x.md", "src/a.mjs", "a.test.mjs"]);
  assert.deepEqual(laneCodeFiles(root), { files: [], partial: false });
  assert.equal(laneCodeLine(root), "");
  assert.equal(laneCodeLine(tree(t, [])), "", "no .ai/ and no plans/ at all");
});

test("laneCodeFiles: a .mjs under plans/ is named; nested dirs and .ai/archive are walked; outside the lanes is not", (t) => {
  const root = tree(t, ["plans/zz.test.mjs", "plans/deep/er/conftest.py", ".ai/archive/x.sh", ".ai/LOG.md", "src/b.mjs"]);
  assert.deepEqual(laneCodeFiles(root).files, [".ai/archive/x.sh", "plans/deep/er/conftest.py", "plans/zz.test.mjs"]);
  assert.match(laneCodeLine(root), /^\[LANE_CODE\] 3 file\(s\) under \.ai\/ or plans\/ .*: \.ai\/archive\/x\.sh, plans\/deep\/er\/conftest\.py, plans\/zz\.test\.mjs — /);
});

test("laneCodeFiles: tracked or not — an untracked file and one a lane .gitignore hides are both named", (t) => {
  const root = tree(t, ["plans/.gitignore", "plans/tracked.md", "plans/hidden.test.mjs", "plans/untracked.cjs"]);
  writeFileSync(join(root, "plans/.gitignore"), "hidden.test.mjs\n");
  const g = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
  g("init", "-q"); g("add", "plans/tracked.md", "plans/.gitignore");
  assert.deepEqual(laneCodeFiles(root).files, ["plans/.gitignore", "plans/hidden.test.mjs", "plans/untracked.cjs"]);
});

test("laneCodeLine: many files → the first ten at most, a count, and one line under the width", (t) => {
  const root = tree(t, Array.from({ length: 25 }, (_, i) => `plans/f${String(i).padStart(2, "0")}.mjs`));
  const line = laneCodeLine(root);
  assert.ok(!line.includes("\n") && line.length <= 380, line);
  assert.match(line, /^\[LANE_CODE\] 25 file\(s\) .*plans\/f00\.mjs, .*\(\+\d+ more\)/);
  assert.ok(!line.includes("plans/f10.mjs"), "at most ten named");
});

// D-172 a1 r25: Rein's two lane files are exempt by exact path, and drawings and documents
// (.svg .html .png .gif .jpg .pdf) are records. Any other dotfile is still named.
test("laneCodeFiles: the two exempt .ai files and the r25 extensions are quiet; another dotfile is not", (t) => {
  const root = tree(t, [".ai/.gitignore", ".ai/.last-import-blob", "plans/icon/a.svg", "plans/icon/a.dc.html",
    "plans/x.png", "plans/x.gif", "plans/x.jpg", "plans/x.pdf", ".ai/.envrc", "plans/.gitignore"]);
  assert.deepEqual(laneCodeFiles(root).files, [".ai/.envrc", "plans/.gitignore"]);
});

// E-476 (D-174 r27) extends "laneCodeFiles: a .mjs under plans/ is named …" above: only regular
// files and symbolic links are reported. A role sandbox puts
// character-device placeholders in the working directory; an unprivileged test cannot mknod
// one, so the device row stubs readdir's entry type and the FIFO row is a real non-regular file.
test("E-476.01: a character device under .ai/ is not reported; a .mjs and a symlink beside it are", (t) => {
  const root = tree(t, [".ai/run.mjs"]);
  symlinkSync("/etc/hostname", join(root, ".ai", "ln"));
  const dev = { name: ".bashrc", isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false,
    isCharacterDevice: () => true };
  const readdir = (abs, opts) => {
    const ents = readdirSync(abs, opts);
    return abs === join(root, ".ai") ? [...ents, dev] : ents;
  };
  assert.deepEqual(laneCodeFiles(root, { readdir }).files, [".ai/ln", ".ai/run.mjs"]);
});

test("E-476.02: a FIFO under .ai/ (a real non-regular entry) is not reported", (t) => {
  const root = tree(t, [".ai/x.mjs"]);
  try { execFileSync("mkfifo", [join(root, ".ai", "pipe")]); } catch { t.skip("no mkfifo"); return; }
  assert.deepEqual(laneCodeFiles(root).files, [".ai/x.mjs"]);
});

test("E-476.03: the CLI takes --root <dir> as well as a bare root", (t) => {
  const root = tree(t, ["plans/z.test.mjs"]);
  const cli = join(import.meta.dirname, "../../src/shared/lane-code.mjs");
  for (const args of [["--root", root], [root]])
    assert.match(execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }), /\[LANE_CODE\] 1 file\(s\).*plans\/z\.test\.mjs/);
});
