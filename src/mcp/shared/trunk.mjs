/**
 * trunk.mjs — the project's trunk, resolved locally (E-341, D-105 r2-r4)
 *
 * The branch claims are published to, the claim gate reads, session-start fetches and the
 * hosted check guards. One resolver, no network, never `git remote set-head` (r3):
 *
 *   (a) .ai/team.json "trunk"                          → source "team.json"
 *   (b) refs/remotes/origin/HEAD (symbolic)            → source "origin/HEAD"
 *   (c) exactly one of refs/remotes/origin/{main,master} → source "origin/<name>"
 *       both, with no origin/HEAD → TRUNK_AMBIGUOUS; neither → NO_TRUNK
 *
 * team.json wins over origin/HEAD (r4): the tracked file is the team's contract; origin/HEAD is
 * a per-clone cache a --single-branch or mirror clone may lack or hold stale.
 */

import { execFileSync } from "child_process";
import { resolve } from "path";
import { readTeam, isBranchName } from "./team.mjs";

const REMOTE_PREFIX = "refs/remotes/origin/";
const FALLBACKS     = ["main", "master"];

function _git(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  } catch { return null; }
}

const _hasRef = (root, ref) => _git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== null;

/** origin/HEAD's branch in this clone, or null. Local read only. */
export function originHead(root) {
  const ref = _git(root, ["symbolic-ref", "-q", `${REMOTE_PREFIX}HEAD`]);
  if (!ref || !ref.startsWith(REMOTE_PREFIX)) return null;
  const name = ref.slice(REMOTE_PREFIX.length);
  return isBranchName(name) ? name : null;
}

/**
 * @param {string} root  the repository root
 * @param {{team?: object|null}} [opts]  a team registry already read (else read here; an
 *        invalid team.json throws TeamError, as readTeam does)
 * @returns {{name: string, source: string} | {name: null, reason: "NO_TRUNK"|"TRUNK_AMBIGUOUS", message: string}}
 *        `message` is the one [NO_TRUNK] line every caller prints on a refusal.
 */
export function resolveTrunk(root, { team } = {}) {
  const t = team === undefined ? readTeam(resolve(root, ".ai")) : team;
  if (t && t.trunk) return { name: t.trunk, source: "team.json" };
  const head = originHead(root);
  if (head) return { name: head, source: "origin/HEAD" };
  const present = FALLBACKS.filter((b) => _hasRef(root, `${REMOTE_PREFIX}${b}`));
  if (present.length === 1) return { name: present[0], source: `origin/${present[0]}` };
  const reason = present.length ? "TRUNK_AMBIGUOUS" : "NO_TRUNK";
  const why = present.length
    ? "origin has both main and master and no origin/HEAD"
    : "no origin/HEAD and neither origin/main nor origin/master";
  return { name: null, reason, message: `[NO_TRUNK] ${reason}: ${why} — set "trunk" in .ai/team.json (or: git remote set-head origin --auto)` };
}

/**
 * The trunk `ai state migrate --team` records in a NEW team.json (D-105 r1). An operator
 * command, so unlike resolveTrunk it may ask origin — once, bounded to 10 s — but it still
 * never runs set-head (r3): --trunk <name>, else origin/HEAD, else `git ls-remote --symref
 * origin HEAD`, else a refusal naming the flag.
 * @returns {{name: string, source: string} | {name: null, message: string}}
 */
export function discoverTrunk(root, flag = null) {
  if (flag != null) {
    return isBranchName(flag) ? { name: flag, source: "--trunk" }
      : { name: null, message: `[NO_TRUNK] --trunk ${JSON.stringify(String(flag)).slice(0, 80)} is not a valid branch name` };
  }
  const head = originHead(root);
  if (head) return { name: head, source: "origin/HEAD" };
  let out = null;
  try {
    out = execFileSync("git", ["ls-remote", "--symref", "origin", "HEAD"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch { out = null; }
  const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out || "");
  if (m && isBranchName(m[1])) return { name: m[1], source: "origin (ls-remote)" };
  return { name: null, message: "[NO_TRUNK] origin's default branch could not be determined — pass --trunk <name>" };
}

/**
 * `ai doctor` lines for a team project (D-105 r1, r4): [TRUNK_UNSET] when team.json has no
 * trunk, [TRUNK_MISMATCH] when it disagrees with origin/HEAD, the resolver's refusal when
 * nothing resolves. [] when all agree. Never edits team.json (a tracked team-wide file).
 */
export function trunkDoctor(root) {
  const team = readTeam(resolve(root, ".ai"));
  if (!team) return [];
  const head = originHead(root);
  if (team.trunk) {
    return head && head !== team.trunk ? [`[TRUNK_MISMATCH] team.json trunk=${team.trunk}, origin/HEAD=${head} — claims use ${team.trunk}`] : [];
  }
  const r = resolveTrunk(root, { team });
  if (!r.name) return [r.message];
  return [`[TRUNK_UNSET] .ai/team.json has no trunk — resolved ${r.name} from ${r.source}; add "trunk": "${r.name}"`];
}
