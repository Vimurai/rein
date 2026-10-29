#!/usr/bin/env node
// provider-workspace.mjs — decide which provider workspace directories a project
// should actually have, and which are left over from a provider nothing is bound to.
//
// WHY THIS EXISTS (E-244, D-066 §4):
//   `ai sync` must only provision workspaces for providers a role is bound to, so a
//   project never carries fully-populated workspaces for CLIs nothing will ever read.
//   The only built-in provider is `claude`; a provider named in .ai/providers.json with
//   a `workspace_dir` is classified the same way.
//
// .claude/ IS NEVER STALE. The git hooks, settings.json and the SessionStart role stamp
// live there and are read whether or not roles.json happens to name `claude` — a project
// whose roles.json is missing or corrupt must not have its hook wiring pruned as a
// consequence. Fail-safe beats consistent here.
//
// This module CLASSIFIES ONLY. It never deletes anything: the removal is done by the
// shell caller through sync-manifest.mjs, so the evidence rules that protect a user's
// own files (E-220: sync wrote it, nobody edited it, it is gone upstream) apply to a
// stale workspace exactly as they apply to a live one.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Vendor-named workspace directories (D-052). A provider named in .ai/providers.json
// supplies its own `workspace_dir`; this is the built-in, so a providers.json without
// that field still classifies correctly.
const BUILTIN_WORKSPACE_DIRS = {
  claude: ".claude",
};

// Never pruned, whatever roles.json says — see the header.
export const ALWAYS_PROVISIONED = new Set(["claude"]);

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // a corrupt config must not make a live workspace look stale
  }
}

/** Providers that at least one role in .ai/roles.json is bound to. */
export function mappedProviders(aiDir) {
  const roles = readJson(join(aiDir, "roles.json"))?.roles;
  if (!roles || typeof roles !== "object") return null; // null = UNKNOWN, not "none"
  const out = new Set();
  for (const v of Object.values(roles)) {
    if (v && typeof v === "object" && typeof v.provider === "string" && v.provider) {
      out.add(v.provider);
    }
  }
  return out;
}

/**
 * Every provider this project knows about, with its workspace directory and status.
 * @returns {{provider:string, dir:string, mapped:boolean, always:boolean,
 *            exists:boolean, stale:boolean, roles:string[], mcp_config:string|null}[]}
 */
export function classify(aiDir, projectRoot = ".") {
  const rolesCfg = readJson(join(aiDir, "roles.json"))?.roles ?? {};
  const providersCfg = readJson(join(aiDir, "providers.json"))?.providers ?? {};
  const mapped = mappedProviders(aiDir);

  const names = new Set([
    ...Object.keys(BUILTIN_WORKSPACE_DIRS),
    ...Object.keys(providersCfg),
  ]);

  const out = [];
  for (const provider of [...names].sort()) {
    const cfg = providersCfg[provider] ?? {};
    const dir = cfg.workspace_dir || BUILTIN_WORKSPACE_DIRS[provider] || null;
    if (!dir) continue; // a provider with no workspace of its own has nothing to prune
    const roles = Object.entries(rolesCfg)
      .filter(([, v]) => v && typeof v === "object" && v.provider === provider)
      .map(([k]) => k)
      .sort();
    const always = ALWAYS_PROVISIONED.has(provider);
    // An UNREADABLE roles.json (mapped === null) means we do not know what is bound.
    // Treat every provider as mapped in that case: provisioning too much is recoverable,
    // pruning a live workspace on the strength of a parse error is not.
    const isMapped = mapped === null ? true : mapped.has(provider);
    const exists = existsSync(join(projectRoot, dir));
    out.push({
      provider,
      dir,
      roles,
      mapped: isMapped,
      always,
      exists,
      stale: !isMapped && !always && exists,
      mcp_config: typeof cfg.mcp_config_path === "string" ? cfg.mcp_config_path : null,
    });
  }
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
//   list  <aiDir> [projectRoot]   → one TSV line per provider:
//                                   <provider>\t<dir>\t<status>\t<roles,>\t<mcp_config>
//                                   status ∈ mapped | always | stale | absent
//   stale <aiDir> [projectRoot]   → one TSV line per STALE provider: <provider>\t<dir>\t<mcp_config>
// Exit 0 always for `list`. `stale` exits 1 when there are none, so the shell can branch
// on the status instead of on empty output.
const _isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch { return false; }
})();

if (_isMain) {
  const [, , mode, aiDir = ".ai", projectRoot = "."] = process.argv;
  if (mode !== "list" && mode !== "stale") {
    process.stderr.write("usage: provider-workspace.mjs <list|stale> <aiDir> [projectRoot]\n");
    process.exit(2);
  }
  const rows = classify(aiDir, projectRoot);
  if (mode === "stale") {
    const s = rows.filter((r) => r.stale);
    for (const r of s) process.stdout.write(`${r.provider}\t${r.dir}\t${r.mcp_config ?? ""}\n`);
    process.exit(s.length ? 0 : 1);
  }
  for (const r of rows) {
    const status = r.always ? "always" : r.stale ? "stale" : r.mapped ? "mapped" : "absent";
    process.stdout.write(`${r.provider}\t${r.dir}\t${status}\t${r.roles.join(",")}\t${r.mcp_config ?? ""}\n`);
  }
  process.exit(0);
}
