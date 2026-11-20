#!/usr/bin/env node
/**
 * safe-exec-mcp — Rein UACS MCP Server
 * Analyzes shell commands for destructive or high-risk patterns before execution.
 * Uses token-based parsing (shell-quote) to detect rm -rf, curl|bash, etc.
 *
 * E-102/E-123 (sovereignty-hardening.md §Data Model): also accepts an optional
 * caller_role. When the role is 'architect', these are BLOCKED with a
 * [SOVEREIGNTY_BLOCK] verdict: destructive implementation git ops + file
 * mutations outside .ai/ and plans/ (E-102); and merge/branch/remote git ops
 * (merge/rebase/push/pull/branch) + deployment commands (ssh/rsync/scp/
 * `npm publish`/`docker push`) which are strictly Engineer tasks (E-123).
 * No environment switch (D-084 r1, D-087 r3); the role comes from the session token (E-294).
 *
 * Tools:
 *   analyze_command(command, caller_role?) → risk assessment with PASS/WARN/BLOCK verdict
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { instrument } from "../../shared/mcp-telemetry.mjs";
import { containsSecret } from "./secret-rule.mjs";
import { selfDisableHits } from "./gate-guard.mjs";
import { stripInertHeredocs } from "./heredoc.mjs";
import { ARCHITECT, ENGINEER, mintToken, verifyToken, ROLE_UNVERIFIED_LINE } from "./role-token.mjs";
import { claimGateFor, claimReport } from "./claim-gate.mjs";
import { foldVerbs } from "./verb-fold.mjs";
import { expandAssignedVerbs } from "./assigned-verbs.mjs";
import { shellTokens as _tokens } from "./tokens.mjs";
import { _tooLarge } from "./input-limits.mjs";
import { pipeHit } from "./pipe-shell.mjs";
import { rmRootHit, rmRecursiveForce } from "./rm-root.mjs";
import { analyzeSovereignty } from "./sovereignty.mjs";
import { pathAnalysis, gateRole } from "./path-gate.mjs";
export { pathAnalysis };
import { createLogger } from "../shared/logger.js";

// ── Structured logger (obs_baseline §Logging) ────────────────────────────────
const logger = createLogger("safe-exec-mcp");

const server = new Server(
  { name: "safe-exec-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Risk rule definitions ─────────────────────────────────────────────────────

// E-289 (D-082 ruling 1): there is NO research-command bypass any more. P-25 exempted
// commands whose FIRST word was grep/cat/… from SECRET_IN_COMMAND, so `grep x f &&
// export TOKEN=<real>` skipped the scan. A per-segment splitter was rejected after the
// E-289 review exploited six shapes of it (`&`, `<(…)`, subshell parens, `find -exec`,
// `rg --pre`, redirection/heredoc). Since E-287 the rule needs a credential-SHAPED value,
// so prose and ordinary searches no longer trip it: secret-cases.json is 0/26 over-block
// without the bypass. A search for a real token blocks — search by prefix instead.

// Normalize a command string for secret scanning — strips basic obfuscation:
// quoted string concatenation (token="sec""ret"), backslash escapes, and outer quotes.
function normalizeForSecretScan(raw) {
  return raw
    .replace(/""/g, "")      // remove adjacent double-quote pairs (concat obfuscation)
    .replace(/''/g, "")      // remove adjacent single-quote pairs
    .replace(/\\(.)/g, "$1") // collapse backslash escapes: \x → x
    .replace(/["']/g, "");   // strip remaining quotes
}

const BLOCK_RULES = [
  {
    id: "RM_RF_ROOT",
    pattern: (tokens, raw) => rmRootHit(tokens, raw),
    message: "rm -rf on root/home paths — BLOCKED (irreversible data destruction)",
  },
  {
    id: "CURL_PIPE_SHELL",
    // E-291 (D-083): an INERT heredoc body (quoted delimiter, cat/tee, no pipe) is prose,
    // not a pipeline — stripped before matching. See heredoc.mjs for what counts as inert.
    pattern: (tokens, raw) => pipeHit(/curl[^|]+\|.*(bash|sh|zsh|python)/i, raw),
    message: "curl | shell — BLOCKED (remote code execution risk)",
  },
  {
    id: "WGET_PIPE_SHELL",
    pattern: (tokens, raw) => pipeHit(/wget[^|]+\|.*(bash|sh|zsh|python)/i, raw),
    message: "wget | shell — BLOCKED (remote code execution risk)",
  },
  {
    id: "DROP_TABLE",
    pattern: (tokens, raw) => /DROP\s+TABLE|TRUNCATE\s+TABLE/i.test(raw),
    message: "SQL DROP/TRUNCATE — BLOCKED (irreversible database operation)",
  },
  {
    id: "FORK_BOMB",
    pattern: (tokens, raw) => raw.includes(":(){ :|:& };:") || raw.includes(":(){ :|:&};:"),
    message: "Fork bomb detected — BLOCKED",
  },
  {
    id: "DD_DISK_WIPE",
    pattern: (tokens, raw) => /\bdd\b.*\bif=\/dev\/(zero|urandom|random)\b.*\bof=\/dev\/(sd[a-z]|nvme|hd[a-z]|disk\d)/i.test(raw),
    message: "dd writing zeros/random to a raw disk device — BLOCKED (irreversible disk wipe)",
  },
  {
    id: "MKFS",
    pattern: (tokens, raw) => /\bmkfs\.[a-z0-9]+\b/i.test(raw) || /\bmkfs\s+/i.test(raw),
    message: "mkfs invocation — BLOCKED (formats a filesystem, irreversible data loss)",
  },
  {
    id: "FIND_DELETE_ROOT",
    pattern: (tokens, raw) => /\bfind\s+(\/|\/root|\/home|\/etc|\/usr|\/var|\/boot)\b.*-delete\b/i.test(raw),
    message: "find / -delete on system path — BLOCKED (mass deletion of system files)",
  },
  {
    id: "REDIRECT_TO_SYSTEM_FILE",
    pattern: (tokens, raw) => />\s*\/etc\/(passwd|shadow|sudoers|hosts)\b/i.test(raw) || />\s*\/dev\/sd[a-z]\b/i.test(raw),
    message: "Redirect to critical system file — BLOCKED (system corruption / privilege escalation)",
  },
  {
    id: "CHMOD_ROOT",
    pattern: (tokens, raw) => /\bchmod\s+(-R\s+)?(777|a\+rwx)\s+(\/|\/etc|\/usr|\/var|\/root|\/boot)\b/i.test(raw),
    message: "chmod 777 on system path — BLOCKED (privilege escalation vector)",
  },
  {
    // E-291 (D-083 r5): the agent must not switch its own gate off — `rein gate`, the override
    // file, or a write into ~/.rein/. Every role. See gate-guard.mjs for the ceiling.
    id: "GATE_SELF_DISABLE",
    pattern: (tokens, raw) => selfDisableHits(raw).length > 0,
    message: "agent self-disable of the safe-exec gate (`rein gate`, the override file, or a write under ~/.rein/) — " +
      "BLOCKED for every role. Operator escape — in YOUR terminal, not through the agent: rein gate off",
  },
  {
    id: "SECRET_IN_COMMAND",
    // E-287 (D-078): keyword in assignment/flag form AND a credential-shaped value, or a
    // known-prefix token anywhere — see secret-rule.mjs. The old keyword-plus-any-word
    // match blocked prose ("token usage", "Secret Rule Precision").
    pattern: (tokens, raw) => containsSecret(normalizeForSecretScan(raw)),
    message: "Plaintext secret in command — BLOCKED (credential exposure risk). To search for a " +
      "token, search by its prefix (e.g. ghp_) or read the pattern from a file — never put the value in the command",
  },
];

const WARN_RULES = [
  {
    id: "RM_RF",
    pattern: (tokens) => rmRecursiveForce(tokens),
    message: "rm -rf detected — verify target path is intentional",
  },
  {
    id: "DD_DEVICE",
    pattern: (tokens, raw) => /\bdd\b.*\bof=\/dev\//i.test(raw),
    message: "dd writing to device file — verify this is intentional",
  },
  {
    id: "CHMOD_777",
    pattern: (tokens, raw) => /chmod\s+(777|a\+rwx)/i.test(raw),
    message: "chmod 777 — grants world-writable permissions",
  },
  {
    id: "SUDO_SU",
    // Only flag -i/--login/su when they belong to the sudo invocation (appear
    // right after `sudo`, past any of sudo's own flags) — not an unrelated -i on
    // some other command (e.g. `sudo apt install -i pkg`, `sudo grep -i x`).
    pattern: (tokens, raw) => /\bsudo\s+(-\w+\s+)*(-i|--login|su)\b/.test(raw),
    message: "sudo su / sudo -i — privilege escalation",
  },
  {
    id: "GIT_FORCE_PUSH",
    pattern: (tokens, raw) => /git push.*--force|git push.*-f\b/i.test(raw),
    message: "git push --force — can overwrite remote history",
  },
  {
    id: "HISTORY_CLEAR",
    pattern: (tokens, raw) => /history\s+-[cwC]|rm\s+~\/\.bash_history|:\s*>\s*~\/\.bash_history/i.test(raw),
    message: "Shell history clearing — potential audit trail destruction",
  },
];

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "analyze_command",
      description:
        "Analyzes a shell command for destructive or high-risk patterns. Returns PASS, WARN, or BLOCK verdict with detailed reasoning. E-102: pass caller_role to enforce Triad sovereignty — when 'architect', destructive implementation git/file operations outside .ai/ and plans/ are BLOCKED with [SOVEREIGNTY_BLOCK].",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command string to analyze",
          },
          caller_role: {
            type: "string",
            enum: ["architect", "engineer", "tester"],
            description: "E-102/E-123 (sovereignty-hardening.md §Data Model): the requesting Triad role. When 'architect', these are BLOCKED with [SOVEREIGNTY_BLOCK]: git reset/revert/checkout/clean and rm -rf/mkdir/touch outside .ai//plans/ (E-102); and — strictly Engineer-only — git merge/rebase/push/pull/branch plus deployment commands ssh/rsync/scp/`npm publish`/`docker push` (E-123). Omitting caller_role preserves legacy (role-agnostic) analysis. Advisory: the enforcing gate takes the role from the session token, never from this argument.",
          },
        },
        required: ["command"],
      },
    },
  ],
}));

// ── Core analysis (shared by the MCP tool AND the --check CLI gate, E-125) ─────
// SINGLE source of truth: the fail-closed PreToolUse gate (hooks/pre-tool-use.sh)
// runs `--check`, which calls THIS exact logic — so the gate ENFORCES the same
// verdicts the analyze_command tool reports (no advisory/enforcement drift).
// Returns { verdict: "PASS"|"WARN"|"BLOCK", blocked, warned, sovereignty, report }.
// E-291 (D-083 r8): what an ACTIVE operator override still blocks. The override lifts the
// policy gate, not the catastrophic backstop, and never the self-disable guard (else an
// active override would let the agent extend itself).
const OVERRIDE_ENFORCED = new Set([
  "GATE_SELF_DISABLE", "RM_RF_ROOT", "FORK_BOMB", "MKFS", "DD_DISK_WIPE", "CURL_PIPE_SHELL", "WGET_PIPE_SHELL",
]);

// D-085 r1 (amends D-084 r2): the quoted-heredoc body exemption applies to THESE rules only —
// the three that over-blocked on prose. Every other rule, and the Architect write and
// sovereignty analyzers, scan the full text: a future lexer gap then hides content from three
// content rules, not from the write gate, and D-056's frozen write gate keeps its behaviour.
const HEREDOC_EXEMPT_RULES = new Set(["CURL_PIPE_SHELL", "WGET_PIPE_SHELL", "GATE_SELF_DISABLE", "SECRET_IN_COMMAND"]);

// Exported for the in-process contract table (E-340, tests/unit/operand-scope.test.mjs).
export function runAnalysis(original, callerRole, { override = false } = {}) {
  // The body of a quoted heredoc whose consumer is a plain file sink is TEXT for the
  // HEREDOC_EXEMPT_RULES (heredoc.mjs decides what counts as inert). The report still quotes
  // the command as given.
  // D-145 r2: a gate verb matches without regard to case — every rule reads the verb-folded text;
  // the report still quotes the command as given.
  const full = foldVerbs(String(original));
  const tooLarge = _tooLarge(full);
  if (tooLarge) {
    const blocked = [{ id: "INPUT_TOO_LARGE", message: tooLarge }];
    const report = [`## safe-exec-mcp Analysis`, `Rule: INPUT_TOO_LARGE`, `Command: \`${full.slice(0, 120)}\``, `Verdict: ✗ BLOCK`, ``,
      "### BLOCKED — Do Not Execute", `- [INPUT_TOO_LARGE] ${blocked[0].message}`].join("\n");
    return { verdict: "BLOCK", blocked, warned: [], sovereignty: [], report };
  }
  const stripped = stripInertHeredocs(full);
  const fullTokens = _tokens(full);
  const strippedTokens = stripped === full ? fullTokens : _tokens(stripped);
  const hits = (r) => (HEREDOC_EXEMPT_RULES.has(r.id) ? r.pattern(strippedTokens, stripped) : r.pattern(fullTokens, full));

  const blocked = BLOCK_RULES.filter(hits).filter((r) => !override || OVERRIDE_ENFORCED.has(r.id));
  const warned = WARN_RULES.filter(hits);

  // E-102/E-123: Architect sovereignty enforcement (sovereignty-hardening.md §API), on the full
  // text. No environment switch (D-084 r1, D-087 r3): the only lift is the operator override.
  let sovereignty = [];
  if (!override && callerRole === "architect") {
    const sovText = stripInertHeredocs(full, { readOnlyLines: true });
    sovereignty = analyzeSovereignty(sovText === full ? fullTokens : _tokens(sovText), sovText, fullTokens, full);
    // E-353 (D-112 r3 a): a verb held in a name (`g=git; $g push`, `alias g=git; g push`) is the
    // verb — the same rules run on the text with those uses expanded; the verdict is the union.
    const expSov = expandAssignedVerbs(sovText);
    if (expSov !== sovText) {
      const expFull = expandAssignedVerbs(full);
      const seen = new Set(sovereignty.map((v) => v.id));
      for (const v of analyzeSovereignty(_tokens(expSov), expSov, _tokens(expFull), expFull)) {
        if (!seen.has(v.id)) { seen.add(v.id); sovereignty.push(v); }
      }
    }
  }

  const verdict = blocked.length > 0 || sovereignty.length > 0 ? "BLOCK" : warned.length > 0 ? "WARN" : "PASS";
  const icon = verdict === "BLOCK" ? "✗" : verdict === "WARN" ? "⚠" : "✓";

  // E-432 (security_engineer P2-1): the rule a block is attributed to, on a fixed line BEFORE the
  // command echo — the hook's telemetry reads the first `Rule:` line, so text in the command cannot
  // choose it. The first id printed: a sovereignty violation, then a policy block.
  const lines = [
    `## safe-exec-mcp Analysis`,
    ...(verdict === "BLOCK" ? [`Rule: ${(sovereignty[0] ?? blocked[0]).id}`] : []),
    `Command: \`${String(original).slice(0, 120)}\``,
    `Verdict: ${icon} ${verdict}`,
    ``,
  ];
  if (sovereignty.length > 0) {
    lines.push("### [SOVEREIGNTY_BLOCK] — Forbidden Architect Operation");
    sovereignty.forEach((v) => lines.push(`- [${v.id}] ${v.message}`));
    lines.push("");
    lines.push("The Architect role may not run destructive implementation commands (sovereignty-hardening.md §Components 1). Switch to the Engineer to execute this, or rescope the command to .ai/ or plans/.");
  }
  if (blocked.length > 0) {
    lines.push("### BLOCKED — Do Not Execute");
    blocked.forEach((r) => lines.push(`- [${r.id}] ${r.message}`));
    lines.push("");
    lines.push("Add [SEC_CLEARED] to .ai/LOG.md with Architect approval before retrying.");
  }
  if (warned.length > 0) {
    lines.push("### Warnings — Verify Before Executing");
    warned.forEach((r) => lines.push(`- [${r.id}] ${r.message}`));
  }
  if (blocked.length === 0 && warned.length === 0 && sovereignty.length === 0) {
    lines.push("No high-risk patterns detected.");
  }

  return { verdict, blocked, warned, sovereignty, report: lines.join("\n") };
}

instrument(server, "safe-exec-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== "analyze_command") {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  // Advisory tool: it reports, it does not gate. The caller's own caller_role selects the rule
  // set it wants to see; the enforcing paths below never read it.
  const { report } = runAnalysis(args.command, args.caller_role || "");
  return { content: [{ type: "text", text: report }] };
});

// ── E-294: mint the session role token and exit ──────────────────────────────────────────
// `node index.js --mint-token <session_id> <session pid>` — invoked by the SessionStart hook
// with the harness's session id and the hook's own PPID (bash's, not an environment read).
// NO role in argv: the role is the launch-record walk's (D-087 r2). Prints "<role>\t<launch>"
// for the token now bound to this session (minted or already bound), nothing on a refusal.
// Always exits 0: the hook is fail-open; the GATE is where a missing token blocks.
// Bound to argv[2] (E-208): a bare indexOf let another mode's arguments capture this block.
if (process.argv[2] === "--mint-token") {
  const r = mintToken(process.argv[3], process.argv[4]);
  if (r.role) process.stdout.write(`${r.role}\t${r.launch}\n`);
  process.exit(0);
}

// ── E-214/E-294: role lookup for callers that hold a session id but no payload ─────────────
// `node index.js --verify-role <session_id>` prints the verified role and exits 0, or prints
// nothing and exits 1. Used by `pre-commit` and caller-role.mjs. The token verifies only when
// its session process is an ANCESTOR of this process with the recorded start time, so a
// session id taken from another session (CLAUDE_CODE_SESSION_ID=<theirs>) verifies nothing.
if (process.argv[2] === "--verify-role") {
  const vrSid = process.argv[3] || "";
  const verified = vrSid ? verifyToken(vrSid) : null;
  if (!verified) process.exit(1);
  process.stdout.write(verified);
  process.exit(0);
}

// E-292 (D-082 r2): the gate CLI modes answer within 10 s or exit 4 (TIMEOUT), which the hook
// treats as no verdict and BLOCKS (E-289). unref'd, so it never holds a finished check open.
// A timer fires only while the event loop is free: a synchronous hang (a catastrophic regex)
// never yields, so the hook ALSO bounds this process from outside (perl alarm → rc 142 → 4).
if (process.argv.includes("--check") || process.argv.includes("--check-path")) {
  setTimeout(() => {
    process.stderr.write("[safe-exec] TIMEOUT: no verdict within 10 s — blocked (E-292)\n");
    process.exit(4);
  }, 10_000).unref();
}

// ── E-208: Write/Edit sovereignty gate CLI (role-abstraction.md §Components 5) ──
// `node index.js --check-path "<path>" --session <sid> [--session-pid <pid>]` exits 2 when the
// write is blocked for the session's role, 0 otherwise. hooks/pre-tool-use.sh calls this for
// Write|Edit|MultiEdit|NotebookEdit, passing its own PPID as --session-pid (the hot path: the
// token must be bound to exactly that process). A verified engineer is a fast exit 0; an
// unverified session gets the union (the Architect's path rules + ROLE_UNVERIFIED_LINE).
const _checkPathIdx = process.argv.indexOf("--check-path");
if (_checkPathIdx !== -1) {
  const target = process.argv[_checkPathIdx + 1] || "";
  const { role: pathRole, verified } = gateRole(_checkPathIdx + 2);
  let verdict;
  try {
    if (pathRole === ARCHITECT && process.env.REIN_SAFE_EXEC_SELFTEST_THROW === "1") throw new Error("self-test fault injection");
    verdict = pathAnalysis(target, pathRole);
  } catch (e) {
    // FAIL-CLOSED, same rule as --check (T-HITL-004): a crash must block, never allow.
    // E-432 (security_engineer, second pass): the error text goes to stderr, never into the report
    // the hook reads its `Rule:` line from (a crash report carries none).
    process.stderr.write(`safe-exec --check-path: ${e.message}\n`);
    process.stdout.write(
      "## safe-exec-mcp Sovereignty Analysis\nVerdict: ✗ BLOCK\n\n" +
      "### BLOCKED — analyzer error (fail-closed)\n" +
      "The path gate crashed; the write is blocked rather than allowed (the error is on stderr).\n"
    );
    process.exit(2);
  }
  if (verdict.id === "GATE_SELF_DISABLE") {
    process.stdout.write(
      "## safe-exec-mcp Path Analysis\nRule: GATE_SELF_DISABLE\nVerdict: ✗ BLOCK\n\n" +
      "### BLOCKED — GATE_SELF_DISABLE\n" +
      `Path: ${target}\nReason: inside ~/.rein/ (the Rein install: hooks, gate, secrets) — no role writes there; ` +
      "only `bash install-rein.sh`, `rein install`, `rein sync` and `rein doctor` do.\n"
    );
    process.exit(2);
  }
  if (pathRole !== ARCHITECT) {
    // E-331 (D-102 §4): the Engineer claim gate — team projects only; a crash blocks.
    if (pathRole === ENGINEER) {
      let cv;
      try { cv = await claimGateFor({ path: target }); }
      catch (e) { cv = { code: "CLAIM_GATE_ERROR", message: `the claim gate crashed; the write is blocked rather than allowed: ${e.message}` }; }
      if (cv) {
        process.stdout.write(claimReport(cv, `Path: ${target}`));
        process.exit(2);
      }
    }
    process.exit(0);
  }
  if (verdict.blocked) {
    process.stdout.write(
      "## safe-exec-mcp Sovereignty Analysis\nRule: ARCH_WRITE_OUTSIDE_SCOPE\nVerdict: ✗ BLOCK\n\n" +
      "### BLOCKED — ARCH_WRITE_OUTSIDE_SCOPE\n" +
      (verified ? "Role: architect (HMAC-verified session token)\n" : `${ROLE_UNVERIFIED_LINE}\n`) +
      `Path: ${target}\n` +
      `Reason: ${verdict.reason}.\n\n` +
      "The Architect designs; the Engineer implements (§35 ANTI-DRIFT, D-054).\n" +
      "Write the blueprint under .ai/ and hand the change-list to the Engineer via `skill: rein-handoff` (SendMessage).\n"
    );
    process.exit(2);
  }
  process.exit(0);
}

// ── E-125/E-129/E-294: fail-closed pre-execution gate CLI (sovereignty-hardening.md / T-HITL-004) ──
// `node index.js --check "<command>" --session <sid> [--session-pid <pid>] [--override]` runs
// the same analysis the analyze_command tool uses and EXITS 2 on a BLOCK verdict (fail-closed),
// 0 otherwise. hooks/pre-tool-use.sh invokes this on every Bash tool call. The role is the
// verified token's; without one the union applies. Running in --check mode short-circuits
// before the stdio server connects.
const _checkIdx = process.argv.indexOf("--check");
if (_checkIdx !== -1) {
  const cmd = process.argv[_checkIdx + 1] || "";
  const { role, verified } = gateRole(_checkIdx + 2);
  if (!cmd) {
    process.stderr.write("[safe-exec --check] no command provided\n");
    process.exit(0); // empty input is not an error — nothing to gate
  }
  let result;
  try {
    // E-128: fault-injection self-test hook so the suite can verify the
    // fail-closed guarantee deterministically. SAFE — it can only ADD restriction
    // (force a block), never bypass the gate, so honouring it from env is harmless.
    if (process.env.REIN_SAFE_EXEC_SELFTEST_THROW === "1") throw new Error("self-test fault injection");
    result = runAnalysis(cmd, role, { override: process.argv.includes("--override") });
  } catch (e) {
    // E-128 (sovereignty-hardening.md): the error path is FAIL-CLOSED. An internal
    // analyzer crash must BLOCK (exit 2), not allow — a fail-open error path would
    // be a gate-circumvention vector (T-HITL-004: crash the analyzer to bypass it).
    process.stderr.write(`[safe-exec --check] analyzer error — FAILING CLOSED (blocking): ${e.message}\n`);
    process.stdout.write(
      "## safe-exec-mcp Analysis\nVerdict: ✗ BLOCK\n\n" +
      "### BLOCKED — analyzer error (fail-closed)\n" +
      "The safe-exec analyzer crashed; the command is blocked rather than allowed " +
      "(fail-closed, T-HITL-004). Operator escape — in YOUR terminal, not through the agent: rein gate off\n"
    );
    process.exit(2);
  }
  // E-331 (D-102 §4): the Engineer claim gate on a shell write — team projects only. The
  // operator override lifts it with the rest of the policy; a crash blocks.
  if (result.verdict !== "BLOCK" && role === ENGINEER && !process.argv.includes("--override")) {
    let cv;
    try { cv = await claimGateFor({ command: cmd, tokens: _tokens(cmd) }); }
    catch (e) { cv = { code: "CLAIM_GATE_ERROR", message: `the claim gate crashed; the command is blocked rather than allowed: ${e.message}` }; }
    if (cv) {
      process.stdout.write(claimReport(cv, `Command: \`${String(cmd).slice(0, 120)}\``));
      process.exit(2);
    }
  }
  // Report always goes to stdout (clean, no node-warning noise); the EXIT CODE is
  // the machine signal the hook reads — 2 = BLOCK (fail-closed), 0 = allow.
  const unverifiedNote = !verified && result.sovereignty.length > 0 ? `\n${ROLE_UNVERIFIED_LINE}` : "";
  process.stdout.write(result.report + unverifiedNote + "\n");
  process.exit(result.verdict === "BLOCK" ? 2 : 0);
}

if (isMainModule(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
