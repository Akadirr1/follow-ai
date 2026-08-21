/**
 * The daily digest: window arithmetic, request validation, and the ranking
 * algorithm.
 *
 * Portable: Web APIs only, no Deno globals, no SDK import, no clock of its own.
 *
 * NO CLAUDE IS INVOLVED. A blurb is the first bullet of a summary that
 * `process-enrichments` already produced and stored. That is what makes a digest
 * buildable today, with no Anthropic key in existence: if five enriched articles
 * exist the digest completes, and if they do not it stays `preparing` rather
 * than inventing anything (addendum §E).
 *
 * ON THE RANKER LIVING TWICE — read this before trusting the tests. The ranking
 * that RUNS is the SQL in `202608210008_digest_and_cron.sql`; it has to be, so
 * that selection and insertion share one snapshot and one transaction.
 * `rankDigestCandidates` below is the same algorithm written out in TypeScript,
 * and it is what the tests exercise. It is a specification and a mirror, NOT the
 * code path production takes. `supabase/tests/sql-lint-p5.test.ts` pins the
 * SQL's ordering clauses so the two cannot drift silently, but genuine
 * equivalence is unproven without a database and is listed as NOT VERIFIED in
 * agents/reports/p5.md.
 */

/** arch-001 §1: one global digest per Europe/Istanbul day. */
export const DIGEST_TIMEZONE = 'Europe/Istanbul';

/**
 * Istanbul has been permanently UTC+3 since September 2016 — the country
 * abolished seasonal clock changes, so there is no DST transition to model and
 * a fixed offset is correct rather than a shortcut. If Türkiye ever reinstates
 * DST this constant is the single thing that breaks, which is why it is a named
 * constant and not an inline `+03`.
 */
export const ISTANBUL_UTC_OFFSET_HOURS = 3;

/**
 * The window closes at 05:00 Istanbul on the digest's own date, and opens 24
 * hours earlier.
 *
 * Anchored to the DATE, never to when the job happened to run: a manual re-run,
 * a retry at 03:50 UTC, and a backfill for last Tuesday all compute the same
 * window, which is what makes finalize idempotent.
 *
 * 05:00 rather than midnight because the audience is Turkish and the sources are
 * mostly American: OpenAI, Anthropic and DeepMind publish during US business
 * hours, which is Istanbul evening and night. A midnight-anchored window would
 * push a story posted at 01:00 Istanbul into the *following* day's digest, a
 * full extra day late. Closing at 05:00 — 45 minutes before the prepare job at
 * 05:45 Istanbul — captures the overnight US cycle in the morning read.
 */
export const DIGEST_WINDOW_END_LOCAL_HOUR = 5;

/** arch-001 §2: positions 1–5. A digest is all five items or none. */
export const DIGEST_ITEM_COUNT = 5;

/** `digest_items_blurb_length` caps `blurb_tr` at 600 characters. */
export const MAX_BLURB_CHARS = 600;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type DigestWindow = {
  /** Inclusive, ISO 8601 UTC. */
  windowStart: string;
  /** Exclusive, ISO 8601 UTC. */
  windowEnd: string;
};

export class DigestDateError extends Error {}

/** True for a real calendar date in `YYYY-MM-DD` form. */
export function isDigestDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // Rejects 2026-02-30, which `Date` would silently roll into March.
  return parsed.toISOString().slice(0, 10) === value;
}

/**
 * The UTC instants bounding a digest date's window.
 *
 * `2026-08-21` → [`2026-08-20T02:00:00Z`, `2026-08-21T02:00:00Z`), i.e. 05:00
 * Istanbul on the 20th to 05:00 Istanbul on the 21st.
 */
export function digestWindow(date: string): DigestWindow {
  if (!isDigestDate(date)) {
    throw new DigestDateError(`Not a YYYY-MM-DD date: ${String(date)}`);
  }
  const localMidnightUtc = Date.parse(`${date}T00:00:00Z`);
  const endMs =
    localMidnightUtc +
    (DIGEST_WINDOW_END_LOCAL_HOUR - ISTANBUL_UTC_OFFSET_HOURS) * HOUR_MS;
  return {
    windowStart: new Date(endMs - DAY_MS).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
  };
}

/**
 * The Istanbul calendar date at a given instant — the digest date a cron firing
 * with no explicit `digest_date` is asking for.
 *
 * Computed by shifting the instant, not by `toLocaleDateString`: the latter
 * depends on the runtime's ICU data being present and correct, which is one
 * more thing that can differ between Node and the Edge runtime.
 */
export function istanbulDateFor(now: Date): string {
  return new Date(now.getTime() + ISTANBUL_UTC_OFFSET_HOURS * HOUR_MS)
    .toISOString()
    .slice(0, 10);
}

/** arch-001 §3 request body. */
export type DigestPhase = 'prepare' | 'finalize';

export type DigestRequest = {
  /** Null means "the Istanbul date now", resolved by the caller. */
  digestDate: string | null;
  phase: DigestPhase;
};

export type DigestRequestResult =
  | { ok: true; value: DigestRequest }
  | { ok: false; reason: 'phase_missing' | 'phase_invalid' | 'date_invalid' };

/** Validate `{digest_date?, phase}` without throwing. */
export function parseDigestRequest(fields: {
  digest_date?: unknown;
  phase?: unknown;
}): DigestRequestResult {
  const phase = fields.phase;
  if (phase === undefined || phase === null) {
    return { ok: false, reason: 'phase_missing' };
  }
  if (phase !== 'prepare' && phase !== 'finalize') {
    return { ok: false, reason: 'phase_invalid' };
  }

  const rawDate = fields.digest_date;
  if (rawDate === undefined || rawDate === null) {
    return { ok: true, value: { digestDate: null, phase } };
  }
  if (!isDigestDate(rawDate)) {
    return { ok: false, reason: 'date_invalid' };
  }
  return { ok: true, value: { digestDate: rawDate, phase } };
}

/** The headline a completed digest carries. */
export function headlineFor(date: string): string {
  return `Bugünün AI Gündemi · ${date}`;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** One enriched article eligible for a digest. */
export type DigestCandidate = {
  articleId: string;
  sourceId: string;
  /** ISO 8601. */
  publishedAt: string;
  /** The article's summary bullets; `summary[0]` becomes the blurb. */
  summary: readonly string[];
};

export type RankedDigestItem = {
  position: number;
  articleId: string;
  sourceId: string;
  blurb: string;
};

/**
 * Order candidates by (per-source recency rank, published_at desc, id desc).
 *
 * The effect is round-robin by source: every source's newest article first
 * (newest of those first), then every source's second-newest, and so on. Five
 * different sources therefore produce five different sources; a day where only
 * two sources published still fills five slots rather than returning three.
 * That is the "max one per source first, then fill" rule, generalised so it
 * keeps working at two passes or four.
 *
 * The order is TOTAL, which is what makes it deterministic: `published_at` can
 * tie — arXiv stamps a whole batch with the same minute — so `articleId`
 * breaks it, and article ids are unique. Same input, same five items, same
 * positions, every run.
 */
export function rankDigestCandidates(
  candidates: readonly DigestCandidate[],
  limit: number = DIGEST_ITEM_COUNT,
): RankedDigestItem[] {
  const perSourceRank = new Map<string, number>();

  const ordered = [...candidates]
    .sort(compareByRecency)
    .map((candidate) => {
      const seen = (perSourceRank.get(candidate.sourceId) ?? 0) + 1;
      perSourceRank.set(candidate.sourceId, seen);
      return { candidate, sourceRank: seen };
    })
    .sort((a, b) =>
      a.sourceRank !== b.sourceRank
        ? a.sourceRank - b.sourceRank
        : compareByRecency(a.candidate, b.candidate),
    );

  return ordered.slice(0, Math.max(0, limit)).map((entry, index) => ({
    position: index + 1,
    articleId: entry.candidate.articleId,
    sourceId: entry.candidate.sourceId,
    blurb: blurbFor(entry.candidate),
  }));
}

/** Newest first; ties broken by descending id so the order is total. */
function compareByRecency(a: DigestCandidate, b: DigestCandidate): number {
  const byTime = Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  if (byTime !== 0) return byTime;
  return a.articleId < b.articleId ? 1 : a.articleId > b.articleId ? -1 : 0;
}

/**
 * The blurb is the summary's first bullet, trimmed and capped.
 *
 * Not generated, not re-summarised: the digest path never calls Claude, so a
 * digest can be built with no API key at all.
 */
export function blurbFor(candidate: DigestCandidate): string {
  const first = (candidate.summary[0] ?? '').trim();
  return first.length <= MAX_BLURB_CHARS ? first : `${first.slice(0, MAX_BLURB_CHARS - 1)}…`;
}

export type DigestOutcome = {
  status: 'preparing' | 'ready';
  items: RankedDigestItem[];
  /** How many more enriched articles the window needs. Zero when ready. */
  missing: number;
};

/**
 * Decide what a finalize attempt should do.
 *
 * All five or none: a digest is only written once the window holds five enriched
 * candidates, so `digest_items` is never partially populated. Partial rows would
 * be invisible anyway (P2's RLS shows items only for a `ready` digest), but
 * "empty until complete" is a state that cannot be misread.
 */
export function planDigest(
  candidates: readonly DigestCandidate[],
  limit: number = DIGEST_ITEM_COUNT,
): DigestOutcome {
  if (candidates.length < limit) {
    return { status: 'preparing', items: [], missing: limit - candidates.length };
  }
  return { status: 'ready', items: rankDigestCandidates(candidates, limit), missing: 0 };
}

// ---------------------------------------------------------------------------
// Database adapter
// ---------------------------------------------------------------------------

/** The one method of `@supabase/supabase-js` this needs (P3's seam). */
export interface DigestClient {
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

/** What both wrappers return, and what the function echoes to the caller. */
export type DigestResultRow = {
  digest_date: string;
  status: string;
  item_count: number;
  missing: number;
};

/**
 * What `internal_enqueue_digest_candidates` (migration 0012) reports.
 *
 * `candidates` is the size of the selected set, `enqueued` how many of them
 * were new jobs, and `already` the rest — a job for that exact
 * (article, content_hash, prompt_version, model) already existed in some state.
 * A second prepare on the same day is therefore expected to read
 * `enqueued: 0, already: n`, which is what idempotence looks like from outside.
 */
export type DigestCandidatesRow = {
  enqueued: number;
  already: number;
  candidates: number;
};

export type DigestDb = {
  prepare(date: string | null): Promise<DigestResultRow>;
  finalize(date: string | null): Promise<DigestResultRow>;
  /**
   * Asks the database to enqueue the window's un-summarised articles (P12).
   *
   * The model MUST be the one the worker will resolve, not a plausible default:
   * it is half the summary cache key, so a mismatch produces summaries that
   * `internal_digest_finalize` — which joins on the article's own content_hash
   * only — would pick up, but that `request-enrichment` would never find again.
   */
  enqueueCandidates(input: {
    date: string | null;
    model: string;
    promptVersion: string;
    perSource: number;
    limit: number;
  }): Promise<DigestCandidatesRow>;
  /** Reads the Vault secret through the allow-listed wrapper. */
  getSetting(name: string): Promise<string | null>;
};

export class DigestDbError extends Error {}

/**
 * `DigestDb` over the `aigundem.internal_*` wrappers, using P3's routing: an
 * `rpcPrefix` so the functions call `public.aigundem_internal_*` today and
 * `aigundem.internal_*` once a human exposes the schema (addendum §C.1).
 *
 * The RPC names here are asserted against migration 0008 by
 * `supabase/tests/sql-lint-p5.test.ts`; a typo would otherwise surface as a 404
 * on the live project, after a deploy.
 */
export function createDigestDb(
  client: DigestClient,
  options: { rpcPrefix?: string } = {},
): DigestDb {
  const prefix = options.rpcPrefix ?? '';

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const fn = `${prefix}${name}`;
    const { data, error } = await client.rpc(fn, args);
    if (error) {
      // The message can quote a row; keep it out of the response (arch-001 §3).
      throw new DigestDbError(`Database call ${fn} failed.`);
    }
    return data as T;
  }

  const firstRow = <T>(data: T[] | T | null, what = 'Digest wrapper'): T => {
    const row = Array.isArray(data) ? (data[0] ?? null) : data;
    if (row === null || row === undefined) {
      throw new DigestDbError(`${what} returned no row.`);
    }
    return row;
  };

  return {
    async prepare(date) {
      return firstRow(
        await call<DigestResultRow[] | DigestResultRow | null>('internal_digest_prepare', {
          p_date: date,
        }),
      );
    },

    async finalize(date) {
      return firstRow(
        await call<DigestResultRow[] | DigestResultRow | null>('internal_digest_finalize', {
          p_date: date,
        }),
      );
    },

    async enqueueCandidates(input) {
      return firstRow(
        await call<DigestCandidatesRow[] | DigestCandidatesRow | null>(
          'internal_enqueue_digest_candidates',
          {
            p_date: input.date,
            p_model: input.model,
            p_prompt_version: input.promptVersion,
            p_per_source: input.perSource,
            p_limit: input.limit,
          },
        ),
        'Candidate enqueue',
      );
    },

    async getSetting(name) {
      const value = await call<string | null>('internal_get_setting', { p_name: name });
      return typeof value === 'string' && value !== '' ? value : null;
    },
  };
}
