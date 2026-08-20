/**
 * `add-source` — the Deno boundary for user-submitted feeds.
 *
 * Thin on purpose: URL safety, feed resolution, discovery, rate-limit
 * arithmetic and slug derivation all live in `../_shared/*` and are unit-tested
 * from Node. What is here is `Deno.serve`, `Deno.env`, `Deno.resolveDns` and
 * the Supabase client.
 *
 * Auth: Supabase's `verify_jwt` gate (left at its default, true) requires a
 * bearer JWT — the legacy `anon` key, per addendum §F. That JWT carries no user
 * identity in v1, so the *rate-limited* subject is the `X-Device-Id` header
 * (addendum §A).
 *
 * Request:  {"url", "category", "language", "client_request_id"}
 * Response: 201 {"source", "client_request_id"} for a new source,
 *           200 {"source", "client_request_id"} when the feed already exists.
 *
 * The created row is SHARED and starts as `pending`: P2's RLS shows clients
 * only `active` sources, so a source nobody has ingested yet stays out of the
 * catalogue until `sync-feeds` succeeds against it once. The device's own
 * subscription to it is stored on the device, not here.
 */

import { createClient } from '@supabase/supabase-js';

import { displayNameFor, resolveFeed } from '../_shared/add-source.ts';
import { readJsonBody, requireDeviceId, requireMethod } from '../_shared/auth.ts';
import {
  AppError,
  errorResponse,
  jsonResponse,
  newRequestId,
  requireOnlyKeys,
} from '../_shared/error.ts';
import { urlHashHex } from '../_shared/hash.ts';
import { ADD_SOURCE_POLICY, isUuidV4, windowForPolicy } from '../_shared/rate-limit.ts';
import {
  Category,
  createAdminGateway,
  isCategory,
  isSourceLanguage,
  slugify,
  SourceLanguage,
} from '../_shared/supabase-admin.ts';
import { checkUrlShape, DEFAULT_MAX_BYTES } from '../_shared/url-safety.ts';

const FETCH_TIMEOUT_MS = 8000;

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
        // One family missing is normal; zero answers overall is a rejection.
      }
    }
    return answers;
  };
}

type AddSourceRequest = {
  url: string;
  category: Category;
  language: SourceLanguage;
  clientRequestId: string;
};

function parseRequest(body: unknown): AddSourceRequest {
  const fields = requireOnlyKeys(body, [
    'url',
    'category',
    'language',
    'client_request_id',
  ] as const);

  if (typeof fields.url !== 'string' || fields.url.trim() === '') {
    throw new AppError('bad_request', 'url is required.');
  }
  if (!isCategory(fields.category)) {
    throw new AppError('bad_request', 'category is not one of the five categories.');
  }
  if (!isSourceLanguage(fields.language)) {
    throw new AppError('bad_request', "language must be 'en' or 'tr'.");
  }
  if (!isUuidV4(fields.client_request_id)) {
    throw new AppError('bad_request', 'client_request_id must be a uuid v4.');
  }

  return {
    url: fields.url.trim(),
    category: fields.category,
    language: fields.language,
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

    // Cheap, network-free rejections first: a malformed or unsafe URL must not
    // cost the caller a rate-limit slot.
    const shape = checkUrlShape(input.url);
    if (!shape.ok) {
      throw new AppError('unsafe_url', `URL rejected: ${shape.reason}`);
    }

    const routing = rpcRouting();
    const client = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: routing.schema },
      global: { headers: { 'x-request-id': requestId } },
    });
    const gateway = createAdminGateway(client, { rpcPrefix: routing.prefix });

    // 5 per device per 24 h (arch-001 §3). The counter is incremented in
    // Postgres, so two concurrent requests cannot both see the last slot.
    const now = new Date();
    const window = windowForPolicy(ADD_SOURCE_POLICY, now);
    const allowed = await gateway.bumpRateLimit(
      deviceId,
      ADD_SOURCE_POLICY.action,
      window.windowStart,
      ADD_SOURCE_POLICY.limit,
    );
    if (!allowed) {
      throw new AppError(
        'rate_limited',
        'Daily limit for adding sources reached.',
        window.retryAfterSeconds,
      );
    }

    const resolved = await resolveFeed(shape.url, {
      fetchImpl: fetch,
      resolve: dnsResolver(),
      // User input: with no resolver available the guard refuses rather than
      // fetching an unclassified destination.
      requireDns: true,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: DEFAULT_MAX_BYTES,
      now: () => now,
    });

    if (!resolved.ok) {
      const code = resolved.code === 'unsafe_url' ? 'unsafe_url' : 'fetch_failed';
      throw new AppError(code, `Feed rejected: ${resolved.code}`);
    }

    const name = displayNameFor(resolved.feed);
    const source = await gateway.upsertSource({
      slug: slugify(name),
      name,
      feedUrl: resolved.feed.feedUrl,
      feedUrlHash: await urlHashHex(resolved.feed.feedUrl),
      siteUrl: resolved.feed.siteUrl,
      language: input.language,
      category: input.category,
    });

    console.log(
      JSON.stringify({
        event: 'add_source_done',
        request_id: requestId,
        created: source.created,
        slug: source.slug,
        discovered: resolved.feed.discovered,
        items: resolved.feed.itemCount,
      }),
    );

    return jsonResponse(
      { source, client_request_id: input.clientRequestId },
      source.created ? 201 : 200,
      requestId,
    );
  } catch (cause) {
    console.error(
      JSON.stringify({
        event: 'add_source_error',
        request_id: requestId,
        code: cause instanceof AppError ? cause.code : 'internal_error',
      }),
    );
    return errorResponse(cause, requestId);
  }
});
