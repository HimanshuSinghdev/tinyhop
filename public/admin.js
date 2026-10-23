// Admin page: review reported links and act on them. Needs the ADMIN_TOKEN secret.
// The token is kept in sessionStorage only, so closing the tab signs you out.

const $ = (selector) => document.querySelector(selector);
const KEY = 'tinyhop:admin-token';

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

let token = '';
try { token = sessionStorage.getItem(KEY) ?? ''; } catch { /* storage blocked */ }

function remember(value) {
  token = value;
  try {
    if (value) sessionStorage.setItem(KEY, value);
    else sessionStorage.removeItem(KEY);
  } catch { /* storage blocked */ }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data?.error?.message ?? 'Something went wrong. Please try again.'), { status: res.status });
  }
  return data;
}

function setMessage(text, isError = false) {
  const msg = $('#msg');
  msg.textContent = text;
  msg.classList.toggle('error', isError);
}

function showPanel(signedIn) {
  $('#login').hidden = signedIn;
  $('#panel').hidden = !signedIn;
}

const button = (label, onclick, extra = '') =>
  el('button', { type: 'button', className: `text-btn ${extra}`.trim(), textContent: label, onclick });

async function act(code, action, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    await api(`/api/admin/links/${code}`, { action });
    setMessage('');
    await load();
  } catch (err) {
    setMessage(err.message, true);
  }
}

const FLAG_LABEL = { disabled: 'Disabled', warn: 'Warning shown' };

function row(report) {
  const gone = !report.url;
  const label = gone ? 'Link deleted' : FLAG_LABEL[report.flag];
  const reasons = String(report.reasons ?? '').split(',').filter(Boolean).join(', ');
  const code = report.code;

  const actions = [];
  if (!gone) {
    if (report.flag) actions.push(button('Restore', () => act(code, 'restore')));
    else {
      actions.push(button('Warn', () => act(code, 'warn')));
      actions.push(button('Disable', () => act(code, 'disable')));
    }
    actions.push(button('Delete link', () => act(code, 'delete', `Delete ${code} and its click data? This cannot be undone.`), 'danger'));
  }
  actions.push(button('Dismiss', () => act(code, 'dismiss')));

  return el(
    'li',
    { className: 'row' },
    el(
      'div',
      { className: 'row-main' },
      el(
        'span',
        {},
        el('a', { className: 'row-short', href: `/p/${code}`, target: '_blank', rel: 'noopener', textContent: code }),
        label ? el('span', { className: 'tag', textContent: label }) : null,
      ),
      el('span', { className: 'row-url', textContent: report.url ?? '(link no longer exists)', title: report.url ?? '' }),
      el('span', { className: 'muted wrap', textContent: report.note ? `${reasons}: ${report.note}` : reasons }),
    ),
    el(
      'div',
      { className: 'row-clicks' },
      el('strong', { textContent: String(report.reports) }),
      el('span', { textContent: report.reports === 1 ? 'report' : 'reports' }),
    ),
    el('div', { className: 'row-actions' }, actions),
  );
}

async function load() {
  try {
    const { reports } = await api('/api/admin/reports');
    $('#reports').replaceChildren(...reports.map(row));
    $('#none').hidden = reports.length > 0;
    showPanel(true);
  } catch (err) {
    if (err.status === 401 || err.status === 404) {
      remember('');
      showPanel(false);
    }
    setMessage(err.message, true);
  }
}

$('#login').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('#token').value.trim();
  if (!value) { setMessage('Enter your admin token.', true); return; }
  remember(value);
  $('#token').value = '';
  setMessage('');
  load();
});

$('#signout').addEventListener('click', () => {
  remember('');
  showPanel(false);
  setMessage('');
});

if (token) load();
else showPanel(false);
