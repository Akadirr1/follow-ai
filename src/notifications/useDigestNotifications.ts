import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import type { PermissionStatus } from '../user-state/onboarding';
import { getPermissionStatus } from '../user-state/onboarding';
import { useUserSettings } from '../user-state/hooks';
import { getNotificationService } from './index';
import type { EnableResult } from './NotificationService';

/**
 * The screens' view of the notification service.
 *
 * Reconciliation runs on mount, on every return to the foreground, and whenever
 * the device's UTC offset changes — a reboot, an OS upgrade or a DST shift can
 * leave the OS with zero schedules where there should be one, and nothing else
 * would notice (arch-001 §4).
 */

/** Reading the offset is cheap; polling it is how a DST change is noticed at all. */
const TIMEZONE_POLL_MS = 60_000;

export type DigestNotificationsApi = {
  permission: PermissionStatus;
  /** True when the OS will actually deliver: granted or provisional. */
  canNotify: boolean;
  isReady: boolean;
  /** Turn the reminder on (or move it); returns what actually happened. */
  enable: (time: string) => Promise<EnableResult>;
  disable: () => Promise<void>;
  refreshPermission: () => Promise<PermissionStatus>;
};

export function useDigestNotifications(): DigestNotificationsApi {
  const { settings, update, isReady: settingsReady } = useUserSettings();
  const [permission, setPermission] = useState<PermissionStatus>('undetermined');
  const [isReady, setIsReady] = useState(false);
  const offset = useRef(new Date().getTimezoneOffset());

  const refreshPermission = useCallback(async () => {
    const status = await getNotificationService().checkPermission();
    setPermission(status);
    return status;
  }, []);

  // Seed from the last stored answer so the UI can explain itself before the OS
  // is consulted, then confirm with the OS.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await getPermissionStatus();
      if (!cancelled) setPermission(stored);
      const live = await getNotificationService().checkPermission();
      if (!cancelled) {
        setPermission(live);
        setIsReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const reconcile = useCallback(async () => {
    if (!settingsReady) return;
    const service = getNotificationService();
    const result = await service.reconcile({
      enabled: settings.digestEnabled,
      time: settings.digestTime,
    });
    if (result.action === 'skipped' && result.reason === 'permission') {
      // Revoked in OS settings while the app was away: stop claiming it is on.
      console.warn('[notifications] permission was revoked; disabling the digest reminder.');
      update({ digestEnabled: false });
      await refreshPermission();
    }
  }, [settings.digestEnabled, settings.digestTime, settingsReady, update, refreshPermission]);

  useEffect(() => {
    void reconcile();
  }, [reconcile]);

  useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      if (state !== 'active') return;
      void refreshPermission();
      void reconcile();
    };
    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, [reconcile, refreshPermission]);

  useEffect(() => {
    const timer = setInterval(() => {
      const current = new Date().getTimezoneOffset();
      if (current === offset.current) return;
      console.warn(
        `[notifications] timezone offset changed ${offset.current} → ${current}; reconciling.`,
      );
      offset.current = current;
      void reconcile();
    }, TIMEZONE_POLL_MS);
    return () => clearInterval(timer);
  }, [reconcile]);

  const enable = useCallback(
    async (time: string) => {
      const result = await getNotificationService().enableDigest(time);
      if (result.ok) {
        setPermission(result.permission);
        update({ digestTime: time, digestEnabled: true });
      } else if (result.status === 'permission_denied') {
        // Denial keeps the chosen time and turns the flag off — the user can
        // grant it later in OS settings without re-picking a slot.
        setPermission(result.permission);
        update({ digestTime: time, digestEnabled: false });
      }
      return result;
    },
    [update],
  );

  const disable = useCallback(async () => {
    await getNotificationService().disableDigest();
    update({ digestEnabled: false });
  }, [update]);

  return {
    permission,
    canNotify: permission === 'granted' || permission === 'provisional',
    isReady: isReady && settingsReady,
    enable,
    disable,
    refreshPermission,
  };
}
