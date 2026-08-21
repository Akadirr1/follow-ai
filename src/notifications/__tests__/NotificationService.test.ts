import type { PermissionStatus } from '../../user-state/onboarding';
import {
  CHANNEL_ID,
  DEEP_LINK,
  OWNED_MARKER,
  canSchedule,
  createNotificationService,
  isDigestTime,
  parseDigestTime,
  toPermissionStatus,
} from '../NotificationService';
import { deepLinkFor } from '../useNotificationDeepLink';
import type {
  NotificationStore,
  NotificationsApi,
  PermissionResponseLike,
  Platformish,
  ScheduledNotificationLike,
} from '../types';

/**
 * The scheduling rules, against a fake `expo-notifications`. What is under test
 * is the ordering and reconciliation logic — the part that decides whether a
 * user gets one reminder, none, or three (arch-001 §4).
 */

type Call = { name: string; args: unknown[] };

function fakeApi(
  options: {
    permission?: PermissionResponseLike;
    requestResult?: PermissionResponseLike;
    scheduled?: ScheduledNotificationLike[];
    failSchedule?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  let scheduled = [...(options.scheduled ?? [])];
  let nextId = 1;

  const api: NotificationsApi = {
    async setNotificationChannelAsync(channelId, channel) {
      calls.push({ name: 'setNotificationChannelAsync', args: [channelId, channel] });
      return null;
    },
    async getPermissionsAsync() {
      calls.push({ name: 'getPermissionsAsync', args: [] });
      return options.permission ?? { status: 'undetermined' };
    },
    async requestPermissionsAsync(opts) {
      calls.push({ name: 'requestPermissionsAsync', args: [opts] });
      return options.requestResult ?? { status: 'granted', granted: true };
    },
    async scheduleNotificationAsync(request) {
      calls.push({ name: 'scheduleNotificationAsync', args: [request] });
      if (options.failSchedule) throw new Error('scheduling refused');
      const identifier = `sched-${nextId++}`;
      scheduled.push({ identifier, content: { data: request.content.data } });
      return identifier;
    },
    async cancelScheduledNotificationAsync(identifier) {
      calls.push({ name: 'cancelScheduledNotificationAsync', args: [identifier] });
      scheduled = scheduled.filter((s) => s.identifier !== identifier);
    },
    async getAllScheduledNotificationsAsync() {
      calls.push({ name: 'getAllScheduledNotificationsAsync', args: [] });
      return [...scheduled];
    },
  };

  return { api, calls, get scheduled() { return scheduled; } };
}

function fakeStore(initial: { id?: string | null; permission?: PermissionStatus } = {}) {
  let id = initial.id ?? null;
  let permission: PermissionStatus = initial.permission ?? 'undetermined';
  const store: NotificationStore = {
    async getNotificationId() {
      return id;
    },
    async setNotificationId(next) {
      id = next;
    },
    async getPermissionStatus() {
      return permission;
    },
    async setPermissionStatus(next) {
      permission = next;
    },
  };
  return { store, get id() { return id; }, get permission() { return permission; } };
}

const android: Platformish = { os: 'android' };
const ios: Platformish = { os: 'ios' };
const web: Platformish = { os: 'web' };

const owned = (identifier: string): ScheduledNotificationLike => ({
  identifier,
  content: { data: { url: DEEP_LINK, owner: OWNED_MARKER } },
});
const foreign = (identifier: string): ScheduledNotificationLike => ({
  identifier,
  content: { data: { owner: 'someone-else' } },
});

describe('digest time validation', () => {
  it.each(['07:00', '07:30', '08:00', '08:30', '09:00'])('accepts %p', (time) => {
    expect(isDigestTime(time)).toBe(true);
    expect(parseDigestTime(time)).not.toBeNull();
  });

  it.each(['06:00', '08:15', '', 'sabah'])('warns and rejects %p', (time) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(isDigestTime(time)).toBe(false);
      expect(parseDigestTime(time)).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('splits the slot into hour and minute', () => {
    expect(parseDigestTime('07:30')).toEqual({ hour: 7, minute: 30 });
  });
});

describe('permission-state matrix', () => {
  it.each([
    ['granted', { status: 'granted', granted: true }, 'granted', true],
    ['iOS provisional via status', { status: 'provisional' }, 'provisional', true],
    ['iOS provisional via ios.status 3', { status: 'denied', ios: { status: 3 } }, 'provisional', true],
    ['denied', { status: 'denied' }, 'denied', false],
    ['undetermined', { status: 'undetermined' }, 'undetermined', false],
    ['granted:false is a denial', { status: 'granted', granted: false }, 'denied', false],
  ])('%s → %s (canSchedule=%s)', (_label, response, expected, schedulable) => {
    const status = toPermissionStatus(response as PermissionResponseLike);
    expect(status).toBe(expected);
    expect(canSchedule(status)).toBe(schedulable);
  });

  it('warns and treats an unknown status as denied', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(toPermissionStatus({ status: 'weird' })).toBe('denied');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('Android channel before permission', () => {
  it('creates the channel before the permission dialog', async () => {
    const api = fakeApi({ permission: { status: 'undetermined' } });
    const store = fakeStore();
    const service = createNotificationService({ api: api.api, store: store.store, platform: android });

    await service.requestPermission();

    const names = api.calls.map((c) => c.name);
    const channelAt = names.indexOf('setNotificationChannelAsync');
    const requestAt = names.indexOf('requestPermissionsAsync');
    expect(channelAt).toBeGreaterThanOrEqual(0);
    expect(requestAt).toBeGreaterThan(channelAt);
    expect(api.calls[channelAt].args[0]).toBe(CHANNEL_ID);
  });

  it('does not create a channel on iOS', async () => {
    const api = fakeApi({ permission: { status: 'undetermined' } });
    const service = createNotificationService({
      api: api.api,
      store: fakeStore().store,
      platform: ios,
    });
    await service.requestPermission();
    expect(api.calls.map((c) => c.name)).not.toContain('setNotificationChannelAsync');
  });

  it('does not re-prompt when permission is already granted', async () => {
    const api = fakeApi({ permission: { status: 'granted', granted: true } });
    const service = createNotificationService({
      api: api.api,
      store: fakeStore().store,
      platform: ios,
    });
    expect(await service.requestPermission()).toBe('granted');
    expect(api.calls.map((c) => c.name)).not.toContain('requestPermissionsAsync');
  });
});

describe('enableDigest — schedule new before cancelling old', () => {
  it('schedules, persists the id, then cancels the previous schedule in that order', async () => {
    const api = fakeApi({
      permission: { status: 'granted', granted: true },
      scheduled: [owned('old-1')],
    });
    const store = fakeStore({ id: 'old-1', permission: 'granted' });
    const service = createNotificationService({ api: api.api, store: store.store, platform: android });

    const result = await service.enableDigest('08:30');
    expect(result).toMatchObject({ ok: true, status: 'scheduled' });

    const names = api.calls.map((c) => c.name);
    const scheduleAt = names.indexOf('scheduleNotificationAsync');
    const cancelAt = names.indexOf('cancelScheduledNotificationAsync');
    // The whole point: the new one exists before the old one is dropped.
    expect(scheduleAt).toBeGreaterThanOrEqual(0);
    expect(cancelAt).toBeGreaterThan(scheduleAt);
    expect(api.calls[cancelAt].args[0]).toBe('old-1');
    if (result.ok) expect(store.id).toBe(result.notificationId);
  });

  it('carries the deep link and the ownership marker', async () => {
    const api = fakeApi({ permission: { status: 'granted', granted: true } });
    const service = createNotificationService({
      api: api.api,
      store: fakeStore().store,
      platform: android,
    });
    await service.enableDigest('07:00');

    const call = api.calls.find((c) => c.name === 'scheduleNotificationAsync');
    const request = call?.args[0] as { content: { data: unknown }; trigger: unknown };
    expect(request.content.data).toEqual({ url: DEEP_LINK, owner: OWNED_MARKER });
    // Inexact daily trigger: no SCHEDULE_EXACT_ALARM needed.
    expect(request.trigger).toEqual({ type: 'daily', hour: 7, minute: 0, channelId: CHANNEL_ID });
  });

  it('keeps the old schedule when scheduling the new one fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const api = fakeApi({
        permission: { status: 'granted', granted: true },
        scheduled: [owned('old-1')],
        failSchedule: true,
      });
      const store = fakeStore({ id: 'old-1' });
      const service = createNotificationService({
        api: api.api,
        store: store.store,
        platform: android,
      });

      const result = await service.enableDigest('09:00');
      expect(result).toMatchObject({ ok: false, status: 'schedule_failed' });
      // Nothing was cancelled, so the user still has yesterday's reminder.
      expect(api.calls.map((c) => c.name)).not.toContain('cancelScheduledNotificationAsync');
      expect(store.id).toBe('old-1');
    } finally {
      warn.mockRestore();
    }
  });

  it('reports permission_denied and schedules nothing', async () => {
    const api = fakeApi({
      permission: { status: 'undetermined' },
      requestResult: { status: 'denied' },
    });
    const store = fakeStore();
    const service = createNotificationService({ api: api.api, store: store.store, platform: android });

    const result = await service.enableDigest('08:00');
    expect(result).toEqual({ ok: false, status: 'permission_denied', permission: 'denied' });
    expect(api.calls.map((c) => c.name)).not.toContain('scheduleNotificationAsync');
    expect(store.permission).toBe('denied');
  });

  it('rejects a time outside the five slots', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const api = fakeApi({ permission: { status: 'granted', granted: true } });
      const service = createNotificationService({
        api: api.api,
        store: fakeStore().store,
        platform: android,
      });
      expect(await service.enableDigest('06:15')).toEqual({ ok: false, status: 'invalid_time' });
      expect(api.calls.map((c) => c.name)).not.toContain('scheduleNotificationAsync');
    } finally {
      warn.mockRestore();
    }
  });

  it('is a no-op on web, with a warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const api = fakeApi();
      const service = createNotificationService({
        api: api.api,
        store: fakeStore().store,
        platform: web,
      });
      expect(await service.enableDigest('08:00')).toEqual({ ok: false, status: 'unsupported' });
      expect(api.calls).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('disableDigest', () => {
  it('cancels the stored schedule and forgets its id', async () => {
    const api = fakeApi({ scheduled: [owned('old-1')] });
    const store = fakeStore({ id: 'old-1' });
    const service = createNotificationService({ api: api.api, store: store.store, platform: ios });

    await service.disableDigest();
    expect(store.id).toBeNull();
    expect(api.scheduled.filter((s) => s.content?.data?.owner === OWNED_MARKER)).toEqual([]);
  });

  it('sweeps an owned schedule that outlived its stored id', async () => {
    const api = fakeApi({ scheduled: [owned('orphan')] });
    const store = fakeStore({ id: null });
    const service = createNotificationService({ api: api.api, store: store.store, platform: ios });

    await service.disableDigest();
    expect(api.scheduled).toEqual([]);
  });

  it('never touches a schedule this app does not own', async () => {
    const api = fakeApi({ scheduled: [owned('mine'), foreign('theirs')] });
    const service = createNotificationService({
      api: api.api,
      store: fakeStore({ id: 'mine' }).store,
      platform: ios,
    });
    await service.disableDigest();
    expect(api.scheduled.map((s) => s.identifier)).toEqual(['theirs']);
  });
});

describe('reconcile — exactly one owned schedule', () => {
  const granted = { status: 'granted', granted: true };

  it('schedules one when the digest is on and the OS has none', async () => {
    const api = fakeApi({ permission: granted, scheduled: [] });
    const store = fakeStore({ id: 'stale-from-before-reboot' });
    const service = createNotificationService({ api: api.api, store: store.store, platform: android });

    const result = await service.reconcile({ enabled: true, time: '08:00' });
    expect(result.action).toBe('scheduled');
    expect(api.scheduled).toHaveLength(1);
    if (result.action === 'scheduled') expect(store.id).toBe(result.notificationId);
  });

  it('leaves a single correct schedule alone', async () => {
    const api = fakeApi({ permission: granted, scheduled: [owned('mine')] });
    const store = fakeStore({ id: 'mine' });
    const service = createNotificationService({ api: api.api, store: store.store, platform: android });

    expect(await service.reconcile({ enabled: true, time: '08:00' })).toEqual({
      action: 'none',
      owned: 1,
    });
    expect(api.calls.map((c) => c.name)).not.toContain('scheduleNotificationAsync');
  });

  it('deduplicates to one, keeping the id it already knows', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const api = fakeApi({ permission: granted, scheduled: [owned('a'), owned('b'), owned('c')] });
      const store = fakeStore({ id: 'b' });
      const service = createNotificationService({
        api: api.api,
        store: store.store,
        platform: android,
      });

      const result = await service.reconcile({ enabled: true, time: '08:00' });
      expect(result).toEqual({ action: 'deduplicated', notificationId: 'b', cancelled: 2 });
      expect(api.scheduled.map((s) => s.identifier)).toEqual(['b']);
      expect(store.id).toBe('b');
    } finally {
      warn.mockRestore();
    }
  });

  it('cancels everything owned when the digest is off', async () => {
    const api = fakeApi({ permission: granted, scheduled: [owned('a'), foreign('x')] });
    const store = fakeStore({ id: 'a' });
    const service = createNotificationService({ api: api.api, store: store.store, platform: android });

    expect(await service.reconcile({ enabled: false, time: '08:00' })).toEqual({
      action: 'cancelled',
      owned: 1,
    });
    expect(api.scheduled.map((s) => s.identifier)).toEqual(['x']);
    expect(store.id).toBeNull();
  });

  it('drops our schedules when permission was revoked in OS settings', async () => {
    const api = fakeApi({ permission: { status: 'denied' }, scheduled: [owned('a')] });
    const store = fakeStore({ id: 'a', permission: 'granted' });
    const service = createNotificationService({ api: api.api, store: store.store, platform: android });

    expect(await service.reconcile({ enabled: true, time: '08:00' })).toEqual({
      action: 'skipped',
      reason: 'permission',
    });
    expect(api.scheduled).toEqual([]);
    expect(store.id).toBeNull();
    expect(store.permission).toBe('denied');
  });

  it('skips on web', async () => {
    const api = fakeApi();
    const service = createNotificationService({
      api: api.api,
      store: fakeStore().store,
      platform: web,
    });
    expect(await service.reconcile({ enabled: true, time: '08:00' })).toEqual({
      action: 'skipped',
      reason: 'unsupported',
    });
    expect(api.calls).toEqual([]);
  });

  it('survives an unreadable schedule list', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const api = fakeApi({ permission: granted });
      api.api.getAllScheduledNotificationsAsync = async () => {
        throw new Error('OS said no');
      };
      const service = createNotificationService({
        api: api.api,
        store: fakeStore().store,
        platform: android,
      });
      const result = await service.reconcile({ enabled: true, time: '08:00' });
      expect(result.action).toBe('scheduled');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('could not read scheduled notifications'),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('deep link target', () => {
  it('resolves an owned notification to the Digest tab', () => {
    expect(
      deepLinkFor({
        notification: { request: { content: { data: { owner: OWNED_MARKER, url: DEEP_LINK } } } },
      }),
    ).toBe('/(tabs)/digest');
  });

  it('falls back to the digest URL when ours carries no url', () => {
    expect(
      deepLinkFor({ notification: { request: { content: { data: { owner: OWNED_MARKER } } } } }),
    ).toBe(DEEP_LINK);
  });

  it.each([
    ['a foreign notification', { notification: { request: { content: { data: { owner: 'x' } } } } }],
    ['no data', { notification: { request: { content: { data: null } } } }],
    ['nothing at all', null],
  ])('ignores %s', (_label, response) => {
    expect(deepLinkFor(response as never)).toBeNull();
  });
});
