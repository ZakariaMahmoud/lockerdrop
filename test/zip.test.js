import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { crc32, crc32Fallback, crc32OfFile } from '../src/crc32.js';
import { buildZipLayout, streamZip, uniqueNames } from '../src/zip.js';

const hasPython = (() => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Independent check: Python's zipfile verifies every CRC and returns contents.
const PY_CHECK = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    print(json.dumps({"bad": bad, "files": {i.filename: z.read(i).decode("utf-8") for i in z.infolist()}}))
`;

let dir;
before(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lockerdrop-zip-')); });
after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

async function makeEntries(files) {
  return Promise.all(Object.entries(files).map(async ([name, text], i) => {
    const filePath = path.join(dir, `f${i}`);
    await fs.writeFile(filePath, text);
    return { name, size: Buffer.byteLength(text), crc32: await crc32OfFile(filePath), mtime: '2026-10-27T12:00:00Z', filePath };
  }));
}

async function zipToBuffer(entries, options) {
  const layout = buildZipLayout(entries, options);
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  await streamZip(layout, entries, out);
  return { layout, data: Buffer.concat(chunks) };
}

function pythonRead(data, name) {
  const file = path.join(dir, name);
  return fs.writeFile(file, data).then(() => JSON.parse(execFileSync('python3', ['-c', PY_CHECK, file]).toString()));
}

test('crc32 matches the standard check values, native and fallback', () => {
  for (const fn of [crc32, crc32Fallback]) {
    assert.equal(fn(Buffer.from('123456789')), 0xcbf43926);
    assert.equal(fn(Buffer.from('world'), fn(Buffer.from('hello '))), fn(Buffer.from('hello world')));
    assert.equal(fn(Buffer.alloc(0)), 0);
  }
});

test('uniqueNames de-duplicates case-insensitively, keeping extensions', () => {
  assert.deepEqual(
    uniqueNames(['a.txt', 'A.txt', 'a.txt', 'a (2).txt', 'README', 'readme']),
    ['a.txt', 'A (2).txt', 'a (3).txt', 'a (2) (2).txt', 'README', 'readme (2)'],
  );
});

test('archive length equals the planned Content-Length', async () => {
  const entries = await makeEntries({ 'a.txt': 'hello', 'b.txt': '' });
  const { layout, data } = await zipToBuffer(entries);
  assert.equal(data.length, layout.totalSize);
  assert.equal(data.readUInt32LE(0), 0x04034b50);
  assert.equal(data.readUInt32LE(data.length - 22), 0x06054b50);
});

test('a normal archive is valid for an independent reader', { skip: !hasPython && 'python3 not found' }, async () => {
  const entries = await makeEntries({ 'notes.txt': 'hello world', 'résumé ✓.md': '# hi', 'empty.bin': '' });
  const { data } = await zipToBuffer(entries);
  const result = await pythonRead(data, 'normal.zip');
  assert.equal(result.bad, null);
  assert.deepEqual(result.files, { 'notes.txt': 'hello world', 'résumé ✓.md': '# hi', 'empty.bin': '' });
});

test('ZIP64 records (forced with a tiny threshold) are valid too', { skip: !hasPython && 'python3 not found' }, async () => {
  const entries = await makeEntries({ 'one.txt': 'x'.repeat(40), 'two.txt': 'second file', 'three.txt': 'y' });
  const { layout, data } = await zipToBuffer(entries, { zip64Threshold: 10 });
  assert.equal(data.length, layout.totalSize);
  assert.ok(data.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'has a ZIP64 end record');
  const result = await pythonRead(data, 'zip64.zip');
  assert.equal(result.bad, null);
  assert.deepEqual(result.files, { 'one.txt': 'x'.repeat(40), 'two.txt': 'second file', 'three.txt': 'y' });
});
