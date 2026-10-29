// bounded-reads.test.mjs — P-8..P-12 robustness: the bounded-read helpers' behaviour. Moved from
// tests/suites/robustness_p7_p12_test.sh (E-302, D-088: pure helpers are tested in the unit
// layer; that suite was misnamed for its tasks). The source-contract rows — that each MCP server
// actually ships the helper — stayed with the servers, in mcp_servers_test.sh.
//
// As in the suite they came from, each row exercises the helper's logic as the server writes it
// (readHead in memory-manager-mcp, the added-line regex in blueprint-aligner-mcp, the
// blueprints fallback in run_handover, the statSync guard in patch-mcp): none is exported.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync,
  openSync, readSync, closeSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let T;
before(() => { T = mkdtempSync(join(tmpdir(), "aios-t-bounded-")); });
after(() => { if (T) rmSync(T, { recursive: true, force: true }); });

// ── P-8: readHead (memory-manager-mcp) reads a bounded head, never the whole file ──
function readHead(filePath, headBytes = 4096) {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(headBytes);
    const bytesRead = readSync(fd, buf, 0, headBytes, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}
const bigfile = () => {
  const f = join(T, "bigfile.txt");
  writeFileSync(f, Array.from({ length: 100 }, (_, i) => `${i + 1}\n`).join(""));
  return f;
};
test("P-8: readHead reads only headBytes (bounded read verified)", () => assert.ok(readHead(bigfile(), 10).length <= 10));
test("P-8: readHead correctly extracts first line", () => assert.equal(readHead(bigfile()).split("\n")[0] || "", "1"));

// ── P-9: the iterative added-line regex (blueprint-aligner-mcp generateDelta) ──
const addedLines = (diff) => {
  const out = [];
  const addedRe = /^\+(?!\+\+).*$/gm;
  let am;
  while ((am = addedRe.exec(diff)) !== null) out.push(am[0]);
  return out;
};
test("P-9: iterative regex extracts added lines, skips +++ headers", () => {
  const diff = ["--- a/foo.js", "+++ b/foo.js", "+function newFn() {}", " unchanged line", "-removed line",
    "+const bar = 1;", "+++header line"].join("\n");
  assert.deepEqual(addedLines(diff), ["+function newFn() {}", "+const bar = 1;"]);
});
test("P-9: +++ diff header lines correctly excluded from addedLines", () => {
  const got = addedLines("+++ b/foo.js\n+real added line\n");
  assert.ok(!got.some((l) => l.startsWith("+++")) && got.length === 1, JSON.stringify(got));
});

// ── P-11: run_handover's blueprints/*.md fallback finds a task id the root architect.md lacks ──
test("P-11: blueprints/*.md fallback finds task ID not in root architect.md", () => {
  const ai = join(T, "p11", ".ai");
  mkdirSync(join(ai, "blueprints"), { recursive: true });
  writeFileSync(join(ai, "blueprints/robustness.md"), "## Section for E-999\nThis blueprint covers E-999 implementation details.\n");
  writeFileSync(join(ai, "architect.md"), "# Architect Index\n");
  const taskId = "E-999";
  const readSafe = (p) => { try { return existsSync(p) ? readFileSync(p, "utf8") : ""; } catch { return ""; } };
  let bpSection = "";
  const arch = readFileSync(resolve(ai, "architect.md"), "utf8");
  const ai0 = arch.indexOf(taskId);
  if (ai0 !== -1) bpSection = arch.slice(Math.max(0, ai0 - 500), Math.min(arch.length, ai0 + 2000));
  if (!bpSection) {
    for (const file of readdirSync(resolve(ai, "blueprints")).filter((f) => f.endsWith(".md"))) {
      const bp = readSafe(resolve(ai, "blueprints", file));
      const idx = bp.indexOf(taskId);
      if (idx !== -1) {
        const before = bp.lastIndexOf("\n## ", idx);
        const after = bp.indexOf("\n## ", idx + 1);
        bpSection = bp.slice(before !== -1 ? before : Math.max(0, idx - 500), after !== -1 ? after : Math.min(bp.length, idx + 2000));
        break;
      }
    }
  }
  assert.match(bpSection, /E-999/);
});

// ── P-12: patch-mcp's statSync 5 MB size guard ──
const LIMIT = 5 * 1024 * 1024;
const sizeGuard = (fileSize) => (fileSize > LIMIT ? "[FILE_TOO_LARGE] File exceeds 5MB limit" : "proceed");
test("P-12: small file passes statSync size guard", () => {
  const f = join(T, "small.txt");
  writeFileSync(f, "hello");
  assert.ok(!(statSync(f).size > LIMIT));
});
test("P-12: size guard rejects >5MB files with [FILE_TOO_LARGE], allows smaller", () => {
  assert.ok(sizeGuard(LIMIT + 1).startsWith("[FILE_TOO_LARGE]"));
  assert.equal(sizeGuard(1024), "proceed");
});
