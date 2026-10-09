'use strict';

/* Shared client helpers: auth bootstrap, CSRF-aware fetch, SSE, formatting,
   and the job-card renderer used by both the submit and history pages. */

let csrfToken = null;
let currentUser = null;

async function ensureCsrf() {
  if (csrfToken) return csrfToken;
  const data = await api('/api/csrf');
  csrfToken = data.token;
  return csrfToken;
}

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = Object.assign({}, options.headers);
  const hasBody = options.body !== undefined;
  if (hasBody) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') {
    headers['x-csrf-token'] = await ensureCsrf();
  }

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: hasBody ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    throw new Error('Network error — is the server reachable?');
  }

  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const message = (data && data.error && data.error.message) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.code = data && data.error ? data.error.code : null;
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function bootstrap(activePage) {
  const me = await api('/api/me');
  if (me.csrfToken) csrfToken = me.csrfToken;
  currentUser = me.authenticated ? me.user : null;
  renderHeader(me, activePage);
  return me;
}

function renderHeader(me, activePage) {
  const el = document.getElementById('topnav');
  if (!el) return;
  const link = (href, label, key) =>
    `<a href="${href}" class="${activePage === key ? 'active' : ''}">${label}</a>`;

  if (!me.authenticated) {
    el.innerHTML = `<a href="/auth/google">Sign in with Google</a>`;
    return;
  }
  const admin = me.user.isAdmin ? link('/admin.html', 'Admin', 'admin') : '';
  el.innerHTML =
    link('/', 'Transfer', 'submit') +
    link('/history.html', 'History', 'history') +
    admin +
    `<span class="who">${escapeHtml(me.user.email)}</span>` +
    `<button class="ghost" id="signout">Sign out</button>`;

  document.getElementById('signout').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST', body: {} }); } catch (e) { /* ignore */ }
    location.href = '/';
  });
}

function connectProgress(handlers) {
  const es = new EventSource('/api/events');
  es.addEventListener('progress', (e) => {
    try { handlers.onProgress(JSON.parse(e.data)); } catch (err) { /* ignore */ }
  });
  es.addEventListener('snapshot', (e) => {
    try { handlers.onSnapshot(JSON.parse(e.data)); } catch (err) { /* ignore */ }
  });
  // EventSource reconnects on its own; surface the state so the UI can dim.
  es.onopen = () => handlers.onStatus && handlers.onStatus(true);
  es.onerror = () => handlers.onStatus && handlers.onStatus(false);
  return es;
}

/* ------------------------------------------------------------------ format */

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${value >= 10 || exp === 0 ? Math.round(value) : value.toFixed(1)} ${units[exp]}`;
}

function formatSpeed(bps) {
  if (!bps || bps <= 0) return '—';
  return `${formatBytes(bps)}/s`;
}

function formatEta(seconds) {
  if (seconds === null || seconds === undefined || !isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function truncateMiddle(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(-half)}`;
}

/* --------------------------------------------------------------- job cards */

const PHASE_LABEL = {
  queued: 'Queued',
  probing: 'Checking source',
  naming: 'Preparing name',
  session: 'Opening upload',
  streaming: 'Streaming',
  finalizing: 'Finalizing',
  done: 'Done',
};

function jobCard(job) {
  const el = document.createElement('div');
  el.className = 'job';
  el.dataset.jobId = job.id;
  el.innerHTML = `
    <div class="head">
      <span class="pill ${escapeHtml(job.status)}" data-f="status">${escapeHtml(job.status)}</span>
      <span class="name" data-f="name">${escapeHtml(job.fileName || truncateMiddle(job.sourceUrl, 60))}</span>
      <span class="meta" data-f="meta"></span>
    </div>
    <div class="src mono" data-f="src">${escapeHtml(truncateMiddle(job.sourceUrl, 110))}</div>
    <div class="bar" data-f="bar"><span data-f="fill"></span></div>
    <div class="foot">
      <span data-f="phase" class="muted"></span>
      <span data-f="bytes"></span>
      <span data-f="speed"></span>
      <span data-f="eta"></span>
      <span class="actions" data-f="actions"></span>
    </div>
    <div class="error hidden" data-f="error"></div>`;
  paintJob(el, job);
  return el;
}

function field(el, name) {
  return el.querySelector(`[data-f="${name}"]`);
}

function paintJob(el, job) {
  el.classList.toggle('failed', job.status === 'FAILED');

  const pill = field(el, 'status');
  pill.className = `pill ${job.status}`;
  pill.textContent = job.status;

  if (job.fileName) field(el, 'name').textContent = job.fileName;

  const pct = job.progress === null || job.progress === undefined ? null : Math.max(0, Math.min(1, job.progress));
  const bar = field(el, 'bar');
  const fill = field(el, 'fill');
  if (pct === null) {
    bar.classList.add('indet');
    fill.style.width = '30%';
  } else {
    bar.classList.remove('indet');
    fill.style.width = `${(pct * 100).toFixed(1)}%`;
  }

  const phase = job.status === 'COMPLETED' ? 'Done' : (PHASE_LABEL[job.phase] || job.status);
  field(el, 'phase').textContent = phase;

  field(el, 'bytes').textContent =
    job.totalBytes === null
      ? formatBytes(job.transferredBytes)
      : `${formatBytes(job.transferredBytes)} / ${formatBytes(job.totalBytes)}${pct !== null ? ` (${Math.round(pct * 100)}%)` : ''}`;
  field(el, 'speed').textContent = job.status === 'TRANSFERRING' ? formatSpeed(job.speedBps) : '';
  field(el, 'eta').textContent =
    job.status === 'TRANSFERRING' && job.etaSeconds !== null ? `ETA ${formatEta(job.etaSeconds)}` : '';

  field(el, 'meta').textContent =
    job.attempts > 1 ? `attempt ${job.attempts}/${job.maxAttempts}` : '';

  const errEl = field(el, 'error');
  if (job.errorMessage && job.status !== 'COMPLETED') {
    errEl.classList.remove('hidden');
    errEl.textContent = job.errorMessage;
  } else {
    errEl.classList.add('hidden');
    errEl.textContent = '';
  }

  const actions = field(el, 'actions');
  actions.innerHTML = '';
  const add = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.appendChild(b);
  };

  if (job.status === 'QUEUED' || job.status === 'TRANSFERRING') {
    add('Cancel', 'ghost', () => act(job.id, 'cancel'));
  }
  if (job.status === 'FAILED' || job.status === 'CANCELLED') {
    add('Retry', 'ghost', () => act(job.id, 'retry'));
  }
  if (job.driveWebUrl) {
    add('Open in Drive', 'ghost', () => window.open(job.driveWebUrl, '_blank', 'noopener'));
  }
  add('Remove', 'ghost danger', () => {
    if (confirm('Remove this job from your history?')) act(job.id, 'remove');
  });
}

/* Action dispatcher — pages register handlers so cards stay decoupled. */
const actionHandlers = {};
function onAction(kind, fn) { actionHandlers[kind] = fn; }
async function act(id, kind) {
  const fn = actionHandlers[kind];
  if (!fn) return;
  try { await fn(id); } catch (err) { showError(err.message); }
}

function showError(message) {
  const el = document.getElementById('alert');
  if (!el) { alert(message); return; }
  el.className = 'alert err';
  el.textContent = message;
}
function showOk(message) {
  const el = document.getElementById('alert');
  if (!el) return;
  el.className = 'alert ok';
  el.textContent = message;
  setTimeout(() => { el.className = 'alert'; el.textContent = ''; }, 5000);
}
function clearAlert() {
  const el = document.getElementById('alert');
  if (el) { el.className = 'alert'; el.textContent = ''; }
}
