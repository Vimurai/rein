// gate-relative-home-cases.test.mjs — GATE_SELF_DISABLE for the install root named relative to
// HOME after entering it (E-294, critic_security P1-2; T-ROLE-001: launch records and role tokens
// live there). In process (E-301, D-088); replaces safe_exec_test's E-294.RH1 spawn-driver run.
// The cwd-dependent forms (a cd .. chain that lands on HOME) need a known HOME AND cwd, so they
// stay in gate-guard-home.test.mjs; these rows are host-independent.
import { gateInProcess, tableTests } from "../lib/check-table.mjs";

const { runAnalysis } = await gateInProcess();
tableTests(runAnalysis, "gate-relative-home");
