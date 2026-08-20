/**
 * Fixed-window arithmetic, backoff and the device-id guard.
 *
 * These are the numbers the TypeScript side must agree with Postgres about: if
 * `windowStart` here did not match the `window_start` primary-key value
 * `private.rate_limit_buckets` stores, a device would get a fresh allowance
 * simply by retrying.
 */
import {
  ADD_SOURCE_POLICY,
  backoffSeconds,
  DAY_SECONDS,
  decide,
  HOUR_SECONDS,
  isUuidV4,
  windowFor,
  windowForPolicy,
} from '../functions/_shared/rate-limit.ts';

describe('windowFor', () => {
  it('floors to an absolute epoch boundary, so both writers agree', () => {
    const window = windowFor(new Date('2026-08-21T13:47:11.512Z'), DAY_SECONDS);
    expect(window.windowStart).toBe('2026-08-21T00:00:00.000Z');
    expect(new Date(window.windowEndMs).toISOString()).toBe('2026-08-22T00:00:00.000Z');
  });

  it('returns the same window for every instant inside it', () => {
    const first = windowFor(new Date('2026-08-21T00:00:00.000Z'), DAY_SECONDS);
    const middle = windowFor(new Date('2026-08-21T12:00:00.000Z'), DAY_SECONDS);
    const last = windowFor(new Date('2026-08-21T23:59:59.999Z'), DAY_SECONDS);
    expect(middle.windowStart).toBe(first.windowStart);
    expect(last.windowStart).toBe(first.windowStart);
  });

  it('rolls over exactly at the boundary', () => {
    const before = windowFor(new Date('2026-08-21T23:59:59.999Z'), DAY_SECONDS);
    const after = windowFor(new Date('2026-08-22T00:00:00.000Z'), DAY_SECONDS);
    expect(after.windowStart).not.toBe(before.windowStart);
    expect(after.windowStartMs).toBe(before.windowEndMs);
  });

  it('counts down to the rollover, never to zero', () => {
    expect(windowFor(new Date('2026-08-21T00:00:00Z'), DAY_SECONDS).retryAfterSeconds).toBe(
      DAY_SECONDS,
    );
    expect(windowFor(new Date('2026-08-21T23:00:00Z'), DAY_SECONDS).retryAfterSeconds).toBe(
      HOUR_SECONDS,
    );
    expect(
      windowFor(new Date('2026-08-21T23:59:59.999Z'), DAY_SECONDS).retryAfterSeconds,
    ).toBe(1);
  });

  it('supports an hourly window too', () => {
    const window = windowFor(new Date('2026-08-21T13:47:11Z'), HOUR_SECONDS);
    expect(window.windowStart).toBe('2026-08-21T13:00:00.000Z');
  });

  it('refuses a nonsensical window length', () => {
    expect(() => windowFor(new Date(), 0)).toThrow(RangeError);
    expect(() => windowFor(new Date(), Number.NaN)).toThrow(RangeError);
  });
});

describe('ADD_SOURCE_POLICY', () => {
  it('is the 5-per-device-per-24h limit arch-001 §3 specifies', () => {
    expect(ADD_SOURCE_POLICY).toEqual({
      action: 'add_source',
      limit: 5,
      windowSeconds: DAY_SECONDS,
    });
  });

  it('produces a decision that carries the retry hint but never the count', () => {
    const now = new Date('2026-08-21T20:00:00Z');
    const denied = decide(ADD_SOURCE_POLICY, now, false);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(4 * HOUR_SECONDS);
    expect(denied.window.windowStart).toBe(windowForPolicy(ADD_SOURCE_POLICY, now).windowStart);
    expect(Object.keys(denied)).not.toContain('count');
  });
});

describe('backoffSeconds', () => {
  const noJitter = () => 0;
  const fullJitter = () => 1;

  it('never retries a failing feed faster than a healthy one', () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect(backoffSeconds(attempt, { random: noJitter })).toBeGreaterThanOrEqual(15 * 60);
    }
  });

  it('doubles the ceiling per attempt until it saturates', () => {
    expect(backoffSeconds(1, { random: fullJitter })).toBe(15 * 60);
    expect(backoffSeconds(2, { random: fullJitter })).toBe(30 * 60);
    expect(backoffSeconds(3, { random: fullJitter })).toBe(60 * 60);
    expect(backoffSeconds(20, { random: fullJitter })).toBe(24 * 60 * 60);
  });

  it('stays inside [base, ceiling] for any random draw', () => {
    for (const draw of [0, 0.25, 0.5, 0.75, 1]) {
      const value = backoffSeconds(4, { random: () => draw });
      expect(value).toBeGreaterThanOrEqual(15 * 60);
      expect(value).toBeLessThanOrEqual(2 * 60 * 60);
    }
  });

  it('clamps a nonsensical attempt number instead of overflowing', () => {
    expect(backoffSeconds(0, { random: fullJitter })).toBe(15 * 60);
    expect(backoffSeconds(-5, { random: fullJitter })).toBe(15 * 60);
    expect(backoffSeconds(9999, { random: fullJitter })).toBe(24 * 60 * 60);
  });
});

describe('isUuidV4', () => {
  it('accepts a real v4 and rejects everything else', () => {
    expect(isUuidV4('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    expect(isUuidV4('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true);
    // Version nibble is 1, not 4.
    expect(isUuidV4('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(false);
    // Variant nibble out of range.
    expect(isUuidV4('3f2504e0-4f89-41d3-1a0c-0305e82c3301')).toBe(false);
    expect(isUuidV4('not-a-uuid')).toBe(false);
    expect(isUuidV4('')).toBe(false);
    expect(isUuidV4(null)).toBe(false);
    expect(isUuidV4(undefined)).toBe(false);
    expect(isUuidV4(42)).toBe(false);
  });

  it('accepts what crypto.randomUUID actually produces', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(isUuidV4(globalThis.crypto.randomUUID())).toBe(true);
    }
  });
});
