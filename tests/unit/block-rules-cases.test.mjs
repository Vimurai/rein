// block-rules-cases.test.mjs — the role-independent BLOCK_RULES (RM_RF_ROOT, the remote-pipe rules,
// DROP_TABLE, FORK_BOMB, …) and the WARN rule SUDO_SU as one contract table, in process (E-301,
// D-088, test-economics.md §Consolidation Map). Replaces safe_exec_test's test_pattern rows, which
// asserted an inlined COPY of each regex, and its E-125 / SUDO_SU rows through the advisory tool.
// Not byte-pinned: RM_RF_ROOT moves again with the E-350 residuals (D-112 r3).
import { gateInProcess, tableTests } from "../lib/check-table.mjs";

const { runAnalysis } = await gateInProcess();
tableTests(runAnalysis, "block-rules");
