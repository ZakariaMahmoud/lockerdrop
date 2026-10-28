import { CODE_RE, api, formatBytes, h, storage, wireCodeGenerator } from './common.js';
import { createManager } from './manager.js';

// Original "shareLocal" prefix kept so saved keys survive the rename (see common.js).
const KEY_STORAGE = 'shareLocal.adminKey';
const LAST_WS_STORAGE = 'shareLocal.lastWorkspace';
const $ = (id) => document.getElementById(id);

let state = { key: storage.get(KEY_STORAGE), session: null, workspaces: [], manager: null };
const setState = (patch) => {
  state = { ...state, ...patch };
};

const authHeaders = () => ({ 'X-Admin-Key': state.key ?? '' });

function adminApi(path, options = {}) {
  const headers = { ...authHeaders(), ...options.headers };
  if (options.body) headers['Content-Type'] = 'application/json';
  return api(path, { ...options, headers });
}

// ---- auth ---------------------------------------------------------------

function showLogin(message = '') {
  $('dashboard').hidden = true;
  $('logout-btn').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = message;
  $('key').focus();
}

function logout(message = '') {
  storage.remove(KEY_STORAGE);
  setState({ key: null, session: null, workspaces: [], manager: null });
  $('detail-body').replaceChildren();
  showLogin(message);
}

const expired = () => logout('Your saved key is no longer valid. Enter it again.');

/** Runs an admin action; a 401 sends the user back to the key prompt. */
async function guarded(action, onError) {
  try {
    return await action();
  } catch (err) {
    if (err.status === 401) expired();
    else onError(err);
    return undefined;
  }
}

async function unlock(key) {
  setState({ key });
  try {
    const session = await adminApi('/api/admin/session');
    storage.set(KEY_STORAGE, key);
    setState({ session });
  } catch (err) {
    storage.remove(KEY_STORAGE);
    setState({ key: null });
    showLogin(err.status === 401 ? 'That key is not right.' : err.message);
    return;
  }
  $('login').hidden = true;
  $('dashboard').hidden = false;
  $('logout-btn').hidden = false;
  renderSettings();
  await refreshList();
  const last = storage.get(LAST_WS_STORAGE);
  if (last && state.workspaces.some((w) => w.code === last)) await openWorkspace(last);
}

// ---- workspaces -----------------------------------------------------------

async function refreshList() {
  const workspaces = await guarded(() => adminApi('/api/admin/workspaces'), (err) => alert(err.message));
  if (!workspaces) return;
  setState({ workspaces });
  renderList();
}

function renderList() {
  const current = state.manager?.code;
  const items = state.workspaces.map((ws) => h('li', {},
    h('button', {
      type: 'button',
      class: `ws-item${current === ws.code ? ' is-active' : ''}`,
      onclick: () => openWorkspace(ws.code),
    },
    h('span', { class: 'ws-item-name' }, h('span', { class: 'ws-item-label' }, ws.name),
      ws.createdBy === 'participant' ? h('span', { class: 'tag' }, 'participant') : null),
    h('span', { class: 'ws-item-meta' },
      h('code', {}, ws.code), ` · ${ws.fileCount} file${ws.fileCount === 1 ? '' : 's'} · ${formatBytes(ws.totalBytes)}`))));
  $('ws-list').replaceChildren(...(items.length ? items : [h('li', { class: 'muted small' }, 'No workspaces yet.')]));
}

function managerFor() {
  if (state.manager) return state.manager;
  const manager = createManager({
    authHeaders,
    maxUploadBytes: state.session.maxUploadBytes,
    getLinks: () => state.session.links,
    onAuthError: expired,
    onChanged: () => refreshList(),
    canPurge: true,
    canDeleteWorkspace: true,
    onDeleted: workspaceDeleted,
  });
  $('detail-body').replaceChildren(manager.root);
  setState({ manager });
  return manager;
}

async function workspaceDeleted(code) {
  if (storage.get(LAST_WS_STORAGE) === code) storage.remove(LAST_WS_STORAGE);
  setState({ manager: null });
  $('detail-body').replaceChildren();
  $('detail-body').hidden = true;
  const notice = $('detail-empty');
  notice.textContent = `Workspace ${code} was deleted. Create a workspace or pick one from the list.`;
  notice.hidden = false;
  await refreshList();
}

async function openWorkspace(code) {
  const ws = await guarded(() => adminApi(`/api/workspaces/${code}`), (err) => alert(err.message));
  if (!ws) return;
  managerFor().show(ws);
  storage.set(LAST_WS_STORAGE, code);
  $('detail-empty').hidden = true;
  $('detail-body').hidden = false;
  renderList();
}

// ---- share-link & storage settings ------------------------------------------

const GB = 1024 ** 3;
const MB_PER_GB = 1024;

/** GB text from the form → whole MB for the API ('' stays '' = unlimited). */
function limitMbFromInput(value) {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const gb = Number(trimmed);
  return Number.isFinite(gb) && gb > 0 ? Math.max(1, Math.round(gb * MB_PER_GB)) : trimmed;
}

function renderSettings() {
  const { settings, detectedLanUrls, links } = state.session;
  $('lan-url-input').value = settings.lanUrl ?? '';
  $('lan-url-input').placeholder = detectedLanUrls[0] ? `auto (${detectedLanUrls[0]})` : 'auto';
  $('tunnel-url-input').value = links.tunnel ?? '';
  const quota = state.session.workspaceQuotaBytes;
  $('limit-input').value = quota === null ? '' : String(+(quota / GB).toFixed(3));
  $('lan-url-chips').replaceChildren(...detectedLanUrls.map((url) => h('button', {
    type: 'button',
    class: 'chip',
    title: 'Use this address',
    onclick: () => {
      $('lan-url-input').value = url;
      $('lan-url-input').focus();
    },
  }, url.replace(/^https?:\/\//, ''))));
}

$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('settings-error');
  error.textContent = '';
  const view = await guarded(
    () => adminApi('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        lanUrl: $('lan-url-input').value,
        publicUrl: $('tunnel-url-input').value,
        workspaceLimitMb: limitMbFromInput($('limit-input').value),
      }),
    }),
    (err) => { error.textContent = err.message; },
  );
  if (!view) return;
  setState({ session: { ...state.session, ...view } });
  renderSettings();
  if (state.manager?.code) await state.manager.reload(); // refresh links and storage shown
  const saved = $('settings-saved');
  saved.hidden = false;
  setTimeout(() => { saved.hidden = true; }, 1800);
});

// ---- wiring -------------------------------------------------------------------

$('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const key = $('key').value.trim();
  if (key) unlock(key);
});

$('logout-btn').addEventListener('click', () => logout());

wireCodeGenerator({
  input: $('ws-code-input'),
  lengthSelect: $('gen-length'),
  button: $('gen-btn'),
  onGenerate: () => { $('create-error').textContent = ''; },
});

$('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('ws-code-input').value;
  const error = $('create-error');
  if (code && !CODE_RE.test(code)) {
    error.textContent = 'Code must be 4–8 characters.';
    return;
  }
  error.textContent = '';
  const created = await guarded(
    () => adminApi('/api/admin/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: $('ws-name-input').value, code }),
    }),
    (err) => { error.textContent = err.message; },
  );
  if (!created) return;
  event.target.reset();
  await refreshList();
  await openWorkspace(created.code);
});

if (state.key) unlock(state.key);
else showLogin();
