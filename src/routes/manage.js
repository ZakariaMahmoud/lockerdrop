import { AppError, badRequest } from '../errors.js';
import { fail, ok, readJson, sendJson } from '../http.js';
import { clientIp, isLocalRequest, isSameOrigin } from '../access.js';
import { isValidCode, parseWorkspaceInput, sanitizeFileName } from '../validate.js';
import { generateToken, hashToken } from '../tokens.js';

export const LOCAL_ONLY_MESSAGE = 'This is only available on the local network';

export function localOnly(handler) {
  return (req, res, params) => {
    if (!isLocalRequest(req)) return sendJson(res, 403, fail(LOCAL_ONLY_MESSAGE));
    if (!isSameOrigin(req)) return sendJson(res, 403, fail('Cross-site requests are not allowed'));
    return handler(req, res, params);
  };
}

function decodeHeaderName(value) {
  if (typeof value !== 'string') return null;
  try {
    return sanitizeFileName(decodeURIComponent(value));
  } catch {
    return null;
  }
}

/**
 * Workspace management (files, deleting the workspace), LAN only. Allowed for
 * the admin (X-Admin-Key) or the participant who created it (X-Owner-Token).
 */
export function manageRoutes(ctx) {
  const { store, authLimiter, ownerLimiter, createLimiter, checkAdminKey, maxUploadBytes } = ctx;

  // Admin-key and owner-token failures are counted separately, so a
  // participant guessing tokens can't lock the admin out (and vice versa).
  function manager(handler) {
    return localOnly(async (req, res, params) => {
      const ip = clientIp(req);
      const usesAdminKey = req.headers['x-admin-key'] !== undefined;
      const limiter = usesAdminKey ? authLimiter : ownerLimiter;
      if (limiter.isBlocked(ip)) {
        return sendJson(res, 429, fail('Too many failed attempts. Try again later.'));
      }
      const [code] = params;
      const allowed = usesAdminKey
        ? checkAdminKey(req.headers['x-admin-key'])
        : isValidCode(code) && await store.verifyOwner(code, req.headers['x-owner-token']);
      if (!allowed) {
        limiter.record(ip);
        return sendJson(res, 401, fail('You are not allowed to manage this workspace'));
      }
      return handler(req, res, params);
    });
  }

  async function create(req, res) {
    const ip = clientIp(req);
    if (createLimiter.isBlocked(ip)) {
      return sendJson(res, 429, fail('Too many workspace attempts recently. Try again later.'));
    }
    // Count every attempt, before any await: a 409 reveals that a code exists,
    // so failed attempts must not be free, and parallel bursts must not slip by.
    createLimiter.record(ip);
    const input = parseWorkspaceInput(await readJson(req));
    const ownerToken = generateToken();
    const workspace = await store.createWorkspace({
      ...input, createdBy: 'participant', ownerTokenHash: hashToken(ownerToken),
    });
    return sendJson(res, 201, ok({ workspace, ownerToken }));
  }

  async function get(_req, res, [code]) {
    const ws = await store.getWorkspace(code, { includeRemoved: true });
    return sendJson(res, 200, ok({ ...ws, quotaBytes: ctx.workspaceQuotaBytes() }));
  }

  async function upload(req, res, [code]) {
    res.setHeader('Connection', 'close'); // don't keep reading a rejected body
    const name = decodeHeaderName(req.headers['x-file-name']);
    if (!name) throw badRequest('Missing or invalid X-File-Name header');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxUploadBytes) {
      throw new AppError(413, 'File exceeds the upload size limit');
    }
    const record = await store.addFile(code, {
      name, stream: req, maxBytes: maxUploadBytes, quotaBytes: ctx.workspaceQuotaBytes(), declaredBytes: declared,
    });
    res.removeHeader('Connection');
    return sendJson(res, 201, ok(record));
  }

  async function setRemoved(req, res, [code, id]) {
    const body = await readJson(req);
    if (typeof body.removed !== 'boolean') throw badRequest('"removed" must be true or false');
    return sendJson(res, 200, ok(await store.setFileRemoved(code, id, body.removed)));
  }

  /** Owners may delete their own workspace; the admin may delete any. */
  const remove = async (_req, res, [code]) => sendJson(res, 200, ok(await store.deleteWorkspace(code)));

  return [
    ['POST', /^\/api\/workspaces$/, localOnly(create)],
    ['DELETE', /^\/api\/workspaces\/([^/]+)$/, manager(remove)],
    ['GET', /^\/api\/workspaces\/([^/]+)$/, manager(get)],
    ['PUT', /^\/api\/workspaces\/([^/]+)\/files$/, manager(upload)],
    ['PATCH', /^\/api\/workspaces\/([^/]+)\/files\/([^/]+)$/, manager(setRemoved)],
  ];
}
