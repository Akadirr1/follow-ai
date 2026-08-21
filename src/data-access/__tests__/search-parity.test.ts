import { createMockRepositories } from '../mock';
import { NO_CONTENT_ARTICLE } from '../mock/mapper';

/**
 * Search behaviour, previously asserted against the store's `selectResults` as an
 * oracle. P7 deleted the store, so the expectations that lived there are stated
 * directly here — same queries, same expected ids, including the impl-002 B1
 * regression (`openai` must find the OpenAI article; Turkish-locale folding used
 * to turn "OpenAI Blog" into "openaı blog").
 */

const repos = createMockRepositories();

const searchIds = async (query: string): Promise<string[]> => {
  const result = await repos.feed.searchArticles({ query, limit: 50 });
  if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
  return result.data.items.map((a) => a.id);
};

describe('mock search', () => {
  it.each([
    ['openai', ['oa']],
    ['ALPHAFOLD', ['gd']],
    ['alphafold', ['gd']],
    // Two Hugging Face articles since fix-005: the prototype one and the
    // body-less fixture that reaches `unavailable/no_content`.
    ['hugging face', ['hf', NO_CONTENT_ARTICLE.id]],
    ['türkiye', ['wz']],
    ['zzzz', []],
    ['', []],
    ['   ', []],
  ])('%p returns %p', async (query, expected) => {
    expect(await searchIds(query as string)).toEqual(expected);
  });

  it('finds the OpenAI article by acronym — the impl-002 B1 regression', async () => {
    expect(await searchIds('openai')).toEqual(['oa']);
    expect(await searchIds('ai')).toContain('oa');
  });

  it('matches on title, source name and category', async () => {
    expect(await searchIds('alphafold')).toEqual(['gd']); // title
    expect(await searchIds('hugging face')).toEqual(['hf', NO_CONTENT_ARTICLE.id]); // source name
    expect(await searchIds('türkiye')).toEqual(['wz']); // category
  });

  it('is case-insensitive both ways round', async () => {
    expect(await searchIds('HUGGING FACE')).toEqual(await searchIds('hugging face'));
    expect(await searchIds('Türkiye')).toEqual(await searchIds('türkiye'));
  });

  it('returns an empty page for a blank query without erroring', async () => {
    const result = await repos.feed.searchArticles({ query: '   ' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.items).toEqual([]);
      expect(result.data.hasMore).toBe(false);
      expect(result.data.nextCursor).toBeNull();
    }
  });

  it('paginates results with the same cursor contract as the feed', async () => {
    const first = await repos.feed.searchArticles({ query: 'a', limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.items).toHaveLength(1);
    expect(first.data.hasMore).toBe(true);

    const second = await repos.feed.searchArticles({
      query: 'a',
      limit: 1,
      cursor: first.data.nextCursor,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.items[0].id).not.toBe(first.data.items[0].id);
  });
});
