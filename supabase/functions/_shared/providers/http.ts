/**
 * The HTTP layer both non-Anthropic providers share.
 *
 * Portable: Web APIs only, no Deno globals, no SDK. `fetch` is injected, so
 * every status-code branch below runs under Jest with no network.
 *
 * One place decides what an HTTP status means, so Gemini and NVIDIA cannot
 * drift into disagreeing about whether a 503 is worth retrying. The failure
 * codes are `anthropic.ts`'s, unchanged — a provider is judged by exactly the
 * rules Claude is.
 */

import type { EnrichmentFailureCode } from '../anthropic.ts';

/** Just the part of `fetch` these providers use. */
export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

/**
 * One minute per call.
 *
 * Longer than the 8/10-second feed fetches on purpose: a 70B model generating a
 * full Turkish translation is slow, and cutting it off wastes the tokens it
 * already spent. Shorter than an Edge invocation's ceiling, so the worker ends
 * on our terms rather than the platform's.
 */
export const PROVIDER_TIMEOUT_MS = 60000;

export type ProviderFailure = {
  ok: false;
  code: EnrichmentFailureCode;
  retryable: boolean;
  detail?: string;
  retryAfterSeconds?: number;
};

export type ProviderResponse =
  | { ok: true; status: number; json: unknown }
  | ProviderFailure;

/**
 * `Retry-After` is either delta-seconds or an HTTP date. Both are honoured;
 * anything else is ignored rather than guessed at.
 *
 * Capped at an hour so a mistaken or hostile header cannot park a job for days.
 */
export const MAX_RETRY_AFTER_SECONDS = 3600;

export function parseRetryAfter(
  header: string | null,
  now: () => number = Date.now,
): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;

  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed), MAX_RETRY_AFTER_SECONDS);
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const seconds = Math.ceil((at - now()) / 1000);
  if (seconds <= 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/**
 * Map an HTTP status to a failure code.
 *
 * The split follows the same reasoning as the Anthropic table: 408/409/429/5xx
 * and transport failures are transient; 400/401/403/404 mean the request itself
 * is wrong and will be just as wrong next time, so retrying only spends
 * quota.
 */
export function classifyProviderStatus(
  status: number,
  retryAfterSeconds?: number,
): ProviderFailure {
  if (status === 401) return { ok: false, code: 'auth', retryable: false };
  if (status === 403) return { ok: false, code: 'permission', retryable: false };
  if (status === 404) return { ok: false, code: 'not_found', retryable: false };
  if (status === 408) return { ok: false, code: 'timeout', retryable: true };
  if (status === 429) {
    return { ok: false, code: 'rate_limited', retryable: true, retryAfterSeconds };
  }
  if (status === 529) {
    return { ok: false, code: 'overloaded', retryable: true, retryAfterSeconds };
  }
  if (status >= 500) {
    return { ok: false, code: 'server_error', retryable: true, retryAfterSeconds };
  }
  if (status >= 400) {
    return { ok: false, code: 'bad_request', retryable: false, detail: `http_${status}` };
  }
  // 1xx/3xx from a JSON API: not an answer, and not something to retry into.
  return { ok: false, code: 'unexpected_stop', retryable: false, detail: `http_${status}` };
}

export type PostJsonOptions = {
  fetchImpl: FetchImpl;
  timeoutMs?: number;
  now?: () => number;
};

/**
 * POST JSON, read JSON, under a hard deadline.
 *
 * Failures come back as values, never thrown: the worker counts outcomes per
 * job, and one article's 429 must not end a run. Nothing from the response body
 * reaches the returned `detail` — an upstream error message can quote the
 * article, and arch-001 §3 keeps article text out of logs and rows alike.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: PostJsonOptions,
): Promise<ProviderResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROVIDER_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await options.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      return controller.signal.aborted
        ? { ok: false, code: 'timeout', retryable: true }
        : {
            ok: false,
            code: 'connection',
            retryable: true,
            detail: cause instanceof Error ? cause.name.slice(0, 40) : undefined,
          };
    }

    const retryAfter = parseRetryAfter(
      response.headers.get('retry-after'),
      options.now ?? Date.now,
    );

    if (!response.ok) {
      // The body may explain the failure, but it may also echo the prompt.
      // The status is enough to decide, so the body is never read.
      return classifyProviderStatus(response.status, retryAfter);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      // A 200 that is not JSON is a broken gateway, not a broken article.
      return { ok: false, code: 'server_error', retryable: true, detail: 'non_json_200' };
    }

    return { ok: true, status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}
