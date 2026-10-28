import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientIp,
  createFailureLimiter,
  createKeyCheck,
  isLocalHost,
  isLocalRequest,
  isPrivateAddress,
  isSameOrigin,
} from '../src/access.js';

const fakeReq = (remoteAddress, headers = {}) => ({
  socket: { remoteAddress },
  headers: { host: '192.168.1.10:8080', ...headers },
});

test('isPrivateAddress recognises loopback and private ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20',
    '169.254.1.1', '::1', '::ffff:192.168.0.5', 'fd12::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1', '', 'nope']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('isLocalRequest rejects anything that came through a proxy or tunnel', () => {
  assert.equal(isLocalRequest(fakeReq('192.168.1.4')), true);
  assert.equal(isLocalRequest(fakeReq('127.0.0.1', { 'cf-ray': 'abc' })), false);
  assert.equal(isLocalRequest(fakeReq('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' })), false);
  assert.equal(isLocalRequest(fakeReq('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })), false);
  assert.equal(isLocalRequest(fakeReq('8.8.8.8')), false);
});

test('isLocalHost accepts direct LAN hosts and rejects public domains', () => {
  for (const host of ['localhost:8080', '192.168.1.10:8080', '[::1]:8080', 'my-laptop', 'nas.local', 'pc.lan:8080']) {
    assert.equal(isLocalHost(host), true, host);
  }
  for (const host of ['abc-def.trycloudflare.com', 'files.example.com:443', '', undefined]) {
    assert.equal(isLocalHost(host), false, String(host));
  }
});

test('isLocalRequest rejects tunnel hosts even with proxy headers stripped', () => {
  assert.equal(isLocalRequest(fakeReq('127.0.0.1', { host: 'abc.trycloudflare.com' })), false);
  assert.equal(isLocalRequest(fakeReq('127.0.0.1', { 'cdn-loop': 'cloudflare' })), false);
});

test('clientIp trusts cf-connecting-ip only from loopback', () => {
  assert.equal(clientIp(fakeReq('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' })), '1.2.3.4');
  assert.equal(clientIp(fakeReq('192.168.1.9', { 'cf-connecting-ip': '1.2.3.4' })), '192.168.1.9');
  assert.equal(clientIp(fakeReq('::ffff:10.0.0.2')), '10.0.0.2');
});

test('failure limiter blocks after max failures and recovers after the window', () => {
  let now = 0;
  const limiter = createFailureLimiter({ max: 3, windowMs: 1000, now: () => now });
  assert.equal(limiter.isBlocked('a'), false);
  limiter.record('a');
  limiter.record('a');
  assert.equal(limiter.isBlocked('a'), false);
  limiter.record('a');
  assert.equal(limiter.isBlocked('a'), true);
  assert.equal(limiter.isBlocked('b'), false);
  now = 1500;
  assert.equal(limiter.isBlocked('a'), false);
});

test('key check compares in constant time and rejects bad input', () => {
  const check = createKeyCheck('super-secret-key');
  assert.equal(check('super-secret-key'), true);
  assert.equal(check('super-secret-kez'), false);
  assert.equal(check(''), false);
  assert.equal(check(undefined), false);
});

test('isSameOrigin allows missing or matching Origin only', () => {
  assert.equal(isSameOrigin(fakeReq('192.168.1.4')), true);
  assert.equal(isSameOrigin(fakeReq('192.168.1.4', { origin: 'http://192.168.1.10:8080' })), true);
  assert.equal(isSameOrigin(fakeReq('192.168.1.4', { origin: 'http://evil.example' })), false);
  assert.equal(isSameOrigin(fakeReq('192.168.1.4', { origin: 'null' })), false);
});
