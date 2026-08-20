/**
 * The search seam must keep the store's behaviour, including the case-folding fix
 * from impl-002 (rev-001 B1): plain `toLowerCase()`, so `openai` still finds the
 * OpenAI article. `selectResults` is imported read-only as the oracle — when P7
 * deletes it, these expectations move here unchanged.
 */
import { initialState } from '../../store/reducer';
import { selectResults } from '../../store/selectors';
import { createMockRepositories } from '../mock';

const repos = createMockRepositories();

const searchIds = async (query: string): Promise<string[]> => {
  const result = await repos.feed.searchArticles({ query, limit: 50 });
  if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
  return result.data.items.map((a) => a.id);
};

const storeIds = (query: string): string[] =>
  selectResults({ ...initialState, q: query }).map((a) => a.id);

const QUERIES = [
  'openai',
  'ai',
  'ALPHAFOLD',
  'alphafold',
  'hugging face',
  'türkiye',
  'gpt-5.2',
  'Claude',
  'açık kaynak',
  'zzzz',
  '',
  '   ',
];

describe('search parity with the store selector', () => {
  it.each(QUERIES)('matches selectResults for %p', async (query) => {
    expect(await searchIds(query)).toEqual(storeIds(query));
  });

  it('finds the OpenAI article by acronym — the rev-001 B1 regression', async () => {
    expect(await searchIds('openai')).toEqual(['oa']);
    expect(await searchIds('ai')).toContain('oa');
  });

  it('matches on title, source name and category', async () => {
    expect(await searchIds('alphafold')).toEqual(['gd']); // title
    expect(await searchIds('hugging face')).toEqual(['hf']); // source name
    expect(await searchIds('türkiye')).toEqual(['wz']); // category
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
