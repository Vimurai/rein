// release-unpack.mjs — the §Data Model installer rule of release-artifact.md, for a test (E-420).
//
//   node tests/lib/release-unpack.mjs <checkout> <rein-X.Y.Z.tar.gz> <rein-home>
//
// What a second installer (rein-app) does with a verified tarball, reduced to a fresh home: every
// member written under <rein-home> (tmp + rename, mode from the header), hooks/ last, then
// manifest.json and VERSION (one line, manifest.version) after everything. Reads the tarball with
// the checkout's own strict reader, so a member the writer would not emit is refused here too.
// It deletes nothing: the fixtures it serves start empty.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [checkout, gz, rein] = process.argv.slice(2);
if (!checkout || !gz || !rein) {
  process.stderr.write("usage: release-unpack.mjs <checkout> <tarball> <rein-home>\n");
  process.exit(2);
}
const { readTarGz } = await import(resolve(checkout, "src/shared/release-tar.mjs"));
const members = readTarGz(readFileSync(gz));
if (members[0]?.path !== "manifest.json") throw new Error("the first member is not manifest.json");
const put = (p, data, mode) => {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, data);
  chmodSync(tmp, mode);
  renameSync(tmp, p);
};
const rest = members.slice(1);
for (const m of rest.filter((m) => !m.path.startsWith("hooks/"))) put(join(rein, m.path), m.data, m.mode);
for (const m of rest.filter((m) => m.path.startsWith("hooks/"))) put(join(rein, m.path), m.data, m.mode);
put(join(rein, "manifest.json"), members[0].data, 0o644);
put(join(rein, "VERSION"), `${JSON.parse(members[0].data.toString("utf8")).version}\n`, 0o644);
