// hosted-ci.mjs — `ai ci hosted [<provider>] [--check] [--force]` (E-335, D-103,
// team-collaboration.md §Component 5b).
//
// The hosted trunk check is a contract, not a pipeline: on a pull request into the trunk the
// provider runs exactly two commands — bootstrap Rein, then `ai ci run` on the merge result.
// One thin wrapper per provider is RENDERED from src/templates/ci/<template>; nobody edits it
// by hand, and `--check` fails when the file on disk is not the current rendering.
//
// The bootstrap is chosen at render time (D-103 r3): in the Rein repository itself it is
// `bash install-rein.sh` from the checked-out sha (the code under test); downstream it clones
// team.json.ci.rein_source at the tag the project pins (project.json rein_version) — a
// project's hosted check runs the Rein version its developers run.
//
// E-341 (D-105 r5): the trunk is trunk.mjs's resolveTrunk (team.json "trunk", else origin/HEAD,
// else main|master) rendered as {{TRUNK}}; for this repository that is master, so its
// .github/workflows/ci.yml renders byte-identical to before.
//
// Usage: node hosted-ci.mjs --root <dir> [<provider>] [--check] [--force]
//        node hosted-ci.mjs --root <dir> --doctor          (one doctor line)
// Exit: 0 written / current, 1 --check mismatch or refusal, 2 usage or unknown provider.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../mcp/shared/is-main.mjs";
import { readTeam, writeTeam, TeamError } from "../mcp/shared/team.mjs";
import { resolveTrunk } from "../mcp/shared/trunk.mjs";
import { redact } from "./publish-scan.mjs"; // E-379 (D-130)

const TEMPLATES = resolve(dirname(fileURLToPath(import.meta.url)), "../templates/ci");
export const DEFAULT_REIN_SOURCE = "https://github.com/Vimurai/rein.git";
export const SELF_BOOTSTRAP = "bash install-rein.sh";
export const REQUIRED_CHECK = "ai ci run";   // team.json ci.required_check: the legs' common name
// E-384 (D-135 r3, r5): the matrix. A shard count comes from team.json ci.shards (default 4);
// a project whose tests/run.sh has no --shard runs one leg. The public profile (.ai/publish.json
// — Rein itself) adds Node 24 and macOS; its nightly adds macOS × 24 and one unsharded leg.
export const DEFAULT_SHARDS = 4;
const PUBLIC_LEGS = [["ubuntu-latest", "22"], ["ubuntu-latest", "24"], ["macos-latest", "22"]];
const TEAM_LEGS = [["ubuntu-latest", "22"]];
const SHA = {
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1   # v7.0.1",
  setupNode: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1   # v7.1.0",
};

// D-103 r5: the check guards MERGES; pushes stay open to the team (claims ride on the trunk,
// and the pre-push gate keeps those pushes to .ai/**). One line per provider, printed after
// a render. `status: planned` providers render nothing; `unverified` ones render but say so on
// every run, until their wrapper has had a documented run on a real instance (D-103 r6).
export const PROVIDERS = {
  github: {
    status: "ready", template: "github.yml", path: ".github/workflows/ci.yml",
    policy: "GitHub → Settings → Branches → {{TRUNK}}: require the status checks listed below (every \"ai ci run\" leg, and \"fast\" when rendered); do NOT restrict pushes (or list the team as bypass actors) — claims push .ai/** to {{TRUNK}}.",
  },
  azure: {
    status: "unverified", template: "azure-pipelines.yml", path: "azure-pipelines.yml",
    policy: "Azure DevOps → Project settings → Repositories → {{TRUNK}} → Branch policies: Build Validation with this pipeline, Required (on Azure Repos the YAML pr: trigger is ignored — the policy IS the gate); grant the team group \"Bypass policies when pushing\" so claim commits (.ai/**) reach {{TRUNK}}; optional path filter !/.ai/*. Keep \"Limit job authorization scope to current project\" on.",
  },
  gitlab: { status: "planned", task: "E-337", path: ".gitlab-ci.yml" },
  bitbucket: { status: "planned", task: "E-337", path: "bitbucket-pipelines.yml" },
};

/** "public" when .ai/publish.json marks the public repository (the privacy gate's marker), else "team". */
export const profileFor = (root) => (existsSync(join(root, ".ai", "publish.json")) ? "public" : "team");

// What the project's own runner advertises, grepped as `ai ci run` greps `--tier` (D-135 §4).
function _runner(root) {
  try { return readFileSync(join(root, "tests", "run.sh"), "utf8"); } catch { return ""; }
}
/** { fast, shards } — the fast job when the runner has --tier, N shards when it has --shard. */
export function matrixFor(root, team) {
  const run = _runner(root);
  const shards = run.includes("--shard") ? (team?.ci?.shards ?? DEFAULT_SHARDS) : 1;
  return { fast: run.includes("--tier"), shards, profile: profileFor(root) };
}

/** Every check name the rendered wrapper reports on a pull request — what the branch policy requires. */
export function requiredChecks(root, team) {
  const m = matrixFor(root, team);
  const legs = m.profile === "public" ? PUBLIC_LEGS : TEAM_LEGS;
  const names = m.fast ? ["fast"] : [];
  for (const [os, node] of legs) {
    if (m.shards === 1) names.push(`${REQUIRED_CHECK} (${os}, node ${node})`);
    else for (let i = 1; i <= m.shards; i++) names.push(`${REQUIRED_CHECK} (${os}, node ${node}, ${i}/${m.shards})`);
  }
  return names;
}

function _matrixYaml(m) {
  const pub = m.profile === "public";
  const shards = Array.from({ length: m.shards }, (_, k) => `'${k + 1}/${m.shards}'`);
  const out = [
    `        os: [${pub ? "ubuntu-latest, macos-latest" : "ubuntu-latest"}]`,
    `        node: [${pub ? "'22', '24'" : "'22'"}]`,
  ];
  if (m.shards > 1) out.push(`        shard: [${shards.join(", ")}]`);
  if (pub) {
    // macOS × 24 runs only with full (nightly, release); full also adds one unsharded leg.
    out.push(`        exclude: \${{ fromJSON(inputs.full && '[]' || '[{"os":"macos-latest","node":"24"}]') }}`);
    if (m.shards > 1) out.push(`        include: \${{ fromJSON(inputs.full && '[{"os":"ubuntu-latest","node":"22","shard":""}]' || '[]') }}`);
  }
  return out.join("\n");
}

function _fastJob(m) {
  if (!m.fast) return "";
  return [
    "  # The first signal (D-135 addendum r1): the fast tier — the node unit layer and the",
    "  # contract tables — on the dependencies alone. No installer: suites beyond the fast tier",
    "  # need the installed mirror and run in the `ai ci run` legs.",
    "  fast:",
    "    name: fast",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 10",
    "    steps:",
    "      - name: Checkout",
    `        uses: ${SHA.checkout}`,
    "        with:",
    "          fetch-depth: 0",
    "          persist-credentials: false",
    "",
    "      - name: Set up Node.js",
    `        uses: ${SHA.setupNode}`,
    "        with:",
    "          node-version: '22'",
    "",
    "      - name: Dependencies",
    "        run: |",
    "          if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund; fi",
    "          for d in src/mcp/*/; do if [ -f \"${d}package.json\" ]; then npm install --prefix \"$d\" --ignore-scripts --no-audit --no-fund; fi; done",
    "",
    "      - name: Fast tier",
    "        run: bash tests/run.sh --tier fast",
    "",
    "",
  ].join("\n");
}

// Plain charsets: these values are written into YAML and a shell line.
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SOURCE_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~-]+)+$/;
// A git branch name may hold ] ' " # , — each breaks a YAML flow list or starts a comment.
const TRUNK_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;

/** The trunk to render, or throws HostedCiError (unresolved, or outside the plain charset). */
export function trunkFor(root, team) {
  const t = resolveTrunk(root, { team });
  if (!t.name) throw new HostedCiError("NO_TRUNK", t.message.replace(/^\[NO_TRUNK\] /, ""));
  if (!TRUNK_RE.test(t.name)) throw new HostedCiError("CI_TRUNK_INVALID", `trunk ${JSON.stringify(t.name).slice(0, 60)} (from ${t.source}) has characters a rendered wrapper cannot carry — use [A-Za-z0-9._/-]`);
  return t.name;
}

/** A provider's branch-policy line for <trunk>. */
export const policyFor = (provider, trunk) => PROVIDERS[provider].policy.replaceAll("{{TRUNK}}", () => trunk);

/** The host of a git remote URL (https://, ssh://, scp-like user@host:path), lowercased, or null. */
export function remoteHost(url) {
  const u = String(url || "").trim();
  let m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(u);
  if (!m) m = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)/.exec(u);
  return m ? m[1].toLowerCase() : null;
}

/** The provider for a remote host, or null when it is not a recognised cloud host (D-103 r4). */
export function detectProvider(url) {
  const h = remoteHost(url);
  if (!h) return null;
  if (h === "github.com" || h === "ssh.github.com") return "github";
  if (h === "dev.azure.com" || h === "ssh.dev.azure.com" || h === "vs-ssh.visualstudio.com" || h.endsWith(".visualstudio.com")) return "azure";
  if (h === "gitlab.com") return "gitlab";
  if (h === "bitbucket.org") return "bitbucket";
  return null;
}

/** Is <root> the Rein repository itself? Its installer at the root and its package name. */
export function isAiOsRepo(root) {
  if (!existsSync(join(root, "install-rein.sh"))) return false;
  try { return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name === "@vimurai/rein"; } catch { return false; }
}

/** The Rein version a project pins: project.json (team record store), else state.json. */
export function pinnedVersion(root) {
  for (const [file, pick] of [["project.json", (d) => d.rein_version], ["state.json", (d) => d.project?.rein_version]]) {
    try {
      const v = pick(JSON.parse(readFileSync(join(root, ".ai", file), "utf8")));
      if (v != null) return String(v);
    } catch { /* absent or unreadable: try the next */ }
  }
  return null;
}

/**
 * The bootstrap for <root>: { variant, command, note }. Throws HostedCiError when a downstream
 * project has no pinned version, or a pinned value / source falls outside the plain charset.
 */
export function bootstrapFor(root, { reinSource } = {}) {
  if (isAiOsRepo(root)) {
    return { variant: "self", command: SELF_BOOTSTRAP,
      note: "This IS the Rein repository: install from the checked-out commit — the code under test." };
  }
  const v = pinnedVersion(root);
  if (!v) throw new HostedCiError("CI_REIN_VERSION_UNKNOWN", "this project pins no Rein version (.ai/project.json or state.json rein_version) — run: ai init");
  if (!VERSION_RE.test(v)) throw new HostedCiError("CI_REIN_VERSION_UNKNOWN", `the pinned Rein version ${JSON.stringify(v).slice(0, 40)} is not X.Y.Z`);
  const src = reinSource || DEFAULT_REIN_SOURCE;
  if (!SOURCE_RE.test(src)) throw new HostedCiError("CI_SOURCE_INVALID", `rein_source ${JSON.stringify(src).slice(0, 80)} must be a plain https git URL`);
  const dir = '"${TMPDIR:-/tmp}/rein-src"';
  return {
    variant: "pinned",
    command: `git clone --quiet --depth 1 --branch v${v} ${src} ${dir} && bash ${dir}/install-rein.sh`,
    note: `Install the Rein version this project pins (v${v}) — the hosted check runs what its developers run.`,
  };
}

export class HostedCiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * The wrapper text for <provider> with a bootstrap from bootstrapFor(), a trunk from trunkFor()
 * and (github) a matrix from matrixFor() — default: one leg, no fast job, the team profile.
 */
export function render(provider, boot, trunk, matrix = { fast: false, shards: 1, profile: "team" }) {
  const p = PROVIDERS[provider];
  if (!renderable(provider)) throw new HostedCiError("CI_PROVIDER_PLANNED", `${provider} has no wrapper yet`);
  return readFileSync(join(TEMPLATES, p.template), "utf8")
    // Replacer functions: a string replacement reads $&, $' and $` specially (critic_security P3).
    .replaceAll("{{FAST_JOB}}", () => _fastJob(matrix))
    .replaceAll("{{MATRIX}}", () => _matrixYaml(matrix))
    .replaceAll("{{BOOTSTRAP_NOTE}}", () => boot.note)
    .replaceAll("{{BOOTSTRAP}}", () => boot.command)
    .replaceAll("{{TRUNK}}", () => trunk);
}

export const renderable = (provider) => ["ready", "unverified"].includes(PROVIDERS[provider]?.status);

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function originUrl(root) {
  try {
    return execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return ""; }
}
function gitEmailAt(root) {
  try { return execFileSync("git", ["-C", root, "config", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
}

/** Which provider: the argument, else team.json.ci.provider, else the origin host. */
function chooseProvider(root, arg, team) {
  if (arg) {
    if (!PROVIDERS[arg]) throw new HostedCiError("CI_PROVIDER_UNKNOWN", `unknown provider '${String(arg).slice(0, 30)}' — one of: ${Object.keys(PROVIDERS).join(", ")}`);
    return arg;
  }
  if (team?.ci?.provider) return team.ci.provider;
  const url = originUrl(root);
  const p = detectProvider(url);
  if (!p) throw new HostedCiError("CI_PROVIDER_UNKNOWN", `origin ${url ? `host '${remoteHost(url) || url}'` : "is not set"} is not a recognised cloud host — name the provider: ai ci hosted <${Object.keys(PROVIDERS).join("|")}>`);
  return p;
}

function writeAtomic(root, path, text) {
  mkdirSync(dirname(path), { recursive: true });
  // A tracked symlinked .github/ or workflows/ must not carry the write outside the repository.
  const r = realpathSync(root), d = realpathSync(dirname(path));
  if (d !== r && !d.startsWith(r + "/")) throw new HostedCiError("WRAPPER_OUTSIDE_REPO", `${dirname(path)} resolves outside the repository (${d})`);
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
  renameSync(tmp, path);
}

/** `ai ci hosted` → { code, out }. Never throws for an expected refusal. */
export function hosted(root, { provider: arg = "", check = false, force = false } = {}) {
  const lines = [];
  try {
    const team = readTeam(join(root, ".ai"));
    const provider = chooseProvider(root, arg, team);
    const p = PROVIDERS[provider];
    if (!renderable(provider)) {
      return { code: 1, out: `[CI_PROVIDER_PLANNED] ${provider} (${p.path}) ships with ${p.task}, after a documented run on a real ${provider} instance (D-103 r6).` };
    }
    const boot = bootstrapFor(root, { reinSource: team?.ci?.rein_source });
    const trunk = trunkFor(root, team);
    // E-379 (D-130): redacted before the comparison, so a redacted wrapper on disk is "current".
    const matrix = matrixFor(root, team);
    const want = redact(render(provider, boot, trunk, matrix), { file: p.path, aiDir: join(root, ".ai") });
    const dest = join(root, p.path);
    const have = existsSync(dest) ? readFileSync(dest, "utf8") : null;
    const current = have !== null && sha256(have) === sha256(want);
    if (check) {
      if (current) return { code: 0, out: `✓ ${p.path} is the current ${provider} rendering (${boot.variant} bootstrap)` };
      return { code: 1, out: have === null
        ? `✗ ${p.path} is missing — run: ai ci hosted ${provider}`
        : `✗ ${p.path} differs from the current ${provider} rendering — run: ai ci hosted ${provider} --force` };
    }
    if (have !== null && !current && !force) {
      return { code: 1, out: `[WRAPPER_DIFFERS] ${p.path} is not the current rendering — review it, then: ai ci hosted ${provider} --force` };
    }
    if (!current) writeAtomic(root, dest, want);
    lines.push(`✓ ${p.path} ${current ? "already current" : "written"} (${provider}, ${boot.variant} bootstrap) — commit it`);
    if (team) {
      const me = gitEmailAt(root);
      const ci = { provider, required_check: REQUIRED_CHECK, ...(team.ci?.rein_source ? { rein_source: team.ci.rein_source } : {}) };
      if (JSON.stringify(team.ci) === JSON.stringify(ci)) {
        // already recorded
      } else if (team.planner !== me) {
        lines.push(`[NOT_PLANNER] ${me || "(no git email)"} is not the planner (${team.planner}) — .ai/team.json ci not written; the planner records it.`);
      } else {
        writeTeam(join(root, ".ai"), { ...team, ci });
        lines.push(`✓ .ai/team.json ci = ${provider} — commit it (bookkeeping, rides on ${trunk})`);
      }
    }
    lines.push(`Branch policy (D-103 r5): ${policyFor(provider, trunk)}`);
    if (provider === "github") lines.push(`Required checks (D-135 r7, ${matrix.profile} profile): ${requiredChecks(root, team).map((n) => `"${n}"`).join(", ")}`);
    if (p.status === "unverified") {
      lines.push(`[CI_PROVIDER_UNVERIFIED] the ${provider} wrapper has not had a documented run on a real ${provider} instance yet (D-103 r6) — run it once and report the pipeline URL; see .ai/DEVOPS.md DEVOPS-011.`);
    }
    return { code: 0, out: lines.join("\n") };
  } catch (e) {
    if (e instanceof HostedCiError) return { code: e.code === "CI_PROVIDER_UNKNOWN" ? 2 : 1, out: `[${e.code}] ${e.message}` };
    if (e instanceof TeamError) return { code: 1, out: `✗ [${e.code}] ${e.message}` };
    throw e;
  }
}

/** One `ai doctor` line. A project with no wrapper and no team.json.ci has nothing to report wrong. */
export function doctorLine(root) {
  let team = null;
  try { team = readTeam(join(root, ".ai")); } catch (e) { return `  ✗ hosted check: ${e.message}`; }
  const configured = team?.ci?.provider || Object.entries(PROVIDERS).find(([, p]) => existsSync(join(root, p.path)))?.[0];
  if (!configured) return "  - hosted check: none (optional — ai ci hosted)";
  const r = hosted(root, { provider: configured, check: true });
  const origin = detectProvider(originUrl(root));
  const warn = origin && origin !== configured ? ` (origin is ${origin}, team.json.ci says ${configured})` : "";
  return r.code === 0 ? `  ✓ hosted check: ${configured} — ${r.out.replace(/^✓ /, "")}${warn}` : `  ✗ hosted check: ${configured} — ${r.out.replace(/^✗ /, "")}${warn}`;
}

function main(argv) {
  let root = null, provider = "", check = false, force = false, doctor = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") root = argv[++i];
    else if (a === "--check") check = true;
    else if (a === "--force") force = true;
    else if (a === "--doctor") doctor = true;
    else if (!a.startsWith("-") && !provider) provider = a;
    else { process.stderr.write(`ai ci hosted: unknown argument '${a}'\n`); return 2; }
  }
  if (!root) { process.stderr.write("ai ci hosted: --root is required\n"); return 2; }
  if (doctor) { process.stdout.write(doctorLine(root) + "\n"); return 0; }
  const r = hosted(root, { provider, check, force });
  process.stdout.write(r.out + "\n");
  return r.code;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
