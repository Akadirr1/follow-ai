/**
 * Enrichment orchestration: the cache check, the job lifecycle, the retry
 * policy — all as pure functions over an injected database and Claude client.
 *
 * Portable: Web APIs only, no Deno globals, no SDK import. Both entry points
 * run under Jest against a fake db and a fake client, which is the only way
 * they can run at all: there is no Anthropic key in v1 (facts-2026-08-21) and
 * no database reachable from this task.
 *
 * Job states are P2's `private.job_status` domain: queued → leased →
 * ready | failed. The transition is owned by SQL — `private.lease_ai_jobs`
 * leases with SKIP LOCKED and stamps a `lease_token`, and every write-back
 * checks that token. A worker whose lease expired mid-call therefore cannot
 * overwrite the result of the worker that took over.
 */

import {
  ClaudeClient,
  EnrichmentFailureCode,
  TokenUsage,
} from './anthropic.ts';
import {
  AI_DAILY_CAP_DEFAULT,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  Effort,
  MAX_ARTICLE_CHARS_DEFAULT,
  MAX_TOKENS_DEFAULT,
  MAX_TOKENS_ESCALATED,
  POLL_AFTER_SECONDS,
  POLL_AFTER_SECONDS_NO_KEY,
} from './anthropic-config.ts';
import { PROMPT_VERSION } from './prompt.ts';
import {
  backoffSeconds,
  DAY_SECONDS,
  HOUR_SECONDS,
  RateLimitAction,
  windowFor,
} from './rate-limit.ts';
import { ArticleLanguage, TranslationState, translationStateFor } from './schemas.ts';

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/** P3's actions plus the global Claude budget counter. */
export type EnrichmentAction = RateLimitAction | 'ai_call';

/** arch-001 §3: "120 cached checks/hour and 30 new misses/device/24h". */
export const CHECK_POLICY = {
  action: 'request_enrichment_check' as const,
  limit: 120,
  windowSeconds: HOUR_SECONDS,
};
export const MISS_POLICY = {
  action: 'request_enrichment_miss' as const,
  limit: 30,
  windowSeconds: DAY_SECONDS,
};

/** Backoff for a failed enrichment: faster than the 15-minute feed cadence. */
export const AI_BACKOFF_BASE_SECONDS = 60;
export const AI_BACKOFF_MAX_SECONDS = 60 * 60;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type SummaryRow = {
  article_id: string;
  /** 64 hex characters; the SQL side decodes to bytea. */
  content_hash: string;
  prompt_version: string;
  model: string;
  summary_tr: string[];
  translation_tr: string | null;
  translation_state: TranslationState;
};

export type ArticleForEnrichment = {
  article_id: string;
  content_hash: string;
  title: string;
  language: ArticleLanguage;
  content_text: string;
  content_quality: 'full' | 'excerpt';
  source_name: string;
};

/** A leased job joined to the article it is about — one round trip, not two. */
export type EnrichmentJob = ArticleForEnrichment & {
  job_id: string;
  lease_token: string;
  prompt_version: string;
  model: string;
  attempt_count: number;
  max_attempts: number;
  last_error_code: string | null;
};

export type EnqueueResult = { job_id: string; status: string; created: boolean };

export type ChargedEnqueueResult = EnqueueResult & {
  /** True only when this call actually spent one of the caller's misses. */
  charged: boolean;
  /** False when the budget was spent; no job was created in that case. */
  allowed: boolean;
};

export interface EnrichmentDb {
  findSummary(
    articleId: string,
    contentHash: string,
    promptVersion: string,
    model: string,
  ): Promise<SummaryRow | null>;
  findArticle(articleId: string): Promise<ArticleForEnrichment | null>;
  enqueueJob(input: {
    articleId: string;
    contentHash: string;
    promptVersion: string;
    model: string;
  }): Promise<EnqueueResult>;
  leaseJobs(n: number): Promise<EnrichmentJob[]>;
  /** False when the lease was lost — another worker owns the job now. */
  completeJob(jobId: string, leaseToken: string, summary: SummaryRow): Promise<boolean>;
  retryJob(
    jobId: string,
    leaseToken: string,
    availableAt: string,
    errorCode: string,
  ): Promise<boolean>;
  failJob(jobId: string, leaseToken: string, errorCode: string): Promise<boolean>;
  /**
   * Return a leased job to the queue AND give back the attempt that leasing
   * consumed. Only for deferrals that made no Claude call — see the cap path.
   */
  releaseJobUnattempted(
    jobId: string,
    leaseToken: string,
    availableAt: string,
    errorCode: string,
  ): Promise<boolean>;
  /**
   * Atomic "return the existing job, or charge and create a new one". Replaces
   * bump-then-enqueue so polling an existing job costs no quota (rev-003 N1).
   */
  enqueueJobCharged(input: {
    articleId: string;
    contentHash: string;
    promptVersion: string;
    model: string;
    subject: string;
    action: EnrichmentAction;
    windowStart: string;
    limit: number;
  }): Promise<ChargedEnqueueResult>;
  bumpRateLimit(
    subject: string,
    action: EnrichmentAction,
    windowStart: string,
    limit: number,
  ): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// request-enrichment
// ---------------------------------------------------------------------------

export type RequestEnrichmentDeps = {
  db: EnrichmentDb;
  now: () => Date;
  model?: string;
  promptVersion?: string;
  /** False when ANTHROPIC_API_KEY is unset (addendum §E). */
  hasApiKey: boolean;
};

/**
 * `reason` explains a non-ready answer without adding a new `status` the client
 * lane would have to learn. `previous_attempt_failed` is the honest label for a
 * job that already exhausted its attempts: the answer is still `queued` (so an
 * existing client keeps rendering "hazırlanıyor" rather than breaking on an
 * unknown status), but the field says plainly that nothing is coming without an
 * operator requeue.
 */
export type QueuedReason = 'no_api_key' | 'previous_attempt_failed';

export type RequestEnrichmentResult =
  | { status: 'ready'; summary: SummaryRow }
  /**
   * The article has no body to summarise — the feed published a headline and a
   * link and nothing else (Hugging Face). TERMINAL and cacheable: no job is
   * enqueued, because no amount of retrying produces a body, and the client
   * shows "Bu haber için özet üretilemiyor" with a link to the source instead
   * of a spinner that never resolves.
   */
  | { status: 'unavailable'; reason: 'no_content' }
  | { status: 'queued'; pollAfterSeconds: number; reason?: QueuedReason; jobId: string }
  | { status: 'rate_limited'; retryAfterSeconds: number; scope: 'check' | 'miss' }
  | { status: 'not_found' };

/**
 * Answer a client's "enrich this article" request.
 *
 * The two counters are separate on purpose. A cached hit is nearly free, so it
 * gets a generous hourly allowance; a miss costs a Claude call, so it gets a
 * tight daily one. Charging a cache hit against the expensive budget would let
 * a user who scrolls a lot exhaust their own enrichment quota reading
 * already-summarised articles.
 *
 * The cache key uses the article's CURRENT `content_hash`, so a rewritten
 * article misses by construction — no invalidation step, no stale summary.
 */
export async function requestEnrichment(
  deps: RequestEnrichmentDeps,
  input: { articleId: string; deviceId: string },
): Promise<RequestEnrichmentResult> {
  const now = deps.now();
  const model = deps.model ?? DEFAULT_MODEL;
  const promptVersion = deps.promptVersion ?? PROMPT_VERSION;

  const checkWindow = windowFor(now, CHECK_POLICY.windowSeconds);
  const checkAllowed = await deps.db.bumpRateLimit(
    input.deviceId,
    CHECK_POLICY.action,
    checkWindow.windowStart,
    CHECK_POLICY.limit,
  );
  if (!checkAllowed) {
    return {
      status: 'rate_limited',
      retryAfterSeconds: checkWindow.retryAfterSeconds,
      scope: 'check',
    };
  }

  const article = await deps.db.findArticle(input.articleId);
  if (!article) return { status: 'not_found' };

  const existing = await deps.db.findSummary(
    article.article_id,
    article.content_hash,
    promptVersion,
    model,
  );
  if (existing) return { status: 'ready', summary: existing };

  // Nothing to summarise. Checked AFTER the cache so an article enriched before
  // its body went missing still serves its stored summary, and BEFORE the miss
  // budget so a user browsing a headlines-only source is not charged for an
  // answer that costs no Claude call at all.
  if (!hasEnrichableBody(article)) {
    return { status: 'unavailable', reason: 'no_content' };
  }

  // rev-003 N1: charging and enqueueing are ONE atomic call. The old order
  // charged the daily budget and only then discovered whether the job already
  // existed, so a client following the poll interval it was handed spent quota
  // on work that was already queued — 2.5 hours to exhaust a day at the no-key
  // interval. Now an existing job comes back uncharged, and only a genuinely
  // new one costs a miss.
  const missWindow = windowFor(now, MISS_POLICY.windowSeconds);
  const job = await deps.db.enqueueJobCharged({
    articleId: article.article_id,
    contentHash: article.content_hash,
    promptVersion,
    model,
    subject: input.deviceId,
    action: MISS_POLICY.action,
    windowStart: missWindow.windowStart,
    limit: MISS_POLICY.limit,
  });

  if (!job.allowed) {
    return {
      status: 'rate_limited',
      retryAfterSeconds: missWindow.retryAfterSeconds,
      scope: 'miss',
    };
  }

  // A job that already exhausted its attempts is terminal — `enqueueJob` does
  // not revive it — so telling the client to poll again in 30 seconds would be
  // a lie. Say why, and slow the poll down.
  const exhausted = job.status === 'failed';
  const reason: QueuedReason | undefined = !deps.hasApiKey
    ? 'no_api_key'
    : exhausted
      ? 'previous_attempt_failed'
      : undefined;

  return {
    status: 'queued',
    jobId: job.job_id,
    pollAfterSeconds:
      reason === undefined ? POLL_AFTER_SECONDS : POLL_AFTER_SECONDS_NO_KEY,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Is there anything for Claude to read?
 *
 * `internal_find_article_for_enrichment` and `internal_lease_enrichment_jobs`
 * both return `coalesce(nullif(content_text, ''), excerpt, '')`, so an empty
 * string here already means "no body AND no excerpt" — one check covers both
 * columns, and it reads the same whether the row stores NULL or ''.
 */
export function hasEnrichableBody(article: Pick<ArticleForEnrichment, 'content_text'>): boolean {
  return (article.content_text ?? '').trim() !== '';
}

// ---------------------------------------------------------------------------
// process-enrichments
// ---------------------------------------------------------------------------

export type ProcessDeps = {
  db: EnrichmentDb;
  client: ClaudeClient;
  now: () => Date;
  random?: () => number;
  hasApiKey: boolean;
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  maxTokensEscalated?: number;
  maxArticleChars?: number;
  dailyCap?: number;
};

export type JobDisposition = 'ready' | 'retried' | 'failed' | 'lease_lost';

export type JobOutcome = {
  jobId: string;
  articleId: string;
  disposition: JobDisposition;
  /** Short code; never article text. */
  code: string;
  attempt: number;
  usage?: TokenUsage;
  /**
   * The model that actually produced the summary, as the provider reported it.
   *
   * Usually identical to the job's model. It differs when the fallback provider
   * answered, and that is the only place the difference is visible — the row
   * keeps the job's model so the cache key stays the one `request-enrichment`
   * looks up. See agents/reports/p11.md.
   */
  usedModel?: string;
};

export type ProcessResult = {
  /**
   * `disabled` is the operator kill switch (AI_DAILY_CAP=0), distinct from
   * `daily_cap` (budget spent for today) and from `no_api_key`. All three
   * touch no jobs; only the reason differs.
   */
  skipped?: 'no_api_key' | 'daily_cap' | 'disabled';
  ready: number;
  retried: number;
  failed: number;
  outcomes: JobOutcome[];
};

export const MAX_JOBS_PER_RUN = 3;

/**
 * Lease, enrich, write back.
 *
 * With no API key this touches nothing at all — it does not lease, so jobs stay
 * `queued` with `attempt_count` untouched and become workable the moment a key
 * appears (addendum §E). Leasing first and failing would burn five attempts per
 * article and mark the backlog `failed` before Claude was ever reachable.
 */
export async function processEnrichments(
  deps: ProcessDeps,
  options: { maxJobs?: number } = {},
): Promise<ProcessResult> {
  const empty: ProcessResult = { ready: 0, retried: 0, failed: 0, outcomes: [] };

  if (!deps.hasApiKey) {
    return { ...empty, skipped: 'no_api_key' };
  }

  // rev-003 N3: AI_DAILY_CAP=0 is an operator kill switch, and it has to be
  // honoured BEFORE leasing. The config layer accepts 0 but
  // `private.bump_rate_limit` rejects any limit below 1, so the old order
  // leased jobs — incrementing their attempts — and then turned the cap check
  // into a function error. Nothing is touched here.
  const dailyCap = deps.dailyCap ?? AI_DAILY_CAP_DEFAULT;
  if (dailyCap <= 0) {
    return { ...empty, skipped: 'disabled' };
  }

  const maxJobs = clampInt(options.maxJobs ?? 1, 1, MAX_JOBS_PER_RUN);
  const jobs = await deps.db.leaseJobs(maxJobs);
  if (jobs.length === 0) return empty;

  const now = deps.now();
  const dayWindow = windowFor(now, DAY_SECONDS);
  const outcomes: JobOutcome[] = [];
  let cappedOut = false;

  for (const job of jobs) {
    if (cappedOut) {
      // Everything still leased goes back to the queue, unattempted.
      outcomes.push(await requeueForCap(deps, job, dayWindow.retryAfterSeconds));
      continue;
    }

    // arch-001 §7 risk 2: a global daily cap, counted in Postgres so it holds
    // across instances. This increments even when it then refuses — a fixed
    // window resets daily, and over-counting a day that is already over budget
    // costs nothing.
    const underCap = await deps.db.bumpRateLimit(
      'global',
      'ai_call',
      dayWindow.windowStart,
      dailyCap,
    );
    if (!underCap) {
      cappedOut = true;
      outcomes.push(await requeueForCap(deps, job, dayWindow.retryAfterSeconds));
      continue;
    }

    outcomes.push(await runOneJob(deps, job));
  }

  return {
    ...(cappedOut ? { skipped: 'daily_cap' as const } : {}),
    ready: outcomes.filter((o) => o.disposition === 'ready').length,
    retried: outcomes.filter((o) => o.disposition === 'retried').length,
    failed: outcomes.filter((o) => o.disposition === 'failed').length,
    outcomes,
  };
}

/** One job, fully isolated: never throws, so one bad article cannot end a run. */
export async function runOneJob(
  deps: ProcessDeps,
  job: EnrichmentJob,
): Promise<JobOutcome> {
  const base = { jobId: job.job_id, articleId: job.article_id, attempt: job.attempt_count };

  // Defensive: `request-enrichment` no longer enqueues a bodyless article, but
  // a job queued before that rule existed is still sitting in the table. Fail
  // it terminally rather than paying Claude to summarise an empty string —
  // retrying cannot help, because the body is not coming.
  if (!hasEnrichableBody(job)) {
    const failed = await deps.db.failJob(job.job_id, job.lease_token, 'no_content');
    return failed
      ? { ...base, disposition: 'failed', code: 'no_content' }
      : { ...base, disposition: 'lease_lost', code: 'lease_lost' };
  }

  // The one-escalation rule: a job whose previous attempt was truncated gets a
  // bigger ceiling now. If it truncates AGAIN it is failed rather than retried,
  // because a third attempt at the same request would truncate too.
  const alreadyEscalated = job.last_error_code === 'output_truncated';
  const maxTokens = alreadyEscalated
    ? (deps.maxTokensEscalated ?? MAX_TOKENS_ESCALATED)
    : (deps.maxTokens ?? MAX_TOKENS_DEFAULT);

  let outcome;
  try {
    outcome = await deps.client.summarise({
      article: {
        title: job.title,
        sourceName: job.source_name,
        language: job.language,
        contentText: job.content_text,
        contentQuality: job.content_quality,
      },
      model: job.model,
      maxTokens,
      effort: deps.effort ?? DEFAULT_EFFORT,
      maxArticleChars: deps.maxArticleChars ?? MAX_ARTICLE_CHARS_DEFAULT,
    });
  } catch (cause) {
    // The client is supposed to return failures as values; a throw here is a
    // bug in the adapter, not an article problem. Treat it as transient.
    outcome = {
      ok: false as const,
      code: 'unknown' as EnrichmentFailureCode,
      retryable: true,
      detail: cause instanceof Error ? cause.name.slice(0, 40) : undefined,
    };
  }

  if (outcome.ok) {
    const summary: SummaryRow = {
      article_id: job.article_id,
      content_hash: job.content_hash,
      prompt_version: job.prompt_version,
      model: job.model,
      summary_tr: outcome.payload.summary,
      translation_tr: outcome.payload.translation,
      translation_state: translationStateFor(job.language),
    };
    const written = await deps.db.completeJob(job.job_id, job.lease_token, summary);
    const used = outcome.model ?? undefined;
    return written
      ? { ...base, disposition: 'ready', code: 'ok', usage: outcome.usage, usedModel: used }
      : {
          ...base,
          disposition: 'lease_lost',
          code: 'lease_lost',
          usage: outcome.usage,
          usedModel: used,
        };
  }

  const truncatedTwice = outcome.code === 'output_truncated' && alreadyEscalated;
  const attemptsLeft = job.attempt_count < job.max_attempts;
  const shouldRetry = outcome.retryable && attemptsLeft && !truncatedTwice;

  if (shouldRetry) {
    // A provider that told us how long to wait outranks our own backoff, but
    // only upwards: Google's free tier answers a 429 with a real Retry-After,
    // and retrying earlier than it asked just spends the next slot on another
    // 429. Capped, so a hostile or mistaken header cannot park a job for a week.
    const backoff = backoffSeconds(job.attempt_count, {
      baseSeconds: AI_BACKOFF_BASE_SECONDS,
      maxSeconds: AI_BACKOFF_MAX_SECONDS,
      random: deps.random,
    });
    const asked = Math.min(outcome.retryAfterSeconds ?? 0, AI_BACKOFF_MAX_SECONDS);
    const delay = Math.max(backoff, asked);
    const availableAt = addSeconds(deps.now(), delay);
    const ok = await deps.db.retryJob(job.job_id, job.lease_token, availableAt, outcome.code);
    return ok
      ? { ...base, disposition: 'retried', code: outcome.code }
      : { ...base, disposition: 'lease_lost', code: 'lease_lost' };
  }

  const ok = await deps.db.failJob(job.job_id, job.lease_token, outcome.code);
  return ok
    ? { ...base, disposition: 'failed', code: outcome.code }
    : { ...base, disposition: 'lease_lost', code: 'lease_lost' };
}

/**
 * Put a leased-but-unattempted job back, and give back the attempt.
 *
 * rev-003 B1: this comment used to claim "without consuming an attempt" while
 * calling the ordinary retry RPC, which clears the lease and leaves the
 * increment leasing made. Every capped worker firing therefore burned an
 * attempt on three jobs Claude never saw; a job at four attempts came back at
 * five, and private.lease_ai_jobs requires attempt_count < max_attempts, so it
 * was stranded forever — never summarised, never failed, invisible.
 *
 * releaseJobUnattempted is the explicit inverse of leasing and is used ONLY
 * here, where no Claude call was made. Every other path keeps the increment,
 * because it really did spend an attempt.
 */
async function requeueForCap(
  deps: ProcessDeps,
  job: EnrichmentJob,
  retryAfterSeconds: number,
): Promise<JobOutcome> {
  const availableAt = addSeconds(deps.now(), retryAfterSeconds);
  const ok = await deps.db.releaseJobUnattempted(
    job.job_id,
    job.lease_token,
    availableAt,
    'daily_cap',
  );
  return {
    jobId: job.job_id,
    articleId: job.article_id,
    attempt: job.attempt_count,
    disposition: ok ? 'retried' : 'lease_lost',
    code: ok ? 'daily_cap' : 'lease_lost',
  };
}

// ---------------------------------------------------------------------------

function addSeconds(from: Date, seconds: number): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
