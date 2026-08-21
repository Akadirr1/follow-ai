/**
 * Enrichment orchestration: the cache, both budgets, the job state machine and
 * the concurrency guard.
 *
 * Fake database, fake Claude client. There is no Anthropic key in v1 and no
 * database reachable from this task, so a fake client is not a convenience —
 * it is the only implementation of `ClaudeClient` that can execute here.
 */
import type { ClaudeClient, ClaudeOutcome } from '../functions/_shared/anthropic.ts';
import {
  AI_BACKOFF_BASE_SECONDS,
  CHECK_POLICY,
  MISS_POLICY,
  processEnrichments,
  requestEnrichment,
  type EnrichmentDb,
  type EnrichmentJob,
  type SummaryRow,
} from '../functions/_shared/enrichment.ts';
import { createEnrichmentDb } from '../functions/_shared/enrichment-db.ts';
import {
  MAX_TOKENS_DEFAULT,
  MAX_TOKENS_ESCALATED,
} from '../functions/_shared/anthropic-config.ts';

const NOW = new Date('2026-08-21T12:00:00Z');
const ARTICLE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const LEASE = '33333333-3333-4333-8333-333333333333';
const HASH = 'ab'.repeat(32);
const DEVICE = '44444444-4444-4444-8444-444444444444';

const ARTICLE = {
  article_id: ARTICLE_ID,
  content_hash: HASH,
  title: 'A model shipped',
  language: 'en' as const,
  content_text: 'Body text.',
  content_quality: 'full' as const,
  source_name: 'OpenAI Blog',
};

const SUMMARY: SummaryRow = {
  article_id: ARTICLE_ID,
  content_hash: HASH,
  prompt_version: 'v1',
  model: 'claude-opus-5',
  summary_tr: ['bir', 'iki', 'üç'],
  translation_tr: 'çeviri',
  translation_state: 'ready',
};

function job(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    ...ARTICLE,
    job_id: JOB_ID,
    lease_token: LEASE,
    prompt_version: 'v1',
    model: 'claude-opus-5',
    attempt_count: 1,
    max_attempts: 5,
    last_error_code: null,
    ...overrides,
  };
}

type Call = { fn: string; args: unknown };

type FakeOptions = {
  article?: typeof ARTICLE | null;
  summary?: SummaryRow | null;
  jobs?: EnrichmentJob[];
  enqueueStatus?: string;
  enqueueCreated?: boolean;
  /** Return false to simulate a lost lease. */
  writeSucceeds?: boolean;
  /** Per-action allow/deny for bumpRateLimit. */
  limits?: Record<string, boolean>;
};

function fakeDb(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const db: EnrichmentDb = {
    async findArticle(articleId) {
      calls.push({ fn: 'findArticle', args: articleId });
      return options.article === undefined ? ARTICLE : options.article;
    },
    async findSummary(articleId, contentHash, promptVersion, model) {
      calls.push({ fn: 'findSummary', args: { articleId, contentHash, promptVersion, model } });
      return options.summary ?? null;
    },
    async enqueueJob(input) {
      calls.push({ fn: 'enqueueJob', args: input });
      return {
        job_id: JOB_ID,
        status: options.enqueueStatus ?? 'queued',
        created: options.enqueueCreated ?? true,
      };
    },
    async leaseJobs(n) {
      calls.push({ fn: 'leaseJobs', args: n });
      return options.jobs ?? [];
    },
    async completeJob(jobId, leaseToken, summary) {
      calls.push({ fn: 'completeJob', args: { jobId, leaseToken, summary } });
      return options.writeSucceeds ?? true;
    },
    async retryJob(jobId, leaseToken, availableAt, errorCode) {
      calls.push({ fn: 'retryJob', args: { jobId, leaseToken, availableAt, errorCode } });
      return options.writeSucceeds ?? true;
    },
    async failJob(jobId, leaseToken, errorCode) {
      calls.push({ fn: 'failJob', args: { jobId, leaseToken, errorCode } });
      return options.writeSucceeds ?? true;
    },
    async bumpRateLimit(subject, action, windowStart, limit) {
      calls.push({ fn: 'bumpRateLimit', args: { subject, action, windowStart, limit } });
      return options.limits?.[action] ?? true;
    },
  };
  return { db, calls, names: () => calls.map((c) => c.fn) };
}

const okClient = (outcome?: ClaudeOutcome): ClaudeClient & { seen: unknown[] } => {
  const seen: unknown[] = [];
  return {
    seen,
    async summarise(input) {
      seen.push(input);
      return (
        outcome ?? {
          ok: true,
          payload: { summary: ['bir', 'iki', 'üç'], translation: 'çeviri' },
          usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: 'claude-opus-5',
        }
      );
    },
  };
};

// ===========================================================================
// request-enrichment
// ===========================================================================

describe('requestEnrichment', () => {
  const base = { now: () => NOW, hasApiKey: true, model: 'claude-opus-5', promptVersion: 'v1' };

  it('serves a cached summary without enqueuing anything', async () => {
    const { db, names } = fakeDb({ summary: SUMMARY });
    const result = await requestEnrichment({ ...base, db }, {
      articleId: ARTICLE_ID,
      deviceId: DEVICE,
    });

    expect(result).toEqual({ status: 'ready', summary: SUMMARY });
    expect(names()).not.toContain('enqueueJob');
    // A cache hit must not spend the expensive daily budget.
    expect(names().filter((n) => n === 'bumpRateLimit')).toHaveLength(1);
  });

  it('looks the summary up by the exact cache key', async () => {
    const { db, calls } = fakeDb({ summary: SUMMARY });
    await requestEnrichment({ ...base, db }, { articleId: ARTICLE_ID, deviceId: DEVICE });

    expect(calls.find((c) => c.fn === 'findSummary')!.args).toEqual({
      articleId: ARTICLE_ID,
      contentHash: HASH,
      promptVersion: 'v1',
      model: 'claude-opus-5',
    });
  });

  it('enqueues on a miss and answers queued', async () => {
    const { db, calls, names } = fakeDb();
    const result = await requestEnrichment({ ...base, db }, {
      articleId: ARTICLE_ID,
      deviceId: DEVICE,
    });

    expect(result).toEqual({ status: 'queued', jobId: JOB_ID, pollAfterSeconds: 30 });
    expect(names()).toContain('enqueueJob');
    expect(calls.find((c) => c.fn === 'enqueueJob')!.args).toEqual({
      articleId: ARTICLE_ID,
      contentHash: HASH,
      promptVersion: 'v1',
      model: 'claude-opus-5',
    });
    // Both budgets charged: the cheap check, then the expensive miss.
    expect(names().filter((n) => n === 'bumpRateLimit')).toHaveLength(2);
  });

  it('charges the two budgets against their documented policies', async () => {
    const { db, calls } = fakeDb();
    await requestEnrichment({ ...base, db }, { articleId: ARTICLE_ID, deviceId: DEVICE });

    const bumps = calls.filter((c) => c.fn === 'bumpRateLimit').map((c) => c.args as Record<string, unknown>);
    expect(bumps[0]).toMatchObject({
      subject: DEVICE,
      action: CHECK_POLICY.action,
      limit: 120,
      windowStart: '2026-08-21T12:00:00.000Z',
    });
    expect(bumps[1]).toMatchObject({
      subject: DEVICE,
      action: MISS_POLICY.action,
      limit: 30,
      windowStart: '2026-08-21T00:00:00.000Z',
    });
  });

  it('refuses at the hourly check limit before touching the database', async () => {
    const { db, names } = fakeDb({ limits: { request_enrichment_check: false } });
    const result = await requestEnrichment({ ...base, db }, {
      articleId: ARTICLE_ID,
      deviceId: DEVICE,
    });

    expect(result).toEqual({
      status: 'rate_limited',
      scope: 'check',
      retryAfterSeconds: 3600,
    });
    expect(names()).toEqual(['bumpRateLimit']);
  });

  it('refuses at the daily miss limit without enqueuing', async () => {
    const { db, names } = fakeDb({ limits: { request_enrichment_miss: false } });
    const result = await requestEnrichment({ ...base, db }, {
      articleId: ARTICLE_ID,
      deviceId: DEVICE,
    });

    expect(result).toMatchObject({ status: 'rate_limited', scope: 'miss' });
    expect(result).toMatchObject({ retryAfterSeconds: 12 * 3600 });
    expect(names()).not.toContain('enqueueJob');
  });

  it('reports an unknown article', async () => {
    const { db, names } = fakeDb({ article: null });
    const result = await requestEnrichment({ ...base, db }, {
      articleId: ARTICLE_ID,
      deviceId: DEVICE,
    });
    expect(result).toEqual({ status: 'not_found' });
    expect(names()).not.toContain('enqueueJob');
  });

  it('still enqueues with no API key, and says why (addendum E)', async () => {
    const { db, names } = fakeDb();
    const result = await requestEnrichment(
      { ...base, db, hasApiKey: false },
      { articleId: ARTICLE_ID, deviceId: DEVICE },
    );

    expect(result).toEqual({
      status: 'queued',
      jobId: JOB_ID,
      pollAfterSeconds: 300,
      reason: 'no_api_key',
    });
    // The backlog is real work — it runs the moment a key appears.
    expect(names()).toContain('enqueueJob');
  });

  it('tells the truth about a job that already exhausted its attempts', async () => {
    const { db } = fakeDb({ enqueueStatus: 'failed', enqueueCreated: false });
    const result = await requestEnrichment({ ...base, db }, {
      articleId: ARTICLE_ID,
      deviceId: DEVICE,
    });

    // Still `queued` so an existing client keeps rendering "hazırlanıyor"
    // rather than breaking on an unknown status — but the reason is honest and
    // the poll interval is not a 30-second lie.
    expect(result).toEqual({
      status: 'queued',
      jobId: JOB_ID,
      pollAfterSeconds: 300,
      reason: 'previous_attempt_failed',
    });
  });

  it('is idempotent: a second request returns the same job', async () => {
    const { db } = fakeDb({ enqueueCreated: false });
    const first = await requestEnrichment({ ...base, db }, {
      articleId: ARTICLE_ID,
      deviceId: DEVICE,
    });
    const second = await requestEnrichment({ ...base, db }, {
      articleId: ARTICLE_ID,
      deviceId: DEVICE,
    });
    expect(first).toEqual(second);
  });
});

// ===========================================================================
// process-enrichments
// ===========================================================================

describe('processEnrichments', () => {
  const base = { now: () => NOW, random: () => 0, hasApiKey: true };

  it('touches nothing at all without an API key', async () => {
    const { db, names } = fakeDb({ jobs: [job()] });
    const client = okClient();

    const result = await processEnrichments({ ...base, db, client, hasApiKey: false });

    expect(result).toEqual({ skipped: 'no_api_key', ready: 0, retried: 0, failed: 0, outcomes: [] });
    // Not even a lease: leasing would burn attempt_count on every cron tick and
    // mark the whole backlog `failed` before a key ever exists.
    expect(names()).toEqual([]);
    expect(client.seen).toEqual([]);
  });

  it('returns early when nothing is due', async () => {
    const { db, names } = fakeDb({ jobs: [] });
    const result = await processEnrichments({ ...base, db, client: okClient() });

    expect(result).toEqual({ ready: 0, retried: 0, failed: 0, outcomes: [] });
    expect(names()).toEqual(['leaseJobs']);
  });

  it('clamps max_jobs to 1..3', async () => {
    for (const [asked, expected] of [[undefined, 1], [1, 1], [3, 3], [99, 3], [0, 1]] as const) {
      const { db, calls } = fakeDb({ jobs: [] });
      await processEnrichments({ ...base, db, client: okClient() }, { maxJobs: asked });
      expect(calls[0]).toEqual({ fn: 'leaseJobs', args: expected });
    }
  });

  it('writes the summary and closes the job on success', async () => {
    const { db, calls } = fakeDb({ jobs: [job()] });
    const result = await processEnrichments({ ...base, db, client: okClient() });

    expect(result).toMatchObject({ ready: 1, retried: 0, failed: 0 });
    const complete = calls.find((c) => c.fn === 'completeJob')!.args as {
      jobId: string;
      leaseToken: string;
      summary: SummaryRow;
    };
    expect(complete.jobId).toBe(JOB_ID);
    expect(complete.leaseToken).toBe(LEASE);
    expect(complete.summary).toEqual(SUMMARY);
  });

  it('stores translation_state not_required and a null translation for a Turkish article', async () => {
    const { db, calls } = fakeDb({ jobs: [job({ language: 'tr' })] });
    const client = okClient({
      ok: true,
      payload: { summary: ['bir', 'iki', 'üç'], translation: null },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'claude-opus-5',
    });

    await processEnrichments({ ...base, db, client });

    const summary = (calls.find((c) => c.fn === 'completeJob')!.args as { summary: SummaryRow })
      .summary;
    // P2's row trigger enforces the same invariant; matching it here turns a
    // would-be database error into a clean write.
    expect(summary.translation_state).toBe('not_required');
    expect(summary.translation_tr).toBeNull();
  });

  it('passes the article through to the client with the default ceiling', async () => {
    const { db } = fakeDb({ jobs: [job()] });
    const client = okClient();
    await processEnrichments({ ...base, db, client, maxTokens: MAX_TOKENS_DEFAULT });

    expect(client.seen).toHaveLength(1);
    expect(client.seen[0]).toMatchObject({
      model: 'claude-opus-5',
      maxTokens: MAX_TOKENS_DEFAULT,
      article: { title: 'A model shipped', language: 'en', sourceName: 'OpenAI Blog' },
    });
  });

  it('retries a transient failure with a backoff and keeps the attempt count', async () => {
    const { db, calls } = fakeDb({ jobs: [job({ attempt_count: 2 })] });
    const client = okClient({ ok: false, code: 'rate_limited', retryable: true });

    const result = await processEnrichments({ ...base, db, client });

    expect(result).toMatchObject({ ready: 0, retried: 1, failed: 0 });
    const retry = calls.find((c) => c.fn === 'retryJob')!.args as {
      availableAt: string;
      errorCode: string;
    };
    expect(retry.errorCode).toBe('rate_limited');
    // random() === 0 → exactly one base interval ahead of now.
    expect(retry.availableAt).toBe(
      new Date(NOW.getTime() + AI_BACKOFF_BASE_SECONDS * 1000).toISOString(),
    );
    expect(new Date(retry.availableAt).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('backs off further on later attempts', async () => {
    const delays: number[] = [];
    for (const attempt of [1, 2, 3, 4]) {
      const { db, calls } = fakeDb({ jobs: [job({ attempt_count: attempt })] });
      await processEnrichments({
        ...base,
        db,
        client: okClient({ ok: false, code: 'server_error', retryable: true }),
        random: () => 1,
      });
      const retry = calls.find((c) => c.fn === 'retryJob')!.args as { availableAt: string };
      delays.push((new Date(retry.availableAt).getTime() - NOW.getTime()) / 1000);
    }
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(delays[3]).toBeGreaterThan(delays[0]);
  });

  it('fails a job that has run out of attempts, even on a transient error', async () => {
    const { db, calls, names } = fakeDb({ jobs: [job({ attempt_count: 5, max_attempts: 5 })] });
    const client = okClient({ ok: false, code: 'server_error', retryable: true });

    const result = await processEnrichments({ ...base, db, client });

    expect(result).toMatchObject({ ready: 0, retried: 0, failed: 1 });
    expect(names()).toContain('failJob');
    expect(names()).not.toContain('retryJob');
    expect((calls.find((c) => c.fn === 'failJob')!.args as { errorCode: string }).errorCode).toBe(
      'server_error',
    );
  });

  it('fails a non-retryable error immediately, with attempts to spare', async () => {
    for (const code of ['auth', 'bad_request', 'refusal', 'schema_summary_wrong_length']) {
      const { db, names } = fakeDb({ jobs: [job({ attempt_count: 1, max_attempts: 5 })] });
      const client = okClient({ ok: false, code: code as never, retryable: false });

      const result = await processEnrichments({ ...base, db, client });
      expect({ code, ...result }).toMatchObject({ code, failed: 1, retried: 0 });
      expect(names()).not.toContain('retryJob');
    }
  });

  // -------------------------------------------------------------------------
  // Truncation: retried exactly once, with more room.
  // -------------------------------------------------------------------------

  it('retries a first truncation and records it so the next attempt escalates', async () => {
    const { db, calls } = fakeDb({ jobs: [job({ last_error_code: null })] });
    const client = okClient({ ok: false, code: 'output_truncated', retryable: true });

    const result = await processEnrichments({ ...base, db, client });

    expect(result).toMatchObject({ retried: 1, failed: 0 });
    expect(client.seen[0]).toMatchObject({ maxTokens: MAX_TOKENS_DEFAULT });
    expect((calls.find((c) => c.fn === 'retryJob')!.args as { errorCode: string }).errorCode).toBe(
      'output_truncated',
    );
  });

  it('asks for the escalated ceiling on the retry', async () => {
    const { db } = fakeDb({ jobs: [job({ last_error_code: 'output_truncated' })] });
    const client = okClient();

    await processEnrichments({ ...base, db, client });

    expect(client.seen[0]).toMatchObject({ maxTokens: MAX_TOKENS_ESCALATED });
  });

  it('fails a second truncation instead of retrying it forever', async () => {
    const { db, names } = fakeDb({ jobs: [job({ last_error_code: 'output_truncated' })] });
    const client = okClient({ ok: false, code: 'output_truncated', retryable: true });

    const result = await processEnrichments({ ...base, db, client });

    // Retrying an already-escalated truncation truncates again, forever, and
    // bills every attempt.
    expect(result).toMatchObject({ failed: 1, retried: 0 });
    expect(names()).toContain('failJob');
    expect(names()).not.toContain('retryJob');
  });

  // -------------------------------------------------------------------------
  // Concurrency.
  // -------------------------------------------------------------------------

  it('discards its result when the lease was lost — two workers, one write', async () => {
    const { db, calls } = fakeDb({ jobs: [job()], writeSucceeds: false });
    const result = await processEnrichments({ ...base, db, client: okClient() });

    // The slow worker still called Claude, but the write is refused by the
    // lease-token check, so the fast worker's summary stands.
    expect(result).toMatchObject({ ready: 0, retried: 0, failed: 0 });
    expect(result.outcomes[0]).toMatchObject({ disposition: 'lease_lost', code: 'lease_lost' });
    expect(calls.filter((c) => c.fn === 'completeJob')).toHaveLength(1);
  });

  it('reports a lost lease on the retry and fail paths too', async () => {
    for (const outcome of [
      { ok: false as const, code: 'server_error' as const, retryable: true },
      { ok: false as const, code: 'auth' as const, retryable: false },
    ]) {
      const { db } = fakeDb({ jobs: [job()], writeSucceeds: false });
      const result = await processEnrichments({ ...base, db, client: okClient(outcome) });
      expect(result.outcomes[0].disposition).toBe('lease_lost');
      expect(result).toMatchObject({ ready: 0, retried: 0, failed: 0 });
    }
  });

  // -------------------------------------------------------------------------
  // Global budget.
  // -------------------------------------------------------------------------

  it('charges the global daily cap before every call', async () => {
    const { db, calls } = fakeDb({ jobs: [job()] });
    await processEnrichments({ ...base, db, client: okClient(), dailyCap: 200 });

    const bump = calls.find((c) => c.fn === 'bumpRateLimit')!.args as Record<string, unknown>;
    expect(bump).toMatchObject({
      subject: 'global',
      action: 'ai_call',
      limit: 200,
      windowStart: '2026-08-21T00:00:00.000Z',
    });
  });

  it('requeues without calling Claude once the cap is spent', async () => {
    const { db, calls, names } = fakeDb({ jobs: [job()], limits: { ai_call: false } });
    const client = okClient();

    const result = await processEnrichments({ ...base, db, client, dailyCap: 200 });

    expect(result.skipped).toBe('daily_cap');
    expect(client.seen).toEqual([]);
    expect(names()).toContain('retryJob');
    const retry = calls.find((c) => c.fn === 'retryJob')!.args as {
      availableAt: string;
      errorCode: string;
    };
    expect(retry.errorCode).toBe('daily_cap');
    // Back at the start of the next daily window, not a minute from now.
    expect(retry.availableAt).toBe('2026-08-22T00:00:00.000Z');
  });

  it('requeues the whole remaining batch once capped, checking the cap only once', async () => {
    const jobs = [
      job({ job_id: 'a', lease_token: 'ta' }),
      job({ job_id: 'b', lease_token: 'tb' }),
      job({ job_id: 'c', lease_token: 'tc' }),
    ];
    const { db, calls } = fakeDb({ jobs, limits: { ai_call: false } });
    const client = okClient();

    const result = await processEnrichments({ ...base, db, client }, { maxJobs: 3 });

    expect(client.seen).toEqual([]);
    expect(result.retried).toBe(3);
    // The counter is not incremented once per remaining job.
    expect(calls.filter((c) => c.fn === 'bumpRateLimit')).toHaveLength(1);
    expect(calls.filter((c) => c.fn === 'retryJob')).toHaveLength(3);
  });

  it('processes a batch and reports each job separately', async () => {
    const jobs = [
      job({ job_id: 'a', lease_token: 'ta' }),
      job({ job_id: 'b', lease_token: 'tb', attempt_count: 5, max_attempts: 5 }),
    ];
    let call = 0;
    const client: ClaudeClient = {
      async summarise() {
        call += 1;
        return call === 1
          ? {
              ok: true,
              payload: { summary: ['bir', 'iki', 'üç'], translation: 'çeviri' },
              usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
              model: 'claude-opus-5',
            }
          : { ok: false, code: 'server_error', retryable: true };
      },
    };

    const result = await processEnrichments({ ...base, db: fakeDb({ jobs }).db, client }, {
      maxJobs: 2,
    });

    expect(result).toMatchObject({ ready: 1, failed: 1, retried: 0 });
    expect(result.outcomes.map((o) => o.disposition)).toEqual(['ready', 'failed']);
  });

  it('treats a throwing client as transient rather than losing the run', async () => {
    const { db, names } = fakeDb({ jobs: [job()] });
    const client: ClaudeClient = {
      async summarise() {
        throw new TypeError('adapter bug');
      },
    };

    const result = await processEnrichments({ ...base, db, client });

    expect(result).toMatchObject({ retried: 1, failed: 0 });
    expect(names()).toContain('retryJob');
  });

  it('keeps article text out of every outcome it reports', async () => {
    const { db } = fakeDb({ jobs: [job()] });
    const result = await processEnrichments({
      ...base,
      db,
      client: okClient({ ok: false, code: 'refusal', retryable: false, detail: 'category=cyber' }),
    });

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Body text.');
    expect(serialised).not.toContain('A model shipped');
    expect(result.outcomes[0].code).toBe('refusal');
  });
});

// ===========================================================================
// The RPC adapter — names and argument shapes the migration must match.
// ===========================================================================

describe('createEnrichmentDb', () => {
  function fakeClient() {
    const calls: { fn: string; args: unknown }[] = [];
    return {
      calls,
      client: {
        rpc(fn: string, args?: Record<string, unknown>) {
          calls.push({ fn, args });
          return Promise.resolve({ data: fn.includes('lease') ? [] : true, error: null });
        },
      },
    };
  }

  it('routes through the public transport shims by default prefix', async () => {
    const { client, calls } = fakeClient();
    const db = createEnrichmentDb(client, { rpcPrefix: 'aigundem_' });

    await db.leaseJobs(3);
    await db.retryJob(JOB_ID, LEASE, NOW.toISOString(), 'rate_limited');

    expect(calls.map((c) => c.fn)).toEqual([
      'aigundem_internal_lease_enrichment_jobs',
      'aigundem_internal_retry_ai_job',
    ]);
  });

  it('calls the aigundem names when the schema is exposed', async () => {
    const { client, calls } = fakeClient();
    const db = createEnrichmentDb(client);

    await db.failJob(JOB_ID, LEASE, 'auth');

    expect(calls[0].fn).toBe('internal_fail_ai_job');
  });

  it('sends hashes as hex and every argument p_-prefixed', async () => {
    const { client, calls } = fakeClient();
    const db = createEnrichmentDb(client);

    await db.completeJob(JOB_ID, LEASE, SUMMARY);

    expect(calls[0].args).toEqual({
      p_job_id: JOB_ID,
      p_lease_token: LEASE,
      p_content_hash: HASH,
      p_prompt_version: 'v1',
      p_model: 'claude-opus-5',
      p_summary_tr: ['bir', 'iki', 'üç'],
      p_translation_tr: 'çeviri',
      p_translation_state: 'ready',
    });
    expect(HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('turns a database error into an AppError without echoing the message', async () => {
    const db = createEnrichmentDb({
      rpc: () =>
        Promise.resolve({
          data: null,
          error: { message: 'row (secret-article-body) violates constraint' },
        }),
    });

    await expect(db.leaseJobs(1)).rejects.toThrow(/Database call .* failed/);
    await expect(db.leaseJobs(1)).rejects.not.toThrow(/secret-article-body/);
  });
});
