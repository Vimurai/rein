#!/usr/bin/env node
// secret-cases.mjs — E-287 case driver for SECRET_IN_COMMAND (tests/fixtures/secret-cases.json).
//
// Same design as arch-write-cases.mjs: each command reaches the REAL `--check` gate as a
// single argv element, so no shell consumes its quoting on the way. The pre-E-287 suite
// asserted a pasted copy of the regex, which kept passing whatever index.js did.
//
// Also prints the over-block ratio (ALLOW cases the gate blocked) on every run, per the
// blueprint contract, and times the rule on a large prose heredoc against the 100 ms budget.
//
// Usage: node secret-cases.mjs <safe-exec index.js> <secret-rule.mjs> <cases.json> [<session id>]
// Exits 1 on any mismatch or a blown budget.
//
// E-294 (D-087): the gate's role is the session token's, never an env var. The cases are
// Engineer cases, so the suite runs this driver under `tests/lib/as-session.sh none <sid>`
// (the plain-launch default: engineer) and passes the same <sid>; without one, every case
// runs in the union and the Architect write rules would answer instead of the secret rule.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [, , safeExec, ruleModule, casesFile, sessionId = ""] = process.argv;
if (!safeExec || !ruleModule || !casesFile) {
  process.stderr.write("usage: secret-cases.mjs <safe-exec.js> <secret-rule.mjs> <cases.json>\n");
  process.exit(2);
}

const verdict = (cmd) => {
  try {
    execFileSync("node", ["--no-warnings", safeExec, "--check", cmd, ...(sessionId ? ["--session", sessionId] : [])], {
      stdio: "ignore",
      timeout: 20_000,
    });
    return "pass";
  } catch (e) {
    return e.status === 2 ? "BLOCK" : "pass";
  }
};

// E-292 (D-084 r2): a case may name its command by reference — `"cmd_from": {"file":
// "plans/…md", "block": N}` = the Nth ``` fenced block of that file (repo-relative). The
// verbatim over-block commands live ONCE, in the Architect's plan file; copying them here put
// their prose (which names a retired provider) under the D-076 legacy-mention grep. A missing
// file or block is a FAIL, never a skip.
const repoRoot = resolve(dirname(casesFile), "..", "..");
const fenced = (file, n) => {
  const blocks = [...readFileSync(resolve(repoRoot, file), "utf8").matchAll(/```\n([\s\S]*?)\n```/g)];
  if (!blocks[n - 1]) throw new Error(`${file} has no fenced block ${n}`);
  return blocks[n - 1][1];
};

const cases = JSON.parse(readFileSync(casesFile, "utf8"));
let fails = 0, allowN = 0, overBlocked = 0, blockN = 0, missed = 0;
for (const c of cases) {
  let cmd = c.cmd;
  if (c.cmd_from) {
    try { cmd = fenced(c.cmd_from.file, c.cmd_from.block); }
    catch (e) { fails++; process.stdout.write(`FAIL\tmissing\t${c.label} (${e.message})\n`); continue; }
  }
  const got = verdict(cmd);
  const ok = got === c.want;
  if (!ok) fails++;
  if (c.want === "pass") { allowN++; if (got === "BLOCK") overBlocked++; }
  else { blockN++; if (got !== "BLOCK") missed++; }
  process.stdout.write(`${ok ? "ok" : "FAIL"}\t${got}\t${c.label}\n`);
}
process.stdout.write(
  `OVER_BLOCK_RATIO ${overBlocked}/${allowN}  MISS_RATIO ${missed}/${blockN}  CASES ${cases.length}\n`
);

// Budget: 80 KB of prose that brushes every keyword, plus an over-limit input that must
// fail closed without being scanned.
const { containsSecret, SCAN_LIMIT } = await import(pathToFileURL(ruleModule).href);
const big = "token usage secret santa password policy a_ api-key docs ".repeat(1400);
const t0 = process.hrtime.bigint();
const bigHit = containsSecret(big);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
process.stdout.write(`BUDGET ${ms.toFixed(1)}ms for ${big.length} chars (limit 100ms), hit=${bigHit}\n`);
if (ms >= 100 || bigHit) fails++;
if (containsSecret("x".repeat(SCAN_LIMIT + 1)) !== true) {
  process.stdout.write("FAIL\tover-limit input must fail closed\n");
  fails++;
}
process.exit(fails === 0 ? 0 : 1);
