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

// Minimal store-only (no compression) ZIP writer, dependency-free, so the
// receiver can bundle a whole folder into a single download without pulling a
// zip library into the zero-dependency frontend. Compression is skipped on
// purpose: the files were just transferred over the data channel and deflate
// would burn CPU for little gain on a one-shot client-side bundle. createZip (the
// in-memory path) stays classic — bounded by the 4 GiB / 65,535-entry classic
// headers and by tab memory — while ZipStream below carries ZIP64 for the streamed
// multi-gigabyte / many-entry case.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3 — the variant ZIP uses) of a byte array. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Path inside the archive, '/'-separated, no leading slash. */
  name: string;
  data: Uint8Array;
}

/**
 * Pack entries into a store-only ZIP archive as one `Uint8Array`, ready to wrap
 * in a Blob. Filenames are UTF-8 with the language-encoding flag set so
 * unzippers decode them correctly; a fixed 1980-01-01 timestamp is used because
 * the wire manifest carries no modification times.
 */
export function createZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const DOS_TIME = 0;
  const DOS_DATE = 0x0021; // 1980-01-01 (ZIP has no "no date", so use the epoch)
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed to extract
    lv.setUint16(6, 0x0800, true); // general-purpose flags: UTF-8 filename (bit 11)
    lv.setUint16(8, 0, true); // compression method: 0 = store
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size (== uncompressed for store)
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra-field length
    local.set(name, 30);
    parts.push(local, entry.data);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed to extract
    cv.setUint16(8, 0x0800, true); // flags: UTF-8 filename
    cv.setUint16(10, 0, true); // method: store
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra-field length
    cv.setUint16(32, 0, true); // file-comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal file attributes
    cv.setUint32(38, 0, true); // external file attributes
    cv.setUint32(42, offset, true); // offset of the local header
    cd.set(name, 46);
    central.push(cd);

    offset += local.length + size;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const cd of central) {
    parts.push(cd);
    centralSize += cd.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(4, 0, true); // number of this disk
  ev.setUint16(6, 0, true); // disk with the start of the central directory
  ev.setUint16(8, entries.length, true); // central directory entries on this disk
  ev.setUint16(10, entries.length, true); // total central directory entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true); // archive comment length
  parts.push(eocd);

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

/** Sink for streamed output: write each chunk, in order. */
export type ZipWrite = (chunk: Uint8Array) => Promise<void>;

// 0xFFFFFFFF doubles as the largest 32-bit value and the "look in the ZIP64 extra
// field for the real value" sentinel that classic size/offset slots hold.
const MAX32 = 0xffffffff;

interface CentralRecord {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  // The local header committed to the 64-bit form (size sentinels + ZIP64 extra),
  // so this central record and its trailing descriptor must match — see addFile.
  zip64: boolean;
}

/**
 * Streaming store-only ZIP writer: emits the archive to `write` as bytes arrive,
 * so a multi-gigabyte folder never has to live in memory (pair it with the File
 * System Access API to stream straight to disk). Each entry uses a trailing data
 * descriptor — the CRC and size follow the data — so a file's bytes can be
 * written before they've all been seen. Drive it as: addFile, writeChunk… ,
 * closeFile, repeated per file, then finish once.
 *
 * Entries and the archive may exceed 4 GiB. Pass each file's expected size to
 * addFile so an entry over the 32-bit ceiling gets per-entry ZIP64 (64-bit sizes);
 * the archive itself is promoted automatically — a ZIP64 end-of-central-directory
 * record — once its offsets pass 4 GiB or it holds more than 65535 entries. Smaller
 * archives stay classic for the widest unzipper compatibility; pass
 * { forceZip64: true } to use ZIP64 unconditionally.
 */
export class ZipStream {
  private readonly central: CentralRecord[] = [];
  private offset = 0;
  // The in-flight entry. `crc` is the running, not-yet-finalized accumulator
  // (closeFile folds it with the final XOR); `offset` is its local-header start;
  // `zip64` is whether the local header reserved 64-bit fields (from the hint).
  private cur: { nameBytes: Uint8Array; offset: number; crc: number; size: number; zip64: boolean } | null = null;
  // Not constructor parameter properties: Node's --experimental-strip-types (used
  // by the unit runner) can strip types but not generate the field assignments.
  private readonly write: ZipWrite;
  private readonly forceZip64: boolean;

  constructor(write: ZipWrite, opts: { forceZip64?: boolean } = {}) {
    this.write = write;
    this.forceZip64 = opts.forceZip64 ?? false;
  }

  /**
   * Begin an entry. `sizeHint` is the expected uncompressed size (the receiver
   * passes the manifest size). It only decides whether the local header reserves
   * 64-bit fields, so an over-estimate is harmless (a small file in ZIP64 form)
   * and the trailing descriptor always carries the true size.
   */
  async addFile(name: string, sizeHint = 0): Promise<void> {
    if (this.cur) throw new Error("ZipStream: addFile() before the previous closeFile()");
    const nameBytes = new TextEncoder().encode(name);
    // `>=`, not `>`: 0xFFFFFFFF is itself the ZIP64 sentinel, so a value of exactly
    // that can't sit in a 32-bit slot and must go ZIP64 too.
    const zip64 = this.forceZip64 || sizeHint >= MAX32;
    // A ZIP64 entry carries a 20-byte extra field (a 4-byte tag/length + two 8-byte
    // sizes); together with the 0xFFFFFFFF size sentinels below, that marks the
    // entry ZIP64 so its trailing descriptor's sizes are read as 64-bit. version-
    // needed is set to 45 to advertise the requirement. The sizes in the extra stay
    // zero while streaming.
    const extraLen = zip64 ? 20 : 0;
    const header = new Uint8Array(30 + nameBytes.length + extraLen);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true); // local file header signature
    v.setUint16(4, zip64 ? 45 : 20, true); // version needed (45 = ZIP64)
    v.setUint16(6, 0x0808, true); // flags: data descriptor (bit 3) + UTF-8 names (bit 11)
    v.setUint16(8, 0, true); // method: store
    v.setUint16(10, 0, true); // time
    v.setUint16(12, 0x0021, true); // date: 1980-01-01
    // CRC and sizes live in the trailing data descriptor (the bit-3 flag). A ZIP64
    // entry parks the 0xFFFFFFFF sentinel in the 32-bit size slots, deferring to
    // the extra field (whose sizes are likewise unknown while streaming, so zero).
    if (zip64) {
      v.setUint32(18, MAX32, true);
      v.setUint32(22, MAX32, true);
    }
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, extraLen, true);
    header.set(nameBytes, 30);
    if (zip64) {
      const e = new DataView(header.buffer, 30 + nameBytes.length, extraLen);
      e.setUint16(0, 0x0001, true); // ZIP64 extended information tag
      e.setUint16(2, 16, true); // data size: two 8-byte size fields follow
    }
    await this.write(header);
    this.cur = { nameBytes, offset: this.offset, crc: 0xffffffff, size: 0, zip64 };
    this.offset += header.length;
  }

  async writeChunk(chunk: Uint8Array): Promise<void> {
    const cur = this.cur;
    if (!cur) throw new Error("ZipStream: writeChunk() before addFile()");
    let crc = cur.crc;
    for (let i = 0; i < chunk.length; i += 1) {
      crc = (CRC_TABLE[(crc ^ chunk[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
    }
    cur.crc = crc;
    cur.size += chunk.length;
    await this.write(chunk);
    this.offset += chunk.length;
  }

  async closeFile(): Promise<void> {
    const cur = this.cur;
    if (!cur) throw new Error("ZipStream: closeFile() before addFile()");
    // The local header already committed to classic 32-bit fields when the hint
    // was under 4 GiB; if the actual stream blew past that (a sender exceeding its
    // declared size) fail loud rather than wrap a 32-bit descriptor field.
    if (!cur.zip64 && cur.size >= MAX32) {
      throw new Error("ZipStream: entry exceeded 4 GiB without a ZIP64 size hint");
    }
    const crc = (cur.crc ^ 0xffffffff) >>> 0;
    // Data descriptor: signature + crc, then sizes — 8 bytes each for a ZIP64
    // entry (its local header declared the 64-bit form), 4 bytes each otherwise.
    const dd = new Uint8Array(cur.zip64 ? 24 : 16);
    const v = new DataView(dd.buffer);
    v.setUint32(0, 0x08074b50, true);
    v.setUint32(4, crc, true);
    if (cur.zip64) {
      v.setBigUint64(8, BigInt(cur.size), true); // compressed size
      v.setBigUint64(16, BigInt(cur.size), true); // uncompressed size
    } else {
      v.setUint32(8, cur.size, true); // compressed size
      v.setUint32(12, cur.size, true); // uncompressed size
    }
    await this.write(dd);
    this.offset += dd.length;
    this.central.push({ nameBytes: cur.nameBytes, crc, size: cur.size, offset: cur.offset, zip64: cur.zip64 });
    this.cur = null;
  }

  async finish(): Promise<void> {
    if (this.cur) throw new Error("ZipStream: finish() before closeFile()");
    const centralStart = this.offset;
    let centralSize = 0;
    for (const rec of this.central) {
      // A central record goes ZIP64 if its size needs 64 bits (it already did
      // locally), or it sits past the 4 GiB mark so its offset needs 64 bits. The
      // extra field carries, in fixed order, only the fields whose 32-bit slot is
      // the sentinel: paired uncompressed+compressed size, then the offset.
      const sizeOverflow = this.forceZip64 || rec.zip64 || rec.size >= MAX32;
      const offsetOverflow = this.forceZip64 || rec.offset >= MAX32;
      const extraData = (sizeOverflow ? 16 : 0) + (offsetOverflow ? 8 : 0);
      const extraLen = extraData > 0 ? 4 + extraData : 0;
      const cd = new Uint8Array(46 + rec.nameBytes.length + extraLen);
      const v = new DataView(cd.buffer);
      v.setUint32(0, 0x02014b50, true); // central directory header signature
      v.setUint16(4, extraLen > 0 ? 45 : 20, true); // version made by
      v.setUint16(6, extraLen > 0 ? 45 : 20, true); // version needed
      v.setUint16(8, 0x0808, true); // flags: data descriptor + UTF-8
      v.setUint16(10, 0, true); // method: store
      v.setUint16(12, 0, true);
      v.setUint16(14, 0x0021, true);
      v.setUint32(16, rec.crc, true);
      v.setUint32(20, sizeOverflow ? MAX32 : rec.size, true); // compressed size
      v.setUint32(24, sizeOverflow ? MAX32 : rec.size, true); // uncompressed size
      v.setUint16(28, rec.nameBytes.length, true);
      v.setUint16(30, extraLen, true);
      v.setUint32(42, offsetOverflow ? MAX32 : rec.offset, true); // local header offset
      cd.set(rec.nameBytes, 46);
      if (extraLen > 0) {
        const e = new DataView(cd.buffer, 46 + rec.nameBytes.length, extraLen);
        e.setUint16(0, 0x0001, true); // ZIP64 extended information tag
        e.setUint16(2, extraData, true);
        let p = 4;
        if (sizeOverflow) {
          e.setBigUint64(p, BigInt(rec.size), true); // uncompressed size
          e.setBigUint64(p + 8, BigInt(rec.size), true); // compressed size
          p += 16;
        }
        if (offsetOverflow) e.setBigUint64(p, BigInt(rec.offset), true); // local header offset
      }
      await this.write(cd);
      centralSize += cd.length;
    }

    const count = this.central.length;
    // `>=` the sentinels, not `>`: 0xFFFF and 0xFFFFFFFF are themselves the "look
    // in the ZIP64 record" markers, so a value of exactly that must go ZIP64 too.
    if (this.forceZip64 || count >= 0xffff || centralStart >= MAX32 || centralSize >= MAX32) {
      // ZIP64 end-of-central-directory record + locator precede the classic EOCD,
      // whose count/size/offset fields then hold the 0xFFFF / 0xFFFFFFFF sentinel
      // only for whichever value overflowed (real values otherwise, e.g. a forced
      // small archive), pointing readers back here for the 64-bit truth.
      const z = new Uint8Array(56);
      const zv = new DataView(z.buffer);
      zv.setUint32(0, 0x06064b50, true); // ZIP64 EOCD signature
      zv.setBigUint64(4, 44n, true); // size of the record after this field
      zv.setUint16(12, 45, true); // version made by
      zv.setUint16(14, 45, true); // version needed
      zv.setUint32(16, 0, true); // this disk
      zv.setUint32(20, 0, true); // disk with the central directory
      zv.setBigUint64(24, BigInt(count), true); // entries on this disk
      zv.setBigUint64(32, BigInt(count), true); // total entries
      zv.setBigUint64(40, BigInt(centralSize), true);
      zv.setBigUint64(48, BigInt(centralStart), true);
      await this.write(z);

      const loc = new Uint8Array(20);
      const lv = new DataView(loc.buffer);
      lv.setUint32(0, 0x07064b50, true); // ZIP64 EOCD locator signature
      lv.setUint32(4, 0, true); // disk with the ZIP64 EOCD
      lv.setBigUint64(8, BigInt(centralStart + centralSize), true); // its offset
      lv.setUint32(16, 1, true); // total disks
      await this.write(loc);
    }

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); // end of central directory signature
    ev.setUint16(8, Math.min(count, 0xffff), true);
    ev.setUint16(10, Math.min(count, 0xffff), true);
    ev.setUint32(12, Math.min(centralSize, MAX32), true);
    ev.setUint32(16, Math.min(centralStart, MAX32), true);
    await this.write(eocd);
  }
}
