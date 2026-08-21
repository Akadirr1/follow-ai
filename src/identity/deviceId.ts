import { KV_KEYS, kv, type KvStore } from '../storage/kv';

/**
 * Device identity. v1 creates no Supabase users (addendum §A), so "who is this"
 * is a uuid v4 generated once per install and kept in the kv store.
 *
 * It is sent as `X-Device-Id` on Edge calls only — it is a rate-limit and
 * attribution key, never an authorization claim, and PostgREST reads never carry
 * it. Nothing about the user is derivable from it and it is not linked to any
 * personal data.
 */

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isDeviceId = (value: unknown): value is string =>
  typeof value === 'string' && UUID_V4.test(value);

/**
 * uuid v4 from `crypto.getRandomValues`, which React Native, Hermes and every
 * browser provide. `crypto.randomUUID` is not used because it is missing on some
 * RN runtimes; this path is the same everywhere.
 *
 * Named for what it produces rather than for its first caller: the Edge
 * idempotency key needs the same uuid v4, and every server handler validates the
 * shape (P10 B1 — a home-grown "unique enough" id was rejected with 400).
 */
export function randomUuidV4(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    // A device id only has to be unique, not unguessable — but a weak source is
    // still worth saying out loud, because collisions would merge two devices'
    // rate-limit buckets.
    console.warn('[identity] crypto.getRandomValues unavailable; falling back to Math.random.');
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The device-identity spelling of the same generator. */
export const generateDeviceId = randomUuidV4;

/** In-flight promise, so concurrent callers on first run cannot mint two ids. */
let pending: Promise<string> | null = null;
let cached: string | null = null;

/**
 * Read the device id, generating and persisting one on first run. Subsequent
 * calls return the same value from memory.
 */
export async function getDeviceId(storage: KvStore = kv): Promise<string> {
  if (cached) return cached;
  if (pending) return pending;

  pending = (async () => {
    const stored = await storage.getItem(KV_KEYS.deviceId);
    if (isDeviceId(stored)) {
      cached = stored;
      return stored;
    }
    if (stored !== null) {
      // Something wrote a non-uuid here; replacing it resets this device's
      // rate-limit bucket, which is worth a line in the log.
      console.warn(`[identity] stored device id "${stored}" is not a uuid v4; regenerating.`);
    }
    const fresh = generateDeviceId();
    await storage.setItem(KV_KEYS.deviceId, fresh);
    cached = fresh;
    return fresh;
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}

/** Test seam: drops the memoised id so the next call re-reads storage. */
export function resetDeviceIdCache(): void {
  cached = null;
  pending = null;
}
