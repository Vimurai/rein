/**
 * skill-promoter.mjs — E-94 (ecc-integrations.md §Components 2 & §Security)
 *
 * Promotes a PROPOSED instinct skill (staged inert by instinct-stager, E-93)
 * to an ACTIVE skill — but ONLY behind the Human-in-the-Loop
 * approval-mcp gate. The caller obtains a decision from
 * `approval-mcp::request_approval` and passes it here; promotion proceeds only
 * when `decision.status === "APPROVED"`. Every other state (REJECTED, NON_TTY,
 * missing) is fail-closed: nothing is activated.
 *
 * Defence in depth on the skill-injection surface (blueprint §Security):
 *   1. approval gate     — no APPROVED decision ⇒ no promotion.
 *   2. content re-scan   — re-checks the body for secrets / destructive shell
 *                          via instinct-stager's scanDangerousContent, even
 *                          though staging already filtered it.
 *   3. no-clobber        — refuses to overwrite an existing ACTIVE skill.
 *   4. safe-slug         — refuses path-unsafe directory names.
 *
 * Pure module — no stdout writes (MCP stdout-purity); returns result objects.
 *
 * Exports:
 *   listProposedSkills(proposedDir)        -> [{ slug, path }]
 *   activateContent(content)               -> string (frontmatter flipped active)
 *   promoteSkill(slug, opts)               -> { promoted, ... }
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isSafeSlug, scanDangerousContent } from "./instinct-stager.mjs";

/** List staged proposals: each `<slug>/SKILL.md` under `proposedDir`. */
export function listProposedSkills(proposedDir) {
  if (!proposedDir || !existsSync(proposedDir)) return [];
  const out = [];
  for (const entry of readdirSync(proposedDir)) {
    const dir  = resolve(proposedDir, entry);
    const path = resolve(dir, "SKILL.md");
    if (isSafeSlug(entry) && existsSync(path) && statSync(dir).isDirectory()) {
      out.push({ slug: entry, path });
    }
  }
  return out;
}

/**
 * Flip a staged skill's inert frontmatter to active and stamp promotion
 * provenance. Only the three inert keys are rewritten; the body is untouched.
 */
export function activateContent(content, meta = {}) {
  let out = String(content)
    .replace(/^disable-model-invocation:\s*true\s*$/m, "disable-model-invocation: false")
    .replace(/^user-invocable:\s*false\s*$/m, "user-invocable: true")
    .replace(/^status:\s*proposed\s*$/m, "status: active")
    // Drop the now-stale "PROPOSED, NOT ACTIVE … Do NOT move" provenance block
    // left by the stager — it contradicts the freshly-activated frontmatter.
    .replace(/<!--\s*AUTO-GENERATED INSTINCT[\s\S]*?-->\n?/, "");
  const stamp = `<!-- PROMOTED to active via approval-mcp HITL gate (E-94)` +
    (meta.approvalId != null ? ` — approval id ${meta.approvalId}` : "") + `. -->\n`;
  // Insert the promotion stamp right after the closing frontmatter fence.
  const fenceEnd = out.indexOf("\n---", out.indexOf("---") + 3);
  if (fenceEnd !== -1) {
    const insertAt = fenceEnd + 4; // past "\n---"
    out = out.slice(0, insertAt) + "\n" + stamp + out.slice(insertAt);
  }
  return out;
}

/**
 * Promote a proposed skill to active. Fail-closed on anything but an APPROVED
 * approval-mcp decision.
 *
 * @param {string} slug
 * @param {object} opts
 * @param {string} opts.proposedDir         Staging dir (…/.claude/skills/proposed).
 * @param {string} opts.activeDir           Active skills dir (…/.claude/skills).
 * @param {object} opts.decision            approval-mcp result: { status, id, ... }.
 * @returns {{ promoted: boolean, slug: string, activePath?: string, reason?: string }}
 */
export function promoteSkill(slug, opts = {}) {
  const { proposedDir, activeDir, decision } = opts;

  if (!isSafeSlug(slug)) return { promoted: false, slug, reason: "unsafe-slug" };

  // Gate 1 — the approval-mcp decision must be an explicit APPROVED.
  const status = decision && typeof decision === "object" ? decision.status : undefined;
  if (status !== "APPROVED") {
    return { promoted: false, slug, reason: `not-approved:${status ?? "no-decision"}` };
  }

  const proposedPath = resolve(proposedDir, slug, "SKILL.md");
  if (!existsSync(proposedPath)) {
    return { promoted: false, slug, reason: "proposal-not-found" };
  }

  // Gate 3 — never overwrite a real, already-active skill.
  const activeSkillDir = resolve(activeDir, slug);
  if (existsSync(resolve(activeSkillDir, "SKILL.md"))) {
    return { promoted: false, slug, reason: "active-skill-exists" };
  }

  const content = readFileSync(proposedPath, "utf8");

  // Gate 2 — re-scan the body for dangerous content before activating it.
  const scan = scanDangerousContent(content);
  if (!scan.safe) {
    return { promoted: false, slug, reason: `dangerous-content:${scan.hits[0]}` };
  }

  mkdirSync(activeSkillDir, { recursive: true });
  const activePath = resolve(activeSkillDir, "SKILL.md");
  writeFileSync(activePath, activateContent(content, { approvalId: decision.id }), "utf8");

  // Remove the now-promoted proposal from the staging area.
  rmSync(resolve(proposedDir, slug), { recursive: true, force: true });

  return { promoted: true, slug, activePath };
}
