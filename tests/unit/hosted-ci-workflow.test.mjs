// hosted-ci-workflow.test.mjs — every hosted-check wrapper runs the local recipe (E-332,
// E-335, D-103, team-collaboration.md §Component 5b).
//
// A wrapper must not be a second description of the pipeline (DEVOPS-009): it bootstraps
// Rein and runs `ai ci run`. contractViolations() diffs a rendering's run steps against the
// command list of _ci_run in src/bin/ai, and checks the rest of the D-103 r1 contract. It runs
// over EVERY template in src/templates/ci, in both bootstrap variants, and against mutated
// renderings so the checker is shown to fail (E-335 acceptance).
//
// Extends E-332's version of this file (which checked the hand-written ci.yml only); the
// generator itself (detection, --check, --force, team.json.ci) is tests/unit/hosted-ci.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS, render, renderable, bootstrapFor, SELF_BOOTSTRAP, matrixFor } from "../../src/shared/hosted-ci.mjs";
import { readTeam } from "../../src/mcp/shared/team.mjs";
import { resolveTrunk } from "../../src/mcp/shared/trunk.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AI = readFileSync(join(REPO, "src/bin/ai"), "utf8");
const TEMPLATE_DIR = join(REPO, "src/templates/ci");
const PINNED = {   // a downstream project's bootstrap, as bootstrapFor() renders it
  variant: "pinned", note: "pinned fixture",
  command: 'git clone --quiet --depth 1 --branch v4.0.0 https://github.com/Vimurai/rein.git "${TMPDIR:-/tmp}/rein-src" && bash "${TMPDIR:-/tmp}/rein-src"/install-rein.sh',
};

// The body of _ci_run, up to the next top-level function.
function recipeBody(src) {
  const start = src.indexOf("\n_ci_run() {");
  assert.ok(start >= 0, "_ci_run not found in src/bin/ai");
  return src.slice(start, src.indexOf("\n}\n", start));
}

// Every command a recipe step runs: the _ci_exec calls (label dropped) plus the steps that
// run their command inline (browsers, suite, secrets, worktree).
function recipeCommands(body) {
  const cmds = [];
  for (const m of body.matchAll(/_ci_exec (?:"[^"]*"|\S+) (.+?)(?: \|\| .*)?$/gm)) cmds.push(m[1].trim());
  for (const m of body.matchAll(/npx --no-install (playwright install \w+)/g)) cmds.push(m[1]);
  for (const m of body.matchAll(/(\/bin\/bash tests\/run\.sh)/g)) cmds.push(m[1]);
  for (const m of body.matchAll(/git -C "\$CI_WT" (check-ignore) -q/g)) cmds.push(`git ${m[1]}`);
  for (const m of body.matchAll(/git -C "\$root" (worktree add)/g)) cmds.push(`git ${m[1]}`);
  return [...new Set(cmds)];
}

// A wrapper's commands — GitHub `run:`, Azure `bash:` / `script:` — one entry per non-blank,
// non-comment line of each (inline or block scalar).
function runLines(yml) {
  const lines = yml.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?(?:run|bash|script):\s*(.*)$/);
    if (!m) continue;
    if (m[2] && m[2] !== "|" && m[2] !== ">") { out.push(m[2].trim()); continue; }
    // A block scalar runs until a non-blank line indented no deeper than its key.
    const indent = m[1].length + (lines[i].trimStart().startsWith("- ") ? 2 : 0);
    while (i + 1 < lines.length && (!lines[i + 1].trim() || lines[i + 1].search(/\S/) > indent)) {
      const l = lines[++i].trim();
      if (l && !l.startsWith("#")) out.push(l);
    }
  }
  return out;
}

const RECIPE = recipeCommands(recipeBody(AI));
const AI_CI_RUN = '"$HOME/.rein/bin/ai" ci run';
// E-384 (D-135 r3): a GitHub leg passes its shard, or nothing, to the same command.
const AI_CI_RUN_LEG = `${AI_CI_RUN}\${{ matrix.shard && format(' --shard {0}', matrix.shard) || '' }}`;
// E-384 (D-135 addendum r1): the fast job's whole command list — dependencies, then the fast tier.
const FAST_RUNS = [
  "if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund; fi",
  'for d in src/mcp/*/; do if [ -f "${d}package.json" ]; then npm install --prefix "$d" --ignore-scripts --no-audit --no-fund; fi; done',
  "bash tests/run.sh --tier fast",
];
const MATRICES = {   // the renderings every github clause runs over
  team: { fast: false, shards: 1, profile: "team" },
  "team, fast, 4 shards": { fast: true, shards: 4, profile: "team" },
  public: { fast: true, shards: 4, profile: "public" },
};

// A GitHub workflow's job blocks under `jobs:` (comment lines already dropped), by job id.
function jobBlocks(code) {
  const at = code.search(/^jobs:\n/m);
  if (at < 0) return {};
  const out = {};
  for (const b of code.slice(at).split("\n").slice(1).join("\n").split(/^(?=  [\w-]+:\n)/m)) {
    const id = b.match(/^  ([\w-]+):\n/)?.[1];
    if (id) out[id] = b;
  }
  return out;
}

// A wrapper's steps under its `steps:` key, comment lines dropped, one text block per item
// (`item` is the item's indentation + "- ").
function stepBlocks(code, item) {
  const at = code.search(/^\s*steps:\n/m);
  if (at < 0) return [];
  const body = code.slice(at).split("\n").slice(1).join("\n") + "\n";
  return body.split(new RegExp(`^(?=${item}\\S)`, "m")).filter((b) => b.startsWith(item)).map((b) => b.replace(/\n+$/, "\n"));
}

/** Every D-103 r1 clause a rendering breaks, as short strings ([] = conforms). */
function contractViolations(provider, yml, boot, trunk = "master") {
  const v = [];
  // Checks read the CODE: a comment must never satisfy a clause (critic_tests P2).
  const code = yml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  // E-384: on GitHub the two-command contract holds for every `ai ci run` leg; the fast job
  // has its own clause below and is the one place the fast tier may be named.
  const jobs = provider === "github" ? jobBlocks(code) : null;
  const runs = runLines(jobs ? (jobs["ai-ci-run"] ?? "") : yml);
  const leg = provider === "github" ? AI_CI_RUN_LEG : AI_CI_RUN;
  if (runs.length !== 2) v.push(`expected two run commands, got ${runs.length}`);
  if (runs[0] !== boot.command) v.push("first run is not the bootstrap");
  if (runs[1] !== leg) v.push("second run is not `ai ci run` from the installed mirror");
  if (boot.variant === "pinned" && !runs[0]?.endsWith(`&& bash "\${TMPDIR:-/tmp}/rein-src"/install-rein.sh`)) v.push("pinned bootstrap does not end in the clone's installer");
  const copied = RECIPE.filter((c) => c !== SELF_BOOTSTRAP)
    .filter((c) => runs.some((r) => r.includes(c.replace(/^\/usr\/bin\/env \S+ /, "").replace(/^\/bin\/bash /, ""))));
  if (copied.length) v.push(`recipe command copied: ${copied.join(", ")}`);
  if (/\{\{[A-Z_]+\}\}/.test(yml)) v.push("unrendered placeholder");
  if (/\bsecrets\b/.test(yml)) v.push("references secrets");
  if (/pull_request_target/.test(yml)) v.push("pull_request_target");
  if (provider === "github") {
    const extra = Object.keys(jobs).filter((j) => j !== "ai-ci-run" && j !== "fast");
    if (extra.length || !jobs["ai-ci-run"]) v.push(`unexpected jobs: ${Object.keys(jobs).join(", ")}`);
    if (jobs.fast) {
      const f = runLines(jobs.fast);
      if (JSON.stringify(f) !== JSON.stringify(FAST_RUNS)) v.push(`fast job runs other than dependencies + the fast tier: ${JSON.stringify(f)}`);
      if (!/^    timeout-minutes: 10$/m.test(jobs.fast) || !/^    runs-on: ubuntu-latest$/m.test(jobs.fast) || !/persist-credentials: false/.test(jobs.fast)) v.push("fast job is not ubuntu, 10 minutes, read-only checkout");
      const fu = [...jobs.fast.matchAll(/^\s*(?:- )?uses:\s*([^@\s]+)@/gm)].map((m) => m[1]);
      if (JSON.stringify(fu) !== JSON.stringify(["actions/checkout", "actions/setup-node"])) v.push(`fast job uses unexpected actions: ${fu.join(", ")}`);
      if (/^\s+(?:if|continue-on-error):/m.test(jobs.fast)) v.push("the check cannot fail (continue-on-error or a condition on a step)");
    }
    // E-384 (D-133 §Security): every action is pinned to a full commit SHA.
    const loose = [...code.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]).filter((u) => !/@[0-9a-f]{40}$/.test(u));
    if (loose.length) v.push(`action not pinned to a commit SHA: ${loose.join(", ")}`);
    const on = code.match(/^on:\n((?:[ \t]+.*\n)+)/m)?.[1] ?? "";
    if (!on.includes(`\n  pull_request:\n    branches: [${trunk}]\n`) && !on.startsWith(`  pull_request:\n    branches: [${trunk}]\n`)) v.push(`no pull_request trigger on ${trunk}`);
    const push = on.match(/^  push:\n((?:    .*\n)+)/m)?.[1];
    if (push !== undefined && push !== `    branches: [${trunk}]\n    paths-ignore: ['.ai/**']\n`) v.push(`push trigger other than the ${trunk} audit run`);
    if (!/^permissions:\n  contents: read$/m.test(code)) v.push("token is not read-only");
    const steps = stepBlocks(jobs["ai-ci-run"] ?? "", "      - ");
    if (steps.length !== 6 || !steps.every((b) => /^\s+(?:- )?(?:uses|run):/m.test(b))) v.push(`expected six uses/run steps, got ${steps.length}`);
    if (!/persist-credentials: false/.test(steps[0] ?? "")) v.push("checkout persists credentials");
    const uses = [...(jobs["ai-ci-run"] ?? "").matchAll(/^\s*(?:- )?uses:\s*([^@\s]+)@/gm)].map((m) => m[1]);
    if (JSON.stringify(uses) !== JSON.stringify(["actions/checkout", "actions/setup-node", "actions/cache", "actions/upload-artifact"])) v.push(`unexpected actions: ${uses.join(", ")}`);
    // The matrix carries Linux and Node 22, Rein's floor, in every profile.
    const legJob = jobs["ai-ci-run"] ?? "";
    if (!/node-version: \$\{\{ matrix\.node \}\}/.test(legJob) || !/^        node: \[(?:'\d+', )*'22'/m.test(legJob) ||
        !/^    runs-on: \$\{\{ matrix\.os \}\}$/m.test(legJob) || !/^        os: \[ubuntu-latest/m.test(legJob)) v.push("not Linux + Node 22");
    // The check must be able to fail: no step may continue on error, only the upload has an if:.
    const ifs = steps.map((b) => b.match(/^\s+if:\s*(.*)$/m)?.[1] ?? null);
    if (/continue-on-error/.test(code) || ifs.slice(0, 5).some((x) => x !== null) || /^    if:/m.test(legJob)) v.push("the check cannot fail (continue-on-error or a condition on a step)");
    const up = steps.find((b) => /uses: actions\/upload-artifact@/.test(b)) ?? "";
    if (ifs[5] !== "always()" || !/~\/\.rein\/ci\/logs\//.test(up) || !/\.ai\/ci\/\*\.json/.test(up) || !/retention-days: (1[4-9]|[2-9]\d)/.test(up)) v.push("no artefact step (always, log + .ai/ci, ≥ 14 days)");
  } else if (provider === "azure") {
    // On Azure Repos the merge gate is the Build Validation policy; pr: covers GitHub/Bitbucket.
    if (code.match(/^pr:\n((?:  .*\n)+)/m)?.[1] !== `  branches:\n    include: [${trunk}]\n` || (code.match(/^pr:/gm) ?? []).length !== 1) v.push(`no pull_request trigger on ${trunk}`);
    // A missing trigger: runs on every push to every branch — the audit block is REQUIRED here.
    if (code.match(/^trigger:\n((?:  .*\n)+)/m)?.[1] !== `  branches:\n    include: [${trunk}]\n  paths:\n    exclude: ['.ai/*']\n` || (code.match(/^trigger:/gm) ?? []).length !== 1) v.push(`push trigger other than the ${trunk} audit run`);
    // No secret can reach a step: no env:, no variables / groups, no macro but the log directory.
    const macros = [...code.matchAll(/\$\(([^)]*)\)/g)].map((m) => m[1]).filter((m) => m !== "REIN_CI_LOG_DIR");
    if (/System\.AccessToken/.test(code) || /^\s+env:/m.test(code) || /^variables:/m.test(code) || /^\s+- group:/m.test(code) || macros.length) v.push(`references secrets${macros.length ? `: $(${macros.join("), $(")})` : ""}`);
    // Exactly these steps: Azure has no closed step set, so a pwsh:/template:/publish: step
    // would run commands the run-line diff never sees (critic_tests P1).
    const steps = stepBlocks(code, "  - ");
    const kinds = steps.map((b) => b.match(/^  - (\w+):/)?.[1]);
    if (JSON.stringify(kinds) !== JSON.stringify(["checkout", "task", "bash", "bash", "task", "task"])) v.push(`expected steps checkout, task, bash, bash, task, task — got ${kinds.join(", ")}`);
    const [co, node, boot_, run, log, rec] = steps;
    if (co !== "  - checkout: self\n    fetchDepth: 0\n    persistCredentials: false\n") v.push("checkout persists credentials or is shallow");
    if (!/^  - task: NodeTool@0\n/.test(node ?? "") || !/versionSpec: '22\.x'/.test(node ?? "") || !/^pool:\n  vmImage: ubuntu-/m.test(code)) v.push("not Linux + Node 22");
    // ##vso commands in a step's output can set variables: the bootstrap sets none, the run
    // step only the log directory (critic_security P3).
    if (!/\n    target:\n      settableVariables: none\n/.test(boot_ ?? "") ||
        !/\n    target:\n      settableVariables:\n        - REIN_CI_LOG_DIR\n/.test(run ?? "")) v.push("steps may set any pipeline variable");
    // The check must be able to fail: no condition / continueOnError on the two commands.
    if ([boot_, run].some((b) => /^\s+(?:condition|continueOnError):/m.test(b ?? ""))) v.push("the check cannot fail (continueOnError or a condition on a step)");
    const conds = (b) => [...(b ?? "").matchAll(/^\s+condition:\s*(.*)$/gm)].map((m) => m[1]);
    if (!/^  - task: PublishPipelineArtifact@1\n/.test(log ?? "") || !/targetPath: \$\(REIN_CI_LOG_DIR\)\n/.test(log ?? "") || /continueOnError/.test(log ?? "") ||
        !/^  - task: PublishPipelineArtifact@1\n/.test(rec ?? "") || !/targetPath: \.ai\/ci\n/.test(rec ?? "") ||
        JSON.stringify([conds(log), conds(rec)]) !== JSON.stringify([["always()"], ["always()"]])) v.push("no artefact step (always, log + .ai/ci)");
    if (!/REIN_CI_LOG_DIR\]/.test(AI)) v.push("ai ci run does not set REIN_CI_LOG_DIR for the artefact step");
  } else {
    // A provider cannot become renderable with only the generic clauses (critic_tests P2):
    // E-337 adds GitLab's and Bitbucket's trigger, token and artefact checks here.
    v.push(`no provider-specific contract for ${provider}`);
  }
  return v;
}

test("the recipe command list is what this test thinks it is", () => {
  // A refactor of _ci_run that hides its commands from the extractor must fail here, not
  // let the wrapper diff pass vacuously.
  for (const c of [SELF_BOOTSTRAP, "npm ci --ignore-scripts", "/bin/bash tests/run.sh",
    "playwright install chromium", "git check-ignore", "git worktree add"]) {
    assert.ok(RECIPE.includes(c), `recipe command missing from the extract: ${c}\n${RECIPE.join("\n")}`);
  }
  assert.ok(RECIPE.some((c) => c.includes("tests/suites/node_unit_test.sh")), "unit step not extracted");
});

test("every template file belongs to a renderable provider — no wrapper ships unseen", () => {
  const ready = Object.keys(PROVIDERS).filter(renderable).map((k) => PROVIDERS[k].template).sort();
  assert.deepEqual(readdirSync(TEMPLATE_DIR).sort(), ready);
  assert.ok(ready.length >= 1);
});

// The broken-wrapper mutants per provider: [name, edit, the clause that must fire].
const MUTANTS = {
  github: (good, boot) => [
    ["recipe command copied", good.replace(`run: |\n          ${AI_CI_RUN}`, `run: |\n          ${AI_CI_RUN}\n          bash tests/run.sh`), "recipe command copied"],
    ["recipe command in the bootstrap", good.replace(`run: ${boot.command}\n`, `run: ${boot.command} && npm ci --ignore-scripts\n`), "recipe command copied"],
    ["PR trigger missing", good.replace(/^  pull_request:\n    branches: \[master\]\n/m, ""), "no pull_request trigger"],
    ["artefact step not always()", good.replace("        if: always()\n", ""), "no artefact step"],
    ["secrets referenced", good.replace("permissions:", "env:\n  T: ${{ secrets.X }}\npermissions:"), "references secrets"],
    ["the check cannot fail", good.replace("      - name: ai ci run\n", "      - name: ai ci run\n        continue-on-error: true\n"), "the check cannot fail"],
    ["the check skipped", good.replace("      - name: ai ci run\n", "      - name: ai ci run\n        if: false\n"), "the check cannot fail"],
    ["an action by tag", good.replace(/actions\/cache@[0-9a-f]{40}/, "actions/cache@v6"), "action not pinned to a commit SHA"],
    ["the leg job skipped", good.replace("    timeout-minutes: 60\n", "    timeout-minutes: 60\n    if: false\n"), "the check cannot fail"],
  ],
  azure: (good, boot) => [
    ["recipe command copied", good.replace(`bash: |\n      ${AI_CI_RUN}`, `bash: |\n      ${AI_CI_RUN}\n      bash tests/run.sh`), "recipe command copied"],
    ["recipe command in the bootstrap", good.replace(`bash: ${boot.command}\n`, `bash: ${boot.command} && npm ci --ignore-scripts\n`), "recipe command copied"],
    ["PR trigger missing", good.replace(/^pr:\n  branches:\n    include: \[master\]\n/m, ""), "no pull_request trigger"],
    ["artefact step not always()", good.replace("    displayName: Upload run log\n    condition: always()\n", "    displayName: Upload run log\n"), "no artefact step"],
    ["secrets referenced", good.replace(`    displayName: ai ci run\n`, `    displayName: ai ci run\n    env:\n      T: $(System.AccessToken)\n`), "references secrets"],
    ["secret variable macro", good.replace("targetPath: .ai/ci", "targetPath: $(MySecret)"), "references secrets"],
    ["run step may set any variable", good.replace("      settableVariables:\n        - REIN_CI_LOG_DIR\n", ""), "steps may set any pipeline variable"],
    ["a pwsh step", good.replace("  - task: PublishPipelineArtifact@1\n    displayName: Upload run log", "  - pwsh: bash tests/run.sh\n\n  - task: PublishPipelineArtifact@1\n    displayName: Upload run log"), "expected steps"],
    ["the check cannot fail", good.replace("    displayName: ai ci run\n", "    displayName: ai ci run\n    continueOnError: true\n"), "the check cannot fail"],
    ["no trigger block", good.replace(/^trigger:\n(?:  .*\n)+/m, ""), "push trigger other than"],
    ["always() only in a comment", good.replace("    displayName: Upload run log\n    condition: always()\n", "    displayName: Upload run log\n    condition: succeeded() # condition: always()\n"), "no artefact step"],
    ["a variable group", good.replace("pool:", "variables:\n  - group: prod\n\npool:"), "references secrets"],
  ],
};

for (const [provider, p] of Object.entries(PROVIDERS).filter(([k]) => renderable(k))) {
  for (const boot of [bootstrapFor(REPO), PINNED]) {
    test(`${provider} (${boot.variant} bootstrap) meets the hosted-check contract`, () => {
      assert.deepEqual(contractViolations(provider, render(provider, boot, "master"), boot), []);
    });
  }
  // E-341 (D-105 r5): a project whose trunk is main gets main in every branch filter, and a
  // master-trunk checker refuses that rendering (the trunk is not a literal anywhere).
  test(`${provider}: trunk main renders main into every branch filter and no master`, () => {
    const boot = bootstrapFor(REPO);
    const yml = render(provider, boot, "main");
    assert.deepEqual(contractViolations(provider, yml, boot, "main"), []);
    assert.doesNotMatch(yml, /\bmaster\b/);
    assert.ok(contractViolations(provider, yml, boot, "master").some((x) => x.startsWith("no pull_request trigger on master")));
  });
  test(`${provider}: the checker fails a rendering that breaks the contract (mutations)`, () => {
    const boot = bootstrapFor(REPO);
    const good = render(provider, boot, "master");
    // The clause, not merely "some violation" (critic_tests P2: two mutants were also caught
    // by unrelated clauses).
    assert.ok(MUTANTS[provider], `no mutants for ${provider}`);
    for (const [name, text, clause] of MUTANTS[provider](good, boot)) {
      assert.notEqual(text, good, `mutation '${name}' did not apply`);
      const v = contractViolations(provider, text, boot);
      assert.ok(v.some((x) => x.startsWith(clause)), `mutation '${name}': expected '${clause}', got ${JSON.stringify(v)}`);
    }
  });
}
// E-384 (D-135): extends the contract tests above to the matrix renderings — the team profile
// with a fast job and shards, and the public profile.
for (const [label, m] of Object.entries(MATRICES)) {
  for (const boot of [bootstrapFor(REPO), PINNED]) {
    test(`github (${label}, ${boot.variant} bootstrap) meets the hosted-check contract`, () => {
      assert.deepEqual(contractViolations("github", render("github", boot, "main", m), boot, "main"), []);
    });
  }
}

test("github: the checker fails a fast job that installs, runs more, or can be skipped (mutations)", () => {
  const boot = bootstrapFor(REPO);
  const good = render("github", boot, "main", MATRICES.public);
  const muts = [
    ["fast job installs", good.replace("        run: bash tests/run.sh --tier fast\n", "        run: bash install-rein.sh && bash tests/run.sh --tier fast\n"), "fast job runs other than"],
    ["fast job runs the full suite", good.replace("run: bash tests/run.sh --tier fast", "run: bash tests/run.sh"), "fast job runs other than"],
    ["fast job skipped", good.replace("    name: fast\n", "    name: fast\n    if: false\n"), "the check cannot fail"],
    ["a third job", good.replace("  ai-ci-run:\n", "  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n\n  ai-ci-run:\n"), "unexpected jobs"],
  ];
  for (const [name, text, clause] of muts) {
    assert.notEqual(text, good, `mutation '${name}' did not apply`);
    const v = contractViolations("github", text, boot, "main");
    assert.ok(v.some((x) => x.startsWith(clause)), `mutation '${name}': expected '${clause}', got ${JSON.stringify(v)}`);
  }
});

test("github public profile: the PR legs are ubuntu × 22, 24 and macOS × 22 in four shards; full adds macOS × 24 and one unsharded leg", () => {
  const yml = render("github", bootstrapFor(REPO), "main", MATRICES.public);
  assert.match(yml, /^        os: \[ubuntu-latest, macos-latest\]\n        node: \['22', '24'\]\n        shard: \['1\/4', '2\/4', '3\/4', '4\/4'\]\n/m);
  assert.match(yml, /exclude: \$\{\{ fromJSON\(inputs\.full && '\[\]' \|\| '\[\{"os":"macos-latest","node":"24"\}\]'\) \}\}/);
  assert.match(yml, /include: \$\{\{ fromJSON\(inputs\.full && '\[\{"os":"ubuntu-latest","node":"22","shard":""\}\]' \|\| '\[\]'\) \}\}/);
  assert.match(yml, /^  workflow_call:\n    inputs:\n      full:\n/m, "the nightly and the release call it with full: true");
  const team = render("github", bootstrapFor(REPO), "main", MATRICES.team);
  assert.match(team, /^        os: \[ubuntu-latest\]\n        node: \['22'\]\n    steps:/m, "team, one shard: a single leg");
  assert.doesNotMatch(team, /^  fast:/m, "no --tier in the runner, no fast job");
});

test("this repository's .github/workflows/ci.yml is the current github rendering, byte for byte", () => {
  // E-378 (D-129): the public repository's trunk is main. The file names the trunk it was rendered
  // for; it must be that rendering byte for byte, and that trunk must be the repository's own
  // whenever one resolves (a checkout without a remote — a CI worktree — resolves none).
  const text = readFileSync(join(REPO, PROVIDERS.github.path), "utf8");
  const trunk = (/^\s+branches: \[([^\]]+)\]$/m.exec(text) || [])[1];
  assert.ok(trunk, "the workflow names its trunk");
  let team = null;
  try { team = readTeam(join(REPO, ".ai")); } catch { /* no team: the default matrix */ }
  assert.equal(text, render("github", bootstrapFor(REPO), trunk, matrixFor(REPO, team)));
  const resolved = resolveTrunk(REPO);
  if (resolved) assert.equal(trunk, resolved.name, `rendered for ${trunk}, the trunk is ${resolved.name}`);
});
