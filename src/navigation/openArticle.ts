import type { Href } from 'expo-router';

/**
 * Guarded navigation to the article detail.
 *
 * rev-001 N1: feed, saved and search each dispatched and then called
 * `router.push` with no in-flight guard, so two quick taps could push the same
 * route twice and leave the user pressing Back twice to get out. The prototype
 * had one `view = 'detail'` transition and no such state.
 *
 * The guard is time-based rather than route-based because the second tap lands
 * before the router has re-rendered: there is nothing to compare against yet.
 */

/** Window in which a repeat push for the same article is swallowed. */
export const DOUBLE_PUSH_WINDOW_MS = 700;

/**
 * Just the slice of expo-router this needs. `Href` keeps typed routes happy at
 * the call sites while a test can still pass `{ push: jest.fn() }`.
 */
export type Pusher = { push: (href: Href) => void };

type LastPush = { id: string; at: number };

let lastPush: LastPush | null = null;

/** Test seam — the module-level guard would otherwise leak between tests. */
export function resetNavigationGuard(): void {
  lastPush = null;
}

export const articleHref = (id: string): Href => `/article/${id}` as Href;

/**
 * Push the article route unless the same article was just pushed.
 *
 * Returns whether the push happened, so a caller that also mutates state (mark
 * read, push a recent search) can skip the duplicate work too.
 */
export function openArticle(
  router: Pusher,
  id: string,
  options: { now?: () => number; onOpen?: () => void } = {},
): boolean {
  const trimmed = id?.trim();
  if (!trimmed) {
    console.warn('[navigation] openArticle called without an article id.');
    return false;
  }

  const now = options.now ? options.now() : Date.now();
  if (lastPush && lastPush.id === trimmed && now - lastPush.at < DOUBLE_PUSH_WINDOW_MS) {
    console.warn(`[navigation] duplicate push for article "${trimmed}" swallowed.`);
    return false;
  }

  lastPush = { id: trimmed, at: now };
  options.onOpen?.();
  router.push(articleHref(trimmed));
  return true;
}
