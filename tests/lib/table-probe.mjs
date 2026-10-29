#!/usr/bin/env node
// table-probe.mjs — the spawn path of one contract table, probed once (E-301, D-088,
// test-economics.md §Consolidation Map: "the spawn path is probed once per table — ONE blocking
// and ONE passing row through the real --check CLI"). The table's rows run in process in their
// unit runner; this proves the CLI glue (argv, the session's token, the exit code) agrees with
// them on two rows. Called only by safe_exec_test, the one bash suite that names a table path.
//
//   node table-probe.mjs <repo> <cases.json> <architect|engineer> <session id>
//
// Picks the first BLOCK row and the first pass row the session's role answers (a row's `role`,
// default architect for arch-write and engineer elsewhere; "none" counts as engineer: neither
// gets the sovereignty rules), with a plain `cmd`. Runs each as a direct child of
// tests/lib/as-session.sh <role> <sid>, as the hook does, and prints one line per row:
//   probe <want> <got> <label>
// Exits 1 when either verdict differs or the table has no such pair.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

const [, , repo, table, role, sid] = process.argv;
const rows = JSON.parse(readFileSync(table, "utf8"));
const fallback = basename(table).startsWith("arch-write") ? "architect" : "engineer";
const answers = (c) => (c.role || fallback) === role || (role === "engineer" && c.role === "none");
const usable = rows.filter((c) => answers(c) && typeof c.cmd === "string" && !c.cmd_from && !c.repeat);
const pick = ["BLOCK", "pass"].map((w) => usable.find((c) => c.want === w));

let failed = 0;
for (const [i, c] of pick.entries()) {
  if (!c) { process.stdout.write(`probe ${["BLOCK", "pass"][i]} MISSING no ${role} row\n`); failed = 1; continue; }
  let got;
  try {
    execFileSync("bash", [join(repo, "tests/lib/as-session.sh"), role, sid, "--",
      "node", "--no-warnings", join(repo, "src/mcp/safe-exec-mcp/index.js"), "--check", c.cmd, "--session", sid],
    { cwd: repo, stdio: "ignore", timeout: 20_000 });
    got = "pass";
  } catch (e) {
    got = e.status === 2 ? "BLOCK" : `exit${e.status}`;
  }
  if (got !== c.want) failed = 1;
  process.stdout.write(`probe ${c.want} ${got} ${c.label}\n`);
}
process.exit(failed);
