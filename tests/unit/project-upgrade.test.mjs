// tests/unit/project-upgrade.test.mjs — node:test unit suite for E-270 (D-074,
// version-lifecycle.md §Components 1-2): the template merge behind `rein init` as an upgrade,
// the provisioning stamp, and the single version source.
//
// The merge decides what to DELETE from a user's project files, so the cases that matter
// are the boundaries: a retired provider goes, a provider the framework never shipped
// stays; a role bound to a retired provider is rebound to the template default rather than
// left missing; unknown keys and custom values survive; a re-run never overwrites the
// pre-merge backup with an already-merged file.
//
// The end-to-end layer (installer into a fixture HOME, rein init/--check, doctor lines) is
// tests/suites/init_upgrade_test.sh.
//
//   node --test tests/unit/project-upgrade.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  mergeRoles, mergeProviders, retiredProviders, runMerge, runStamp, readProjectVersion,
} from "../../src/shared/project-upgrade.mjs";
import { getDb, getDbSeeded, stampProvisioning, readState } from "../../src/mcp/shared/state-db.js";
import { tcFixtureHome } from "../lib/toolchain-fixture.mjs";

// Run from the repo root (node_unit_test.sh cds there), so shipped files need no parent hop.
const ROOT = process.cwd();
const TEMPLATES = join(ROOT, "src", "templates");
const LEGACY = join(ROOT, "src", "config", "legacy-artefacts.json");

function tmp(tag = "upg") {
  const d = mkdtempSync(join(tmpdir(), `rein-t-${tag}-`));
  return { d, done: () => rmSync(d, { recursive: true, force: true }) };
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");

// A 3.0-shaped project: no tester, the architect on agy, agy+gemini providers, a
// user-added provider and user keys that must survive.
function seed30(aiDir) {
  mkdirSync(aiDir, { recursive: true });
  writeJson(join(aiDir, "roles.json"), {
    roles: {
      architect: { provider: "agy", pane_identifier: "1" },
      engineer: { provider: "claude", pane_identifier: "0", model: "opus", custom_note: "keep" },
    },
    x_user_key: 42,
  });
  writeJson(join(aiDir, "providers.json"), {
    providers: {
      claude: { workspace_dir: ".claude", launch: ["--my-flag"] },
      agy: { workspace_dir: ".agents" },
      gemini: { workspace_dir: ".gemini" },
      myllm: { workspace_dir: ".myllm" },
    },
  });
}

// ── the version source ────────────────────────────────────────────────────────

test("package.json and the CHANGELOG's newest released entry name the same version", () => {
  const pkg = readJson(join(ROOT, "package.json")).version;
  const top = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8")
    .split("\n").map((l) => l.match(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/)).find(Boolean);
  assert.ok(top, "CHANGELOG has a released ## [x.y.z] entry");
  assert.equal(top[1], pkg);
});

test("no version literal remains in src/bin/rein or install-rein.sh", () => {
  const ai = readFileSync(join(ROOT, "src", "bin", "rein"), "utf8");
  const inst = readFileSync(join(ROOT, "install-rein.sh"), "utf8");
  assert.doesNotMatch(ai, /^VERSION="\d+\.\d+\.\d+"/m, "src/bin/rein must not hard-code VERSION");
  assert.doesNotMatch(inst, /Rein v\d+\.\d+\.\d+/, "the installer must not print a typed version");
  assert.match(inst, /\$\{REIN\}\/VERSION/, "the installer writes ~/.rein/VERSION");
});

test("provider_history lists every provider the template ever shipped", () => {
  const reg = readJson(LEGACY);
  const tpl = readJson(join(TEMPLATES, "providers.json"));
  for (const p of Object.keys(tpl.providers)) assert.ok(reg.provider_history.includes(p), `${p} in provider_history`);
  for (const p of ["agy", "gemini"]) assert.ok(reg.provider_history.includes(p), `${p} (D-069) in provider_history`);
});

// ── pure merges ───────────────────────────────────────────────────────────────

test("retiredProviders: shipped-then-removed only; unknown names are never retired", () => {
  const r = retiredProviders({ claude: {} }, { provider_history: ["claude", "agy", "gemini"] });
  assert.deepEqual([...r].sort(), ["agy", "gemini"]);
  assert.equal(retiredProviders({ claude: {} }, null).size, 0, "no registry → nothing retired");
});

test("mergeProviders drops retired, keeps user-added and existing values, adds missing", () => {
  const { doc, changes } = mergeProviders(
    { providers: { claude: { launch: ["--mine"] }, agy: {}, myllm: { a: 1 } }, extra: true },
    { providers: { claude: { launch: ["--tpl"] }, newp: { b: 2 } } },
    new Set(["agy"]));
  assert.deepEqual(doc.providers.claude, { launch: ["--mine"] }, "existing value preserved");
  assert.ok(!("agy" in doc.providers));
  assert.deepEqual(doc.providers.myllm, { a: 1 });
  assert.deepEqual(doc.providers.newp, { b: 2 });
  assert.equal(doc.extra, true, "unknown top-level key preserved");
  assert.deepEqual(changes, ["-agy (retired provider)", "+newp"]);
});

test("mergeRoles rebinds a role whose provider is gone and adds missing roles", () => {
  const tpl = readJson(join(TEMPLATES, "roles.json"));
  const { doc, changes } = mergeRoles(
    { roles: { architect: { provider: "agy" }, engineer: { provider: "claude", custom: 1 } }, u: 1 },
    tpl, new Set(["claude"]));
  assert.deepEqual(doc.roles.architect, tpl.roles.architect, "architect back on the template default");
  assert.deepEqual(doc.roles.engineer, { provider: "claude", custom: 1 }, "engineer untouched");
  assert.deepEqual(doc.roles.tester, tpl.roles.tester, "tester added");
  assert.equal(doc.u, 1);
  assert.deepEqual(changes, ["~architect → template default", "+tester"]);
});

test("mergeRoles keeps a role bound to a user-added provider", () => {
  const { doc, changes } = mergeRoles({ roles: { architect: { provider: "myllm" } } },
    { roles: { architect: { provider: "claude" } } }, new Set(["claude", "myllm"]));
  assert.equal(doc.roles.architect.provider, "myllm");
  assert.deepEqual(changes, []);
});

// ── runMerge on disk ──────────────────────────────────────────────────────────

test("runMerge --check reports and writes nothing", () => {
  const t = tmp("chk");
  try {
    const ai = join(t.d, ".ai"); seed30(ai);
    const before = readFileSync(join(ai, "roles.json"), "utf8");
    const recs = runMerge({ aiDir: ai, templatesDir: TEMPLATES, legacyPath: LEGACY, version: "9.9.9", check: true });
    assert.deepEqual(recs.map((r) => [r.kind, r.file]), [["pending", ".ai/roles.json"], ["pending", ".ai/providers.json"]]);
    assert.equal(readFileSync(join(ai, "roles.json"), "utf8"), before);
    assert.ok(!existsSync(join(ai, "roles.pre-9.9.9.json")));
  } finally { t.done(); }
});

test("runMerge upgrades a 3.0-shaped project, keeps backups, and is idempotent", () => {
  const t = tmp("mrg");
  try {
    const ai = join(t.d, ".ai"); seed30(ai);
    const origRoles = readFileSync(join(ai, "roles.json"), "utf8");
    const recs = runMerge({ aiDir: ai, templatesDir: TEMPLATES, legacyPath: LEGACY, version: "9.9.9" });
    assert.equal(recs.filter((r) => r.kind === "merged").length, 2);
    const roles = readJson(join(ai, "roles.json"));
    const prov = readJson(join(ai, "providers.json"));
    assert.equal(roles.roles.architect.provider, "claude");
    assert.ok(roles.roles.tester, "tester role gained");
    assert.equal(roles.roles.engineer.custom_note, "keep");
    assert.equal(roles.x_user_key, 42);
    assert.deepEqual(Object.keys(prov.providers).sort(), ["claude", "myllm"]);
    assert.deepEqual(prov.providers.claude.launch, ["--my-flag"], "custom value intact");
    assert.equal(readFileSync(join(ai, "roles.pre-9.9.9.json"), "utf8"), origRoles, "pre-merge copy is the original");
    // Second run: nothing to do, and the backup still holds the ORIGINAL.
    assert.deepEqual(runMerge({ aiDir: ai, templatesDir: TEMPLATES, legacyPath: LEGACY, version: "9.9.9" }), []);
    assert.equal(readFileSync(join(ai, "roles.pre-9.9.9.json"), "utf8"), origRoles);
  } finally { t.done(); }
});

test("runMerge leaves an invalid JSON file untouched and reports it", () => {
  const t = tmp("bad");
  try {
    const ai = join(t.d, ".ai"); mkdirSync(ai);
    writeFileSync(join(ai, "roles.json"), "{ not json");
    const recs = runMerge({ aiDir: ai, templatesDir: TEMPLATES, legacyPath: LEGACY, version: "9.9.9" });
    assert.equal(recs[0].kind, "error");
    assert.equal(readFileSync(join(ai, "roles.json"), "utf8"), "{ not json");
  } finally { t.done(); }
});

// ── the stamp ─────────────────────────────────────────────────────────────────

const STATE_JSON = (extra = {}) => ({
  version: "1.0",
  project: { current_tier: null, release_verdict: null, focus: "f", ...extra },
  tasks: [{ id: "E-1", owner: "Engineer (Claude)", status: "OPEN", tier: 1, description: "d", created_at: "2026-01-01T00:00:00Z" }],
  stamps: [],
});

test("stampProvisioning rejects a non-semver version and is idempotent", () => {
  const t = tmp("stp");
  try {
    const ai = join(t.d, ".ai"); mkdirSync(ai);
    const db = getDb(ai);
    assert.equal(stampProvisioning(ai, db, { version: "v3" }).ok, false);
    const a = stampProvisioning(ai, db, { version: "3.1.0", at: "2026-01-01T00:00:00Z" });
    assert.equal(a.changed, true);
    const b = stampProvisioning(ai, db, { version: "3.1.0", at: "2027-01-01T00:00:00Z" });
    assert.equal(b.changed, false);
    assert.equal(readState(db).project.provisioned_at, "2026-01-01T00:00:00Z", "re-stamp keeps the original time");
  } finally { t.done(); }
});

test("runStamp seeds state.sqlite from state.json first, keeps tasks, never touches TASKS.md", async () => {
  const t = tmp("seed");
  try {
    const ai = join(t.d, ".ai"); mkdirSync(ai);
    writeJson(join(ai, "state.json"), STATE_JSON());
    writeFileSync(join(ai, "TASKS.md"), "hand-written\n");
    const recs = await runStamp({ aiDir: ai, version: "3.1.0" });
    assert.equal(recs[0].kind, "stamped");
    const s = readJson(join(ai, "state.json"));
    assert.equal(s.project.rein_version, "3.1.0");
    assert.equal(s.project.focus, "f");
    assert.equal(s.tasks.length, 1, "the seed import kept the task");
    assert.equal(readFileSync(join(ai, "TASKS.md"), "utf8"), "hand-written\n");
    assert.equal(readProjectVersion(ai), "3.1.0");
    assert.deepEqual(await runStamp({ aiDir: ai, version: "3.1.0" }), [], "idempotent");
    assert.equal((await runStamp({ aiDir: ai, version: "4.0.0", check: true }))[0].kind, "pending");
    assert.equal(readProjectVersion(ai), "3.1.0", "--check wrote nothing");
    // D-131: the public line restarts at 0.4.0 — a lower version restamps like any other.
    await runStamp({ aiDir: ai, version: "4.0.0" });
    const down = await runStamp({ aiDir: ai, version: "0.4.0" });
    assert.deepEqual(down.map((r) => [r.kind, r.detail]), [["stamped", "project.rein_version 4.0.0 → 0.4.0"]]);
    assert.equal(readProjectVersion(ai), "0.4.0");
  } finally { t.done(); }
});

test("runStamp refuses a state.json the import would skip (never empties state)", async () => {
  const t = tmp("skip");
  try {
    const ai = join(t.d, ".ai"); mkdirSync(ai);
    const odd = { ...STATE_JSON(), version: "2.0" };
    writeJson(join(ai, "state.json"), odd);
    const recs = await runStamp({ aiDir: ai, version: "3.1.0" });
    assert.equal(recs[0].kind, "error");
    assert.ok(!existsSync(join(ai, "state.sqlite")), "no store was created");
    assert.deepEqual(readJson(join(ai, "state.json")), odd);
  } finally { t.done(); }
});

test("the first-run import carries an existing stamp across", () => {
  const t = tmp("imp");
  try {
    const ai = join(t.d, ".ai"); mkdirSync(ai);
    writeJson(join(ai, "state.json"), STATE_JSON({ rein_version: "3.0.0", provisioned_at: "2025-01-01T00:00:00Z" }));
    const st = readState(getDbSeeded(ai));
    assert.equal(st.project.rein_version, "3.0.0");
    assert.equal(st.project.provisioned_at, "2025-01-01T00:00:00Z");
  } finally { t.done(); }
});

test("an unstamped project's view has no stamp keys (the view shape is unchanged)", () => {
  const t = tmp("view");
  try {
    const ai = join(t.d, ".ai"); mkdirSync(ai);
    assert.deepEqual(Object.keys(readState(getDb(ai)).project).sort(), ["current_tier", "focus", "release_verdict"]);
  } finally { t.done(); }
});

// ── COMM.md is tracked and committed per handoff (E-338, D-104) ─────────────────
// Extends this suite's "upgrade a user's project files" layer to the .ai/.gitignore that
// older templates wrote; the probe (src/shared/comm-status.sh) is the one detector doctor,
// preflight and the Stop hook share. Fixture repos only; the real pre-commit hook runs
// under a fixture HOME so nothing reaches ~/.rein.

const SKILLS_WITH_HANDOFF = [
  ".claude/skills/ai-handoff/SKILL.md", ".claude/skills/ai-task/SKILL.md",
  ".claude/skills/arch-task/SKILL.md", ".claude/skills/task-planner/SKILL.md",
  ".claude/skills/ai-archive/SKILL.md",
  "src/shared/skills/ai-handoff/SKILL.md", "src/shared/skills/ai-task/SKILL.md",
  "src/claude/skills/arch-task/SKILL.md", "src/claude/skills/task-planner/SKILL.md",
  "src/shared/skills/ai-archive/SKILL.md",
];

function fixtureRepo(t) {
  const home = mkdtempSync(join(tmpdir(), "rein-t-comm-home-"));
  tcFixtureHome(home);   // E-345 (D-109 r1): the toolchain record the hooks pin
  const dir = join(t.d, "r");
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", AI_TELEMETRY_DISABLE: "1" };
  const git = (...a) => execFileSync("git", a, { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  mkdirSync(dir);
  git("init", "-q", "-b", "master");
  for (const [k, v] of [["user.email", "a@example.com"], ["user.name", "a"], ["commit.gpgsign", "false"]]) git("config", k, v);
  mkdirSync(join(dir, ".ai"));
  const bash = (script) => spawnSync("bash", ["-c", script], { cwd: dir, env, encoding: "utf8" });
  return { dir, git, bash, env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// The function under test lives in src/bin/rein (a dispatcher that cannot be sourced): lift it.
const liftFn = (name) => {
  const src = readFileSync(join(ROOT, "src", "bin", "rein"), "utf8");
  const m = src.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, `${name} found in src/bin/rein`);
  return m[0];
};
const PROBE = `. '${join(ROOT, "src", "shared", "comm-status.sh")}'`;
const LOCATE_STUB = `rein_locate() { printf '%s' '${join(ROOT, "src")}'/"$1"; }`;

test("the template .gitignore does not ignore .ai/COMM.md (this repo and a rein init fixture)", () => {
  const t = tmp("comm-tpl");
  const f = fixtureRepo(t);
  try {
    writeFileSync(join(f.dir, ".ai", ".gitignore"), readFileSync(join(TEMPLATES, "_gitignore")));
    assert.equal(f.bash("git check-ignore -q --no-index .ai/COMM.md").status, 1, "fixture");
    const here = spawnSync("git", ["check-ignore", "-q", "--no-index", ".ai/COMM.md"], { cwd: ROOT });
    assert.equal(here.status, 1, "this repository");
  } finally { f.cleanup(); t.done(); }
});

test("rein sync removes only the COMM.md pattern from an old .ai/.gitignore", () => {
  const t = tmp("comm-sync");
  const f = fixtureRepo(t);
  try {
    const old = "SESSION.md\n\n# Contains cross-agent messages (may include sensitive context)\nCOMM.md\n\n# COMM.md.bak stays\nCOMM.md.bak\n";
    const gi = join(f.dir, ".ai", ".gitignore");
    writeFileSync(gi, old);
    f.git("add", "-A"); f.git("commit", "-q", "-m", "seed", "--no-verify");
    const r = f.bash(`${liftFn("_untrack_comm_gitignore")}\n_untrack_comm_gitignore .`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /removed COMM\.md/);
    assert.equal(r.stdout.trim().split("\n").length, 1, "one printed line");
    assert.equal(f.git("diff", "--numstat", "--", ".ai/.gitignore").trim(), "0\t1\t.ai/.gitignore", "one deletion");
    assert.equal(readFileSync(gi, "utf8"), old.replace("COMM.md\n\n# COMM.md.bak", "\n# COMM.md.bak"));
    const again = f.bash(`${liftFn("_untrack_comm_gitignore")}\n_untrack_comm_gitignore .`);
    assert.equal(again.stdout, "", "idempotent: a clean file is not touched");
  } finally { f.cleanup(); t.done(); }
});

test("every handoff-writing skill commits COMM.md with --only (both copies)", () => {
  for (const p of SKILLS_WITH_HANDOFF) {
    assert.match(readFileSync(join(ROOT, p), "utf8"), /git commit --only \.ai\/COMM\.md/, p);
  }
  assert.ok(!existsSync(join(ROOT, ".ai", "COMM_APPEND.md")), "the June orphan is deleted");
});

test("the ai-handoff commit step commits COMM.md alone and passes the real pre-commit with no stamp", () => {
  const t = tmp("comm-commit");
  const f = fixtureRepo(t);
  try {
    writeFileSync(join(f.dir, ".ai", ".gitignore"), readFileSync(join(TEMPLATES, "_gitignore")));
    mkdirSync(join(f.dir, "src"));
    writeFileSync(join(f.dir, "src", "a.js"), "x\n");
    writeFileSync(join(f.dir, ".ai", "COMM.md"), "# COMM\n");
    f.git("add", "-A"); f.git("commit", "-q", "-m", "seed", "--no-verify");
    const hook = join(f.dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/bash\nexec /bin/bash -p '${join(ROOT, "hooks", "pre-commit.sh")}' "$@"\n`);
    chmodSync(hook, 0o755);
    // An Engineer mid-task: source staged, then a handoff entry written.
    writeFileSync(join(f.dir, "src", "a.js"), "x\ny\n"); f.git("add", "src/a.js");
    writeFileSync(join(f.dir, ".ai", "COMM.md"), "# COMM\n---\n## Handoff — 2026-10-23 14:00 UTC\n");
    const skill = readFileSync(join(ROOT, ".claude/skills/ai-handoff/SKILL.md"), "utf8");
    const cmd = skill.split("\n").find((l) => l.startsWith("git add -- .ai/COMM.md && git commit --only .ai/COMM.md"));
    assert.ok(cmd, "the skill's commit line");
    const r = f.bash(cmd.replace("<YYYY-MM-DD HH:MM UTC>", "2026-10-23 14:00 UTC").replace("<Role>", "Engineer"));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(f.git("status", "--porcelain", "--", ".ai/COMM.md"), "");
    assert.match(f.git("log", "-1", "--format=%s"), /^chore\(\.ai\): COMM handoff /);
    assert.equal(f.git("show", "--name-only", "--format=", "HEAD").trim(), ".ai/COMM.md", "nothing else rode along");
    assert.equal(f.git("diff", "--cached", "--name-only").trim(), "src/a.js", "the staged source is still staged");
  } finally { f.cleanup(); t.done(); }
});

test("doctor: [COMM_IGNORED] with the pattern, [COMM_UNCOMMITTED] when dirty, nothing on a clean tree", () => {
  const t = tmp("comm-doc");
  const f = fixtureRepo(t);
  try {
    const doctor = () => f.bash(`${LOCATE_STUB}\n${liftFn("_doctor_comm_report")}\n_doctor_comm_report`).stdout;
    const probe = () => f.bash(`${PROBE}; rein_comm_status .`).stdout.trim();
    assert.equal(probe(), "absent");
    writeFileSync(join(f.dir, ".ai", ".gitignore"), "COMM.md\n");
    writeFileSync(join(f.dir, ".ai", "COMM.md"), "a\n");
    assert.equal(probe(), "IGNORED");
    assert.match(doctor(), /\[COMM_IGNORED\]/);
    writeFileSync(join(f.dir, ".ai", ".gitignore"), "");
    assert.equal(probe(), "UNCOMMITTED 1", "untracked counts the whole file");
    f.git("add", "-A"); f.git("commit", "-q", "-m", "c", "--no-verify");
    assert.equal(probe(), "tracked");
    assert.doesNotMatch(doctor(), /\[COMM_/);
    writeFileSync(join(f.dir, ".ai", "COMM.md"), "a\nb\nc\n");
    assert.equal(probe(), "UNCOMMITTED 2");
    assert.match(doctor(), /\[COMM_UNCOMMITTED\]/);
    // A rule still counts once the file is tracked (check-ignore --no-index).
    writeFileSync(join(f.dir, ".ai", ".gitignore"), "COMM.md\n");
    assert.equal(probe(), "IGNORED");
  } finally { f.cleanup(); t.done(); }
});
