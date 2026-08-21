import type { PermissionStatus } from '../user-state/onboarding';

/**
 * The slice of `expo-notifications` the service uses, as an interface.
 *
 * Everything below is injected rather than imported directly, for two reasons:
 * the native module cannot run under Jest, and the scheduling rules (schedule
 * before cancel, reconcile to exactly one) are the part worth testing — testing
 * them against a fake is testing the logic, not the SDK.
 */

/** `expo-notifications` returns more than this; these are the fields we read. */
export type PermissionResponseLike = {
  status: string;
  granted?: boolean;
  canAskAgain?: boolean;
  ios?: { status?: number };
};

export type ScheduledNotificationLike = {
  identifier: string;
  content?: { data?: Record<string, unknown> | null } | null;
};

export type DailyTrigger = {
  type: 'daily';
  hour: number;
  minute: number;
  channelId?: string;
};

export type ScheduleRequest = {
  content: {
    title: string;
    body: string;
    data: Record<string, unknown>;
  };
  trigger: DailyTrigger;
};

export type NotificationsApi = {
  setNotificationChannelAsync(channelId: string, channel: Record<string, unknown>): Promise<unknown>;
  getPermissionsAsync(): Promise<PermissionResponseLike>;
  requestPermissionsAsync(options?: Record<string, unknown>): Promise<PermissionResponseLike>;
  scheduleNotificationAsync(request: ScheduleRequest): Promise<string>;
  cancelScheduledNotificationAsync(identifier: string): Promise<void>;
  getAllScheduledNotificationsAsync(): Promise<ScheduledNotificationLike[]>;
};

/** Where the persisted bookkeeping lives, injected for the same reason. */
export type NotificationStore = {
  getNotificationId(): Promise<string | null>;
  setNotificationId(id: string | null): Promise<void>;
  getPermissionStatus(): Promise<PermissionStatus>;
  setPermissionStatus(status: PermissionStatus): Promise<void>;
};

export type Platformish = { os: 'ios' | 'android' | 'web' };
