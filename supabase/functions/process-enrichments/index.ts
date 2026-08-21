/**
 * `process-enrichments` — the Deno boundary for the AI worker.
 *
 * Thin on purpose: leasing, the retry policy, the truncation escalation, the
 * global budget check and every error mapping live in `../_shared/*` and run
 * under Jest against a fake Claude client. What is here is `Deno.serve`,
 * `Deno.env`, the Supabase client and the real Anthropic client.
 *
 * Trigger: pg_cron via pg_net, or a manual call by the coordinator.
 * Auth: `X-Internal-Secret` only, compared in constant time. No user identity.
 *
 * Request:  {"max_jobs"?: 1..3}
 * Response: {"skipped"?: "no_api_key"|"daily_cap", "ready":N, "retried":N,
 *            "failed":N}   (arch-001 §3)
 *
 * KEY-OPTIONAL (addendum §E): with no ANTHROPIC_API_KEY this returns
 * `{skipped:"no_api_key", ready:0, retried:0, failed:0}` after ONE warning and
 * touches no jobs at all — it does not even lease. Leasing would increment
 * `attempt_count` on every cron tick and mark the whole backlog `failed` long
 * before a key exists.
 */

import { createClient } from '@supabase/supabase-js';

import { createClaudeClient, readAnthropicConfig } from '../_shared/anthropic-deno.ts';
import { readJsonBody, requireMethod } from '../_shared/auth.ts';
import {
  AUTOMATIONS_SECRET_NAME,
  createInternalSecretResolver,
  requireResolvedInternalSecret,
} from '../_shared/secret.ts';
import { createEnrichmentDb } from '../_shared/enrichment-db.ts';
import {
  MAX_JOBS_PER_RUN,
  processEnrichments,
} from '../_shared/enrichment.ts';
import {
  AppError,
  errorResponse,
  jsonResponse,
  newRequestId,
  requireOnlyKeys,
} from '../_shared/error.ts';

function rpcRouting(): { schema: string; prefix: string } {
  return {
    schema: Deno.env.get('AIGUNDEM_RPC_SCHEMA') ?? 'public',
    prefix: Deno.env.get('AIGUNDEM_RPC_PREFIX') ?? 'aigundem_',
  };
}

function parseRequest(body: unknown): { maxJobs: number } {
  const fields = requireOnlyKeys(body, ['max_jobs'] as const);

  if (fields.max_jobs === undefined || fields.max_jobs === null) {
    return { maxJobs: 1 };
  }
  const value = fields.max_jobs;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_JOBS_PER_RUN
  ) {
    throw new AppError(
      'bad_request',
      `max_jobs must be an integer between 1 and ${MAX_JOBS_PER_RUN}.`,
    );
  }
  return { maxJobs: value };
}

Deno.serve(async (request: Request): Promise<Response> => {
  const requestId = newRequestId();

  try {
    requireMethod(request, 'POST');

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      throw new AppError('internal_error', 'Database credentials are not configured.');
    }

    const routing = rpcRouting();
    const client = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: routing.schema },
      global: { headers: { 'x-request-id': requestId } },
    });

    // The internal secret lives in Supabase Vault, not in Deno.env — no Edge
    // secret could be set for this project (P5). Resolution needs a database
    // client, so the client is built first; `requireResolvedInternalSecret`
    // still rejects a request with no header before looking anything up, so an
    // unauthenticated caller cannot force a Vault round trip.
    await requireResolvedInternalSecret(
      request.headers,
      createInternalSecretResolver(
        { get: (name) => Deno.env.get(name) },
        async () => {
          const { data, error } = await client.rpc(
            `${routing.prefix}internal_get_setting`,
            { p_name: AUTOMATIONS_SECRET_NAME },
          );
          if (error) return null;
          return typeof data === 'string' ? data : null;
        },
      ),
    );

    const { maxJobs } = parseRequest(await readJsonBody(request));
    const config = readAnthropicConfig();

    // The no-key path still returns before any JOB is touched. It now costs one
    // Vault read for authentication, which P4's version avoided by reading the
    // secret from the environment — unavoidable when the secret lives in the
    // database, and still nothing that leases, writes or calls Claude.
    if (config.apiKey === null) {
      console.warn(
        JSON.stringify({
          event: 'process_enrichments_skipped',
          request_id: requestId,
          reason: 'no_api_key',
        }),
      );
      return jsonResponse(
        { skipped: 'no_api_key', ready: 0, retried: 0, failed: 0 },
        200,
        requestId,
      );
    }

    const result = await processEnrichments(
      {
        db: createEnrichmentDb(client, { rpcPrefix: routing.prefix }),
        client: createClaudeClient(config),
        now: () => new Date(),
        hasApiKey: true,
        model: config.model,
        effort: config.effort,
        maxTokens: config.maxTokens,
        maxTokensEscalated: config.maxTokensEscalated,
        maxArticleChars: config.maxArticleChars,
        dailyCap: config.dailyCap,
      },
      { maxJobs },
    );

    // Per-job detail goes to the log, never the response: job ids and short
    // codes are enough to debug, and article text never leaves the database.
    console.log(
      JSON.stringify({
        event: 'process_enrichments_done',
        request_id: requestId,
        model: config.model,
        effort: config.effort,
        skipped: result.skipped ?? null,
        ready: result.ready,
        retried: result.retried,
        failed: result.failed,
        outcomes: result.outcomes.map((o) => ({
          job_id: o.jobId,
          disposition: o.disposition,
          code: o.code,
          attempt: o.attempt,
          input_tokens: o.usage?.inputTokens ?? 0,
          output_tokens: o.usage?.outputTokens ?? 0,
          cache_read_tokens: o.usage?.cacheReadTokens ?? 0,
        })),
      }),
    );

    return jsonResponse(
      {
        ...(result.skipped ? { skipped: result.skipped } : {}),
        ready: result.ready,
        retried: result.retried,
        failed: result.failed,
      },
      200,
      requestId,
    );
  } catch (cause) {
    console.error(
      JSON.stringify({
        event: 'process_enrichments_error',
        request_id: requestId,
        code: cause instanceof AppError ? cause.code : 'internal_error',
      }),
    );
    return errorResponse(cause, requestId);
  }
});
