import type { Cursor } from '../domain/types';

/**
 * Keyset cursors over `(publishedAt DESC, id DESC)` — the one place a `Cursor` is
 * minted, serialised or parsed.
 *
 * `Cursor`'s brand is required (rev-002 N2), so `{publishedAt, id}` does not
 * satisfy the type: the only ways to obtain one are `cursorOf` (from a row this
 * layer just read) and `decodeCursor` (validated). The single cast lives here,
 * which is what makes the opacity claim true rather than decorative.
 *
 * Serialising matters because a cursor can end up inside a persisted query cache,
 * where it has to survive a JSON round-trip without becoming a plain object a
 * caller could edit into an arbitrary offset.
 */

/** The only place a cursor is created. Both adapters call it. */
export const cursorOf = (publishedAt: string, id: string): Cursor =>
  ({ publishedAt, id }) as Cursor;

/** URL-safe base64 of the JSON pair. Opaque to callers by construction. */
export function encodeCursor(cursor: Cursor): string {
  const json = JSON.stringify({ p: cursor.publishedAt, i: cursor.id });
  const base64 =
    typeof btoa === 'function'
      ? btoa(unescape(encodeURIComponent(json)))
      : Buffer.from(json, 'utf8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Parse an encoded cursor. Returns null (with a warning) for anything that is not
 * one of ours — a truncated string, a hand-written object, a value from an older
 * cache version. Callers treat null as "start from the top" rather than crashing.
 */
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
    if (!parsed.p || !parsed.i) {
      console.warn('[cursor] decoded cursor has an empty publishedAt or id.');
      return null;
    }
    return cursorOf(parsed.p, parsed.i);
  } catch (error) {
    console.warn(`[cursor] could not decode "${encoded}":`, error);
    return null;
  }
}

/** True when `item` sorts strictly after `cursor` in `(publishedAt, id)` DESC. */
export const isAfterCursor = (
  item: { publishedAt: string; id: string },
  cursor: Cursor,
): boolean =>
  item.publishedAt < cursor.publishedAt ||
  (item.publishedAt === cursor.publishedAt && item.id < cursor.id);

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
