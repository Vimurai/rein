#!/usr/bin/env node
// inproc-tables.mjs — E-300 pass B, fast path: the gate's four contract tables answered by ONE
// process. The spawn drivers (tests/lib/secret-cases.mjs, arch-write-cases.mjs) start one
// `node index.js --check` per case (~220 spawns, ~2 min per mutant); this imports the
// (mutated) gate once and asks runAnalysis directly, with --check's own semantics:
//   role    = the verified token's (verifyToken, hot path when a session pid is given), else the
//             union stand-in ARCHITECT;
//   verdict = BLOCK when runAnalysis says BLOCK or THROWS (the CLI fails closed, exit 2).
// It cannot judge the CLI glue itself (_gateFlags, gateRole, the --check block): gate-pass.mjs
// sends mutants on those lines down the spawn path (gate-tables.sh).
//
// Needs the sandbox index.js to end with `export { runAnalysis as __probeRunAnalysis };`
// (gate-pass.mjs appends it to its sandbox copy only). Run under tests/lib/as-session.sh none
// <engineer sid> — the secret tables are Engineer cases verified by ancestry, as in the suite.
//
// Usage: node inproc-tables.mjs <index.js> <repo> <engineer sid> architect=<sid>:<pid> engineer=<sid>:<pid> [--all]
// Prints "<table> PASS|FAIL" per table; exits 1 when any failed.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [, , indexJs, repo, engSid, ...rest] = process.argv;
const all = rest.includes("--all");
const sessions = {};
for (const a of rest) {
  const m = /^(architect|engineer)=([^:]+):([0-9]+)$/.exec(a);
  if (m) sessions[m[1]] = { sid: m[2], pid: m[3] };
}

const dir = dirname(indexJs);
const { __probeRunAnalysis: runAnalysis } = await import(pathToFileURL(indexJs).href);
const { verifyToken, ARCHITECT } = await import(pathToFileURL(join(dir, "role-token.mjs")).href);
const { containsSecret, SCAN_LIMIT } = await import(pathToFileURL(join(dir, "secret-rule.mjs")).href);

const verdict = (cmd, sid, sessionPid = null) => {
  try {
    const role = (sid ? verifyToken(sid, { sessionPid }) : null) || ARCHITECT;
    return runAnalysis(cmd, role, { override: false }).verdict === "BLOCK" ? "BLOCK" : "pass";
  } catch {
    return "BLOCK";
  }
};

const fenced = (file, n) => {
  const blocks = [...readFileSync(resolve(repo, file), "utf8").matchAll(/```\n([\s\S]*?)\n```/g)];
  if (!blocks[n - 1]) throw new Error(`${file} has no fenced block ${n}`);
  return blocks[n - 1][1];
};
const load = (name) => JSON.parse(readFileSync(join(repo, "tests/fixtures", `${name}-cases.json`), "utf8"));

const secretTable = (name) => {
  for (const c of load(name)) {
    let cmd = c.cmd;
    if (c.cmd_from) { try { cmd = fenced(c.cmd_from.file, c.cmd_from.block); } catch { return false; } }
    if (verdict(cmd, engSid) !== c.want) return false;
  }
  if (name !== "secret") return true;
  // secret-cases.mjs's two rule checks: the 100 ms budget on 80 KB of prose, and fail-closed
  // above SCAN_LIMIT.
  const big = "token usage secret santa password policy a_ api-key docs ".repeat(1400);
  const t0 = process.hrtime.bigint();
  const hit = containsSecret(big);
  if (Number(process.hrtime.bigint() - t0) / 1e6 >= 100 || hit) return false;
  return containsSecret("x".repeat(SCAN_LIMIT + 1)) === true;
};

const archTable = () => {
  for (const c of load("arch-write")) {
    const s = sessions[c.role || "architect"];
    if (verdict(c.cmd, s ? s.sid : "", s ? s.pid : null) !== c.want) return false;
  }
  return true;
};

let failed = 0;
for (const t of ["secret", "pipe-shell", "gate-relative-home", "arch-write"]) {
  const ok = t === "arch-write" ? archTable() : secretTable(t);
  process.stdout.write(`${t} ${ok ? "PASS" : "FAIL"}\n`);
  if (!ok) { failed = 1; if (!all) break; }
}
process.exit(failed);
