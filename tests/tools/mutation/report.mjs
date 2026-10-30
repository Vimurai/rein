#!/usr/bin/env node
// report.mjs — E-300 (D-088 §Component 5): merge pass A (Stryker over the unit layer) and
// pass B (gate survivors against the contract tables) into the probe report P-44 reads.
//
// Usage: node report.mjs <pass-a.json> <pass-b.json> <out.json> <commit>
// Writes <out.json>; prints the markdown summary (the COMM.md packet) on stdout.
//
// Per module: mutants, killed (unit), killed (tables), survived, no coverage, score.
//   score = detected / (detected + undetected), detected = Killed + Timeout (Stryker's).
// Survivors: file:line, mutator, replacement. A survivor in the gate (src/mcp/safe-exec-mcp)
//   that also survived pass B is a MISSING contract-table row.
// Tests: per unit test file, the mutants it kills; one that kills none is a deletion candidate.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [, , passA, passB, outFile, commit = ""] = process.argv;
if (!passA || !passB || !outFile) {
  process.stderr.write("usage: report.mjs <pass-a.json> <pass-b.json> <out.json> [commit]\n");
  process.exit(2);
}
const GATE_DIR = "src/mcp/safe-exec-mcp/";
const a = JSON.parse(readFileSync(passA, "utf8"));
const b = JSON.parse(readFileSync(passB, "utf8"));
const tableVerdict = new Map(b.results.map((r) => [`${r.file}#${r.id}`, r]));

// Test ids → test file (the tap runner runs one file per "test").
const testName = new Map();
for (const [file, entry] of Object.entries(a.testFiles || {})) {
  for (const t of entry.tests || []) testName.set(t.id, file || t.name);
}
const kills = new Map([...new Set(testName.values())].map((f) => [f, 0]));
const covers = new Map([...kills.keys()].map((f) => [f, 0]));

const DETECTED = new Set(["Killed", "Timeout"]);
const modules = [];
const survivors = [];
for (const [file, entry] of Object.entries(a.files).sort(([x], [y]) => x.localeCompare(y))) {
  const gate = file.startsWith(GATE_DIR);
  const row = { file, gate, mutants: 0, killed_unit: 0, killed_tables: 0, survived: 0, no_coverage: 0, ignored: 0 };
  for (const m of entry.mutants) {
    for (const id of m.killedBy || []) { const f = testName.get(id) || id; kills.set(f, (kills.get(f) || 0) + 1); }
    for (const id of m.coveredBy || []) { const f = testName.get(id) || id; covers.set(f, (covers.get(f) || 0) + 1); }
    if (m.status === "Ignored" || m.status === "CompileError" || m.status === "RuntimeError") { row.ignored++; continue; }
    row.mutants++;
    if (DETECTED.has(m.status)) { row.killed_unit++; continue; }
    const t = gate ? tableVerdict.get(`${file}#${m.id}`) : null;
    if (t && DETECTED.has(t.status)) { row.killed_tables++; continue; }
    // No coverage = nothing executes it: no unit test, and (in the gate) no table either. A gate
    // mutant a table EXECUTED without detecting it survived, whatever pass A said.
    const unexecuted = gate ? !t || t.reason === "no table executes it" : m.status === "NoCoverage";
    if (gate ? unexecuted && m.status === "NoCoverage" : unexecuted) row.no_coverage++; else row.survived++;
    survivors.push({
      file, line: m.location.start.line, column: m.location.start.column,
      mutator: m.mutatorName, replacement: m.replacement, unit_status: m.status,
      gate, missing_table_row: gate, table_executed: gate ? !unexecuted : null, table_reason: t ? t.reason : null,
    });
  }
  const detected = row.killed_unit + row.killed_tables;
  row.score = row.mutants ? Math.round((1000 * detected) / row.mutants) / 10 : null;
  row.unit_score = row.mutants ? Math.round((1000 * row.killed_unit) / row.mutants) / 10 : null;
  modules.push(row);
}

const tests = [...kills.keys()].sort().map((f) => ({ test_file: f, kills: kills.get(f), covers: covers.get(f) || 0 }));
const killNothing = tests.filter((t) => t.kills === 0).map((t) => t.test_file);
const out = {
  schema: "rein-mutation-probe/1",
  date: new Date().toISOString(),
  commit,
  tool: "@stryker-mutator/core + tap-runner 10.0.0 (pass A); tests/tools/mutation/gate-pass.mjs (pass B)",
  scope: ["src/shared", "src/mcp/shared", "src/mcp/safe-exec-mcp"],
  test_commands: { pass_a: "node --test tests/unit (tap runner, perTest)", pass_b: `contract tables: ${b.tables.join(", ")}` },
  modules, tests, kill_nothing: killNothing,
  survivors,
  missing_table_rows: survivors.filter((s) => s.missing_table_row).length,
  pass_b_crosscheck_disagreements: b.disagreements || [],
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(out, null, 2));

// ── markdown packet ─────────────────────────────────────────────────────────────────────────
const tot = modules.reduce((s, m) => ({ n: s.n + m.mutants, d: s.d + m.killed_unit + m.killed_tables, u: s.u + m.killed_unit }), { n: 0, d: 0, u: 0 });
const pct = (x, n) => (n ? `${Math.round((1000 * x) / n) / 10}%` : "—");
const L = [];
L.push(`Mutation probe (E-300) on ${commit || "HEAD"}: ${tot.n} mutants, ${pct(tot.d, tot.n)} detected overall (${pct(tot.u, tot.n)} by the unit layer alone). Report: ${outFile}`);
L.push("");
L.push("| module | mutants | unit | tables | survived | no cov | score |");
L.push("|---|---:|---:|---:|---:|---:|---:|");
for (const m of [...modules].sort((x, y) => (x.score ?? 101) - (y.score ?? 101))) {
  L.push(`| ${m.file}${m.gate ? " (gate)" : ""} | ${m.mutants} | ${m.killed_unit} | ${m.gate ? m.killed_tables : "—"} | ${m.survived} | ${m.no_coverage} | ${m.score ?? "—"}% |`);
}
L.push("");
L.push(`Unit tests that kill no mutant in scope (deletion candidates — or they test code outside the probed dirs): ${killNothing.length ? killNothing.join(", ") : "none"}`);
L.push(`Per-test kills: ${tests.map((t) => `${t.test_file.replace(/^tests\/unit\//, "")} ${t.kills}`).join(", ")}`);
L.push("");
L.push(`Pass B in-process vs spawn cross-check: ${(b.disagreements || []).length} disagreement(s).`);
const gs = survivors.filter((x) => x.gate);
const byMut = new Map();
for (const s of gs) byMut.set(s.mutator, (byMut.get(s.mutator) || 0) + 1);
L.push(`Gate survivors after the contract tables (MISSING table rows): ${out.missing_table_rows} — ${gs.filter((x) => x.table_executed).length} executed by a table but not detected, ${gs.filter((x) => !x.table_executed).length} on lines no table executes.`);
L.push(`By mutator (StringLiteral survivors are mostly report/log text, not behaviour): ${[...byMut].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`);
L.push("Top lines:");
const byLine = new Map();
for (const s of survivors.filter((x) => x.gate)) {
  const k = `${s.file}:${s.line}`;
  byLine.set(k, (byLine.get(k) || 0) + 1);
}
for (const [k, n] of [...byLine].sort((x, y) => y[1] - x[1]).slice(0, 25)) L.push(`- ${k} (${n})`);
process.stdout.write(L.join("\n") + "\n");
