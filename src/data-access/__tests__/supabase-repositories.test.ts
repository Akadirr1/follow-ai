import { decodeCursor, encodeCursor, cursorOf, keysetFilter } from '../cursor';
import {
  createSupabaseDigestRepository,
  createSupabaseFeedRepository,
  createSupabaseSourceRepository,
  DIGESTS_VIEW,
  DIGEST_ITEMS_VIEW,
  SOURCES_VIEW,
} from '../supabase/repositories';
import { FEED_VIEW, SEARCH_RPC, toDataError } from '../supabase/client';
import { toArticle, type FeedArticleRow } from '../supabase/mapper';

/**
 * A fake `SupabaseClient` that records the query it was asked to build and
 * returns canned rows. It reproduces the fluent builder's shape only — enough to
 * assert the *call* (table, columns, filters, order, limit), which is the part
 * this layer is responsible for.
 */
type Call = {
  table: string;
  select?: string;
  filters: { op: string; args: unknown[] }[];
  orders: { column: string; ascending?: boolean }[];
  limit?: number;
};

function fakeClient(responses: { data?: unknown; error?: unknown }[] | { data?: unknown; error?: unknown }) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: Call[] = [];
  const rpcCalls: { name: string; params: unknown }[] = [];

  const makeBuilder = (call: Call) => {
    const result = queue.shift() ?? { data: [] };
    const builder: Record<string, unknown> = {
      select(columns: string) {
        call.select = columns;
        return builder;
      },
      order(column: string, options?: { ascending?: boolean }) {
        call.orders.push({ column, ascending: options?.ascending });
        return builder;
      },
      limit(n: number) {
        call.limit = n;
        return builder;
      },
      in(column: string, values: unknown[]) {
        call.filters.push({ op: 'in', args: [column, values] });
        return builder;
      },
      eq(column: string, value: unknown) {
        call.filters.push({ op: 'eq', args: [column, value] });
        return builder;
      },
      or(filter: string) {
        call.filters.push({ op: 'or', args: [filter] });
        return builder;
      },
      // Awaiting the builder runs the query.
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve(result).then(resolve);
      },
    };
    return builder;
  };

  return {
    calls,
    rpcCalls,
    client: {
      from(table: string) {
        const call: Call = { table, filters: [], orders: [] };
        calls.push(call);
        return makeBuilder(call);
      },
      rpc(name: string, params: unknown) {
        rpcCalls.push({ name, params });
        const result = queue.shift() ?? { data: [] };
        return Promise.resolve(result);
      },
    } as never,
  };
}

const row = (over: Partial<FeedArticleRow> = {}): FeedArticleRow => ({
  article_id: '11111111-1111-4111-8111-111111111111',
  source_id: '22222222-2222-4222-8222-222222222222',
  source_slug: 'openai-blog',
  source_name: 'OpenAI Blog',
  source_site_url: 'https://openai.com/news',
  category: 'Modeller',
  title: 'GPT-5.2',
  author: null,
  canonical_url: 'https://openai.com/news/gpt-5-2',
  published_at: '2026-08-20T06:41:00.000Z',
  fetched_at: '2026-08-20T07:00:00.000Z',
  language: 'en',
  excerpt: 'excerpt',
  content_text: 'full text',
  content_quality: 'ok',
  summary_tr: ['bir', 'iki', 'üç'],
  translation_tr: 'Türkçe gövde',
  translation_state: 'ready',
  summary_model: 'claude-opus-5',
  summary_generated_at: '2026-08-20T07:05:00.000Z',
  summary_ready: true,
  ...over,
});

describe('keyset cursor', () => {
  it('round-trips through encode/decode', () => {
    const cursor = cursorOf('2026-08-20T06:41:00.000Z', 'abc');
    const encoded = encodeCursor(cursor);
    expect(encoded).not.toContain('=');
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  it('warns and returns null for a value it did not write', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(decodeCursor('not-base64!!')).toBeNull();
      expect(decodeCursor(encodeCursor(cursorOf('x', 'y')).slice(0, 3))).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('builds a keyset filter that is strictly after the cursor', () => {
    const filter = keysetFilter(cursorOf('2026-08-20T06:41:00.000Z', 'abc'));
    expect(filter).toBe(
      'published_at.lt."2026-08-20T06:41:00.000Z",and(published_at.eq."2026-08-20T06:41:00.000Z",article_id.lt."abc")',
    );
  });
});

describe('feed repository', () => {
  it('queries the public shim view, ordered and limited for keyset paging', async () => {
    const { client, calls } = fakeClient({ data: [row()] });
    const result = await createSupabaseFeedRepository(client).listArticles({ limit: 2 });

    expect(result.ok).toBe(true);
    expect(calls[0].table).toBe(FEED_VIEW);
    expect(calls[0].orders).toEqual([
      { column: 'published_at', ascending: false },
      { column: 'article_id', ascending: false },
    ]);
    // limit+1: the extra row is how `hasMore` is known without a count query.
    expect(calls[0].limit).toBe(3);
  });

  it('reports the end of the list when fewer rows than the limit come back', async () => {
    const { client } = fakeClient({ data: [row()] });
    const result = await createSupabaseFeedRepository(client).listArticles({ limit: 2 });
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.hasMore).toBe(false);
    expect(result.data.nextCursor).toBeNull();
    expect(result.data.items).toHaveLength(1);
  });

  it('returns a cursor built from the last visible row when there is another page', async () => {
    const rows = [
      row({ article_id: 'a', published_at: '2026-08-20T10:00:00.000Z' }),
      row({ article_id: 'b', published_at: '2026-08-20T09:00:00.000Z' }),
      row({ article_id: 'c', published_at: '2026-08-20T08:00:00.000Z' }),
    ];
    const { client } = fakeClient({ data: rows });
    const result = await createSupabaseFeedRepository(client).listArticles({ limit: 2 });
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.items.map((a) => a.id)).toEqual(['a', 'b']);
    expect(result.data.hasMore).toBe(true);
    expect(result.data.nextCursor).toEqual({ publishedAt: '2026-08-20T09:00:00.000Z', id: 'b' });
  });

  it('applies the cursor, source and category filters', async () => {
    const { client, calls } = fakeClient({ data: [] });
    await createSupabaseFeedRepository(client).listArticles({
      cursor: cursorOf('2026-08-20T09:00:00.000Z', 'b'),
      sourceIds: ['s1', 's2'],
      category: 'Araştırma',
    });
    const ops = calls[0].filters.map((f) => f.op);
    expect(ops).toEqual(['in', 'eq', 'or']);
    expect(calls[0].filters[0].args).toEqual(['source_id', ['s1', 's2']]);
    expect(calls[0].filters[1].args).toEqual(['category', 'Araştırma']);
    expect(String(calls[0].filters[2].args[0])).toContain('published_at.lt.');
  });

  it('maps a PostgREST error to a typed DataError instead of throwing', async () => {
    const { client } = fakeClient({ error: { code: 'PGRST205', message: 'not in schema cache' } });
    const result = await createSupabaseFeedRepository(client).listArticles();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_implemented');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('returns not_found for an article id with no row', async () => {
    const { client } = fakeClient({ data: [] });
    const result = await createSupabaseFeedRepository(client).getArticle('missing');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('calls the search RPC with the documented argument names', async () => {
    const { client, rpcCalls } = fakeClient({ data: [row()] });
    const result = await createSupabaseFeedRepository(client).searchArticles({
      query: '  openai  ',
      limit: 5,
    });
    expect(result.ok).toBe(true);
    expect(rpcCalls[0].name).toBe(SEARCH_RPC);
    expect(rpcCalls[0].params).toEqual({ q: 'openai', source_ids: null, lim: 5 });
  });

  it('does not call the RPC for a blank query', async () => {
    const { client, rpcCalls } = fakeClient({ data: [] });
    const result = await createSupabaseFeedRepository(client).searchArticles({ query: '   ' });
    expect(result.ok).toBe(true);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('row → DTO mapping', () => {
  it('maps a ready English article, keeping the original body separate from the translation', () => {
    const article = toArticle(row());
    expect(article.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(article.tile).toBe('OP');
    expect(article.bodyOriginal).toBe('full text');
    expect(article.summary?.translationState).toBe('ready');
    expect(article.summary?.translationTr).toBe('Türkçe gövde');
    expect(article.summary?.bullets).toEqual(['bir', 'iki', 'üç']);
  });

  it('marks a Turkish article not_required with a null translation', () => {
    const article = toArticle(row({ language: 'tr', translation_state: 'not_required', translation_tr: null }));
    expect(article.language).toBe('tr');
    expect(article.summary?.translationState).toBe('not_required');
    expect(article.summary?.translationTr).toBeNull();
  });

  it('maps summary_ready=false to pending — the no-API-key state', () => {
    const article = toArticle(row({ summary_ready: false, summary_tr: null, translation_tr: null }));
    expect(article.summary?.translationState).toBe('pending');
    expect(article.summary?.translationTr).toBeNull();
    expect(article.summary?.bullets).toHaveLength(3);
  });

  it('falls back to the excerpt when there is no full text', () => {
    expect(toArticle(row({ content_text: null })).bodyOriginal).toBe('excerpt');
  });

  it('warns and pads a summary that does not have three bullets', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const article = toArticle(row({ summary_tr: ['tek'] }));
      expect(article.summary?.bullets).toEqual(['tek', '', '']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('expected 3'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('source repository', () => {
  it('lists active sources from the catalog shim, defaults first', async () => {
    const { client, calls } = fakeClient({
      data: [
        {
          id: 's1',
          slug: 'openai-blog',
          name: 'OpenAI Blog',
          feed_url: 'https://openai.com/news/rss.xml',
          site_url: 'https://openai.com/news',
          language: 'en',
          category: 'Modeller',
          is_default: true,
          status: 'active',
        },
      ],
    });
    const result = await createSupabaseSourceRepository(client).listSources();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls[0].table).toBe(SOURCES_VIEW);
    expect(calls[0].filters[0].args).toEqual(['status', 'active']);
    expect(calls[0].orders[0]).toEqual({ column: 'is_default', ascending: false });
    expect(result.data[0]).toEqual(
      expect.objectContaining({ id: 's1', isDefault: true, isActive: true, tile: 'OP' }),
    );
  });
});

describe('digest repository', () => {
  it('reports preparing when there is no ready digest', async () => {
    const { client } = fakeClient({ data: [] });
    const result = await createSupabaseDigestRepository(client).getLatestDigest();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe('preparing');
  });

  it('joins item blurbs to article titles from the feed view', async () => {
    const { client, calls } = fakeClient([
      {
        data: [
          {
            id: 'd1',
            digest_date: '2026-08-21',
            timezone: 'Europe/Istanbul',
            status: 'ready',
            headline: 'Bugünün AI Gündemi',
            window_start: null,
            window_end: null,
            generated_at: '2026-08-21T03:50:00.000Z',
          },
        ],
      },
      {
        data: [
          { digest_id: 'd1', position: 1, article_id: 'a1', blurb_tr: 'ilk', created_at: 'x' },
          { digest_id: 'd1', position: 2, article_id: 'a2', blurb_tr: 'ikinci', created_at: 'x' },
        ],
      },
      {
        data: [
          { article_id: 'a1', title: 'Birinci', source_name: 'OpenAI Blog', category: 'Modeller' },
          { article_id: 'a2', title: 'İkinci', source_name: 'Webrazzi', category: 'Türkiye' },
        ],
      },
    ]);

    const result = await createSupabaseDigestRepository(client).getLatestDigest();
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.status !== 'ready') throw new Error('expected a ready digest');

    expect(calls.map((c) => c.table)).toEqual([DIGESTS_VIEW, DIGEST_ITEMS_VIEW, FEED_VIEW]);
    expect(result.data.digest.preparedAt).toBe('2026-08-21T03:50:00.000Z');
    expect(result.data.digest.items).toEqual([
      { position: 1, articleId: 'a1', title: 'Birinci', blurb: 'ilk', sourceName: 'OpenAI Blog', category: 'Modeller' },
      { position: 2, articleId: 'a2', title: 'İkinci', blurb: 'ikinci', sourceName: 'Webrazzi', category: 'Türkiye' },
    ]);
  });

  it('keeps an item whose article is no longer readable, and warns', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { client } = fakeClient([
        {
          data: [
            {
              id: 'd1',
              digest_date: '2026-08-21',
              timezone: 'Europe/Istanbul',
              status: 'ready',
              headline: null,
              window_start: null,
              window_end: null,
              generated_at: null,
            },
          ],
        },
        { data: [{ digest_id: 'd1', position: 1, article_id: 'gone', blurb_tr: 'blurb', created_at: 'x' }] },
        { data: [] },
      ]);
      const result = await createSupabaseDigestRepository(client).getLatestDigest();
      if (!result.ok || result.data.status !== 'ready') throw new Error('expected a ready digest');
      expect(result.data.digest.items[0].title).toBe('');
      expect(result.data.digest.preparedAt).toBe('2026-08-21');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not in the feed view'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('toDataError', () => {
  it.each([
    ['PGRST205', 'not_implemented', false],
    ['PGRST106', 'not_implemented', false],
    ['PGRST116', 'not_found', false],
    ['42501', 'server', false],
    ['XX000', 'server', true],
  ])('maps %s to %s', (code, expected, retryable) => {
    const error = toDataError({ code, message: 'boom' }, 'ctx');
    expect(error.code).toBe(expected);
    expect(error.retryable).toBe(retryable);
  });
});
