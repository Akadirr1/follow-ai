/**
 * `add-source`'s feed resolution: direct feed, HTML discovery, and every
 * rejection path. `fetch` and the resolver are injected — no network.
 */
import { displayNameFor, resolveFeed } from '../functions/_shared/add-source.ts';
import { slugify } from '../functions/_shared/supabase-admin.ts';
import {
  ATOM_GENERIC,
  HTML_WITHOUT_FEED_LINK,
  HTML_WITH_FEED_LINK,
  NOT_XML_AT_ALL,
  RSS_OPENAI,
  RSS_WEBRAZZI,
} from './fixtures/feeds.ts';

const NOW = new Date('2026-08-21T12:00:00Z');
const publicResolver = async () => ['93.184.216.34'];

type Route = { status?: number; body: string; contentType?: string };

function routes(map: Record<string, Route>, log: string[] = []) {
  return async (input: string): Promise<Response> => {
    log.push(input);
    const route = map[input];
    if (!route) return new Response('', { status: 404 });
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { 'content-type': route.contentType ?? 'application/rss+xml' },
    });
  };
}

function deps(fetchImpl: (input: string) => Promise<Response>, requireDns = true) {
  return {
    fetchImpl,
    resolve: publicResolver,
    requireDns,
    now: () => NOW,
  };
}

describe('resolveFeed: direct feed', () => {
  it('accepts a feed URL and reports what it found', async () => {
    const result = await resolveFeed(
      'https://openai.com/news/rss.xml',
      deps(routes({ 'https://openai.com/news/rss.xml': { body: RSS_OPENAI } })),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.feed).toMatchObject({
        feedUrl: 'https://openai.com/news/rss.xml',
        title: 'OpenAI Blog',
        siteUrl: 'https://openai.com/news',
        kind: 'rss',
        itemCount: 2,
        discovered: false,
      });
    }
  });

  it('accepts an Atom feed', async () => {
    const result = await resolveFeed(
      'https://example.org/feed.xml',
      deps(
        routes({
          'https://example.org/feed.xml': {
            body: ATOM_GENERIC,
            contentType: 'application/atom+xml',
          },
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.feed.kind).toBe('atom');
  });

  it('sniffs a feed served with the wrong content type', async () => {
    const result = await resolveFeed(
      'https://example.org/feed',
      deps(
        routes({
          'https://example.org/feed': { body: RSS_WEBRAZZI, contentType: 'text/plain' },
        }),
      ),
    );
    expect(result.ok).toBe(true);
  });
});

describe('resolveFeed: HTML discovery', () => {
  it('follows exactly one advertised feed and marks it discovered', async () => {
    const log: string[] = [];
    const result = await resolveFeed(
      'https://example.org/blog',
      deps(
        routes(
          {
            'https://example.org/blog': {
              body: HTML_WITH_FEED_LINK,
              contentType: 'text/html',
            },
            'https://example.org/feed.xml': { body: RSS_OPENAI },
            'https://example.org/atom.xml': { body: ATOM_GENERIC },
          },
          log,
        ),
      ),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.feed.discovered).toBe(true);
      expect(result.feed.feedUrl).toBe('https://example.org/feed.xml');
    }
    // Exactly one discovery hop: the second advertised feed is never fetched.
    expect(log).toEqual(['https://example.org/blog', 'https://example.org/feed.xml']);
  });

  it('revalidates the discovered target under the same policy', async () => {
    const log: string[] = [];
    const html = `<link rel="alternate" type="application/rss+xml" href="http://169.254.169.254/latest/">`;
    const result = await resolveFeed(
      'https://example.org/blog',
      deps(
        routes(
          { 'https://example.org/blog': { body: html, contentType: 'text/html' } },
          log,
        ),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unsafe_url');
    // The dangerous target was never fetched.
    expect(log).toEqual(['https://example.org/blog']);
  });

  it('rejects an HTML page that advertises nothing', async () => {
    const result = await resolveFeed(
      'https://example.org/blog',
      deps(
        routes({
          'https://example.org/blog': {
            body: HTML_WITHOUT_FEED_LINK,
            contentType: 'text/html',
          },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_feed_discovered');
  });

  it('rejects a discovered target that turns out not to be a feed', async () => {
    const result = await resolveFeed(
      'https://example.org/blog',
      deps(
        routes({
          'https://example.org/blog': {
            body: HTML_WITH_FEED_LINK,
            contentType: 'text/html',
          },
          'https://example.org/feed.xml': {
            body: HTML_WITHOUT_FEED_LINK,
            contentType: 'text/html',
          },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_a_feed');
  });
});

describe('resolveFeed: rejections', () => {
  it('refuses an unsafe URL before any fetch happens', async () => {
    const log: string[] = [];
    for (const url of [
      'http://example.org/feed.xml',
      'https://127.0.0.1/feed.xml',
      'https://example.org:8080/feed.xml',
      'https://user:pw@example.org/feed.xml',
      'https://intranet.local/feed.xml',
    ]) {
      const result = await resolveFeed(url, deps(routes({}, log)));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('unsafe_url');
    }
    expect(log).toEqual([]);
  });

  it('fails closed when the runtime offers no DNS resolver', async () => {
    const result = await resolveFeed('https://example.org/feed.xml', {
      fetchImpl: routes({ 'https://example.org/feed.xml': { body: RSS_OPENAI } }),
      resolve: null,
      requireDns: true,
      now: () => NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsafe_url');
      expect(result.detail).toBe('dns_unavailable');
    }
  });

  it('reports an upstream HTTP failure without leaking the body', async () => {
    const result = await resolveFeed(
      'https://example.org/feed.xml',
      deps(
        routes({
          'https://example.org/feed.xml': { status: 503, body: 'internal stack trace' },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('fetch_failed');
      expect(result.detail).toBe('http_503');
      expect(JSON.stringify(result)).not.toContain('stack trace');
    }
  });

  it('rejects a document that is neither feed nor HTML', async () => {
    const result = await resolveFeed(
      'https://example.org/x',
      deps(
        routes({
          'https://example.org/x': { body: NOT_XML_AT_ALL, contentType: 'text/plain' },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_feed_discovered');
  });

  it('rejects a syntactically valid feed with nothing in it', async () => {
    const empty = '<rss version="2.0"><channel><title>Empty</title></channel></rss>';
    const result = await resolveFeed(
      'https://example.org/feed.xml',
      deps(routes({ 'https://example.org/feed.xml': { body: empty } })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('empty_feed');
  });

  it('rejects a body over the size cap', async () => {
    const result = await resolveFeed('https://example.org/feed.xml', {
      ...deps(routes({ 'https://example.org/feed.xml': { body: 'x'.repeat(5000) } })),
      maxBytes: 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('too_large');
  });
});

describe('displayNameFor', () => {
  const base = {
    feedUrl: 'https://example.org/feed.xml',
    siteUrl: null,
    kind: 'rss' as const,
    itemCount: 1,
    discovered: false,
  };

  it('uses the feed title, because the caller does not name a shared row', () => {
    expect(displayNameFor({ ...base, title: 'Webrazzi Yapay Zeka' })).toBe(
      'Webrazzi Yapay Zeka',
    );
  });

  it('falls back to the hostname when the feed is untitled', () => {
    expect(displayNameFor({ ...base, title: '   ' })).toBe('example.org');
    expect(
      displayNameFor({ ...base, title: '', feedUrl: 'https://www.example.org/f.xml' }),
    ).toBe('example.org');
  });

  it('caps the name at the column width', () => {
    expect(displayNameFor({ ...base, title: 'x'.repeat(400) })).toHaveLength(200);
  });
});

describe('slugify', () => {
  it('produces a slug the sources CHECK constraint accepts', () => {
    const pattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const input of [
      'OpenAI Blog',
      'Webrazzi Yapay Zeka',
      'Türkçe Şey — Çok Güzel',
      'arXiv cs.AI',
      '  spaced   out  ',
      'Hugging Face!!!',
    ]) {
      const slug = slugify(input);
      expect({ input, ok: pattern.test(slug) }).toEqual({ input, ok: true });
      expect(slug.length).toBeGreaterThanOrEqual(2);
      expect(slug.length).toBeLessThanOrEqual(64);
    }
  });

  it('transliterates Turkish characters rather than dropping them', () => {
    expect(slugify('Türkçe Şey')).toBe('turkce-sey');
    expect(slugify('İstanbul Ağı')).toBe('istanbul-agi');
  });

  it('falls back when nothing usable survives', () => {
    expect(slugify('!!!')).toBe('kaynak');
    expect(slugify('')).toBe('kaynak');
    expect(slugify('中文')).toBe('kaynak');
  });
});
