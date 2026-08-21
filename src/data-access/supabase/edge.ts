import { env } from '../../config/env';
import { err, ok, type DataErrorCode, type Result } from '../../domain/errors';
import { getDeviceId, randomUuidV4 } from '../../identity/deviceId';

/**
 * Edge Function calls. Everything privileged or costly — adding a source, asking
 * for a summary — goes through here rather than through PostgREST, because the
 * client has no write grants anywhere (arch-001 §1).
 *
 * Every request carries three headers: the anon JWT as `apikey` and as the bearer
 * (Edge Functions with `verify_jwt=true` need a JWT, addendum §F) and
 * `X-Device-Id`, which is the rate-limit key (addendum §A). The device id goes
 * **only** here; PostgREST reads never carry it.
 */

/** The server's error envelope (arch-001 §3). */
export type EdgeErrorEnvelope = {
  error: {
    code?: string;
    message?: string;
    retryable?: boolean;
    request_id?: string;
  };
};

/**
 * Server error codes we can map to something better than `server`.
 *
 * The first block is `_shared/error.ts`'s `ErrorCode` union — what the deployed
 * functions actually emit. P10 N1 found the map keyed only on names no handler
 * ever sends (`invalid_url`, `not_a_feed`, …), so a "this is not a feed" answer
 * reached the user as "start the address with https://". The legacy names are
 * kept below because they cost nothing and a future handler may use them; the
 * ones that matter are the first block.
 *
 * `duplicate_source` is deliberately absent: an already-known feed is a **200**
 * with `created:false`, not an error. The mock repository still raises that code
 * locally, which is why the copy for it survives in AddSourceSheet.
 */
const CODE_MAP: Record<string, DataErrorCode> = {
  // Emitted by the deployed functions (supabase/functions/_shared/error.ts).
  bad_request: 'invalid_input',
  unsafe_url: 'invalid_input',
  parse_failed: 'unsupported_source',
  not_found: 'not_found',
  rate_limited: 'rate_limited',
  payload_too_large: 'invalid_input',
  // Names a handler could plausibly grow, mapped ahead of time.
  invalid_url: 'invalid_input',
  invalid_input: 'invalid_input',
  invalid_request: 'invalid_input',
  unsupported_source: 'unsupported_source',
  not_a_feed: 'unsupported_source',
  no_feed_discovered: 'unsupported_source',
  empty_feed: 'unsupported_source',
  blocked_host: 'unsupported_source',
  too_many_requests: 'rate_limited',
};

const isEnvelope = (value: unknown): value is EdgeErrorEnvelope =>
  typeof value === 'object' && value !== null && 'error' in value;

export type EdgeConfig = { supabaseUrl: string | null; supabaseAnonKey: string | null };

export type EdgeCallOptions = {
  /** Overridable so tests can drive the call without a global fetch stub. */
  fetchImpl?: typeof fetch;
  /**
   * Project URL + anon key. Defaults to the validated `env`, which is frozen;
   * injecting it keeps this function testable without mocking the config module.
   */
  config?: EdgeConfig;
  /** Milliseconds before the request is aborted. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export const EDGE_TIMEOUT_MS = 15_000;

/**
 * POST a JSON body to an Edge Function and return either the parsed payload or a
 * typed `DataError`. Never throws: a transport failure, a timeout and a 500 all
 * come back as `Result`.
 */
export async function callEdgeFunction<T>(
  name: string,
  body: Record<string, unknown>,
  options: EdgeCallOptions = {},
): Promise<Result<{ status: number; data: T }>> {
  const { supabaseUrl, supabaseAnonKey } = options.config ?? env;
  if (!supabaseUrl || !supabaseAnonKey) {
    return err('not_implemented', `[edge] ${name}: Supabase is not configured in this build.`);
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return err('not_implemented', `[edge] ${name}: no fetch implementation available.`);
  }

  const deviceId = await getDeviceId();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? EDGE_TIMEOUT_MS);
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let response: Response;
  try {
    response = await fetchImpl(`${supabaseUrl}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
        'X-Device-Id': deviceId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    return err('network', `[edge] ${name}: ${error instanceof Error ? error.message : String(error)}`, {
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }

  let payload: unknown = null;
  try {
    const text = await response.text();
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    // A body we cannot parse is a server problem, not a caller problem.
    console.warn(`[edge] ${name}: response body was not JSON:`, error);
  }

  if (response.ok) {
    return ok({ status: response.status, data: payload as T });
  }

  if (response.status === 404) {
    // P3 may not be deployed yet; say which function is missing rather than
    // surfacing a bare 404 to the UI.
    return err(
      'not_implemented',
      `[edge] ${name}: function is not deployed (404).`,
      { details: { status: 404 } },
    );
  }

  if (isEnvelope(payload)) {
    const envelope = payload.error;
    const code = CODE_MAP[envelope.code ?? ''] ?? (response.status >= 500 ? 'server' : 'invalid_input');
    return err(code, `[edge] ${name}: ${envelope.message ?? 'request failed'}`, {
      retryable: envelope.retryable ?? response.status >= 500,
      details: {
        status: response.status,
        ...(envelope.code ? { serverCode: envelope.code } : {}),
        ...(envelope.request_id ? { requestId: envelope.request_id } : {}),
      },
    });
  }

  return err(
    response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'server' : 'invalid_input',
    `[edge] ${name}: HTTP ${response.status}`,
    { retryable: response.status === 429 || response.status >= 500, details: { status: response.status } },
  );
}

/**
 * Idempotency key for a retryable Edge write (arch-001 §6: explicit mutation ids).
 *
 * It must be a **uuid v4**: every handler runs `isUuidV4` on it and answers 400
 * `bad_request` otherwise. A shorter "unique enough" id shipped here once and
 * failed every Edge write in supabase mode while every curl smoke passed, because
 * those used real uuids (P10 B1).
 */
export const clientRequestId = (): string => randomUuidV4();
