// "Manage keys": no accounts. Each link gets a random secret when it is created.
// We store only its SHA-256 hash, so a database leak cannot be used to delete links.

import { randomCode } from './codes.js';

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const newToken = () => `mk_${randomCode(32)}`; // 32 base62 characters, about 190 bits

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const bearerToken = (request) =>
  /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;

export async function tokenMatches(token, expectedHash) {
  if (!token || !expectedHash) return false;
  return timingSafeEqual(await sha256Hex(token), expectedHash);
}
