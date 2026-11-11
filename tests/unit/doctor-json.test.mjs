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

// E-427 (D-158 r8-r11): extends E-421.04 — every record's scope comes from ONE table. The guard:
// an id a call site emits (`_dr <id>` / `_dr_lines <id>` in src/bin/rein) that the table lacks
// fails, and so does a table id no call site has. The E-421.01 contract row checks the ids a real
// doctor run emits.
test("E-427.01: doctor-scopes.json covers exactly the ids src/bin/rein emits; render takes scope from it", async () => {
  const { readFileSync } = await import("node:fs");
  const { loadScopes } = await import(resolve(repo, "src/shared/doctor-json.mjs"));
  const scopes = loadScopes(resolve(repo, "src/shared/doctor-scopes.json"));
  const src = readFileSync(resolve(repo, "src/bin/rein"), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const emitted = new Set([...src.matchAll(/(?:^|[\s;|(&])_dr(?:_lines)? ([a-z][a-z0-9_]*)\b/gm)].map((m) => m[1]));
  assert.ok(emitted.size >= 50, `only ${emitted.size} call-site ids found — the scan is broken`);
  assert.deepEqual([...emitted].filter((id) => !(id in scopes)).sort(), [], "call-site ids missing from doctor-scopes.json");
  assert.deepEqual(Object.keys(scopes).filter((id) => !emitted.has(id)).sort(), [], "table ids no call site emits");
  for (const [id, s] of Object.entries(scopes)) assert.ok(["install", "host", "project"].includes(s), `${id}: ${s}`);
  const d = render(rec("version", "-", "  ✓ version: x", "", "") + rec("tmux", "-", "  ✓ tmux", "", ""), "1", scopes);
  assert.deepEqual(d.checks.map((c) => c.scope), ["install", "host"]);
});
