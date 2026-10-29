# SECURITY.md — Rein v2

> Full threat detail: `.ai/THREAT_MODEL.md`
> Last updated: 2026-04-14 (security_engineer — E-8 computer-use-mcp)

---

## 1. Secrets Handling

| Secret | Stored Location | How Rotated | Must Never Appear In |
|---|---|---|---|
| TestSprite API key | `.mcp.json` env block (`API_KEY`) | Manual replacement in `.mcp.json`, then `install-rein.sh` re-sync | Logs, `.ai/*.md`, git commits, DIGEST.md |
| GitHub credentials (github-bridge-mcp) | System keychain / env var at runtime | External (GitHub PAT rotation) | Any `.ai/` file, any MCP tool output written to disk |
| Host `$DISPLAY` socket path | Must NOT be visible to computer-use-mcp | N/A — should be structurally unreachable | Any MCP tool argument, any log line emitted by computer-use-mcp |
| Xvfb virtual display socket | Ephemeral per session, e.g. `/tmp/.X99-lock` | Auto-destroyed on session end | No persistent logging of socket path |

**Absolute prohibitions:**
- No API key, token, or password may appear in any `.ai/*.md` file, `LOG.md`, `DIGEST.md`, or `SESSION.md`.
- `computer-use-mcp` must never log screenshot payloads, keystrokes, or coordinates to disk in plaintext.
- The Xvfb virtual DISPLAY socket path must be isolated at the process level — it must not be readable via the host `$DISPLAY` env var.

---

## 2. Auth / AuthZ Boundaries

| Boundary | Who Can Cross | Token / Lifetime | Revocation |
|---|---|---|---|
| MCP tool invocation | Claude (Engineer) via MCP protocol only | Session-scoped | Process kill / session end |
| computer-use-mcp screen capture | TestSprite + Vibe Sentinel only (via `ai test --vibe`) | Single test run | TestSprite session teardown |
| computer-use-mcp keyboard/mouse input | TestSprite orchestration only — never direct agent prompt injection | Single test run | TestSprite session teardown |
| filesystem MCP | Scoped to project root (`.`) per `.mcp.json` | Session-scoped | Remove from `.mcp.json` |
| github-bridge-mcp | Claude only, authenticated PAT, read/write to project repo | PAT expiry | GitHub PAT revocation |

**computer-use-mcp must enforce that it only receives commands from a TestSprite session context** — direct invocation by the agent via arbitrary tool calls outside of `ai test --vibe` must be blocked at the MCP server layer.

---

## 3. computer-use-mcp — Threat Model Summary

Full entry: `.ai/THREAT_MODEL.md` section `T-CU-001` through `T-CU-005`.

### T-CU-001: Sandbox Escape — Virtual Display Breakout
- **Attack**: Agent or malicious tool call sets `DISPLAY=:0` (host), bypassing the Xvfb virtual display.
- **Impact**: Full visual access to all host applications including credential stores, browsers, and terminals.
- **Mitigation (REQUIRED)**:
  1. `computer-use-mcp` process must be launched with `DISPLAY` hardcoded to the Xvfb virtual display (e.g. `:99`) in the process environment — never inherited from the parent shell.
  2. The server must reject any tool call that attempts to override or pass a `display` parameter pointing to `:0` or any value other than the configured virtual display.
  3. Xvfb must be started as a non-root user, isolated from the host's X authority file (`XAUTHORITY`).
  4. Do not pass `--no-sandbox` to any Chromium/browser process launched within Xvfb.
- **Residual Risk**: Low if mitigations applied. High if process inherits host `$DISPLAY`.

### T-CU-002: Host Filesystem Access via UI Interaction
- **Attack**: Agent uses keyboard/mouse simulation to open a host terminal, file manager, or browser file picker and read/write files outside the project root.
- **Impact**: Reads `.env`, SSH keys, browser-saved passwords; exfiltrates data; modifies host config files.
- **Mitigation (REQUIRED)**:
  1. Xvfb session must not have access to a running file manager, terminal emulator, or host DE — the display should contain only the application under test.
  2. The virtual display environment must not have `$HOME` pointing to the real user home; use an isolated `$HOME=/tmp/computer-use-sandbox` with no `.ssh/`, no `.gnupg/`, no browser profiles.
  3. `safe-exec-mcp` must be in the computer-use-mcp execution chain — any shell spawned during a test run must pass through `safe-exec-mcp` command analysis before execution.
  4. Directory access from within the Xvfb session must be restricted to the project root via filesystem MCP scoping (already enforced by `.` root in `.mcp.json`).
- **Residual Risk**: Medium. Full mitigation requires OS-level namespace isolation (Docker/bubblewrap). Without that, keyboard-to-terminal attacks remain possible if a terminal is reachable from the virtual display.

### T-CU-003: Privilege Escalation
- **Attack**: `computer-use-mcp` server runs as root or with elevated capabilities, allowing the agent to escalate privileges via UI interaction (e.g., clicking "Allow" on a sudo prompt visible in the virtual display).
- **Impact**: Root access on the host machine.
- **Mitigation (REQUIRED)**:
  1. `computer-use-mcp` must run as the same unprivileged user as the Claude Code process — never as root.
  2. The MCP server process must not be granted `CAP_SYS_ADMIN`, `CAP_NET_ADMIN`, or any elevated Linux capabilities.
  3. The Xvfb virtual display must not render any polkit/sudo/UAC prompts — the application under test must be pre-authorized (no privilege gates within the test UI).
  4. Process isolation: use `setuid`/`setgid` drops or Docker `--user` flag if containerized.
- **Residual Risk**: Low if the server is launched without escalation and the virtual display renders no auth prompts.

### T-CU-004: Credential Theft via Visual Scraping
- **Attack**: Agent uses screen capture to read secrets visible in other applications (browser autofill, password manager, Slack DMs, terminal history with API keys) by pointing the capture at the host display.
- **Impact**: All secrets visible on screen at capture time are exposed to the agent and potentially logged.
- **Mitigation (REQUIRED)**:
  1. Virtual display isolation (T-CU-001) is the primary defense — if the agent cannot reach `:0`, it cannot see host app windows.
  2. Screenshot output must be scoped to the virtual display framebuffer only — the capture API must not accept arbitrary display or window handle arguments from agent tool calls.
  3. Screenshot payloads must never be written to disk in plaintext. If stored at all (for TestSprite assertion), write to a temporary path that is deleted after the test run.
  4. `context-guardian-mcp` must be invoked to verify that screenshot data is not echoed back into any `.ai/` memory file.
- **Residual Risk**: Low with display isolation. Critical without it.

### T-CU-005: Network Exfiltration via Sandboxed Browser
- **Attack**: Agent uses computer-use keyboard/mouse to open a browser within the virtual display, navigate to an attacker-controlled URL, and POST captured data (file contents, environment variables, agent memory) out of the sandbox.
- **Impact**: Exfiltration of project source, secrets, or agent memory to an external server.
- **Mitigation (REQUIRED)**:
  1. The Xvfb virtual display session must not have unrestricted internet access. Network egress from the Xvfb session must be restricted to `localhost` only, or to a specific allowlist (e.g., the local dev server under test).
  2. Implement outbound firewall rule (iptables/pf) scoped to the Xvfb process group: block all non-localhost TCP/UDP by default.
  3. If testing a web application, use a localhost-only dev server — the browser under test should not have general internet access.
  4. `safe-exec-mcp` must block any `curl`, `wget`, `nc`, or `ssh` commands spawned from within the test session.
- **Residual Risk**: Medium without network namespace isolation. Low with process-group-scoped egress firewall.

---

## 4. Input Validation

All external inputs entering the MCP server layer must be validated at the trust boundary before execution.

| Input Surface | Validation Rule |
|---|---|
| Tool call arguments (coordinates, key strings) | Coordinates: validate integer bounds against virtual display resolution (0 ≤ x ≤ W, 0 ≤ y ≤ H). Key strings: allowlist of printable ASCII + known key names — reject control sequences that could inject shell commands. |
| `display` parameter (if exposed) | Must match the configured virtual display ID exactly (e.g., `:99`). Reject anything that does not match this regex: `^:[0-9]{1,3}$` and does not equal the configured value. |
| Screenshot region parameters | Validate bounding box is within virtual display bounds. Reject negative values or values exceeding display dimensions. |
| TestSprite test instruction payloads | Treat as UNTRUSTED. Fence with `<!-- UNTRUSTED: TestSprite instruction -->` before any storage in `.ai/` memory. Strip any embedded shell metacharacters before passing to keyboard simulation. |
| MCP tool caller identity | Validate that the calling context is a TestSprite-initiated `ai test --vibe` session. Reject arbitrary agent-originated calls outside this context. |

**Prompt injection defense**: Any instruction text passed to `computer-use-mcp` from an external source (TestSprite plans, blueprint content) must be treated as UNTRUSTED data, not as executable instructions. The server must never pass raw instruction text to a shell or `eval`-equivalent.

---

## 5. Path Traversal Defense

The `filesystem` MCP server is already scoped to the project root (`.`) per `.mcp.json`. The following additional rules apply to `computer-use-mcp`:

- The server must not accept filesystem paths as tool arguments. All file operations triggered by computer-use actions must pass through the `filesystem` MCP with its existing project-root scope enforcement.
- `../` sequences in any tool argument must be stripped and the call rejected with an error.
- The sandbox `$HOME` must be set to an isolated directory (e.g., `/tmp/computer-use-sandbox`) with no symlinks to the real user home. This directory must be created fresh each session and deleted on teardown.
- Screenshot output paths, if used, must be within the project's `tmp/` or `tests/screenshots/` directory — never an absolute path provided by the caller.

---

## 6. Dependency Security

| Item | Status |
|---|---|
| Lockfile | `package-lock.json` present at project root (npm workspaces, E-1) |
| Audit command | `npm audit` — run before any `npm install` for computer-use-mcp dependencies |
| `dependency_gate` skill | Mandatory before adding any new npm/pip dependency for computer-use-mcp |
| Xvfb system package | Must be pinned to distro LTS version; verify with `apt-cache policy xvfb` or equivalent |
| Claude Computer Use SDK | Pin to a specific version tag in `package.json`; do not use `latest` or `*` |
| Screen capture library | Audit for known CVEs before install; pass through `dependency_gate` |

**New dependency rule**: Any dependency added for `computer-use-mcp` must produce a DECISIONS.md entry (D-002 or higher) via the `dependency_gate` skill before installation. This is already flagged as OUTSTANDING in `LOG.md` (TRIGGER_AUDIT 2026-04-14).

---

## 7. .mcp.json Scope vs CAPABILITIES.md Sync

CAPABILITIES.md does not currently exist at `.ai/CAPABILITIES.md` (file absent as of 2026-04-14 audit). The `.mcp.json` filesystem server is scoped to project root (`.`). When `computer-use-mcp` is added to `.mcp.json`:

- Its entry must include an explicit `env` block with `DISPLAY=:99` (or the configured Xvfb display).
- It must NOT inherit the parent process environment — `env` must be fully explicit.
- The entry must be reviewed against `.ai/blueprints/capabilities.md` section 2 before merge.
- A D-### capability decision entry must be proposed (not directly edited) if the scope expands beyond project root.

**Proposed decision**: D-002 — computer-use-mcp sandbox scope (headless Xvfb display only, no host display access, no host filesystem beyond project root, no unrestricted network egress). This must be formally written to `.ai/DECISIONS.md` before E-8 implementation is merged.

---

## 8. Threat Mitigation Status (Updated: 2026-04-22)

E-8 implementation is complete. All P0 threats have been mitigated in `src/mcp/computer-use-mcp/index.js`.

| Threat ID | Description | Status |
|---|---|---|
| T-CU-001 | Sandbox escape via host `$DISPLAY` | **MITIGATED** — `SANDBOX_DISPLAY = ":99"` hardcoded constant; no env var read; all `execFileSync` calls use explicit minimal env `{ DISPLAY: SANDBOX_DISPLAY, HOME: SANDBOX_HOME }` (P1 env-spread in healthCheck fixed 2026-04-22) |
| T-CU-002 | Host filesystem access via UI interaction | **MITIGATED** — `SANDBOX_HOME = "/tmp/computer-use-sandbox"` hardcoded; dir created at mode `0o700`; passed to all child processes |
| T-CU-004 | Credential theft via visual scraping | **MITIGATED** — screenshots written to `tmpdir()` with unique name, deleted in `finally` block via `unlinkSync`; no persistent screenshot storage |
| T-CU-005 | Network exfiltration via sandboxed browser | **PARTIALLY MITIGATED** — display isolation prevents host browser access; full network namespace restriction (iptables/pf) is a deploy-time hardening step, not enforced in code |
| T-PI-001 | Prompt injection via keyboard payload | **MITIGATED** — `sanitizeText()` allows only printable ASCII `\x20-\x7E`; `sanitizeKey()` enforces `[a-zA-Z0-9_+\-]+` allowlist |

`[SEC_CLEARED]` condition fulfilled — see LOG.md 2026-04-21.

---

_Generated by security_engineer agent — 2026-04-21. Updated post-implementation by Claude — 2026-04-22._

---

## approval-mcp (E-10)

> Full threat entries: `.ai/THREAT_MODEL.md` section `T-HITL-001` through `T-HITL-005`.
> Component: `src/mcp/approval-mcp/index.js`
> Blueprint: `.ai/blueprints/interop.md §2`
> Last updated: 2026-04-14 (security_engineer — E-10 pre-implementation review)

`approval-mcp` is a Human-in-the-Loop (HITL) gate server. It surfaces a blocking Y/N prompt in the host terminal before returning to Claude. Because it sits on the execution path for all Tier 3 operations, its security posture is load-bearing — a compromise here is a compromise of the entire approval mechanism.

---

### T-HITL-001: Prompt Injection via `action` / `reason` Strings (ANSI / Terminal Control Characters)

- **Severity**: P0 (Critical)
- **Attack vector**: Claude (or a compromised upstream caller) passes an `action` or `reason` string containing ANSI escape sequences (e.g., `\x1b[2J` to clear the screen, `\x1b[A` to move the cursor up and overwrite prior lines) or terminal control characters (`\r`, `\n`, `\x08` backspace) designed to manipulate what the human operator sees in the terminal. An attacker could craft a string that clears the real prompt text and replaces it with a false confirmation message — causing the operator to approve something they did not intend to.
- **Impact**: The human operator is deceived into approving a malicious action. This is the highest-impact vector for approval-mcp because it undermines the entire HITL guarantee.
- **Required mitigations**:
  1. **Sanitize before display** — strip all ANSI escape sequences and non-printable characters from `action` and `reason` before writing them to `process.stdout`. Use a pattern such as replacing `[\x00-\x1F\x7F]|\x1b\[[0-9;]*[A-Za-z]` with an empty string or a safe placeholder (e.g., `[CTRL]`).
  2. **Enforce length limits** (see T-HITL-005) before sanitization so oversized strings cannot be used to flood the display and obscure the prompt.
  3. **Prefix the prompt line with a hard visual boundary** (e.g., `=== APPROVAL REQUEST ===`) that is printed by the server itself, not derived from the input — making it harder for injected text to masquerade as the approval UI.
  4. **Log the raw (pre-sanitized) value** to `state.sqlite` alongside the sanitized display value, so post-hoc audit can detect attempted injection.
- **Residual risk**: Low if sanitization applied before display. Critical if raw strings are passed directly to `process.stdout.write` or a `readline` prompt.
- **Status**: UNMITIGATED (E-10 not yet implemented) — **REQUIRED before merge**

---

### T-HITL-002: SQLite Path Injection / Path Traversal

- **Severity**: P0 (Critical)
- **Attack vector**: The path to `state.sqlite` is resolved at runtime. If it is derived from an environment variable, a tool argument, or any user-controlled input, an attacker can redirect it to an arbitrary path (e.g., `../../.ssh/authorized_keys`, `/dev/null`, or a remote SMB mount) to either corrupt a sensitive file or silently discard approval records, breaking the OASF audit trail.
- **Impact**: Audit trail destroyed (approvals not recorded), or arbitrary file overwrite at the path to which SQLite writes its WAL/journal files.
- **Required mitigations**:
  1. **Hardcode the SQLite path** as a compile-time constant in the server source, e.g.: `const DB_PATH = path.join(__dirname, '../../state/state.sqlite');`. Never read from `process.env`, tool arguments, or any external input.
  2. **Canonicalize and validate** the resolved path on startup: `path.resolve(DB_PATH)` must start with the known project root. If it does not, exit with a non-zero code rather than proceeding.
  3. **`../` in any argument must never reach the DB path resolution code** — this is enforced by the hardcoded constant, but should be validated as a defense-in-depth check.
  4. **File permissions**: `state.sqlite` must be mode `0o600` (owner-read/write only). The server must verify or set this on first open.
- **Residual risk**: Low if path is fully hardcoded. High if any environment variable or argument influences it.
- **Status**: UNMITIGATED (E-10 not yet implemented) — **REQUIRED before merge**

---

### T-HITL-003: Approval Spoofing — Auto-Approval Without Human Interaction

- **Severity**: P0 (Critical)
- **Attack vector**: A compromised or misconfigured call path bypasses the `readline` interactive prompt entirely and returns `{ status: "APPROVED" }` without blocking for human input. This could occur via:
  - `stdin` being non-TTY (e.g., the MCP server is started with `stdin` piped from a file or another process), causing `readline` to read from the pipe and auto-answer;
  - a code path that defaults to APPROVED on timeout or on readline error;
  - a test/mock mode flag (`--auto-approve`, `NODE_ENV=test`) left enabled in production;
  - Claude calling `request_approval` with a crafted input stream that feeds the readline prompt automatically.
- **Impact**: All Tier 3 operations proceed without any human consent check — the entire HITL gate is neutralized. This is equivalent to removing the gate entirely.
- **Required mitigations**:
  1. **TTY assertion on startup**: the server must verify that `process.stdin.isTTY === true` before registering `request_approval`. If stdin is not a TTY, the server must either refuse to start or refuse to process any approval request (return `REJECTED` with an error message explaining that no interactive terminal is available).
  2. **No timeout-based auto-approval**: the readline prompt must block indefinitely until the user explicitly inputs `y`, `Y`, `n`, or `N`. A timeout that resolves to APPROVED is forbidden. A timeout that resolves to REJECTED is acceptable as a safe default.
  3. **No `--auto-approve` flag or `NODE_ENV=test` bypass in production code**: if a test mode is needed, it must be implemented in a separate test-only module, never in the production `index.js`. The production entry point must not contain any code path that skips the readline prompt.
  4. **Minimum required input**: The server must only accept `y`/`Y` as approval. Any other input (including empty string, enter with no input, or unrecognized characters) must be treated as REJECTED.
  5. **Audit log written before response**: the SQLite record must be committed before the tool response is returned to Claude, preventing a crash-between-write-and-respond from producing an unrecorded approval.
- **Residual risk**: Low if TTY assertion and no-timeout rules are enforced. Critical if either is absent.
- **Status**: UNMITIGATED (E-10 not yet implemented) — **REQUIRED before merge**

---

### T-HITL-004: Bypass Resistance — Gate Circumvention

- **Severity**: P1 (High)
- **Attack vector**: The `approval-mcp` gate is bypassed by one of several mechanisms:
  - The MCP server is simply not registered in `.mcp.json`, so `request_approval` is unavailable and Claude proceeds without it;
  - Claude's `safe-exec-mcp` or `trigger-audit` skill fails to flag a Tier 3 operation, so `request_approval` is never called;
  - The `disable-model-invocation` setting or a `settings.json` permission block prevents the gate from being reached;
  - A future refactor removes the `request_approval` call from the Tier 3 execution path.
- **Impact**: Tier 3 operations execute without human consent. The HITL guarantee is silently broken with no visible error.
- **Required mitigations**:
  1. **Registration enforced**: `approval-mcp` must be present in `src/config/registry.json` and `.mcp.json`. Its absence must be caught by a startup health check or CI test that verifies the registry entry exists.
  2. **`disable-model-invocation` cannot suppress the gate**: the blueprint states this explicitly. In implementation, `request_approval` must be a standard MCP tool (not dependent on model invocation settings) — it does not invoke a model; it invokes `readline`. Confirm this property is preserved in the implementation.
  3. **`safe-exec-mcp` integration test**: a CI test must verify that a known Tier 3 command (e.g., `prisma migrate deploy`) causes `safe-exec-mcp` to emit `[TIER_3_RISK]`, which in turn triggers `request_approval`. This is an end-to-end bypass-resistance test.
  4. **Audit trail as detection**: the SQLite log is the detection mechanism. If a Tier 3 operation completes but no corresponding approval record exists in `state.sqlite`, the OASF compliance check must flag this as a violation. Implement a post-task reconciliation check in `orchestrator-mcp` or `verification-mcp`.
  5. **Skill gate**: the `trigger-audit` skill must be updated to explicitly mandate `request_approval` for all Tier 3 tasks. This is a documentation + enforcement gap until E-10 is merged.
- **Residual risk**: Medium — no single code change can enforce this end-to-end without tests. The detection path (audit reconciliation) must be implemented.
- **Status**: UNMITIGATED (E-10 not yet implemented) — mitigations 1–3 required before merge; mitigation 4 required as part of E-10 scope

---

### T-HITL-005: Unbounded Input Length — DoS and Display Overflow

- **Severity**: P2 (Medium)
- **Attack vector**: The `action` and `reason` string arguments to `request_approval` have no length limit. A caller (or a prompt-injected instruction) passes a multi-megabyte string as `reason`, causing:
  - Terminal buffer overflow / display corruption when the string is printed to stdout;
  - Excessive memory allocation in the Node.js process before or during SQLite write;
  - Log bloat: if the raw string is written to `state.sqlite`, very large values inflate the database file.
- **Impact**: Denial of service (approval-mcp crashes or hangs, blocking all Tier 3 operations until restarted); terminal display corruption that could obscure the Y/N prompt; SQLite file grows unboundedly.
- **Required mitigations**:
  1. **Hard length cap**: enforce `action.length <= 200` and `reason.length <= 500` at the MCP tool input validation layer. Reject (throw a tool error) if exceeded — do not silently truncate, as truncation could hide part of the action being approved.
  2. **Validation order**: length check must occur before sanitization (T-HITL-001) and before any write to SQLite or stdout.
  3. **SQLite column type**: define `action` and `reason` columns with a `CHECK(length(action) <= 200)` constraint in the schema DDL — this is a defense-in-depth layer independent of the application-level check.
  4. **Error response**: when input exceeds limits, return a structured MCP error (not a crash). Claude must treat this error as an approval failure and escalate to the human operator via a fallback mechanism (e.g., a direct log warning in `LOG.md`).
- **Residual risk**: Low with hard caps enforced at the tool input layer and SQLite constraint.
- **Status**: UNMITIGATED (E-10 not yet implemented) — **REQUIRED before merge**

---

### approval-mcp Threat Mitigation Summary

| Threat ID | Vector | Severity | Mitigation Status |
|---|---|---|---|
| T-HITL-001 | ANSI/terminal injection via `action`/`reason` | P0 | UNMITIGATED — required before merge |
| T-HITL-002 | SQLite path traversal / hardcode requirement | P0 | UNMITIGATED — required before merge |
| T-HITL-003 | Auto-approval without human interaction (TTY bypass, timeout default) | P0 | UNMITIGATED — required before merge |
| T-HITL-004 | Gate circumvention (not registered, safe-exec miss, no audit reconciliation) | P1 | UNMITIGATED — required before merge |
| T-HITL-005 | Unbounded input length (DoS, display overflow) | P2 | UNMITIGATED — required before merge |

**P0 count: 3. All P0 threats are unmitigated pending E-10 implementation.**

The implementation of `approval-mcp` is conditionally cleared for development. `[SEC_CLEARED]` status will be granted only after the following are verified in code review:
- T-HITL-001: `action`/`reason` sanitized before `process.stdout` write; raw value logged to SQLite.
- T-HITL-002: DB path is a hardcoded constant; canonical path validated on startup.
- T-HITL-003: `process.stdin.isTTY` asserted; no timeout-to-APPROVED; no `--auto-approve` path in production code.
- T-HITL-004: Server registered in `registry.json` and `.mcp.json`; CI test for Tier 3 → approval flow.
- T-HITL-005: `action <= 200 chars`, `reason <= 500 chars` enforced with rejection (not truncation).

---

_approval-mcp section generated by security_engineer agent — 2026-04-14 (E-10 pre-implementation review)._

---

## E-379 / D-130 — privacy redaction at write time (security_engineer, 2026-10-28)

Threat detail: THREAT_MODEL.md `T-PRIVACY-001`. Surface: `redact()` in `src/shared/publish-scan.mjs`
and its wrapped writers. Harness: E-278 throwaway (pure copy of publish-scan.mjs, secret-rule.mjs,
is-main.mjs in `mktemp -d`, `env -i`, CPU/file caps; `-u` raised to the user's current thread count
+ 64 and `-v` to 2 GB because node cannot start under the literal caps). All values invented.

### Pen-Test Results

| OWASP | Surface | Payload (truncated) | Verdict | Harness exit | Notes |
|---|---|---|---|---|---|
| A04 | redact operator_name | name with U+200B inside | EXPLOITED | 0 | scanText finds it on the NFC/Cf-stripped line; redact replaces the literal match in the ORIGINAL text, so nothing is replaced and nothing is logged |
| A04 | redact operator_name | NFD spelling of a listed NFC name | EXPLOITED | 0 | same root cause |
| A04 | redact operator_name | listed address with U+200B before the TLD | EXPLOITED | 0 | same root cause |
| A04 | redact operator_name | upper-case listed name | RESISTED | 0 | |
| A04 | redact operator_name | full name split over two lines | RESISTED | 0 | only because the single name is listed too; residual |
| A04 | redact client_name | client name with U+200B | EXPLOITED | 0 | scanText applies client regexes to the raw line (no Cf strip) |
| A04 | redact client_name | upper-case client | RESISTED | 0 | |
| A04 | stop hook | address cut at 100 chars (`bob@private-dom`) | EXPLOITED | 0 | the hook truncates BEFORE redact; a TLD-less fragment isn't an address to EMAIL_RE |
| A03 | redact personal_email | `https://bob@private.no` in prose | EXPLOITED | 0 | URL-userinfo exemption is inherited from scanText |
| A03 | redact personal_email | `bob@private.no:fixed` | EXPLOITED | 0 | SSH-remote exemption is inherited from scanText |
| A03 | redact personal_email | full-width `＠` | EXPLOITED | 0 | no NFKC fold |
| A03 | redact home_path | `C:\Users\<u>\`, `%2Fhome%2F<u>`, `\/home\/<u>` | EXPLOITED | 0 | Windows, URL-encoded and JSON-escaped spellings not covered |
| A03 | redact home_path | `/home/<u>/x`, `~<u>/y` | RESISTED | 0 | |
| A03 | redact session_socket | upper-case UUID | RESISTED | 0 | |
| A02 | redact secret | prefix token | RESISTED | 0 | |
| A02 | redact secret | `KEY = value` across tokens | RESISTED | 0 | whole line redacted |
| A02 | redact secret | markdown-escaped prefix token (`_` → `\_`) | EXPLOITED | 0 | renders as the live token in TASKS.md/REPO_MAP.md |
| A04 | redact list loader | regex metacharacters and a lone surrogate as list values | RESISTED | 0 | no throw |
| A04 | scanText/redact ReDoS | 40 000-char letter run | EXPLOITED | 0 | 0.9 s; quadratic in EMAIL_RE `[...]+@` (unanchored). 200 KB was killed by the cap (≈23 s). A bounded lookbehind form is linear (0 ms at 200 KB) |
| A04 | redact | 20 000 repeated hits (340 KB) | INCONCLUSIVE | 0 | 2.5 s: one global replace per duplicate finding; dedupe |
| A03 | stop hook | `$(…)`, backticks, `${X:=}`, quotes, printf formats | RESISTED | 0 | bash replica; failure of the filter yields the placeholder (fail open) |
| A05 | redact | `AI_PRIVACY_REDACT=0` | EXPLOITED | 0 | disables all redaction; settable by a project's `.claude/settings.json` env (T-HOOKENV class); no pre-commit scan exists yet |

Unit runs: `node --test tests/unit/privacy-cases.test.mjs tests/unit/publish-scan.test.mjs` → 68/68.
Gating: 11 EXPLOITED and 1 INCONCLUSIVE rows block Tier 3 sign-off for E-379 until fixed and re-run.

---

## E-378 / D-129 — public bootstrap snapshot and the commit/CI privacy gate (security_engineer, 2026-10-28)

Threat detail: THREAT_MODEL.md `T-PRIVACY-002`. Surfaces: the staged `precommitProblems` /
`treeGateProblems` and the `precommit` / `scan-tree` CLIs in `src/shared/publish-scan.mjs`, the
pre-commit hook step, `src/templates/public/privacy.yml`, and the snapshot builder (scratchpad
`e378_snapshot.mjs`) with its one-commit copy. Harness: E-278 throwaway (pure copy of the staged
module, secret-rule.mjs, is-main.mjs; a git fixture repo with `HOME=$T`; `env -i`; CPU/file caps;
`-u` = current user threads + 64 because Linux counts every process the user owns). All payload
values were invented. Snapshot probes report file paths and classes only.

Snapshot (one-commit copy, 587 files): the operator's list values, in raw, folded, URL, `\u`, HTML,
base64 (3 alignments), hex, UTF-16, separator, reversed and slug forms, appear only in the D-124
allowed files (NOTICE, SECURITY.md, package.json). Decoded-form scans (JSON strings, URL-decoded,
HTML-decoded, base64 blobs, wasm strings) found 0 hits. There are no real credentials: every token
shape is under `tests/fixtures` and is fake, and the secret-keyword lines are documentation. Hostname
0, Windows user 0 (outside allowed files), `.gitattributes` none, 3 wasm files with no build paths.
The commit metadata is noreply and unsigned, with tz +0100.

### Pen-Test Results

| OWASP | Surface | Payload (truncated) | Verdict | Harness exit | Notes |
|---|---|---|---|---|---|
| A04 | precommitProblems | plain personal address (control) | RESISTED | 0 | |
| A04 | precommitProblems | UTF-16LE text file with an address | EXPLOITED | 0 | NUL ⇒ "binary" ⇒ skipped |
| A04 | precommitProblems | NUL byte, then an address | EXPLOITED | 0 | the same skip; any text can opt out |
| A04 | precommitProblems | address / `home/<u>/` / operator name in a FILE NAME | EXPLOITED | 0 | paths are never scanned |
| A02 | precommitProblems / scan-tree | PAT-shaped token, AWS secret-key line | EXPLOITED | 0 | the gate has no `secret` class (containsSecret is used by redact() only); privacy.yml claims it checks secrets |
| A03 | precommitProblems | URL-encoded address, `\u`-escaped name, HTML-entity name, base64 address | EXPLOITED | 0 | no decoding pass; a Python `json.dumps` writer emits the `\u` form of a diacritic name |
| A04 | precommitProblems | address in EXEMPT_FILES (publish-scan.test.mjs) | EXPLOITED | 0 | by design for structural classes; still a hole |
| A04 | precommitProblems | `C:\Users\<u>`, `/root/...`, `~/.claude/projects/-home-<u>-…`, 32-hex session id, `<u>@<host>:~$` prompt | EXPLOITED | 0 | not in any class (`/mnt/c/Users/<u>` RESISTED via HOME_RE) |
| A04 | precommitProblems | operator name split by a newline, in markdown, or dotted | RESISTED | 0 | only because the surname alone is listed |
| A07 | identity rule | upper-cased noreply, personal author only, personal committer only | RESISTED | 0 | exact match; fails closed |
| A07 | identity rule | `--author`, `GIT_AUTHOR_EMAIL` env, `-c user.email` | RESISTED | 0 | git exports these to the hook; `git var` sees them |
| A07 | identity rule | contributor mode (no local list) with a personal author | EXPLOITED | 0 | the operator loses the identity check by moving one gitignored file |
| A01 | hook bypass | `--no-verify`, `-c core.hooksPath=…`, cherry-pick, revert, merge, `commit-tree` | EXPLOITED | 0 | no pre-commit hook runs; cherry-pick kept a personal author |
| A01 | hook activation | `.ai/publish.json` absent from the worktree (`git rm` / `mv`) | EXPLOITED | 0 | the gate returns [] and one staged deletion disables it for good |
| A04 | precommit CLI | file → symlink type change (status T) to a `/home/<u>` target | EXPLOITED | 0 | `--diff-filter=ACMR` drops T |
| A04 | scan-tree CLI | new symlink to `/home/<u>/…` | EXPLOITED | 0 | readFileSync follows the link → ENOENT → skipped; the target text is never scanned |
| A05 | hook → installed helper | `~/.rein/shared/publish-scan.mjs precommit` (stale install, no such CLI) | EXPLOITED | 0 | rc 0, no output; the hook prints "✓ privacy gate". This is the CURRENT installed state |
| A05 | CI job | snapshot's own publish-scan.mjs `scan-tree` (built from HEAD f98f00c) | EXPLOITED | 0 | rc 0, no output ⇒ the privacy CI is green and checks nothing |
| A05 | CLI | unknown subcommand typo | EXPLOITED | 0 | rc 0 silently |
| A08 | snapshot | latest snapshot vs current builder | EXPLOITED | 0 | rein-snapshot-ynvxhF predates the builder edit: no `.ai/publish.json`, no privacy.yml, no gate code |
| A09 | bootstrap step 7 | tag in the one-commit clone | EXPLOITED | n/a | the clone has no repo-local identity and the global identity is personal ⇒ the annotated tag's `tagger` would be the personal address; no hook checks tags |
| A09 | commit metadata | commit message / trailers / tagger | EXPLOITED | n/a | no commit-msg hook; CI scans the tree only |

Unit run: `node --test tests/unit/publish-scan.test.mjs` → 53/53.
Gating: EXPLOITED rows block Tier 3 sign-off for E-378. The P0s (tag tagger identity, stale snapshot
without the gate, CLI fail-open) must be fixed before the first push.

## E-383 / D-132 — rename compatibility layer (security_engineer, 2026-10-29)

Scope: the env resolver (env.mjs, `rein_legacy_env_apply`), the hook scrub, the installer move,
the gate MIRROR, settings/sync and legacy key reads. Threat entry: THREAT_MODEL.md T-RENAME-001.
Findings: P1 secret-rule.mjs SECRETS_DIR matches only the new name. P2 the pre-tool-use.sh:360
fallback grep and classifier-backstop.py RULE name only the new path. P2 src/bin/ai
CI_ENV_RESERVED_* dropped the old-prefix reservation HEAD had. P3 the installer's `mv` has no `-T`.

### Pen-Test Results

Harness: a mktemp HOME, `env -i`, `ulimit -t 5 -f 10240`. `ulimit -u 64` was dropped for node:
RLIMIT_NPROC counts every process the user owns, so V8 could not start its worker threads (RC 134).

| OWASP | Surface | Payload (truncated) | Verdict | Harness exit | Notes |
|---|---|---|---|---|---|
| A01 | gate-guard selfDisableHits | redirect / `rm -rf` / `cp` / `sed -i` into the old path's hooks | RESISTED | 0 | the old path is a symlink to ~/.rein |
| A01 | gate-guard relative / cd / -C / parent | `cd ~ && rm <old>/run/x`, `cd <old> && echo >…`, `../..$HOME/<old>/…` | RESISTED | 0 | |
| A01 | isUnderAiOs | `<old>/hooks/x.sh`, `<old>/new/f` (not yet created) | RESISTED | 0 | realpath folds the path onto ~/.rein |
| A01 | secret-rule containsSecret | `cat <old>/secrets/role-token.key` | EXPLOITED | 0 | the same command with `.rein` is blocked, so the role-token key can be read through the old name |
| A01 | secret-rule containsSecret | `base64 <old>/secrets/*` | EXPLOITED | 0 | |
| A05 | rein_legacy_env_apply | old TC_NODE, LOCATE_DEV, LOCATE_UNTRUSTED_ENV, CALLER_ROLE, PANE_ROLE | RESISTED | 0 | never mapped |
| A05 | rein_legacy_env_apply | old WORKSPACE=/decoy while REIN_WORKSPACE is set but empty | RESISTED | 0 | the new name wins even when empty |
| A05 | rein_legacy_env_apply | old HOME, old CLAIM_GATE=0 | RESISTED | 0 | mapped, but this reaches only what setting the new name reaches |
| A05 | `_ci_local_env` reservation | old-name WORKSPACE in .ai/ci.local.json | EXPLOITED | n/a | found by reading the code, not run: only REIN_* is reserved now |

Gating: the A01 EXPLOITED rows block Tier 3 sign-off for E-383 until SECRETS_DIR covers both names.
