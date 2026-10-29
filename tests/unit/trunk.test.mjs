// trunk.test.mjs — the trunk resolver (E-341, D-105 r1-r4).
//
// New module, new file. The fixture is one local repository whose refs/remotes/origin/* are
// written with update-ref / symbolic-ref: the resolver reads refs only, so no origin is needed,
// and a FETCH_HEAD appearing would mean it touched the network. The claim paths that consume
// it (main trunk end to end, the ambiguous refusal) extend tests/unit/task-claims.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { resolveTrunk, discoverTrunk, trunkDoctor } from "../../src/mcp/shared/trunk.mjs";
import { validateTeam } from "../../src/mcp/shared/team.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const TEAM = { schema: 1, planner: "a@example.com", claim_ttl_days: 7, shared_log: false, members: {} };

// refs: the branches under refs/remotes/origin/; head: origin/HEAD's target; trunk: team.json's.
function repo(t, { refs = [], head = null, trunk } = {}) {
  const d = mkdtempSync(join(tmpdir(), "aios-trunk-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(d, "init", "-q", "-b", "work");
  git(d, "-c", "user.email=a@example.com", "-c", "user.name=a", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "seed");
  for (const r of refs) git(d, "update-ref", `refs/remotes/origin/${r}`, "HEAD");
  if (head) git(d, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${head}`);
  if (trunk !== undefined) {
    mkdirSync(join(d, ".ai"));
    writeFileSync(join(d, ".ai", "team.json"), JSON.stringify({ ...TEAM, trunk }) + "\n");
  }
  return d;
}

const CASES = [
  // [label, fixture, expected]
  ["team.json trunk wins over origin/HEAD (r4)", { refs: ["main", "dev"], head: "main", trunk: "dev" }, { name: "dev", source: "team.json" }],
  ["team.json trunk is used even before origin has it (the claim reports TRUNK_MISSING)", { trunk: "release" }, { name: "release", source: "team.json" }],
  ["origin/HEAD names a branch outside main|master", { refs: ["main", "master", "develop"], head: "develop" }, { name: "develop", source: "origin/HEAD" }],
  ["only origin/main", { refs: ["main", "feature"] }, { name: "main", source: "origin/main" }],
  ["only origin/master", { refs: ["master"] }, { name: "master", source: "origin/master" }],
];

for (const [label, fx, want] of CASES) {
  test(`resolveTrunk: ${label}`, (t) => {
    const d = repo(t, fx);
    assert.deepEqual(resolveTrunk(d), want);
    assert.equal(existsSync(join(d, ".git", "FETCH_HEAD")), false, "no network");
  });
}

test("resolveTrunk: both main and master with no origin/HEAD is TRUNK_AMBIGUOUS; neither is NO_TRUNK", (t) => {
  const amb = resolveTrunk(repo(t, { refs: ["main", "master"] }));
  assert.equal(amb.name, null);
  assert.equal(amb.reason, "TRUNK_AMBIGUOUS");
  assert.equal(amb.message, '[NO_TRUNK] TRUNK_AMBIGUOUS: origin has both main and master and no origin/HEAD — set "trunk" in .ai/team.json (or: git remote set-head origin --auto)');
  const none = resolveTrunk(repo(t, { refs: ["feature"] }));
  assert.equal(none.reason, "NO_TRUNK");
  assert.match(none.message, /^\[NO_TRUNK\] NO_TRUNK: no origin\/HEAD and neither origin\/main nor origin\/master — /);
});

test("validateTeam: trunk must be a plain branch name (r1)", () => {
  for (const ok of ["main", "master", "release/4.x"]) assert.doesNotThrow(() => validateTeam({ ...TEAM, trunk: ok }), ok);
  assert.doesNotThrow(() => validateTeam(TEAM), "trunk is optional");
  for (const bad of ["refs/heads/x", "a..b", "@{-1}", "-x", "HEAD", "two words", "", 7]) {
    assert.throws(() => validateTeam({ ...TEAM, trunk: bad }), /trunk must be a valid branch name/, JSON.stringify(bad));
  }
});

// discoverTrunk is the operator path `ai state migrate --team` takes for a NEW team.json: it may
// ask origin once (ls-remote), never set-head. The fixture is a real bare origin whose HEAD
// names main, cloned, with the clone's origin/HEAD removed so only ls-remote can answer.
test("discoverTrunk: --trunk, else origin/HEAD, else ls-remote; refuses with the flag named", (t) => {
  const d = mkdtempSync(join(tmpdir(), "aios-trunk-disc-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const origin = join(d, "origin.git"), seed = join(d, "seed"), c = join(d, "c");
  git(d, "init", "-q", "--bare", "-b", "main", origin);
  git(d, "init", "-q", "-b", "main", seed);
  git(seed, "-c", "user.email=a@example.com", "-c", "user.name=a", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "seed");
  git(seed, "push", "-q", origin, "main");
  git(d, "clone", "-q", origin, c);
  assert.deepEqual(discoverTrunk(c, "release/4.x"), { name: "release/4.x", source: "--trunk" });
  assert.match(discoverTrunk(c, "refs/heads/x").message, /^\[NO_TRUNK\] --trunk "refs\/heads\/x" is not a valid branch name$/);
  assert.deepEqual(discoverTrunk(c), { name: "main", source: "origin/HEAD" });
  git(c, "remote", "set-head", "origin", "-d");
  assert.deepEqual(discoverTrunk(c), { name: "main", source: "origin (ls-remote)" });
  assert.throws(() => git(c, "symbolic-ref", "-q", "refs/remotes/origin/HEAD"), "ls-remote wrote no origin/HEAD (no set-head, r3)");
  const lone = repo(t, {});
  assert.equal(discoverTrunk(lone).message, "[NO_TRUNK] origin's default branch could not be determined — pass --trunk <name>");
});

test("trunkDoctor: [TRUNK_UNSET] names the resolved branch, [TRUNK_MISMATCH] when team.json and origin/HEAD differ, nothing when they agree", (t) => {
  const unset = repo(t, { refs: ["main"], trunk: undefined });
  mkdirSync(join(unset, ".ai"));
  writeFileSync(join(unset, ".ai", "team.json"), JSON.stringify(TEAM) + "\n");
  assert.deepEqual(trunkDoctor(unset), ['[TRUNK_UNSET] .ai/team.json has no trunk — resolved main from origin/main; add "trunk": "main"']);
  assert.deepEqual(trunkDoctor(repo(t, { refs: ["main", "dev"], head: "main", trunk: "dev" })), ["[TRUNK_MISMATCH] team.json trunk=dev, origin/HEAD=main — claims use dev"]);
  assert.deepEqual(trunkDoctor(repo(t, { refs: ["main"], head: "main", trunk: "main" })), []);
  assert.deepEqual(trunkDoctor(repo(t, { refs: ["main"] })), [], "no team.json: nothing to say");
});
