// Report form. Plain ES module, no tracking.

const $ = (selector) => document.querySelector(selector);

// Accepts "tinyhop.example/AbC123", "https://tinyhop.example/AbC123?x=1" or just "AbC123".
export function extractCode(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    const segment = url.pathname.split('/').filter(Boolean).pop();
    if (url.pathname !== '/' && segment) return segment;
  } catch { /* not a URL: treat it as a bare code */ }
  return text.replace(/^\/+|\/+$/g, '');
}

function setMessage(text, kind = '') {
  const msg = $('#report-msg');
  msg.textContent = text;
  msg.className = `msg ${kind}`.trim();
}

async function onSubmit(event) {
  event.preventDefault();
  const code = extractCode($('#code').value);
  if (!code) { setMessage('Paste the short link first.', 'error'); $('#code').focus(); return; }

  const button = $('#send');
  button.disabled = true;
  setMessage('');
  try {
    const res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, reason: $('#reason').value, details: $('#details').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message ?? 'Something went wrong. Please try again.');
    $('#report-form').reset();
    setMessage('Report received. Thank you.', 'ok-text');
  } catch (err) {
    setMessage(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

$('#report-form').addEventListener('submit', onSubmit);

const prefill = new URLSearchParams(location.search).get('code');
if (prefill) $('#code').value = prefill;
