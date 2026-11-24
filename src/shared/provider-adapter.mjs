// provider-adapter.mjs — single source of truth for resolving a ROLE to a PROVIDER
// and building that provider's argv from the Provider Adapter Registry.
//
// WHY THIS EXISTS (E-210, D-054 / role-abstraction.md §Same-Provider Triad):
//   Two callers need exactly this resolution and must never drift apart:
//     - advisor-mcp::ask_architect  — the SYNCHRONOUS A2A bridge (print mode)
//     - `rein pane <role>` (src/bin/rein) — the per-pane role binding launcher
//   Before E-210 the bridge hardcoded its executable, so a Triad bound to another
//   provider silently consulted the WRONG architect. The executable and its argv
//   both come from .ai/roles.json × .ai/providers.json.
//
// DATA MODEL (role-abstraction.md §Data Model):
//   .ai/roles.json     { roles: { <role>: { provider, pane_identifier?, model?, headless? } } }
//   .ai/providers.json { providers: { <name>: { launch[], print_mode[],
//                                               child_env_unset[] } } }
//   Templates substitute {role} {rulefile} {model} {prompt} {session_name}. An entry whose
//   placeholder resolves to EMPTY is dropped — together with an immediately
//   preceding flag entry, so `["--model", "{model}"]` with no model configured
//   collapses to nothing rather than emitting a dangling `--model`.

import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";

// D-066 defaults — used when .ai/roles.json is absent or malformed. Kept in sync with
// src/templates/roles.json (architect=claude:1 · fable, engineer=claude:0 · opus).
// E-255 (D-069): the Tester is the third Claude role — headless, no pane.
export const DEFAULT_ROLE_PROVIDERS = { architect: "claude", engineer: "claude", tester: "claude" };
// Per-role model fallbacks, applied only when the role's provider is claude — another
// provider has no use for a claude model name.
export const DEFAULT_ROLE_MODELS = { architect: "fable", engineer: "opus", tester: "sonnet" };
// Roles that are headless when roles.json does not say otherwise. A headless role is
// dispatched as a subagent (the Tester via skill: rein-test) and is never laid out as a
// pane, never bound by `rein pane`, and never minted a role token (claude-native-consolidation.md §Security).
export const DEFAULT_HEADLESS_ROLES = new Set(["tester"]);

// Built-in adapter fallbacks, so a project whose .ai/providers.json predates E-210
// (no launch/print_mode keys) still resolves a working argv instead of throwing.
export const DEFAULT_ADAPTERS = {
  claude: {
    launch: ["--settings", ".claude/settings.{role}.json", "--append-system-prompt-file", "{rulefile}", "--model", "{model}", "--name", "{session_name}"],
    print_mode: ["-p", "--append-system-prompt-file", "{rulefile}", "{prompt}"],
    child_env_unset: ["CLAUDECODE"],
  },
};

function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // corrupt config must degrade to defaults, never throw at a caller
  }
}

/** Role entry from .ai/roles.json, or {} when absent/malformed. */
export function roleEntry(aiDir, role) {
  const cfg = readJson(join(aiDir, "roles.json"));
  const entry = cfg?.roles?.[role];
  return entry && typeof entry === "object" ? entry : {};
}

/** Provider bound to `role`. Falls back to the D-050 default map. */
export function roleProvider(aiDir, role) {
  const p = roleEntry(aiDir, role).provider;
  return (typeof p === "string" && p.trim()) ? p.trim() : (DEFAULT_ROLE_PROVIDERS[role] ?? "");
}

/**
 * A model name, as `--model` takes it: an alias (`opus`), a full id (`claude-opus-4-1`), a
 * context suffix (`opus[1m]`) or a vendor-prefixed id (`us.anthropic.claude-…:0`). It starts
 * with a letter or digit, so it can never be read as a flag.
 *
 * WHY STRICT (SECURITY.md lean-core round F1, T-SANDBOXLANE-001): .ai/roles.json is in the
 * Architect's lane and `model` reaches the operator's launch argv. resolve-launch prints argv one
 * element per line and `rein pane` reads it back line by line, so a newline in `model` added
 * `--mcp-config` to the next launch and an MCP server ran outside the sandbox.
 */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;

/** Thrown for a roles.json value that must not reach a launch line. Never a silent fallback. */
export class RoleConfigError extends Error {
  constructor(message) { super(message); this.name = "RoleConfigError"; this.code = "ROLE_CONFIG_INVALID"; }
}

/**
 * Optional per-role model override ("" when unset). An invalid value THROWS RoleConfigError:
 * falling back to the default would hide an injection attempt and start a session on a model
 * nobody configured.
 */
export function roleModel(aiDir, role) {
  const m = roleEntry(aiDir, role).model;
  if (m === undefined || m === null) return "";
  if (typeof m !== "string") {
    throw new RoleConfigError(`[ROLE_MODEL_INVALID] .ai/roles.json roles.${role}.model must be a string, got ${typeof m} — refusing.`);
  }
  const t = m.trim();
  if (!t) return "";
  if (!MODEL_RE.test(t)) {
    const shown = JSON.stringify(m.length > 80 ? `${m.slice(0, 80)}…` : m);
    throw new RoleConfigError(`[ROLE_MODEL_INVALID] .ai/roles.json roles.${role}.model ${shown} is not a model name (expected ${MODEL_RE.source}) — refusing. Fix the value or remove the key.`);
  }
  return t;
}

/** True when `role` has no pane: an explicit `headless` in roles.json wins over the default. */
export function isHeadless(aiDir, role) {
  const h = roleEntry(aiDir, role).headless;
  return typeof h === "boolean" ? h : DEFAULT_HEADLESS_ROLES.has(role);
}

/**
 * Human label for a role, DERIVED from roles.json (E-255, D-066 lineage):
 * "Tester (claude · sonnet)". The model falls back to the default only for a claude
 * binding; an unmodelled role renders as "Tester (claude)". Never a vendor literal.
 */
export function roleLabel(aiDir, role) {
  const name = String(role || "");
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  const provider = roleProvider(aiDir, name);
  let model;
  try {
    model = roleModel(aiDir, name) || (provider === "claude" ? (DEFAULT_ROLE_MODELS[name] ?? "") : "");
  } catch {
    model = "invalid model"; // a label is display only; the launch and the Tester refuse
  }
  if (!provider) return title;
  return model ? `${title} (${provider} · ${model})` : `${title} (${provider})`;
}

/** Adapter for `provider`, merged over the built-in default. */
export function providerAdapter(aiDir, provider) {
  const cfg = readJson(join(aiDir, "providers.json"));
  const fromFile = cfg?.providers?.[provider];
  const builtin = DEFAULT_ADAPTERS[provider] ?? {};
  return { ...builtin, ...(fromFile && typeof fromFile === "object" ? fromFile : {}) };
}

const PLACEHOLDER = /\{(role|rulefile|model|prompt|session_name)\}/g;

/**
 * Substitute {placeholders} in an argv template.
 * Any entry whose placeholder resolves to an empty string is dropped, along with an
 * immediately preceding flag (`-`-prefixed) entry — so an unset {model} removes the
 * whole `--model {model}` pair rather than leaving a dangling flag.
 *
 * @param {string[]} template
 * @param {Record<string,string>} subs
 * @returns {string[]}
 */
export function buildArgv(template, subs = {}) {
  if (!Array.isArray(template)) return [];
  const out = [];
  for (const raw of template) {
    if (typeof raw !== "string") continue;
    let dropped = false;
    const val = raw.replace(PLACEHOLDER, (_m, key) => {
      const v = subs[key];
      if (v === undefined || v === null || v === "") { dropped = true; return ""; }
      return String(v);
    });
    if (dropped) {
      // Drop the flag this placeholder belonged to, if one was just emitted.
      if (out.length && /^-/.test(out[out.length - 1])) out.pop();
      continue;
    }
    out.push(val);
  }
  return out;
}

/**
 * Child environment for a spawned provider CLI.
 * `base` is an explicit ALLOWLIST (never process.env — spreading it would leak host
 * secrets to the child; D-002). `child_env_unset` is
 * then applied on top as defence-in-depth: Claude Code refuses to nest while it sees
 * an inherited CLAUDECODE=1, and the strip keeps that true if the allowlist ever grows.
 */
/**
 * Flags whose OPERAND is a path the provider CLI must open. E-242 (D-066).
 *
 * Everything here is emitted PROJECT-RELATIVE by the adapter templates, which is correct
 * only when the CLI's cwd is the project root. It frequently is not: an rc-file `cd`, a
 * pre-existing tmux session or window, a pane opened in a subdirectory. The CLI then
 * reports "Settings file not found: .claude/settings.architect.json" for a file that
 * exists — the path is wrong, not the file.
 *
 * The rulefile is the more serious half and was failing the same way silently: without
 * ARCHITECT.md actually loading, a claude Architect pane boots the ENGINEER persona from
 * CLAUDE.md. That is gap G1, the very thing the same-provider Triad depends on, and a
 * missing file produces a wrong PERSONA rather than an error.
 */
export const PATH_OPERAND_FLAGS = new Set([
  "--settings",
  "--append-system-prompt-file",
]);

/**
 * Resolve project-relative path operands against the project root.
 *
 * Only the operand of a known path flag is touched, and only when it is relative — so a
 * prompt, a model name or a flag that merely looks path-like is never rewritten. Absolute
 * and `~`-anchored operands are left exactly as the author wrote them.
 *
 * @param {string[]} argv
 * @param {string} projectRoot absolute path to the project
 * @returns {string[]}
 */
export function absolutisePathOperands(argv, projectRoot) {
  if (!Array.isArray(argv) || !projectRoot) return Array.isArray(argv) ? argv : [];
  const out = [...argv];
  for (let i = 0; i < out.length - 1; i++) {
    if (!PATH_OPERAND_FLAGS.has(out[i])) continue;
    const operand = out[i + 1];
    if (typeof operand !== "string" || operand === "") continue;
    if (operand.startsWith("/") || operand.startsWith("~")) continue; // already anchored
    if (operand.startsWith("-")) continue;                            // a flag, not a path
    out[i + 1] = resolvePath(projectRoot, operand);
  }
  return out;
}

export function childEnv(base, adapter) {
  const env = { ...base };
  for (const k of adapter?.child_env_unset ?? []) delete env[k];
  return env;
}
