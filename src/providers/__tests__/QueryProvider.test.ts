import { persistQueryClient } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient } from '@tanstack/react-query';

import { KV_KEYS, type KvStore } from '../../storage/kv';
import { queryKeys } from '../../data-access/queryKeys';
import {
  CACHE_BUSTER,
  MAX_CACHE_AGE_MS,
  MAX_PERSISTED_FEED_ARTICLES,
  QUERY_KEY_VERSION,
  asyncStorageFromKv,
  capPersistedFeed,
  createQueryClient,
  shouldDehydrateQuery,
} from '../QueryProvider';

/**
 * The persistence contract, exercised against a real `QueryClient` and a fake kv
 * store. What matters is that a restored cache is available to a query *before*
 * it fetches — that is what makes an offline launch render the last feed instead
 * of an empty screen.
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

const persisterFor = (storage: KvStore) =>
  createAsyncStoragePersister({
    storage: asyncStorageFromKv(storage),
    key: KV_KEYS.queryCache,
    throttleTime: 0,
  });

describe('query keys', () => {
  it('all start with the version segment, which is what gets persisted', () => {
    for (const key of [
      queryKeys.feed(),
      queryKeys.article('a'),
      queryKeys.search('q'),
      queryKeys.sources(),
      queryKeys.digest(),
      queryKeys.enrichment('a'),
    ]) {
      expect(key[0]).toBe(QUERY_KEY_VERSION);
      expect(shouldDehydrateQuery(key)).toBe(true);
    }
    expect(shouldDehydrateQuery(['something-else'])).toBe(false);
  });

  it('normalises a filter so two equivalent ones share a cache entry', () => {
    expect(queryKeys.feed({ sourceIds: ['b', 'a'] })).toEqual(
      queryKeys.feed({ sourceIds: ['a', 'b'] }),
    );
    expect(queryKeys.feed({ category: null })).toEqual(queryKeys.feed());
    expect(queryKeys.feed({ category: 'Modeller' })).not.toEqual(queryKeys.feed());
  });

  it('lower-cases and trims a search key', () => {
    expect(queryKeys.search('  OpenAI ')).toEqual(queryKeys.search('openai'));
  });
});

describe('persisted cache', () => {
  /**
   * Every client made here is cleared afterwards: `gcTime` is seven days, so a
   * live QueryClient keeps garbage-collection timers pending and Jest will not
   * exit while they are outstanding.
   */
  const clients: QueryClient[] = [];
  const track = (client: QueryClient) => {
    clients.push(client);
    return client;
  };

  afterEach(() => {
    for (const client of clients.splice(0)) client.clear();
  });

  it('writes a successful query to storage and restores it into a fresh client', async () => {
    const storage = fakeKv();
    const client = track(createQueryClient());
    client.setQueryData(queryKeys.article('a1'), { id: 'a1', title: 'cached' });

    const [unsubscribe, restored] = persistQueryClient({
      queryClient: client,
      persister: persisterFor(storage),
      maxAge: MAX_CACHE_AGE_MS,
      buster: CACHE_BUSTER,
    });
    await restored;
    // Force a write, then tear down the subscription.
    client.setQueryData(queryKeys.article('a1'), { id: 'a1', title: 'cached' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    unsubscribe();

    expect(storage.data.has(KV_KEYS.queryCache)).toBe(true);

    const fresh = track(new QueryClient());
    const [unsubscribe2, restored2] = persistQueryClient({
      queryClient: fresh,
      persister: persisterFor(storage),
      maxAge: MAX_CACHE_AGE_MS,
      buster: CACHE_BUSTER,
    });
    await restored2;
    unsubscribe2();

    // Restored before any fetch could run: the data is already there.
    expect(fresh.getQueryData(queryKeys.article('a1'))).toEqual({ id: 'a1', title: 'cached' });
  });

  it('discards a cache written under a different buster', async () => {
    const storage = fakeKv();
    const client = track(createQueryClient());
    client.setQueryData(queryKeys.article('a1'), { id: 'a1' });
    const [unsubscribe, restored] = persistQueryClient({
      queryClient: client,
      persister: persisterFor(storage),
      maxAge: MAX_CACHE_AGE_MS,
      buster: 'old-buster',
    });
    await restored;
    client.setQueryData(queryKeys.article('a1'), { id: 'a1' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    unsubscribe();

    const fresh = track(new QueryClient());
    const [unsubscribe2, restored2] = persistQueryClient({
      queryClient: fresh,
      persister: persisterFor(storage),
      maxAge: MAX_CACHE_AGE_MS,
      buster: CACHE_BUSTER,
    });
    await restored2;
    unsubscribe2();

    expect(fresh.getQueryData(queryKeys.article('a1'))).toBeUndefined();
  });

  it('keeps the cache for seven days', () => {
    expect(MAX_CACHE_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('includes the repository contract version in the buster', () => {
    expect(CACHE_BUSTER).toContain('repo1');
  });
});

describe('feed cap', () => {
  const page = (n: number) => ({ data: { items: Array.from({ length: n }, (_, i) => ({ id: i })) } });

  it('keeps pages up to the article cap', () => {
    const data = { pages: [page(50), page(50)], pageParams: [null, 'c1'] };
    expect(capPersistedFeed(data)).toBe(data);
  });

  it('drops the pages past the cap, with their page params', () => {
    const pages = Array.from({ length: 6 }, () => page(50)); // 300 articles
    const capped = capPersistedFeed({ pages, pageParams: pages.map((_, i) => `c${i}`) }) as {
      pages: unknown[];
      pageParams: unknown[];
    };
    expect(capped.pages.length).toBeLessThan(pages.length);
    const kept = capped.pages.length * 50;
    expect(kept).toBeLessThanOrEqual(MAX_PERSISTED_FEED_ARTICLES);
    expect(capped.pageParams).toHaveLength(capped.pages.length);
  });

  it('leaves anything that is not an infinite-query blob alone', () => {
    expect(capPersistedFeed({ id: 'a1' })).toEqual({ id: 'a1' });
    expect(capPersistedFeed(null)).toBeNull();
  });
});
