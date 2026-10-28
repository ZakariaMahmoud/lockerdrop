import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_TOKEN_LENGTH = 256;

/** Secret handed to a participant once; only its hash is stored. */
export function generateToken() {
  return randomBytes(24).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenMatches(token, storedHash) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;
  if (typeof storedHash !== 'string' || !HASH_RE.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(hashToken(token), 'hex'), Buffer.from(storedHash, 'hex'));
}
