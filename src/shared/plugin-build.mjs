#!/usr/bin/env node
// plugin-build.mjs — the Rein Claude Code plugin (E-469, D-170 r4, lean-core.md §Revision 2
// Packaging).
//
// The kept agents, skills and Claude Code hooks ship as ONE plugin, built from the install home
// into <rein-home>/plugin/ and loaded in place from a local-directory marketplace (the same
// folder carries .claude-plugin/marketplace.json, entry source "./"). Nothing is published.
//
//   <rein-home>/plugin/
//     .claude-plugin/plugin.json        from claude/plugin/plugin.json, version = <rein-home>/VERSION
//     .claude-plugin/marketplace.json   from claude/plugin/marketplace.json
//     agents/<name>.md                  the registry's agent_dirs (union over roles, as rein sync did)
//     skills/<name>/                    the registry's skill_dirs (same union)
//     hooks/hooks.json                  PLUGIN_HOOKS, exec form /bin/bash -p <rein-home>/hooks/<script>
//
// What the plugin does NOT carry, and why (the handoff states it):
//   - hooks/pre-tool-use.sh (the seatbelt, E-463): its registration stays where `rein doctor`
//     checks it — the project's .claude/settings.json, written by rein init / rein sync — and in
//     the Architect's role file, since a session started in .ai/ reads no project settings.
//   - the git hooks (pre-commit, pre-push, post-commit, state-import): a plugin declares Claude
//     Code hooks only; rein init / rein sync install the git stubs.
//   - task-synchronizer-mcp: a plugin can declare it, but its tools would be renamed
//     mcp__plugin_rein_<server>__<tool>, which every allow rule, agent tool list and the
//     Architect's MCP file name today. It stays in the project's .mcp.json.
//   - the role settings files: a plugin cannot carry sandbox or permission settings; rein init,
//     rein pane and rein start write them under ~/.rein/roles/.
//
// The hook commands are the install-time ABSOLUTE path in exec form (E-290): no shell, no
// ${CLAUDE_PLUGIN_ROOT} (a copied plugin's root is a cache directory without the hook scripts).
//
// Usage:
//   node plugin-build.mjs build --rein-home <dir>   → builds <dir>/plugin atomically; one summary line
//   node plugin-build.mjs units --rein-home <dir>   → JSON {agents, skills, hooks, events} of the built plugin
// Exit 1 when the build cannot complete (nothing is swapped in), 2 on bad arguments.

import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { isMainModule } from "../mcp/shared/is-main.mjs";

export const PLUGIN_NAME = "rein";
export const MARKETPLACE_NAME = "rein";
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

/** The Claude Code hooks the plugin carries: [event, matcher, script]. Moved from rein sync's
 *  project-settings table (E-469). session-start.sh (E-460 brief, E-129/E-294 role token) fires on
 *  clear and compact too: `/clear` issues a NEW session id in the same process (measured
 *  2026-10-04), which needs its own token or the session falls into the union; it takes no role
 *  argument (the role is the launch-record walk's, D-087). The waiting-signal rows are E-433's
 *  (D-160, docs/app-contract.md §6). */
export const PLUGIN_HOOKS = Object.freeze([
  ["SessionStart", "startup|resume|clear|compact", "session-start.sh"],
  ["PermissionRequest", ".*", "waiting-signal.sh"],
  ["Notification", "permission_prompt|elicitation_dialog", "waiting-signal.sh"],
  ["PreToolUse", "AskUserQuestion|ExitPlanMode", "waiting-signal.sh"],
  ["PostToolUse", ".*", "waiting-signal.sh"],
  ["PostToolUseFailure", ".*", "waiting-signal.sh"],
  ["UserPromptSubmit", ".*", "waiting-signal.sh"],
  ["Stop", ".*", "waiting-signal.sh"],
  ["SessionStart", "startup|resume|clear|compact", "waiting-signal.sh"],
  ["SessionEnd", ".*", "waiting-signal.sh"],
  ["PermissionDenied", ".*", "waiting-signal.sh"],
]);

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

/** Skill and agent directories the registry provisions to every role (union over roles), and the
 *  names they hold. `tree` is an install home or a source tree's src/. null without registry roles. */
export function provisioned(tree) {
  const reg = readJson(join(tree, "config", "registry.json"));
  if (!reg?.roles) return null;
  const skillDirs = new Set(), agentDirs = new Set();
  for (const [k, r] of Object.entries(reg.roles)) {
    if (k.startsWith("_") || !r || typeof r !== "object") continue;
    for (const d of r.skill_dirs || []) skillDirs.add(d);
    for (const d of r.agent_dirs || []) agentDirs.add(d);
  }
  // name → absolute source path. One plugin serves both roles, so two DIFFERENT units under one
  // name cannot both ship (E-217's collision, D-055 R2: rename the role-specific one, as
  // arch-oracle / arch-review were); the same content twice is the same unit.
  const skills = new Map(), agents = new Map(), collisions = [];
  const claim = (map, name, path, file) => {
    const prev = map.get(name);
    if (prev === undefined) { map.set(name, path); return; }
    const a = readFileSync(file(prev), "utf8"), b = readFileSync(file(path), "utf8");
    if (a !== b) collisions.push(`${name} (${prev} and ${path})`);
  };
  for (const d of skillDirs) {
    for (const e of (isDir(join(tree, d)) ? readdirSync(join(tree, d)).sort() : [])) {
      if (isFile(join(tree, d, e, "SKILL.md"))) claim(skills, e, join(tree, d, e), (p) => join(p, "SKILL.md"));
    }
  }
  for (const d of agentDirs) {
    for (const e of (isDir(join(tree, d)) ? readdirSync(join(tree, d)).sort() : [])) {
      if (e.endsWith(".md") && isFile(join(tree, d, e))) claim(agents, e.slice(0, -3), join(tree, d, e), (p) => p);
    }
  }
  return {
    collisions,
    skillDirs: [...skillDirs], agentDirs: [...agentDirs],
    skills: [...skills.keys()].sort(), agents: [...agents.keys()].sort(),
    skillPaths: skills, agentPaths: agents, mcp: reg.mcp_servers || {},
  };
}

/** hooks/hooks.json for a hooks directory: one exec-form entry per PLUGIN_HOOKS row. */
export function hooksDoc(hooksDir) {
  const hooks = {};
  for (const [event, matcher, script] of PLUGIN_HOOKS) {
    (hooks[event] ||= []).push({
      matcher,
      hooks: [{ type: "command", command: "/bin/bash", args: ["-p", join(hooksDir, script)], timeout: 30 }],
    });
  }
  return { hooks };
}

/** Build <reinHome>/plugin. Returns {dir, agents, skills, hooks} or throws with the reason. */
export function buildPlugin({ reinHome }) {
  const tmplDir = join(reinHome, "claude", "plugin");
  const manifest = readJson(join(tmplDir, "plugin.json"));
  const market = readJson(join(tmplDir, "marketplace.json"));
  if (!manifest || !market) throw new Error(`no plugin manifest templates in ${tmplDir}`);
  const units = provisioned(reinHome);
  if (!units) throw new Error(`no registry.json roles in ${join(reinHome, "config")}`);
  if (units.collisions.length) {
    throw new Error(`two different units under one name: ${units.collisions.join("; ")} — rename the role-specific one (D-055 R2 precedent: arch-oracle, arch-review)`);
  }
  const hooksDir = join(reinHome, "hooks");
  const scripts = [...new Set(PLUGIN_HOOKS.map((r) => r[2]))];
  const missing = scripts.filter((s) => !isFile(join(hooksDir, s)));
  if (missing.length) throw new Error(`hook script(s) missing in ${hooksDir}: ${missing.join(", ")}`);

  let version = "";
  try { version = readFileSync(join(reinHome, "VERSION"), "utf8").trim(); } catch { /* the template's */ }
  if (/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/.test(version)) manifest.version = version;
  manifest.name = PLUGIN_NAME;
  market.name = MARKETPLACE_NAME;

  const dir = join(reinHome, "plugin");
  const tag = randomBytes(6).toString("hex");
  const fresh = join(reinHome, `.plugin.new.${tag}`);
  const old = join(reinHome, `.plugin.old.${tag}`);
  try {
    mkdirSync(join(fresh, ".claude-plugin"), { recursive: true });
    mkdirSync(join(fresh, "agents"));
    mkdirSync(join(fresh, "skills"));
    mkdirSync(join(fresh, "hooks"));
    writeFileSync(join(fresh, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(fresh, ".claude-plugin", "marketplace.json"), JSON.stringify(market, null, 2) + "\n");
    for (const [name, src] of units.agentPaths) cpSync(src, join(fresh, "agents", `${name}.md`));
    for (const [name, src] of units.skillPaths) cpSync(src, join(fresh, "skills", name), { recursive: true });
    writeFileSync(join(fresh, "hooks", "hooks.json"), JSON.stringify(hooksDoc(hooksDir), null, 2) + "\n");
    // The swap: the old folder steps aside, the new one takes its name, the old one goes. The path
    // stays the same, so the marketplace Claude Code recorded keeps pointing at it.
    const had = existsSync(dir);
    if (had) renameSync(dir, old);
    try {
      renameSync(fresh, dir);
    } catch (e) {
      if (had) renameSync(old, dir);   // the old plugin stays in place
      throw e;
    }
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
  return { dir, agents: units.agents, skills: units.skills, hooks: scripts };
}

/** What a built plugin holds, read from its folder (doctor). null when there is no manifest. */
export function pluginUnits(reinHome) {
  const dir = join(reinHome, "plugin");
  if (!isFile(join(dir, ".claude-plugin", "plugin.json"))) return null;
  const agents = isDir(join(dir, "agents")) ? readdirSync(join(dir, "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort() : [];
  const skills = isDir(join(dir, "skills")) ? readdirSync(join(dir, "skills")).filter((d) => isFile(join(dir, "skills", d, "SKILL.md"))).sort() : [];
  const doc = readJson(join(dir, "hooks", "hooks.json"));
  const scripts = new Set(), events = new Set();
  for (const [ev, lst] of Object.entries(doc?.hooks || {})) {
    for (const e of Array.isArray(lst) ? lst : []) {
      for (const h of e?.hooks || []) {
        const a = Array.isArray(h?.args) ? h.args : [];
        if (h?.command === "/bin/bash" && a[0] === "-p" && typeof a[1] === "string") {
          scripts.add(a[1].split("/").pop());
          events.add(ev);
        }
      }
    }
  }
  return { dir, agents, skills, hooks: [...scripts].sort(), events: [...events].sort() };
}

if (isMainModule(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const i = rest.indexOf("--rein-home");
  const reinHome = i >= 0 ? rest[i + 1] : "";
  if (!["build", "units"].includes(cmd) || !reinHome) {
    console.error("usage: plugin-build.mjs build|units --rein-home <dir>");
    process.exit(2);
  }
  if (cmd === "units") {
    const u = pluginUnits(reinHome);
    process.stdout.write(JSON.stringify(u) + "\n");
    process.exit(u ? 0 : 1);
  }
  try {
    const r = buildPlugin({ reinHome });
    console.log(`plugin ${PLUGIN_ID} built in ${r.dir}: ${r.agents.length} agents, ${r.skills.length} skills, hooks ${r.hooks.join(" ")}`);
  } catch (e) {
    console.error(`[PLUGIN_BUILD_FAILED] ${e.message}`);
    process.exit(1);
  }
}
