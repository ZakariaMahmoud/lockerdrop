import { randomInt } from 'node:crypto';
import { badRequest } from './errors.js';

export const CODE_MIN = 4;
export const CODE_MAX = 8;
// Generated codes skip I, l and O, which are easy to misread as 1 and 0.
export const CODE_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const CODE_RE = /^[1-9A-Za-z]+$/;
const FILE_ID_RE = /^[a-f0-9]{32}$/;
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f/\\]/g;
// Invisible direction marks/overrides: "invoice\u202Efdp.exe" would display as "invoiceexe.pdf".
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const MAX_FILE_NAME = 200;
const MAX_WORKSPACE_NAME = 60;

/** Workspace codes: 4–8 chars, digits 1-9 and ASCII letters (case-sensitive). */
export function isValidCode(value) {
  return (
    typeof value === 'string' &&
    value.length >= CODE_MIN &&
    value.length <= CODE_MAX &&
    CODE_RE.test(value)
  );
}

export function generateCode(length = CODE_MAX) {
  return Array.from({ length }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

export function isValidFileId(value) {
  return typeof value === 'string' && FILE_ID_RE.test(value);
}

function clampChars(value, max) {
  return Array.from(value).slice(0, max).join('');
}

/** Returns a display-safe file name, or null when nothing usable is left. */
export function sanitizeFileName(value) {
  if (typeof value !== 'string') return null;
  const cleaned = clampChars(value.replace(BIDI_CONTROLS, '').replace(UNSAFE_NAME_CHARS, '_').trim(), MAX_FILE_NAME);
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return null;
  return cleaned;
}

export function sanitizeWorkspaceName(value) {
  if (typeof value !== 'string') return null;
  const cleaned = clampChars(value.replace(BIDI_CONTROLS, '').replace(/[\u0000-\u001f\u007f]/g, '').trim(), MAX_WORKSPACE_NAME);
  return cleaned === '' ? null : cleaned;
}

/** Validates a create-workspace body; an empty code means "generate one". */
export function parseWorkspaceInput(body) {
  const name = sanitizeWorkspaceName(body.name ?? '') ?? 'Untitled workspace';
  const code = body.code === undefined || body.code === null || body.code === '' ? generateCode() : body.code;
  if (!isValidCode(code)) {
    throw badRequest('Code must be 4–8 characters: digits 1–9 and letters a–z, A–Z');
  }
  return { code, name };
}
