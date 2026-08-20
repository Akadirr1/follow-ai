import type { Cursor } from '../domain/types';

/**
 * Keyset cursors over `(published_at DESC, article_id DESC)`.
 *
 * The DTO `Cursor` is branded so callers cannot fabricate one; these helpers are
 * the only sanctioned way to make one from a row and to serialise it. Serialising
 * matters because a cursor can end up inside a persisted query cache, where it has
 * to survive JSON round-trips without becoming a plain object a caller could edit.
 */

/** Build a cursor from the last row of a page. */
export const cursorOf = (publishedAt: string, id: string): Cursor => ({ publishedAt, id });

/** URL-safe base64 of the JSON pair. Opaque to callers by construction. */
export function encodeCursor(cursor: Cursor): string {
  const json = JSON.stringify({ p: cursor.publishedAt, i: cursor.id });
  const base64 =
    typeof btoa === 'function'
      ? btoa(unescape(encodeURIComponent(json)))
      : Buffer.from(json, 'utf8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns null (with a warning) for anything that is not one of ours. */
export function decodeCursor(encoded: string): Cursor | null {
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const json =
      typeof atob === 'function'
        ? decodeURIComponent(escape(atob(base64)))
        : Buffer.from(base64, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as { p?: unknown; i?: unknown };
    if (typeof parsed.p !== 'string' || typeof parsed.i !== 'string') {
      console.warn(`[cursor] decoded value is not a cursor: ${json}`);
      return null;
    }
    return cursorOf(parsed.p, parsed.i);
  } catch (error) {
    console.warn(`[cursor] could not decode "${encoded}":`, error);
    return null;
  }
}

/**
 * The PostgREST filter for "strictly after this cursor" in `(published_at, id)`
 * DESC order. Written as one `or(...)` so PostgREST keeps it in a single WHERE
 * clause the `(published_at desc, id desc)` index can serve.
 *
 * Timestamps come back from PostgREST already normalised, and both parts are
 * quoted, so a value containing a comma or paren cannot break out of the filter.
 */
export const keysetFilter = (cursor: Cursor): string =>
  `published_at.lt."${cursor.publishedAt}",and(published_at.eq."${cursor.publishedAt}",article_id.lt."${cursor.id}")`;
