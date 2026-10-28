import net from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';

// Headers added by Cloudflare / reverse proxies. Their presence means the
// request did not originate on the local network.
const PROXY_HEADERS = [
  'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cf-visitor', 'cdn-loop',
  'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'true-client-ip', 'forwarded',
];

function normalizeIp(ip = '') {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function isPrivateAddress(rawIp) {
  const ip = normalizeIp(rawIp);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return false;
}

/**
 * Hosts a browser uses when talking to us directly: an IP literal, localhost,
 * a bare machine name, or a LAN-only suffix. Public domains (e.g. a
 * *.trycloudflare.com tunnel) never match, even if proxy headers are stripped.
 */
export function isLocalHost(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;
  const host = hostHeader.startsWith('[')
    ? hostHeader.slice(1, hostHeader.indexOf(']'))
    : hostHeader.replace(/:\d+$/, '');
  const name = host.toLowerCase();
  return (
    net.isIP(name) !== 0 ||
    name === 'localhost' ||
    /^[a-z0-9-]+$/.test(name) ||
    /\.(local|lan|home|internal|localhost)$/.test(name)
  );
}

/** True only for direct requests from the LAN (never through the tunnel). */
export function isLocalRequest(req) {
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  if (!isLocalHost(req.headers.host)) return false;
  return isPrivateAddress(req.socket.remoteAddress);
}

/** A browser's Origin, when sent, must be this same host (blocks cross-site requests). */
export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Best-effort client identity for rate limiting. */
export function clientIp(req) {
  const remote = normalizeIp(req.socket.remoteAddress);
  const viaTunnel = remote === '127.0.0.1' || remote === '::1';
  const cfIp = req.headers['cf-connecting-ip'];
  return viaTunnel && typeof cfIp === 'string' ? cfIp : remote;
}

/** Counts events (failures, creations…) per key in a sliding window. */
export function createFailureLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();

  function recent(key) {
    const cutoff = now() - windowMs;
    return (hits.get(key) ?? []).filter((t) => t > cutoff);
  }

  return {
    isBlocked(key) {
      const list = recent(key);
      if (list.length === 0) hits.delete(key);
      else hits.set(key, list);
      return list.length >= max;
    },
    record(key) {
      hits.set(key, [...recent(key), now()]);
    },
  };
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

export function createKeyCheck(secret) {
  const expected = digest(secret);
  return (candidate) =>
    typeof candidate === 'string' && candidate.length > 0 && timingSafeEqual(digest(candidate), expected);
}
