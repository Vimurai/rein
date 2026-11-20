// sovereignty.mjs — the Architect's command rules (E-102, E-123, E-216, E-350, E-438).
// Moved out of index.js by E-442 (D-164 r8): a pure move, no rule, message or verdict changed.

import { isSafeArchitectPath, analyzeArchitectWrites } from "./architect-writes.mjs";
import { codeStrings } from "./code-strings.mjs";
import { gitRedirectHits } from "./git-redirect.mjs";
import { gitCommandView, gitRelocated } from "./git-view.mjs";
import { shellTokens as _tokens } from "./tokens.mjs";

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasSequence(tokens, cmds, flags) {
  const strTokens = tokens.filter((t) => typeof t === "string").map((t) => String(t));
  return cmds.some((cmd) => strTokens.includes(cmd)) && flags.some((f) => strTokens.includes(f));
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
export function analyzeSovereignty(tokens, raw, writeTokens = tokens, writeRaw = raw, depth = 0, { projectRoot } = {}) {
  const violations = [];

  // E-438 (D-163 addendum 2 r2): the git rules also read each git command as git reads it — the
  // verb unquoted and the global options before the subcommand skipped (git-view.mjs), so
  // `"git" push` and `git -C . push` are git push. The E-353 assigned-verb expansion feeds this too.
  const gitText = raw + "\n" + gitCommandView(raw);

  // ForbiddenArchitectGit: reset/revert/checkout/clean on implementation targets.
  const gitMatch = /\bgit\s+(reset|revert|checkout|clean)\b/i.exec(gitText);
  if (gitMatch) {
    const verb = gitMatch[1].toLowerCase();
    const targets = operandsAfter(tokens, "git", verb);
    // E-438 (A2A 2026-11-18 09:06 r4): `.ai/x` names .ai/ only where git runs — not after a `-C`
    // elsewhere, or with --work-tree / --git-dir / core.worktree on the line.
    const scopedSafe = targets.length > 0 && targets.every(isSafeArchitectPath) && !gitRelocated(raw, projectRoot);
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
  const gitGlobal = new RegExp(`\\bgit\\s+(${FORBIDDEN_ARCHITECT_GIT_GLOBAL.join("|")})\\b`, "i").exec(gitText);
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
      ? analyzeSovereignty(_tokens(code), code, undefined, undefined, depth + 1, { projectRoot })
      : [{ id: "ARCH_CODE_STRING_DEPTH", message: `a code string nested deeper than ${CODE_STRING_DEPTH} levels or longer than ${CODE_STRING_BYTES} bytes is a forbidden Architect operation — it is not analysed` }];
    for (const v of inner) if (!violations.some((x) => x.id === v.id)) violations.push(v);
  }

  return violations;
}
