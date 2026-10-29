/**
 * instinct-stager.mjs — E-93 (ecc-integrations.md §Components 1 & 2)
 *
 * Stages "instincts" extracted by the meta_analyst (recurring successful
 * tool/debug patterns that consistently reach a DONE state) as PROPOSED
 * skills under .claude/skills/proposed/.
 *
 * Staged skills are INERT by construction: written with
 * `disable-model-invocation: true` and `user-invocable: false` so they can
 * never auto-fire while sitting in the staging area — defence in depth ahead of
 * the Human-in-the-Loop approval-mcp gate (E-94) that promotes them to active
 * skills. The stager refuses low-confidence, malformed, path-unsafe, or
 * dangerous-content instincts (blueprint §Security — auto-generated skills are
 * an injection surface).
 *
 * Pure module — no stdout writes (MCP stdout-purity contract); returns a
 * manifest describing what was staged and what was skipped (with reasons).
 *
 * Exports:
 *   MIN_CONFIDENCE
 *   validateInstinct(inst, minConfidence?) -> { ok, slug? , reason? }
 *   renderProposedSkill(inst, slug)        -> string (SKILL.md body)
 *   stageInstincts(instincts, opts?)       -> { staged, skipped, proposedDir }
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { redact } from "./publish-scan.mjs"; // E-379 (D-130)

// Instincts below this confidence are never staged (blueprint: "high-confidence
// instinct clusters"). The meta_analyst may pass a stricter threshold.
export const MIN_CONFIDENCE = 0.7;

// Patterns that must never appear in an auto-proposed skill body. A generated
// skill is untrusted content; this is the static defence ahead of E-94's HITL
// review (mirrors the spirit of standards-checker's SECRET_PATTERNS).
const DANGEROUS_PATTERNS = [
  { name: "destructive-rm",  re: /\brm\s+-rf?\b/ },
  { name: "pipe-to-shell",   re: /\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/ },
  { name: "curl-exec",       re: /\bcurl\b[^\n]*\|\s*(?:sh|bash)/ },
  { name: "eval",            re: /\beval\s*\(/ },
  { name: "aws-key",         re: /AKIA[0-9A-Z]{16}/ },
  { name: "private-key",     re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
  { name: "generic-secret",  re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{8,}/i },
  // E-145 (Tier-3 review hardening): close two empirical evasions of the denylist.
  // The HITL approval gate remains authoritative — this is defence-in-depth only.
  { name: "cmd-subst",       re: /\$\(/ },                                              // $(...) command substitution
  { name: "env-secret-exfil", re: /\$\{?[A-Z_]*(?:SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL)/ }, // $AWS_SECRET_ACCESS_KEY-style exfil
];

// A staged skill dir name must be a safe kebab-case slug — no path separators,
// no traversal, bounded length.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** True when `slug` is a safe kebab-case skill directory name (no traversal). */
export function isSafeSlug(slug) {
  return SLUG_RE.test(String(slug ?? ""));
}

/**
 * Scan text for dangerous patterns that must never appear in an
 * auto-generated skill (secrets, destructive shell). Returns
 * { safe: boolean, hits: string[] }. Reused by skill-promoter (E-94) as a
 * defence-in-depth re-check at promotion time.
 */
export function scanDangerousContent(text) {
  const hits = [];
  for (const { name, re } of DANGEROUS_PATTERNS) {
    if (re.test(String(text ?? ""))) hits.push(name);
  }
  return { safe: hits.length === 0, hits };
}

export function slugify(patternId) {
  return String(patternId || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Validate one instinct's shape and safety against the Instinct schema
 * (blueprint §Data Model). Returns { ok: true, slug } or { ok: false, reason }.
 */
export function validateInstinct(inst, minConfidence = MIN_CONFIDENCE) {
  if (!inst || typeof inst !== "object") return { ok: false, reason: "not-an-object" };
  const { pattern_id, confidence_score, trigger_condition, proposed_skill_content } = inst;
  if (typeof pattern_id !== "string" || !pattern_id.trim())
    return { ok: false, reason: "missing-pattern_id" };
  if (typeof confidence_score !== "number" || Number.isNaN(confidence_score))
    return { ok: false, reason: "invalid-confidence_score" };
  if (typeof trigger_condition !== "string" || !trigger_condition.trim())
    return { ok: false, reason: "missing-trigger_condition" };
  if (typeof proposed_skill_content !== "string" || !proposed_skill_content.trim())
    return { ok: false, reason: "missing-proposed_skill_content" };
  if (confidence_score < minConfidence)
    return { ok: false, reason: `below-confidence(${confidence_score}<${minConfidence})` };
  const slug = slugify(pattern_id);
  if (!SLUG_RE.test(slug)) return { ok: false, reason: "unsafe-pattern_id" };
  const scan = scanDangerousContent(proposed_skill_content);
  if (!scan.safe) return { ok: false, reason: `dangerous-content:${scan.hits[0]}` };
  return { ok: true, slug };
}

/**
 * Render an inert PROPOSED skill markdown file from an instinct. Frontmatter
 * disables model + user invocation so the staged skill cannot fire pre-approval.
 */
export function renderProposedSkill(inst, slug) {
  const conf = inst.confidence_score.toFixed(2);
  const frontmatter = [
    "---",
    `name: ${slug}`,
    `description: "PROPOSED instinct (pattern ${inst.pattern_id}, confidence ${conf}) — ${inst.trigger_condition.replace(/"/g, "'")}"`,
    "disable-model-invocation: true",
    "user-invocable: false",
    "context: default",
    "agent: default",
    "status: proposed",
    "---",
  ].join("\n");
  const provenance = [
    "",
    "<!-- AUTO-GENERATED INSTINCT — PROPOSED, NOT ACTIVE.",
    `     pattern_id:        ${inst.pattern_id}`,
    `     confidence_score:  ${conf}`,
    `     trigger_condition: ${inst.trigger_condition}`,
    "     Pending Human-in-the-Loop approval via approval-mcp (E-94) before activation.",
    "     Do NOT move to .claude/skills/ without approval. -->",
    "",
  ].join("\n");
  return `${frontmatter}\n${provenance}${inst.proposed_skill_content.trimEnd()}\n`;
}

/**
 * Stage an array of instincts as proposed skills.
 *
 * @param {Array} instincts  Instinct objects (blueprint §Data Model).
 * @param {object} [opts]
 * @param {string} [opts.proposedDir]   Target dir (default: <cwd>/.claude/skills/proposed).
 * @param {number} [opts.minConfidence] Confidence gate (default MIN_CONFIDENCE).
 * @returns {{ staged: Array, skipped: Array, proposedDir: string }}
 */
export function stageInstincts(instincts, opts = {}) {
  const proposedDir   = opts.proposedDir || resolve(process.cwd(), ".claude", "skills", "proposed");
  const minConfidence = opts.minConfidence ?? MIN_CONFIDENCE;
  const list = Array.isArray(instincts) ? instincts : [];
  const staged  = [];
  const skipped = [];

  for (const inst of list) {
    const v = validateInstinct(inst, minConfidence);
    if (!v.ok) {
      skipped.push({ pattern_id: inst && typeof inst === "object" ? inst.pattern_id ?? null : null, reason: v.reason });
      continue;
    }
    const dir  = resolve(proposedDir, v.slug);
    const path = resolve(dir, "SKILL.md");
    mkdirSync(dir, { recursive: true });
    // E-379 (D-130): proposedDir is <project>/.claude/skills/proposed, so the lists are <project>/.ai's.
    writeFileSync(path, redact(renderProposedSkill(inst, v.slug), {
      file: `.claude/skills/proposed/${v.slug}/SKILL.md`, aiDir: opts.aiDir || resolve(proposedDir, "..", "..", "..", ".ai"),
    }), "utf8");
    staged.push({ pattern_id: inst.pattern_id, slug: v.slug, path, confidence_score: inst.confidence_score });
  }

  return { staged, skipped, proposedDir };
}
