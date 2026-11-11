// release-layout.mjs — the layout of a Rein release artifact, schema 1 (E-418; D-153 r2,
// D-153 addendum r2, D-155 r2; .ai/blueprints/release-artifact.md §Data Model).
//
// What is shipped, what an installer must never delete, and the operator_owned matcher an
// installer applies to a path that is NOT in the manifest's `files`. node: modules only.

// The ten directories an install mirrors (install-rein.sh: _REIN_TREES plus scripts and hooks).
export const MIRRORED = Object.freeze([
  "bin", "hooks", "mcp", "shared", "claude", "contracts", "templates", "copilot", "scripts", "config",
]);

// Paths under the Rein home an installer leaves alone when no shipped file names them.
// Literal, trailing "/" (a directory and everything under it), "*" within one segment,
// "**" across segments. Adding an entry is compatible; removing one is a layout change.
export const OPERATOR_OWNED = Object.freeze([
  "accounts.json", "gate-override.json", "secrets/", "run/", "memory/", "incidents.ndjson",
  "telemetry.sqlite", "INSIGHTS.md", "memory-palace.md", "config/rein-workspace.txt",
  "config/install-stamp.json", "shared/toolchain.sh", "mcp/*/node_modules/", "mcp/*/package-lock.json",
]);

// Written by the install on the installing host; a stage that carries one is refused.
export const INSTALL_GENERATED = Object.freeze([
  "config/rein-workspace.txt", "config/install-stamp.json", "shared/toolchain.sh",
]);

const _compiled = new Map();
function compile(pattern) {
  let re = _compiled.get(pattern);
  if (re) return re;
  const dir = pattern.endsWith("/");
  const body = (dir ? pattern.slice(0, -1) : pattern)
    .split("**")
    .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  re = new RegExp(`^${body}${dir ? "(?:/.*)?" : ""}$`);
  _compiled.set(pattern, re);
  return re;
}

/** True when `path` (relative to the Rein home, "/"-separated) matches one of `patterns`. */
export function operatorOwned(path, patterns = OPERATOR_OWNED) {
  return patterns.some((p) => compile(p).test(path));
}

/**
 * What an installer does with an existing path under the Rein home: a shipped path is written
 * ("replaced") even when a pattern also matches it (rule 3, a shipped path wins); an unshipped
 * path matching operator_owned is "kept"; an unshipped path inside a mirrored directory that
 * matches no pattern is "deleted"; a path outside the mirrored directories is never written or
 * deleted (rule 1, D-155 addendum 3 r10) — manifest.json and VERSION are written, not listed.
 */
export function installerAction(path, shipped, patterns = OPERATOR_OWNED) {
  if (shipped) return "replaced";
  if (operatorOwned(path, patterns)) return "kept";
  return MIRRORED.includes(path.split("/")[0]) ? "deleted" : "kept";
}
