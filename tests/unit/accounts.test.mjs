// tests/unit/accounts.test.mjs — the Claude account registry (E-314, D-095, accounts.md §1 and §4)
//
// src/shared/accounts.py is the one resolver and validator of account names and config
// directories; src/bin/rein-account.sh is the `rein account` glue around it. The resolver is a
// table (name/dir → exit code + first token); the glue is a process boundary (a throwaway
// HOME, a stub `claude` on PATH), so both are driven from node:test rather than a bash suite.
// Nothing here reads or writes the operator's ~/.claude, ~/.rein or Keychain.
//
// Run standalone: node --test tests/unit/accounts.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, symlinkSync, chmodSync, copyFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = join(REPO, "src", "shared", "accounts.py");
const AI = join(REPO, "src", "bin", "rein");

function fixtureHome() {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "rein-t-acct-")));
  mkdirSync(join(h, ".claude", "projects", "p"), { recursive: true });
  mkdirSync(join(h, "stub"));
  return { h, done: () => rmSync(h, { recursive: true, force: true }) };
}

const py = (...args) => {
  const r = spawnSync("python3", ["-I", PY, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim() };
};

// A stub `claude` whose `auth status` reports the directory it was started under, or
// STUB_REPORT when set (the MISMATCH case). It never logs anyone in.
function stubClaude(h) {
  const f = join(h, "stub", "claude");
  writeFileSync(f, '#!/bin/bash\nd="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; [ -n "$STUB_REPORT" ] && d="$STUB_REPORT"\n' +
    'printf \'{"loggedIn": false, "authMethod": "none", "configDirectory": "%s"}\\n\' "$d"\n');
  chmodSync(f, 0o755);
}

const ai = (h, args, env = {}) => {
  const r = spawnSync("/bin/bash", [AI, ...args], {
    encoding: "utf8", input: "",
    // TMUX_TMPDIR: tmux finds its server by socket dir, not HOME — without it the in-use
    // check reads the operator's own panes (a running 'work' pane failed `remove work`).
    env: { HOME: h, PATH: `${join(h, "stub")}:/usr/bin:/bin`, TMUX_TMPDIR: h, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test("resolver table: names, directories, registration (accounts.py)", () => {
  const { h, done } = fixtureHome();
  try {
    const reg = join(h, ".rein", "accounts.json");
    mkdirSync(join(h, ".claude-work"));
    symlinkSync("/tmp", join(h, "escape"));
    mkdirSync(join(h, "repo", ".git"), { recursive: true });
    mkdirSync(join(h, "shared"), { mode: 0o777 }); chmodSync(join(h, "shared"), 0o777);
    // [label, argv, exit, first token]
    const rows = [
      ["valid name + dir", ["check", h, "work", join(h, ".claude-work")], 0, join(h, ".claude-work")],
      ["reserved name", ["check", h, "default", join(h, ".claude-x")], 2, "INVALID"],
      ["upper-case name", ["check", h, "Work", join(h, ".claude-x")], 2, "INVALID"],
      ["name too long", ["check", h, "a".repeat(25), join(h, ".claude-x")], 2, "INVALID"],
      ["relative dir", ["check", h, "w", ".claude-w"], 5, "BADDIR"],
      ["dir outside HOME", ["check", h, "w", "/tmp/claude-w"], 5, "BADDIR"],
      ["dir with ..", ["check", h, "w", `${h}/x/../.claude-w`], 5, "BADDIR"],
      ["dir = ~/.claude", ["check", h, "w", join(h, ".claude")], 5, "BADDIR"],
      ["dir = HOME", ["check", h, "w", h], 5, "BADDIR"],
      ["symlink leaving HOME", ["check", h, "w", join(h, "escape")], 5, "BADDIR"],
      // Security review of E-314 — each row was ACCEPTED before the fix:
      ["name with a trailing newline", ["check", h, "work\n", join(h, ".claude-x")], 2, "INVALID"],
      ["symlinked parent of a new dir leaves HOME", ["check", h, "w", join(h, "escape", "acct")], 5, "BADDIR"],
      ["inside ~/.claude", ["check", h, "w", join(h, ".claude", "sub")], 5, "BADDIR"],
      ["inside ~/.rein", ["check", h, "w", join(h, ".rein", "hooks")], 5, "BADDIR"],
      ["inside a git working tree", ["check", h, "w", join(h, "repo", "acct")], 5, "BADDIR"],
      ["under a world-writable dir", ["check", h, "w", join(h, "shared", "acct")], 5, "BADDIR"],
      ["unregistered", ["resolve", reg, h, "work"], 4, "UNREGISTERED"],
      ["add", ["add", reg, h, "work", join(h, ".claude-work"), "2026-10-13"], 0, "ADDED"],
      ["duplicate", ["add", reg, h, "work", join(h, ".claude-work"), "2026-10-13"], 2, "DUPLICATE"],
      ["registered + present", ["resolve", reg, h, "work"], 0, join(h, ".claude-work")],
      ["add a second, dir not created", ["add", reg, h, "gone", join(h, ".claude-gone"), "2026-10-13"], 0, "ADDED"],
      ["missing dir", ["resolve", reg, h, "gone"], 6, "MISSING"],
      ["remove", ["remove", reg, h, "gone"], 0, "REMOVED"],
      ["removed is unregistered", ["resolve", reg, h, "gone"], 4, "UNREGISTERED"],
    ];
    for (const [label, argv, code, tok] of rows) {
      const r = py(...argv);
      assert.equal(r.code, code, `${label}: exit ${r.code} (${r.out})`);
      assert.equal(r.out.split("\t")[0], tok, `${label}: ${r.out}`);
    }
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(reg, "utf8")).accounts), ["work"]);
    // A registry that is not exactly the shape is refused whole, never half-read.
    for (const [label, body] of [
      ["duplicate key", '{"accounts": {"w": {"config_dir": "/x"}, "w": {"config_dir": "/y"}}}'],
      ["a stored 'default'", `{"accounts": {"default": {"config_dir": "${h}/.claude-d"}}}`],
      ["a row outside HOME", '{"accounts": {"w": {"config_dir": "/etc"}}}'],
      ["not an object", "[]"],
      ["an unknown root key", '{"accounts": {}, "x": 1}'],
      ["an unknown row key", `{"accounts": {"w": {"config_dir": "${h}/.claude-w", "env": "x"}}}`],
      ["'added' forging a row", `{"accounts": {"w": {"config_dir": "${h}/.claude-w", "added": "x\\nevil\\t/outside\\t-"}}}`],
    ]) {
      writeFileSync(reg, body);
      const r = py("list", reg, h);
      assert.equal(r.code, 3, `${label}: exit ${r.code} (${r.out})`);
      assert.match(r.out, /^UNPARSABLE\t/, label);
    }
  } finally { done(); }
});

test("rein account add: creates, seeds by copy, registers; ~/.claude untouched, nothing private copied", () => {
  const { h, done } = fixtureHome();
  try {
    stubClaude(h);
    const c = join(h, ".claude");
    for (const [f, body] of [["settings.json", '{"model":"opus"}\n'], ["keybindings.json", "[]\n"], ["CLAUDE.md", "# me\n"],
      [".credentials.json", "SECRET\n"], ["history.jsonl", "{}\n"]]) writeFileSync(join(c, f), body);
    for (const d of ["sessions", "skills/synced", "plugins/synced", "file-history"]) mkdirSync(join(c, d), { recursive: true });
    const before = readdirSync(c, { recursive: true }).sort().join("\n");

    const r = ai(h, ["account", "add", "work"]);
    assert.equal(r.code, 0, r.out + r.err);
    const dir = join(h, ".claude-work");
    assert.deepEqual(readdirSync(dir).sort(), ["CLAUDE.md", "keybindings.json", "settings.json"],
      "only the operator layer is seeded");
    assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), '{"model":"opus"}\n');
    assert.match(r.out, /empty memory there/, "the per-account memory notice is printed");
    assert.match(r.out, /claude\.ai logins/, "the claude.ai-only notice is printed");
    assert.match(r.out, /CLAUDE_CONFIG_DIR=\S+ claude/, "no TTY → the /login recipe, not a launch");
    assert.equal(readdirSync(c, { recursive: true }).sort().join("\n"), before, "~/.claude is unchanged");
    const reg = JSON.parse(readFileSync(join(h, ".rein", "accounts.json"), "utf8"));
    assert.equal(reg.accounts.work.config_dir, dir);

    // A directory that already holds a seeded file (a prior login) keeps it AND is registered:
    // copy's EXISTS is exit 1, which once ended the add under `set -e` before the registry write.
    const pre = join(h, ".claude-pre");
    mkdirSync(pre); writeFileSync(join(pre, "settings.json"), '{"mine":1}\n');
    const p = ai(h, ["account", "add", "pre"]);
    assert.equal(p.code, 0, p.out + p.err);
    assert.match(p.out, /settings\.json: kept the one already in/);
    assert.equal(readFileSync(join(pre, "settings.json"), "utf8"), '{"mine":1}\n');
    assert.equal(JSON.parse(readFileSync(join(h, ".rein", "accounts.json"), "utf8")).accounts.pre.config_dir, pre);

    assert.equal(ai(h, ["account", "add", "work"]).code, 2, "a registered name is refused");
    assert.equal(ai(h, ["account", "add", "default"]).code, 2, "the reserved name is refused");
    assert.equal(ai(h, ["account", "add", "x", "--dir", "/tmp/x"]).code, 2, "a directory outside HOME is refused");
  } finally { done(); }
});

test("rein account list: default first, login from claude auth status, MISMATCH when it reports another dir", () => {
  const { h, done } = fixtureHome();
  try {
    stubClaude(h);
    writeFileSync(join(h, ".claude", "settings.json"), "{}\n");
    assert.equal(ai(h, ["account", "add", "work"]).code, 0);
    let r = ai(h, ["account", "list"]);
    assert.equal(r.code, 0, r.err);
    const rows = r.out.trim().split("\n");
    assert.match(rows[1], /^default\s+~\/\.claude\s+yes\s+logged out/);
    assert.match(rows[2], /^work\s+~\/\.claude-work\s+yes\s+logged out\s+same$/);
    r = ai(h, ["account", "list"], { STUB_REPORT: "/somewhere/else" });
    assert.match(r.out, /^work .*MISMATCH \(claude reports \/somewhere\/else\)/m);
    writeFileSync(join(h, ".claude-work", "settings.json"), '{"x":1}\n');
    assert.match(ai(h, ["account", "list"]).out, /^work .* differs$/m, "a drifted copy reads 'differs'");
    // remove unregisters only: the directory and its login stay.
    r = ai(h, ["account", "remove", "work"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(h, ".claude-work", "settings.json")));
    assert.equal(ai(h, ["account", "remove", "work"]).code, 2, "removing an unregistered name is refused");
  } finally { done(); }
});

test("copy never writes through a link at the destination (seeding and sync)", () => {
  const { h, done } = fixtureHome();
  try {
    const src = join(h, ".claude", "settings.json"), victim = join(h, "victim");
    writeFileSync(src, '{"model":"opus"}\n'); writeFileSync(victim, "keep\n");
    const dst = join(h, "dst.json");
    symlinkSync(victim, dst);
    assert.equal(py("copy", src, dst).out, "EXISTS", "a link at dst counts as present: nothing is written");
    assert.equal(readFileSync(victim, "utf8"), "keep\n");
    assert.equal(py("copy", src, dst, "--replace").out, "COPIED");
    assert.ok(!lstatSync(dst).isSymbolicLink(), "--replace replaces the link with a file");
    assert.equal(readFileSync(victim, "utf8"), "keep\n", "…and never writes through it");
    assert.equal(lstatSync(dst).mode & 0o777, 0o600);
  } finally { done(); }
});

test("an exported bash function cannot stand in for the account library (E-223 class)", () => {
  const { h, done } = fixtureHome();
  try {
    // A copy of ai WITHOUT rein-account.sh beside it — the partial install the guard exists for.
    mkdirSync(join(h, "bin"));
    copyFileSync(AI, join(h, "bin", "rein"));
    const r = spawnSync("/bin/bash", [join(h, "bin", "rein"), "account", "list"], {
      encoding: "utf8", input: "",
      env: { HOME: h, PATH: "/usr/bin:/bin", "BASH_FUNC_do_account%%": "() {  echo PWNED; }" },
    });
    assert.doesNotMatch(r.stdout + r.stderr, /PWNED/);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /rein-account\.sh is missing/);
  } finally { done(); }
});
