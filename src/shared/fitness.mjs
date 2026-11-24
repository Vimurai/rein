#!/usr/bin/env node
// fitness.mjs — `rein doctor --fitness [--json]` (E-459; D-169 r11, D-170 r15; lean-core.md
// §Component 6, §Data Model, §Revision 2 "Scorecard changes").
//
// One row per measure of the scorecard. Every value is computed from the tree and the record at
// the time of the call; a measure that cannot be computed prints UNKNOWN with the reason, never a
// guess. The command reports; it exits 0 whatever the rows say (a FAIL row is a fact, not an
// error). Exit 2 only on bad arguments.
//
//   node fitness.mjs [--json] [--root <project>] [--rein-home <dir>]
//
// Where the numbers come from:
//   - the project root (--root, default: the git top level of the cwd): rulefiles, .ai/, tests/,
//     git branches;
//   - the Rein tree: <root>/src when the project is the Rein source repository, else the install
//     tree (--rein-home, default ~/.rein), which has the same layout (config/, mcp/, claude/,
//     shared/); hooks from <root>/hooks, else <rein-home>/hooks.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { architectSettings, engineerSettings, gitDirs, ARCHITECT_LANE, ARCHITECT_CWD, ENGINEER_REIN_WRITABLE } from "./role-settings.mjs";
import { TIER_DISPATCH } from "./review-checks.mjs";
import { DEFAULT_ADAPTERS } from "./provider-adapter.mjs";
import { provisioned } from "./plugin-build.mjs";
import { isMainModule } from "../mcp/shared/is-main.mjs";

/** Targets (D-169 r11 table; D-170 r15 replaces the MCP and skills targets, adds agents and hooks). */
export const TARGETS = Object.freeze({
  session_bytes: 4096, default_skills: 6, mcp_servers: 1, bookkeeping_calls: 3,
  review_agent_runs: 2, agents: 4, hook_lines: 950, role_guarantees: 5,
  command_text_lines: 300, open_gate_task_share: 0.10, gate_test_share: 0.03,
  unmerged_branches: 0, install_steps: 4,
});

/**
 * The gate's share of tests/ is decided by FILE NAME (the handoff states this set). A file under
 * tests/ whose base name matches one of these is a test of the command-text gate (safe-exec-mcp,
 * hooks/pre-tool-use.sh, the role token, the verdict tables and their drivers). Not in the set:
 * sandbox_escape_test (it tests the sandbox, which stays), completion-gates (the DONE gate),
 * rename-gate (the product-name grep), privacy-cases and traversal-policy (pre-commit / review).
 */
export const GATE_TEST_NAMES = Object.freeze([
  /safe[-_]exec/i, /pre[-_]tool[-_]use/i, /^gate[-_]/i, /role[-_]token/i,
  /^(?:arch-write|block-rules|pipe-shell|secret|role-verdict|gate-self-disable|gate-relative-home|operand-scope)-cases/i,
  /^operand-scope/i, /^check-table\.mjs$/i, /^table-probe\.mjs$/i,
]);

/**
 * An open task is about Rein's own controls when its text names the gate or its tables: the gate's
 * files, a gate of any kind, the role token, the test-budget ratchet, a verdict or contract table,
 * or a rule id of the tables.
 */
export const GATE_TASK_RE = new RegExp([
  "safe-exec", "pre-tool-use", "\\b(?:command|text|policy|write|path|shell) gate\\b", "\\bthe gate\\b",
  "\\bgate(?:'s| rules?| tables?| rows?| ledger| codes?)\\b", "role[ -]token", "test_lines", "ratchet",
  "(?:verdict|contract) tables?", "\\b(?:BLOCK|WARN)_RULES\\b",
  "\\bARCH_(?:GIT|RM|MKDIR|TOUCH|DEPLOY|CODE|ARCHIVE|INLINE|REDIRECT|SHELL|WRITE)\\w*",
  "\\bRM_RF\\w*", "SECRET_IN_COMMAND", "GATE_SELF_DISABLE",
  "(?:arch-write|pipe-shell|secret|block-rules|gate-self-disable|gate-relative-home|role-verdict)-cases",
  "operand-scope",
].join("|"), "i");

/** Statuses that are not open. Everything else (OPEN, BLOCKED, IN_PROGRESS…) counts as open. */
const CLOSED = new Set(["DONE", "SUPERSEDED", "CANCELLED", "ARCHIVED"]);

const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const bytes = (p) => { try { return statSync(p).size; } catch { return null; } };
/** Lines as `wc -l` counts them. */
const lines = (p) => { const t = read(p); return t === null ? 0 : (t.match(/\n/g) || []).length; };
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function walk(dir, skip = new Set(["node_modules", ".git"])) {
  const out = [];
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (skip.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, skip));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function git(root, args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Where the Rein tree is for this project: its own src/ (the source repo), else the install. */
export function locate(root, reinHome) {
  const src = join(root, "src");
  const tree = isFile(join(src, "config", "registry.json")) ? src : reinHome;
  const hooks = isDir(join(root, "hooks")) && isFile(join(root, "hooks", "session-start.sh")) ? join(root, "hooks") : join(reinHome, "hooks");
  return { tree, hooks };
}

const row = (axis, id, measure, target, value, ok, note = "") => ({
  axis, id, measure, value: String(value), target, result: ok ? "PASS" : "FAIL", note,
});
const unknown = (axis, id, measure, target, why) => ({ axis, id, measure, value: "UNKNOWN", target, result: "UNKNOWN", note: why });

// ── Overhead ─────────────────────────────────────────────────────────────────────────────────

/** Files Claude Code loads from a CLAUDE.md: the file and its @imports, recursively (depth 5). */
function claudeMdClosure(root, file, seen = new Set(), depth = 0) {
  const p = resolve(root, file);
  if (seen.has(p) || depth > 5 || !isFile(p)) return seen;
  seen.add(p);
  for (const m of (read(p) || "").matchAll(/^@(\S+)\s*$/gm)) claudeMdClosure(root, m[1], seen, depth + 1);
  return seen;
}

/** The brief the session-start hook injects, measured by running the hook once in the project. */
export function measureBrief(root, hooksDir) {
  const hook = join(hooksDir, "session-start.sh");
  if (!isFile(hook)) return { error: `no session-start hook at ${hook}` };
  const r = spawnSync("/bin/bash", ["-p", hook], { cwd: root, input: "{}", encoding: "utf8", timeout: 15000 });
  if (r.status !== 0 && !r.stdout) return { error: `the session-start hook exited ${r.status ?? r.signal}` };
  try {
    const ctx = JSON.parse(r.stdout).hookSpecificOutput?.additionalContext;
    if (typeof ctx !== "string") return { error: "the session-start hook printed no additionalContext" };
    return { bytes: Buffer.byteLength(ctx, "utf8") };
  } catch { return { error: "the session-start hook's output is not JSON" }; }
}

function sessionBytes(root, hooksDir, opts) {
  const M = "bytes Rein adds to a session at start", T = `≤ ${TARGETS.session_bytes}`;
  const auto = claudeMdClosure(root, "CLAUDE.md");
  if (!auto.size) return unknown("Overhead", "session_bytes", M, T, `no CLAUDE.md in ${root}`);
  const brief = opts.brief ?? measureBrief(root, hooksDir);
  if (brief.error) return unknown("Overhead", "session_bytes", M, T, brief.error);
  // A role pane is launched with `--append-system-prompt-file <its rulefile>` (provider-adapter.mjs,
  // resolve-launch.mjs) AND loads CLAUDE.md with its @imports: both count, each time it loads.
  const appends = DEFAULT_ADAPTERS.claude.launch.includes("--append-system-prompt-file");
  const autoBytes = [...auto].reduce((n, p) => n + (bytes(p) || 0), 0);
  const per = {};
  for (const [role, file] of [["engineer", "ENGINEER.md"], ["architect", "ARCHITECT.md"]]) {
    per[role] = autoBytes + (appends ? bytes(join(root, file)) || 0 : 0) + brief.bytes;
  }
  const worst = Math.max(per.engineer, per.architect);
  const files = [...auto].map((p) => basename(p)).join(" + ");
  const how = appends ? " + the appended rulefile" : "";
  return row("Overhead", "session_bytes", M, T, worst, worst <= TARGETS.session_bytes,
    `engineer ${per.engineer}, architect ${per.architect}: ${files} (${autoBytes})${how} + the brief (${brief.bytes}, measured by running the hook once; cap 2048)`);
}

// The skill and agent union is plugin-build.mjs's provisioned() (E-469): the plugin carries it.

function provisionRows(tree) {
  const p = provisioned(tree);
  const why = `no registry.json roles in ${join(tree, "config")}`;
  if (!p) {
    return [
      unknown("Overhead", "default_skills", "skills provisioned by default", `≤ ${TARGETS.default_skills}`, why),
      unknown("Overhead", "mcp_servers", "MCP servers per session", `≤ ${TARGETS.mcp_servers}`, why),
      unknown("Overhead", "agents", "agents provisioned by default", `≤ ${TARGETS.agents}`, why),
    ];
  }
  // The servers rein sync generates into .mcp.json: the registry's entries with a path.
  const servers = Object.entries(p.mcp).filter(([, v]) => v && typeof v === "object" && v.path).map(([k]) => k).sort();
  return [
    row("Overhead", "default_skills", "skills provisioned by default", `≤ ${TARGETS.default_skills}`, p.skills.length, p.skills.length <= TARGETS.default_skills, p.skills.join(", ")),
    row("Overhead", "mcp_servers", "MCP servers per session", `≤ ${TARGETS.mcp_servers}`, servers.length, servers.length <= TARGETS.mcp_servers, `generated .mcp.json: ${servers.join(", ")}`),
    row("Overhead", "agents", "agents provisioned by default", `≤ ${TARGETS.agents}`, p.agents.length, p.agents.length <= TARGETS.agents, p.agents.join(", ")),
  ];
}

/** Close and hand off a Tier 1–2 task: `rein done`, `rein handoff`, then SendMessage of the wake
 *  line `rein handoff` prints. Counted from the commands that exist, not observed in a session. */
function bookkeeping(tree) {
  const M = "bookkeeping tool calls to close and hand off a Tier 1–2 task", T = `≤ ${TARGETS.bookkeeping_calls}`;
  const cli = read(join(tree, "bin", "rein"));
  const bk = read(join(tree, "shared", "cli-bookkeeping.mjs"));
  if (cli === null || bk === null) return unknown("Overhead", "bookkeeping_calls", M, T, `no rein CLI or cli-bookkeeping.mjs in ${tree}`);
  const arms = [...cli.matchAll(/^\s*([a-z|-]+)\)/gm)].flatMap((m) => m[1].split("|"));
  const done = arms.includes("done"), handoff = arms.includes("handoff");
  if (!done || !handoff) return unknown("Overhead", "bookkeeping_calls", M, T, `rein ${done ? "handoff" : "done"} is not a command; the skill path is not counted`);
  const wake = /SendMessage/.test(bk) ? 1 : 0;
  const n = 2 + wake;
  return row("Overhead", "bookkeeping_calls", M, T, n, n <= TARGETS.bookkeeping_calls,
    `rein done + rein handoff${wake ? " + SendMessage of the printed wake line" : ""} (from the commands, not a session trace)`);
}

function review(tree) {
  const M = "agent runs to review a Tier 2 task", T = `= ${TARGETS.review_agent_runs}`;
  const agents = TIER_DISPATCH[2] || [];
  const p = provisioned(tree);
  const missing = p ? agents.filter((a) => !p.agents.includes(a)) : [];
  return row("Overhead", "review_agent_runs", M, T, agents.length,
    agents.length === TARGETS.review_agent_runs && missing.length === 0,
    `rein review 2 dispatches ${agents.join(", ")}${missing.length ? `; not provisioned: ${missing.join(", ")}` : ""}`);
}

function hookLines(hooksDir) {
  const M = "lines of hook scripts", T = `≤ ${TARGETS.hook_lines}`;
  if (!isDir(hooksDir)) return unknown("Overhead", "hook_lines", M, T, `no hooks directory at ${hooksDir}`);
  const files = readdirSync(hooksDir).filter((f) => f.endsWith(".sh")).sort();
  const per = files.map((f) => [f, lines(join(hooksDir, f))]);
  const n = per.reduce((a, [, l]) => a + l, 0);
  const big = per.filter(([, l]) => l >= 200).map(([f, l]) => `${f} ${l}`).join(", ");
  return row("Overhead", "hook_lines", M, T, n, n <= TARGETS.hook_lines, `${files.length} hooks${big ? `; largest: ${big}` : ""}`);
}

// ── Enforcement ──────────────────────────────────────────────────────────────────────────────

/**
 * The five guarantees of lean-core.md §Security, checked against the role settings the launch
 * generates for this project (role-settings.mjs, the code `rein pane` runs). Static: the escape
 * suite (tests/suites/sandbox_escape_test.sh) is what proves them in the real sandbox.
 */
export function roleGuarantees(root, tree, reinHome) {
  // `rein pane` writes the files (bin/rein → role-settings.mjs) and launches with them
  // (resolve-launch.mjs points --settings at the role dir).
  const cli = read(join(tree, "bin", "rein")) || "", launch = read(join(tree, "shared", "resolve-launch.mjs")) || "";
  const launched = cli.includes("role-settings.mjs") && launch.includes("--settings") && launch.includes("roleDir(");
  // D-172 r2a: the Architect's session starts in <project>/.ai, so its Bash can write the working
  // directory (a lane entry), the write list and nothing else — the project root needs no deny list.
  const inLane = ARCHITECT_LANE.includes(ARCHITECT_CWD) && cli.includes(`cd "\${_proj}/${ARCHITECT_CWD}"`);
  let A, E;
  try { A = architectSettings(root, reinHome); E = engineerSettings(root, reinHome); } catch (e) { return { error: `role settings: ${e.message}` }; }
  const aSb = A.sandbox || {}, eSb = E.sandbox || {};
  const aDeny = new Set(aSb.filesystem?.denyWrite || []), eDeny = new Set(eSb.filesystem?.denyWrite || []);
  const aAllow = aSb.filesystem?.allowWrite || [];
  const fileTool = (A.permissions?.allow || []).filter((r) => /^(Edit|Write|MultiEdit|NotebookEdit)\b/.test(r));
  const reinEntries = isDir(reinHome) ? readdirSync(reinHome).filter((e) => e !== ENGINEER_REIN_WRITABLE).map((e) => join(reinHome, e)) : null;
  const on = (s) => s.enabled === true && s.failIfUnavailable === true;
  const checks = [
    ["Architect file tools write only .ai/ and plans/", A.permissions?.defaultMode === "dontAsk"
      && fileTool.length > 0 && fileTool.every((r) => ARCHITECT_LANE.some((l) => r === `Edit(/${join(root, l)}/**)`))],
    ["Architect Bash writes only .ai/, plans/ and .git", on(aSb) && inLane
      && aAllow.every((p) => ARCHITECT_LANE.some((l) => p === join(root, l)) || p.startsWith(join(root, ".git")) || p === gitDirs(root).commonDir)],
    ["Architect cannot push or merge", on(aSb) && Array.isArray(aSb.network?.allowedDomains) && aSb.network.allowedDomains.length === 0
      && aDeny.has(join(gitDirs(root).gitDir, "HEAD"))],
    ["neither role changes the controls", reinEntries !== null && reinEntries.length > 0 && reinEntries.every((p) => eDeny.has(p))
      && eDeny.has(join(root, ".claude")) && !aAllow.includes(join(root, ".claude"))
      && !aAllow.some((p) => p === reinHome || p.startsWith(reinHome + "/"))],
    ["neither role leaves the sandbox", [aSb, eSb].every((s) => on(s) && s.allowUnsandboxedCommands === false)
      && [A, E].every((s) => s.permissions?.disableBypassPermissionsMode === "disable")],
  ];
  return { launched, checks };
}

function enforcementRow(root, tree, reinHome) {
  const M = "role guarantees held by sandbox or path rule", T = `${TARGETS.role_guarantees} of 5`;
  const g = roleGuarantees(root, tree, reinHome);
  if (g.error) return unknown("Enforcement", "role_guarantees", M, T, g.error);
  if (!g.launched) return row("Enforcement", "role_guarantees", M, T, "0 of 5", false, "rein pane does not launch with the role settings (bin/rein → role-settings.mjs, resolve-launch.mjs → --settings <role dir>)");
  const held = g.checks.filter(([, ok]) => ok).length;
  const failed = g.checks.filter(([, ok]) => !ok).map(([n]) => n);
  return row("Enforcement", "role_guarantees", M, T, `${held} of 5`, held === TARGETS.role_guarantees,
    failed.length ? `not held: ${failed.join("; ")}` : "checked in the generated role settings; the escape suite proves them at run time");
}

function commandTextLines(tree) {
  const M = "lines of command-text rules", T = `≤ ${TARGETS.command_text_lines}`;
  // D-172 r26: the seatbelt is one file, src/shared/seatbelt.mjs — this row counts that file only.
  const f = join(tree, "shared", "seatbelt.mjs");
  if (!existsSync(f)) return row("Enforcement", "command_text_lines", M, T, 0, true, `no ${f}`);
  const n = lines(f);
  return row("Enforcement", "command_text_lines", M, T, n, n <= TARGETS.command_text_lines, "src/shared/seatbelt.mjs");
}

// ── Self-policing ────────────────────────────────────────────────────────────────────────────

function openTasks(root) {
  const s = readJson(join(root, ".ai", "state.json"));
  return Array.isArray(s?.tasks) ? s.tasks.filter((t) => t && !CLOSED.has(t.status)) : null;
}

function gateTasks(root) {
  const M = "open tasks about Rein's own controls", T = `≤ ${pct(TARGETS.open_gate_task_share)}`;
  const open = openTasks(root);
  if (!open) return unknown("Self-policing", "open_gate_task_share", M, T, `no tasks in ${join(root, ".ai", "state.json")}`);
  if (!open.length) return row("Self-policing", "open_gate_task_share", M, T, "0 of 0", true, "no open tasks");
  const hit = open.filter((t) => GATE_TASK_RE.test(String(t.description || "")));
  const share = hit.length / open.length;
  return row("Self-policing", "open_gate_task_share", M, T, `${hit.length} of ${open.length} (${pct(share)})`,
    share <= TARGETS.open_gate_task_share, "task text names the gate or its tables (fitness.mjs GATE_TASK_RE)");
}

export function isGateTest(file) {
  const b = basename(file);
  return GATE_TEST_NAMES.some((re) => re.test(b));
}

function gateTests(root) {
  const M = "share of tests/ that tests the gate", T = `≤ ${pct(TARGETS.gate_test_share)}`;
  const dir = join(root, "tests");
  if (!isDir(dir)) return unknown("Self-policing", "gate_test_share", M, T, `no tests/ in ${root}`);
  let all = 0, gate = 0, nGate = 0;
  for (const f of walk(dir)) {
    const l = lines(f);
    all += l;
    if (isGateTest(f)) { gate += l; nGate++; }
  }
  if (!all) return unknown("Self-policing", "gate_test_share", M, T, "tests/ holds no lines");
  const share = gate / all;
  return row("Self-policing", "gate_test_share", M, T, `${pct(share)} (${gate} of ${all} lines)`, share <= TARGETS.gate_test_share,
    `${nGate} files by name (fitness.mjs GATE_TEST_NAMES)`);
}

// ── Waiting ──────────────────────────────────────────────────────────────────────────────────

/** The ref a branch must be merged into: origin's default branch, else origin/main|master, else local. */
function trunkRef(root) {
  const h = git(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (h) return h.replace(/^refs\/remotes\//, "");
  for (const r of ["origin/main", "origin/master", "main", "master"]) {
    if (git(root, ["rev-parse", "-q", "--verify", `${r}^{commit}`])) return r;
  }
  return null;
}

function waiting(root) {
  const M = "finished branches waiting for the operator", T = `${TARGETS.unmerged_branches}`;
  if (git(root, ["rev-parse", "--git-dir"]) === null) return unknown("Waiting", "unmerged_branches", M, T, `${root} is not a git repository`);
  const trunk = trunkRef(root);
  if (!trunk) return unknown("Waiting", "unmerged_branches", M, T, "no trunk: no origin/HEAD, origin/main, origin/master, main or master");
  const cur = git(root, ["symbolic-ref", "-q", "--short", "HEAD"]) || "";
  const out = git(root, ["for-each-ref", "--format=%(refname:short)", `--no-merged=${trunk}`, "refs/heads"]);
  if (out === null) return unknown("Waiting", "unmerged_branches", M, T, `git for-each-ref --no-merged=${trunk} failed`);
  const local = trunk.replace(/^origin\//, "");
  const names = out.split("\n").filter((b) => b && b !== cur && b !== local);
  const shown = names.slice(0, 5).join(", ") + (names.length > 5 ? ", …" : "");
  return row("Waiting", "unmerged_branches", M, T, names.length, names.length <= TARGETS.unmerged_branches,
    `local branches not merged into ${trunk}, the checked-out one excepted${names.length ? `: ${shown}` : ""}`);
}

// ── Adoptability ─────────────────────────────────────────────────────────────────────────────

function adoptability() {
  return unknown("Adoptability", "install_steps", "steps from install to a first closed task", `≤ ${TARGETS.install_steps}, nothing to read first`,
    "not computable from the tree: it needs a run in a scratch HOME from install-rein.sh to `rein done` (install-rein.sh and `rein init` install the plugin since E-469; docs/getting-started.md counts the steps, E-468)");
}

// ── The scorecard ────────────────────────────────────────────────────────────────────────────

/**
 * @param {{root: string, reinHome?: string, brief?: {bytes:number}|{error:string}}} opts
 *        `brief` replaces running the hook (tests).
 * @returns {Array<{axis,id,measure,value,target,result,note}>}
 */
export function scorecard({ root, reinHome = join(homedir(), ".rein"), brief } = {}) {
  const { tree, hooks } = locate(root, reinHome);
  const [skills, mcp, agents] = provisionRows(tree);
  return [
    sessionBytes(root, hooks, { brief }),
    skills, mcp,
    bookkeeping(tree),
    review(tree),
    agents,
    hookLines(hooks),
    enforcementRow(root, tree, reinHome),
    commandTextLines(tree),
    gateTasks(root),
    gateTests(root),
    waiting(root),
    adoptability(),
  ];
}

export function renderText(rows) {
  const w = (k, min) => Math.max(min, ...rows.map((r) => String(r[k]).length));
  const wa = w("axis", 4), wm = w("measure", 7), wv = w("value", 5), wt = w("target", 6);
  const pad = (s, n) => String(s).padEnd(n);
  const out = [`${pad("Axis", wa)}  ${pad("Measure", wm)}  ${pad("Value", wv)}  ${pad("Target", wt)}  Result`];
  for (const r of rows) {
    out.push(`${pad(r.axis, wa)}  ${pad(r.measure, wm)}  ${pad(r.value, wv)}  ${pad(r.target, wt)}  ${r.result}`);
    if (r.note) out.push(`${" ".repeat(wa + 2)}↳ ${r.note}`);
  }
  const n = (k) => rows.filter((r) => r.result === k).length;
  out.push("", `${n("PASS")} PASS · ${n("FAIL")} FAIL · ${n("UNKNOWN")} UNKNOWN of ${rows.length} rows`);
  return out.join("\n");
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const known = new Set(["--json", "--fitness", "--root", "--rein-home"]);
  const bad = argv.filter((a, i) => a.startsWith("--") && !known.has(a) && !["--root", "--rein-home"].includes(argv[i - 1]));
  if (bad.length || (argv.includes("--root") && !opt("--root")) || (argv.includes("--rein-home") && !opt("--rein-home"))) {
    process.stderr.write("usage: rein doctor --fitness [--json]   (fitness.mjs [--json] [--root <dir>] [--rein-home <dir>])\n");
    process.exit(2);
  }
  const root = resolve(opt("--root") || (git(process.cwd(), ["rev-parse", "--show-toplevel"]) || process.cwd()));
  const rows = scorecard({ root, reinHome: resolve(opt("--rein-home") || join(homedir(), ".rein")) });
  process.stdout.write(argv.includes("--json") ? JSON.stringify(rows, null, 2) + "\n" : renderText(rows) + "\n");
}
