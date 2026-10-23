# Tinyhop

A fast, open-source link shortener. Paste a long link, get a short one. No accounts, no cookies, and every line of code (including the database schema) is in this repo.

Version 2 is a rebuild on **Cloudflare Workers + D1**. It replaces the old Express + MongoDB + Redis + React stack, whose slow loads came mostly from a sleeping free-tier server and cross-region database calls.

## Why it's fast

| Choice | What it does for you |
|---|---|
| Cloudflare Workers | Code runs in the data center nearest the visitor. No server to wake up, so no 30 to 60 second cold start. |
| Static files served by Cloudflare | `/public` never touches the Worker. The page is a few small files, no framework, no web fonts. |
| Edge cache for redirects | On a custom domain, repeat clicks on a link are answered from the nearest location's cache (60 seconds), without a database call. |
| Click tracking after the redirect | Counting a click happens after the visitor has already been sent on, so it never slows them down. |
| One database, three tables | D1 (SQLite). Short codes are the primary key, so lookups are index reads. |

Honest limits: the Cache API does not work on `*.workers.dev` addresses, so until you add a custom domain every redirect reads D1. D1 has one primary region, so a cache miss far from it costs extra round trips. We have only measured locally so far (see "Measure it yourself").

## Features

- Shorten any http(s) link, with or without `https://`
- Custom aliases with a live "is it free?" check
- Expiry: 1 hour, 1 day, 7 days, 30 days, 1 year, or never
- QR codes (generated in your browser, downloadable as SVG)
- Click stats per link: last 30 days, countries, devices, browsers, referring sites
- "Your links" list with one-tap copy, stats, QR and delete
- Installable on Android (PWA), and it appears in the Android Share menu
- Public JSON API with CORS enabled
- Light and dark themes that follow the phone's setting

## What we store, exactly

| When | Stored | Not stored |
|---|---|---|
| You shorten a link | the link, short code, created and expiry times, SHA-256 hash of your manage key | name, email, IP address |
| A human clicks | day, country, device type, browser family, referrer domain | IP address, cookies, full user agent, full referrer URL |
| Safe Browsing is on (optional) | the link is sent to Google to be checked | anything about you |
| Someone reports a link | short code, reason, optional note (500 characters), time. Deleted after 180 days | who reported it |
| Anyone creates or deletes | a salted hash of the IP plus the minute, to rate limit | the IP itself. Rows are deleted when the minute ends |

Bots and link previews (Googlebot, WhatsApp previews and similar) are not counted. The exact SQL is in [`schema.sql`](schema.sql) and [`src/lib/db.js`](src/lib/db.js).

Cloudflare, as the host, still processes each request the way any host does. Workers logging is switched **off** in `wrangler.jsonc`; turn it on only while debugging.

## How "no accounts" works

When you create a link, the server returns a random **manage key** once. Your browser saves it in `localStorage`, and the server keeps only its hash. The key is what lets you read stats and delete the link. If you clear your browser data, you lose management of those links (they keep working). There is no password reset because there is no password.

## API

Base URL is wherever you deploy. No API key. Errors look like `{"error":{"code":"...","message":"..."}}`.

| Method and path | Body or auth | Returns |
|---|---|---|
| `POST /api/links` | `{"url": "...", "alias"?: "...", "expiresIn"?: "never\|1h\|1d\|7d\|30d\|365d"}` | `201` with `code`, `shortUrl`, `url`, `createdAt`, `expiresAt`, `manageToken` |
| `GET /api/links/:code` | `Authorization: Bearer <manageToken>` | stats for the last 30 days |
| `DELETE /api/links/:code` | `Authorization: Bearer <manageToken>` | `{"deleted": true}` |
| `POST /api/links/lookup` | `{"items":[{"code","token"}]}` (max 50) | current click counts for links whose key matches |
| `GET /api/check/:alias` | none | `{"available": true\|false, "reason"}` |
| `GET /api/health` | none | `{"ok": true}` |
| `POST /api/report` | `{"code", "reason": "phishing\|malware\|spam\|illegal\|other", "details"?}` | `201 {"reported": true}`. 5 per minute per visitor |
| `GET /p/:code` | none | an HTML page showing where the link goes, with a Continue button. Does not count a click |
| `GET /api/admin/reports` | `Authorization: Bearer <ADMIN_TOKEN>` | reported links with reasons, notes and current state |
| `POST /api/admin/links/:code` | Bearer `ADMIN_TOKEN`, `{"action": "warn\|disable\|restore\|dismiss\|delete"}` | `{"ok": true}` |
| `GET /:code` | none | `302` to the original link, `404` unknown, `410` expired |

```bash
curl -X POST https://YOUR-DOMAIN/api/links \
  -H "content-type: application/json" \
  -d '{"url":"https://example.com/a/very/long/link","expiresIn":"7d"}'
```

Rate limits per visitor: 10 creates per minute (configurable), 20 deletes, 60 stats reads. Over the limit you get `429` with a `Retry-After` header.

## Project layout

```
tinyhop/
├── wrangler.jsonc        Cloudflare config (assets, D1, daily cleanup cron, settings)
├── schema.sql            the whole database, applied automatically on first request
├── src/
│   ├── worker.js         routes: /api/*, redirects, cleanup cron
│   └── lib/
│       ├── db.js         every SQL statement
│       ├── url.js        link validation (blocks javascript:, localhost, private IPs...)
│       ├── codes.js      random 7-character codes, alias rules
│       ├── auth.js       manage keys (hashed, timing-safe comparison)
│       ├── ua.js         device/browser labels and bot detection
│       ├── http.js       JSON, HTML and security-header helpers
│       ├── pages.js      the preview and warning page
│       └── safebrowsing.js  optional Google Safe Browsing check
├── public/               the website: index.html, style.css, app.js, PWA files
│   └── vendor/qrcode.js  QR generator (MIT, Kazuhiko Arase), loaded only on demand
└── test/smoke.mjs        end-to-end API tests
```

## Deploy (no command line needed)

You only need a free Cloudflare account and this repo on GitHub.

1. Cloudflare dashboard, **Workers & Pages**, **Create**, **Import a repository**, pick this repo.
2. Leave the build command empty. Keep the default deploy command (`npx wrangler deploy`). Deploy.
3. The `DB` database in `wrangler.jsonc` has no `database_id`; recent Wrangler versions create it for you on first deploy. If the build log complains, go to **Storage & databases, D1**, create a database named `tinyhop`, and paste its id into `wrangler.jsonc` as `"database_id"`.
4. Under your Worker's **Settings, Variables and secrets**, add a secret named `HASH_SALT` with any long random text. This overrides the placeholder in `wrangler.jsonc`.
5. Optional but recommended: **Settings, Domains & routes, Add custom domain**. This turns on the edge redirect cache and gives you a shorter address than `*.workers.dev`.

The database tables are created automatically on the first request. Nothing else to run.

### With a computer

```bash
npm install
npm run dev        # local server at http://localhost:8787 with a local D1
npm run unit       # fast tests for the helper code
npm run smoke      # in another terminal: runs the API tests
npm run deploy
```

Some tests create many links quickly, so for a full run start the dev server with `npx wrangler dev --var RATE_CREATE_PER_MIN:40`.

## Handling abuse reports

The home page footer links to a public report form (`/report.html`). Reports land in the `reports` table, and you review them on the admin page.

**Turn on the admin page:** in the Cloudflare dashboard open your Worker, **Settings, Variables and secrets**, and add a secret named `ADMIN_TOKEN` with 20 or more random characters. Then open `/admin` on your site and sign in with it. Without the secret, every admin route answers 404. Guesses are rate limited to 30 per minute per visitor.

For each reported link you can:

| Action | What happens |
|---|---|
| Warn | Visitors see a warning page with a Continue button instead of an instant redirect |
| Disable | The link stops working and shows a "removed" page (HTTP 410) |
| Restore | Clears a warning or disable |
| Delete link | Removes the link and its click data for good |
| Dismiss | Clears the reports and leaves the link alone |

Warned and disabled links are never put in the edge cache, but a cached copy made before you acted can keep redirecting for up to 60 seconds in other locations.

Anyone can open `/p/<code>` to see where a short link goes without following it. The "Your links" list has a Preview button for it.

## Safe Browsing check (optional)

Add a secret named `SAFE_BROWSING_KEY` (a free Google Safe Browsing API key) and every new link is checked against Google's list of phishing, malware and unwanted-software sites before it is shortened. Only the link is sent to Google. If Google is slow or down the check is skipped, so people can still shorten links. Without the key nothing is sent anywhere. Check [Google's terms](https://developers.google.com/safe-browsing) for your use before enabling it.

## Settings (`vars` in `wrangler.jsonc`)

| Name | Default | Meaning |
|---|---|---|
| `BLOCKED_HOSTS` | empty | Comma-separated domains that can never be shortened (subdomains included) |
| `RATE_CREATE_PER_MIN` | `10` | Link creations per visitor per minute |
| `HASH_SALT` | `change-me` | Salt for hashing IPs into rate-limit keys. Set your own as a secret |
| `ADMIN_TOKEN` (secret) | unset | Turns on the admin page at `/admin`. Use 20 or more random characters |
| `SAFE_BROWSING_KEY` (secret) | unset | Google Safe Browsing API key. When set, new links are checked |

## Measure it yourself

Don't trust a claim of speed without numbers. After deploying, from your own network:

```bash
curl -o /dev/null -s -w "dns %{time_namelookup}s  connect %{time_connect}s  tls %{time_appconnect}s  first byte %{time_starttransfer}s  total %{time_total}s\n" https://YOUR-DOMAIN/SOMECODE
```

Run it twice. The second run on a custom domain should show the edge cache at work. For the website itself, run PageSpeed Insights or Chrome Lighthouse on the home page.

## Security notes

- Only `http` and `https` links are accepted. Links to `localhost`, private networks, links with embedded passwords, and links back to Tinyhop itself are rejected.
- Strict Content Security Policy: no inline scripts or styles, no third-party requests. The page loads nothing from other websites.
- Manage keys are 190 bits of randomness, stored only as hashes, compared in constant time.
- Rate limiting is per visitor IP and best effort. It is not a defense against a determined attacker. Put Cloudflare Turnstile or WAF rules in front if abuse becomes a problem.
- **Any public shortener can be used to hide phishing or malware links.** Turn on the Safe Browsing check, use `BLOCKED_HOSTS` for known bad domains, and review reports on the admin page. None of this makes abuse impossible, so keep an eye on reports.

## Free plan limits

Cloudflare's free plan caps Worker requests and D1 reads and writes per day. A click costs a few D1 row writes, so expect tens of thousands of tracked clicks per day before you need a paid plan. Check [Cloudflare's current limits](https://developers.cloudflare.com/d1/platform/limits/) because they change.

## Roadmap

- Edit a link's destination, password-protected links
- Public stats page toggle
- D1 read replication for faster cache misses far from the primary region
- Optional accounts for people who want links on more than one device

## Contributing

Issues and pull requests are welcome. Run `npm run check` and the smoke tests before sending a change. If you change what is stored about visitors, update the "What we store" section in this file and on the home page in the same pull request.

## License

MIT. See [LICENSE](LICENSE). The bundled QR code generator is also MIT (Kazuhiko Arase).
