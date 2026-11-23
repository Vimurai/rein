#!/usr/bin/env node
// role-settings.mjs — the role settings files that hold each role's boundary (E-462).
//
// D-169 r3, D-170 r10, .ai/blueprints/lean-core.md §Component 1 and §Security. The shape is
// the one E-458 measured on this machine (plans/e-458-sandbox-measurement.md):
//   - the Architect's Bash runs in the sandbox with every top-level entry of the project
//     write-denied except .ai, plans and .git; its file tools may write only .ai/ and plans/
//     (dontAsk + allow Edit(.ai/**), Edit(plans/**) — no Edit(!…) shape works); no network
//     domain; .git/HEAD write-denied, so it can commit on the branch but not switch it;
//   - the Engineer's Bash runs in the sandbox with every entry of ~/.rein but ci/ (where
//     `rein ci run` keeps its logs) and the project's .claude/ write-denied, and the network
//     domains CI and the registry need;
//   - both: failIfUnavailable, no unsandboxed retry, bypass mode disabled.
//
// WHERE (gap 3 of E-458): the files are written under ~/.rein/roles/<project key>/, never in
// the project. The Engineer's sandbox write-denies ~/.rein (measured, M9) and the Architect's
// write list does not include it, so neither session can edit either role's file — in the
// project, `.claude/settings.architect.json` was writable by the Engineer. `rein pane` and
// `rein start` regenerate them on every launch, so the deny list is never older than the launch.
//
// The Architect's MCP list holds only the state server (mcp.architect.json, passed with
// --strict-mcp-config): MCP servers are not sandboxed.
//
// Usage:
//   node role-settings.mjs write --ai-dir <dir> [--out <dir>] [--rein-home <dir>] [--role <r>]
//       writes settings.<role>.json for each pane role mapped to claude (+ mcp.architect.json)
//       into --out (default: the role dir); prints one line per file. Exit 1 if a write fails.
//   node role-settings.mjs dir --ai-dir <dir> [--rein-home <dir>]   → prints the role dir

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Pane roles that have a boundary shape. Any other role key gets no file. */
export const PANE_ROLES = ["architect", "engineer"];
/** E-458 M7: what `rein ci run`, `gh` and the package registry need. */
export const ENGINEER_DOMAINS = ["github.com", "api.github.com", "*.githubusercontent.com", "registry.npmjs.org"];
/** Entries the Architect's Bash may write. Everything else at the top level is denied. */
export const ARCHITECT_LANE = [".ai", "plans"];
/** A file Claude Code loads into the other role's session from the project root that its own
 *  protected list does not name. Denied even when absent (the sandbox puts an empty placeholder
 *  there while a command runs), because a new top-level entry is otherwise writable (gap 1 of
 *  E-458). Only a FILE name belongs here: a placeholder for a directory name would be a file. */
export const RESERVED_ABSENT = ["CLAUDE.local.md"];
/** MCP tools that write files. The Architect's MCP list no longer loads them; denied anyway. */
const MCP_WRITE_TOOLS = [
  "mcp__filesystem__write_file", "mcp__filesystem__edit_file", "mcp__filesystem__move_file",
  "mcp__filesystem__create_directory", "mcp__patch-mcp__patch_file",
  "mcp__propose-patch-mcp__propose_patch", "mcp__propose-patch-mcp__confirm_patch",
  "mcp__computer-use-mcp__type_text", "mcp__computer-use-mcp__key_press",
];
const STATE_SERVER = "task-synchronizer-mcp";

const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/** The project root an .ai directory belongs to, as a physical path. */
export function projectRoot(aiDir) {
  const p = dirname(resolve(aiDir));
  try { return realpathSync(p); } catch { return p; }
}

/** ~/.rein/roles/<basename>-<12 hex of sha256(path)>: one directory per project path. */
export function roleDir(project, reinHome = join(homedir(), ".rein")) {
  const name = basename(project).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "project";
  const key = createHash("sha256").update(project).digest("hex").slice(0, 12);
  return join(reinHome, "roles", `${name}-${key}`);
}

/** The git directories a commit writes. `.git` may be a file (a worktree): follow it. */
export function gitDirs(project) {
  const dotgit = join(project, ".git");
  let gitDir = dotgit;
  try {
    if (statSync(dotgit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"));
      if (m) gitDir = resolve(project, m[1].trim());
    }
  } catch { /* no .git: the commit route simply does not exist */ }
  let commonDir = gitDir;
  try {
    const c = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (c) commonDir = resolve(gitDir, c);
  } catch { /* not a linked worktree */ }
  return { gitDir, commonDir };
}

/** The lane ledger directory (lane-ledger.mjs): writable by the Engineer, denied to the Architect. */
export function ledgerDir(project) {
  return join(gitDirs(project).commonDir, "rein");
}

/** Every top-level entry except .ai, plans and .git, plus the reserved names. Absolute, sorted. */
export function architectDenyList(project) {
  let entries = [];
  try { entries = readdirSync(project); } catch { entries = []; }
  const names = new Set(entries.filter((e) => !ARCHITECT_LANE.includes(e) && e !== ".git"));
  for (const r of RESERVED_ABSENT) names.add(r);
  const { gitDir, commonDir } = gitDirs(project);
  const out = [...names].sort().map((e) => join(project, e));
  // M3: HEAD write-denied keeps a commit on the branch working and stops a branch switch.
  out.push(join(gitDir, "HEAD"));
  out.push(join(commonDir, "rein"));
  return out;
}

function sandbox(filesystem, allowedDomains) {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem,
    network: { allowedDomains },
  };
}

export function architectSettings(project) {
  const { gitDir, commonDir } = gitDirs(project);
  const allowWrite = [...ARCHITECT_LANE.map((e) => join(project, e)), gitDir];
  if (commonDir !== gitDir) allowWrite.push(commonDir);
  return {
    env: { REIN_CALLER_ROLE: "architect" },
    sandbox: sandbox({ denyWrite: architectDenyList(project), allowWrite }, []),
    permissions: {
      defaultMode: "dontAsk",
      allow: [
        "Edit(.ai/**)", "Edit(plans/**)", "Bash",
        `mcp__${STATE_SERVER}`, "ListAgents", "SendMessage", "Agent", "Skill",
        "WebSearch", "WebFetch",
      ],
      deny: [...MCP_WRITE_TOOLS],
      disableBypassPermissionsMode: "disable",
      disableAutoMode: "disable",
    },
  };
}

/** The one install-tree entry the Engineer's commands write: `rein ci run` keeps its logs,
 *  census and caches there (src/bin/rein, ci_home). It holds no control. */
export const ENGINEER_REIN_WRITABLE = "ci";

/** Every entry of the install tree except ci/, write-denied to the Engineer. ~/.rein itself is
 *  outside the Engineer's write list, so no new entry can be made there; a broad deny of ~/.rein
 *  would also deny ci/ (E-458 M1: the broad deny wins), so the entries are listed one by one. */
export function engineerReinDeny(reinHome) {
  let entries = [];
  try { entries = readdirSync(reinHome); } catch { entries = []; }
  return entries.filter((e) => e !== ENGINEER_REIN_WRITABLE).sort().map((e) => join(reinHome, e));
}

export function engineerSettings(project, reinHome = join(homedir(), ".rein")) {
  const reinDeny = engineerReinDeny(reinHome);
  return {
    env: { REIN_CALLER_ROLE: "engineer" },
    sandbox: sandbox({
      denyWrite: [...reinDeny, join(project, ".claude")],
      allowWrite: [join(reinHome, ENGINEER_REIN_WRITABLE)],
    }, [...ENGINEER_DOMAINS]),
    permissions: {
      allow: ["Bash", "Edit(./**)"],
      // `//` anchors an absolute path in a permission rule.
      deny: [...reinDeny.flatMap((d) => [`Edit(/${d})`, `Edit(/${d}/**)`]), "Edit(.claude/settings.json)", "Edit(.claude/settings.local.json)"],
      disableBypassPermissionsMode: "disable",
    },
  };
}

/** The Architect's only MCP server, from the install tree. */
export function architectMcpConfig(reinHome = join(homedir(), ".rein")) {
  return { mcpServers: { [STATE_SERVER]: { command: "node", args: [join(reinHome, "mcp", STATE_SERVER, "index.js")] } } };
}

/** Pane roles roles.json maps to claude (headless roles have no pane and no file). */
export function paneRoles(aiDir) {
  const roles = readJson(join(aiDir, "roles.json"))?.roles;
  const cfg = roles && typeof roles === "object" ? roles : { architect: { provider: "claude" }, engineer: { provider: "claude" } };
  return Object.entries(cfg)
    .filter(([r, c]) => ROLE_RE.test(r) && PANE_ROLES.includes(r) && c && typeof c === "object" && c.provider === "claude" && c.headless !== true)
    .map(([r]) => r);
}

function writeJsonAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, path);
}

/** Write the role files. Returns the paths written. Throws on a write that fails. */
export function writeRoleFiles({ aiDir, out, reinHome = join(homedir(), ".rein"), roles }) {
  const project = projectRoot(aiDir);
  const dir = out || roleDir(project, reinHome);
  mkdirSync(dir, { recursive: true });
  // The Engineer's writable entry must exist at launch: the sandbox skips an allowWrite path that
  // does not, and ~/.rein itself is not writable inside it.
  try { mkdirSync(join(reinHome, ENGINEER_REIN_WRITABLE), { recursive: true }); } catch { /* rein ci run reports it */ }
  const written = [];
  for (const role of roles?.length ? roles.filter((r) => paneRoles(aiDir).includes(r)) : paneRoles(aiDir)) {
    const p = join(dir, `settings.${role}.json`);
    writeJsonAtomic(p, role === "architect" ? architectSettings(project) : engineerSettings(project, reinHome));
    written.push(p);
    if (role === "architect") {
      const m = join(dir, "mcp.architect.json");
      writeJsonAtomic(m, architectMcpConfig(reinHome));
      written.push(m);
    }
  }
  return written;
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// Run directly? Real paths on both sides: the install mirror may reach this file through a
// symlinked directory (as a test fixture HOME does), and macOS routes $TMPDIR through /private.
function isMain() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  const [cmd, ...rest] = process.argv.slice(2);
  const aiDir = arg(rest, "--ai-dir");
  const reinHome = arg(rest, "--rein-home") || join(homedir(), ".rein");
  if (!aiDir || !existsSync(aiDir) || !isAbsolute(reinHome)) {
    process.stderr.write("usage: role-settings.mjs write|dir --ai-dir <dir> [--out <dir>] [--rein-home <abs>] [--role <r>]\n");
    process.exit(2);
  }
  if (cmd === "dir") {
    process.stdout.write(roleDir(projectRoot(aiDir), reinHome) + "\n");
  } else if (cmd === "write") {
    try {
      const role = arg(rest, "--role");
      for (const p of writeRoleFiles({ aiDir, out: arg(rest, "--out"), reinHome, roles: role ? [role] : undefined })) {
        process.stdout.write(p + "\n");
      }
    } catch (e) {
      process.stderr.write(`[ROLE_SETTINGS] could not write the role settings: ${e.code || e.message}\n`);
      process.exit(1);
    }
  } else {
    process.stderr.write("usage: role-settings.mjs write|dir --ai-dir <dir>\n");
    process.exit(2);
  }
}
