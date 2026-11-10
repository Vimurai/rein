// release-tar.mjs — the ustar writer and the matching strict reader for a Rein release
// tarball (E-418; release-artifact.md §Component 2, D-155 addendum r4). node: modules only.
//
// The writer emits regular-file members only (typeflag "0"): no directory entries, no links,
// never a pax or GNU extension record ("x", "g", "L", "K"). Names are relative with no
// leading "./"; uid and gid 0; uname and gname empty; mtime as given; gzip level 9. The
// reader accepts exactly that and nothing else, so it is also the shape rein-app may rely on.

import { gunzipSync, gzipSync } from "node:zlib";

const BLOCK = 512;

export class TarError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.path = path;
    this.reason = reason;
  }
}

/** [prefix, name] buffers that ustar can hold for `path`, or null when it cannot. */
export function ustarSplit(path) {
  const b = Buffer.from(path, "utf8");
  if (b.length <= 100) return [Buffer.alloc(0), b];
  for (let i = b.length - 1; i > 0; i--) {
    if (b[i] !== 0x2f) continue;
    const prefix = b.subarray(0, i);
    const name = b.subarray(i + 1);
    if (prefix.length <= 155 && name.length > 0 && name.length <= 100) return [prefix, name];
  }
  return null;
}

function octal(n, width) {
  const s = n.toString(8);
  if (s.length > width) throw new RangeError(`value ${n} does not fit ${width} octal digits`);
  return s.padStart(width, "0") + "\0";
}

function header(path, mode, size, mtime) {
  const split = ustarSplit(path);
  if (!split) throw new TarError(path, "name does not fit a ustar header");
  const h = Buffer.alloc(BLOCK);
  split[1].copy(h, 0);
  h.write(octal(mode, 7), 100, "ascii");
  h.write(octal(0, 7), 108, "ascii");
  h.write(octal(0, 7), 116, "ascii");
  h.write(octal(size, 11), 124, "ascii");
  h.write(octal(mtime, 11), 136, "ascii");
  h.fill(0x20, 148, 156);
  h.write("0", 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  split[0].copy(h, 345);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}

/**
 * members: [{ path, mode, data }] in archive order. Returns the gzip'd tarball as a Buffer.
 * mtime: seconds since the epoch for every member (SOURCE_DATE_EPOCH or 0).
 */
export function writeTarGz(members, mtime = 0) {
  const parts = [];
  for (const m of members) {
    parts.push(header(m.path, m.mode, m.data.length, mtime), m.data);
    const pad = (BLOCK - (m.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

function cstr(buf, start, len) {
  const f = buf.subarray(start, start + len);
  const nul = f.indexOf(0);
  return nul === -1 ? f : f.subarray(0, nul);
}

function num(buf, start, len, path, field) {
  const s = buf.toString("ascii", start, start + len).replace(/[\0 ]+$/, "");
  if (!/^[0-7]+$/.test(s)) throw new TarError(path, `${field} is not an octal number`);
  return parseInt(s, 8);
}

function isZero(buf) {
  for (const byte of buf) if (byte !== 0) return false;
  return true;
}

/** Reads a tarball the writer above produced. Throws TarError naming the first bad member. */
export function readTarGz(gz) {
  let tar;
  try {
    tar = gunzipSync(gz);
  } catch {
    throw new TarError("<archive>", "not a gzip stream");
  }
  const members = [];
  let off = 0;
  for (;;) {
    if (off + BLOCK > tar.length) throw new TarError("<archive>", "truncated: no end-of-archive blocks");
    const h = tar.subarray(off, off + BLOCK);
    if (isZero(h)) {
      if (!isZero(tar.subarray(off)) || tar.length - off < BLOCK * 2) {
        throw new TarError("<archive>", "data after the end-of-archive marker");
      }
      return members;
    }
    const prefix = cstr(h, 345, 155);
    const name = cstr(h, 0, 100);
    const path = (prefix.length ? `${prefix.toString("utf8")}/` : "") + name.toString("utf8");
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (num(h, 148, 8, path, "checksum") !== sum) throw new TarError(path, "header checksum mismatch");
    if (h.toString("latin1", 257, 265) !== "ustar\x0000") throw new TarError(path, "not a ustar header");
    const type = String.fromCharCode(h[156]);
    if (type !== "0") throw new TarError(path, `member type '${type === "\0" ? "\\0" : type}' is not a regular file`);
    if (!isZero(h.subarray(157, 257))) throw new TarError(path, "carries a link name");
    if (num(h, 108, 8, path, "uid") !== 0 || num(h, 116, 8, path, "gid") !== 0) {
      throw new TarError(path, "uid or gid is not 0");
    }
    if (!isZero(h.subarray(265, 345))) throw new TarError(path, "carries a user or group name");
    if (!path || path.startsWith("/") || path.startsWith("./") || path.split("/").includes("..")) {
      throw new TarError(path || "<empty>", "name is not a plain relative path");
    }
    const mode = num(h, 100, 8, path, "mode");
    const size = num(h, 124, 12, path, "size");
    const mtime = num(h, 136, 12, path, "mtime");
    const start = off + BLOCK;
    if (start + size > tar.length) throw new TarError(path, "truncated member data");
    members.push({ path, mode, size, mtime, data: tar.subarray(start, start + size) });
    off = start + Math.ceil(size / BLOCK) * BLOCK;
  }
}
