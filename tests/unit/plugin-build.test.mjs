// plugin-build.test.mjs — E-469 (D-170 r4, lean-core.md §Revision 2 Packaging): the rein Claude
// Code plugin that `rein install` builds into <rein-home>/plugin. New file: it replaces what
// mirror_hygiene_test E-273.2 observed in a project's .claude/agents (a source agent reaching the
// project, a dropped one leaving it) — the agents now reach Claude Code through the plugin, so the
// rows below observe the plugin folder instead. Each test builds a fixture install home from the
// repository's own templates and registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlugin, hooksDoc, pluginUnits, provisioned, PLUGIN_HOOKS, PLUGIN_ID } from "../../src/shared/plugin-build.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILD = join(repo, "src/shared/plugin-build.mjs");

/** An install home shaped as install-rein.sh leaves it, from this checkout's sources. */
function home() {
  const base = mkdtempSync(join(tmpdir(), "rein-plugin-"));
  const h = join(base, ".rein");
  for (const t of ["claude", "config"]) cpSync(join(repo, "src", t), join(h, t), { recursive: true });
  cpSync(join(repo, "src/shared/skills"), join(h, "shared/skills"), { recursive: true });
  mkdirSync(join(h, "hooks"));
  for (const s of ["session-start.sh", "waiting-signal.sh", "pre-tool-use.sh"]) writeFileSync(join(h, "hooks", s), "#!/bin/bash\nexit 0\n");
  writeFileSync(join(h, "VERSION"), "9.8.7\n");
  return { base, h };
}
const json = (p) => JSON.parse(readFileSync(p, "utf8"));

test("the build carries the registry's agents and skills, the manifest and the marketplace", (t) => {
  const { base, h } = home();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const r = buildPlugin({ reinHome: h });
  const p = join(h, "plugin");
  const want = provisioned(h);
  assert.deepEqual(r.agents, want.agents);
  assert.deepEqual(r.skills, want.skills);
  assert.equal(want.agents.length, 4, `the four kept agents: ${want.agents}`);
  assert.deepEqual(readdirSync(join(p, "agents")).sort(), want.agents.map((a) => `${a}.md`));
  for (const a of want.agents) assert.equal(readFileSync(join(p, "agents", `${a}.md`), "utf8"), readFileSync(join(h, "claude/agents", `${a}.md`), "utf8"));
  for (const s of want.skills) assert.ok(existsSync(join(p, "skills", s, "SKILL.md")), s);
  const m = json(join(p, ".claude-plugin/plugin.json"));
  assert.equal(m.name, "rein");
  assert.equal(m.version, "9.8.7", "the version is the install's VERSION");
  const mk = json(join(p, ".claude-plugin/marketplace.json"));
  assert.equal(`${mk.plugins[0].name}@${mk.name}`, PLUGIN_ID);
  assert.equal(mk.plugins[0].source, "./", "the plugin is the marketplace folder itself (loaded in place)");
});

test("hooks.json: every row exec form /bin/bash -p <absolute script>, timeout 30; the gate is not one of them", (t) => {
  const { base, h } = home();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  buildPlugin({ reinHome: h });
  const doc = json(join(h, "plugin/hooks/hooks.json"));
  assert.deepEqual(doc, hooksDoc(join(h, "hooks")));
  let n = 0;
  for (const [ev, lst] of Object.entries(doc.hooks)) {
    for (const e of lst) {
      for (const hk of e.hooks) {
        n++;
        assert.equal(hk.command, "/bin/bash", ev);
        assert.equal(hk.args[0], "-p", ev);
        assert.ok(hk.args[1].startsWith(join(h, "hooks") + "/"), `${ev}: ${hk.args[1]}`);
        assert.ok(!hk.args[1].includes("${"), "no variable: the absolute install path (E-290)");
        assert.equal(hk.timeout, 30);
        assert.notEqual(hk.args[1].split("/").pop(), "pre-tool-use.sh", "the gate stays in project settings while E-463 is held");
      }
    }
  }
  assert.equal(n, PLUGIN_HOOKS.length);
  const ss = doc.hooks.SessionStart.find((e) => e.hooks[0].args[1].endsWith("session-start.sh"));
  assert.equal(ss.matcher, "startup|resume|clear|compact", "a /clear issues a new session id that needs its own token (E-294)");
  assert.equal(ss.hooks[0].args.length, 2, "no role argument: the role is the launch record's (D-087)");
});

test("a rebuild follows the source: an added agent appears, a dropped one goes (was E-273.2 in a project)", (t) => {
  const { base, h } = home();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(join(h, "claude/agents/zz_retiring.md"), "---\nname: zz_retiring\n---\nbody\n");
  buildPlugin({ reinHome: h });
  assert.ok(existsSync(join(h, "plugin/agents/zz_retiring.md")));
  rmSync(join(h, "claude/agents/zz_retiring.md"));
  buildPlugin({ reinHome: h });
  assert.ok(!existsSync(join(h, "plugin/agents/zz_retiring.md")));
  assert.ok(existsSync(join(h, "plugin/agents/critic_acceptance.md")));
  assert.deepEqual(readdirSync(h).filter((e) => e.startsWith(".plugin.")), [], "no swap leftovers");
});

test("a build that cannot complete leaves the previous plugin in place and says why", (t) => {
  const { base, h } = home();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  buildPlugin({ reinHome: h });
  rmSync(join(h, "hooks/waiting-signal.sh"));
  const r = spawnSync(process.execPath, ["--no-warnings", BUILD, "build", "--rein-home", h], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[PLUGIN_BUILD_FAILED\] hook script\(s\) missing .*waiting-signal\.sh/);
  assert.ok(existsSync(join(h, "plugin/hooks/hooks.json")), "the old plugin is still there");
  const u = pluginUnits(h);
  assert.deepEqual(u.hooks, ["session-start.sh", "waiting-signal.sh"]);
  assert.equal(u.agents.length, 4);
  assert.equal(spawnSync(process.execPath, ["--no-warnings", BUILD, "build"], { encoding: "utf8" }).status, 2, "bad arguments");
});

test("two different skills under one name are refused, the same one twice is not (was E-217.04 in sync)", (t) => {
  const { base, h } = home();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  cpSync(join(h, "shared/skills/rein-test"), join(h, "claude/skills/rein-test"), { recursive: true });
  assert.doesNotThrow(() => buildPlugin({ reinHome: h }), "identical content is one skill");
  writeFileSync(join(h, "claude/skills/rein-test/SKILL.md"), "---\nname: rein-test\ndescription: another\n---\nx\n");
  assert.throws(() => buildPlugin({ reinHome: h }), /two different units under one name: rein-test .*D-055 R2 precedent/);
  assert.ok(existsSync(join(h, "plugin/skills/rein-test/SKILL.md")), "the previous build stays");
});

test("claude plugin validate accepts the built plugin (needs the claude CLI)", (t) => {
  if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) { t.skip("the claude CLI is not on PATH"); return; }
  const { base, h } = home();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  buildPlugin({ reinHome: h });
  const r = spawnSync("claude", ["plugin", "validate", join(h, "plugin")], { encoding: "utf8", env: { ...process.env, HOME: base, CLAUDE_CONFIG_DIR: join(base, ".claude") } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Validation passed/);
  for (const a of ["reviewer", "critic_acceptance", "security_engineer", "test_engineer"]) assert.match(r.stdout, new RegExp(`agents: rein:${a}\\b`));
});
