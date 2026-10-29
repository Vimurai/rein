#!/usr/bin/env node
/**
 * propose-patch-mcp — Rein Human-in-the-Loop Safe Diff Flow (E-141, §30)
 *
 * Instead of directly writing files, Claude proposes a formatted diff and
 * waits for explicit human confirmation before applying it.
 *
 * Tools:
 *   propose_patch(path, diff_content, description?)
 *     → Stores patch, formats diff for review. Returns patch_id.
 *   confirm_patch(patch_id)
 *     → Applies the stored patch to disk. Requires explicit human approval.
 *   reject_patch(patch_id)
 *     → Discards the stored patch. No changes made.
 *   list_pending_patches()
 *     → Shows all patches awaiting confirmation.
 *   preview_patch(patch_id)
 *     → Re-displays formatted diff without applying it.
 *
 * Diff format:
 *   Uses `delta` if available, falls back to `diff --color` or plain unified diff.
 *
 * Security:
 *   - Path traversal blocked (must resolve within cwd).
 *   - Patches stored in-memory only (no disk persistence of diffs).
 *   - confirm_patch is disable-model-invocation safe — requires explicit call.
 *   - Role-aware RBAC: Architect writes blocked outside .ai/ and plans/ (E-143, §35).
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { instrument, rejection } from "../../shared/mcp-telemetry.mjs";
import { readFileSync, writeFileSync, existsSync, unlinkSync, realpathSync } from "fs";
import { resolve, relative } from "path";
import { spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { getDbSeeded } from "../shared/state-db.js";
import { createLogger } from "../shared/logger.js";
import {
  architectScopeGuard as _staticScopeGuard,
  effectiveRequestRole as _staticEffectiveRole,
} from "../shared/caller-role.mjs";
import {
  findProjectRootFrom as _staticFindRoot,
  projectPathVerdict as _staticPathVerdict,
} from "../safe-exec-mcp/architect-writes.mjs";
import { loadPolicy } from "../shared/load-policy.mjs";

// ── E-237 (D-061 §5): per-request policy refresh ─────────────────────────────
// The policy modules are re-read at the TOP of each request rather than awaited at every
// call site. The guards below are small SYNCHRONOUS helpers used from many places in a
// security-critical path; making them async would ripple through the whole file, and a
// security gate is the wrong place for a wide mechanical refactor.
//
// The static import stays as the initial value and as the fail-safe: if a reload ever
// throws, the previous good policy keeps deciding rather than the guard becoming
// undefined. A gate that disappears is far worse than a gate that is one version behind.
let _rolePolicy = {
  architectScopeGuard: _staticScopeGuard,
  effectiveRequestRole: _staticEffectiveRole,
};
let _writePolicy = {
  findProjectRootFrom: _staticFindRoot,
  projectPathVerdict: _staticPathVerdict,
};
async function refreshPolicies() {
  try { _rolePolicy = await loadPolicy("caller-role"); } catch { /* keep last good */ }
  try { _writePolicy = await loadPolicy("architect-writes"); } catch { /* keep last good */ }
}
const architectScopeGuard = (...a) => _rolePolicy.architectScopeGuard(...a);
const effectiveRequestRole = (...a) => _rolePolicy.effectiveRequestRole(...a);
const findProjectRootFrom = (...a) => _writePolicy.findProjectRootFrom(...a);
const projectPathVerdict = (...a) => _writePolicy.projectPathVerdict(...a);

import { validateDiffContent } from "./diff-targets.mjs";

// ── Structured logger (obs_baseline §Logging) ────────────────────────────────
const logger = createLogger("propose-patch-mcp");

// ── Patch store (SQLite-backed via state-db.js, P-24) ─────────────────────────
// Patches are stored in the `patches` table of state.sqlite.
// This replaces the patches.json approach (P-20) for ACID-safe concurrent access.

function _patchDb() {
  const aiDir = resolve(process.cwd(), ".ai");
  if (!existsSync(aiDir)) return null;
  try { return getDbSeeded(aiDir); } catch { return null; }
}

function newPatchId() {
  return "patch-" + randomBytes(4).toString("hex");
}

/**
 * Bounds a path to a project root. Delegates to `projectPathVerdict` — the SAME predicate
 * the Write/Edit and shell gates use — and returns the absolute path, or null.
 *
 * This used to be four lines of its own: resolve, relative, reject a leading "..". That is
 * a LEXICAL test, and a symlinked DIRECTORY component inside the project walked straight
 * through it — `src/esc -> ../outside` collapses to a relative path with no "..", so the
 * check passed and the write followed the link out of the project. Proven end-to-end
 * against this server during the E-221 audit: a single project, no cross-project confirm,
 * no DB tampering, and the bytes landed outside the root.
 *
 * The repository already contained the hardened predicate — symlink resolution through
 * realpathNearest, raw ".." rejection, trailing-separator handling, a hardlink inode check,
 * fail-closed on a realpath error — built over seven audit rounds in E-216. Hand-rolling a
 * second one is exactly what E-219 F1 did and what the E-216 header warns against: two
 * gates for one rule drift, and the weaker one is the one that decides.
 */
function safePath(filePath, cwd) {
  const v = projectPathVerdict(filePath, cwd);
  if (v.blocked || !v.rel) return null;
  return resolve(cwd, v.rel);
}

/**
 * E-221 (D-057 §1): the project boundary for a two-phase patch.
 *
 * `propose_patch` resolves a path against the PROPOSING process's root; `confirm_patch`
 * used to write to the stored ABSOLUTE path without re-checking it against its OWN root,
 * so confirming a pending patch from a different project landed the write outside that
 * project. That is not a role escape — the role is re-derived per process since E-219 —
 * the gap is the project boundary.
 *
 * The fix has two halves, and BOTH are needed:
 *   1. store the root the path was resolved against, plus a path RELATIVE to it;
 *   2. at confirm time re-derive the root, require equality, and re-run safePath on the
 *      relative path against that root.
 * Storing the root alone would only detect the mismatch; re-resolving the relative path
 * is what stops a stored absolute path from being trusted as a destination at all.
 */
function projectRootFor(cwd) {
  return canonicalRoot(findProjectRootFrom(cwd));
}

/**
 * Compare roots by their REALPATH. `/tmp` is a symlink to `/private/tmp` on macOS, so
 * two processes in the same directory can hold strings that differ while naming one
 * place — a string compare would reject legitimate confirms there. realpathSync throws
 * on a missing path; fall back to the resolved string rather than crashing the guard.
 */
function canonicalRoot(dir) {
  try {
    return realpathSync(resolve(dir));
  } catch {
    return resolve(dir);
  }
}

/**
 * Role-Aware RBAC guard (E-143 §35; role derivation moved SERVER-SIDE in E-219/D-056 R1).
 *
 * The old signature took the caller's own `caller_role` and returned "allow" whenever it
 * was absent — a self-declared guard, and the only barrier left in a session started
 * without the settings overlay. It now delegates to the shared resolver, which derives
 * the role from the HMAC-verified session record, then this server's launch env, and
 * falls back to `architect` (the RESTRICTED role) when there is no evidence.
 * The argument survives as advisory: it may add restriction, never lift it.
 */
function roleGuard(callerRole, absPath, cwd) {
  return architectScopeGuard(callerRole, absPath, cwd);
}

/**
 * E-226 (D-058 §4): how a stored row relates to THIS project.
 *
 * `preview_patch` called `formatDiff(patch.diff_content, patch.path)`, which STATS AND
 * READS the stored absolute path to build a diff baseline — with no check that the path
 * belongs to the previewing project. During the E-221 audit a secret-bearing file outside
 * the project root was rendered straight into tool output (T-PROPOSEPATCH-002). `list` and
 * `reject` had the same shape: rows from any project reachable in the store, giving path
 * disclosure and cross-project queue deletion.
 *
 * E-221 fixed the WRITE path by re-deriving the target from `project_root` + `rel_path`.
 * These three read-only tools were explicitly out of that ruling's scope, so they kept
 * trusting the stored absolute path. Same derivation, same equality test, applied here.
 *
 * @returns {"own"|"foreign"|"legacy"} — `legacy` rows predate the E-221 columns and carry
 *   no project at all, so they are never read from disk, only listed.
 */
function rowScope(patch, ownRoot) {
  if (patch.project_root == null || patch.rel_path == null) return "legacy";
  return canonicalRoot(patch.project_root) === ownRoot ? "own" : "foreign";
}

/** The path a row names in THIS project, or null when it does not belong here. */
function rowTargetPath(patch, ownRoot) {
  if (rowScope(patch, ownRoot) !== "own") return null;
  if (patch.rel_path === "") return null;
  return safePath(patch.rel_path, ownRoot);
}

/** basename only — never leak an absolute path from another project. */
function rootLabel(root) {
  const parts = String(root || "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "(unknown)";
}

/**
 * Attempt to format diff_content using delta, diff --color, or plain text.
 * Returns the formatted string.
 */
function formatDiff(diffContent, absPath) {
  // Try `delta` (https://github.com/dandavison/delta) — best TUI rendering
  const delta = spawnSync("delta", ["--no-gitconfig"], {
    input: diffContent,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (!delta.error && delta.status === 0 && delta.stdout?.trim()) {
    return delta.stdout;
  }

  // Try `diff --color` against empty baseline (for new files) or actual file
  if (existsSync(absPath)) {
    const diffResult = spawnSync("diff", ["--color=always", "-u", absPath, "-"], {
      input: diffContent,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
    });
    // diff exits 1 when files differ (that's expected), 2 on error
    if (diffResult.status !== 2 && diffResult.stdout?.trim()) {
      return diffResult.stdout;
    }
  }

  // Plain fallback — annotate the unified diff with line numbers
  const lines = diffContent.split("\n");
  const annotated = lines.map((l, i) => {
    if (l.startsWith("+++") || l.startsWith("---")) return l;
    if (l.startsWith("+")) return `\x1b[32m${l}\x1b[0m`; // green
    if (l.startsWith("-")) return `\x1b[31m${l}\x1b[0m`; // red
    if (l.startsWith("@@")) return `\x1b[36m${l}\x1b[0m`; // cyan
    return l;
  });
  return annotated.join("\n");
}

function renderPatch(patchData, formatted) {
  return [
    `╔══ PROPOSED PATCH ═══════════════════════════════════════════════╗`,
    `║  ID:   ${patchData.id}`,
    `║  File: ${patchData.path}`,
    `║  Desc: ${(patchData.description || "(none)").slice(0, 60)}`,
    `║  Time: ${patchData.created_at}`,
    `╚═════════════════════════════════════════════════════════════════╝`,
    "",
    formatted,
    "",
    `┌─────────────────────────────────────────────────────────────────┐`,
    `│  To APPLY:   confirm_patch("${patchData.id}")                   │`,
    `│  To DISCARD: reject_patch("${patchData.id}")                    │`,
    `└─────────────────────────────────────────────────────────────────┘`,
  ].join("\n");
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "propose-patch-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "propose_patch",
      description:
        "Proposes a file edit as a formatted diff for human review. " +
        "Does NOT write to disk — returns a patch_id that must be confirmed via confirm_patch(). " +
        "Use instead of direct file edits for Tier 2/3 logic changes requiring human review.",
      inputSchema: {
        type: "object",
        properties: {
          path:         { type: "string", description: "Relative or absolute file path to patch." },
          diff_content: { type: "string", description: "Unified diff content (output of: diff -u old new) OR the full new file content." },
          description:  { type: "string", description: "One-line description of what this patch does." },
          caller_role:  {
            type: "string",
            enum: ["engineer", "architect"],
            description:
              "Role of the calling agent. If 'architect', writes outside .ai/ and plans/ " +
              "are blocked with [ANTI_DRIFT_VIOLATION]. Advisory only (E-219): the role is " +
              "derived server-side from the verified session record, then this server's launch " +
              "environment, defaulting to 'architect' when neither is available. Supplying a " +
              "role can only ADD restriction — pass 'architect' to sandbox yourself; passing " +
              "'engineer' does nothing.",
          },
        },
        required: ["path", "diff_content"],
      },
    },
    {
      name: "confirm_patch",
      description:
        "Applies a previously proposed patch to disk. " +
        "IMPORTANT: Only call this after the user has reviewed and approved the diff. " +
        "This is a destructive write — back up the file if needed.",
      inputSchema: {
        type: "object",
        properties: {
          patch_id: { type: "string", description: "The patch_id returned by propose_patch()." },
        },
        required: ["patch_id"],
      },
    },
    {
      name: "reject_patch",
      description:
        "Discards a proposed patch without making any changes. " +
        "Call this if the user rejects the diff or you want to revise the patch.",
      inputSchema: {
        type: "object",
        properties: {
          patch_id: { type: "string", description: "The patch_id returned by propose_patch()." },
        },
        required: ["patch_id"],
      },
    },
    {
      name: "list_pending_patches",
      description:
        "Lists patches awaiting confirmation IN THIS PROJECT. " +
        "Pass all:true to also list rows proposed in other projects — those are shown as " +
        "id plus the path relative to their own root, never an absolute path, and they " +
        "cannot be previewed against a file or rejected from here (E-226).",
      inputSchema: {
        type: "object",
        properties: {
          all: {
            type: "boolean",
            description: "Include rows from other projects and legacy rows (identifiers only).",
          },
        },
      },
    },
    {
      name: "preview_patch",
      description:
        "Re-displays the formatted diff for a pending patch without applying it. " +
        "For a patch proposed in ANOTHER project the stored diff is shown with a " +
        "[FOREIGN_PROJECT] banner and no file is read, so the rendered diff has no " +
        "baseline from disk (E-226).",
      inputSchema: {
        type: "object",
        properties: {
          patch_id: { type: "string", description: "The patch_id returned by propose_patch()." },
        },
        required: ["patch_id"],
      },
    },
  ],
}));

instrument(server, "propose-patch-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await refreshPolicies();   // E-237: pick up a policy `ai sync` refreshed under us
  const { name, arguments: args } = request.params;
  const cwd = process.cwd();

  switch (name) {
    // ── propose_patch ─────────────────────────────────────────────────────────
    case "propose_patch": {
      // Resolve against the PROJECT ROOT so confirm_patch can re-derive the same base
      // independently. In practice this equals cwd: `_patchDb()` looks for `.ai` in cwd
      // EXACTLY and returns null otherwise, so a call that gets this far already has cwd
      // at the root and the walk-up never fires. An earlier comment here claimed this
      // handled the documented MCP rooting trap — it does not, because the DB lookup
      // fails first. Kept because it makes the two sides derive the root the same way,
      // which is what the equality check below compares.
      const projectRoot = projectRootFor(cwd);
      const abs = safePath(args.path, projectRoot);
      if (!abs) {
        return {
          content: [{ type: "text", text: `✗ Path traversal blocked: '${args.path}'` }],
          isError: true,
        };
      }
      const relPath = relative(projectRoot, abs);

      // The path is validated three ways above — and none of that bounds what `patch`
      // WRITES. It consumes the operand for the FIRST diff section only; later sections
      // pick their own targets from their own headers, so a blob proposed for one file
      // could carry a second section headed `../outside/victim.txt` and land there with
      // exit 0 and a "✓ Patch applied" report. The predicate was right; it was applied to
      // the wrong thing. Verified on this host: single-section blobs ARE operand-governed,
      // multi-section ones escape.
      const diffCheck = validateDiffContent(args.diff_content);
      if (!diffCheck.ok) {
        return {
          content: [{ type: "text", text: `✗ [DIFF_REDIRECT] ${diffCheck.reason}` }],
          isError: true,
        };
      }

      const roleBlock = roleGuard(args.caller_role, abs, cwd);
      if (roleBlock) return roleBlock;

      const db = _patchDb();
      if (!db) {
        return { content: [{ type: "text", text: "✗ state.sqlite not found — run: ai init" }], isError: true };
      }

      const id = newPatchId();
      const patchData = {
        id,
        path: abs,
        diff_content: args.diff_content,
        description: args.description || "",
        caller_role: args.caller_role || null,
        // E-219: RENDER-ONLY provenance. These two fields reach the tool's text output
        // so a reviewer can see what the proposing process was derived as, and from
        // which evidence — they are NOT persisted: the patches table has no such
        // columns and the INSERT below does not name them.
        //
        // Deliberately not persisted. No guard consumes them (confirm_patch re-derives
        // in its own process, which is the stronger check), so adding columns would mean
        // a state.sqlite schema migration for a field nothing reads. An earlier comment
        // here claimed the stored row was auditable, which was simply false — and a
        // comment that overstates what the code does is worse than an absent feature,
        // because the next reader trusts it.
        derived_role: effectiveRequestRole(args.caller_role, cwd).role,
        derived_role_source: effectiveRequestRole(args.caller_role, cwd).source,
        created_at: new Date().toISOString(),
        status: "pending",
      };
      db.prepare(
        "INSERT INTO patches(id, path, diff_content, description, caller_role, created_at, status, project_root, rel_path) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)"
      ).run(
        id, abs, args.diff_content, args.description || null, args.caller_role || null,
        patchData.created_at, projectRoot, relPath,
      );

      const formatted = formatDiff(args.diff_content, abs);
      const rendered  = renderPatch(patchData, formatted);

      return { content: [{ type: "text", text: rendered }] };
    }

    // ── confirm_patch ─────────────────────────────────────────────────────────
    case "confirm_patch": {
      const db = _patchDb();
      // E-179: the guards below are EXPECTED rejections — missing DB (setup not run), a stale
      // patch id (already applied/rejected), or a non-pending patch (double-confirm). The tool
      // is behaving correctly, not failing; booked SUCCESS so confirm_patch's 33% rate (mostly
      // stale ids + clean dry-run refusals) stops masquerading as a defect. Genuine apply/write
      // failures below stay UNMARKED → still ERROR.
      if (!db) {
        return rejection("✗ state.sqlite not found — run: ai init");
      }
      const patch = db.prepare("SELECT * FROM patches WHERE id = ?").get(args.patch_id);
      if (!patch) {
        return rejection(`✗ Patch not found: '${args.patch_id}'. It may have already been applied or rejected.`);
      }
      if (patch.status !== "pending") {
        return rejection(`✗ Patch '${args.patch_id}' is already ${patch.status}.`);
      }

      // ── E-221 (D-057 §1): re-establish the PROJECT boundary at confirm time ──
      // The stored absolute path is never trusted as a destination. We re-derive this
      // process's own root, require it to be the root the patch was proposed against,
      // and re-resolve the RELATIVE path against it. A patch is a promise about a place
      // inside one project; confirming it somewhere else is not the same promise.
      const ownRoot = projectRootFor(cwd);
      let targetPath;

      // A record is legacy when the COLUMNS are absent — not when a value is falsy.
      // `propose_patch(path: ".")` stores rel_path = "", and `!""` sent a row written
      // seconds earlier down the legacy branch, reporting that it "predates the
      // project-boundary check". It failed closed, but on the wrong branch: legacy is
      // precisely the branch that SKIPS the PROJECT_MISMATCH equality check, and it was
      // being selected by a value the record controls. An empty rel_path is rejected
      // below on its own terms — it names the root directory, never a writable file.
      if (patch.project_root == null || patch.rel_path == null) {
        // A record from before this migration carries only an absolute path, and nothing
        // in it says which project it belonged to. Guessing is exactly the behaviour
        // being removed, so refuse and let the caller re-propose — the diff is not lost,
        // it is still readable via preview_patch.
        if (process.env.REIN_PATCH_LEGACY !== "1") {
          return rejection(
            `✗ [LEGACY_PATCH] Patch '${args.patch_id}' predates the project-boundary check ` +
            `(E-221) and records no project root, so it cannot be verified against this ` +
            `project. Re-propose it here, or set REIN_PATCH_LEGACY=1 to accept the ` +
            `pre-E-221 behaviour for this run.`
          );
        }
        // Rollback path: still strictly better than pre-E-221 — the stored absolute path
        // is bounds-checked against THIS root before anything is written.
        targetPath = safePath(patch.path, ownRoot);
        if (!targetPath) {
          return rejection(
            `✗ [PROJECT_ESCAPE] Legacy patch '${args.patch_id}' targets '${patch.path}', ` +
            `which lies outside this project root (${ownRoot}) — refusing to write.`
          );
        }
      } else if (patch.rel_path === "") {
        return rejection(
          `✗ [PROJECT_ESCAPE] Patch '${args.patch_id}' names the project root itself, ` +
          `not a file within it — refusing to write.`
        );
      } else {
        if (canonicalRoot(patch.project_root) !== ownRoot) {
          return rejection(
            `✗ [PROJECT_MISMATCH] Patch '${args.patch_id}' was proposed against ` +
            `'${patch.project_root}' but is being confirmed from '${ownRoot}'. ` +
            `Confirm it from the project it was proposed in, or re-propose it here.`
          );
        }
        // Re-run the bounds check on the RELATIVE path against our own root. The stored
        // rel_path is data, not a verified destination: a row edited in the DB, or one
        // written before some later change, must still be unable to escape.
        targetPath = safePath(patch.rel_path, ownRoot);
        if (!targetPath) {
          return rejection(
            `✗ [PROJECT_ESCAPE] Patch '${args.patch_id}' resolves outside the project ` +
            `root (${ownRoot}) — refusing to write.`
          );
        }
      }

      // Re-validate the blob too: the stored row is DATA, and confirm already re-derives
      // the root, the path and the role rather than trusting what was written down.
      const storedDiffCheck = validateDiffContent(patch.diff_content);
      if (!storedDiffCheck.ok) {
        return rejection(`✗ [DIFF_REDIRECT] ${storedDiffCheck.reason}`);
      }

      // Defense-in-depth: re-check role at apply time, against the path we just
      // re-derived — not the stored one.
      const roleBlock = roleGuard(patch.caller_role, targetPath, cwd);
      if (roleBlock) return roleBlock;

      // Apply the patch — determine if diff_content is a unified diff or a full
      // file. A prefix heuristic (startsWith "---") misfires on full-file content
      // that legitimately begins with "---" (YAML front-matter, markdown rules,
      // dividers) and pipes it to patch(1), corrupting the target. Require the
      // structural signature of a real unified diff — a hunk header — instead.
      const isDiff = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(patch.diff_content);

      try {
        if (isDiff) {
          const popts = { input: patch.diff_content, encoding: "utf8", timeout: 10000, maxBuffer: 10 * 1024 * 1024 };
          // 1. Dry-run first — never mutate the file unless every hunk applies.
          const dry = spawnSync("patch", ["--dry-run", "-f", targetPath, "-"], popts);
          if (dry.status !== 0) {
            // E-179: a clean dry-run refusal is the tool's core SAFETY guard working as designed
            // (the patch does not apply to the current file state) — an expected rejection that
            // protected the file, not a malfunction. Booked SUCCESS for telemetry.
            return rejection(
              `✗ patch would not apply cleanly (dry-run exit ${dry.status}) — no changes written:\n${dry.stderr || dry.stdout || "(no output)"}`
            );
          }
          // 2. Capture the pre-image OURSELVES, in memory, before anything runs.
          //
          // This used to pass `-b` and roll back from the `.orig` that patch(1) writes.
          // Two problems with that, both raised in the E-221 audit:
          //   - patch(1) writes `.orig` per SECTION, not per run, so by the time a later
          //     section fails the backup can already hold partially-applied content —
          //     "restoring" it would then commit exactly what we meant to reject;
          //   - `${targetPath}.orig` is a real path in the user's tree. A pre-existing
          //     file of that name was overwritten and then unlinked on success: data
          //     loss caused by a rollback mechanism.
          // A pre-image we read ourselves has neither property, and it is the only copy
          // we can be sure corresponds to the state the dry-run approved.
          //
          // NOTE on the audit's H2: the reported dry-run BYPASS (an ed-style section
          // plus a trailing unified header) did not reproduce here — patch 2.0-12u11-Apple
          // returns 1 from the dry-run and the file is untouched, and the tool's message
          // is accurate. The rollback SHAPE was still wrong for the reasons above, so it
          // is fixed on its own merits rather than on the strength of that payload.
          let preImage = null;
          try { preImage = readFileSync(targetPath); } catch { preImage = null; }

          // patch(1) writes `${target}.orig` on its OWN initiative on this platform
          // (patch 2.0-12u11-Apple backs up by default; `-b` only made it explicit), so
          // dropping `-b` does not stop it. Record what was at that path first: it may be
          // a real file of the user's, and a housekeeping unlink that destroys one is the
          // same class of harm as the over-prune in E-220. Restore it if it existed,
          // remove it only if patch created it.
          const backup = `${targetPath}.orig`;
          let priorBackup = null;
          try { priorBackup = existsSync(backup) ? readFileSync(backup) : null; } catch { priorBackup = null; }
          const restoreBackupPath = () => {
            try {
              if (priorBackup !== null) writeFileSync(backup, priorBackup);
              else if (existsSync(backup)) unlinkSync(backup);
            } catch { /* best effort — never fail the call over backup housekeeping */ }
          };

          const result = spawnSync("patch", ["-f", targetPath, "-"], popts);
          if (result.status !== 0) {
            // Restore from OUR pre-image, then verify the restore actually happened
            // before claiming it did. The old message said "file restored from backup"
            // unconditionally — including when there was no backup to restore from.
            let restored = false;
            try {
              if (preImage !== null) {
                writeFileSync(targetPath, preImage);
                restored = readFileSync(targetPath).equals(preImage);
              } else if (existsSync(targetPath)) {
                // The file did not exist before; a partial apply may have created it.
                unlinkSync(targetPath);
                restored = !existsSync(targetPath);
              } else {
                restored = true;
              }
            } catch { restored = false; }
            restoreBackupPath();
            try { const rej = `${targetPath}.rej`; if (existsSync(rej)) unlinkSync(rej); } catch {}
            return {
              content: [{
                type: "text",
                text: `✗ patch failed after dry-run passed (exit ${result.status}); ` +
                      (restored
                        ? "file restored to its pre-patch content"
                        : "⚠ THE FILE MAY BE PARTIALLY MODIFIED — the rollback could not be verified, inspect it before continuing") +
                      `:\n${result.stderr || result.stdout || "(no output)"}`,
              }],
              isError: true,
            };
          }
          // Success — leave the tree as we found it.
          restoreBackupPath();
        } else {
          writeFileSync(targetPath, patch.diff_content, "utf8");
        }

        db.prepare("DELETE FROM patches WHERE id = ?").run(args.patch_id);

        return {
          content: [{
            type: "text",
            text: `✓ Patch applied: ${targetPath}\n  ID: ${args.patch_id}\n  Desc: ${patch.description || "(none)"}`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `✗ Write failed: ${e.message}` }],
          isError: true,
        };
      }
    }

    // ── reject_patch ──────────────────────────────────────────────────────────
    case "reject_patch": {
      const db = _patchDb();
      if (!db) {
        return { content: [{ type: "text", text: "✗ state.sqlite not found — run: ai init" }], isError: true };
      }
      const patch = db.prepare("SELECT id, path, description, project_root, rel_path FROM patches WHERE id = ?").get(args.patch_id);
      if (!patch) {
        return {
          content: [{ type: "text", text: `✗ Patch not found: '${args.patch_id}'.` }],
          isError: true,
        };
      }
      // Rejecting is a WRITE to another project's queue: it destroys a pending patch its
      // owner is waiting to confirm. Refuse rather than delete.
      const rejectRoot = projectRootFor(cwd);
      const rejectScope = rowScope(patch, rejectRoot);
      if (rejectScope !== "own" && process.env.REIN_PATCH_LEGACY !== "1") {
        return rejection(
          rejectScope === "legacy"
            ? `✗ [LEGACY_PATCH] Patch '${args.patch_id}' records no project root, so it cannot be verified against this project. Re-propose it here, or set REIN_PATCH_LEGACY=1.`
            : `✗ [PROJECT_MISMATCH] Patch '${args.patch_id}' was proposed in '${rootLabel(patch.project_root)}', not this project — refusing to discard another project's pending patch.`
        );
      }
      db.prepare("DELETE FROM patches WHERE id = ?").run(args.patch_id);
      return {
        content: [{
          type: "text",
          text: `✓ Patch rejected and discarded.\n  ID: ${args.patch_id}\n  File: ${patch.rel_path ?? patch.path}\n  No changes were made.`,
        }],
      };
    }

    // ── list_pending_patches ──────────────────────────────────────────────────
    case "list_pending_patches": {
      const db = _patchDb();
      const pending = db ? db.prepare("SELECT * FROM patches WHERE status = 'pending' ORDER BY created_at").all() : [];
      if (pending.length === 0) {
        return { content: [{ type: "text", text: "No pending patches." }] };
      }
      // Own-project rows by default. `all: true` also shows foreign rows, but as
      // id + rel_path + the root's BASENAME — never an absolute path, which is the
      // disclosure T-PROPOSEPATCH-002 records.
      const listRoot = projectRootFor(cwd);
      const legacyMode = process.env.REIN_PATCH_LEGACY === "1";
      const own = [], foreign = [], legacyRows = [];
      for (const p of pending) {
        const sc = legacyMode ? "own" : rowScope(p, listRoot);
        if (sc === "own") own.push(p);
        else if (sc === "legacy") legacyRows.push(p);
        else foreign.push(p);
      }
      const shown = args.all ? own.length + foreign.length + legacyRows.length : own.length;
      if (shown === 0) {
        const hidden = foreign.length + legacyRows.length;
        return {
          content: [{
            type: "text",
            text: hidden > 0
              ? `No pending patches for this project. (${hidden} row(s) belong to other projects or predate the boundary check — pass all:true to list them.)`
              : "No pending patches.",
          }],
        };
      }
      const lines = [`Pending patches (${shown}):`, ""];
      for (const p of own) {
        lines.push(`  ${p.id} — ${legacyMode ? p.path : (p.rel_path ?? p.path)}`);
        lines.push(`    Desc: ${p.description || "(none)"} | Created: ${p.created_at}`);
      }
      if (args.all) {
        for (const p of foreign) {
          lines.push(`  ${p.id} — ${rootLabel(p.project_root)}/${p.rel_path}  [FOREIGN_PROJECT]`);
        }
        for (const p of legacyRows) {
          lines.push(`  ${p.id} — (legacy row, no project recorded)  [LEGACY_PATCH]`);
        }
      } else if (foreign.length + legacyRows.length > 0) {
        lines.push("", `  (${foreign.length + legacyRows.length} row(s) hidden — other projects or legacy; pass all:true)`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // ── preview_patch ─────────────────────────────────────────────────────────
    case "preview_patch": {
      const db = _patchDb();
      if (!db) {
        return { content: [{ type: "text", text: "✗ state.sqlite not found — run: ai init" }], isError: true };
      }
      const patch = db.prepare("SELECT * FROM patches WHERE id = ?").get(args.patch_id);
      if (!patch) {
        return {
          content: [{ type: "text", text: `✗ Patch not found: '${args.patch_id}'.` }],
          isError: true,
        };
      }
      // A baseline is only read for a row that belongs to THIS project. For anything
      // else the stored diff is still shown — the operator can see what was proposed —
      // but no file is touched, so a path from another project cannot render its
      // contents into the output.
      const ownRoot = projectRootFor(cwd);
      const scope = rowScope(patch, ownRoot);
      if (process.env.REIN_PATCH_LEGACY === "1") {
        const formatted = formatDiff(patch.diff_content, patch.path);
        return { content: [{ type: "text", text: renderPatch(patch, formatted) }] };
      }
      if (scope === "own") {
        const target = rowTargetPath(patch, ownRoot);
        const formatted = target
          ? formatDiff(patch.diff_content, target)
          : patch.diff_content;
        return { content: [{ type: "text", text: renderPatch({ ...patch, path: target || patch.rel_path }, formatted) }] };
      }
      const banner = scope === "legacy"
        ? "[LEGACY_PATCH] this row predates the project-boundary columns — showing the stored diff only, no file was read."
        : `[FOREIGN_PROJECT] proposed in '${rootLabel(patch.project_root)}', not this project — showing the stored diff only, no file was read.`;
      return {
        content: [{
          type: "text",
          text: `${banner}\n\n` + renderPatch(
            { ...patch, path: scope === "legacy" ? "(unknown — legacy row)" : `${rootLabel(patch.project_root)}/${patch.rel_path}` },
            patch.diff_content,
          ),
        }],
      };
    }

    default:
      return { content: [{ type: "text", text: `✗ Unknown tool: ${name}` }], isError: true };
  }
});

if (isMainModule(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
