// Small response helpers. Every API reply is JSON and never cached.

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
      ...CORS_HEADERS,
      ...extra,
    },
  });

export const fail = (status, code, message, extra = {}) =>
  json({ error: { code, message } }, status, extra);

// Returns a plain object, or null when the body is missing, too large or not a JSON object.
export async function readJson(request, maxBytes = 16384) {
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
