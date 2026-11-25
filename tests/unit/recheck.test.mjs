// tests/unit/recheck.test.mjs — `rein recheck` in src/shared/recheck.mjs (E-479, D-176,
// .ai/blueprints/acceptance-replay.md §Component 2). A new file: no earlier test replays a
// check. It extends tests/unit/checks.test.mjs (the grammar) to the run: a scratch git repo
// whose state holds CHECK stamps written by record-store's insertStamp, so each stamp carries
// the sha the server would bind. git and bash are the process boundary, so the fixture is real.
//
// Run standalone: node --test tests/unit/recheck.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { runRecheck, runList, runRetire, liveSet, parseArgs, main } from "../../src/shared/recheck.mjs";
import { getDb } from "../../src/mcp/shared/state-db.js";
import { insertStamp } from "../../src/mcp/shared/record-store.mjs";

function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), "recheck-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
  mkdirSync(join(repo, ".ai"));
  writeFileSync(join(repo, ".ai", ".gitignore"), "state.sqlite*\n");
  writeFileSync(join(repo, ".ai", "DECISIONS.md"), "# DECISIONS\n\n## D-176 — acceptance replay\n");
  writeFileSync(join(repo, "a.txt"), "alpha\nbeta\n");
  const ai = join(repo, ".ai");
  const db = getDb(ai);
  const add = db.prepare("INSERT INTO tasks(id, owner, status, tier, description, created_at) VALUES (?, 'Engineer (Claude)', ?, 2, 'fixture', '2026-11-25T00:00:00Z')");
  for (const [id, st] of [["E-10", "DONE"], ["E-11", "OPEN"], ["E-12", "DONE"]]) add.run(id, st);
  g("add", "-A"); g("commit", "-q", "-m", "seed");
  const check = (task, summary) => insertStamp(ai, db, { type: "CHECK", agent: "critic_acceptance", task_id: task, timestamp: new Date().toISOString(), summary });
  const stamps = (type) => db.prepare("SELECT summary, sha FROM stamps WHERE type = ?").all(type).map((r) => ({ ...r }));
  return { repo, ai, db, g, check, stamps, head: () => g("rev-parse", "HEAD") };
}

test("checks that hold: exit 0, one ✓ line, a CHECKS_PASS stamp bound to HEAD", async (t) => {
  const f = fixture(t);
  f.check("E-10", "E-10#1 | lines=2 | cat a.txt");
  f.check("E-10", "E-10#2 | out=alpha | head -1 a.txt | tr -d ' '");   // a command with '|'
  f.check("E-11", "E-11#1 | exit=0 | false");                          // OPEN task: not live
  const r = await runRecheck(f.ai);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^✓ \[CHECKS_PASS\] 2 hold, 0 retired \(\d+\.\d s\)$/);
  assert.deepEqual(f.stamps("CHECKS_PASS"), [{ summary: `[CHECKS_PASS] at ${f.head().slice(0, 7)} — 2 hold, 0 retired`, sha: f.head() }]);
});

test("one broken check per expect form: a [CHECK_BROKEN] line each, [CHECKS_FAIL], exit 1, a CHECKS_FAIL stamp", async (t) => {
  const f = fixture(t);
  for (const [n, s] of [["1", "exit=0 | exit 3"], ["2", "empty | echo x"], ["3", "lines=1 | cat a.txt"],
    ["4", "lines>=3 | cat a.txt"], ["5", "out=beta | head -1 a.txt"]]) f.check("E-10", `E-10#${n} | ${s}`);
  const r = await runRecheck(f.ai);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out.split("\n").slice(0, 5), [
    "✗ [CHECK_BROKEN] E-10#1 expected exit=0, got exit 3: exit 3",
    "✗ [CHECK_BROKEN] E-10#2 expected empty, got 1 line: echo x",
    "✗ [CHECK_BROKEN] E-10#3 expected lines=1, got 2 lines: cat a.txt",
    "✗ [CHECK_BROKEN] E-10#4 expected lines>=3, got 2 lines: cat a.txt",
    "✗ [CHECK_BROKEN] E-10#5 expected out=beta, got out=alpha: head -1 a.txt",
  ]);
  assert.match(r.out.split("\n")[5], /^✗ \[CHECKS_FAIL\] 5 broken of 5 \(/);
  assert.equal(f.stamps("CHECKS_FAIL")[0].summary, `[CHECKS_FAIL] at ${f.head().slice(0, 7)} — 5 broken of 5: E-10#1, E-10#2, E-10#3, E-10#4, E-10#5`);
});

test("a check past its time limit, or past the stdout cap, is broken and its process group is gone", async (t) => {
  const f = fixture(t);
  f.check("E-10", "E-10#1 | exit=0 | sleep 5 | cat");
  f.check("E-10", "E-10#2 | exit=0 | yes | head -c 200000");
  const t0 = Date.now();
  const r = await runRecheck(f.ai, { json: true, opts: { timeoutMs: 400 } });
  assert.ok(Date.now() - t0 < 4000, "the pipeline was killed, not waited for");
  const broken = JSON.parse(r.out).broken.map((b) => [b.id, b.got]);
  assert.deepEqual(broken, [["E-10#1", "timed out after 0 s"], ["E-10#2", "output too large"]]);
  assert.equal(r.code, 1);
});

test("the live set: the newest stamp per clause, a retirement ends one, a reopened task leaves until DONE again", (t) => {
  const f = fixture(t);
  f.check("E-10", "E-10#1 | empty | echo old");
  f.check("E-10", "E-10#1 | empty | true");
  f.check("E-12", "E-12#1 | exit=0 | true");
  assert.deepEqual(liveSet(f.db).live.map((c) => [c.id, c.command]), [["E-10#1", "true"], ["E-12#1", "true"]]);
  assert.equal(runRetire(f.ai, "E-12#1", "D-176", "the file was renamed").out, "✓ E-12#1 retired by D-176");
  assert.deepEqual(liveSet(f.db), { live: [liveSet(f.db).live[0]], retired: ["E-12#1"] });
  f.db.prepare("UPDATE tasks SET status = 'OPEN' WHERE id = 'E-10'").run();
  assert.deepEqual(liveSet(f.db).live, [], "reopened: out of the set");
  f.db.prepare("UPDATE tasks SET status = 'DONE' WHERE id = 'E-10'").run();
  assert.deepEqual(liveSet(f.db).live.map((c) => c.id), ["E-10#1"], "DONE again: back in");
});

test("a dirty tree: the run is made and printed, nothing is recorded; an .ai/-only change is not dirty", async (t) => {
  const f = fixture(t);
  f.check("E-10", "E-10#1 | exit=0 | true");
  writeFileSync(join(f.ai, "DECISIONS.md"), "# DECISIONS\n\n## D-176 — edited\n");
  assert.equal((await runRecheck(f.ai)).code, 0);
  assert.equal(f.stamps("CHECKS_PASS").length, 1, ".ai/ edits do not stop the record");
  writeFileSync(join(f.repo, "a.txt"), "changed\n");
  const r = await runRecheck(f.ai);
  assert.match(r.out, /^✓ \[CHECKS_PASS\] 1 hold, 0 retired \(.*\) \(dirty: not recorded\)$/);
  assert.equal(f.stamps("CHECKS_PASS").length, 1, "nothing recorded on the dirty tree");
});

test("--list prints the live checks and runs nothing", (t) => {
  const f = fixture(t);
  f.check("E-10", "E-10#1 | exit=0 | touch made-by-list");
  f.check("E-10", "E-10#2 | lines>=1 | git ls-files | grep a.txt");
  const r = runList(f.ai);
  assert.equal(r.code, 0);
  assert.equal(r.out, "E-10#1 | exit=0 | touch made-by-list\nE-10#2 | lines>=1 | git ls-files | grep a.txt");
  assert.equal(existsSync(join(f.repo, "made-by-list")), false, "the command was not run");
});

test("--retire refuses an unknown --by with [RETIRE_UNKNOWN] and an id that is not live with [CHECK_UNKNOWN]", async (t) => {
  const f = fixture(t);
  f.check("E-10", "E-10#1 | exit=0 | true");
  assert.deepEqual(runRetire(f.ai, "E-10#1", "D-999", "x"), { code: 1, out: "✗ [RETIRE_UNKNOWN] D-999 is not a decision or a task" });
  assert.deepEqual(runRetire(f.ai, "E-10#1", "E-404", "x"), { code: 1, out: "✗ [RETIRE_UNKNOWN] E-404 is not a decision or a task" });
  assert.deepEqual(runRetire(f.ai, "E-10#9", "D-176", "x"), { code: 1, out: "✗ [CHECK_UNKNOWN] E-10#9 is not a live check" });
  assert.deepEqual(runRetire(f.ai, "E-11#1", "E-12", "x"), { code: 1, out: "✗ [CHECK_UNKNOWN] E-11#1 is not a live check" });
  assert.equal(f.stamps("CHECK_RETIRED").length, 0, "a refusal writes nothing");
  assert.equal(runRetire(f.ai, "E-10#1", "E-12", "replaced by E-12").code, 0, "a task in state is a valid --by");
  assert.equal(f.stamps("CHECK_RETIRED")[0].summary, "E-10#1 | E-12 | replaced by E-12");
});

test("bad arguments print the usage and exit 2", async () => {
  for (const argv of [["--bogus"], ["--retire", "E-1#1"], ["--list", "--json"], ["--retire", "E-1#1", "--by", "D-1", "--reason", "x", "--list"], ["--by"]]) {
    assert.equal(parseArgs(argv), null, argv.join(" "));
    const r = await main(argv, tmpdir());
    assert.equal(r.code, 2);
    assert.match(r.out, /^usage: rein recheck/);
  }
});
