/**
 * serializer.mjs — E-97 (ast-repository-map.md §API generate_map,
 * §Execution Constraints token budget)
 *
 * Serializes ranked symbols (from repo-mapper, E-96) into a concise markdown
 * skeleton for .ai/REPO_MAP.md. Function bodies are elided with `⋮` — only
 * signatures survive. A strict token budget (default 2048) aggressively trims
 * the lowest-centrality files so the map never blows the context window.
 *
 * Pure module — no I/O, no stdout. The MCP handler writes the returned markdown.
 *
 * Exports:
 *   DEFAULT_MAX_TOKENS
 *   estimateTokens(text)            -> integer (~chars/4 heuristic)
 *   renderFileBlock(symbol)         -> markdown block string
 *   serializeRepoMap(symbols, opts) -> { markdown, included, total, estimatedTokens, maxTokens }
 */

export const DEFAULT_MAX_TOKENS = 2048;

// Reserve for the header/footer comment so the budget covers the whole file.
const HEADER_TOKEN_RESERVE = 40;

/** Rough token estimate (the standard ~4-chars-per-token heuristic). */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

/** Render one file's skeleton: path + centrality, exports, imports, classes. */
export function renderFileBlock(sym) {
  const score = sym.centrality_score != null ? `  (centrality ${sym.centrality_score})` : "";
  const lines = [`## ${sym.file_path}${score}`];
  if (sym.exports?.length) lines.push(`exports: ${sym.exports.join(", ")}`);
  if (sym.imports?.length) lines.push(`imports: ${sym.imports.join(", ")}`);
  for (const c of sym.classes || []) {
    lines.push(`class ${c.name}`);
    for (const m of c.methods || []) lines.push(`  ${m.signature} ⋮`);
  }
  return lines.join("\n");
}

/**
 * Serialize ranked symbols into a budgeted REPO_MAP markdown document.
 * Symbols are taken highest-centrality first; blocks are appended until the
 * next would exceed `maxTokens`. At least the single most-central file is kept
 * when any content exists, so the map is never empty for a non-empty workspace.
 */
export function serializeRepoMap(symbols, opts = {}) {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const all = Array.isArray(symbols) ? symbols : [];
  const ranked = [...all].sort(
    (a, b) => (b.centrality_score ?? 0) - (a.centrality_score ?? 0) || a.file_path.localeCompare(b.file_path)
  );

  const blocks = [];
  let used = HEADER_TOKEN_RESERVE;
  for (const s of ranked) {
    const block = renderFileBlock(s);
    const cost = estimateTokens(block) + 1; // +1 for the joining blank line
    if (used + cost > maxTokens && blocks.length > 0) break; // trim the tail
    blocks.push(block);
    used += cost;
  }

  const included = blocks.length;
  const total = all.length;
  const header =
    `# REPO_MAP.md — AST Repository Map (auto-generated)\n` +
    `<!-- ast-parser-mcp generate_map (E-97): ${included}/${total} files, ` +
    `budget ${maxTokens} tokens. \`⋮\` = elided function body. -->\n`;
  const markdown = `${header}\n${blocks.join("\n\n")}\n`;

  return { markdown, included, total, estimatedTokens: estimateTokens(markdown), maxTokens };
}
