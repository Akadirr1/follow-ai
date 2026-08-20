/**
 * Typed, injectable gateway over the `service_role` database surface.
 *
 * Portable: no Deno globals and — deliberately — no import of
 * `@supabase/supabase-js`. The client is described here by the single method
 * this code actually uses, so:
 *   - `_shared` stays dependency-free and runs unchanged under Node and Deno;
 *   - every test injects a plain object instead of a real client;
 *   - the npm specifier is pinned in exactly one place (`deno.json`) and used
 *     in exactly one place (each function's `index.ts`).
 *
 * EVERY call goes through an RPC, never `from(...)`. The reason is structural:
 * PostgREST exposes `public, aigundem` only (P2, addendum §B), so `private.*`
 * is unreachable from an Edge Function. Migration `202608210006_internal_
 * wrappers.sql` therefore adds `aigundem.internal_*` SECURITY DEFINER wrappers,
 * executable by `service_role` alone, and this gateway is their only caller.
 *
 * Hashes cross this boundary as lowercase hex strings; the SQL side does
 * `decode(…, 'hex')` into `bytea`. JSON has no byte type, and hex avoids every
 * base64/escape ambiguity in PostgREST's bytea handling.
 */

import { AppError } from './error.ts';
import type { ContentQuality } from './feed.ts';
import type { RateLimitAction } from './rate-limit.ts';

/** The only part of `@supabase/supabase-js` this code depends on. */
export interface AdminClient {
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

// ---------------------------------------------------------------------------
// Row shapes (mirrors of the columns P2 created)
// ---------------------------------------------------------------------------

export type SourceLanguage = 'en' | 'tr';
export type ArticleLanguage = 'en' | 'tr' | 'und';
export type SourceStatus = 'pending' | 'active' | 'paused' | 'failed';
export type Category = 'Modeller' | 'Araştırma' | 'Ürün' | 'Açık Kaynak' | 'Türkiye';

export const CATEGORIES: readonly Category[] = [
  'Modeller',
  'Araştırma',
  'Ürün',
  'Açık Kaynak',
  'Türkiye',
];

export type LeasedSource = {
  id: string;
  slug: string;
  name: string;
  feed_url: string;
  site_url: string | null;
  language: SourceLanguage;
  category: Category;
  status: SourceStatus;
  etag: string | null;
  last_modified: string | null;
  next_fetch_at: string;
  consecutive_failures: number;
};

export type ArticleUpsertRow = {
  external_id: string;
  canonical_url: string;
  /** 64 hex chars. */
  url_hash: string;
  title: string;
  author: string | null;
  category: Category;
  published_at: string;
  language: ArticleLanguage;
  content_text: string;
  content_quality: ContentQuality;
  /** 64 hex chars. */
  content_hash: string;
  excerpt: string;
};

export type UpsertArticlesResult = {
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
  /** Bounded list of SQLSTATEs; never contains article content. */
  error_codes: string[];
};

export type SourceFetchOutcome = {
  ok: boolean;
  etag: string | null;
  lastModified: string | null;
  nextFetchAt: string;
  /** Short, non-sensitive code such as `http_503` or `parse_failed`. */
  errorCode: string | null;
};

export type IngestionCounts = {
  sourcesOk: number;
  sourcesFailed: number;
  inserted: number;
  updated: number;
  unchanged: number;
};

export type UpsertSourceInput = {
  slug: string;
  name: string;
  feedUrl: string;
  feedUrlHash: string;
  siteUrl: string | null;
  language: SourceLanguage;
  category: Category;
};

export type UpsertSourceResult = {
  id: string;
  slug: string;
  name: string;
  feed_url: string;
  site_url: string | null;
  language: SourceLanguage;
  category: Category;
  status: SourceStatus;
  is_default: boolean;
  created: boolean;
};

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export type AdminGateway = ReturnType<typeof createAdminGateway>;

export type AdminGatewayOptions = {
  /**
   * Prefix applied to every RPC name.
   *
   * MEASURED 2026-08-21: on hosted Supabase `ALTER ROLE authenticator SET
   * pgrst.db_schemas` fails with 42501 (reserved role), so `aigundem` is not a
   * PostgREST-exposed schema until a human adds it in Project Settings → API →
   * Exposed schemas. Until then nothing in `aigundem` is callable through
   * supabase-js, service_role included — the exposed-schema list is server
   * config, not a privilege check.
   *
   * So the RPC name is not hard-coded. Today the functions run with
   * `db.schema = 'public'` and prefix `'aigundem_'`, reaching the transport
   * shims that migration 202608210006_internal_wrappers.sql publishes. Once a
   * human exposes `aigundem`, the schema becomes 'aigundem' and the prefix
   * empties. Both spellings reach the same SECURITY DEFINER implementation;
   * only the lookup path differs.
   */
  rpcPrefix?: string;
};

export function createAdminGateway(
  client: AdminClient,
  options: AdminGatewayOptions = {},
) {
  const prefix = options.rpcPrefix ?? '';

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const fn = `${prefix}${name}`;
    const { data, error } = await client.rpc(fn, args);
    if (error) {
      // The message may quote a database row; keep it out of the response and
      // let the caller log a short code instead (arch-001 §3).
      throw new AppError('upstream_error', `Database call ${fn} failed.`);
    }
    return data as T;
  }

  return {
    /** `aigundem.internal_lease_due_sources` — P2. Clamped 1..20 in SQL. */
    async leaseDueSources(n: number): Promise<LeasedSource[]> {
      const rows = await call<LeasedSource[] | null>('internal_lease_due_sources', { n });
      return rows ?? [];
    },

    /**
     * `aigundem.internal_lease_source` — the targeted form behind
     * `sync-feeds`'s optional `source_id`. Returns an empty array when the
     * source does not exist, is `failed`, or is already leased.
     */
    async leaseSource(sourceId: string): Promise<LeasedSource[]> {
      const rows = await call<LeasedSource[] | null>('internal_lease_source', {
        p_source_id: sourceId,
      });
      return rows ?? [];
    },

    /** Opens a `private.ingestion_runs` row and returns its id. */
    async startIngestionRun(trigger: 'cron' | 'manual'): Promise<string> {
      const id = await call<string>('internal_start_ingestion_run', {
        p_trigger_source: trigger,
      });
      return id;
    },

    /** Closes the run with its counts. `errorSummary` is bounded by SQL. */
    async finishIngestionRun(
      runId: string,
      counts: IngestionCounts,
      errorSummary: string | null,
    ): Promise<void> {
      await call<null>('internal_finish_ingestion_run', {
        p_run_id: runId,
        p_sources_ok: counts.sourcesOk,
        p_sources_failed: counts.sourcesFailed,
        p_inserted: counts.inserted,
        p_updated: counts.updated,
        p_unchanged: counts.unchanged,
        p_error_summary: errorSummary,
      });
    },

    /**
     * Upsert a batch on `(source_id, external_id)`. The SQL wrapper isolates
     * each item in its own subtransaction, so one malformed item is counted in
     * `failed` and the rest of the batch still lands (arch-001 §2).
     */
    async upsertArticles(
      sourceId: string,
      rows: ArticleUpsertRow[],
    ): Promise<UpsertArticlesResult> {
      if (rows.length === 0) {
        return { inserted: 0, updated: 0, unchanged: 0, failed: 0, error_codes: [] };
      }
      const result = await call<UpsertArticlesResult[] | UpsertArticlesResult>(
        'internal_upsert_articles',
        { p_source_id: sourceId, p_articles: rows },
      );
      return Array.isArray(result) ? result[0] : result;
    },

    /** Records success/failure, conditional-GET validators and the next due time. */
    async updateSourceFetchState(
      sourceId: string,
      outcome: SourceFetchOutcome,
    ): Promise<void> {
      await call<null>('internal_update_source_fetch_state', {
        p_source_id: sourceId,
        p_ok: outcome.ok,
        p_etag: outcome.etag,
        p_last_modified: outcome.lastModified,
        p_next_fetch_at: outcome.nextFetchAt,
        p_error_code: outcome.errorCode,
      });
    },

    /** `aigundem.internal_bump_rate_limit` — P2. True while within `limit`. */
    async bumpRateLimit(
      subject: string,
      action: RateLimitAction,
      windowStart: string,
      limit: number,
    ): Promise<boolean> {
      const allowed = await call<boolean>('internal_bump_rate_limit', {
        p_subject: subject,
        p_action: action,
        p_window_start: windowStart,
        p_limit: limit,
      });
      return allowed === true;
    },

    /**
     * Insert a shared source, or return the existing row for the same
     * normalised feed URL. `created` distinguishes 201 from 200.
     */
    async upsertSource(input: UpsertSourceInput): Promise<UpsertSourceResult> {
      const result = await call<UpsertSourceResult[] | UpsertSourceResult>(
        'internal_upsert_source',
        {
          p_slug: input.slug,
          p_name: input.name,
          p_feed_url: input.feedUrl,
          p_feed_url_hash: input.feedUrlHash,
          p_site_url: input.siteUrl,
          p_language: input.language,
          p_category: input.category,
        },
      );
      return Array.isArray(result) ? result[0] : result;
    },
  };
}

/** Type guard for a category arriving in a request body. */
export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

/** Type guard for a source language arriving in a request body. */
export function isSourceLanguage(value: unknown): value is SourceLanguage {
  return value === 'en' || value === 'tr';
}

/**
 * A URL-safe slug derived from the feed's own title. Not unique by itself —
 * only seeded defaults carry a unique slug (P2 uses a partial unique index
 * `WHERE is_default`), so a collision between two user-added sources is fine.
 */
export function slugify(input: string, fallback = 'kaynak'): string {
  const map: Record<string, string> = {
    ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i',
    ö: 'o', Ö: 'o', ş: 's', Ş: 's', ü: 'u', Ü: 'u',
  };
  const folded = [...input].map((ch) => map[ch] ?? ch).join('');
  const slug = folded
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : fallback;
}
