/**
 * URL canonicalisation and length capping.
 *
 * Portable: Web APIs only (`URL`), no Deno globals.
 *
 * Canonicalisation exists for one reason: two spellings of the same article
 * must hash to the same `url_hash`, because `aigundem.articles.url_hash` is
 * UNIQUE and is how ingestion deduplicates across sources (arch-001 §2).
 *
 * The rules are deliberately conservative — a canonicaliser that is too clever
 * merges two genuinely different articles, which is worse than missing a
 * duplicate:
 *   - scheme and host lowercased (URL already does this);
 *   - default port (443) dropped;
 *   - fragment dropped — it never identifies a different article;
 *   - known tracking parameters dropped;
 *   - remaining query parameters kept in their original order;
 *   - the path is left EXACTLY as-is, trailing slash included. TechCrunch and
 *     Webrazzi both serve trailing-slash canonical URLs while arXiv does not,
 *     so "normalising" it would be a guess.
 */

/** Query parameters that never change which article is being addressed. */
export const TRACKING_PARAMS: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref_src',
  'ref_url',
  '_hsenc',
  '_hsmi',
  'yclid',
  'ttclid',
];

/** `aigundem.sources.feed_url` and `articles.canonical_url` cap at 2048. */
export const MAX_URL_LENGTH = 2048;

const TRACKING_SET = new Set(TRACKING_PARAMS);

export class UrlCanonicalisationError extends Error {}

/**
 * Canonicalise an absolute URL. Throws `UrlCanonicalisationError` when the
 * input is not a parseable absolute URL or exceeds the stored length cap.
 *
 * NOTE: this is *not* a safety check. It performs no scheme, host or DNS
 * validation — `checkUrlSafety` in `url-safety.ts` does that, and must run
 * before any fetch.
 */
export function canonicalizeUrl(raw: string, base?: string): string {
  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    throw new UrlCanonicalisationError('Not an absolute URL.');
  }

  url.hash = '';

  // `URL` already omits the port when it is the protocol default, but an
  // explicit ":443" on https survives in some engines. Drop it either way.
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }

  if (url.search !== '') {
    const kept: [string, string][] = [];
    for (const [key, value] of url.searchParams.entries()) {
      if (TRACKING_SET.has(key.toLowerCase())) continue;
      kept.push([key, value]);
    }
    if (kept.length === 0) {
      url.search = '';
    } else {
      const params = new URLSearchParams();
      for (const [key, value] of kept) params.append(key, value);
      url.search = params.toString();
    }
  }

  const result = url.toString();
  if (result.length > MAX_URL_LENGTH) {
    throw new UrlCanonicalisationError(
      `URL exceeds ${MAX_URL_LENGTH} characters.`,
    );
  }
  return result;
}

/** Canonicalise, returning null instead of throwing. */
export function tryCanonicalizeUrl(raw: string, base?: string): string | null {
  try {
    return canonicalizeUrl(raw, base);
  } catch {
    return null;
  }
}

/**
 * Resolve a possibly-relative link found inside a feed against the feed's own
 * URL, then canonicalise it. Returns null when the result is unusable.
 */
export function resolveFeedLink(href: string, feedUrl: string): string | null {
  const trimmed = href.trim();
  if (trimmed === '') return null;
  return tryCanonicalizeUrl(trimmed, feedUrl);
}
