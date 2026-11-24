#!/usr/bin/env node
// role-settings.mjs — the role settings files that hold each role's boundary (E-462).
//
// D-169 r3, D-170 r10, .ai/blueprints/lean-core.md §Component 1 and §Security. The shape is
// the one E-458 measured on this machine (plans/e-458-sandbox-measurement.md):
//   - the Architect's session starts with its working directory at <project>/.ai (D-172 r2a,
//     F3 of the lean-core round): the sandbox makes the working directory writable and nothing
//     else, so the project root is read-only to its Bash with no deny list, and a file planted
//     at the root (.npmrc, conftest.py, …) cannot be made. plans/ and the git dirs are on the
//     write list; its file tools may write only .ai/ and plans/ (dontAsk + allow Edit on the
//     two absolute paths — no Edit(!…) shape works); no network domain; .git/HEAD
//     write-denied, so it can commit on the branch but not switch it; also .git/refs/remotes,
//     refs/replace, packed-refs and info (F2 of the lean-core round). A session started in
//     .ai/ reads no project .claude/settings.json, so this file carries what the Architect
//     needs from it: the command gate's PreToolUse entry (until E-463) and the session env;
//     `rein pane` loads the rein plugin with --plugin-dir (resolve-launch.mjs);
//   - the Engineer's Bash runs in the sandbox with every entry of ~/.rein but ci/ (where
//     `rein ci run` keeps its logs) and the project's .claude/ write-denied, and the network
//     domains CI and the registry need;
//   - both: failIfUnavailable, no unsandboxed retry, bypass mode disabled.
//
// WHERE (gap 3 of E-458): the files are written under ~/.rein/roles/<project key>/, never in
// the project. The Engineer's sandbox write-denies ~/.rein (measured, M9) and the Architect's
// write list does not include it, so neither session can edit either role's file — in the
// project, `.claude/settings.architect.json` was writable by the Engineer. `rein pane` and
// `rein start` regenerate them on every launch, so a file is never older than the launch.
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
/** Entries the Architect may write. Nothing else at the top level is writable: the session's
 *  working directory is the first of them (ARCHITECT_CWD), and the root is not on its list. */
export const ARCHITECT_LANE = [".ai", "plans"];
/** The Architect's working directory, relative to the project (D-172 r2a). `rein pane` starts the
 *  session there; Claude Code makes the working directory writable, so it must be in the lane. */
export const ARCHITECT_CWD = ".ai";
/** The command gate's hook, which a project's .claude/settings.json registers (rein sync) and a
 *  session started in .ai/ does not read. Carried in the Architect's file until E-463 deletes it. */
export const GATE_HOOK = Object.freeze({ event: "PreToolUse", matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit", script: "pre-tool-use.sh" });
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

/** The Architect's write-denied paths: the git paths its write list would otherwise open. The
 *  project root needs none (D-172 r2a): the session runs in .ai/, and the root is not writable. */
export function architectDenyList(project) {
  const { gitDir, commonDir } = gitDirs(project);
  // M3: HEAD write-denied keeps a commit on the branch working and stops a branch switch.
  const out = [join(gitDir, "HEAD"), join(commonDir, "rein")];
  // SECURITY.md lean-core round F2/F3: refs the Architect could forge to hide a commit from the
  // lane check (remote-tracking refs, packed-refs, replace objects) and info/ (grafts, and the
  // exclude file that hid a planted entry). A commit on the branch writes none of them.
  for (const p of ARCHITECT_GIT_DENY) out.push(join(commonDir, p));
  return out;
}

/** Paths under the git common dir write-denied to the Architect (beyond HEAD and rein/). */
export const ARCHITECT_GIT_DENY = ["refs/remotes", "refs/replace", "packed-refs", "info"];
/** Of those, the directories. Each denied path is made before launch if it does not exist: the
 *  sandbox puts an unreadable placeholder at a denied path that is absent, and git then fails on
 *  it (an absent packed-refs stopped every `git status` and `git commit` in the escape suite), or a
 *  file at refs/replace would read as a broken ref. */
const ARCHITECT_GIT_DENY_DIRS = ["refs/remotes", "refs/replace", "info"];
/** An empty packed-refs as git writes it: valid, and holds no ref. */
const PACKED_REFS_HEADER = "# pack-refs with: peeled fully-peeled sorted \n";

/** Create the denied git paths that do not exist yet (best effort; no .git/refs: nothing). */
export function ensureGitDenyPaths(project) {
  const { commonDir } = gitDirs(project);
  if (!existsSync(join(commonDir, "refs"))) return;
  for (const d of ARCHITECT_GIT_DENY_DIRS) {
    try { mkdirSync(join(commonDir, d), { recursive: true }); } catch { /* the launch reports a sandbox failure */ }
  }
  try { writeFileSync(join(commonDir, "packed-refs"), PACKED_REFS_HEADER, { flag: "wx", mode: 0o644 }); } catch { /* exists */ }
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

/** `//` anchors an absolute path in a permission rule (a single `/` is relative to the settings file). */
const abs = (p) => `/${p}`;

/** The gate's hook entry in exec form (E-290), when the install tree has the script. */
export function gateHooks(reinHome) {
  let script;
  try { script = realpathSync(join(reinHome, "hooks", GATE_HOOK.script)); } catch { return undefined; }
  return { [GATE_HOOK.event]: [{ matcher: GATE_HOOK.matcher, hooks: [{ type: "command", command: "/bin/bash", args: ["-p", script], timeout: 30 }] }] };
}

export function architectSettings(project, reinHome = join(homedir(), ".rein")) {
  const { gitDir, commonDir } = gitDirs(project);
  const allowWrite = [...ARCHITECT_LANE.map((e) => join(project, e)), gitDir];
  if (commonDir !== gitDir) allowWrite.push(commonDir);
  const s = {
    // What rein sync puts in the project's settings env that a session in .ai/ would miss.
    env: { REIN_CALLER_ROLE: "architect", CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" },
    sandbox: sandbox({ denyWrite: architectDenyList(project), allowWrite }, []),
    permissions: {
      defaultMode: "dontAsk",
      allow: [
        ...ARCHITECT_LANE.map((e) => `Edit(${abs(join(project, e))}/**)`),
        `Read(${abs(project)}/**)`, "Bash",
        `mcp__${STATE_SERVER}`, "ListAgents", "SendMessage", "Agent", "Skill",
        "WebSearch", "WebFetch",
      ],
      deny: [...MCP_WRITE_TOOLS],
      disableBypassPermissionsMode: "disable",
      disableAutoMode: "disable",
    },
  };
  const hooks = gateHooks(reinHome);
  if (hooks) s.hooks = hooks;
  return s;
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
    if (role === "architect") ensureGitDenyPaths(project);
    writeJsonAtomic(p, role === "architect" ? architectSettings(project, reinHome) : engineerSettings(project, reinHome));
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
