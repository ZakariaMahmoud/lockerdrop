import zlib from 'node:zlib';
import { createReadStream } from 'node:fs';

const TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32Js(buf, previous) {
  let c = ~previous;
  for (const byte of buf) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * CRC-32 (as used by ZIP), continuing from `previous`. Uses the native
 * implementation when available (Node ≥ 22.2), otherwise a table version.
 */
export const crc32 = typeof zlib.crc32 === 'function'
  ? (buf, previous = 0) => zlib.crc32(buf, previous)
  : (buf, previous = 0) => crc32Js(buf, previous);

export { crc32Js as crc32Fallback };

export async function crc32OfFile(filePath) {
  let crc = 0;
  for await (const chunk of createReadStream(filePath)) crc = crc32(chunk, crc);
  return crc;
}
