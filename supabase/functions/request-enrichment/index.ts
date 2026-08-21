/**
 * `request-enrichment` — the Deno boundary for "summarise this article".
 *
 * Thin on purpose: the cache lookup, both rate-limit budgets and the job
 * enqueue all live in `../_shared/enrichment.ts` and run under Jest against a
 * fake database. What is here is `Deno.serve`, `Deno.env` and the Supabase
 * client.
 *
 * Auth: Supabase's `verify_jwt` gate (platform default, true) requires a bearer
 * JWT — the legacy anon key, per addendum §F. That JWT carries no user identity
 * in v1, so the rate-limited subject is the `X-Device-Id` header (addendum §A).
 *
 * Request:  {"article_id": uuid, "client_request_id": uuid v4}
 * Response: 200 {"status":"ready","summary":{...}}
 *           202 {"status":"queued","poll_after_seconds":N,"reason"?:"..."}
 *           429 error envelope with retry_after_seconds
 *
 * With no ANTHROPIC_API_KEY the job is still enqueued and the answer is
 * 202 with `reason:"no_api_key"` and a long poll interval (addendum §E): the
 * backlog is real work that runs the moment a key appears.
 */

import { createClient } from '@supabase/supabase-js';

import { readJsonBody, requireDeviceId, requireMethod } from '../_shared/auth.ts';
import { DEFAULT_MODEL } from '../_shared/anthropic-config.ts';
import { createEnrichmentDb } from '../_shared/enrichment-db.ts';
import {
  requestEnrichment,
} from '../_shared/enrichment.ts';
import {
  AppError,
  errorResponse,
  jsonResponse,
  newRequestId,
  requireOnlyKeys,
} from '../_shared/error.ts';
import { PROMPT_VERSION } from '../_shared/prompt.ts';
import { isUuidV4 } from '../_shared/rate-limit.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where the internal RPCs live (addendum §C.1). Defaults to the `public`
 * transport shims, because `aigundem` is not a PostgREST-exposed schema until a
 * human adds it. Switching later is configuration, not a redeploy.
 */
function rpcRouting(): { schema: string; prefix: string } {
  return {
    schema: Deno.env.get('AIGUNDEM_RPC_SCHEMA') ?? 'public',
    prefix: Deno.env.get('AIGUNDEM_RPC_PREFIX') ?? 'aigundem_',
  };
}

function parseRequest(body: unknown): { articleId: string; clientRequestId: string } {
  const fields = requireOnlyKeys(body, ['article_id', 'client_request_id'] as const);

  if (typeof fields.article_id !== 'string' || !UUID_RE.test(fields.article_id)) {
    throw new AppError('bad_request', 'article_id must be a uuid.');
  }
  if (!isUuidV4(fields.client_request_id)) {
    throw new AppError('bad_request', 'client_request_id must be a uuid v4.');
  }

  return {
    articleId: fields.article_id.toLowerCase(),
    clientRequestId: fields.client_request_id.toLowerCase(),
  };
}

Deno.serve(async (request: Request): Promise<Response> => {
  const requestId = newRequestId();

  try {
    requireMethod(request, 'POST');
    const deviceId = requireDeviceId(request.headers);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      throw new AppError('internal_error', 'Database credentials are not configured.');
    }

    const input = parseRequest(await readJsonBody(request));

    // Presence only — the key itself is never read, logged or returned here.
    const hasApiKey = (Deno.env.get('ANTHROPIC_API_KEY') ?? '').trim() !== '';
    const model = (Deno.env.get('ANTHROPIC_MODEL') ?? '').trim() || DEFAULT_MODEL;

    const routing = rpcRouting();
    const client = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: routing.schema },
      global: { headers: { 'x-request-id': requestId } },
    });

    const result = await requestEnrichment(
      {
        db: createEnrichmentDb(client, { rpcPrefix: routing.prefix }),
        now: () => new Date(),
        model,
        promptVersion: PROMPT_VERSION,
        hasApiKey,
      },
      { articleId: input.articleId, deviceId },
    );

    if (result.status === 'not_found') {
      throw new AppError('not_found', 'Article not found.');
    }

    if (result.status === 'rate_limited') {
      throw new AppError(
        'rate_limited',
        result.scope === 'miss'
          ? 'Daily limit for new summaries reached.'
          : 'Too many summary requests. Try again shortly.',
        result.retryAfterSeconds,
      );
    }

    if (result.status === 'unavailable') {
      // 200, not an error: nothing went wrong, this article simply has no body
      // to summarise. Terminal and cacheable — the client renders "Bu haber
      // için özet üretilemiyor" with a link to the source, and never polls.
      return jsonResponse(
        {
          status: 'unavailable',
          reason: result.reason,
          client_request_id: input.clientRequestId,
        },
        200,
        requestId,
      );
    }

    if (result.status === 'ready') {
      return jsonResponse(
        {
          status: 'ready',
          summary: {
            article_id: result.summary.article_id,
            summary_tr: result.summary.summary_tr,
            translation_tr: result.summary.translation_tr,
            translation_state: result.summary.translation_state,
            model: result.summary.model,
            prompt_version: result.summary.prompt_version,
          },
          client_request_id: input.clientRequestId,
        },
        200,
        requestId,
      );
    }

    console.log(
      JSON.stringify({
        event: 'request_enrichment_queued',
        request_id: requestId,
        reason: result.reason ?? 'queued',
        poll_after_seconds: result.pollAfterSeconds,
      }),
    );

    return jsonResponse(
      {
        status: 'queued',
        poll_after_seconds: result.pollAfterSeconds,
        ...(result.reason ? { reason: result.reason } : {}),
        client_request_id: input.clientRequestId,
      },
      202,
      requestId,
    );
  } catch (cause) {
    console.error(
      JSON.stringify({
        event: 'request_enrichment_error',
        request_id: requestId,
        code: cause instanceof AppError ? cause.code : 'internal_error',
      }),
    );
    return errorResponse(cause, requestId);
  }
});
