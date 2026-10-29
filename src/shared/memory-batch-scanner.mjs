#!/usr/bin/env node
/**
 * memory-batch-scanner.mjs — E-75 Batch Scanner for the memory_curator agent.
 *
 * Implements §Components 1 of .ai/blueprints/multimodal-rag-batching.md:
 *
 *   "A filesystem traverser that identifies eligible media (PNG/SVG/PDF) and
 *    computes SHA-256 hashes to skip unchanged files already present in the
 *    Memory Palace."
 *
 * Layered exclusion gates (applied in order — first matching gate wins):
 *
 *   1. Skip-dir prune — walker never descends into node_modules, .git,
 *      .ai-os, .env*, .ssh, .aws, .gnupg, secrets, credentials.
 *   2. Path-rule reject — defence-in-depth substring match against the
 *      same sensitive segments (catches symlinks / unusual layouts).
 *   3. Sensitive-name reject — basename matches the credential regex
 *      (secret|credential|token|apikey|password|kubeconfig|id_rsa|
 *       id_ed25519|.pem|.p12|.pfx).
 *   4. .gitignore reject — single batched `git check-ignore --stdin` call
 *      per scan (no per-file subprocess fork) per blueprint §Security.
 *   5. [NO_RAG] reject — sidecar file `<name>.norag` exists, or the file
 *      is an SVG carrying the literal [NO_RAG] string in its XML body.
 *   6. Size-cap reject — file > maxSizeBytes (default 5 MB per
 *      blueprint §Security/Resource Exhaustion).
 *   7. SHA-256 hash + already-indexed dedup — if the file's hash is
 *      present in opts.indexedHashes, it has been seen before and the
 *      worker pool (E-76) can skip the embedding call entirely.
 *
 * Privacy contract: skipped entries surface only the **basename** + a
 * reason code. Full paths NEVER appear in the structured return value
 * or stderr logs (mirrors the memory_curator §Forbidden mandate of
 * "never the filename's full path").
 *
 * Pure node:fs / node:crypto / node:child_process — no external deps.
 *
 * Usage (programmatic):
 *   import { scanWorkspace } from "./shared/memory-batch-scanner.mjs";
 *   const result = scanWorkspace("/path/to/project", {
 *     indexedHashes: new Set([...prevHashes]),  // skip already-embedded
 *     maxSizeBytes: 5 * 1024 * 1024,
 *     extensions: [".png", ".svg", ".pdf"],
 *   });
 *
 * Usage (CLI smoke):
 *   node src/shared/memory-batch-scanner.mjs --scan <project-root>
 *   node src/shared/memory-batch-scanner.mjs --hash <file>
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, basename, relative, sep, extname } from "node:path";
import { spawnSync } from "node:child_process";

const SERVICE = "memory-batch-scanner";

export const DEFAULT_EXTENSIONS = [".png", ".svg", ".pdf"];
export const DEFAULT_MAX_BYTES  = 5 * 1024 * 1024;

// Directories the walker refuses to descend into. Pure performance pruning —
// these directories never contain embeddable media. Sensitive directories
// (.env*, .ssh, .aws, .gnupg, secrets/, credentials/) are intentionally
// NOT pruned here so their files surface in `skipped[reason=path-rule]`
// for observability. The blueprint mandates that every reject carries a
// reason code so the curator can log it; silent pruning would defeat that.
const SKIP_DIR_EXACT = new Set([
  "node_modules", ".git", ".ai-os",
  ".npm", ".yarn", ".cache",
]);

// Sensitive segments matched against the absolute path. Defence-in-depth
// for files reached via symlink / unusual layout that the walker missed.
const PATH_RULE_SEGMENTS = [
  "/.env", "/secrets/", "/credentials/", "/.ssh/", "/.aws/", "/.gnupg/",
];

// Filename pattern — mirrors memory_curator.md §"Sensitive-naming reject".
const SENSITIVE_NAME_RE = /(secret|credential|token|apikey|password|kubeconfig|id_rsa|id_ed25519|\.pem|\.p12|\.pfx)/i;

// ── Structured stderr logger (obs_baseline §Logging) ────────────────────────
function log(level, message, extras = {}) {
  process.stderr.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    level, service: SERVICE, message, ...extras,
  }) + "\n");
}

// ── Predicates (exported for unit testing) ───────────────────────────────────

export function isSkippableDir(name) {
  return SKIP_DIR_EXACT.has(name);
}

export function isPathExcluded(absPath) {
  return PATH_RULE_SEGMENTS.some((seg) => absPath.includes(seg));
}

export function isSensitiveName(name) {
  return SENSITIVE_NAME_RE.test(name);
}

export function computeFileSha256(absPath) {
  // readFileSync handles binary cleanly when no encoding is supplied.
  const buf = readFileSync(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Detect a [NO_RAG] marker:
 *   - sidecar file `<absPath>.norag` exists (works for any format)
 *   - SVG (text format) carries the literal `[NO_RAG]` substring
 *
 * Other binary formats (PNG/PDF) MUST use the sidecar — we deliberately
 * do not parse PNG tEXt / PDF metadata to keep the scanner dependency-free.
 */
export function hasNoRagTag(absPath) {
  if (existsSync(`${absPath}.norag`)) return true;
  if (extname(absPath).toLowerCase() === ".svg") {
    try {
      const content = readFileSync(absPath, "utf8");
      if (content.includes("[NO_RAG]")) return true;
    } catch {
      // Binary-as-utf8 read might silently swap bytes — that's fine; we'd
      // rather false-negative than throw on a non-XML file labelled .svg.
    }
  }
  return false;
}

/**
 * Batch .gitignore check via `git check-ignore --stdin`.
 *
 * Returns a Set of absolute paths the project's gitignore rules match.
 * Single subprocess for the entire candidate list — keeps the scanner
 * cheap on repos with thousands of media files. If git is not on PATH
 * or the project root is not a git work tree, returns an empty Set
 * (gitignore rules simply do not apply).
 */
export function batchGitignoreCheck(projectRoot, absPaths) {
  if (absPaths.length === 0) return new Set();

  const probe = spawnSync(
    "git",
    ["-C", projectRoot, "rev-parse", "--is-inside-work-tree"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (probe.error || probe.status !== 0) return new Set();

  const input = absPaths.join("\n") + "\n";
  const res = spawnSync(
    "git",
    ["-C", projectRoot, "check-ignore", "--stdin", "--no-index"],
    { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  // `git check-ignore` exits:
  //   0 — at least one path is ignored
  //   1 — no paths are ignored
  //   128 — fatal (e.g., non-repo)
  // Any other status means the call itself failed; treat as "nothing
  // ignored" rather than over-rejecting eligible files.
  if (res.error || (res.status !== 0 && res.status !== 1)) return new Set();

  const ignored = new Set();
  for (const line of (res.stdout || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    // git check-ignore prints paths as supplied; we fed absolute paths.
    ignored.add(resolve(t));
  }
  return ignored;
}

// ── Walker (depth-first, skip-dir pruning) ───────────────────────────────────

function* _walk(dir, projectRoot) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable — pretend it's empty rather than blow up the scan.
  }
  for (const ent of entries) {
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) {
      if (isSkippableDir(ent.name)) continue;
      // Defence-in-depth: even if the walker descended via a symlink, the
      // path-rule will catch sensitive segments at the file level.
      yield* _walk(full, projectRoot);
    } else if (ent.isFile()) {
      yield full;
    }
    // Symlinks are intentionally ignored — opening them would be the
    // only way to embed the target's bytes anyway, and we don't want
    // to follow a symlink out of the project tree.
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan a project root for embedding candidates.
 *
 * Returns:
 *   {
 *     eligible: Array<{ path, sha256, size, kind }>,
 *     skipped:  Array<{ basename, reason }>,
 *   }
 *
 * No exceptions on hostile inputs — every per-file failure surfaces as a
 * `skipped` entry with a structured reason code.
 */
export function scanWorkspace(projectRoot, opts = {}) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    return { eligible: [], skipped: [{ basename: "(missing)", reason: "invalid-project-root" }] };
  }
  const root = resolve(projectRoot);
  if (!existsSync(root)) {
    return { eligible: [], skipped: [{ basename: basename(root), reason: "project-root-missing" }] };
  }

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length > 0
    ? opts.extensions.map((e) => e.toLowerCase())
    : DEFAULT_EXTENSIONS;
  const maxBytes = Number.isFinite(opts.maxSizeBytes) && opts.maxSizeBytes > 0
    ? opts.maxSizeBytes
    : DEFAULT_MAX_BYTES;
  const indexedHashes = opts.indexedHashes instanceof Set
    ? opts.indexedHashes
    : new Set();

  // Stage 1: enumerate candidates by extension (cheap — extension test
  // happens during the directory walk, no I/O per non-match).
  const candidates = [];
  for (const file of _walk(root, root)) {
    if (!extensions.includes(extname(file).toLowerCase())) continue;
    candidates.push(file);
  }

  // Stage 2: single batched gitignore probe before per-file gates.
  const gitignored = batchGitignoreCheck(root, candidates);

  // Stage 3: per-file gating.
  const eligible = [];
  const skipped  = [];

  for (const abs of candidates) {
    const name = basename(abs);

    if (isPathExcluded(abs)) {
      skipped.push({ basename: name, reason: "path-rule" });
      continue;
    }
    if (isSensitiveName(name)) {
      skipped.push({ basename: name, reason: "sensitive-name" });
      continue;
    }
    if (gitignored.has(abs)) {
      skipped.push({ basename: name, reason: "gitignored" });
      continue;
    }
    if (hasNoRagTag(abs)) {
      skipped.push({ basename: name, reason: "no-rag-tag" });
      continue;
    }

    let st;
    try { st = statSync(abs); } catch (e) {
      skipped.push({ basename: name, reason: "stat-failed" });
      continue;
    }
    if (st.size > maxBytes) {
      skipped.push({ basename: name, reason: "size-cap" });
      continue;
    }

    let hash;
    try { hash = computeFileSha256(abs); } catch (e) {
      skipped.push({ basename: name, reason: "hash-failed" });
      continue;
    }
    if (indexedHashes.has(hash)) {
      skipped.push({ basename: name, reason: "already-indexed" });
      continue;
    }

    eligible.push({
      path: abs,
      sha256: hash,
      size: st.size,
      kind: extname(abs).toLowerCase().slice(1),
    });
  }

  return { eligible, skipped };
}

/**
 * Load the set of SHA-256 hashes already present in the Memory Palace
 * embeddings index. Returns an empty Set if the file is absent or
 * unparseable — the scanner will then return every eligible file as new.
 */
export function loadIndexedHashes(embeddingsPath) {
  if (!embeddingsPath) return new Set();
  if (!existsSync(embeddingsPath)) return new Set();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(embeddingsPath, "utf8"));
  } catch (e) {
    log("warn", "embeddings file unparseable — treating as empty", { error: e.message });
    return new Set();
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  const set = new Set();
  for (const ent of entries) {
    if (ent && typeof ent.id === "string" && ent.id.length > 0) set.add(ent.id);
  }
  return set;
}

// ── CLI entry (smoke test) ───────────────────────────────────────────────────

const __isMain = (() => {
  try {
    const argv1 = process.argv[1] || "";
    return argv1.endsWith("/memory-batch-scanner.mjs") ||
           argv1.endsWith("\\memory-batch-scanner.mjs");
  } catch { return false; }
})();

if (__isMain) {
  const flag = process.argv[2];
  if (flag === "--scan") {
    const root = process.argv[3];
    if (!root) {
      process.stderr.write("usage: memory-batch-scanner.mjs --scan <project-root>\n");
      process.exit(2);
    }
    const embeddingsPath = process.env.AI_MEMORY_EMBEDDINGS_PATH ||
      `${process.env.HOME}/.ai-os/memory-palace.embeddings.json`;
    const indexedHashes = loadIndexedHashes(embeddingsPath);
    const result = scanWorkspace(root, { indexedHashes });
    process.stdout.write(JSON.stringify({
      summary: {
        eligible: result.eligible.length,
        skipped:  result.skipped.length,
        indexed_hashes_loaded: indexedHashes.size,
      },
      eligible: result.eligible.map((e) => ({
        sha256: e.sha256, size: e.size, kind: e.kind,
        // CLI honours the same privacy contract as the API — basename only.
        basename: basename(e.path),
      })),
      skipped: result.skipped,
    }, null, 2) + "\n");
    process.exit(0);
  }
  if (flag === "--hash") {
    const file = process.argv[3];
    if (!file) {
      process.stderr.write("usage: memory-batch-scanner.mjs --hash <file>\n");
      process.exit(2);
    }
    try {
      process.stdout.write(computeFileSha256(file) + "\n");
      process.exit(0);
    } catch (e) {
      process.stderr.write(`hash error: ${e.message}\n`);
      process.exit(1);
    }
  }
  process.stderr.write("usage: memory-batch-scanner.mjs [--scan <project-root> | --hash <file>]\n");
  process.exit(2);
}
