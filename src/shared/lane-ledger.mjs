#!/usr/bin/env node
// lane-ledger.mjs — an Architect commit may change only .ai/ and plans/, whatever git spelling
// made it (E-462, gap 2 of E-458; lean-core.md §Security "The Architect does not push").
//
// WHY A LEDGER: the Architect's sandbox must leave .git writable so `git commit` works, and then
// `git hash-object -w` + `update-index --cacheinfo` + `commit` (or `commit-tree` + `update-ref`,
// which skips every hook) records a src/ change without writing src/. A pre-commit check cannot
// hold against that, and a commit carries nothing the Architect cannot forge (author, trailer,
// env). What the Architect cannot do is write <git common dir>/rein/: its role settings
// write-deny that directory (role-settings.mjs) while the Engineer's sandbox and the operator's
// terminal can write it. So the post-commit hook records every commit made OUTSIDE the
// Architect's lane here, and the pre-push hook refuses a pushed commit that changes a path
// outside .ai/ and plans/ unless the ledger names it. The Architect has no network domain, so
// every push goes through a lane where this hook runs.
//
// Index poisoning: the Architect can stage content in .git/index for the Engineer's next commit.
// `record` therefore refuses to record a commit whose out-of-lane paths differ from the working
// tree — which the Architect cannot write outside its lane.
//
// Usage (all exit 0 unless stated):
//   node lane-ledger.mjs seed   --root <repo>   create the ledger; trust the unpushed history
//   node lane-ledger.mjs record --root <repo>   post-commit: record HEAD (silent where read-only)
//   node lane-ledger.mjs trust  --root <repo> <sha>   record one commit by hand (exit 1 if read-only)
//   node lane-ledger.mjs check  --root <repo>   pre-push: refs on stdin; exit 1 [ARCH_LANE_COMMIT]

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerDir } from "./role-settings.mjs";

const ZERO = /^0+$/;
export const LANE_PREFIXES = [".ai/", "plans/"];

export function isLanePath(p) {
  return LANE_PREFIXES.some((pre) => p.startsWith(pre));
}

function git(root, args, input) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 << 20 });
}

export function ledgerFile(root) {
  return join(ledgerDir(root), "commits");
}

function readLedger(root) {
  try {
    return new Set(readFileSync(ledgerFile(root), "utf8").split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{40,64}$/.test(l)));
  } catch { return new Set(); }
}

/** Paths a commit changes. A merge lists only what differs from every parent (--cc). */
export function changedPaths(root, sha) {
  const parents = git(root, ["rev-list", "--parents", "-n", "1", sha]).trim().split(/\s+/).slice(1);
  const args = parents.length > 1
    ? ["diff-tree", "--cc", "--no-commit-id", "--name-only", "-z", sha]
    : ["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", "--no-renames", "-z", sha];
  return git(root, args).split("\0").filter(Boolean);
}

export function outOfLane(root, sha) {
  return changedPaths(root, sha).filter((p) => !isLanePath(p));
}

export function seed(root) {
  mkdirSync(ledgerDir(root), { recursive: true });
  const f = ledgerFile(root);
  if (existsSync(f)) return { seeded: false, file: f };
  let shas = "";
  try { shas = git(root, ["rev-list", "--branches", "--not", "--remotes"]); } catch { shas = ""; }
  writeFileSync(f, `# lane ledger — commits made outside the Architect's lane (E-462); seeded ${new Date().toISOString()}\n${shas}`);
  return { seeded: true, file: f, count: shas.split("\n").filter(Boolean).length };
}

/** post-commit. Returns a reason string when HEAD is not recorded, "" when it is or need not be. */
export function record(root, sha = "HEAD") {
  if (!existsSync(ledgerDir(root))) return "";            // no sandboxed Architect has run here
  const full = git(root, ["rev-parse", "--verify", `${sha}^{commit}`]).trim();
  const outside = outOfLane(root, full);
  if (outside.length === 0) return "";                    // a lane-only commit needs no entry
  // The committed content outside the lane must be what the working tree holds; content only
  // the index held could have been staged by the Architect.
  try {
    git(root, ["diff", "--quiet", full, "--", ...outside]);
  } catch {
    return `${full.slice(0, 7)} not recorded: what it commits outside .ai/ and plans/ differs from the working tree (staged by another session?) — check it, then: node ~/.rein/shared/lane-ledger.mjs trust ${full.slice(0, 7)}`;
  }
  appendFileSync(ledgerFile(root), full + "\n");
  return "";
}

export function trust(root, sha) {
  mkdirSync(ledgerDir(root), { recursive: true });
  const full = git(root, ["rev-parse", "--verify", `${sha}^{commit}`]).trim();
  appendFileSync(ledgerFile(root), full + "\n");
  return full;
}

/** pre-push. `refs` is git's stdin. Returns the refusal lines (empty: allowed). */
export function check(root, refs) {
  if (!existsSync(ledgerDir(root))) return { refused: [], note: "[LANE_CHECK] no lane ledger here (no sandboxed Architect has run): not checked" };
  const ledger = readLedger(root);
  const refused = [];
  for (const line of refs.split("\n")) {
    const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localRef || !localSha || ZERO.test(localSha)) continue;
    const args = ["rev-list", localSha, "--not", "--remotes"];
    if (remoteSha && !ZERO.test(remoteSha)) {
      try { git(root, ["cat-file", "-e", `${remoteSha}^{commit}`]); args.push(remoteSha); } catch { /* unknown here */ }
    }
    for (const c of git(root, args).split("\n").filter(Boolean)) {
      if (ledger.has(c)) continue;
      const outside = outOfLane(root, c);
      if (outside.length === 0) continue;
      const subject = git(root, ["log", "-1", "--format=%s", c]).trim();
      const shown = outside.slice(0, 3).join(", ") + (outside.length > 3 ? ` (+${outside.length - 3})` : "");
      refused.push(`[ARCH_LANE_COMMIT] ${c.slice(0, 7)} "${subject}" changes ${shown} but was not committed in the Engineer's lane — refused. An Architect commit may change only .ai/ and plans/. If you made it: node ~/.rein/shared/lane-ledger.mjs trust ${c.slice(0, 7)}`);
    }
  }
  return { refused, note: "" };
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
  const root = arg(rest, "--root") || process.cwd();
  try {
    if (cmd === "seed") {
      const r = seed(root);
      if (r.seeded) process.stdout.write(`lane ledger created: ${r.file} (${r.count} unpushed commits trusted)\n`);
    } else if (cmd === "record") {
      try {
        const why = record(root);
        if (why) process.stderr.write(`[LANE_LEDGER] ${why}\n`);
      } catch (e) {
        // EROFS/EACCES: the Architect's lane, where the ledger is read-only by design.
        if (!["EROFS", "EACCES", "EPERM"].includes(e.code)) process.stderr.write(`[LANE_LEDGER] not recorded: ${e.code || e.message}\n`);
      }
    } else if (cmd === "trust") {
      const sha = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--root")[0];
      if (!sha) { process.stderr.write("usage: lane-ledger.mjs trust --root <repo> <sha>\n"); process.exit(2); }
      process.stdout.write(`trusted ${trust(root, sha)}\n`);
    } else if (cmd === "check") {
      const { refused, note } = check(root, readFileSync(0, "utf8"));
      if (note) process.stderr.write(note + "\n");
      for (const l of refused) process.stderr.write(l + "\n");
      process.exit(refused.length ? 1 : 0);
    } else {
      process.stderr.write("usage: lane-ledger.mjs seed|record|trust|check --root <repo>\n");
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`[LANE_LEDGER] ${cmd}: ${e.code === "EROFS" || e.code === "EACCES" ? "the ledger is read-only in this lane" : (e.stderr || e.message || e).toString().trim()}\n`);
    process.exit(cmd === "check" ? 1 : (cmd === "trust" ? 1 : 0));
  }
}
