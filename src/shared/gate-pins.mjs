#!/usr/bin/env node
// gate-pins.mjs — E-305 (D-089 r3, sovereignty-hardening.md §Hook Toolchain Pinning Component 9):
// every package a gate path imports is pinned EXACTLY, and the install must hold exactly that.
//
// Why: a parser IS the gate's input model. `shell-quote@^1.8.1` resolved 1.12.0 on a fresh
// install, which returns `&>` / `>|` as single operators, and the Architect write gate stopped
// seeing them (b36a818). A moved dependency is the same class as a moved interpreter
// (E-286, [TOOLCHAIN_STALE]).
//
//   node gate-pins.mjs check <mcp-dir>   0 all installed == pinned | 1 a DIFFERENT version is
//                                        installed (one "[TOOLCHAIN_STALE] <pkg> <installed> !=
//                                        <pinned> — run: bash install-rein.sh" line each) | 4 only
//                                        MISSING ones ("[GATE_DEP_MISSING] …") — not drift: the gate
//                                        fails closed without them ([SAFE_EXEC_UNAVAILABLE]) | 2 a range
//   node gate-pins.mjs list  <mcp-dir>   "<pkg>@<version>" per gate dependency
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** MCP servers whose code runs on a gate path (the PreToolUse hook, pre-commit, caller-role). */
export const GATE_SERVERS = ["safe-exec-mcp"];
const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** [{server, pkg, pinned}] from each gate server's package.json; throws on a range. */
export function gatePins(mcpDir) {
  const out = [];
  for (const server of GATE_SERVERS) {
    const pj = join(mcpDir, server, "package.json");
    if (!existsSync(pj)) continue;
    const deps = JSON.parse(readFileSync(pj, "utf8")).dependencies || {};
    for (const [pkg, spec] of Object.entries(deps)) {
      if (!EXACT.test(String(spec))) throw new Error(`${server}: ${pkg} is "${spec}" — a gate dependency must be an exact version`);
      out.push({ server, pkg, pinned: String(spec) });
    }
  }
  return out;
}

/** The version a server would load: its own node_modules first, then the workspace root's. */
export function installedVersion(mcpDir, server, pkg) {
  for (const base of [join(mcpDir, server), resolve(mcpDir, "..")]) {
    const p = join(base, "node_modules", pkg, "package.json");
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")).version || null; } catch { return null; }
    }
  }
  return null;
}

/** [{pkg, pinned, installed, ok}] */
export function checkPins(mcpDir) {
  return gatePins(mcpDir).map(({ server, pkg, pinned }) => {
    const installed = installedVersion(mcpDir, server, pkg);
    return { server, pkg, pinned, installed, ok: installed === pinned };
  });
}

function main(argv) {
  const [cmd, dir] = argv;
  if (!["check", "list"].includes(cmd) || !dir) {
    process.stderr.write("usage: gate-pins.mjs check|list <mcp-dir>\n");
    return 2;
  }
  let rows;
  try { rows = cmd === "list" ? gatePins(resolve(dir)) : checkPins(resolve(dir)); }
  catch (e) { process.stdout.write(`[GATE_PIN_RANGE] ${e.message}\n`); return 2; }
  if (cmd === "list") {
    for (const r of rows) process.stdout.write(`${r.pkg}@${r.pinned}\n`);
    return 0;
  }
  let drift = 0, missing = 0;
  for (const r of rows) {
    if (r.ok) continue;
    if (r.installed === null) {
      missing++;
      process.stdout.write(`[GATE_DEP_MISSING] ${r.pkg} not installed (pinned ${r.pinned}) — run: ai mcp-setup\n`);
    } else {
      drift++;
      process.stdout.write(`[TOOLCHAIN_STALE] ${r.pkg} ${r.installed} != ${r.pinned} — run: bash install-rein.sh\n`);
    }
  }
  return drift ? 1 : missing ? 4 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
