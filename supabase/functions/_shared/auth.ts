/**
 * Request authentication helpers.
 *
 * Portable: Web APIs only, no Deno globals. The secret and the headers are passed
 * in, so every branch is testable without a server.
 */

import { AppError } from './error.ts';
import { isUuidV4 } from './rate-limit.ts';

const encoder = new TextEncoder();

/**
 * Constant-time string comparison.
 *
 * `a === b` on a secret leaks its length and its longest matching prefix
 * through timing. This compares every byte of the longer input regardless of
 * where the first difference is, and folds the length difference into the same
 * accumulator so an early length mismatch is not a fast path either.
 *
 * The inputs are secrets of bounded length, so the extra work is negligible.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Internal-only endpoints (`sync-feeds`, and later `process-enrichments` and
 * `build-digest`): the caller must present the shared automations secret.
 *
 * Fails closed when the secret is not configured — an unset secret must never
 * mean "let everyone in".
 */
export function requireInternalSecret(
  headers: Headers,
  expected: string | undefined,
): void {
  if (!expected || expected.length < 16) {
    throw new AppError(
      'internal_error',
      'Automations secret is not configured.',
    );
  }
  const presented = headers.get('x-internal-secret') ?? '';
  if (presented === '' || !timingSafeEqual(presented, expected)) {
    throw new AppError('unauthorized', 'Invalid or missing internal secret.');
  }
}

/**
 * Client endpoints identify the caller by device, not by user: v1 creates no
 * Supabase users (addendum §A). The JWT is still verified — Supabase's
 * `verify_jwt` gate does that before the handler runs — but it carries no
 * identity worth using, so rate limiting keys on `X-Device-Id`.
 *
 * A device id is trivially forgeable, which is why it limits abuse rate rather
 * than granting access: every endpoint it guards is either read-only or writes
 * shared, public content.
 */
export function requireDeviceId(headers: Headers): string {
  const raw = headers.get('x-device-id');
  if (!isUuidV4(raw)) {
    throw new AppError('bad_request', 'X-Device-Id must be a uuid v4.');
  }
  return raw.toLowerCase();
}

/** Reject anything but the expected method, so a stray GET cannot mutate. */
export function requireMethod(request: Request, method: 'POST' | 'GET'): void {
  if (request.method !== method) {
    throw new AppError('method_not_allowed', `Use ${method}.`);
  }
}

/** Parse a bounded JSON body. An empty body is an empty object. */
export async function readJsonBody(
  request: Request,
  maxBytes = 16 * 1024,
): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new AppError('payload_too_large', 'Request body is too large.');
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new AppError('bad_request', 'Could not read request body.');
  }
  if (text.length > maxBytes) {
    throw new AppError('payload_too_large', 'Request body is too large.');
  }
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('bad_request', 'Body is not valid JSON.');
  }
}
