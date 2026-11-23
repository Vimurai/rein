// tests/unit/bookkeeping-commands.test.mjs — `rein done`, `rein handoff`, `rein decide`
// (E-461, D-169 r7, .ai/blueprints/lean-core.md §Component 4 and §API).
//
// New: these replace the bookkeeping skills, whose only tests were the skill-text pins and the
// live evals (rein-task, rein-handoff). Extends record-store.test.mjs's `rein task done` rows —
// `rein done` closes through the same runTaskDone — with the LOG line, the digest and the exit
// codes the blueprint's API names. Each command runs in a scratch git project; nothing reads
// ~/.rein (the build check gets a fixture mirror and run dir).
//
// Run standalone: node --test tests/unit/bookkeeping-commands.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";

import { runDone, runHandoff, runDecide, main, nextDecisionId, missingDecisionParts, handoffLine } from "../../src/shared/cli-bookkeeping.mjs";
import { getDb, regenerateViews } from "../../src/mcp/shared/state-db.js";
import { writeDigest } from "../../src/shared/digest-build.mjs";

function project(t) {
  const root = mkdtempSync(join(tmpdir(), "rein-bookkeeping-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const g = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  const ai = join(root, ".ai");
  mkdirSync(ai, { recursive: true });
  writeFileSync(join(ai, "LOG.md"), "# LOG\n");
  writeFileSync(join(ai, "COMM.md"), "# COMM\n");
  writeFileSync(join(ai, "DECISIONS.md"), "# DECISIONS\n\n## D-7 — a ruling\n\n---\n\n## D-70 addendum 1 — more\n\n---\n");
  writeFileSync(join(root, ".gitignore"), ".ai/state.sqlite*\n");
  const db = getDb(ai);
  const add = db.prepare("INSERT INTO tasks(id, owner, status, tier, description, created_at) VALUES (?, 'Engineer (Claude)', 'OPEN', ?, ?, '2026-11-23T00:00:00Z')");
  add.run("E-500", 1, "Fix the text. Acceptance: README.md reads right.");
  add.run("E-501", 2, "Add a command. Acceptance: `rein x` exits 0.");
  regenerateViews(ai, db);
  writeDigest(root);                                      // tracked, as in a real project
  g("add", "-A"); g("commit", "-q", "-m", "seed");
  // The build check reads a mirror and a run dir: both are fixtures, never ~/.rein.
  const mirror = join(root, ".mirror"); const runDir = join(root, ".run");
  mkdirSync(runDir, { recursive: true });
  const opts = { env: { REIN_CI_GATE: "0" }, buildOpts: { mirrorRoot: mirror, runDir, frameworkOnly: false } };
  const status = (id) => getDb(ai).prepare("SELECT status FROM tasks WHERE id = ?").get(id).status;
  const entry = (name, text) => { const p = join(root, name); writeFileSync(p, text); return p; };
  return { root, ai, g, opts, status, entry, mirror };
}

// ── rein done ───────────────────────────────────────────────────────────────────────

test("rein done: exit 0, one line; the task is DONE, the LOG line written, the digest built", (t) => {
  const p = project(t);
  const r = runDone(p.ai, "E-500", "text fixed", p.opts);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, "✓ E-500 → DONE: text fixed");
  assert.equal(p.status("E-500"), "DONE");
  assert.match(readFileSync(join(p.ai, "LOG.md"), "utf8"), /^\d{4}-\d{2}-\d{2} \| Claude \| E-500 \| text fixed$/m);
  assert.match(readFileSync(join(p.ai, "DIGEST.md"), "utf8"), /^- E-500 \(\d{4}-\d{2}-\d{2}\): text fixed$/m);
  assert.equal(runDone(p.ai, "E-500", "again", p.opts).out, "E-500 is already DONE.", "a second close writes nothing");
});

test("rein done: exit 1 names the missing stamp; nothing is written", (t) => {
  const p = project(t);
  // E-501 is Tier 2 above both floors: the review gate is the first to refuse.
  const digest = readFileSync(join(p.ai, "DIGEST.md"), "utf8");
  const r = runDone(p.ai, "E-501", "built", p.opts);
  assert.equal(r.code, 1);
  assert.match(r.out, /^\[REVIEW_GATE\] E-501 is Tier 2 and has no \[REVIEW_PASS\] stamp/);
  assert.equal(p.status("E-501"), "OPEN");
  assert.equal(readFileSync(join(p.ai, "LOG.md"), "utf8"), "# LOG\n");
  assert.equal(readFileSync(join(p.ai, "DIGEST.md"), "utf8"), digest);
});

test("rein done: a stale build prints one [BUILD_STALE] line and does not refuse", (t) => {
  const p = project(t);
  mkdirSync(join(p.root, "src", "mcp", "srv"), { recursive: true });
  mkdirSync(join(p.mirror, "mcp", "srv"), { recursive: true });
  writeFileSync(join(p.root, "src", "mcp", "srv", "index.js"), "// v2, not installed\n");
  writeFileSync(join(p.mirror, "mcp", "srv", "index.js"), "// v1\n");
  const r = runDone(p.ai, "E-500", "lands", p.opts);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.split("\n").filter((l) => l.startsWith("[BUILD_STALE]")).length, 1, r.out);
  assert.equal(p.status("E-500"), "DONE");
});

test("rein done: usage errors exit 2 (no summary, no id)", (t) => {
  const p = project(t);
  assert.equal(main(["done", "E-500"], p.root).code, 2);
  assert.equal(main(["done", "--summary", "x"], p.root).code, 2);
  assert.equal(main(["done", "E-500", "--summary"], p.root).code, 2);
  assert.equal(p.status("E-500"), "OPEN");
});

// ── rein handoff ────────────────────────────────────────────────────────────────────

const ENTRY = `---
## Handoff — 2026-11-23 23:00 UTC
**From**: Engineer → Architect
**Trigger**: E-500 shipped (text fixed)

### Next action needed
- Review E-500.
---
`;

test("rein handoff: appends the entry, commits COMM.md with the dirty tracked .ai/ paths, prints the sha and the wake line", (t) => {
  const p = project(t);
  runDone(p.ai, "E-500", "text fixed", p.opts);          // dirties TASKS.md, state.json, LOG.md
  writeFileSync(join(p.root, "src.js"), "// source, never in a bookkeeping commit\n");
  p.g("add", "src.js");                                  // staged source must not ride along
  const file = p.entry("entry.md", ENTRY);
  const r = runHandoff(p.ai, { to: "architect", file }, { cwd: p.root });
  assert.equal(r.code, 0, r.out);
  const [sha, wake] = r.out.split("\n");
  assert.equal(sha, p.g("rev-parse", "--short", "HEAD"));
  assert.match(wake, new RegExp(`^SendMessage to "${basename(p.root)} · Architect": E-500 shipped \\(text fixed\\) — review and plan next\\. Details: \\.ai/COMM\\.md handoff \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC, commit ${sha}\\.$`));
  assert.ok(readFileSync(join(p.ai, "COMM.md"), "utf8").endsWith(ENTRY));
  // The acceptance clause: no tracked .ai/ change is left behind.
  assert.equal(p.g("status", "--short", "--", ".ai/"), "");
  assert.match(p.g("log", "-1", "--format=%s"), /^chore\(\.ai\): COMM handoff .* UTC \(Engineer\)$/);
  const files = p.g("show", "--name-only", "--format=", "HEAD").split("\n").sort();
  assert.ok(files.includes(".ai/COMM.md") && files.includes(".ai/TASKS.md") && files.includes(".ai/LOG.md"), files.join(","));
  assert.ok(!files.includes("src.js"), "staged source stays out of the handoff commit");
  assert.match(p.g("status", "--short", "--", "src.js"), /^A  src\.js$/);
});

test("rein handoff: exit 1 when the entry lacks \"Next action needed\"; nothing is written or committed", (t) => {
  const p = project(t);
  const head = p.g("rev-parse", "HEAD");
  const file = p.entry("entry.md", "## Handoff\n**Trigger**: something\n");
  const r = runHandoff(p.ai, { to: "engineer", file }, { cwd: p.root });
  assert.equal(r.code, 1);
  assert.match(r.out, /\[HANDOFF_INCOMPLETE\] .* has no "Next action needed" section/);
  assert.equal(readFileSync(join(p.ai, "COMM.md"), "utf8"), "# COMM\n");
  assert.equal(p.g("rev-parse", "HEAD"), head);
});

test("rein handoff: exit 1 with [COMM_IGNORED] when COMM.md is gitignored; nothing is written", (t) => {
  const p = project(t);
  p.g("rm", "-q", "--cached", ".ai/COMM.md");
  writeFileSync(join(p.root, ".gitignore"), ".ai/state.sqlite*\n.ai/COMM.md\n");
  const r = runHandoff(p.ai, { to: "architect", file: p.entry("entry.md", ENTRY) }, { cwd: p.root });
  assert.equal(r.code, 1);
  assert.match(r.out, /\[COMM_IGNORED\]/);
  assert.equal(readFileSync(join(p.ai, "COMM.md"), "utf8"), "# COMM\n");
});

test("rein handoff: usage errors exit 2 (unknown role, no file); a missing file exits 1", (t) => {
  const p = project(t);
  assert.equal(main(["handoff", "--to", "tester", "--file", "x"], p.root).code, 2);
  assert.equal(main(["handoff", "--to", "architect"], p.root).code, 2);
  assert.match(main(["handoff", "--to", "architect", "--file", "nope.md"], p.root).out, /\[ENTRY_MISSING\]/);
});

test("handoffLine: the Trigger, else the first line under Next action needed", () => {
  assert.equal(handoffLine("**Trigger**: P-9 planned\n"), "P-9 planned");
  assert.equal(handoffLine("### Next action needed\n\n- Execute E-12.\n"), "Execute E-12.");
});

// ── rein decide ─────────────────────────────────────────────────────────────────────

const DECISION = `## D-### — Keep the ledger in sqlite

**Decision**: The ledger stays in state.sqlite.

### Why needed
Two writers drifted.

### Rollback
Revert the commit.
`;

test("rein decide: numbers the entry after the highest D-, adds the date, appends it, prints the id", (t) => {
  const p = project(t);
  const r = runDecide(p.ai, { file: p.entry("d.md", DECISION) }, { cwd: p.root });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, "D-071");
  const text = readFileSync(join(p.ai, "DECISIONS.md"), "utf8");
  assert.match(text, /\n---\n\n## D-071 — Keep the ledger in sqlite\n\n\*\*Date\*\*: \d{4}-\d{2}-\d{2}\n\n\*\*Decision\*\*: The ledger stays/);
  assert.ok(text.endsWith("Revert the commit.\n\n---\n"));
  assert.equal(runDecide(p.ai, { file: p.entry("d2.md", DECISION.replace("D-### — ", "")) }, { cwd: p.root }).out, "D-072");
});

test("rein decide: exit 1 naming each missing part; DECISIONS.md unchanged", (t) => {
  const p = project(t);
  const before = readFileSync(join(p.ai, "DECISIONS.md"), "utf8");
  const cases = [
    [DECISION.replace(/\*\*Decision\*\*:.*\n/, ""), /a decision/],
    [DECISION.replace("### Why needed\nTwo writers drifted.\n", ""), /a reason/],
    [DECISION.replace("### Rollback\nRevert the commit.\n", ""), /a rollback/],
    [DECISION.replace("Revert the commit.\n", ""), /a rollback/],
    [DECISION.replace(/^## .*\n/, ""), /a '## <title>' heading/],
  ];
  for (const [text, want] of cases) {
    const r = runDecide(p.ai, { file: p.entry("bad.md", text) }, { cwd: p.root });
    assert.equal(r.code, 1, text);
    assert.match(r.out, /^✗ \[DECISION_INCOMPLETE\] /);
    assert.match(r.out, want);
  }
  assert.equal(readFileSync(join(p.ai, "DECISIONS.md"), "utf8"), before);
});

test("nextDecisionId and missingDecisionParts are pure", () => {
  assert.equal(nextDecisionId(""), "D-001");
  assert.equal(nextDecisionId("## D-171 — x\n## D-99 — y\n"), "D-172");
  assert.deepEqual(missingDecisionParts(DECISION), []);
});
