// standards-cases.test.mjs — the standards checker's rules as one contract table, in process
// (E-301, D-088, test-economics.md §Consolidation Map). Table: tests/fixtures/standards-cases.json.
// Carries program_position_test (E-234), operand_retokenise_test (E-231), the pure rows of
// standards_checker_test (E-80: T-STD-S01..S08, S13, E-250.06d/07) and absorbs
// standards-test-rules.test.mjs (E-299). The CLI, validateStaged (git), the install mirrors and
// the suppression report are pre_commit_hook_test's E-80 section, where a process is under test.
//
// A row takes one of two paths, mirroring what the original assertion did:
//   - `line` or `file` + `rule`: that rule's OWN handler, called directly (D-071 §5 allows it
//     for a rule's own unit rows on a marker-free fixture). `line` is wrapped in the skill
//     template the suites used, at `path` (default src/shared/skills/x/SKILL.md); `file` is a
//     real repo file. `env` is set for the call only. HIT = the handler returned a finding.
//   - otherwise `path` + `content` (or `repeat: [line, n]`, python's `print(line + "\n" * n)`;
//     or `content_parts`, joined — a fake vendor key is never whole in the file, E-378):
//     written into a temp repo and run through validateFile with the real standards.json rules
//     (`only` filters them by rule_id prefix). HIT = a finding of `rule` (with `severity`, when
//     given); MISS = `rule` appears nowhere in the report, as the suite's grep asserted. `ids`
//     is the exact sorted set of finding ids; `status` the report status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repo, loadTable } from "../lib/check-table.mjs";
import {
  RULE_REGISTRY, loadStandards, reportDrift, validateFile, validateFiles,
} from "../../src/shared/standards-checker.mjs";

const STANDARDS_JSON = join(repo, "src/shared/standards.json");
const CHECKER = join(repo, "src/shared/standards-checker.mjs");
const standards = loadStandards();
const rules = standards.rules;
const rows = loadTable("standards");

const proj = mkdtempSync(join(tmpdir(), "aios-t-std-"));
test.after(() => rmSync(proj, { recursive: true, force: true }));

const wrap = (line) => "---\nname: x\n---\n\n## Dynamic Context Injection\n" + line + "\n";

function viaHandler(c) {
  const relPath = c.file || c.path || "src/shared/skills/x/SKILL.md";
  const content = c.file ? readFileSync(join(repo, c.file), "utf8") : wrap(c.line);
  const saved = {};
  for (const [k, v] of Object.entries(c.env || {})) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const r = RULE_REGISTRY[c.rule]({ relPath, content, lines: content.split("\n"), rule: { rule_id: c.rule } });
    return { got: r ? "HIT" : "MISS", why: JSON.stringify(r) };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function viaValidateFile(c) {
  const abs = join(proj, c.path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, c.repeat ? `${c.repeat[0]}\n`.repeat(c.repeat[1]) + "\n" : c.content ?? c.content_parts.join(""));
  const set = c.only ? rules.filter((r) => r.rule_id.startsWith(c.only)) : rules;
  return validateFile(abs, set, { repoRoot: proj });
}

const family = (c) => (c.line !== undefined || c.file ? `handler:${c.rule}` : "validateFile");

test("standards-cases: every family has both outcomes (the table cannot pass empty)", () => {
  const seen = {};
  for (const c of rows) {
    const s = (seen[family(c)] ??= new Set());
    if (c.want) s.add(c.want);
    if (c.ids) s.add(c.ids.length ? "HIT" : "MISS");
  }
  for (const f of ["handler:skill_locator_install_first", "handler:skill_consent_no_project_exec", "validateFile"]) {
    assert.deepEqual([...(seen[f] || [])].sort(), ["HIT", "MISS"], f);
  }
});

for (const c of rows) {
  test(`standards ${c.want || c.status || "ids"}: ${c.label}`, () => {
    if (c.line !== undefined || c.file) {
      const { got, why } = viaHandler(c);
      assert.equal(got, c.want, why);
      return;
    }
    const r = viaValidateFile(c);
    const why = JSON.stringify(r.violated_rules);
    if (c.want === "HIT") {
      assert.ok(r.violated_rules.some((v) => v.rule_id === c.rule && (!c.severity || v.severity === c.severity)),
        `${c.rule}${c.severity ? "/" + c.severity : ""} did not fire — ${why}`);
    }
    if (c.want === "MISS") assert.ok(!JSON.stringify(r).includes(c.rule), `${c.rule} appears — ${why}`);
    if (c.ids) {
      assert.deepEqual(r.violated_rules.map((v) => v.rule_id).sort(), c.ids, why);
      if (c.severity) assert.equal(r.violated_rules[0].severity, c.severity);
    }
    if (c.status) assert.equal(r.status, c.status, why);
  });
}

// ── standards.json and the registry (T-STD-S01/S02) ─────────────────────────────────────────
test("T-STD-S01: standards.json parses and loadStandards() returns a non-empty rules array", () => {
  JSON.parse(readFileSync(STANDARDS_JSON, "utf8"));
  assert.ok(Array.isArray(rules) && rules.length > 0);
});
test("T-STD-S01: every rule has rule_id + severity + description + auto_fix_available", () => {
  for (const r of rules) {
    assert.ok(typeof r.rule_id === "string" && r.rule_id.length > 0, JSON.stringify(r));
    assert.ok(["info", "warning", "error"].includes(r.severity), r.rule_id);
    assert.ok(typeof r.description === "string" && r.description.length > 0, r.rule_id);
    assert.equal(typeof r.auto_fix_available, "boolean", r.rule_id);
  }
});
test("T-STD-S02: every rule_id maps to a function in RULE_REGISTRY", () => {
  assert.deepEqual(rules.filter((r) => typeof RULE_REGISTRY[r.rule_id] !== "function").map((r) => r.rule_id), []);
});
test("T-STD-S02: the six E-80 rule ids are present", () => {
  const ids = rules.map((r) => r.rule_id);
  for (const rid of ["file_size_limit_lines", "mcp_stdout_purity", "no_committed_tmp_files",
    "kebab_case_filenames", "no_secrets_in_diff", "mandatory_shared_helper"]) assert.ok(ids.includes(rid), rid);
});

// ── reportDrift (T-STD-S13) ──────────────────────────────────────────────────────────────────
test("T-STD-S13: reportDrift returns drift_count and entries carrying rule_id + severity", () => {
  const abs = join(proj, "src/drift.tmp");
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "temp data\n");
  const d = reportDrift(validateFiles([abs], rules, { repoRoot: proj }).reports);
  assert.ok("drift_count" in d && Array.isArray(d.entries));
  assert.ok(d.entries.every((e) => "rule_id" in e && "severity" in e));
});

// ── E-250: exemptions live in standards.json; suppression is applied centrally ─────────────
test("E-250.06d: the tests/run.sh exemption lives in standards.json, with a reason", () => {
  const r = rules.find((x) => x.rule_id === "no_raw_exit_trap_in_tests");
  assert.ok((r.exempt_files || []).some((e) => e.path === "tests/run.sh" && e.reason));
});
test("E-250.07a/b: validateFile applies suppression centrally and reports it", () => {
  const src = readFileSync(CHECKER, "utf8");
  assert.ok(src.includes("isSuppressed(lines, v.line, rule)"));
  assert.ok(src.includes("suppressions, exemptions"));
});

// ── E-299: test_suite_naming exemptions are by name, with a reason (D-065) ──────────────────
test("E-299: both test-economics rules are registered in standards.json", () => {
  assert.deepEqual(rules.filter((r) => r.rule_id.startsWith("test_")).map((r) => r.rule_id).sort(),
    ["test_label_density", "test_suite_naming"]);
});
// E-301 renamed e143_test (mcp_role_interceptors_test); E-302 renamed e140_e141_e142_test
// (propose_patch_test) and moved robustness_p7_p12_test (mcp_servers_test + bounded-reads unit),
// so no task-named suite is left and the by-name exemption list is EMPTY (test-economics.md:
// "Task-named suites: 3 → 0"). A suite that takes one of those names again is a finding.
test("E-302: no task-named suite is exempted any more", () => {
  const naming = rules.find((r) => r.rule_id === "test_suite_naming");
  assert.deepEqual(naming.exempt_files || [], []);
  for (const path of ["tests/suites/e140_e141_e142_test.sh", "tests/suites/robustness_p7_p12_test.sh"]) {
    const r = viaValidateFile({ path, content: 'assert_status 0 "x" true\n', only: "test_" });
    assert.deepEqual(r.violated_rules.map((v) => v.rule_id), ["test_suite_naming"], path);
  }
});

// ── E-234.06c-e / E-231.06a-c: the shipped markdown corpus is clean ─────────────────────────
// The corpus is built here (find src .claude -name node_modules -prune -o -name "*.md"); the
// roots are REQUIRED and the count has a floor, so the scan cannot pass over nothing (E-251).
function corpus(root) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(join(repo, d), { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  walk(root);
  return out;
}
test("E-234.06c-e / E-231.06a-c: the src + .claude markdown corpus is built and has no locator findings", () => {
  for (const r of ["src", ".claude"]) assert.ok(existsSync(join(repo, r)), `corpus root ${r} missing`);
  const files = [...corpus("src"), ...corpus(".claude")];
  assert.ok(files.length >= 100, `corpus has ${files.length} files, floor 100`);
  const hits = [];
  for (const f of files) {
    const c = readFileSync(join(repo, f), "utf8");
    const r = RULE_REGISTRY.skill_locator_install_first({ relPath: f, content: c, lines: c.split("\n"),
      rule: { rule_id: "skill_locator_install_first" } });
    if (r) hits.push(`${f}: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(hits, [], `scanned ${files.length} files`);
});
