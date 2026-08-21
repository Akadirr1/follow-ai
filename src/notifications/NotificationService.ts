import type { PermissionStatus } from '../user-state/onboarding';
import type {
  NotificationStore,
  NotificationsApi,
  PermissionResponseLike,
  Platformish,
  ScheduledNotificationLike,
} from './types';

/**
 * One repeating local notification, and nothing else.
 *
 * No push token, no server, no background fetch (arch-001 §4). The whole job is
 * to keep exactly one daily schedule alive at the user's chosen time and to stay
 * honest when the OS says no.
 */

/** The Android channel, created *before* any permission request (Android 13). */
export const CHANNEL_ID = 'daily-digest';

/** Marks the schedules this app owns, so reconciliation never cancels someone else's. */
export const OWNED_MARKER = 'aigundem.daily-digest';

/** Where a tap lands. expo-router resolves this URL to the Digest tab. */
export const DEEP_LINK = '/(tabs)/digest';

/** The five slots the prototype offers; anything else is rejected. */
export const DIGEST_TIMES = ['07:00', '07:30', '08:00', '08:30', '09:00'] as const;
export type DigestTime = (typeof DIGEST_TIMES)[number];

export const isDigestTime = (value: string): value is DigestTime =>
  (DIGEST_TIMES as readonly string[]).includes(value);

/** Turkish copy for the notification itself. */
export const NOTIFICATION_TITLE = 'Bugünün AI Gündemi hazır';
export const NOTIFICATION_BODY = 'Günlük özetin seni bekliyor.';

export function parseDigestTime(time: string): { hour: number; minute: number } | null {
  if (!isDigestTime(time)) {
    console.warn(`[notifications] "${time}" is not one of ${DIGEST_TIMES.join(', ')}.`);
    return null;
  }
  const [hour, minute] = time.split(':').map(Number);
  return { hour, minute };
}

/**
 * Map a permission response onto our four states.
 *
 * iOS provisional (`ios.status === 3`) is a real grant — quiet notifications
 * delivered without a prompt — so it must not be read as denial. `undetermined`
 * means the OS has not been asked yet, which is different from a "no".
 */
export function toPermissionStatus(
  response: PermissionResponseLike | null | undefined,
): PermissionStatus {
  if (!response || typeof response.status !== 'string') {
    // A module that answers with nothing (an old OS, a stubbed build) must not
    // take a screen down; "we have not been told yes" is the safe reading.
    console.warn('[notifications] permission check returned no status; treating as undetermined.');
    return 'undetermined';
  }
  if (response.ios?.status === 3) return 'provisional';
  switch (response.status) {
    case 'granted':
      return response.granted === false ? 'denied' : 'granted';
    case 'provisional':
      return 'provisional';
    case 'undetermined':
      return 'undetermined';
    case 'denied':
      return 'denied';
    default:
      console.warn(`[notifications] unknown permission status "${response.status}".`);
      return 'denied';
  }
}

/** Provisional counts: the notification is delivered, just quietly. */
export const canSchedule = (status: PermissionStatus): boolean =>
  status === 'granted' || status === 'provisional';

export const isOwned = (scheduled: ScheduledNotificationLike): boolean =>
  scheduled.content?.data?.owner === OWNED_MARKER;

export type EnableResult =
  | { ok: true; status: 'scheduled'; notificationId: string; permission: PermissionStatus }
  | { ok: false; status: 'permission_denied'; permission: PermissionStatus }
  | { ok: false; status: 'invalid_time' }
  | { ok: false; status: 'unsupported' }
  | { ok: false; status: 'schedule_failed'; error: unknown };

export type NotificationServiceOptions = {
  api: NotificationsApi;
  store: NotificationStore;
  platform: Platformish;
};

export function createNotificationService({ api, store, platform }: NotificationServiceOptions) {
  const supported = platform.os === 'ios' || platform.os === 'android';

  /**
   * Android 13 will not show the permission dialog for a channel that does not
   * exist yet, so the channel is always created first — before asking, not after.
   */
  async function ensureChannel(): Promise<void> {
    if (platform.os !== 'android') return;
    await api.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Günlük digest',
      importance: 4, // AndroidImportance.HIGH
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
      lockscreenVisibility: 1, // PUBLIC
    });
  }

  /** What the OS currently thinks, without prompting. */
  async function checkPermission(): Promise<PermissionStatus> {
    if (!supported) return 'undetermined';
    let status: PermissionStatus;
    try {
      status = toPermissionStatus(await api.getPermissionsAsync());
    } catch (error) {
      console.warn('[notifications] permission check failed; treating as undetermined:', error);
      status = 'undetermined';
    }
    await store.setPermissionStatus(status);
    return status;
  }

  /**
   * Ask for permission. The caller must have shown the explanatory UI first —
   * this is the moment the OS dialog appears, and on iOS there is only one.
   */
  async function requestPermission(): Promise<PermissionStatus> {
    if (!supported) {
      console.warn('[notifications] permission request skipped: unsupported platform.');
      return 'undetermined';
    }
    try {
      await ensureChannel();
      const current = toPermissionStatus(await api.getPermissionsAsync());
      if (canSchedule(current)) {
        await store.setPermissionStatus(current);
        return current;
      }
      const status = toPermissionStatus(
        await api.requestPermissionsAsync({
          ios: { allowAlert: true, allowSound: true, allowBadge: false },
        }),
      );
      await store.setPermissionStatus(status);
      return status;
    } catch (error) {
      console.warn('[notifications] permission request failed:', error);
      await store.setPermissionStatus('denied');
      return 'denied';
    }
  }

  async function scheduleAt(time: DigestTime): Promise<string> {
    const parsed = parseDigestTime(time);
    if (!parsed) throw new Error(`invalid digest time: ${time}`);
    return api.scheduleNotificationAsync({
      content: {
        title: NOTIFICATION_TITLE,
        body: NOTIFICATION_BODY,
        // `url` is what expo-router follows on tap; `owner` is what
        // reconciliation matches on.
        data: { url: DEEP_LINK, owner: OWNED_MARKER },
      },
      // A daily (inexact) trigger, deliberately: an exact alarm would need
      // SCHEDULE_EXACT_ALARM on Android 12+ and a store-review justification for
      // a digest that is fine a few minutes late.
      trigger: { type: 'daily', hour: parsed.hour, minute: parsed.minute, channelId: CHANNEL_ID },
    });
  }

  async function cancel(id: string | null): Promise<void> {
    if (!id) return;
    try {
      await api.cancelScheduledNotificationAsync(id);
    } catch (error) {
      // A schedule the OS already dropped is not a failure worth propagating,
      // but it should not disappear silently either.
      console.warn(`[notifications] could not cancel schedule "${id}":`, error);
    }
  }

  /**
   * Turn the digest on, or move it to a new time.
   *
   * Order matters and is the whole point: **schedule the new one, persist its
   * id, then cancel the old one**. If scheduling fails the old schedule is still
   * alive, so a failed time change degrades to "the time did not change" rather
   * than "notifications silently stopped".
   */
  async function enableDigest(time: string): Promise<EnableResult> {
    if (!supported) {
      console.warn('[notifications] scheduling skipped: notifications are native-only.');
      return { ok: false, status: 'unsupported' };
    }
    if (!isDigestTime(time)) return { ok: false, status: 'invalid_time' };

    await ensureChannel();
    const permission = await requestPermission();
    if (!canSchedule(permission)) {
      return { ok: false, status: 'permission_denied', permission };
    }

    const previousId = await store.getNotificationId();
    let newId: string;
    try {
      newId = await scheduleAt(time);
    } catch (error) {
      console.warn('[notifications] scheduling failed; keeping the existing schedule:', error);
      return { ok: false, status: 'schedule_failed', error };
    }

    await store.setNotificationId(newId);
    if (previousId && previousId !== newId) await cancel(previousId);

    return { ok: true, status: 'scheduled', notificationId: newId, permission };
  }

  /** Turn it off. The chosen time is *not* forgotten — that lives in settings. */
  async function disableDigest(): Promise<void> {
    if (!supported) return;
    const id = await store.getNotificationId();
    await cancel(id);
    await store.setNotificationId(null);

    // Belt and braces: cancel any owned schedule that outlived its id, so a
    // disabled digest cannot keep firing from a forgotten identifier.
    for (const scheduled of await safeGetAll()) {
      if (isOwned(scheduled)) await cancel(scheduled.identifier);
    }
  }

  async function safeGetAll(): Promise<ScheduledNotificationLike[]> {
    try {
      return await api.getAllScheduledNotificationsAsync();
    } catch (error) {
      console.warn('[notifications] could not read scheduled notifications:', error);
      return [];
    }
  }

  /**
   * Bring the OS back to exactly one owned schedule, or none.
   *
   * Run on launch, on foreground and on a timezone change: a reboot, an OS
   * upgrade or a DST shift can leave zero schedules where there should be one,
   * or duplicates after a failed cancel. Schedules this app does not own are
   * never touched.
   */
  async function reconcile(desired: {
    enabled: boolean;
    time: string;
  }): Promise<
    | { action: 'none'; owned: number }
    | { action: 'cancelled'; owned: number }
    | { action: 'scheduled'; notificationId: string }
    | { action: 'deduplicated'; notificationId: string; cancelled: number }
    | { action: 'skipped'; reason: 'unsupported' | 'permission' | 'invalid_time' }
  > {
    if (!supported) return { action: 'skipped', reason: 'unsupported' };

    const all = await safeGetAll();
    const owned = all.filter(isOwned);

    if (!desired.enabled) {
      for (const scheduled of owned) await cancel(scheduled.identifier);
      await store.setNotificationId(null);
      return owned.length > 0
        ? { action: 'cancelled', owned: owned.length }
        : { action: 'none', owned: 0 };
    }

    if (!isDigestTime(desired.time)) return { action: 'skipped', reason: 'invalid_time' };

    const permission = await checkPermission();
    if (!canSchedule(permission)) {
      // The user revoked permission in OS settings. Drop our schedules and let
      // the caller turn the flag off rather than pretending it still works.
      for (const scheduled of owned) await cancel(scheduled.identifier);
      await store.setNotificationId(null);
      return { action: 'skipped', reason: 'permission' };
    }

    if (owned.length === 0) {
      const id = await scheduleAt(desired.time);
      await store.setNotificationId(id);
      return { action: 'scheduled', notificationId: id };
    }

    if (owned.length > 1) {
      // Keep the one we have a record of if it is still there, otherwise the
      // first; cancel the rest.
      const storedId = await store.getNotificationId();
      const keep = owned.find((s) => s.identifier === storedId) ?? owned[0];
      let cancelled = 0;
      for (const scheduled of owned) {
        if (scheduled.identifier === keep.identifier) continue;
        await cancel(scheduled.identifier);
        cancelled += 1;
      }
      await store.setNotificationId(keep.identifier);
      console.warn(`[notifications] reconciled ${owned.length} owned schedules down to one.`);
      return { action: 'deduplicated', notificationId: keep.identifier, cancelled };
    }

    // Exactly one: make sure our stored id points at it.
    await store.setNotificationId(owned[0].identifier);
    return { action: 'none', owned: 1 };
  }

  return {
    supported,
    ensureChannel,
    checkPermission,
    requestPermission,
    enableDigest,
    disableDigest,
    reconcile,
  };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
