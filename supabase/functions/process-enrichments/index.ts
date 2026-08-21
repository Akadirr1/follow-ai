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
import { resolveAiProvider } from '../_shared/ai-provider.ts';
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

/**
 * Reads one allow-listed Vault secret through the transport shim, memoised for
 * this invocation — the same discipline `secret.ts` uses, so resolving three
 * providers costs at most three round trips and never one per lookup.
 */
function vaultReader(
  client: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> },
  prefix: string,
): (name: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  return (name) => {
    const hit = cache.get(name);
    if (hit) return hit;
    const pending = (async () => {
      const { data, error } = await client.rpc(`${prefix}internal_get_setting`, {
        p_name: name,
      });
      if (error) return null;
      return typeof data === 'string' && data !== '' ? data : null;
    })();
    cache.set(name, pending);
    return pending;
  };
}

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

    // Which provider answers is configuration (addendum §H). The same resolver
    // runs in `request-enrichment`, so the model string that goes into the job
    // row is the one this worker will write back — that agreement is what keeps
    // the summary cache key from diverging.
    //
    // Anthropic needs its SDK, which cannot be imported into a portable module,
    // so the resolver takes a factory for it and builds the other two itself.
    const resolved = await resolveAiProvider(
      { get: (name) => Deno.env.get(name) },
      vaultReader(client, routing.prefix),
      {
        fetchImpl: fetch,
        createAnthropicClient: (model) =>
          createClaudeClient({ ...config, apiKey: config.apiKey ?? '', model }),
      },
    );

    // The no-key path still returns before any JOB is touched: no lease, no
    // attempt spent, no provider called. It costs the Vault reads the resolver
    // made, which is unavoidable when the keys live in the database.
    if (resolved.provider === null) {
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
        client: resolved.client,
        now: () => new Date(),
        hasApiKey: true,
        model: resolved.model,
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
        // Watch this line after the first deploy: `provider` says who answered
        // and `ready > 0` says the whole path works end to end.
        provider: resolved.provider,
        model: resolved.model,
        fallback: resolved.fallback?.provider ?? null,
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
          // Differs from `model` above only when the fallback answered.
          used_model: o.usedModel ?? null,
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
