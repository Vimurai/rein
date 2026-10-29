#!/usr/bin/env node
/**
 * blueprint-aligner-mcp — AI-OS UACS MCP Server
 * Compares git diff against architect.md rules to detect sovereignty violations,
 * forbidden patterns, and missing blueprint coverage.
 *
 * Tools:
 *   align_diff(diff?, architect_content?) → PASS/FAIL alignment report
 *   validate_blueprint_section(content)   → VALID/INVALID schema depth check
 *   generate_implementation_delta(task_id, diff, blueprint_section) → IMPLEMENTATION_DELTA report
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { instrument } from "../../shared/mcp-telemetry.mjs";
import { spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { createLogger } from "../shared/logger.js";

// ── Structured logger (obs_baseline §Logging) ────────────────────────────────
const logger = createLogger("blueprint-aligner-mcp");

// ── Helpers ───────────────────────────────────────────────────────────────────
function readFileSafe(p) {
  try { return existsSync(p) ? readFileSync(p, "utf8") : ""; } catch { return ""; }
}

// E-55/E-56: hunk-aware preprocessing. Walk a unified diff and group its
// added (`+`) lines by destination file path, parsed from `+++ b/<path>`
// headers. Lines that arrive before the first such header are discarded —
// they cannot be attributed to a file and should not trigger rules. This
// is the substrate the file-path-aware introspectors below need.
export function parseDiffByFile(diff) {
  const byFile = new Map();
  let currentFile = null;
  for (const line of diff.split("\n")) {
    const fileHeader = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileHeader) {
      currentFile = fileHeader[1];
      continue;
    }
    // `---` / `diff --git` / `@@` markers reset nothing; just skip.
    if (line.startsWith("---") || line.startsWith("diff ") || line.startsWith("@@")) {
      continue;
    }
    if (!currentFile) continue;
    // Real `+` body lines, not the `+++ b/...` header (already consumed).
    if (line.startsWith("+") && !line.startsWith("++")) {
      let bucket = byFile.get(currentFile);
      if (!bucket) { bucket = []; byFile.set(currentFile, bucket); }
      bucket.push(line);
    }
  }
  return byFile;
}

// E-55: Markdown introspector. `../` inside markdown documentation prose
// (e.g. references in TASKS.md or blueprints) is not executable code and
// must not trigger CAPABILITIES_BYPASS.
export function isMarkdownFile(filePath) {
  return typeof filePath === "string" && filePath.endsWith(".md");
}

// E-55: JSON introspector. The dependency rule must only fire on
// package.json — JSON keys in state.json (`"summary":`, `"status":`) are
// state metadata, not npm deps.
export function isPackageJsonFile(filePath) {
  return filePath === "package.json" || /(^|\/)package\.json$/.test(filePath || "");
}

// E-55: JSON files are structured data, schema-validated where it matters
// (state.json via task-synchronizer-mcp). Path-like substrings inside JSON
// string values (`"summary": "...refers to ../foo..."`) are metadata, not
// executable commands. CAPABILITIES_BYPASS uses this to skip the whole file.
export function isJsonFile(filePath) {
  return typeof filePath === "string" && filePath.endsWith(".json");
}

// E-55: Inline-backtick code-span detector. Markdown and JSDoc comments
// both wrap code references in single backticks (e.g. `../shared/util.js`,
// `${SCRIPT_DIR}/../lib/assert.sh`). Splitting on the backtick character
// gives alternating outside/inside segments — the even-indexed segments
// are outside any code span. If the forbidden pattern appears only inside
// code spans, the line is documentation, not executable code.
export function traversalOutsideBackticks(line, traversalRe) {
  const parts = line.split("`");
  for (let i = 0; i < parts.length; i += 2) {
    if (traversalRe.test(parts[i])) return true;
  }
  return false;
}

// E-56: Test path excluder. Bash test helpers in tests/{suites,lib}/*.sh
// legitimately use `${SCRIPT_DIR}/../lib/assert.sh` style sibling imports;
// these are not capability bypasses.
export function isTestHelperFile(filePath) {
  return /^tests\/(suites|lib)\/[^/]+\.sh$/.test(filePath || "");
}

// v3.0 W4-T8 (aligner-hardening.md §Phase-2 context engine): internal
// path-construction introspector. A `..` quoted literal passed to a Node path
// API (resolve/join/relative/normalize/dirname) is internal path math — e.g.
// `resolve(SCRIPT_DIR, "../..")` to derive a repo root — NOT a capability
// bypass. This is distinct from the E-42 module-specifier whitelist (which only
// covers from/require/import). Fail-closed safeguards preserved: this NEVER
// whitelists a line that also references a sensitive absolute path
// (/etc/, /root/, /home/<user>/.), so `resolve("/etc/passwd")`,
// `readFile("/etc/shadow")`, and shell traversal like `cat ../../etc/passwd`
// all still FAIL.
const SENSITIVE_ABS_RE = /(?:\/etc\/|\/root\/|\/home\/\w+\/\.)/;
const PATH_BUILDER_RE =
  /\b(?:resolve|join|relative|normalize|dirname)\s*\([^)]*(["'])\.\.(?:\/[^"']*)?\1/;
export function isInternalPathBuilder(line) {
  if (typeof line !== "string") return false;
  if (SENSITIVE_ABS_RE.test(line)) return false; // sensitive abs path → never whitelist
  return PATH_BUILDER_RE.test(line);
}

const server = new Server(
  { name: "blueprint-aligner-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "align_diff",
      description:
        "Compares staged git diff against .ai/architect.md rules. Returns PASS or FAIL with specific violations. Intended as a pre-commit gate.",
      inputSchema: {
        type: "object",
        properties: {
          diff: {
            type: "string",
            description: "Git diff text to analyze (optional — reads `git diff --staged` if omitted)",
          },
          architect_content: {
            type: "string",
            description: "architect.md content to check against (optional — reads .ai/architect.md if omitted)",
          },
        },
      },
    },
    {
      name: "validate_blueprint_section",
      description:
        "Validates that a blueprint section meets minimum schema depth requirements (P-41 §28). Returns VALID or INVALID with missing components listed.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The markdown content of the blueprint section to validate.",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "generate_implementation_delta",
      description:
        "Compares a completed E-## task's diff against its blueprint section and generates an IMPLEMENTATION_DELTA report highlighting divergences. Called by orchestrator-mcp during handover (P-42 §29).",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The E-## task ID (e.g. 'E-78').",
          },
          diff: {
            type: "string",
            description: "Git diff of the implementation (optional — reads git diff HEAD~1 if omitted).",
          },
          blueprint_section: {
            type: "string",
            description: "The relevant architect.md section text that this task implements.",
          },
        },
        required: ["task_id"],
      },
    },
  ],
}));

// ── Implementation Delta Generator (P-42 §29) ──────────────────────────────
function generateDelta(taskId, diff, blueprintSection) {
  const date = new Date().toISOString().split("T")[0];

  if (!diff || !diff.trim()) {
    return `## IMPLEMENTATION_DELTA — ${taskId} (${date})\nNo diff available. Delta cannot be generated.\n`;
  }

  // Extract changed files from diff
  const changedFiles = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]);

  // Extract added functions/classes/exports (iterative regex avoids full array split on large diffs)
  const addedLines = [];
  const addedRe = /^\+(?!\+\+).*$/gm;
  let am;
  while ((am = addedRe.exec(diff)) !== null) addedLines.push(am[0]);
  const newFunctions = addedLines
    .filter(l => /^\+\s*(function|const|export|class|async)\s+\w+/i.test(l))
    .map(l => l.replace(/^\+\s*/, "").trim().slice(0, 80))
    .slice(0, 10);

  // Extract new tool/endpoint names
  const newTools = addedLines
    .filter(l => /name:\s*["'][\w-]+["']/.test(l))
    .map(l => {
      const m = l.match(/name:\s*["']([\w-]+)["']/);
      return m ? m[1] : null;
    })
    .filter(Boolean);

  // Compare against blueprint if provided
  const divergences = [];
  if (blueprintSection) {
    // Check if blueprint mentions specific file paths that weren't touched
    const blueprintPaths = [...blueprintSection.matchAll(/`([a-zA-Z0-9_\-/.]+\.\w+)`/g)]
      .map(m => m[1])
      .filter(p => p.includes("/") || p.includes("."));
    const untouched = blueprintPaths.filter(bp =>
      !changedFiles.some(cf => cf.includes(bp) || bp.includes(cf.split("/").pop()))
    );
    if (untouched.length > 0) {
      divergences.push(`Blueprint references files not touched: ${untouched.slice(0, 5).join(", ")}`);
    }

    // Check if blueprint mentions tools/APIs not found in diff
    const blueprintTools = [...blueprintSection.matchAll(/`(\w+(?:_\w+)+)`/g)]
      .map(m => m[1])
      .filter(t => /^[a-z]/.test(t) && t.length > 3);
    const missingTools = blueprintTools.filter(bt =>
      !diff.includes(bt) && !newTools.includes(bt)
    );
    if (missingTools.length > 0 && missingTools.length <= 5) {
      divergences.push(`Blueprint references identifiers not found in diff: ${missingTools.join(", ")}`);
    }
  }

  const lines = [
    `## IMPLEMENTATION_DELTA — ${taskId} (${date})`,
    ``,
    `### Files Changed`,
    ...changedFiles.map(f => `- ${f}`),
    ``,
  ];

  if (newFunctions.length > 0) {
    lines.push(`### New Definitions`);
    newFunctions.forEach(f => lines.push(`- \`${f}\``));
    lines.push(``);
  }

  if (newTools.length > 0) {
    lines.push(`### New Tools/Endpoints`);
    newTools.forEach(t => lines.push(`- ${t}`));
    lines.push(``);
  }

  if (divergences.length > 0) {
    lines.push(`### Divergences from Blueprint`);
    divergences.forEach(d => lines.push(`- ⚠ ${d}`));
    lines.push(``);
  }

  if (divergences.length === 0 && blueprintSection) {
    lines.push(`### Alignment`);
    lines.push(`✓ Implementation appears aligned with blueprint. No significant divergences detected.`);
    lines.push(``);
  }

  return lines.join("\n");
}

// ── Blueprint Schema Validation (P-41 §28) ──────────────────────────────────
// Required structural components for any architect.md blueprint section.
const BLUEPRINT_SCHEMA = [
  {
    id: "CONCEPT",
    label: "Core Concept & Value Prop",
    patterns: [
      /(?:^|\n)#+\s*.*(?:concept|value|motivation|background|purpose|why|overview)/i,
      /(?:^|\n)#+\s*\d+\.\d+\s+(?:background|motivation)/i,
    ],
    contentCheck: (text) => {
      // Must have at least 2 sentences or 30 words in relevant section
      return text.split(/\s+/).length >= 30;
    },
  },
  {
    id: "DATA_MODEL",
    label: "Data Model / State",
    patterns: [
      /(?:^|\n)#+\s*.*(?:data\s*model|state|schema|types|entities|structure)/i,
      /(?:^|\n)```(?:json|typescript|ts|graphql|sql)/i,
      /(?:^|\n)(?:type|interface|schema|table|model)\s+\w+/i,
    ],
    contentCheck: (text) => {
      // Must have a code block or at least describe data fields
      return /```/.test(text) || /\b(?:field|column|property|attribute|key)\b/i.test(text);
    },
  },
  {
    id: "API_CONTRACT",
    label: "API Contract / Interfaces",
    patterns: [
      /(?:^|\n)#+\s*.*(?:api|interface|contract|endpoint|signature|tool|method)/i,
      /(?:^|\n)#+\s*.*(?:extending|implement)/i,
      /\b(?:GET|POST|PUT|DELETE|PATCH)\s+\//i,
      /\btool:\s*`?\w+/i,
    ],
    contentCheck: (text) => {
      // Must describe at least one interface/endpoint/tool
      return /\(.*\)/.test(text) || /→|->|returns?/i.test(text) || /input|output|param/i.test(text);
    },
  },
  {
    id: "EXECUTION_FLOW",
    label: "Execution Flow / Logic",
    patterns: [
      /(?:^|\n)#+\s*.*(?:flow|logic|execution|mechanism|step|process|algorithm|workflow)/i,
      /(?:^|\n)#+\s*.*(?:proposed\s*solution|implementation)/i,
      /(?:^|\n)\d+\.\s+/m,
    ],
    contentCheck: (text) => {
      // Must have numbered steps or describe a sequence
      const hasSteps = (text.match(/(?:^|\n)\d+\.\s+/g) || []).length >= 2;
      const hasSequence = /\b(?:then|next|after|before|first|finally|step)\b/i.test(text);
      return hasSteps || hasSequence;
    },
  },
  {
    id: "ERROR_HANDLING",
    label: "Error Handling & Edge Cases",
    patterns: [
      /(?:^|\n)#+\s*.*(?:error|edge\s*case|failure|fallback|recovery|exception)/i,
      /\b(?:if\s+.*fail|when\s+.*fail|error\s+handling|graceful)/i,
    ],
    contentCheck: (text) => {
      return /\b(?:fail|error|exception|invalid|reject|block|deny|corrupt|missing|timeout)\b/i.test(text);
    },
  },
  {
    id: "SECURITY",
    label: "Security & Validation",
    patterns: [
      /(?:^|\n)#+\s*.*(?:security|validation|trust|auth|permission|capability|sanitiz)/i,
      /\b(?:validate|sanitize|escape|boundary|permission|capability)\b/i,
    ],
    contentCheck: (text) => {
      return /\b(?:validat|sanitiz|escap|trust|boundary|permission|inject|xss|csrf)\b/i.test(text);
    },
  },
];

function validateBlueprint(content) {
  if (!content || content.trim().length < 50) {
    return { valid: false, missing: BLUEPRINT_SCHEMA.map(s => s.label), feedback: "Content is too short to be a valid blueprint section." };
  }

  const missing = [];
  const found = [];

  for (const component of BLUEPRINT_SCHEMA) {
    const hasHeader = component.patterns.some(p => p.test(content));
    const hasContent = component.contentCheck(content);

    if (hasHeader && hasContent) {
      found.push(component.label);
    } else if (hasHeader) {
      // Header found but content is shallow
      missing.push(`${component.label} (header found but content is shallow — add detail)`);
    } else if (hasContent) {
      // Content exists but no clear header — count as found with advisory
      found.push(component.label);
    } else {
      missing.push(component.label);
    }
  }

  // Valid if at least 4 of 6 components are present (allows minor omissions for simple features)
  const valid = missing.length <= 2 && found.length >= 4;

  return { valid, found, missing };
}

// ── Alignment rules ───────────────────────────────────────────────────────────
// Each rule checks the diff for a violation of the System Philosophy.

// E-42: Recognise UACS authorship stamps that authorise architect-owned-file
// edits. Triggered by either:
//   • a state.json stamp of type ARCHITECT_HANDOFF dated within the last 24h, or
//   • an [ARCHITECT_HANDOFF] marker in the last 20 lines of .ai/LOG.md.
// Returns null when no stamp is found, otherwise a short reason string used
// to downgrade ARCHITECT_FILE_MODIFIED to WARN.
function detectArchitectHandoffStamp(cwd) {
  const STAMP_TYPES = /^ARCHITECT_HANDOFF$/i;
  const LOG_MARKER  = /\[ARCHITECT_HANDOFF\]/i;
  const WINDOW_MS   = 24 * 60 * 60 * 1000;

  // 1. state.json stamps (authoritative)
  try {
    const statePath = resolve(cwd, ".ai/state.json");
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSafe(statePath));
      const stamps = Array.isArray(state.stamps) ? state.stamps : [];
      const now = Date.now();
      for (let i = stamps.length - 1; i >= 0; i--) {
        const s = stamps[i];
        if (!s || !STAMP_TYPES.test(String(s.type || ""))) continue;
        const ts = Date.parse(s.timestamp || "");
        if (Number.isFinite(ts) && now - ts <= WINDOW_MS) {
          return `state.json stamp [${s.type}] at ${s.timestamp}`;
        }
      }
    }
  } catch { /* fall through to log scan */ }

  // 2. LOG.md tail (advisory)
  try {
    const log = readFileSafe(resolve(cwd, ".ai/LOG.md"));
    if (log) {
      const tail = log.split("\n").slice(-20).join("\n");
      const m = tail.match(LOG_MARKER);
      if (m) return `LOG.md marker ${m[0]} (last 20 lines)`;
    }
  } catch { /* ignore */ }

  return null;
}

const ALIGNMENT_RULES = [
  {
    id: "ARCHITECT_FILE_MODIFIED",
    severity: "FAIL",
    // Severity may be downgraded to WARN when an authorship stamp is present.
    check: (diff, cwd) => {
      const architectFiles = [".ai/architect.md", ".ai/BRIEF.md"];
      const violations = architectFiles.filter(
        (f) => diff.includes(`a/${f}`) || diff.includes(`b/${f}`)
      );
      if (violations.length === 0) return [];
      const stamp = detectArchitectHandoffStamp(cwd);
      if (stamp) {
        // Annotate the violation list so the message renderer surfaces the
        // stamp and the rule.severityOverride downgrades to WARN.
        violations.__handoffStamp = stamp;
      }
      return violations;
    },
    severityOverride: (violations) =>
      violations.__handoffStamp ? "WARN" : null,
    message: (violations) => {
      const stamp = violations.__handoffStamp;
      if (stamp) {
        return `Architect-owned files modified (${violations.join(", ")}) — handoff authorised by ${stamp}. Verify the change matches the stamped intent.`;
      }
      return `Claude modified Architect-owned files: ${violations.join(", ")} — Domain Sovereignty violation (§12). If this is an Architect handoff, record [ARCHITECT_HANDOFF] in state.json stamps or .ai/LOG.md.`;
    },
  },
  {
    id: "HARDCODED_SECRET",
    severity: "FAIL",
    check: (diff) => {
      const secretPattern = /^\+[^+].*\b(password|passwd|api.?key|secret|token|private.?key)\s*=\s*["'][^"']{4,}/gim;
      const matches = [...diff.matchAll(secretPattern)].map((m) => m[0].trim().slice(0, 60));
      return matches;
    },
    message: (violations) =>
      `Hardcoded secret detected in diff: ${violations[0]}... — Security violation (§5)`,
  },
  {
    id: "CAPABILITIES_BYPASS",
    severity: "FAIL",
    check: (diff) => {
      // Flag ../ path traversal or explicit /etc /root /home paths in code.
      // E-42: whitelist canonical ESM/CJS sibling imports — module-specifier
      // form `from "../..."`, `require("../...")`, `import("../...")`.
      // E-55: skip markdown files (prose mentions of `../` are documentation).
      // E-56: skip bash test helpers in tests/{suites,lib}/*.sh — sibling
      //       imports like `${SCRIPT_DIR}/../lib/assert.sh` are canonical.
      // Literal traversal in code (`cat ../../../etc/passwd`, `fs.readFile("/etc/shadow")`)
      // still fires.
      const traversalRe       = /(?:\.\.\/|\/etc\/|\/root\/|\/home\/\w+\/\.)/;
      const moduleSpecifierRe = /(?:from|require|import)\s*\(?\s*(["'])\.\.\/[^"']*\1/;
      const byFile = parseDiffByFile(diff);
      const matches = [];
      for (const [file, lines] of byFile) {
        if (isMarkdownFile(file)) continue;       // E-55: markdown introspector
        if (isJsonFile(file)) continue;           // E-55: JSON value strings are metadata
        if (isTestHelperFile(file)) continue;     // E-56: test path excluder
        for (const line of lines) {
          if (!traversalRe.test(line)) continue;
          if (moduleSpecifierRe.test(line)) continue; // E-42 ESM/CJS whitelist
          if (isInternalPathBuilder(line)) continue;  // v3.0 W4-T8: resolve/join("..") path math
          // E-55: skip when the only hit is inside a backtick code span
          // (JSDoc/markdown inline code reference). If the line still has
          // the pattern OUTSIDE the backticks, it's real code — flag it.
          if (!traversalOutsideBackticks(line, traversalRe)) continue;
          matches.push(line.trim().slice(0, 80));
        }
      }
      return matches;
    },
    message: (violations) =>
      `Path traversal or forbidden path in code: "${violations[0]}" — CAPABILITIES.md violation (§6)`,
  },
  {
    id: "UNAPPROVED_DEPENDENCY",
    severity: "WARN",
    check: (diff) => {
      // E-55: only fire on package.json — earlier versions matched JSON keys
      // anywhere in the diff (state.json `"summary":`, TASKS.md JSON-prose),
      // producing a recurring false-positive class.
      const pkgPattern = /^\+\s+"[a-z@][a-z0-9\-@/.]+"\s*:/;
      const byFile = parseDiffByFile(diff);
      const newDeps = [];
      for (const [file, lines] of byFile) {
        if (!isPackageJsonFile(file)) continue;
        for (const line of lines) {
          const m = line.match(pkgPattern);
          if (m) newDeps.push(m[0].trim());
        }
      }
      if (newDeps.length === 0) return [];
      // DECISIONS.md update in the same diff acts as the dependency gate.
      if (diff.includes("DECISIONS.md")) return [];
      return newDeps.slice(0, 3);
    },
    message: (violations) =>
      `New dependency added without DECISIONS.md entry: ${violations.join(", ")} — Dependency Gate violation`,
  },
  {
    id: "NO_LOG_UPDATE",
    severity: "WARN",
    check: (diff) => {
      const hasSrcChanges = diff.includes("a/src/") || diff.includes("b/src/");
      const hasLogUpdate = diff.includes(".ai/LOG.md");
      if (hasSrcChanges && !hasLogUpdate) return ["src/ changed but LOG.md not updated"];
      return [];
    },
    message: (violations) =>
      `${violations[0]} — Handover Protocol violation (update LOG.md per §12)`,
  },
  {
    // P-44: Exclusive state.json check — no TASKS.md fallback.
    // If state.json is missing, fail-safe (block commit) rather than silently pass.
    id: "TIER3_NO_SECURITY_REVIEW",
    severity: "FAIL",
    check: (diff, cwd) => {
      const statePath = resolve(cwd, ".ai/state.json");
      if (!existsSync(statePath)) {
        return ["state.json missing — run: ai migrate-state before committing"];
      }
      let state;
      try {
        state = JSON.parse(readFileSafe(statePath));
      } catch {
        return ["state.json is corrupt — run: ai migrate-state to rebuild"];
      }
      const tier3Done = (state.tasks || []).some(t => t.tier === 3 && t.status === "DONE");
      if (!tier3Done) return [];
      const hasSecStamp = (state.stamps || []).some(s => /SEC_PASS|SEC_CLEARED/i.test(s.type));
      if (hasSecStamp) return [];
      // P-44 hard-mandate: LOG.md text patterns are advisory only — they do NOT clear this gate.
      // The gate clears exclusively from stamps[] containing SEC_PASS or SEC_CLEARED.
      const logPath = resolve(cwd, ".ai/LOG.md");
      const log = readFileSafe(logPath);
      const logHint = /security_engineer|THREAT_MODEL|\[SECURITY\]|\[SEC_PASS\]/i.test(log)
        ? " (LOG.md contains security keywords — run: mcp__task-synchronizer-mcp__add_stamp to record SEC_PASS in state.json)"
        : "";
      return [`Tier 3 task marked DONE without SEC_PASS or SEC_CLEARED stamp in state.json${logHint}`];
    },
    message: (violations) =>
      `${violations[0]} — §21 Checkpoint Protocol violation: activate security_engineer before closing Tier 3 tasks`,
  },
];

instrument(server, "blueprint-aligner-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── validate_blueprint_section ─────────────────────────────────────────────
  if (name === "validate_blueprint_section") {
    const content = args.content;
    if (!content) {
      return { content: [{ type: "text", text: "✗ Missing required parameter: content" }], isError: true };
    }

    const result = validateBlueprint(content);
    const date = new Date().toISOString().split("T")[0];
    const lines = [`## Blueprint Schema Validation — ${date}`];

    if (result.valid) {
      lines.push(`Verdict: ✓ VALID`);
      lines.push(`Components found: ${result.found.join(", ")}`);
      if (result.missing.length > 0) {
        lines.push(``, `### Advisory (non-blocking)`);
        result.missing.forEach(m => lines.push(`- Consider adding: ${m}`));
      }
    } else {
      lines.push(`Verdict: ✗ INVALID`);
      if (result.found && result.found.length > 0) {
        lines.push(`Components found: ${result.found.join(", ")}`);
      }
      lines.push(``, `### Missing Components (must fix before generating E-## tasks)`);
      result.missing.forEach(m => lines.push(`- ${m}`));
      if (result.feedback) {
        lines.push(``, result.feedback);
      }
      lines.push(``, `Expand the blueprint to include the missing sections, then re-validate.`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // ── generate_implementation_delta ───────────────────────────────────────────
  if (name === "generate_implementation_delta") {
    const taskId = args.task_id;
    if (!taskId) {
      return { content: [{ type: "text", text: "✗ Missing required parameter: task_id" }], isError: true };
    }

    const cwd = process.cwd();
    let diff = args.diff;
    if (!diff) {
      const r1 = spawnSync("git", ["diff", "HEAD~1"], { cwd, encoding: "utf8", timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
      diff = r1.error ? "" : (r1.stdout || "");
    }

    let blueprintSection = args.blueprint_section;
    if (!blueprintSection) {
      // Try to auto-read the relevant section from architect.md
      const archPath = resolve(cwd, ".ai/architect.md");
      if (existsSync(archPath)) {
        const arch = readFileSync(archPath, "utf8");
        // Search for task ID reference in architect.md
        const idx = arch.indexOf(taskId);
        if (idx !== -1) {
          // Extract surrounding section (up to 200 lines around the reference)
          const before = arch.lastIndexOf("\n## ", idx);
          const after = arch.indexOf("\n## ", idx + 1);
          blueprintSection = arch.slice(
            before !== -1 ? before : Math.max(0, idx - 500),
            after !== -1 ? after : Math.min(arch.length, idx + 2000)
          );
        }
      }
    }

    const delta = generateDelta(taskId, diff, blueprintSection);
    return { content: [{ type: "text", text: delta }] };
  }

  // ── align_diff ─────────────────────────────────────────────────────────────
  if (name !== "align_diff") {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  const cwd = process.cwd();

  // Get diff
  let diff = args.diff;
  if (!diff) {
    const r2 = spawnSync("git", ["diff", "--staged"], { cwd, encoding: "utf8", timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
    diff = r2.error ? "" : (r2.stdout || "");
  }

  if (!diff.trim()) {
    return {
      content: [{ type: "text", text: "No staged changes found. Nothing to align." }],
    };
  }

  // Get architect.md
  let architectContent = args.architect_content;
  if (!architectContent) {
    const archPath = resolve(cwd, ".ai/architect.md");
    architectContent = existsSync(archPath) ? readFileSync(archPath, "utf8") : "";
  }

  // Run alignment rules
  const failures = [];
  const warnings = [];

  for (const rule of ALIGNMENT_RULES) {
    const violations = rule.check(diff, cwd);
    if (violations.length > 0) {
      const entry = { id: rule.id, message: rule.message(violations) };
      // E-42: rules may downgrade FAIL → WARN when an authorship stamp is
      // present (architect.md handoff). The override is opt-in per rule.
      const effective =
        (typeof rule.severityOverride === "function" && rule.severityOverride(violations)) ||
        rule.severity;
      if (effective === "FAIL") failures.push(entry);
      else warnings.push(entry);
    }
  }

  // Check if diff touches areas not mentioned in architect.md (orphaned work)
  const changedFiles = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
  const orphaned = changedFiles.filter((f) => {
    if (f.startsWith(".ai/")) return false; // Always valid
    const basename = f.split("/").pop().replace(/\.[^.]+$/, "");
    return architectContent && !architectContent.includes(basename);
  });
  if (orphaned.length > 0) {
    warnings.push({
      id: "ORPHANED_WORK",
      message: `Files changed but not mentioned in architect.md: ${orphaned.slice(0, 3).join(", ")} — verify these are covered by a blueprint`,
    });
  }

  const verdict = failures.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS";
  const date = new Date().toISOString().split("T")[0];

  const lines = [
    `## blueprint-aligner-mcp Report — ${date}`,
    `Verdict: ${verdict === "PASS" ? "✓ PASS" : verdict === "WARN" ? "⚠ WARN" : "✗ FAIL"}`,
    `Files analyzed: ${changedFiles.length}`,
    ``,
  ];

  if (failures.length > 0) {
    lines.push("### Failures (Block Commit)");
    failures.forEach((f) => lines.push(`- [${f.id}] ${f.message}`));
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push("### Warnings (Review Required)");
    warnings.forEach((w) => lines.push(`- [${w.id}] ${w.message}`));
    lines.push("");
  }

  if (verdict === "PASS") {
    lines.push("✓ All changes align with blueprint. Safe to commit.");
  } else if (verdict === "FAIL") {
    lines.push(`Resolve all failures before committing.\nAppend [BLUEPRINT_FAIL] ${date} to .ai/LOG.md.`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
});

if (isMainModule(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
