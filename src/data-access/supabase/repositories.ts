import type { SupabaseClient } from '@supabase/supabase-js';

import { err, ok, type Result } from '../../domain/errors';
import type {
  Article,
  ArticleId,
  DigestSnapshot,
  EnrichmentResult,
  Page,
  Source,
} from '../../domain/types';
import { cursorOf, keysetFilter } from '../cursor';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  REPOSITORY_CONTRACT_VERSION,
  type DigestRepository,
  type EnrichmentRepository,
  type FeedRepository,
  type AddSourceOptions,
  type ListArticlesParams,
  type SearchArticlesParams,
  type SourceRepository,
} from '../repositories';
import { FEED_VIEW, SEARCH_RPC, getSupabaseClient, toDataError, toNetworkError } from './client';
import { callEdgeFunction, clientRequestId, type EdgeCallOptions } from './edge';
import {
  FEED_COLUMNS,
  toArticle,
  toDigest,
  toSource,
  type DigestArticleFacts,
  type DigestItemRow,
  type DigestRow,
  type FeedArticleRow,
  type SourceRow,
} from './mapper';

/**
 * Supabase implementations of the P1 seam.
 *
 * Reads go to the `public.aigundem_*` shims (migration 0006) because schema
 * `aigundem` is not exposed to PostgREST — measured 2026-08-21, `Accept-Profile:
 * aigundem` → `PGRST106`. Writes never touch PostgREST at all: the anon role has
 * no write grant, so adding a source and requesting a summary are Edge calls.
 *
 * The `PGRST205`/`PGRST106` → `not_implemented` mapping in `toDataError` stays as
 * defence: these shims are temporary, and the day they are dropped in favour of
 * `.schema('aigundem')` the failure should name the missing surface rather than
 * surfacing an unexplained error.
 */

/** Catalog + digest shims, added by migration 0007 (verified live: 200 []). */
export const SOURCES_VIEW = 'aigundem_sources_v1';
export const DIGESTS_VIEW = 'aigundem_digests_v1';
export const DIGEST_ITEMS_VIEW = 'aigundem_digest_items_v1';

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(limit) || limit < 1) {
    console.warn(`[supabase] limit ${limit} is not a positive number; using ${DEFAULT_PAGE_SIZE}.`);
    return DEFAULT_PAGE_SIZE;
  }
  if (limit > MAX_PAGE_SIZE) {
    console.warn(`[supabase] limit ${limit} exceeds ${MAX_PAGE_SIZE}; clamping.`);
    return MAX_PAGE_SIZE;
  }
  return Math.floor(limit);
}

/** One extra row tells us whether another page exists without a count query. */
function toPage(rows: FeedArticleRow[], limit: number): Page<Article> {
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const last = visible[visible.length - 1];
  return {
    items: visible.map(toArticle),
    nextCursor: hasMore && last ? cursorOf(last.published_at, last.article_id) : null,
    hasMore,
  };
}

export function createSupabaseFeedRepository(
  client: SupabaseClient = getSupabaseClient(),
): FeedRepository {
  return {
    version: REPOSITORY_CONTRACT_VERSION,

    async listArticles(params: ListArticlesParams = {}): Promise<Result<Page<Article>>> {
      const limit = clampLimit(params.limit);
      try {
        let query = client
          .from(FEED_VIEW)
          .select(FEED_COLUMNS)
          .order('published_at', { ascending: false })
          .order('article_id', { ascending: false })
          .limit(limit + 1);

        if (params.sourceIds && params.sourceIds.length > 0) {
          query = query.in('source_id', params.sourceIds as string[]);
        }
        if (params.category) {
          query = query.eq('category', params.category);
        }
        if (params.cursor) {
          query = query.or(keysetFilter(params.cursor));
        }

        const { data, error } = await query;
        if (error) return { ok: false, error: toDataError(error, 'listArticles') };
        return ok(toPage((data ?? []) as unknown as FeedArticleRow[], limit));
      } catch (error) {
        return toNetworkError(error, 'listArticles');
      }
    },

    async getArticle(id: ArticleId): Promise<Result<Article>> {
      const trimmed = id?.trim();
      if (!trimmed) return err('invalid_input', 'getArticle called without an article id.');
      try {
        const { data, error } = await client
          .from(FEED_VIEW)
          .select(FEED_COLUMNS)
          .eq('article_id', trimmed)
          .limit(1);
        if (error) return { ok: false, error: toDataError(error, 'getArticle') };
        const row = ((data ?? []) as unknown as FeedArticleRow[])[0];
        return row ? ok(toArticle(row)) : err('not_found', `No article with id "${trimmed}".`);
      } catch (error) {
        return toNetworkError(error, 'getArticle');
      }
    },

    /**
     * Search is the RPC, not a `like` filter: it uses the GIN index on
     * `search_tsv`. The RPC returns at most `lim` rows in one shot and has no
     * cursor parameter, so a search result page is always the last page.
     */
    async searchArticles(params: SearchArticlesParams): Promise<Result<Page<Article>>> {
      const query = params.query?.trim() ?? '';
      const limit = clampLimit(params.limit);
      if (!query) return ok({ items: [], nextCursor: null, hasMore: false });
      try {
        const { data, error } = await client.rpc(SEARCH_RPC, {
          q: query,
          source_ids: null,
          lim: limit,
        });
        if (error) return { ok: false, error: toDataError(error, 'searchArticles') };
        const rows = (data ?? []) as unknown as FeedArticleRow[];
        return ok({ items: rows.map(toArticle), nextCursor: null, hasMore: false });
      } catch (error) {
        return toNetworkError(error, 'searchArticles');
      }
    },
  };
}

export function createSupabaseSourceRepository(
  client: SupabaseClient = getSupabaseClient(),
  edgeOptions: EdgeCallOptions = {},
): SourceRepository {
  return {
    version: REPOSITORY_CONTRACT_VERSION,

    async listSources(): Promise<Result<Source[]>> {
      try {
        const { data, error } = await client
          .from(SOURCES_VIEW)
          .select('id,slug,name,feed_url,site_url,language,category,is_default,status')
          .eq('status', 'active')
          .order('is_default', { ascending: false })
          .order('name', { ascending: true });
        if (error) return { ok: false, error: toDataError(error, 'listSources') };
        return ok(((data ?? []) as unknown as SourceRow[]).map(toSource));
      } catch (error) {
        return toNetworkError(error, 'listSources');
      }
    },

    /** Creates the *shared* source row; the device's subscription is local (addendum §A). */
    async addSourceByUrl(url: string, options?: AddSourceOptions): Promise<Result<Source>> {
      const raw = url?.trim();
      if (!raw) return err('invalid_input', 'A feed or site URL is required.');

      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return err('invalid_input', `"${raw}" is not a valid URL.`);
      }
      // Client-side pre-checks mirror the server's SSRF rules so an obviously bad
      // URL never becomes a rate-limited round trip. The server re-checks.
      if (parsed.protocol !== 'https:') {
        return err('unsupported_source', 'Only https:// sources are allowed.');
      }
      if (parsed.username || parsed.password) {
        return err('unsupported_source', 'Credentialed URLs are not allowed.');
      }

      const result = await callEdgeFunction<{ source?: SourceRow }>(
        'add-source',
        {
          url: parsed.toString(),
          // The sheet's category/language are hints for the server's own
          // classification, not authority: add-source re-derives both.
          ...(options?.category ? { category: options.category } : {}),
          language: options?.language ?? 'en',
          client_request_id: clientRequestId(),
        },
        edgeOptions,
      );
      if (!result.ok) return result;

      const row = result.data.data?.source;
      if (!row) {
        return err('server', '[edge] add-source: response contained no source.');
      }
      return ok(toSource(row));
    },
  };
}

export function createSupabaseDigestRepository(
  client: SupabaseClient = getSupabaseClient(),
): DigestRepository {
  return {
    version: REPOSITORY_CONTRACT_VERSION,

    async getLatestDigest(): Promise<Result<DigestSnapshot>> {
      try {
        const { data, error } = await client
          .from(DIGESTS_VIEW)
          .select('id,digest_date,timezone,status,headline,window_start,window_end,generated_at')
          .eq('status', 'ready')
          .order('digest_date', { ascending: false })
          .limit(1);
        if (error) return { ok: false, error: toDataError(error, 'getLatestDigest') };

        const digest = ((data ?? []) as unknown as DigestRow[])[0];
        // No ready digest is not an error: with no Anthropic key the digest
        // legitimately stays `preparing` (addendum §E).
        if (!digest) return ok({ status: 'preparing' });

        const { data: itemRows, error: itemError } = await client
          .from(DIGEST_ITEMS_VIEW)
          .select('digest_id,position,article_id,blurb_tr,created_at')
          .eq('digest_id', digest.id)
          .order('position', { ascending: true });
        if (itemError) return { ok: false, error: toDataError(itemError, 'getLatestDigest.items') };

        const items = (itemRows ?? []) as unknown as DigestItemRow[];
        if (items.length === 0) {
          console.warn(`[supabase] digest ${digest.id} is ready but has no items; reporting preparing.`);
          return ok({ status: 'preparing' });
        }

        // The item view carries only `article_id` + `blurb_tr`; titles and source
        // labels live in the feed view, so they are fetched in one keyed lookup.
        const facts = new Map<string, DigestArticleFacts>();
        const { data: articleRows, error: articleError } = await client
          .from(FEED_VIEW)
          .select('article_id,title,source_name,category')
          .in(
            'article_id',
            items.map((item) => item.article_id),
          );
        if (articleError) {
          return { ok: false, error: toDataError(articleError, 'getLatestDigest.articles') };
        }
        for (const row of (articleRows ?? []) as unknown as {
          article_id: string;
          title: string;
          source_name: string;
          category: string;
        }[]) {
          facts.set(row.article_id, {
            title: row.title,
            sourceName: row.source_name,
            category: row.category,
          });
        }

        return ok({ status: 'ready', digest: toDigest(digest, items, facts) });
      } catch (error) {
        return toNetworkError(error, 'getLatestDigest');
      }
    },
  };
}

/** `202 {status:'queued'}` shape from `request-enrichment`. */
type EnrichmentResponse = {
  status?: string;
  summary?: { bullets?: string[]; translation_tr?: string | null; translation_state?: string };
  poll_after_seconds?: number;
  reason?: string;
};

export function createSupabaseEnrichmentRepository(
  edgeOptions: EdgeCallOptions = {},
): EnrichmentRepository {
  return {
    version: REPOSITORY_CONTRACT_VERSION,

    async requestEnrichment(articleId: ArticleId): Promise<Result<EnrichmentResult>> {
      const trimmed = articleId?.trim();
      if (!trimmed) return err('invalid_input', 'requestEnrichment called without an article id.');

      const result = await callEdgeFunction<EnrichmentResponse>(
        'request-enrichment',
        { article_id: trimmed, client_request_id: clientRequestId() },
        edgeOptions,
      );
      if (!result.ok) return result;

      const { status, data } = result.data;
      // Terminal, and checked before `queued`: v2 answers 200 `unavailable` for an
      // article with no body to send Claude. It used to fall through to the
      // unknown-body branch below and be polled to the cap as if it were pending.
      if (data?.status === 'unavailable') {
        return ok({ status: 'unavailable', reason: data.reason ?? 'no_content' });
      }

      // 202, or any body that says `queued`, is the normal no-API-key path
      // (addendum §E): the job is real, it just has nothing to run yet.
      if (status === 202 || data?.status === 'queued') {
        return ok({ status: 'queued', reason: data?.reason ?? null });
      }

      const summary = data?.summary;
      if (data?.status === 'ready' && summary?.bullets) {
        const bullets = summary.bullets;
        if (bullets.length !== 3) {
          console.warn(
            `[supabase] request-enrichment returned ${bullets.length} bullets for ${trimmed}, expected 3; padding.`,
          );
        }
        const state = summary.translation_state === 'not_required' ? 'not_required' : 'ready';
        return ok({
          status: 'ready',
          summary: {
            bullets: [bullets[0] ?? '', bullets[1] ?? '', bullets[2] ?? ''],
            translationTr: state === 'not_required' ? null : (summary.translation_tr ?? null),
            translationState: state,
          },
        });
      }

      console.warn(
        `[supabase] request-enrichment returned an unrecognised body for ${trimmed}; treating it as queued.`,
      );
      return ok({ status: 'queued', reason: data?.reason ?? null });
    },
  };
}

/** Seconds the caller should wait before polling again, when the server says so. */
export const pollAfterSeconds = (payload: unknown): number | null => {
  const value = (payload as EnrichmentResponse | null)?.poll_after_seconds;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
};
