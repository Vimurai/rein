// mcp-paths.test.mjs — the one `${VAR}` reader of .mcp.json (E-409, D-143 r3). This is
// mcp-claim.test.mjs renamed and cut to that scope: the claim, refusal, --adopt, dead-install and
// mixed-prefix rows are deleted with the behaviour they asserted (D-143 r2). The process boundary
// (rein doctor's line and exit) is E-409.06 in tests/suites/rein_sync_test.sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expandVars, expandDoc, doctorLines } from "../../src/shared/mcp-paths.mjs";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI = join(REPO, "src", "shared", "mcp-paths.mjs");

function sandbox(t) {
  const d = mkdtempSync(join(tmpdir(), "rein-mcp-paths-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  mkdirSync(join(d, "home", ".rein", "mcp", "s0-mcp"), { recursive: true });
  writeFileSync(join(d, "home", ".rein", "mcp", "s0-mcp", "index.js"), "");
  return { d, home: join(d, "home"), file: join(d, ".mcp.json") };
}
const write = (file, servers) => writeFileSync(file, JSON.stringify({ mcpServers: servers }));

test("expandVars: the grammar Claude Code applies to .mcp.json — ${VAR} and ${VAR:-default}, nothing else", () => {
  const env = { HOME: "/h" };
  for (const [input, want] of [
    ["${HOME}/.rein/mcp/x/index.js", "/h/.rein/mcp/x/index.js"],
    ["${UNSET:-/d}/x", "/d/x"],
    ["${HOME:-/d}/x", "/h/x"],
    ["${UNSET}/x", "/x"],            // unset, no default → ""
    ["$HOME/x", "$HOME/x"],          // the bare form is not the grammar
    ["${HOME-/d}", "${HOME-/d}"],    // nor is the `-` (unset-only) form
    ["a ${HOME} b ${UNSET:-c}", "a /h b c"],
  ]) assert.equal(expandVars(input, env), want, input);
  assert.equal(expandVars(42, env), 42, "a non-string passes through");
});

test("expandDoc: command and args are expanded; env and other fields are left as written", () => {
  const doc = { mcpServers: { s: { command: "${N:-node}", args: ["${HOME}/a", 3], env: { K: "${HOME}" } } }, other: 1 };
  const out = expandDoc(doc, { HOME: "/h" });
  assert.deepEqual(out.mcpServers.s, { command: "node", args: ["/h/a", 3], env: { K: "${HOME}" } });
  assert.equal(out.other, 1);
  assert.equal(doc.mcpServers.s.command, "${N:-node}", "the input is not mutated");
});

test("doctorLines: no file, invalid JSON, every path present, and [MCP_PATHS_MISSING] counted per server", (t) => {
  const { home, file } = sandbox(t);
  const env = { HOME: home };
  assert.deepEqual(doctorLines(file, { env }), { code: 0, lines: ["  - .mcp.json: none (rein sync writes it)"] });
  writeFileSync(file, "{ not json");
  assert.equal(doctorLines(file, { env }).code, 1);
  assert.match(doctorLines(file, { env }).lines[0], /not valid JSON — run: rein sync/);
  write(file, {
    s0: { command: "node", args: ["${HOME}/.rein/mcp/s0-mcp/index.js"] },
    fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },   // no absolute path: not a claim
  });
  assert.deepEqual(doctorLines(file, { env }), { code: 0, lines: ["  ✓ .mcp.json paths: all valid (1 server(s))"] });
  write(file, {
    s0: { command: "node", args: ["${HOME}/.rein/mcp/s0-mcp/index.js"] },
    a: { command: "node", args: ["${GONE:-/nonexistent-e409}/a/index.js"] },
    b: { command: "/nonexistent-e409/bin/node", args: ["${HOME}/.rein/mcp/s0-mcp/index.js"] },   // a dead command counts too
  });
  assert.deepEqual(doctorLines(file, { env }), {
    code: 1, lines: ["  ✗ [MCP_PATHS_MISSING] 2 servers point at paths that do not exist — run: rein sync"],
  });
});

test("the CLI: doctor's exit is its verdict; expand prints the expanded file; a bad call is usage (2)", (t) => {
  const { home, file } = sandbox(t);
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8", env: { ...process.env, HOME: home } });
  write(file, { s0: { command: "node", args: ["${HOME}/.rein/mcp/s0-mcp/index.js"] } });
  let r = run("doctor", file);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✓ \.mcp\.json paths: all valid/);
  r = run("expand", file);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).mcpServers.s0.args[0], join(home, ".rein/mcp/s0-mcp/index.js"));
  write(file, { a: { command: "node", args: ["${GONE:-/nonexistent-e409}/a/index.js"] } });
  r = run("doctor", file);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\[MCP_PATHS_MISSING\] 1 servers/);
  assert.equal(run("nope", file).status, 2);
  assert.equal(run("expand", join(dirname(file), "absent.json")).status, 1);
});
