/**
 * `sync-feeds` — the Deno boundary for feed ingestion.
 *
 * This file is deliberately thin. Everything decidable without a runtime lives
 * in `../_shared/*` and is unit-tested from Node; what remains here is the part
 * only Deno can provide: `Deno.serve`, `Deno.env`, `Deno.resolveDns`, and the
 * real Supabase client. That split is why `supabase/` is excluded from the app
 * `tsconfig.json` — these globals do not exist in the Expo type environment —
 * while `_shared` stays fully typed and covered.
 *
 * Trigger: pg_cron via pg_net, or a manual call by the coordinator.
 * Auth: `X-Internal-Secret` only. There is no user identity here.
 *
 * Request:  {"source_id"?: uuid, "max_sources"?: 1..20}
 * Response: {"run_id", "sources_ok", "sources_failed", "inserted", "updated",
 *            "unchanged"}   (arch-001 §3)
 */

import { createClient } from '@supabase/supabase-js';

import { readJsonBody, requireMethod } from '../_shared/auth.ts';
import {
  AUTOMATIONS_SECRET_NAME,
  createInternalSecretResolver,
  requireResolvedInternalSecret,
} from '../_shared/secret.ts';
import {
  AppError,
  errorResponse,
  jsonResponse,
  newRequestId,
  requireOnlyKeys,
} from '../_shared/error.ts';
import {
  DEFAULT_SOURCES_PER_RUN,
  FeedFetchOutcome,
  MAX_SOURCES_PER_RUN,
  runIngestion,
} from '../_shared/ingest.ts';
import { createAdminGateway, LeasedSource } from '../_shared/supabase-admin.ts';
import { DEFAULT_MAX_BYTES, safeFetch } from '../_shared/url-safety.ts';

const FEED_TIMEOUT_MS = 10000;

/**
 * `Deno.resolveDns` is not guaranteed on the Supabase Edge runtime. When it is
 * missing this returns null, and the guard then decides per call site: strict
 * for user input (`add-source` fails closed), shape-only for the seeded
 * sources here, whose hostnames were reviewed by a human before seeding.
 */
function dnsResolver(): ((hostname: string) => Promise<string[]>) | null {
  const resolve = (Deno as unknown as {
    resolveDns?: (query: string, type: string) => Promise<string[]>;
  }).resolveDns;
  if (typeof resolve !== 'function') return null;
  return async (hostname: string) => {
    const answers: string[] = [];
    for (const recordType of ['A', 'AAAA']) {
      try {
        answers.push(...(await resolve(hostname, recordType)));
      } catch {
        // NXDOMAIN for one family is normal; an empty total is handled above.
      }
    }
    return answers;
  };
}

/**
 * Where the internal RPCs live (addendum §C.1).
 *
 * DEFAULTS TO `public` + `aigundem_` because that is what works today:
 * `alter role authenticator set pgrst.db_schemas` fails with 42501 on hosted
 * Supabase, so `aigundem` is not a PostgREST-exposed schema and nothing in it
 * is callable through supabase-js — service_role included, since the
 * exposed-schema list is server config and not a privilege check. Migration
 * 202608210006_internal_wrappers.sql therefore also publishes
 * `public.aigundem_internal_*` transport shims, granted to service_role alone.
 *
 * Once a human adds `aigundem` under Project Settings → API → Exposed schemas,
 * set AIGUNDEM_RPC_SCHEMA=aigundem and AIGUNDEM_RPC_PREFIX= (empty) and the
 * same code calls `aigundem.internal_*` directly. The switch is configuration,
 * never a redeploy of changed logic.
 */
function rpcRouting(): { schema: string; prefix: string } {
  return {
    schema: Deno.env.get('AIGUNDEM_RPC_SCHEMA') ?? 'public',
    prefix: Deno.env.get('AIGUNDEM_RPC_PREFIX') ?? 'aigundem_',
  };
}

async function fetchFeed(source: LeasedSource): Promise<FeedFetchOutcome> {
  const result = await safeFetch(source.feed_url, {
    fetchImpl: fetch,
    resolve: dnsResolver(),
    // Seeded and previously-validated sources: a runtime without DNS access
    // must not stop ingestion entirely.
    requireDns: false,
    timeoutMs: FEED_TIMEOUT_MS,
    maxBytes: DEFAULT_MAX_BYTES,
    conditional: { etag: source.etag, lastModified: source.last_modified },
  });

  if (!result.ok) {
    switch (result.kind) {
      case 'http_error':
        return { kind: 'error', code: `http_${result.status}` };
      case 'unsafe_url':
        return { kind: 'error', code: `unsafe_url_${result.reason}` };
      default:
        return { kind: 'error', code: result.kind };
    }
  }

  if (result.status === 304) {
    return {
      kind: 'not_modified',
      etag: result.headers.get('etag'),
      lastModified: result.headers.get('last-modified'),
    };
  }

  return {
    kind: 'ok',
    body: result.body,
    finalUrl: result.finalUrl,
    etag: result.headers.get('etag'),
    lastModified: result.headers.get('last-modified'),
  };
}

function parseRequest(body: unknown): { sourceId?: string; maxSources: number } {
  const fields = requireOnlyKeys(body, ['source_id', 'max_sources'] as const);

  let sourceId: string | undefined;
  if (fields.source_id !== undefined && fields.source_id !== null) {
    if (
      typeof fields.source_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        fields.source_id,
      )
    ) {
      throw new AppError('bad_request', 'source_id must be a uuid.');
    }
    sourceId = fields.source_id.toLowerCase();
  }

  let maxSources = DEFAULT_SOURCES_PER_RUN;
  if (fields.max_sources !== undefined && fields.max_sources !== null) {
    const value = fields.max_sources;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_SOURCES_PER_RUN
    ) {
      throw new AppError(
        'bad_request',
        `max_sources must be an integer between 1 and ${MAX_SOURCES_PER_RUN}.`,
      );
    }
    maxSources = value;
  }

  return { sourceId, maxSources };
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
      // `private` is never exposed to PostgREST, which is why the
      // SECURITY DEFINER wrappers exist at all; this only picks which exposed
      // schema they are reached through.
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

    const { sourceId, maxSources } = parseRequest(await readJsonBody(request));

    const result = await runIngestion(
      {
        gateway: createAdminGateway(client, { rpcPrefix: routing.prefix }),
        fetchFeed,
        now: () => new Date(),
      },
      {
        trigger: sourceId ? 'manual' : 'cron',
        maxSources,
        sourceId,
      },
    );

    // Per-source detail stays in the log, not in the response body: the
    // response is a cron result, and slugs plus codes are enough to debug.
    console.log(
      JSON.stringify({
        event: 'sync_feeds_done',
        request_id: requestId,
        run_id: result.run_id,
        sources_ok: result.sources_ok,
        sources_failed: result.sources_failed,
        outcomes: result.outcomes.map((o) => ({
          slug: o.slug,
          code: o.code,
          inserted: o.inserted,
          // A headlines-only feed reports inserted === contentless. That is
          // normal, and it is the line that proves the Hugging Face fix landed.
          contentless: o.contentlessItems,
        })),
      }),
    );

    return jsonResponse(
      {
        run_id: result.run_id,
        sources_ok: result.sources_ok,
        sources_failed: result.sources_failed,
        inserted: result.inserted,
        updated: result.updated,
        unchanged: result.unchanged,
      },
      200,
      requestId,
    );
  } catch (cause) {
    console.error(
      JSON.stringify({
        event: 'sync_feeds_error',
        request_id: requestId,
        code: cause instanceof AppError ? cause.code : 'internal_error',
      }),
    );
    return errorResponse(cause, requestId);
  }
});
