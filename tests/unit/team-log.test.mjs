// team-log.test.mjs — the shared log: where a LOG entry goes, and the newest entries across
// every developer's file (E-333, D-102 §8, team-collaboration.md §Component 8).
//
// New behaviour of team.mjs with no unit file of its own (E-327's team.json rules are the
// tests/fixtures/team-cases.json table); the ai-log / ai-preflight skills reach it through
// `ai log path|recent` (cli-state.mjs), exercised at the end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { logPath, appendLog, recentLog, newTeam, writeTeam } from "../../src/mcp/shared/team.mjs";
import { main as cliState } from "../../src/shared/cli-state.mjs";

const A = "dev-a@example.com", B = "Dev.B+laptop@example.com";

/** A project with .ai/ and, when <shared> is not null, a team.json with shared_log = <shared>. */
function project(t, shared) {
  const d = mkdtempSync(join(tmpdir(), "aios-teamlog-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["config", "user.email", A], { cwd: d });
  mkdirSync(join(d, ".ai"));
  if (shared !== null) writeTeam(join(d, ".ai"), { ...newTeam(A, { E: [[1, 99]] }), shared_log: shared });
  return join(d, ".ai");
}

test("shared_log false (or no team.json): LOG.md, appended only when it exists — nothing changes", (t) => {
  for (const shared of [null, false]) {
    const ai = project(t, shared);
    assert.equal(logPath(ai, A), join(ai, "LOG.md"));
    assert.equal(appendLog(ai, "2026-10-22 | Claude | E-1 | x", A), null, "no LOG.md → not created");
    assert.equal(existsSync(join(ai, "log")), false);
    writeFileSync(join(ai, "LOG.md"), "# Log\n2026-10-20 | Claude | E-0 | old\n");
    assert.equal(appendLog(ai, "2026-10-22 | Claude | E-1 | x", A), join(ai, "LOG.md"));
    assert.deepEqual(recentLog(ai, 5), ["2026-10-20 | Claude | E-0 | old", "2026-10-22 | Claude | E-1 | x"]);
  }
});

test("shared_log true: two developers land in two tracked files, named by email local part", (t) => {
  const ai = project(t, true);
  assert.equal(logPath(ai, A), join(ai, "log", "dev-a.md"));
  assert.equal(logPath(ai, B), join(ai, "log", "dev.b-laptop.md"), "lowercased, plain charset");
  // No local part can name a path outside .ai/log: "/" is replaced, leading dots are stripped.
  assert.equal(logPath(ai, "a/b@x"), join(ai, "log", "a-b.md"));
  assert.equal(logPath(ai, ".hidden@x"), join(ai, "log", "hidden.md"));
  appendLog(ai, "2026-10-21 | Claude | E-5 | a first", A);
  appendLog(ai, "2026-10-22 | Claude | E-6 | b second", B);
  appendLog(ai, "2026-10-23 | Claude | E-7 | a third", A);
  assert.deepEqual(readdirSync(join(ai, "log")).sort(), ["dev-a.md", "dev.b-laptop.md"]);
  assert.equal(readFileSync(join(ai, "log", "dev-a.md"), "utf8"), "2026-10-21 | Claude | E-5 | a first\n2026-10-23 | Claude | E-7 | a third\n");
  assert.equal(existsSync(join(ai, "LOG.md")), false, "the gitignored LOG.md is not written");
});

test("recent: the newest entries across every developer's file, in date order", (t) => {
  const ai = project(t, true);
  appendLog(ai, "2026-10-21 | Claude | E-5 | a first", A);
  appendLog(ai, "2026-10-22 | Claude | E-6 | b second", B);
  appendLog(ai, "2026-10-23 | Claude | E-7 | a third", A);
  writeFileSync(join(ai, "log", "dev-a.md"), "# heading, not an entry\n" + readFileSync(join(ai, "log", "dev-a.md"), "utf8"));
  assert.deepEqual(recentLog(ai, 2), ["2026-10-22 | Claude | E-6 | b second", "2026-10-23 | Claude | E-7 | a third"]);
  assert.equal(recentLog(ai, 10).length, 3);
});

test("a broken team.json never makes a log line fail: it falls back to LOG.md", (t) => {
  const ai = project(t, null);
  writeFileSync(join(ai, "team.json"), "{ not json");
  assert.equal(logPath(ai, A), join(ai, "LOG.md"));
});

test("ai log path | recent — the CLI the ai-log and ai-preflight skills call", (t) => {
  const ai = project(t, true);
  const root = join(ai, "..");
  appendLog(ai, "2026-10-22 | Claude | E-6 | b second", B);
  assert.deepEqual(cliState(["log", "path"], root), { code: 0, out: join(ai, "log", "dev-a.md") });
  assert.deepEqual(cliState(["log", "recent", "-n", "5"], root), { code: 0, out: "2026-10-22 | Claude | E-6 | b second" });
  assert.equal(cliState(["log", "recent", "-n", "x"], root).code, 2);
});
