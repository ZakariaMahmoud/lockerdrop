import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';
import { SECURITY_HEADERS, fail, sendJson } from './http.js';
import { createFailureLimiter, createKeyCheck, isLocalRequest } from './access.js';
import { receiverRoutes } from './routes/receiver.js';
import { LOCAL_ONLY_MESSAGE, manageRoutes } from './routes/manage.js';
import { adminRoutes } from './routes/admin.js';
import { createDownloadTracker } from './downloads.js';

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/common.js': ['common.js', 'text/javascript; charset=utf-8'],
  '/manager.js': ['manager.js', 'text/javascript; charset=utf-8'],
  '/receiver.js': ['receiver.js', 'text/javascript; charset=utf-8'],
  '/transfers.js': ['transfers.js', 'text/javascript; charset=utf-8'],
  '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const ADMIN_ONLY_PAGES = new Set(['/admin', '/admin.js']);

/**
 * @param {{ store: ReturnType<import('./store.js').createStore>,
 *   settings: Awaited<ReturnType<import('./settings.js').createSettings>>,
 *   adminKey: string, publicDir: string, maxUploadBytes: number,
 *   publicUrl?: string|null, lanUrls?: string[], defaultWorkspaceLimitMb?: number|null,
 *   logger?: Pick<Console, 'error'> }} options
 */
export function createApp({
  store, settings, adminKey, publicDir, maxUploadBytes, publicUrl = null, lanUrls = [],
  defaultWorkspaceLimitMb = null, logger = console,
}) {
  const ctx = {
    store,
    settings,
    maxUploadBytes,
    lanUrls,
    checkAdminKey: createKeyCheck(adminKey),
    downloads: createDownloadTracker(),
    lookupLimiter: createFailureLimiter({ max: 15, windowMs: 5 * 60_000 }),
    authLimiter: createFailureLimiter({ max: 10, windowMs: 15 * 60_000 }),
    ownerLimiter: createFailureLimiter({ max: 10, windowMs: 15 * 60_000 }),
    createLimiter: createFailureLimiter({ max: 30, windowMs: 60 * 60_000 }),
    defaultWorkspaceLimitMb,
    /** Storage cap per workspace in bytes, or null for unlimited. */
    workspaceQuotaBytes() {
      const saved = settings.get();
      const mb = 'workspaceLimitMb' in saved ? saved.workspaceLimitMb : defaultWorkspaceLimitMb;
      return mb === null ? null : mb * 1024 * 1024;
    },
    /** Base URLs used in share links. Saved settings win over detection / env. */
    shareLinks() {
      const saved = settings.get();
      return {
        lan: saved.lanUrl ?? lanUrls[0] ?? null,
        tunnel: 'publicUrl' in saved ? saved.publicUrl : publicUrl,
      };
    },
  };

  const routes = [...receiverRoutes(ctx), ...manageRoutes(ctx), ...adminRoutes(ctx)];

  async function serveStatic(req, res, pathname) {
    const entry = STATIC_FILES[pathname];
    if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    if (ADMIN_ONLY_PAGES.has(pathname) && !isLocalRequest(req)) {
      res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${LOCAL_ONLY_MESSAGE}.\n`);
      return true;
    }
    const [file, type] = entry;
    const body = await fs.readFile(path.join(publicDir, file));
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  function handleError(res, err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof AppError) {
      sendJson(res, err.status, fail(err.message));
      return;
    }
    logger.error('Unhandled request error:', err);
    sendJson(res, 500, fail('Something went wrong on the server'));
  }

  return async function handle(req, res) {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      for (const [method, pattern, handler] of routes) {
        const match = req.method === method && pattern.exec(pathname);
        if (match) return await handler(req, res, match.slice(1));
      }
      if (await serveStatic(req, res, pathname)) return;
      sendJson(res, 404, fail('Not found'));
    } catch (err) {
      handleError(res, err);
    }
  };
}
