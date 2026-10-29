/**
 * browser-check.mjs — fail FAST and CLEARLY when the Playwright browser is missing
 * (E-235, D-061 §3).
 *
 * WHY. `npx playwright install chromium` used to run inside the default install. It is an
 * unbounded network download of a ~150MB browser, and on 2026-09-09 it ran for over an
 * hour on a developer machine without finishing — inside `install-ai-os.sh`, which every
 * user install and every CI run depends on. The existing `|| true` around it gave no
 * protection at all: the failure mode is HANGING, not erroring, and you cannot `|| true`
 * your way out of a process that never returns.
 *
 * Taking the download out of the default path moves the failure to first USE. So first use
 * has to say something useful. Without this, `chromium.launch()` throws Playwright's own
 * multi-paragraph installation essay, or — worse, behind a proxy — sits there.
 *
 * The check is a cheap filesystem probe, not a launch: asking whether the executable
 * exists costs nothing, whereas discovering it by trying to launch is precisely the slow,
 * confusing path being removed.
 */
import { existsSync } from "node:fs";

export const BROWSER_MISSING = "[BROWSER_MISSING]";

/**
 * @param {object} chromium  the Playwright chromium namespace
 * @returns {{ ok: boolean, path: string|null, reason: string|null }}
 */
export function browserStatus(chromium) {
  // Rollback / escape hatch: an operator who has a browser somewhere unusual can say so
  // rather than being blocked by a probe that is only trying to be helpful.
  if (process.env.AI_OS_SKIP_BROWSER_CHECK === "1") {
    return { ok: true, path: null, reason: null };
  }
  let path = null;
  try {
    path = chromium?.executablePath?.() ?? null;
  } catch (err) {
    // Playwright throws here when the browser was never downloaded. That is an ANSWER,
    // not an error: it means "missing", and it is exactly what we want to report.
    return { ok: false, path: null, reason: String(err?.message ?? err).split("\n")[0] };
  }
  if (!path) return { ok: false, path: null, reason: "no executable path reported" };
  if (!existsSync(path)) return { ok: false, path, reason: "executable not present on disk" };
  return { ok: true, path, reason: null };
}

/**
 * The message a caller sees instead of a hang or a stack trace. It names the ONE command
 * that fixes it — a diagnostic that does not tell you what to run is only half a message.
 */
export function browserMissingMessage(status) {
  return [
    `${BROWSER_MISSING} Playwright's Chromium is not installed.`,
    "",
    "  run: ai mcp-setup --browsers",
    "",
    "Browsers are no longer downloaded during `ai install` (E-235 / D-061 §3): it is an",
    "unbounded ~150MB fetch that once ran for over an hour inside the installer, and every",
    "install and CI run sits behind that path.",
    status?.reason ? `\nDetail: ${status.reason}` : "",
    "\nRollback: AI_OS_INSTALL_BROWSERS=1 restores the download during install;",
    "AI_OS_SKIP_BROWSER_CHECK=1 bypasses this probe if the browser lives elsewhere.",
  ].join("\n");
}

/**
 * Throws a clear, actionable error when the browser is absent. Call this BEFORE
 * `chromium.launch()` in every tool that needs one.
 */
export function assertBrowserAvailable(chromium) {
  const status = browserStatus(chromium);
  if (status.ok) return status;
  const err = new Error(browserMissingMessage(status));
  err.code = "BROWSER_MISSING";
  throw err;
}
