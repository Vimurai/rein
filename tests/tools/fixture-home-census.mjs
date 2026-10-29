// tests/tools/fixture-home-census.mjs — E-345 (D-109 r1): every fixture HOME a hook runs under
// carries the toolchain record.
//
// A hook ASSIGNS its PATH and finds node through ~/.rein/shared/toolchain.sh (E-286); without
// the record it falls back to a fixed dir list. A suite that points HOME at a temp dir and then
// runs a hook, `ai`, or the pin (src/shared/toolchain-pin.sh) therefore passes only on hosts whose node
// sits in that list — 12 suites went red on 2026-10-23 when node moved to Linuxbrew. The record
// is the contract, not the fallback: such a suite must create its HOME with tc_fixture_home
// (tests/lib/toolchain-fixture.sh) or tc_overlay_home, and only those helpers write a
// toolchain.sh. A suite that deliberately runs with a bare HOME, or writes a broken record to
// test the pin itself, is listed per RULE in tests/fixtures/fixture-home-exemptions.json with a
// one-line reason.
//
// The check is static (the suite's source), run by tests/run.sh before any suite starts.
//   censusSuite(text, name, exemptions) → [] or the violation lines for that suite
//   node fixture-home-census.mjs [--exemptions <json>] <suite.sh>...   exit 1 on a violation

import { readFileSync } from "node:fs";
import { basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// HOME assigned to anything but itself: `HOME=…`, `export HOME=…`, `env HOME=…`; in a node
// test, `process.env.HOME = …` or an env object's `HOME: …`.
const SETS_HOME   = /(^|[\s;(&|'"`{])(?:export\s+)?HOME=(?!"?\$\{?HOME\}?"?(?:[\s;)]|$))|process\.env\.HOME\s*=[^=]|[{,\s]HOME:\s*(?!process\.env\.HOME\b)/m;
// What loads the pin: a hook (by path, through a hooks dir variable, or through git's
// core.hooksPath), the ai CLI (the source tree's, an installed one, or a bare `ai <verb>`),
// or the pin itself (the only src/shared/*.sh that loads it).
const RUNS_LOADER = new RegExp([
  String.raw`\bhooks\/(?:[\w-]+\.sh\b|\$\{?\w)`,
  String.raw`\$\{?HOOKS?_DIR\}?\/`,
  String.raw`\bcore\.hooksPath\b`,
  String.raw`["']hooks["']\s*,\s*["'][\w-]+\.sh["']`,   // node: join(REPO, "hooks", "x.sh")
  String.raw`\bsrc\/bin\/ai\b`,
  String.raw`\.rein\/bin\/ai\b`,
  String.raw`(?:^|[\s;(&|"'\`])ai\s+(?:doctor|sync|init|install|pane|start|ci|task|state|trunk|gate|clean|log)\b`,
  String.raw`\bsrc\/shared\/toolchain-pin\.sh\b`,
].join("|"), "m");
const HELPER      = /\btc_fixture_home\b|\btc_link_shared\b|\btc_overlay_home\b|\btcFixtureHome\b/;
// A suite writing a toolchain record itself bypasses the one writer.
const WRITES_TC   = /\bai_os_tc_write\b|>\s*["']?[^\s"'|;]*toolchain\.sh\b/;

export const RULES = ["FIXTURE_HOME_NO_RECORD", "TOOLCHAIN_WRITE"];

// Comment lines name hooks and `ai` verbs in prose; only code is evidence.
const _code = (text) => text.split("\n").filter((l) => !/^\s*(#|\/\/|\*)/.test(l)).join("\n");

export function censusSuite(source, name, exemptions = {}) {
  const exempt = new Set(exemptions[name]?.rules || []);
  const text = _code(source);
  const out = [];
  if (!exempt.has("FIXTURE_HOME_NO_RECORD") && SETS_HOME.test(text) && RUNS_LOADER.test(text) && !HELPER.test(text)) {
    out.push(`[FIXTURE_HOME_NO_RECORD] ${name}: sets HOME and runs a hook, ai or the toolchain pin without tc_fixture_home — its HOME has no ~/.rein/shared/toolchain.sh (D-109 r1)`);
  }
  if (!exempt.has("TOOLCHAIN_WRITE") && WRITES_TC.test(text)) {
    out.push(`[TOOLCHAIN_WRITE] ${name}: writes a toolchain record itself — use tc_fixture_home / tcFixtureHome (tests/lib/toolchain-fixture.*)`);
  }
  return out;
}

export function loadExemptions(path) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith("//")) continue;
    if (!v || typeof v.reason !== "string" || !v.reason.trim()) throw new Error(`exemption ${k} has no reason`);
    if (!Array.isArray(v.rules) || !v.rules.length || v.rules.some((r) => !RULES.includes(r))) throw new Error(`exemption ${k} must name its rules (${RULES.join(", ")})`);
  }
  return doc;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  let exPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fixture-home-exemptions.json");
  const i = args.indexOf("--exemptions");
  if (i >= 0) { exPath = args[i + 1]; args.splice(i, 2); }
  const exemptions = loadExemptions(exPath);
  const lines = args.flatMap((f) => censusSuite(readFileSync(f, "utf8"), basename(f), exemptions));
  for (const l of lines) console.log(l);
  process.exit(lines.length ? 1 : 0);
}
