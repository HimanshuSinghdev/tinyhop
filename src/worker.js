// Tinyhop: URL shortener on Cloudflare Workers + D1.
//
//   /api/*        JSON API (create, check, stats, delete)
//   /<code>       redirect (and count the click)
//   everything    static files from /public are served by Cloudflare before this
//   else          Worker never sees them, so they cost nothing and load instantly

import { bearerToken, newToken, sha256Hex, tokenMatches } from './lib/auth.js';
import { ALIAS_PATTERN, checkAlias, isReserved, randomCode } from './lib/codes.js';
import {
  clearFlag, deleteLink, dismissReports, ensureSchema, getLink, getStats, hitRateLimit,
  insertLink, insertReport, listReports, lookupLinks, purgeOld, reclaimExpired, recordClick,
  setFlag,
} from './lib/db.js';
import { CORS_HEADERS, HTML_HEADERS, SECURITY_HEADERS, fail, json, readJson } from './lib/http.js';
import { normalizeTarget, parseList } from './lib/url.js';
import { parseUserAgent, referrerHost } from './lib/ua.js';
import { previewPage } from './lib/pages.js';
import { isUnsafe } from './lib/safebrowsing.js';

const CODE_PATH = /^\/([A-Za-z0-9_-]{3,32})$/;
const PREVIEW_PATH = /^\/p\/([A-Za-z0-9_-]{3,32})$/;
const MINUTE = 60_000;
const EXPIRY_CHOICES = {
  never: null,
  '1h': 3_600_000,
  '1d': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '365d': 365 * 86_400_000,
};
const MAX_CACHE_SECONDS = 60; // how long an edge location may remember a redirect
const REPORT_REASONS = ['phishing', 'malware', 'spam', 'illegal', 'other'];

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error('Unhandled error', err);
      return fail(500, 'internal', 'Something went wrong on our side. Please try again.');
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(ensureSchema(env.DB).then(() => purgeOld(env.DB, Date.now())));
  },
};

// ---------- routing ----------

async function route(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    return api(request, env, url);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return fail(405, 'method_not_allowed', 'Use GET for short links.', { allow: 'GET, HEAD' });
  }

  const preview = PREVIEW_PATH.exec(url.pathname);
  if (preview) return previewLink(env, url, preview[1]);

  const match = CODE_PATH.exec(url.pathname);
  if (match) return redirect(request, env, ctx, match[1]);
  return page(env, url, '/404.html', 404);
}

async function api(request, env, url) {
  const { pathname } = url;
  const { method } = request;

  if (pathname === '/api/health' && method === 'GET') {
    return json({ ok: true, time: Date.now() });
  }
  if (pathname === '/api/links' && method === 'POST') return createLink(request, env, url);
  if (pathname === '/api/links/lookup' && method === 'POST') return lookup(request, env);
  if (pathname === '/api/report' && method === 'POST') return reportLink(request, env);

  if (pathname === '/api/admin/reports' && method === 'GET') return adminReports(request, env);
  const adminLink = /^\/api\/admin\/links\/([A-Za-z0-9_-]{3,32})$/.exec(pathname);
  if (adminLink && method === 'POST') return adminAction(request, env, adminLink[1], url);

  const check = /^\/api\/check\/([^/]+)$/.exec(pathname);
  if (check && method === 'GET') return checkAvailability(env, decodeURIComponent(check[1]));

  const one = /^\/api\/links\/([A-Za-z0-9_-]{3,32})$/.exec(pathname);
  if (one && method === 'GET') return linkStats(request, env, one[1]);
  if (one && method === 'DELETE') return removeLink(request, env, one[1], url);

  return fail(404, 'not_found', 'No such API route.');
}

// ---------- static pages served from the Worker ----------

async function page(env, url, path, status) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
  return new Response(res.body, {
    status,
    headers: HTML_HEADERS,
  });
}

// ---------- redirect ----------

const secondsUntil = (expiresAt, now) =>
  expiresAt ? Math.max(0, Math.min(MAX_CACHE_SECONDS, Math.floor((expiresAt - now) / 1000))) : MAX_CACHE_SECONDS;

async function redirect(request, env, ctx, code) {
  const now = Date.now();
  const url = new URL(request.url);
  // Per-location edge cache. It only works on custom domains (not *.workers.dev),
  // where most repeat clicks never reach the database.
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/__redirect/${code}`, url.origin).href);

  let target = (await cache.match(cacheKey))?.headers.get('location') ?? null;

  if (!target) {
    await ensureSchema(env.DB);
    const link = await getLink(env.DB, code);
    if (!link) return page(env, url, '/404.html', 404);
    if (link.expires_at && link.expires_at <= now) return page(env, url, '/expired.html', 410);
    // Moderation flags are never edge-cached, so they take effect as soon as the cache entry expires.
    if (link.flag === 'disabled') return page(env, url, '/disabled.html', 410);
    if (link.flag === 'warn') return html(previewPage({ code, target: link.url, warn: true }));

    target = link.url;
    const ttl = secondsUntil(link.expires_at, now);
    if (ttl > 0) {
      ctx.waitUntil(
        cache.put(
          cacheKey,
          new Response(null, {
            status: 302,
            headers: { location: target, 'cache-control': `public, max-age=${ttl}` },
          }),
        ),
      );
    }
  }

  if (request.method === 'GET') ctx.waitUntil(trackClick(env, request, code, now));

  return new Response(null, {
    status: 302,
    headers: { location: target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...SECURITY_HEADERS },
  });
}

// Runs after the redirect is sent, so it never slows the visitor down.
async function trackClick(env, request, code, now) {
  try {
    const ua = parseUserAgent(request.headers.get('user-agent') ?? '');
    if (ua.bot) return; // previews and crawlers are not counted
    await ensureSchema(env.DB);
    await recordClick(
      env.DB,
      code,
      {
        country: request.cf?.country ?? 'XX',
        device: ua.device,
        browser: ua.browser,
        referrer: referrerHost(request.headers.get('referer')),
      },
      now,
    );
  } catch (err) {
    console.error('Click tracking failed', err);
  }
}

// ---------- rate limiting ----------

// Returns a 429 response when the visitor is over the limit, otherwise null.
async function limited(request, env, bucket, limit) {
  const now = Date.now();
  const windowIndex = Math.floor(now / MINUTE);
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const who = (await sha256Hex(`${ip}:${env.HASH_SALT ?? ''}`)).slice(0, 16);
  await ensureSchema(env.DB);
  const count = await hitRateLimit(env.DB, `${bucket}:${who}:${windowIndex}`, (windowIndex + 1) * MINUTE);
  if (count <= limit) return null;
  const retryAfter = Math.max(1, Math.ceil(((windowIndex + 1) * MINUTE - now) / 1000));
  return fail(429, 'rate_limited', `Too many requests. Try again in ${retryAfter} seconds.`, {
    'retry-after': String(retryAfter),
  });
}

const numberOr = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

// ---------- API handlers ----------

async function createLink(request, env, url) {
  const tooMany = await limited(request, env, 'create', numberOr(env.RATE_CREATE_PER_MIN, 10));
  if (tooMany) return tooMany;

  const body = await readJson(request);
  if (!body) return fail(400, 'bad_json', 'Send a JSON body like {"url":"https://example.com"}.');

  const target = normalizeTarget(body.url, {
    selfHost: url.hostname,
    blockedHosts: parseList(env.BLOCKED_HOSTS),
  });
  if (!target.ok) return fail(400, 'invalid_url', target.message);

  const expiresIn = body.expiresIn ?? 'never';
  if (!(expiresIn in EXPIRY_CHOICES)) {
    return fail(400, 'invalid_expiry', `expiresIn must be one of: ${Object.keys(EXPIRY_CHOICES).join(', ')}.`);
  }

  const alias = typeof body.alias === 'string' && body.alias !== '' ? body.alias : null;
  if (alias) {
    const verdict = checkAlias(alias);
    if (!verdict.ok) return fail(400, 'invalid_alias', verdict.message);
  }

  if (await isUnsafe(target.url, env.SAFE_BROWSING_KEY)) {
    return fail(400, 'unsafe_url', 'Google Safe Browsing flagged this link as unsafe, so it cannot be shortened.');
  }

  const now = Date.now();
  const token = newToken();
  const base = {
    url: target.url,
    createdAt: now,
    expiresAt: EXPIRY_CHOICES[expiresIn] ? now + EXPIRY_CHOICES[expiresIn] : null,
    tokenHash: await sha256Hex(token),
  };

  await ensureSchema(env.DB);

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = alias ?? randomCode();
    if (!alias && isReserved(code)) continue;

    let result = await insertLink(env.DB, { ...base, code });
    if (!result.ok && alias) {
      await reclaimExpired(env.DB, code, now);
      result = await insertLink(env.DB, { ...base, code });
    }
    if (result.ok) {
      return json(
        {
          code,
          shortUrl: `${url.origin}/${code}`,
          url: base.url,
          createdAt: base.createdAt,
          expiresAt: base.expiresAt,
          manageToken: token, // shown once; only its hash is stored
        },
        201,
      );
    }
    if (alias) return fail(409, 'alias_taken', 'That alias is already taken. Try another.');
  }
  return fail(503, 'busy', 'Could not find a free short code. Please try again.');
}

async function checkAvailability(env, alias) {
  const verdict = checkAlias(alias);
  if (!verdict.ok) return json({ available: false, reason: verdict.message });
  await ensureSchema(env.DB);
  const row = await getLink(env.DB, alias);
  const free = !row || (row.expires_at && row.expires_at <= Date.now());
  return json({ available: Boolean(free), reason: free ? null : 'That alias is already taken.' });
}

async function linkStats(request, env, code) {
  const tooMany = await limited(request, env, 'stats', 60);
  if (tooMany) return tooMany;
  await ensureSchema(env.DB);
  const link = await getLink(env.DB, code);
  if (!link) return fail(404, 'not_found', 'That link does not exist.');
  if (!(await tokenMatches(bearerToken(request), link.token_hash))) {
    return fail(401, 'unauthorized', 'Missing or wrong manage key.');
  }
  return json(await getStats(env.DB, link, Date.now()));
}

async function removeLink(request, env, code, url) {
  const tooMany = await limited(request, env, 'delete', 20);
  if (tooMany) return tooMany;
  await ensureSchema(env.DB);
  const link = await getLink(env.DB, code);
  if (!link) return fail(404, 'not_found', 'That link does not exist.');
  if (!(await tokenMatches(bearerToken(request), link.token_hash))) {
    return fail(401, 'unauthorized', 'Missing or wrong manage key.');
  }
  await deleteLink(env.DB, code);
  await caches.default.delete(new Request(new URL(`/__redirect/${code}`, url.origin).href));
  return json({ deleted: true });
}

// Batch lookup for the "your links" list: one query instead of one per link.
async function lookup(request, env) {
  const tooMany = await limited(request, env, 'lookup', 60);
  if (tooMany) return tooMany;
  const body = await readJson(request, 65536);
  const items = Array.isArray(body?.items) ? body.items.slice(0, 50) : null;
  if (!items) return fail(400, 'bad_json', 'Send {"items":[{"code":"...","token":"..."}]}.');

  const valid = items.filter((i) => typeof i?.code === 'string' && typeof i?.token === 'string');
  await ensureSchema(env.DB);
  const rows = await lookupLinks(env.DB, valid.map((i) => i.code));
  const byCode = new Map(rows.map((r) => [r.code, r]));

  const links = [];
  for (const { code, token } of valid) {
    const row = byCode.get(code);
    if (row && (await tokenMatches(token, row.token_hash))) {
      links.push({
        code,
        url: row.url,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        clicks: row.clicks,
        lastClickAt: row.last_click_at,
      });
    }
  }
  return json({ links });
}

// Public abuse report. Stores the short code, a reason and an optional note, never who sent it.
async function reportLink(request, env) {
  const tooMany = await limited(request, env, 'report', 5);
  if (tooMany) return tooMany;

  const body = await readJson(request);
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  if (!ALIAS_PATTERN.test(code)) return fail(400, 'invalid_code', 'Enter the short link or its code.');
  if (!REPORT_REASONS.includes(body.reason)) {
    return fail(400, 'invalid_reason', `Reason must be one of: ${REPORT_REASONS.join(', ')}.`);
  }
  const details = typeof body.details === 'string' ? body.details.trim().slice(0, 500) : '';

  await ensureSchema(env.DB);
  if (!(await getLink(env.DB, code))) return fail(404, 'not_found', 'That link does not exist.');
  await insertReport(env.DB, { code, reason: body.reason, details, ts: Date.now() });
  return json({ reported: true }, 201);
}

// ---------- preview page ----------

const html = (body, status = 200) => new Response(body, { status, headers: HTML_HEADERS });

// Shows where a short link goes without following it, and without counting a click.
async function previewLink(env, url, code) {
  await ensureSchema(env.DB);
  const link = await getLink(env.DB, code);
  if (!link) return page(env, url, '/404.html', 404);
  if (link.expires_at && link.expires_at <= Date.now()) return page(env, url, '/expired.html', 410);
  if (link.flag === 'disabled') return page(env, url, '/disabled.html', 410);
  return html(previewPage({ code, target: link.url, warn: link.flag === 'warn' }));
}

// ---------- admin ----------
// Turned on by adding an ADMIN_TOKEN secret. Without it every admin route answers 404.

async function adminGuard(request, env) {
  if (!env.ADMIN_TOKEN) return fail(404, 'admin_off', 'Admin is not set up. Add an ADMIN_TOKEN secret.');
  const tooMany = await limited(request, env, 'admin', 30);
  if (tooMany) return tooMany;
  const given = bearerToken(request);
  if (!(await tokenMatches(given, await sha256Hex(env.ADMIN_TOKEN)))) {
    return fail(401, 'unauthorized', 'Wrong admin token.');
  }
  return null;
}

async function adminReports(request, env) {
  const denied = await adminGuard(request, env);
  if (denied) return denied;
  await ensureSchema(env.DB);
  return json({ reports: await listReports(env.DB) });
}

const ADMIN_ACTIONS = ['disable', 'warn', 'restore', 'dismiss', 'delete'];

async function adminAction(request, env, code, url) {
  const denied = await adminGuard(request, env);
  if (denied) return denied;

  const body = await readJson(request);
  const action = body?.action;
  if (!ADMIN_ACTIONS.includes(action)) {
    return fail(400, 'invalid_action', `action must be one of: ${ADMIN_ACTIONS.join(', ')}.`);
  }

  await ensureSchema(env.DB);
  if (action === 'dismiss') {
    await dismissReports(env.DB, code);
    return json({ ok: true });
  }

  const link = await getLink(env.DB, code);
  if (!link) {
    if (action !== 'delete') return fail(404, 'not_found', 'That link does not exist.');
    await dismissReports(env.DB, code); // the link is already gone: just clear its reports
    return json({ ok: true });
  }

  if (action === 'delete') {
    await deleteLink(env.DB, code);
    await dismissReports(env.DB, code);
  } else if (action === 'restore') {
    await clearFlag(env.DB, code);
  } else {
    await setFlag(env.DB, code, action === 'disable' ? 'disabled' : 'warn', Date.now());
  }
  // Clears this location's redirect cache. Other locations drop theirs within 60 seconds.
  await caches.default.delete(new Request(new URL(`/__redirect/${code}`, url.origin).href));
  return json({ ok: true });
}
