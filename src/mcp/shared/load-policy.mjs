/**
 * load-policy.mjs — hot-reload the POLICY modules inside a long-running MCP server
 * (E-237, D-061 §5).
 *
 * WHY THIS EXISTS. An MCP server is spawned once and lives for the whole session, and ESM
 * caches a module by URL forever. So a policy edited on disk — or, more often, a mirror
 * refreshed by `rein sync` — never reaches the running server. Throughout the 2026-09-09
 * sprint `run_review` reported a P0 PATH_TRAVERSAL on
 * `source "${SCRIPT_DIR}/../lib/assert.sh"` while the on-disk `traversal-policy.mjs`,
 * byte-identical in `src` and the `~/.rein` mirror, graded that exact line P1 with
 * anchor=self_dir. Every review had to be adjudicated by hand against the real module.
 *
 * A gate that cries wolf is worse than one that is merely wrong: people learn to wave it
 * through, and the next finding — a real one — gets waved through with it.
 *
 * HOW. Re-import with a cache-busting query, but ONLY when the file's mtime has actually
 * changed. Busting on every call would re-parse the module on every request and leak a new
 * ESM record each time, since nothing can be evicted from the module registry.
 *
 * `mtimeMs` is sub-millisecond, deliberately. E-229 shipped a whole-second stamp that made
 * a self re-exec inert for a rewrite landing in the same second the process started —
 * which is precisely the `rein sync` case. Do not coarsen this.
 *
 * Rollback: REIN_POLICY_HOT_RELOAD=0 pins the first load for the process lifetime, which
 * is exactly the pre-E-237 behaviour.
 */
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The four modules that decide whether something is ALLOWED. They are the ones worth
 * reloading: a stale formatter is cosmetic, a stale policy is a wrong verdict.
 */
export const POLICY_PATHS = {
  "traversal-policy": resolve(HERE, "..", "..", "shared", "traversal-policy.mjs"),
  "markdown-exec": resolve(HERE, "..", "..", "shared", "markdown-exec.mjs"),
  "architect-writes": resolve(HERE, "..", "safe-exec-mcp", "architect-writes.mjs"),
  "caller-role": resolve(HERE, "caller-role.mjs"),
};

// name → { mtimeMs, mod }
const cache = new Map();
// Counts how many distinct module records this process has created, so a test can prove
// the registry stays bounded rather than growing per request.
const loadCounts = new Map();

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null; // unreadable — fall through to whatever is already cached
  }
}

/**
 * @param {string} name  a key of POLICY_PATHS
 * @returns {Promise<object>} the module namespace, re-imported if the file changed
 */
export async function loadPolicy(name) {
  const path = POLICY_PATHS[name];
  if (!path) throw new Error(`loadPolicy: unknown policy '${name}'`);

  const hot = process.env.REIN_POLICY_HOT_RELOAD !== "0";
  const hit = cache.get(name);

  if (!hot) {
    // Pinned: load once, then never look at the file again.
    if (hit) return hit.mod;
    const mod = await import(pathToFileURL(path).href);
    cache.set(name, { mtimeMs: null, mod });
    loadCounts.set(name, (loadCounts.get(name) ?? 0) + 1);
    return mod;
  }

  const now = mtimeOf(path);
  // Unchanged, or unreadable while something is already cached: keep what we have.
  if (hit && (now === null || now === hit.mtimeMs)) return hit.mod;

  // Changed (or first load). The query makes this a DISTINCT module URL, which is the only
  // way to get ESM to re-evaluate a file it has already seen.
  const url = `${pathToFileURL(path).href}?mtime=${now ?? 0}`;
  const mod = await import(url);
  cache.set(name, { mtimeMs: now, mod });
  loadCounts.set(name, (loadCounts.get(name) ?? 0) + 1);
  return mod;
}

/** How many times each policy has actually been imported. For tests and diagnostics. */
export function policyLoadCounts() {
  return Object.fromEntries(loadCounts);
}

/**
 * What this process currently has loaded, versus what is on disk. `rein sync` uses it to
 * tell the operator that a running server is serving an older policy than the mirror it
 * just refreshed — the situation that produced a session of phantom P0s.
 */
export function policyStaleness() {
  const out = [];
  for (const [name, path] of Object.entries(POLICY_PATHS)) {
    const disk = mtimeOf(path);
    const hit = cache.get(name);
    out.push({
      name,
      path,
      loadedMtimeMs: hit ? hit.mtimeMs : null,
      diskMtimeMs: disk,
      stale: Boolean(hit && hit.mtimeMs !== null && disk !== null && disk > hit.mtimeMs),
    });
  }
  return out;
}
