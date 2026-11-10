// doctor-json.test.mjs — the `rein doctor --json` renderer (E-421; D-153 r3, D-155 r5;
// release-artifact.md §Component 5). New: doctor had no machine-readable form before. The
// process boundary (records written by _dr / _dr_lines in a real doctor run) is E-421.01 in
// init_upgrade_test.sh, extending E-391.03g-h; this file covers the rules of the document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { fixOf, render, statusOf } = await import(resolve(repo, "src/shared/doctor-json.mjs"));
const rec = (...r) => r.map((f) => `${f ?? ""}\0`).join("");

test("E-421.02: a glyph maps to a status; a line with no glyph is ok", () => {
  const cases = [["✓ x", "ok"], ["○ x", "ok"], ["⚠ x", "warn"], ["! x", "warn"], ["✗ x", "fail"],
    ["- n/a", "ok"], ["? unknown", "warn"], ["ⓘ info", "ok"], ["— skipped", "ok"], ["[PRIVACY_OK] x", "ok"], ["✓", "ok"]];
  for (const [line, want] of cases) assert.equal(statusOf(`    ${line}`), want, line);
});

test("E-421.03: fix is the command after the first 'run: ', without its trailing explanation", () => {
  assert.equal(fixOf("✗ [GATE_UNREGISTERED] no PreToolUse entry runs /x/pre-tool-use.sh — run: rein sync"), "rein sync");
  assert.equal(fixOf("⚠ cannot check (helper missing — run: bash install-rein.sh)"), "bash install-rein.sh");
  assert.equal(fixOf("✗ local CI: HEAD abc FAIL — run: rein ci log --failed"), "rein ci log --failed");
  assert.equal(fixOf("✗ [CENSUS_BASELINE_STALE] 3 runs — run: rein ci run, then commit it"), "rein ci run, then commit it");
  assert.equal(fixOf("✗ ~/.claude missing"), null);
});

test("E-421.04: the document — order kept, continuations joined, (id, subject) unique, status fail > warn > ok", () => {
  const raw = rec("a", "-", "  ✓ one", "", "") + rec("b", "-", "  ✗ two — run: rein sync", "", "") +
    rec("+", "-", "      detail", "", "") + rec("c", "warn", "  [COMM_IGNORED] x", "", "") +
    rec("s", "-", "  ✓ srv", "", "x") + rec("s", "-", "  ✓ srv", "", "x") + rec("s", "-", "  ✓ s", "", "");
  const d = render(raw, "0.5.0");
  assert.equal(d.schema, 1);
  assert.equal(d.version, "0.5.0");
  assert.equal(d.status, "fail");
  assert.deepEqual(d.checks.map((c) => c.id), ["a", "b", "c", "s", "s", "s"]);
  assert.equal(d.checks[1].line, "✗ two — run: rein sync\ndetail", "indentation removed, glyph kept, continuation joined");
  assert.equal(d.checks[1].fix, "rein sync");
  assert.equal(d.checks[2].status, "warn", "an explicit status wins over the glyph");
  assert.deepEqual(d.checks.slice(3).map((c) => c.subject), ["x", "x#2", null]);
  assert.equal(render(rec("a", "-", "✓ a", "", "") + rec("b", "-", "⚠ b", "", ""), "1").status, "warn");
  assert.equal(render("", "1").status, "ok");
});

test("E-421.05: a fix may sit on a continuation line, and ends with it", () => {
  const d = render(rec("chromium", "-", "  ✗ Chromium not installed", "", "") + rec("+", "-", "    run: rein mcp-setup --browsers", "", "") +
    rec("+", "-", "    more text", "", ""), "1");
  assert.equal(d.checks[0].fix, "rein mcp-setup --browsers");
});
