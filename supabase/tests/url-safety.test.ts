/**
 * The SSRF matrix and the guarded fetch (arch-001 §3).
 *
 * No network: `fetch` and the DNS resolver are injected everywhere.
 */
import {
  BLOCKED_IP_CLASSES,
  classifyIp,
  isIpLiteral,
  parseIp,
} from '../functions/_shared/ip.ts';
import { canonicalizeUrl, TRACKING_PARAMS } from '../functions/_shared/url.ts';
import {
  checkUrlSafety,
  checkUrlShape,
  decodeBody,
  looksLikeXmlFeed,
  safeFetch,
} from '../functions/_shared/url-safety.ts';

// ---------------------------------------------------------------------------
// Address classification — the full matrix arch-001 §3 names.
// ---------------------------------------------------------------------------

describe('classifyIp: the SSRF range matrix', () => {
  const cases: [string, string][] = [
    // loopback
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    // private
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['::ffff:192.168.0.5', 'private'],
    // link-local
    ['169.254.169.254', 'link_local'],
    ['fe80::1', 'link_local'],
    ['febf::1', 'link_local'],
    // carrier-grade NAT
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    // documentation
    ['192.0.2.1', 'documentation'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['2001:db8::1', 'documentation'],
    // multicast
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['ff02::1', 'multicast'],
    // reserved
    ['0.0.0.1', 'reserved'],
    ['192.0.0.1', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['240.0.0.1', 'reserved'],
    ['2001::1', 'reserved'],
    // broadcast / unspecified
    ['255.255.255.255', 'broadcast'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    // IPv6 unique local
    ['fc00::1', 'unique_local'],
    ['fd12:3456::1', 'unique_local'],
    // genuinely public
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['172.32.0.1', 'public'],
    ['100.128.0.1', 'public'],
    ['2606:4700::1111', 'public'],
  ];

  it.each(cases)('%s is %s', (address, expected) => {
    expect(classifyIp(address)).toBe(expected);
  });

  it('blocks every non-public class', () => {
    for (const [address, cls] of cases) {
      const blocked = BLOCKED_IP_CLASSES.has(classifyIp(address));
      expect({ address, blocked }).toEqual({ address, blocked: cls !== 'public' });
    }
  });

  it('fails closed on anything it cannot parse', () => {
    for (const junk of ['', 'not-an-ip', '999.1.1.1', '1.2.3', '10.0.0.01', 'fe80:::1']) {
      expect(classifyIp(junk)).toBe('reserved');
      expect(BLOCKED_IP_CLASSES.has(classifyIp(junk))).toBe(true);
    }
  });

  it('parses the IPv6 forms feeds actually use', () => {
    expect(parseIp('::1')?.bytes.slice(-1)).toEqual([1]);
    expect(parseIp('[::1]')?.family).toBe(6);
    expect(parseIp('fe80::1%eth0')?.family).toBe(6);
    expect(parseIp('::ffff:1.2.3.4')?.bytes.slice(-4)).toEqual([1, 2, 3, 4]);
    expect(parseIp('1:2:3:4:5:6:7:8')?.family).toBe(6);
    expect(parseIp('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIp('1:2:3:4:5:6:7')).toBeNull();
  });

  it('recognises IP literals as hostnames', () => {
    expect(isIpLiteral('93.184.216.34')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('example.org')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// URL shape
// ---------------------------------------------------------------------------

describe('checkUrlShape', () => {
  const rejects: [string, string][] = [
    ['http://example.org/feed.xml', 'scheme_not_https'],
    ['ftp://example.org/feed.xml', 'scheme_not_https'],
    ['file:///etc/passwd', 'scheme_not_https'],
    ['data:text/xml,<rss/>', 'scheme_not_https'],
    ['https://user:pass@example.org/feed.xml', 'credentials_not_allowed'],
    ['https://user@example.org/feed.xml', 'credentials_not_allowed'],
    ['https://example.org/feed.xml#section', 'fragment_not_allowed'],
    ['https://example.org:8080/feed.xml', 'port_not_allowed'],
    ['https://example.org:22/feed.xml', 'port_not_allowed'],
    ['https://127.0.0.1/feed.xml', 'ip_literal_not_allowed'],
    ['https://169.254.169.254/latest/meta-data/', 'ip_literal_not_allowed'],
    ['https://[::1]/feed.xml', 'ip_literal_not_allowed'],
    ['https://93.184.216.34/feed.xml', 'ip_literal_not_allowed'],
    ['https://localhost/feed.xml', 'invalid_host'],
    ['https://router.local/feed.xml', 'special_use_host'],
    ['https://metadata.internal/feed.xml', 'special_use_host'],
    ['https://abc.onion/feed.xml', 'special_use_host'],
    ['not a url', 'not_absolute_url'],
    ['', 'not_absolute_url'],
    ['/relative/feed.xml', 'not_absolute_url'],
  ];

  it.each(rejects)('rejects %s as %s', (url, reason) => {
    const result = checkUrlShape(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });

  it('rejects a URL longer than the stored column', () => {
    const long = `https://example.org/${'a'.repeat(2100)}`;
    const result = checkUrlShape(long);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('url_too_long');
  });

  it('accepts a plain public https feed and returns it canonicalised', () => {
    const result = checkUrlShape('https://EXAMPLE.org:443/feed.xml?utm_source=x&id=7');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe('https://example.org/feed.xml?id=7');
      expect(result.hostname).toBe('example.org');
      expect(result.dnsChecked).toBe(false);
    }
  });

  it('accepts every seeded feed URL unchanged', () => {
    const seeded = [
      'https://openai.com/news/rss.xml',
      'https://deepmind.google/blog/rss.xml',
      'https://huggingface.co/blog/feed.xml',
      'https://rss.arxiv.org/rss/cs.AI',
      'https://techcrunch.com/category/artificial-intelligence/feed/',
      'https://webrazzi.com/kategori/yapay-zeka/feed/',
    ];
    for (const url of seeded) {
      const result = checkUrlShape(url);
      expect({ url, ok: result.ok }).toEqual({ url, ok: true });
      // Canonicalisation must be a no-op, or the seeded feed_url_hash would
      // not match what add-source computes for the same feed.
      if (result.ok) expect(result.url).toBe(url);
    }
  });
});

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

describe('checkUrlSafety: resolved addresses', () => {
  const publicResolver = async () => ['93.184.216.34'];

  it('rejects a name that resolves into a blocked range', async () => {
    for (const address of ['127.0.0.1', '169.254.169.254', '10.1.2.3', 'fd00::1']) {
      const result = await checkUrlSafety('https://evil.example.org/feed.xml', {
        resolve: async () => [address],
        requireDns: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('blocked_address');
    }
  });

  it('rejects when ANY answer is blocked, not just the first', async () => {
    const result = await checkUrlSafety('https://mixed.example.org/feed.xml', {
      resolve: async () => ['93.184.216.34', '127.0.0.1'],
      requireDns: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('blocked_address');
  });

  it('rejects an empty answer', async () => {
    const result = await checkUrlSafety('https://nowhere.example.org/feed.xml', {
      resolve: async () => [],
      requireDns: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('dns_no_answer');
  });

  it('fails closed for user input when no resolver exists', async () => {
    const result = await checkUrlSafety('https://example.org/feed.xml', {
      resolve: null,
      requireDns: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('dns_unavailable');
  });

  it('fails closed for user input when the resolver throws', async () => {
    const result = await checkUrlSafety('https://example.org/feed.xml', {
      resolve: async () => {
        throw new Error('SERVFAIL');
      },
      requireDns: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('dns_unavailable');
  });

  it('allows shape-only checking for reviewed sources when DNS is absent', async () => {
    const result = await checkUrlSafety('https://openai.com/news/rss.xml', {
      resolve: null,
      requireDns: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dnsChecked).toBe(false);
  });

  it('accepts a public answer and records it', async () => {
    const result = await checkUrlSafety('https://example.org/feed.xml', {
      resolve: publicResolver,
      requireDns: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dnsChecked).toBe(true);
      expect(result.addresses).toEqual(['93.184.216.34']);
    }
  });
});

// ---------------------------------------------------------------------------
// safeFetch
// ---------------------------------------------------------------------------

type Route = { status: number; headers?: Record<string, string>; body?: string };

function fakeFetch(routes: Record<string, Route>, log: string[] = []) {
  return async (input: string, init: RequestInit): Promise<Response> => {
    log.push(input);
    const route = routes[input];
    if (!route) throw new TypeError('fetch failed');
    void init;
    return new Response(route.status === 304 ? null : (route.body ?? ''), {
      status: route.status,
      headers: route.headers ?? {},
    });
  };
}

const openResolver = async () => ['93.184.216.34'];

describe('safeFetch', () => {
  it('sends only the headers it chooses, with manual redirects', async () => {
    let seen: RequestInit | undefined;
    const result = await safeFetch('https://example.org/feed.xml', {
      fetchImpl: async (_input, init) => {
        seen = init;
        return new Response('<rss/>', { status: 200 });
      },
      resolve: openResolver,
      requireDns: true,
    });
    expect(result.ok).toBe(true);
    expect(seen?.redirect).toBe('manual');
    expect(seen?.credentials).toBe('omit');
    const headers = seen?.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual([
      'accept',
      'accept-encoding',
      'user-agent',
    ]);
    expect(headers.cookie).toBeUndefined();
  });

  it('sends conditional headers when validators are known', async () => {
    let headers: Record<string, string> = {};
    await safeFetch('https://example.org/feed.xml', {
      fetchImpl: async (_input, init) => {
        headers = init.headers as Record<string, string>;
        return new Response(null, { status: 304 });
      },
      resolve: openResolver,
      requireDns: true,
      conditional: { etag: 'W/"abc"', lastModified: 'Wed, 20 Aug 2026 00:00:00 GMT' },
    });
    expect(headers['if-none-match']).toBe('W/"abc"');
    expect(headers['if-modified-since']).toBe('Wed, 20 Aug 2026 00:00:00 GMT');
  });

  it('reports 304 as a success with an empty body', async () => {
    const result = await safeFetch('https://example.org/feed.xml', {
      fetchImpl: async () => new Response(null, { status: 304, headers: { etag: 'W/"v2"' } }),
      resolve: openResolver,
      requireDns: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(304);
      expect(result.body).toBe('');
      expect(result.headers.get('etag')).toBe('W/"v2"');
    }
  });

  it('follows up to three redirects and revalidates every hop', async () => {
    const log: string[] = [];
    const routes: Record<string, Route> = {
      'https://example.org/1': { status: 301, headers: { location: '/2' } },
      'https://example.org/2': { status: 302, headers: { location: '/3' } },
      'https://example.org/3': { status: 307, headers: { location: '/4' } },
      'https://example.org/4': { status: 200, body: '<rss/>' },
    };
    const result = await safeFetch('https://example.org/1', {
      fetchImpl: fakeFetch(routes, log),
      resolve: openResolver,
      requireDns: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.redirects).toBe(3);
      expect(result.finalUrl).toBe('https://example.org/4');
    }
    expect(log).toHaveLength(4);
  });

  it('refuses a fourth redirect', async () => {
    const routes: Record<string, Route> = {
      'https://example.org/1': { status: 301, headers: { location: '/2' } },
      'https://example.org/2': { status: 301, headers: { location: '/3' } },
      'https://example.org/3': { status: 301, headers: { location: '/4' } },
      'https://example.org/4': { status: 301, headers: { location: '/5' } },
      'https://example.org/5': { status: 200, body: '<rss/>' },
    };
    const result = await safeFetch('https://example.org/1', {
      fetchImpl: fakeFetch(routes),
      resolve: openResolver,
      requireDns: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('too_many_redirects');
  });

  it('re-applies the full policy to a redirect target, so a redirect cannot escape it', async () => {
    const log: string[] = [];
    const cases: [string, string][] = [
      ['http://example.org/plain', 'scheme_not_https'],
      ['https://169.254.169.254/latest/meta-data/', 'ip_literal_not_allowed'],
      ['https://internal.local/feed.xml', 'special_use_host'],
      ['https://example.org:9999/feed.xml', 'port_not_allowed'],
    ];
    for (const [target, reason] of cases) {
      log.length = 0;
      const result = await safeFetch('https://example.org/start', {
        fetchImpl: fakeFetch(
          {
            'https://example.org/start': { status: 302, headers: { location: target } },
          },
          log,
        ),
        resolve: openResolver,
        requireDns: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok && result.kind === 'unsafe_url') expect(result.reason).toBe(reason);
      // The dangerous hop was never fetched.
      expect(log).toEqual(['https://example.org/start']);
    }
  });

  it('rejects a redirect to a name that resolves into a blocked range', async () => {
    const resolve = async (hostname: string) =>
      hostname === 'evil.example.org' ? ['10.0.0.5'] : ['93.184.216.34'];
    const result = await safeFetch('https://example.org/start', {
      fetchImpl: fakeFetch({
        'https://example.org/start': {
          status: 302,
          headers: { location: 'https://evil.example.org/feed.xml' },
        },
      }),
      resolve,
      requireDns: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === 'unsafe_url') {
      expect(result.reason).toBe('blocked_address');
    }
  });

  it('refuses a redirect with no Location', async () => {
    const result = await safeFetch('https://example.org/x', {
      fetchImpl: async () => new Response('', { status: 302 }),
      resolve: openResolver,
      requireDns: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('redirect_without_location');
  });

  it('rejects a declared body over the cap without reading it', async () => {
    const result = await safeFetch('https://example.org/big', {
      fetchImpl: async () =>
        new Response('x', { status: 200, headers: { 'content-length': '99999999' } }),
      resolve: openResolver,
      requireDns: true,
      maxBytes: 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('too_large');
  });

  it('rejects an undeclared body that exceeds the cap while streaming', async () => {
    const result = await safeFetch('https://example.org/big', {
      fetchImpl: async () => new Response('y'.repeat(5000), { status: 200 }),
      resolve: openResolver,
      requireDns: true,
      maxBytes: 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('too_large');
  });

  it('reports an aborted request as a timeout, not a network error', async () => {
    const result = await safeFetch('https://example.org/slow', {
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
      resolve: openResolver,
      requireDns: true,
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('timeout');
  });

  /**
   * rev-003 B2. The old deadline ended at the response HEADERS: the abort timer
   * was cleared as soon as `fetchImpl` resolved, and the body was then read with
   * no timer at all. A server that answers instantly and then stalls below the
   * 1 MiB cap held an Edge invocation — or an ingestion concurrency slot — open
   * forever. The pre-existing timeout test stalls BEFORE headers, so it could
   * not see this.
   */
  it('times out when the body stalls after the headers arrive', async () => {
    let cancelled = false;
    const started = Date.now();

    const result = await safeFetch('https://example.org/trickle', {
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              // One chunk, then silence: never closes, never errors, and stays
              // far below the byte cap.
              ctrl.enqueue(new TextEncoder().encode('<rss>'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
      resolve: openResolver,
      requireDns: true,
      timeoutMs: 60,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('timeout');
    // Within the budget, not "eventually".
    expect(Date.now() - started).toBeLessThan(3000);
    // The stalled stream is released rather than abandoned.
    expect(cancelled).toBe(true);
  });

  it('counts the whole redirect chain against one deadline', async () => {
    // Each hop answers, so the old per-hop timer would have restarted three
    // times and allowed 4x the stated budget.
    const started = Date.now();
    const result = await safeFetch('https://example.org/1', {
      fetchImpl: async (input) => {
        await new Promise((r) => setTimeout(r, 40));
        const next = Number(input.slice(-1)) + 1;
        return new Response('', { status: 302, headers: { location: `/${next}` } });
      },
      resolve: openResolver,
      requireDns: true,
      timeoutMs: 60,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('cancels a redirect body instead of abandoning the stream', async () => {
    let cancelled = false;
    const routes: Record<string, () => Response> = {
      'https://example.org/1': () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(new TextEncoder().encode('ignored redirect body'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 301, headers: { location: '/2' } },
        ),
      'https://example.org/2': () => new Response('<rss/>', { status: 200 }),
    };

    const result = await safeFetch('https://example.org/1', {
      fetchImpl: async (input) => routes[input](),
      resolve: openResolver,
      requireDns: true,
    });

    expect(result.ok).toBe(true);
    expect(cancelled).toBe(true);
  });

  it('cancels the body of a non-2xx response', async () => {
    let cancelled = false;
    const result = await safeFetch('https://example.org/gone', {
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(new TextEncoder().encode('error page'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 },
        ),
      resolve: openResolver,
      requireDns: true,
    });

    expect(result.ok).toBe(false);
    expect(cancelled).toBe(true);
  });

  it('still reads a well-behaved body inside the deadline', async () => {
    // The guard must not turn a slow-but-finishing feed into a timeout.
    const result = await safeFetch('https://example.org/slow-but-ok', {
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(ctrl) {
              ctrl.enqueue(new TextEncoder().encode('<rss>'));
              await new Promise((r) => setTimeout(r, 20));
              ctrl.enqueue(new TextEncoder().encode('</rss>'));
              ctrl.close();
            },
          }),
          { status: 200 },
        ),
      resolve: openResolver,
      requireDns: true,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toBe('<rss></rss>');
  });

  it('reports a transport failure as a network error with no detail leak', async () => {
    const result = await safeFetch('https://example.org/down', {
      fetchImpl: async () => {
        throw new TypeError('getaddrinfo ENOTFOUND secret-internal-host');
      },
      resolve: openResolver,
      requireDns: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === 'network_error') {
      expect(result.detail).toBe('TypeError');
      expect(JSON.stringify(result)).not.toContain('secret-internal-host');
    }
  });

  it('reports a non-2xx status', async () => {
    const result = await safeFetch('https://example.org/gone', {
      fetchImpl: async () => new Response('', { status: 503 }),
      resolve: openResolver,
      requireDns: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === 'http_error') expect(result.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Decoding and sniffing
// ---------------------------------------------------------------------------

describe('decodeBody', () => {
  it('honours the HTTP charset', () => {
    // 'ü' is 0xFC in ISO-8859-9, which is not valid UTF-8.
    const bytes = new Uint8Array([0x54, 0xfc, 0x72]);
    expect(decodeBody(bytes, 'text/xml; charset=ISO-8859-9')).toBe('Tür');
  });

  it('falls back to the XML declaration', () => {
    const head = '<?xml version="1.0" encoding="ISO-8859-9"?><rss>';
    const bytes = new Uint8Array([
      ...new TextEncoder().encode(head),
      0xfc,
    ]);
    expect(decodeBody(bytes, null).endsWith('ü')).toBe(true);
  });

  it('defaults to UTF-8 and survives an unknown label', () => {
    const bytes = new TextEncoder().encode('Türkçe');
    expect(decodeBody(bytes, null)).toBe('Türkçe');
    expect(decodeBody(bytes, 'text/xml; charset=x-made-up')).toBe('Türkçe');
  });
});

describe('looksLikeXmlFeed', () => {
  it('accepts feed content types and sniffs bodies', () => {
    expect(looksLikeXmlFeed('', 'application/rss+xml')).toBe(true);
    expect(looksLikeXmlFeed('', 'application/atom+xml; charset=utf-8')).toBe(true);
    expect(looksLikeXmlFeed('', 'text/xml')).toBe(true);
    expect(looksLikeXmlFeed('<?xml version="1.0"?><rss>', 'text/plain')).toBe(true);
    expect(looksLikeXmlFeed('<feed xmlns="...">', null)).toBe(true);
  });

  it('rejects an HTML page', () => {
    expect(looksLikeXmlFeed('<!doctype html><html>', 'text/html')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Canonicalisation
// ---------------------------------------------------------------------------

describe('canonicalizeUrl', () => {
  it('drops the fragment, the default port and tracking parameters', () => {
    expect(canonicalizeUrl('https://Example.ORG:443/a/b?utm_source=x#frag')).toBe(
      'https://example.org/a/b',
    );
  });

  it('keeps meaningful query parameters in order', () => {
    expect(canonicalizeUrl('https://example.org/a?b=2&a=1&fbclid=zz')).toBe(
      'https://example.org/a?b=2&a=1',
    );
  });

  it('preserves the trailing slash, because sites disagree about it', () => {
    expect(canonicalizeUrl('https://techcrunch.com/category/ai/feed/')).toBe(
      'https://techcrunch.com/category/ai/feed/',
    );
    expect(canonicalizeUrl('https://rss.arxiv.org/rss/cs.AI')).toBe(
      'https://rss.arxiv.org/rss/cs.AI',
    );
  });

  it('strips every documented tracking parameter', () => {
    const query = TRACKING_PARAMS.map((p) => `${p}=x`).join('&');
    expect(canonicalizeUrl(`https://example.org/a?${query}&keep=1`)).toBe(
      'https://example.org/a?keep=1',
    );
  });

  it('throws rather than silently truncating an over-long URL', () => {
    expect(() => canonicalizeUrl(`https://example.org/${'a'.repeat(2100)}`)).toThrow();
  });
});
