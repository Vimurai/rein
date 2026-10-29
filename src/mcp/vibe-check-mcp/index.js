#!/usr/bin/env node
/**
 * vibe-check-mcp — AI-OS MCP Server
 * Exposes Playwright-powered visual audit, chaos testing, and performance metrics.
 *
 * Tools:
 *   run_vibe_audit(url, routes?)       → screenshots + CLS + contrast audit
 *   run_chaos_test(url, interactions?) → rapid-click + form stress + race detection
 *   get_performance_metrics(url)       → LCP, CLS, TTFB via CDP session
 *
 * Install: npm install (in this directory)
 * Run:     node index.js (stdio transport — registered in .mcp.json)
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { instrument } from "../../shared/mcp-telemetry.mjs";
import { chromium } from "@playwright/test";
// E-235 (D-061 §3): browsers are no longer downloaded during install, so the FIRST USE has
// to explain itself. Without this, a missing browser surfaces as Playwright's multi-
// paragraph installation essay — or, behind a proxy, as a hang.
import { assertBrowserAvailable } from "./browser-check.mjs";
import { createLogger } from "../shared/logger.js";

// ── Structured logger (obs_baseline §Logging) ────────────────────────────────
const logger = createLogger("vibe-check-mcp");

const server = new Server(
  { name: "vibe-check-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "run_vibe_audit",
      description:
        "Captures screenshots, calculates Cumulative Layout Shift (CLS), and audits color contrast/accessibility for a URL. Returns a structured Vibe Report.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Base URL to audit (e.g. http://localhost:3000)",
          },
          routes: {
            type: "array",
            items: { type: "string" },
            description: "Additional routes to audit (e.g. [\"/dashboard\", \"/login\"])",
            default: ["/"],
          },
          timeout_ms: {
            type: "number",
            description: "Navigation timeout in milliseconds (default: 15000). Increase for slow local servers or heavy SPAs.",
            default: 15000,
          },
        },
        required: ["url"],
      },
    },
    {
      name: "run_chaos_test",
      description:
        "Simulates rapid, random user interactions (rapid-clicks, form stress, navigation) to find race conditions or state-management crashes.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to chaos test",
          },
          interactions: {
            type: "number",
            description: "Number of rapid interactions to simulate (default: 20)",
            default: 20,
          },
          timeout_ms: {
            type: "number",
            description: "Navigation timeout in milliseconds (default: 15000). Increase for slow local servers or heavy SPAs.",
            default: 15000,
          },
        },
        required: ["url"],
      },
    },
    {
      name: "get_performance_metrics",
      description:
        "Returns Core Web Vitals: LCP (Largest Contentful Paint), CLS (Cumulative Layout Shift), and TTFB (Time to First Byte) via Playwright CDP session.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to measure",
          },
          timeout_ms: {
            type: "number",
            description: "Navigation timeout in milliseconds (default: 15000). Increase for slow local servers.",
            default: 15000,
          },
        },
        required: ["url"],
      },
    },
  ],
}));

// ── Tool implementations ──────────────────────────────────────────────────────

instrument(server, "vibe-check-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "run_vibe_audit":
      return await runVibeAudit(args.url, args.routes ?? ["/"], args.timeout_ms ?? 15000);

    case "run_chaos_test":
      return await runChaosTest(args.url, args.interactions ?? 20, args.timeout_ms ?? 15000);

    case "get_performance_metrics":
      return await getPerformanceMetrics(args.url, args.timeout_ms ?? 15000);

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// ── run_vibe_audit ────────────────────────────────────────────────────────────

async function runVibeAudit(baseUrl, routes, timeoutMs) {
  assertBrowserAvailable(chromium);   // E-235: clear [BROWSER_MISSING], never a hang
  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (const route of routes) {
      const url = `${baseUrl}${route}`;
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      try {
        try {
          const page = await context.newPage();

          // Inject CLS observer before navigation
          await page.addInitScript(() => {
            window.__clsScore = 0;
            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                if (!entry.hadRecentInput) window.__clsScore += entry.value;
              }
            }).observe({ type: "layout-shift", buffered: true });
          });

          await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });

          // CLS score
          const cls = await page.evaluate(() => window.__clsScore ?? 0);
          const clsStatus = cls < 0.1 ? "PASS" : cls < 0.25 ? "WARN" : "FAIL";

          // Contrast check — sample viewport-visible text elements (P-19)
          const contrastIssues = await page.evaluate(() => {
            const issues = [];
            const vh = window.innerHeight;
            const elements = Array.from(document.querySelectorAll(
              "p, h1, h2, h3, h4, h5, h6, span, a, button, label"
            )).filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.top < vh && r.bottom > 0;
            }).slice(0, 100);
            for (const el of elements) {
              const style = window.getComputedStyle(el);
              const fg = style.color;
              const bg = style.backgroundColor;
              // Basic luminance check (simplified — full WCAG requires exact parsing)
              if (fg === bg || (bg === "rgba(0, 0, 0, 0)" && fg === "rgba(0, 0, 0, 0)")) {
                issues.push(`Invisible text on: ${el.tagName} "${el.textContent?.slice(0, 30)}"`);
              }
            }
            return issues.slice(0, 5);
          });

          // Touch targets — viewport-visible interactive elements (P-19)
          const smallTargets = await page.evaluate(() => {
            const vh = window.innerHeight;
            const interactive = Array.from(document.querySelectorAll("button, a, input, select"))
              .filter(el => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.top < vh && r.bottom > 0;
              }).slice(0, 100);
            const small = [];
            for (const el of interactive) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44)) {
                small.push(`${el.tagName}[${el.textContent?.slice(0, 20) || el.type || ""}] ${Math.round(rect.width)}x${Math.round(rect.height)}px`);
              }
            }
            return small.slice(0, 5);
          });

          // Focus ring check — viewport-visible focusable elements (P-19)
          const focusIssues = await page.evaluate(() => {
            const vh = window.innerHeight;
            const focusable = Array.from(document.querySelectorAll("button, a, input, select, textarea"))
              .filter(el => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.top < vh && r.bottom > 0;
              }).slice(0, 100);
            const issues = [];
            for (const el of focusable) {
              const style = window.getComputedStyle(el, ":focus");
              const outline = style.outline || style.outlineStyle;
              if (outline === "none" || outline === "0px") {
                issues.push(`No focus ring: ${el.tagName}[${el.textContent?.slice(0, 20) || el.type}]`);
              }
            }
            return issues.slice(0, 5);
          });

          results.push({
            route,
            url,
            cls: { score: cls.toFixed(4), status: clsStatus },
            contrast: {
              status: contrastIssues.length === 0 ? "PASS" : "WARN",
              issues: contrastIssues,
            },
            touchTargets: {
              status: smallTargets.length === 0 ? "PASS" : "WARN",
              violations: smallTargets,
            },
            focusRings: {
              status: focusIssues.length === 0 ? "PASS" : "FAIL",
              violations: focusIssues,
            },
          });
        } catch (routeErr) {
          // P-39: isolate single-route failures — record FAULT and continue
          results.push({ route, url, fault: true, error: routeErr.message });
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const hasP0 = results.some(
    (r) =>
      r.fault ||
      r.cls?.status === "FAIL" ||
      r.focusRings?.status === "FAIL"
  );

  const report = formatVibeReport(results, hasP0);
  return { content: [{ type: "text", text: report }] };
}

function formatVibeReport(results, hasP0) {
  const date = new Date().toISOString().split("T")[0];
  const score = Math.max(0, 10 - results.reduce((acc, r) => {
    if (r.fault) return acc + 3;
    if (r.cls?.status === "FAIL") acc += 3;
    else if (r.cls?.status === "WARN") acc += 1;
    if (r.focusRings?.status === "FAIL") acc += 2;
    if (r.contrast?.issues?.length > 0) acc += 1;
    if (r.touchTargets?.violations?.length > 0) acc += 1;
    return acc;
  }, 0));

  let out = `[VIBE_REPORT] ${date} | Score: ${score}/10${hasP0 ? " | [VIBE_BLOCKED]" : ""}\n\n`;

  for (const r of results) {
    out += `## Route: ${r.route}\n`;
    if (r.fault) {
      out += `- Status: FAULT — ${r.error}\n\n`;
      continue;
    }
    out += `- CLS: ${r.cls.score} — ${r.cls.status}\n`;
    out += `- Contrast: ${r.contrast.status}${r.contrast.issues.length ? "\n  " + r.contrast.issues.join("\n  ") : ""}\n`;
    out += `- Touch targets: ${r.touchTargets.status}${r.touchTargets.violations.length ? "\n  " + r.touchTargets.violations.join("\n  ") : ""}\n`;
    out += `- Focus rings: ${r.focusRings.status}${r.focusRings.violations.length ? "\n  " + r.focusRings.violations.join("\n  ") : ""}\n\n`;
  }

  if (hasP0) {
    out += `## ⚠ P0 Issues Found — [VIBE_BLOCKED]\n`;
    out += `Tag: append [VIBE_BLOCKED] ${date} to .ai/LOG.md\n`;
  } else {
    out += `## ✓ No P0 Issues — Vibe Cleared\n`;
    out += `Tag: append [VIBE_REPORT] ${date} | Score: ${score}/10 to .ai/REVIEWS.md\n`;
  }

  return out;
}

// ── run_chaos_test ────────────────────────────────────────────────────────────

async function runChaosTest(url, interactions, timeoutMs) {
  assertBrowserAvailable(chromium);   // E-235: clear [BROWSER_MISSING], never a hang
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const errors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`JS error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`Page error: ${err.message}`));

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });

    // Rapid-click stress on primary CTA
    const primaryCta = await page.$("button[type='submit'], button.primary, button:first-of-type");
    const rapidClickErrors = [];
    if (primaryCta) {
      const clickCount = Math.min(interactions, 20);
      const initialErrors = errors.length;
      for (let i = 0; i < clickCount; i++) {
        await primaryCta.click({ force: true }).catch(() => {});
        await page.waitForTimeout(50);
      }
      if (errors.length > initialErrors) {
        rapidClickErrors.push(`${errors.length - initialErrors} errors after ${clickCount} rapid clicks`);
      }
    }

    // Empty form submission
    const form = await page.$("form");
    const formErrors = [];
    if (form) {
      await form.evaluate((f) => {
        const inputs = f.querySelectorAll("input:not([type='hidden']), textarea");
        inputs.forEach((i) => { i.value = ""; });
      });
      const submitBtn = await form.$("button[type='submit'], input[type='submit']");
      if (submitBtn) {
        const errorsBefore = errors.length;
        await submitBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);
        if (errors.length > errorsBefore) formErrors.push("JS errors on empty form submit");
      }
    }

    // Back/forward navigation stress
    const navErrors = [];
    for (let i = 0; i < 3; i++) {
      await page.goBack().catch(() => {});
      await page.goForward().catch(() => {});
    }
    if (errors.filter((e) => e.includes("navigation")).length > 0) {
      navErrors.push("Errors during rapid back/forward navigation");
    }

    const date = new Date().toISOString().split("T")[0];
    const allIssues = [...rapidClickErrors, ...formErrors, ...navErrors, ...errors.slice(0, 5)];
    const severity = allIssues.length === 0 ? "PASS" : allIssues.length < 3 ? "P1" : "P0";

    const report = [
      `[CHAOS_REPORT] ${date} | Severity: ${severity}`,
      ``,
      `## Chaos Test Results`,
      `- Rapid-click (${Math.min(interactions, 20)}×): ${rapidClickErrors.length === 0 ? "PASS" : "FAIL — " + rapidClickErrors.join("; ")}`,
      `- Empty form submit: ${formErrors.length === 0 ? "PASS" : "FAIL — " + formErrors.join("; ")}`,
      `- Back/forward stress: ${navErrors.length === 0 ? "PASS" : "FAIL — " + navErrors.join("; ")}`,
      `- JS console errors: ${errors.length === 0 ? "None" : errors.slice(0, 5).join("; ")}`,
      ``,
      severity === "PASS"
        ? `## ✓ [CHAOS_CLEARED] — No P0 issues found\nTag: append [CHAOS_CLEARED] ${date} to .ai/LOG.md`
        : `## ⚠ [CHAOS_BLOCKED] — P0/P1 issues found\nFix issues above before Tier 3 release.\nTag: append [CHAOS_BLOCKED] ${date} | ${severity} to .ai/LOG.md`,
    ].join("\n");

    return { content: [{ type: "text", text: report }] };
  } finally {
    await context.close();
    await browser.close();
  }
}

// ── get_performance_metrics ───────────────────────────────────────────────────

async function getPerformanceMetrics(url, timeoutMs) {
  assertBrowserAvailable(chromium);   // E-235: clear [BROWSER_MISSING], never a hang
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  let client = null;

  try {
    // Enable CDP for performance metrics
    client = await context.newCDPSession(page);
    await client.send("Performance.enable");

    // Inject Web Vitals observers
    await page.addInitScript(() => {
      window.__webVitals = { lcp: 0, cls: 0 };
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) window.__webVitals.lcp = last.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__webVitals.cls += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });

    const navStart = Date.now();
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    const ttfb = Date.now() - navStart;

    // Allow Vitals to settle
    await page.waitForTimeout(1000);

    const vitals = await page.evaluate(() => window.__webVitals);
    const perfMetrics = await client.send("Performance.getMetrics");
    const metricsMap = Object.fromEntries(
      perfMetrics.metrics.map((m) => [m.name, m.value])
    );

    const lcp = Math.round(vitals.lcp);
    const cls = vitals.cls.toFixed(4);
    const ttfbMs = ttfb;

    const lcpStatus = lcp < 2500 ? "PASS" : lcp < 4000 ? "WARN" : "FAIL";
    const clsStatus = parseFloat(cls) < 0.1 ? "PASS" : parseFloat(cls) < 0.25 ? "WARN" : "FAIL";
    const ttfbStatus = ttfbMs < 800 ? "PASS" : ttfbMs < 1800 ? "WARN" : "FAIL";

    const report = [
      `## Performance Metrics — ${url}`,
      `Measured: ${new Date().toISOString()}`,
      ``,
      `| Metric | Value       | Target       | Status     |`,
      `|--------|-------------|--------------|------------|`,
      `| LCP    | ${lcp}ms    | < 2500ms     | ${lcpStatus}    |`,
      `| CLS    | ${cls}      | < 0.1        | ${clsStatus}    |`,
      `| TTFB   | ${ttfbMs}ms | < 800ms      | ${ttfbStatus}    |`,
      ``,
      `### CDP Metrics (selected)`,
      `- ScriptDuration: ${(metricsMap.ScriptDuration ?? 0).toFixed(3)}s`,
      `- TaskDuration: ${(metricsMap.TaskDuration ?? 0).toFixed(3)}s`,
      `- JSHeapUsedSize: ${Math.round((metricsMap.JSHeapUsedSize ?? 0) / 1024 / 1024)}MB`,
    ].join("\n");

    return { content: [{ type: "text", text: report }] };
  } finally {
    if (client) await client.detach().catch(() => {});
    await context.close();
    await browser.close();
  }
}

// ── Start server ──────────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
