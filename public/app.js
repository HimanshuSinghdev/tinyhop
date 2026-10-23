// Tinyhop frontend: one plain ES module. No framework, no build step, no tracking.
// Style: small pure functions, explicit state in one place, DOM built with textContent
// (never innerHTML) so nothing a user types can become markup.

const SVG_NS = 'http://www.w3.org/2000/svg';
const STORE_KEY = 'tinyhop:links:v1';
const MAX_SAVED = 50;

const $ = (selector, root = document) => root.querySelector(selector);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'attrs') for (const [k, v] of Object.entries(value)) node.setAttribute(k, v);
    else node[key] = value;
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

// ---------- pure helpers ----------

const numberFormat = new Intl.NumberFormat();
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const regionNames = (() => {
  try { return new Intl.DisplayNames(undefined, { type: 'region' }); } catch { return null; }
})();

const plural = (n, one, many) => `${numberFormat.format(n)} ${n === 1 ? one : many}`;

function relativeTime(timestamp, now = Date.now()) {
  const diff = timestamp - now;
  for (const [unit, ms] of [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]]) {
    if (Math.abs(diff) >= ms) return relativeFormat.format(Math.round(diff / ms), unit);
  }
  return 'just now';
}

const expiryText = (expiresAt, now = Date.now()) =>
  !expiresAt ? 'Never expires' : expiresAt <= now ? `Expired ${relativeTime(expiresAt, now)}` : `Expires ${relativeTime(expiresAt, now)}`;

const countryName = (code) =>
  code === 'XX' || !code ? 'Unknown' : (regionNames?.of(code) ?? code);

const stripScheme = (url) => url.replace(/^https?:\/\//i, '');

const savedPercent = (longLength, shortLength) =>
  Math.max(0, Math.round((1 - shortLength / longLength) * 100));

// Saved links (with their secret manage keys) live only in this browser.
const loadLinks = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};
const persistLinks = (links) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(links)); } catch { /* private mode */ } };
const withLink = (links, link) => [link, ...links.filter((l) => l.code !== link.code)].slice(0, MAX_SAVED);
const withoutLink = (links, code) => links.filter((l) => l.code !== code);

// ---------- state ----------

let links = loadLinks();
let currentLink = null; // the link shown in the result panel

function setLinks(next) {
  links = next;
  persistLinks(links);
  renderHistory();
}

// ---------- network ----------

async function api(path, { method = 'GET', body, token } = {}) {
  const started = performance.now();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data?.error?.message ?? 'Something went wrong. Please try again.'), {
      status: res.status,
    });
  }
  return { data, ms: Math.round(performance.now() - started) };
}

// ---------- small UI helpers ----------

function flash(button, text) {
  const original = button.dataset.label ?? button.textContent;
  button.dataset.label = original;
  button.textContent = text;
  clearTimeout(button._flash);
  button._flash = setTimeout(() => { button.textContent = original; }, 1400);
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    flash(button, 'Copied');
  } catch {
    const area = el('textarea', { value: text });
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.('copy');
    area.remove();
    flash(button, ok ? 'Copied' : 'Press and hold to copy');
  }
}

function setMessage(text, isError = false) {
  const msg = $('#msg');
  msg.textContent = text;
  msg.classList.toggle('error', isError);
}

// ---------- result panel ----------

function showResult(link, ms) {
  currentLink = link;
  const shortUrl = `${location.origin}/${link.code}`;
  const display = `${location.host}/${link.code}`;

  $('#result').hidden = false;
  const anchor = $('#short-link');
  anchor.href = shortUrl;
  anchor.replaceChildren(`${location.host}/`, el('b', { textContent: link.code }));
  $('#share-btn').hidden = typeof navigator.share !== 'function';

  const longText = stripScheme(link.url);
  const longFill = $('#long-fill');
  const shortFill = $('#short-fill');
  longFill.textContent = longText;
  shortFill.textContent = display;
  longFill.style.width = '100%';
  shortFill.style.width = '100%';

  // The one animated moment: the short bar shrinks to show how much shorter the link got.
  const pct = Math.max(8, Math.round((display.length / Math.max(longText.length, display.length)) * 100));
  requestAnimationFrame(() => requestAnimationFrame(() => { shortFill.style.width = `${pct}%`; }));

  const saved = savedPercent(longText.length, display.length);
  $('#saved').textContent =
    saved > 0
      ? `Saved ${saved}%: ${plural(longText.length, 'character', 'characters')} down to ${display.length}.`
      : 'Already short, but now you can count clicks and set an expiry.';
  $('#result-meta').textContent = `Created in ${ms} ms. ${expiryText(link.expiresAt)}.`;
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- your links ----------

const textButton = (label, onclick, extra = '') =>
  el('button', { type: 'button', className: `text-btn ${extra}`.trim(), textContent: label, onclick });

function historyRow(link) {
  const shortUrl = `${location.origin}/${link.code}`;
  const expired = link.expiresAt && link.expiresAt <= Date.now();
  const clicks = link.clicks ?? 0;
  return el(
    'li',
    { className: 'row' },
    el(
      'div',
      { className: 'row-main' },
      el('span', {}, el('a', { className: 'row-short', href: shortUrl, target: '_blank', rel: 'noopener', textContent: `${location.host}/${link.code}` }), expired ? el('span', { className: 'tag', textContent: 'Expired' }) : null),
      el('span', { className: 'row-url', textContent: link.url, title: link.url }),
    ),
    el('div', { className: 'row-clicks' }, el('strong', { textContent: numberFormat.format(clicks) }), el('span', { textContent: clicks === 1 ? 'click' : 'clicks' })),
    el(
      'div',
      { className: 'row-actions' },
      textButton('Copy', (e) => copyText(shortUrl, e.currentTarget)),
      textButton('Stats', () => openStats(link)),
      textButton('QR code', () => openQr(link)),
      textButton('Delete', () => removeLinkFlow(link), 'danger'),
    ),
  );
}

function renderHistory() {
  $('#history-list').replaceChildren(...links.map(historyRow));
  $('#history-empty').hidden = links.length > 0;
}

// Pulls fresh click counts for everything saved here, in a single request.
async function refreshLinks() {
  if (links.length === 0) return;
  try {
    const { data } = await api('/links/lookup', {
      method: 'POST',
      body: { items: links.map(({ code, token }) => ({ code, token })) },
    });
    const fresh = new Map(data.links.map((l) => [l.code, l]));
    setLinks(links.filter((l) => fresh.has(l.code)).map((l) => ({ ...l, ...fresh.get(l.code) })));
  } catch { /* offline or rate limited: keep what we have */ }
}

async function removeLinkFlow(link) {
  if (!confirm(`Delete ${location.host}/${link.code}? The link stops working and its click data is erased.`)) return;
  try {
    await api(`/links/${link.code}`, { method: 'DELETE', token: link.token });
  } catch (err) {
    if (err.status !== 404) { alert(err.message); return; }
  }
  setLinks(withoutLink(links, link.code));
  if (currentLink?.code === link.code) { $('#result').hidden = true; currentLink = null; }
  $('#stats-dialog').close();
}

// ---------- stats dialog ----------

function chart(series) {
  const width = 300, height = 80, barWidth = width / series.length;
  const max = Math.max(1, ...series.map((d) => d.clicks));
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', class: 'chart', role: 'img',
    'aria-label': `Clicks per day over the last ${series.length} days`,
  });
  series.forEach((day, i) => {
    const barHeight = day.clicks ? Math.max(3, (day.clicks / max) * (height - 4)) : 1.5;
    const rect = svgEl('rect', {
      x: i * barWidth + 1, y: height - barHeight, width: barWidth - 2, height: barHeight, rx: 1,
      class: day.clicks ? '' : 'zero',
    });
    const title = svgEl('title');
    title.textContent = `${day.day}: ${plural(day.clicks, 'click', 'clicks')}`;
    rect.append(title);
    svg.append(rect);
  });
  return svg;
}

function breakdown(title, rows, label = (k) => k) {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return el(
    'div',
    { className: 'breakdown' },
    el('h3', { textContent: title }),
    rows.length === 0
      ? el('p', { textContent: 'No clicks yet.' })
      : el('ol', {}, rows.map((r) => {
          const meter = el('i');
          meter.style.width = `${Math.round((r.count / total) * 100)}%`;
          return el('li', {}, el('span', { textContent: label(r.key) }), el('span', { textContent: numberFormat.format(r.count) }), el('div', { className: 'meter' }, meter));
        })),
  );
}

function renderStats(body, stats, link) {
  const first = stats.series[0]?.day ?? '';
  const last = stats.series.at(-1)?.day ?? '';
  body.replaceChildren(
    el('p', { className: 'muted wrap', textContent: stats.url, title: stats.url }),
    el(
      'div',
      { className: 'kpis' },
      el('div', { className: 'kpi' }, el('strong', { textContent: numberFormat.format(stats.clicks) }), el('span', { textContent: stats.clicks === 1 ? 'click' : 'clicks' })),
      el('div', { className: 'kpi' }, el('strong', { textContent: stats.lastClickAt ? relativeTime(stats.lastClickAt) : 'None yet' }), el('span', { textContent: 'last click' })),
      el('div', { className: 'kpi' }, el('strong', { textContent: stats.expiresAt ? relativeTime(stats.expiresAt) : 'Never' }), el('span', { textContent: 'expires' })),
    ),
    chart(stats.series),
    el('div', { className: 'chart-caption' }, el('span', { textContent: first }), el('span', { textContent: last })),
    el(
      'div',
      { className: 'breakdowns' },
      breakdown('Countries', stats.countries, countryName),
      breakdown('Devices', stats.devices),
      breakdown('Browsers', stats.browsers),
      breakdown('Came from', stats.referrers),
    ),
    el(
      'div',
      { className: 'stats-foot' },
      el('span', { className: 'muted', textContent: 'Bots and link previews are not counted.' }),
      textButton('Delete this link', () => removeLinkFlow(link), 'danger'),
    ),
  );
}

async function openStats(link) {
  const dialog = $('#stats-dialog');
  const body = $('#stats-body');
  $('#stats-title').textContent = `${location.host}/${link.code}`;
  body.replaceChildren(el('p', { className: 'muted', textContent: 'Loading stats...' }));
  dialog.showModal();
  try {
    const { data } = await api(`/links/${link.code}`, { token: link.token });
    renderStats(body, data, link);
  } catch (err) {
    body.replaceChildren(el('p', { className: 'error', textContent: err.message }));
  }
}

// ---------- QR code (library is loaded only when someone asks for it) ----------

let qrLoader;
const loadQrLibrary = () =>
  (qrLoader ??= new Promise((resolve, reject) => {
    const script = el('script', { src: '/vendor/qrcode.js', onload: resolve });
    script.onerror = () => { qrLoader = undefined; reject(new Error('Could not load the QR code tool.')); };
    document.head.append(script);
  }));

async function openQr(link) {
  const shortUrl = `${location.origin}/${link.code}`;
  const box = $('#qr-box');
  $('#qr-caption').textContent = `${location.host}/${link.code}`;
  box.replaceChildren();
  $('#qr-dialog').showModal();
  try {
    await loadQrLibrary();
    const qr = window.qrcode(0, 'M');
    qr.addData(shortUrl);
    qr.make();
    const svgText = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    const svg = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
    box.replaceChildren(document.importNode(svg, true));
    $('#qr-download').onclick = () => {
      const blob = new Blob([svgText], { type: 'image/svg+xml' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `tinyhop-${link.code}.svg` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
  } catch (err) {
    box.replaceChildren(el('p', { className: 'error', textContent: err.message }));
  }
}

// ---------- form ----------

async function onSubmit(event) {
  event.preventDefault();
  const url = $('#url').value.trim();
  const alias = $('#alias').value.trim();
  if (!url) { setMessage('Paste a link first.', true); $('#url').focus(); return; }

  const button = $('#submit-btn');
  button.disabled = true;
  button.textContent = 'Shortening...';
  setMessage('');
  try {
    const { data, ms } = await api('/links', {
      method: 'POST',
      body: { url, alias: alias || undefined, expiresIn: $('#expiry').value },
    });
    const link = {
      code: data.code, token: data.manageToken, url: data.url,
      createdAt: data.createdAt, expiresAt: data.expiresAt, clicks: 0,
    };
    setLinks(withLink(links, link));
    showResult(link, ms);
    $('#url').value = '';
    $('#alias').value = '';
    setAliasHint('');
  } catch (err) {
    setMessage(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Shorten';
  }
}

// Live alias check: instant local rules first, then ask the server once typing pauses.
function setAliasHint(text, kind = '') {
  const hint = $('#alias-hint');
  hint.textContent = text;
  hint.className = `hint ${kind}`.trim();
}

let aliasTimer;
let aliasRun = 0;
function onAliasInput() {
  const value = $('#alias').value.trim();
  clearTimeout(aliasTimer);
  aliasRun += 1;
  if (!value) { setAliasHint(''); return; }
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(value)) {
    setAliasHint('Use 3 to 32 letters, numbers, dashes or underscores.', 'bad');
    return;
  }
  const run = aliasRun;
  aliasTimer = setTimeout(async () => {
    try {
      const { data } = await api(`/check/${encodeURIComponent(value)}`);
      if (run !== aliasRun) return; // a newer keystroke superseded this check
      setAliasHint(data.available ? 'Available' : data.reason, data.available ? 'ok' : 'bad');
    } catch { if (run === aliasRun) setAliasHint(''); }
  }, 350);
}

// Android "Share to Tinyhop" and ?url= links fill the box for you.
function prefillFromShare() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('url') ?? params.get('text');
  if (!raw) return;
  $('#url').value = raw.match(/https?:\/\/\S+/i)?.[0] ?? raw;
  history.replaceState(null, '', location.pathname);
}

// ---------- start up ----------

function init() {
  const host = location.host;
  $('#alias-prefix').textContent = `${host}/`;
  $('#curl-example').textContent =
    `curl -X POST ${location.origin}/api/links \\\n  -H "content-type: application/json" \\\n  -d '{"url":"https://example.com/a/very/long/link"}'`;

  $('#shorten-form').addEventListener('submit', onSubmit);
  $('#alias').addEventListener('input', onAliasInput);

  if (navigator.clipboard?.readText) {
    const paste = $('#paste-btn');
    paste.hidden = false;
    paste.addEventListener('click', async () => {
      try { $('#url').value = (await navigator.clipboard.readText()).trim(); } catch { /* permission denied */ }
      $('#url').focus();
    });
  }

  $('#copy-btn').addEventListener('click', (e) => currentLink && copyText(`${location.origin}/${currentLink.code}`, e.currentTarget));
  $('#share-btn').addEventListener('click', () => {
    if (currentLink) navigator.share({ title: 'Short link', url: `${location.origin}/${currentLink.code}` }).catch(() => {});
  });
  $('#qr-btn').addEventListener('click', () => currentLink && openQr(currentLink));

  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (e) => { if (e.target === dialog || e.target.closest('[data-close]')) dialog.close(); });
  }

  prefillFromShare();
  renderHistory();
  refreshLinks();

  if ('serviceWorker' in navigator) {
    addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
}

init();
