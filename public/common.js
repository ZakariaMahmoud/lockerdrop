export const CODE_MIN = 4;
export const CODE_MAX = 8;
export const CODE_RE = /^[1-9A-Za-z]{4,8}$/;
// Generated codes skip I, l and O, which are easy to misread as 1 and 0.
const CODE_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Drops characters that can never be part of a code. */
export const cleanCode = (value) => value.replace(/[^1-9A-Za-z]/g, '').slice(0, CODE_MAX);

export function randomCode(length = CODE_MAX) {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes ?? 0} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function extOf(name) {
  const match = /\.([A-Za-z0-9]{1,4})$/.exec(name);
  return match ? match[1].toUpperCase() : 'FILE';
}

/** Tiny DOM builder. Strings become text nodes, so user data is never parsed as HTML. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

export function fileRow(file, action) {
  return h('li', { class: `file${file.removed ? ' is-removed' : ''}` },
    h('span', { class: 'file-ext', 'aria-hidden': 'true' }, extOf(file.name)),
    h('span', { class: 'file-main' },
      h('span', { class: 'file-name', title: file.name }, file.name),
      h('span', { class: 'file-meta' }, `${formatBytes(file.size)} · ${formatDate(file.uploadedAt)}`)),
    h('span', { class: 'file-actions' }, action));
}

export async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw Object.assign(new Error('Cannot reach the server. Check your connection.'), { status: 0 });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    throw Object.assign(new Error(body?.error ?? `Request failed (${res.status})`), { status: res.status });
  }
  return body.data;
}

/** localStorage that never throws (private mode, blocked storage). */
export const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  },
};

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; plain-http LAN pages fall back here.
    const area = h('textarea', { readonly: true, class: 'sr-only' }, text);
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  }
}

/** Upload with progress. `headers` carries X-Admin-Key or X-Owner-Token. */
export function uploadFile(code, file, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/workspaces/${code}/files`);
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.addEventListener('progress', (e) => e.lengthComputable && onProgress(e.loaded / e.total));
    xhr.addEventListener('load', () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON error */ }
      if (xhr.status >= 200 && xhr.status < 300 && body?.success) resolve(body.data);
      else reject(Object.assign(new Error(body?.error ?? `Upload failed (${xhr.status})`), { status: xhr.status }));
    });
    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.send(file);
  });
}

// Storage keys keep the project's original "shareLocal" prefix on purpose:
// renaming them would sign admins out and orphan participants' workspaces.
const CODE_LENGTH_KEY = 'shareLocal.codeLength';

/** Random-code button + length picker that fill a code input. */
export function wireCodeGenerator({ input, lengthSelect, button, onGenerate }) {
  const saved = storage.get(CODE_LENGTH_KEY);
  if (saved && lengthSelect.querySelector(`option[value="${saved}"]`)) lengthSelect.value = saved;
  lengthSelect.addEventListener('change', () => storage.set(CODE_LENGTH_KEY, lengthSelect.value));
  input.addEventListener('input', () => {
    const cleaned = cleanCode(input.value);
    if (cleaned !== input.value) input.value = cleaned;
  });
  button.addEventListener('click', () => {
    input.value = randomCode(Number(lengthSelect.value));
    input.classList.remove('is-generated');
    void input.offsetWidth; // restart the highlight animation
    input.classList.add('is-generated');
    onGenerate?.();
  });
}

const OWNED_KEY = 'shareLocal.owned';

/** Workspaces this browser created, with the owner token that manages them. */
export const owned = {
  all() {
    try {
      const value = JSON.parse(storage.get(OWNED_KEY) ?? '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  },
  get(code) {
    return Object.hasOwn(owned.all(), code) ? owned.all()[code] : null;
  },
  save(code, entry) {
    storage.set(OWNED_KEY, JSON.stringify({ ...owned.all(), [code]: entry }));
  },
  forget(code) {
    const { [code]: _removed, ...rest } = owned.all();
    storage.set(OWNED_KEY, JSON.stringify(rest));
  },
};
