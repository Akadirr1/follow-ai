/**
 * The `sync-feeds` run, exercised entirely through injected dependencies.
 *
 * The property under test is the one arch-001 §2 states and no amount of
 * reading can confirm: "One malformed source/item cannot roll back other
 * sources/items." Here that means a source whose fetch fails, whose feed does
 * not parse, or whose upsert throws must not stop the others — and must still
 * be recorded with a backoff.
 */
import {
  ingestOneSource,
  mapWithConcurrency,
  runIngestion,
  SUCCESS_INTERVAL_SECONDS,
  toArticleRows,
  type FeedFetchOutcome,
  type IngestDeps,
} from '../functions/_shared/ingest.ts';
import { contentHashHex, urlHashHex } from '../functions/_shared/hash.ts';
import { parseFeed } from '../functions/_shared/feed.ts';
import type { LeasedSource } from '../functions/_shared/supabase-admin.ts';
import { RSS_OPENAI, RSS_WEBRAZZI } from './fixtures/feeds.ts';

const NOW = new Date('2026-08-21T12:00:00Z');

function source(overrides: Partial<LeasedSource> = {}): LeasedSource {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'openai-blog',
    name: 'OpenAI Blog',
    feed_url: 'https://openai.com/news/rss.xml',
    site_url: 'https://openai.com/news',
    language: 'en',
    category: 'Modeller',
    status: 'active',
    etag: null,
    last_modified: null,
    next_fetch_at: NOW.toISOString(),
    consecutive_failures: 0,
    ...overrides,
  };
}

type GatewayCall = { fn: string; args: unknown };

function fakeGateway(
  options: {
    sources?: LeasedSource[];
    upsert?: (sourceId: string) => Promise<unknown>;
    failStateWriteFor?: string;
  } = {},
) {
  const calls: GatewayCall[] = [];
  const gateway = {
    async leaseDueSources(n: number) {
      calls.push({ fn: 'leaseDueSources', args: n });
      return options.sources ?? [];
    },
    async leaseSource(sourceId: string) {
      calls.push({ fn: 'leaseSource', args: sourceId });
      return (options.sources ?? []).filter((s) => s.id === sourceId);
    },
    async startIngestionRun(trigger: string) {
      calls.push({ fn: 'startIngestionRun', args: trigger });
      return 'run-0001';
    },
    async finishIngestionRun(runId: string, counts: unknown, errorSummary: string | null) {
      calls.push({ fn: 'finishIngestionRun', args: { runId, counts, errorSummary } });
    },
    async upsertArticles(sourceId: string, rows: unknown[]) {
      calls.push({ fn: 'upsertArticles', args: { sourceId, count: rows.length } });
      if (options.upsert) return (await options.upsert(sourceId)) as never;
      return { inserted: rows.length, updated: 0, unchanged: 0, failed: 0, error_codes: [] };
    },
    async updateSourceFetchState(sourceId: string, outcome: unknown) {
      calls.push({ fn: 'updateSourceFetchState', args: { sourceId, outcome } });
      if (options.failStateWriteFor === sourceId) throw new Error('state write failed');
    },
    async bumpRateLimit() {
      return true;
    },
    async upsertSource() {
      throw new Error('not used here');
    },
  };
  return { gateway: gateway as unknown as IngestDeps['gateway'], calls };
}

function deps(
  gateway: IngestDeps['gateway'],
  fetchFeed: IngestDeps['fetchFeed'],
): IngestDeps {
  return { gateway, fetchFeed, now: () => NOW, random: () => 0 };
}

const okFetch = (body: string): FeedFetchOutcome => ({
  kind: 'ok',
  body,
  finalUrl: 'https://openai.com/news/rss.xml',
  etag: 'W/"v1"',
  lastModified: 'Wed, 20 Aug 2026 15:04:05 GMT',
});

describe('toArticleRows', () => {
  it('derives the hashes the database uses as keys', async () => {
    const feed = parseFeed(RSS_OPENAI, 'https://openai.com/news/rss.xml', { now: NOW })!;
    const rows = await toArticleRows(feed.items, { language: 'en', category: 'Modeller' });

    expect(rows).toHaveLength(2);
    expect(rows[0].url_hash).toBe(await urlHashHex(rows[0].canonical_url));
    expect(rows[0].content_hash).toBe(
      await contentHashHex(rows[0].title, rows[0].content_text),
    );
    // 32-byte bytea, per P2's octet_length checks.
    expect(rows[0].url_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('inherits language and category from the source', async () => {
    const feed = parseFeed(RSS_WEBRAZZI, 'https://webrazzi.com/kategori/yapay-zeka/feed/', {
      now: NOW,
    })!;
    const rows = await toArticleRows(feed.items, { language: 'tr', category: 'Türkiye' });
    expect(rows[0].language).toBe('tr');
    expect(rows[0].category).toBe('Türkiye');
    expect(rows[0].content_quality).toBe('full');
  });

  it('changes content_hash when the title changes, so a stale summary is invalidated', async () => {
    const before = await contentHashHex('Old headline', 'Body');
    const after = await contentHashHex('New headline', 'Body');
    expect(after).not.toBe(before);
  });

  it('ignores whitespace-only reformatting, so no pointless AI call is queued', async () => {
    const flat = await contentHashHex('Title', 'one two three');
    const indented = await contentHashHex('  Title  ', '\n  one   two\n  three\n');
    expect(indented).toBe(flat);
  });

  it('drops a non-https link rather than letting the insert fail', async () => {
    const rows = await toArticleRows(
      [
        {
          externalId: 'a',
          canonicalUrl: 'http://insecure.example.org/x',
          title: 't',
          author: null,
          publishedAt: NOW.toISOString(),
          contentText: 'c',
          excerpt: 'c',
          quality: 'excerpt',
        },
      ],
      { language: 'en', category: 'Modeller' },
    );
    expect(rows).toEqual([]);
  });
});

describe('ingestOneSource', () => {
  it('records success, the new validators and the 15-minute cadence', async () => {
    const { gateway, calls } = fakeGateway();
    const outcome = await ingestOneSource(
      deps(gateway, async () => okFetch(RSS_OPENAI)),
      source(),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.code).toBe('ok');
    expect(outcome.inserted).toBe(2);

    const state = calls.find((c) => c.fn === 'updateSourceFetchState')!.args as {
      outcome: Record<string, unknown>;
    };
    expect(state.outcome).toEqual({
      ok: true,
      etag: 'W/"v1"',
      lastModified: 'Wed, 20 Aug 2026 15:04:05 GMT',
      nextFetchAt: new Date(NOW.getTime() + SUCCESS_INTERVAL_SECONDS * 1000).toISOString(),
      errorCode: null,
    });
  });

  it('writes nothing at all for 304 Not Modified', async () => {
    const { gateway, calls } = fakeGateway();
    const outcome = await ingestOneSource(
      deps(gateway, async () => ({ kind: 'not_modified', etag: 'W/"v1"', lastModified: null })),
      source(),
    );

    expect(outcome).toMatchObject({ ok: true, code: 'not_modified', inserted: 0 });
    expect(calls.map((c) => c.fn)).toEqual(['updateSourceFetchState']);
    expect(calls.some((c) => c.fn === 'upsertArticles')).toBe(false);
  });

  it('keeps the previous validators when a 304 carries none', async () => {
    const { gateway, calls } = fakeGateway();
    await ingestOneSource(
      deps(gateway, async () => ({ kind: 'not_modified', etag: null, lastModified: null })),
      source({ etag: 'W/"old"', last_modified: 'Mon, 18 Aug 2026 00:00:00 GMT' }),
    );
    const state = calls[0].args as { outcome: Record<string, unknown> };
    expect(state.outcome.etag).toBe('W/"old"');
    expect(state.outcome.lastModified).toBe('Mon, 18 Aug 2026 00:00:00 GMT');
  });

  it('backs a failing source off instead of retrying it every cycle', async () => {
    const { gateway, calls } = fakeGateway();
    const outcome = await ingestOneSource(
      deps(gateway, async () => ({ kind: 'error', code: 'http_503' })),
      source({ consecutive_failures: 3 }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('http_503');
    const state = calls[0].args as { outcome: Record<string, unknown> };
    expect(state.outcome.ok).toBe(false);
    expect(state.outcome.errorCode).toBe('http_503');
    // attempt 4, random() === 0 → exactly one base interval ahead.
    expect(state.outcome.nextFetchAt).toBe(
      new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
    );
  });

  it('reports an unparseable body as parse_failed without throwing', async () => {
    const { gateway } = fakeGateway();
    const outcome = await ingestOneSource(
      deps(gateway, async () => okFetch('this is not a feed')),
      source(),
    );
    expect(outcome).toMatchObject({ ok: false, code: 'parse_failed' });
  });

  it('never throws, even when the database rejects the batch', async () => {
    const { gateway } = fakeGateway({
      upsert: async () => {
        throw new Error('upsert exploded');
      },
    });
    const outcome = await ingestOneSource(
      deps(gateway, async () => okFetch(RSS_OPENAI)),
      source(),
    );
    expect(outcome.ok).toBe(false);
  });

  it('never throws, even when recording the failure also fails', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const { gateway } = fakeGateway({ failStateWriteFor: id });
    const outcome = await ingestOneSource(
      deps(gateway, async () => ({ kind: 'error', code: 'timeout' })),
      source({ id }),
    );
    expect(outcome).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('passes through the per-item failure count the database reports', async () => {
    const { gateway } = fakeGateway({
      upsert: async () => ({
        inserted: 1,
        updated: 0,
        unchanged: 0,
        failed: 1,
        error_codes: ['23505'],
      }),
    });
    const outcome = await ingestOneSource(
      deps(gateway, async () => okFetch(RSS_OPENAI)),
      source(),
    );
    expect(outcome).toMatchObject({ ok: true, inserted: 1, failedItems: 1 });
  });
});

describe('runIngestion', () => {
  const good = source({ id: '11111111-1111-4111-8111-111111111111', slug: 'good' });
  const broken = source({ id: '22222222-2222-4222-8222-222222222222', slug: 'broken' });
  const alsoGood = source({ id: '33333333-3333-4333-8333-333333333333', slug: 'also-good' });

  it('lets the other sources finish when one fails', async () => {
    const { gateway, calls } = fakeGateway({ sources: [good, broken, alsoGood] });
    const result = await runIngestion(
      deps(gateway, async (s) =>
        s.slug === 'broken'
          ? { kind: 'error', code: 'http_500' }
          : okFetch(RSS_OPENAI),
      ),
      { trigger: 'cron' },
    );

    expect(result.sources_ok).toBe(2);
    expect(result.sources_failed).toBe(1);
    expect(result.inserted).toBe(4);
    expect(result.outcomes.map((o) => o.slug)).toEqual(['good', 'broken', 'also-good']);

    const finish = calls.find((c) => c.fn === 'finishIngestionRun')!.args as {
      errorSummary: string | null;
    };
    expect(finish.errorSummary).toBe('broken=http_500');
  });

  it('keeps URLs and upstream text out of the recorded error summary', async () => {
    const { gateway, calls } = fakeGateway({ sources: [broken] });
    await runIngestion(
      deps(gateway, async () => ({ kind: 'error', code: 'unsafe_url_blocked_address' })),
      { trigger: 'cron' },
    );
    const finish = calls.find((c) => c.fn === 'finishIngestionRun')!.args as {
      errorSummary: string;
    };
    expect(finish.errorSummary).toBe('broken=unsafe_url_blocked_address');
    expect(finish.errorSummary).not.toContain('https://');
  });

  it('opens no run at all when nothing is due', async () => {
    const { gateway, calls } = fakeGateway({ sources: [] });
    const result = await runIngestion(
      deps(gateway, async () => okFetch(RSS_OPENAI)),
      { trigger: 'cron' },
    );
    expect(result).toMatchObject({ run_id: null, sources_ok: 0, sources_failed: 0 });
    expect(calls.some((c) => c.fn === 'startIngestionRun')).toBe(false);
  });

  it('clamps max_sources to the documented bounds', async () => {
    for (const [requested, expected] of [
      [undefined, 10],
      [1, 1],
      [20, 20],
      [999, 20],
      [0, 1],
    ] as [number | undefined, number][]) {
      const { gateway, calls } = fakeGateway({ sources: [] });
      await runIngestion(deps(gateway, async () => okFetch(RSS_OPENAI)), {
        trigger: 'cron',
        maxSources: requested,
      });
      expect(calls[0]).toEqual({ fn: 'leaseDueSources', args: expected });
    }
  });

  it('uses the targeted lease when a source_id is given', async () => {
    const { gateway, calls } = fakeGateway({ sources: [good] });
    const result = await runIngestion(
      deps(gateway, async () => okFetch(RSS_OPENAI)),
      { trigger: 'manual', sourceId: good.id },
    );
    expect(calls[0]).toEqual({ fn: 'leaseSource', args: good.id });
    expect(result.sources_ok).toBe(1);
  });

  it('does not lose committed work when closing the run fails', async () => {
    const { gateway } = fakeGateway({ sources: [good] });
    const broken_gateway = {
      ...(gateway as unknown as Record<string, unknown>),
      finishIngestionRun: async () => {
        throw new Error('run row write failed');
      },
    } as unknown as IngestDeps['gateway'];

    const result = await runIngestion(
      deps(broken_gateway, async () => okFetch(RSS_OPENAI)),
      { trigger: 'cron' },
    );
    expect(result.sources_ok).toBe(1);
    expect(result.inserted).toBe(2);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const result = await mapWithConcurrency([30, 10, 20, 0], 2, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `${i}:${ms}`;
    });
    expect(result).toEqual(['0:30', '1:10', '2:20', '3:0']);
  });

  it('never runs more than the allowed number at once', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([...Array(12).keys()], 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});
