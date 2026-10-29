#!/usr/bin/env node
// arch-write-cases.mjs — E-216 case driver.
//
// WHY A NODE DRIVER RATHER THAN BASH CASES: these payloads depend on their own exact
// quoting (`awk 'BEGIN{print "x" > "src/x"}'`), and a bash test file consumed those
// quotes twice during development — turning `>` inside an awk program into a real shell
// redirection and making a genuine bypass look like a pass. Passing each command as a
// single argv element removes the shell from the loop entirely.
//
// Usage: node arch-write-cases.mjs <safe-exec path> <cases.json> [<role>=<sid>:<session pid> ...]
// Prints one `ok|FAIL <verdict> <command>` line per case; exits 1 on any mismatch.
//
// E-294 (D-087): the gate's role is the session token's, never AI_OS_CALLER_ROLE. Each case's
// role is answered by a REAL session of that role — the suite starts one per role
// (tests/lib/as-session.sh, a launch record + a token bound to that process) and passes its
// session id and pid here; the check runs with `--session <sid> --session-pid <pid>`, the same
// hot path the PreToolUse hook uses. A role with no session given runs with no token at all,
// i.e. in the union (the Architect rule set for everyone).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [, , safeExec, casesFile, ...sessionArgs] = process.argv;
const sessions = {};
for (const a of sessionArgs) {
  const m = /^(architect|engineer)=([^:]+):([0-9]+)$/.exec(a);
  if (!m) { process.stderr.write(`arch-write-cases: bad session arg '${a}'\n`); process.exit(2); }
  sessions[m[1]] = ["--session", m[2], "--session-pid", m[3]];
}
if (!safeExec || !casesFile) {
  process.stderr.write("usage: arch-write-cases.mjs <safe-exec.js> <cases.json>\n");
  process.exit(2);
}

const verdict = (cmd, role) => {
  try {
    execFileSync("node", ["--no-warnings", safeExec, "--check", cmd, ...(sessions[role] || [])], {
      stdio: "ignore",
      timeout: 20_000,
    });
    return "pass";
  } catch (e) {
    return e.status === 2 ? "BLOCK" : "pass";
  }
};

const cases = JSON.parse(readFileSync(casesFile, "utf8"));
let fails = 0;
for (const c of cases) {
  const role = c.role || "architect";
  const got = verdict(c.cmd, role);
  const ok = got === c.want;
  if (!ok) fails++;
  process.stdout.write(`${ok ? "ok" : "FAIL"}\t${got}\t${role}\t${c.label || c.cmd}\n`);
}
process.exit(fails === 0 ? 0 : 1);
