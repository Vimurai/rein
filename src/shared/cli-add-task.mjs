// cli-add-task.mjs — the shell-native primitive behind `ai add-task` (E-198,
// Architect Ruling A / pending D-053).
//
// WHY THIS EXISTS:
//   State mutation is normally MCP-only (structured-outputs.md §32). A session without
//   the project MCP servers that hand-edits TASKS.md loses those rows: the next
//   `verify_markdown_sync` regenerates TASKS.md from state.sqlite and DROPS the
//   unpersisted rows (the "orphaned blueprint" incident). This helper is the
//   deterministic shell primitive behind `ai add-task`.
//
//   Both this CLI and task-synchronizer-mcp::add_task route through the SAME
//   state-db::addTask(), so state.sqlite stays the single writer and the two callers
//   can never drift (engineering-standards.md §src/shared reuse). The Architect ratified
//   this as an explicit, audited exception to MCP-only state mutation.
//
// CONSTRAINTS (Architect Ruling A):
//   1. Invoke the EXACT same state logic as the MCP tool — done via the shared
//      addTask() (nextId → DAG validate → INSERT → id high-water → regenerate views).
//   2. Stamp the caller_role: the created task's owner reflects the resolved Triad
//      role (architect → "Architect (Claude)", engineer → "Engineer (Claude)"), taken
//      from the bootloader-injected REIN_CALLER_ROLE (E-127) unless overridden.
//   3. Respect the sovereignty lock: writes go through getDbSeeded() (node:sqlite WAL,
//      single-writer) — the same handle discipline the MCP uses; no divergent raw write.
//
import { isMainModule } from "../mcp/shared/is-main.mjs";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { getDbSeeded, addTask } from "../mcp/shared/state-db.js";
import { roleProvider } from "./provider-adapter.mjs";

// Triad caller_role → TASKS.md owner label. Attribution only (safe-exec-mcp owns the
// tamper-resistant HMAC role boundary, E-129); here we just record who created the row.
//
// E-213 (architect-provider-parity.md §Components 4): the PROVIDER half is resolved
// from .ai/roles.json rather than hardcoded, so the label always names the provider the
// role is actually bound to. state-db::roleFromOwner splits on " (" for the generated
// TASKS.md section headers, so making the provider dynamic cannot churn those headers.
export const DEFAULT_ROLE_OWNER = {
  architect: "Architect (Claude)",
  engineer:  "Engineer (Claude)",
};

// Kept as a named export for back-compat with existing importers/tests.
export const ROLE_OWNER = DEFAULT_ROLE_OWNER;

// "claude" → "Claude". Cosmetic only: the label is human-facing and the previous
// hardcoded values were capitalized, so this keeps TASKS.md reading the same way.
function _titleProvider(p) {
  const t = String(p || "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

/**
 * Resolve the owner label. Explicit --owner wins; else map the Triad role
 * (--role, then the bootloader-injected REIN_CALLER_ROLE, then 'engineer') and
 * pair it with the provider that role is bound to in .ai/roles.json.
 * Fails soft to the D-050 defaults — an attribution label must never break task
 * creation just because roles.json is missing or unreadable.
 */
export function resolveOwner({ owner, role, aiDir } = {}) {
  if (typeof owner === "string" && owner.trim()) return owner.trim();
  const r = String(role || process.env.REIN_CALLER_ROLE || "engineer").toLowerCase();
  const known = r === "architect" ? "architect" : "engineer";
  const label = known === "architect" ? "Architect" : "Engineer";
  try {
    const dir = aiDir || findAiDir(process.cwd());
    const provider = _titleProvider(roleProvider(dir, known));
    if (provider) return `${label} (${provider})`;
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_ROLE_OWNER[known];
}

/**
 * Walk up from a start dir to find the project's .ai/ directory (state.sqlite lives
 * under it). Mirrors advisor-mcp::findProjectRoot — tolerant of being invoked from a
 * subdirectory. Falls back to <cwd>/.ai even if absent (getDb will surface the error).
 */
export function findAiDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".ai");
    // E-325: a fresh clone of a team project has neither yet — project.json marks it.
    if (existsSync(join(candidate, "state.sqlite")) || existsSync(join(candidate, "state.json")) ||
        existsSync(join(candidate, "project.json"))) {
      return candidate;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return join(startDir, ".ai");
}

/**
 * Parse `ai add-task` argv (tokens AFTER the `add-task` subcommand). Supports
 * `--flag value` and `--flag=value`; every non-flag token is part of the description.
 * Recognised flags: --prefix, --owner, --role, --tier, --depends-on (comma-separated).
 * @returns {{prefix,owner,role,tier,depends_on:string[],description:string}}
 */
export function parseArgs(argv) {
  const out = { prefix: "E", owner: null, role: null, tier: null, depends_on: [], _desc: [] };
  const takesValue = new Set(["--prefix", "--owner", "--role", "--tier", "--depends-on"]);
  for (let i = 0; i < argv.length; i++) {
    let tok = argv[i];
    if (tok.startsWith("--")) {
      let val = null;
      const eq = tok.indexOf("=");
      if (eq !== -1) { val = tok.slice(eq + 1); tok = tok.slice(0, eq); }
      else if (takesValue.has(tok)) { val = argv[++i]; }
      switch (tok) {
        case "--prefix":     out.prefix = (val || "E").toUpperCase(); break;
        case "--owner":      out.owner = val; break;
        case "--role":       out.role = val; break;
        case "--tier":       out.tier = val != null ? parseInt(val, 10) : null; break;
        case "--depends-on": out.depends_on = String(val || "").split(",").map(s => s.trim()).filter(Boolean); break;
        default: /* unknown flag → ignore (forward-compatible) */ break;
      }
    } else {
      out._desc.push(tok);
    }
  }
  const { _desc, ...rest } = out;
  return { ...rest, description: _desc.join(" ").trim() };
}

/**
 * Create a task from resolved options. Pure of process state (caller supplies aiDir),
 * so it is unit-testable and reusable. Routes through the shared addTask().
 * @returns {{ok:true, task:object, owner:string} | {ok:false, code:string, error:string}}
 */
export function runAddTask({ aiDir, description, owner, role, tier, prefix, depends_on } = {}) {
  const finalOwner = resolveOwner({ owner, role });
  let db;
  try {
    // E-325: seeded like the MCP server — a first open must import state.json (legacy) or
    // rebuild from the record files (team), never regenerate views from an empty index.
    db = getDbSeeded(aiDir);
  } catch (e) {
    return { ok: false, code: "STATE_DB_UNAVAILABLE", error: `could not open state.sqlite under ${aiDir}: ${e.message}` };
  }
  const res = addTask(aiDir, db, { owner: finalOwner, description, tier, prefix, depends_on });
  if (!res.ok) return res;
  return { ok: true, task: res.task, owner: finalOwner };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────
// Invoked as: node cli-add-task.mjs <args…>  (from bin/ai `do_add_task`).
function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  if (!opts.description) {
    process.stderr.write("usage: ai add-task [--prefix E|P] [--owner <name>] [--role architect|engineer] [--tier N] [--depends-on E-1,E-2] <description>\n");
    process.exit(2);
  }
  const aiDir = findAiDir(process.cwd());
  const res = runAddTask({ aiDir, ...opts });
  if (!res.ok) {
    process.stderr.write(`ai add-task: [${res.code}] ${res.error}\n`);
    process.exit(1);
  }
  // stdout: the created id (scriptable) + a human line; full record to stderr for logs.
  process.stdout.write(`${res.task.id}\n`);
  process.stderr.write(`✓ Added ${res.task.id} (${res.task.status}) owner="${res.owner}": ${res.task.description}\n`);
}

// Run only when executed directly (not when imported by tests). Mirrors the
// is-main guard used across the MCP servers.
if (isMainModule(import.meta.url)) {
  main();
}
