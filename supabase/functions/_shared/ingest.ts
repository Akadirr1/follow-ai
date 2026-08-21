/**
 * The `sync-feeds` run, as a pure function over injected dependencies.
 *
 * Portable: no Deno globals, no `fetch` of its own, no clock of its own. Both the
 * database gateway and the feed fetcher are injected, which is what makes the
 * two properties arch-001 §2 demands directly testable with no network and no
 * database:
 *
 *   - "One malformed source/item cannot roll back other sources/items."
 *     Each source is wrapped in its own try/catch here; each *item* is isolated
 *     inside `internal_upsert_articles` by a per-row subtransaction.
 *   - "unchanged items do not re-call Claude." A 304, or an item whose
 *     `content_hash` is unchanged, produces no write and no job.
 */

import { parseFeed, ParsedItem } from './feed.ts';
import { contentHashHex, urlHashHex } from './hash.ts';
import { backoffSeconds } from './rate-limit.ts';
import type {
  AdminGateway,
  ArticleUpsertRow,
  IngestionCounts,
  LeasedSource,
} from './supabase-admin.ts';

/** Cron cadence for a healthy source (arch-001 §2: ingestion every 15 min). */
export const SUCCESS_INTERVAL_SECONDS = 15 * 60;
/** arch-001 §3: max concurrency 4, 20 sources per run. */
export const MAX_CONCURRENCY = 4;
export const MAX_SOURCES_PER_RUN = 20;
export const DEFAULT_SOURCES_PER_RUN = 10;
/** Bounded, non-sensitive error detail for `private.ingestion_runs`. */
export const MAX_ERROR_SUMMARY = 4000;

export type FeedFetchOutcome =
  | { kind: 'ok'; body: string; finalUrl: string; etag: string | null; lastModified: string | null }
  | { kind: 'not_modified'; etag: string | null; lastModified: string | null }
  | { kind: 'error'; code: string };

export type IngestDeps = {
  gateway: AdminGateway;
  /** Performs the guarded conditional GET. Never throws for expected failures. */
  fetchFeed: (source: LeasedSource) => Promise<FeedFetchOutcome>;
  now: () => Date;
  concurrency?: number;
  /** Injected for deterministic backoff under test. */
  random?: () => number;
};

export type SourceOutcome = {
  sourceId: string;
  slug: string;
  ok: boolean;
  /** Short code such as `http_503`, `parse_failed`, `not_modified`. */
  code: string;
  inserted: number;
  updated: number;
  unchanged: number;
  failedItems: number;
  skippedItems: number;
  /**
   * Emitted items that carry no body. Not a failure: it is how a
   * headlines-only feed looks. Surfaced so a run against Hugging Face reads
   * "845 inserted, 845 contentless" instead of looking like a silent bug.
   */
  contentlessItems: number;
};

export type IngestionResult = {
  run_id: string | null;
  sources_ok: number;
  sources_failed: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Per-source detail; useful in the coordinator's remote smoke. */
  outcomes: SourceOutcome[];
};

export type RunOptions = {
  trigger: 'cron' | 'manual';
  maxSources?: number;
  /**
   * arch-001 §3's optional `source_id`: sync exactly this source, whether or
   * not it is due. Used by the coordinator's remote smoke.
   */
  sourceId?: string;
};

/**
 * Lease, fetch, parse and upsert. Returns counts; never throws for a per-source
 * failure. It DOES propagate a failure to lease or to open the run, because
 * those mean the database is unreachable and there is nothing to report.
 */
export async function runIngestion(
  deps: IngestDeps,
  options: RunOptions,
): Promise<IngestionResult> {
  const maxSources = clampInt(
    options.maxSources ?? DEFAULT_SOURCES_PER_RUN,
    1,
    MAX_SOURCES_PER_RUN,
  );
  const concurrency = clampInt(deps.concurrency ?? MAX_CONCURRENCY, 1, MAX_CONCURRENCY);

  const sources = options.sourceId
    ? await deps.gateway.leaseSource(options.sourceId)
    : await deps.gateway.leaseDueSources(maxSources);
  if (sources.length === 0) {
    return {
      run_id: null,
      sources_ok: 0,
      sources_failed: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      outcomes: [],
    };
  }

  const runId = await deps.gateway.startIngestionRun(options.trigger);
  const outcomes = await mapWithConcurrency(sources, concurrency, (source) =>
    ingestOneSource(deps, source),
  );

  const counts: IngestionCounts = {
    sourcesOk: outcomes.filter((o) => o.ok).length,
    sourcesFailed: outcomes.filter((o) => !o.ok).length,
    inserted: sum(outcomes, (o) => o.inserted),
    updated: sum(outcomes, (o) => o.updated),
    unchanged: sum(outcomes, (o) => o.unchanged),
  };

  const errorSummary = summariseErrors(outcomes);

  // A failure to close the run must not lose the work that already landed.
  try {
    await deps.gateway.finishIngestionRun(runId, counts, errorSummary);
  } catch (cause) {
    // rev-003 N4: say it once, boundedly. Swallowing this silently left the
    // request log reporting a clean run while a stale `finished_at IS NULL`
    // row sat in a private table only someone already suspicious would query.
    // Run id and a short code, never feed or article content (arch-001 §3).
    console.warn(
      JSON.stringify({
        event: 'ingestion_run_close_failed',
        run_id: runId,
        code: cause instanceof Error ? cause.name.slice(0, 40) : 'unknown',
      }),
    );
    // Swallowed on purpose: the articles are committed, and the run row is
    // observability, not truth. The stale open row is visible in
    // private.ingestion_runs as finished_at IS NULL.
  }

  return {
    run_id: runId,
    sources_ok: counts.sourcesOk,
    sources_failed: counts.sourcesFailed,
    inserted: counts.inserted,
    updated: counts.updated,
    unchanged: counts.unchanged,
    outcomes,
  };
}

/** One source, fully isolated: this function never throws. */
export async function ingestOneSource(
  deps: IngestDeps,
  source: LeasedSource,
): Promise<SourceOutcome> {
  const base: SourceOutcome = {
    sourceId: source.id,
    slug: source.slug,
    ok: false,
    code: 'unknown',
    inserted: 0,
    updated: 0,
    unchanged: 0,
    failedItems: 0,
    skippedItems: 0,
    contentlessItems: 0,
  };

  try {
    const fetched = await deps.fetchFeed(source);

    if (fetched.kind === 'error') {
      await recordFailure(deps, source, fetched.code);
      return { ...base, code: fetched.code };
    }

    if (fetched.kind === 'not_modified') {
      await deps.gateway.updateSourceFetchState(source.id, {
        ok: true,
        etag: fetched.etag ?? source.etag,
        lastModified: fetched.lastModified ?? source.last_modified,
        nextFetchAt: addSeconds(deps.now(), SUCCESS_INTERVAL_SECONDS),
        errorCode: null,
      });
      return { ...base, ok: true, code: 'not_modified' };
    }

    const feed = parseFeed(fetched.body, fetched.finalUrl, { now: deps.now() });
    if (feed === null) {
      await recordFailure(deps, source, 'parse_failed');
      return { ...base, code: 'parse_failed' };
    }

    const skippedItems = Object.values(feed.skipped).reduce((a, b) => a + b, 0);
    const rows = await toArticleRows(feed.items, source);
    const result = await deps.gateway.upsertArticles(source.id, rows);

    await deps.gateway.updateSourceFetchState(source.id, {
      ok: true,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      nextFetchAt: addSeconds(deps.now(), SUCCESS_INTERVAL_SECONDS),
      errorCode: null,
    });

    return {
      ...base,
      ok: true,
      code: 'ok',
      inserted: result.inserted,
      updated: result.updated,
      unchanged: result.unchanged,
      failedItems: result.failed,
      skippedItems,
      contentlessItems: feed.contentless,
    };
  } catch (cause) {
    // Includes a failed upsert or a failed state write: the run continues.
    const code = shortCode(cause);
    await recordFailure(deps, source, code);
    return { ...base, code };
  }
}

/**
 * Record a failed fetch and back the source off.
 *
 * This never throws. Bookkeeping is not the failure: if the state write also
 * fails, the caller must still report the ORIGINAL reason ('timeout',
 * 'http_503', …) rather than the write's own error, or the run summary would
 * say 'internal_error' for exactly the case a human most needs to diagnose.
 * The un-updated source simply becomes due again when its 5-minute lease
 * expires.
 */
async function recordFailure(
  deps: IngestDeps,
  source: LeasedSource,
  code: string,
): Promise<void> {
  const attempt = (source.consecutive_failures ?? 0) + 1;
  const delay = backoffSeconds(attempt, { random: deps.random });
  try {
    await deps.gateway.updateSourceFetchState(source.id, {
      ok: false,
      etag: source.etag,
      lastModified: source.last_modified,
      nextFetchAt: addSeconds(deps.now(), delay),
      errorCode: code.slice(0, 128),
    });
  } catch {
    // Deliberate: see the note above.
  }
}

/**
 * Map parsed items onto insertable rows.
 *
 * `language` is inherited from the source rather than detected. All six seeded
 * feeds are single-language, and a wrong guess is worse than no guess: it would
 * make `process-enrichments` skip the Turkish translation of an English
 * article. Detection belongs with the AI task, which sees the text anyway.
 */
export async function toArticleRows(
  items: ParsedItem[],
  source: Pick<LeasedSource, 'language' | 'category'>,
): Promise<ArticleUpsertRow[]> {
  const rows: ArticleUpsertRow[] = [];
  for (const item of items) {
    // `aigundem.articles` CHECKs canonical_url against '^https://'; a feed
    // linking to http would fail the insert, so drop it here instead.
    if (!item.canonicalUrl.startsWith('https://')) continue;
    rows.push({
      external_id: item.externalId,
      canonical_url: item.canonicalUrl,
      url_hash: await urlHashHex(item.canonicalUrl),
      title: item.title,
      author: item.author,
      category: source.category,
      published_at: item.publishedAt,
      language: source.language,
      // Absent, not empty: a bodyless item stores NULL so the column says
      // "this feed publishes headlines" rather than "the body was blank".
      // The content hash is still computed over (title, ''), so a later
      // edit to the headline still invalidates any cached summary.
      content_text: item.contentText === '' ? null : item.contentText,
      content_quality: item.quality,
      content_hash: await contentHashHex(item.title, item.contentText),
      excerpt: item.excerpt === '' ? null : item.excerpt,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Bounded worker pool; preserves input order in the output. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = new Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    });
  await Promise.all(runners);
  return results;
}

function summariseErrors(outcomes: SourceOutcome[]): string | null {
  const failures = outcomes.filter((o) => !o.ok);
  if (failures.length === 0) return null;
  // Slug plus code only: no URLs, no bodies, no upstream error text.
  const summary = failures.map((o) => `${o.slug}=${o.code}`).join(', ');
  return summary.length <= MAX_ERROR_SUMMARY
    ? summary
    : `${summary.slice(0, MAX_ERROR_SUMMARY - 1)}…`;
}

function shortCode(cause: unknown): string {
  if (cause instanceof Error) {
    const name = cause.name === 'Error' ? 'internal_error' : cause.name;
    return name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 128);
  }
  return 'internal_error';
}

function addSeconds(from: Date, seconds: number): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
