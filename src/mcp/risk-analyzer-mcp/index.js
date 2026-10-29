#!/usr/bin/env node
/**
 * risk-analyzer-mcp — AI-OS TSRT MCP Server
 * Classifies intent and git changes as Tier 1/2/3 using multi-signal analysis.
 * Enables gate skipping and token savings per architect.md §14.
 *
 * Tier 1 (Low Risk):  CSS/docs/typos — skip Critic + Security agents
 * Tier 2 (Medium Risk): Logic/refactor/tests — run unit tests + blueprint_aligner
 * Tier 3 (High Risk): Auth/secrets/new features/breaking — full Triad required
 *
 * Tools:
 *   classify_risk(content?, diff?, files?)   → Tier + confidence + reasoning + actions
 *   get_tier_actions(tier)                   → Specific gates to run/skip for that tier
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
const logger = createLogger("risk-analyzer-mcp");

const server = new Server(
  { name: "risk-analyzer-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Signal definitions ────────────────────────────────────────────────────────

const TIER3_CONTENT_SIGNALS = [
  { pattern: /\b(auth|oauth|jwt|saml|sso)\b/i, label: "authentication system", weight: 3 },
  { pattern: /\b(secret|api.?key|private.?key|credential|passphrase)\b/i, label: "secret/credential", weight: 3 },
  { pattern: /\b(password|passwd|bcrypt|argon2|pbkdf)\b/i, label: "password handling", weight: 3 },
  { pattern: /\b(deploy|deployment|production|release|publish)\b/i, label: "deployment/release", weight: 2 },
  { pattern: /\b(migration|schema.?change|breaking.?change|major.?version)\b/i, label: "breaking/migration", weight: 3 },
  { pattern: /\b(rbac|permission|role|acl|policy|access.?control)\b/i, label: "access control", weight: 3 },
  { pattern: /\b(csrf|xss|injection|sanitize|escape|validate.?input)\b/i, label: "security hardening", weight: 2 },
  { pattern: /\b(encryption|decrypt|cipher|tls|ssl|certificate)\b/i, label: "encryption", weight: 2 },
  { pattern: /\b(new.?feature|new.?system|new.?service|new.?module)\b/i, label: "new system/feature", weight: 2 },
  { pattern: /\b(dependency|npm.?install|pip.?install|go.?get|cargo.?add)\b/i, label: "new dependency", weight: 2 },
];

const TIER2_CONTENT_SIGNALS = [
  { pattern: /\b(refactor|restructure|reorganize)\b/i, label: "refactor", weight: 2 },
  { pattern: /\b(logic|algorithm|business.?rule|calculation)\b/i, label: "business logic", weight: 2 },
  { pattern: /\b(api|endpoint|route|handler|controller)\b/i, label: "API changes", weight: 2 },
  { pattern: /\b(database|query|sql|orm|model|schema)\b/i, label: "database", weight: 2 },
  { pattern: /\b(test|spec|coverage|unit.?test|integration)\b/i, label: "tests", weight: 1 },
  { pattern: /\b(implement|build|create|add|integrate)\b/i, label: "implementation", weight: 1 },
  { pattern: /\b(config|configuration|settings|environment)\b/i, label: "configuration", weight: 1 },
  { pattern: /\b(performance|optimize|cache|memo|lazy)\b/i, label: "performance", weight: 1 },
];

const TIER1_CONTENT_SIGNALS = [
  { pattern: /\b(typo|spelling|grammar|wording)\b/i, label: "typo/text fix", weight: 2 },
  { pattern: /\b(css|style|color|font|layout|spacing|padding|margin)\b/i, label: "styling", weight: 2 },
  { pattern: /\b(docs?|documentation|readme|comment|changelog)\b/i, label: "documentation", weight: 2 },
  { pattern: /\b(format|lint|prettier|whitespace|indent)\b/i, label: "formatting", weight: 2 },
  { pattern: /\b(rename|move.?file|reorganize.?folder)\b/i, label: "rename/move", weight: 1 },
];

const TIER3_FILE_PATTERNS = [
  /auth/i, /login/i, /password/i, /secret/i, /\.env/i, /credential/i,
  /migration/i, /deploy/i, /release/i, /CHANGELOG/i, /package\.json$/i,
  /security/i, /permission/i, /role/i, /token/i,
];

const TIER2_FILE_PATTERNS = [
  /src\//i, /lib\//i, /api\//i, /routes\//i, /controllers?\//i,
  /models?\//i, /services?\//i, /hooks\//i, /utils\//i, /helpers?\//i,
  /tests?\//i, /specs?\//i, /\.test\./i, /\.spec\./i,
];

const TIER1_FILE_PATTERNS = [
  /\.css$/i, /\.scss$/i, /\.less$/i, /\.md$/i, /README/i,
  /CONTRIBUTING/i, /\.txt$/i, /docs\//i, /\.json$/i,
];

// ── Classifier ────────────────────────────────────────────────────────────────

function classifyContent(text) {
  if (!text) return { tier: null, score: 0, signals: [] };

  let t3Score = 0, t2Score = 0, t1Score = 0;
  const signals = [];

  for (const sig of TIER3_CONTENT_SIGNALS) {
    if (sig.pattern.test(text)) { t3Score += sig.weight; signals.push({ tier: 3, label: sig.label }); }
  }
  for (const sig of TIER2_CONTENT_SIGNALS) {
    if (sig.pattern.test(text)) { t2Score += sig.weight; signals.push({ tier: 2, label: sig.label }); }
  }
  for (const sig of TIER1_CONTENT_SIGNALS) {
    if (sig.pattern.test(text)) { t1Score += sig.weight; signals.push({ tier: 1, label: sig.label }); }
  }

  const total = t1Score + t2Score + t3Score || 1;
  if (t3Score >= 2) return { tier: 3, score: t3Score, confidence: Math.min(99, Math.round((t3Score / total) * 100)), signals };
  if (t2Score >= 2) return { tier: 2, score: t2Score, confidence: Math.min(99, Math.round((t2Score / total) * 100)), signals };
  if (t1Score >= 1) return { tier: 1, score: t1Score, confidence: Math.min(99, Math.round((t1Score / total) * 100)), signals };
  return { tier: 2, score: 1, confidence: 50, signals }; // Default to Tier 2 when ambiguous
}

function classifyFiles(changedFiles) {
  if (!changedFiles || changedFiles.length === 0) return { tier: null, signals: [] };

  let maxTier = 1;
  const signals = [];

  for (const file of changedFiles) {
    if (TIER3_FILE_PATTERNS.some((p) => p.test(file))) {
      maxTier = Math.max(maxTier, 3);
      signals.push({ tier: 3, label: `file: ${file}` });
    } else if (TIER2_FILE_PATTERNS.some((p) => p.test(file))) {
      maxTier = Math.max(maxTier, 2);
      signals.push({ tier: 2, label: `file: ${file}` });
    } else if (TIER1_FILE_PATTERNS.some((p) => p.test(file))) {
      signals.push({ tier: 1, label: `file: ${file}` });
    }
  }

  return { tier: maxTier, signals };
}

function mergeTiers(contentResult, fileResult) {
  const tier = Math.max(
    contentResult.tier ?? 1,
    fileResult.tier ?? 1
  );
  const allSignals = [
    ...contentResult.signals.filter((s) => s.tier >= tier - 1),
    ...fileResult.signals.filter((s) => s.tier >= tier - 1),
  ].slice(0, 8);
  const confidence = contentResult.confidence ?? 60;
  return { tier, confidence, signals: allSignals };
}

// ── Tier actions ──────────────────────────────────────────────────────────────

const TIER_ACTIONS = {
  1: {
    label: "Tier 1 — Low Risk (CSS/Docs/Typos)",
    run: ["Linter/Prettier (local, 0 tokens)"],
    skip: ["Critic agents", "Security review", "Vibe audit", "Chaos test"],
    handover: "Auto-commit with [TIER_1] tag. No agent review required.",
    commit_tag: "[TIER_1]",
    token_cost: "~0 tokens",
  },
  2: {
    label: "Tier 2 — Medium Risk (Logic/Refactor/Tests)",
    run: ["Unit tests (local, 0 tokens)", "blueprint-aligner-mcp (pattern check)"],
    skip: ["Security review", "Vibe audit", "Chaos test"],
    handover: "Requires manual Thumbs Up in chat. Run: blueprint-aligner-mcp align_diff",
    commit_tag: "[TIER_2]",
    token_cost: "~500–2000 tokens (blueprint_aligner only)",
  },
  3: {
    label: "Tier 3 — High Risk (Auth/Secrets/Breaking Changes)",
    run: [
      "security_engineer agent",
      "skill: ai-test --vibe (ux_reviewer + chaos_monkey)",
      "skill: ai-review (Tier 3 = full parallel critics: arch + security + tests)",
      "blueprint-aligner-mcp",
      "safe-exec-mcp for shell commands",
    ],
    skip: [],
    handover: "Mandatory [UACS_VERIFIED] stamp + Architect sign-off before commit.",
    commit_tag: "[TIER_3]",
    token_cost: "~5000–20000 tokens (full Triad)",
  },
};

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "classify_risk",
      description:
        "Classifies intent/changes as Tier 1, 2, or 3 using multi-signal analysis of intent content and git diff. Returns tier, confidence, signals, and required actions.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Intent content to analyze (mandatory)",
          },
          diff: {
            type: "string",
            description: "Git diff text to analyze (optional — reads `git diff --staged` if omitted)",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description: "List of changed file paths (optional — extracted from diff if omitted)",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "get_tier_actions",
      description:
        "Returns the specific gates to run and skip for a given tier, with token cost estimate.",
      inputSchema: {
        type: "object",
        properties: {
          tier: {
            type: "number",
            description: "Risk tier (1, 2, or 3)",
            enum: [1, 2, 3],
          },
        },
        required: ["tier"],
      },
    },
  ],
}));

instrument(server, "risk-analyzer-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "classify_risk": {
      const content = args.content;
      if (!content) {
        return { content: [{ type: "text", text: "✗ 'content' argument is mandatory for classify_risk." }], isError: true };
      }

      // Get diff and extract changed files
      let diff = args.diff;
      if (!diff) {
        const spawnOpts = { cwd: process.cwd(), encoding: "utf8", timeout: 10000, maxBuffer: 10 * 1024 * 1024 };
        const rs = spawnSync("git", ["diff", "--staged"], spawnOpts);
        diff = rs.error ? "" : (rs.stdout || "");
        if (!diff.trim()) {
          const rh = spawnSync("git", ["diff", "HEAD"], spawnOpts);
          diff = rh.error ? "" : (rh.stdout || "");
        }
      }

      const changedFiles = args.files ??
        [...(diff ?? "").matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);

      // Classify
      const contentResult = classifyContent(content);
      const fileResult = classifyFiles(changedFiles);
      const { tier, confidence, signals } = mergeTiers(contentResult, fileResult);
      const actions = TIER_ACTIONS[tier];

      const date = new Date().toISOString().split("T")[0];
      const report = [
        `## risk-analyzer-mcp Classification — ${date}`,
        ``,
        `**${actions.label}**`,
        `Confidence: ${confidence}%`,
        ``,
        `### Signals Detected`,
        signals.length > 0
          ? signals.map((s) => `- [Tier ${s.tier}] ${s.label}`).join("\n")
          : "- No strong signals — defaulting to Tier 2",
        ``,
        `### Required Actions`,
        actions.run.map((a) => `- ✓ Run: ${a}`).join("\n"),
        actions.skip.length > 0
          ? actions.skip.map((s) => `- ✗ Skip (TSRT): ${s}`).join("\n")
          : "",
        ``,
        `### Handover`,
        actions.handover,
        `Commit tag: \`${actions.commit_tag}\``,
        `Token cost estimate: ${actions.token_cost}`,
        ``,
        tier === 1
          ? `[TIER_1] Append to commit message: "${actions.commit_tag} <description>"`
          : tier === 2
          ? `[TIER_2] Run blueprint-aligner-mcp before committing.`
          : `[TIER_3] Full Triad required. Do not commit until [UACS_VERIFIED] is in LOG.md.`,
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text", text: report }] };
    }

    case "get_tier_actions": {
      const t = args.tier;
      const actions = TIER_ACTIONS[t];
      if (!actions) {
        return { content: [{ type: "text", text: `Invalid tier: ${t}. Use 1, 2, or 3.` }], isError: true };
      }

      const report = [
        `## Tier ${t} Actions — ${actions.label}`,
        `Token cost estimate: ${actions.token_cost}`,
        ``,
        `### Run`,
        actions.run.map((a) => `- ${a}`).join("\n"),
        ``,
        actions.skip.length > 0 ? `### Skip (TSRT — token savings)\n${actions.skip.map((s) => `- ${s}`).join("\n")}` : "",
        ``,
        `### Handover`,
        actions.handover,
        `Commit tag: \`${actions.commit_tag}\``,
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text", text: report }] };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
});

if (isMainModule(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
