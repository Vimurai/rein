// fitness.test.mjs — E-459 (D-169 r11, D-170 r15; lean-core.md §Component 6, §Data Model): the
// scorecard `rein doctor --fitness` prints. New file: nothing measured the scorecard before. Each
// test builds a fixture tree (a project that is also a Rein source tree, as this repository is)
// and runs src/shared/fitness.mjs on it as the CLI does. Needs `git` (the branch row); SKIPPED
// without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isGateTest, GATE_TASK_RE } from "../../src/shared/fitness.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FITNESS = join(repo, "src/shared/fitness.mjs");
const hasGit = spawnSync("git", ["--version"]).status === 0;
const ROWS = 13;

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], { env: gitEnv, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

function put(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
const nLines = (n, s = "x") => `${s}\n`.repeat(n);

/** A project + Rein tree. `fat` breaks every target the tree can break. */
function fixture({ fat = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "rein-fitness-"));
  const root = join(base, "proj"), reinHome = join(base, "rein-home");
  mkdirSync(root);
  for (const e of ["ci", "hooks", "mcp", "shared"]) mkdirSync(join(reinHome, e), { recursive: true });

  put(root, "CLAUDE.md", "@ENGINEER.md\n");
  put(root, "ENGINEER.md", "e".repeat(fat ? 3000 : 900) + "\n");
  put(root, "ARCHITECT.md", "a".repeat(800) + "\n");
  const brief = fat ? 1800 : 400;
  put(root, "hooks/session-start.sh",
    `printf '%s' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"${"b".repeat(brief)}"}}'\n`);
  put(root, "hooks/pre-commit.sh", nLines(fat ? 1000 : 100));

  const servers = { "task-synchronizer-mcp": { path: "src/mcp/task-synchronizer-mcp/index.js" } };
  if (fat) servers["safe-exec-mcp"] = { path: "src/mcp/safe-exec-mcp/index.js" };
  put(root, "src/config/registry.json", JSON.stringify({
    roles: { _comment: "x", architect: { skill_dirs: ["claude/skills"], agent_dirs: ["claude/agents"] },
      engineer: { skill_dirs: ["claude/skills"], agent_dirs: ["claude/agents"] }, shared: { skill_dirs: ["shared/skills"], agent_dirs: [] } },
    mcp_servers: servers,
  }));
  const skills = fat ? 7 : 3;
  for (let i = 0; i < skills; i++) put(root, `src/${i % 2 ? "shared" : "claude"}/skills/s${i}/SKILL.md`, "---\n");
  for (const a of ["reviewer", "critic_acceptance", ...(fat ? ["a3", "a4", "a5"] : [])]) put(root, `src/claude/agents/${a}.md`, "---\n");
  put(root, "src/bin/rein", 'gen="$(_rein_helper shared/role-settings.mjs)"\ncase "$cmd" in\n  done|handoff|decide|archive) ;;\nesac\n');
  put(root, "src/shared/cli-bookkeeping.mjs", "// SendMessage wake line\n");
  put(root, "src/shared/resolve-launch.mjs", 'const i = argv.indexOf("--settings"); roleDir(x);\n');
  if (fat) put(root, "src/mcp/safe-exec-mcp/index.js", nLines(400));
  put(root, "src/mcp/safe-exec-mcp/node_modules/dep/index.js", nLines(5000));

  put(root, "tests/unit/other.test.mjs", nLines(fat ? 100 : 990));
  put(root, "tests/unit/gate-rules.test.mjs", nLines(fat ? 900 : 10));
  put(root, "tests/suites/sandbox_escape_test.sh", nLines(500));

  const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `E-${i}`, status: "OPEN", description: `Add a widget ${i}` }));
  tasks[0].description = "Close the RM_RF_ROOT gap in safe-exec";
  if (fat) for (let i = 1; i < 6; i++) tasks[i].description = "Merge the gate table rows";
  tasks.push({ id: "E-99", status: "DONE", description: "safe-exec, closed" });
  put(root, ".ai/state.json", JSON.stringify({ tasks }));
  mkdirSync(join(root, "plans"));

  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  if (fat) {
    git(root, "checkout", "-q", "-b", "e-1-done");
    put(root, "x.txt", "x\n");
    git(root, "add", "x.txt");
    git(root, "commit", "-q", "-m", "work");
    git(root, "checkout", "-q", "main");
  }
  return { base, root, reinHome };
}

function run(f, ...extra) {
  const r = spawnSync(process.execPath, [FITNESS, "--root", f.root, "--rein-home", f.reinHome, ...extra], { encoding: "utf8", env: gitEnv });
  return r;
}
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

test("E-459.01 a lean tree: every computable row PASSes; adoptability is UNKNOWN with a reason", { skip: !hasGit && "git missing" }, () => {
  const f = fixture();
  try {
    const r = run(f, "--json");
    assert.equal(r.status, 0, r.stderr);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, ROWS);
    const m = byId(rows);
    for (const row of rows) {
      if (row.id === "install_steps") continue;
      assert.equal(row.result, "PASS", `${row.id}: ${row.value} vs ${row.target} — ${row.note}`);
    }
    assert.equal(m.install_steps.result, "UNKNOWN");
    assert.match(m.install_steps.note, /scratch HOME/);
    // CLAUDE.md (13) + ENGINEER.md (901) + the appended ENGINEER.md (901) + the brief (400).
    assert.equal(m.session_bytes.value, String(13 + 901 + 901 + 400));
    assert.equal(m.default_skills.value, "3");
    assert.equal(m.mcp_servers.value, "1");
    assert.equal(m.agents.value, "2");
    assert.equal(m.hook_lines.value, "101");
    assert.equal(m.role_guarantees.value, "5 of 5");
    assert.equal(m.command_text_lines.value, "0", "node_modules is not counted");
    assert.equal(m.open_gate_task_share.value, "1 of 20 (5.0%)", "a DONE task is not open");
    assert.equal(m.gate_test_share.value, "0.7% (10 of 1500 lines)", "sandbox_escape is not a gate test");
    assert.equal(m.unmerged_branches.value, "0");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("E-459.02 a fat tree: each broken target prints FAIL with the computed value; text mode exits 0", { skip: !hasGit && "git missing" }, () => {
  const f = fixture({ fat: true });
  try {
    const m = byId(JSON.parse(run(f, "--json").stdout));
    const fail = (id, value) => { assert.equal(m[id].result, "FAIL", id); assert.equal(m[id].value, value, id); };
    fail("session_bytes", String(13 + 3001 + 3001 + 1800));
    fail("default_skills", "7");
    fail("mcp_servers", "2");
    fail("agents", "5");
    fail("hook_lines", "1001");
    fail("command_text_lines", "400");
    fail("open_gate_task_share", "6 of 20 (30.0%)");
    fail("gate_test_share", "60.0% (900 of 1500 lines)");
    fail("unmerged_branches", "1");
    assert.match(m.unmerged_branches.note, /e-1-done/);
    const t = run(f);
    assert.equal(t.status, 0);
    assert.equal(t.stdout.split("\n").filter((l) => /\s(PASS|FAIL|UNKNOWN)$/.test(l)).length, ROWS);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("E-459.03 a guarantee the settings do not hold, and a CLI that does not launch with them, lower the count", { skip: !hasGit && "git missing" }, () => {
  const f = fixture();
  try {
    rmSync(join(f.reinHome), { recursive: true, force: true });   // no install tree: nothing to write-deny
    assert.equal(byId(JSON.parse(run(f, "--json").stdout)).role_guarantees.value, "4 of 5");
    put(f.root, "src/shared/resolve-launch.mjs", "// launches without the role file\n");
    const g = byId(JSON.parse(run(f, "--json").stdout)).role_guarantees;
    assert.equal(g.value, "0 of 5");
    assert.match(g.note, /does not launch with the role settings/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("E-459.04 nothing to measure: UNKNOWN with the reason, never a guess; still exit 0 and every row", () => {
  const base = mkdtempSync(join(tmpdir(), "rein-fitness-empty-"));
  try {
    const r = spawnSync(process.execPath, [FITNESS, "--json", "--root", base, "--rein-home", join(base, "none")], { encoding: "utf8", env: { ...gitEnv, GIT_CEILING_DIRECTORIES: base } });
    assert.equal(r.status, 0, r.stderr);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, ROWS);
    for (const id of ["session_bytes", "default_skills", "mcp_servers", "agents", "bookkeeping_calls", "hook_lines", "open_gate_task_share", "gate_test_share", "unmerged_branches"]) {
      const row = byId(rows)[id];
      assert.equal(row.result, "UNKNOWN", id);
      assert.equal(row.value, "UNKNOWN", id);
      assert.ok(row.note.length > 0, `${id} names its reason`);
    }
    assert.equal(spawnSync(process.execPath, [FITNESS, "--bogus"]).status, 2);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("E-459.05 the gate's file-name set and the task matcher", () => {
  for (const f of ["tests/suites/safe_exec_test.sh", "tests/suites/pre_tool_use_gate_test.sh", "tests/unit/gate-rules.test.mjs",
    "tests/fixtures/arch-write-cases.json", "tests/lib/check-table.mjs", "tests/suites/role_token_test.sh", "tests/unit/operand-scope.test.mjs"]) {
    assert.ok(isGateTest(f), f);
  }
  for (const f of ["tests/suites/sandbox_escape_test.sh", "tests/unit/completion-gates.test.mjs", "tests/unit/rename-gate.test.mjs",
    "tests/unit/privacy-cases.test.mjs", "tests/unit/traversal-policy.test.mjs"]) {
    assert.ok(!isGateTest(f), f);
  }
  assert.ok(GATE_TASK_RE.test("Close the cwd spellings of RM_RF_ROOT"));
  assert.ok(GATE_TASK_RE.test("Retire the test_lines ratchet"));
  assert.ok(!GATE_TASK_RE.test("Record ARCH_PASS for the task"), "a stamp is not a gate rule");
  assert.ok(!GATE_TASK_RE.test("Build the digest builder"));
});
