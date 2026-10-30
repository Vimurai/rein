// publish-scan.mjs — what must never leave in a published tree (E-364, D-117, licensing.md
// §Component 8). One scanner for the four classes the public mirror refuses, shared by E-362's
// pre-publication audit (`ai release --scan`) and E-360's export, so the two cannot drift:
//
//   personal_email   an address outside the reserved example/test domains and the allow list
//   home_path        /home/<user>, /Users/<user> or ~<user> for a user that is not a neutral placeholder
//   session_socket   a session id (UUID) or a per-user socket path (/run/user/<n>/, /tmp/tmux-<n>/)
//   client_name      a downstream client's project name
//   operator_name    the operator's real name or address, in any form they list (E-372, D-123/D-124)
//
// The client and operator names are this operator's knowledge, so they live in the gitignored
// .ai/publish-scan.local.json ({"client_names": [...], "operator_names": [...], "allow": {...},
// "allow_emails": [...]}) — committing the lists would publish the very names they guard. Without that file a scan of a tree FAILS CLOSED
// with [SCAN_LIST_MISSING] (E-365, D-118 r5): a missing list must not read as "no client names".
// A finding is data for the caller to classify (E-362) or refuse on (E-360); this module only
// reports.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMainModule } from "../mcp/shared/is-main.mjs";
import { containsCredentialToken, containsSecret } from "../mcp/safe-exec-mcp/secret-rule.mjs";

export const CLASSES = ["personal_email", "home_path", "session_socket", "client_name", "operator_name"];

// D-124 r1/r2: the only files that may carry an operator value, and only a value the local
// `allow` block names for that file. Anything else of the operator's refuses everywhere.
export const ALLOWABLE_FILES = ["LICENSE", "NOTICE", "SECURITY.md", "package.json", "README.md"];

// RFC 2606 / 6761 reserved names never route to a person.
const RESERVED_EMAIL = /@(?:[a-z0-9-]+\.)*(?:example|test|invalid|localhost)(?:\.[a-z]+)?$|@example\.(?:com|org|net)$/i;
const DEFAULT_ALLOW_EMAILS = ["noreply@anthropic.com"];
// GitHub's noreply addresses exist to be published (the D-124 r3 commit identity).
const NOREPLY_EMAIL = /@users\.noreply\.github\.com$/i;
const PLACEHOLDER_USERS = new Set(["dev", "user", "runner", "me", "you", "someone", "example", "x", "linuxbrew", "username", "root", "login"]);

// E-365 (D-118 r5, audit O1): files whose address, path and id findings are reviewed and kept,
// each with its reason. Client names are checked in them all the same.
export const EXEMPT_FILES = {
  "tests/unit/publish-scan.test.mjs": "the scanner's own positive cases — every address, path and id in it is invented (E-362 E5-E6, H7, U2-U3)",
};

// The §Component 8 include list as amended by D-118 r3 and D-123 (NOTICE in, legal/ gone;
// DECISIONS.md and the superseded licensing.md never ship) — what the public mirror receives.
const EXPORT_INCLUDE = [
  /^src\//, /^hooks\//, /^tests\//, /^scripts\//, /^\.claude\//, /^docs\//, /^\.ai\/blueprints\/(?!licensing\.md$)/,
  /^(install-rein\.sh|package\.json|package-lock\.json|\.gitignore|LICENSE|NOTICE|CHANGELOG\.md|CONTRIBUTING\.md|SECURITY\.md|CODE_OF_CONDUCT\.md)$/, /^README[^/]*$/,
  /^\.ai\/(architect\.md|BRIEF\.md|RULES\.md|SECURITY\.md|THREAT_MODEL\.md|roles\.json|providers\.json)$/,
];
export const isExported = (path) => EXPORT_INCLUDE.some((re) => re.test(path));

/** The tracked files the mirror would receive (git ls-files ∩ the include list). */
export function exportFiles(root) {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter((f) => f && isExported(f));
}

// Bounded and anchored by a lookbehind: linear on long input (E-379 security P2-1; the old
// unbounded form was quadratic, 23 s on 200 KB, and now runs on every write path).
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,63}/g;
const HOME_RE = /\/(?:home|Users)\/([A-Za-z_][A-Za-z0-9_.-]*)/g;
// `~login` used as a shell path (audit H4): a lowercase login after whitespace, a quote, `=` or
// `:`, then a path `/`, a quote, `*` or the line's end. Prose (`~all expected`, `~M tokens`,
// `(~sum`) and arithmetic (`~chars/4`) are not a login; `~/`, `~+` and `~-` have none.
const TILDE_RE = /(?:^|[\s"'`=:])~([A-Za-z_][a-z0-9_-]*)(?=\/(?!\d)|["'`*]|$)/g;   // `~Login` yes, camelCase `~minMs` no
// …and any `~login` operand of a shell verb, whatever follows it (critic_security P2, E-365).
const TILDE_VERB_RE = /\b(?:cd|ls|rm|cp|mv|cat|chmod|chown|find|tar|rsync|scp)\b(?:\s+-[A-Za-z-]+)*\s+~([A-Za-z_][A-Za-z0-9_-]*)/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SOCKET_RE = /\/run\/user\/\d+\/[^\s"'`]*|\/tmp\/tmux-\d+\/[^\s"'`]*/g;

const _esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The operator's local scan config. Absent → throws [SCAN_LIST_MISSING] (fail closed). */
export function loadScanConfig(aiDir) {
  const p = join(aiDir, "publish-scan.local.json");
  if (!existsSync(p)) {
    throw new Error(`[SCAN_LIST_MISSING] ${p} is missing — write {"client_names": [...]} there (gitignored); a scan without it cannot check client names`);
  }
  let j;
  // A parse error can quote the file — which holds the operator's values — so it is not echoed.
  try { j = JSON.parse(readFileSync(p, "utf8")); } catch { throw new Error(`[SCAN_CONFIG_UNREADABLE] ${p} is not valid JSON`); }
  const clientNames = [].concat(j.client_names || []).filter((n) => typeof n === "string" && n.trim());
  // An empty list is the same hole as a missing one (critic_security P2, E-365).
  if (!clientNames.length) throw new Error(`[SCAN_LIST_MISSING] ${p} names no client — client_names must list at least one name`);
  const operatorNames = [].concat(j.operator_names || []).filter((n) => typeof n === "string" && n.trim());
  if (!operatorNames.length) throw new Error(`[SCAN_LIST_MISSING] ${p} names no operator value — operator_names must list the real name and addresses`);
  return { clientNames, operatorNames, allow: checkAllow(j.allow, operatorNames, p), allowEmails: [].concat(j.allow_emails || []) };
}

/**
 * The `allow` block as a Map(lowercased value → Set(files)). Fails closed: a value that is not
 * in operator_names, or a file outside ALLOWABLE_FILES, throws [SCAN_ALLOW_BAD] — an allow-list
 * can narrow D-124, never widen it.
 */
export function checkAllow(allow = {}, operatorNames = [], where = "allow") {
  const known = new Set(operatorNames.map((n) => n.toLowerCase()));
  const out = new Map();
  if (allow === null || typeof allow !== "object" || Array.isArray(allow)) throw new Error(`[SCAN_ALLOW_BAD] ${where}: allow must be {"<value>": [files]}`);
  for (const [value, files] of Object.entries(allow)) {
    if (!known.has(value.toLowerCase())) throw new Error(`[SCAN_ALLOW_BAD] ${where}: an allowed value is not in operator_names`);
    if (!Array.isArray(files) || files.some((f) => !ALLOWABLE_FILES.includes(f))) {
      throw new Error(`[SCAN_ALLOW_BAD] ${where}: allowed files must be among ${ALLOWABLE_FILES.join(", ")}`);
    }
    out.set(value.toLowerCase(), new Set(files));
  }
  return out;
}

/** Findings in one text: [{ class, match, line }] (1-based lines), in reading order. */
export function scanText(text, { clientNames = [], operatorNames = [], allowEmails = [] } = {}) {
  const allow = new Set([...DEFAULT_ALLOW_EMAILS, ...allowEmails].map((e) => e.toLowerCase()));
  const clientRes = clientNames.filter(Boolean).map((n) => new RegExp(`\\b${_esc(n)}\\b`, "i"));
  // Bounded by anything that is not a letter or digit (Unicode-aware, so "Quillić" works):
  // `name@` and `<name>` still match; a longer word containing the value does not.
  // A space in a listed name matches any run of whitespace (NBSP included, \s covers it) and a
  // hyphen matches the non-breaking hyphen too (critic_security P2, E-379).
  const _loose = (n) => _esc(n.normalize("NFC")).replace(/\s+/g, "\\s+").replace(/\\?-/g, "[-\\u2011]");
  const operatorRes = operatorNames.filter(Boolean).map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${_loose(n)}(?![\\p{L}\\p{N}])`, "giu"));
  const out = [];
  String(text).split("\n").forEach((l, i) => {
    const line = i + 1;
    for (const m of l.matchAll(EMAIL_RE)) {
      // SSH-remote and URL userinfo is not mail: `git@host:owner/repo` (a `:` followed at once by a
      // path, never `: ` as in prose) and `scheme://<user>@host/…` (the userinfo directly after
      // `://`). critic_security P1 (E-365): a bare `:`, `/` or `//` let real prose addresses through.
      const after = l.slice(m.index + m[0].length), before = l.slice(0, m.index);
      const userinfo = /^:[^\s:]/.test(after) || /[a-z][a-z0-9+.-]*:\/\/[^\s/@]*$/i.test(before);
      if (!userinfo && !RESERVED_EMAIL.test(m[0]) && !NOREPLY_EMAIL.test(m[0]) && !allow.has(m[0].toLowerCase())) out.push({ class: "personal_email", match: m[0], line });
    }
    const homes = new Set();
    for (const re of [HOME_RE, TILDE_RE, TILDE_VERB_RE]) {
      for (const m of l.matchAll(re)) {
        const user = m[1].toLowerCase(), key = `${m.index + m[0].indexOf(m[1])}`;
        if (PLACEHOLDER_USERS.has(user) || /^</.test(m[1]) || homes.has(key)) continue;
        homes.add(key);
        out.push({ class: "home_path", match: m[0].trim(), line });
      }
    }
    for (const m of l.matchAll(UUID_RE)) {
      // A placeholder repeats one character per group (00000000-0000-…, 11111111-2222-…).
      const placeholder = m[0].split("-").every((g) => new Set(g.toLowerCase()).size === 1);
      if (!placeholder) out.push({ class: "session_socket", match: m[0], line });
    }
    for (const m of l.matchAll(SOCKET_RE)) out.push({ class: "session_socket", match: m[0], line });
    // Format characters (zero-width space, joiners, bidi marks) cannot split a name past the scan.
    const nfc = l.normalize("NFC").replace(/\p{Cf}/gu, "");
    for (const re of clientRes) {
      const m = nfc.match(re);
      if (m) out.push({ class: "client_name", match: m[0], line });
    }
    for (const re of operatorRes) for (const m of nfc.matchAll(re)) out.push({ class: "operator_name", match: m[0], line });
  });
  return out;
}

/**
 * Findings over files (paths relative to root): [{ file, class, match, line }]. Without an
 * explicit `clientNames`, the root's .ai/publish-scan.local.json is loaded — and its absence
 * throws [SCAN_LIST_MISSING]. EXEMPT_FILES are skipped.
 */
export function scanFiles(root, files, opts = {}) {
  if (opts.clientNames === undefined) opts = { ...opts, ...loadScanConfig(join(root, ".ai")) };
  const allow = opts.allow instanceof Map ? opts.allow : checkAllow(opts.allow, opts.operatorNames);
  // D-124: an allowed value in its allowed file is no finding — whichever class caught it.
  const allowed = (f, hit) => (hit.class === "operator_name" || hit.class === "personal_email") && !!allow.get(hit.match.toLowerCase())?.has(f);
  const out = [];
  for (const f of files) {
    let text;
    try { text = opts.read ? opts.read(f) : readFileSync(join(root, f), "utf8"); } catch { continue; }
    if (typeof text !== "string" || text.includes("\u0000")) continue;   // gone, or binary
    // An exempt file is still checked for client and operator names: its exemption covers its
    // invented addresses, paths and ids only (critic_security P2, E-365; E-372).
    const exempt = Object.hasOwn(EXEMPT_FILES, f);
    for (const hit of scanText(text, opts)) {
      if (allowed(f, hit)) continue;
      if (!exempt || hit.class === "client_name" || hit.class === "operator_name") out.push({ file: f, ...hit });
    }
  }
  return out;
}

// ── E-372 (D-123 §Component 3): what the export must satisfy beyond file content ──

const REGISTRY = "https://registry.npmjs.org/";
const TEMPLATE_RE = /(^|\/)\.claude\/settings[^/]*\.json$|(^|\/)\.?mcp(\.[^/]*)?\.json$/;
// `.env.example` is the committed template the DevOps contract asks for (src/contracts/40_DEVOPS.md:
// every key present, values empty) — not an environment file.
const FORBIDDEN_RE = /(^|\/)\.git(\/|$)|(^|\/)\.env(?!\.example$)[^/]*$|\.local\.json$/i;

/**
 * Tree findings over an export (paths relative to root): [{ file, class, match }].
 *   forbidden_file   a .git/ entry, an .env* file or a *.local.json
 *   lockfile_url     a package-lock.json `resolved` URL outside https://registry.npmjs.org/ (a
 *                    workspace link to a relative path inside the tree is not a download)
 *   absolute_path    a string in a .claude/settings*.json or .mcp.json template that is an
 *                    absolute path (/…, C:\…) — a template must resolve on any machine
 */
export function treeProblems(root, files) {
  const out = [];
  for (const f of files) {
    if (FORBIDDEN_RE.test(f)) { out.push({ file: f, class: "forbidden_file", match: f }); continue; }
    const lock = /(^|\/)package-lock\.json$/.test(f), tpl = TEMPLATE_RE.test(f);
    if (!lock && !tpl) continue;
    let j;
    try { j = JSON.parse(readFileSync(join(root, f), "utf8")); } catch (e) { out.push({ file: f, class: lock ? "lockfile_url" : "absolute_path", match: `unparseable: ${e.message}` }); continue; }
    if (lock) {
      for (const [name, pkg] of Object.entries(j.packages || {})) {
        // A workspace link (`"link": true`) resolves to a relative path inside the tree itself.
        const workspace = pkg?.link === true && typeof pkg.resolved === "string" && !/^[a-z][a-z0-9+.-]*:|^\/|(^|\/)\.\.(\/|$)/i.test(pkg.resolved);
        if (pkg && typeof pkg.resolved === "string" && !workspace && !pkg.resolved.startsWith(REGISTRY)) out.push({ file: f, class: "lockfile_url", match: `${name}: ${pkg.resolved}` });
      }
    } else {
      const walk = (v) => {
        if (typeof v === "string") { if (/^\/|^[A-Za-z]:[\\/]/.test(v)) out.push({ file: f, class: "absolute_path", match: v }); }
        else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
      };
      walk(j);
    }
  }
  return out;
}

/** [PUBLISH_IDENTITY]: the export commit's author and committer must both be the public identity. */
export function identityProblem({ author, committer }, identity) {
  const want = `${identity.name} <${identity.email}>`;
  for (const [role, got] of [["author", author], ["committer", committer]]) {
    if (got !== want) return `[PUBLISH_IDENTITY] the export commit's ${role} is not the public identity in .ai/publish.json`;
  }
  return null;
}

/** The `rein doctor` line: [PUBLISH_SCAN_OK] classes=5 lists=client:N,operator:N, or the missing line. */
export function doctorLine(aiDir) {
  try {
    const c = loadScanConfig(aiDir);
    return `[PUBLISH_SCAN_OK] classes=${CLASSES.length} lists=client:${c.clientNames.length},operator:${c.operatorNames.length}`;
  } catch (e) {
    return String(e.message).replace(/ — .*/, "");
  }
}

// ── E-379 (D-130 §Component 10): privacy by construction for automated writers ──
//
// Every automated writer into a project's tracked .ai/ or .claude/ passes its text through
// redact() before it lands: a finding of any scan class, or a credential (the D-080 detector,
// secret-rule.mjs), becomes `[redacted:<class>]` and one `[PRIVACY_REDACTED] <class> <file>`
// line goes to stderr. It never refuses — a writer must not fail because a summary quoted a
// path; the pre-commit hook and CI refuse what slips through. Without the operator's list the
// structural classes (address, home path, session id, socket, secret) still apply. There is no
// switch to turn it off: a project's .claude/settings.json env reaches every hook and MCP server,
// so an env switch is the project's switch (E-291's rule; security P1-3). What lives under the install directory (telemetry,
// incidents, insights, the memory palace) stays on the operator's machine and is not redacted.

/** The writers that call redact(); `rein doctor` counts them. */
export const REDACT_WRITERS = [
  "task description and summary (record-store insertTask/updateTask)", "stamp summary (record-store insertStamp)",
  "handover delta (run-handover)", "log line (team appendLog)", "repository map (ast-parser generate_map)",
  "CI evidence (ci-evidence writeCiRecord)", "hosted CI wrapper (hosted-ci)", "proposed skill (instinct-stager)",
  "digest line (stop hook)", "project focus and verdict (record-store setProject)",
  "advisor ruling (advisor-mcp logRuling)", "rein clean entry (rein-clean logApply)",
];

const _lists = new Map();   // aiDir → { mtime, lists }
/** The operator's lists for redaction, or empty lists (structural classes only) — never throws. */
export function redactLists(aiDir) {
  if (!aiDir) return { clientNames: [], operatorNames: [] };
  const p = join(aiDir, "publish-scan.local.json");
  let mtime = -1;
  try { mtime = statSync(p).mtimeMs; } catch { /* absent: structural only */ }
  const hit = _lists.get(aiDir);
  if (hit && hit.mtime === mtime) return hit.lists;
  let lists = { clientNames: [], operatorNames: [] };
  if (mtime >= 0) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      const strs = (v) => [].concat(v || []).filter((n) => typeof n === "string" && n.trim());
      lists = { clientNames: strs(j.client_names), operatorNames: strs(j.operator_names), allowEmails: strs(j.allow_emails) };
    } catch { /* unreadable: structural only; rein doctor reports it */ }
  }
  _lists.set(aiDir, { mtime, lists });
  return lists;
}

const _counterFile = (home) => join(home, ".rein", "privacy", `redacted-${new Date().toISOString().slice(0, 10)}.count`);
function _count(n) {
  try {
    const f = _counterFile(homedir());
    mkdirSync(join(f, ".."), { recursive: true });
    let k = 0;
    try { k = Number(readFileSync(f, "utf8")) || 0; } catch { /* first today */ }
    writeFileSync(f, String(k + n));
  } catch { /* a counter must never break a writer */ }
}

/** Today's redaction count (`rein doctor`). */
export function redactedToday(home = homedir()) {
  try { return Number(readFileSync(_counterFile(home), "utf8")) || 0; } catch { return 0; }
}

/**
 * Redact `text` for a write into `file` (a label for the log line). `lists` defaults to
 * redactLists(aiDir). Returns the redacted string; a non-string passes through unchanged.
 * `count: false` — a writer under the install directory (incidents, memory signatures): no
 * log line and no doctor count, which are about the tracked tree.
 */
export function redact(text, { file = "?", aiDir = null, lists = null, count = true, log = (l) => process.stderr.write(`${l}\n`) } = {}) {
  if (typeof text !== "string" || !text) return text;
  const l = lists || redactLists(aiDir);
  const seen = new Set();
  let n = 0;
  const mark = (cls) => { seen.add(cls); n++; return `[redacted:${cls}]`; };
  // 0. Normalise once (NFC, no format characters), so a name split by a zero-width space or
  //    spelled in NFD is both found and replaced; the output is the normalised text.
  let out = text.normalize("NFC").replace(/\p{Cf}/gu, "");
  // 1. Credentials, line by line: the offending token when one token carries it, else the line.
  //    `\_` renders as `_` in Markdown, so the check sees it unescaped.
  const secret = (s) => containsSecret(s) || containsSecret(s.replace(/\\_/g, "_"));
  out = out.split("\n").map((line) => {
    if (!secret(line)) return line;
    let hit = false;
    const fixed = line.replace(/\S+/g, (tok) => (secret(tok) ? ((hit = true), mark("secret")) : tok));
    return hit && !secret(fixed) ? fixed : mark("secret");
  }).join("\n");
  // 2. The five scan classes, longest match first so a full name goes before its surname.
  const found = [...new Map(scanText(out, l).map((h) => [`${h.class}\0${h.match}`, h])).values()]
    .sort((a, b) => b.match.length - a.match.length);
  for (const h of found) {
    const re = new RegExp(_esc(h.match), h.class === "operator_name" || h.class === "client_name" ? "giu" : "g");
    out = out.replace(re, () => mark(h.class));
  }
  if (n && count) {
    for (const cls of seen) log(`[PRIVACY_REDACTED] ${cls} ${file}`);
    _count(n);
  }
  return out;
}

// CLI: `redact <file-label> [root]` filters stdin to stdout for the bash writers (the stop hook).
if (isMainModule(import.meta.url) && process.argv[2] === "redact") {
  const root = process.argv[4] || process.cwd();
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { buf += c; });
  process.stdin.on("end", () => process.stdout.write(redact(buf, { file: process.argv[3] || "?", aiDir: join(root, ".ai") })));
}

if (isMainModule(import.meta.url) && process.argv[2] === "privacy") {
  console.log(`[PRIVACY_OK] writers=${REDACT_WRITERS.length} redacted_today=${redactedToday()}`);
}
// ── E-378 (D-129 §Component 9): the public repository's commit and CI gates ──
// They apply where .ai/publish.json exists — the public repository; a private working clone has
// none. With the operator's list (their machine) every class is checked and the commit identity
// must be the public one; without it (a contributor, CI) the structural classes are.

/** The public repository's .ai/publish.json, or null. `read` (a staged or committed copy) is tried
 *  after the working tree, so deleting the file from the work tree does not turn the gate off. */
export function publishConfig(root, ...reads) {
  try { return JSON.parse(readFileSync(join(root, ".ai", "publish.json"), "utf8")); } catch { /* try the index, then HEAD */ }
  for (const read of reads) {
    try { if (read) return JSON.parse(blobText(read(".ai/publish.json"))); } catch { /* next */ }
  }
  return null;
}

// ── What the gates read beyond plain UTF-8 (security_engineer, E-378 P1-7 and P2-9) ──
/** A blob as text: UTF-16 with a BOM, or with every other byte NUL, is decoded; any other binary
 *  yields its printable runs (6+ characters), so a value inside a binary is still seen. */
export function blobText(buf) {
  if (typeof buf === "string") return buf;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  if (buf.length >= 4 && buf.length % 2 === 0) {
    let odd = 0;
    for (let i = 1; i < Math.min(buf.length, 512); i += 2) if (buf[i] === 0) odd++;
    if (odd >= Math.min(buf.length, 512) / 2 - 1) return buf.toString("utf16le");
  }
  const t = buf.toString("utf8");
  if (!t.includes("\u0000")) return t;
  return (buf.toString("latin1").match(/[\x20-\x7e]{6,}/g) || []).join("\n");
}
const HTML_NAMED = { amp: "&", lt: "<", gt: ">", quot: '"' };
/** Common encodings undone, so an escaped value is matched too: JSON \uXXXX, percent, HTML entities. */
export function decodedView(text) {
  let d = text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  d = d.replace(/%([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  // HTML entities in ONE pass: chained replaces decoded `&amp;lt;` (and `&#38;lt;`) twice, to `<`
  // (E-397, CodeQL js/double-escaping). The \u and % layers above still decode into entities.
  d = d.replace(/&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot));/g, (_m, h, n, name) =>
    h ? String.fromCodePoint(parseInt(h, 16)) : n ? String.fromCodePoint(Number(n)) : HTML_NAMED[name]);
  return d.normalize("NFKC");
}
const FAKE_TOKEN_MARK = "privacy:allow-fake-token";
/** The gates' sixth class: a vendor-format token or a private key (secret-rule.mjs, high precision).
 *  tests/fixtures/ carries fake tokens by design; elsewhere a fake is marked on its line or within the
 *  three above (a bash statement's continuation lines and a heredoc's opening line cannot carry it). */
function _secretHits(file, text) {
  if (file.startsWith("tests/fixtures/")) return [];
  const lines = text.split("\n");
  return lines.flatMap((l, i) => (containsCredentialToken(l) && !lines.slice(Math.max(0, i - 3), i + 1).some((x) => x.includes(FAKE_TOKEN_MARK)))
    ? [{ file, class: "secret", line: i + 1 }] : []);
}
/** One gate pass over files: the classes on the text, on its decoded view, on the path; secrets. */
function _gateScan(root, files, lists, read) {
  const texts = new Map();
  const get = (f) => { if (!texts.has(f)) { let t = null; try { t = blobText(read(f)); } catch { /* gone */ } texts.set(f, t); } return texts.get(f); };
  const seen = new Set(), out = [];
  const add = (h) => { const k = `${h.class} ${h.file}:${h.line}`; if (!seen.has(k)) { seen.add(k); out.push(k); } };
  for (const h of scanFiles(root, files, { ...lists, read: get })) add(h);
  for (const h of scanFiles(root, files, { ...lists, read: (f) => { const t = get(f); return t == null ? t : decodedView(t); } })) add(h);
  for (const f of files) {
    for (const h of scanText(f, lists)) add({ file: f, class: h.class, line: "path" });
    const t = get(f);
    if (t != null) for (const h of _secretHits(f, t)) add(h);
  }
  return out.map((k) => `[PUBLISH_SCAN_HIT] ${k}`);
}

/** The lists for a gate: the operator's (fail closed when present but invalid), else structural only. */
function _gateLists(root, read) {
  const lists = existsSync(join(root, ".ai", "publish-scan.local.json"))
    ? { ...loadScanConfig(join(root, ".ai")), operator: true }
    : { clientNames: [], operatorNames: [], allow: {}, operator: false };
  // D-124 r2: the project contact is public in the root package.json author, and allowed in the
  // contact files only. Read from there, so the public CI (which never has the operator's list)
  // knows the one address it may see — and no file gains a copy of it.
  const allow = lists.allow instanceof Map ? new Map([...lists.allow].map(([k, v]) => [k, new Set(v)])) : checkAllow(lists.allow, lists.operatorNames);
  const contact = contactAddress(read);
  if (contact) {
    const files = allow.get(contact) || new Set();
    for (const f of CONTACT_FILES) files.add(f);
    allow.set(contact, files);
  }
  return { ...lists, allow };
}

const CONTACT_FILES = ["SECURITY.md", "package.json", "README.md"];
/** The address in the root package.json author ("Name <address>"), lowercased, or null. */
export function contactAddress(read) {
  try { return (/<([^<>\s]+@[^<>\s]+)>\s*$/.exec(JSON.parse(blobText(read("package.json"))).author || "") || [])[1]?.toLowerCase() || null; }
  catch { return null; }
}

/**
 * The commit gate: [problem lines] for the staged `files` (read through `read`), and — on the
 * operator's machine — the author and committer against publish.json's public identity. A line
 * names the class and file:line, never the matched value.
 */
export function precommitProblems(root, { files, read, readHead = null, author, committer, deleted = [] }) {
  // The deletion is refused BEFORE the marker is looked up: deleting it is how the gate would be
  // turned off (critic_security E-378). A private clone never has the file, so nothing misfires.
  const out = deleted.includes(".ai/publish.json") ? ["[PUBLISH_GATE] .ai/publish.json marks the public repository and cannot be deleted"] : [];
  const cfg = publishConfig(root, read, readHead);
  if (!cfg) return out;
  const lists = _gateLists(root, (f) => { try { return read(f); } catch { return readFileSync(join(root, f)); } });
  if (lists.operator) {
    const p = cfg.author ? identityProblem({ author, committer }, cfg.author) : "[PUBLISH_IDENTITY] .ai/publish.json names no author";
    if (p) out.push(p);
  }
  for (const f of files.filter((x) => FORBIDDEN_RE.test(x))) out.push(`[PUBLISH_SCAN_HIT] forbidden_file ${f}`);
  out.push(..._gateScan(root, files.filter((x) => !FORBIDDEN_RE.test(x)), lists, read));
  return out;
}

/** The CI gate: [problem lines] for every tracked file (read through `read`), plus the tree
 *  checks; the tree must carry .ai/publish.json. */
export function treeGateProblems(root, files, read = (f) => readFileSync(join(root, f))) {
  const lists = _gateLists(root, read);
  return [
    ...(files.includes(".ai/publish.json") ? [] : ["[PUBLISH_GATE] .ai/publish.json is missing — the public repository carries it"]),
    ..._gateScan(root, files, lists, read),
    ...treeProblems(root, files).map((t) => `[PUBLISH_SCAN_HIT] ${t.class} ${t.file}`),
  ];
}

const _git = (root, ...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const _blob = (root, spec) => execFileSync("git", ["-C", root, "cat-file", "-p", spec], { maxBuffer: 64 * 1024 * 1024 });
const _ident = (s) => String(s).replace(/\s+\d+\s+[+-]\d{4}\s*$/, "").trim();   // "Name <mail> 1700000000 +0100" → "Name <mail>"

// CLI: `precommit [root]` (the pre-commit hook) and `scan-tree [root]` (the public CI job).
if (isMainModule(import.meta.url) && (process.argv[2] === "precommit" || process.argv[2] === "scan-tree")) {
  const root = process.argv[3] || process.cwd();
  let problems, _gateFiles = 0;
  try {
    if (process.argv[2] === "precommit") {
      const files = _git(root, "diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRT").split("\0").filter(Boolean);
      const deleted = _git(root, "diff", "--cached", "--name-only", "-z", "--diff-filter=D").split("\0").filter(Boolean);
      problems = precommitProblems(root, {
        files, deleted, read: (f) => _blob(root, `:${f}`), readHead: (f) => _blob(root, `HEAD:${f}`),
        author: _ident(_git(root, "var", "GIT_AUTHOR_IDENT")), committer: _ident(_git(root, "var", "GIT_COMMITTER_IDENT")),
      });
      _gateFiles = files.length;
    } else {
      const files = _git(root, "ls-files", "-z").split("\0").filter(Boolean);
      problems = treeGateProblems(root, files, (f) => _blob(root, `:${f}`));
      _gateFiles = files.length;
    }
  } catch (e) {
    problems = [`[PUBLISH_GATE] ${String(e.message).split("\n")[0].replace(/ — .*/, "")}`];   // fail closed
  }
  for (const p of problems) console.error(p);
  if (problems.length) {
    console.error(`[COMMIT_BLOCKED] privacy gate: ${problems.length} finding(s) — remove them (values are never printed; the file:line says where)`);
    process.exit(1);
  }
  // The hook and the CI job require this line: a helper that ran nothing must not read as clean.
  console.log(`[PRIVACY_GATE_OK] files=${_gateFiles}`);
}
if (isMainModule(import.meta.url) && process.argv[2] === "doctor") {
  console.log(doctorLine(join(process.argv[3] || process.cwd(), ".ai")));
}
// An unknown subcommand is an error, never a silent success (security_engineer E-378 P0-3).
if (isMainModule(import.meta.url) && !["redact", "privacy", "doctor", "precommit", "scan-tree"].includes(process.argv[2])) {
  console.error(`publish-scan: unknown subcommand ${JSON.stringify(String(process.argv[2] ?? "")).slice(0, 40)} — redact | privacy | doctor | precommit | scan-tree`);
  process.exit(2);
}
