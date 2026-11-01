// mcp-claim.test.mjs — which Rein install a project's .mcp.json belongs to (E-409, D-141
// addendum 2). New module, new file; the process boundary (rein sync / rein init refusing,
// rein doctor's line) is pinned in tests/suites/rein_sync_test.sh beside the other sync rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reinPrefixes, claimCheck, doctorLines } from "../../src/shared/mcp-claim.mjs";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));   // tests/unit/<this> → repo root
const CLI = join(REPO, "src", "shared", "mcp-claim.mjs");

/** A sandbox: two installs (<d>/a/.rein, <d>/b/.rein, each with mcp/), a project dir. */
function sandbox(t) {
  const d = mkdtempSync(join(tmpdir(), "rein-claim-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  for (const h of ["a", "b"]) for (const n of ["s0-mcp", "s1-mcp"]) {
    mkdirSync(join(d, h, ".rein", "mcp", n), { recursive: true });
    writeFileSync(join(d, h, ".rein", "mcp", n, "index.js"), "");
  }
  mkdirSync(join(d, "proj"));
  return { d, a: join(d, "a", ".rein"), b: join(d, "b", ".rein"), proj: join(d, "proj"), file: join(d, "proj", ".mcp.json") };
}
const doc = (...prefixes) => ({
  mcpServers: Object.fromEntries([
    ["filesystem", { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2026.1.14", "."] }],
    ["mine", { command: "node", args: [process.execPath] }],   // user-added, not Rein (a path that exists)
    ...prefixes.map((p, i) => [`s${i}-mcp`, { command: "node", args: [join(p, "mcp", `s${i}-mcp`, "index.js")] }]),
  ]),
});
const put = (s, d) => writeFileSync(s.file, JSON.stringify(d, null, 2) + "\n");

test("reinPrefixes: the <prefix>/.rein the Rein (*-mcp) node entries share; user servers and npx are not claims", (t) => {
  const s = sandbox(t);
  assert.deepEqual([...reinPrefixes(doc(s.a, s.a))], [s.a]);
  assert.deepEqual([...reinPrefixes(doc(s.a, s.b))].sort(), [s.a, s.b].sort());
  assert.deepEqual([...reinPrefixes(doc())], []);
  assert.deepEqual([...reinPrefixes({})], []);
  assert.deepEqual([...reinPrefixes(null)], []);
});

test("claimCheck: no file, no Rein entries, or the same install → write", (t) => {
  const s = sandbox(t);
  assert.equal(claimCheck(s.file, s.a).action, "write", "no file is unregistered");
  put(s, doc());
  assert.equal(claimCheck(s.file, s.a).action, "write", "no Rein entries is unregistered");
  put(s, doc(s.a));
  assert.equal(claimCheck(s.file, s.a).action, "write");
  writeFileSync(s.file, "{ not json");
  assert.equal(claimCheck(s.file, s.a).action, "write", "an unparsable file claims nothing (the writer keeps a .bak)");
});

test("claimCheck: the same install through a symlink is the same install (canonical real paths, r1)", (t) => {
  const s = sandbox(t);
  symlinkSync(s.a, join(s.d, "a-link"));
  put(s, doc(join(s.d, "a-link")));
  assert.equal(claimCheck(s.file, s.a).action, "write");
  put(s, doc(s.a));
  assert.equal(claimCheck(s.file, join(s.d, "a-link")).action, "write");
});

test("claimCheck: a LIVE foreign install refuses with the [FOREIGN_PROJECT] line (r2)", (t) => {
  const s = sandbox(t);
  put(s, doc(s.a));
  const r = claimCheck(s.file, s.b);
  assert.equal(r.action, "refuse");
  assert.equal(r.code, 3);
  assert.equal(r.message, `[FOREIGN_PROJECT] ${s.proj} is registered to ${s.a} — run rein sync from that HOME, or rein init --adopt`);
});

test("claimCheck: a DEAD foreign install claims nothing — the outage's recovery path (r2)", (t) => {
  const s = sandbox(t);
  put(s, doc(join(s.d, "gone", ".rein")));
  const r = claimCheck(s.file, s.a);
  assert.equal(r.action, "write");
  assert.match(r.message, /pointed at .*gone\/\.rein, which no longer exists — rewritten for /);
  rmSync(join(s.b, "mcp"), { recursive: true });       // an install dir without mcp/ is dead too
  put(s, doc(s.b));
  assert.equal(claimCheck(s.file, s.a).action, "write");
});

test("claimCheck: mixed prefixes are a broken file, rewritten with one line naming them (r3)", (t) => {
  const s = sandbox(t);
  put(s, doc(s.a, s.b));
  const r = claimCheck(s.file, s.a);
  assert.equal(r.action, "write");
  assert.equal(r.message.split("\n").length, 1);
  assert.match(r.message, /named several installs \(.*a\/\.rein, .*b\/\.rein\) — rewritten for /);
});

test("claimCheck: --adopt is the only override and prints the old and the new install (r4)", (t) => {
  const s = sandbox(t);
  put(s, doc(s.a));
  const r = claimCheck(s.file, s.b, { adopt: true });
  assert.equal(r.action, "write");
  assert.equal(r.message, `adopted ${s.proj}: ${s.a} → ${s.b}`);
  const env = spawnSync(process.execPath, [CLI, "check", s.file, s.b], { encoding: "utf8", env: { ...process.env, REIN_MCP_ADOPT: "1", REIN_ADOPT: "1" } });
  assert.equal(env.status, 3, "no environment variable bypasses the refusal");
});

test("doctorLines: dead server paths are [MCP_PATHS_MISSING]; a live foreign claim is [FOREIGN_PROJECT] (r5)", (t) => {
  const s = sandbox(t);
  put(s, doc(s.a));
  const ok = doctorLines(s.file, s.a);
  assert.equal(ok.code, 0);
  assert.match(ok.lines.join("\n"), /✓ \.mcp\.json: 1 Rein server\(s\), every path present/);
  put(s, doc(join(s.d, "gone", ".rein"), join(s.d, "gone", ".rein")));
  const gone = doctorLines(s.file, s.a);
  assert.equal(gone.code, 1);
  assert.ok(gone.lines.includes("  ✗ [MCP_PATHS_MISSING] 2 servers point at paths that do not exist — run: rein sync"), gone.lines.join("\n"));
  put(s, doc(s.a));
  const foreign = doctorLines(s.file, s.b);
  assert.equal(foreign.code, 1);
  assert.match(foreign.lines.join("\n"), /✗ \[FOREIGN_PROJECT\] .* is registered to .*a\/\.rein/);
  assert.deepEqual(doctorLines(join(s.d, "none.json"), s.a), { code: 0, lines: ["  - .mcp.json: none (rein sync writes it)"] });
});

test("the CLI: check exits 3 and leaves the file byte-identical on a refusal; doctor's exit is its verdict", (t) => {
  const s = sandbox(t);
  put(s, doc(s.a));
  const before = readFileSync(s.file, "utf8");
  const r = spawnSync(process.execPath, [CLI, "check", s.file, s.b], { encoding: "utf8" });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /^\[FOREIGN_PROJECT\] /);
  assert.equal(readFileSync(s.file, "utf8"), before);
  assert.equal(spawnSync(process.execPath, [CLI, "check", s.file, s.b, "--adopt"], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync(process.execPath, [CLI, "doctor", s.file, s.b]).status, 1);
  assert.equal(spawnSync(process.execPath, [CLI, "doctor", s.file, s.a]).status, 0);
  assert.equal(spawnSync(process.execPath, [CLI, "bogus"]).status, 2, "an unknown subcommand is an error");
});
