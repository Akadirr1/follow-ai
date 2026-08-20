/**
 * Turning a user-supplied URL into a validated feed.
 *
 * Portable: no Deno globals. `fetch` and the DNS resolver are injected, so the
 * whole flow — including HTML discovery and every rejection path — runs under
 * Jest with no network.
 *
 * arch-001 §3: the submitted URL may be the feed itself, or an HTML page that
 * advertises exactly one `<link rel="alternate">` feed. The discovered target
 * is re-validated by the *same* policy before it is fetched; discovery is not
 * a way around the URL rules.
 */

import { discoverFeedLinks, parseFeed, ParsedFeed } from './feed.ts';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  FetchImpl,
  looksLikeXmlFeed,
  Resolver,
  safeFetch,
} from './url-safety.ts';

export type ResolveFeedDeps = {
  fetchImpl: FetchImpl;
  resolve: Resolver;
  /** User input: a runtime with no DNS must fail closed, not fetch blind. */
  requireDns: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => Date;
};

export type ResolvedFeed = {
  /** The canonical URL of the feed itself — never the HTML page. */
  feedUrl: string;
  title: string;
  siteUrl: string | null;
  kind: ParsedFeed['kind'];
  itemCount: number;
  /** True when the feed was found via `<link rel="alternate">`. */
  discovered: boolean;
};

export type ResolveFeedFailure = {
  ok: false;
  /** Short, stable, non-sensitive code. Safe to return to the caller. */
  code:
    | 'unsafe_url'
    | 'fetch_failed'
    | 'timeout'
    | 'too_large'
    | 'too_many_redirects'
    | 'not_a_feed'
    | 'no_feed_discovered'
    | 'empty_feed';
  detail?: string;
};

export type ResolveFeedResult = { ok: true; feed: ResolvedFeed } | ResolveFeedFailure;

/** A feed with no usable items is not worth adding — it would seed nothing. */
export async function resolveFeed(
  rawUrl: string,
  deps: ResolveFeedDeps,
): Promise<ResolveFeedResult> {
  const first = await fetchDocument(rawUrl, deps);
  if (!first.ok) return first;

  if (looksLikeXmlFeed(first.body, first.contentType)) {
    return finish(first.body, first.finalUrl, deps, false);
  }

  // An HTML page: follow at most ONE advertised feed (arch-001 §3).
  const candidates = discoverFeedLinks(first.body, first.finalUrl);
  if (candidates.length === 0) {
    return { ok: false, code: 'no_feed_discovered' };
  }

  const second = await fetchDocument(candidates[0], deps);
  if (!second.ok) return second;
  if (!looksLikeXmlFeed(second.body, second.contentType)) {
    return { ok: false, code: 'not_a_feed' };
  }
  return finish(second.body, second.finalUrl, deps, true);
}

function finish(
  body: string,
  finalUrl: string,
  deps: ResolveFeedDeps,
  discovered: boolean,
): ResolveFeedResult {
  const now = deps.now ? deps.now() : new Date();
  const parsed = parseFeed(body, finalUrl, { now });
  if (parsed === null) return { ok: false, code: 'not_a_feed' };
  if (parsed.items.length === 0) return { ok: false, code: 'empty_feed' };

  return {
    ok: true,
    feed: {
      feedUrl: finalUrl,
      title: parsed.title,
      siteUrl: parsed.siteUrl,
      kind: parsed.kind,
      itemCount: parsed.items.length,
      discovered,
    },
  };
}

type DocumentResult =
  | { ok: true; body: string; finalUrl: string; contentType: string | null }
  | ResolveFeedFailure;

async function fetchDocument(
  url: string,
  deps: ResolveFeedDeps,
): Promise<DocumentResult> {
  const result = await safeFetch(url, {
    fetchImpl: deps.fetchImpl,
    resolve: deps.resolve,
    requireDns: deps.requireDns,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: deps.maxBytes ?? DEFAULT_MAX_BYTES,
  });

  if (!result.ok) {
    switch (result.kind) {
      case 'unsafe_url':
        return { ok: false, code: 'unsafe_url', detail: result.reason };
      case 'timeout':
        return { ok: false, code: 'timeout' };
      case 'too_large':
        return { ok: false, code: 'too_large' };
      case 'too_many_redirects':
        return { ok: false, code: 'too_many_redirects' };
      case 'http_error':
        return { ok: false, code: 'fetch_failed', detail: `http_${result.status}` };
      default:
        return { ok: false, code: 'fetch_failed', detail: result.kind };
    }
  }

  return {
    ok: true,
    body: result.body,
    finalUrl: result.finalUrl,
    contentType: result.headers.get('content-type'),
  };
}

/**
 * The display name for a new source: the feed's own `<title>`, falling back to
 * its hostname. arch-001 §3 is explicit that "the feed supplies the display
 * name" — the caller does not get to name a shared row, because that row is
 * visible to every other user.
 */
export function displayNameFor(feed: ResolvedFeed): string {
  const title = feed.title.trim();
  if (title !== '') return title.slice(0, 200);
  try {
    return new URL(feed.feedUrl).hostname.replace(/^www\./, '').slice(0, 200);
  } catch {
    return 'Kaynak';
  }
}
