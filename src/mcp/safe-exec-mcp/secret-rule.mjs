// secret-rule.mjs — E-287 (D-078, sovereignty-hardening.md §Secret Rule Precision).
//
// SECRET_IN_COMMAND used to fire on a KEYWORD followed by any four characters, so prose
// matched: a heredoc naming "token usage", a commit message titled "Secret Rule
// Precision". On 2026-09-29 it blocked the Engineer three times and one block cost a
// COMM.md handoff entry. The rule now needs a keyword in ASSIGNMENT or FLAG form AND a
// value that looks like a credential — or a value whose prefix alone says it is one.
//
// Tiers (security_engineer threat model, E-287):
//   1. Known-prefix tokens (ghp_, sk-, AKIA…, a three-part JWT) block ANYWHERE, keyword
//      or not — the keyword was never the signal. Each prefix carries its own boundary
//      and minimum length so `desk-sk-refactor`, `sk-learn` and a bare "AKIA" in prose
//      stay clean.
//   2. KEY=value / KEY: value / --key value / --key=value / `Authorization: Bearer|token|
//      Basic value`, where the value is ≥16 chars with ≥3 character classes, or ≥20 chars
//      of a hex/base64 alphabet with a digit (a 32-hex API token is only 2 classes).
//   3. Password-type keys (pass, passwd, password, pwd) in assignment form block at ≥8
//      chars with ≥2 classes. DIVERGENCE from the blueprint's value-shape rule, recorded
//      for the Architect: without it the historical true positive
//      `export password=supersecret123` (14 chars, 2 classes) would pass, and the
//      blueprint's own contract says every historical true positive stays BLOCK.
//   4. URL userinfo (`scheme://user:pass@host`) and `curl -u user:pass` with a literal
//      password of ≥8 chars.
// A value starting with $VAR, ${, $(, <placeholder>, ***, xxxx or ... is a REFERENCE and
// passes. The caller scans normalizeForSecretScan(raw), so quote-splitting (gh""p_…) and
// backslash escapes are already collapsed before any tier runs.
//
// ReDoS budget (100 ms on arbitrarily long heredocs): every quantifier is bounded, there
// are no nested quantifiers, and class counting is done in JS, not with lookaheads. Input
// above SCAN_LIMIT is refused outright (fail closed) rather than scanned partially.
// STATED RESIDUAL: `mysql -pPASS` (the -p flag is too overloaded to match), a low-entropy
// secret under a non-password key, and secrets a command reads from a file.

export const SCAN_LIMIT = 256 * 1024;

const PREFIX_TOKEN = new RegExp(
  "(?<![A-Za-z0-9_-])(?:" +
    [
      "sk-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{16,256}",
      "gh[pousr]_[A-Za-z0-9]{20,255}",
      "github_pat_[A-Za-z0-9_]{20,255}",
      "xox[abpr]-[A-Za-z0-9-]{10,255}",
      "(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])",
      "eyJ[A-Za-z0-9_-]{8,2048}\\.eyJ[A-Za-z0-9_-]{8,2048}\\.[A-Za-z0-9_-]{0,2048}",
      "npm_[A-Za-z0-9]{20,255}",
      "glpat-[A-Za-z0-9_-]{20,255}",
      "[sr]k_live_[A-Za-z0-9]{16,255}",
      "hf_[A-Za-z0-9]{30,255}",
    ].join("|") +
    ")"
);

// A credential-named key. The bounded lazy prefix lets API_KEY, GITHUB_TOKEN,
// AWS_SECRET_ACCESS_KEY and _authToken match; the key must END in the keyword, so
// PASSWORD_MIN_LENGTH, max_tokens and --token-budget do not.
const KW =
  "[A-Za-z0-9_-]{0,40}?(pass(?:word|wd)?|pwd|secret|api[_-]?key|apikey|access[_-]?key|" +
  "private[_-]?key|token|auth|credentials?|client[_-]?secret)";
// `}` ends a value (JSON), except the one closing a leading ${VAR} — otherwise
// `TOKEN=${X}Real…` was cut to `${X` and its literal tail never scored.
const VAL = "((?:\\$\\{[^}\\s]{1,64}\\})?[^\\s\"',;}]{0,512})";

const ASSIGN = new RegExp(
  // KEY=value, KEY: value, --key=value, JSON "key": "value" (quotes already stripped)
  `(?:^|[\\s;&|("'{,/:])-{0,2}${KW}\\s*([=:])\\s*${VAL}` +
    // --key value
    `|(?:^|\\s)--${KW}\\s+${VAL}` +
    // Authorization header
    `|Authorization:\\s*(?:Bearer|token|Basic)\\s+${VAL}`,
  "gi"
);

// E-355 (D-114, licensing.md §Security): the licence signing key never passes through a shell.
// Absolute: a private key's PEM header (whitespace- and case-tolerant) or the fixed prefix of an
// Ed25519 PKCS8 key (base64 or hex). Per command segment: naming the signing key
// (license-sign…, any spelling a glob could complete) or anything under ~/.rein/secrets —
// except a segment that only searches or records text (grep/rg, git commit/log/show/grep/diff)
// and, for the directory, ls/stat. A speed bump, not the boundary: the 0600 file and not
// running agents as the vendor on the signing machine are (security_engineer P2-7, P2-8).
const PEM_PRIVATE = /-----\s*BEGIN\s+(?:[A-Z0-9]+\s+)*PRIVATE\s+KEY\s*-----/i;
const ED25519_PKCS8 = /MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9+/]{20,}|302e020100300506032b657004220420[0-9a-f]{20,}/i;
const SIGNING_KEY = /(?<![A-Za-z0-9_-])license-sign/i;
const SECRETS_DIR = /\.rein\/secrets(?=[/*\s"'}]|$)|\.rein\/?["']?\s+["']?secrets\b/;   // also `-C ~/.rein secrets`
const TEXT_ONLY = /^(?:grep|egrep|fgrep|rg|git\s+(?:commit|log|show|grep|diff))\b/;
const LISTS = /^(?:ls|stat)\b/;

function _signingKeyPath(text) {
  // `~/.rein//secrets` and `~/.rein/./secrets` are the same directory (critic_security P2, E-355).
  const s = text.replace(/\/(?:\.?\/)+/g, "/");
  for (const seg of s.split(/&&|\|\||[;|&\n]/)) {
    const cmd = seg.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:sudo\s+)?/, "");
    // The secrets directory, or a glob straight under ~/.rein/, blocks in EVERY segment —
    // searching (`grep -r . ~/.rein/secrets`) or writing (`git log > …/secrets/y`) included.
    if ((SECRETS_DIR.test(cmd) || /\.rein\/[?*[]/.test(cmd)) && !LISTS.test(cmd)) return true;
    // A search or a commit message may NAME the key file; not when it hides a substitution.
    if (TEXT_ONLY.test(cmd) && !/\$\(|`/.test(cmd)) continue;
    if (SIGNING_KEY.test(cmd)) return true;
  }
  return false;
}

const USERINFO = /[a-z][a-z0-9+.-]{1,15}:\/\/[^\s:@/]{1,64}:([^\s@/]{1,256})@/i;
const CURL_USER = /(?:^|\s)(?:-u|--user)\s*[^\s:]{1,64}:([^\s]{1,256})/;

function classes(v) {
  let n = 0;
  if (/[a-z]/.test(v)) n++;
  if (/[A-Z]/.test(v)) n++;
  if (/[0-9]/.test(v)) n++;
  if (/[^A-Za-z0-9]/.test(v)) n++;
  return n;
}

// The WHOLE value must be the reference: a prefix test let `TOKEN=${X}Real9876abcDEF`
// and `TOKEN=<Real…` through (critic_security P2). `$(` without its `)` is a command
// substitution that VAL cut at the first space, so it has no literal tail to inspect.
// E-378 (D-129): the high-precision part — a token in a known vendor format or a private key —
// for scanning a TREE (the public repository's commit and CI gates). The assignment heuristics
// below are for commands and would flag code that merely names `password=`.
export function containsCredentialToken(text) {
  const s = String(text ?? "");
  return PREFIX_TOKEN.test(s) || PEM_PRIVATE.test(s) || ED25519_PKCS8.test(s);
}

export function isReference(v) {
  return /^(?:\$[A-Za-z_][A-Za-z0-9_]{0,63}|\$\{[^}]{1,64}\}|\$\([^)]{0,256}\)?|<[^<>]{1,64}>|\*+|x{4,}|\.\.\.)$/i.test(v);
}

function looksLikeCredential(value, keyword) {
  if (isReference(value)) return false;
  if (PREFIX_TOKEN.test(value)) return true;
  if (value.length >= 16 && classes(value) >= 3) return true;
  if (value.length >= 20 && /^[A-Za-z0-9+/_=-]+$/.test(value) && /\d/.test(value) && classes(value) >= 2) return true;
  if (/^(?:pass(?:word|wd)?|pwd)$/i.test(keyword) && value.length >= 8 && classes(value) >= 2) return true;
  return false;
}

// Returns true when `text` (already normalised by the caller) carries a credential.
export function containsSecret(text) {
  const s = String(text ?? "");
  if (s.length > SCAN_LIMIT) return true; // fail closed: never pass what was not scanned
  if (PREFIX_TOKEN.test(s)) return true;
  if (PEM_PRIVATE.test(s) || ED25519_PKCS8.test(s) || _signingKeyPath(s)) return true;
  ASSIGN.lastIndex = 0;
  let m;
  while ((m = ASSIGN.exec(s)) !== null) {
    const keyword = m[1] || m[4] || "auth";
    const value = m[3] || m[5] || m[6];
    // E-284 over-block (D-080: recorded verbatim in secret-cases.json): a bare `pass` or
    // `auth` label in COLON form is how test output and prose read ("PASS: 12", "Auth: ok"),
    // and a grep pattern after it scored as a password. Colon-form credentials carry a
    // specific key ("password":, X-Api-Key:, Authorization:), so only these two bare
    // labels are skipped, and only after a colon.
    // The WHOLE key must be the bare label (critic_security SEC_FAIL): the keyword group
    // excludes the lazy key prefix, so testing `keyword` alone also skipped db_pass:,
    // SMTP_PASS: and x-auth: — real credential keys. Test the matched text instead.
    if (m[2] === ":" && /^[\s;&|("'{,/:]?-{0,2}(?:pass|auth)\s*:/i.test(m[0])) {
      if (m[0].length === 0) ASSIGN.lastIndex++;
      continue;
    }
    if (value && looksLikeCredential(value, keyword)) return true;
    if (m[0].length === 0) ASSIGN.lastIndex++; // defensive: never loop on an empty match
  }
  for (const re of [USERINFO, CURL_USER]) {
    const u = re.exec(s);
    if (u && u[1].length >= 8 && !isReference(u[1])) return true;
  }
  return false;
}
