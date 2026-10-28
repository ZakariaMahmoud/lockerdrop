import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../errors.js';
import { SECURITY_HEADERS, contentDisposition, fail, ok, sendJson } from '../http.js';
import { clientIp, isLocalRequest } from '../access.js';
import { isValidCode, sanitizeFileName } from '../validate.js';
import { buildZipLayout, streamZip, uniqueNames } from '../zip.js';
import { isValidDownloadId } from '../downloads.js';

/** Public routes: anyone (LAN or tunnel) who knows a code can list and download. */
export function receiverRoutes(ctx) {
  const { store, lookupLimiter, downloads } = ctx;

  /** Optional ?t=<id> on download URLs: lets the page poll progress. */
  function trackedBody(req, res, totalBytes) {
    const id = new URL(req.url, 'http://localhost').searchParams.get('t');
    return isValidDownloadId(id) ? downloads.track(id, totalBytes, res) : null;
  }

  // Both routes share one limiter, and every miss (bad code, unknown code,
  // unknown file) looks identical, so neither can be used to probe codes.
  function guarded(handler) {
    return async (req, res, params) => {
      const ip = clientIp(req);
      if (lookupLimiter.isBlocked(ip)) {
        return sendJson(res, 429, fail('Too many wrong codes. Try again in a few minutes.'));
      }
      try {
        if (!isValidCode(params[0])) throw new AppError(404, 'Not found');
        return await handler(req, res, params);
      } catch (err) {
        if (err instanceof AppError && err.status === 404) {
          lookupLimiter.record(ip);
          throw new AppError(404, 'Not found');
        }
        throw err;
      }
    };
  }

  async function lookup(_req, res, [code]) {
    const ws = await store.getWorkspace(code);
    const files = ws.files.map(({ id, name, size, uploadedAt }) => ({ id, name, size, uploadedAt }));
    return sendJson(res, 200, ok({ code: ws.code, name: ws.name, totalBytes: ws.totalBytes, files }));
  }

  async function download(req, res, [code, id]) {
    const { file, filePath } = await store.getActiveFile(code, id);
    const stat = await fs.stat(filePath);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': contentDisposition(file.name),
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    const counter = trackedBody(req, res, stat.size);
    if (counter) await pipeline(createReadStream(filePath), counter, res);
    else await pipeline(createReadStream(filePath), res);
  }

  /** Every visible file as one ZIP, streamed with an exact Content-Length. */
  async function downloadAll(req, res, [code]) {
    const { name, entries } = await store.getZipEntries(code);
    if (entries.length === 0) throw new AppError(409, 'This workspace has no files yet');
    const names = uniqueNames(entries.map((e) => e.name));
    const files = entries.map((e, i) => ({ ...e, name: names[i] }));
    const layout = buildZipLayout(files);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/zip',
      'Content-Length': layout.totalSize,
      'Content-Disposition': contentDisposition(`${sanitizeFileName(name) ?? code}.zip`),
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    const counter = trackedBody(req, res, layout.totalSize);
    if (!counter) return streamZip(layout, files, res);
    await Promise.all([streamZip(layout, files, counter), pipeline(counter, res)]);
  }

  async function progress(_req, res, [id]) {
    const record = isValidDownloadId(id) ? downloads.get(id) : null;
    if (!record) return sendJson(res, 404, fail('Unknown download'));
    return sendJson(res, 200, ok(record));
  }

  /** What the home page may offer this visitor. Links are only shown on the LAN. */
  async function config(req, res) {
    const local = isLocalRequest(req);
    return sendJson(res, 200, ok({
      canCreate: local,
      maxUploadBytes: ctx.maxUploadBytes,
      links: local ? ctx.shareLinks() : null,
    }));
  }

  return [
    ['GET', /^\/api\/config$/, config],
    ['GET', /^\/api\/downloads\/([^/]+)$/, progress],
    ['GET', /^\/api\/w\/([^/]+)$/, guarded(lookup)],
    ['GET', /^\/api\/w\/([^/]+)\/zip$/, guarded(downloadAll)],
    ['HEAD', /^\/api\/w\/([^/]+)\/zip$/, guarded(downloadAll)],
    ['GET', /^\/api\/w\/([^/]+)\/files\/([^/]+)$/, guarded(download)],
    ['HEAD', /^\/api\/w\/([^/]+)\/files\/([^/]+)$/, guarded(download)],
  ];
}
