// tests/unit/build-stamp.test.mjs — node:test unit suite for src/shared/build-stamp.mjs (E-249)
//
// D-067 §3: a running MCP server serves whatever it imported at startup, because ESM caches
// modules for the process lifetime. This module is what lets a separate process find out.
//
// Everything here runs against REAL fixture trees on disk — a fake "server" directory with
// an entry file and a `shared/` sibling, and a repo/mirror pair for the completion gate. No
// mocks: the thing under test is filesystem observation, and a mocked filesystem would only
// prove the mock agrees with itself.
//
// The run dir is redirected per test, so nothing here can see, reap or write the machine's
// real ~/.rein/run records.
//
// Run standalone: node --test tests/unit/build-stamp.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  stampFor,
  buildInputsFor,
  buildStampEnabled,
  bootedBuild,
  _resetBootedBuild,
  writeBootRecord,
  recordPathFor,
  listStaleServers,
  isStdioServerInvocation,
  formatStaleLines,
  staleServerReport,
  mirrorDrift,
  checkCompletionBuildGate,
} from "../../src/shared/build-stamp.mjs";

import { stampBootedBuild, withTelemetry, BOOTED_BUILD_META, EXPECTED_REJECTION_META, statusForResult }
  from "../../src/shared/mcp-telemetry.mjs";

// ── fixtures ────────────────────────────────────────────────────────────────────────────
const temps = [];
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tmp(prefix = "e249") {
  const d = mkdtempSync(join(tmpdir(), `${prefix}-`));
  temps.push(d);
  return d;
}
process.on("exit", () => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

// A fake server tree: <root>/mcp/<name>/index.js plus <root>/mcp/shared/*.
function serverFixture({ entryBody = "// entry\n", sharedBody = "// shared\n", name = "fake-mcp" } = {}) {
  const root = tmp();
  const dir = join(root, "mcp", name);
  const shared = join(root, "mcp", "shared");
  mkdirSync(dir, { recursive: true });
  mkdirSync(shared, { recursive: true });
  const entry = join(dir, "index.js");
  const sharedFile = join(shared, "state-db.js");
  writeFileSync(entry, entryBody);
  writeFileSync(sharedFile, sharedBody);
  return { root, entry, sharedFile, name };
}

function runDirFixture() {
  const d = join(tmp(), "run");
  mkdirSync(d, { recursive: true });
  return d;
}

// ── stampFor ────────────────────────────────────────────────────────────────────────────

test("stampFor covers the entry file AND the shared directory beside it", () => {
  const f = serverFixture();
  const inputs = buildInputsFor(f.entry);
  assert.equal(inputs.length, 2, "entry + one shared file");
  assert.ok(inputs.includes(f.entry));
  assert.ok(inputs.includes(f.sharedFile));
  assert.equal(stampFor(f.entry).file_count, 2);
});

test("stampFor is deterministic for unchanged bytes", () => {
  const f = serverFixture();
  assert.equal(stampFor(f.entry).hash, stampFor(f.entry).hash);
});

test("stampFor changes when a SHARED module changes — the actual E-249 scenario", () => {
  // The pre-E-245 projector lived in src/mcp/shared. A stamp that only hashed the entry
  // file would have reported that server as current while it served the old projector.
  const f = serverFixture();
  const before = stampFor(f.entry).hash;
  writeFileSync(f.sharedFile, "// shared v2\n");
  assert.notEqual(stampFor(f.entry).hash, before);
});

test("stampFor ignores a touch that does not change bytes", () => {
  // install-rein.sh rewrites files whether or not their content changed (E-229's atomic
  // copy). Reporting those as stale would train the operator to ignore the notice.
  const f = serverFixture();
  const before = stampFor(f.entry).hash;
  writeFileSync(f.entry, readFileSync(f.entry));      // same bytes, new mtime
  assert.equal(stampFor(f.entry).hash, before);
});

test("stampFor hashes basenames, so the same build in two locations matches", () => {
  const a = serverFixture({ name: "srv" });
  const b = serverFixture({ name: "srv" });
  assert.equal(stampFor(a.entry).hash, stampFor(b.entry).hash,
    "an identical build installed at a different absolute path must not read as stale");
});

test("stampFor returns null for a missing entry file", () => {
  assert.equal(stampFor(join(tmp(), "nope", "index.js")), null);
});

// ── boot records and the stale scan ─────────────────────────────────────────────────────

test("a fresh boot record is NOT stale", () => {
  const f = serverFixture();
  const runDir = runDirFixture();
  writeBootRecord(f.name, stampFor(f.entry), runDir);
  assert.ok(existsSync(recordPathFor(f.name, runDir)));
  assert.deepEqual(listStaleServers({ runDir }), []);
});

test("rewriting a shared module makes the RUNNING server stale (acceptance)", () => {
  const f = serverFixture();
  const runDir = runDirFixture();
  const booted = stampFor(f.entry);
  writeBootRecord(f.name, booted, runDir);

  writeFileSync(f.sharedFile, "// projector v2 — the archive pointer is no longer stripped\n");

  const stale = listStaleServers({ runDir });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].server, f.name);
  assert.equal(stale[0].booted_hash, booted.hash);
  assert.notEqual(stale[0].current_hash, booted.hash);
});

test("the message is exactly the shape D-067 §3 specifies", () => {
  const f = serverFixture();
  const runDir = runDirFixture();
  writeBootRecord(f.name, stampFor(f.entry), runDir);
  writeFileSync(f.sharedFile, "// v2\n");

  const [line] = formatStaleLines(listStaleServers({ runDir }));
  assert.match(line, /^\[STALE_SERVER\] fake-mcp booted \S+, mirror changed \S+ — restart required$/);
});

test("a record for a DEAD pid is reaped, not reported", () => {
  // A record whose process has exited is not evidence about anything running. Left in
  // place, a machine that has started hundreds of short-lived servers would report a
  // growing crowd of "stale" servers that do not exist.
  const f = serverFixture();
  const runDir = runDirFixture();
  const rec = recordPathFor(f.name, runDir);
  writeFileSync(rec, JSON.stringify({
    server: f.name, pid: 2147483646, entry: f.entry, hash: "deadbeefdead",
    mtime_ms: 0, booted_at: new Date(0).toISOString(),
  }));

  assert.deepEqual(listStaleServers({ runDir }), [], "a dead pid is never reported");
  assert.equal(existsSync(rec), false, "and its record is reaped");
});

test("a dead pid's record survives when reaping is off", () => {
  const f = serverFixture();
  const runDir = runDirFixture();
  const rec = recordPathFor(f.name, runDir);
  writeFileSync(rec, JSON.stringify({ server: f.name, pid: 2147483646, entry: f.entry, hash: "x" }));
  assert.deepEqual(listStaleServers({ runDir, reap: false }), []);
  assert.equal(existsSync(rec), true);
});

test("a server whose entry file has vanished is not reported stale", () => {
  // Nothing to compare against, and a null stamp compared unequal forever would make an
  // uninstalled server permanently "stale".
  const f = serverFixture();
  const runDir = runDirFixture();
  writeBootRecord(f.name, stampFor(f.entry), runDir);
  rmSync(join(f.root, "mcp"), { recursive: true, force: true });
  assert.deepEqual(listStaleServers({ runDir }), []);
});

test("a corrupt record is skipped, not thrown on", () => {
  const runDir = runDirFixture();
  writeFileSync(join(runDir, "build-broken.json"), "{not json");
  writeFileSync(join(runDir, "build-empty.json"), "{}");
  assert.deepEqual(listStaleServers({ runDir }), []);
});

test("non-build files in the run dir are ignored", () => {
  // ~/.rein/run also holds role-<sid>.lock (E-129) and other runtime locks.
  const runDir = runDirFixture();
  writeFileSync(join(runDir, "role-ABC.lock"), '{"role":"engineer"}');
  writeFileSync(join(runDir, "ci-run.lock"), "123");
  assert.deepEqual(listStaleServers({ runDir }), []);
});

// ── the rollback switch ─────────────────────────────────────────────────────────────────

test("REIN_BUILD_STAMP=0 disables the scan, the stamp and the gate", (t) => {
  const f = serverFixture();
  const runDir = runDirFixture();
  writeBootRecord(f.name, stampFor(f.entry), runDir);
  writeFileSync(f.sharedFile, "// v2\n");
  assert.equal(listStaleServers({ runDir }).length, 1, "stale while enabled");

  const prev = process.env.REIN_BUILD_STAMP;
  process.env.REIN_BUILD_STAMP = "0";
  t.after(() => { if (prev === undefined) delete process.env.REIN_BUILD_STAMP; else process.env.REIN_BUILD_STAMP = prev; });

  assert.equal(buildStampEnabled(), false);
  assert.deepEqual(listStaleServers({ runDir }), []);
  assert.deepEqual(staleServerReport({ runDir }), []);
  _resetBootedBuild();
  assert.equal(bootedBuild("fake-mcp", f.entry, runDir), null);
  assert.deepEqual(stampBootedBuild({ content: [] }, "fake-mcp")._meta, undefined);
  assert.deepEqual(checkCompletionBuildGate({ repoRoot: "/nope" }), { ok: true });
});

// ── _meta.booted_build on tool results ──────────────────────────────────────────────────

test("stampBootedBuild attaches the stamp without disturbing _meta", async () => {
  const f = serverFixture({ name: "meta-mcp" });
  _resetBootedBuild();
  bootedBuild("meta-mcp", f.entry, runDirFixture());   // seed the cache; never the real run dir

  const result = stampBootedBuild({ content: [], _meta: { [EXPECTED_REJECTION_META]: true } }, "meta-mcp");
  assert.equal(result._meta[EXPECTED_REJECTION_META], true, "an existing key survives");
  assert.equal(result._meta[BOOTED_BUILD_META].hash, stampFor(f.entry).hash);
  assert.equal(result._meta[BOOTED_BUILD_META].entry, f.entry);
});

test("only a stdio server invocation writes a run-dir record", (t) => {
  // safe-exec-mcp's `--check` runs on EVERY Bash tool call through the PreToolUse hook. A
  // record per invocation would put a file write on that hot path and fill the run dir with
  // entries the next scan only has to reap. .mcp.json launches a server as `node <entry>`;
  // every CLI mode is selected by a flag, so argv shape separates them.
  const f = serverFixture({ name: "cli-mcp" });
  const runDir = runDirFixture();
  const realArgv = process.argv;
  t.after(() => { process.argv = realArgv; });

  process.argv = [realArgv[0], f.entry, "--check", "ls"];
  assert.equal(isStdioServerInvocation(), false);
  _resetBootedBuild();
  assert.ok(bootedBuild("cli-mcp", f.entry, runDir), "the stamp is still computed — _meta needs it either way");
  assert.equal(existsSync(recordPathFor("cli-mcp", runDir)), false, "but no record is written");

  process.argv = [realArgv[0], f.entry];
  assert.equal(isStdioServerInvocation(), true);
  _resetBootedBuild();
  assert.ok(bootedBuild("cli-mcp", f.entry, runDir), "a bare `node <entry>` is a server");
  assert.equal(existsSync(recordPathFor("cli-mcp", runDir)), true, "and it records its boot");
});

test("stampBootedBuild leaves a non-object result alone", () => {
  assert.equal(stampBootedBuild(undefined, "x"), undefined);
  assert.equal(stampBootedBuild("oops", "x"), "oops");
});

test("withTelemetry stamps every result and still classifies status correctly", async () => {
  // Ordering matters: statusForResult reads _meta.expected_rejection and stampBootedBuild
  // rebuilds _meta. This asserts a REJECTED result is still booked REJECTED after stamping.
  const f = serverFixture({ name: "wt-mcp" });
  _resetBootedBuild();
  bootedBuild("wt-mcp", f.entry, runDirFixture());

  const rows = [];
  const handler = async () => ({ content: [], isError: true, _meta: { [EXPECTED_REJECTION_META]: true } });
  const wrapped = withTelemetry("wt-mcp", handler, { record: (r) => rows.push(r) });

  const out = await wrapped({ params: { name: "t" } });
  assert.equal(rows[0].status, "REJECTED", "an expected rejection is not re-classified by stamping");
  assert.equal(out._meta[BOOTED_BUILD_META].hash, stampFor(f.entry).hash);
  assert.equal(statusForResult(out), "REJECTED");
});

test("withTelemetry never lets a stamping failure surface as a tool error", async () => {
  // A frozen result cannot take a new _meta. The tool's answer must still come back.
  // The cache is seeded against a FIXTURE run dir first: stampBootedBuild() otherwise
  // resolves bootedBuild()'s defaults — this test file as the entry, and the machine's real
  // ~/.rein/run as the destination — and a unit test that writes into the real run dir is
  // the leaked-external-state failure E-240 exists to catch.
  const ff = serverFixture({ name: "frozen-mcp" });
  _resetBootedBuild();
  bootedBuild("frozen-mcp", ff.entry, runDirFixture());

  const frozen = Object.freeze({ content: [{ type: "text", text: "ok" }] });
  const wrapped = withTelemetry("frozen-mcp", async () => frozen, { record: () => {} });
  assert.equal((await wrapped({ params: { name: "t" } })).content[0].text, "ok");
});

// ── the completion gate (D-067 §3, third bullet) ────────────────────────────────────────

// A repo/mirror pair. `frameworkOnly:false` is passed by every gate test below: the real
// guard asks isFrameworkClone(), which is false for a temp dir, and without the seam every
// one of these would pass vacuously by taking the not-the-framework early return.
function repoMirrorFixture() {
  const repo = tmp("e249-repo");
  const mirror = tmp("e249-mirror");
  for (const [dir, file, body] of [
    [join(repo, "src", "mcp", "srv"), "index.js", "// server v1\n"],
    [join(repo, "src", "bin"), "rein", "#!/usr/bin/env bash\n"],
    [join(mirror, "mcp", "srv"), "index.js", "// server v1\n"],
    [join(mirror, "bin"), "rein", "#!/usr/bin/env bash\n"],
  ]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), body);
  }
  return { repo, mirror };
}

test("gate PASSES when the mirror matches src/ and nothing is stale", () => {
  const { repo, mirror } = repoMirrorFixture();
  const runDir = runDirFixture();
  const d = mirrorDrift({ repoRoot: repo, mirrorRoot: mirror, frameworkOnly: false });
  assert.equal(d.installed, true);
  assert.deepEqual(d.drift, []);
  assert.deepEqual(
    checkCompletionBuildGate({ repoRoot: repo, mirrorRoot: mirror, runDir, frameworkOnly: false }),
    { ok: true });
});

test("gate BLOCKS when src/mcp/ has not been installed to the mirror", () => {
  const { repo, mirror } = repoMirrorFixture();
  const runDir = runDirFixture();
  writeFileSync(join(repo, "src", "mcp", "srv", "index.js"), "// server v2 — edited, not installed\n");

  const g = checkCompletionBuildGate({ repoRoot: repo, mirrorRoot: mirror, runDir, frameworkOnly: false });
  assert.equal(g.ok, false);
  assert.equal(g.code, "BUILD_STALE");
  assert.match(g.message, /src\/mcp\/srv\/index\.js/);
  assert.match(g.message, /bash install-rein\.sh/);
  assert.match(g.message, /REIN_BUILD_STAMP=0/);
});

test("gate BLOCKS on src/bin/ too, and on a file the mirror lacks entirely", () => {
  const { repo, mirror } = repoMirrorFixture();
  writeFileSync(join(repo, "src", "bin", "rein"), "#!/usr/bin/env bash\n# new\n");
  writeFileSync(join(repo, "src", "bin", "rein-brand-new"), "#!/usr/bin/env bash\n");
  const d = mirrorDrift({ repoRoot: repo, mirrorRoot: mirror, frameworkOnly: false });
  assert.ok(d.drift.includes("src/bin/rein"));
  assert.ok(d.drift.includes("src/bin/rein-brand-new"), "a file absent from the mirror is drift");
});

test("gate BLOCKS when the mirror is current but a running server booted an older build", () => {
  // The second half of the ruling: install ran, restart did not.
  const { repo, mirror } = repoMirrorFixture();
  const runDir = runDirFixture();
  const f = serverFixture({ name: "live-mcp" });
  writeBootRecord(f.name, stampFor(f.entry), runDir);
  writeFileSync(f.sharedFile, "// shared v2\n");

  const g = checkCompletionBuildGate({ repoRoot: repo, mirrorRoot: mirror, runDir, frameworkOnly: false });
  assert.equal(g.ok, false);
  assert.equal(g.code, "BUILD_STALE");
  assert.match(g.message, /\[STALE_SERVER\] live-mcp/);
  assert.match(g.message, /restart/i);
});

test("lockfiles and node_modules are never drift", () => {
  // `rein mcp-setup` runs npm install INSIDE the mirror, so every lockfile there differs
  // from src/ permanently and by design. A gate that can never be satisfied is one the
  // operator turns off.
  const { repo, mirror } = repoMirrorFixture();
  writeFileSync(join(repo, "src", "mcp", "srv", "package-lock.json"), '{"a":1}');
  writeFileSync(join(mirror, "mcp", "srv", "package-lock.json"), '{"a":2}');
  mkdirSync(join(repo, "src", "mcp", "srv", "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo, "src", "mcp", "srv", "node_modules", "pkg", "index.js"), "//\n");

  assert.deepEqual(mirrorDrift({ repoRoot: repo, mirrorRoot: mirror, frameworkOnly: false }).drift, []);
});

test("a project that is not the framework clone is never gated", () => {
  // A downstream repo with its own src/bin/ would otherwise be compared against
  // ~/.rein/bin and told all of its own files had drifted.
  const { repo, mirror } = repoMirrorFixture();
  writeFileSync(join(repo, "src", "bin", "rein"), "# a downstream project's own script\n");
  const d = mirrorDrift({ repoRoot: repo, mirrorRoot: mirror });   // frameworkOnly defaults true
  assert.equal(d.installed, false);
  assert.deepEqual(d.drift, []);
});

test("no mirror at all means nothing to be behind", () => {
  const { repo } = repoMirrorFixture();
  const d = mirrorDrift({ repoRoot: repo, mirrorRoot: join(tmp(), "absent"), frameworkOnly: false });
  assert.equal(d.installed, false);
  assert.deepEqual(d.drift, []);
});

test("drift is capped and says so", () => {
  const { repo, mirror } = repoMirrorFixture();
  const dir = join(repo, "src", "mcp", "many");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 30; i++) writeFileSync(join(dir, `f${i}.js`), `// ${i}\n`);
  const d = mirrorDrift({ repoRoot: repo, mirrorRoot: mirror, frameworkOnly: false, limit: 5 });
  assert.equal(d.drift.length, 5);
  assert.equal(d.truncated, true);
});

// ── E-319 / E-320 (D-097 r5, D-098 r2): run_handover applies the shared completion gates ──
// The second door to a task's DONE. It used to mark E-314 DONE while task-synchronizer's
// update_task_status refused the same call with [BUILD_STALE], and then still lacked the CI
// gate. Extends the gate rows above: same fixtures, called through the handler.
async function handoverFixture({ git = false } = {}) {
  const { repo, mirror } = repoMirrorFixture();
  const runDir = runDirFixture();
  mkdirSync(join(repo, ".ai"), { recursive: true });
  writeFileSync(join(repo, ".ai", "LOG.md"), "# LOG\n");
  const { getDb } = await import("../../src/mcp/shared/state-db.js");
  getDb(join(repo, ".ai"))
    .prepare("INSERT INTO tasks(id, owner, status, description, created_at) VALUES ('E-1', 'Engineer (Claude)', 'OPEN', 'fixture', ?)")
    .run(new Date().toISOString());
  let head = null;
  if (git) {   // a HEAD for the CI gate to certify; .ai/ is not part of the commit
    const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
    g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
    writeFileSync(join(repo, ".gitignore"), ".ai/\n");
    g("add", "-A"); g("commit", "-q", "-m", "fixture");
    head = g("rev-parse", "HEAD");
  }
  const { runHandover } = await import("../../src/mcp/orchestrator-mcp/run-handover.mjs");
  const db = getDb(join(repo, ".ai"));
  const status = () => db.prepare("SELECT status FROM tasks WHERE id = 'E-1'").get().status;
  const opts = { mirrorRoot: mirror, runDir, frameworkOnly: false };
  return { repo, db, head, runHandover, status, opts };
}

test("run_handover REFUSES on a stale build: [BUILD_STALE], REJECTED, nothing written", async () => {
  const { repo, runHandover, status, opts } = await handoverFixture();
  writeFileSync(join(repo, "src", "mcp", "srv", "index.js"), "// server v2 — edited, not installed\n");
  const r = runHandover(repo, { task_id: "E-1", summary: "should not land" }, opts, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /\[BUILD_STALE\]/);
  assert.equal(statusForResult(r), "REJECTED", "telemetry books the refusal REJECTED, not ERROR (D-049)");
  assert.equal(status(), "OPEN", "the task row is unchanged");
  assert.equal(readFileSync(join(repo, ".ai", "LOG.md"), "utf8"), "# LOG\n", "no LOG line for a refused handover");
});

test("run_handover PASSES the gate on a current build and marks DONE", async () => {
  const { repo, runHandover, status, opts } = await handoverFixture();
  const r = runHandover(repo, { task_id: "E-1", summary: "landed" }, opts, {});
  assert.notEqual(r.isError, true, r.content[0].text);
  assert.match(r.content[0].text, /E-1 marked DONE/);
  assert.equal(status(), "DONE");
});

test("run_handover REFUSES with [CI_GATE] when HEAD's run FAILED; task OPEN, LOG unchanged (E-320)", async () => {
  const { repo, db, head, runHandover, status, opts } = await handoverFixture({ git: true });
  const { recordCiRun } = await import("../../src/mcp/shared/ci-runs.js");
  recordCiRun(db, { sha: head, ref: "HEAD", status: "FAIL", started_at: "2026-10-14T08:00:00Z" });
  const r = runHandover(repo, { task_id: "E-1", summary: "should not land" }, opts, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /\[CI_GATE\] no green local CI run for HEAD/);
  assert.equal(statusForResult(r), "REJECTED");
  assert.equal(status(), "OPEN");
  assert.equal(readFileSync(join(repo, ".ai", "LOG.md"), "utf8"), "# LOG\n");
  // …and REIN_CI_GATE=0 is the same bypass it is for update_task_status.
  assert.match(runHandover(repo, { task_id: "E-1", summary: "bypassed" }, opts, { REIN_CI_GATE: "0" }).content[0].text, /E-1 marked DONE/);
});

test("run_handover PASSES the CI gate on a green run for HEAD (E-320)", async () => {
  const { repo, db, head, runHandover, status, opts } = await handoverFixture({ git: true });
  const { recordCiRun } = await import("../../src/mcp/shared/ci-runs.js");
  recordCiRun(db, { sha: head, ref: "HEAD", status: "PASS", started_at: "2026-10-14T08:00:00Z" });
  const r = runHandover(repo, { task_id: "E-1", summary: "landed" }, opts, {});
  assert.notEqual(r.isError, true, r.content[0].text);
  assert.equal(status(), "DONE");
});

test("one gate list: both status writers call completionGates and define no gate text of their own (E-320)", () => {
  const src = (f) => readFileSync(join(REPO, f), "utf8");
  for (const f of ["src/mcp/task-synchronizer-mcp/index.js", "src/mcp/orchestrator-mcp/run-handover.mjs"]) {
    assert.match(src(f), /completionGates\(/, `${f} calls the shared gates`);
    assert.doesNotMatch(src(f), /checkCompletionBuildGate|checkCiDoneGate/, `${f} calls no gate of its own`);
  }
  const all = execFileSync("git", ["-C", REPO, "grep", "-l", "-e", "no green local CI run for HEAD", "-e", "the mirror is current but", "--", "src"], { encoding: "utf8" })
    .trim().split("\n").sort();
  assert.deepEqual(all, ["src/mcp/shared/ci-runs.js", "src/shared/build-stamp.mjs"], "each gate text is defined once");
});
