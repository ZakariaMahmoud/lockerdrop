import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { badRequest } from './errors.js';

const MAX_URL_LENGTH = 300;
const MAX_LIMIT_MB = 100_000_000;

/**
 * Normalizes a share-link base such as "192.168.1.20:8080" or
 * "https://x.trycloudflare.com/" to "scheme://host[:port]". Empty → null.
 */
export function normalizeBaseUrl(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw badRequest('Address must be text');
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_URL_LENGTH) throw badRequest('Address is too long');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw badRequest(`"${trimmed}" is not a valid address`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('Address must use http or https');
  if (url.username || url.password) throw badRequest('Address must not contain a user name or password');
  if (url.pathname !== '/' || url.search || url.hash) {
    throw badRequest('Address must not contain a path. Use only scheme, host and port.');
  }
  return `${url.protocol}//${url.host}`;
}

/** Per-workspace storage limit in MB. Empty → null, meaning unlimited. */
export function normalizeLimitMb(value) {
  if (value === null || value === undefined || value === '') return null;
  const mb = Number(value);
  if (!Number.isInteger(mb) || mb < 1 || mb > MAX_LIMIT_MB) {
    throw badRequest('Storage limit must be a whole number of MB, at least 1');
  }
  return mb;
}

const NORMALIZERS = {
  lanUrl: normalizeBaseUrl,
  publicUrl: normalizeBaseUrl,
  workspaceLimitMb: normalizeLimitMb,
};
const KEYS = Object.keys(NORMALIZERS);

/**
 * Admin-editable settings persisted in <dataDir>/settings.json.
 * A key that was never saved is absent, so callers can fall back to defaults.
 */
export async function createSettings(dataDir) {
  const file = path.join(dataDir, 'settings.json');
  let current = {};
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    current = Object.fromEntries(KEYS.filter((k) => k in parsed).map((k) => [k, NORMALIZERS[k](parsed[k])]));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${err.message}`);
  }

  async function update(patch) {
    const changes = Object.fromEntries(
      KEYS.filter((k) => patch[k] !== undefined).map((k) => [k, NORMALIZERS[k](patch[k])]),
    );
    const next = { ...current, ...changes };
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2));
    await fs.rename(tmp, file);
    current = next;
    return current;
  }

  return { get: () => current, update };
}
