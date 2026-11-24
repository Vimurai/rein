// role-settings.test.mjs — the shape of the role settings files (E-462, D-169 r3, D-170 r10).
// The shape is the configuration E-458 measured (plans/e-458-sandbox-measurement.md); whether
// that shape HOLDS is observed by tests/suites/sandbox_escape_test.sh in the real sandbox.
// Replaces pane_binding_test.sh's E-208.03 and E-213.02 content checks of the .claude/ overlays,
// which no longer exist: the files are generated under ~/.rein/roles/ (gap 3 of E-458).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  architectSettings, engineerSettings, architectDenyList, architectMcpConfig, roleDir, writeRoleFiles, paneRoles,
} from "../../src/shared/role-settings.mjs";

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rs-")));
  for (const d of [".ai", "plans", "src", ".git", ".claude"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "README.md"), "r");
  return root;
}

test("the Architect: sandbox on, no escape hatch, no network, dontAsk with only .ai/ and plans/ editable", () => {
  const p = project();
  try {
    const s = architectSettings(p);
    assert.deepEqual(
      [s.sandbox.enabled, s.sandbox.failIfUnavailable, s.sandbox.allowUnsandboxedCommands, s.sandbox.network.allowedDomains],
      [true, true, false, []]);
    assert.equal(s.permissions.defaultMode, "dontAsk");
    assert.equal(s.permissions.disableBypassPermissionsMode, "disable");
    assert.equal(s.permissions.disableAutoMode, "disable");
    assert.deepEqual(s.permissions.allow.filter((r) => r.startsWith("Edit(")), ["Edit(.ai/**)", "Edit(plans/**)"]);
    assert.ok(s.permissions.allow.includes("Bash"), "Bash must be allowed explicitly (E-458 notes)");
    assert.deepEqual(s.sandbox.filesystem.allowWrite, [join(p, ".ai"), join(p, "plans"), join(p, ".git")]);
    assert.equal(s.env.REIN_CALLER_ROLE, "architect");
    assert.equal(s.hooks, undefined, "a role file registers no hooks (E-208 double-run guard)");
  } finally { rmSync(p, { recursive: true, force: true }); }
});

test("the Architect's deny list: every top-level entry but .ai, plans and .git, HEAD, the lane ledger, forgeable refs, CLAUDE.local.md", () => {
  const p = project();
  try {
    const deny = architectDenyList(p);
    for (const e of [".claude", "README.md", "src", "CLAUDE.local.md"]) assert.ok(deny.includes(join(p, e)), e);
    for (const e of [".ai", "plans", ".git"]) assert.ok(!deny.includes(join(p, e)), e);
    assert.ok(deny.includes(join(p, ".git", "HEAD")) && deny.includes(join(p, ".git", "rein")));
    // F2 of the lean-core round: refs that could hide a commit from the lane check, and info/.
    for (const g of ["refs/remotes", "refs/replace", "packed-refs", "info"]) assert.ok(deny.includes(join(p, ".git", g)), g);
    assert.ok(deny.every((d) => d.startsWith(p + "/")), "absolute, inside the project");
  } finally { rmSync(p, { recursive: true, force: true }); }
});

test("a linked worktree: the git dir and the common dir are writable, the ledger is in the common dir", () => {
  const p = project();
  const main = realpathSync(mkdtempSync(join(tmpdir(), "rs-main-")));
  try {
    rmSync(join(p, ".git"), { recursive: true });
    mkdirSync(join(main, "worktrees", "w"), { recursive: true });
    writeFileSync(join(p, ".git"), `gitdir: ${join(main, "worktrees", "w")}\n`);
    writeFileSync(join(main, "worktrees", "w", "commondir"), "../..\n");
    const s = architectSettings(p);
    assert.deepEqual(s.sandbox.filesystem.allowWrite.slice(2), [join(main, "worktrees", "w"), main]);
    assert.ok(s.sandbox.filesystem.denyWrite.includes(join(main, "rein")));
    assert.ok(s.sandbox.filesystem.denyWrite.includes(join(main, "worktrees", "w", "HEAD")));
  } finally { rmSync(p, { recursive: true, force: true }); rmSync(main, { recursive: true, force: true }); }
});

test("the Engineer: every ~/.rein entry but ci/ and .claude/ write-denied, CI domains, no bypass", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rs-rein-")));
  try {
    for (const d of ["bin", "hooks", "roles", "ci"]) mkdirSync(join(home, d));
    writeFileSync(join(home, "VERSION"), "1");
    const s = engineerSettings("/proj", home);
    assert.deepEqual(s.sandbox.filesystem.denyWrite, ["VERSION", "bin", "hooks", "roles"].map((e) => join(home, e)).concat("/proj/.claude"));
    // A broad deny of ~/.rein would deny ci/ too (E-458 M1), and `rein ci run` writes there.
    assert.deepEqual(s.sandbox.filesystem.allowWrite, [join(home, "ci")]);
    assert.deepEqual([s.sandbox.failIfUnavailable, s.sandbox.allowUnsandboxedCommands], [true, false]);
    assert.ok(s.sandbox.network.allowedDomains.includes("github.com") && s.sandbox.network.allowedDomains.includes("registry.npmjs.org"));
    assert.ok(s.permissions.deny.includes(`Edit(/${join(home, "roles")}/**)`) && s.permissions.deny.includes(`Edit(/${join(home, "VERSION")})`));
    assert.equal(s.permissions.disableBypassPermissionsMode, "disable");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the Architect's MCP list holds only the state server, from the install tree", () => {
  assert.deepEqual(architectMcpConfig("/h/.rein"),
    { mcpServers: { "task-synchronizer-mcp": { command: "node", args: ["/h/.rein/mcp/task-synchronizer-mcp/index.js"] } } });
});

test("files go to ~/.rein/roles/<project key>; only claude pane roles; a traversal key writes nothing", () => {
  const p = project();
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rs-home-")));
  try {
    writeFileSync(join(p, ".ai", "roles.json"), JSON.stringify({ roles: {
      architect: { provider: "claude" }, engineer: { provider: "claude" }, tester: { provider: "claude", headless: true },
      "../../escape": { provider: "claude" } } }));
    assert.deepEqual(paneRoles(join(p, ".ai")), ["architect", "engineer"]);
    mkdirSync(join(p, ".git", "refs"));
    const written = writeRoleFiles({ aiDir: join(p, ".ai"), reinHome: home });
    // F2: the paths denied to the Architect exist before launch, so the sandbox puts no
    // placeholder there (an absent packed-refs broke git status and git commit).
    for (const g of ["refs/remotes", "refs/replace", "info", "packed-refs"]) assert.ok(existsSync(join(p, ".git", g)), g);
    assert.match(readFileSync(join(p, ".git", "packed-refs"), "utf8"), /^# pack-refs with:/);
    const dir = roleDir(p, home);
    assert.ok(dir.startsWith(join(home, "roles") + "/"));
    assert.deepEqual(written, [join(dir, "settings.architect.json"), join(dir, "mcp.architect.json"), join(dir, "settings.engineer.json")]);
    assert.equal(JSON.parse(readFileSync(written[0], "utf8")).permissions.defaultMode, "dontAsk");
    assert.ok(!existsSync(join(home, "escape")) && !existsSync(join(dir, "settings.tester.json")));
    // Another provider gets no claude file.
    writeFileSync(join(p, ".ai", "roles.json"), JSON.stringify({ roles: { architect: { provider: "acme" } } }));
    assert.deepEqual(paneRoles(join(p, ".ai")), []);
  } finally { rmSync(p, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
