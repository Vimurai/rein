/**
 * is-main.mjs — ESM "run directly vs. imported" detector (E-160).
 *
 * MCP servers start a StdioServerTransport at module top-level. When a unit
 * test `import()`s the server file to exercise its pure helpers, that transport
 * would attach to stdin and the test process would hang forever. Guarding the
 * `server.connect(...)` call with isMainModule(import.meta.url) means the
 * transport only starts when the file is the process entry point (launched as
 * `node .../index.js`), never on import.
 *
 * @param {string} metaUrl  Pass `import.meta.url` from the calling module.
 * @returns {boolean} true when this module is the process entry point.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// E-326: REAL paths on both sides. Node resolves a symlinked entry before it sets
// import.meta.url, so `node <symlink>/x.mjs` (an install mirror reached through a link,
// macOS /var → /private/var) compared unequal and the entry point silently did nothing.
function _real(p) {
  try { return realpathSync(p); } catch { return p; }
}

export function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  if (metaUrl === pathToFileURL(entry).href) return true;
  return _real(fileURLToPath(metaUrl)) === _real(entry);
}
