import { Transform } from 'node:stream';

const ID_RE = /^[a-f0-9]{32}$/;

export const isValidDownloadId = (value) => typeof value === 'string' && ID_RE.test(value);

/**
 * In-memory progress of downloads, keyed by a random id the browser puts in
 * the download URL (?t=…). The page polls it to show a progress bar while the
 * browser saves the file natively (no size limit, no buffering in memory).
 */
export function createDownloadTracker({ max = 2000, ttlMs = 10 * 60_000, now = Date.now } = {}) {
  const records = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [id, r] of records) {
      if (r.state !== 'active' && r.updatedAt < cutoff) records.delete(id);
    }
    // Hard cap: drop the oldest finished entries first, then the oldest active
    // ones (Map keeps insertion order), so a flood of new ids can't easily
    // push out downloads that are still running.
    for (const finishedOnly of [true, false]) {
      for (const [id, r] of records) {
        if (records.size <= max) return;
        if (!finishedOnly || r.state !== 'active') records.delete(id);
      }
    }
  }

  /**
   * Starts tracking a response. Returns a pass-through stream that counts the
   * bytes flowing into `res`; pipe the body through it.
   */
  function track(id, totalBytes, res) {
    const record = { totalBytes, sentBytes: 0, state: 'active', updatedAt: now() };
    records.delete(id); // re-insert so the newest is last for the cap
    records.set(id, record);
    prune();
    const update = (patch) => Object.assign(record, patch, { updatedAt: now() });
    res.on('close', () => {
      if (record.state === 'active') update({ state: res.writableFinished ? 'done' : 'cancelled' });
    });
    return new Transform({
      transform(chunk, _enc, done) {
        update({ sentBytes: record.sentBytes + chunk.length });
        done(null, chunk);
      },
    });
  }

  function get(id) {
    const record = records.get(id);
    if (!record) return null;
    const { totalBytes, sentBytes, state } = record;
    return { totalBytes, sentBytes, state };
  }

  return { track, get };
}
