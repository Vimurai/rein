/**
 * repo-mapper.mjs — E-96 (ast-repository-map.md §Components 2, §Core Concept)
 *
 * The ranking half of the repo-mapper service. Takes the symbol array emitted
 * by ast-parser-mcp's parse_workspace (E-95), builds a file-level dependency
 * graph from the resolved `imports`, and scores each file's importance with a
 * PageRank-style algorithm. A file imported by many (important) files ranks
 * higher — exactly the signatures worth keeping when the token budget (E-97)
 * forces trimming.
 *
 * Pure module — no I/O, no Tree-sitter, no stdout. Operates on plain symbol
 * objects so it is trivially unit-testable.
 *
 * Exports:
 *   normalizePath(p)
 *   resolveImport(fromFile, importPath, fileSet) -> resolved file_path | null
 *   buildDependencyGraph(symbols)               -> { nodes, edges }
 *   pageRank(graph, opts?)                       -> Map<file, score>
 *   rankSymbols(symbols, opts?)                  -> symbols + centrality_score, sorted desc
 */

// Extension candidates tried when resolving an extension-less relative import
// (e.g. "./util" → "./util.ts" → "./util/index.js").
const RESOLVE_SUFFIXES = [
  "", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs",
];

/** Collapse `.` and `..` segments in a POSIX-style path (no leading slash). */
export function normalizePath(p) {
  const out = [];
  for (const part of String(p).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else {
      out.push(part);
    }
  }
  return out.join("/");
}

/**
 * Resolve a relative import from `fromFile` against the known workspace files.
 * Bare/external specifiers (e.g. "fs", "lodash") and unresolved paths → null.
 */
export function resolveImport(fromFile, importPath, fileSet) {
  if (typeof importPath !== "string" || !importPath.startsWith(".")) return null;
  const slash = fromFile.lastIndexOf("/");
  const dir = slash >= 0 ? fromFile.slice(0, slash) : "";
  const base = normalizePath(`${dir}/${importPath}`);
  for (const suffix of RESOLVE_SUFFIXES) {
    const cand = base + suffix;
    if (fileSet.has(cand)) return cand;
  }
  return null;
}

/**
 * Build a file-level dependency graph. Edge A→B means "A imports B" where B is
 * a file that exists in the workspace symbol set.
 * @returns {{ nodes: string[], edges: Map<string, Set<string>> }}
 */
export function buildDependencyGraph(symbols) {
  const fileSet = new Set(symbols.map((s) => s.file_path));
  const edges = new Map();
  for (const s of symbols) {
    const out = new Set();
    for (const imp of s.imports || []) {
      const target = resolveImport(s.file_path, imp, fileSet);
      if (target && target !== s.file_path) out.add(target);
    }
    edges.set(s.file_path, out);
  }
  return { nodes: [...fileSet], edges };
}

/**
 * Standard PageRank over the dependency graph. Dangling nodes (no outbound
 * edges) redistribute their rank uniformly. Returns raw scores (~sum to 1).
 */
export function pageRank(graph, opts = {}) {
  const { damping = 0.85, iterations = 40 } = opts;
  const { nodes, edges } = graph;
  const N = nodes.length;
  if (N === 0) return new Map();

  const scores = new Map(nodes.map((n) => [n, 1 / N]));
  const outCount = new Map(nodes.map((n) => [n, edges.get(n)?.size || 0]));
  const inbound = new Map(nodes.map((n) => [n, []]));
  for (const [from, tos] of edges) {
    for (const to of tos) if (inbound.has(to)) inbound.get(to).push(from);
  }

  for (let it = 0; it < iterations; it++) {
    let dangling = 0;
    for (const n of nodes) if (outCount.get(n) === 0) dangling += scores.get(n);
    const next = new Map();
    for (const n of nodes) {
      let sum = 0;
      for (const from of inbound.get(n)) sum += scores.get(from) / outCount.get(from);
      next.set(n, (1 - damping) / N + damping * (sum + dangling / N));
    }
    for (const n of nodes) scores.set(n, next.get(n));
  }
  return scores;
}

/**
 * Attach a normalized centrality_score (0..1, top file = 1.0) to each symbol
 * and return them sorted by importance (desc, then file_path for stability).
 */
export function rankSymbols(symbols, opts = {}) {
  if (!Array.isArray(symbols) || symbols.length === 0) return [];
  const graph = buildDependencyGraph(symbols);
  const pr = pageRank(graph, opts);
  let max = 0;
  for (const v of pr.values()) if (v > max) max = v;
  const denom = max > 0 ? max : 1;
  const ranked = symbols.map((s) => ({
    ...s,
    centrality_score: Number(((pr.get(s.file_path) || 0) / denom).toFixed(4)),
  }));
  ranked.sort(
    (a, b) => b.centrality_score - a.centrality_score || a.file_path.localeCompare(b.file_path)
  );
  return ranked;
}
