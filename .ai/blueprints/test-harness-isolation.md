# Test Harness Isolation Blueprint

## Goal & Architecture
Ensures that the E2E test harness (`tests/run.sh`) no longer pollutes the git working tree by leaving `.mcp.json` modified. This isolates test configuration from production configuration.

## Core Concept
Use a dedicated configuration file (`.mcp.test.json`) for the test harness and point the tests to it, completely ignoring the production `.mcp.json`.

## Components
1. **Test Config Generator**: A script or setup step in `run.sh` that dynamically generates `.mcp.test.json` based on the current `.mcp.json` but with sandbox paths.
2. **Environment Overrides**: Modifying the test invocation environment to use `MCP_CONFIG_PATH=.mcp.test.json`.
3. **Cleanup Trap**: A bash trap that ensures the temporary test config is deleted and any temporary directories are removed upon test exit.

## Data Model
`mcp_config.json` schema remains identical, just saved to a separate ephemeral path during testing.

## API / Interface Contracts
- Environment variable `MCP_CONFIG_PATH` is respected by all MCP loaders.

## Security
No security impact. Test isolation prevents accidental production mutations.

## Execution Constraints
The teardown trap must execute regardless of whether the test exits successfully, fails, or is interrupted (SIGINT/SIGTERM).

## Rollback Plan
Revert the test harness changes to point back to the hardcoded `.mcp.json` modification logic if dynamic test config fails.

## E-## Task Breakdown
- **E-156**: Implement `.mcp.test.json` generation and isolated config loading in `tests/run.sh`.
- **E-157**: Add robust bash trap cleanup logic to remove test artifacts.

## Environment Dependence (D-061 §4, 2026-09-09)
Three tests in the D-059/D-060 sprint passed on a developer Mac and failed on CI: a mirror byte-identity check, an unpruned `node_modules` corpus scan, and an assertion that assumed an ambient tmux server. Rule: every assertion must state what it requires of the machine, and a requirement that is genuinely optional is expressed with `skip_unless_cmd` / `skip_unless_env` (a recorded SKIP, never a fabricated PASS or FAIL). The `rein-review` skill and the `critic_tests` agent ask the standing question "does this assertion depend on what the running machine happens to have?" on every test diff. → E-236.

## Performance Budgets Are Host-Relative (D-062 §2, 2026-09-09)
Absolute wall-clock budgets ("under 200ms") are true only on the reference machine: a bare `node` spawn alone costs ~197ms on some developer hosts while CI passes. Rule: every performance assertion names a same-host baseline measured in the same run; the absolute budget is enforced only when `CI=true`; elsewhere the assertion is `elapsed ≤ k × baseline + slack` (defaults k=2, slack=50ms, declared beside the budget); baseline and elapsed are printed every run so a failure carries its evidence; an absolute budget without a baseline is a `critic_tests` finding. This is the environment-dependence rule (§ above) extended from "what the machine has" to "how fast it is". Rollback `REIN_PERF_ABSOLUTE=1`.

## Leaked External State — the Third Environment Dependence (D-063 §2, 2026-09-09)
Three varieties now stand together: **what the machine has** (E-236: supply or skip), **how fast it is** (E-239: host-relative budgets whose baseline includes the assertion's own instrument — D-063 §1), and **what a previous run left behind** (this section). The `rein start` suites leaked 50 tmux servers on one machine because the socket name used `$$` and a FAILING assertion skipped the cleanup line — leaks happened only when something was already wrong. Rules: (1) register cleanup in an `EXIT` trap BEFORE creating external state; names from `mktemp` entropy, never `$$`; (2) `tests/run.sh` snapshots and diffs the known external-state kinds (test-prefixed tmux servers, sandbox-named processes, `.ai/` lock dirs, harness temp dirs), reports `LEAKED n <kind>` per suite, fails the run on CI, offers `--sweep` locally; it matches only by test prefix or sandbox name, never by age or count; (3) standing review question #3 in `critic_tests`/`rein-review`: "what does this test leave behind when an assertion fails halfway?". → E-240. Rollback `REIN_TEST_NO_SWEEP=1`.

## Trap Chaining (D-064 §1, 2026-09-10)
A suite that installs `trap … EXIT` after sourcing `assert.sh` replaced the `register_cleanup` handler, so 46 suites self-cleaned only through the runner sweep. Rule: `assert.sh` shadows `trap` for `EXIT` only — the command is appended to the cleanup registry, never replaces it; other signals and argument shapes go to `builtin trap`; handlers run LIFO, each in its own subshell; `CLEANUP n handlers` is printed on exit. `on_exit <cmd>` is the documented spelling; a raw `trap … EXIT` in `tests/**` is an E-80 P1 finding; the existing sites are converted mechanically. The sweep remains the backstop and `LEAKED 0` on the full run is the acceptance evidence. → E-241. Rollback `REIN_TEST_NO_TRAP_CHAIN=1`.

## The Scan That Never Ran — Variety #5 (D-067 §5, 2026-09-10)
Three rule-scanning suites built their corpus with `find` over roots that E-244 stopped provisioning; `find` exited non-zero, the corpus came back EMPTY, and the suites would have reported "no violations" indefinitely — only their own file-count assertions caught it. Rule: a scan-based suite builds its corpus with `corpus_or_fail <min> <root>…`, which fails when a root is missing or the count is below the minimum and prints the count every run. Standing review question #5 (`critic_tests`, `rein-review`): "can this scan return an empty set and still pass?". → E-251.

## The Sixth Variety: the Instrument Recorded the Test (D-070, 2026-09-11)
The five varieties above are all "the test measured something else". The sixth is the inverse:
**the production instrument measured the tests.** Every MCP call the bash suite makes is
telemetered by the global interceptor (E-153) into the operator's `~/.rein/telemetry.sqlite`,
because E-159 isolation redirected `.ai/` but never the telemetry path. On 2026-09-11 the
meta_analyst found 47,391 of 51,382 in-window rows on four test-run days, 4,864 single-use
`project_hash` values (temp-dir fixtures), 1,659 of 1,729 `task_velocity` rows carrying fixture
ids `E-1`/`E-2`/`E-3`, and `patch_file`'s "56% error rate" resting on 1,920 fixture calls and
zero live ones. Two `rein-insights` reports (2026-08-04, 2026-09-10) had read fixtures as operator
behaviour and recommended skills for them.

Rules (E-257):
- A test run sets `AI_TELEMETRY_DB_PATH` to a per-run temp file (or `AI_TELEMETRY_DISABLE=1`)
  in `tests/lib/` BEFORE any server or hook is spawned; the interceptor honours it.
- The harness treats the live telemetry DB as **leaked external state** (E-240 lineage): the
  run records its row count at start and FAILS if it grew. Print both numbers.
- The store the operator has now is reset once, with a dated backup, by an explicit command —
  no silent purge, no heuristic row tagging; 8% real traffic mixed with 92% fixtures is not
  worth a migration.
- Standing review question #6 for `critic_tests` / `rein-review`: "does this test write to any
  path under `~/.rein/` other than a per-run temp path?"

## Inherited Launch Variables — Environment Dependence, Shape #4 (D-071 §4, 2026-09-13)
Three consecutive tasks lost assertions to variables the suite INHERITED from the tmux pane it
ran in, each time failing in the direction that looks like a product bug. `rein pane <role>`
exports `REIN_PANE_ROLE`, which `hooks/pre-commit.sh` ranks above `REIN_CALLER_ROLE` and
`hooks/session-start.sh` above its positional argument — deliberately and correctly, that IS
the D-054 per-pane binding — so `git_lane_test` run from a bound pane lost its entire Architect
lane (22 failures) and `role_token_test` minted the wrong token while its own "a token was
minted" assertion still passed (E-248). The Rein shell exports `REIN_WORKSPACE`, which
`isFrameworkClone()` consults before the `package.json` fallback, so every E-249 gate fixture
read as "not the framework clone" and the gate never fired. This is variety #1 ("what the
machine has") in a new shape: what the machine has is an EXPORTED VARIABLE that outranks the
test's own inputs, and the remedy is neither supply nor skip but **strip**.

Rules (E-264):
- `tests/lib` holds a named list, `LAUNCH_VARS` (`REIN_PANE_ROLE`, `REIN_WORKSPACE`, and every
  other variable `rein pane`, `rein start` or the Rein shell exports that a hook or resolver ranks
  above its own inputs), and unsets every entry ONCE, centrally, before any suite, hook,
  resolver or server is spawned.
- A suite that needs a launch variable sets it explicitly in its own environment. The
  per-suite `env -u` sites (`role_token_test`, `git_lane_test`, `booted_build_test`) are
  retired — a rule rediscovered per suite is folklore, not a rule — each keeping one explicit
  non-vacuity assertion that the variable is absent when its hook runs.
- No dead entries: a test asserts every `LAUNCH_VARS` entry is referenced by `hooks/` or `src/`.
  A hook or resolver that starts ranking a new launch variable adds it to the list in the
  same change.
- The hooks are NOT taught to ignore launch variables under a test flag — that would test a
  path production never takes (E-244's "filter the roots" mistake in a new place).
- Standing review question #7 (`critic_tests`, `rein-review`): "does this test drive a hook or
  resolver that ranks an inherited launch variable above the test's own inputs — and is that
  variable stripped?"
- Rollback `REIN_TEST_KEEP_LAUNCH_ENV=1` skips the strip.

## The Fixture HOME Without a Toolchain Record — Environment Dependence, Shape #5 (D-109 §1, 2026-10-24)
- A hook under a fixture HOME finds its interpreters through `<home>/.rein/shared/toolchain.sh`
  (D-078 pin), else a fixed fallback dir list. A fixture HOME without the record makes the
  test depend on where THIS host keeps node: green with `/usr/local/bin/node`, red with node
  only in Linuxbrew (12 suites, 105 assertions, 2026-10-23).
- One helper creates every such HOME: `tc_fixture_home <home>` (`tests/lib/toolchain-fixture.sh`)
  and `tcFixtureHome(home)` (`toolchain-fixture.mjs`), recording the host's resolved node,
  python3 and git through the installer's own `rein_tc_write`. The fallback list is never
  extended for a host (D-109 alt. 1).
- The harness preflight census fails the run when a suite exports a temp HOME and then runs
  `hooks/`, `ai ` or a pin loader without that record; exemptions carry a reason (E-345).
- Host-independence proof: the affected suites pass with the pin's fallback list emptied
  (`tc_stale_tree`), the only honest "node outside the list" on a host that has node in it.
- Standing review question #8 (`critic_tests`): "does this test run a hook or `rein` under a
  HOME it created — and did `tc_fixture_home` write that HOME's toolchain record?"
