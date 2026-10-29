// test-command.mjs — what `skill: ai-test` runs, and on which model the Tester works.
//
// WHY THIS EXISTS (E-255, D-069 / claude-native-consolidation.md §Components 3):
//   The third-party test cloud is gone. The Tester's default is now the project's OWN test command, and
//   its model comes from .ai/roles.json like the other two roles. A skill is markdown, so
//   the two decisions it depends on live here, where a fixture can pin them:
//     - detectTestCommand(root) — package.json `test`, else tests/run.sh, else pytest,
//       else go test. First match wins; nothing found is a result, not a guess.
//     - testerModel(aiDir, {fast}) — `--fast` is haiku; otherwise the tester role's model,
//       falling back to sonnet. Aliases only, never dated ids, so upgrades are config.
//
// CLI: node test-command.mjs [--fast] [projectRoot]
//   prints {"command","source","model"} as JSON; exit 3 when no test command is found.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { roleModel } from "./provider-adapter.mjs";

export const FAST_MODEL = "haiku";
export const DEFAULT_TESTER_MODEL = "sonnet";

// `npm init` writes this placeholder; running it would "fail" a project with no tests.
const NPM_PLACEHOLDER = /no test specified/i;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function readText(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function hasPytest(root) {
  if (existsSync(join(root, "pytest.ini")) || existsSync(join(root, "conftest.py"))) return true;
  if (/^\[tool\.pytest/m.test(readText(join(root, "pyproject.toml")))) return true;
  if (/^\[(tool:)?pytest\]/m.test(readText(join(root, "setup.cfg")))) return true;
  if (/^\[pytest\]/m.test(readText(join(root, "tox.ini")))) return true;
  try {
    return readdirSync(join(root, "tests")).some((f) => /^test_.*\.py$|_test\.py$/.test(f));
  } catch {
    return false;
  }
}

/**
 * The project's real test command.
 * @param {string} root project root
 * @returns {{command:string, source:string} | null}
 */
export function detectTestCommand(root) {
  const pkg = readJson(join(root, "package.json"));
  const script = pkg?.scripts?.test;
  if (typeof script === "string" && script.trim() && !NPM_PLACEHOLDER.test(script)) {
    return { command: "npm test", source: "package.json" };
  }
  if (existsSync(join(root, "tests", "run.sh"))) {
    return { command: "bash tests/run.sh", source: "tests/run.sh" };
  }
  if (hasPytest(root)) return { command: "pytest", source: "pytest" };
  if (existsSync(join(root, "go.mod"))) return { command: "go test ./...", source: "go.mod" };
  return null;
}

/** Model the Tester runs on: haiku under --fast, else roles.json's tester model, else sonnet. */
export function testerModel(aiDir, { fast = false } = {}) {
  if (fast) return FAST_MODEL;
  return roleModel(aiDir, "tester") || DEFAULT_TESTER_MODEL;
}

const _isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch { return false; }
})();

if (_isMain) {
  const args = process.argv.slice(2);
  const fast = args.includes("--fast");
  const root = resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());
  const found = detectTestCommand(root);
  const out = {
    command: found?.command ?? null,
    source: found?.source ?? null,
    model: testerModel(join(root, ".ai"), { fast }),
  };
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(found ? 0 : 3);
}
