import { formatBytes, h } from './common.js';

const POLL_MS = 800;
const START_TIMEOUT_MS = 60_000;
const KEEP_DONE_MS = 10_000;
const KEEP_FAILED_MS = 30_000;
export const TRACK_MIN_BYTES = 1024 * 1024; // smaller files finish before a bar is useful

function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function formatDuration(seconds) {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function describe(p, speed) {
  const left = speed > 0 ? (p.totalBytes - p.sentBytes) / speed : NaN;
  return [
    `${formatBytes(p.sentBytes)} of ${formatBytes(p.totalBytes)}`,
    speed > 0 ? `${formatBytes(Math.round(speed))}/s` : null,
    Number.isFinite(left) ? `${formatDuration(left)} left` : null,
  ].filter(Boolean).join(' · ');
}

/**
 * Lets the browser save the file natively (any size, straight to disk) and
 * shows its progress in `list` by polling the server with a random id.
 */
export function startTrackedDownload({ href, fileName, list }) {
  const id = newId();
  const url = `${href}${href.includes('?') ? '&' : '?'}t=${id}`;
  const trigger = h('a', { href: url, download: fileName, hidden: true });
  document.body.append(trigger);
  trigger.click();
  trigger.remove();

  const bar = h('progress', { max: '1', value: '0' });
  const status = h('span', { class: 'transfer-status' }, 'Starting…');
  const row = h('li', { class: 'transfer' },
    h('div', { class: 'transfer-top' },
      h('span', { class: 'transfer-name', title: fileName }, fileName),
      status),
    bar);
  list.prepend(row);

  const startedAt = Date.now();
  let last = null;
  let speed = 0;
  let timer = null;

  function finish(kind, text) {
    clearInterval(timer);
    row.classList.add(kind);
    status.textContent = text;
    setTimeout(() => row.remove(), kind === 'is-done' ? KEEP_DONE_MS : KEEP_FAILED_MS);
  }

  async function poll() {
    let res;
    try {
      res = await fetch(`/api/downloads/${id}`, { cache: 'no-store' });
    } catch {
      return; // transient network hiccup: try again next tick
    }
    if (res.status === 404) {
      if (Date.now() - startedAt > START_TIMEOUT_MS) finish('is-error', 'Did not start. Check your browser’s downloads.');
      return;
    }
    const p = (await res.json().catch(() => null))?.data;
    if (!p) return;
    const now = Date.now();
    if (last && now > last.at) {
      const instant = (p.sentBytes - last.bytes) / ((now - last.at) / 1000);
      speed = speed > 0 ? speed * 0.7 + instant * 0.3 : instant;
    }
    last = { at: now, bytes: p.sentBytes };
    bar.value = p.totalBytes > 0 ? p.sentBytes / p.totalBytes : 1;
    if (p.state === 'done') {
      bar.value = 1;
      finish('is-done', `Done · ${formatBytes(p.totalBytes)} saved by your browser`);
    } else if (p.state === 'cancelled') {
      finish('is-error', `Stopped at ${formatBytes(p.sentBytes)} of ${formatBytes(p.totalBytes)}`);
    } else {
      status.textContent = describe(p, speed);
    }
  }

  timer = setInterval(poll, POLL_MS);
}

/**
 * Plain left-clicks on big downloads become tracked; anything else stays native.
 * `opts` is read at click time, so it may use getters for changing values.
 */
export function trackClicks(link, opts) {
  link.addEventListener('click', (event) => {
    const plain = event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
    if (!plain || opts.totalBytes < TRACK_MIN_BYTES) return;
    event.preventDefault();
    startTrackedDownload({ href: link.getAttribute('href'), fileName: opts.fileName, list: opts.list });
  });
}
