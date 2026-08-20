import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import type { DataError } from '../domain/errors';
import type { Cursor, EnrichmentResult } from '../domain/types';
import { getRepositories } from './index';
import { queryKeys, type FeedFilter } from './queryKeys';
import type { Repositories } from './repositories';

/**
 * Query hooks over the seam. They call `getRepositories()`, so the same hook
 * serves mock and Supabase mode — screens (P7) never learn which is active.
 *
 * A repository returns `Result<T>`; a query needs a thrown error to enter its
 * error state, so `unwrap` converts one into the other at exactly one place.
 */

/** Thrown only inside a query function, so React Query can catch it. */
export class DataErrorThrown extends Error {
  readonly error: DataError;
  constructor(error: DataError) {
    super(error.message);
    this.name = 'DataErrorThrown';
    this.error = error;
  }
}

export const asDataError = (thrown: unknown): DataError | null =>
  thrown instanceof DataErrorThrown ? thrown.error : null;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: DataError }): T {
  if (!result.ok) throw new DataErrorThrown(result.error);
  return result.data;
}

/** Retry only what the server said is worth retrying. */
const retryPolicy = (failureCount: number, thrown: unknown): boolean => {
  const error = asDataError(thrown);
  if (error && !error.retryable) return false;
  return failureCount < 2;
};

export const useRepositories = (): Repositories => useMemo(() => getRepositories(), []);

export function useFeed(filter: FeedFilter = {}) {
  const repos = useRepositories();
  return useInfiniteQuery({
    queryKey: queryKeys.feed(filter),
    initialPageParam: null as Cursor | null,
    queryFn: ({ pageParam }) =>
      repos.feed
        .listArticles({
          cursor: pageParam,
          category: filter.category ?? null,
          ...(filter.sourceIds ? { sourceIds: filter.sourceIds } : {}),
        })
        .then(unwrap),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    retry: retryPolicy,
  });
}

export function useArticle(id: string | null | undefined) {
  const repos = useRepositories();
  return useQuery({
    queryKey: queryKeys.article(id ?? ''),
    enabled: Boolean(id),
    queryFn: () => repos.feed.getArticle(id as string).then(unwrap),
    retry: retryPolicy,
  });
}

export function useSearch(query: string) {
  const repos = useRepositories();
  const trimmed = query.trim();
  return useQuery({
    queryKey: queryKeys.search(trimmed),
    // A blank query is the "recent searches" state, not a request.
    enabled: trimmed.length > 0,
    queryFn: () => repos.feed.searchArticles({ query: trimmed }).then(unwrap),
    retry: retryPolicy,
  });
}

export function useSources() {
  const repos = useRepositories();
  return useQuery({
    queryKey: queryKeys.sources(),
    queryFn: () => repos.sources.listSources().then(unwrap),
    // The catalog changes when someone adds a source, which is rare.
    staleTime: 30 * 60 * 1000,
    retry: retryPolicy,
  });
}

export function useDigest() {
  const repos = useRepositories();
  return useQuery({
    queryKey: queryKeys.digest(),
    queryFn: () => repos.digest.getLatestDigest().then(unwrap),
    retry: retryPolicy,
  });
}

/** Default seconds between enrichment polls when the server does not say. */
export const ENRICHMENT_POLL_SECONDS = 5;
/** Stop after this many polls; without a key the job never leaves the queue. */
export const ENRICHMENT_MAX_POLLS = 6;

/**
 * Ask for an article's summary and keep asking while it is `queued`.
 *
 * Polling stops after `ENRICHMENT_MAX_POLLS` with a warning: with
 * no Anthropic key configured the job stays queued forever (addendum §E), and a hook that
 * polled forever would be an invisible battery drain rather than a visible
 * "Özet hazırlanıyor".
 */
export function useEnrichment(
  articleId: string | null | undefined,
  options: { enabled?: boolean; maxPolls?: number } = {},
) {
  const repos = useRepositories();
  const maxPolls = options.maxPolls ?? ENRICHMENT_MAX_POLLS;

  return useQuery({
    queryKey: queryKeys.enrichment(articleId ?? ''),
    enabled: Boolean(articleId) && options.enabled !== false,
    queryFn: () => repos.enrichment.requestEnrichment(articleId as string).then(unwrap),
    retry: retryPolicy,
    refetchInterval: (query) => {
      const data = query.state.data as EnrichmentResult | undefined;
      if (!data || data.status !== 'queued') return false;
      if (query.state.dataUpdateCount >= maxPolls) {
        console.warn(
          `[enrichment] article ${articleId}: still queued after ${maxPolls} polls (${
            data.reason ?? 'no reason given'
          }); giving up until the screen is reopened.`,
        );
        return false;
      }
      return ENRICHMENT_POLL_SECONDS * 1000;
    },
  });
}
