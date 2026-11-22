// Optional, operator-selected HTTPS cultural feed. Cached for six hours and
// used ONLY during editorial seeding; never in the track picker or watcher.
// No model-supplied URL, web browsing, listener identifiers or audio upload.
import { parseFeed } from '../../skills/feed.js';
import { fetchWithTimeout } from '../../util/fetch-timeout.js';

const TTL = 6 * 3600_000;
let cached: { url: string; at: number; items: ReturnType<typeof parseFeed> } | null = null;

export function approvedCulturalFeed(raw: string | undefined): string | null {
  if (!raw || raw.length > 500) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
      || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')
      || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return null;
    return url.toString();
  } catch { return null; }
}
export async function fetchDirectorCulture(): Promise<Array<{ title: string; description: string;
  sourceUrl: string; retrievedAt: string; verification: 'unverified_headline' }>> {
  const url = approvedCulturalFeed(process.env.SUBWAVE_MI_V3_CULTURAL_FEED_URL);
  if (!url) return [];
  if (cached?.url === url && Date.now() - cached.at < TTL) return stamped(cached);
  try {
    const res = await fetchWithTimeout(url, { timeoutMs: 2300, bodyDeadline: true,
      redirect: 'error', headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml' } });
    if (!res.ok || Number(res.headers.get('content-length') ?? 0) > 64_000) return [];
    const content = await res.text();
    if (content.length > 64_000) return [];
    const items = parseFeed(content, 3).map(x => ({ title: x.title.slice(0, 150), description: x.description.slice(0, 220) }));
    cached = { url, at: Date.now(), items };
    return stamped(cached);
  } catch { return []; }
}
function stamped(v: NonNullable<typeof cached>) {
  return v.items.map(x => ({ ...x, sourceUrl: v.url,
    retrievedAt: new Date(v.at).toISOString(), verification: 'unverified_headline' as const }));
}
