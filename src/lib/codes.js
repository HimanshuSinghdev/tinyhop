// Short code generation and alias rules.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const CODE_LENGTH = 7; // 62^7 is about 3.5 trillion combinations

export const ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;

// Words that would clash with pages or API routes, or mislead people.
const RESERVED = new Set([
  'api', 'app', 'admin', 'assets', 'static', 'public', 'login', 'logout', 'signup',
  'privacy', 'terms', 'about', 'help', 'docs', 'status', 'health', 'stats', 'qr',
  'index', 'favicon', 'robots', 'sitemap', 'manifest', 'sw', 'vendor', 'security',
  'www', 'mail', 'root', 'null', 'undefined',
]);

export const isReserved = (code) => RESERVED.has(code.toLowerCase());

// Uniform random code. Bytes >= 248 are skipped so every character is equally likely.
export function randomCode(length = CODE_LENGTH) {
  const limit = 256 - (256 % ALPHABET.length);
  const out = [];
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out.push(ALPHABET[byte % ALPHABET.length]);
    }
  }
  return out.join('');
}

export function checkAlias(alias) {
  if (typeof alias !== 'string' || !ALIAS_PATTERN.test(alias)) {
    return { ok: false, message: 'Use 3 to 32 letters, numbers, dashes or underscores.' };
  }
  if (isReserved(alias)) {
    return { ok: false, message: 'That word is reserved. Try another one.' };
  }
  return { ok: true };
}
