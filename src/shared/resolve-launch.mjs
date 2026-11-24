#!/usr/bin/env node
// resolve-launch.mjs — resolve a ROLE to its provider + launch argv.
//
// WHY THIS EXISTS (E-208 review, critic_tests P2): `rein pane <role>` previously
// carried this resolution as an inline `node --input-type=module -e '...'` snippet
// while the test suite exercised provider-adapter.mjs directly. Two copies of the
// same logic, and neither test would fail if they drifted. This file is the single
// executable seam both use, so a change to the launch contract cannot pass tests
// while breaking the launcher.
//
// Usage:  node resolve-launch.mjs <role> <aiDir> [roleDir]
//         roleDir: where the role settings were generated (role-settings.mjs); default
//         ~/.rein/roles/<project key>.
// Output: line 1 = provider name, remaining lines = argv (one element per line).
// Exit:   0 ok | 2 role not mapped to a provider | 3 bad usage
//         | 4 refused: an invalid roles.json value, or an argv element holding a line break
//           (the reason is on stderr).
//
// One element per line (not JSON) so the bash caller can read it with a plain
// `while read` loop and keep argv elements intact even when they contain spaces.

import { roleProvider, roleModel, RoleConfigError, providerAdapter, buildArgv, absolutisePathOperands, DEFAULT_ADAPTERS } from "./provider-adapter.mjs";
import { roleDir, projectRoot as physicalRoot } from "./role-settings.mjs";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

const [, , role, aiDir, roleDirArg] = process.argv;
if (!role || !aiDir) {
  process.stderr.write("usage: resolve-launch.mjs <role> <aiDir>\n");
  process.exit(3);
}

const provider = roleProvider(aiDir, role);
if (!provider) process.exit(2);

const adapter = providerAdapter(aiDir, provider);
// The rulefile is what makes a same-provider Triad work: without ARCHITECT.md
// appended, a claude Architect pane boots the ENGINEER persona from CLAUDE.md (G1).
const rulefile = role === "architect" ? "ARCHITECT.md" : "ENGINEER.md";
const projectRoot = resolve(dirname(resolve(aiDir)));
// E-288 (D-079): the remote app (claude.ai/code, mobile, the session picker) lists sessions
// by display name, and the Triad runs two sessions per project — unnamed, the operator cannot
// tell the Architect from the Engineer. The PROJECT is part of the name because the remote
// list spans every project (the "phantom E-292" incident was another project's sessions).
const sessionName = `${basename(projectRoot)} · ${role.charAt(0).toUpperCase()}${role.slice(1)}`;
let model;
try {
  model = roleModel(aiDir, role);
} catch (e) {
  if (!(e instanceof RoleConfigError)) throw e;
  process.stderr.write(`${e.message}\n`);
  process.exit(4);
}
const subs = { role, rulefile, model, session_name: sessionName };
// E-462 (D-169 r3): a claude role session is launched from the install tree's template, never
// from .ai/providers.json — the Architect can write that file, and a launch line without
// --settings would start the next pane outside the sandbox. The settings operand is the role
// file `rein pane` generated under ~/.rein/roles/, which neither session can write; the
// Architect also gets only the state server (--strict-mcp-config).
const argv = buildArgv(provider === "claude" ? DEFAULT_ADAPTERS.claude.launch : adapter.launch, subs);
if (provider === "claude") {
  const dir = roleDirArg || roleDir(physicalRoot(aiDir));
  const i = argv.indexOf("--settings");
  if (i >= 0) argv[i + 1] = join(dir, `settings.${role}.json`);
  // --mcp-config takes several values: it goes right after --settings, so the next flag ends it
  // and an operator's argument after `rein pane architect --` is never read as a config file.
  if (role === "architect" && i >= 0) argv.splice(i + 2, 0, "--strict-mcp-config", "--mcp-config", join(dir, "mcp.architect.json"));
  // D-172 r2a: the Architect's session runs in <project>/.ai, where Claude Code reads no project
  // settings, so the project-scope enable of the rein plugin does not reach it. Load the plugin
  // the install built (<rein home>/plugin; the role dir is <rein home>/roles/<key>) for the session.
  const plugin = join(dirname(dirname(dir)), "plugin");
  if (role === "architect" && i >= 0 && existsSync(join(plugin, ".claude-plugin", "plugin.json"))) {
    argv.splice(i + 2, 0, "--plugin-dir", plugin);
  }
}

// E-288: inject the name when the project's .ai/providers.json predates {session_name} —
// same reason E-242 anchors paths here and not only in the template: a stale downstream
// file would otherwise stay unnamed until someone hand-edits it. claude only; another
// provider's flag of the same spelling could mean anything.
const NAME_FLAG = (a) => a === "--name" || a === "-n" || a.startsWith("--name=");
if (provider === "claude" && !argv.some(NAME_FLAG)) argv.push("--name", sessionName);

// E-242 (D-066): the adapter templates emit PROJECT-RELATIVE paths, which only resolve
// when the CLI's cwd is the project root. A pane opened in a subdirectory, or one whose
// rc-file `cd`s, made the CLI report "Settings file not found" for a file that exists.
//
// Anchoring here rather than in the templates fixes every project at once, including one
// whose .ai/providers.json predates this change and still carries the relative form —
// editing the default template alone would leave those broken.
const anchored = absolutisePathOperands(argv, projectRoot);

// SECURITY.md lean-core round F1: the output is line-framed, so an element holding a line break
// would become several argv elements in `rein pane` — a flag nobody configured. Whatever value
// carried it (roles.json, a providers.json template, the project directory's name), refuse the
// whole launch rather than drop or rewrite the element. NUL cannot reach here (argv is C strings)
// but is refused too, so the check does not depend on that.
const BREAK = /[\n\r\0]/;
const bad = [provider, ...anchored].find((a) => typeof a !== "string" || BREAK.test(a));
if (bad !== undefined) {
  process.stderr.write(`[LAUNCH_ARG_INVALID] the ${role} launch line has an element with a line break (${JSON.stringify(String(bad).slice(0, 80))}) — refusing. Check .ai/roles.json and .ai/providers.json.\n`);
  process.exit(4);
}

process.stdout.write([provider, ...anchored].join("\n"));
