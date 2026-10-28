import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createStore } from '../src/store.js';
import { loadAdminKey } from '../src/admin-key.js';
import { generateToken, hashToken } from '../src/tokens.js';

let dir;
let store;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lockerdrop-store-'));
  store = createStore(dir);
  await store.init();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const streamOf = (text) => Readable.from([Buffer.from(text)]);

test('creates, lists and rejects duplicate workspaces', async () => {
  const ws = await store.createWorkspace({ code: 'Abc123', name: 'Class' });
  assert.deepEqual({ code: ws.code, name: ws.name, fileCount: ws.fileCount }, { code: 'Abc123', name: 'Class', fileCount: 0 });
  await assert.rejects(store.createWorkspace({ code: 'Abc123', name: 'Again' }), { status: 409 });
  const list = await store.listWorkspaces();
  assert.equal(list.length, 1);
});

test('codes are case-sensitive', async () => {
  await store.createWorkspace({ code: 'abcd', name: 'lower' });
  await store.createWorkspace({ code: 'ABCD', name: 'upper' });
  assert.equal((await store.getWorkspace('abcd')).name, 'lower');
  assert.equal((await store.getWorkspace('ABCD')).name, 'upper');
});

test('rejects invalid codes before touching the filesystem', async () => {
  await assert.rejects(store.getWorkspace('../x'), { status: 400 });
  await assert.rejects(store.getWorkspace('zzzz'), { status: 404 });
});

test('adds files, soft-removes and restores them', async () => {
  await store.createWorkspace({ code: 'Work', name: 'w' });
  const file = await store.addFile('Work', { name: 'a.txt', stream: streamOf('hello'), maxBytes: 100 });
  assert.equal(file.size, 5);

  const removed = await store.setFileRemoved('Work', file.id, true);
  assert.equal(removed.removed, true);
  assert.equal((await store.getWorkspace('Work')).files.length, 0);
  assert.equal((await store.getWorkspace('Work', { includeRemoved: true })).files.length, 1);
  await assert.rejects(store.getActiveFile('Work', file.id), { status: 404 });

  // File is still on disk: removal is not a real delete.
  const onDisk = await fs.readFile(path.join(dir, 'workspaces', 'Work', 'files', file.id), 'utf8');
  assert.equal(onDisk, 'hello');

  await store.setFileRemoved('Work', file.id, false);
  const { filePath } = await store.getActiveFile('Work', file.id);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'hello');
});

test('enforces the size limit and cleans up partial uploads', async () => {
  await store.createWorkspace({ code: 'Big1', name: 'b' });
  await assert.rejects(
    store.addFile('Big1', { name: 'x', stream: streamOf('0123456789'), maxBytes: 5 }),
    { status: 413 },
  );
  const leftovers = await fs.readdir(path.join(dir, 'workspaces', 'Big1', 'files'));
  assert.deepEqual(leftovers, []);
  assert.equal((await store.getWorkspace('Big1')).files.length, 0);
});

test('concurrent uploads are all recorded', async () => {
  await store.createWorkspace({ code: 'Many', name: 'm' });
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      store.addFile('Many', { name: `f${i}`, stream: streamOf(`x${i}`), maxBytes: 100 })),
  );
  assert.equal((await store.getWorkspace('Many')).files.length, 10);
});

test('unknown file ids are not found', async () => {
  await store.createWorkspace({ code: 'Miss', name: 'm' });
  await assert.rejects(store.setFileRemoved('Miss', 'nope', true), { status: 404 });
  await assert.rejects(store.setFileRemoved('Miss', 'a'.repeat(32), true), { status: 404 });
  await assert.rejects(store.getActiveFile('Miss', 'nope'), { status: 404 });
  await assert.rejects(store.addFile('Nope', { name: 'x', stream: streamOf('x'), maxBytes: 9 }), { status: 404 });
});

test('admin key: env, generated then reused from file', async () => {
  assert.deepEqual(await loadAdminKey(dir, 'env-key-long-enough'), { key: 'env-key-long-enough', source: 'env' });
  await assert.rejects(loadAdminKey(dir, 'short'));
  const first = await loadAdminKey(dir, undefined);
  assert.equal(first.source, 'generated');
  const second = await loadAdminKey(dir, '');
  assert.deepEqual(second, { key: first.key, source: 'file' });
  const mode = (await fs.stat(path.join(dir, 'admin.key'))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('verifyOwner checks the stored token hash and hides it from reads', async () => {
  const token = generateToken();
  await store.createWorkspace({ code: 'Own1', name: 'o', createdBy: 'participant', ownerTokenHash: hashToken(token) });
  await store.createWorkspace({ code: 'Adm1', name: 'a' });
  assert.equal(await store.verifyOwner('Own1', token), true);
  assert.equal(await store.verifyOwner('Own1', 'wrong'), false);
  assert.equal(await store.verifyOwner('Adm1', token), false);
  assert.equal(await store.verifyOwner('Nope', token), false);
  assert.equal(await store.verifyOwner('../x', token), false);
  const ws = await store.getWorkspace('Own1');
  assert.equal(ws.createdBy, 'participant');
  assert.equal('ownerTokenHash' in ws, false);
});

test('workspace quota counts removed files and rejects uploads that would exceed it', async () => {
  await store.createWorkspace({ code: 'Quot', name: 'q' });
  const put = (text, extra = {}) =>
    store.addFile('Quot', { name: 'f', stream: streamOf(text), maxBytes: 100, quotaBytes: 10, ...extra });
  const first = await put('123456');
  assert.equal((await store.getWorkspace('Quot')).usedBytes, 6);
  await store.setFileRemoved('Quot', first.id, true);
  const ws = await store.getWorkspace('Quot');
  assert.deepEqual([ws.totalBytes, ws.usedBytes], [0, 6]); // removed files still use storage
  await assert.rejects(put('12345'), { status: 413, message: /workspace is full/ });
  await assert.rejects(put('1', { declaredBytes: 5 }), { status: 413 });
  await put('1234'); // exactly fills the quota
  await assert.rejects(put('1'), { status: 413 });
  const leftovers = (await fs.readdir(path.join(dir, 'workspaces', 'Quot', 'files'))).filter((f) => f.endsWith('.part'));
  assert.deepEqual(leftovers, []);
  assert.equal((await store.getWorkspace('Quot', { includeRemoved: true })).files.length, 2);
});

test('parallel uploads cannot overshoot the quota together', async () => {
  await store.createWorkspace({ code: 'Para', name: 'p' });
  const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
    store.addFile('Para', { name: 'f', stream: streamOf('x'.repeat(4)), maxBytes: 100, quotaBytes: 10 })));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  assert.ok(ok <= 2, `${ok} uploads fit in 10 bytes`);
  assert.ok((await store.getWorkspace('Para')).usedBytes <= 10);
});

test('a null quota means unlimited', async () => {
  await store.createWorkspace({ code: 'Free', name: 'f' });
  await store.addFile('Free', { name: 'f', stream: streamOf('x'.repeat(50)), maxBytes: 100, quotaBytes: null });
  assert.equal((await store.getWorkspace('Free')).usedBytes, 50);
});

test('purgeRemoved deletes only removed files, from disk and from the quota', async () => {
  await store.createWorkspace({ code: 'Purg', name: 'p' });
  const put = (text) => store.addFile('Purg', { name: 'f', stream: streamOf(text), maxBytes: 100, quotaBytes: 10 });
  const keep = await put('aaaa');
  const gone1 = await put('bbb');
  const gone2 = await put('cc');
  const filesDir = path.join(dir, 'workspaces', 'Purg', 'files');

  await assert.rejects(store.purgeRemoved('Purg', keep.id), { status: 409 });
  await assert.rejects(store.purgeRemoved('Purg', 'a'.repeat(32)), { status: 404 });
  await assert.rejects(store.purgeRemoved('Purg', 'bad'), { status: 404 });

  await store.setFileRemoved('Purg', gone1.id, true);
  await store.setFileRemoved('Purg', gone2.id, true);
  assert.deepEqual(await store.purgeRemoved('Purg', gone1.id), { deletedCount: 1, freedBytes: 3 });
  assert.deepEqual(await store.purgeRemoved('Purg'), { deletedCount: 1, freedBytes: 2 });
  assert.deepEqual(await store.purgeRemoved('Purg'), { deletedCount: 0, freedBytes: 0 });

  assert.deepEqual(await fs.readdir(filesDir), [keep.id]);
  const ws = await store.getWorkspace('Purg', { includeRemoved: true });
  assert.deepEqual([ws.files.length, ws.usedBytes], [1, 4]);
  await put('123456'); // the freed space is usable again (4 + 6 = 10)
});

test('deleteWorkspace removes everything and frees the code', async () => {
  await store.createWorkspace({ code: 'Del1', name: 'd' });
  const a = await store.addFile('Del1', { name: 'a', stream: streamOf('aaa'), maxBytes: 100 });
  await store.addFile('Del1', { name: 'b', stream: streamOf('bb'), maxBytes: 100 });
  await store.setFileRemoved('Del1', a.id, true);

  assert.deepEqual(await store.deleteWorkspace('Del1'), { code: 'Del1', deletedFiles: 2, freedBytes: 5 });
  assert.deepEqual(await fs.readdir(path.join(dir, 'workspaces')), []);
  await assert.rejects(store.getWorkspace('Del1'), { status: 404 });
  await assert.rejects(store.deleteWorkspace('Del1'), { status: 404 });
  await assert.rejects(store.deleteWorkspace('../x'), { status: 400 });

  // The code can be used again, starting empty.
  await store.createWorkspace({ code: 'Del1', name: 'again' });
  assert.equal((await store.getWorkspace('Del1')).usedBytes, 0);
});

test('an upload racing a workspace delete fails with not found', async () => {
  await store.createWorkspace({ code: 'Race', name: 'r' });
  const { PassThrough } = await import('node:stream');
  const slow = new PassThrough();
  const pending = store.addFile('Race', { name: 'x', stream: slow, maxBytes: 100 });
  slow.write('abc');
  await new Promise((r) => setTimeout(r, 20));
  const outcome = assert.rejects(pending, { status: 404 }); // the delete aborts it right away
  await store.deleteWorkspace('Race');
  slow.end('def');
  await outcome;
  await assert.rejects(store.getWorkspace('Race'), { status: 404 });
});

test('init cleans up interrupted workspace deletes', async () => {
  const leftover = path.join(dir, 'workspaces', '.deleting-Abcd-12345678');
  await fs.mkdir(path.join(leftover, 'files'), { recursive: true });
  await createStore(dir).init();
  assert.deepEqual(await fs.readdir(path.join(dir, 'workspaces')), []);
});

test('uploads record a CRC-32 and older files get one backfilled for zipping', async () => {
  await store.createWorkspace({ code: 'Crc1', name: 'c' });
  const fresh = await store.addFile('Crc1', { name: 'a', stream: streamOf('123456789'), maxBytes: 100 });
  assert.equal(fresh.crc32, 0xcbf43926);

  // Simulate a file uploaded before CRCs existed.
  const metaPath = path.join(dir, 'workspaces', 'Crc1', 'meta.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  await fs.writeFile(metaPath, JSON.stringify({ ...meta, files: meta.files.map(({ crc32: _c, ...f }) => f) }));

  const { entries } = await store.getZipEntries('Crc1');
  assert.equal(entries[0].crc32, 0xcbf43926);
  const saved = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(saved.files[0].crc32, 0xcbf43926);
});

test('deleting a workspace stops its uploads at once', async () => {
  await store.createWorkspace({ code: 'Stop1', name: 's' });
  const { PassThrough } = await import('node:stream');
  const endless = new PassThrough(); // never ends: only an abort can finish this upload
  const pending = store.addFile('Stop1', { name: 'x', stream: endless, maxBytes: 1e9 });
  endless.write('abc');
  await new Promise((r) => setTimeout(r, 20));
  const outcome = assert.rejects(pending, { status: 404 });
  await store.deleteWorkspace('Stop1');
  await outcome;
  assert.equal(endless.destroyed, true);

  // Re-creating the code starts with a clean quota (no leftover in-flight bytes).
  await store.createWorkspace({ code: 'Stop1', name: 'again' });
  await store.addFile('Stop1', { name: 'y', stream: streamOf('12345'), maxBytes: 100, quotaBytes: 5 });
});

test('init only removes trash folders it created itself', async () => {
  const ws = path.join(dir, 'workspaces');
  await fs.mkdir(path.join(ws, '.deleting-Abcd-0123abcd'), { recursive: true });
  await fs.mkdir(path.join(ws, '.deleting-notes'), { recursive: true });
  await createStore(dir).init();
  assert.deepEqual(await fs.readdir(ws), ['.deleting-notes']);
});
