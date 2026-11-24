#!/usr/bin/env node
// seatbelt.mjs — E-463 (D-169 r2/r5, lean-core.md §Component 2): what is left of the command-text
// gate. It is ADVICE, not a security boundary: the role sandbox is the boundary (D-169 r3,
// docs/role-sandbox.md). It gets no pen-test round and no new spellings; a miss is recorded as a
// miss, not as a finding.
//
// Three classes, one table (RULES): `rm -r` of home, root or the project root; a download piped
// into a shell; a secret in a command (src/shared/secret-rule.mjs, the publish scan's rule).
//
// CLI (hooks/pre-tool-use.sh): the PreToolUse payload on stdin. On a hit it prints the documented
// hook answer `permissionDecision: "ask"` with the reason, so the operator decides; otherwise it
// prints nothing. It always exits 0: advice fails open.
//   node seatbelt.mjs            read the payload from stdin
//   node seatbelt.mjs --text     read a bare command from stdin; print `<id>\t<class>` per hit

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { containsCredentialToken, containsSecret } from "../../shared/secret-rule.mjs";

const MAX = 256 * 1024;   // a larger command is not read (advice, not a boundary)

/** Split a command line into simple commands (on ; & | newline and the && || pairs). */
export function segments(cmd) {
  return String(cmd).split(/\|\||&&|[;&|\n]/).map((s) => s.trim()).filter(Boolean);
}

/** Whitespace words, quotes removed. Enough for advice; not a shell parser. */
export function words(seg) {
  return (seg.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));
}

// Prefixes that run the next word as the command.
const RUNNERS = new Set(["sudo", "doas", "command", "builtin", "exec", "nice", "nohup", "time", "env", "xargs"]);

/** The words of an `rm` invocation in this segment, or null. */
function rmWords(seg) {
  const w = words(seg);
  let i = 0;
  while (i < w.length && (RUNNERS.has(w[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || (i > 0 && w[i].startsWith("-") && RUNNERS.has(w[i - 1])))) i++;
  return w[i] && /(^|\/)rm$/.test(w[i]) ? w.slice(i + 1) : null;
}

function recursive(args) {
  return args.some((a) => a === "--recursive" || a === "--no-preserve-root" || /^-[A-Za-z]*[rR]/.test(a));
}

/** Normalise an rm operand: strip trailing `/`, `/.`, `/*`; keep `/` itself. */
function norm(t) {
  let s = t;
  for (;;) {
    const n = s.replace(/\/\*$/, "").replace(/\/\.$/, "").replace(/(.)\/+$/, "$1");
    if (n === s) return s;
    s = n;
  }
}

/** True when an operand names home, root or the project root. */
export function wideTarget(t, ctx) {
  const n = norm(t);
  const home = ctx.home.replace(/\/+$/, "");
  const roots = new Set(["/", "/*", "~", "~/", "$HOME", "${HOME}", home, "*"]);
  if (roots.has(n) || roots.has(t)) return n !== "*" || ctx.cwd === ctx.root || ctx.cwd === home;
  if (ctx.root && (n === ctx.root || n === "." || n === "./" || n === "$PWD" || n === "${PWD}")) {
    return n === ctx.root || ctx.cwd === ctx.root;
  }
  return false;
}

const SHELL = "(?:ba|z|da|k|fi)?sh|python3?|perl|ruby|node";
const DL = "(?:curl|wget|fetch|aria2c)";

// The table. Each row: id, class, test(command, ctx) → boolean. At most 40 rows (§Component 2).
export const RULES = Object.freeze([
  { id: "RM_WIDE", class: "rm", why: "recursive rm of home, root or the project root",
    test: (c, ctx) => segments(c).some((s) => { const a = rmWords(s); return a && recursive(a) && a.filter((x) => !x.startsWith("-")).some((t) => wideTarget(t, ctx)); }) },
  { id: "PIPE_SHELL", class: "download", why: "a download piped into a shell",
    test: (c) => new RegExp(`\\b${DL}\\b[^|\\n]*\\|\\s*(?:sudo\\s+(?:-\\S+\\s+)*)?(?:\\S*/)?(?:${SHELL})\\b`).test(c) },
  { id: "SUBST_SHELL", class: "download", why: "a shell running a download's output",
    test: (c) => new RegExp(`\\b(?:${SHELL})\\b\\s+(?:-c\\s+)?["']?(?:<\\(|\\$\\()\\s*${DL}\\b`).test(c) },
  { id: "EVAL_DOWNLOAD", class: "download", why: "eval of a download",
    test: (c) => new RegExp(`\\beval\\s+["']?\\$\\(\\s*${DL}\\b`).test(c) },
  { id: "SECRET", class: "secret", why: "a secret in the command text",
    test: (c) => containsCredentialToken(c) || containsSecret(c) },
]);

/** The rows the command hits. */
export function check(cmd, ctx = {}) {
  const c = String(cmd ?? "");
  if (!c || c.length > MAX) return [];
  const home = ctx.home || homedir();
  const cwd = ctx.cwd || process.cwd();
  const full = { home, cwd, root: ctx.root ?? projectRoot(cwd) };
  return RULES.filter((r) => { try { return r.test(c, full); } catch { return false; } });
}

/** The nearest directory at or above `dir` holding `.git`, else `dir`. */
export function projectRoot(dir) {
  let d = resolve(dir);
  for (;;) {
    try { statSync(join(d, ".git")); return d; } catch { /* up */ }
    const up = dirname(d);
    if (up === d) return resolve(dir);
    d = up;
  }
}

/** The hook answer for a list of hits, or "" when there is none. */
export function answer(hits) {
  if (!hits.length) return "";
  const reason = `[SEATBELT] ${hits.map((h) => `${h.id}: ${h.why}`).join("; ")}. ` +
    "This is advice, not a security boundary (the role sandbox is): approve it if you mean it.";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } });
}

function main() {
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { return; }
  if (process.argv.includes("--text")) {
    for (const h of check(raw.replace(/\n$/, ""))) process.stdout.write(`${h.id}\t${h.class}\n`);
    return;
  }
  let p;
  try { p = JSON.parse(raw); } catch { return; }
  if (!p || p.tool_name !== "Bash" || typeof p.tool_input?.command !== "string") return;
  const out = answer(check(p.tool_input.command, { cwd: typeof p.cwd === "string" && p.cwd ? p.cwd : undefined }));
  if (out) process.stdout.write(out + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try { main(); } catch { /* advice fails open */ }
  process.exit(0);
}
