/**
 * `build-digest` — the Deno boundary for the daily digest.
 *
 * Thin on purpose: the window arithmetic, the request validation and the
 * ranking specification live in `../_shared/digest.ts` and run under Jest. The
 * ranking that actually executes is the SQL in migration 0008, so that
 * selection and insertion share one snapshot and one transaction.
 *
 * NO CLAUDE. A blurb is the first bullet of a summary `process-enrichments`
 * already stored, so a digest is buildable with no Anthropic key in existence.
 * Fewer than five enriched articles in the window leaves the digest `preparing`
 * rather than inventing anything (addendum §E).
 *
 * Trigger: pg_cron via pg_net, or a manual call by the coordinator.
 * Auth: `X-Internal-Secret` only, resolved from Vault (see `_shared/secret.ts`).
 *
 * P12: `prepare` also ENQUEUES the day's enrichment candidates. Before that,
 * nothing ever enqueued a job except a human opening an article, so the digest
 * counted zero enriched candidates every morning and stayed `preparing`
 * forever. The candidate selection is `internal_enqueue_digest_candidates`
 * (migration 0012); the orchestration is `../_shared/digest-enqueue.ts` and
 * runs under Jest. `finalize` is unchanged.
 *
 * Request:  {"digest_date"?: "YYYY-MM-DD", "phase": "prepare"|"finalize"}
 * Response: {"date", "status", "item_count", "missing_enrichments"}
 *           (arch-001 §3), plus {"enqueued", "already", "candidates"} and an
 *           optional "reason" on `prepare`.
 */

import { createClient } from '@supabase/supabase-js';

import { resolveAiProvider } from '../_shared/ai-provider.ts';
import { readJsonBody, requireMethod } from '../_shared/auth.ts';
import {
  createDigestDb,
  DigestDbError,
  parseDigestRequest,
  type DigestResultRow,
} from '../_shared/digest.ts';
import {
  readDigestLimits,
  runDigestPrepare,
  type DigestEnqueueReport,
} from '../_shared/digest-enqueue.ts';
import { PROMPT_VERSION } from '../_shared/prompt.ts';
import {
  AppError,
  errorResponse,
  jsonResponse,
  newRequestId,
  requireOnlyKeys,
} from '../_shared/error.ts';
import {
  AUTOMATIONS_SECRET_NAME,
  createInternalSecretResolver,
  requireResolvedInternalSecret,
} from '../_shared/secret.ts';

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

const REQUEST_REASONS: Record<string, string> = {
  phase_missing: "phase is required and must be 'prepare' or 'finalize'.",
  phase_invalid: "phase must be 'prepare' or 'finalize'.",
  date_invalid: 'digest_date must be a real YYYY-MM-DD date.',
};

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
    const db = createDigestDb(client, { rpcPrefix: routing.prefix });

    // The secret lives in Vault, not in Deno.env — no Edge secret could be set
    // for this project. `requireResolvedInternalSecret` rejects a request with
    // no header BEFORE it looks anything up, so an unauthenticated caller
    // cannot force a database round trip.
    await requireResolvedInternalSecret(
      request.headers,
      createInternalSecretResolver(
        { get: (name) => Deno.env.get(name) },
        () => db.getSetting(AUTOMATIONS_SECRET_NAME),
      ),
    );

    const fields = requireOnlyKeys(await readJsonBody(request), [
      'digest_date',
      'phase',
    ] as const);

    const parsed = parseDigestRequest(fields);
    if (!parsed.ok) {
      throw new AppError('bad_request', REQUEST_REASONS[parsed.reason]);
    }

    // A null date means "the current Istanbul day". Postgres resolves it: it
    // has real timezone data, so the answer stays correct even if Türkiye ever
    // reinstates seasonal clock changes.
    const { digestDate, phase } = parsed.value;

    let result: DigestResultRow;
    let enqueue: DigestEnqueueReport | null = null;

    if (phase === 'prepare') {
      // P12. The provider is resolved through the SAME env-then-Vault path
      // `process-enrichments` uses, because its model string is half the
      // summary cache key: enqueueing under anything else would produce
      // summaries no lookup could ever match. No key value is read here — only
      // the model string — and no provider is ever called.
      const prepared = await runDigestPrepare(
        {
          db,
          resolveProvider: () =>
            resolveAiProvider(
              { get: (name) => Deno.env.get(name) },
              (name) => db.getSetting(name),
              { fetchImpl: fetch },
            ),
          promptVersion: PROMPT_VERSION,
          limits: readDigestLimits({ get: (name) => Deno.env.get(name) }),
        },
        digestDate,
      );
      result = prepared.row;
      enqueue = prepared.enqueue;
    } else {
      result = await db.finalize(digestDate);
    }

    console.log(
      JSON.stringify({
        event: 'build_digest_done',
        request_id: requestId,
        phase,
        date: result.digest_date,
        status: result.status,
        item_count: result.item_count,
        missing_enrichments: result.missing,
        ...(enqueue
          ? {
              provider: enqueue.provider,
              model: enqueue.model,
              enqueued: enqueue.enqueued,
              already: enqueue.already,
              candidates: enqueue.candidates,
              ...(enqueue.reason ? { reason: enqueue.reason } : {}),
            }
          : {}),
      }),
    );

    return jsonResponse(
      {
        date: result.digest_date,
        status: result.status,
        item_count: result.item_count,
        missing_enrichments: result.missing,
        ...(enqueue
          ? {
              enqueued: enqueue.enqueued,
              already: enqueue.already,
              candidates: enqueue.candidates,
              ...(enqueue.reason ? { reason: enqueue.reason } : {}),
            }
          : {}),
      },
      200,
      requestId,
    );
  } catch (cause) {
    const code =
      cause instanceof AppError
        ? cause.code
        : cause instanceof DigestDbError
          ? 'upstream_error'
          : 'internal_error';

    console.error(
      JSON.stringify({ event: 'build_digest_error', request_id: requestId, code }),
    );

    return errorResponse(
      cause instanceof DigestDbError
        ? new AppError('upstream_error', 'Digest wrapper call failed.')
        : cause,
      requestId,
    );
  }
});
