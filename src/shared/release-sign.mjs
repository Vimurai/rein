#!/usr/bin/env node
// release-sign.mjs — `rein release sign` and the signature half of `rein release verify`
// (E-419; D-153 r1, D-155 r6; .ai/blueprints/release-artifact.md §Component 3, §Security).
//
//   node release-sign.mjs sign <rein-X.Y.Z.tar.gz> --pubkey <file>     (key: REIN_RELEASE_KEY)
//
// Wraps the `minisign` binary; this repository carries no signer of its own. The secret key comes
// only from the environment variable REIN_RELEASE_KEY (the key file's two lines, unencrypted). It
// is written to a 0600 file in a fresh private temp directory, used once, and the directory is
// removed on every path out — success, refusal, or a signal. Key material never appears in an
// argument, a log line or beside the tarball. The signature is the prehashed form (`ED`), carries
// the trusted comment `file:rein-<version>.tar.gz version:<version>` (the version read from the
// manifest inside the tarball), and is verified against --pubkey before it is written as
// <tarball>.minisig. Any refusal — no key, no minisign, a self-check that fails — exits 3 and
// leaves nothing beside the tarball. node: modules only.

import { spawnSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readTarGz } from "./release-tar.mjs";

export class SignRefusal extends Error {}

// security_engineer E-419 F4: minisign never inherits the key's environment variable.
function minisignEnv() {
  const env = { ...process.env };
  delete env.REIN_RELEASE_KEY;
  return env;
}

/** Status 0 when a `minisign` binary answers on PATH. */
export function haveMinisign() {
  const r = spawnSync("minisign", ["-v"], { encoding: "utf8", env: minisignEnv() });
  return !r.error && r.status === 0;
}

/**
 * `minisign -V` of <file> against <pubkey> with <file>.minisig (or `sig`). → null when it
 * verifies, else the reason. Never trusts the untrusted comment; reads the trusted one only.
 */
export function verifySignature(file, pubkey, sig = `${file}.minisig`) {
  if (!haveMinisign()) return "minisign is not on PATH";
  if (!existsSync(sig)) return `${basename(sig)} is missing`;
  const r = spawnSync("minisign", ["-V", "-q", "-p", pubkey, "-m", file, "-x", sig], { encoding: "utf8", env: minisignEnv() });
  if (r.status !== 0) return `the signature does not verify against ${basename(pubkey)}`;
  return null;
}

/** The signature line's algorithm: "ED" for the prehashed form, "Ed" for the legacy one. */
export function signatureAlgorithm(sigText) {
  const line = String(sigText).split("\n")[1] || "";
  return Buffer.from(line.trim(), "base64").subarray(0, 2).toString("latin1");
}

/** Sign <tarball>; the key text arrives as an argument from the caller's environment read. */
export function signTarball(tarball, pubkey, keyText) {
  if (!keyText || !String(keyText).trim()) throw new SignRefusal("REIN_RELEASE_KEY is not set — nothing signed");
  if (!haveMinisign()) throw new SignRefusal("minisign is not on PATH — nothing signed");
  if (!existsSync(pubkey)) throw new SignRefusal(`${pubkey}: no such public key file`);
  let version;
  try {
    const first = readTarGz(readFileSync(tarball))[0];
    if (first?.path !== "manifest.json") throw new Error("the first member is not manifest.json");
    version = JSON.parse(first.data.toString("utf8")).version;
  } catch (e) {
    throw new SignRefusal(`${basename(tarball)}: not a release tarball (${e.message})`);
  }
  if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new SignRefusal(`${basename(tarball)}: the manifest's version ${JSON.stringify(version)} is not semver`);
  }
  // F2: a signature from an earlier run never survives a refusal of this one.
  rmSync(`${tarball}.minisig`, { force: true });
  const dir = mkdtempSync(join(tmpdir(), "rein-sign-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const onSignal = (sig) => { cleanup(); process.exit(sig === "SIGINT" ? 130 : 143); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    chmodSync(dir, 0o700);
    const key = join(dir, "key");
    writeFileSync(key, String(keyText).endsWith("\n") ? keyText : `${keyText}\n`, { mode: 0o600, flag: "wx" });
    const sig = join(dir, "sig");
    const r = spawnSync("minisign", ["-S", "-W", "-s", key, "-m", tarball, "-x", sig,
      "-t", `file:rein-${version}.tar.gz version:${version}`], { encoding: "utf8", env: minisignEnv() });
    // minisign's own output can name the key file path; neither stream is passed on.
    if (r.status !== 0 || !existsSync(sig)) throw new SignRefusal("minisign could not sign with REIN_RELEASE_KEY (wrong format, or a password-protected key)");
    if (signatureAlgorithm(readFileSync(sig, "utf8")) !== "ED") throw new SignRefusal("minisign produced a legacy (non-prehashed) signature — refusing");
    const bad = verifySignature(tarball, pubkey, sig);
    if (bad) throw new SignRefusal(`self-check failed: ${bad} — the key does not match ${basename(pubkey)}`);
    const out = `${tarball}.minisig`;
    // F1: never write through a link planted at the temporary name.
    rmSync(`${out}.tmp`, { force: true });
    copyFileSync(sig, `${out}.tmp`, constants.COPYFILE_EXCL);
    renameSync(`${out}.tmp`, out);
    return { out, version };
  } finally {
    cleanup();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

function main(argv) {
  const [sub, tarball, ...rest] = argv;
  const i = rest.indexOf("--pubkey");
  const pubkey = i >= 0 ? rest[i + 1] : null;
  if (sub !== "sign" || !tarball || !pubkey || rest.length !== 2) {
    process.stderr.write("usage: rein release sign <rein-X.Y.Z.tar.gz> --pubkey <file>   (key: REIN_RELEASE_KEY)\n");
    return 2;
  }
  try {
    const { out, version } = signTarball(tarball, pubkey, process.env.REIN_RELEASE_KEY);
    process.stdout.write(`✓ ${basename(out)} — rein ${version}, verified against ${basename(pubkey)}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof SignRefusal)) throw e;
    rmSync(`${tarball}.minisig.tmp`, { force: true });
    process.stderr.write(`[RELEASE_SIGN_REFUSED] ${e.message}\n`);
    return 3;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
