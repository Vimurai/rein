// tests/unit/cache-blob.test.mjs — the SessionStart context blob cap (E-275, D-075)
//
// native-first.md §Component 1: the blob `hooks/session-start.sh` injects at every session
// start is architect.md plus the blueprints modified within 7 days, and it NEVER exceeds
// CACHE_CHAR_LIMIT (20,000). It used to measure 25,812 against that limit, because
// registry.json and the state.sqlite schema rode along unconditionally and the old eviction
// could only touch blueprints older than 7 days.
//
// Every case drives the real CLI (`--measure` / `--emit-context`) — the same entry point the
// hook uses — under a throwaway HOME, so nothing reads or writes the operator's
// ~/.rein/cache.sqlite. Fixture mtimes are set explicitly: a fresh checkout gives every
// file the same mtime, which is exactly the tie the eviction order has to survive.
//
// Run standalone: node --test tests/unit/cache-blob.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = join(REPO, "src", "mcp", "cache-manager-mcp", "index.js");
const LIMIT = 20000;
const DAY = 24 * 60 * 60;

function run(flag, cwd, home) {
  const r = spawnSync(process.execPath, ["--no-warnings", SERVER, flag], {
    cwd,
    env: { ...process.env, HOME: home, REIN_DISABLE_CACHE: "0", AI_TELEMETRY_DISABLE: "1" },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "cache-blob-"));
  const home = join(root, "home");
  const proj = join(root, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(proj, ".ai", "blueprints"), { recursive: true });
  mkdirSync(join(proj, "src", "config"), { recursive: true });
  try { return fn({ home, proj }); } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Write a blueprint of `size` chars whose mtime is `ageDays` in the past. */
function blueprint(proj, name, size, ageDays) {
  const p = join(proj, ".ai", "blueprints", name);
  writeFileSync(p, `# ${name}\n${"B".repeat(size)}\n`);
  const t = Date.now() / 1000 - ageDays * DAY;
  utimesSync(p, t, t);
  return p;
}

test("this repository's own blob is within the cap", () => {
  const home = mkdtempSync(join(tmpdir(), "cache-blob-home-"));
  try {
    const r = run("--measure", REPO, home);
    assert.equal(r.status, 0, r.stderr);
    const n = Number(r.stdout.trim());
    assert.ok(Number.isInteger(n) && n > 0, `--measure printed ${JSON.stringify(r.stdout)}`);
    assert.ok(n <= LIMIT, `blob is ${n} chars, cap is ${LIMIT}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("no registry or schema text reaches the injected context", () => {
  withFixture(({ home, proj }) => {
    writeFileSync(join(proj, ".ai", "architect.md"), "# ARCHITECT DOC\n");
    writeFileSync(join(proj, "src", "config", "registry.json"),
      JSON.stringify({ mcp_servers: { "REGISTRY-SENTINEL": { path: "x" } } }));
    writeFileSync(join(proj, ".ai", "state.sqlite"), "");
    const r = run("--emit-context", proj, home);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ARCHITECT DOC/);
    assert.doesNotMatch(r.stdout, /REGISTRY-SENTINEL|mcp_servers|\(registry\)|\(schema\)|sqlite_master/);
  });
});

test("only blueprints modified within 7 days are injected", () => {
  withFixture(({ home, proj }) => {
    writeFileSync(join(proj, ".ai", "architect.md"), "# ARCHITECT DOC\n");
    blueprint(proj, "fresh.md", 100, 1);
    blueprint(proj, "stale.md", 100, 30);
    const r = run("--emit-context", proj, home);
    assert.match(r.stdout, /# fresh\.md/);
    assert.doesNotMatch(r.stdout, /# stale\.md/);
    assert.match(r.stderr, /^Omitted: \.ai\/blueprints\/stale\.md$/m);
  });
});

test("over the cap, the OLDEST recent blueprint is dropped first and named on stderr", () => {
  withFixture(({ home, proj }) => {
    writeFileSync(join(proj, ".ai", "architect.md"), "# ARCHITECT DOC\n");
    blueprint(proj, "a-oldest.md", 8000, 3);
    blueprint(proj, "b-middle.md", 8000, 2);
    blueprint(proj, "c-newest.md", 8000, 1);
    const m = run("--measure", proj, home);
    assert.ok(Number(m.stdout.trim()) <= LIMIT, `measured ${m.stdout.trim()}`);
    const r = run("--emit-context", proj, home);
    assert.ok(r.stdout.length <= LIMIT);
    assert.doesNotMatch(r.stdout, /# a-oldest\.md/);
    assert.match(r.stdout, /# b-middle\.md/);
    assert.match(r.stdout, /# c-newest\.md/);
    assert.match(r.stdout, /Omitted: 1 blueprint/);
    assert.match(r.stderr, /Omitted: \.ai\/blueprints\/a-oldest\.md/);
  });
});

test("equal mtimes (a fresh checkout) evict deterministically by name", () => {
  withFixture(({ home, proj }) => {
    writeFileSync(join(proj, ".ai", "architect.md"), "# ARCHITECT DOC\n");
    const t = Date.now() / 1000 - DAY;
    for (const n of ["z.md", "y.md", "x.md"]) {
      const p = blueprint(proj, n, 8000, 1);
      utimesSync(p, t, t);
    }
    const first = run("--emit-context", proj, home).stderr;
    const second = run("--emit-context", proj, home).stderr;
    assert.equal(first, second);
    assert.match(first, /Omitted: \.ai\/blueprints\/x\.md$/m);
  });
});

test("an architect.md larger than the cap is truncated with a marker, never let through", () => {
  withFixture(({ home, proj }) => {
    writeFileSync(join(proj, ".ai", "architect.md"), `# ARCHITECT DOC\n${"A".repeat(LIMIT + 5000)}\n`);
    const r = run("--emit-context", proj, home);
    assert.ok(r.stdout.length <= LIMIT, `blob is ${r.stdout.length} chars`);
    assert.match(r.stdout, /\[TRUNCATED at 20000 chars/);
    assert.match(r.stdout, /=== END SYSTEM CONTEXT ===$/);
  });
});

test("REIN_DISABLE_CACHE=1 still emits nothing (rollback)", () => {
  withFixture(({ home, proj }) => {
    writeFileSync(join(proj, ".ai", "architect.md"), "# ARCHITECT DOC\n");
    const r = spawnSync(process.execPath, ["--no-warnings", SERVER, "--emit-context"], {
      cwd: proj, env: { ...process.env, HOME: home, REIN_DISABLE_CACHE: "1" }, encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });
});
