import { ARTICLES } from '../../data/articles';
import type { Result } from '../../domain/errors';
import type { Article, Cursor, Page } from '../../domain/types';
import { createMockRepositories } from '../mock';
import { MOCK_NOW_ISO, hoursAgoFromLabel } from '../mock/mapper';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../repositories';

const repos = createMockRepositories();

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
  return result.data;
}

describe('mock feed — mapping', () => {
  it('maps every fixture article onto a DTO with no fixture-shaped fields left', async () => {
    const page = unwrap(await repos.feed.listArticles());
    expect(page.items).toHaveLength(ARTICLES.length);
    for (const article of page.items) {
      expect(article).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          sourceId: expect.any(String),
          sourceName: expect.any(String),
          title: expect.any(String),
          publishedAt: expect.any(String),
          category: expect.any(String),
          bodyOriginal: expect.any(String),
        }),
      );
      expect(Object.keys(article)).not.toContain('sum');
      expect(Object.keys(article)).not.toContain('body');
      expect(Object.keys(article)).not.toContain('en');
      expect(Date.parse(article.publishedAt)).not.toBeNaN();
    }
  });

  it('gives every article exactly three summary bullets', async () => {
    const page = unwrap(await repos.feed.listArticles());
    for (const article of page.items) {
      expect(article.summary?.bullets).toHaveLength(3);
    }
  });

  it('translates English articles and marks the Turkish one not_required', async () => {
    const en = unwrap(await repos.feed.getArticle('oa'));
    expect(en.language).toBe('en');
    expect(en.summary?.translationState).toBe('ready');
    expect(en.summary?.translationTr).toContain('OpenAI');
    // bodyOriginal is the English text, not the Turkish translation.
    expect(en.bodyOriginal).toContain('OpenAI announced');

    const tr = unwrap(await repos.feed.getArticle('wz'));
    expect(tr.language).toBe('tr');
    expect(tr.summary?.translationState).toBe('not_required');
    expect(tr.summary?.translationTr).toBeNull();
    expect(tr.bodyOriginal).toContain('TÜBİTAK destekli konsorsiyum');
  });

  it('derives deterministic timestamps from the relative labels', async () => {
    expect(hoursAgoFromLabel('2 saat önce')).toBe(2);
    expect(hoursAgoFromLabel('dün')).toBe(24);
    const first = unwrap(await repos.feed.listArticles());
    const second = unwrap(await repos.feed.listArticles());
    expect(first.items.map((a) => a.publishedAt)).toEqual(second.items.map((a) => a.publishedAt));
    expect(first.items[0].publishedAt).toBe(
      new Date(Date.parse(MOCK_NOW_ISO) - 2 * 3_600_000).toISOString(),
    );
  });

  it('warns instead of throwing on an unrecognised time label', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(hoursAgoFromLabel('geçen ay')).toBe(24 * 7);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('geçen ay'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('mock feed — ordering and pagination', () => {
  it('orders newest first', async () => {
    const page = unwrap(await repos.feed.listArticles());
    expect(page.items.map((a) => a.id)).toEqual(['oa', 'an', 'gd', 'hf', 'wz']);
    const times = page.items.map((a) => Date.parse(a.publishedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('honours the page size', async () => {
    const page = unwrap(await repos.feed.listArticles({ limit: 2 }));
    expect(page.items.map((a) => a.id)).toEqual(['oa', 'an']);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({ publishedAt: page.items[1].publishedAt, id: 'an' });
  });

  it('walks the whole list with cursor continuity and no repeats', async () => {
    const seen: string[] = [];
    let cursor: Cursor | null = null;
    let pages = 0;

    do {
      const page: Page<Article> = unwrap(await repos.feed.listArticles({ limit: 2, cursor }));
      seen.push(...page.items.map((a) => a.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10); // guards an infinite cursor loop
    } while (cursor);

    expect(seen).toEqual(['oa', 'an', 'gd', 'hf', 'wz']);
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages).toBe(3); // 2 + 2 + 1
  });

  it('reports the end of the list with a null cursor', async () => {
    const page = unwrap(await repos.feed.listArticles({ limit: 50 }));
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('clamps an out-of-range limit and warns', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await repos.feed.listArticles({ limit: MAX_PAGE_SIZE + 1 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('clamping'));
      warn.mockClear();
      await repos.feed.listArticles({ limit: 0 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(String(DEFAULT_PAGE_SIZE)));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('mock feed — filtering', () => {
  it('filters by category', async () => {
    const page = unwrap(await repos.feed.listArticles({ category: 'Araştırma' }));
    expect(page.items.map((a) => a.id)).toEqual(['gd']);
  });

  it('filters by source ids', async () => {
    const page = unwrap(await repos.feed.listArticles({ sourceIds: ['hf', 'wz'] }));
    expect(page.items.map((a) => a.id)).toEqual(['hf', 'wz']);
  });

  it('combines both filters and can return an empty page', async () => {
    const page = unwrap(
      await repos.feed.listArticles({ sourceIds: ['hf'], category: 'Modeller' }),
    );
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

describe('mock feed — getArticle', () => {
  it('returns a typed not_found rather than a fallback article', async () => {
    const result = await repos.feed.getArticle('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('rejects an empty id as invalid_input', async () => {
    const result = await repos.feed.getArticle('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_input');
  });
});
