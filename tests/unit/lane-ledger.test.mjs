// lane-ledger.test.mjs — an Architect commit may change only .ai/ and plans/, however git made
// it (E-462, gap 2 of E-458). New file: the ledger is new. Drives real git in a temp repo, the
// cheapest layer that can observe a commit; the sandbox half (the Architect cannot write the
// ledger) is observed by tests/suites/sandbox_escape_test.sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basesFile, check, record, seed, trust, ledgerFile } from "../../src/shared/lane-ledger.mjs";

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ll-")));
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "ll-bare-")));
  const g = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  execFileSync("git", ["init", "-q", "--bare", bare]);
  g("init", "-q", "-b", "main"); g("config", "user.name", "t"); g("config", "user.email", "t@example.invalid");
  mkdirSync(join(root, ".ai")); mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".ai", "a.md"), "a"); writeFileSync(join(root, "src", "s.js"), "s");
  g("add", "-A"); g("commit", "-qm", "init"); g("remote", "add", "origin", bare); g("push", "-q", "origin", "main");
  const refs = () => `refs/heads/main ${g("rev-parse", "HEAD")} refs/heads/main ${g("rev-parse", "origin/main")}\n`;
  const plumb = (path, content) => {
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: content, encoding: "utf8" }).trim();
    g("update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
  };
  return { root, g, refs, plumb, done: () => { rmSync(root, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); } };
}

test("no ledger: nothing is checked and the push is not refused", () => {
  const r = repo();
  try {
    r.plumb("src/s.js", "evil"); r.g("commit", "-qm", "x");
    const out = check(r.root, r.refs());
    assert.deepEqual(out.refused, []);
    assert.match(out.note, /LANE_CHECK/);
  } finally { r.done(); }
});

test("a lane-only commit passes unrecorded; a recorded src/ commit passes; a plumbing src/ commit is refused", () => {
  const r = repo();
  try {
    seed(r.root);
    writeFileSync(join(r.root, ".ai", "a.md"), "b"); r.g("commit", "-qam", "arch"); assert.equal(record(r.root), "");
    writeFileSync(join(r.root, "src", "s.js"), "eng"); r.g("commit", "-qam", "eng"); assert.equal(record(r.root), "");
    assert.deepEqual(check(r.root, r.refs()).refused, []);
    // The Architect's route: content only the index holds, committed without touching src/.
    r.plumb("src/s.js", "evil"); r.g("commit", "-qm", "plumbing");
    assert.match(record(r.root), /not recorded/, "index content the working tree lacks is never recorded");
    const out = check(r.root, r.refs());
    assert.equal(out.refused.length, 1);
    assert.match(out.refused[0], /\[ARCH_LANE_COMMIT\] [0-9a-f]{7} "plumbing" changes src\/s\.js/);
  } finally { r.done(); }
});

test("a new branch is checked against the trusted bases; trust records one commit by hand", () => {
  const r = repo();
  try {
    seed(r.root);
    r.plumb("newtop", "x"); r.g("commit", "-qm", "planted");
    const head = r.g("rev-parse", "HEAD");
    const nb = `refs/heads/side ${head} refs/heads/side ${"0".repeat(40)}\n`;
    assert.equal(check(r.root, nb).refused.length, 1, "a new top-level entry is outside the lane too");
    trust(r.root, head);
    assert.ok(readFileSync(ledgerFile(r.root), "utf8").includes(head));
    assert.deepEqual(check(r.root, nb).refused, []);
  } finally { r.done(); }
});

test("seed trusts the unpushed history once and never re-seeds", () => {
  const r = repo();
  try {
    writeFileSync(join(r.root, "src", "s.js"), "pre"); r.g("commit", "-qam", "before the ledger");
    const pre = r.g("rev-parse", "HEAD");
    assert.equal(seed(r.root).count, 1);
    assert.equal(seed(r.root).seeded, false);
    assert.ok(readFileSync(ledgerFile(r.root), "utf8").includes(pre));
    assert.deepEqual(check(r.root, r.refs()).refused, []);
  } finally { r.done(); }
});

// SECURITY.md lean-core round F2: the Architect can write refs/remotes, packed-refs and
// refs/replace. None of them may hide a commit from the check, on an existing branch or a new one.
function forged(r) {
  seed(r.root);
  r.plumb("src/s.js", "evil"); r.g("commit", "-qm", "plumbing");
  const x = r.g("rev-parse", "HEAD");
  return { x, nb: `refs/heads/side ${x} refs/heads/side ${"0".repeat(40)}\n` };
}

test("F2: a forged remote-tracking ref does not hide a commit", () => {
  const r = repo();
  try {
    const { x, nb } = forged(r);
    r.g("update-ref", "refs/remotes/zz/hide", x);
    r.g("update-ref", "refs/remotes/origin/main", x); // the tracking ref the old check trusted
    const push = `refs/heads/main ${x} refs/heads/main ${r.g("ls-remote", "origin", "refs/heads/main").split(/\s/)[0]}\n`;
    assert.match(check(r.root, push).refused.join("\n"), /"plumbing"/);
    assert.match(check(r.root, nb).refused.join("\n"), /"plumbing"/);
  } finally { r.done(); }
});

test("F2: a packed-refs line does not hide a commit", () => {
  const r = repo();
  try {
    const { x, nb } = forged(r);
    const pr = join(r.root, ".git", "packed-refs");
    if (!existsSync(pr)) writeFileSync(pr, "# pack-refs with: peeled fully-peeled sorted \n");
    appendFileSync(pr, `${x} refs/remotes/origin/zz\n`);
    assert.equal(r.g("rev-parse", "refs/remotes/origin/zz"), x, "the forged line is read by git");
    assert.match(check(r.root, nb).refused.join("\n"), /"plumbing" changes src\/s\.js/);
  } finally { r.done(); }
});

test("F2: git replace does not swap in a lane-only lookalike", () => {
  const r = repo();
  try {
    const { x, nb } = forged(r);
    const base = r.g("rev-parse", "HEAD~1");
    // The lookalike: the same parent, a lane-only change.
    r.g("reset", "-q", "--hard", base);
    writeFileSync(join(r.root, ".ai", "a.md"), "look"); r.g("commit", "-qam", "lookalike");
    const y = r.g("rev-parse", "HEAD");
    r.g("replace", x, y);
    assert.equal(r.g("log", "-1", "--format=%s", x), "lookalike", "git itself now shows the lookalike");
    assert.match(check(r.root, nb).refused.join("\n"), /"plumbing" changes src\/s\.js/);
  } finally { r.done(); }
});

test("F2: a passed tip becomes a trusted base; a missing bases file is taken at the next seed", () => {
  const r = repo();
  try {
    seed(r.root);
    writeFileSync(join(r.root, "src", "s.js"), "eng"); r.g("commit", "-qam", "eng"); assert.equal(record(r.root), "");
    const tip = r.g("rev-parse", "HEAD");
    assert.deepEqual(check(r.root, `refs/heads/side ${tip} refs/heads/side ${"0".repeat(40)}\n`).refused, []);
    assert.ok(readFileSync(basesFile(r.root), "utf8").includes(tip));
    unlinkSync(basesFile(r.root));
    assert.equal(seed(r.root).seeded, false);
    assert.ok(existsSync(basesFile(r.root)), "a pre-F2 ledger gets its bases at the next seed");
  } finally { r.done(); }
});
