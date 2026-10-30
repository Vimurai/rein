# Blueprint: Sovereignty Hardening

## Goal & Architecture
**Goal**: Enforce Role-Based Access Control (RBAC) to prevent the Architect (Agy) from executing destructive git operations and improperly mutating completed task states.
**Architecture**: Transition role boundaries from "honor-system" documentation to "fail-closed" MCP validation and state-locks.

## Core Concept
The Triad (Architect, Engineer, Tester) requires sovereign boundaries. Sovereignty Hardening move these boundaries from instruction-level guidelines to tool-level enforcement.

## Components
1. **Role-Aware `safe-exec-mcp`**
   - Responsibility: Extend `analyze_command` to accept a `caller_role`. Block dangerous implementation git commands (`reset`, `revert`, `checkout` of source files) if the role is `architect`.
2. **Immutability Lock in `task-synchronizer-mcp`**
   - Responsibility: Prevent `update_task_status` on `DONE` tasks unless an explicit `reopen: true` flag is provided. This prevents accidental mutation of completed implementation history.
3. **Audit Stamp Enforcement**
   - Responsibility: Update `rein-log` and pre-commit hooks to audit Architect shell commands for sovereignty violations.

## Data Model
- `ForbiddenArchitectGit`: `['reset', 'revert', 'checkout', 'clean', 'merge', 'rebase', 'push', 'pull', 'branch']` when used with implementation targets (outside `.ai/`, `plans/`). Merges, pulls, and pushes are globally blocked for the Architect.
- `ForbiddenArchitectOps`: `['rm -rf', 'mkdir', 'touch', 'ssh', 'rsync', 'scp', 'npm publish', 'docker push']` when used outside `.ai/`, `plans/`. Deployments are strictly Engineer territory.
- `TaskLock`: `DONE` status tasks require `reopen: true` for any further status mutation.

## API / Interface Contracts
- **`safe-exec-mcp::analyze_command(command, caller_role)`**
  - If `caller_role === 'architect'`, check `command` against `ForbiddenArchitectGit` and `ForbiddenArchitectOps`.
  - Verdict: `BLOCK` with tag `[SOVEREIGNTY_BLOCK]`.
- **`task-synchronizer-mcp::update_task_status(id, status, reopen: boolean)`**
  - If `current_status === 'DONE'` and `reopen !== true`, return `isError: true` with message `[TASK_LOCKED]`.

## Security
- **Trust Boundary**: The `caller_role` is the primary selector. While currently self-reported by the agent, future iterations will have this injected by the Rein bootloader to prevent impersonation.
- **Rollback**: Set `REIN_SOVEREIGNTY_LOCK=0` to bypass the `DONE` task lock.

## Execution Constraints
- Lock logic must be transactionally safe (SQLite-first).
- Shell filtering must use regex to ensure sub-100ms analysis.

## Rollback Plan
- Revert `src/mcp/task-synchronizer-mcp/index.js` to pre-lock logic.
- Remove `caller_role` dependency from `safe-exec-mcp`.

## E-## Task Breakdown
- **E-101**: Implement the `DONE` task mutation lock in `task-synchronizer-mcp` with `reopen: true` override.
- **E-102**: Implement `caller_role` support and Architect-specific blocks in `safe-exec-mcp`.
- **E-103**: Update `GEMINI.md` and `.ai/RULES.md` to explicitly list forbidden git commands for the Architect.

## Hook Toolchain Pinning (D-078, 2026-09-29 — E-286, THREAT_MODEL T-HOOKENV-001)

### Goal & Core Concept
A gate is only as trustworthy as the interpreter that runs it. The hooks call `node`,
`python3` and `nice` by bare name, and a project's `.claude/settings.json` `env` can set
`PATH`. **The installer decides which interpreters the hooks use; the environment of the
visited project does not.**

### Components
1. **Recorder — `install-rein.sh`**: resolves `node`, `python3` and `nice` once, at install
   time, from the operator's own shell, checks the realpath and every ancestor (owner root
   or self, no o+w, no g+w unless the group is wheel/admin), refuses in-project paths, and
   writes the absolute `realpath`s to `~/.rein/shared/toolchain.sh` atomically as plain
   assignments (mode 0644, owner-only write).
2. **Pin — `src/shared/toolchain-pin.sh` (logic, shipped) + `toolchain.sh` (data,
   recorded)**, run as the prologue of every hook (`pre-tool-use`, `post-tool-use`,
   `post-tool-log`, `session-start`, `stop-hook`, and the git hooks' canonical scripts)
   before the E-223 locator bootstrap and before any external command. The data file is
   PARSED against a strict pattern, never sourced (as built in E-286, ratified D-082).
   `node` and `python3` become shell functions over the recorded absolute paths
   (`python3 -I` everywhere); `nice`'s target is absolute. The prologue ASSIGNS `PATH` to
   `<dir of node>:<dir of python3>:/usr/bin:/bin:/usr/sbin:/sbin` and drops inherited
   functions and NODE_*/PYTHON*/DYLD_*/LD_*/BASH_ENV/ENV/CDPATH/GLOBIGNORE/REIN_TC_*
   (best-effort until Component 5). Tests pin through `tests/lib/toolchain-fixture.sh`; the
   `PATH=stub:$PATH` idiom was the attack channel and is banned in new tests.
3. **Fallback**: toolchain file missing, or a recorded interpreter no longer executable
   (nvm/brew upgrade) → `PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin`,
   never the inherited `PATH`. A fail-closed gate that then finds no `node` **or no
   `python3`** (D-081 ruling 3: the payload parser is `python3 -I`; no parser, no verdict)
   blocks with `[TOOLCHAIN_STALE] <interpreter> missing — run: bash install-rein.sh`;
   fail-open hooks skip silently. **Repair exemption (D-081 ruling 4, D-082 ruling 3)**: the
   literal `bash install-rein.sh`, run from the project root with no other arguments,
   passes the stale branch and E-289's unavailable branch. The predicate is three lines and
   lives INLINE in `pre-tool-use.sh`, nowhere else: a hatch that depends on the mirror is not
   a hatch. Nothing else is exempt.
4. **Reporter — `rein doctor`**: `✓ hook toolchain: node <ver> · python3 <ver>` or
   `✗ hook toolchain: <path> missing — run: bash install-rein.sh`.
5. **Exec-form hooks under privileged bash (D-081 ruling 1, D-083 rulings 1–4 — E-290)**:
   every generated hook entry is the documented EXEC form —
   `{"type":"command","command":"/bin/bash","args":["-p","<absolute hook path>"],"timeout":30}`
   — because a shell-form line runs through `sh -c`, which honours `SHELLOPTS`/`PS4` BEFORE
   `/bin/bash -p` starts (probed). Exec form has no shell; `-p` then ignores `BASH_ENV`/`ENV`,
   imports no functions and ignores `SHELLOPTS`/`BASHOPTS`. `args` carries the install-time
   ABSOLUTE path, so `$HOME` is gone from the hook lines and the HOME channel is closed by
   construction; consequently `.claude/settings.json` is generated-and-gitignored in every
   Rein project (the `.gemini/settings.json` precedent, E-233 mechanism), regenerated by
   `rein sync`, reported by `rein doctor`, and generated inside fixtures by `rein ci run` and the
   tests; the role overlays stay tracked. The settings writer REMOVES every Rein-owned
   entry for the five hooks in any older form before writing (user entries untouched).
   Git stubs: `#!/bin/bash -p`, `exec /bin/bash -p "$CANONICAL"`, chained user hooks via
   `/bin/bash -p`; the prologue also unsets `POSIXLY_CORRECT` and `BASH_COMPAT`. The
   installer verifies `/bin/bash` exists, is executable and accepts `-p`, and REFUSES to
   install the hooks with a named error otherwise; a gate's interpreter never falls back to
   `PATH`. The `env.HOME` measurement is recorded in `THREAT_MODEL.md` (T-HOOKENV-002).
6. **Override file replaces the env opt-outs (D-081 ruling 2 — E-291)**:
   `REIN_SAFE_EXEC_GATE` and `REIN_ROLE_TOKEN` are removed from the hook and from
   `safe-exec`. `rein gate off [--minutes N] [--reason …]` (default 15, hard max 60) writes
   `~/.rein/gate-override.json` (`until`, `reason`, mode 0600); `rein gate on` removes it;
   `rein gate status` prints it. The hook honours the file only when owned by the current
   uid, not group/other-writable, unexpired and within the max window (read with
   O_NOFOLLOW + fstat: regular file, nlink 1, ≤ 4 KB, `until` a number with
   `now < until ≤ now + 3600`, `reason` sanitised to a plain charset ≤ 120 chars at read
   and write).
   **Ceiling (D-083 ruling 5)**: a same-uid agent can reach anything the operator can; the
   gate is TAMPER-RESISTANT, not tamper-proof. Mitigations: analyzer rule
   `GATE_SELF_DISABLE` for every role (`rein gate`, `gate-override`, any shell write under
   `~/.rein/` BLOCK; string-splitting residual recorded); the Write/Edit branch blocks
   every role under `~/.rein/**`; the only writer paths are the inline literal allowlist
   `bash install-rein.sh`, `rein install`, `rein sync`, `rein doctor`; Component 6b adds the
   classifier backstop; operator presence (Keychain/Touch ID) is the next rung, unfunded.
   Block messages never tell the model to run `rein gate off` ("Operator escape — in YOUR
   terminal, not through the agent").
   **Loud (ruling 7)**: on every bypassed call the hook exits 0 with JSON stdout carrying
   `systemMessage: "[GATE_OVERRIDE] safe-exec bypassed until <until> (<reason>) — operator:
   rein gate on"` (user-visible; stderr on exit 0 is not), one telemetry row
   (`source=hook`, `status=BYPASS`), a session-start `additionalContext` line while active,
   and an `rein doctor` line.
   **Backstop (ruling 8)**: the catastrophic set (recursive root deletion, fork bomb, `mkfs`,
   `dd` to a device, a download piped into a shell) blocks under an active override; the
   override lifts the policy gate only.
   **Quoted heredoc bodies (D-084, narrowed D-085)**: the three content rules that
   over-blocked on prose — `CURL_PIPE_SHELL`/`WGET_PIPE_SHELL`, `GATE_SELF_DISABLE`,
   `SECRET_IN_COMMAND` — do not match inside the BODY of a quoted heredoc whose consumer
   is a plain top-level file sink. The Architect write analyzers and the sovereignty rules
   scan the full text (D-056 freeze). The shell lexer `heredoc.mjs` (E-292) is the
   definition and `tests/fixtures/pipe-shell-cases.json` is the contract: top-level consumer
   only; strict consumer line (plain-word sink, a real file, no `/dev/*`, optional unquoted
   `cd <abs> &&` prefix); no stripping when the surrounding text carries grouping,
   continuation, `eval`/`function`/`alias`/`exec`/`PATH`/`BASH_ENV`; a body stays scanned
   when a later line names a sink or carries expansion. The verbatim over-block commands
   (`plans/d083-overblock-verbatim.md`) are referenced by the fixture, not copied.
6b. **Classifier backstop (D-083 ruling 5(iii), text fixed by D-086, v2 by D-090 — E-293,
   E-306)**: `rein install` OFFERS (y/N, never silent) one labelled `hard_deny` prose rule,
   "Rein Gate Tamper (D-090)" (verbatim in DECISIONS.md; E-306 replaces the D-086 label in
   place), in the operator's `~/.claude/settings.json`. v2 adds `secrets/` to the protected
   set, exempts `rein init`, replaces "documented flags only" with "no flag that skips, disables
   or redirects hooks or the gate", exempts the installers only from a source tree the session
   has not modified, and exempts the `rein` command's own runtime state under `run/`. `hard_deny` is unconditional, so
   the rule names MACHINERY, not a directory: `rein gate off`; the override file and
   `~/.rein/{hooks,bin,mcp,shared,scripts,run,config}/`; `claude auto-mode reset`; removing
   or altering `autoMode`/`hooks`/`disableAllHooks`/`defaultMode` or adding `permissions.allow`
   for `rein` in the user settings; removing or altering `hooks`/`disableAllHooks`/`defaultMode`
   in a project's settings; a nested `claude` that drops its hooks. Exempt, with documented
   flags only: `rein install`, `rein sync`, `rein doctor`, `rein start`, `rein pane`, `ai watch`,
   `rein gate on`, `rein gate status`, `bash install-rein.sh`; reading. Data paths under
   `~/.rein/` are not covered. `"$defaults"` is inserted only when `hard_deny` is absent;
   the file is re-serialised in Claude Code's own format; JSONC is refused, never repaired.
   The classifier's configuration is the one layer the agent cannot reach from a project
   (D-080), so the two gates are independently configured — but only in auto mode: no
   launch path sets a permission mode, so under `bypassPermissions` the hook is the only
   gate. `rein doctor` reports present / not configured, the effective default mode, a
   `hard_deny` without `"$defaults"`, and any `Bash(ai…` allow entry (which would resolve
   before the classifier).
7. **An aborted gate is a blocked call (D-082 ruling 2 — E-292)**: the fail-closed gates
   (`pre-tool-use`, `pre-commit`, `pre-push`) carry a chained EXIT trap that maps any
   unexpected non-zero exit (unbound variable = 1, syntax error = 258) to exit 2 with
   `[GATE_INTERNAL_ERROR] <hook> aborted (rc N near line L) — run: rein doctor`. The old
   policy "an aborted hook is a broken session" is reversed for gates only; fail-open hooks
   still exit 0 on their own bug but write one incident record. The analyzer has a 10 s
   internal watchdog (exit 4 = TIMEOUT, blocked by the E-289 branch) and the generated hook
   entries carry an explicit 30 s `timeout`, so Claude Code's own hook timeout never fires
   first (the hooks reference confirms a timed-out PreToolUse hook does NOT block). SIGKILL
   and an external timeout are the accepted residual. No lockout: the operator's escape
   (`rein gate off`) runs from the operator's terminal, never through the gated tool.
8. **Role from a launch record, never from env (D-083 ruling 9, amended D-087 — E-294)**.
   Invariant: **a role may only move toward restriction** — nothing a session can run
   yields a role less restricted than the most restricted one on its process chain.
   - **8a. Launch-record module (one implementation)**: owns the record format, the
     start-time read, the file discipline and the walk; `rein pane`, the mint and the verifier
     all call it. Record: `~/.rein/run/launch/<pid>.json`, exactly `role`, `project`
     (realpath of the Rein root), `started`; regular file, euid-owned, nlink 1, ≤ 4 KB;
     directory chain opened `O_DIRECTORY|O_NOFOLLOW`, each directory euid-owned 0700; writer
     `umask 077`, `O_EXCL` temp + rename. Start time by one method in writer and reader:
     macOS `LC_ALL=C TZ=UTC0 /bin/ps -o lstart= -p PID`, Linux `/proc/<pid>/stat` field 22;
     `ps` by absolute path. The root is the gate stack's one root (`$HOME/.rein`, D-087 r7).
   - **8b. Writer — `rein pane` only**: writes the record for its own pid immediately before
     `exec` (the provider keeps the pid). `do_pane` never runs in a subshell or pipeline
     (bash 3.2 has no `BASHPID`). It REFUSES — exit 2, `[PANE_NESTED]`, nothing written —
     when any ancestor holds a live record: a pane is launched from a terminal, never from
     inside a session. No other component writes a record (the advisor does not, D-087 r6).
   - **8c. Walk — exhaustive, most-restrictive-wins**: from the minting process to pid 1,
     ≤ 64 hops, skipping record-less ancestors. LIVE = passes 8a's discipline, `started`
     equals the pid's real start time (else stale, skipped), `project` equals the realpath
     of the hook cwd's Rein root. Result, in order: a record failing the discipline, or a
     live record for another project → no token; any live `architect` → `architect`; any
     live `engineer` → `engineer` / `launch: record`; none on the whole chain → `engineer` /
     `launch: unverified` (the documented plain-launch default).
   - **8d. Mint — `--mint-token <sid> <session pid>`, no role in argv**: the role comes
     from 8c; a role word is refused; `<session pid>` is the hook's parent pid (bash's own
     `PPID`, not an environment read), accepted only when on the minter's ancestor chain.
     Token v2: `{v:2, role, session_id, launch, pid, started, hmac}`, HMAC over
     `v2|role|sid|launch|pid|started`. Table (lstat first; `architect` outranks `engineer`):
     (1) no file → mint; (2) valid v2 bound to this session process → no-op; (3) valid v2
     bound to another LIVE process → refuse; (4) valid v2 whose process is gone, or a valid
     v1 → replace only when the new role is the same or more restricted; (5) anything else
     at the path → refuse, never replaced. Refuse = file untouched, one stderr line, exit 0.
   - **8e. Verify — one implementation inside `safe-exec`** (`--check`, `--check-path`,
     `--verify-role`; consumed by the hook, `pre-commit` and `caller-role.mjs`): HMAC valid
     AND the token's pid is an ancestor of the verifier AND its start time matches. v1
     never verifies. PreToolUse hot path: the hook passes its own `PPID`; equality with the
     token's pid suffices there and reads no process table. `CLAUDE_CODE_SESSION_ID` is
     thereby a SELECTOR, not an authority.
   - **8f. Union — no verified token**: the `REIN_CALLER_ROLE` fallback in
     `--check`/`--check-path` is removed; no verified token → every role-specific block of
     every role (today: the Architect rule set; the Engineer has none at the hook) with
     `[ROLE_UNVERIFIED] run: rein pane <role>`. `caller-role.mjs`: no verified token →
     `architect` (its existing fail-closed default; the env branch is removed).
   - **8g. `pre-commit` role sources, in order (D-087 r5)**: (1) session id whose token
     verifies → `record:<role>`, the only source that unlocks the stamp waiver; (2) a live
     launch record on the committing process's ancestor chain → most restricted, restrict-only;
     (3) a session id that does not verify → union: lane restriction, no waiver; (4) advisory
     env (restrict-only), then `engineer` — the operator's own terminal is unchanged.
   - **8h. Lifecycle**: `rein doctor` reports this pane's live record, counts pre-E-294 (v1)
     tokens, and prunes only records and tokens whose process is gone; `rein start --kill`
     prunes the same. After install every running session is unverified until relaunched;
     the installer says so.
   - **Measured precondition — HELD (E-294, D-089)**: SessionStart and PreToolUse hooks share
     one parent pid, the pid `rein pane` exec'd, stable across startup, resume, clear, compact,
     a subagent's tool call and `--resume` in a new process. `/clear` issues a NEW session id
     in the same process, so SessionStart is registered for `startup|resume|clear|compact`.
   - **As built, ratified D-089 r1**: (1) `~/.rein` euid-owned and not group/other-writable,
     `run/` and `launch/` exactly 0700 (not "each directory 0700"); (2) a refused mint DELETES
     a v2 token whose process is known dead — `alive` exit 1; "unknown" deletes nothing —
     because under pid reuse the hot path could otherwise honour a dead token, and deletion
     only moves toward the union; (3) off the hot path the verified role is the MORE
     restrictive of the token's role and a walk from the verifier counting every live record
     whatever its project; (4) a process table that cannot be read is an error everywhere —
     walk = union, prune refuses; (5) `GATE_SELF_DISABLE` covers the install root named
     relatively after entering `HOME` (every `cd` form, `../` chains, `find -delete/-exec`,
     inline interpreters); (6) `role-token.mjs` runs python through the pinned interpreter
     from `toolchain.sh`, else `/usr/bin/python3`, never `PATH`. Implementation:
     `src/shared/launch-record.py` (8a–8c), `src/mcp/safe-exec-mcp/role-token.mjs` (8d–8e),
     `tests/lib/as-session.sh` (fixtures run as real session processes), `role_token_test`
     is the acceptance suite.
9. **One installer, one committed tree, exact gate dependencies (D-089 r2–r3 — E-304, E-305)**:
   `rein sync` never writes into `~/.rein/` (the hook-propagation step is deleted — hooks copied
   without the `mcp/` and `shared/` they depend on put an uncommitted, mismatched gate live
   machine-wide twice on 2026-10-04). `bash install-rein.sh` / `rein install` are the ONE
   installer: whole mirror from one tree, staged, build-stamp verified, then swapped. The
   installer REFUSES a tree with uncommitted changes under `hooks/`, `src/mcp`, `src/shared`,
   `src/bin` or itself; `--allow-dirty` is the one override, loud, recorded in the build stamp
   so `rein doctor` reports "installed from an uncommitted tree". Workspace precedence: the
   persisted `config/rein-workspace.txt` wins; an exported `REIN_WORKSPACE` is honoured only
   when no file exists; `rein doctor` warns on disagreement; the installer no longer writes the
   variable into shell rc files and offers to remove lines it wrote earlier. Dependencies on a
   gate path (`safe-exec-mcp`'s `shell-quote`, `heredoc.mjs`, the standards checker,
   `gate-guard`) are pinned to EXACT versions, installed with `npm ci` from the committed
   lockfile, and the installer verifies installed == pinned (`[TOOLCHAIN_STALE]` otherwise); a
   bump goes through `dependency_gate` and runs every contract table against the new parser.
   The two-parser-generation fixture from b36a818 is the regression pin.
   **Env inventory (D-084, fixed by D-087 r3) — the contract; a new env read on a gate
   path is a D-ruling.**
   | Variable | Where | Class |
   |---|---|---|
   | `REIN_SOVEREIGNTY_LOCK` | `safe-exec` `runAnalysis`, `caller-role.mjs`, `task-synchronizer` DONE lock, and every message/schema that offers it | gating — REMOVED everywhere |
   | `REIN_CALLER_ROLE` | `safe-exec` `effectiveRole`, `pre-tool-use.sh` positional role, `caller-role.mjs` env branch | gating — REMOVED |
   | `REIN_PANE_ROLE` | `session-start.sh` mint | gating — REMOVED |
   | `CLAUDE_CODE_SESSION_ID` | `pre-commit`, `caller-role.mjs` | selector — kept; a token verifies only under its own session process (8e) |
   | `REIN_SKIP_GIT_LANE`, `REIN_SKIP_CONFLICT_GATE`, `REIN_SKIP_STANDARDS`, `REIN_CI_SKIP` (+`_REASON`) | git hooks | residual — kept, same strength as `--no-verify` (D-081 r5); each prints a named line when honoured |
   | `REIN_PANE_ROLE` / `REIN_CALLER_ROLE` | `pre-commit` row 4; prompts, advisor, handoff, `rein add-task` routing | advisory — restrict-only or routing |
   | `HOME` | the root of the whole gate stack | root selector — residual (D-087 r7): project settings `env` cannot redirect it (measured, E-290) |
   | `REIN_HOME`, `REIN_LOCATE_DEV`, `REIN_WORKSPACE` | locator | ignored under `REIN_LOCATE_UNTRUSTED_ENV` |
   | `REIN_TC_*` | toolchain pin | unset before the pin |
   | `REIN_SAFE_EXEC_SELFTEST_THROW` | `safe-exec` | restrict-only |
   | `REIN_DISABLE_CACHE` | session-start cache | not a gate input |
   | `PWD` | `pre-tool-use.sh` | validated against the real cwd |
   **Residuals (T-ROLE-001, D-087)**: a program the gate cannot read (a script file given
   to an interpreter, a provider launched outside any Rein project or with settings that
   drop its hooks, a launch detached from the session's process chain) is outside the
   per-command scan and the walk — the classifier backstop is the cross-call layer, in auto
   mode only; the Architect shell gate is not widened for it (D-056). Same-uid ceiling: the
   record and token are files under `~/.rein/run/`, write-gated by `GATE_SELF_DISABLE` and
   the D-086 rule; removing both returns a pane to the plain-launch default. Binding the
   role to something a session cannot remove is the next rung, unfunded.
   **E-294 acceptance (D-087; replaces nothing in the task text, adds to it)** — fixtures
   mint real tokens from records in a throwaway `HOME`, no new env var:
   nested `rein pane engineer` under an architect record is refused and writes nothing; a
   nested provider under an architect record mints `architect`; an engineer record below an
   architect record on one chain mints `architect`; `--mint-token` with a role word is
   refused; each of the five mint-table rows; a removed-then-re-minted token never yields a
   less restricted role while the record is live; a stale pid (start-time mismatch) is
   skipped; a foreign-project record yields the union; symlink, nlink 2, wrong owner, wrong
   mode, extra key and oversize records each yield the union; a token presented under a
   process that is not a descendant of its session process does not verify (the session-id
   substitution case, in `--check-path` and in `pre-commit`); `pre-commit` rows 1–4, with
   the waiver reachable only from row 1; the role and lock variables set in a project's
   settings `env` change no verdict; `REIN_SOVEREIGNTY_LOCK=0` no longer unlocks a DONE
   task; each git-hook opt-out prints its named line; record pid == provider pid after
   exec; the advisor's resolved `print_mode` argv carries no permission-bypass flag; the
   D-085 r1 heredoc narrowing keeps the sovereignty and write analyzers on the full text;
   `arch-write-cases.json` sha256 unchanged and green; session-start and pre-tool-use within
   their perf budgets; bash 3.2. Sequencing: commit and push, THEN `bash install-rein.sh`,
   the operator relaunches both panes, the task is closed from the relaunched pane.

### Data Model
```
~/.rein/shared/toolchain.sh
REIN_TC_NODE=/abs/path/node
REIN_TC_PYTHON3=/abs/path/python3
REIN_TC_NICE=/usr/bin/nice
REIN_TC_RECORDED=<ISO-8601>
```
These are shell variables set by the sourced file, not environment inputs: a value
inherited under the same name is overwritten at source time.
```
~/.rein/run/launch/<pid>.json        (Component 8a; written only by `rein pane`)
{ "role": "architect|engineer", "project": "<realpath of the Rein root>", "started": "<process start time>" }

~/.rein/run/role-<sid>.lock          (Component 8d; token v2)
{ "v": 2, "role": "...", "session_id": "<sid>", "launch": "record|unverified",
  "pid": <session process>, "started": "<its start time>", "hmac": "<over v2|role|sid|launch|pid|started>" }
```

### API / Interface Contracts
- Hooks: the `toolchain-pin.sh` prologue is the first statement after `set` options; it
  parses `toolchain.sh` (never sources it); no hook reads `PATH` before it.
- No new environment variable and no opt-out variable: T-LOCATOR-001's lesson is that a
  fix for an environment-trust bug must not add an environment switch. Rollback is a revert.

### Security
- Closes the interpreter channel of T-HOOKENV-001. The shell-level channels (`BASH_ENV`,
  exported functions, `SHELLOPTS`/`PS4`, decoy `bash`) are T-HOOKENV-002, closed by
  Component 5 (E-290). `HOME` is measured in E-290, not assumed. A decoy `git` on the Bash
  tool's PATH skipping the git hooks is an accepted residual (D-081 ruling 5): the
  authoritative gates are the PreToolUse hook and `rein ci run`.
- The env opt-outs were the single-variable undo of this whole section; Component 6
  (E-291) replaces them with an operator-owned, time-boxed, loud override file.
- The recorder refuses an interpreter whose `realpath` lies inside the current project or
  any directory writable by others.
- Tier 3: `security_engineer` before code, `critic_security` on the diff.

### Execution Constraints
- Sourcing adds one file read per hook run; the pre-tool-use warm path budget (E-239
  `assert_perf`) must still hold.
- bash 3.2 compatible (macOS system bash).

### Rollback Plan
Revert the PR; the hooks return to bare-name resolution. `toolchain.sh` is inert if unread.

### E-## Task Breakdown
- **E-286** (Tier 3): components 1–4, including the D-081 amendments to component 3
  (missing `python3` is stale; repair-command exemption through the shared helper).
- **E-290** (Tier 3, after E-286 — D-081 ruling 1): component 5, privileged shell + the
  `HOME` measurement + T-HOOKENV-002.
- **E-291** (Tier 3, after E-289 — D-081 ruling 2): component 6, the override file;
  E-289's second escape hatch becomes this file.
- **E-292** (Tier 3, after E-291 — D-082 ruling 2): component 7, aborted gate = blocked
  call, analyzer watchdog, explicit hook timeouts.
- **E-293** (Tier 3, after E-291 — D-083 ruling 5(iii)): component 6b, the classifier
  backstop offered by `rein install`.
- **E-294** (Tier 3, after E-290 and E-291 — D-083 ruling 9, design amended by D-087):
  component 8a–8h, the env inventory table and the acceptance list there; most-restrictive
  walk, process-bound v2 token, role-less monotonic mint, `[ROLE_UNVERIFIED]` union block;
  writes THREAT_MODEL T-ROLE-001 and closes T-GITLANE-001 residual 2. **DONE** (b36a818,
  PR #95); six divergences ratified D-089 r1.
- **E-304** (Tier 2 — D-089 r2): component 9, `rein sync` stops writing into the mirror; the
  installer refuses a dirty tree (`--allow-dirty` loud); workspace precedence reversed.
- **E-305** (Tier 2 — D-089 r3): component 9, exact pins for gate-path dependencies, `npm ci`,
  installed == pinned verified by the installer.
- **E-306** (Tier 2 — D-090): component 6b, the rule text v2 replaced in place.
- E-289 as-built divergence ratified (D-083): rc 0 with no `Verdict:` line is "no verdict"
  and blocks.
- **E-287** (Tier 3): `SECRET_IN_COMMAND` value-shaped matching — see §Secret Rule Precision.
- **E-289** (Tier 3, after E-286 — D-080 rulings 3 and 4): the hook's Bash branch fails
  CLOSED when the analyzer is located but `--check` exits with anything other than 0 or 2
  (`[SAFE_EXEC_UNAVAILABLE] safe-exec exited N: run bash install-rein.sh`), matching the
  Write/Edit branch. Escape hatches: the literal `bash install-rein.sh` from the project
  root passes, and `REIN_SAFE_EXEC_GATE=0` remains the rollback. The catastrophic backstop
  keeps covering the analyzer-not-located case. Plus the per-segment research bypass.

## Operand Scope and Inert Heredocs (D-105 r6, D-111 r3-r4, 2026-10-23 — E-340)
- Every rule keeps its whole-line match. Two narrow exemptions, each falling back to the
  old verdict when unsure: `RM_RF_ROOT` ignores ONE leading `cd <plain absolute dir> ;|&&`
  (`KEEP_CD_PREFIX` conditions in `safe-exec-mcp/index.js`); the sovereignty families
  (git/deploy/rm/mkdir/touch) read `stripInertHeredocs(full, {readOnlyLines: true})` —
  inert bodies are stripped only when every other non-blank line passes the read-only
  allowlist lexer and no sink is an implicit-run file.
- **A quoted argument is not data** for the sovereignty families (D-111 r3): a string handed
  to `-c`, `eval`, `su -c`, `python -c` is code. The Architect commits with `-F <file>` or a
  heredoc when a message must name a forbidden verb.
- **D-085 r1 narrowed** (D-111 r4): the read-only relaxation applies to the sovereignty
  families only; the three content rules keep the strict strip; `analyzeArchitectWrites`
  scans the full text. Contract: `heredoc.mjs` + `operand-scope-cases.json` +
  `pipe-shell-cases.json` + `operand-scope-verbatim.md`.
- **E-350 as built, ratified D-112 r1-r2 (2026-10-28)**: `code-strings.mjs` (a forbidden verb
  inside a string a carrier executes — `bash -c`, `sh -c`, `eval`, `su -c`, `env -S`,
  `python -c`, `node -e`, `watch`, `sudo -s` — recursive to depth 3 / 16 KB) and
  `git-redirect.mjs` (`core.hooksPath`, `GIT_DIR=`, `GIT_WORK_TREE=` on a git line) block for
  the Architect; `_emptyExpansionRoot` makes `~user`, `"$UNSET"/*` and `$A/$B/*` root-form.
  `RM_RF_ROOT` is a catastrophic rule, not a sovereignty rule: it has never been role-scoped,
  so the new root forms block EVERY role (the Engineer's variable root is `"${X:?}"/*`, which
  fails closed when unset and passes). The input cap is three limits — 2000 groups, 10k
  words, 64 KB — answered as `[INPUT_TOO_LARGE]` inside 200 ms; a document larger than that
  goes through the Write/Edit tools, which are path-gated and not line-parsed (E-351 makes
  the block line say so). Contract: `operand-scope-cases.json` at 240 rows.
- **Residuals accepted for now, queued as E-353 after wave 1 (D-112 r3)**: aliased verbs
  (`g=git; $g`), `GIT_CONFIG_GLOBAL=` / `HOME=` / `include.path` / `core.fsmonitor` /
  `core.sshCommand` on a git line, `GIT_DIR=x make`, the carriers yash/posh/lua/tmux/parallel,
  `~+` / `~-` / `$((…))` / `$'\x2f'` / `/bin` / `/opt` / `a/../../*` / `/tmp/../*` as root
  forms, string concatenation inside interpreter programs, the false positive `git grep
  GIT_DIR=`, and a `|` inside the BODY of a quoted-delimiter heredoc read as a pipe by the
  three content rules (a markdown table in a `cat >> .ai/… <<'EOF'` body tripped
  `CURL_PIPE_SHELL` on 2026-10-28). The tables are pinned by sha256 when E-353 closes them.

## Secret Rule Precision (D-078, 2026-09-29 — E-287)

### Problem
`SECRET_IN_COMMAND` matches a KEYWORD followed by any 4 non-space characters
(`\b(password|passwd|secret|api.?key|token)(\s*=\s*|\s+)\S{4,}`). Prose matches: a heredoc
containing "token usage" or "secret santa" is blocked. On 2026-09-29 it blocked the
Engineer three times and one of those blocks silently cost a COMM.md handoff entry.

### Rule (as built in E-287, ratified D-080 2026-10-01)
Implemented in `src/mcp/safe-exec-mcp/secret-rule.mjs`. A block needs a keyword AND a value
that looks like a credential:
1. **Assignment, flag or header form only** — `KEY=value`, `KEY: value` (headers, JSON),
   `--key value`, `--key=value`, `Authorization: Bearer|token|Basic value`, URL userinfo
   (`https://user:secret@host`) and `curl -u user:secret`. A keyword followed by whitespace
   and a word is prose.
2. **Value shape** — a known prefix (`sk-`, `sk_live_`, `rk_live_`, `ghp_`, `gho_`, `ghu_`,
   `ghs_`, `ghr_`, `github_pat_`, `xox[abp]-`, `AKIA`, `ASIA`, `eyJ`, `npm_`, `glpat-`, `hf_`)
   of any length ≥ 12; OR length ≥ 16 with at least three of the four classes
   lower/upper/digit/symbol; OR, with a keyword, a ≥ 20-char hex/base64 run containing a
   digit. A `$VAR`, `${VAR}`, `$(…)` or `<placeholder>` value is a reference, not a secret,
   and passes.
3. **Password-key tier** — `pass|passwd|password|pwd` in assignment form blocks at ≥ 8 chars
   and ≥ 2 classes. The original ≥ 16 / 3-class shape let the historical true positive
   `export password=supersecret123` through while the contract kept every historical TP as
   BLOCK; the contract wins. `password=supersecret` (one class) and `--password=changeme`
   pass by design.
4. **Known-prefix values block even without a keyword** — the keyword was never the signal.
5. **Input over 256 KB blocks unscanned** (fail closed).
6. The obfuscation normaliser stays. The `RESEARCH_CMDS` bypass is **DELETED** (D-082
   ruling 1, E-289, amending D-080 ruling 4): with a value-shaped rule it protected no
   contract case (0/26 over-block, 0/25 miss without it), and a per-segment splitter was
   exploited by six payload classes in review. A credential-shaped literal typed into any
   command line blocks, whatever the verb; the message says to search by prefix
   (`grep -rn 'ghp_' src` is ALLOW) or from a file.

### Accepted residuals (D-080)
`mysql -pPASS`; low-entropy secrets under non-password keys (`SECRET=hunter2hunter2`);
keyword + space + value with no `=` or flag; secrets read from files. Precision is the
purpose (contract: over-block 0/26, miss 0/25); a secret entering a COMMIT is additionally
caught by the auto-mode classifier's content check.

### Contract
`tests/fixtures/secret-cases.json` is the contract, in the manner of
`arch-write-cases.json`: every historical true positive in the suite stays BLOCK; the
three 2026-09-29 commands (reconstructed from the COMM description — no verbatim record
survived) and at least ten prose cases are ALLOW; the over-block ratio is printed on every
run. **From D-080 on, every overturned block goes into the fixture verbatim in the same
handoff that reports it; the fixture is the record.** This narrows a rule; it does not touch
the Architect write gate frozen by D-056 (`arch-write-cases.json` byte-identical).

### Rollback
Revert the PR; the keyword rule returns.
