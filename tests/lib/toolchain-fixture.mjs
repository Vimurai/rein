// tests/lib/toolchain-fixture.mjs — the node-side twin of tests/lib/toolchain-fixture.sh.
//
// A hook ASSIGNS its PATH (E-286) and finds node through the install-time record
// ~/.ai-os/shared/toolchain.sh, falling back to a FIXED dir list (/usr/bin, /bin,
// /usr/local/bin, /opt/homebrew/bin). A fixture HOME has no record, so on a host whose node
// lives anywhere else (Linuxbrew, nvm, fnm) every hook-driven `ai` call reported "node not
// found" and the test failed for a reason that has nothing to do with what it tests. The
// record is written by the installer's own writer, with the interpreters running this test.
//
//   tcFixtureHome(home)         E-345 (D-109 r1): the twin of tc_fixture_home — the record
//                               AND the pin, through the shell helper itself (one writer)
//   recordToolchain(home)       writes <home>/.ai-os/shared/toolchain.sh
//   linkShared(home, srcShared) <home>/.ai-os/shared as a REAL dir whose entries link into
//                               srcShared, so the record never lands in the source tree

import { mkdirSync, readdirSync, symlinkSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function recordToolchain(home) {
  const shared = join(home, ".ai-os", "shared");
  mkdirSync(shared, { recursive: true });
  const py = execFileSync("bash", ["-c", "command -v python3 || true"], { encoding: "utf8" }).trim();
  execFileSync("bash", ["-c", '. "$1"; ai_os_tc_write "$2" "$3" "$4" /usr/bin/nice', "_",
    join(REPO, "src", "shared", "toolchain-record.sh"), join(shared, "toolchain.sh"),
    realpathSync(process.execPath), py ? realpathSync(py) : ""]);
}

export function tcFixtureHome(home) {
  execFileSync("bash", ["-c", '. "$1"; tc_fixture_home "$2"', "_", join(REPO, "tests", "lib", "toolchain-fixture.sh"), home],
    { stdio: ["ignore", "ignore", "inherit"] });
}

export function linkShared(home, srcShared) {
  const shared = join(home, ".ai-os", "shared");
  mkdirSync(shared, { recursive: true });
  for (const n of readdirSync(srcShared)) {
    if (n !== "toolchain.sh") symlinkSync(join(srcShared, n), join(shared, n));
  }
}
