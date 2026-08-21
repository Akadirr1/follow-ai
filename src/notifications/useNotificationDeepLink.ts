import { useEffect } from 'react';
import { useRouter } from 'expo-router';

import { DEEP_LINK, OWNED_MARKER } from './NotificationService';

/**
 * Tapping the daily reminder opens the Digest tab.
 *
 * `expo-notifications` is subscribed to lazily and only on native: importing it
 * at module scope would put it in the web graph, and there is nothing to listen
 * for there anyway. The listener is added once, at the root.
 */

type ResponseLike = {
  notification?: { request?: { content?: { data?: Record<string, unknown> | null } | null } | null };
};

/** The URL a tapped notification should open, or null if it is not ours. */
export function deepLinkFor(response: ResponseLike | null | undefined): string | null {
  const data = response?.notification?.request?.content?.data;
  if (!data || data.owner !== OWNED_MARKER) return null;
  return typeof data.url === 'string' && data.url ? data.url : DEEP_LINK;
}

export function useNotificationDeepLink(): void {
  const router = useRouter();

  useEffect(() => {
    let subscription: { remove: () => void } | null = null;
    let cancelled = false;

    (async () => {
      let notifications: {
        addNotificationResponseReceivedListener: (
          handler: (response: ResponseLike) => void,
        ) => { remove: () => void };
        getLastNotificationResponseAsync: () => Promise<ResponseLike | null>;
      };
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        notifications = require('expo-notifications');
        if (typeof notifications?.addNotificationResponseReceivedListener !== 'function') return;
      } catch {
        // Web, or a build without the module: nothing to listen for.
        return;
      }

      // A tap that launched the app from cold has already happened by now.
      try {
        const initial = await notifications.getLastNotificationResponseAsync();
        const url = deepLinkFor(initial);
        if (url && !cancelled) router.push(url as never);
      } catch (error) {
        console.warn('[notifications] could not read the launch notification:', error);
      }

      if (cancelled) return;
      subscription = notifications.addNotificationResponseReceivedListener((response) => {
        const url = deepLinkFor(response);
        if (url) router.push(url as never);
      });
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [router]);
}
