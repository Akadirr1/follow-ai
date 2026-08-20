/**
 * Fixed-window rate-limit arithmetic.
 *
 * Portable: no Deno globals, no clock of its own — `now` is always passed in, which
 * is what makes every case below testable without faking timers.
 *
 * This module does NOT count anything. The counter is
 * `private.rate_limit_buckets`, incremented atomically by
 * `aigundem.internal_bump_rate_limit(subject, action, window_start, limit)`,
 * which returns whether the caller is still inside the limit. All this file
 * does is agree with Postgres about where a window starts and when it ends —
 * if the two disagreed, a device could get a fresh allowance early by retrying.
 *
 * Fixed windows, not sliding: they cost one row and one upsert. The known cost
 * is the boundary burst — a device can spend its allowance at the end of one
 * window and again at the start of the next. For a 5-per-24h source-add limit
 * that is 10 adds in a minute, which is acceptable; if it stops being
 * acceptable the fix is a sliding window in SQL, not arithmetic here.
 */

/** Actions that carry a limit, matching `private.rate_limit_buckets.action`. */
export type RateLimitAction = 'add_source' | 'request_enrichment_miss' | 'request_enrichment_check';

export type RateLimitPolicy = {
  action: RateLimitAction;
  limit: number;
  windowSeconds: number;
};

export const DAY_SECONDS = 24 * 60 * 60;
export const HOUR_SECONDS = 60 * 60;

/** arch-001 §3: "inferred initial limit 5 attempts/device/24h". */
export const ADD_SOURCE_POLICY: RateLimitPolicy = {
  action: 'add_source',
  limit: 5,
  windowSeconds: DAY_SECONDS,
};

export type Window = {
  /** Inclusive start, ISO 8601 UTC — the `window_start` primary-key column. */
  windowStart: string;
  windowStartMs: number;
  /** Exclusive end. */
  windowEndMs: number;
  /** Whole seconds until the window rolls over; always >= 1. */
  retryAfterSeconds: number;
};

/**
 * The window containing `now`, aligned to absolute epoch boundaries.
 *
 * Alignment matters: both the function and Postgres must derive the same
 * `window_start` from the same instant, and epoch-floor is the one rule that
 * needs no shared state, no timezone and no per-subject bookkeeping.
 */
export function windowFor(now: Date, windowSeconds: number): Window {
  if (!Number.isFinite(windowSeconds) || windowSeconds < 1) {
    throw new RangeError('windowSeconds must be a positive number of seconds.');
  }
  const windowMs = Math.floor(windowSeconds) * 1000;
  const nowMs = now.getTime();
  const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
  const windowEndMs = windowStartMs + windowMs;
  return {
    windowStart: new Date(windowStartMs).toISOString(),
    windowStartMs,
    windowEndMs,
    retryAfterSeconds: Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000)),
  };
}

/** Convenience: the window for a policy. */
export function windowForPolicy(policy: RateLimitPolicy, now: Date): Window {
  return windowFor(now, policy.windowSeconds);
}

export type RateLimitDecision = {
  allowed: boolean;
  action: RateLimitAction;
  limit: number;
  window: Window;
  /** Only meaningful when `allowed` is false. */
  retryAfterSeconds: number;
};

/**
 * Turn the boolean that `internal_bump_rate_limit` returned into the decision
 * the handler acts on. The count itself never leaves Postgres, so a caller
 * cannot learn how much of someone else's allowance is left.
 */
export function decide(
  policy: RateLimitPolicy,
  now: Date,
  allowedByCounter: boolean,
): RateLimitDecision {
  const window = windowForPolicy(policy, now);
  return {
    allowed: allowedByCounter,
    action: policy.action,
    limit: policy.limit,
    window,
    retryAfterSeconds: window.retryAfterSeconds,
  };
}

/**
 * Exponential backoff with full jitter, for retrying a failed source fetch.
 *
 * `random` is injected so the schedule is deterministic under test. Used by
 * `sync-feeds` to set `sources.next_fetch_at` after a failure, so a dead feed
 * backs off instead of being retried every 15 minutes forever.
 */
export function backoffSeconds(
  attempt: number,
  options: {
    baseSeconds?: number;
    maxSeconds?: number;
    random?: () => number;
  } = {},
): number {
  const base = options.baseSeconds ?? 15 * 60;
  const max = options.maxSeconds ?? 24 * 60 * 60;
  const random = options.random ?? Math.random;
  const safeAttempt = Math.max(1, Math.min(Math.floor(attempt), 20));
  const ceiling = Math.min(max, base * 2 ** (safeAttempt - 1));
  // Full jitter: uniform in [base, ceiling]. Never below one base interval, so
  // a flapping feed cannot be retried faster than a healthy one.
  return Math.round(base + random() * Math.max(0, ceiling - base));
}

/** Is this a well-formed uuid v4, as required of `X-Device-Id`? */
export function isUuidV4(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
