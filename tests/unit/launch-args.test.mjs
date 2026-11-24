// launch-args.test.mjs — an Architect-writable value cannot add an argument to a role launch
// (SECURITY.md lean-core security round F1, T-SANDBOXLANE-001). New file: no unit test drove
// provider-adapter.mjs or resolve-launch.mjs before; the real-session half (rein pane, the
// sandbox) is in tests/suites/sandbox_escape_test.sh (C31).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { roleModel, roleLabel, RoleConfigError } from "../../src/shared/provider-adapter.mjs";
import { testerModel } from "../../src/shared/test-command.mjs";

const RESOLVE = fileURLToPath(new URL("../../src/shared/resolve-launch.mjs", import.meta.url));
const INJECT = "haiku\n--mcp-config\n/tmp/m.json";

function project(roles, providers) {
  const root = mkdtempSync(join(tmpdir(), "la-"));
  mkdirSync(join(root, ".ai"));
  writeFileSync(join(root, ".ai", "roles.json"), JSON.stringify({ roles }));
  if (providers) writeFileSync(join(root, ".ai", "providers.json"), JSON.stringify({ providers }));
  return { ai: join(root, ".ai"), root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function resolve(p, role) {
  return spawnSync(process.execPath, ["--no-warnings", RESOLVE, role, p.ai, join(p.root, "roles")], { encoding: "utf8" });
}

test("roleModel: a model name passes, trimmed; anything else is refused, never defaulted", () => {
  const ok = { architect: "fable", engineer: " claude-opus-4-1[1m] ", tester: "us.anthropic.claude-x:0" };
  const p = project(Object.fromEntries(Object.entries(ok).map(([r, m]) => [r, { provider: "claude", model: m }])));
  try {
    for (const [r, m] of Object.entries(ok)) assert.equal(roleModel(p.ai, r), m.trim());
  } finally { p.done(); }
  for (const bad of [INJECT, "haiku\r--settings", "--dangerously-skip-permissions", "a b", "x".repeat(65), 5]) {
    const q = project({ engineer: { provider: "claude", model: bad }, tester: { provider: "claude", model: bad } });
    try {
      assert.throws(() => roleModel(q.ai, "engineer"), (e) => e instanceof RoleConfigError && /ROLE_MODEL_INVALID/.test(e.message), JSON.stringify(bad));
      assert.throws(() => testerModel(q.ai), RoleConfigError, "the Tester's model is refused too");
      assert.match(roleLabel(q.ai, "engineer"), /invalid model/, "a label never throws");
    } finally { q.done(); }
  }
});

test("resolve-launch: an injected model is refused (exit 4, reason on stderr, nothing on stdout)", () => {
  const p = project({ engineer: { provider: "claude", model: INJECT } });
  try {
    const r = resolve(p, "engineer");
    assert.equal(r.status, 4);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /ROLE_MODEL_INVALID/);
  } finally { p.done(); }
});

test("resolve-launch: a line break in any other element (a providers.json template) is refused", () => {
  // A non-claude provider takes its launch line from providers.json; rein pane refuses it later,
  // but the resolver must not frame a line break as two elements first.
  const p = project({ engineer: { provider: "other" } }, { other: { launch: ["--x", "a\n--mcp-config"] } });
  try {
    const r = resolve(p, "engineer");
    assert.equal(r.status, 4);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /LAUNCH_ARG_INVALID/);
  } finally { p.done(); }
});

test("resolve-launch: a valid model gives exactly one --model operand", () => {
  const p = project({ engineer: { provider: "claude", model: "haiku" } });
  try {
    const r = resolve(p, "engineer");
    assert.equal(r.status, 0, r.stderr);
    const argv = r.stdout.split("\n").slice(1);
    assert.equal(argv.filter((a) => a === "--model").length, 1);
    assert.equal(argv[argv.indexOf("--model") + 1], "haiku");
    assert.ok(!argv.includes("--mcp-config"), "the Engineer has no --mcp-config");
  } finally { p.done(); }
});
