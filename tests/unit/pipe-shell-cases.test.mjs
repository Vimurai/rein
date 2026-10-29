// pipe-shell-cases.test.mjs — the heredoc lexer and the remote-pipe rules (E-291, D-083,
// D-111 r4): an INERT heredoc body (quoted delimiter, cat/tee sink, no pipe) is text; a real
// pipe into a shell blocks. In process (E-301, D-088); replaces safe_exec_test's E-291.PS1
// spawn-driver run. Rows run as a verified Engineer, as the driver did.
import { gateInProcess, tableTests } from "../lib/check-table.mjs";

const { runAnalysis } = await gateInProcess();
tableTests(runAnalysis, "pipe-shell");
