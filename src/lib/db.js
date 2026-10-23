// All SQL lives here, so it is easy to audit exactly what is stored and read.

import schemaSql from '../../schema.sql';

const DAY_MS = 86_400_000;

// ---------- schema ----------

const splitSql = (sql) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

let schemaReady;

// Applies schema.sql once per Worker instance. Every statement is idempotent.
export function ensureSchema(db) {
  schemaReady ??= db.batch(splitSql(schemaSql).map((s) => db.prepare(s))).catch((err) => {
    schemaReady = undefined;
    throw err;
  });
  return schemaReady;
}

// ---------- links ----------

export const getLink = (db, code) =>
  db
    .prepare(
      `SELECT l.*, f.status AS flag FROM links l
       LEFT JOIN link_flags f ON f.code = l.code WHERE l.code = ?`,
    )
    .bind(code)
    .first();

export async function insertLink(db, link) {
  try {
    await db
      .prepare(
        'INSERT INTO links (code, url, created_at, expires_at, token_hash) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(link.code, link.url, link.createdAt, link.expiresAt, link.tokenHash)
      .run();
    return { ok: true };
  } catch (err) {
    if (String(err?.message ?? err).includes('UNIQUE')) return { ok: false, conflict: true };
    throw err;
  }
}

// Frees an alias whose link has already expired, so it can be claimed again.
export const reclaimExpired = (db, code, now) =>
  db
    .prepare('DELETE FROM links WHERE code = ? AND expires_at IS NOT NULL AND expires_at <= ?')
    .bind(code, now)
    .run();

export const deleteLink = (db, code) =>
  db.batch([
    db.prepare('DELETE FROM clicks WHERE code = ?').bind(code),
    db.prepare('DELETE FROM link_flags WHERE code = ?').bind(code),
    db.prepare('DELETE FROM links WHERE code = ?').bind(code),
  ]);

// Looks up many links at once for the "your links" list. Returns rows without secrets.
export async function lookupLinks(db, codes) {
  if (codes.length === 0) return [];
  const marks = codes.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT code, url, created_at, expires_at, clicks, last_click_at, token_hash
       FROM links WHERE code IN (${marks})`,
    )
    .bind(...codes)
    .all();
  return results;
}

// ---------- clicks ----------

// Records one human click and bumps the counter, only if the link still exists.
export function recordClick(db, code, info, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  return db.batch([
    db
      .prepare(
        `INSERT INTO clicks (code, ts, day, country, device, browser, referrer)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM links WHERE code = ?)`,
      )
      .bind(code, now, day, info.country, info.device, info.browser, info.referrer, code),
    db
      .prepare('UPDATE links SET clicks = clicks + 1, last_click_at = ? WHERE code = ?')
      .bind(now, code),
  ]);
}

// Pure helper: fills days with no clicks so charts have a continuous axis.
export function fillDays(rows, now, days) {
  const byDay = new Map(rows.map((r) => [r.day, r.count]));
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(now - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10);
    return { day, clicks: byDay.get(day) ?? 0 };
  });
}

export async function getStats(db, link, now, days = 30) {
  const since = now - days * DAY_MS;
  const top = (column) =>
    db
      .prepare(
        `SELECT ${column} AS key, COUNT(*) AS count FROM clicks
         WHERE code = ? GROUP BY ${column} ORDER BY count DESC LIMIT 8`,
      )
      .bind(link.code);

  const [perDay, countries, devices, browsers, referrers] = await db.batch([
    db
      .prepare(
        `SELECT day, COUNT(*) AS count FROM clicks
         WHERE code = ? AND ts >= ? GROUP BY day ORDER BY day`,
      )
      .bind(link.code, since),
    top('country'),
    top('device'),
    top('browser'),
    top('referrer'),
  ]);

  return {
    code: link.code,
    url: link.url,
    createdAt: link.created_at,
    expiresAt: link.expires_at,
    clicks: link.clicks,
    lastClickAt: link.last_click_at,
    series: fillDays(perDay.results, now, days),
    countries: countries.results,
    devices: devices.results,
    browsers: browsers.results,
    referrers: referrers.results,
  };
}

// ---------- rate limiting ----------

// Counts one hit in the current window and returns the new count.
export async function hitRateLimit(db, key, windowEndsAt) {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, windowEndsAt)
    .first();
  return row?.count ?? 1;
}

// ---------- cleanup (runs from the daily cron) ----------

export function purgeOld(db, now) {
  return db.batch([
    db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM reports WHERE ts < ?').bind(now - 180 * DAY_MS),
    db.prepare('DELETE FROM clicks WHERE ts < ?').bind(now - 365 * DAY_MS),
    db
      .prepare('DELETE FROM clicks WHERE code IN (SELECT code FROM links WHERE expires_at < ?)')
      .bind(now - 30 * DAY_MS),
    db
      .prepare('DELETE FROM links WHERE expires_at IS NOT NULL AND expires_at < ?')
      .bind(now - 30 * DAY_MS),
    db.prepare('DELETE FROM link_flags WHERE code NOT IN (SELECT code FROM links)'),
  ]);
}

// ---------- abuse reports ----------

export const insertReport = (db, report) =>
  db
    .prepare('INSERT INTO reports (code, reason, details, ts) VALUES (?, ?, ?, ?)')
    .bind(report.code, report.reason, report.details, report.ts)
    .run();

// ---------- moderation (admin page) ----------

export const setFlag = (db, code, status, ts) =>
  db
    .prepare(
      `INSERT INTO link_flags (code, status, ts) VALUES (?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET status = excluded.status, ts = excluded.ts`,
    )
    .bind(code, status, ts)
    .run();

export const clearFlag = (db, code) =>
  db.prepare('DELETE FROM link_flags WHERE code = ?').bind(code).run();

export const dismissReports = (db, code) =>
  db.prepare('DELETE FROM reports WHERE code = ?').bind(code).run();

// One row per reported code, newest first, with the link's current state.
export async function listReports(db) {
  const { results } = await db
    .prepare(
      `SELECT r.code AS code, COUNT(*) AS reports, MAX(r.ts) AS lastAt,
              GROUP_CONCAT(DISTINCT r.reason) AS reasons,
              (SELECT d.details FROM reports d
                 WHERE d.code = r.code AND d.details != '' ORDER BY d.ts DESC LIMIT 1) AS note,
              l.url AS url, l.clicks AS clicks, f.status AS flag
       FROM reports r
       LEFT JOIN links l ON l.code = r.code
       LEFT JOIN link_flags f ON f.code = r.code
       GROUP BY r.code ORDER BY lastAt DESC LIMIT 100`,
    )
    .all();
  return results;
}
