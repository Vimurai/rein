# tests/tools — measurement tools for the test suite (D-088)

Tools that measure the suite rather than test the product. None of them runs as part of
`rein ci run`.

| Tool | Task | What it answers |
|---|---|---|
| `census.mjs` | E-297 | Per suite: assertions, task-label density, wall time, footprint. `node tests/tools/census.mjs` |
| `select-suites.mjs` | E-298 | Which suites `tests/run.sh --tier fast` / `--changed <ref>` runs |
| `sandbox-probe.sh` | E-458 | What Claude Code's Bash sandbox and path rules hold on this machine (M1..M10), by real `claude -p` sessions. `bash tests/tools/sandbox-probe.sh` |

`managed_agents_spike.js` (E-47) is not a measurement tool: it is the offline Managed Agents
feasibility spike, kept here as a fixture program that `tests/suites/managed_agents_test.sh` runs
(moved from `tests/` by E-302).
