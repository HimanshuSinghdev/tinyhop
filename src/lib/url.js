// Validates and normalizes the link someone wants to shorten.

export const MAX_URL_LENGTH = 2048;

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const DANGEROUS_SCHEME = /^(javascript|data|vbscript|file|blob|about|mailto|tel|sms|intent):/i;

export const parseList = (text) =>
  String(text ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

function isPrivateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  if (host.startsWith('[')) return true; // IPv6 literals are not supported
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return !host.includes('.'); // single-label names like "intranet"
}

// Returns { ok: true, url } or { ok: false, message }.
export function normalizeTarget(raw, { selfHost, blockedHosts = [] }) {
  if (typeof raw !== 'string') return { ok: false, message: 'Enter a link to shorten.' };
  let input = raw.trim();
  if (!input) return { ok: false, message: 'Enter a link to shorten.' };
  if (input.length > MAX_URL_LENGTH) {
    return { ok: false, message: `Links can be up to ${MAX_URL_LENGTH} characters.` };
  }
  if (DANGEROUS_SCHEME.test(input)) {
    return { ok: false, message: 'Only http and https links can be shortened.' };
  }
  if (!SCHEME.test(input)) input = `https://${input}`;

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, message: "That doesn't look like a valid link." };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: 'Only http and https links can be shortened.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: 'Links with a username or password are not allowed.' };
  }

  const host = parsed.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    return { ok: false, message: 'That address is private and cannot be reached by others.' };
  }
  if (host === String(selfHost).toLowerCase()) {
    return { ok: false, message: 'That link is already a Tinyhop link.' };
  }
  if (blockedHosts.some((b) => host === b || host.endsWith(`.${b}`))) {
    return { ok: false, message: 'This site cannot be shortened.' };
  }
  return { ok: true, url: parsed.href };
}
