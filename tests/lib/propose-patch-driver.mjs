#!/usr/bin/env node
// propose-patch-driver.mjs — drive the REAL propose-patch-mcp over stdio JSON-RPC
// through a full two-phase propose → confirm cycle (E-221, D-057 §1).
//
// WHY A DRIVER: the defect is a relationship between TWO calls made from TWO cwds. No
// single-call test and no static grep can express that. Each mode below builds a
// disposable project (or two), runs the real server, and prints one verdict token.
//
// The cross-project modes give the second project a `.ai` SYMLINK to the first's, which
// is what makes one patch store reachable from two roots — without it the second project
// simply has its own empty DB and the interesting case never arises.
//
// Usage: propose-patch-driver.mjs <mode>
//   same | cross | tampered-rel | legacy | legacy-ok | legacy-escape | preview | reject
//   symlink-escape | root-target | failed-apply | orig-collateral
//   multi-section-redirect | ed-prelude
//   foreign-preview | foreign-reject | foreign-list | foreign-list-all | own-preview
// Prints one line: the verdict token, then a tab, then the applied file content ("-" if
// the file was not written).

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { dirname as dirOf } from "node:path";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// E221_SERVER lets the non-vacuity check point the same probe at the PRE-FIX server:
// a guard test that would pass against the vulnerable code is worthless.
const SERVER = process.env.E221_SERVER || join(REPO, "src", "mcp", "propose-patch-mcp", "index.js");
const { getDb } = await import(join(REPO, "src", "mcp", "shared", "state-db.js"));

const mode = process.argv[2] || "same";

function newProject(name) {
  const p = mkdtempSync(join(tmpdir(), `e221-${name}-`));
  mkdirSync(join(p, ".ai"), { recursive: true });
  mkdirSync(join(p, "src"), { recursive: true });
  writeFileSync(join(p, "src", "target.txt"), "original\n");
  return p;
}

// A second root that reaches the FIRST project's patch store.
function siblingSharing(dbOwner, name) {
  const p = mkdtempSync(join(tmpdir(), `e221-${name}-`));
  mkdirSync(join(p, "src"), { recursive: true });
  writeFileSync(join(p, "src", "target.txt"), "original\n");
  symlinkSync(join(dbOwner, ".ai"), join(p, ".ai"));
  return p;
}

// E-294 (D-087): the server's role is the HMAC-verified session token's — AI_OS_CALLER_ROLE is
// no longer evidence (no token → the fail-closed `architect`). Every server therefore runs as
// the direct child of a real PLAIN-LAUNCH session (tests/lib/as-session.sh none → engineer, the
// write target being src/), with CLAUDE_CODE_SESSION_ID naming it. A plain launch has no launch
// record, so the cross-project modes (two cwds) both verify as engineer. The session's token and
// machine key live in a per-driver throwaway HOME, never the operator's ~/.ai-os (rule 6).
const AS = join(REPO, "tests", "lib", "as-session.sh");
const SESSION_HOME = mkdtempSync(join(tmpdir(), "e221-home-"));
mkdirSync(join(SESSION_HOME, ".ai-os"), { recursive: true });
process.on("exit", () => { try { rmSync(SESSION_HOME, { recursive: true, force: true }); } catch { /* temp dir */ } });
let _rpcN = 0;

function rpc(cwd, calls, env = {}) {
  const lines = [
    JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ...calls.map((c, i) =>
      JSON.stringify({ jsonrpc: "2.0", id: i + 2, method: "tools/call", params: { name: c.name, arguments: c.args } })),
  ].join("\n") + "\n";
  try {
    const sid = `e221-${process.pid}-${++_rpcN}`;
    return execFileSync("bash", [AS, "none", sid, "--", "node", "--no-warnings", SERVER], {
      input: lines, encoding: "utf8", cwd, timeout: 25_000,
      // Explicit env — several cases turn on a piece of evidence being ABSENT.
      env: {
        PATH: process.env.PATH, HOME: SESSION_HOME,
        // E-257: telemetry plumbing, not evidence (see patch-mcp-driver.mjs).
        ...(process.env.AI_TELEMETRY_DB_PATH ? { AI_TELEMETRY_DB_PATH: process.env.AI_TELEMETRY_DB_PATH } : {}),
        ...(process.env.AI_TELEMETRY_DISABLE ? { AI_TELEMETRY_DISABLE: process.env.AI_TELEMETRY_DISABLE } : {}),
        CLAUDE_CODE_SESSION_ID: sid,     // the write target is src/: an Engineer (plain-launch) session
        ...env,
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function proposeIn(cwd, relPath = "src/target.txt") {
  const out = rpc(cwd, [{
    name: "propose_patch",
    args: { path: relPath, diff_content: "patched\n", description: "e221 probe", caller_role: "engineer" },
  }]);
  const m = out.match(/patch-[0-9a-f]{8}/);
  return m ? m[0] : null;
}

function verdictOf(out) {
  for (const tok of ["PROJECT_MISMATCH", "PROJECT_ESCAPE", "LEGACY_PATCH", "DIFF_REDIRECT", "ANTI_DRIFT_VIOLATION"]) {
    if (out.includes(tok)) return tok;
  }
  if (/Patch applied/.test(out)) return "applied";
  if (out.includes("Patch not found")) return "not-found";
  if (out === "") return "error";
  return "other";
}

const contentOf = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim() : "-");

const cleanup = [];
let verdict = "error";
let content = "-";

try {
  if (mode === "same") {
    const A = newProject("a"); cleanup.push(A);
    const id = proposeIn(A);
    const out = rpc(A, [{ name: "confirm_patch", args: { patch_id: id } }]);
    verdict = verdictOf(out);
    content = contentOf(join(A, "src", "target.txt"));

  } else if (mode === "cross") {
    // The vulnerability shape: proposed against A, confirmed from B. Pre-E-221 the write
    // followed the stored ABSOLUTE path and landed in A — from a session rooted in B.
    const A = newProject("a"); const B = siblingSharing(A, "b"); cleanup.push(A, B);
    const id = proposeIn(A);
    const out = rpc(B, [{ name: "confirm_patch", args: { patch_id: id } }]);
    verdict = verdictOf(out);
    content = `${contentOf(join(A, "src", "target.txt"))}|${contentOf(join(B, "src", "target.txt"))}`;

  } else if (mode === "tampered-rel") {
    // rel_path is DATA, not a verified destination. A row edited in the DB must still
    // be unable to escape: the bounds check is re-run at confirm time.
    const A = newProject("a"); cleanup.push(A);
    const outside = join(A, "..", `e221-canary-${process.pid}.txt`);
    const id = proposeIn(A);
    const db = getDb(join(A, ".ai"));
    db.prepare("UPDATE patches SET rel_path = ? WHERE id = ?")
      .run(`../${"e221-canary-" + process.pid}.txt`, id);
    const out = rpc(A, [{ name: "confirm_patch", args: { patch_id: id } }]);
    verdict = verdictOf(out);
    content = contentOf(outside);
    try { rmSync(outside, { force: true }); } catch { /* nothing written is the pass */ }

  } else if (mode === "legacy" || mode === "legacy-ok") {
    // A row written before the migration: absolute path, no project root.
    const A = newProject("a"); cleanup.push(A);
    const id = proposeIn(A);
    const db = getDb(join(A, ".ai"));
    db.prepare("UPDATE patches SET project_root = NULL, rel_path = NULL WHERE id = ?").run(id);
    const env = mode === "legacy-ok" ? { AI_OS_PATCH_LEGACY: "1" } : {};
    const out = rpc(A, [{ name: "confirm_patch", args: { patch_id: id } }], env);
    verdict = verdictOf(out);
    content = contentOf(join(A, "src", "target.txt"));

  } else if (mode === "legacy-escape") {
    // Even the rollback path bounds-checks the stored absolute path against THIS root.
    const A = newProject("a"); cleanup.push(A);
    const outside = join(tmpdir(), `e221-legacy-canary-${process.pid}.txt`);
    const id = proposeIn(A);
    const db = getDb(join(A, ".ai"));
    db.prepare("UPDATE patches SET project_root = NULL, rel_path = NULL, path = ? WHERE id = ?")
      .run(outside, id);
    const out = rpc(A, [{ name: "confirm_patch", args: { patch_id: id } }], { AI_OS_PATCH_LEGACY: "1" });
    verdict = verdictOf(out);
    content = contentOf(outside);
    try { rmSync(outside, { force: true }); } catch { /* nothing written is the pass */ }

  } else if (mode === "symlink-escape") {
    // E-221 audit H1: a symlinked DIRECTORY component inside the project. The old
    // four-line safePath was lexical, so the relative path contained no ".." and the
    // write followed the link out of the project — one project, no DB tampering.
    const base = mkdtempSync(join(tmpdir(), "e221-esc-"));
    const A = join(base, "proj");
    mkdirSync(join(A, ".ai"), { recursive: true });
    mkdirSync(join(A, "src"), { recursive: true });
    mkdirSync(join(base, "outside"), { recursive: true });
    writeFileSync(join(base, "outside", "victim.txt"), "UNTOUCHED\n");
    symlinkSync(join(base, "outside"), join(A, "src", "esc"));
    cleanup.push(base);
    const id = proposeIn(A, "src/esc/victim.txt");
    const out = id ? rpc(A, [{ name: "confirm_patch", args: { patch_id: id } }]) : "";
    verdict = id ? verdictOf(out) : "refused-at-propose";
    content = contentOf(join(base, "outside", "victim.txt"));

  } else if (mode === "root-target") {
    // E-221 audit L1: `path: "."` stores rel_path === "". The legacy branch is the one
    // that SKIPS the equality check, so it must not be selected by a record's own value.
    const A = newProject("a"); cleanup.push(A);
    const id = proposeIn(A, ".");
    const out = id ? rpc(A, [{ name: "confirm_patch", args: { patch_id: id } }]) : "";
    verdict = id ? verdictOf(out) : "refused-at-propose";
    content = "-";

  } else if (mode === "failed-apply") {
    // A diff that passes nothing: the file must be byte-identical afterwards and the
    // message must not claim a restore that did not happen.
    const A = newProject("a"); cleanup.push(A);
    const target = join(A, "src", "target.txt");
    const before = readFileSync(target, "utf8");
    const id = proposeIn(A);
    const db = getDb(join(A, ".ai"));
    db.prepare("UPDATE patches SET diff_content = ? WHERE id = ?")
      .run("@@ -1,1 +1,1 @@\n-NOT_THE_CURRENT_CONTENT\n+attacker\n", id);
    const out = rpc(A, [{ name: "confirm_patch", args: { patch_id: id } }]);
    const after = readFileSync(target, "utf8");
    verdict = after === before ? "unchanged" : "MUTATED";
    // A stray .orig in the tree is the collateral the old `-b` rollback left behind.
    content = existsSync(`${target}.orig`) ? "stray-orig" : "clean";
    void out;

  } else if (mode === "orig-collateral") {
    // E-221 audit M2: patch(1) backs up to `${target}.orig` on its own. A user file of
    // that name was overwritten with the pre-image and then unlinked on success — data
    // loss caused by rollback housekeeping.
    const A = newProject("a"); cleanup.push(A);
    const orig = join(A, "src", "target.txt.orig");
    writeFileSync(orig, "MY OWN FILE\n");
    const id = proposeIn(A);
    const out = rpc(A, [{ name: "confirm_patch", args: { patch_id: id } }]);
    verdict = /Patch applied/.test(out) ? "applied" : "other";
    content = contentOf(orig);

  } else if (mode === "multi-section-redirect" || mode === "ed-prelude") {
    // E-221 audit H3/H2: `diff_content` names its own write targets. patch(1) applies the
    // validated operand to the FIRST section only; later sections choose their own. An ed
    // prelude needs no header at all and still writes.
    const base = mkdtempSync(join(tmpdir(), "e221-blob-"));
    const A = join(base, "proj");
    mkdirSync(join(A, ".ai"), { recursive: true });
    mkdirSync(join(A, "src"), { recursive: true });
    mkdirSync(join(base, "outside"), { recursive: true });
    writeFileSync(join(A, "src", "target.txt"), "TARGET_ORIGINAL\n");
    writeFileSync(join(A, "z.txt"), "TARGET_ORIGINAL\n");
    writeFileSync(join(base, "outside", "victim.txt"), "VICTIM_ORIGINAL\n");
    cleanup.push(base);
    const blob = mode === "multi-section-redirect"
      ? "--- a\n+++ a\n@@ -1,1 +1,1 @@\n-TARGET_ORIGINAL\n+benign\n" +
        "--- ../outside/victim.txt\n+++ ../outside/victim.txt\n@@ -1,1 +1,1 @@\n-VICTIM_ORIGINAL\n+PWNED\n"
      : "1c\nATTACKER_CONTENT\n.\nw\n--- z.txt\n+++ z.txt\n@@ -1,1 +1,1 @@\n-TARGET_ORIGINAL\n+z\n";
    const out = rpc(A, [{ name: "propose_patch",
      args: { path: "src/target.txt", diff_content: blob, caller_role: "engineer" } }]);
    const id = (out.match(/patch-[0-9a-f]{8}/) || [null])[0];
    const conf = id ? rpc(A, [{ name: "confirm_patch", args: { patch_id: id } }]) : "";
    verdict = id ? verdictOf(conf) : "refused-at-propose";
    if (!id && /DIFF_REDIRECT/.test(out)) verdict = "DIFF_REDIRECT";
    // Report every file the blob could have touched.
    content = [
      contentOf(join(A, "src", "target.txt")),
      contentOf(join(A, "z.txt")),
      contentOf(join(base, "outside", "victim.txt")),
    ].join("|");

  } else if (mode === "foreign-preview" || mode === "foreign-reject" || mode === "foreign-list") {
    // E-226 (D-058 §4): the read-only tools were out of D-057 §1's scope, so they kept
    // trusting the stored ABSOLUTE path. preview_patch read it to build a diff baseline,
    // so a file outside the previewing project was rendered into tool output.
    const A = newProject("a"); const B = siblingSharing(A, "b"); cleanup.push(A, B);
    // A canary OUTSIDE B's root, named by the row A proposed.
    writeFileSync(join(A, "src", "target.txt"), "TOP_SECRET_CANARY_CONTENT\n");
    const id = proposeIn(A);
    let out = "";
    if (mode === "foreign-preview") out = rpc(B, [{ name: "preview_patch", args: { patch_id: id } }]);
    if (mode === "foreign-reject")  out = rpc(B, [{ name: "reject_patch",  args: { patch_id: id } }]);
    if (mode === "foreign-list")    out = rpc(B, [{ name: "list_pending_patches", args: {} }]);
    const leaked = out.includes("TOP_SECRET_CANARY_CONTENT");
    const absLeak = out.includes(A);   // an absolute path from the other project
    verdict = leaked ? "LEAKED"
      : absLeak ? "ABS_PATH_LEAKED"
      : /\[FOREIGN_PROJECT\]/.test(out) ? "FOREIGN_BANNER"
      : verdictOf(out);
    // For reject, also confirm the row SURVIVED (it is another project's queue).
    const still = rpc(A, [{ name: "list_pending_patches", args: {} }]).includes(id);
    content = `${still ? "row-kept" : "row-deleted"}`;

  } else if (mode === "foreign-list-all") {
    const A = newProject("a"); const B = siblingSharing(A, "b"); cleanup.push(A, B);
    const id = proposeIn(A);
    const out = rpc(B, [{ name: "list_pending_patches", args: { all: true } }]);
    verdict = out.includes(A) ? "ABS_PATH_LEAKED"
      : (out.includes("FOREIGN_PROJECT") && out.includes(id) ? "listed-safely" : "other");
    content = "-";

  } else if (mode === "own-preview") {
    // The legitimate case must still render a real baseline.
    const A = newProject("a"); cleanup.push(A);
    const id = proposeIn(A);
    const out = rpc(A, [{ name: "preview_patch", args: { patch_id: id } }]);
    verdict = /FOREIGN_PROJECT|LEGACY_PATCH/.test(out) ? "wrongly-foreign"
      : (/patched|target\.txt/.test(out) ? "previewed" : "other");
    content = contentOf(join(A, "src", "target.txt"));

  } else if (mode === "preview") {
    const A = newProject("a"); cleanup.push(A);
    const id = proposeIn(A);
    const out = rpc(A, [{ name: "preview_patch", args: { patch_id: id } }]);
    verdict = /e221 probe|patched/.test(out) ? "previewed" : "other";
    content = contentOf(join(A, "src", "target.txt"));   // must still be untouched

  } else if (mode === "reject") {
    const A = newProject("a"); cleanup.push(A);
    const id = proposeIn(A);
    const out = rpc(A, [{ name: "reject_patch", args: { patch_id: id } }]);
    const after = rpc(A, [{ name: "confirm_patch", args: { patch_id: id } }]);
    verdict = /rejected and discarded/.test(out) && verdictOf(after) === "not-found" ? "rejected" : "other";
    content = contentOf(join(A, "src", "target.txt"));
  }
} finally {
  for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }); } catch { /* temp dir */ } }
}

process.stdout.write(`${verdict}\t${content}\n`);
