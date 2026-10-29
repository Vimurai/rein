#!/usr/bin/env node
/**
 * ast-parser-mcp — E-95 (ast-repository-map.md §Components 1, §API)
 *
 * MCP server encapsulating Tree-sitter (WASM, via extractor.mjs). Exposes
 * `parse_workspace`: scans a directory, applies ignore rules (.gitignore +
 * .reinignore + .env*), skips node_modules/.git/large/minified files, and
 * returns a JSON array of extracted symbols per the blueprint Data Model.
 * Symbol ranking (centrality_score) is added by the repo-mapper (E-96).
 *
 * Security (blueprint §Security): never indexes secret files (.env*) or
 * node_modules; stays within the resolved workspace root (no path escape);
 * per-file parse timeout + 1 MB size cap bound CPU (DoS).
 *
 * NOT DEAD CODE — intentionally absent from registry.json / .mcp.json. This is a
 * dual-mode binary: the `--generate-map` CLI path is invoked directly by `ai sync`
 * (src/bin/ai → `node ${REIN}/mcp/ast-parser-mcp/index.js --generate-map`) to build
 * .ai/REPO_MAP.md. The MCP-server mode (parse_workspace) is reachable when the SDK
 * is present. Deleting this breaks REPO_MAP generation.
 */

// E-98: the MCP SDK is imported lazily (server mode only) so the
// `--generate-map` CLI path used by the `ai sync` hook stays dependency-light —
// it needs only web-tree-sitter + the vendored grammars, no SDK.
import { isMainModule } from "../shared/is-main.mjs";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, relative, join, dirname, sep } from "node:path";
import { languageForFile, extractFromSource } from "./extractor.mjs";
import { rankSymbols } from "./repo-mapper.mjs";
import { serializeRepoMap } from "./serializer.mjs";
import { redact } from "../../shared/publish-scan.mjs"; // E-379 (D-130)
// E-153 (telemetry-hardening.md): global telemetry interceptor (SDK-free — schema injected).
import { instrument, rejection } from "../../shared/mcp-telemetry.mjs";

const MAX_FILE_BYTES = 1_000_000; // skip files > 1 MB (DoS / minified bundles)
const DEFAULT_MAX_FILES = 2000;
const ALWAYS_SKIP_DIRS = new Set(["node_modules", ".git"]);

// ── Ignore rules ─────────────────────────────────────────────────────────────

/** Build an ignore predicate from .gitignore + .reinignore (pragmatic glob). */
function buildIgnore(rootDir) {
  const patterns = [];
  for (const f of [".gitignore", ".reinignore"]) {
    const p = resolve(rootDir, f);
    if (!existsSync(p)) continue;
    for (const raw of readFileSync(p, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("!")) continue;
      patterns.push(line.replace(/\/$/, ""));
    }
  }
  const toRe = (pat) => {
    const anchored = pat.startsWith("/");
    const body = pat.replace(/^\//, "")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*");
    return { re: new RegExp(`^${body}$`), anchored, raw: pat.replace(/^\//, "") };
  };
  const compiled = patterns.map(toRe);

  return (relPath) => {
    // Secrets are never indexed, regardless of ignore files.
    const base = relPath.split("/").pop();
    if (/^\.env(\..+)?$/.test(base)) return true;
    if (/\.min\.(js|mjs|cjs|ts)$/.test(base)) return true;
    const segs = relPath.split("/");
    for (const { re, anchored, raw } of compiled) {
      if (anchored) {
        if (re.test(relPath) || relPath.startsWith(raw + "/")) return true;
      } else if (segs.some((s) => re.test(s)) || re.test(relPath)) {
        return true;
      }
    }
    return false;
  };
}

// ── Workspace walk ───────────────────────────────────────────────────────────

function collectSourceFiles(rootDir, ignore, maxFiles) {
  const files = [];
  const stack = [rootDir];
  while (stack.length && files.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const rel = relative(rootDir, abs).split(sep).join("/");
      if (ent.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(ent.name) || ignore(rel)) continue;
        stack.push(abs);
      } else if (ent.isFile()) {
        if (!languageForFile(ent.name) || ignore(rel)) continue;
        files.push({ abs, rel });
      }
    }
  }
  return files;
}

async function parseWorkspace(dirPath, maxFiles) {
  const cwd = process.cwd();
  const rootDir = resolve(cwd, dirPath || ".");
  // Containment — never traverse outside the invoking workspace.
  if (rootDir !== cwd && !rootDir.startsWith(cwd + sep)) {
    return { error: `[PATH_DENIED] dir_path escapes the workspace root: ${dirPath}` };
  }
  if (!existsSync(rootDir)) return { error: `[NOT_FOUND] ${rootDir}` };

  const ignore = buildIgnore(rootDir);
  const files = collectSourceFiles(rootDir, ignore, maxFiles || DEFAULT_MAX_FILES);

  const symbols = [];
  let skipped = 0;
  for (const f of files) {
    let content;
    try {
      content = readFileSync(f.abs);
      if (content.length > MAX_FILE_BYTES) { skipped++; continue; }
      content = content.toString("utf8");
    } catch { skipped++; continue; }
    const sym = await extractFromSource(content, languageForFile(f.abs));
    if (!sym) { skipped++; continue; }
    if (sym.exports.length || sym.classes.length || sym.imports.length) {
      symbols.push({ file_path: f.rel, exports: sym.exports, classes: sym.classes, imports: sym.imports });
    }
  }
  // E-96: rank by dependency-graph centrality before returning (PageRank).
  const ranked = rankSymbols(symbols);
  return { root: relative(cwd, rootDir) || ".", file_count: files.length, skipped, symbols: ranked };
}

// E-97/E-98: parse → rank → serialize → write .ai/REPO_MAP.md. Shared by the
// generate_map MCP tool and the `--generate-map` CLI mode (ai sync hook).
async function generateMap({ dirPath, maxFiles, maxTokens } = {}) {
  if (process.env.REIN_DISABLE_REPO_MAP === "1") return { disabled: true };
  const ws = await parseWorkspace(dirPath, maxFiles);
  if (ws.error) return { error: ws.error };
  const ser = serializeRepoMap(ws.symbols, { maxTokens });
  const outPath = resolve(process.cwd(), ".ai", "REPO_MAP.md");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, redact(ser.markdown, { file: ".ai/REPO_MAP.md", aiDir: dirname(outPath) }), "utf8");
  return {
    outPath,
    summary: {
      path: ".ai/REPO_MAP.md",
      files_included: ser.included,
      files_total: ser.total,
      estimated_tokens: ser.estimatedTokens,
      max_tokens: ser.maxTokens,
    },
  };
}

// ── Tool surface (plain data + dispatch — no SDK dependency) ─────────────────

const TOOLS = [
  {
    name: "parse_workspace",
    description:
      "E-95 (ast-repository-map.md): scan a directory and return extracted TS/JS symbols " +
      "(exports, classes+method signatures, imports) per file, ranked by dependency-graph " +
      "centrality (E-96). Respects .gitignore + .reinignore, never indexes .env*/node_modules, " +
      "skips minified and >1MB files.",
    inputSchema: {
      type: "object",
      properties: {
        dir_path:  { type: "string", description: "Directory to scan, relative to the workspace root (default '.')." },
        max_files: { type: "number", description: `Cap on files parsed (default ${DEFAULT_MAX_FILES}).` },
      },
    },
  },
  {
    name: "generate_map",
    description:
      "E-97 (ast-repository-map.md): run parse_workspace, serialize the ranked symbols into a " +
      "concise markdown skeleton (⋮ for elided function bodies), and write it to .ai/REPO_MAP.md " +
      "within a strict token budget (default 2048) — lowest-centrality files are trimmed first. " +
      "Returns a summary { path, files_included, files_total, estimated_tokens }. " +
      "Set REIN_DISABLE_REPO_MAP=1 to short-circuit (blueprint rollback).",
    inputSchema: {
      type: "object",
      properties: {
        dir_path:   { type: "string", description: "Directory to scan, relative to the workspace root (default '.')." },
        max_files:  { type: "number", description: `Cap on files parsed (default ${DEFAULT_MAX_FILES}).` },
        max_tokens: { type: "number", description: "Token budget for REPO_MAP.md (default 2048)." },
      },
    },
  },
];

async function dispatchTool(name, args) {
  if (name === "parse_workspace") {
    const result = await parseWorkspace(args?.dir_path, args?.max_files);
    // E-179: parseWorkspace errors are EXPECTED target rejections ([PATH_DENIED] /
    // [NOT_FOUND] — the caller pointed at a forbidden/missing path), not a parser malfunction.
    // Booked SUCCESS for telemetry so parse_workspace's "unstable parse target" rate stops
    // reading as a defect. Genuine thrown exceptions still hit the catch below → ERROR.
    if (result.error) return rejection(result.error);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
  if (name === "generate_map") {
    const r = await generateMap({ dirPath: args?.dir_path, maxFiles: args?.max_files, maxTokens: args?.max_tokens });
    if (r.disabled) {
      return { content: [{ type: "text", text: "[REPO_MAP_DISABLED] REIN_DISABLE_REPO_MAP=1 — generate_map is a no-op." }] };
    }
    if (r.error) return rejection(r.error);  // E-179: expected bad-target rejection, not a defect
    return { content: [{ type: "text", text: JSON.stringify(r.summary, null, 2) }] };
  }
  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

// ── Entry point ──────────────────────────────────────────────────────────────
// `--generate-map` (the ai sync hook) regenerates .ai/REPO_MAP.md and exits
// WITHOUT loading the SDK — fail-open. Otherwise start the stdio MCP server,
// lazily importing the SDK so the CLI path stays self-contained.
if (process.argv.includes("--generate-map")) {
  const r = await generateMap();
  if (r.disabled) {
    process.stderr.write("[REPO_MAP_DISABLED] REIN_DISABLE_REPO_MAP=1\n");
  } else if (r.error) {
    process.stderr.write(`${r.error}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(
      `[REPO_MAP] wrote ${r.outPath} (${r.summary.files_included}/${r.summary.files_total} files, ~${r.summary.estimated_tokens} tokens)\n`
    );
  }
} else {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const server = new Server({ name: "ast-parser-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  instrument(server, "ast-parser-mcp", CallToolRequestSchema);
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await dispatchTool(name, args);
    } catch (e) {
      return { content: [{ type: "text", text: `[PARSE_ERROR] ${e.message}` }], isError: true };
    }
  });
  if (isMainModule(import.meta.url)) {
    await server.connect(new StdioServerTransport());
  }
}
