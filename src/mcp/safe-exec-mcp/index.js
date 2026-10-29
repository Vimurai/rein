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
import { parse } from "shell-quote";
import {
  isSafeArchitectPath,
  architectPathVerdict,
  findProjectRootFrom,
  analyzeArchitectWrites,
} from "./architect-writes.mjs";
import { containsSecret } from "./secret-rule.mjs";
import { selfDisableHits, isUnderRein } from "./gate-guard.mjs";
import { stripInertHeredocs } from "./heredoc.mjs";
import { codeStrings } from "./code-strings.mjs";
import { gitRedirectHits } from "./git-redirect.mjs";
import { ARCHITECT, ENGINEER, mintToken, verifyToken, ROLE_UNVERIFIED_LINE } from "./role-token.mjs";
import { claimGateFor, claimReport } from "./claim-gate.mjs";
import { createLogger } from "../shared/logger.js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, normalize, relative, dirname, basename, resolve as resolvePath } from "node:path";

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
    pattern: (tokens, raw) => /curl[^|]+\|.*(bash|sh|zsh|python)/i.test(stripInertHeredocs(raw)),
    message: "curl | shell — BLOCKED (remote code execution risk)",
  },
  {
    id: "WGET_PIPE_SHELL",
    pattern: (tokens, raw) => /wget[^|]+\|.*(bash|sh|zsh|python)/i.test(stripInertHeredocs(raw)),
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
    // E-291 (D-083 r5): the agent must not switch its own gate off — `ai gate`, the override
    // file, or a write into ~/.rein/. Every role. See gate-guard.mjs for the ceiling.
    id: "GATE_SELF_DISABLE",
    pattern: (tokens, raw) => selfDisableHits(raw).length > 0,
    message: "agent self-disable of the safe-exec gate (`ai gate`, the override file, or a write under ~/.rein/) — " +
      "BLOCKED for every role. Operator escape — in YOUR terminal, not through the agent: ai gate off",
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasSequence(tokens, cmds, flags) {
  const strTokens = tokens.filter((t) => typeof t === "string").map((t) => String(t));
  return cmds.some((cmd) => strTokens.includes(cmd)) && flags.some((f) => strTokens.includes(f));
}

// E-125: rm invoked with BOTH recursive and force — combined (-rf/-fr/-Rfv…) OR
// SPLIT (`rm -r -f`), OR --no-preserve-root. Split flags are equivalent to -rf, so
// a fail-closed gate must treat them identically (plain hasSequence missed them).
function _shortFlagHas(strTokens, ch) {
  return strTokens.some((t) => /^-[A-Za-z]+$/.test(t) && t.slice(1).includes(ch));
}
function rmRecursiveForce(tokens) {
  const t = tokens.filter((x) => typeof x === "string").map((x) => String(x));
  if (!t.some((x) => x.split("/").pop() === "rm")) return false;   // E-340: /bin/rm is rm
  if (t.includes("--no-preserve-root")) return true;
  // E-340 review: an UPPERCASE R in a bundle (`-Rf`, `-fR`) is recursive too — the lowercase-only
  // test let `rm -Rf /` through with no warning at all.
  const recursive = t.includes("--recursive") || _shortFlagHas(t, "r") || _shortFlagHas(t, "R");
  const force = t.includes("--force") || _shortFlagHas(t, "f");
  return recursive && force;
}

// E-125: catastrophic rm targets (root/home). Tokenizers EXPAND $HOME→"" and turn
// `/*` into a glob object (both dropped from string tokens), and bare ~ slips the
// old token-only check — so also scan the raw string. Only consulted inside the
// rm-recursive-force rule, where any root/home target is irreversible.
function hasRootPaths(tokens, raw) {
  const strTokens = tokens.filter((t) => typeof t === "string").map((t) => String(t));
  if (strTokens.some((t) => /^(\/$|\/root|\/home|\/etc|\/usr|\/var|\/boot|~$|~\/|\$HOME(\/|$)|\$\{HOME\}(\/|$))/.test(t))) return true;
  if (raw == null) return false;
  const r = String(raw);
  if (/(^|[\s=])(\$HOME|\$\{HOME\})(\/|\s|$)/.test(r)) return true;  // $HOME / ${HOME} (tokenizer expands to "")
  if (/(^|\s)~(\/|\s|$)/.test(r)) return true;                      // ~ or ~/
  if (/(^|\s)\/\*(\s|$)/.test(r)) return true;                      // /* glob (dropped from tokens)
  // E-350 (D-111 r6 ii): ~user is that user's home.
  if (/(^|\s)["']?~[A-Za-z_][A-Za-z0-9_.-]*["']?(\/|\s|$)/.test(r)) return true;
  return _emptyExpansionRoot(r);
}

// E-350 (D-111 r6 ii, security_engineer P0-1): each word is normalised the way it can expand at
// its most dangerous — every expansion ($X ${X} ${X:-} $1 $@ $( ) `…`) empty, quotes and
// backslashes removed ($'/' is /), // and /./ collapsed. A word that then starts with `/` and
// whose first component is nothing, a glob, a brace list, `.` or `..` is `/`, `/*` or a set of
// top-level directories: `$A/$B/*`, `"/"*`, `\/*`, `//*`, `/{bin,usr}`. A word that BEGINS with
// ${X:?…} fails closed when X is unset (not root-form) — one nested inside $( ) or another ${ }
// exempts nothing. "$X"/dist names one subdirectory, and so does a glob with a literal part
// ("$TMPDIR"/rein-*, "$OUT"/*.log): only a bare glob, class or brace list is the whole root.
const EXPANSION = /\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?!$-]|\$\([^()]*\)|`[^`]*`/g;
const INNER_BRACE = /\$\{[^{}]*\}/g;
const BARE_GLOB = /^(\.?(\*|\?|\[[^\]]*\])+|\{[^}]*\})$/;
function _emptyExpansionRoot(r) {
  // $( ) and `…` may hold spaces, so they are emptied before the line is cut into words — on
  // whitespace AND on shell separators: `$X/*; echo` ends the operand at the `;`.
  for (const word of String(r).replace(/\$\([^()]*\)|`[^`]*`/g, "").split(/[\s;&|<>()]+/)) {
    if (!/[/$`"'\\]/.test(word) || /^["']?\$\{[A-Za-z_][A-Za-z0-9_]*:?\?/.test(word)) continue;
    let w = word.replace(/\$'/g, "'");
    for (let prev = ""; prev !== w;) { prev = w; w = w.replace(INNER_BRACE, ""); }   // ${A+${B}} inside out
    w = w.replace(EXPANSION, "").replace(/["'\\]/g, "")
      .replace(/\/(\.\/)+/g, "/").replace(/\/{2,}/g, "/").replace(/\/(\.\/)+/g, "/");
    if (!w.startsWith("/")) continue;
    const first = w.slice(1).split("/")[0];
    if (first === "" || first === "." || first === ".." || BARE_GLOB.test(first)) return true;
  }
  return false;
}

// E-340 (finding 6, 2026-10-23): `cd /home/dev/Dev/rein; …; rm -rf .ai/stale-…` was blocked
// because hasRootPaths matched the cd's /home path, not an rm operand. The rule now ignores ONE
// leading `cd <plain absolute dir> ;|&&` when that directory is not one an rm below it could
// wipe (root, a system tree at any depth, a home tree within two levels of /home): every rm
// after it then works below a project-like directory, and the rest of the line is judged
// exactly as before. Nothing else is narrowed: two cuts that split the line into simple
// commands and read each rm's own operands failed critic_security (every parser gap hid an rm),
// so the whole-line match stays the model. Also new: an rm -rf with a `..` component anywhere on
// the line blocks (`rm -rf ../../..` matched no root path).
const SAFE_CD_PREFIX = /^\s*cd\s+(\/[A-Za-z0-9_.@%+,=:\/-]*)\s*(?:;|&&)/;
const CD_DANGER =
  /^\/(etc|usr|var|boot|root|bin|sbin|lib[0-9a-z_]*|opt|srv|proc|sys|dev|snap|nix|run|private|System|Library|Applications|Volumes)(\/|$)|^\/(home|Users|mnt|media)(\/[^/]+){0,2}$/;
const KEEP_CD_PREFIX =
  /\b(cd|pushd|popd|CDPATH|chdir|eval|exec|source|alias|function|bash|sh|zsh|dash|ash|ksh|mksh|tcsh|csh|fish|busybox)\b|\n|[`$({]|=\s*[\/~]|\s-[A-Za-z]*[CD]\s*[\/~.]|~[A-Za-z_]|(^|[;&|])\s*\.\s/;
function withoutSafeCdPrefix(raw) {
  const r = String(raw ?? "");
  const m = SAFE_CD_PREFIX.exec(r);
  if (!m) return r;
  const dir = m[1].replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
  if (dir === "/" || /(^|\/)\.\.?(\/|$)/.test(dir) || CD_DANGER.test(dir)) return r;
  const rest = r.slice(m[0].length);
  // Only while nothing after the prefix can change directory again or run text this match does
  // not see (critic_security / security_engineer, E-340 third review): cd/pushd/popd/CDPATH, a
  // second line, eval/exec/source/alias/function, a shell, $ or a backtick, ( or {, a directory
  // option with its path attached (`--chdir=/etc`, `-C/etc`, `-D~`), or ~user. Stripping the
  // prefix can only ever yield HEAD's verdict on the rest of the line.
  if (KEEP_CD_PREFIX.test(rest)) return r;
  return rest;
}
const DOTDOT = /(^|\/)\.\.(\/|$)/;
function rmRootHit(tokens, raw) {
  const rest = withoutSafeCdPrefix(raw);
  const t = rest === String(raw ?? "") ? tokens : _tokens(rest);
  return rmRecursiveForce(t) && (hasRootPaths(t, rest) || t.some((x) => DOTDOT.test(x)));
}

// ── E-102: Architect sovereignty rules (sovereignty-hardening.md §Components 1) ─
// When caller_role === 'architect', the Architect may not run
// destructive *implementation* git operations or create/destroy files outside
// the Architect-owned .ai/ and plans/ trees. These are honour-system today
// (caller_role is self-reported) but enforced fail-closed: a forbidden verb is
// allowed ONLY when every path operand is scoped to .ai/ or plans/.
const FORBIDDEN_ARCHITECT_GIT = ["reset", "revert", "checkout", "clean"];
const FORBIDDEN_ARCHITECT_OPS = ["rm", "mkdir", "touch"];

// E-123 (sovereignty-hardening.md §Data Model): branch-merge + deployment
// sovereignty. These git verbs are branch/remote operations (not path-scoped), so
// they are GLOBALLY forbidden for the Architect — merges, pulls, pushes, rebases
// and branch management are strictly Engineer tasks.
const FORBIDDEN_ARCHITECT_GIT_GLOBAL = ["merge", "rebase", "push", "pull", "branch"];
// Deployment commands the Architect may never run (Engineer territory): single
// verbs plus two-token forms (npm publish / docker push).
const FORBIDDEN_ARCHITECT_DEPLOY = ["ssh", "rsync", "scp"];
const FORBIDDEN_ARCHITECT_DEPLOY_PAIRS = [["npm", "publish"], ["docker", "push"]];

// Matches a verb at a COMMAND position — line start, after a shell separator
// (; & | newline, backtick, subshell paren), or after a command prefix
// (sudo/env/…) — not merely as an argument substring, so `cat ~/.ssh/config` does
// not trip the ssh rule. `tokens` is string-only here (shell operators are
// stripped upstream), so command-position detection runs against the raw string.
const CMD_HEAD = "(?:^|[;&|\\n`(]|\\b(?:sudo|env|nohup|time|command|exec|xargs|then|do)\\s+)\\s*";
function usesCommandVerb(raw, verb) {
  return new RegExp(CMD_HEAD + verb + "\\b", "i").test(raw);
}
function usesCommandPair(raw, a, b) {
  return new RegExp(CMD_HEAD + a + "\\s+" + b + "\\b", "i").test(raw);
}

// Non-flag operand tokens appearing after the first occurrence of `cmd`
// (and, when given, after `sub`). `--` is treated as a separator and dropped.
function operandsAfter(tokens, cmd, sub) {
  const i = tokens.indexOf(cmd);
  if (i === -1) return [];
  let rest = tokens.slice(i + 1);
  if (sub) {
    const j = rest.indexOf(sub);
    rest = j === -1 ? [] : rest.slice(j + 1);
  }
  return rest.filter((t) => t && t !== "--" && !t.startsWith("-"));
}


// Returns [{id, message}] sovereignty violations for an architect caller.
// E-340: `tokens`/`raw` are the command with INERT heredoc bodies removed under the read-only
// relaxation (heredoc.mjs readOnlyLine) — the Architect's D-105 append wrote prose naming
// pushing into .ai/DECISIONS.md and was blocked as ARCH_GIT_PUSH. The write analyzer keeps the
// FULL text (`writeTokens`/`writeRaw`, D-085 r1).
// E-350: `depth` counts code-string levels (su -c "bash -c '…'"); see codeStrings below.
const CODE_STRING_DEPTH = 3;
const CODE_STRING_BYTES = 16 * 1024;
function analyzeSovereignty(tokens, raw, writeTokens = tokens, writeRaw = raw, depth = 0) {
  const violations = [];

  // ForbiddenArchitectGit: reset/revert/checkout/clean on implementation targets.
  const gitMatch = /\bgit\s+(reset|revert|checkout|clean)\b/i.exec(raw);
  if (gitMatch) {
    const verb = gitMatch[1].toLowerCase();
    const targets = operandsAfter(tokens, "git", verb);
    const scopedSafe = targets.length > 0 && targets.every(isSafeArchitectPath);
    if (!scopedSafe) {
      violations.push({
        id: `ARCH_GIT_${verb.toUpperCase()}`,
        message: `git ${verb} is a forbidden Architect implementation operation (allowed only when every target is under .ai/ or plans/)`,
      });
    }
  }

  // ForbiddenArchitectOps: rm -rf / mkdir / touch outside .ai/ or plans/.
  if (hasSequence(tokens, ["rm"], ["-rf", "-fr", "-r", "-R", "--recursive"])) {
    const targets = operandsAfter(tokens, "rm");
    if (!(targets.length > 0 && targets.every(isSafeArchitectPath))) {
      violations.push({ id: "ARCH_RM_RF", message: "rm -rf outside .ai/ or plans/ is a forbidden Architect operation" });
    }
  }
  for (const op of ["mkdir", "touch"]) {
    if (tokens.includes(op)) {
      const targets = operandsAfter(tokens, op);
      if (!(targets.length > 0 && targets.every(isSafeArchitectPath))) {
        violations.push({ id: `ARCH_${op.toUpperCase()}`, message: `${op} outside .ai/ or plans/ is a forbidden Architect operation` });
      }
    }
  }

  // E-123: globally-forbidden Architect git ops (merge/rebase/push/pull/branch).
  // These are branch/remote operations, blocked regardless of path scope —
  // merging and pushing are strictly Engineer tasks.
  const gitGlobal = new RegExp(`\\bgit\\s+(${FORBIDDEN_ARCHITECT_GIT_GLOBAL.join("|")})\\b`, "i").exec(raw);
  if (gitGlobal) {
    const verb = gitGlobal[1].toLowerCase();
    violations.push({
      id: `ARCH_GIT_${verb.toUpperCase()}`,
      message: `git ${verb} is a forbidden Architect operation — merges/branch/remote ops are strictly Engineer tasks`,
    });
  }

  // E-123: deployment commands are strictly Engineer territory (ssh/rsync/scp,
  // npm publish, docker push) — blocked for the Architect at command position.
  for (const v of FORBIDDEN_ARCHITECT_DEPLOY) {
    if (usesCommandVerb(raw, v)) {
      violations.push({ id: `ARCH_DEPLOY_${v.toUpperCase()}`, message: `${v} is a forbidden Architect operation — deployments are strictly Engineer tasks` });
    }
  }
  for (const [a, b] of FORBIDDEN_ARCHITECT_DEPLOY_PAIRS) {
    if (usesCommandPair(raw, a, b)) {
      violations.push({ id: `ARCH_DEPLOY_${a.toUpperCase()}_${b.toUpperCase()}`, message: `${a} ${b} is a forbidden Architect operation — deployments are strictly Engineer tasks` });
    }
  }

  // E-216: shell write channel (redirections, write verbs, in-place editors,
  // inline interpreters). Appended last so its ids read after the historical ones.
  violations.push(...analyzeArchitectWrites(writeTokens, writeRaw));

  // E-350 (D-111 r6 iii): core.hooksPath / GIT_DIR on a git line, whatever the target.
  violations.push(...gitRedirectHits(raw));

  // E-350 (D-111 r6 i): a string handed to su -c, env -S, a shell's -c, eval or an
  // interpreter's -c/-e is code (D-111 r3) — judge it exactly as the unquoted command. Past
  // the depth cap, or over CODE_STRING_BYTES (each level re-tokenizes it), the string is not
  // analysed further, so it blocks rather than passes.
  for (const code of codeStrings(raw)) {
    const inner = depth < CODE_STRING_DEPTH && code.length <= CODE_STRING_BYTES
      ? analyzeSovereignty(_tokens(code), code, undefined, undefined, depth + 1)
      : [{ id: "ARCH_CODE_STRING_DEPTH", message: `a code string nested deeper than ${CODE_STRING_DEPTH} levels or longer than ${CODE_STRING_BYTES} bytes is a forbidden Architect operation — it is not analysed` }];
    for (const v of inner) if (!violations.some((x) => x.id === v.id)) violations.push(v);
  }

  return violations;
}

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

function _tokens(text) {
  try {
    return parse(text).filter((t) => typeof t === "string").map((t) => String(t));
  } catch {
    return String(text).split(/\s+/);
  }
}

// Exported for the in-process contract table (E-340, tests/unit/operand-scope.test.mjs).
// E-350 (D-111 r6 iv): shell-quote's parse grows quadratically with the token count (~100 s for
// 50k groups), so the gate leaned on the hook's timeout. A group is one command separator or
// grouping operator — ; & | ( ) { } ` $( newline — counted in one linear pass before anything
// is tokenized. Ordinary commands use tens; a long script hundreds. The cost is per TOKEN, so
// redirections (< >, which split a word into tokens), words and bytes are capped the same way.
const MAX_GROUPS = 2000;
const MAX_WORDS = 10000;
const MAX_BYTES = 64 * 1024;
const GROUP_RE = /\$\(|&&|\|\||[;&|(){}`\n<>]/g;
const WORD_RE = /\S+/g;
function _count(re, text) {
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(text) !== null) n++;
  return n;
}
// E-351 (D-112 r2): the first limit that tripped, with the measured figure, or null. The line
// names the escape so a refusal is not read as a gate failure: a document goes through Write/Edit.
function _tooLarge(full) {
  const bytes = Buffer.byteLength(full);
  const hit = bytes > MAX_BYTES ? [bytes, MAX_BYTES, "bytes"]
    : [[GROUP_RE, MAX_GROUPS, "command groups"], [WORD_RE, MAX_WORDS, "words"]]
      .map(([re, max, unit]) => [_count(re, full), max, unit]).find(([n, max]) => n > max);
  if (!hit) return null;
  const [n, max, unit] = hit;
  return `${n} ${unit} (limit ${max}) — not analysed; split the command, or a document this size goes through the Write/Edit tool`;
}

export function runAnalysis(original, callerRole, { override = false } = {}) {
  // The body of a quoted heredoc whose consumer is a plain file sink is TEXT for the
  // HEREDOC_EXEMPT_RULES (heredoc.mjs decides what counts as inert). The report still quotes
  // the command as given.
  const full = String(original);
  const tooLarge = _tooLarge(full);
  if (tooLarge) {
    const blocked = [{ id: "INPUT_TOO_LARGE", message: tooLarge }];
    const report = [`## safe-exec-mcp Analysis`, `Command: \`${full.slice(0, 120)}\``, `Verdict: ✗ BLOCK`, ``,
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
  }

  const verdict = blocked.length > 0 || sovereignty.length > 0 ? "BLOCK" : warned.length > 0 ? "WARN" : "PASS";
  const icon = verdict === "BLOCK" ? "✗" : verdict === "WARN" ? "⚠" : "✓";

  const lines = [
    `## safe-exec-mcp Analysis`,
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

// ── E-294 (D-087, sovereignty-hardening.md Components 8d–8f): the role on the gate path ────
// The role comes ONLY from the HMAC-verified v2 session token (role-token.mjs), which is bound
// to its session process and minted from the launch-record walk. No environment input: the
// REIN_CALLER_ROLE fallback is gone (D-087 r3). No verified token → the UNION: every role's
// blocks apply (today the Architect rule set — the Engineer has none at the hook), with
// ROLE_UNVERIFIED_LINE naming the fix.
//
// Flags are scanned AFTER the fixed positional (<command> or <path>), so a command or a target
// path literally named "--session" cannot hijack the parse (E-208 audit). A positional role
// word left by an older hook is ignored.
function _gateFlags(fromIdx) {
  const val = (flag) => {
    const i = process.argv.indexOf(flag, fromIdx);
    return i !== -1 ? String(process.argv[i + 1] || "") : "";
  };
  return { sid: val("--session"), sessionPid: val("--session-pid") };
}

/**
 * E-301 (D-088): the --check-path decision as a function of (target, role) — the CLI below and
 * the role-verdict contract table call this one function. `role` is the gate's: the token's,
 * or ARCHITECT for the union. Throws on an analyzer fault; the caller fails closed. The claim
 * gate (team projects, E-331) stays in the CLI: it reads process state, not the path.
 *   → { blocked: false } | { blocked: true, id: "GATE_SELF_DISABLE" | "ARCH_WRITE_OUTSIDE_SCOPE", reason }
 */
export function pathAnalysis(target, role, { projectRoot = findProjectRootFrom(process.cwd()), home } = {}) {
  // E-291 (D-083 r6): ~/.rein/** (hooks, gate, secrets, the override file) is protected
  // for EVERY role — the Write/Edit tools are the other way an agent could disable the gate.
  let underRein = false;
  try { underRein = isUnderRein(target, home); } catch { underRein = true; }   // fail closed
  if (underRein) return { blocked: true, id: "GATE_SELF_DISABLE", reason: "inside ~/.rein/" };
  if (role !== ARCHITECT) return { blocked: false };
  const v = architectPathVerdict(target, projectRoot);
  return v.blocked ? { blocked: true, id: "ARCH_WRITE_OUTSIDE_SCOPE", reason: v.reason } : { blocked: false };
}

/** {role, verified}: the token's role, or the union stand-in ("architect") when unverified. */
function gateRole(fromIdx) {
  const { sid, sessionPid } = _gateFlags(fromIdx);
  const role = sid ? verifyToken(sid, { sessionPid: sessionPid || null }) : null;
  return role ? { role, verified: true } : { role: ARCHITECT, verified: false };
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
    process.stdout.write(
      "## safe-exec-mcp Sovereignty Analysis\nVerdict: ✗ BLOCK\n\n" +
      "### BLOCKED — analyzer error (fail-closed)\n" +
      `The path gate crashed; the write is blocked rather than allowed: ${e.message}\n`
    );
    process.exit(2);
  }
  if (verdict.id === "GATE_SELF_DISABLE") {
    process.stdout.write(
      "## safe-exec-mcp Path Analysis\nVerdict: ✗ BLOCK\n\n" +
      "### BLOCKED — GATE_SELF_DISABLE\n" +
      `Path: ${target}\nReason: inside ~/.rein/ (the Rein install: hooks, gate, secrets) — no role writes there; ` +
      "only `bash install-rein.sh`, `ai install`, `ai sync` and `ai doctor` do.\n"
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
      "## safe-exec-mcp Sovereignty Analysis\nVerdict: ✗ BLOCK\n\n" +
      "### BLOCKED — ARCH_WRITE_OUTSIDE_SCOPE\n" +
      (verified ? "Role: architect (HMAC-verified session token)\n" : `${ROLE_UNVERIFIED_LINE}\n`) +
      `Path: ${target}\n` +
      `Reason: ${verdict.reason}.\n\n` +
      "The Architect designs; the Engineer implements (§35 ANTI-DRIFT, D-054).\n" +
      "Write the blueprint under .ai/ and hand the change-list to the Engineer via `skill: ai-handoff` (SendMessage).\n"
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
      "(fail-closed, T-HITL-004). Operator escape — in YOUR terminal, not through the agent: ai gate off\n"
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
