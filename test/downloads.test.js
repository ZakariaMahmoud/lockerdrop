import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDownloadTracker, isValidDownloadId } from '../src/downloads.js';

const ID = (n) => n.toString(16).padStart(32, '0');
const fakeRes = (finished) => Object.assign(new EventEmitter(), { writableFinished: finished });

function pump(counter, chunks) {
  return new Promise((resolve) => {
    counter.on('data', () => {});
    counter.on('end', resolve);
    chunks.forEach((c) => counter.write(Buffer.from(c)));
    counter.end();
  });
}

test('isValidDownloadId accepts 32 lowercase hex chars only', () => {
  assert.equal(isValidDownloadId(ID(1)), true);
  for (const bad of ['abc', 'Z'.repeat(32), ID(1).toUpperCase().replace(/0/g, 'A'), null]) {
    assert.equal(isValidDownloadId(bad), false, String(bad));
  }
});

test('counts bytes and reports done or cancelled when the response closes', async () => {
  const tracker = createDownloadTracker();
  const okRes = fakeRes(true);
  await pump(tracker.track(ID(1), 10, okRes), ['abcd', 'efghij']);
  assert.deepEqual(tracker.get(ID(1)), { totalBytes: 10, sentBytes: 10, state: 'active' });
  okRes.emit('close');
  assert.equal(tracker.get(ID(1)).state, 'done');

  const cut = fakeRes(false);
  await pump(tracker.track(ID(2), 100, cut), ['abc']);
  cut.emit('close');
  assert.deepEqual(tracker.get(ID(2)), { totalBytes: 100, sentBytes: 3, state: 'cancelled' });
  assert.equal(tracker.get(ID(3)), null);
});

test('finished records expire and the map is capped', () => {
  let now = 0;
  const tracker = createDownloadTracker({ max: 2, ttlMs: 1000, now: () => now });
  const res = fakeRes(true);
  tracker.track(ID(1), 1, res);
  res.emit('close');
  now = 5000;
  tracker.track(ID(2), 1, fakeRes(true)); // prunes the expired one
  assert.equal(tracker.get(ID(1)), null);
  tracker.track(ID(3), 1, fakeRes(true));
  tracker.track(ID(4), 1, fakeRes(true)); // over the cap: oldest goes
  assert.equal(tracker.get(ID(2)), null);
  assert.ok(tracker.get(ID(3)) && tracker.get(ID(4)));
});

test('the cap evicts finished downloads before active ones', () => {
  const tracker = createDownloadTracker({ max: 2 });
  tracker.track(ID(1), 1, fakeRes(true)); // stays active
  const finished = fakeRes(true);
  tracker.track(ID(2), 1, finished);
  finished.emit('close');
  tracker.track(ID(3), 1, fakeRes(true)); // over the cap
  assert.equal(tracker.get(ID(2)), null);
  assert.ok(tracker.get(ID(1)), 'the older active download survives');
  assert.ok(tracker.get(ID(3)));
});
