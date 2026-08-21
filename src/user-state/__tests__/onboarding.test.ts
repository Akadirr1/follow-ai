import { KV_KEYS, type KvStore } from '../../storage/kv';
import {
  P9_KEYS,
  completeOnboarding,
  getNotificationId,
  getOnboardingCompletedAt,
  getPermissionStatus,
  isOnboardingComplete,
  isPermissionStatus,
  resetOnboarding,
  setNotificationId,
  setPermissionStatus,
} from '../onboarding';
import { getEnabledSourceIds, getSettings } from '../store';

/**
 * Onboarding completion and the notification bookkeeping.
 *
 * The interesting property is the *ordering*: a kv store has no transaction, so
 * the completion marker is written last and a crash part-way must leave the
 * device in "not onboarded" rather than "onboarded with no sources".
 */

function fakeKv(initial: Record<string, string> = {}): KvStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async getItem(key) {
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    },
  };
}

const now = () => '2026-08-21T05:00:00.000Z';

describe('onboarding completion', () => {
  it('is incomplete on a fresh install', async () => {
    const storage = fakeKv();
    expect(await getOnboardingCompletedAt(storage)).toBeNull();
    expect(await isOnboardingComplete(storage)).toBe(false);
  });

  it('writes sources, settings and the marker, and reports complete', async () => {
    const storage = fakeKv();
    const result = await completeOnboarding(
      { sourceIds: ['s1', 's2'], digestTime: '07:30', digestEnabled: true },
      storage,
      now,
    );

    expect(result).toEqual({ ok: true, completedAt: now() });
    expect(await getEnabledSourceIds(storage)).toEqual(['s1', 's2']);
    const settings = await getSettings(storage);
    expect(settings.digestTime).toBe('07:30');
    expect(settings.digestEnabled).toBe(true);
    expect(await isOnboardingComplete(storage)).toBe(true);
  });

  it('requires at least one source and writes nothing when there are none', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = fakeKv();
      const result = await completeOnboarding(
        { sourceIds: [], digestTime: '08:00', digestEnabled: false },
        storage,
        now,
      );
      expect(result).toEqual({ ok: false, reason: 'no_sources' });
      expect(storage.data.size).toBe(0);
      expect(await isOnboardingComplete(storage)).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('drops duplicates and blanks from the selection', async () => {
    const storage = fakeKv();
    await completeOnboarding(
      { sourceIds: ['s1', 's1', '', 's2'], digestTime: '08:00', digestEnabled: false },
      storage,
      now,
    );
    expect(await getEnabledSourceIds(storage)).toEqual(['s1', 's2']);
  });

  it('writes the completion marker LAST, so a crash replays onboarding', async () => {
    const order: string[] = [];
    const storage = fakeKv();
    const recording: KvStore = {
      getItem: storage.getItem,
      removeItem: storage.removeItem,
      async setItem(key, value) {
        order.push(key);
        await storage.setItem(key, value);
      },
    };

    await completeOnboarding(
      { sourceIds: ['s1'], digestTime: '08:00', digestEnabled: true },
      recording,
      now,
    );

    expect(order).toEqual([
      KV_KEYS.enabledSourceIds,
      KV_KEYS.settings,
      P9_KEYS.onboardingCompletedAt,
    ]);
    // A kill after either of the first two leaves no marker → onboarding runs
    // again and overwrites the partial state.
    expect(order[order.length - 1]).toBe(P9_KEYS.onboardingCompletedAt);
  });

  it('treats a garbage marker as incomplete rather than trusting it', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = fakeKv({ [P9_KEYS.onboardingCompletedAt]: 'evet' });
      expect(await getOnboardingCompletedAt(storage)).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('evet'));
    } finally {
      warn.mockRestore();
    }
  });

  it('can be reset for a dev build', async () => {
    const storage = fakeKv();
    await completeOnboarding(
      { sourceIds: ['s1'], digestTime: '08:00', digestEnabled: false },
      storage,
      now,
    );
    await resetOnboarding(storage);
    expect(await isOnboardingComplete(storage)).toBe(false);
  });
});

describe('notification bookkeeping', () => {
  it('round-trips the schedule id and clears it with null', async () => {
    const storage = fakeKv();
    expect(await getNotificationId(storage)).toBeNull();
    await setNotificationId('sched-1', storage);
    expect(await getNotificationId(storage)).toBe('sched-1');
    await setNotificationId(null, storage);
    expect(await getNotificationId(storage)).toBeNull();
  });

  it('defaults the permission to undetermined and round-trips the rest', async () => {
    const storage = fakeKv();
    expect(await getPermissionStatus(storage)).toBe('undetermined');
    for (const status of ['granted', 'provisional', 'denied'] as const) {
      await setPermissionStatus(status, storage);
      expect(await getPermissionStatus(storage)).toBe(status);
    }
  });

  it('warns and falls back for a permission value we did not write', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = fakeKv({ [P9_KEYS.permissionStatus]: 'maybe' });
      expect(await getPermissionStatus(storage)).toBe('undetermined');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('maybe'));
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['granted', 'provisional', 'denied', 'undetermined'])('accepts %p', (value) => {
    expect(isPermissionStatus(value)).toBe(true);
  });

  it.each(['', 'GRANTED', null, 7])('rejects %p', (value) => {
    expect(isPermissionStatus(value)).toBe(false);
  });

  it('versions every key it owns', () => {
    for (const key of Object.values(P9_KEYS)) {
      expect(key.startsWith('v1:')).toBe(true);
    }
  });
});
