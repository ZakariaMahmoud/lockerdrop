import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isValidCode, isValidFileId } from './validate.js';
import { badRequest, conflict, notFound, tooLarge, workspaceFull } from './errors.js';
import { tokenMatches } from './tokens.js';
import { crc32, crc32OfFile } from './crc32.js';

const META_FILE = 'meta.json';
const TRASH_RE = /^\.deleting-[1-9A-Za-z]{4,8}-[a-f0-9]{8}$/;

function sizeLimiter(maxBytes) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, done) {
      seen += chunk.length;
      if (seen > maxBytes) done(tooLarge('File exceeds the upload size limit'));
      else done(null, chunk);
    },
  });
}

const sumSizes = (files) => files.reduce((sum, f) => sum + f.size, 0);

function summarize(meta) {
  const active = meta.files.filter((f) => !f.removed);
  return {
    code: meta.code,
    name: meta.name,
    createdAt: meta.createdAt,
    createdBy: meta.createdBy ?? 'admin',
    fileCount: active.length,
    removedCount: meta.files.length - active.length,
    totalBytes: sumSizes(active),
    // Removed files stay on disk, so they still use storage.
    usedBytes: sumSizes(meta.files),
  };
}

/**
 * File-system backed workspace repository.
 * Layout: <dataDir>/workspaces/<code>/{meta.json, files/<id>}
 */
export function createStore(dataDir) {
  const root = path.join(dataDir, 'workspaces');
  const locks = new Map();
  const committed = new Map(); // code → bytes recorded in meta.json (incl. removed files)
  const inflight = new Map(); // code → bytes written so far by uploads in progress
  const uploads = new Map(); // code → Set<AbortController> of uploads in progress

  function wsDir(code) {
    if (!isValidCode(code)) throw badRequest('Invalid workspace code');
    return path.join(root, code);
  }

  // Serialize meta.json read-modify-write per workspace.
  function withLock(code, fn) {
    const run = (locks.get(code) ?? Promise.resolve()).then(fn);
    const settled = run.catch(() => {});
    locks.set(code, settled);
    settled.then(() => {
      if (locks.get(code) === settled) locks.delete(code);
    });
    return run;
  }

  async function readMeta(code) {
    try {
      return JSON.parse(await fs.readFile(path.join(wsDir(code), META_FILE), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async function writeMeta(meta) {
    const target = path.join(wsDir(meta.code), META_FILE);
    const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2));
    await fs.rename(tmp, target);
  }

  async function requireMeta(code) {
    const meta = await readMeta(code);
    if (!meta) throw notFound('Workspace');
    return meta;
  }

  async function init() {
    await fs.mkdir(root, { recursive: true });
    // Finish deletes interrupted by a crash or restart.
    const leftovers = (await fs.readdir(root)).filter((name) => TRASH_RE.test(name));
    await Promise.all(leftovers.map((name) => fs.rm(path.join(root, name), { recursive: true, force: true })));
  }

  async function listWorkspaces() {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const codes = entries.filter((e) => e.isDirectory() && isValidCode(e.name)).map((e) => e.name);
    const metas = await Promise.all(codes.map(readMeta));
    return metas
      .filter(Boolean)
      .map(summarize)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * @param {{ code: string, name: string, createdBy?: 'admin'|'participant',
   *   ownerTokenHash?: string|null }} input
   */
  async function createWorkspace({ code, name, createdBy = 'admin', ownerTokenHash = null }) {
    const dir = wsDir(code);
    try {
      await fs.mkdir(dir);
    } catch (err) {
      if (err.code === 'EEXIST') throw conflict('That code is already in use');
      throw err;
    }
    const meta = { code, name, createdAt: new Date().toISOString(), createdBy, ownerTokenHash, files: [] };
    try {
      await fs.mkdir(path.join(dir, 'files'));
      await writeMeta(meta);
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true }); // don't leave a half-made, unusable code
      throw err;
    }
    return summarize(meta);
  }

  async function getWorkspace(code, { includeRemoved = false } = {}) {
    const meta = await requireMeta(code);
    const files = includeRemoved ? meta.files : meta.files.filter((f) => !f.removed);
    return { ...summarize(meta), files };
  }

  async function committedBytes(code) {
    if (!committed.has(code)) committed.set(code, sumSizes((await requireMeta(code)).files));
    return committed.get(code);
  }

  const inflightBytes = (code) => inflight.get(code) ?? 0;
  const addInflight = (code, delta) => {
    const next = inflightBytes(code) + delta;
    if (next === 0) inflight.delete(code);
    else inflight.set(code, next);
  };

  /**
   * Streams an upload to disk. `quotaBytes` (null = unlimited) caps the
   * workspace's total storage; it is checked on every chunk against committed
   * plus in-progress bytes, so parallel uploads can't overshoot it.
   */
  async function addFile(code, { name, stream, maxBytes, quotaBytes = null, declaredBytes = NaN }) {
    const base = await committedBytes(code);
    const overQuota = (extra) => quotaBytes !== null && committed.get(code) + inflightBytes(code) + extra > quotaBytes;
    if (Number.isFinite(declaredBytes) && overQuota(declaredBytes)) throw workspaceFull();
    if (quotaBytes !== null && base >= quotaBytes) throw workspaceFull();

    const id = randomBytes(16).toString('hex');
    const finalPath = path.join(wsDir(code), 'files', id);
    const partPath = `${finalPath}.part`;
    let size = 0;
    let checksum = 0; // CRC-32, kept so "download all" can zip without re-reading files
    const counter = new Transform({
      transform(chunk, _enc, done) {
        size += chunk.length;
        checksum = crc32(chunk, checksum);
        addInflight(code, chunk.length);
        if (overQuota(0)) done(workspaceFull());
        else done(null, chunk);
      },
    });
    const controller = new AbortController();
    const active = uploads.get(code) ?? new Set();
    uploads.set(code, active.add(controller));
    try {
      await pipeline(stream, sizeLimiter(maxBytes), counter, createWriteStream(partPath), { signal: controller.signal });
      await fs.rename(partPath, finalPath);
      const record = { id, name, size, crc32: checksum, uploadedAt: new Date().toISOString(), removed: false };
      await withLock(code, async () => {
        const meta = await requireMeta(code);
        await writeMeta({ ...meta, files: [...meta.files, record] });
        committed.set(code, sumSizes(meta.files) + size);
      });
      return record;
    } catch (err) {
      await fs.rm(partPath, { force: true });
      // The workspace was deleted mid-upload: report that, not a raw fs error.
      if (!(err instanceof Error && 'status' in err) && !(await readMeta(code))) throw notFound('Workspace');
      throw err;
    } finally {
      addInflight(code, -size);
      active.delete(controller);
      if (active.size === 0 && uploads.get(code) === active) uploads.delete(code);
    }
  }

  /** True when `token` is the owner token issued for this workspace. */
  async function verifyOwner(code, token) {
    if (!isValidCode(code)) return false;
    const meta = await readMeta(code);
    return Boolean(meta?.ownerTokenHash) && tokenMatches(token, meta.ownerTokenHash);
  }

  /** Soft remove/restore: the file stays on disk, only visibility changes. */
  function setFileRemoved(code, id, removed) {
    if (!isValidFileId(id)) return Promise.reject(notFound('File'));
    return withLock(code, async () => {
      const meta = await requireMeta(code);
      const current = meta.files.find((f) => f.id === id);
      if (!current) throw notFound('File');
      const updated = { ...current, removed, removedAt: removed ? new Date().toISOString() : null };
      await writeMeta({ ...meta, files: meta.files.map((f) => (f.id === id ? updated : f)) });
      return updated;
    });
  }

  /**
   * Permanently deletes soft-removed files: one (`id`) or all of them.
   * Active files are never touched: they must be removed first.
   */
  function purgeRemoved(code, id = null) {
    if (id !== null && !isValidFileId(id)) return Promise.reject(notFound('File'));
    return withLock(code, async () => {
      const meta = await requireMeta(code);
      if (id !== null) {
        const file = meta.files.find((f) => f.id === id);
        if (!file) throw notFound('File');
        if (!file.removed) throw conflict('Remove the file before deleting it permanently');
      }
      const doomed = meta.files.filter((f) => f.removed && (id === null || f.id === id));
      const kept = meta.files.filter((f) => !doomed.includes(f));
      await writeMeta({ ...meta, files: kept });
      committed.set(code, sumSizes(kept));
      await Promise.all(doomed.map((f) => fs.rm(path.join(wsDir(code), 'files', f.id), { force: true })));
      return { deletedCount: doomed.length, freedBytes: sumSizes(doomed) };
    });
  }

  /**
   * Permanently deletes a workspace and all its files. The directory is first
   * renamed out of the way (atomic), so the code disappears at once.
   */
  function deleteWorkspace(code) {
    return withLock(code, async () => {
      const meta = await requireMeta(code);
      const trash = path.join(root, `.deleting-${code}-${randomBytes(4).toString('hex')}`);
      await fs.rename(wsDir(code), trash);
      // Stop uploads into this workspace now instead of letting them stream on.
      uploads.get(code)?.forEach((c) => c.abort());
      committed.delete(code);
      await fs.rm(trash, { recursive: true, force: true });
      return { code, deletedFiles: meta.files.length, freedBytes: sumSizes(meta.files) };
    });
  }

  /**
   * Visible files of a workspace, ready to zip. Files uploaded before CRCs
   * were recorded get theirs computed once and saved.
   */
  async function getZipEntries(code) {
    const meta = await requireMeta(code);
    const active = meta.files.filter((f) => !f.removed);
    const filePath = (id) => path.join(wsDir(code), 'files', id);
    const missing = active.filter((f) => typeof f.crc32 !== 'number');
    const computed = new Map(await Promise.all(missing.map(async (f) => [f.id, await crc32OfFile(filePath(f.id))])));
    if (computed.size > 0) {
      await withLock(code, async () => {
        const latest = await requireMeta(code);
        await writeMeta({
          ...latest,
          files: latest.files.map((f) => (computed.has(f.id) ? { ...f, crc32: computed.get(f.id) } : f)),
        });
      });
    }
    return {
      name: meta.name,
      entries: active.map((f) => ({
        name: f.name,
        size: f.size,
        crc32: f.crc32 ?? computed.get(f.id),
        mtime: f.uploadedAt,
        filePath: filePath(f.id),
      })),
    };
  }

  /** Resolves a downloadable (non-removed) file. */
  async function getActiveFile(code, id) {
    if (!isValidFileId(id)) throw notFound('File');
    const meta = await requireMeta(code);
    const file = meta.files.find((f) => f.id === id && !f.removed);
    if (!file) throw notFound('File');
    return { file, filePath: path.join(wsDir(code), 'files', id) };
  }

  return {
    init, listWorkspaces, createWorkspace, getWorkspace, addFile, setFileRemoved, getActiveFile, verifyOwner,
    purgeRemoved, deleteWorkspace, getZipEntries,
  };
}
