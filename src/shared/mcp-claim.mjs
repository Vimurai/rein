// mcp-claim.mjs — which Rein install a project's .mcp.json belongs to (E-409, D-141 addendum 2).
//
// There is no project registry: the record of which install serves a project is the absolute
// server paths generate_mcp_json writes (`<prefix>/.rein/mcp/<server>/index.js`). So the
// registered install is the `<prefix>/.rein` the project's Rein entries share (r1). A writer
// running under a DIFFERENT install refuses only when that install is alive — `<prefix>/mcp/`
// exists on disk (r2) — because a dead install claims nothing, and rewriting a file that points
// into a deleted throwaway HOME is exactly how the 2026-11-01 outage was recovered. No file or
// no Rein entries is unregistered (r3); several prefixes is a broken file, rewritten (r3);
// `--adopt` is the only override (r4) — there is deliberately no environment bypass.
//
//   node mcp-claim.mjs check  <mcp-file> <rein-dir> [--adopt]   exit 0 write, 3 refuse
//   node mcp-claim.mjs doctor <mcp-file> <rein-dir>             exit 0 ok, 1 a ✗ line
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainModule } from "../mcp/shared/is-main.mjs";

// A Rein server entry: `node <prefix>/mcp/<name>-mcp/index.js`. Every server Rein ships is
// named *-mcp; a user's own node server elsewhere is not a claim on the project.
const REIN_ENTRY = /^(.+)\/mcp\/[A-Za-z0-9._-]+-mcp\/index\.js$/;

/** A path with symlinks resolved; a missing path resolves as far as it exists. */
function canonical(p) {
  try { return realpathSync(p); } catch { /* fall through */ }
  const parent = dirname(p);
  return parent === p ? p : resolve(canonical(parent), p.slice(parent.length + 1));
}

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

function readDoc(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** The set of `<prefix>/.rein` dirs the Rein entries of an .mcp.json document name. */
export function reinPrefixes(doc, key = "mcpServers") {
  const out = new Set();
  const servers = doc && typeof doc === "object" ? doc[key] : null;
  if (!servers || typeof servers !== "object") return out;
  for (const spec of Object.values(servers)) {
    const arg = spec && spec.command === "node" && Array.isArray(spec.args) ? spec.args[0] : null;
    const m = typeof arg === "string" ? REIN_ENTRY.exec(arg) : null;
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * May the install at <rein> write <file>? → { action: "write"|"refuse", code, message }.
 * `message` is "" when there is nothing to say.
 */
export function claimCheck(file, rein, { adopt = false, key = "mcpServers" } = {}) {
  const project = canonical(dirname(resolve(file)));
  const mine = canonical(rein);
  const prefixes = [...reinPrefixes(readDoc(file), key)];
  if (prefixes.length === 0) return { action: "write", code: 0, message: "" };
  if (prefixes.length > 1) {
    return { action: "write", code: 0, message: `⚠ ${file} named several installs (${prefixes.sort().join(", ")}) — rewritten for ${mine}` };
  }
  const theirs = canonical(prefixes[0]);
  if (theirs === mine) return { action: "write", code: 0, message: "" };
  if (!isDir(`${theirs}/mcp`)) {
    return { action: "write", code: 0, message: `  ${file} pointed at ${theirs}, which no longer exists — rewritten for ${mine}` };
  }
  if (adopt) return { action: "write", code: 0, message: `adopted ${project}: ${theirs} → ${mine}` };
  return {
    action: "refuse", code: 3,
    message: `[FOREIGN_PROJECT] ${project} is registered to ${theirs} — run rein sync from that HOME, or rein init --adopt`,
  };
}

/** `rein doctor`'s .mcp.json lines → { code, lines }. */
export function doctorLines(file, rein) {
  const doc = readDoc(file);
  if (!existsSync(file)) return { code: 0, lines: ["  - .mcp.json: none (rein sync writes it)"] };
  if (!doc) return { code: 1, lines: ["  ✗ .mcp.json is not valid JSON — run: rein sync"] };
  const lines = [];
  const servers = doc.mcpServers && typeof doc.mcpServers === "object" ? Object.values(doc.mcpServers) : [];
  let rein_n = 0, missing = 0;
  for (const spec of servers) {
    const arg = spec && spec.command === "node" && Array.isArray(spec.args) ? spec.args[0] : null;
    if (typeof arg !== "string" || !arg.startsWith("/")) continue;
    if (REIN_ENTRY.test(arg)) rein_n++;
    if (!existsSync(arg)) missing++;
  }
  if (missing) lines.push(`  ✗ [MCP_PATHS_MISSING] ${missing} servers point at paths that do not exist — run: rein sync`);
  const claim = claimCheck(file, rein);
  if (claim.action === "refuse") lines.push(`  ✗ ${claim.message}`);
  if (lines.length) return { code: 1, lines };
  return { code: 0, lines: [`  ✓ .mcp.json: ${rein_n} Rein server(s), every path present`] };
}

function main(argv) {
  const [cmd, file, rein, ...rest] = argv;
  if (!["check", "doctor"].includes(cmd) || !file || !rein) {
    process.stderr.write("usage: mcp-claim.mjs check|doctor <mcp-file> <rein-dir> [--adopt]\n");
    return 2;
  }
  if (cmd === "doctor") {
    const r = doctorLines(file, rein);
    process.stdout.write(r.lines.join("\n") + "\n");
    return r.code;
  }
  const r = claimCheck(file, rein, { adopt: rest.includes("--adopt") });
  if (r.message) process.stderr.write(r.message + "\n");
  return r.code;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
