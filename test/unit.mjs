// Unit tests for the pure helpers. No server needed: `npm run unit`.

import { buildRequestBody, isUnsafe } from '../src/lib/safebrowsing.js';
import { normalizeTarget } from '../src/lib/url.js';
import { parseUserAgent, referrerHost } from '../src/lib/ua.js';
import { escapeHtml, previewPage } from '../src/lib/pages.js';

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

const reply = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

console.log('Unit tests\n');

await test('safe browsing: no key means no request and no block', async () => {
  let called = false;
  const result = await isUnsafe('https://example.com', '', async () => { called = true; return new Response('{}'); });
  expect(result === false && called === false, 'should skip without a key');
});

await test('safe browsing: a match blocks, an empty reply does not', async () => {
  expect((await isUnsafe('https://bad.example', 'k', reply({ matches: [{ threatType: 'MALWARE' }] }))) === true, 'match not blocked');
  expect((await isUnsafe('https://ok.example', 'k', reply({}))) === false, 'empty reply blocked');
  expect((await isUnsafe('https://ok.example', 'k', reply({ matches: [] }))) === false, 'empty matches blocked');
});

await test('safe browsing: errors and timeouts fail open', async () => {
  expect((await isUnsafe('https://x.example', 'k', reply({}, 500))) === false, 'HTTP 500 blocked');
  expect((await isUnsafe('https://x.example', 'k', async () => { throw new Error('boom'); })) === false, 'throw blocked');
});

await test('safe browsing: request carries the key and the link', async () => {
  let seen;
  await isUnsafe('https://example.com/a b', 'my key', async (url, init) => { seen = { url, init }; return new Response('{}'); });
  expect(seen.url.includes('key=my%20key'), `key not encoded: ${seen.url}`);
  const body = JSON.parse(seen.init.body);
  expect(body.threatInfo.threatEntries[0].url === 'https://example.com/a b', 'link missing');
  expect(buildRequestBody('https://x.example').threatInfo.threatTypes.includes('SOCIAL_ENGINEERING'), 'phishing type missing');
});

await test('links: dangerous and private targets are rejected', async () => {
  const opts = { selfHost: 'tinyhop.example' };
  for (const bad of ['javascript:alert(1)', 'http://localhost', 'http://10.0.0.5', 'https://user:pw@example.com', 'https://tinyhop.example/x']) {
    expect(normalizeTarget(bad, opts).ok === false, `${bad} was accepted`);
  }
  expect(normalizeTarget('example.com/a', opts).url === 'https://example.com/a', 'scheme not added');
});

await test('user agents: bots are ignored, phones are mobile', async () => {
  expect(parseUserAgent('Googlebot/2.1').bot === true, 'Googlebot counted');
  expect(parseUserAgent('').bot === true, 'empty UA counted');
  const phone = parseUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36');
  expect(phone.device === 'mobile' && phone.browser === 'Chrome' && phone.bot === false, JSON.stringify(phone));
  expect(referrerHost('https://www.t.co/abc?secret=1') === 't.co', 'referrer not reduced to host');
  expect(referrerHost('') === 'direct', 'missing referrer');
});

await test('preview page: escapes everything and never inlines script', async () => {
  const html = previewPage({ code: 'abc', target: 'https://example.com/?q="><script>alert(1)</script>' });
  expect(!html.includes('<script>'), 'raw script tag in page');
  expect(html.includes('example.com'), 'host missing');
  expect(escapeHtml(`<&>"'`) === '&lt;&amp;&gt;&quot;&#39;', 'escape wrong');
  expect(previewPage({ code: 'abc', target: 'https://example.com', warn: true }).includes('was reported'), 'warn text missing');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
