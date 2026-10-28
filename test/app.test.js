import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { createSettings } from '../src/settings.js';
import { createApp } from '../src/app.js';

const KEY = 'test-admin-key-123';
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TUNNEL = { 'CF-Connecting-IP': '203.0.113.9' };
let dir;
let server;
let base;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lockerdrop-app-'));
  const store = createStore(dir);
  await store.init();
  const settings = await createSettings(dir);
  const handler = createApp({
    store,
    settings,
    adminKey: KEY,
    publicDir,
    maxUploadBytes: 1024,
    publicUrl: 'https://env.example.com',
    lanUrls: ['http://192.168.1.50:8080', 'http://10.0.0.5:8080'],
    defaultWorkspaceLimitMb: 1,
    logger: { error() {} },
  });
  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
});

const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const asAdmin = (init = {}) => ({ ...init, headers: { 'X-Admin-Key': KEY, ...init.headers } });
const asOwner = (token, init = {}) => ({ ...init, headers: { 'X-Owner-Token': token, ...init.headers } });
const call = (p, init) => fetch(base + p, init);

const adminCreate = (body) => call('/api/admin/workspaces', asAdmin({ method: 'POST', ...json(body) }));
const participantCreate = (body, headers = {}) =>
  call('/api/workspaces', { method: 'POST', ...json(body), headers: { 'Content-Type': 'application/json', ...headers } });
const upload = (code, name, body, auth) =>
  call(`/api/workspaces/${code}/files`, {
    method: 'PUT', body, headers: { 'X-File-Name': encodeURIComponent(name), ...auth.headers },
  });
const setRemoved = (code, id, removed, auth) =>
  call(`/api/workspaces/${code}/files/${id}`, {
    method: 'PATCH', body: JSON.stringify({ removed }), headers: { 'Content-Type': 'application/json', ...auth.headers },
  });

test('admin endpoints require the key', async () => {
  assert.equal((await call('/api/admin/workspaces')).status, 401);
  assert.equal((await call('/api/admin/session', { headers: { 'X-Admin-Key': 'wrong' } })).status, 401);
  assert.equal((await call('/api/admin/session', asAdmin())).status, 200);
});

test('admin and management are blocked through the tunnel', async () => {
  assert.equal((await call('/api/admin/workspaces', asAdmin({ headers: TUNNEL }))).status, 403);
  assert.equal((await call('/admin', { headers: { 'CF-Ray': 'x' } })).status, 403);
  assert.equal((await participantCreate({ name: 'x' }, TUNNEL)).status, 403);
  assert.equal((await call('/api/workspaces/Abcd', asAdmin({ headers: TUNNEL }))).status, 403);
});

test('config tells the home page what this visitor may do', async () => {
  const local = (await (await call('/api/config')).json()).data;
  assert.equal(local.canCreate, true);
  assert.deepEqual(local.links, { lan: 'http://192.168.1.50:8080', tunnel: 'https://env.example.com' });
  const remote = (await (await call('/api/config', { headers: TUNNEL })).json()).data;
  assert.equal(remote.canCreate, false);
  assert.equal(remote.links, null);
});

test('admin flow: create, upload, receive, download, soft remove, restore', async () => {
  assert.equal((await adminCreate({ code: 'Cl4ss', name: 'Class notes' })).status, 201);
  const up = await upload('Cl4ss', 'résumé "v2".txt', 'hello world', asAdmin());
  assert.equal(up.status, 201);
  const { data: file } = await up.json();

  const view = await (await call('/api/w/Cl4ss')).json();
  assert.equal(view.data.name, 'Class notes');
  assert.deepEqual(view.data.files.map((f) => f.name), ['résumé "v2".txt']);
  assert.equal('removed' in view.data.files[0], false);

  const dl = await call(`/api/w/Cl4ss/files/${file.id}`);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="r_sum_ _v2_.txt"; filename\*=UTF-8''r%C3%A9sum%C3%A9/);
  assert.equal(await dl.text(), 'hello world');

  assert.equal((await setRemoved('Cl4ss', file.id, true, asAdmin())).status, 200);
  assert.equal((await (await call('/api/w/Cl4ss')).json()).data.files.length, 0);
  assert.equal((await call(`/api/w/Cl4ss/files/${file.id}`)).status, 404);
  const managed = await (await call('/api/workspaces/Cl4ss', asAdmin())).json();
  assert.equal(managed.data.files[0].removed, true);

  assert.equal((await setRemoved('Cl4ss', file.id, false, asAdmin())).status, 200);
  assert.equal((await call(`/api/w/Cl4ss/files/${file.id}`)).status, 200);

  const list = await (await call('/api/admin/workspaces', asAdmin())).json();
  assert.ok(list.data.some((w) => w.code === 'Cl4ss' && w.fileCount === 1 && w.createdBy === 'admin'));
});

test('participants create workspaces and manage only their own', async () => {
  const res = await participantCreate({ name: 'Group 2', code: 'Grp2x' });
  assert.equal(res.status, 201);
  const { data } = await res.json();
  assert.equal(data.workspace.createdBy, 'participant');
  assert.match(data.ownerToken, /^[A-Za-z0-9_-]{32}$/);
  assert.equal('ownerTokenHash' in data.workspace, false);
  const token = data.ownerToken;

  const up = await upload('Grp2x', 'notes.txt', 'abc', asOwner(token));
  assert.equal(up.status, 201);
  const { data: file } = await up.json();
  assert.equal((await setRemoved('Grp2x', file.id, true, asOwner(token))).status, 200);
  const own = await (await call('/api/workspaces/Grp2x', asOwner(token))).json();
  assert.equal(own.success, true);
  assert.equal('ownerTokenHash' in own.data, false);

  // The token does not unlock anyone else's workspace, and no token unlocks nothing.
  await adminCreate({ code: 'Other' });
  assert.equal((await upload('Other', 'x.txt', 'x', asOwner(token))).status, 401);
  assert.equal((await call('/api/workspaces/Grp2x')).status, 401);
  // The admin can still manage participant workspaces.
  assert.equal((await setRemoved('Grp2x', file.id, false, asAdmin())).status, 200);

  const list = await (await call('/api/admin/workspaces', asAdmin())).json();
  assert.ok(list.data.some((w) => w.code === 'Grp2x' && w.createdBy === 'participant'));
});

test('participant creation validates input and generates codes', async () => {
  assert.equal((await participantCreate({}, { 'X-Forwarded-Host': 'proxy' })).status, 403);
  const gen = await (await participantCreate({ name: '' })).json();
  assert.match(gen.data.workspace.code, /^[1-9A-Za-z]{8}$/);
  assert.equal(gen.data.workspace.name, 'Untitled workspace');
  assert.equal((await participantCreate({ code: gen.data.workspace.code })).status, 409);
  assert.equal((await participantCreate({ code: 'no' })).status, 400);
});

test('JSON endpoints reject other content types and cross-site origins', async () => {
  const plain = await call('/api/workspaces', { method: 'POST', body: '{"name":"x"}', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(plain.status, 415);
  const crossSite = await participantCreate({ name: 'x' }, { Origin: 'http://evil.example' });
  assert.equal(crossSite.status, 403);
  const sameSite = await participantCreate({ name: 'ok' }, { Origin: base });
  assert.equal(sameSite.status, 201);
});

test('workspace creation validates input', async () => {
  assert.equal((await adminCreate({ code: 'ab0c' })).status, 400);
  assert.equal((await adminCreate({ code: 'abcdefghij' })).status, 400);
  const bad = await call('/api/admin/workspaces', asAdmin({ method: 'POST', ...json([1]) }));
  assert.equal(bad.status, 400);
});

test('admin edits share-link addresses; everyone sees the result', async () => {
  const save = (body) => call('/api/admin/settings', asAdmin({ method: 'PUT', ...json(body) }));
  const res = await save({ lanUrl: '192.168.1.77:8080', publicUrl: 'https://abc.trycloudflare.com/' });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.deepEqual(data.links, { lan: 'http://192.168.1.77:8080', tunnel: 'https://abc.trycloudflare.com' });
  assert.deepEqual(data.detectedLanUrls, ['http://192.168.1.50:8080', 'http://10.0.0.5:8080']);

  const cfg = (await (await call('/api/config')).json()).data;
  assert.equal(cfg.links.lan, 'http://192.168.1.77:8080');

  assert.equal((await save({ lanUrl: 'ftp://x' })).status, 400);
  assert.equal((await save({ lanUrl: 'http://x/path' })).status, 400);

  // Empty LAN → back to auto-detected; empty tunnel → no tunnel link.
  const cleared = (await (await save({ lanUrl: '', publicUrl: '' })).json()).data;
  assert.deepEqual(cleared.links, { lan: 'http://192.168.1.50:8080', tunnel: null });
  assert.equal((await call('/api/admin/settings', { method: 'PUT', ...json({ lanUrl: 'x' }) })).status, 401);
});

test('admin sets the per-workspace storage limit; uploads beyond it are refused', async () => {
  const save = (body) => call('/api/admin/settings', asAdmin({ method: 'PUT', ...json(body) }));
  await adminCreate({ code: 'Full1' });
  const before = (await (await call('/api/workspaces/Full1', asAdmin())).json()).data;
  assert.equal(before.quotaBytes, 1024 * 1024); // default from config: 1 MB
  assert.equal(before.usedBytes, 0);

  // The setting overrides the default; empty means unlimited.
  const view = (await (await save({ workspaceLimitMb: 1 })).json()).data;
  assert.equal(view.workspaceQuotaBytes, 1024 * 1024);
  assert.equal((await save({ workspaceLimitMb: 0 })).status, 400);

  const unlimited = (await (await save({ workspaceLimitMb: '' })).json()).data;
  assert.equal(unlimited.workspaceQuotaBytes, null);
  const after = (await (await call('/api/workspaces/Full1', asAdmin())).json()).data;
  assert.equal(after.quotaBytes, null);
  await save({ workspaceLimitMb: 1 });
});

test('a full workspace refuses uploads with a clear message', async () => {
  await adminCreate({ code: 'Full2' });
  const chunk = 'x'.repeat(1000);
  let res;
  for (let i = 0; i < 1100; i += 1) {
    res = await upload('Full2', `f${i}.txt`, chunk, asAdmin());
    if (res.status !== 201) break;
  }
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /workspace is full/);
});

test('only the admin can permanently delete, and only removed files', async () => {
  const { data } = await (await participantCreate({ code: 'Prg1x' })).json();
  const owner = asOwner(data.ownerToken);
  const { data: file } = await (await upload('Prg1x', 'old.zip', 'zip', owner)).json();
  const purge = (p, auth) => call(p, { method: 'DELETE', ...auth });

  assert.equal((await purge(`/api/admin/workspaces/Prg1x/files/${file.id}`, asAdmin())).status, 409);
  await setRemoved('Prg1x', file.id, true, owner);
  assert.equal((await purge(`/api/admin/workspaces/Prg1x/files/${file.id}`, owner)).status, 401);
  assert.equal((await purge(`/api/admin/workspaces/Prg1x/files/${file.id}`, asAdmin({ headers: TUNNEL }))).status, 403);

  const res = await purge(`/api/admin/workspaces/Prg1x/files/${file.id}`, asAdmin());
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, { deletedCount: 1, freedBytes: 3 });
  const ws = (await (await call('/api/workspaces/Prg1x', owner)).json()).data;
  assert.deepEqual([ws.files.length, ws.usedBytes], [0, 0]);

  assert.equal((await purge('/api/admin/workspaces/Prg1x/removed', asAdmin())).status, 200);
  assert.equal((await purge('/api/admin/workspaces/Nope1/removed', asAdmin())).status, 404);
});

test('a deleted workspace is gone for everyone', async () => {
  const { data } = await (await participantCreate({ code: 'Gone1' })).json();
  const owner = asOwner(data.ownerToken);
  await upload('Gone1', 'a.txt', 'abc', owner);
  const del = (auth) => call('/api/workspaces/Gone1', { method: 'DELETE', ...auth });

  assert.equal((await del(asAdmin({ headers: TUNNEL }))).status, 403);
  const res = await del(asAdmin());
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, { code: 'Gone1', deletedFiles: 1, freedBytes: 3 });

  assert.equal((await call('/api/w/Gone1')).status, 404);
  assert.equal((await call('/api/workspaces/Gone1', owner)).status, 401); // the owner token is now useless
  assert.equal((await del(asAdmin())).status, 404);
  const list = (await (await call('/api/admin/workspaces', asAdmin())).json()).data;
  assert.equal(list.some((w) => w.code === 'Gone1'), false);
});

test('participants can delete their own workspace, but nobody else\'s', async () => {
  const mine = (await (await participantCreate({ code: 'Mine1' })).json()).data;
  const theirs = (await (await participantCreate({ code: 'Their1' })).json()).data;
  const del = (code, auth) => call(`/api/workspaces/${code}`, { method: 'DELETE', ...auth });
  await upload('Mine1', 'a.txt', 'abcd', asOwner(mine.ownerToken));

  assert.equal((await del('Their1', asOwner(mine.ownerToken))).status, 401);
  assert.equal((await del('Mine1')).status, 401);
  assert.equal((await del('Mine1', { headers: { ...TUNNEL, 'X-Owner-Token': mine.ownerToken } })).status, 403);

  const res = await del('Mine1', asOwner(mine.ownerToken));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, { code: 'Mine1', deletedFiles: 1, freedBytes: 4 });
  assert.equal((await call('/api/w/Mine1')).status, 404);

  // The admin can delete any workspace through the same route.
  assert.equal((await del('Their1', asAdmin())).status, 200);
  assert.equal((await call('/api/w/Their1')).status, 404);
});

test('download all returns one ZIP of the visible files', async () => {
  await adminCreate({ code: 'Zip1', name: 'Week 4 / labs' });
  assert.equal((await call('/api/w/Zip1/zip')).status, 409); // nothing to zip yet
  await upload('Zip1', 'a.txt', 'alpha', asAdmin());
  await upload('Zip1', 'a.txt', 'second a', asAdmin());
  const hidden = (await (await upload('Zip1', 'secret.txt', 'hidden', asAdmin())).json()).data;
  await setRemoved('Zip1', hidden.id, true, asAdmin());

  const head = await call('/api/w/Zip1/zip', { method: 'HEAD' });
  assert.equal(head.status, 200);
  const res = await call('/api/w/Zip1/zip');
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /filename="Week 4 _ labs.zip"/);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, Number(res.headers.get('content-length')));
  assert.equal(head.headers.get('content-length'), res.headers.get('content-length'));
  const text = body.toString('latin1');
  assert.ok(text.includes('a.txt') && text.includes('a (2).txt'));
  assert.equal(text.includes('secret.txt'), false); // removed files are not included
  assert.equal((await call('/api/w/Nope9/zip')).status, 404);
});

test('downloads with ?t= report progress the page can poll', async () => {
  await adminCreate({ code: 'Prog1' });
  const { data: file } = await (await upload('Prog1', 'big.bin', 'x'.repeat(900), asAdmin())).json();
  await upload('Prog1', 'small.bin', 'y'.repeat(50), asAdmin());
  const id = 'c'.repeat(32);
  const zipId = 'd'.repeat(32);

  assert.equal((await call(`/api/downloads/${id}`)).status, 404); // not started yet
  const body = await (await call(`/api/w/Prog1/files/${file.id}?t=${id}`)).arrayBuffer();
  assert.equal(body.byteLength, 900);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual((await (await call(`/api/downloads/${id}`)).json()).data, { totalBytes: 900, sentBytes: 900, state: 'done' });

  const zip = await call(`/api/w/Prog1/zip?t=${zipId}`);
  const zipBytes = (await zip.arrayBuffer()).byteLength;
  await new Promise((r) => setTimeout(r, 20));
  const zipProgress = (await (await call(`/api/downloads/${zipId}`)).json()).data;
  assert.deepEqual(zipProgress, { totalBytes: zipBytes, sentBytes: zipBytes, state: 'done' });

  // Bad ids are simply not tracked; the download still works.
  assert.equal((await call(`/api/w/Prog1/files/${file.id}?t=nope`)).status, 200);
  assert.equal((await call('/api/downloads/nope')).status, 404);
});

test('upload rejects missing names, oversized files and unknown workspaces', async () => {
  await adminCreate({ code: 'Up1d' });
  const noName = await call('/api/workspaces/Up1d/files', asAdmin({ method: 'PUT', body: 'x' }));
  assert.equal(noName.status, 400);
  assert.equal((await upload('Up1d', 'big.bin', 'x'.repeat(2048), asAdmin())).status, 413);
  assert.equal((await upload('Nope', 'a.txt', 'x', asAdmin())).status, 404);
});

test('PATCH validates its body', async () => {
  await adminCreate({ code: 'Ptch' });
  const res = await call('/api/workspaces/Ptch/files/abc', asAdmin({ method: 'PATCH', ...json({ removed: 'yes' }) }));
  assert.equal(res.status, 400);
});

test('serves static pages with security headers and 404s unknown paths', async () => {
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await call('/admin')).status, 200);
  assert.equal((await call('/manager.js')).status, 200);
  assert.equal((await call('/transfers.js')).status, 200);
  assert.equal((await call('/../src/app.js')).status, 404);
  assert.equal((await call('/api/unknown')).status, 404);
});

test('download misses look the same whether or not the code exists', async () => {
  await adminCreate({ code: 'Real' });
  const headers = { 'CF-Connecting-IP': '198.51.100.20' };
  const fakeId = 'a'.repeat(32);
  const realCode = await (await call(`/api/w/Real/files/${fakeId}`, { headers })).json();
  const fakeCode = await (await call(`/api/w/Fake/files/${fakeId}`, { headers })).json();
  assert.deepEqual(realCode, fakeCode);
});

test('download probing is rate limited too', async () => {
  const headers = { 'CF-Connecting-IP': '198.51.100.21' };
  let last;
  for (let i = 0; i < 16; i += 1) last = await call(`/api/w/Prb${i % 9 + 1}/files/${'b'.repeat(32)}`, { headers });
  assert.equal(last.status, 429);
});

test('wrong codes are rate limited per client', async () => {
  const headers = { 'CF-Connecting-IP': '198.51.100.7' };
  let last;
  for (let i = 0; i < 16; i += 1) last = await call(`/api/w/Zzzz${i % 9 + 1}`, { headers });
  assert.equal(last.status, 429);
  const other = await call('/api/w/Zzzz1', { headers: { 'CF-Connecting-IP': '198.51.100.8' } });
  assert.equal(other.status, 404);
});

test('wrong owner tokens are rate limited without locking out the admin', async () => {
  let last;
  for (let i = 0; i < 11; i += 1) last = await call('/api/workspaces/Grp2x', asOwner(`bad-${i}`));
  assert.equal(last.status, 429);
  assert.equal((await call('/api/workspaces/Grp2x', asAdmin())).status, 200);
});

test('every create attempt counts, so 409s cannot probe codes forever', async () => {
  // Runs last: it exhausts 127.0.0.1's creation budget.
  let last;
  for (let i = 0; i < 31; i += 1) last = await participantCreate({ code: 'Grp2x' });
  assert.equal(last.status, 429);
});
