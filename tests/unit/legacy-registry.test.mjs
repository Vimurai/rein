// tests/unit/legacy-registry.test.mjs — node:test unit suite for the E-272 legacy
// registry (D-074, version-lifecycle.md §Component 3).
//
// The registry is DATA, so the things that can go wrong with it are data faults: a `safe`
// entry with no evidence behind it, a rule name nothing implements, a glob in a mid-path
// segment that matches nothing forever. Each of those would make `ai clean` either
// dangerous or a permanent silent no-op, and neither shows up in an end-to-end run — the
// command would simply report less than the operator believes. They are pinned here.
//
// The end-to-end layer (fixture HOME + project, apply, restore, exit codes) is
// tests/suites/ai_clean_test.sh.
//
//   node --test tests/unit/legacy-registry.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, symlinkSync, realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadRegistry, registryPath, scan, summarize, expandEntryPaths, scanSettingAllows,
  RULES, KINDS, CLASSES,
} from "../../src/shared/legacy-registry.mjs";

// The unit layer runs from the repo root (node_unit_test.sh cds there, and the standalone
// invocation in the header does the same), so the shipped registry is addressable without
// a parent hop — which the CAPABILITIES scanner reads as path traversal.
const SHIPPED = join(process.cwd(), "src", "config", "legacy-artefacts.json");

function tmp(tag = "reg") {
  const d = mkdtempSync(join(tmpdir(), `aios-t-${tag}-`));
  return { d, done: () => rmSync(d, { recursive: true, force: true }) };
}

/** Write a one-entry registry and load it, so a validation test reads as one line. */
function loadWith(entry, extra = {}) {
  const t = tmp("regload");
  const p = join(t.d, "reg.json");
  writeFileSync(p, JSON.stringify({
    version: 1, registry_history: [], entries: [entry], ...extra,
  }));
  try { return loadRegistry(p); } finally { t.done(); }
}

const VALID = {
  id: "x", path: "thing", kind: "file", class: "prompt", since: "*", note: "n",
};

// ── the shipped registry ─────────────────────────────────────────────────────

test("the shipped registry loads and validates", () => {
  const reg = loadRegistry(SHIPPED);
  assert.equal(reg.version, 1);
  assert.ok(reg.entries.length >= 18, `expected the seed set, got ${reg.entries.length}`);
  for (const e of reg.entries) {
    assert.ok(KINDS.has(e.kind));
    assert.ok(CLASSES.has(e.class));
    if (e.rule) assert.ok(RULES.has(e.rule));
  }
});

// version-lifecycle.md §Component 3: "A test asserts every D-069 removal has an entry."
// The list is written out rather than derived: the point is that a future removal without
// a registry entry fails HERE, and a derived list would move with the code.
test("every D-069 removal has a registry entry", () => {
  const reg = loadRegistry(SHIPPED);
  const paths = new Set(reg.entries.map((e) => e.path));
  for (const p of [".gemini/", ".agents/", "GEMINI.md", "AGENTS.md", "testsprite_tests/", "~/.gemini/"]) {
    assert.ok(paths.has(p), `D-069 removed ${p} but no registry entry covers it`);
  }
  // ~/.gemini/ is Antigravity's own user data (OAuth credentials live there).
  assert.equal(reg.entries.find((e) => e.path === "~/.gemini/").class, "not-ours");
});

test("registry_history covers the retired server names the sweep must recognise", () => {
  const { registry_history: h } = loadRegistry(SHIPPED);
  for (const n of ["testsprite-mcp", "intent-refiner-mcp", "filesystem", "memory"]) {
    assert.ok(h.includes(n), `${n} is missing from registry_history`);
  }
});

// ── loader validation ────────────────────────────────────────────────────────

test("a bare safe path is refused (§API)", () => {
  assert.throws(() => loadWith({ ...VALID, class: "safe" }), /needs a rule or known_hashes/);
  // Either form of evidence is enough.
  assert.ok(loadWith({ ...VALID, class: "safe", known_hashes: ["a".repeat(64)] }));
  assert.ok(loadWith({ ...VALID, class: "safe", rule: "not-in-src", src_root: "src" }));
});

test("an unknown rule, kind or class is refused", () => {
  assert.throws(() => loadWith({ ...VALID, rule: "trust-me" }), /unknown rule/);
  assert.throws(() => loadWith({ ...VALID, kind: "socket" }), /kind must be one of/);
  assert.throws(() => loadWith({ ...VALID, class: "probably-fine" }), /class must be one of/);
});

// The E-251 shape: a rule written against the wrong kind has no implementation for it, so
// the entry would report nothing for ever and read as "clean".
test("a rule is bound to the kind that implements it", () => {
  assert.throws(() => loadWith({ ...VALID, kind: "setting", rule: "dead-pid" }), /must carry rule not-in-registry/);
  assert.throws(() => loadWith({ ...VALID, rule: "not-in-registry" }), /no path implementation/);
  assert.throws(() => loadWith({ ...VALID, kind: "process" }), /must carry rule orphan-process/);
});

test("stale-mtime without a positive max_age_days is refused", () => {
  assert.throws(() => loadWith({ ...VALID, rule: "stale-mtime" }), /positive max_age_days/);
  assert.throws(() => loadWith({ ...VALID, rule: "stale-mtime", max_age_days: 0 }), /positive max_age_days/);
});

test("a wildcard outside the last path segment is refused", () => {
  assert.throws(() => loadWith({ ...VALID, path: ".claude/*/agents.md" }), /only the last path segment/);
  assert.ok(loadWith({ ...VALID, path: ".claude/agents/*" }));
});

test("duplicate ids and a wrong version are refused", () => {
  const t = tmp("regdup");
  const p = join(t.d, "r.json");
  writeFileSync(p, JSON.stringify({ version: 1, registry_history: [], entries: [VALID, VALID] }));
  assert.throws(() => loadRegistry(p), /duplicate entry id/);
  writeFileSync(p, JSON.stringify({ version: 2, registry_history: [], entries: [VALID] }));
  assert.throws(() => loadRegistry(p), /version must be 1/);
  writeFileSync(p, "{not json");
  assert.throws(() => loadRegistry(p), /not valid JSON/);
  t.done();
  assert.throws(() => loadRegistry(join(t.d, "gone.json")), /not found/);
});

test("registryPath prefers the install mirror over the clone", () => {
  const t = tmp("regpath");
  mkdirSync(join(t.d, ".ai-os", "config"), { recursive: true });
  writeFileSync(join(t.d, ".ai-os", "config", "legacy-artefacts.json"), "{}");
  assert.equal(registryPath({ home: t.d }), join(t.d, ".ai-os", "config", "legacy-artefacts.json"));
  t.done();
});

// ── path expansion ───────────────────────────────────────────────────────────

test("paths expand against the project, HOME or the temp root and must exist", () => {
  const t = tmp("regexp");
  const ctx = { project: join(t.d, "proj"), home: join(t.d, "home"), tmp: join(t.d, "tmp") };
  mkdirSync(ctx.project, { recursive: true });
  mkdirSync(ctx.home, { recursive: true });
  mkdirSync(ctx.tmp, { recursive: true });
  writeFileSync(join(ctx.project, "GEMINI.md"), "x");
  writeFileSync(join(ctx.home, "install-ai-os.sh"), "x");
  mkdirSync(join(ctx.tmp, "ai-os-ci.abc"));

  assert.deepEqual(expandEntryPaths({ path: "GEMINI.md", kind: "file" }, ctx), [join(ctx.project, "GEMINI.md")]);
  assert.deepEqual(expandEntryPaths({ path: "~/install-ai-os.sh", kind: "file" }, ctx), [join(ctx.home, "install-ai-os.sh")]);
  assert.deepEqual(expandEntryPaths({ path: "$TMPDIR/ai-os-ci.*", kind: "dir" }, ctx), [join(ctx.tmp, "ai-os-ci.abc")]);
  // Absent is not a finding, and a glob that matches nothing returns nothing rather than
  // the unexpanded pattern.
  assert.deepEqual(expandEntryPaths({ path: "AGENTS.md", kind: "file" }, ctx), []);
  assert.deepEqual(expandEntryPaths({ path: "~/.ai-os/run/role-*.lock", kind: "file" }, ctx), []);
  t.done();
});

// ── rules, through scan() ────────────────────────────────────────────────────

function fixture(tag = "regscan") {
  const t = tmp(tag);
  const home = join(t.d, "home");
  const project = join(t.d, "proj");
  const tmpRoot = join(t.d, "tmp");
  const clone = join(t.d, "clone");
  for (const d of [
    join(home, ".ai-os", "mcp"), join(home, ".ai-os", "run"), join(home, ".ai-os", "ci"),
    join(project, ".claude", "agents"), tmpRoot,
    join(clone, "src", "mcp", "kept-mcp"), join(clone, "src", "config"), join(clone, "hooks"),
  ]) mkdirSync(d, { recursive: true });
  writeFileSync(join(clone, "src", "config", "registry.json"),
    JSON.stringify({ mcp_servers: { "kept-mcp": { path: "x" } } }));
  return { ...t, home, project, tmp: tmpRoot, clone };
}

const scanFixture = (f, registry, over = {}) => scan({
  project: f.project, home: f.home, tmp: f.tmp, srcRoots: [f.clone], registry, ...over,
});

const reg1 = (entry) => ({ version: 1, registry_history: ["retired-mcp"], entries: [entry] });

test("not-in-src keeps a mirror dir the source ships and flags one it does not", () => {
  const f = fixture();
  mkdirSync(join(f.home, ".ai-os", "mcp", "kept-mcp"));
  mkdirSync(join(f.home, ".ai-os", "mcp", "retired-mcp"));
  const { findings } = scanFixture(f, reg1({
    id: "mirror-orphan-mcp", path: "~/.ai-os/mcp/*", kind: "dir", class: "safe",
    since: "*", rule: "not-in-src", src_root: "src/mcp",
  }));
  assert.deepEqual(findings.map((x) => x.path), [join(f.home, ".ai-os", "mcp", "retired-mcp")]);
  assert.equal(findings[0].class, "safe");
  f.done();
});

// Without a source tree there is no evidence either way, so the honest answer is silence.
// The alternative — "not found in src, therefore stale" — would propose deleting the
// whole mirror on a machine whose clone has moved.
test("not-in-src reports nothing when no source tree is available", () => {
  const f = fixture();
  mkdirSync(join(f.home, ".ai-os", "mcp", "retired-mcp"));
  const { findings } = scanFixture(f, reg1({
    id: "m", path: "~/.ai-os/mcp/*", kind: "dir", class: "safe", since: "*",
    rule: "not-in-src", src_root: "src/mcp",
  }), { srcRoots: [] });
  assert.deepEqual(findings, []);
  f.done();
});

test("dead-pid reads the pid from the record and spares a live one", () => {
  const f = fixture();
  const run = join(f.home, ".ai-os", "run");
  writeFileSync(join(run, "build-dead.json"), JSON.stringify({ server: "d", pid: 2147480000 }));
  writeFileSync(join(run, "build-live.json"), JSON.stringify({ server: "l", pid: process.pid }));
  const { findings } = scanFixture(f, reg1({
    id: "dead-build-record", path: "~/.ai-os/run/build-*.json", kind: "file", class: "safe",
    since: "*", rule: "dead-pid", pid_source: "json:pid",
  }));
  assert.deepEqual(findings.map((x) => x.path), [join(run, "build-dead.json")]);
  assert.match(findings[0].why, /pid 2147480000 is gone/);
  f.done();
});

test("a guard pid that is alive suppresses the whole entry", () => {
  const f = fixture();
  mkdirSync(join(f.tmp, "ai-os-ci.abandoned"));
  const entry = {
    id: "abandoned-ci-workdir", path: "$TMPDIR/ai-os-ci.*", kind: "dir", class: "safe",
    since: "*", rule: "dead-pid", guard_pids: "~/.ai-os/ci/run-*.lock", guard_pid_source: "file:pid",
  };
  const lock = join(f.home, ".ai-os", "ci", "run-1.lock");

  mkdirSync(lock); writeFileSync(join(lock, "pid"), String(process.pid));
  assert.deepEqual(scanFixture(f, reg1(entry)).findings, [], "a live run may still own the dir");

  writeFileSync(join(lock, "pid"), "2147480000");
  const { findings } = scanFixture(f, reg1(entry));
  // The scan resolves the temp root (macOS /var → /private/var): comparing the raw
  // spelling is the E-265 symlink trap, and it is the scan that is right here.
  assert.deepEqual(findings.map((x) => x.path), [join(realpathSync(f.tmp), "ai-os-ci.abandoned")]);
  f.done();
});

test("stale-mtime flags only what is older than max_age_days", () => {
  const f = fixture();
  const run = join(f.home, ".ai-os", "run");
  writeFileSync(join(run, "role-old.lock"), "{}");
  writeFileSync(join(run, "role-new.lock"), "{}");
  const old = (Date.now() - 9 * 86400000) / 1000;
  utimesSync(join(run, "role-old.lock"), old, old);
  const { findings } = scanFixture(f, reg1({
    id: "dead-role-lock", path: "~/.ai-os/run/role-*.lock", kind: "file", class: "safe",
    since: "*", rule: "stale-mtime", max_age_days: 7,
  }));
  assert.deepEqual(findings.map((x) => x.path), [join(run, "role-old.lock")]);
  f.done();
});

test("not-in-manifest prunes nothing without the three pieces of evidence", () => {
  const f = fixture();
  const dir = join(f.project, ".claude", "agents");
  const entry = {
    id: "claude-agents-orphan", path: ".claude/agents/*", kind: "file", class: "safe",
    since: "*", rule: "not-in-manifest",
  };
  writeFileSync(join(dir, "ghost.md"), "written by sync\n");

  // 1. no manifest at all — nothing proves sync wrote it.
  assert.deepEqual(scanFixture(f, reg1(entry)).findings, []);

  const manifest = (entries) => writeFileSync(join(dir, "_SYNC_MANIFEST.json"),
    JSON.stringify({ version: 1, entries }));
  const sha = createHash("sha256").update("written by sync\n").digest("hex");

  // 2. a manifest that does not record it — user-authored.
  manifest({ "other.md": sha });
  assert.deepEqual(scanFixture(f, reg1(entry)).findings, []);

  // 3. recorded but edited since — their edit outranks our bookkeeping.
  manifest({ "ghost.md": "0".repeat(64) });
  assert.deepEqual(scanFixture(f, reg1(entry)).findings, []);

  // All three hold → the one case that is removable.
  manifest({ "ghost.md": sha });
  const { findings } = scanFixture(f, reg1(entry));
  assert.deepEqual(findings.map((x) => x.path), [join(dir, "ghost.md")]);
  f.done();
});

test("known_hashes downgrade an edited file from safe to prompt", () => {
  const f = fixture();
  const shipped = "# GEMINI.md shim\n";
  const entry = {
    id: "gemini-rulefile", path: "GEMINI.md", kind: "file", class: "safe", since: "4.0.0",
    known_hashes: [createHash("sha256").update(shipped).digest("hex")],
  };

  writeFileSync(join(f.project, "GEMINI.md"), shipped);
  let { findings } = scanFixture(f, reg1(entry));
  assert.equal(findings[0].class, "safe");
  assert.match(findings[0].why, /byte-identical/);

  writeFileSync(join(f.project, "GEMINI.md"), shipped + "my own notes\n");
  ({ findings } = scanFixture(f, reg1(entry)));
  assert.equal(findings[0].class, "prompt", "an edited shim must not be removed by --apply");
  assert.match(findings[0].why, /edited since/);
  f.done();
});

test("a symlink is reported as not-ours and never followed", () => {
  const f = fixture();
  mkdirSync(join(f.d, "elsewhere"));
  symlinkSync(join(f.d, "elsewhere"), join(f.project, ".gemini"));
  const { findings } = scanFixture(f, reg1({
    id: "gemini-workspace", path: ".gemini/", kind: "dir", class: "prompt", since: "4.0.0",
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "not-ours");
  assert.equal(findings[0].action, "report");
  f.done();
});

// Extends the case above to a symlinked PARENT: lstat sees only the last segment, so a
// project whose `.ai/` links elsewhere looked like an ordinary file under the project and
// `ai sync`'s watcher reap (D-099, E-322) would have moved it out of the link's target.
test("a file under a symlinked parent directory is reported, never moved", () => {
  const f = fixture();
  const outside = join(f.d, "outside-ai");
  mkdirSync(outside);
  writeFileSync(join(outside, "signal.json"), "[]");
  symlinkSync(outside, join(f.project, ".ai"));
  const { findings } = scanFixture(f, reg1({
    id: "watcher-signal-queue", path: ".ai/signal.json", kind: "file", class: "safe",
    since: "4.0.0", rule: "dead-pid", guard_pids: ".ai/.ai-watch.lock", guard_pid_source: "file:pid",
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "not-ours");
  assert.equal(findings[0].action, "report");
  f.done();
});

test("scope limits the scan to the project or to HOME", () => {
  const f = fixture();
  writeFileSync(join(f.project, "GEMINI.md"), "x");
  writeFileSync(join(f.home, "install-ai-os.sh"), "x");
  const reg = {
    version: 1,
    registry_history: [],
    entries: [
      { id: "p", path: "GEMINI.md", kind: "file", class: "prompt", since: "*" },
      { id: "h", path: "~/install-ai-os.sh", kind: "file", class: "prompt", since: "*" },
    ],
  };
  assert.deepEqual(scanFixture(f, reg, { scope: "project" }).findings.map((x) => x.entry_id), ["p"]);
  assert.deepEqual(scanFixture(f, reg, { scope: "home" }).findings.map((x) => x.entry_id), ["h"]);
  assert.deepEqual(scanFixture(f, reg).findings.map((x) => x.entry_id).sort(), ["h", "p"]);
  f.done();
});

// ── settings allows ──────────────────────────────────────────────────────────

test("a retired server's allow is flagged; a user-added server's is kept", () => {
  const f = fixture();
  const p = join(f.project, ".claude", "settings.json");
  writeFileSync(p, JSON.stringify({
    permissions: {
      allow: [
        "mcp__kept-mcp__*",        // current
        "mcp__retired-mcp__*",     // in registry_history, gone from registry.json
        "mcp__semrush__*",         // never shipped by AI-OS — the operator's own
        "Bash(ls:*)",
      ],
    },
  }));
  const ctx = {
    registryServers: new Set(["kept-mcp"]),
    registryHistory: new Set(["retired-mcp", "kept-mcp"]),
  };
  assert.deepEqual(scanSettingAllows(p, ctx), [{ allow: "mcp__retired-mcp__*", server: "retired-mcp" }]);

  const { findings } = scanFixture(f, reg1({
    id: "settings-allow-orphan", path: ".claude/settings.json", kind: "setting",
    class: "prompt", since: "*", rule: "not-in-registry",
  }));
  assert.equal(findings.length, 1);
  // Report only: `ai clean` moves paths, and a JSON key is not a path.
  assert.equal(findings[0].action, "report");
  assert.equal(summarize(findings).actionable, 0);
  f.done();
});

test("summarize separates what ai clean could act on from what it only reports", () => {
  const c = summarize([
    { class: "safe", action: "trash" },
    { class: "prompt", action: "trash" },
    { class: "not-ours", action: "report" },
    { class: "prompt", action: "report" },
  ]);
  assert.deepEqual(c, { safe: 1, prompt: 2, "not-ours": 1, actionable: 2, report_only: 2 });
});
