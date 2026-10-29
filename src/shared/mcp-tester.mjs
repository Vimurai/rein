#!/usr/bin/env node
/**
 * mcp-tester.mjs — MCP Connection Tester (E-176, doctor-and-cache-optimizations.md §Components 2)
 *
 * Programmatically launches each MCP server declared in the active config
 * (`.mcp.json` by default), performs the minimum JSON-RPC stdio handshake to
 * reach `tools/list`, and reports per-server connectivity. Used by
 * `ai doctor --env` to surface servers that fail to boot or never answer.
 *
 * SECURITY (blueprint §Security):
 *   - Each child is spawned with a CURATED env — only PATH + HOME plus the
 *     env the server itself declares in the config. The parent's full
 *     environment (which may hold unrelated tokens) is NEVER forwarded, so a
 *     misbehaving server cannot harvest ambient secrets.
 *   - The probe sends ONLY `initialize` + `notifications/initialized` +
 *     `tools/list`. It NEVER issues `tools/call`, so no execution-capable tool
 *     is ever invoked during a connectivity check.
 *   - Child stderr is discarded; we never echo server output that could carry
 *     secret-bearing diagnostics.
 *
 * CLI:
 *   node mcp-tester.mjs [--config <path>] [--timeout <ms>] [--concurrency <n>] [--json]
 *     → prints a "[OK]/[FAIL] <server>" checklist, exits 1 if any server fails.
 *
 * Library:
 *   import { testMcpServers, loadServerConfigs } from "./mcp-tester.mjs";
 *   const results = await testMcpServers({ configPath, timeoutMs });
 *   // results: Array<{ name, ok, toolCount, error, durationMs }>
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_CONCURRENCY = 8;

/**
 * Read an MCP config file and return [{ name, command, args, env }].
 * Supports the standard `{ "mcpServers": { name: { command, args, env } } }`
 * shape used by .mcp.json.
 */
export function loadServerConfigs(configPath, mcpKey = "mcpServers") {
  if (!existsSync(configPath)) {
    throw new Error(`config not found: ${configPath}`);
  }
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  const servers = cfg[mcpKey] || {};
  return Object.entries(servers).map(([name, s]) => ({
    name,
    command: s.command,
    args: Array.isArray(s.args) ? s.args : [],
    env: s.env && typeof s.env === "object" ? s.env : {},
  }));
}

/**
 * Build the curated child environment: PATH + HOME + the server's own declared
 * env. Nothing else from process.env is forwarded (blueprint §Security).
 */
function curatedEnv(serverEnv) {
  const base = {};
  if (process.env.PATH) base.PATH = process.env.PATH;
  if (process.env.HOME) base.HOME = process.env.HOME;
  // Resolve ${VAR} placeholders in declared env against the real environment so
  // a configured token (e.g. ${SERVICE_API_KEY}) is passed through, but only
  // the specific vars the server opted into — never the whole parent env.
  for (const [k, v] of Object.entries(serverEnv)) {
    base[k] = typeof v === "string"
      ? v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
      : v;
  }
  return base;
}

/**
 * Probe a single MCP server: spawn it, run the handshake, await tools/list.
 * Always resolves (never rejects) with a structured result.
 */
export function probeServer(server, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolveResult) => {
    const started = Date.now();
    const done = (partial) =>
      resolveResult({
        name: server.name,
        ok: false,
        toolCount: 0,
        error: null,
        durationMs: Date.now() - started,
        ...partial,
      });

    if (!server.command) {
      return done({ error: "no command in config" });
    }

    let child;
    try {
      child = spawn(server.command, server.args, {
        env: curatedEnv(server.env),
        stdio: ["pipe", "pipe", "ignore"], // discard stderr (may carry secrets)
      });
    } catch (e) {
      return done({ error: `spawn failed: ${e.message}` });
    }

    let settled = false;
    let stdout = "";

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done({ error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    const finish = (partial) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done(partial);
    };

    child.on("error", (e) => finish({ error: `spawn error: ${e.message}` }));
    child.on("exit", (code) => {
      // Exited before we saw a tools/list response → boot failure.
      if (!settled) finish({ error: `exited (code ${code}) before tools/list` });
    });

    child.stdout.on("data", (buf) => {
      stdout += buf.toString();
      // The response we want has id === 2 (our tools/list request).
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        let obj;
        try { obj = JSON.parse(t); } catch { continue; }
        if (obj.id === 2) {
          if (obj.error) {
            return finish({ error: `tools/list error: ${obj.error.message || "rpc error"}` });
          }
          const tools = obj.result?.tools;
          if (Array.isArray(tools)) {
            return finish({ ok: true, toolCount: tools.length });
          }
          return finish({ error: "tools/list returned no tools array" });
        }
      }
    });

    // Minimal handshake — initialize, ack, then ONLY tools/list (never tools/call).
    const frames = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mcp-tester", version: "1.0" },
        } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ].map((f) => JSON.stringify(f)).join("\n") + "\n";

    try {
      child.stdin.write(frames);
      child.stdin.end();
    } catch (e) {
      finish({ error: `stdin write failed: ${e.message}` });
    }
  });
}

/**
 * Test every server in the config, bounded by `concurrency`, each with its own
 * `timeoutMs`. Returns the per-server results in config order.
 */
export async function testMcpServers({
  configPath = resolve(process.cwd(), ".mcp.json"),
  mcpKey = "mcpServers",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY,
  only = null,
} = {}) {
  let servers = loadServerConfigs(configPath, mcpKey);
  if (Array.isArray(only) && only.length) {
    const want = new Set(only);
    servers = servers.filter((s) => want.has(s.name));
  }

  const results = new Array(servers.length);
  let next = 0;
  const worker = async () => {
    while (next < servers.length) {
      const i = next++;
      results[i] = await probeServer(servers[i], timeoutMs);
    }
  };
  const pool = Array.from({ length: Math.min(concurrency, servers.length) }, worker);
  await Promise.all(pool);
  return results;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { configPath: null, timeoutMs: DEFAULT_TIMEOUT_MS, concurrency: DEFAULT_CONCURRENCY, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") out.configPath = argv[++i];
    else if (a === "--timeout") out.timeoutMs = parseInt(argv[++i], 10) || DEFAULT_TIMEOUT_MS;
    else if (a === "--concurrency") out.concurrency = parseInt(argv[++i], 10) || DEFAULT_CONCURRENCY;
    else if (a === "--json") out.json = true;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let configPath = opts.configPath || resolve(process.cwd(), ".mcp.json");
  if (!isAbsolute(configPath)) configPath = resolve(process.cwd(), configPath);

  let results;
  try {
    results = await testMcpServers({
      configPath,
      timeoutMs: opts.timeoutMs,
      concurrency: opts.concurrency,
    });
  } catch (e) {
    if (opts.json) process.stdout.write(JSON.stringify({ error: e.message }) + "\n");
    else process.stdout.write(`[FAIL] mcp-tester: ${e.message}\n`);
    process.exit(1);
  }

  const failed = results.filter((r) => !r.ok);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ results, failed: failed.length }) + "\n");
  } else {
    for (const r of results) {
      process.stdout.write(
        r.ok
          ? `  [OK]   ${r.name} (${r.toolCount} tools, ${r.durationMs}ms)\n`
          : `  [FAIL] ${r.name} — ${r.error}\n`
      );
    }
    process.stdout.write(
      failed.length
        ? `\n${failed.length}/${results.length} MCP server(s) failed connectivity.\n`
        : `\nAll ${results.length} MCP servers answered tools/list.\n`
    );
  }
  process.exit(failed.length ? 1 : 0);
}

// Run as CLI only when invoked directly (not when imported).
const invokedDirectly = process.argv[1] && resolve(process.argv[1]).endsWith("mcp-tester.mjs");
if (invokedDirectly) {
  main().catch((e) => {
    process.stdout.write(`[FAIL] mcp-tester: ${e.message}\n`);
    process.exit(1);
  });
}
