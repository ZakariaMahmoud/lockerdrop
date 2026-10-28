import { fail, ok, readJson, sendJson } from '../http.js';
import { clientIp } from '../access.js';
import { parseWorkspaceInput } from '../validate.js';
import { localOnly } from './manage.js';

/** Admin-only routes: every workspace, admin-owned creation, share-link settings. */
export function adminRoutes(ctx) {
  const { store, settings, authLimiter, checkAdminKey } = ctx;

  function admin(handler) {
    return localOnly(async (req, res, params) => {
      const ip = clientIp(req);
      if (authLimiter.isBlocked(ip)) {
        return sendJson(res, 429, fail('Too many failed attempts. Try again later.'));
      }
      if (!checkAdminKey(req.headers['x-admin-key'])) {
        authLimiter.record(ip);
        return sendJson(res, 401, fail('Invalid admin key'));
      }
      return handler(req, res, params);
    });
  }

  const settingsView = () => ({
    settings: settings.get(),
    detectedLanUrls: ctx.lanUrls,
    links: ctx.shareLinks(),
    workspaceQuotaBytes: ctx.workspaceQuotaBytes(),
    defaultWorkspaceLimitMb: ctx.defaultWorkspaceLimitMb,
  });

  const session = async (_req, res) =>
    sendJson(res, 200, ok({ maxUploadBytes: ctx.maxUploadBytes, ...settingsView() }));

  const list = async (_req, res) => sendJson(res, 200, ok(await store.listWorkspaces()));

  async function create(req, res) {
    const input = parseWorkspaceInput(await readJson(req));
    return sendJson(res, 201, ok(await store.createWorkspace({ ...input, createdBy: 'admin' })));
  }

  async function updateSettings(req, res) {
    const body = await readJson(req);
    await settings.update({ lanUrl: body.lanUrl, publicUrl: body.publicUrl, workspaceLimitMb: body.workspaceLimitMb });
    return sendJson(res, 200, ok(settingsView()));
  }

  // Permanent deletion is admin-only and only for files already removed.
  const purgeOne = async (_req, res, [code, id]) => sendJson(res, 200, ok(await store.purgeRemoved(code, id)));
  const purgeAll = async (_req, res, [code]) => sendJson(res, 200, ok(await store.purgeRemoved(code)));

  return [
    ['GET', /^\/api\/admin\/session$/, admin(session)],
    ['DELETE', /^\/api\/admin\/workspaces\/([^/]+)\/files\/([^/]+)$/, admin(purgeOne)],
    ['DELETE', /^\/api\/admin\/workspaces\/([^/]+)\/removed$/, admin(purgeAll)],
    ['GET', /^\/api\/admin\/workspaces$/, admin(list)],
    ['POST', /^\/api\/admin\/workspaces$/, admin(create)],
    ['PUT', /^\/api\/admin\/settings$/, admin(updateSettings)],
  ];
}
