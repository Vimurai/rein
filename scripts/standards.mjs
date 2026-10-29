#!/usr/bin/env node
/**
 * scripts/standards.mjs — E-80 Standards-Checker CLI.
 *
 * The `node scripts/standards.mjs` invocation named in
 * .ai/blueprints/engineering-standards.md §Components 1. Thin wrapper
 * around src/shared/standards-checker.mjs.
 *
 * Subcommands:
 *   check [--staged | --all | --file <path>] [--json]
 *     Default mode = `--staged`. Validates files via the registered
 *     rules and emits a structured report. Exit code 0 = PASS, 1 = at
 *     least one ERROR-severity violation, 2 = usage error.
 *
 *   list-rules [--json]
 *     Print every loaded rule from src/shared/standards.json.
 *
 *   --help / --version
 *     Standard banners.
 *
 * Honors AI_OS_SKIP_STANDARDS=1 (blueprint §Rollback Plan): exits 0 with
 * a stderr notice so the pre-commit hook can roll back to the legacy
 * gate without removing the wiring.
 */

import { resolve, basename, dirname } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// Locator-aware import of standards-checker.mjs (E-83, blueprint
// standards-checker-import-fix.md). Mirrors the E-52 pattern in
// scripts/generate_mcp_docs.mjs so the CLI resolves correctly both in
// the source repo and from the global install at ~/.ai-os/.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CHECKER_CANDIDATES = [
  // Repo development: scripts/ → ../src/shared/standards-checker.mjs
  resolve(SCRIPT_DIR, "../src/shared/standards-checker.mjs"),
  // Installed mode: ~/.ai-os/scripts/ → ../shared/standards-checker.mjs
  resolve(SCRIPT_DIR, "../shared/standards-checker.mjs"),
  // Absolute fallback: explicit ~/.ai-os install root.
  resolve(homedir(), ".ai-os/shared/standards-checker.mjs"),
];
let _checkerMod = null;
for (const candidate of CHECKER_CANDIDATES) {
  if (existsSync(candidate)) {
    _checkerMod = await import(candidate);
    break;
  }
}
if (!_checkerMod) {
  process.stderr.write(
    "[standards] ERROR: standards-checker.mjs not found in any candidate paths.\n"
  );
  process.exit(1);
}
const {
  loadStandards,
  validateStaged,
  validateFiles,
  reportDrift,
} = _checkerMod;

const VERSION = "1.0.0";

function _printUsage(stream = process.stderr) {
  stream.write(
    "usage: standards.mjs <subcommand> [args]\n" +
    "  check [--staged | --all | --file <path>] [--json]\n" +
    "  list-rules [--json]\n" +
    "  --version | --help\n"
  );
}

// Set by main() once standards.json is loaded; _emit needs the rule list to enumerate
// declared exemptions, and threading it through every call site of a two-argument helper
// would be a wider change than this section is worth.
let _RULES_FOR_SUMMARY = [];

function _emit(reportEnvelope, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify(reportEnvelope, null, 2) + "\n");
    return;
  }
  const { reports, summary } = reportEnvelope;
  const lines = [];
  lines.push(`Standards-Checker (E-80) — ${summary.files_checked} files checked in ${summary.elapsed_ms}ms`);
  lines.push(`  errors: ${summary.error_count} | warnings: ${summary.warning_count}`);
  lines.push("");
  for (const r of reports) {
    if (r.status === "PASS") continue;
    if (r.status === "MISSING" || r.status === "SKIPPED") continue;
    lines.push(`[${r.status}] ${r.file_path}`);
    for (const v of r.violated_rules) {
      const at = v.line != null ? `:${v.line}` : "";
      // `message` is the field the header contract names (line 122 of the checker), but
      // four of the newer rules emit `detail` instead — and this line rendered every one of
      // them as the literal text "undefined". Found while adding the E-250 summary: a
      // finding nobody can read is the reporting half of the same problem.
      lines.push(`  • [${v.severity}] ${v.rule_id}${at} — ${v.message ?? v.detail ?? "(no message)"}`);
    }
    lines.push("");
  }
  if (summary.error_count === 0 && summary.warning_count === 0) {
    lines.push("✓ Standards PASS — no violations found.");
  }

  // E-250 (D-067 §4 / D-065 §1): ON EVERY RUN, pass or fail. A suppression and a by-name
  // exemption are both coverage REDUCTIONS, and D-065's whole argument is that a reduction
  // nobody can see is indistinguishable from a rule that quietly stopped working. Printed
  // even when the count is zero: "0 active suppressions" is information; a missing section
  // is only the absence of it.
  lines.push(...formatSuppressionSummary(reportEnvelope, _RULES_FOR_SUMMARY));

  process.stdout.write(lines.join("\n") + (lines.at(-1) === "" ? "" : "\n"));
}

/**
 * The suppression + exemption section. Returns lines rather than printing them, so the
 * caller decides where they go and the tests can read them without capturing stdout.
 */
export function formatSuppressionSummary(reportEnvelope, rules = []) {
  const out = [""];
  const byRule = new Map();
  const exemptions = [];
  for (const r of reportEnvelope.reports || []) {
    for (const s of r.suppressions || []) {
      if (!byRule.has(s.rule_id)) byRule.set(s.rule_id, []);
      byRule.get(s.rule_id).push(`${s.path}:${s.line}` + (s.token && s.token !== s.rule_id ? ` (allow-${s.token})` : ""));
    }
    for (const e of r.exemptions || []) exemptions.push(e);
  }

  const total = [...byRule.values()].reduce((n, v) => n + v.length, 0);
  out.push(`Active suppressions (# standards:allow-<rule>): ${total}`);
  if (total === 0) {
    out.push("  (none)");
  } else {
    for (const [ruleId, sites] of [...byRule.entries()].sort()) {
      out.push(`  ${ruleId}: ${sites.length}`);
      for (const s of sites.sort()) out.push(`    • ${s}`);
    }
  }

  // Exemptions are listed from the CONFIG, not from what this run happened to touch: a
  // staged-file run sees only the files in the diff, and an exemption that disappears from
  // the report whenever its file is not staged would be reported as "none" on almost every
  // run — the same invisibility the section exists to end.
  const declared = [];
  for (const rule of rules) {
    for (const e of rule.exempt_files || []) {
      declared.push({ rule_id: rule.rule_id, path: e.path, reason: e.reason || "(no reason recorded)" });
    }
  }
  out.push(`By-name exemptions (standards.json): ${declared.length}`);
  if (declared.length === 0) {
    out.push("  (none)");
  } else {
    for (const e of declared.sort((a, b) => (a.rule_id + a.path < b.rule_id + b.path ? -1 : 1))) {
      const hit = exemptions.some(x => x.rule_id === e.rule_id && x.path === e.path);
      out.push(`  ${e.rule_id} → ${e.path}${hit ? "  [applied this run]" : ""}`);
      out.push(`    reason: ${e.reason}`);
    }
  }
  return out;
}

function _walkSources(root, exts = [".js", ".mjs", ".ts", ".tsx"]) {
  // Best-effort source walker for `--all`. Prunes node_modules / .git / dist.
  const out = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", ".ai-os"]);
  function visit(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = resolve(dir, ent.name);
      if (ent.isDirectory()) {
        if (skip.has(ent.name)) continue;
        visit(full);
      } else if (ent.isFile()) {
        if (exts.some(e => ent.name.endsWith(e))) out.push(full);
      }
    }
  }
  visit(resolve(root, "src"));
  return out;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.length === 0) {
    _printUsage(process.stdout);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  if (argv.includes("--version")) {
    process.stdout.write(`standards-checker v${VERSION}\n`);
    process.exit(0);
  }

  // Rollback (blueprint §Rollback Plan).
  if (process.env.AI_OS_SKIP_STANDARDS === "1") {
    process.stderr.write("[STANDARDS_SKIPPED] AI_OS_SKIP_STANDARDS=1 — bypassing rule checks\n");
    process.exit(0);
  }

  const sub = argv[0];
  const asJson = argv.includes("--json");
  const standards = (() => {
    try { return loadStandards(); }
    catch (e) {
      process.stderr.write(`✗ failed to load standards.json: ${e.message}\n`);
      process.exit(1);
    }
  })();

  _RULES_FOR_SUMMARY = standards.rules || [];

  if (sub === "list-rules") {
    if (asJson) {
      process.stdout.write(JSON.stringify(standards, null, 2) + "\n");
    } else {
      process.stdout.write(`Standards Registry (v${standards.version}) — ${standards.rules.length} rules\n\n`);
      for (const r of standards.rules) {
        process.stdout.write(`[${r.severity.toUpperCase()}] ${r.rule_id}\n`);
        process.stdout.write(`  ${r.description}\n`);
        process.stdout.write(`  applies_to: ${(r.applies_to || []).join(", ")}\n`);
        process.stdout.write(`  auto_fix_available: ${r.auto_fix_available}\n\n`);
      }
    }
    process.exit(0);
  }

  if (sub === "check") {
    const repoRoot = process.cwd();
    let envelope;

    if (argv.includes("--all")) {
      const files = _walkSources(repoRoot);
      envelope = validateFiles(files, standards.rules, { repoRoot });
    } else if (argv.includes("--file")) {
      const idx = argv.indexOf("--file");
      const path = argv[idx + 1];
      if (!path) {
        process.stderr.write("✗ --file requires a path argument\n");
        process.exit(2);
      }
      envelope = validateFiles([resolve(repoRoot, path)], standards.rules, { repoRoot });
    } else {
      // Default + --staged path.
      envelope = validateStaged(repoRoot, standards.rules);
    }

    _emit(envelope, asJson);

    // Surface drift to ai-review consumers via stderr JSON line. This is the
    // §API reportDrift surface — not the human report on stdout.
    const drift = reportDrift(envelope.reports);
    if (drift.drift_count > 0) {
      process.stderr.write(JSON.stringify({
        service: "standards-checker",
        kind:    "drift_report",
        drift,
      }) + "\n");
    }

    // Performance guard (blueprint §Execution Constraints: <200ms).
    if (envelope.summary.elapsed_ms > 200) {
      process.stderr.write(JSON.stringify({
        service: "standards-checker",
        level:   "warn",
        message: "validation exceeded 200ms budget",
        elapsed_ms: envelope.summary.elapsed_ms,
      }) + "\n");
    }

    process.exit(envelope.summary.error_count > 0 ? 1 : 0);
  }

  _printUsage();
  process.exit(2);
}

main().catch((e) => {
  process.stderr.write(`✗ standards-checker crashed: ${e.message}\n`);
  process.exit(1);
});
