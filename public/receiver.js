import {
  CODE_MIN, CODE_RE, api, cleanCode, fileRow, formatBytes, h, owned, wireCodeGenerator,
} from './common.js';
import { createManager } from './manager.js';
import { trackClicks } from './transfers.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['entry', 'create', 'manage', 'workspace'];
const input = $('code');
const slots = [...document.querySelectorAll('.code-slot')];

let config = { canCreate: false, maxUploadBytes: 0, links: null };
let receiving = null;

function showView(name) {
  VIEWS.forEach((v) => { $(v).hidden = v !== name; });
  window.scrollTo(0, 0);
}

/** Go home without adding a history entry and without re-routing. */
function goHome(message = '') {
  history.replaceState(null, '', location.pathname);
  showEntry(message);
}

// ---- entry ------------------------------------------------------------------

function renderSlots() {
  const value = input.value;
  const focused = document.activeElement === input;
  slots.forEach((slot, i) => {
    slot.textContent = value[i] ?? '';
    slot.classList.toggle('is-filled', i < value.length);
    slot.classList.toggle('is-current', focused && i === Math.min(value.length, slots.length - 1));
  });
  $('open-btn').disabled = value.length < CODE_MIN;
}

function renderMine() {
  const mine = Object.entries(owned.all())
    .sort(([, a], [, b]) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  $('mine').hidden = !config.canCreate || mine.length === 0;
  $('mine-list').replaceChildren(...mine.map(([code, entry]) => h('li', {},
    h('a', { class: 'ws-item', href: `#${code}` },
      h('span', { class: 'ws-item-name' }, entry.name ?? code),
      h('span', { class: 'ws-item-meta' }, h('code', {}, code), ' · you manage this')))));
}

function showEntry(message = '') {
  receiving = null;
  showView('entry');
  $('code-error').textContent = message;
  $('share-cta').hidden = !config.canCreate;
  renderMine();
  input.focus();
  renderSlots();
}

// ---- receive ------------------------------------------------------------------

function renderReceive(ws) {
  receiving = ws;
  showView('workspace');
  $('ws-code').textContent = ws.code;
  $('ws-name').textContent = ws.name;
  const count = ws.files.length;
  $('ws-meta').textContent = `${count} file${count === 1 ? '' : 's'} · ${formatBytes(ws.totalBytes)}`;
  const list = $('transfers');
  $('file-list').replaceChildren(...ws.files.map((file) => {
    const link = h('a', { class: 'btn btn-primary btn-sm', href: `/api/w/${ws.code}/files/${file.id}`, download: file.name },
      'Download');
    trackClicks(link, { fileName: file.name, totalBytes: file.size, list });
    return fileRow(file, link);
  }));
  $('empty').hidden = count > 0;
  const all = $('download-all');
  all.hidden = count < 2;
  all.href = `/api/w/${ws.code}/zip`;
  all.download = `${ws.name}.zip`;
  all.title = `Download all ${count} files as one .zip`;
  $('download-all-label').textContent = `Download all (${formatBytes(ws.totalBytes)})`;
}

// The "Download all" link is static, so wire its click once; it reads the
// current workspace at click time.
trackClicks($('download-all'), {
  get fileName() { return receiving ? `${receiving.name}.zip` : 'files.zip'; },
  get totalBytes() { return receiving?.totalBytes ?? 0; },
  list: $('transfers'),
});

function messageFor(err) {
  if (err.status === 404) return 'No workspace matches that code. Check the letters: case matters.';
  if (err.status === 429) return 'Too many wrong codes from this device. Wait a few minutes and try again.';
  return err.message;
}

async function showReceive(code) {
  try {
    renderReceive(await api(`/api/w/${code}`));
  } catch (err) {
    input.value = code;
    goHome(messageFor(err));
  }
}

$('refresh-btn').addEventListener('click', async () => {
  if (!receiving) return;
  $('refresh-btn').disabled = true;
  await showReceive(receiving.code);
  $('refresh-btn').disabled = false;
});

// ---- create & manage -------------------------------------------------------------

function showCreate() {
  showView('create');
  $('create-error').textContent = '';
  $('ws-name-input').focus();
}

async function showManage(code) {
  const entry = owned.get(code);
  const lost = () => {
    owned.forget(code);
    goHome('That workspace was deleted, or this browser can no longer manage it.');
  };
  const manager = createManager({
    authHeaders: () => ({ 'X-Owner-Token': entry.token }),
    maxUploadBytes: config.maxUploadBytes,
    getLinks: () => config.links ?? { lan: null, tunnel: null },
    onAuthError: lost,
    onChanged: (ws) => owned.save(code, { ...entry, name: ws.name }),
    canDeleteWorkspace: true,
    onDeleted: () => {
      owned.forget(code);
      goHome(`Workspace ${code} was deleted.`);
    },
  });
  try {
    const ws = await api(`/api/workspaces/${code}`, { headers: { 'X-Owner-Token': entry.token } });
    manager.show(ws);
    $('manage-body').replaceChildren(manager.root);
    showView('manage');
  } catch (err) {
    if (err.status === 401) lost();
    else goHome(err.message);
  }
}

$('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('ws-code-input').value;
  const error = $('create-error');
  if (code && !CODE_RE.test(code)) {
    error.textContent = 'Code must be 4–8 characters.';
    return;
  }
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const { workspace, ownerToken } = await api('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('ws-name-input').value, code }),
    });
    owned.save(workspace.code, { token: ownerToken, name: workspace.name, createdAt: workspace.createdAt });
    event.target.reset();
    location.hash = workspace.code;
  } catch (err) {
    error.textContent = err.status === 403 ? 'Workspaces can only be created on the local network.' : err.message;
  } finally {
    submit.disabled = false;
  }
});

wireCodeGenerator({
  input: $('ws-code-input'),
  lengthSelect: $('gen-length'),
  button: $('gen-btn'),
  onGenerate: () => { $('create-error').textContent = ''; },
});

// ---- routing: ''  → entry · #new → create · #Code → manage (if mine) or receive ----

function route() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash === 'new') return config.canCreate ? showCreate() : goHome();
  const code = cleanCode(hash);
  if (!code) return showEntry();
  if (config.canCreate && owned.get(code)) return showManage(code);
  return showReceive(code);
}

input.addEventListener('input', () => {
  const cleaned = cleanCode(input.value);
  if (cleaned !== input.value) input.value = cleaned;
  $('code-error').textContent = '';
  renderSlots();
});
input.addEventListener('focus', renderSlots);
input.addEventListener('blur', renderSlots);
document.querySelector('.code-field').addEventListener('click', () => input.focus());
$('code-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!CODE_RE.test(input.value)) {
    $('code-error').textContent = 'Codes are 4–8 characters: digits 1–9 and letters.';
    return;
  }
  location.hash = input.value;
});
window.addEventListener('hashchange', route);

try {
  config = await api('/api/config');
} catch {
  // Server unreachable: receiving still works once it is back.
}
$('new-link').hidden = !config.canCreate;
route();
