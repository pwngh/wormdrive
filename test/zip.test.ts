/**
 * @pwngh/wormdrive
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

// The store-only ZIP writer is pure (bytes in, bytes out), so it's checked
// without a browser: CRC-32 against the standard IEEE 802.3 test vectors, and
// the archive's signatures/counts/sizes against the spec layout.

import test from "node:test";
import assert from "node:assert/strict";
import { createZip, crc32, ZipStream } from "../src/zip.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
};

test("crc32: standard IEEE 802.3 vectors", () => {
  assert.equal(crc32(bytes("")), 0x00000000);
  assert.equal(crc32(bytes("a")), 0xe8b7be43);
  assert.equal(crc32(bytes("abc")), 0x352441c2);
});

test("createZip: store-only archive layout", () => {
  const zip = createZip([
    { name: "hello.txt", data: bytes("hello") },
    { name: "dir/b.txt", data: bytes("world!") },
  ]);
  const view = new DataView(zip.buffer);

  // First record is a local file header for hello.txt.
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(8, true), 0, "compression method is store (0)");
  assert.equal(view.getUint32(14, true), crc32(bytes("hello")), "crc field");
  assert.equal(view.getUint32(18, true), 5, "compressed size == uncompressed");
  assert.equal(view.getUint32(22, true), 5, "uncompressed size");

  // End-of-central-directory record closes the archive and lists both entries.
  const eocd = zip.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, "EOCD signature");
  assert.equal(view.getUint16(eocd + 10, true), 2, "total entries");

  // Both names are present (the second carries its directory path).
  const text = new TextDecoder().decode(zip);
  assert.ok(text.includes("hello.txt"));
  assert.ok(text.includes("dir/b.txt"));

  // Central directory: the second entry's local-header offset must point past the
  // first entry's local header (30 + "hello.txt"=9) and its data (5) = 44.
  const cdStart = view.getUint32(eocd + 16, true);
  assert.equal(view.getUint32(cdStart + 42, true), 0, "first entry local-header offset");
  const cd2 = cdStart + 46 + "hello.txt".length;
  assert.equal(view.getUint32(cd2, true), 0x02014b50, "second central directory header");
  assert.equal(view.getUint32(cd2 + 42, true), 44, "second entry local-header offset");
});

test("createZip: empty archive is just an EOCD record", () => {
  const zip = createZip([]);
  assert.equal(zip.length, 22);
  assert.equal(new DataView(zip.buffer).getUint32(0, true), 0x06054b50);
});

test("ZipStream: streams an entry with a trailing data descriptor", async () => {
  const out: Uint8Array[] = [];
  const zip = new ZipStream(async (chunk) => {
    out.push(chunk.slice());
  });
  await zip.addFile("a.txt");
  await zip.writeChunk(bytes("hel"));
  await zip.writeChunk(bytes("lo"));
  await zip.closeFile();
  await zip.finish();

  const buf = concat(out);
  const view = new DataView(buf.buffer);

  assert.equal(view.getUint32(0, true), 0x04034b50, "local file header");
  assert.equal(view.getUint16(6, true), 0x0808, "data-descriptor + UTF-8 flags");
  assert.equal(view.getUint32(14, true), 0, "header CRC is deferred to the descriptor");
  // local header (30 + "a.txt"=5 = 35) + data ("hello"=5) ⇒ data descriptor at 40.
  assert.equal(view.getUint32(40, true), 0x08074b50, "data descriptor signature");
  assert.equal(view.getUint32(44, true), crc32(bytes("hello")), "descriptor CRC matches the data");
  assert.equal(view.getUint32(48, true), 5, "descriptor compressed size");
  assert.equal(view.getUint32(52, true), 5, "descriptor uncompressed size");

  // Central directory must mirror the descriptor and point at the local header,
  // and the EOCD pointers must frame it — the offset math that no other test covers.
  const eocd = buf.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, "EOCD");
  assert.equal(view.getUint16(eocd + 10, true), 1, "one entry");
  const cdStart = view.getUint32(eocd + 16, true);
  assert.equal(view.getUint32(cdStart, true), 0x02014b50, "central directory header");
  assert.equal(view.getUint32(cdStart + 16, true), crc32(bytes("hello")), "central dir CRC");
  assert.equal(view.getUint32(cdStart + 24, true), 5, "central dir uncompressed size");
  assert.equal(view.getUint32(cdStart + 42, true), 0, "central dir local-header offset");
  assert.equal(view.getUint32(eocd + 12, true), 46 + "a.txt".length, "EOCD central-dir size");
  assert.ok(new TextDecoder().decode(buf).includes("a.txt"));
});

test("ZipStream: accumulates offsets across multiple entries", async () => {
  const out: Uint8Array[] = [];
  const zip = new ZipStream(async (chunk) => {
    out.push(chunk.slice());
  });
  await zip.addFile("a.txt");
  await zip.writeChunk(bytes("hello"));
  await zip.closeFile();
  await zip.addFile("b.txt");
  await zip.writeChunk(bytes("world!"));
  await zip.closeFile();
  await zip.finish();

  const buf = concat(out);
  const view = new DataView(buf.buffer);
  // Entry 1 spans local header (30 + 5) + data (5) + data descriptor (16) = 56,
  // so b.txt's local header must start exactly at byte 56.
  assert.equal(view.getUint32(56, true), 0x04034b50, "second local file header");
  const eocd = buf.length - 22;
  assert.equal(view.getUint16(eocd + 10, true), 2, "two entries");
  const cdStart = view.getUint32(eocd + 16, true);
  assert.equal(view.getUint32(cdStart + 42, true), 0, "first entry local-header offset");
  // Second central record follows the first (46 + "a.txt"=5); its offset is 56.
  assert.equal(view.getUint32(cdStart + 46 + 5 + 42, true), 56, "second entry local-header offset");
});

test("ZipStream: an empty entry has crc 0 and size 0", async () => {
  const out: Uint8Array[] = [];
  const zip = new ZipStream(async (chunk) => {
    out.push(chunk.slice());
  });
  await zip.addFile("e.txt");
  await zip.closeFile();
  await zip.finish();

  const buf = concat(out);
  const view = new DataView(buf.buffer);
  // local header (30 + "e.txt"=5 = 35), then the data descriptor immediately.
  assert.equal(view.getUint32(35, true), 0x08074b50, "data descriptor signature");
  assert.equal(view.getUint32(39, true), crc32(bytes("")), "empty entry crc is 0");
  assert.equal(view.getUint32(43, true), 0, "empty entry size");
});

// ZIP64 (the extensions that lift the 4 GiB / 65,535-entry ceilings) is awkward to
// test honestly: actually streaming the 4+ GiB it takes to overflow the 32-bit
// fields would run for minutes. So each ceiling is tripped the cheap way instead —
// forceZip64 writes the ZIP64 shape with tiny data, a >4 GiB size hint marks one
// entry, exactly 65,535 empty entries overflow the count, and one test pokes the
// internal byte counter to the boundary. The genuinely-large case is proven
// separately: a one-off check fed forced / hint / count archives to the real
// Info-ZIP `unzip`, which extracted every one.
test("ZipStream: forceZip64 emits a full ZIP64 archive (small data)", async () => {
  const out: Uint8Array[] = [];
  const zip = new ZipStream(async (chunk) => out.push(chunk.slice()), { forceZip64: true });
  await zip.addFile("a.txt");
  await zip.writeChunk(bytes("hello"));
  await zip.closeFile();
  await zip.finish();

  const buf = concat(out);
  const view = new DataView(buf.buffer);

  // Local header: ZIP64 version, 0xFFFFFFFF size sentinels, a 20-byte extra field.
  assert.equal(view.getUint16(4, true), 45, "local version needed = 45 (ZIP64)");
  assert.equal(view.getUint32(18, true), 0xffffffff, "local compressed-size sentinel");
  assert.equal(view.getUint32(22, true), 0xffffffff, "local uncompressed-size sentinel");
  assert.equal(view.getUint16(28, true), 20, "local ZIP64 extra length");
  assert.equal(view.getUint16(30 + 5, true), 0x0001, "local ZIP64 extra tag");

  // 8-byte data descriptor: local header (30 + 5 + 20 = 55) + data (5) = 60.
  assert.equal(view.getUint32(60, true), 0x08074b50, "data descriptor signature");
  assert.equal(view.getBigUint64(68, true), 5n, "descriptor compressed size (64-bit)");
  assert.equal(view.getBigUint64(76, true), 5n, "descriptor uncompressed size (64-bit)");

  // Tail: ZIP64 EOCD record, then its locator, then the classic EOCD.
  const eocd = buf.length - 22;
  const loc = eocd - 20;
  const z64 = loc - 56;
  assert.equal(view.getUint32(z64, true), 0x06064b50, "ZIP64 EOCD record");
  assert.equal(view.getBigUint64(z64 + 32, true), 1n, "ZIP64 EOCD total entries");
  assert.equal(view.getBigUint64(z64 + 24, true), 1n, "ZIP64 EOCD entries on this disk");
  // The central-dir size/offset are the fields that relocate the directory — assert
  // them (against the classic EOCD's real values here) so a setBigUint64 swap fails.
  assert.equal(Number(view.getBigUint64(z64 + 40, true)), view.getUint32(eocd + 12, true), "ZIP64 EOCD central-dir size");
  assert.equal(Number(view.getBigUint64(z64 + 48, true)), view.getUint32(eocd + 16, true), "ZIP64 EOCD central-dir offset");
  assert.equal(view.getUint32(loc, true), 0x07064b50, "ZIP64 EOCD locator");
  assert.equal(view.getBigUint64(loc + 8, true), BigInt(z64), "locator points at the ZIP64 EOCD");
  assert.equal(view.getUint32(eocd, true), 0x06054b50, "classic EOCD");
  assert.equal(view.getUint16(eocd + 10, true), 1, "classic EOCD entry count");

  // Central record: classic size/offset slots hold sentinels; the real values
  // live in its ZIP64 extra (uncompressed size first, at tag + 4).
  const cdStart = view.getUint32(eocd + 16, true);
  assert.equal(view.getUint32(cdStart, true), 0x02014b50, "central directory header");
  assert.equal(view.getUint32(cdStart + 20, true), 0xffffffff, "central compressed-size sentinel");
  assert.equal(view.getUint32(cdStart + 42, true), 0xffffffff, "central offset sentinel");
  assert.equal(view.getUint16(cdStart + 46 + 5, true), 0x0001, "central ZIP64 extra tag");
  assert.equal(view.getBigUint64(cdStart + 46 + 5 + 4, true), 5n, "central ZIP64 uncompressed size");
});

test("ZipStream: a >4 GiB size hint makes one entry ZIP64 (8-byte descriptor)", async () => {
  const out: Uint8Array[] = [];
  const zip = new ZipStream(async (chunk) => out.push(chunk.slice()));
  await zip.addFile("big.bin", 5_000_000_000); // hint over 4 GiB → ZIP64 entry
  await zip.writeChunk(bytes("hi"));
  await zip.closeFile();
  await zip.finish();

  const buf = concat(out);
  const view = new DataView(buf.buffer);
  assert.equal(view.getUint16(4, true), 45, "local version needed = 45 (ZIP64)");
  assert.equal(view.getUint32(18, true), 0xffffffff, "local size sentinel");
  // local header (30 + "big.bin"=7 + extra 20 = 57) + data ("hi"=2) = 59.
  assert.equal(view.getUint32(59, true), 0x08074b50, "data descriptor signature");
  assert.equal(view.getBigUint64(67, true), 2n, "8-byte compressed size");
  // The archive itself is tiny, so the EOCD stays classic (no ZIP64 EOCD record).
  const eocd = buf.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, "classic EOCD");
  assert.equal(view.getUint16(eocd + 10, true), 1, "one entry");
});

test("ZipStream: forceZip64 across two entries pins the 2nd record + accumulation", async () => {
  const out: Uint8Array[] = [];
  const zip = new ZipStream(async (chunk) => out.push(chunk.slice()), { forceZip64: true });
  await zip.addFile("a.txt");
  await zip.writeChunk(bytes("hello"));
  await zip.closeFile();
  await zip.addFile("b.txt");
  await zip.writeChunk(bytes("world!"));
  await zip.closeFile();
  await zip.finish();

  const buf = concat(out);
  const view = new DataView(buf.buffer);
  const eocd = buf.length - 22;
  assert.equal(view.getUint16(eocd + 10, true), 2, "classic EOCD entry count");

  const cdStart = view.getUint32(eocd + 16, true);
  // Record 1 is 46 + "a.txt"(5) + extra(28) = 79 bytes, so record 2 follows at +79.
  const cd2 = cdStart + 79;
  assert.equal(view.getUint32(cd2, true), 0x02014b50, "second central directory header");
  assert.equal(view.getUint16(cd2 + 46 + 5, true), 0x0001, "second record ZIP64 extra tag");
  assert.equal(view.getBigUint64(cd2 + 46 + 5 + 4, true), 6n, "second record ZIP64 uncompressed size");

  const loc = eocd - 20;
  const z64 = loc - 56;
  assert.equal(view.getUint32(z64, true), 0x06064b50, "ZIP64 EOCD record");
  assert.equal(view.getBigUint64(z64 + 32, true), 2n, "ZIP64 EOCD total entries");
  assert.equal(view.getBigUint64(loc + 8, true), BigInt(z64), "locator points at the ZIP64 EOCD");
});

test("ZipStream: 65535 entries (the count sentinel) trigger a ZIP64 EOCD", async () => {
  const out: Uint8Array[] = [];
  const zip = new ZipStream(async (chunk) => out.push(chunk.slice()));
  const N = 65535; // exactly the 16-bit count sentinel — the `>=` boundary
  for (let i = 0; i < N; i += 1) {
    await zip.addFile("f"); // 1-byte name, empty data: cheap, no CRC cost
    await zip.closeFile();
  }
  await zip.finish();

  const buf = concat(out);
  const view = new DataView(buf.buffer);
  const eocd = buf.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, "classic EOCD");
  assert.equal(view.getUint16(eocd + 8, true), 0xffff, "disk-entry count clamped to the sentinel");
  assert.equal(view.getUint16(eocd + 10, true), 0xffff, "total-entry count clamped to the sentinel");

  const loc = eocd - 20;
  const z64 = loc - 56;
  assert.equal(view.getUint32(z64, true), 0x06064b50, "ZIP64 EOCD record present");
  assert.equal(view.getBigUint64(z64 + 32, true), BigInt(N), "ZIP64 EOCD total entries");
  assert.equal(view.getUint32(loc, true), 0x07064b50, "ZIP64 EOCD locator");
  assert.equal(view.getBigUint64(loc + 8, true), BigInt(z64), "locator points at the ZIP64 EOCD");
});

test("ZipStream: a mixed archive keeps classic and ZIP64 entries independent", async () => {
  const out: Uint8Array[] = [];
  const zip = new ZipStream(async (chunk) => out.push(chunk.slice()));
  await zip.addFile("classic.txt"); // no hint → classic
  await zip.writeChunk(bytes("hello"));
  await zip.closeFile();
  await zip.addFile("big.bin", 5_000_000_000); // ZIP64 by size hint, 2 bytes written
  await zip.writeChunk(bytes("hi"));
  await zip.closeFile();
  await zip.finish();

  const buf = concat(out);
  const view = new DataView(buf.buffer);
  // Entry 1 local header is classic (version 20); entry 1 spans 30 + "classic.txt"
  // (11) + data (5) + a 16-byte descriptor = 62, where entry 2's header begins.
  assert.equal(view.getUint16(4, true), 20, "entry 1 is classic");
  assert.equal(view.getUint32(62, true), 0x04034b50, "entry 2 local header");
  assert.equal(view.getUint16(66, true), 45, "entry 2 is ZIP64");

  const eocd = buf.length - 22;
  assert.equal(view.getUint16(eocd + 10, true), 2, "two entries");
  const cdStart = view.getUint32(eocd + 16, true);
  assert.equal(view.getUint16(cdStart + 6, true), 20, "record 1 version (classic)");
  assert.equal(view.getUint16(cdStart + 30, true), 0, "record 1 has no ZIP64 extra");
  assert.equal(view.getUint32(cdStart + 42, true), 0, "record 1 offset");
  // Record 2: a ZIP64 size extra, but its offset fits in 32 bits (a real value).
  const cd2 = cdStart + 46 + "classic.txt".length;
  assert.equal(view.getUint16(cd2 + 6, true), 45, "record 2 version (ZIP64)");
  assert.equal(view.getUint16(cd2 + 30, true), 20, "record 2 ZIP64 extra (4 + 16)");
  assert.equal(view.getUint32(cd2 + 20, true), 0xffffffff, "record 2 size sentinel");
  assert.equal(view.getUint32(cd2 + 42, true), 62, "record 2 offset is real, not a sentinel");
  assert.equal(view.getBigUint64(cd2 + 46 + "big.bin".length + 4, true), 2n, "record 2 ZIP64 size");
  assert.equal(view.getUint32(eocd, true), 0x06054b50, "classic EOCD (tiny archive)");
});

test("ZipStream: an entry past the 4 GiB mark gets an offset-only ZIP64 extra", async () => {
  const out: Uint8Array[] = [];
  const zip = new ZipStream(async (chunk) => out.push(chunk.slice()));
  // Set the next local-header offset to exactly 0xFFFFFFFF without streaming the
  // bytes (the offset is internal and only advances by real writes). This is the
  // boundary value that is both the largest 32-bit number and the ZIP64 sentinel,
  // so it must go ZIP64 (regression test for the `>=` check) — and it reaches the
  // offset-overflow-but-size-fits branch, the lone extra layout that omits the
  // size pair, without a multi-gigabyte fixture.
  (zip as unknown as { offset: number }).offset = 0xffffffff;
  await zip.addFile("tail.txt"); // small hint → classic 32-bit sizes
  await zip.writeChunk(bytes("hi"));
  await zip.closeFile();
  await zip.finish();

  const buf = concat(out);
  const view = new DataView(buf.buffer);
  let cd = -1;
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (view.getUint32(i, true) === 0x02014b50) {
      cd = i;
      break;
    }
  }
  assert.notEqual(cd, -1, "central directory header found");
  assert.equal(view.getUint32(cd + 20, true), 2, "compressed-size slot holds the real size");
  assert.equal(view.getUint32(cd + 24, true), 2, "uncompressed-size slot holds the real size");
  assert.equal(view.getUint32(cd + 42, true), 0xffffffff, "offset slot is the sentinel");
  const extra = cd + 46 + view.getUint16(cd + 28, true);
  assert.equal(view.getUint16(extra, true), 0x0001, "ZIP64 extra tag");
  assert.equal(view.getUint16(extra + 2, true), 8, "extra data-size = 8 (offset only, no size pair)");
  assert.equal(view.getBigUint64(extra + 4, true), 0xffffffffn, "extra carries the 64-bit offset");
});

test("ZipStream: a size hint of exactly 4 GiB-1 (the sentinel) goes ZIP64", async () => {
  const out: Uint8Array[] = [];
  const zip = new ZipStream(async (chunk) => out.push(chunk.slice()));
  await zip.addFile("x", 0xffffffff); // == MAX32 == the ZIP64 sentinel → must be ZIP64
  await zip.writeChunk(bytes("hi"));
  await zip.closeFile();
  await zip.finish();
  const view = new DataView(concat(out).buffer);
  assert.equal(view.getUint16(4, true), 45, "exact-sentinel hint forces ZIP64 (the `>=` check)");
});
