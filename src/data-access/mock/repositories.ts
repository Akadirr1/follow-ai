/**
 * Mock implementations of all four repositories, over the prototype fixtures.
 * They are deliberately as strict as the Supabase adapter will have to be:
 * bounded pages, opaque cursors, typed errors, no throwing.
 */
import { err, ok, type Result } from '../../domain/errors';
import type {
  Article,
  ArticleId,
  Cursor,
  DigestSnapshot,
  EnrichmentResult,
  Page,
  Source,
} from '../../domain/types';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  REPOSITORY_CONTRACT_VERSION,
  type DigestRepository,
  type EnrichmentRepository,
  type FeedRepository,
  type ListArticlesParams,
  type SearchArticlesParams,
  type SourceRepository,
} from '../repositories';
import {
  compareArticles,
  cursorOfArticle,
  isAfterCursor,
  mockArticles,
  mockDigest,
  mockSources,
} from './mapper';

/** Clamp rather than reject: a bad limit is a caller bug, not a user-facing error. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(limit) || limit < 1) {
    console.warn(`[mock] limit ${limit} is not a positive number; using ${DEFAULT_PAGE_SIZE}.`);
    return DEFAULT_PAGE_SIZE;
  }
  if (limit > MAX_PAGE_SIZE) {
    console.warn(`[mock] limit ${limit} exceeds ${MAX_PAGE_SIZE}; clamping.`);
    return MAX_PAGE_SIZE;
  }
  return Math.floor(limit);
}

function paginate(sorted: Article[], cursor: Cursor | null | undefined, limit: number): Page<Article> {
  const start = cursor ? sorted.filter((a) => isAfterCursor(a, cursor)) : sorted;
  const items = start.slice(0, limit);
  const hasMore = start.length > items.length;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? cursorOfArticle(last) : null,
    hasMore,
  };
}

/** Same folding rule as the store's `selectResults`: plain `toLowerCase()`. */
export const matchesQuery = (article: Article, query: string): boolean =>
  `${article.title} ${article.sourceName} ${article.category}`
    .toLowerCase()
    .includes(query.trim().toLowerCase());

export function createMockFeedRepository(): FeedRepository {
  return {
    version: REPOSITORY_CONTRACT_VERSION,

    async listArticles(params: ListArticlesParams = {}): Promise<Result<Page<Article>>> {
      const limit = clampLimit(params.limit);
      const sourceIds = params.sourceIds ? new Set(params.sourceIds) : null;
      const filtered = mockArticles().filter(
        (a) =>
          (sourceIds === null || sourceIds.has(a.sourceId)) &&
          (!params.category || a.category === params.category),
      );
      return ok(paginate(filtered.sort(compareArticles), params.cursor, limit));
    },

    async getArticle(id: ArticleId): Promise<Result<Article>> {
      const trimmed = id?.trim();
      if (!trimmed) {
        return err('invalid_input', 'getArticle called without an article id.');
      }
      const found = mockArticles().find((a) => a.id === trimmed);
      // No prototype-style fallback article here: the seam reports the miss and the
      // caller decides, rather than silently rendering a different article.
      return found ? ok(found) : err('not_found', `No article with id "${trimmed}".`);
    },

    async searchArticles(params: SearchArticlesParams): Promise<Result<Page<Article>>> {
      const query = params.query?.trim() ?? '';
      const limit = clampLimit(params.limit);
      if (!query) return ok({ items: [], nextCursor: null, hasMore: false });
      const matched = mockArticles().filter((a) => matchesQuery(a, query));
      return ok(paginate(matched, params.cursor, limit));
    },
  };
}

export function createMockSourceRepository(): SourceRepository {
  return {
    version: REPOSITORY_CONTRACT_VERSION,

    async listSources(): Promise<Result<Source[]>> {
      return ok(mockSources().filter((s) => s.isActive));
    },

    /**
     * Validates the URL the same way the real `add-source` function will (public
     * HTTPS only, no credentials, no duplicates) and then refuses, because the mock
     * has no way to fetch or parse a feed. Refusing with a typed error is the
     * honest answer; inventing a source row would make the mock claim a capability
     * the app does not have until P3.
     */
    async addSourceByUrl(url: string): Promise<Result<Source>> {
      const raw = url?.trim();
      if (!raw) return err('invalid_input', 'A feed or site URL is required.');

      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return err('invalid_input', `"${raw}" is not a valid URL.`);
      }
      if (parsed.protocol !== 'https:') {
        return err('unsupported_source', 'Only https:// sources are allowed.');
      }
      if (parsed.username || parsed.password) {
        return err('unsupported_source', 'Credentialed URLs are not allowed.');
      }

      const existing = mockSources().find(
        (s) => s.feedUrl === parsed.toString() || s.siteUrl === parsed.toString(),
      );
      if (existing) {
        return err('duplicate_source', `"${existing.name}" is already in the catalog.`, {
          details: { sourceId: existing.id },
        });
      }

      return err(
        'not_implemented',
        'Adding sources needs the add-source Edge Function; switch EXPO_PUBLIC_DATA_MODE to supabase once P3 is deployed.',
      );
    },
  };
}

export function createMockDigestRepository(): DigestRepository {
  return {
    version: REPOSITORY_CONTRACT_VERSION,

    async getLatestDigest(): Promise<Result<DigestSnapshot>> {
      const articles = mockArticles();
      if (articles.length === 0) {
        console.warn('[mock] no articles to build a digest from; reporting preparing.');
        return ok({ status: 'preparing' });
      }
      return ok({ status: 'ready', digest: mockDigest(articles) });
    },
  };
}

export function createMockEnrichmentRepository(): EnrichmentRepository {
  return {
    version: REPOSITORY_CONTRACT_VERSION,

    async requestEnrichment(articleId: ArticleId): Promise<Result<EnrichmentResult>> {
      const trimmed = articleId?.trim();
      if (!trimmed) {
        return err('invalid_input', 'requestEnrichment called without an article id.');
      }
      const article = mockArticles().find((a) => a.id === trimmed);
      if (!article) return err('not_found', `No article with id "${trimmed}".`);

      // The fixtures ship Claude's output already, so the mock is always `ready`.
      // The `queued` branch still exists on the contract because the real backend
      // returns it whenever the Anthropic key is unset (addendum §E).
      if (!article.summary) {
        console.warn(`[mock] article "${trimmed}" has no fixture summary; reporting queued.`);
        return ok({ status: 'queued', reason: 'no_fixture_summary' });
      }
      return ok({ status: 'ready', summary: article.summary });
    },
  };
}
