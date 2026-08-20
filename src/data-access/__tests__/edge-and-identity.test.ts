import { generateDeviceId, getDeviceId, isDeviceId, resetDeviceIdCache } from '../../identity/deviceId';
import { KV_KEYS, type KvStore } from '../../storage/kv';
import { createSupabaseEnrichmentRepository, createSupabaseSourceRepository } from '../supabase/repositories';

/**
 * Edge calls and device identity, driven through an injected `fetch` so nothing
 * here touches the network. The assertions are about the *request* — headers,
 * body, idempotency key — and about how each response shape becomes a `Result`.
 */

function fakeKv(initial: Record<string, string> = {}): KvStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async getItem(key) {
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    },
  };
}

type Captured = { url: string; init: RequestInit };

function fakeFetch(responses: { status: number; body?: unknown }[]) {
  const captured: Captured[] = [];
  const queue = [...responses];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    const next = queue.shift() ?? { status: 200, body: {} };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (next.body === undefined ? '' : JSON.stringify(next.body)),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, captured };
}

/**
 * `env` is frozen by design (P1), so tests inject the project config through the
 * same `EdgeCallOptions` seam that carries `fetchImpl` instead of mutating it.
 */
const TEST_CONFIG = {
  supabaseUrl: 'https://project.supabase.co',
  supabaseAnonKey: 'anon.jwt.value',
};
const withSupabaseEnv = <T>(run: () => T): T => run();

describe('device identity', () => {
  beforeEach(() => resetDeviceIdCache());

  it('generates a syntactically valid uuid v4', () => {
    const id = generateDeviceId();
    expect(isDeviceId(id)).toBe(true);
    expect(id).not.toBe(generateDeviceId());
  });

  it.each(['', 'not-a-uuid', '11111111-1111-1111-1111-111111111111'])(
    'rejects %p as a device id',
    (value) => {
      expect(isDeviceId(value)).toBe(false);
    },
  );

  it('generates once and reuses it, writing exactly one value', async () => {
    const storage = fakeKv();
    const first = await getDeviceId(storage);
    const second = await getDeviceId(storage);
    expect(first).toBe(second);
    expect(storage.data.get(KV_KEYS.deviceId)).toBe(first);
    expect(storage.data.size).toBe(1);
  });

  it('reuses the stored id across a cold start', async () => {
    const storage = fakeKv();
    const first = await getDeviceId(storage);
    resetDeviceIdCache();
    expect(await getDeviceId(storage)).toBe(first);
  });

  it('does not mint two ids when two callers race on first run', async () => {
    const storage = fakeKv();
    const [a, b] = await Promise.all([getDeviceId(storage), getDeviceId(storage)]);
    expect(a).toBe(b);
    expect(storage.data.size).toBe(1);
  });

  it('warns and regenerates when the stored value is not a uuid', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = fakeKv({ [KV_KEYS.deviceId]: 'garbage' });
      const id = await getDeviceId(storage);
      expect(isDeviceId(id)).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('garbage'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('add-source Edge call', () => {
  beforeEach(() => resetDeviceIdCache());

  it('sends the device id and the anon JWT as apikey and bearer', async () => {
    await withSupabaseEnv(async () => {
      const { impl, captured } = fakeFetch([
        {
          status: 201,
          body: {
            source: {
              id: 's1',
              slug: 'example',
              name: 'Example',
              feed_url: 'https://example.com/feed.xml',
              site_url: null,
              language: 'en',
              category: 'Ürün',
              is_default: false,
              status: 'active',
            },
          },
        },
      ]);
      const repo = createSupabaseSourceRepository({} as never, { fetchImpl: impl, config: TEST_CONFIG });
      const result = await repo.addSourceByUrl('https://example.com/feed.xml');

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.id).toBe('s1');

      const headers = captured[0].init.headers as Record<string, string>;
      expect(captured[0].url).toBe('https://project.supabase.co/functions/v1/add-source');
      expect(headers.apikey).toBe('anon.jwt.value');
      expect(headers.Authorization).toBe('Bearer anon.jwt.value');
      expect(isDeviceId(headers['X-Device-Id'])).toBe(true);

      const body = JSON.parse(String(captured[0].init.body)) as Record<string, string>;
      expect(body.url).toBe('https://example.com/feed.xml');
      // An idempotency key so a retry cannot create the source twice.
      expect(typeof body.client_request_id).toBe('string');
      expect(body.client_request_id.length).toBeGreaterThan(4);
    });
  });

  it('maps the server error envelope onto a typed DataError', async () => {
    await withSupabaseEnv(async () => {
      const { impl } = fakeFetch([
        {
          status: 409,
          body: {
            error: {
              code: 'duplicate_source',
              message: 'already in the catalog',
              retryable: false,
              request_id: 'req-1',
            },
          },
        },
      ]);
      const repo = createSupabaseSourceRepository({} as never, { fetchImpl: impl, config: TEST_CONFIG });
      const result = await repo.addSourceByUrl('https://example.com/feed.xml');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('duplicate_source');
        expect(result.error.retryable).toBe(false);
        expect(result.error.details).toEqual({ status: 409, serverCode: 'duplicate_source', requestId: 'req-1' });
      }
    });
  });

  it('says the function is not deployed on a 404 rather than surfacing a bare error', async () => {
    await withSupabaseEnv(async () => {
      const { impl } = fakeFetch([{ status: 404, body: { code: 'NOT_FOUND' } }]);
      const repo = createSupabaseSourceRepository({} as never, { fetchImpl: impl, config: TEST_CONFIG });
      const result = await repo.addSourceByUrl('https://example.com/feed.xml');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('not_implemented');
        expect(result.error.message).toContain('not deployed');
      }
    });
  });

  it('rejects a non-https URL before spending a request', async () => {
    await withSupabaseEnv(async () => {
      const { impl, captured } = fakeFetch([]);
      const repo = createSupabaseSourceRepository({} as never, { fetchImpl: impl, config: TEST_CONFIG });
      const result = await repo.addSourceByUrl('http://example.com/feed.xml');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('unsupported_source');
      expect(captured).toHaveLength(0);
    });
  });

  it('returns a retryable network error when fetch itself fails', async () => {
    await withSupabaseEnv(async () => {
      const impl = (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch;
      const repo = createSupabaseSourceRepository({} as never, { fetchImpl: impl, config: TEST_CONFIG });
      const result = await repo.addSourceByUrl('https://example.com/feed.xml');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('network');
        expect(result.error.retryable).toBe(true);
      }
    });
  });
});

describe('request-enrichment Edge call', () => {
  beforeEach(() => resetDeviceIdCache());

  it('maps 202 no_api_key to queued — the normal v1 path', async () => {
    await withSupabaseEnv(async () => {
      const { impl, captured } = fakeFetch([
        { status: 202, body: { status: 'queued', reason: 'no_api_key', poll_after_seconds: 30 } },
      ]);
      const repo = createSupabaseEnrichmentRepository({ fetchImpl: impl, config: TEST_CONFIG });
      const result = await repo.requestEnrichment('a1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.status).toBe('queued');
        if (result.data.status === 'queued') expect(result.data.reason).toBe('no_api_key');
      }
      expect(captured[0].url).toContain('/functions/v1/request-enrichment');
      expect(JSON.parse(String(captured[0].init.body)).article_id).toBe('a1');
    });
  });

  it('maps a 200 ready body to a summary DTO', async () => {
    await withSupabaseEnv(async () => {
      const { impl } = fakeFetch([
        {
          status: 200,
          body: {
            status: 'ready',
            summary: {
              bullets: ['bir', 'iki', 'üç'],
              translation_tr: 'Türkçe',
              translation_state: 'ready',
            },
          },
        },
      ]);
      const repo = createSupabaseEnrichmentRepository({ fetchImpl: impl, config: TEST_CONFIG });
      const result = await repo.requestEnrichment('a1');
      if (!result.ok || result.data.status !== 'ready') throw new Error('expected ready');
      expect(result.data.summary.bullets).toEqual(['bir', 'iki', 'üç']);
      expect(result.data.summary.translationTr).toBe('Türkçe');
    });
  });

  it('drops the translation when the server says not_required', async () => {
    await withSupabaseEnv(async () => {
      const { impl } = fakeFetch([
        {
          status: 200,
          body: {
            status: 'ready',
            summary: { bullets: ['a', 'b', 'c'], translation_tr: 'ignored', translation_state: 'not_required' },
          },
        },
      ]);
      const repo = createSupabaseEnrichmentRepository({ fetchImpl: impl, config: TEST_CONFIG });
      const result = await repo.requestEnrichment('a1');
      if (!result.ok || result.data.status !== 'ready') throw new Error('expected ready');
      expect(result.data.summary.translationState).toBe('not_required');
      expect(result.data.summary.translationTr).toBeNull();
    });
  });

  it('warns and treats an unrecognised body as queued rather than inventing a summary', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await withSupabaseEnv(async () => {
        const { impl } = fakeFetch([{ status: 200, body: { status: 'something-else' } }]);
        const repo = createSupabaseEnrichmentRepository({ fetchImpl: impl, config: TEST_CONFIG });
        const result = await repo.requestEnrichment('a1');
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.data.status).toBe('queued');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('unrecognised body'));
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects a blank article id without a request', async () => {
    await withSupabaseEnv(async () => {
      const { impl, captured } = fakeFetch([]);
      const repo = createSupabaseEnrichmentRepository({ fetchImpl: impl, config: TEST_CONFIG });
      const result = await repo.requestEnrichment('   ');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_input');
      expect(captured).toHaveLength(0);
    });
  });
});
