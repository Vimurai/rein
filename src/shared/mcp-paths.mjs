// mcp-paths.mjs — the one reader of `${VAR}` paths in a project's .mcp.json (E-409, D-143 r3).
//
// generate_mcp_json writes install-neutral server paths (`${HOME}/.rein/mcp/<server>/index.js`,
// D-143 r1), so every Rein reader expands them with the grammar Claude Code itself applies to
// .mcp.json — `${VAR}` and `${VAR:-default}`, nothing else — and this module is that expander's
// only copy (mcp-tester.mjs imports it). Python's os.path.expandvars does not know `:-default`.
//
//   node mcp-paths.mjs doctor <mcp-file>   rein doctor's line(s); exit 0 ok, 1 a ✗ line
//   node mcp-paths.mjs expand <mcp-file>   the file with command/args expanded, as JSON
import { existsSync, readFileSync } from "node:fs";
import { isMainModule } from "../mcp/shared/is-main.mjs";

/** Expand `${VAR}` / `${VAR:-default}` against `env`; an unset VAR with no default is "". */
export function expandVars(value, env = process.env) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{(\w+)(?::-([^}]*))?\}/g,
    (_, name, dflt) => env[name] ?? dflt ?? "");
}

function readDoc(file) {
  if (!existsSync(file)) return { absent: true };
  try { return { doc: JSON.parse(readFileSync(file, "utf8")) }; } catch { return { invalid: true }; }
}

/** The document with every server's `command` and `args` expanded (other fields untouched). */
export function expandDoc(doc, env = process.env, key = "mcpServers") {
  const servers = doc && typeof doc === "object" ? doc[key] : null;
  if (!servers || typeof servers !== "object") return doc;
  const out = {};
  for (const [name, spec] of Object.entries(servers)) {
    if (!spec || typeof spec !== "object") { out[name] = spec; continue; }
    out[name] = {
      ...spec,
      command: expandVars(spec.command, env),
      ...(Array.isArray(spec.args) ? { args: spec.args.map((a) => expandVars(a, env)) } : {}),
    };
  }
  return { ...doc, [key]: out };
}

/**
 * rein doctor's .mcp.json line(s) → { code, lines }: the servers whose absolute path, after
 * expansion, does not exist (D-143 r2b). A relative or non-string argument is not a path claim.
 */
export function doctorLines(file, { env = process.env, exists = existsSync } = {}) {
  const r = readDoc(file);
  if (r.absent) return { code: 0, lines: ["  - .mcp.json: none (rein sync writes it)"] };
  if (r.invalid) return { code: 1, lines: ["  ✗ .mcp.json is not valid JSON — run: rein sync"] };
  const servers = expandDoc(r.doc, env).mcpServers;
  let total = 0, missing = 0;
  for (const spec of servers && typeof servers === "object" ? Object.values(servers) : []) {
    const paths = [spec?.command, ...(Array.isArray(spec?.args) ? spec.args : [])]
      .filter((p) => typeof p === "string" && p.startsWith("/"));
    if (!paths.length) continue;
    total++;
    if (paths.some((p) => !exists(p))) missing++;
  }
  if (missing) {
    return { code: 1, lines: [`  ✗ [MCP_PATHS_MISSING] ${missing} servers point at paths that do not exist — run: rein sync`] };
  }
  return { code: 0, lines: [`  ✓ .mcp.json paths: all valid (${total} server(s))`] };
}

function main([cmd, file]) {
  if (!["doctor", "expand"].includes(cmd) || !file) {
    process.stderr.write("usage: mcp-paths.mjs doctor|expand <mcp-file>\n");
    return 2;
  }
  if (cmd === "doctor") {
    const r = doctorLines(file);
    process.stdout.write(r.lines.join("\n") + "\n");
    return r.code;
  }
  const r = readDoc(file);
  if (!r.doc) { process.stderr.write(`mcp-paths: ${r.absent ? "no file" : "invalid JSON"}: ${file}\n`); return 1; }
  process.stdout.write(JSON.stringify(expandDoc(r.doc)) + "\n");
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
