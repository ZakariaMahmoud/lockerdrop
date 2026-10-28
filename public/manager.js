import { api, copyText, fileRow, formatBytes, h, uploadFile } from './common.js';

let pageDropGuard = false;

function shareLink(label, base, code) {
  const link = `${base}/#${code}`;
  const button = h('button', { type: 'button', class: 'btn btn-sm' }, 'Copy');
  button.addEventListener('click', async () => {
    button.textContent = (await copyText(link)) ? 'Copied' : 'Copy failed';
    setTimeout(() => { button.textContent = 'Copy'; }, 1600);
  });
  return h('li', { class: 'share-link' },
    h('span', { class: 'share-label' }, label),
    h('code', { class: 'share-url' }, link),
    button);
}

/**
 * Workspace management panel shared by the admin and participant pages:
 * share links, uploads, soft remove / restore.
 * @param {{ authHeaders: () => Record<string, string>, maxUploadBytes: number,
 *   getLinks: () => { lan: string|null, tunnel: string|null },
 *   onAuthError: () => void, onChanged?: (ws: object) => void,
 *   canPurge?: boolean, canDeleteWorkspace?: boolean, onDeleted?: (code: string) => void }} opts
 *   canPurge (admin only) shows permanent delete for removed files;
 *   canDeleteWorkspace (admin, or the owner) shows "Delete workspace".
 */
export function createManager(opts) {
  let ws = null;
  const el = {
    name: h('h1', { class: 'title' }),
    meta: h('p', { class: 'muted' }),
    meter: h('progress', { class: 'meter', max: '1', value: '0' }),
    meterText: h('span', { class: 'meter-text' }),
    code: h('code'),
    links: h('ul', { class: 'share-links' }),
    status: h('p', { class: 'error', role: 'alert' }),
    uploads: h('ul', { class: 'upload-list' }),
    active: h('ul', { class: 'file-list' }),
    activeEmpty: h('p', { class: 'empty' }, 'Nothing shared yet. Drop files above.'),
    activeCount: h('span', { class: 'count' }),
    removed: h('ul', { class: 'file-list' }),
    removedCount: h('span', { class: 'count' }),
    fileInput: h('input', { type: 'file', multiple: true, class: 'sr-only' }),
  };
  const dropzone = h('label', { class: 'dropzone' },
    el.fileInput,
    h('strong', {}, 'Drop files here'),
    h('span', {}, `or click to choose · up to ${formatBytes(opts.maxUploadBytes)} each`));
  const purgeAllButton = h('button', { type: 'button', class: 'btn btn-sm btn-danger' }, 'Delete all removed');
  const removedWrap = h('details', { class: 'removed' },
    h('summary', {}, 'Removed ', el.removedCount),
    h('div', { class: 'removed-bar' },
      h('p', { class: 'muted small' }, opts.canPurge
        ? 'Hidden from receivers and kept on disk until you delete them for good.'
        : 'Hidden from receivers. The files are kept on disk and can be restored.'),
      opts.canPurge ? purgeAllButton : null),
    el.removed);
  const deleteWsButton = h('button', { type: 'button', class: 'btn btn-danger' }, 'Delete workspace');
  const dangerZone = opts.canDeleteWorkspace
    ? h('section', { class: 'danger-zone' },
      h('div', {},
        h('h2', {}, 'Delete this workspace'),
        h('p', { class: 'muted small' },
          'Permanently deletes the workspace and every file in it, shared or removed. The code stops working.')),
      deleteWsButton)
    : null;
  const root = h('div', { class: 'manager' },
    h('div', { class: 'ws-head' },
      h('div', {}, h('p', { class: 'eyebrow' }, 'Workspace'), el.name, el.meta,
        h('div', { class: 'storage' }, el.meter, el.meterText)),
      h('div', { class: 'code-badge' }, h('span', { class: 'code-badge-label' }, 'Code'), el.code)),
    el.links, dropzone, el.uploads, el.status,
    h('h2', { class: 'section-title' }, 'Shared files ', el.activeCount),
    el.active, el.activeEmpty, removedWrap, dangerZone);

  function report(err) {
    if (err.status === 401) opts.onAuthError();
    else el.status.textContent = err.message;
  }

  async function reload() {
    try {
      ws = await api(`/api/workspaces/${ws.code}`, { headers: opts.authHeaders() });
      render();
      opts.onChanged?.(ws);
    } catch (err) {
      report(err);
    }
  }

  function toggleButton(file) {
    const button = h('button', { type: 'button', class: `btn btn-sm${file.removed ? '' : ' btn-danger'}` },
      file.removed ? 'Restore' : 'Remove');
    button.addEventListener('click', async () => {
      button.disabled = true;
      el.status.textContent = '';
      try {
        await api(`/api/workspaces/${ws.code}/files/${file.id}`, {
          method: 'PATCH',
          headers: { ...opts.authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ removed: !file.removed }),
        });
      } catch (err) {
        report(err);
      }
      await reload();
    });
    return button;
  }

  /** Admin-only permanent delete; `file` null means every removed file. */
  async function purge(file, button) {
    const removed = ws.files.filter((f) => f.removed);
    const targets = file ? [file] : removed;
    const bytes = formatBytes(targets.reduce((sum, f) => sum + f.size, 0));
    const question = file
      ? `Permanently delete "${file.name}"?\n\nThis frees ${bytes} and cannot be undone.`
      : `Permanently delete all ${targets.length} removed file${targets.length === 1 ? '' : 's'}?\n\n`
        + `This frees ${bytes} and cannot be undone.`;
    if (targets.length === 0 || !window.confirm(question)) return;
    button.disabled = true;
    el.status.textContent = '';
    try {
      const path = file
        ? `/api/admin/workspaces/${ws.code}/files/${file.id}`
        : `/api/admin/workspaces/${ws.code}/removed`;
      await api(path, { method: 'DELETE', headers: opts.authHeaders() });
    } catch (err) {
      report(err);
    }
    button.disabled = false;
    await reload();
  }

  async function deleteWorkspace() {
    const { code, name } = ws;
    const typed = window.prompt(
      `Delete "${name}" and all ${ws.files.length} file${ws.files.length === 1 ? '' : 's'} `
      + `(${formatBytes(ws.usedBytes)})?\n\nThis cannot be undone. Type the code ${code} to confirm:`,
    );
    if (typed === null) return;
    if (typed.trim() !== code) {
      el.status.textContent = 'The code did not match, so nothing was deleted.';
      return;
    }
    deleteWsButton.disabled = true;
    el.status.textContent = '';
    try {
      await api(`/api/workspaces/${code}`, { method: 'DELETE', headers: opts.authHeaders() });
      ws = null;
      opts.onDeleted?.(code);
    } catch (err) {
      report(err);
      deleteWsButton.disabled = false;
    }
  }

  function removedActions(file) {
    if (!opts.canPurge) return toggleButton(file);
    const del = h('button', { type: 'button', class: 'btn btn-sm btn-danger', title: 'Delete permanently' },
      'Delete forever');
    del.addEventListener('click', () => purge(file, del));
    return h('span', { class: 'action-group' }, toggleButton(file), del);
  }

  function render() {
    const active = ws.files.filter((f) => !f.removed);
    const removed = ws.files.filter((f) => f.removed);
    el.name.textContent = ws.name;
    el.code.textContent = ws.code;
    el.meta.textContent = `Created ${new Date(ws.createdAt).toLocaleDateString()} · ${formatBytes(ws.totalBytes)} shared`;
    renderStorage();
    const { lan, tunnel } = opts.getLinks();
    el.links.replaceChildren(
      shareLink('LAN', lan ?? location.origin, ws.code),
      ...(tunnel ? [shareLink('Tunnel', tunnel, ws.code)] : []),
    );
    el.active.replaceChildren(...active.map((f) => fileRow(f, toggleButton(f))));
    el.activeEmpty.hidden = active.length > 0;
    el.activeCount.textContent = String(active.length);
    el.removed.replaceChildren(...removed.map((f) => fileRow(f, removedActions(f))));
    el.removedCount.textContent = String(removed.length);
    removedWrap.hidden = removed.length === 0;
  }

  function renderStorage() {
    const { usedBytes, quotaBytes } = ws;
    const removedNote = ws.files.some((f) => f.removed) ? ' · removed files still count' : '';
    el.meter.hidden = quotaBytes === null;
    if (quotaBytes === null) {
      el.meterText.textContent = `${formatBytes(usedBytes)} used · no storage limit`;
      return;
    }
    const ratio = Math.min(usedBytes / quotaBytes, 1);
    el.meter.value = ratio;
    el.meter.classList.toggle('is-high', ratio >= 0.9);
    el.meterText.textContent = `${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used${removedNote}`;
  }

  const spaceLeft = () => (ws.quotaBytes === null ? Infinity : ws.quotaBytes - ws.usedBytes);

  async function uploadAll(files) {
    if (!ws || files.length === 0) return;
    const code = ws.code;
    el.status.textContent = '';
    const jobs = files.map((file) => {
      const progress = h('progress', { max: '1', value: '0' });
      const status = h('span', { class: 'upload-status' }, 'Waiting');
      const row = h('li', { class: 'upload' }, h('span', { class: 'upload-name' }, file.name), progress, status);
      return { file, row, progress, status };
    });
    el.uploads.prepend(...jobs.map((j) => j.row));

    for (const job of jobs) {
      if (job.file.size > opts.maxUploadBytes) {
        job.status.textContent = 'Too large';
        job.row.classList.add('is-error');
        continue;
      }
      if (job.file.size > spaceLeft()) {
        job.status.textContent = 'Not enough space';
        job.row.classList.add('is-error');
        continue;
      }
      job.status.textContent = 'Uploading';
      try {
        await uploadFile(code, job.file, opts.authHeaders(), (ratio) => { job.progress.value = ratio; });
        job.progress.value = 1;
        job.status.textContent = 'Done';
        job.row.classList.add('is-done');
        setTimeout(() => job.row.remove(), 4000);
      } catch (err) {
        if (err.status === 401) {
          opts.onAuthError();
          return;
        }
        job.status.textContent = err.message;
        job.row.classList.add('is-error');
      }
      await reload();
    }
  }

  purgeAllButton.addEventListener('click', () => purge(null, purgeAllButton));
  deleteWsButton.addEventListener('click', deleteWorkspace);
  el.fileInput.addEventListener('change', () => {
    uploadAll([...el.fileInput.files]);
    el.fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-over');
  }));
  ['dragleave', 'drop'].forEach((type) => dropzone.addEventListener(type, () => dropzone.classList.remove('is-over')));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    uploadAll([...event.dataTransfer.files]);
  });
  if (!pageDropGuard) {
    // Dropping outside the zone must not navigate away from the page.
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => event.preventDefault());
    pageDropGuard = true;
  }

  return {
    root,
    get code() { return ws?.code ?? null; },
    show(next) {
      ws = next;
      deleteWsButton.disabled = false;
      el.status.textContent = '';
      render();
    },
    reload,
  };
}
