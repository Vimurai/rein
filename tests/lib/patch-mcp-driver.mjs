#!/usr/bin/env node
// patch-mcp-driver.mjs — drive the REAL patch-mcp server over stdio JSON-RPC and report
// whether a write was allowed or refused.
//
// WHY A DRIVER: a static grep cannot tell you whether the guard actually refuses a
// write, and E-219's whole point is that the previous guard *looked* correct while
// allowing an unidentified caller through. Each case runs a real server against a
// disposable project and inspects the result.
//
// Usage: patch-mcp-driver.mjs <target> <extra-args-json> [<project dir>]
//   target: src | ai | symlink | hardlink
//   project dir: E-294 — reuse this AI-OS project instead of a fresh temp one (it is reset,
//   never deleted). The session token verifies only when the walk from the server's cwd agrees
//   with the session's launch record, whose `project` is the root the session started in — so a
//   suite that runs the driver inside a real session (tests/lib/as-session.sh) starts that
//   session in this same directory, exactly as a claude session and its MCP servers share one.
// Prints exactly one of: allow | BLOCK | error
//
// The targets are RESET before every run: a successful patch mutates the file, so a
// later case's old_content stops matching and the result reads as "error" — which
// looked like three product failures the first time this was written, and was entirely
// the harness.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = join(REPO, "src", "mcp", "patch-mcp", "index.js");

const [, , target = "src", extraJson = "{}", projArg = ""] = process.argv;

const proj = projArg || mkdtempSync(join(tmpdir(), "e219-drv-"));
mkdirSync(join(proj, ".ai"), { recursive: true });
rmSync(join(proj, ".ai", "link.txt"), { force: true });
rmSync(join(proj, ".ai", "hard.txt"), { force: true });
mkdirSync(join(proj, "src"), { recursive: true });
writeFileSync(join(proj, "src", "target.txt"), "original\n");
writeFileSync(join(proj, ".ai", "target.txt"), "original\n");

let relPath;
switch (target) {
  case "ai":
    relPath = ".ai/target.txt";
    break;
  case "symlink":
    // A link the Architect may legitimately create inside its own scope, pointing out of it.
    symlinkSync(join(proj, "src", "target.txt"), join(proj, ".ai", "link.txt"));
    relPath = ".ai/link.txt";
    break;
  case "hardlink":
    linkSync(join(proj, "src", "target.txt"), join(proj, ".ai", "hard.txt"));
    relPath = ".ai/hard.txt";
    break;
  default:
    relPath = "src/target.txt";
}

const args = {
  path: relPath,
  old_content: "original",
  new_content: "patched",
  ...JSON.parse(extraJson),
};

const req = [
  JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  }),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "patch_file", arguments: args } }),
].join("\n") + "\n";

let verdict = "error";
try {
  const out = execFileSync("node", ["--no-warnings", SERVER], {
    input: req, encoding: "utf8", cwd: proj, timeout: 25_000,
    // Explicit env: the point of several cases is that a piece of evidence is ABSENT,
    // so inheriting the parent's would defeat them.
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      // E-257: telemetry plumbing, not evidence — without it every call this driver makes
      // is recorded in the operator's live store (56 rows per CI run before this).
      ...(process.env.AI_TELEMETRY_DB_PATH ? { AI_TELEMETRY_DB_PATH: process.env.AI_TELEMETRY_DB_PATH } : {}),
      ...(process.env.AI_TELEMETRY_DISABLE ? { AI_TELEMETRY_DISABLE: process.env.AI_TELEMETRY_DISABLE } : {}),
      ...(process.env.CLAUDE_CODE_SESSION_ID ? { CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID } : {}),
      ...(process.env.AI_OS_CALLER_ROLE ? { AI_OS_CALLER_ROLE: process.env.AI_OS_CALLER_ROLE } : {}),
      ...(process.env.AI_OS_SOVEREIGNTY_LOCK ? { AI_OS_SOVEREIGNTY_LOCK: process.env.AI_OS_SOVEREIGNTY_LOCK } : {}),
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  verdict = /ANTI_DRIFT_VIOLATION/.test(out) ? "BLOCK" : (/"isError":\s*true/.test(out) ? "error" : "allow");
} catch {
  verdict = "error";
}

if (!projArg) rmSync(proj, { recursive: true, force: true });
process.stdout.write(verdict);
