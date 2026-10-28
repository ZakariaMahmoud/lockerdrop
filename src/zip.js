import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

// Streaming ZIP writer, "stored" (no compression). Every size and CRC is known
// before the first byte is sent, so the archive needs no data descriptors and
// its exact length can be sent as Content-Length. ZIP64 records are added only
// where a size or offset needs them, which keeps small archives maximally
// compatible.

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
const UTF8_FLAG = 0x0800;
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
const EMPTY = Buffer.alloc(0);

function dosDateTime(value) {
  const d = new Date(value);
  const valid = !Number.isNaN(d.getTime());
  const date = valid ? d : new Date(1980, 0, 1);
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function zip64Extra(values) {
  const buf = Buffer.alloc(4 + 8 * values.length);
  buf.writeUInt16LE(0x0001, 0);
  buf.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => buf.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return buf;
}

/** Makes names unique inside the archive: "a.txt", "a (2).txt", "a (3).txt". */
export function uniqueNames(names) {
  const used = new Set();
  return names.map((name) => {
    if (!used.has(name.toLowerCase())) {
      used.add(name.toLowerCase());
      return name;
    }
    const dot = name.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let n = 2;
    while (used.has(`${base} (${n})${ext}`.toLowerCase())) n += 1;
    const unique = `${base} (${n})${ext}`;
    used.add(unique.toLowerCase());
    return unique;
  });
}

function localHeader(entry, name, big, version, stamp) {
  const head = Buffer.alloc(30);
  const extra = big ? zip64Extra([entry.size, entry.size]) : EMPTY;
  const size32 = big ? MAX32 : entry.size;
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(version, 4);
  head.writeUInt16LE(UTF8_FLAG, 6);
  head.writeUInt16LE(0, 8); // method: stored
  head.writeUInt16LE(stamp.time, 10);
  head.writeUInt16LE(stamp.date, 12);
  head.writeUInt32LE(entry.crc32, 14);
  head.writeUInt32LE(size32, 18);
  head.writeUInt32LE(size32, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(extra.length, 28);
  return Buffer.concat([head, name, extra]);
}

function centralHeader(entry, name, big, farOffset, offset, version, stamp) {
  const head = Buffer.alloc(46);
  const fields = [...(big ? [entry.size, entry.size] : []), ...(farOffset ? [offset] : [])];
  const extra = fields.length ? zip64Extra(fields) : EMPTY;
  const size32 = big ? MAX32 : entry.size;
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(VERSION_ZIP64, 4); // made by
  head.writeUInt16LE(version, 6); // needed to extract
  head.writeUInt16LE(UTF8_FLAG, 8);
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(stamp.time, 12);
  head.writeUInt16LE(stamp.date, 14);
  head.writeUInt32LE(entry.crc32, 16);
  head.writeUInt32LE(size32, 20);
  head.writeUInt32LE(size32, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt16LE(extra.length, 30);
  // comment length, disk start, internal and external attributes stay 0
  head.writeUInt32LE(farOffset ? MAX32 : offset, 42);
  return Buffer.concat([head, name, extra]);
}

function endRecords(count, cdOffset, cdSize, threshold) {
  const needZip64 = count >= MAX16 || cdOffset >= threshold || cdSize >= threshold;
  const parts = [];
  if (needZip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(VERSION_ZIP64, 12);
    record.writeUInt16LE(VERSION_ZIP64, 14);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(cdSize), 40);
    record.writeBigUInt64LE(BigInt(cdOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Math.min(count, MAX16), 8);
  eocd.writeUInt16LE(Math.min(count, MAX16), 10);
  eocd.writeUInt32LE(needZip64 && cdSize >= threshold ? MAX32 : cdSize, 12);
  eocd.writeUInt32LE(needZip64 && cdOffset >= threshold ? MAX32 : cdOffset, 16);
  parts.push(eocd);
  return parts;
}

/**
 * Plans an archive. `entries`: { name, size, crc32, mtime }.
 * `zip64Threshold` exists so tests can exercise ZIP64 with tiny files.
 * @returns {{ localHeaders: Buffer[], tail: Buffer, totalSize: number }}
 */
export function buildZipLayout(entries, { zip64Threshold = MAX32 } = {}) {
  const localHeaders = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const big = entry.size >= zip64Threshold;
    const farOffset = offset >= zip64Threshold;
    const version = big || farOffset ? VERSION_ZIP64 : VERSION_DEFAULT;
    const stamp = dosDateTime(entry.mtime);
    const local = localHeader(entry, name, big, version, stamp);
    localHeaders.push(local);
    centrals.push(centralHeader(entry, name, big, farOffset, offset, version, stamp));
    offset += local.length + entry.size;
  }
  const centralDirectory = Buffer.concat(centrals);
  const tail = Buffer.concat([
    centralDirectory,
    ...endRecords(entries.length, offset, centralDirectory.length, zip64Threshold),
  ]);
  return { localHeaders, tail, totalSize: offset + tail.length };
}

const write = (out, buf) => new Promise((resolve, reject) => {
  out.write(buf, (err) => (err ? reject(err) : resolve()));
});

/** Streams the planned archive; `entries[i].filePath` holds each file's data. */
export async function streamZip(layout, entries, out) {
  for (let i = 0; i < entries.length; i += 1) {
    await write(out, layout.localHeaders[i]);
    await pipeline(createReadStream(entries[i].filePath), out, { end: false });
  }
  await write(out, layout.tail);
  out.end();
}
