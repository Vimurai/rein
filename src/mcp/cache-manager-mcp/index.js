#!/usr/bin/env node
/**
 * cache-manager-mcp — Rein Explicit Context Cache (E-11)
 *
 * Assembles and persists a "System Context" blob from the Rein blueprint
 * files so agents can include it as a long-lived prompt prefix — enabling
 * Anthropic's prompt caching to eliminate per-turn JIT read costs.
 *
 * Blueprint: .ai/blueprints/caching.md
 *
 * Cache payload (per caching.md §2, narrowed by D-075 / E-275):
 *   - .ai/architect.md
 *   - .ai/blueprints/*.md modified within the last 7 days
 *   The blob never exceeds CACHE_CHAR_LIMIT: the oldest blueprint is dropped first and
 *   the omitted names are printed on stderr. registry.json and the state.sqlite schema
 *   are NOT injected — no agent read them, and they were half the blob.
 *
 * Invalidation (per caching.md §3):
 *   Cache is rebuilt only when a tracked file's mtime changes or a new
 *   .ai/blueprints/*.md file appears. Checked on every get_cached_context call.
 *
 * Tools:
 *   build_cache(project_root?)          → build/rebuild cache now
 *   get_cached_context(project_root?)   → return cached blob (auto-rebuild if stale)
 *   invalidate_cache()                  → mark cache stale (forces next rebuild)
 *   get_cache_status()                  → cache age, file count, validity, mtimes
 *
 * Security:
 *   - project_root validated: absolute, no ".." traversal, must exist.
 *   - DB path fixed to ~/.rein/cache.sqlite — never user-controlled.
 *   - All file reads use readFileSync (no execSync / shell).
 *
 * Observability:
 *   Structured JSON logs to stderr:
 *   { timestamp, level, service:"cache-manager-mcp", tool, latency_ms, error? }
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { instrument } from "../../shared/mcp-telemetry.mjs";
import { DatabaseSync } from "node:sqlite";
import {
  readFileSync,
  statSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { resolve, join, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../shared/logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SERVICE = "cache-manager-mcp";
const VERSION = "1.0.0";

const STORE_DIR = resolve(homedir(), ".rein");
const DB_PATH   = join(STORE_DIR, "cache.sqlite");

// ── Structured logger ─────────────────────────────────────────────────────────
// Shared NDJSON logger; emits one JSON line per call to stderr.

const logger = createLogger(SERVICE);
const log = (level, tool, message, extras) => logger.log(level, tool, message, extras);

// ── SQLite setup ──────────────────────────────────────────────────────────────

let db = null;

function getDb() {
  if (db) return db;
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    const conn = new DatabaseSync(DB_PATH);
    conn.exec("PRAGMA journal_mode = WAL;");
    conn.exec(`
      CREATE TABLE IF NOT EXISTS cache_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cache_files (
        path       TEXT PRIMARY KEY,
        mtime_ms   INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        role       TEXT NOT NULL
      );
    `);
    db = conn;
    return db;
  } catch (e) {
    log("error", "init", "DB init failed", { error: e.message, code: e.code });
    return null;
  }
}

// ── Project root validation ───────────────────────────────────────────────────

/**
 * Validate and normalise project_root.
 * Returns an absolute, traversal-safe path or throws on invalid input.
 */
function validateProjectRoot(raw) {
  const root = raw ? String(raw).trim() : process.cwd();

  if (!isAbsolute(root)) {
    throw new Error(`project_root must be an absolute path, got: ${root}`);
  }
  // Prevent path traversal
  if (root.includes("..")) {
    throw new Error(`project_root must not contain ".." segments`);
  }
  if (!existsSync(root)) {
    throw new Error(`project_root does not exist: ${root}`);
  }
  return root;
}

// ── Blueprint file discovery ──────────────────────────────────────────────────

/**
 * Returns the list of files that make up the cache payload, in display order.
 * Each entry: { path, role }
 */
function discoverPayloadFiles(projectRoot) {
  const files = [];

  // architect.md
  const architectPath = join(projectRoot, ".ai", "architect.md");
  if (existsSync(architectPath)) {
    files.push({ path: architectPath, role: "architect" });
  }

  // .ai/blueprints/*.md  (sorted for deterministic order)
  const blueprintsDir = join(projectRoot, ".ai", "blueprints");
  if (existsSync(blueprintsDir)) {
    const names = readdirSync(blueprintsDir)
      .filter((n) => n.endsWith(".md"))
      .sort();
    for (const name of names) {
      files.push({ path: join(blueprintsDir, name), role: "blueprint" });
    }
  }

  return files;
}

// ── Cache assembly ────────────────────────────────────────────────────────────

// E-275 (D-075, native-first.md §Component 1): the blob is capped, not "compacted when
// convenient". It measured 25,812 chars against this 20,000 limit because the old eviction
// (E-177) could only drop blueprints older than 7 days, while registry.json and the schema
// were never evictable. Now the payload is architect.md plus blueprints modified within
// STALE_BLUEPRINT_AGE_MS; when that still exceeds the limit the OLDEST blueprint goes first
// (ties broken by name, so a fresh checkout where every mtime is equal is deterministic).
// Files are never deleted and stay tracked for staleness — only the blob is trimmed.
const CACHE_CHAR_LIMIT       = 20000;
const STALE_BLUEPRINT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Render the System Context blob from a chosen subset of entries. */
function renderContextBlob(projectRoot, allEntries, included, omittedCount) {
  const header = [
    `=== Rein SYSTEM CONTEXT CACHE ===`,
    `Built: ${new Date().toISOString()}`,
    `Source: ${projectRoot}`,
    `Files: ${included.length}/${allEntries.length}`,
  ];
  if (omittedCount > 0) {
    header.push(
      `Omitted: ${omittedCount} blueprint(s) — older than 7d or over the ` +
      `${CACHE_CHAR_LIMIT}-char cap; read .ai/blueprints/<name>.md directly when a task names one`
    );
  }
  header.push("");
  return [
    header.join("\n"),
    ...included.map((e) => e.section),
    `=== END SYSTEM CONTEXT ===`,
  ].join("\n");
}

/** Oldest first; equal mtimes (a fresh checkout) fall back to the file name. */
function _oldestFirst(a, b) {
  return (a.mtime_ms - b.mtime_ms) || a.path.localeCompare(b.path);
}

/**
 * Build the System Context blob from the payload files.
 * Returns { blob, fileRecords: Array<{path,mtime_ms,size_bytes,role}>, omitted: string[] }
 * where `omitted` names every blueprint left out of the blob.
 */
function assembleContext(projectRoot, { now = Date.now() } = {}) {
  const payloadFiles = discoverPayloadFiles(projectRoot);
  const entries = [];      // { path, role, mtime_ms, section }
  const fileRecords = [];  // EVERY discovered file — tracked even if left out of the blob

  for (const { path, role } of payloadFiles) {
    try {
      const stat = statSync(path);
      const content = readFileSync(path, "utf8");
      const label = path.replace(projectRoot + "/", "");
      const mtime_ms = Math.round(stat.mtimeMs);

      entries.push({
        path,
        role,
        mtime_ms,
        section: `--- ${label} (${role}) ---\n${content.trimEnd()}\n`,
      });
      fileRecords.push({ path, mtime_ms, size_bytes: stat.size, role });
    } catch (e) {
      log("warn", "assemble", `Skipping unreadable file: ${path}`, {
        error: e.message,
      });
    }
  }

  const omit = new Set();
  for (const e of entries) {
    if (e.role === "blueprint" && (now - e.mtime_ms) > STALE_BLUEPRINT_AGE_MS) omit.add(e.path);
  }
  let included = entries.filter((e) => !omit.has(e.path));
  let blob = renderContextBlob(projectRoot, entries, included, omit.size);

  // Over the cap: drop the oldest remaining blueprint until it fits. architect.md is never
  // a candidate here; it is only cut by the hard guard below.
  const recentOldestFirst = included.filter((e) => e.role === "blueprint").sort(_oldestFirst);
  for (const e of recentOldestFirst) {
    if (blob.length <= CACHE_CHAR_LIMIT) break;
    omit.add(e.path);
    included = entries.filter((x) => !omit.has(x.path));
    blob = renderContextBlob(projectRoot, entries, included, omit.size);
  }

  // Hard guard: architect.md alone over the cap. The cap is the contract, so the blob is
  // cut with a visible marker rather than allowed through.
  if (blob.length > CACHE_CHAR_LIMIT) {
    const marker = `\n[TRUNCATED at ${CACHE_CHAR_LIMIT} chars — read .ai/architect.md directly]\n=== END SYSTEM CONTEXT ===`;
    blob = blob.slice(0, CACHE_CHAR_LIMIT - marker.length) + marker;
  }

  const omitted = entries
    .filter((e) => omit.has(e.path))
    .map((e) => e.path.replace(projectRoot + "/", ""));
  return { blob, fileRecords, omitted };
}

// ── Staleness check ───────────────────────────────────────────────────────────

/**
 * Returns true when the cache needs rebuilding:
 *   - cache_meta.valid !== '1'
 *   - any tracked file's mtime differs from stored value
 *   - a new .ai/blueprints/*.md file appeared
 */
function isCacheStale(d, projectRoot) {
  const valid = d
    .prepare("SELECT value FROM cache_meta WHERE key = 'valid'")
    .get();
  if (!valid || valid.value !== "1") return true;

  const storedRoot = d
    .prepare("SELECT value FROM cache_meta WHERE key = 'project_root'")
    .get();
  if (!storedRoot || storedRoot.value !== projectRoot) return true;

  // Check existing tracked files
  const tracked = d.prepare("SELECT path, mtime_ms FROM cache_files").all();
  for (const row of tracked) {
    try {
      const stat = statSync(row.path);
      if (Math.round(stat.mtimeMs) !== row.mtime_ms) return true;
    } catch {
      return true; // file deleted
    }
  }

  // Check for new blueprint files not in tracked set
  const trackedPaths = new Set(tracked.map((r) => r.path));
  const blueprintsDir = join(projectRoot, ".ai", "blueprints");
  if (existsSync(blueprintsDir)) {
    const current = readdirSync(blueprintsDir)
      .filter((n) => n.endsWith(".md"))
      .map((n) => join(blueprintsDir, n));
    for (const p of current) {
      if (!trackedPaths.has(p)) return true;
    }
  }

  return false;
}

// ── Persist cache ─────────────────────────────────────────────────────────────

function persistCache(d, blob, fileRecords, projectRoot) {
  d.exec("DELETE FROM cache_files;");

  const setMeta = d.prepare(
    "INSERT OR REPLACE INTO cache_meta(key, value) VALUES (?, ?)"
  );
  const insertFile = d.prepare(
    "INSERT OR REPLACE INTO cache_files(path, mtime_ms, size_bytes, role) VALUES (?, ?, ?, ?)"
  );

  setMeta.run("context_blob",  blob);
  setMeta.run("built_at",      new Date().toISOString());
  setMeta.run("valid",         "1");
  setMeta.run("project_root",  projectRoot);
  setMeta.run("file_count",    String(fileRecords.length));
  setMeta.run("char_count",    String(blob.length));

  for (const rec of fileRecords) {
    insertFile.run(rec.path, rec.mtime_ms, rec.size_bytes, rec.role);
  }
}

// ── Estimated token count (rough approximation: 1 token ≈ 4 chars) ───────────

function estimateTokens(charCount) {
  return Math.round(charCount / 4);
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: SERVICE, version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "build_cache",
      description:
        "Force-rebuild the System Context cache from all blueprint files " +
        "(.ai/architect.md + .ai/blueprints/*.md modified within 7 days, capped at " +
        "20,000 chars). Stores the assembled blob in SQLite with " +
        "file mtimes for change detection. Returns the full context blob.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: {
            type: "string",
            description:
              "Absolute path to the Rein project root. Defaults to cwd. " +
              "Must not contain '..' path traversal segments.",
          },
        },
      },
    },
    {
      name: "get_cached_context",
      description:
        "Return the cached System Context blob. Automatically rebuilds if any " +
        "tracked file's mtime changed or a new blueprint file appeared. " +
        "Use the returned blob as a long-lived system prompt prefix to enable " +
        "Anthropic prompt caching and eliminate per-turn JIT read costs.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: {
            type: "string",
            description:
              "Absolute path to the Rein project root. Defaults to cwd.",
          },
        },
      },
    },
    {
      name: "invalidate_cache",
      description:
        "Mark the cache as stale without rebuilding. The next call to " +
        "get_cached_context or build_cache will trigger a full rebuild. " +
        "Use after manually editing blueprint files outside of normal hooks.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_cache_status",
      description:
        "Return cache metadata: validity, build timestamp, file count, " +
        "context size (chars + estimated tokens), project root, and the " +
        "mtime of each tracked file. Use for observability and debugging.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

instrument(server, "cache-manager-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const t0 = Date.now();

  try {
    switch (name) {
      // ── build_cache ────────────────────────────────────────────────────────
      case "build_cache": {
        const projectRoot = validateProjectRoot(args?.project_root);
        log("info", name, "Building cache", { project_root: projectRoot });

        const { blob, fileRecords } = assembleContext(projectRoot);
        const d = getDb();
        if (!d) {
          return {
            content: [
              {
                type: "text",
                text:
                  "[CACHE_WARN] SQLite unavailable — context assembled in-memory only.\n\n" +
                  blob,
              },
            ],
          };
        }

        persistCache(d, blob, fileRecords, projectRoot);
        log("info", name, "Cache built", {
          files: fileRecords.length,
          chars: blob.length,
          latency_ms: Date.now() - t0,
        });

        return {
          content: [
            {
              type: "text",
              text:
                `[CACHE_BUILT] ${fileRecords.length} files cached | ` +
                `${blob.length.toLocaleString()} chars | ` +
                `~${estimateTokens(blob.length).toLocaleString()} tokens\n` +
                `DB: ${DB_PATH}\n\n` +
                blob,
            },
          ],
        };
      }

      // ── get_cached_context ─────────────────────────────────────────────────
      case "get_cached_context": {
        const projectRoot = validateProjectRoot(args?.project_root);
        const d = getDb();

        if (!d) {
          log("warn", name, "SQLite unavailable — building in-memory");
          const { blob } = assembleContext(projectRoot);
          return { content: [{ type: "text", text: blob }] };
        }

        const stale = isCacheStale(d, projectRoot);
        if (stale) {
          log("info", name, "Cache stale — rebuilding", {
            project_root: projectRoot,
          });
          const { blob, fileRecords } = assembleContext(projectRoot);
          persistCache(d, blob, fileRecords, projectRoot);
          log("info", name, "Cache rebuilt", {
            files: fileRecords.length,
            chars: blob.length,
            latency_ms: Date.now() - t0,
          });
          return {
            content: [
              {
                type: "text",
                text:
                  `[CACHE_REBUILT] ${fileRecords.length} files | ` +
                  `~${estimateTokens(blob.length).toLocaleString()} tokens\n\n` +
                  blob,
              },
            ],
          };
        }

        const row = d
          .prepare("SELECT value FROM cache_meta WHERE key = 'context_blob'")
          .get();
        const blob = row?.value ?? "";
        log("info", name, "Cache hit", {
          chars: blob.length,
          latency_ms: Date.now() - t0,
        });
        return {
          content: [
            {
              type: "text",
              text: `[CACHE_HIT] ~${estimateTokens(blob.length).toLocaleString()} tokens\n\n${blob}`,
            },
          ],
        };
      }

      // ── invalidate_cache ───────────────────────────────────────────────────
      case "invalidate_cache": {
        const d = getDb();
        if (!d) {
          return {
            content: [
              { type: "text", text: "[CACHE_WARN] SQLite unavailable — nothing to invalidate." },
            ],
          };
        }
        d.prepare(
          "INSERT OR REPLACE INTO cache_meta(key, value) VALUES ('valid', '0')"
        ).run();
        log("info", name, "Cache invalidated", { latency_ms: Date.now() - t0 });
        return {
          content: [
            {
              type: "text",
              text: "[CACHE_INVALIDATED] Cache marked stale. Next get_cached_context will rebuild.",
            },
          ],
        };
      }

      // ── get_cache_status ───────────────────────────────────────────────────
      case "get_cache_status": {
        const d = getDb();
        if (!d) {
          return {
            content: [
              { type: "text", text: "[CACHE_WARN] SQLite unavailable — no status to report." },
            ],
          };
        }

        const rows = d.prepare("SELECT key, value FROM cache_meta").all();
        const meta = {};
        for (const r of rows) meta[r.key] = r.value;

        const files = d
          .prepare("SELECT path, mtime_ms, size_bytes, role FROM cache_files ORDER BY role, path")
          .all();

        const valid    = meta["valid"] === "1" ? "VALID" : "STALE";
        const builtAt  = meta["built_at"] || "(never)";
        const fileCount= meta["file_count"] || "0";
        const charCount= parseInt(meta["char_count"] || "0", 10);
        const root     = meta["project_root"] || "(unset)";

        const lines = [
          `## Cache Status`,
          ``,
          `Status:         ${valid}`,
          `Built at:       ${builtAt}`,
          `Project root:   ${root}`,
          `Files tracked:  ${fileCount}`,
          `Context size:   ${charCount.toLocaleString()} chars / ~${estimateTokens(charCount).toLocaleString()} tokens`,
          `DB:             ${DB_PATH}`,
          ``,
          `### Tracked Files`,
        ];

        for (const f of files) {
          const label = f.path.replace(root + "/", "");
          lines.push(`  [${f.role.padEnd(9)}] ${label} (${f.size_bytes} bytes, mtime=${f.mtime_ms})`);
        }

        if (files.length === 0) {
          lines.push("  (none — run build_cache first)");
        }

        log("info", name, "Status reported", {
          valid,
          latency_ms: Date.now() - t0,
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (e) {
    log("error", name, e.message, { latency_ms: Date.now() - t0 });
    return {
      content: [{ type: "text", text: `Error: ${e.message}` }],
      isError: true,
    };
  }
});

// E-112 (caching.md §3.1): `--build` CLI mode — build/persist the System Context
// cache for the current project and exit, WITHOUT starting the stdio server.
// `rein sync` invokes this after regenerating blueprint-derived docs so the cache
// is actually exercised in a live flow (it was built but never invoked). The
// downstream prompt-prefix injection (§3.2/§3.3) is a runtime/harness concern
// beyond this MCP. Fail-open: any error warns to stderr and exits 0 so a sync
// cycle is never blocked.
// E-126 (caching.md §3.2/§3.3): `--emit-context` CLI — print the compiled System
// Context blob to stdout so the SessionStart hook (hooks/session-start.sh) can
// inject it as a prompt-prefix at Claude session start (the previously-unwired
// "Agent Invocation" step of the caching workflow). No server is started.
// Fail-open: any error (or REIN_DISABLE_CACHE=1) emits nothing and exits 0 so
// session start is never blocked.
// E-275: `--measure` prints the size of exactly what `--emit-context` would inject, so the
// cap is checkable from a shell and from tests/unit. Both print the omitted blueprint names
// on stderr (the SessionStart hook discards stderr; an operator running it by hand sees it).
function _reportOmitted(omitted) {
  if (omitted.length) process.stderr.write(`Omitted: ${omitted.join(", ")}\n`);
}

if (process.argv.includes("--measure")) {
  try {
    const { blob, omitted } = assembleContext(validateProjectRoot());
    _reportOmitted(omitted);
    process.stdout.write(`${blob.length}\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[cache-manager] --measure failed: ${e.message}\n`);
    process.exit(1);
  }
}

if (process.argv.includes("--emit-context")) {
  try {
    if (process.env.REIN_DISABLE_CACHE !== "1") {
      const projectRoot = validateProjectRoot();
      const { blob, omitted } = assembleContext(projectRoot);
      _reportOmitted(omitted);
      if (blob && blob.trim()) process.stdout.write(blob);
    }
  } catch {
    // fail-open: emit nothing rather than block session start
  }
  process.exit(0);
}

if (process.argv.includes("--build")) {
  try {
    const projectRoot = validateProjectRoot();
    const { blob, fileRecords } = assembleContext(projectRoot);
    const d = getDb();
    if (d) persistCache(d, blob, fileRecords, projectRoot);
    process.stderr.write(
      `[cache-manager] context cache ${d ? "built" : "assembled (SQLite unavailable — in-memory only)"}: ` +
      `${fileRecords.length} files, ${blob.length} chars, ~${estimateTokens(blob.length)} tokens\n`
    );
  } catch (e) {
    process.stderr.write(`[cache-manager] WARN: ${e.message} — cache build skipped (sync continues).\n`);
  }
  process.exit(0);
}

log("info", "startup", `${SERVICE} v${VERSION} starting`, { db: DB_PATH });
if (isMainModule(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
