// End-to-end smoke test. Start the app first (`npm run dev`), then run `npm run smoke`.
// Usage: BASE=http://localhost:8787 node test/smoke.mjs

const BASE = process.env.BASE ?? 'http://localhost:8787';
const PHONE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};

const call = (path, { method = 'GET', body, token, headers = {} } = {}) =>
  fetch(BASE + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const create = (body) => call('/api/links', { method: 'POST', body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Testing ${BASE}\n`);

let link; // shared between tests

await test('health endpoint responds', async () => {
  const res = await call('/api/health');
  expect(res.status === 200, `status ${res.status}`);
  expect((await res.json()).ok === true, 'ok flag missing');
});

await test('home page is served', async () => {
  const res = await call('/');
  expect(res.status === 200, `status ${res.status}`);
  expect((res.headers.get('content-type') ?? '').includes('text/html'), 'not html');
});

await test('create a link', async () => {
  const res = await create({ url: 'https://example.com/some/very/long/path?x=1' });
  expect(res.status === 201, `status ${res.status}`);
  link = await res.json();
  expect(/^[A-Za-z0-9]{7}$/.test(link.code), `bad code ${link.code}`);
  expect(link.shortUrl.endsWith(`/${link.code}`), 'shortUrl wrong');
  expect(link.manageToken?.startsWith('mk_'), 'manage token missing');
  expect(link.url === 'https://example.com/some/very/long/path?x=1', 'url changed');
});

await test('scheme is added when missing', async () => {
  const res = await create({ url: 'example.org/page' });
  expect(res.status === 201, `status ${res.status}`);
  expect((await res.json()).url === 'https://example.org/page', 'https not added');
});

await test('redirect returns 302 with Location', async () => {
  const res = await call(`/${link.code}`, { headers: { 'user-agent': PHONE, referer: 'https://t.co/abc?secret=1' } });
  expect(res.status === 302, `status ${res.status}`);
  expect(res.headers.get('location') === link.url, `location ${res.headers.get('location')}`);
  expect(res.headers.get('cache-control') === 'no-store', 'redirect must not be cached by browsers');
});

await test('bots are not counted', async () => {
  await call(`/${link.code}`, { headers: { 'user-agent': 'Googlebot/2.1' } });
  await call(`/${link.code}`, { headers: { 'user-agent': 'WhatsApp/2.23' } });
});

await test('stats show exactly one human click, no raw IP or full referrer', async () => {
  await sleep(500); // click tracking runs after the redirect is sent
  const res = await call(`/api/links/${link.code}`, { token: link.manageToken });
  expect(res.status === 200, `status ${res.status}`);
  const stats = await res.json();
  expect(stats.clicks === 1, `clicks ${stats.clicks}`);
  expect(stats.devices[0]?.key === 'mobile', `device ${JSON.stringify(stats.devices)}`);
  expect(stats.browsers[0]?.key === 'Chrome', `browser ${JSON.stringify(stats.browsers)}`);
  expect(stats.referrers[0]?.key === 't.co', `referrer ${JSON.stringify(stats.referrers)}`);
  expect(stats.series.length === 30, 'series should cover 30 days');
  expect(stats.series.at(-1).clicks === 1, 'today should have 1 click');
});

await test('stats need the right manage key', async () => {
  const none = await call(`/api/links/${link.code}`);
  const wrong = await call(`/api/links/${link.code}`, { token: 'mk_wrong' });
  expect(none.status === 401 && wrong.status === 401, `${none.status}/${wrong.status}`);
});

await test('custom alias works, then conflicts', async () => {
  const alias = `smoke-${Date.now().toString(36)}`;
  const first = await create({ url: 'https://example.com/a', alias });
  expect(first.status === 201 && (await first.json()).code === alias, 'alias not used');
  const again = await create({ url: 'https://example.com/b', alias });
  expect(again.status === 409, `expected 409, got ${again.status}`);
  const check = await (await call(`/api/check/${alias}`)).json();
  expect(check.available === false, 'check should report taken');
  const free = await (await call('/api/check/surely-free-alias-123')).json();
  expect(free.available === true, 'check should report free');
});

await test('bad aliases are rejected', async () => {
  for (const alias of ['ab', 'api', 'has space', 'a'.repeat(33), 'emoji-😀']) {
    const res = await create({ url: 'https://example.com', alias });
    expect(res.status === 400, `alias "${alias}" gave ${res.status}`);
  }
});

await test('unsafe or invalid links are rejected', async () => {
  const bad = [
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'ftp://example.com/file',
    'http://localhost:3000',
    'http://127.0.0.1/admin',
    'http://192.168.1.1',
    'https://user:pass@example.com',
    '',
    'not a url',
    `https://example.com/${'a'.repeat(2100)}`,
  ];
  for (const url of bad) {
    const res = await create({ url });
    expect(res.status === 400, `"${url.slice(0, 40)}" gave ${res.status}`);
  }
});

await test('cannot shorten a Tinyhop link', async () => {
  const res = await create({ url: `${BASE}/${link.code}` });
  expect(res.status === 400, `status ${res.status}`);
});

await test('invalid expiry is rejected, valid expiry is stored', async () => {
  expect((await create({ url: 'https://example.com', expiresIn: 'forever' })).status === 400, 'bad expiry accepted');
  const res = await create({ url: 'https://example.com/exp', expiresIn: '1d' });
  const data = await res.json();
  const day = data.expiresAt - data.createdAt;
  expect(day === 86_400_000, `expiry ${day}`);
});

await test('batch lookup returns only links with a valid key', async () => {
  const res = await call('/api/links/lookup', {
    method: 'POST',
    body: { items: [{ code: link.code, token: link.manageToken }, { code: link.code, token: 'mk_nope' }] },
  });
  const data = await res.json();
  expect(res.status === 200 && data.links.length === 1, `got ${JSON.stringify(data)}`);
  expect(data.links[0].clicks === 1, 'click count missing');
  expect(!('token_hash' in data.links[0]) && !('tokenHash' in data.links[0]), 'hash leaked');
});

await test('unknown code gives the 404 page', async () => {
  const res = await call('/zzzzzzz');
  expect(res.status === 404, `status ${res.status}`);
  expect((res.headers.get('content-type') ?? '').includes('text/html'), 'not html');
});

await test('delete needs the key, then removes the link', async () => {
  expect((await call(`/api/links/${link.code}`, { method: 'DELETE' })).status === 401, 'delete without key worked');
  const ok = await call(`/api/links/${link.code}`, { method: 'DELETE', token: link.manageToken });
  expect(ok.status === 200, `status ${ok.status}`);
  const after = await call(`/${link.code}`);
  expect(after.status === 404, `after delete: ${after.status}`);
});

await test('bad JSON gets a clear error', async () => {
  const res = await fetch(`${BASE}/api/links`, { method: 'POST', body: '{nope' });
  expect(res.status === 400, `status ${res.status}`);
  expect((await res.json()).error.code === 'bad_json', 'wrong error code');
});

await test('CORS preflight works for the public API', async () => {
  const res = await call('/api/links', { method: 'OPTIONS' });
  expect(res.status === 204, `status ${res.status}`);
  expect(res.headers.get('access-control-allow-origin') === '*', 'CORS header missing');
});

await test('abuse reports: accepted, validated, unknown links rejected', async () => {
  const made = await (await create({ url: 'https://example.com/report-me' })).json();
  const send = (body) => call('/api/report', { method: 'POST', body });
  const ok = await send({ code: made.code, reason: 'phishing', details: 'looks fake' });
  expect(ok.status === 201, `report status ${ok.status}`);
  expect((await send({ code: made.code, reason: 'because' })).status === 400, 'bad reason accepted');
  expect((await send({ code: 'no spaces', reason: 'spam' })).status === 400, 'bad code accepted');
  expect((await send({ code: 'zzzzzzz', reason: 'spam' })).status === 404, 'unknown link accepted');
});

const ADMIN = process.env.ADMIN_TOKEN;
if (!ADMIN) {
  console.log('  skip admin tests (start the dev server with --var ADMIN_TOKEN:<value> and pass the same ADMIN_TOKEN here)');
} else {
  const admin = (path, opts = {}) => call(path, { ...opts, token: ADMIN });
  const act = (code, action) => admin(`/api/admin/links/${code}`, { method: 'POST', body: { action } });
  let flagged;

  await test('admin rejects a missing or wrong token', async () => {
    const none = await call('/api/admin/reports');
    const wrong = await call('/api/admin/reports', { token: 'nope' });
    expect(none.status === 401 && wrong.status === 401, `${none.status}/${wrong.status}`);
  });

  await test('admin sees a reported link with reason and note', async () => {
    flagged = await (await create({ url: 'https://example.com/flag-me' })).json();
    await call('/api/report', { method: 'POST', body: { code: flagged.code, reason: 'spam', details: 'seen in a scam message' } });
    const { reports } = await (await admin('/api/admin/reports')).json();
    const row = reports.find((r) => r.code === flagged.code);
    expect(row && row.reports === 1 && row.reasons === 'spam' && row.note === 'seen in a scam message', JSON.stringify(row));
    expect(row.url === 'https://example.com/flag-me' && row.flag === null, 'url or flag wrong');
  });

  await test('preview page shows the destination and does not count a click', async () => {
    const res = await call(`/p/${flagged.code}`);
    const text = await res.text();
    expect(res.status === 200 && text.includes('example.com') && text.includes('Continue'), `status ${res.status}`);
    expect(!text.includes('was reported'), 'normal preview must not show the warning');
    const stats = await (await call(`/api/links/${flagged.code}`, { token: flagged.manageToken })).json();
    expect(stats.clicks === 0, `preview counted ${stats.clicks} clicks`);
  });

  await test('warn shows a warning page instead of redirecting', async () => {
    expect((await act(flagged.code, 'warn')).status === 200, 'warn failed');
    const res = await call(`/${flagged.code}`);
    expect(res.status === 200 && (await res.text()).includes('was reported'), `status ${res.status}`);
  });

  await test('disable returns 410, restore brings the redirect back', async () => {
    expect((await act(flagged.code, 'disable')).status === 200, 'disable failed');
    expect((await call(`/${flagged.code}`)).status === 410, 'disabled link should be 410');
    expect((await call(`/p/${flagged.code}`)).status === 410, 'disabled preview should be 410');
    expect((await act(flagged.code, 'restore')).status === 200, 'restore failed');
    const res = await call(`/${flagged.code}`);
    expect(res.status === 302 && res.headers.get('location') === 'https://example.com/flag-me', `status ${res.status}`);
  });

  await test('admin actions validate input', async () => {
    expect((await act(flagged.code, 'explode')).status === 400, 'bad action accepted');
    expect((await act('zzzzzzz', 'warn')).status === 404, 'unknown link accepted');
  });

  await test('dismiss clears reports, delete removes the link', async () => {
    expect((await act(flagged.code, 'dismiss')).status === 200, 'dismiss failed');
    let list = (await (await admin('/api/admin/reports')).json()).reports;
    expect(!list.some((r) => r.code === flagged.code), 'report still listed');
    expect((await act(flagged.code, 'delete')).status === 200, 'delete failed');
    expect((await call(`/${flagged.code}`)).status === 404, 'link still exists');
  });
}

await test('rate limit kicks in with Retry-After', async () => {
  let blocked;
  for (let i = 0; i < 80 && !blocked; i++) {
    const res = await create({ url: `https://example.com/rl/${i}` });
    if (res.status === 429) blocked = res;
  }
  expect(blocked, 'never got a 429 in 80 creates');
  expect(Number(blocked.headers.get('retry-after')) >= 1, 'retry-after missing');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
