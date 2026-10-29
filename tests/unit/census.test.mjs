// tests/unit/census.test.mjs — node:test unit suite for tests/tools/census.mjs (E-297, D-088)
//
// The census is the evidence the Consolidation Map (P-44) deletes and merges on, so its
// derivations are pinned here against a FIXTURE repository whose overlap is known by
// construction: which suites must come out as merge / move-to-unit / delete / misnamed
// candidates, and which must not. Everything runs in temp dirs; HOME and TMPDIR are
// redirected for the CLI run, so nothing here reads or writes the real ~/.rein.
//
// Run standalone: node --test tests/unit/census.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  inventory, staticFacts, resolveTarget, spawnShape, parseCensusLines, parseCiLogForCensus,
  failureHistory, overlap, hubFiles, deriveCandidates, buildCensus, renderMarkdown, MISNAMED_RE,
  baselineFromLog, BASELINE_HEADER, CENSUS_BASELINE,
} from "../tools/census.mjs";

const CENSUS = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "census.mjs");

function tmp(label) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `rein-t-census-${label}-`)));
  return { d, done: () => rmSync(d, { recursive: true, force: true }) };
}

function put(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

// ── The fixture repository ───────────────────────────────────────────────────
// alpha        node a.mjs, an -e import of b.mjs, node e.mjs, node f.mjs  {a,b,e,f}
//              → pure-node; overlap with alpha_twin 4/5; covered by alpha_twin
// alpha_twin   a,b,e,f named statically + bash hooks/h2.sh               {a,b,e,f,h2}
// beta         node e.mjs only, never failed                              → delete:alpha
// table        the contract-table runner (x-cases.json) over c.mjs        → never a delete
// gamma        node c.mjs, never failed                                   → delete:table
// flaky        node d.mjs, FAILED in CI                                   → paid rent: no delete
// e123_widget  bash hooks/h.sh                                            → misnamed
// hub1..hub5   ai <subcommand> only — src/bin/ai is a HUB                 → nothing
// installer    alpha_twin: declared subject with 2 runs; hub1: an UNDECLARED ai init; beta: declared, none measured
const SUITES = {
  alpha: 'source tests/lib/assert.sh\nassert_contains "E-1.01a: a" x "$(node src/shared/a.mjs)"\nassert_status 0 "E-1.01b: b" true\n',
  alpha_twin: '# REIN_INSTALLER_SUBJECT\nassert_contains "abef" x "$(cat src/shared/a.mjs src/shared/b.mjs src/shared/e.mjs src/shared/f.mjs)"\n',
  beta: '#!/usr/bin/env bash\n# REIN_INSTALLER_SUBJECT\nassert_status 0 "plain e" node src/shared/e.mjs\n',
  table: 'run_table "${R}/tests/fixtures/x-cases.json"   # node src/shared/c.mjs\nassert_status 0 "table" true\n',
  gamma: 'assert_status 0 "c once" node src/shared/c.mjs\n',
  flaky: 'assert_status 0 "d" node src/shared/d.mjs\n',
  e123_widget: 'assert_status 0 "E-123.04a: widget" bash hooks/h.sh\n# T-SEC-001 in a comment is not counted\n',
  hub1: 'assert_status 0 "x" ai one\n', hub2: 'assert_status 0 "x" ai two\n', hub3: 'assert_status 0 "x" ai three\n',
  hub4: 'assert_status 0 "x" ai four\n', hub5: 'assert_status 0 "x" ai five\n',
};

// The census input tests/run.sh would have written for this repo (CENSUS_FP lines carry the
// recorder's targets exactly as footprint.sh records them).
function censusInput(root) {
  const fp = [
    ["alpha", "node", "src/shared/a.mjs"], ["alpha", "node", "-e:src/shared/b.mjs"],
    ["alpha", "node", "src/shared/e.mjs"], ["alpha", "node", "src/shared/f.mjs"],
    ["alpha_twin", "bash", "hooks/h2.sh"],
    ["beta", "node", "src/shared/e.mjs"],
    ["table", "node", "src/shared/c.mjs"],
    ["gamma", "node", "src/shared/c.mjs"],
    ["flaky", "node", `${root}/src/shared/d.mjs`],      // an absolute path the recorder could not strip
    ["e123_widget", "bash", "hooks/h.sh"],
    ["hub1", "ai", "one"], ["hub2", "ai", "two"], ["hub3", "ai", "three"], ["hub4", "ai", "four"], ["hub5", "ai", "five"],
    // E-311: installer lines — alpha_twin is a declared subject, hub1 runs `ai init` undeclared.
    // E-312: …each with its spawn's HOME class: alpha_twin's own temp HOME and run HOME (shared
    // lane), hub1's foreign one (exclusive).
    ["alpha_twin", "installer", "install-rein.sh\ttmp"], ["alpha_twin", "installer", "ai init\trun"],
    ["hub1", "installer", "ai init\tforeign:/srv/shared"],
  ];
  const lines = ["CENSUS_RUN\t2026-10-04T10:00:00Z\tabc\t*_test.sh"];
  for (const s of Object.keys(SUITES)) lines.push(`CENSUS_SUITE\t${s}_test.sh\t${s === "alpha" ? 2500 : 100}\t2\t0\t0\t0`);
  for (const [s, c, a] of fp) lines.push(`CENSUS_FP\t${s}_test.sh\t1\t${c}\t${a}`);
  lines.push(`CENSUS_TOTAL\t${Object.keys(SUITES).length}\t22\t0\t0`);
  return `${lines.join("\n")}\n`;
}

function ciLog(root, { sha, started, dirty = 0, failed = [], passed = [], census = "" }) {
  return [
    "[ci] ai ci run — Rein 3.1.0",
    `[ci] sha=${sha} ref=HEAD dirty=${dirty} started_at=${started}`,
    `[ci] repo=${root}`,
    "[ci] ── suite: /bin/bash tests/run.sh",
    census,
    "━━ Results ━━━━━━━━━━━━━━",
    ...passed.map((s) => `  ✓ ${s}_test.sh (2 passed)`),
    ...failed.map((s) => `  ✗ ${s}_test.sh (1 passed, 1 failed)`),
    "   Total: 9 passed, 1 failed",
    `[ci] finished status=${failed.length ? "FAIL" : "PASS"} duration_ms=1000 finished_at=${started}`,
  ].join("\n");
}

function fixtureRepo() {
  const t = tmp("repo");
  const r = t.d;
  for (const f of ["a", "b", "c", "d", "e", "f"]) put(r, `src/shared/${f}.mjs`, `export const ${f} = 1;\n`);
  put(r, "src/bin/ai", "#!/usr/bin/env bash\necho ai\n");
  put(r, "hooks/h.sh", "#!/usr/bin/env bash\nexit 0\n");
  put(r, "hooks/h2.sh", "#!/usr/bin/env bash\nexit 0\n");
  put(r, "src/README.md", "not code\n");
  put(r, "tests/fixtures/x-cases.json", "[]\n");
  put(r, "tests/unit/one.test.mjs", "// unit\n");
  for (const [s, body] of Object.entries(SUITES)) put(r, `tests/suites/${s}_test.sh`, `#!/usr/bin/env bash\n${body}`);
  const logs = join(r, "ci-logs");
  const all = Object.keys(SUITES);
  put(r, "ci-logs/1.log", ciLog(r, { sha: "a".repeat(40), started: "2026-10-01T10:00:00Z",
    failed: ["flaky"], passed: all.filter((s) => s !== "flaky") }));
  put(r, "ci-logs/2.log", ciLog(r, { sha: "b".repeat(40), started: "2026-10-02T10:00:00Z",
    passed: all, census: censusInput(r) }));
  // Another project's run in the same (shared) log directory must be ignored entirely.
  put(r, "ci-logs/3.log", ciLog("/somewhere/else", { sha: "c".repeat(40), started: "2026-10-03T10:00:00Z",
    failed: ["alpha", "beta", "gamma"] }));
  return { ...t, r, logs };
}

// ── inventory + static facts ─────────────────────────────────────────────────
test("inventory: suites, unit files, and line totals (src counts code only)", () => {
  const f = fixtureRepo();
  try {
    const inv = inventory(f.r);
    assert.equal(inv.suites.length, Object.keys(SUITES).length);
    assert.equal(inv.unitFiles.length, 1);
    assert.equal(inv.srcLines, 6 + 2 + 2 + 2, "6 one-line modules + src/bin/ai + two hooks; README excluded");
    assert.ok(inv.srcSet.has("hooks/h.sh") && inv.srcSet.has("src/bin/ai"));
  } finally { f.done(); }
});

test("staticFacts: assertions, task labels in assertion text, src/hooks refs, table runner, fixed sleeps", () => {
  const src = new Set(["src/shared/a.mjs", "src/shared/b.mjs", "hooks/h.sh"]);
  const f = staticFacts([
    'assert_contains "E-1.01a: a" x "$(node "${R}/src/shared/a.mjs")"',
    '  _pass "T-SEC-001 + P-44.2 both labels"',
    '# assert_status 0 "E-9.99: a comment is not an assertion" true',
    "assert_summary",
    'bash hooks/h.sh; cat src/shared/missing.mjs; ls src/shared/',
    'run "$R/tests/fixtures/arch-write-cases.json"',
    "sleep 1   # REIN_SLEEP_ALLOWED: negative wait",
    "  sleep 0.5",
    "# guessed with `sleep 2` (a comment still counts: the acceptance grep is plain)",
    "wait_for '[ -e f ]' 1000",
  ].join("\n"), src);
  assert.equal(f.assertions, 2);
  assert.deepEqual([f.sleepsAllowed, f.sleepsUnmarked], [1, 2], "E-307: fixed sleeps, allowed vs unmarked");
  assert.equal(f.labels, 3);
  assert.deepEqual(f.refs, ["hooks/h.sh", "src/shared/a.mjs"], "only files that exist; dirs and missing files are not footprint");
  assert.equal(f.tableRunner, true);
});

test("misnamed: the blueprint's task-id pattern", () => {
  for (const n of ["e143_test.sh", "e140_e141_e142_test.sh", "robustness_p7_p12_test.sh", "ui_e2_test.sh"]) assert.match(n, MISNAMED_RE, n);
  for (const n of ["pane_binding_test.sh", "ai_ci_run_test.sh", "telemetry_isolation_test.sh"]) assert.doesNotMatch(n, MISNAMED_RE, n);
});

// ── dynamic footprint ────────────────────────────────────────────────────────
test("resolveTarget: repo-relative, CI worktree, installed mirror, inline programs, ai", () => {
  const s = new Set(["src/shared/a.mjs", "src/bin/ai", "hooks/h.sh", "src/mcp/x-mcp/index.js"]);
  assert.equal(resolveTarget("node", "src/shared/a.mjs", s), "src/shared/a.mjs");
  assert.equal(resolveTarget("node", "./src/shared/a.mjs", s), "src/shared/a.mjs");
  assert.equal(resolveTarget("node", "/private/var/T/rein-ci.X/wt/src/shared/a.mjs", s), "src/shared/a.mjs");
  assert.equal(resolveTarget("node", "/tmp/rein-t-h/home/.rein/shared/a.mjs", s), "src/shared/a.mjs", "mirror → src");
  assert.equal(resolveTarget("bash", "/tmp/sbx/.rein/hooks/h.sh", s), "hooks/h.sh");
  assert.equal(resolveTarget("node", "/x/mcp/x-mcp/index.js", s), "src/mcp/x-mcp/index.js");
  assert.equal(resolveTarget("node", "-e:src/shared/a.mjs", s), "src/shared/a.mjs");
  assert.equal(resolveTarget("bash", "-c:src/bin/ai", s), "src/bin/ai");
  assert.equal(resolveTarget("ai", "status", s), "src/bin/ai");
  for (const a of ["-e", "-c", "-", "-m json.tool", "<inline>", "/tmp/fixture.sh", "tests/lib/assert.sh"]) {
    assert.equal(resolveTarget("node", a, s), null, a);
  }
});

test("spawnShape: pure-node only when EVERY spawn is node <src module>", () => {
  const s = new Set(["src/shared/a.mjs", "hooks/h.sh", "src/bin/ai"]);
  const n = (arg) => ({ cmd: "node", arg, count: 1 });
  assert.equal(spawnShape([n("src/shared/a.mjs"), n("-e:src/shared/a.mjs")], s), "pure-node");
  assert.equal(spawnShape([n("src/shared/a.mjs"), n("-e")], s), "mixed", "an inline program with no src module is a process");
  assert.equal(spawnShape([{ cmd: "bash", arg: "hooks/h.sh", count: 1 }, { cmd: "ai", arg: "x", count: 1 }], s), "process");
  assert.equal(spawnShape([], s), "none");
  assert.equal(spawnShape(null, s), null, "no dynamic data = unknown, not 'none'");
});

// ── run records ──────────────────────────────────────────────────────────────
test("parseCensusLines: run, suites, footprint (an empty target survives), totals", () => {
  const c = parseCensusLines("noise\nCENSUS_RUN\t2026-10-04T00:00:00Z\tdeadbeef\t*_test.sh\n" +
    "CENSUS_SUITE\tx_test.sh\t1234\t5\t1\t0\t1\nCENSUS_FP\tx_test.sh\t3\tnode\tsrc/a.mjs\n" +
    "CENSUS_FP\tx_test.sh\t1\tbash\t\nCENSUS_TOTAL\t1\t5\t1\t0\n");
  assert.equal(c.commit, "deadbeef");
  assert.deepEqual(c.suites.get("x_test.sh"), { wall_ms: 1234, pass: 5, fail: 1, skip: 0, exit: 1 });
  assert.deepEqual(c.fp.get("x_test.sh"), [{ count: 3, cmd: "node", arg: "src/a.mjs" }, { count: 1, cmd: "bash", arg: "" }]);
  assert.deepEqual(c.total, { suites: 1, pass: 5, fail: 1, skip: 0 });
  assert.equal(parseCensusLines("no census here"), null);
});

test("parseCiLogForCensus: the LAST Results block wins (a nested runner's output is not the run's)", () => {
  const log = [
    "[ci] sha=" + "f".repeat(40) + " ref=HEAD dirty=1 started_at=2026-10-04T00:00:00Z", "[ci] repo=/r",
    "━━ Results ━━", "  ✗ inner_test.sh (0 passed, 1 failed)",        // printed by a suite
    "SUITE_RESULT PASS=1 FAIL=0 SKIP=0",
    "━━ Results ━━", "  \x1b[32m✓\x1b[0m outer_test.sh (1 passed)", "  ✗ bad_test.sh (0 passed, 1 failed)",
  ].join("\n");
  const r = parseCiLogForCensus(log);
  assert.equal(r.dirty, true);
  assert.deepEqual([...r.passed], ["outer_test.sh"]);
  assert.deepEqual([...r.failed], ["bad_test.sh"]);
  assert.equal(parseCiLogForCensus("[ci] repo=/r\n"), null, "no sha/started_at → not a run");
});

test("failureHistory: newest failure is real; a same-commit rerun pass is REPORTED, not applied", () => {
  const run = (sha, at, failed, passed, dirty = false) => ({ sha, started_at: at, dirty, failed: new Set(failed), passed: new Set(passed) });
  const h = failureHistory([
    run("s2", "2026-10-03T00:00:00Z", ["a_test.sh"], []),
    run("s1", "2026-10-01T00:00:00Z", ["a_test.sh", "b_test.sh"], []),
    run("s1", "2026-10-02T00:00:00Z", [], ["a_test.sh", "b_test.sh"]),     // rerun of s1 passes both
    run("s3", "2026-10-04T00:00:00Z", ["c_test.sh"], [], true),
    run("s3", "2026-10-05T00:00:00Z", [], ["c_test.sh"], true),            // dirty: cannot clear
  ]);
  assert.deepEqual(h.get("a_test.sh"), { last: "2026-10-03T00:00:00Z", failures: 2, rerun_passed: 1 });
  assert.deepEqual(h.get("b_test.sh"), { last: "2026-10-01T00:00:00Z", failures: 1, rerun_passed: 1 },
    "presumed real (D-062): the rerun pass does not null last_real_failure");
  assert.deepEqual(h.get("c_test.sh"), { last: "2026-10-04T00:00:00Z", failures: 1, rerun_passed: 0 });
  assert.equal(h.has("d_test.sh"), false);
});

// ── derivations ──────────────────────────────────────────────────────────────
test("overlap + hubFiles: Jaccard; a file in >20% of suites is a hub", () => {
  assert.equal(overlap(["a", "b"], ["a", "b"]), 1);
  assert.equal(overlap(["a", "b", "c", "d"], ["a", "b", "c", "d", "e"]), 0.8);
  assert.equal(overlap(["a"], []), 0);
  const suites = Array.from({ length: 40 }, (_, i) => ({ footprint: i < 9 ? ["hub", `f${i}`] : [`f${i}`] }));
  suites[0].footprint.push("x"); suites[1].footprint.push("x");
  assert.deepEqual([...hubFiles(suites)], ["hub"], "9 of 40 > 20%; 2 of 40 is not");
  const small = Array.from({ length: 5 }, () => ({ footprint: ["shared"] }));
  assert.deepEqual([...hubFiles(small)], ["shared"], "5 of 5");
  assert.deepEqual([...hubFiles(small.slice(0, 4))], [], "a small set needs more than 4 suites sharing a file");
});

test("deriveCandidates: no history → never a delete candidate (\"never failed\" is unknowable)", () => {
  const mk = (name, footprint) => ({ name, file: `tests/suites/${name}_test.sh`, footprint, assertions: 1,
    spawn_shape: "process", last_real_failure: null, ran_in_history: false, table_runner: false });
  const s = deriveCandidates([mk("a", ["x"]), mk("b", ["x", "y"])], { historyRuns: 0 });
  assert.ok(s.every((x) => !x.candidates.some((c) => c.startsWith("delete"))));
});

test("fixture repo: the census derives exactly the known candidate lists", () => {
  const f = fixtureRepo();
  try {
    const c = buildCensus({ repo: f.r, ciLogs: f.logs, inputs: [] });
    const by = Object.fromEntries(c.suites.map((s) => [s.name, s]));
    const cand = Object.fromEntries(c.suites.map((s) => [s.name, s.candidates]));
    assert.deepEqual(cand, {
      alpha: ["merge:alpha_twin", "move-to-unit", "delete:alpha_twin"],
      alpha_twin: ["merge:alpha"],
      beta: ["move-to-unit", "delete:alpha"],
      e123_widget: ["misnamed"],
      flaky: ["move-to-unit"],
      gamma: ["merge:table", "move-to-unit", "delete:table"],
      hub1: [], hub2: [], hub3: [], hub4: [], hub5: [],
      table: ["merge:gamma", "move-to-unit"],
    });
    assert.equal(c.history.runs, 2, "the other project's log is excluded");
    assert.equal(by.flaky.last_real_failure, "2026-10-01T10:00:00Z");
    assert.equal(by.alpha.last_real_failure, null);
    assert.deepEqual(by.flaky.footprint_dynamic, ["src/shared/d.mjs"], "absolute path resolved to the repo file");
    assert.equal(by.alpha.wall_ms, 2500);
    assert.equal(by.alpha.assertions, 2, "PASS+FAIL+SKIP of the last run");
    assert.equal(by.alpha.labels, 2);
    assert.equal(by.alpha.spawn_shape, "pure-node");
    assert.equal(by.alpha_twin.spawn_shape, "process", "bash hooks/h2.sh only");
    assert.equal(by.e123_widget.spawn_shape, "process");
    assert.deepEqual(by.table.footprint, ["src/shared/c.mjs"]);
    assert.equal(by.table.table_runner, true);
    assert.deepEqual(c.totals, { suites: 12, unit_files: 1, test_lines: c.totals.test_lines, src_lines: 12, fixed_sleeps: { allowed: 0, unmarked: 0 },
      installer: { spawns: 3, by_suite: { alpha_twin: 2, hub1: 1 }, unheadered: ["hub1"], headered_not_measured: ["beta"],
        lanes: {
          alpha_twin: { homes: { tmp: 1, run: 1 }, lane: "shared", reason: null },
          beta: { homes: {}, lane: "exclusive", reason: "no measured installer footprint" },
          hub1: { homes: { "foreign:/srv/shared": 1 }, lane: "exclusive", reason: "installer HOME foreign:/srv/shared" },
        } } });
    assert.equal(by.alpha_twin.spawns, 1, "E-311: an installer line is a marker, not a spawn of its own");
    assert.ok(c.totals.test_lines > 12);
    const md = renderMarkdown(c);
    assert.match(md, /## Merge candidates/);
    assert.match(md, /- beta — covered by alpha/);
    assert.match(md, /tests\/suites\/e123_widget_test\.sh/);
  } finally { f.done(); }
});

test("carry-forward: a failure older than the retained logs survives through the previous census", () => {
  const f = fixtureRepo();
  try {
    const previous = { generated: "2026-09-01T00:00:00Z", history: { runs: 9, oldest: "2026-08-01T00:00:00Z" },
      suites: [{ name: "gamma", last_real_failure: "2026-08-15T00:00:00Z", ran_in_history: true }] };
    const c = buildCensus({ repo: f.r, ciLogs: f.logs, inputs: [], previous });
    const gamma = c.suites.find((s) => s.name === "gamma");
    assert.equal(gamma.last_real_failure, "2026-08-15T00:00:00Z");
    assert.ok(!gamma.candidates.some((x) => x.startsWith("delete")), "it paid rent once: not a delete candidate");
    assert.equal(c.history.oldest, "2026-08-01T00:00:00Z");
  } finally { f.done(); }
});

test("CLI: --json writes the Data Model shape, markdown on stdout, exit 0, under 5 s; HOME untouched", () => {
  const f = fixtureRepo();
  const home = tmp("home");
  try {
    put(f.r, "tmp/rein-census-20261004T000000Z-abc.tsv", censusInput(f.r));
    const out = join(f.r, "out", "census.json");
    const t0 = Date.now();
    const stdout = execFileSync(process.execPath, [CENSUS, "--repo", f.r, "--ci-logs", f.logs, "--json", out], {
      encoding: "utf8", env: { ...process.env, HOME: home.d, TMPDIR: join(f.r, "tmp") },
    });
    const ms = Date.now() - t0;
    console.log(`  census CLI on the fixture: ${ms} ms (budget 5000 ms)`);
    assert.ok(ms < 5000, `${ms} ms`);
    assert.match(stdout, /^# Test census/);
    assert.match(stdout, new RegExp(`JSON: ${out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const j = JSON.parse(readFileSync(out, "utf8"));
    for (const k of ["generated", "commit", "suites", "totals"]) assert.ok(k in j, k);
    for (const k of ["name", "file", "assertions", "labels", "wall_ms", "footprint", "spawn_shape", "last_real_failure", "candidates"]) {
      assert.ok(k in j.suites[0], k);
    }
    assert.ok(j.sources.data_runs.some((p) => p.endsWith(".tsv")), "the $TMPDIR census input was read");
    assert.equal(existsSync(join(home.d, ".rein")), false, "nothing written under HOME when --json is given");
  } finally { f.done(); home.done(); }
});

test("CLI: an unknown flag or a flag without a value is exit 2, never a silent default", () => {
  for (const args of [["--bogus"], ["--json"]]) {
    let code = 0;
    try { execFileSync(process.execPath, [CENSUS, ...args], { stdio: "pipe" }); } catch (e) { code = e.status; }
    assert.equal(code, 2, args.join(" "));
  }
});

test("CLI --since <ref>: only suites whose file or footprint changed; an unknown ref is exit 2", (ctx) => {
  const f = fixtureRepo();
  try {
    const g = (...a) => execFileSync("git", ["-C", f.r, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...a], { stdio: "pipe" });
    try { g("init", "-q"); } catch { ctx.skip("git is not installed"); return; }
    g("add", "-A"); g("commit", "-q", "-m", "fixture");
    writeFileSync(join(f.r, "src", "shared", "c.mjs"), "export const c = 2;\n");
    const out = join(f.r, "out", "since.json");
    const args = [CENSUS, "--repo", f.r, "--ci-logs", f.logs, "--no-tmp-inputs", "--json", out];
    execFileSync(process.execPath, [...args, "--since", "HEAD"], { stdio: "pipe" });
    const j = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(j.suites.map((s) => s.name), ["gamma", "table"], "c.mjs changed: its two suites, nothing else");
    assert.deepEqual(j.since, { ref: "HEAD", changed_files: 1, suites: 2 });
    assert.equal(j.totals.suites, 12, "totals stay whole");
    let code = 0;
    try { execFileSync(process.execPath, [...args, "--since", "no-such-ref"], { stdio: "pipe" }); } catch (e) { code = e.status; }
    assert.equal(code, 2);
  } finally { f.done(); }
});

// E-386 (D-135 r2): extends the CI-log parse tests above — the census baseline is the suite
// step's census rows of one log, with what only this host could use taken out.
test("baselineFromLog: the suite step's rows, header first; worktree paths relative, temp paths and the fast tier's rows dropped", () => {
  const log = [
    "[ci] sha=" + "a".repeat(40) + " ref=HEAD dirty=0 started_at=2026-10-29T11:16:27Z",
    "[ci] ── suite: /bin/bash tests/run.sh",
    "CENSUS_SUITE\tnoise_test.sh\t1\t1\t0\t0\t0",          // before the block: a suite's own output
    "── census input (E-297) ──",
    "CENSUS_RUN\t2026-10-29T11:17:47Z\t" + "a".repeat(40) + "\t*_test.sh",
    "CENSUS_SUITE\tcli_test.sh\t42000\t90\t0\t0\t0",
    "CENSUS_FP\tcli_test.sh\t4\tnode\t/tmp/rein-ci.R2zF/wt/scripts/generate_blueprints_index.mjs",
    "CENSUS_FP\tcli_test.sh\t2\tnode\t-e:src/shared/a.mjs",
    "CENSUS_FP\tgate_test.sh\t1\tpython3\t/tmp/rein-ci.R2zF/tmp/tmp.X/home/.rein/shared/g.py",
    "CENSUS_FP\tinst_test.sh\t1\tinstaller\tinstall-rein.sh\tforeign:/tmp/rein-ci.R2zF/tmp/tmp.Y/home",
    "CENSUS_FP\tinit_test.sh\t12\tinstaller\tai init\ttmp",
    "CENSUS_TOTAL\t46\t6921\t0\t25",
    "",
    "━━ Results ━━",
    "[ci] ── fast tier: /bin/bash tests/run.sh --tier fast",
    "── census input (E-297) ──",
    "CENSUS_SUITE\tnode_unit_test.sh\t22000\t2209\t0\t0\t0",
  ].join("\n");
  assert.equal(baselineFromLog(log), [
    BASELINE_HEADER,
    "CENSUS_RUN\t2026-10-29T11:17:47Z\t" + "a".repeat(40) + "\t*_test.sh",
    "CENSUS_SUITE\tcli_test.sh\t42000\t90\t0\t0\t0",
    "CENSUS_FP\tcli_test.sh\t4\tnode\tscripts/generate_blueprints_index.mjs",
    "CENSUS_FP\tcli_test.sh\t2\tnode\t-e:src/shared/a.mjs",
    "CENSUS_FP\tinst_test.sh\t1\tinstaller\tinstall-rein.sh\tforeign",
    "CENSUS_FP\tinit_test.sh\t12\tinstaller\tai init\ttmp",
  ].join("\n") + "\n");
  assert.equal(baselineFromLog("[ci] ── suite: x\n(no census)"), null, "no suite census → no baseline");
});

test("CLI --baseline-from writes the baseline atomically; it is not counted as test lines", () => {
  const f = fixtureRepo();
  try {
    const before = inventory(f.r).testLines;
    const log = join(f.r, "run.log");
    writeFileSync(log, "[ci] ── suite: x\n── census input (E-297) ──\nCENSUS_RUN\tt\ts\tp\nCENSUS_SUITE\ta_test.sh\t5\t1\t0\t0\t0\n");
    const out = execFileSync("node", ["--no-warnings", CENSUS, "--baseline-from", log, "--repo", f.r], { encoding: "utf8" }).trim();
    assert.equal(out, join(f.r, CENSUS_BASELINE));
    assert.match(readFileSync(out, "utf8"), /^# census-baseline .*\nCENSUS_RUN\tt\ts\tp\nCENSUS_SUITE\ta_test\.sh\t5/);
    assert.equal(inventory(f.r).testLines, before, "scheduling data, not test code");
    writeFileSync(log, "nothing");
    assert.throws(() => execFileSync("node", ["--no-warnings", CENSUS, "--baseline-from", log, "--repo", f.r], { stdio: "pipe" }), (e) => e.status === 1, "no suite census → exit 1, nothing written");
  } finally { f.done(); }
});
