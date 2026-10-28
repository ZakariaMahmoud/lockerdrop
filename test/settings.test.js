import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettings, normalizeBaseUrl, normalizeLimitMb } from '../src/settings.js';
import { generateToken, hashToken, tokenMatches } from '../src/tokens.js';

test('normalizeBaseUrl accepts bare hosts and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('192.168.1.20:8080'), 'http://192.168.1.20:8080');
  assert.equal(normalizeBaseUrl(' https://abc.trycloudflare.com/ '), 'https://abc.trycloudflare.com');
  assert.equal(normalizeBaseUrl('http://[fd00::1]:8080'), 'http://[fd00::1]:8080');
  assert.equal(normalizeBaseUrl(''), null);
  assert.equal(normalizeBaseUrl(null), null);
});

test('normalizeBaseUrl rejects unsafe or malformed addresses', () => {
  for (const bad of ['ftp://host', 'javascript:alert(1)', 'http://u:p@host', 'http://host/path',
    'http://host?x=1', 'http://exa mple', 'x'.repeat(400), 42]) {
    assert.throws(() => normalizeBaseUrl(bad), { status: 400 }, String(bad));
  }
});

test('settings persist across restarts and only save provided keys', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lockerdrop-settings-'));
  try {
    const first = await createSettings(dir);
    assert.deepEqual(first.get(), {});
    await first.update({ lanUrl: '10.0.0.9:8080' });
    assert.deepEqual(first.get(), { lanUrl: 'http://10.0.0.9:8080' });
    await first.update({ publicUrl: '' });
    const reloaded = await createSettings(dir);
    assert.deepEqual(reloaded.get(), { lanUrl: 'http://10.0.0.9:8080', publicUrl: null });

    await fs.writeFile(path.join(dir, 'settings.json'), '{not json');
    await assert.rejects(createSettings(dir), /Cannot read/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('owner tokens match only their own hash', () => {
  const token = generateToken();
  const hash = hashToken(token);
  assert.equal(tokenMatches(token, hash), true);
  assert.equal(tokenMatches(generateToken(), hash), false);
  assert.equal(tokenMatches('', hash), false);
  assert.equal(tokenMatches(undefined, hash), false);
  assert.equal(tokenMatches('x'.repeat(300), hash), false);
  assert.equal(tokenMatches(token, null), false);
  assert.equal(tokenMatches(token, 'nothex'), false);
});

test('normalizeLimitMb accepts whole MB, empty means unlimited', () => {
  assert.equal(normalizeLimitMb(10240), 10240);
  assert.equal(normalizeLimitMb('512'), 512);
  assert.equal(normalizeLimitMb(''), null);
  assert.equal(normalizeLimitMb(null), null);
  for (const bad of [0, -1, 1.5, 'lots', 1e12]) assert.throws(() => normalizeLimitMb(bad), { status: 400 }, String(bad));
});
