/**
 * The digest's `prepare` phase: create the day's row, then ask for the
 * enrichments the day will need (P12).
 *
 * Portable: Web APIs only, no Deno globals, no SDK import, no clock of its own.
 * `build-digest/index.ts` is the Deno boundary that supplies `Deno.env`, the
 * Supabase client and `fetch`; everything decided here runs under Jest.
 *
 * WHY THIS FILE EXISTS. Before P12 the only caller of `internal_enqueue_ai_job*`
 * was `request-enrichment` — a summary existed because a human opened an
 * article. `internal_digest_prepare` counted enriched articles and reported
 * `missing: 5`, forever, because nothing was ever going to enrich them. The
 * digest now asks.
 *
 * THE MODEL STRING IS THE WHOLE POINT. The summary cache key is
 * `(article_id, content_hash, prompt_version, model)`. Prepare must enqueue
 * under the model `process-enrichments` will resolve, which is why the provider
 * is resolved here with P11's `resolveAiProvider` rather than defaulted: a
 * plausible-but-wrong model string would produce jobs the worker happily
 * executes and summaries no cache lookup ever matches again.
 *
 * PRE-ENRICHMENT IS AN OPTIMISATION, NEVER A PRECONDITION. Every way it can
 * fail — no provider key, migration 0012 not applied yet, the RPC erroring —
 * degrades to `enqueued: 0` plus a reason. The digest row is created either
 * way and `finalize` is untouched, so deploying this function before applying
 * 0012 is merely ineffective, not broken.
 */

import type { DigestCandidatesRow, DigestDb, DigestResultRow } from './digest.ts';
import { DigestDbError } from './digest.ts';

/** Per-source cap: how many of one feed's newest articles to enqueue. */
export const DIGEST_PER_SOURCE_ENV = 'DIGEST_PER_SOURCE';
/** Overall cap for one prepare run. */
export const DIGEST_CANDIDATES_ENV = 'DIGEST_CANDIDATES';

/**
 * Two per source, fifteen overall.
 *
 * Six active sources x 2 = 12, so the overall cap is not usually what binds;
 * it is there so that adding sources cannot silently multiply the daily spend.
 * Fifteen is also comfortably inside what the worker can drain between the
 * 02:45 UTC prepare and the 03:30 UTC finalize: `ai-gundem-ai-worker` runs
 * every 2 minutes with `max_jobs: 3` (migration 0008), so ~22 firings x 3 = 66
 * job slots stand between the two.
 */
export const DEFAULT_DIGEST_PER_SOURCE = 2;
export const DEFAULT_DIGEST_CANDIDATES = 15;

/** The ranges migration 0012 accepts. Anything else it rejects outright. */
export const MIN_DIGEST_PER_SOURCE = 1;
export const MAX_DIGEST_PER_SOURCE = 5;
export const MIN_DIGEST_CANDIDATES = 1;
export const MAX_DIGEST_CANDIDATES = 50;

/** The subset of an environment this needs (same shape as `SecretEnv`). */
export type DigestEnv = { get(name: string): string | undefined };

export type DigestLimits = { perSource: number; limit: number };

/**
 * Read the two knobs, clamped rather than validated.
 *
 * Deliberate: migration 0012 REJECTS an out-of-range argument, so passing a
 * typo'd `DIGEST_CANDIDATES=500` straight through would make the whole prepare
 * phase throw and the day's digest row would never be created. A daily job must
 * not be takeable down by a deploy variable. The SQL guard stays as the real
 * boundary; this clamp only ensures we never hand it something it refuses.
 *
 * Note that 0 is NOT an off switch — it clamps to 1. Nothing here disables
 * pre-enrichment; see agents/reports/p12.md for the levers that do.
 */
export function readDigestLimits(env: DigestEnv): DigestLimits {
  return {
    perSource: clampInt(
      env.get(DIGEST_PER_SOURCE_ENV),
      DEFAULT_DIGEST_PER_SOURCE,
      MIN_DIGEST_PER_SOURCE,
      MAX_DIGEST_PER_SOURCE,
    ),
    limit: clampInt(
      env.get(DIGEST_CANDIDATES_ENV),
      DEFAULT_DIGEST_CANDIDATES,
      MIN_DIGEST_CANDIDATES,
      MAX_DIGEST_CANDIDATES,
    ),
  };
}

/** Blank, non-numeric and fractional values fall back to the default. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const text = (raw ?? '').trim();
  if (text === '') return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * What `resolveAiProvider` returns, structurally.
 *
 * Typed here rather than imported so this module has no reason to pull in the
 * provider clients: prepare needs the model STRING and nothing else. It never
 * calls a model, and it never reads a key.
 */
export type ProviderChoice = { provider: string; model: string } | { provider: null };

/** Why nothing was enqueued, when nothing was. */
export type DigestEnqueueSkip = 'no_provider' | 'enqueue_failed';

export type DigestEnqueueReport = DigestCandidatesRow & {
  /** Which provider's model string the jobs were enqueued under. */
  provider: string | null;
  model: string | null;
  reason?: DigestEnqueueSkip;
};

export type DigestPrepareResult = {
  row: DigestResultRow;
  enqueue: DigestEnqueueReport;
};

export type DigestPrepareDeps = {
  db: Pick<DigestDb, 'prepare' | 'enqueueCandidates'>;
  /** P11's resolver, already bound to this invocation's env and Vault reader. */
  resolveProvider: () => Promise<ProviderChoice>;
  promptVersion: string;
  limits: DigestLimits;
};

const NOTHING: DigestCandidatesRow = { enqueued: 0, already: 0, candidates: 0 };

/**
 * Run the prepare phase: the digest row first, then its candidates.
 *
 * Order matters. `internal_digest_prepare` is what creates the `preparing` row
 * and reports readiness; it is the part that must always happen. Enqueueing is
 * what makes the NEXT finalize able to succeed, and every failure mode of it is
 * absorbed into the report rather than raised.
 */
export async function runDigestPrepare(
  deps: DigestPrepareDeps,
  date: string | null,
): Promise<DigestPrepareResult> {
  const row = await deps.db.prepare(date);

  const choice = await deps.resolveProvider();
  if (choice.provider === null) {
    // No key resolved anywhere. `process-enrichments` would answer
    // `skipped: no_api_key` for whatever we queued, so queueing is pure waste —
    // and we have no model string to queue it under in the first place.
    return {
      row,
      enqueue: { ...NOTHING, provider: null, model: null, reason: 'no_provider' },
    };
  }

  try {
    const counts = await deps.db.enqueueCandidates({
      date,
      model: choice.model,
      promptVersion: deps.promptVersion,
      perSource: deps.limits.perSource,
      limit: deps.limits.limit,
    });
    return {
      row,
      enqueue: { ...counts, provider: choice.provider, model: choice.model },
    };
  } catch (cause) {
    // Most likely cause on the day this ships: migration 0012 is not applied
    // yet, so the RPC 404s. That must not cost the project its digest row, so
    // the failure is reported and swallowed rather than propagated.
    if (!(cause instanceof DigestDbError)) throw cause;
    return {
      row,
      enqueue: {
        ...NOTHING,
        provider: choice.provider,
        model: choice.model,
        reason: 'enqueue_failed',
      },
    };
  }
}
