import { env } from '../../config/env';
import { isDataErrorException } from '../../domain/errors';
import {
  getRepositories,
  REPOSITORY_CONTRACT_VERSION,
  resetRepositories,
} from '../index';
import { createMockRepositories } from '../mock';

describe('repository factory', () => {
  afterEach(() => resetRepositories());

  it('defaults to the validated env mode, which is mock in this checkout', () => {
    expect(env.dataMode).toBe('mock');
    const repos = getRepositories();
    expect(repos.mode).toBe('mock');
    expect(repos.version).toBe(REPOSITORY_CONTRACT_VERSION);
  });

  it('memoises the set for the ambient mode', () => {
    expect(getRepositories()).toBe(getRepositories());
    resetRepositories();
    expect(getRepositories()).not.toBe(createMockRepositories());
  });

  it('exposes all four repositories at the same contract version', () => {
    const repos = getRepositories('mock');
    for (const repo of [repos.feed, repos.sources, repos.digest, repos.enrichment]) {
      expect(repo.version).toBe(REPOSITORY_CONTRACT_VERSION);
    }
  });

  it('throws a typed not_implemented DataError for supabase mode', () => {
    expect(() => getRepositories('supabase')).toThrow();
    try {
      getRepositories('supabase');
      throw new Error('expected getRepositories("supabase") to throw');
    } catch (thrown) {
      expect(isDataErrorException(thrown)).toBe(true);
      if (isDataErrorException(thrown)) {
        expect(thrown.error.code).toBe('not_implemented');
        expect(thrown.error.retryable).toBe(false);
        expect(thrown.error.message).toContain('EXPO_PUBLIC_DATA_MODE');
      }
    }
  });
});

describe('mock source repository', () => {
  const repos = createMockRepositories();

  it('lists only active sources, and every active source has a feed URL', async () => {
    const result = await repos.sources.listSources();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Six defaults: Anthropic publishes no feed (measured 2026-08-21, addendum §D).
    expect(result.data).toHaveLength(6);
    expect(result.data.map((s) => s.id)).not.toContain('an');
    for (const source of result.data) {
      expect(source.feedUrl).toMatch(/^https:\/\//);
      expect(source.isActive).toBe(true);
      expect(['tr', 'en']).toContain(source.language);
    }
  });

  it('marks the Turkish source as tr and the rest as en', async () => {
    const result = await repos.sources.listSources();
    if (!result.ok) throw new Error('expected ok');
    const byId = Object.fromEntries(result.data.map((s) => [s.id, s]));
    expect(byId.wz.language).toBe('tr');
    expect(byId.oa.language).toBe('en');
  });

  it.each([
    ['', 'invalid_input'],
    ['not a url', 'invalid_input'],
    ['http://example.com/feed.xml', 'unsupported_source'],
    ['https://user:pw@example.com/feed.xml', 'unsupported_source'],
  ])('rejects %p with a typed %s error', async (url, code) => {
    const result = await repos.sources.addSourceByUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it('reports a duplicate with the existing source id in details', async () => {
    const result = await repos.sources.addSourceByUrl('https://openai.com/news/rss.xml');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('duplicate_source');
      expect(result.error.details).toEqual({ sourceId: 'oa' });
    }
  });

  it('refuses a genuinely new URL with not_implemented rather than inventing a source', async () => {
    const result = await repos.sources.addSourceByUrl('https://example.com/feed.xml');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_implemented');
  });
});

describe('mock digest repository', () => {
  const repos = createMockRepositories();

  it('returns a ready digest of five items in positions 1..5', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await repos.digest.getLatestDigest();
      expect(result.ok).toBe(true);
      if (!result.ok || result.data.status !== 'ready') throw new Error('expected a ready digest');
      const { digest } = result.data;
      expect(digest.items).toHaveLength(5);
      expect(digest.items.map((i) => i.position)).toEqual([1, 2, 3, 4, 5]);
      expect(digest.date).toBe('2026-08-20');
      for (const item of digest.items) {
        expect(item.articleId).toBeTruthy();
        expect(item.blurb).not.toBe('');
      }
      // The prototype's TechCrunch entry has no article behind it; it is dropped
      // with a warning rather than shipped with a null articleId.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('TechCrunch AI'));
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the prototype blurb where an article matches the source', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await repos.digest.getLatestDigest();
      if (!result.ok || result.data.status !== 'ready') throw new Error('expected a ready digest');
      const first = result.data.digest.items[0];
      expect(first.articleId).toBe('oa');
      expect(first.title).toBe('GPT-5.2 tanıtıldı: iki kat bağlam, yarı fiyat');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('mock enrichment repository', () => {
  const repos = createMockRepositories();

  it('returns ready with the fixture summary', async () => {
    const result = await repos.enrichment.requestEnrichment('gd');
    expect(result.ok).toBe(true);
    if (!result.ok || result.data.status !== 'ready') throw new Error('expected ready');
    expect(result.data.summary.bullets).toHaveLength(3);
    expect(result.data.summary.translationState).toBe('ready');
  });

  it('returns not_required translation state for the Turkish article', async () => {
    const result = await repos.enrichment.requestEnrichment('wz');
    if (!result.ok || result.data.status !== 'ready') throw new Error('expected ready');
    expect(result.data.summary.translationState).toBe('not_required');
    expect(result.data.summary.translationTr).toBeNull();
  });

  it.each([
    ['   ', 'invalid_input'],
    ['nope', 'not_found'],
  ])('rejects %p with a typed %s error', async (id, code) => {
    const result = await repos.enrichment.requestEnrichment(id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });
});
