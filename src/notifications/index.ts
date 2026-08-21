import { Platform } from 'react-native';

import {
  getNotificationId,
  getPermissionStatus,
  setNotificationId,
  setPermissionStatus,
} from '../user-state/onboarding';
import { createNotificationService, type NotificationService } from './NotificationService';
import type { NotificationsApi, Platformish } from './types';

/**
 * The app's single `NotificationService`, wired to the real `expo-notifications`
 * on device and to a no-op on web.
 *
 * The native module is `require`d lazily inside a *private* function: exporting a
 * function that contains the require would pull it into the web module graph,
 * which is exactly how P8's kv adapter broke `expo export --platform web`
 * (rev-002 B1 / fix-002). Same lesson, applied ahead of time.
 */

/** Web has no local scheduling here; every call warns once and does nothing. */
let warnedUnsupported = false;
function warnUnsupported(): void {
  if (warnedUnsupported) return;
  warnedUnsupported = true;
  console.warn('[notifications] not supported on this platform; the digest reminder is disabled.');
}

const noopApi: NotificationsApi = {
  async setNotificationChannelAsync() {
    warnUnsupported();
    return null;
  },
  async getPermissionsAsync() {
    warnUnsupported();
    return { status: 'undetermined' };
  },
  async requestPermissionsAsync() {
    warnUnsupported();
    return { status: 'undetermined' };
  },
  async scheduleNotificationAsync() {
    warnUnsupported();
    throw new Error('notifications are not supported on this platform');
  },
  async cancelScheduledNotificationAsync() {
    warnUnsupported();
  },
  async getAllScheduledNotificationsAsync() {
    warnUnsupported();
    return [];
  },
};

function loadExpoNotifications(): NotificationsApi {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module = require('expo-notifications') as Record<string, unknown>;
  const api = module as unknown as NotificationsApi;
  const required = [
    'setNotificationChannelAsync',
    'getPermissionsAsync',
    'requestPermissionsAsync',
    'scheduleNotificationAsync',
    'cancelScheduledNotificationAsync',
    'getAllScheduledNotificationsAsync',
  ] as const;
  for (const name of required) {
    if (typeof (module as Record<string, unknown>)[name] !== 'function') {
      throw new Error(`expo-notifications is missing ${name}`);
    }
  }
  return api;
}

function nativeApi(): NotificationsApi {
  try {
    return loadExpoNotifications();
  } catch (error) {
    console.warn('[notifications] expo-notifications unavailable; falling back to no-op:', error);
    return noopApi;
  }
}

const platform: Platformish = {
  os: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
};

let cached: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  if (cached) return cached;
  cached = createNotificationService({
    api: platform.os === 'web' ? noopApi : nativeApi(),
    store: { getNotificationId, setNotificationId, getPermissionStatus, setPermissionStatus },
    platform,
  });
  return cached;
}

/** Test seam. */
export function resetNotificationService(): void {
  cached = null;
  warnedUnsupported = false;
}

export * from './NotificationService';
export type * from './types';
