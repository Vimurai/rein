// E-300 (D-088 §Component 5): the one-off mutation probe, pass A — the node unit layer.
// Run through tests/tools/mutation/probe.sh, never directly and never from `ai ci run`.
// The tap runner treats each tests/unit/*.test.mjs FILE as one test, so killedBy in the
// JSON report names the test file that detected a mutant (per-test attribution).
import os from "node:os";
import path from "node:path";

const out = process.env.REIN_MUTATION_OUT || path.join(os.tmpdir(), "rein-mutation");

export default {
  testRunner: "tap",
  plugins: ["@stryker-mutator/tap-runner"],
  tap: { testFiles: ["tests/unit/*.test.mjs"] },
  coverageAnalysis: "perTest",
  mutate: [
    "src/shared/**/*.{js,mjs}",
    "src/mcp/shared/**/*.{js,mjs}",
    "src/mcp/safe-exec-mcp/**/*.{js,mjs}",
    "!**/node_modules/**",
  ],
  concurrency: Number(process.env.REIN_MUTATION_CONCURRENCY || 6),
  timeoutMS: 30000,
  disableBail: true,
  reporters: ["json", "progress-append-only"],
  jsonReporter: { fileName: path.join(out, "pass-a.json") },
  tempDirName: path.join(out, "sandbox"),
  cleanTempDir: "always",
  incremental: false,
};
