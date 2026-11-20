// ci-plan.test.mjs — how much CI a change needs (smart-ci.md §Component 1, D-166 r1). One table:
// a row per level and a row per fail-full case. The decision rows call planFromInputs (pure) with
// the project's real selectSuites; the gathering rows call ciPlan on a small git fixture that
// carries this tree's tests/tools/census.mjs and select-suites.mjs and a synthetic baseline.
// Extends no earlier test: the planner is new; suite selection itself stays covered by
// select-suites.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tcFixtureHome } from "../lib/toolchain-fixture.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { planFromInputs, ciPlan, globToRe, FALLBACK } = await import(join(repo, "src/shared/ci-plan.mjs"));
const { selectSuites } = await import(join(repo, "tests/tools/select-suites.mjs"));

// ── the decision (pure) ──────────────────────────────────────────────────────────────────
const suites = ["node_unit_test.sh", "a_test.sh", "b_test.sh", "c_test.sh", "d_test.sh"].map((name) => ({ name, text: "" }));
const census = { suites: [
  { name: "a", file: "tests/suites/a_test.sh", wall_ms: 10000, footprint: ["src/a.mjs", "src/shared.mjs", "README.md"] },
  { name: "b", file: "tests/suites/b_test.sh", wall_ms: 20000, footprint: ["src/b.mjs", "src/shared.mjs"] },
  { name: "c", file: "tests/suites/c_test.sh", wall_ms: 30000, footprint: ["src/shared.mjs"] },
  { name: "d", file: "tests/suites/d_test.sh", wall_ms: 400000, footprint: ["src/d.mjs"] },
] };
const base = { base: "b".repeat(40), head: "h".repeat(40), tree: "t".repeat(40), shallow: false, team: null,
  censusTool: true, baseline: "FRESH", census, suites, select: selectSuites, subjects: ["feat: x"] };
const rows = [
  // [label, inputs, level, reason pattern, extra check]
  ["none: bookkeeping only", { changed: [".ai/COMM.md", "plans/p.md"] }, "none", /bookkeeping/],
  ["fast: a docs path no footprint reads", { changed: ["docs/getting-started.md"] }, "fast", /docs-only/],
  ["affected: a docs path a footprint reads", { changed: ["README.md"] }, "affected", /suite/, (p) => p.suites.includes("a_test.sh")],
  ["affected: a path the census knows selects its suites only", { changed: ["src/a.mjs"] }, "affected", /suite/,
    (p) => p.suites.includes("a_test.sh") && !p.suites.includes("b_test.sh") && p.skipped === 3],
  ["affected: a changed suite file is known", { changed: ["tests/suites/b_test.sh"] }, "affected", /suite/],
  ["affected: a unit test file is run by the fast tier", { changed: ["tests/unit/x.test.mjs"] }, "affected", /suite/],
  ["shards: one under 240 s, ci.shards above", { changed: ["src/d.mjs"], team: { ci: { shards: 3 } } }, "affected", /suite/, (p) => p.shards === 3],
  ["full: a path on the built-in full list", { changed: ["hooks/pre-tool-use.sh"] }, "full", /full list: hooks\/pre-tool-use\.sh/],
  ["full: .ai/team.json is on the full list though under .ai/", { changed: [".ai/team.json"] }, "full", /full list/],
  ["full: ci.full_paths extends the list", { changed: ["schema/x.sql"], team: { ci: { full_paths: ["schema/**"] } } }, "full", /full list: schema/],
  ["fast: ci.docs_paths extends the docs class", { changed: ["notes/x.txt"], team: { ci: { docs_paths: ["notes/**"] } } }, "fast", /docs-only/],
  ["full: a path unknown to the census", { changed: ["src/new.mjs"] }, "full", /unknown to the census: src\/new\.mjs/],
  ["full: a [TIER_3] commit in the range", { changed: ["src/a.mjs"], subjects: ["x", "[TIER_3] fix(gate): y"] }, "full", /\[TIER_3\]/],
  ["full: no base", { changed: ["src/a.mjs"], base: null }, "full", /no base/],
  ["full: a shallow clone", { changed: ["src/a.mjs"], shallow: true }, "full", /shallow/],
  ["full: a missing baseline", { changed: ["src/a.mjs"], baseline: "MISSING" }, "full", /census-baseline/],
  ["full: a stale baseline", { changed: ["src/a.mjs"], baseline: "STALE" }, "full", /CENSUS_BASELINE_STALE/],
  ["full: more than half the suites selected", { changed: ["src/shared.mjs"] }, "full", /more than half/],
  ["full: ci.smart false", { changed: [".ai/COMM.md"], team: { ci: { smart: false } } }, "full", /ci\.smart/],
  ["full: a selector that throws is [PLAN_FALLBACK]", { changed: ["src/a.mjs"], select: () => { throw new Error("boom"); } }, "full", /^\[PLAN_FALLBACK\] boom/],
  ["no census: a docs-only change is fast", { changed: ["docs/x.md"], censusTool: false }, "fast", /no census/],
  ["no census: anything else is full", { changed: ["src/a.mjs"], censusTool: false }, "full", /no census/],
];
for (const [label, over, level, reason, check] of rows) {
  test(`plan ${level}: ${label}`, () => {
    const p = planFromInputs({ ...base, ...over });
    assert.equal(p.level, level, `${label}: ${p.reason}`);
    assert.match(p.reason, reason);
    for (const k of ["level", "reason", "base", "head", "tree", "suites", "skipped", "est_seconds", "shards", "platforms"]) assert.ok(k in p, `${label}: no ${k}`);
    if (check) assert.ok(check(p), `${label}: ${JSON.stringify(p)}`);
  });
}

test("the globs: ** spans directories, * stays in one segment", () => {
  for (const [g, p, want] of [["hooks/**", "hooks/a/b.sh", true], ["**/package.json", "package.json", true], ["**/package.json", "src/x/package.json", true],
    ["install-*.sh", "install-rein.sh", true], ["install-*.sh", "src/install-x.sh", false], ["**/*.md", "a/b/c.md", true], ["LICENSE*", "LICENSE.txt", true]]) {
    assert.equal(globToRe(g).test(p), want, `${g} ~ ${p}`);
  }
});

// ── gathering from git (ciPlan) ──────────────────────────────────────────────────────────
const fx = mkdtempSync(join(tmpdir(), "rein-t-ciplan-"));
tcFixtureHome(fx);   // E-345 (D-109 r1): HOME is set for git, so it carries the toolchain record
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: fx };
const git = (...a) => execFileSync("git", ["-C", join(fx, "r"), ...a], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (p, s) => { mkdirSync(dirname(join(fx, "r", p)), { recursive: true }); writeFileSync(join(fx, "r", p), s); };
const commit = (subject, files) => { for (const [p, s] of Object.entries(files)) put(p, s); git("add", "-A"); git("commit", "-qm", subject); return git("rev-parse", "HEAD"); };
mkdirSync(join(fx, "r"));
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
mkdirSync(join(fx, "r", "tests", "tools"), { recursive: true });
for (const f of ["census.mjs", "select-suites.mjs"]) copyFileSync(join(repo, "tests", "tools", f), join(fx, "r", "tests", "tools", f));
const BASELINE = ["# census-baseline — fixture", "CENSUS_RUN\t2026-11-20T00:00:00Z\t0000000\t*_test.sh",
  ...["node_unit", "a", "b", "c"].map((s) => `CENSUS_SUITE\t${s}_test.sh\t1000\t1\t0\t0\t0`),
  "CENSUS_FP\ta_test.sh\t1\tnode\tsrc/a.mjs", "CENSUS_FP\tb_test.sh\t1\tnode\tsrc/b.mjs", ""].join("\n");
commit("seed", {
  "tests/census-baseline.tsv": BASELINE, "src/a.mjs": "1\n", "src/b.mjs": "1\n", "hooks/pre-tool-use.sh": "#\n",
  "tests/suites/node_unit_test.sh": "#\n", "tests/suites/a_test.sh": "#\n", "tests/suites/b_test.sh": "#\n", "tests/suites/c_test.sh": "#\n",
  ".ai/COMM.md": "#\n", "docs/getting-started.md": "#\n",
});
const at = (subject, files) => { const head = commit(subject, files); return { head, base: git("rev-parse", `${head}~1`) }; };
test.after(() => rmSync(fx, { recursive: true, force: true }));

const gitRows = [
  ["none: a commit touching only .ai/", () => at("chore: comm", { ".ai/COMM.md": "#2\n" }), "none", /bookkeeping/],
  ["fast: a commit touching only docs/getting-started.md", () => at("docs: x", { "docs/getting-started.md": "#2\n" }), "fast", /docs-only/],
  ["affected: a commit touching src/a.mjs", () => at("feat: a", { "src/a.mjs": "2\n" }), "affected", /suite/],
  ["full: a commit touching hooks/pre-tool-use.sh names the path", () => at("fix: hook", { "hooks/pre-tool-use.sh": "#2\n" }), "full", /hooks\/pre-tool-use\.sh/],
];
for (const [label, make, level, reason] of gitRows) {
  test(`ciPlan ${level}: ${label}`, async () => {
    const { base: b, head } = make();
    const p = await ciPlan(join(fx, "r"), b, head);
    assert.equal(p.level, level, p.reason);
    assert.match(p.reason, reason);
    assert.equal(p.head, head);
    assert.equal(p.tree, git("rev-parse", `${head}^{tree}`));
  });
}
test("ciPlan full: the baseline removed from the work tree", async () => {
  const { base: b, head } = at("feat: a again", { "src/a.mjs": "3\n" });
  unlinkSync(join(fx, "r", "tests", "census-baseline.tsv"));
  try {
    const p = await ciPlan(join(fx, "r"), b, head);
    assert.equal(p.level, "full", p.reason);
    assert.match(p.reason, /census-baseline/);
  } finally { git("checkout", "--", "tests/census-baseline.tsv"); }
});
test("ciPlan full: a selector that throws returns full, the reason starting [PLAN_FALLBACK]", async () => {
  const { base: b, head } = at("feat: a once more", { "src/a.mjs": "4\n" });   // affected without the throw
  const p = await ciPlan(join(fx, "r"), b, head, { select: () => { throw new Error("selector down"); } });
  assert.equal(p.level, "full");
  assert.ok(p.reason.startsWith(FALLBACK), p.reason);
});
test("ciPlan full: an unknown base ref", async () => {
  const p = await ciPlan(join(fx, "r"), "no-such-ref", "HEAD");
  assert.equal(p.level, "full");
  assert.match(p.reason, /no base/);
});

// The planner's team.json keys (smart-ci.md §Data Model) are validated where the rest of ci is.
const { newTeam, validateTeam } = await import(join(repo, "src/mcp/shared/team.mjs"));
test("team.json ci.smart is a boolean; ci.full_paths / ci.docs_paths are short lists of plain globs", () => {
  const t = (ci) => ({ ...newTeam("p@example.com", { E: [[1, 9]] }), ci: { provider: "github", required_check: "rein ci run", ...ci } });
  assert.doesNotThrow(() => validateTeam(t({ smart: false, full_paths: ["schema/**"], docs_paths: ["notes/*.txt"] })));
  assert.throws(() => validateTeam(t({ smart: "no" })), /ci\.smart/);
  assert.throws(() => validateTeam(t({ full_paths: "schema/**" })), /ci\.full_paths/);
  assert.throws(() => validateTeam(t({ docs_paths: ["a b"] })), /ci\.docs_paths/);
  assert.throws(() => validateTeam(t({ full_paths: Array(65).fill("x") })), /ci\.full_paths/);
});

// critic_security P2s: a glob of many ** stays linear; a ref that reads as an option is refused.
test("a glob of repeated ** is one ** (no polynomial backtracking); team.json caps ** at four per glob", () => {
  assert.equal(globToRe("**/**/**/**/x").source, globToRe("**/x").source);
  const t0 = performance.now();
  globToRe("a" + "**".repeat(40) + "b").test("a".repeat(5000));
  assert.ok(performance.now() - t0 < 100, "linear in the path");
  const t = (g) => ({ ...newTeam("p@example.com", { E: [[1, 9]] }), ci: { provider: "github", required_check: "rein ci run", full_paths: [g] } });
  assert.throws(() => validateTeam(t("**/a/**/b/**/c/**/d/**/e")), /at most four/);
});
test("ciPlan: a head ref starting with '-' is a [PLAN_FALLBACK] full plan; such a base is no base", async () => {
  const p = await ciPlan(join(fx, "r"), "HEAD~1", "--output=/tmp/x");
  assert.equal(p.level, "full"); assert.ok(p.reason.startsWith(FALLBACK), p.reason);
  const q = await ciPlan(join(fx, "r"), "-x", "HEAD");
  assert.equal(q.level, "full"); assert.match(q.reason, /no base/);
});
