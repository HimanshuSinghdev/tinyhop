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
