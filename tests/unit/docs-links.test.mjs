// docs-links.test.mjs — the shape of the public docs (E-390, D-136, readme.md §Component 5):
// every mermaid fence is balanced and flowchart-only; the HTML is limited to <div>, <picture>
// (with its <source>/<img>) and <details>/<summary>; the README stays under 60 KB.
// Extends E-374 (tests/unit/publish-scan.test.mjs), which already resolves every relative link
// and #anchor in README.md and docs/ — that check is not repeated here (D-088).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { hostname } from "node:os";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : n.endsWith(".md") ? [p] : [];
});
const PAGES = [join(repo, "README.md"), ...walk(join(repo, "docs"))];

// Code fences and inline code are not markup.
const FENCE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
const prose = (md) => md.replace(FENCE, "").replace(/`[^`\n]*`/g, "");

const mermaidBlocks = PAGES.flatMap((p) => [...readFileSync(p, "utf8").matchAll(/^```mermaid\n([\s\S]*?)^```[ \t]*$/gm)]
  .map((m) => ({ page: relative(repo, p), src: m[1] })));

test("every mermaid fence is balanced and uses flowchart only", () => {
  // Non-vacuity: the four diagrams of readme.md §Component 2, one of them in the README.
  assert.ok(mermaidBlocks.length >= 4, `only ${mermaidBlocks.length} mermaid blocks — the four diagrams are missing`);
  assert.ok(mermaidBlocks.some((b) => b.page === "README.md"), "the README lost its loop diagram");
  for (const p of PAGES) {
    const md = readFileSync(p, "utf8");
    const opens = (md.match(/^```mermaid[ \t]*$/gm) || []).length;
    const closed = [...md.matchAll(/^```mermaid\n[\s\S]*?^```[ \t]*$/gm)].length;
    assert.equal(closed, opens, `${relative(repo, p)}: an unterminated mermaid fence`);
  }
  for (const { page, src } of mermaidBlocks) {
    assert.match(src.trimStart(), /^flowchart (LR|RL|TD|TB|BT)\b/, `${page}: a diagram that is not a flowchart`);
    const bare = src.replace(/"[^"]*"/g, "");
    for (const [o, c] of [["[", "]"], ["(", ")"], ["{", "}"]]) {
      assert.equal(bare.split(o).length, bare.split(c).length, `${page}: unbalanced ${o}${c} outside the quoted labels`);
    }
    assert.equal((src.match(/^\s*subgraph\b/gm) || []).length, (src.match(/^\s*end\s*$/gm) || []).length, `${page}: subgraph without end`);
  }
});

// The parse needs the mermaid package; only a host that already has it runs it (no install).
test("every mermaid block parses", async (t) => {
  let mermaid;
  try { mermaid = (await import(createRequire(join(repo, "package.json")).resolve("mermaid"))).default; }
  catch { t.skip(`mermaid is not installed on ${hostname()} — the parse is skipped`); return; }
  for (const { page, src } of mermaidBlocks) await assert.doesNotReject(mermaid.parse(src), page);
});

test("the HTML is limited to <div>, <picture> and <details>", () => {
  const ALLOWED = new Set(["div", "picture", "source", "img", "details", "summary"]);
  const seen = new Set();
  for (const p of PAGES) {
    const tags = [...prose(readFileSync(p, "utf8")).matchAll(/<\/?([a-z][a-z0-9]*)(?=[\s/>])[^>]*>/gi)].map((m) => m[1].toLowerCase());
    tags.forEach((x) => seen.add(x));
    assert.deepEqual(tags.filter((x) => !ALLOWED.has(x)), [], `${relative(repo, p)}: HTML beyond div/picture/details`);
  }
  assert.ok(seen.has("picture"), "no <picture> found — the tag scan is broken");
});

test("the README stays under 60 KB", () => {
  assert.ok(statSync(join(repo, "README.md")).size < 60 * 1024);
});
