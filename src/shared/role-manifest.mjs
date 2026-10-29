// role-manifest.mjs — resolve which SOURCE directories a provider's workspace should
// receive, by unioning the `shared` role with every role that provider serves.
//
// WHY THIS EXISTS (E-212, architect-provider-parity.md §Components 1-2):
//   `do_sync` used to provision by PROVIDER DIRECTORY — `src/claude/*` → `.claude/`,
//   `src/agents/*` → `.agents/` — which silently equated provider with role. That held
//   only while each vendor served exactly one role. Under D-054 a single provider can
//   serve BOTH roles in different panes, and then the Claude workspace needs the
//   Architect's 15 skills and 7 agents too, or the Architect pane is a Claude session
//   with no Architect tooling.
//
//   Directory names stay vendor-named (D-052). `registry.json → roles` is the ONLY
//   place that records which role a directory serves, and `.ai/roles.json` is the only
//   place that records which provider holds a role. This module is the join.
//
// UNION, not replacement: a provider serving both roles gets everything, deduped and
// order-stable. Sync stays additive (it never prunes), matching existing behaviour —
// so rebinding a role leaves the old provider's copies in place until it re-syncs.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // corrupt config degrades to "no extra dirs", never throws at a caller
  }
}

/** Roles a provider serves, per .ai/roles.json (e.g. ["architect","engineer"]). */
export function rolesForProvider(aiDir, provider) {
  const cfg = readJson(join(aiDir, "roles.json"));
  const roles = cfg?.roles;
  if (!roles || typeof roles !== "object") return [];
  return Object.entries(roles)
    .filter(([, v]) => v && typeof v === "object" && v.provider === provider)
    .map(([k]) => k)
    .sort();
}

/**
 * Source dirs a provider's workspace should receive.
 * @returns {{skill_dirs:string[], agent_dirs:string[], roles:string[]}}
 *          paths are repo-relative to src/ (e.g. "agents/skills").
 */
export function providerSources(aiDir, registryPath, provider) {
  const manifest = readJson(registryPath)?.roles ?? {};
  const served = rolesForProvider(aiDir, provider);

  // `shared` is always included — it is not a role anyone is bound to, it is the
  // baseline every workspace gets. Listing it in the manifest keeps the set of
  // source directories in ONE place rather than half here and half hardcoded.
  const keys = ["shared", ...served];

  const skills = [];
  const agents = [];
  for (const key of keys) {
    const entry = manifest[key];
    if (!entry || typeof entry !== "object") continue;
    for (const d of entry.skill_dirs ?? []) if (!skills.includes(d)) skills.push(d);
    for (const d of entry.agent_dirs ?? []) if (!agents.includes(d)) agents.push(d);
  }
  return { skill_dirs: skills, agent_dirs: agents, roles: served };
}

/** Rulefile for a role, per the manifest (ARCHITECT.md / ENGINEER.md). */
export function rulefileForRole(registryPath, role) {
  return readJson(registryPath)?.roles?.[role]?.rulefile ?? "";
}

// ── CLI: `node role-manifest.mjs <aiDir> <registryPath> <provider> [--agents]` ──
// Prints one source dir per line (skills by default, agent dirs with --agents) so
// bash callers can consume it with a plain `while read` loop. Exit 0 even when the
// list is empty — an unserved provider is a normal state, not an error.
// Compare the RESOLVED entrypoint URL, not a filename suffix: when this module is
// imported dynamically (e.g. `node -e 'import(...)'`), argv[1] is the module path
// itself, so a suffix test wrongly concluded "I am the CLI" and printed usage +
// exit 2 into an importing caller. Caught by `ai doctor` aborting mid-report.
const _isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch { return false; }
})();

if (_isMain) {
  const [, , aiDir, registryPath, provider, flag] = process.argv;
  if (!aiDir || !registryPath || !provider) {
    process.stderr.write("usage: role-manifest.mjs <aiDir> <registryPath> <provider> [--agents|--roles]\n");
    process.exit(2);
  }
  const out = providerSources(aiDir, registryPath, provider);
  const list = flag === "--agents" ? out.agent_dirs : flag === "--roles" ? out.roles : out.skill_dirs;
  if (list.length) process.stdout.write(list.join("\n") + "\n");
}
