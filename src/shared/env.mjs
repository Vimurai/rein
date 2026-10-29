#!/usr/bin/env node
// env.mjs — the pre-rename env fallback (E-383, D-132 r4, rein-rename.md §Component 4).
// Node twin of `rein_legacy_env_apply` in locate.sh; the two state one rule.
//
// Every variable was AI_OS_<X> before the rename and is REIN_<X> now (AIOS_WORKSPACE is  (rename:legacy-fallback)
// REIN_WORKSPACE). For one release an old name still works: resolve() reads REIN_<X> and,
// only when that is UNSET, AI_OS_<X>. New wins, so an inherited old variable can never  (rename:legacy-fallback)
// override a new one (the security_engineer's condition in the blueprint).
//
// Never mapped: the names that carry a trust decision. *_TC_* pins the hook toolchain,
// *_LOCATE_* steers which file is executed, CALLER_ROLE / PANE_ROLE name the session's
// role. An old spelling of any of them is ignored rather than honoured — the hooks drop
// every AI_OS_* outright.  (rename:legacy-fallback)
//
//   node env.mjs --doctor   one `[LEGACY_ENV] AI_OS_X → REIN_X` line per old variable set  (rename:legacy-fallback)
//
// Removed in 0.5 (docs/upgrading.md).

const LEGACY_PREFIX = "AI_OS_"; // rename:legacy-fallback
const LEGACY_ALIASES = { AIOS_WORKSPACE: "REIN_WORKSPACE" }; // rename:legacy-fallback
const NEVER = /^REIN_(?:TC_.*|LOCATE_.*|CALLER_ROLE|PANE_ROLE)$/;

/** The REIN_ name an old variable maps to, or null when it is not mapped. */
export function newNameOf(old) {
  const name = LEGACY_ALIASES[old] ?? (old.startsWith(LEGACY_PREFIX) ? "REIN_" + old.slice(LEGACY_PREFIX.length) : null);
  return name && !NEVER.test(name) ? name : null;
}

function _oldNamesOf(name) {
  const out = Object.keys(LEGACY_ALIASES).filter((k) => LEGACY_ALIASES[k] === name);
  if (name.startsWith("REIN_")) out.push(LEGACY_PREFIX + name.slice("REIN_".length));
  return out;
}

/** resolve("REIN_X") → { value, legacy } — the new name first, the old only when it is unset. */
export function resolve(name, env = process.env) {
  if (env[name] !== undefined) return { value: env[name], legacy: false };
  if (NEVER.test(name)) return { value: undefined, legacy: false };
  for (const old of _oldNamesOf(name)) {
    if (env[old] !== undefined) return { value: env[old], legacy: true };
  }
  return { value: undefined, legacy: false };
}

/** Every old variable set in env, as [{ old, name, shadowed }] (shadowed: the new one is set too). */
export function legacyVars(env = process.env) {
  return Object.keys(env).sort()
    .map((old) => ({ old, name: newNameOf(old) }))
    .filter((v) => v.name)
    .map((v) => ({ ...v, shadowed: env[v.name] !== undefined }));
}

/** Copy each unshadowed old variable to its new name, in place. Returns the names set. */
export function applyLegacyEnv(env = process.env) {
  const set = [];
  for (const { old, name, shadowed } of legacyVars(env)) {
    if (shadowed) continue;
    env[name] = env[old];
    set.push(name);
  }
  return set;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv[2] === "--doctor") {
  for (const { old, name, shadowed } of legacyVars()) {
    process.stdout.write(`[LEGACY_ENV] ${old} → ${name}${shadowed ? " (ignored: the new name is set)" : ""} — rename it; the old name stops working in 0.5\n`);
  }
}
