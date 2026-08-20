import { QUERY_KEY_VERSION } from '../providers/QueryProvider';
import type { SourceId } from '../domain/types';

/**
 * Every query key starts with the version segment, which is what
 * `shouldDehydrateQuery` matches on: a key that does not start with it is never
 * persisted. Keys are built here and nowhere else, so a rename cannot leave a
 * stale key spelled two different ways in two screens.
 */
export type FeedFilter = {
  category?: string | null;
  sourceIds?: readonly SourceId[];
};

/** Sorted + joined so two equivalent filters produce one cache entry. */
const filterSegment = (filter: FeedFilter): string =>
  JSON.stringify({
    category: filter.category ?? null,
    sourceIds: filter.sourceIds ? [...filter.sourceIds].sort() : null,
  });

export const queryKeys = {
  all: [QUERY_KEY_VERSION] as const,
  feed: (filter: FeedFilter = {}) => [QUERY_KEY_VERSION, 'feed', filterSegment(filter)] as const,
  article: (id: string) => [QUERY_KEY_VERSION, 'article', id] as const,
  search: (query: string) => [QUERY_KEY_VERSION, 'search', query.trim().toLowerCase()] as const,
  sources: () => [QUERY_KEY_VERSION, 'sources'] as const,
  digest: () => [QUERY_KEY_VERSION, 'digest'] as const,
  enrichment: (articleId: string) => [QUERY_KEY_VERSION, 'enrichment', articleId] as const,
} as const;
