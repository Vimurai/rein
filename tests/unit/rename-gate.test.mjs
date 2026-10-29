// tests/unit/rename-gate.test.mjs — the rename's grep gate (E-383, D-132, rein-rename.md
// §Component 6) and the env resolver it leaves room for (§Component 4).
//
// New file: nothing tested the product name before. The gate reads every tracked (and
// untracked, not ignored) file and fails on an old spelling outside the history exclusions
// in tests/fixtures/rename-exclusions.json and outside lines carrying the marker
// `rename:legacy-fallback`. The project-file rewrite `ai sync` performs is tested where the
// rest of sync's data half is: tests/unit/project-upgrade.test.mjs.
//
//   node --test tests/unit/rename-gate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { resolve as resolveEnv, legacyVars, applyLegacyEnv, newNameOf } from "../../src/shared/env.mjs";

const isIgnored = (p) => {
  try { execFileSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: ROOT, stdio: "ignore" }); return true; } catch { return false; }
};

const ROOT = process.cwd();
const OLD = /ai-os|AI-OS|AI_OS_|aios|AIOS/;
// AWS's documented example access-key id spells AIOS by accident; the secret fixtures need it
// verbatim (the mechanical map broke it once). Assembled so this file does not carry it.
const NOT_OURS = new RegExp("AKI" + "A" + "IOSFODNN7EXAMPLE", "g");
const MARKER = "rename:legacy-fallback";
const EXCL = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/rename-exclusions.json"), "utf8"));
const MAP = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/rename-map.json"), "utf8"));

// A section exclusion: from the line equal to `from` up to (not including) the next line
// starting with `until`, or to the end of the file when `until` is null.
function excludedLines(file, lines, sections = EXCL.sections || {}) {
  const out = new Set();
  const sec = sections[file];
  if (!sec) return out;
  let on = false;
  lines.forEach((line, i) => {
    if (on && sec.until !== null && i > 0 && line.startsWith(sec.until)) on = false;
    if (line === sec.from) on = true;
    if (on) out.add(i);
  });
  return out;
}

function files() {
  const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  return out.split("\0").filter(Boolean);
}

const wholeFile = (f) => f in EXCL.files || Object.keys(EXCL.prefixes || {}).some((p) => f.startsWith(p));

test("no old spelling of the product name outside the exclusions and marked legacy fallbacks", () => {
  const hits = [];
  for (const f of files()) {
    if (wholeFile(f)) continue;
    const p = join(ROOT, f);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    if (OLD.test(f)) hits.push(`${f} (path)`);
    const buf = readFileSync(p);
    if (buf.includes(0)) continue;               // binary
    const lines = buf.toString("utf8").split("\n");
    const skip = excludedLines(f, lines);
    lines.forEach((line, i) => {
      if (OLD.test(line.replace(NOT_OURS, "")) && !line.includes(MARKER) && !skip.has(i)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, [], `old spellings left (${hits.length}):\n${hits.slice(0, 40).join("\n")}`);
});

test("the gate pattern covers every old name in the map, and every exclusion names a reason", () => {
  for (const { old, new: now, kind } of MAP) {
    assert.match(old, OLD, `map entry ${old} is not caught by the gate`);
    assert.doesNotMatch(now, OLD, `map entry ${old} → ${now} still spells the old name`);
    assert.ok(["env", "path", "tag", "id", "prose", "file"].includes(kind), `${old}: unknown kind ${kind}`);
  }
  const reasons = { ...EXCL.files, ...EXCL.prefixes, ...Object.fromEntries(Object.entries(EXCL.sections).map(([k, v]) => [k, v.why])) };
  for (const [k, why] of Object.entries(reasons)) {
    assert.ok(typeof why === "string" && why.length > 10, `exclusion ${k} has no reason`);
    // A gitignored record (.ai/LOG.md) is absent from a clean checkout — the CI worktree.
    assert.ok(existsSync(join(ROOT, k)) || isIgnored(k), `exclusion ${k} names a missing path`);
  }
  for (const [f, { from }] of Object.entries(EXCL.sections)) {
    assert.ok(readFileSync(join(ROOT, f), "utf8").split("\n").includes(from), `${f}: section heading "${from}" not found — the exclusion would cover nothing`);
  }
});

test("a section exclusion ends at the next `until` line, or runs to the end of the file", () => {
  const lines = ["## A", "ai-os", "## Where this comes from", "AI-OS", "### sub", "## B", "AIOS"];
  assert.deepEqual([...excludedLines("X.md", lines, { "X.md": { from: "## Where this comes from", until: "## " } })], [2, 3, 4]);
  assert.deepEqual([...excludedLines("X.md", lines, { "X.md": { from: "## Where this comes from", until: null } })], [2, 3, 4, 5, 6]);
});

// ── env resolver (src/shared/env.mjs; its shell twin is rein_legacy_env_apply in locate.sh) ──

test("env: the new name wins, the old one is read only when the new one is unset", () => {
  assert.deepEqual(resolveEnv("REIN_FOO", { REIN_FOO: "new", AI_OS_FOO: "old" }), { value: "new", legacy: false });
  assert.deepEqual(resolveEnv("REIN_FOO", { AI_OS_FOO: "old" }), { value: "old", legacy: true });
  assert.deepEqual(resolveEnv("REIN_FOO", { REIN_FOO: "" , AI_OS_FOO: "old" }), { value: "", legacy: false });
  assert.deepEqual(resolveEnv("REIN_WORKSPACE", { AIOS_WORKSPACE: "/w" }), { value: "/w", legacy: true });
  assert.deepEqual(resolveEnv("REIN_FOO", {}), { value: undefined, legacy: false });
});

test("env: the trust-bearing names are never mapped", () => {
  for (const x of ["TC_NODE", "LOCATE_DEV", "LOCATE_UNTRUSTED_ENV", "CALLER_ROLE", "PANE_ROLE"]) {
    assert.equal(newNameOf(`AI_OS_${x}`), null, x);
    assert.deepEqual(resolveEnv(`REIN_${x}`, { [`AI_OS_${x}`]: "architect" }), { value: undefined, legacy: false }, x);
  }
});

test("env: applyLegacyEnv sets only unshadowed names; the shell twin agrees", () => {
  const input = { AI_OS_FOO: "1", AI_OS_BAR: "old", REIN_BAR: "new", AI_OS_CALLER_ROLE: "architect", AIOS_WORKSPACE: "/w", OTHER: "x" };
  const env = { ...input };
  assert.deepEqual(applyLegacyEnv(env).sort(), ["REIN_FOO", "REIN_WORKSPACE"]);
  assert.equal(env.REIN_BAR, "new");
  assert.equal(env.REIN_CALLER_ROLE, undefined);
  assert.deepEqual(legacyVars(input).map((v) => [v.old, v.shadowed]),
    [["AIOS_WORKSPACE", false], ["AI_OS_BAR", true], ["AI_OS_FOO", false]]);

  const sh = execFileSync("/bin/bash", ["-c", `. "${join(ROOT, "src/shared/locate.sh")}"; rein_legacy_env_apply; env | grep '^REIN_' | sort; printf '%s\\n' "\${REIN_LEGACY_ENV_SEEN[@]}"`],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...input }, encoding: "utf8" });
  const set = sh.split("\n").filter((l) => /^REIN_(FOO|BAR|WORKSPACE|CALLER_ROLE)=/.test(l));
  assert.deepEqual(set, ["REIN_BAR=new", "REIN_FOO=1", "REIN_WORKSPACE=/w"]);
  assert.match(sh, /^AI_OS_BAR REIN_BAR ignored$/m);
});
