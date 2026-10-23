// HTML pages the Worker builds itself. Everything inserted is escaped.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Shows where a short link goes before anyone follows it. With warn: true it is the
// warning shown for links that were reported and flagged from the admin page.
export function previewPage({ code, target, warn = false }) {
  const host = new URL(target).host;
  const title = warn ? 'This link was reported.' : 'Where this link goes.';
  const intro = warn
    ? 'Other people reported this link as unsafe. Only continue if you trust the site.'
    : 'Check the address before you continue.';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(title)} | Tinyhop</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header class="site">
    <a class="brand" href="/"><img src="/favicon.svg" width="32" height="32" alt=""><span>Tinyhop</span></a>
  </header>
  <main class="notice">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(intro)}</p>
    <p class="dest">${escapeHtml(host)}</p>
    <p class="wrap">${escapeHtml(target)}</p>
    <div class="button-row">
      <a class="primary" href="${escapeHtml(target)}" rel="noopener noreferrer nofollow">Continue to ${escapeHtml(host)}</a>
      <a class="ghost" href="/report.html?code=${encodeURIComponent(code)}">Report this link</a>
    </div>
  </main>
</body>
</html>
`;
}
