// tests/unit/rename-gate.test.mjs — the rename's grep gate (E-383, E-391; D-132 and its
// addendum 2; rein-rename.md §Component 6).
//
// New file: nothing tested the product name before. The gate reads every tracked (and
// untracked, not ignored) file and fails on an old spelling outside the history and record
// exclusions in tests/fixtures/rename-exclusions.json. The rename is a hard cut: no line is
// exempt by a marker. Three families:
//   the brand    — ai-os / ai_os / aios, any case;
//   the command  — `ai <subcommand>`, the subcommands read from src/bin/rein's dispatch table,
//                  never preceded by a letter, digit, `_`, `.`, `/`, `@` or `-` (so `.ai/` and
//                  paths ending in `ai` cannot match);
//   the skills   — `ai-<name>` for the 18 skills renamed to `rein-<name>`;
// plus the literals the command left in file names and CI: bin/ai, ai-exec, ai-account,
// ai-ci-run, `ai ci run (`, and `ai` in backticks.
//
//   node --test tests/unit/rename-gate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT = process.cwd();

const isIgnored = (p) => {
  try { execFileSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: ROOT, stdio: "ignore" }); return true; } catch { return false; }
};

// Case-insensitive: the case-sensitive first cut missed every lowercase `ai_os_*` shell function.
const BRAND = /ai[-_]os|aios/i;
// AWS's documented example access-key id spells AIOS by accident; the secret fixtures need it
// verbatim (the mechanical map broke it once). Assembled so this file does not carry it.
const NOT_OURS = new RegExp("AKI" + "A" + "IOSFODNN7EXAMPLE", "g");

export const SKILLS = ["archive", "debug", "digest", "handoff", "incident", "insights", "log", "migration",
  "preflight", "profile", "review", "review-proposed-skills", "seo", "sync-state", "task", "test", "triage", "upgrade"];

// The subcommands, from the dispatch table: every label of `case "$cmd" in … esac`.
export function subcommands(cli = readFileSync(join(ROOT, "src/bin/rein"), "utf8")) {
  const body = cli.slice(cli.indexOf('case "$cmd" in'));
  const table = body.slice(0, body.indexOf("\nesac"));
  const out = new Set();
  for (const m of table.matchAll(/^ {2}([a-z|-]+(?:\|[a-z|-]+)*)\)/gm)) {
    for (const s of m[1].split("|")) if (/^[a-z][a-z-]*$/.test(s)) out.add(s);
  }
  return [...out].sort();
}

// Not after a letter, digit, `_`, `.`, `/`, `@` or `-` — except the letter of a `\t`, `\n` or
// `\r` escape inside a string literal (a census line "\tai init" is the command).
const NOT_BEFORE = String.raw`(?:(?<![A-Za-z0-9_./@-])|(?<=\\[tnr]))`;
// A path segment named for the product or the command. ai-bookkeeping.md is named for the
// .ai/ directory (the one survivor), not for the product.
const OLD_PATH = /(?:^|\/)ai[-_](?!bookkeeping\.md$)/;
export function patterns(subs = subcommands()) {
  const skillNames = [...SKILLS].sort((a, b) => b.length - a.length).join("|");
  return [
    ["brand", BRAND],
    ["command", new RegExp(NOT_BEFORE + String.raw`ai (?:${subs.join("|")})(?![A-Za-z0-9_-])`)],
    ["skill", new RegExp(NOT_BEFORE + String.raw`ai-(?:${skillNames})(?![A-Za-z0-9_-])`)],
    ["literal", new RegExp(String.raw`bin/ai(?![A-Za-z0-9_-])|ai-exec|ai-account|ai-ci-run|ai ci run \(|` + "`ai`")],
  ];
}

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

test("no old spelling of the product, the command or a skill outside the exclusions", () => {
  const pats = patterns();
  const hits = [];
  for (const f of files()) {
    if (wholeFile(f)) continue;
    const p = join(ROOT, f);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    for (const [kind, re] of pats) if (re.test(f)) hits.push(`${f} (path, ${kind})`);
    if (OLD_PATH.test(f)) hits.push(`${f} (path, name)`);
    const buf = readFileSync(p);
    if (buf.includes(0)) continue;               // binary
    const lines = buf.toString("utf8").split("\n");
    const skip = excludedLines(f, lines);
    lines.forEach((line, i) => {
      if (skip.has(i)) return;
      const l = line.replace(NOT_OURS, "");
      for (const [kind, re] of pats) {
        if (re.test(l)) { hits.push(`${f}:${i + 1} [${kind}]: ${line.trim().slice(0, 120)}`); break; }
      }
    });
  }
  assert.deepEqual(hits, [], `old spellings left (${hits.length}):\n${hits.slice(0, 60).join("\n")}`);
});

test("the patterns catch the old forms and never the new ones or the .ai/ directory", () => {
  const pats = patterns(["ci", "sync", "pane", "doctor"]);
  const hit = (s) => pats.some(([, re]) => re.test(s));
  for (const s of ["run: ai sync", "`ai ci run --dirty`", "skill: ai-preflight", "ai-review-proposed-skills",
    "src/bin/ai", "src/bin/ai-exec", "ai-account.sh", "job ai-ci-run", "ai ci run (ubuntu-latest", "the `ai` command",
    "ai_os_locate", "~/.ai-os/hooks", "AI_OS_HOME", "AIOS_WORKSPACE", "\\tai sync\\trun", "\\nai ci run"]) assert.ok(hit(s), `missed: ${s}`);
  for (const s of ["rein sync", "rein ci run", "skill: rein-preflight", "src/bin/rein", "rein-ci-run", ".ai/TASKS.md",
    "cat .ai/ci.local.json", "~/.ai/sync", "openai sync", "the AI review", "arch-review", "chaos", "repo/ai pane",
    "rein-review-proposed-skills", "\\trein init", "maintain sync"]) assert.ok(!hit(s), `false positive: ${s}`);
});

test("a path segment named ai-/ai_ fails, except the .ai/ bookkeeping rule", () => {
  for (const p of ["src/shared/ai-clean.mjs", "tests/suites/ai_ci_test.sh", ".claude/skills/ai-task/SKILL.md"]) assert.ok(OLD_PATH.test(p), p);
  for (const p of [".claude/rules/ai-bookkeeping.md", ".ai/TASKS.md", "src/shared/rein-clean.mjs", "docs/maid-notes.md"]) assert.ok(!OLD_PATH.test(p), p);
});

test("the subcommand list comes from the dispatch table", () => {
  const subs = subcommands();
  for (const s of ["ci", "sync", "init", "doctor", "pane", "start", "task", "gate"]) assert.ok(subs.includes(s), s);
  assert.deepEqual(subcommands('cmd="$1"\ncase "$cmd" in\n  a|b-c)  x ;;\n  -v|--version) y ;;\n  *) z ;;\nesac\n'), ["a", "b-c"]);
});

test("every old name in the map is caught, every exclusion names a reason and exists", () => {
  const pats = patterns();
  const concrete = (s) => s.replace("<subcommand>", "sync");
  for (const { old, new: now, kind } of MAP.filter((r) => r.kind !== "pin")) {
    assert.ok(pats.some(([, re]) => re.test(concrete(old))), `map entry ${old} is not caught by the gate`);
    assert.ok(!pats.some(([, re]) => re.test(concrete(now))), `map entry ${old} → ${now} still spells an old name`);
    assert.ok(["env", "path", "tag", "id", "prose", "file", "command", "skill", "pin"].includes(kind), `${old}: unknown kind ${kind}`);
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

// D-132 addendum 3: the pinned tables took the token rename and were re-pinned; each table now
// hashes to its new pin and its old pin is gone from every test.
test("every re-pinned table hashes to its new pin, and no test still names the old one", () => {
  const pins = MAP.filter((r) => r.kind === "pin");
  assert.ok(pins.length >= 3, "the three D-132 addendum 3 tables");
  const tests = files().filter((f) => f.startsWith("tests/") && f.endsWith(".mjs"));
  for (const { old, new: now, table } of pins) {
    assert.equal(createHash("sha256").update(readFileSync(join(ROOT, table))).digest("hex"), now, table);
    for (const f of tests) assert.ok(!readFileSync(join(ROOT, f), "utf8").includes(old), `${f} still pins ${table} at ${old.slice(0, 8)}`);
  }
});

test("a section exclusion ends at the next `until` line, or runs to the end of the file", () => {
  const lines = ["## A", "ai-os", "## Where this comes from", "AI-OS", "### sub", "## B", "AIOS"];
  assert.deepEqual([...excludedLines("X.md", lines, { "X.md": { from: "## Where this comes from", until: "## " } })], [2, 3, 4]);
  assert.deepEqual([...excludedLines("X.md", lines, { "X.md": { from: "## Where this comes from", until: null } })], [2, 3, 4, 5, 6]);
});
