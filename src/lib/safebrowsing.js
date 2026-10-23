// Optional Google Safe Browsing check, run when a link is created.
// Only the link being shortened is sent to Google, never anything about the visitor.
// Turned on by adding a SAFE_BROWSING_KEY secret. Without a key this does nothing.

const ENDPOINT = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';

export function buildRequestBody(url) {
  return {
    client: { clientId: 'tinyhop', clientVersion: '2.0' },
    threatInfo: {
      threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
      platformTypes: ['ANY_PLATFORM'],
      threatEntryTypes: ['URL'],
      threatEntries: [{ url }],
    },
  };
}

// Resolves true only when Google reports a match. Any error or timeout resolves false
// ("fail open"), so a Google outage never stops people from shortening links.
export async function isUnsafe(url, apiKey, fetchImpl = fetch) {
  if (!apiKey) return false;
  try {
    const res = await fetchImpl(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildRequestBody(url)),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data?.matches) && data.matches.length > 0;
  } catch (err) {
    console.error('Safe Browsing check failed', err);
    return false;
  }
}
