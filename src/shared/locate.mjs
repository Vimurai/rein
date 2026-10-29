#!/usr/bin/env node
// locate.mjs — node twin of locate.sh (E-223, D-057 §3). Same policy, same order,
// same env flags; see locate.sh for the full rationale.
//
// The two must not drift, so the policy is stated once here in code and once there in
// shell, and `locator_policy_test.sh` drives BOTH and compares their answers on the same
// inputs rather than trusting that they look alike.

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";

// The caller sets AI_OS_LOCATE_UNTRUSTED_ENV=1 to say "the environment I run in may have
// been chosen by the repository I am visiting" — see locate.sh for the full rationale.
// This twin was NOT updated when the shell side was hardened, so for a round the two
// implemented different trust models: with the flag set exactly as the hooks set it, the
// shell returned the install mirror and node returned the decoy, for all three of
// AI_OS_LOCATE_DEV, AI_OS_HOME and AIOS_WORKSPACE. Nothing imports this module yet, so it
// was not live — but it is the resolver any future node caller is pointed at, and its
// header claimed "same policy, same env flags", which had become false in the direction
// that matters. The parity test missed it because it only exercised the TRUSTED branch.
const UNTRUSTED_ENV = process.env.AI_OS_LOCATE_UNTRUSTED_ENV === "1";
const HOME_DIR = UNTRUSTED_ENV
  ? join(process.env.HOME || "", ".ai-os")
  : (process.env.AI_OS_HOME || join(process.env.HOME || "", ".ai-os"));

function gitToplevel(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

const canonical = (p) => { try { return realpathSync(resolve(p)); } catch { return resolve(p); } };

// The dev-tree override is module STATE flipped by a function call, never an env value —
// see locate.sh. An env var here would be readable from a project's own settings.json,
// which is exactly the channel this whole module exists to distrust.
let devTreeEnabled = false;

/** Enable dev-tree-first resolution. Call only for an explicit user-supplied flag. */
export function enableDevTree() { devTreeEnabled = true; }

/** Test seam: restore the default. */
export function _resetDevTree() { devTreeEnabled = false; }

/** True when `cwd`'s git toplevel is the AI-OS framework clone. */
export function isFrameworkClone(cwd = process.cwd()) {
  const top = gitToplevel(cwd);
  if (!top) return false;

  // The installer-written FILE is authoritative; the env var is only a convenience and is
  // consulted second, and not at all under an untrusted env. The reverse precedence is
  // how `AIOS_WORKSPACE=$(pwd)` in a downstream repo made it read as the framework clone.
  let ws = "";
  const persisted = join(HOME_DIR, "config", "aios-workspace.txt");
  if (existsSync(persisted)) {
    try { ws = readFileSync(persisted, "utf8").split("\n")[0].trim(); } catch { ws = ""; }
  }
  if (!ws && !UNTRUSTED_ENV) ws = process.env.AIOS_WORKSPACE || "";
  if (ws) return canonical(ws) === canonical(top);

  // Only reached when the install recorded no workspace at all.
  const pkg = join(top, "package.json");
  if (!existsSync(pkg)) return false;
  try { return JSON.parse(readFileSync(pkg, "utf8")).name === "ai-os-v2"; } catch { return false; }
}

/**
 * Resolve an install-mirror-relative logical path ("mcp/safe-exec-mcp/index.js").
 * Returns an absolute path, or null.
 */
export function locate(logical, cwd = process.cwd()) {
  if (!logical) return null;
  const install = join(HOME_DIR, logical);
  const top = gitToplevel(cwd);
  const dev = top ? join(top, "src", logical) : null;

  let candidates;
  // AI_OS_LOCATE_DEV bypasses the framework-clone test entirely, so it is honoured only
  // when the environment is trusted.
  if (devTreeEnabled && dev) candidates = [dev, install];
  else if (process.env.AI_OS_LOCATE_DEV === "1" && !UNTRUSTED_ENV && dev) candidates = [dev, install];
  else if (dev && isFrameworkClone(cwd)) candidates = [dev, install];
  else candidates = [install];   // a downstream project's own src/ is never a candidate

  return candidates.find((c) => existsSync(c)) || null;
}

// CLI: locate.mjs <logical-path>  → prints the path, exit 1 when unresolved.
// Used by the cross-implementation parity test and by shell callers that already have node.
import { isMainModule } from "../mcp/shared/is-main.mjs";
if (isMainModule(import.meta.url)) {
  // Position-anchored, like bin/ai: only argv[2], never a later occurrence, so a literal
  // "--dev-tree" arriving as data cannot steer resolution.
  const args = process.argv.slice(2);
  if (args[0] === "--dev-tree") { enableDevTree(); args.shift(); }
  const p = locate(args[0]);
  if (!p) process.exit(1);
  process.stdout.write(p);
}
