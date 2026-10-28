import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const MIN_KEY_LENGTH = 12;

/**
 * Uses ADMIN_KEY from the environment when set; otherwise loads (or creates
 * once) a random key persisted at <dataDir>/admin.key with 0600 permissions.
 * @returns {Promise<{ key: string, source: 'env' | 'file' | 'generated' }>}
 */
export async function loadAdminKey(dataDir, envKey) {
  if (envKey !== undefined && envKey !== '') {
    if (envKey.length < MIN_KEY_LENGTH) {
      throw new Error(`ADMIN_KEY must be at least ${MIN_KEY_LENGTH} characters`);
    }
    return { key: envKey, source: 'env' };
  }
  const keyPath = path.join(dataDir, 'admin.key');
  try {
    const stored = (await fs.readFile(keyPath, 'utf8')).trim();
    if (stored.length >= MIN_KEY_LENGTH) return { key: stored, source: 'file' };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const key = randomBytes(18).toString('base64url');
  await fs.writeFile(keyPath, `${key}\n`, { mode: 0o600 });
  return { key, source: 'generated' };
}
