// Turns a User-Agent string into three coarse labels. The raw string is never stored.

const BOT =
  /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|curl|wget|python-requests|headless|monitor|uptime|lighthouse/i;

export function parseUserAgent(ua = '') {
  const s = String(ua);
  const lower = s.toLowerCase();

  const isAndroid = lower.includes('android');
  const device =
    /ipad|tablet/.test(lower) || (isAndroid && !lower.includes('mobile'))
      ? 'tablet'
      : /mobi|iphone|android/.test(lower)
        ? 'mobile'
        : 'desktop';

  const browser = lower.includes('edg/') || lower.includes('edga/') || lower.includes('edgios/')
    ? 'Edge'
    : lower.includes('opr/') || lower.includes('opera')
      ? 'Opera'
      : lower.includes('samsungbrowser')
        ? 'Samsung Internet'
        : lower.includes('firefox') || lower.includes('fxios')
          ? 'Firefox'
          : lower.includes('chrome') || lower.includes('crios')
            ? 'Chrome'
            : lower.includes('safari')
              ? 'Safari'
              : 'Other';

  return { bot: s === '' || BOT.test(s), device, browser };
}

// Keeps only the host of a Referer header, or "direct" when there is none.
export function referrerHost(header) {
  if (!header) return 'direct';
  try {
    return new URL(header).hostname.replace(/^www\./, '').slice(0, 80) || 'direct';
  } catch {
    return 'direct';
  }
}
