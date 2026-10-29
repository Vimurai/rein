// hosted-ci-workflow.test.mjs — every hosted-check wrapper runs the local recipe (E-332,
// E-335, D-103, team-collaboration.md §Component 5b).
//
// A wrapper must not be a second description of the pipeline (DEVOPS-009): it bootstraps
// AI-OS and runs `ai ci run`. contractViolations() diffs a rendering's run steps against the
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
import { PROVIDERS, render, renderable, bootstrapFor, SELF_BOOTSTRAP } from "../../src/shared/hosted-ci.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AI = readFileSync(join(REPO, "src/bin/ai"), "utf8");
const TEMPLATE_DIR = join(REPO, "src/templates/ci");
const PINNED = {   // a downstream project's bootstrap, as bootstrapFor() renders it
  variant: "pinned", note: "pinned fixture",
  command: 'git clone --quiet --depth 1 --branch v4.0.0 https://github.com/Vimurai/ai-os.git "${TMPDIR:-/tmp}/ai-os-src" && bash "${TMPDIR:-/tmp}/ai-os-src"/install-ai-os.sh',
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
const AI_CI_RUN = '"$HOME/.ai-os/bin/ai" ci run';

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
  const runs = runLines(yml);
  if (runs.length !== 2) v.push(`expected two run commands, got ${runs.length}`);
  if (runs[0] !== boot.command) v.push("first run is not the bootstrap");
  if (runs[1] !== AI_CI_RUN) v.push("second run is not `ai ci run` from the installed mirror");
  if (boot.variant === "pinned" && !runs[0]?.endsWith(`&& bash "\${TMPDIR:-/tmp}/ai-os-src"/install-ai-os.sh`)) v.push("pinned bootstrap does not end in the clone's installer");
  const copied = RECIPE.filter((c) => c !== SELF_BOOTSTRAP)
    .filter((c) => runs.some((r) => r.includes(c.replace(/^\/usr\/bin\/env \S+ /, "").replace(/^\/bin\/bash /, ""))));
  if (copied.length) v.push(`recipe command copied: ${copied.join(", ")}`);
  if (/\{\{[A-Z_]+\}\}/.test(yml)) v.push("unrendered placeholder");
  if (/\bsecrets\b/.test(yml)) v.push("references secrets");
  if (/pull_request_target/.test(yml)) v.push("pull_request_target");
  // Checks read the CODE: a comment must never satisfy a clause (critic_tests P2).
  const code = yml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  if (provider === "github") {
    const on = code.match(/^on:\n((?:[ \t]+.*\n)+)/m)?.[1] ?? "";
    if (!on.includes(`\n  pull_request:\n    branches: [${trunk}]\n`) && !on.startsWith(`  pull_request:\n    branches: [${trunk}]\n`)) v.push(`no pull_request trigger on ${trunk}`);
    const push = on.match(/^  push:\n((?:    .*\n)+)/m)?.[1];
    if (push !== undefined && push !== `    branches: [${trunk}]\n    paths-ignore: ['.ai/**']\n`) v.push(`push trigger other than the ${trunk} audit run`);
    if (!/^permissions:\n  contents: read$/m.test(code)) v.push("token is not read-only");
    const steps = stepBlocks(code, "      - ");
    if (steps.length !== 6 || !steps.every((b) => /^\s+(?:- )?(?:uses|run):/m.test(b))) v.push(`expected six uses/run steps, got ${steps.length}`);
    if (!/persist-credentials: false/.test(steps[0] ?? "")) v.push("checkout persists credentials");
    const uses = [...code.matchAll(/^\s*(?:- )?uses:\s*([^@\s]+)@/gm)].map((m) => m[1]);
    if (JSON.stringify(uses) !== JSON.stringify(["actions/checkout", "actions/setup-node", "actions/cache", "actions/upload-artifact"])) v.push(`unexpected actions: ${uses.join(", ")}`);
    if (!/node-version: '22'/.test(code) || !/runs-on: ubuntu-/.test(code)) v.push("not Linux + Node 22");
    // The check must be able to fail: no step may continue on error, only the upload has an if:.
    const ifs = steps.map((b) => b.match(/^\s+if:\s*(.*)$/m)?.[1] ?? null);
    if (/continue-on-error/.test(code) || ifs.slice(0, 5).some((x) => x !== null)) v.push("the check cannot fail (continue-on-error or a condition on a step)");
    const up = steps.find((b) => /uses: actions\/upload-artifact@/.test(b)) ?? "";
    if (ifs[5] !== "always()" || !/~\/\.ai-os\/ci\/logs\//.test(up) || !/\.ai\/ci\/\*\.json/.test(up) || !/retention-days: (1[4-9]|[2-9]\d)/.test(up)) v.push("no artefact step (always, log + .ai/ci, ≥ 14 days)");
  } else if (provider === "azure") {
    // On Azure Repos the merge gate is the Build Validation policy; pr: covers GitHub/Bitbucket.
    if (code.match(/^pr:\n((?:  .*\n)+)/m)?.[1] !== `  branches:\n    include: [${trunk}]\n` || (code.match(/^pr:/gm) ?? []).length !== 1) v.push(`no pull_request trigger on ${trunk}`);
    // A missing trigger: runs on every push to every branch — the audit block is REQUIRED here.
    if (code.match(/^trigger:\n((?:  .*\n)+)/m)?.[1] !== `  branches:\n    include: [${trunk}]\n  paths:\n    exclude: ['.ai/*']\n` || (code.match(/^trigger:/gm) ?? []).length !== 1) v.push(`push trigger other than the ${trunk} audit run`);
    // No secret can reach a step: no env:, no variables / groups, no macro but the log directory.
    const macros = [...code.matchAll(/\$\(([^)]*)\)/g)].map((m) => m[1]).filter((m) => m !== "AI_OS_CI_LOG_DIR");
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
        !/\n    target:\n      settableVariables:\n        - AI_OS_CI_LOG_DIR\n/.test(run ?? "")) v.push("steps may set any pipeline variable");
    // The check must be able to fail: no condition / continueOnError on the two commands.
    if ([boot_, run].some((b) => /^\s+(?:condition|continueOnError):/m.test(b ?? ""))) v.push("the check cannot fail (continueOnError or a condition on a step)");
    const conds = (b) => [...(b ?? "").matchAll(/^\s+condition:\s*(.*)$/gm)].map((m) => m[1]);
    if (!/^  - task: PublishPipelineArtifact@1\n/.test(log ?? "") || !/targetPath: \$\(AI_OS_CI_LOG_DIR\)\n/.test(log ?? "") || /continueOnError/.test(log ?? "") ||
        !/^  - task: PublishPipelineArtifact@1\n/.test(rec ?? "") || !/targetPath: \.ai\/ci\n/.test(rec ?? "") ||
        JSON.stringify([conds(log), conds(rec)]) !== JSON.stringify([["always()"], ["always()"]])) v.push("no artefact step (always, log + .ai/ci)");
    if (!/AI_OS_CI_LOG_DIR\]/.test(AI)) v.push("ai ci run does not set AI_OS_CI_LOG_DIR for the artefact step");
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
  ],
  azure: (good, boot) => [
    ["recipe command copied", good.replace(`bash: |\n      ${AI_CI_RUN}`, `bash: |\n      ${AI_CI_RUN}\n      bash tests/run.sh`), "recipe command copied"],
    ["recipe command in the bootstrap", good.replace(`bash: ${boot.command}\n`, `bash: ${boot.command} && npm ci --ignore-scripts\n`), "recipe command copied"],
    ["PR trigger missing", good.replace(/^pr:\n  branches:\n    include: \[master\]\n/m, ""), "no pull_request trigger"],
    ["artefact step not always()", good.replace("    displayName: Upload run log\n    condition: always()\n", "    displayName: Upload run log\n"), "no artefact step"],
    ["secrets referenced", good.replace(`    displayName: ai ci run\n`, `    displayName: ai ci run\n    env:\n      T: $(System.AccessToken)\n`), "references secrets"],
    ["secret variable macro", good.replace("targetPath: .ai/ci", "targetPath: $(MySecret)"), "references secrets"],
    ["run step may set any variable", good.replace("      settableVariables:\n        - AI_OS_CI_LOG_DIR\n", ""), "steps may set any pipeline variable"],
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
test("this repository's .github/workflows/ci.yml is the current github rendering, byte for byte", () => {
  assert.equal(readFileSync(join(REPO, PROVIDERS.github.path), "utf8"), render("github", bootstrapFor(REPO), "master"));
});
