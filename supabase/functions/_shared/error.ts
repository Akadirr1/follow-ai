/**
 * The error envelope every Edge Function returns (arch-001 §3).
 *
 * Portable: Web APIs only, no Deno globals. Unit-tested from Node via Jest.
 *
 * Shape:
 *   { error: { code, message, retryable, request_id }, retry_after_seconds? }
 *
 * `message` is a short, human-readable, *non-sensitive* string. It never
 * contains article bodies, tokens, keys, or a caller's full URL — arch-001 §3
 * forbids all four in responses and logs alike.
 */

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'rate_limited'
  | 'unsafe_url'
  | 'fetch_failed'
  | 'parse_failed'
  | 'upstream_error'
  | 'timeout'
  | 'internal_error';

/** Which failures a caller may usefully retry, and with what HTTP status. */
const ERROR_META: Record<ErrorCode, { status: number; retryable: boolean }> = {
  bad_request: { status: 400, retryable: false },
  unauthorized: { status: 401, retryable: false },
  forbidden: { status: 403, retryable: false },
  not_found: { status: 404, retryable: false },
  method_not_allowed: { status: 405, retryable: false },
  payload_too_large: { status: 413, retryable: false },
  rate_limited: { status: 429, retryable: true },
  unsafe_url: { status: 400, retryable: false },
  fetch_failed: { status: 502, retryable: true },
  parse_failed: { status: 422, retryable: false },
  upstream_error: { status: 502, retryable: true },
  timeout: { status: 504, retryable: true },
  internal_error: { status: 500, retryable: true },
};

export type ErrorEnvelope = {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    request_id: string;
  };
  retry_after_seconds?: number;
};

/** The only error type the functions throw across a boundary. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function statusFor(code: ErrorCode): number {
  return ERROR_META[code].status;
}

export function isRetryable(code: ErrorCode): boolean {
  return ERROR_META[code].retryable;
}

export function newRequestId(): string {
  // crypto.randomUUID is a Web API: present in Deno, Node 19+, and browsers.
  return globalThis.crypto.randomUUID();
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  retryAfterSeconds?: number,
): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    error: {
      code,
      message,
      retryable: isRetryable(code),
      request_id: requestId,
    },
  };
  if (typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0) {
    envelope.retry_after_seconds = Math.ceil(retryAfterSeconds);
  }
  return envelope;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, 'x-request-id': requestId, ...extraHeaders },
  });
}

/**
 * Turn anything thrown into the envelope. An unknown throwable becomes
 * `internal_error` with a fixed message: the original text may quote untrusted
 * upstream content, so it is deliberately not echoed to the caller.
 */
export function errorResponse(cause: unknown, requestId: string): Response {
  const err =
    cause instanceof AppError
      ? cause
      : new AppError('internal_error', 'Unexpected error.');

  const envelope = errorEnvelope(
    err.code,
    err.message,
    requestId,
    err.retryAfterSeconds,
  );

  const headers: Record<string, string> = {};
  if (envelope.retry_after_seconds !== undefined) {
    headers['retry-after'] = String(envelope.retry_after_seconds);
  }

  return jsonResponse(envelope, statusFor(err.code), requestId, headers);
}

/**
 * Reject unknown top-level fields (arch-001 §3). Returns the object narrowed to
 * the allowed keys, or throws `bad_request`.
 */
export function requireOnlyKeys<T extends string>(
  value: unknown,
  allowed: readonly T[],
): Record<T, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('bad_request', 'Body must be a JSON object.');
  }
  const allowedSet = new Set<string>(allowed as readonly string[]);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new AppError('bad_request', `Unknown field: ${key}`);
    }
  }
  return value as Record<T, unknown>;
}
