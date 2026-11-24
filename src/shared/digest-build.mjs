// digest-build.mjs — E-429 (D-159 r1-r2, r4, r6; .ai/blueprints/harness-fitness.md §Component 1).
//
// `.ai/DIGEST.md` is a generated view: a pure function of tracked inputs, rebuilt rather than
// remembered. This module is its ONLY writer.
//
// Inputs, fixed order, tracked files and git only (never LOG.md, SESSION.md, state.sqlite,
// telemetry or the wall clock — those differ per machine, and a digest built from them differs
// per clone): .ai/state.json, the `^## D-` headings of .ai/DECISIONS.md, .ai/BRIEF.md,
// package.json, the newest `v*` tag reachable from HEAD. `inputs` = first 12 hex of sha256 over
// exactly those bytes; it is how staleness is decided.
//
// No section needed an untracked input, so none was dropped. The header date is the newest
// task/stamp date: a DECISIONS.md heading carries no date, and the file's mtime is per-clone.
//
// CLI:  node digest-build.mjs build [dir]   → [DIGEST_BUILT] / [DIGEST_OK] inputs <hex>   exit 0
//                                              [DIGEST_BUILD_FAILED] <reason>              exit 1
//       node digest-build.mjs check [dir]   → [DIGEST_OK] exit 0 · [DIGEST_STALE] exit 1 · exit 2
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { isMainModule } from "../mcp/shared/is-main.mjs";
import { redact } from "./publish-scan.mjs";

export const MAX_LINES = 60;
const DIGEST = ".ai/DIGEST.md";
const DAY = 86_400_000;

class DigestError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const cut = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const day = (iso) => (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "");
const idNum = (id) => Number(String(id).replace(/^\D+-/, "")) || 0;
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const role = (owner) => (/^architect/i.test(String(owner ?? "")) ? "Architect" : /^engineer/i.test(String(owner ?? "")) ? "Engineer" : "Other");
const isOpen = (t) => t.status !== "DONE";

function readOptional(path) {
  try { return readFileSync(path); } catch (e) {
    if (e.code === "ENOENT") return Buffer.alloc(0);
    throw new DigestError(`cannot read ${path}: ${e.code || e.message}`, 2);
  }
}

function newestTag(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "tag", "--merged", "HEAD", "--list", "v*", "--sort=-v:refname"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    });
    return out.split("\n")[0].trim();
  } catch { return ""; } // not a git work tree, no HEAD, no git: no tag
}

/** Read the five inputs and their hash. Throws DigestError(code 2) when an input is unreadable. */
export function readInputs(projectDir) {
  const ai = join(projectDir, ".ai");
  const stateBytes = readOptional(join(ai, "state.json"));
  const decisions = readOptional(join(ai, "DECISIONS.md")).toString("utf8")
    .split("\n").filter((l) => l.startsWith("## D-")).map((l) => l.replace(/\r$/, ""));
  const briefBytes = readOptional(join(ai, "BRIEF.md"));
  const pkgBytes = readOptional(join(projectDir, "package.json"));
  const tag = newestTag(projectDir);

  let state = { tasks: [], stamps: [] };
  if (stateBytes.length) {
    try { state = JSON.parse(stateBytes.toString("utf8")); } catch { throw new DigestError(".ai/state.json is not valid JSON", 2); }
  }
  let pkg = {};
  if (pkgBytes.length) {
    try { pkg = JSON.parse(pkgBytes.toString("utf8")); } catch { throw new DigestError("package.json is not valid JSON", 2); }
  }

  const h = createHash("sha256");
  const part = (name, buf) => { h.update(`${name}\0${buf.length}\0`); h.update(buf); };
  part("state.json", stateBytes);
  part("decisions", Buffer.from(decisions.join("\n"), "utf8"));
  part("BRIEF.md", briefBytes);
  part("package.json", pkgBytes);
  part("tag", Buffer.from(tag, "utf8"));
  return {
    hash: h.digest("hex").slice(0, 12),
    tasks: Array.isArray(state.tasks) ? state.tasks.filter((t) => t && typeof t.id === "string") : [],
    stamps: Array.isArray(state.stamps) ? state.stamps.filter((s) => s && typeof s.type === "string") : [],
    decisions,
    brief: briefBytes.toString("utf8"),
    pkg,
    tag,
  };
}

function firstParagraph(md) {
  const out = [];
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const l = raw.trim();
    if (!l) { if (out.length) break; continue; }
    if (l.startsWith("#") || l.startsWith(">")) { if (out.length) break; continue; }
    out.push(l);
  }
  return cut(out.join(" "), 400);
}

/** Each section: { title, lines (fixed), items (trimmable list), more (label for trimmed) }. */
function sections(inp) {
  const { tasks, stamps } = inp;
  const dates = [
    ...tasks.flatMap((t) => [day(t.created_at), day(t.completed_at)]),
    ...stamps.map((s) => day(s.timestamp)),
  ].filter(Boolean).sort();
  const asOf = dates.length ? dates[dates.length - 1] : "";
  const asOfMs = asOf ? Date.parse(`${asOf}T00:00:00Z`) : NaN;

  const name = String(inp.pkg.name || "").replace(/^@[^/]+\//, "") || "project";
  const header = [
    `# DIGEST — ${name} (as of ${asOf || "no records"}) · inputs ${inp.hash}`,
    "Generated by rein digest build — do not hand-edit",
  ];

  const product = { title: "Product", lines: [firstParagraph(inp.brief) || "(no .ai/BRIEF.md)"] };

  const version = typeof inp.pkg.version === "string" ? inp.pkg.version : "";
  const rel = [`- Newest tag: ${inp.tag || "(none)"} · package version: ${version || "(none)"}`];
  if (inp.tag && version && inp.tag.replace(/^v/, "") !== version) rel.push(`- Note: tag ${inp.tag} and package version ${version} differ`);
  const release = { title: "Release", lines: rel };

  const count = (arr, key) => {
    const m = new Map();
    for (const x of arr) m.set(key(x), (m.get(key(x)) || 0) + 1);
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(" · ") || "none";
  };
  const open = tasks.filter(isOpen);
  const old = Number.isNaN(asOfMs) ? 0
    : open.filter((t) => day(t.created_at) && asOfMs - Date.parse(`${day(t.created_at)}T00:00:00Z`) > 30 * DAY).length;
  const queue = { title: "Queue", lines: [
    `- By status: ${count(tasks, (t) => String(t.status || "?"))}`,
    `- By owner: ${count(tasks, (t) => role(t.owner))}`,
    `- Open by tier: ${count(open, (t) => `T${t.tier ?? "?"}`)}`,
    `- Open more than 30 days: ${old}`,
  ] };

  const focusTask = (t) => `- ${t.id}${t.status === "OPEN" ? "" : ` [${t.status}]`}: ${cut(t.description, 110)}`;
  const active = (t) => t.status === "OPEN" || t.status === "IN_PROGRESS";
  const eng = tasks.filter((t) => active(t) && role(t.owner) === "Engineer")
    .sort((a, b) => idNum(a.id) - idNum(b.id) || byId(a, b)).slice(0, 5);
  const arch = tasks.filter((t) => active(t) && role(t.owner) === "Architect")
    .sort((a, b) => idNum(a.id) - idNum(b.id) || byId(a, b));
  const focus = { title: "Current focus", lines: eng.length || arch.length ? [] : ["- (no open tasks)"],
    items: [...eng, ...arch].map(focusTask), more: "open tasks" };

  // Review health: stamp families with a PASS or FAIL type, over the last 30 input days.
  const fam = (type) => { const m = /^(.+)_(PASS|FAIL)$/.exec(type); return m ? { f: m[1], v: m[2] } : null; };
  const inWindow = (s) => !Number.isNaN(asOfMs) && day(s.timestamp) && asOfMs - Date.parse(`${day(s.timestamp)}T00:00:00Z`) <= 30 * DAY;
  const tally = new Map();
  for (const s of stamps) {
    const k = fam(s.type);
    if (!k || !inWindow(s)) continue;
    const c = tally.get(k.f) || { PASS: 0, FAIL: 0 };
    c[k.v]++;
    tally.set(k.f, c);
  }
  const counts = [...tally.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([f, c]) => `${f} ${c.PASS}/${c.FAIL}`).join(" · ");
  const unresolved = [];
  stamps.forEach((s, i) => {
    const k = fam(s.type);
    if (!k || k.v !== "FAIL" || !s.task_id) return;
    const later = stamps.slice(i + 1).some((x) => x.task_id === s.task_id && fam(x.type)?.f === k.f && fam(x.type)?.v === "PASS");
    if (!later) unresolved.push(`- Unresolved ${s.type} on ${s.task_id} (${day(s.timestamp) || "?"}): ${cut(s.summary, 90)}`);
  });
  const review = { title: "Review health", lines: [`- PASS/FAIL, last 30 days: ${counts || "none"}`],
    items: unresolved, more: "unresolved FAILs" };

  const decisions = { title: "Key decisions", lines: inp.decisions.length ? [] : ["- (no decisions recorded)"],
    items: inp.decisions.slice(-8).map((l) => `- ${cut(l.replace(/^##\s*/, ""), 160)}`), more: "decisions" };

  const done = tasks.map((t, i) => ({ t, i })).filter(({ t }) => t.status === "DONE")
    .sort((a, b) => {
      const ca = String(a.t.completed_at || ""), cb = String(b.t.completed_at || "");
      return ca < cb ? -1 : ca > cb ? 1 : a.i - b.i;
    }).slice(-10).reverse();
  const recent = { title: "Recent changes", lines: done.length ? [] : ["- (nothing completed yet)"],
    items: done.map(({ t }) => `- ${t.id} (${day(t.completed_at) || "?"}): ${cut(t.summary || t.description, 110)}`), more: "completed tasks" };

  return { header, body: [product, release, queue, focus, review, decisions, recent] };
}

function render({ header, body }) {
  const lay = () => {
    const out = [...header];
    for (const s of body) {
      out.push("", `## ${s.title}`, ...s.lines, ...(s.items || []));
      if (s.dropped) out.push(`- … ${s.dropped} more ${s.more}`);
    }
    return out;
  };
  // Hold the 60-line ceiling: trim the longest list first, one item at a time, and say so.
  let lines = lay();
  while (lines.length > MAX_LINES) {
    const s = body.filter((x) => x.items && x.items.length > 1)
      .sort((a, b) => b.items.length - a.items.length)[0];
    if (!s) break;
    s.items = s.items.slice(0, -1);
    s.dropped = (s.dropped || 0) + 1;
    lines = lay();
  }
  return `${lines.slice(0, MAX_LINES).join("\n")}\n`;
}

/** Pure: the digest text and its inputs hash. Throws DigestError on unreadable inputs. */
export function buildDigest(projectDir) {
  const inputs = readInputs(projectDir);
  return { text: render(sections(inputs)), inputs: inputs.hash };
}

/** The target path, refused when it is a symlink or resolves outside the project. */
function target(projectDir) {
  const root = realpathSync(projectDir);
  let aiReal;
  try { aiReal = realpathSync(join(projectDir, ".ai")); } catch { throw new DigestError("no .ai/ directory — not a Rein project", 1); }
  const rel = relative(root, aiReal);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new DigestError(".ai/ resolves outside the project", 1);
  const path = join(aiReal, "DIGEST.md");
  try {
    if (lstatSync(path).isSymbolicLink()) throw new DigestError(`${DIGEST} is a symlink — refused`, 1);
  } catch (e) { if (e instanceof DigestError) throw e; }
  return { path, dir: aiReal };
}

const headerInputs = (text) => /· inputs ([0-9a-f]{12})\s*$/m.exec(String(text).split("\n")[0] || "")?.[1] || null;

/** Build and write. Returns { status: "BUILT"|"OK", inputs }. The file changes only when bytes differ. */
export function writeDigest(projectDir, { log } = {}) {
  const { path, dir } = target(projectDir);
  const built = buildDigest(projectDir);
  const text = redact(built.text, { file: DIGEST, aiDir: dir, ...(log ? { log } : {}) });
  let old = null;
  try { old = readFileSync(path, "utf8"); } catch { /* first build */ }
  if (old === text) return { status: "OK", inputs: built.inputs };
  const tmp = join(dir, `.DIGEST.md.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: "wx", mode: 0o644 });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* not created */ }
    throw new DigestError(`write failed: ${e.code || e.message}`, 1);
  }
  return { status: "BUILT", inputs: built.inputs };
}

/** Compare the file's header hash with the current inputs. { fresh, built, now }. */
export function checkDigest(projectDir) {
  const now = readInputs(projectDir).hash;
  let built = null;
  try { built = headerInputs(readFileSync(join(projectDir, DIGEST), "utf8")); } catch { /* absent */ }
  return { fresh: built === now, built, now };
}

if (isMainModule(import.meta.url)) {
  const [cmd, dirArg] = process.argv.slice(2);
  const dir = dirArg || process.cwd();
  try {
    if (cmd === "build") {
      const r = writeDigest(dir);
      console.log(`[DIGEST_${r.status === "OK" ? "OK" : "BUILT"}] inputs ${r.inputs}`);
    } else if (cmd === "check") {
      const r = checkDigest(dir);
      if (r.fresh) console.log(`[DIGEST_OK] inputs ${r.now}`);
      else { console.log(`[DIGEST_STALE] built from ${r.built || "none"}, inputs now ${r.now} — run: rein digest build`); process.exitCode = 1; }
    } else {
      console.error("usage: rein digest build | check");
      process.exitCode = 2;
    }
  } catch (e) {
    if (cmd === "check") { console.log(`[DIGEST_UNREADABLE] ${e.message}`); process.exitCode = 2; }
    else { console.log(`[DIGEST_BUILD_FAILED] ${e.message}`); process.exitCode = 1; }
  }
}
