// cli-bookkeeping.mjs — `rein done`, `rein handoff`, `rein decide` (E-461, D-169 r7,
// .ai/blueprints/lean-core.md §Component 4 and §API).
//
// Three commands replace the bookkeeping skills (rein-task, arch-task, rein-handoff,
// task-planner, decision-recorder, rein-log). A step whose result can be computed is one
// command; the model only writes the entry and sends the wake line these print.
//
//   rein done <id> --summary <text>
//     The task goes DONE through the state layer and the completion gates (runTaskDone, the
//     same path as `rein task done`), then the LOG line is appended and the digest rebuilt.
//     Exit 1 names the missing stamp. A stale build prints one [BUILD_STALE] line, not a refusal.
//   rein handoff --to architect|engineer --file <entry>
//     Appends the entry to .ai/COMM.md and commits it with every dirty tracked .ai/ path
//     (D-104, D-147 r1: `git commit --only`, the list taken against HEAD), then prints the
//     short sha and the wake line for SendMessage. Exit 1 when the entry lacks
//     "Next action needed", or when COMM.md is gitignored (nothing is written then).
//   rein decide --file <entry>
//     Assigns the next D-number, requires a decision, a reason and a rollback, and appends the
//     entry to .ai/DECISIONS.md. Prints the D-###.
//
// Exit: 0 done; 1 refused (the reason is printed); 2 usage.

import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { isMainModule } from "../mcp/shared/is-main.mjs";
import { runTaskDone, GATE_ROLLBACK_VARS } from "./cli-state.mjs";
import { findAiDir } from "./cli-add-task.mjs";
import { appendLog } from "../mcp/shared/team.mjs";
import { writeDigest } from "./digest-build.mjs";

const USAGE = `usage: rein done <id> --summary <text>
       rein handoff --to architect|engineer --file <entry>
       rein decide --file <entry>`;

const ROLES = { architect: "Architect", engineer: "Engineer" };

function today() { return new Date().toISOString().slice(0, 10); }
function stampUtc() { return new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC"; }

function readEntry(file, cwd) {
  if (!file) return { error: { code: 2, out: USAGE } };
  const p = resolve(cwd, file);
  if (!existsSync(p)) return { error: { code: 1, out: `✗ [ENTRY_MISSING] ${file} does not exist` } };
  const text = readFileSync(p, "utf8");
  if (!text.trim()) return { error: { code: 1, out: `✗ [ENTRY_EMPTY] ${file} is empty` } };
  return { text };
}

/** Parse `--flag value` / `--flag=value` pairs; anything else is a usage error. */
function parseFlags(args, known) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!known.includes(name)) return null;
    const val = eq > 0 ? a.slice(eq + 1) : args[++i];
    if (val === undefined) return null;
    out[name.slice(2)] = val;
  }
  return out;
}

// ── rein done ───────────────────────────────────────────────────────────────────────
/** @returns {{code:number, out:string}} */
export function runDone(aiDir, id, summary, opts = {}) {
  if (!id || typeof summary !== "string" || !summary.trim()) return { code: 2, out: USAGE };
  const res = runTaskDone(aiDir, String(id).toUpperCase(), summary.trim(), opts);
  if (res.code !== 0 || res.already) return res;
  const lines = [res.out];
  appendLog(aiDir, `${today()} | Claude | ${String(id).toUpperCase()} | ${summary.trim()}`);
  try {
    writeDigest(dirname(resolve(aiDir)));
  } catch (e) {
    lines.push(`[DIGEST_BUILD_FAILED] ${String(e.message).slice(0, 200)} — run: rein digest build`);
  }
  return { code: 0, out: lines.join("\n") };
}

// ── rein handoff ────────────────────────────────────────────────────────────────────
function git(root, args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 60000 });
  return { ok: !r.error && r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/** The handoff line: the entry's **Trigger** value, else the first line under "Next action needed". */
export function handoffLine(text) {
  const trig = /^\*\*Trigger\*\*:\s*(.+)$/m.exec(text);
  if (trig) return trig[1].trim();
  const next = /Next action needed[^\n]*\n+([\s\S]*)/.exec(text);
  const first = next ? next[1].split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).find(Boolean) : null;
  return first || "handoff";
}

/** @returns {{code:number, out:string}} */
export function runHandoff(aiDir, { to, file } = {}, { cwd = process.cwd() } = {}) {
  const target = ROLES[String(to || "").toLowerCase()];
  if (!target || !file) return { code: 2, out: USAGE };
  const entry = readEntry(file, cwd);
  if (entry.error) return entry.error;
  if (!/Next action needed/.test(entry.text)) {
    return { code: 1, out: `✗ [HANDOFF_INCOMPLETE] ${file} has no "Next action needed" section — say what the ${target} does next` };
  }
  const root = dirname(resolve(aiDir));
  if (!git(root, ["rev-parse", "--git-dir"]).ok) return { code: 1, out: `✗ [NOT_A_REPO] ${root} is not a git work tree` };
  // D-104 r2/r4: an un-synced clone still ignores COMM.md. Refuse before writing — never add -f.
  if (git(root, ["check-ignore", "-q", ".ai/COMM.md"]).ok) {
    return { code: 1, out: "✗ [COMM_IGNORED] .ai/COMM.md is gitignored in this clone — run: rein sync" };
  }
  const comm = resolve(aiDir, "COMM.md");
  const prev = existsSync(comm) ? readFileSync(comm, "utf8") : "";
  const sep = prev && !prev.endsWith("\n") ? "\n" : "";
  const body = entry.text.endsWith("\n") ? entry.text : entry.text + "\n";
  if (prev) appendFileSync(comm, sep + body); else writeFileSync(comm, body);

  const from = target === "Architect" ? "Engineer" : "Architect";
  const when = stampUtc();
  const add = git(root, ["add", "--", ".ai/COMM.md"]);
  if (!add.ok) return { code: 1, out: `✗ [HANDOFF_COMMIT_FAILED] git add .ai/COMM.md: ${add.err.slice(0, 300)}` };
  // D-147 r1 / addendum r1: every tracked .ai/ path that differs from HEAD rides the commit,
  // staged or not; --only commits exactly these, whatever else the index holds.
  const hasHead = git(root, ["rev-parse", "--verify", "-q", "HEAD"]).ok;
  const dirty = hasHead
    ? git(root, ["diff", "--name-only", "HEAD", "--", ".ai/", ":(exclude).ai/COMM.md"]).out.split("\n").filter(Boolean)
    : [];
  const msg = `chore(.ai): COMM handoff ${when} (${from})`;
  const commit = git(root, ["commit", "-q", "--only", ".ai/COMM.md", ...dirty, "-m", msg]);
  if (!commit.ok) return { code: 1, out: `✗ [HANDOFF_COMMIT_FAILED] ${(commit.err || commit.out).slice(0, 600)}` };
  const sha = git(root, ["rev-parse", "--short", "HEAD"]).out;
  const verb = target === "Architect" ? "review and plan next" : "execute the OPEN queue";
  const wake = `SendMessage to "${basename(root)} · ${target}": ${handoffLine(entry.text)} — ${verb}. Details: .ai/COMM.md handoff ${when}, commit ${sha}.`;
  return { code: 0, out: `${sha}\n${wake}` };
}

// ── rein decide ─────────────────────────────────────────────────────────────────────
/** The parts a decision entry must carry; @returns the names of the missing ones. */
export function missingDecisionParts(text) {
  const missing = [];
  if (!/^##\s+\S/m.test(text)) missing.push("a '## <title>' heading");
  if (!/^\*\*Decision\*\*:\s*\S/m.test(text)) missing.push("a decision ('**Decision**: <one sentence>')");
  if (!/^(###\s+Why\b[^\n]*\n+\s*\S|\*\*(Why|Reason)\*\*:\s*\S|###\s+Reason\b[^\n]*\n+\s*\S)/m.test(text)) {
    missing.push("a reason ('### Why needed' with text)");
  }
  if (!/^(###\s+Rollback\b[^\n]*\n+\s*(?!---)\S|\*\*Rollback\*\*:\s*\S)/m.test(text)) missing.push("a rollback ('### Rollback' with text)");
  return missing;
}

/** The next D-number: the highest `## D-<n>` heading plus one. */
export function nextDecisionId(decisionsText) {
  let max = 0;
  for (const m of decisionsText.matchAll(/^## D-(\d+)\b/gm)) max = Math.max(max, Number(m[1]));
  return `D-${String(max + 1).padStart(3, "0")}`;
}

/** @returns {{code:number, out:string}} */
export function runDecide(aiDir, { file } = {}, { cwd = process.cwd() } = {}) {
  if (!file) return { code: 2, out: USAGE };
  const entry = readEntry(file, cwd);
  if (entry.error) return entry.error;
  const missing = missingDecisionParts(entry.text);
  if (missing.length) return { code: 1, out: `✗ [DECISION_INCOMPLETE] ${file} lacks ${missing.join(", ")}` };
  const path = resolve(aiDir, "DECISIONS.md");
  const prev = existsSync(path) ? readFileSync(path, "utf8") : "# DECISIONS\n";
  const id = nextDecisionId(prev);
  // The entry's own heading may carry a placeholder id (`## D-### — title`); the command numbers it.
  let text = entry.text.replace(/^##\s+(?:D-[\dX#?]+\s*—\s*)?(.+)$/m, (_, t) => `## ${id} — ${t.trim()}`);
  if (!/^\*\*Date\*\*:/m.test(text)) text = text.replace(/^(## D-\d+ — .*)$/m, `$1\n\n**Date**: ${today()}`);
  text = text.replace(/^\s*(---\s*\n)?/, "").replace(/\s*(\n---\s*)?$/, "");
  const sep = prev.trimEnd().endsWith("---") ? "\n\n" : "\n\n---\n\n";
  writeFileSync(path, prev.trimEnd() + sep + text + "\n\n---\n");
  return { code: 0, out: id };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────
export function main(argv, cwd = process.cwd()) {
  const [verb, ...rest] = argv;
  for (const k of GATE_ROLLBACK_VARS) delete process.env[k];   // as cli-state: an env switch is not the operator's
  const aiDir = findAiDir(cwd);
  if (verb === "done") {
    const [id, ...flags] = rest;
    const f = parseFlags(flags, ["--summary"]);
    if (!id || id.startsWith("--") || !f) return { code: 2, out: USAGE };
    return runDone(aiDir, id, f.summary);
  }
  if (verb === "handoff") {
    const f = parseFlags(rest, ["--to", "--file"]);
    return f ? runHandoff(aiDir, f, { cwd }) : { code: 2, out: USAGE };
  }
  if (verb === "decide") {
    const f = parseFlags(rest, ["--file"]);
    return f ? runDecide(aiDir, f, { cwd }) : { code: 2, out: USAGE };
  }
  return { code: 2, out: USAGE };
}

if (isMainModule(import.meta.url)) {
  let res;
  try {
    res = main(process.argv.slice(2));
  } catch (e) {
    res = { code: 1, out: `✗ ${e.message}` };
  }
  if (res.out) (res.code === 0 ? process.stdout : process.stderr).write(res.out + "\n");
  process.exit(res.code);
}
