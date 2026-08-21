import { act, renderHook, waitFor } from '@testing-library/react-native';

import type { KvStore } from '../../storage/kv';
import {
  P9_KEYS,
  completeOnboarding,
  getOnboardingSnapshot,
  primeOnboardingState,
  resetOnboarding,
  resetOnboardingStateForTests,
  subscribeOnboarding,
} from '../onboarding';

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn().mockResolvedValue(undefined),
  hideAsync: jest.fn().mockResolvedValue(undefined),
  setOptions: jest.fn(),
}));

jest.mock('@expo-google-fonts/inter', () => ({
  useFonts: () => [true, null],
  Inter_400Regular: 'Inter_400Regular',
  Inter_500Medium: 'Inter_500Medium',
  Inter_600SemiBold: 'Inter_600SemiBold',
  Inter_700Bold: 'Inter_700Bold',
  Inter_800ExtraBold: 'Inter_800ExtraBold',
}));

import { useOnboardingState } from '../../../app/_layout';

/**
 * The store behind the root guard, and the hook that reads it (fix-006).
 *
 * The boundary faked here is **storage** — a Map with a read counter — and
 * nothing else. The store, the hook and `completeOnboarding` are all real, so
 * "the second subscriber flipped too" is a statement about the store's
 * notification, not about a mock being called twice.
 *
 * The routing consequence of these flips is covered separately, against the real
 * navigator, in `src/__tests__/onboarding-routing.test.tsx`.
 */

function countingKv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  let reads = 0;
  const store: KvStore & { reads: () => number; data: Map<string, string> } = {
    data,
    reads: () => reads,
    async getItem(key) {
      reads += 1;
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    },
  };
  return store;
}

beforeEach(() => {
  resetOnboardingStateForTests();
});

afterEach(() => {
  resetOnboardingStateForTests();
});

describe('onboarding store', () => {
  it('starts unread, so the launch gate can tell "no" from "not yet"', () => {
    expect(getOnboardingSnapshot()).toBeUndefined();
  });

  it('publishes null for a device that has never completed onboarding', async () => {
    await primeOnboardingState(countingKv());
    expect(getOnboardingSnapshot()).toBeNull();
  });

  it('publishes the stored instant for a device that has', async () => {
    const at = '2026-08-21T09:00:00.000Z';
    await primeOnboardingState(countingKv({ [P9_KEYS.onboardingCompletedAt]: at }));
    expect(getOnboardingSnapshot()).toBe(at);
  });

  it('reads storage once however many times it is primed', async () => {
    const storage = countingKv();
    await Promise.all([
      primeOnboardingState(storage),
      primeOnboardingState(storage),
      primeOnboardingState(storage),
    ]);
    await primeOnboardingState(storage);
    // One read for N subscribers: a launch must not turn into N storage hits.
    expect(storage.reads()).toBe(1);
  });

  it('falls back to incomplete when the read throws, rather than hanging', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const broken: KvStore = {
        getItem: async () => {
          throw new Error('storage is gone');
        },
        setItem: async () => undefined,
        removeItem: async () => undefined,
      };
      await primeOnboardingState(broken);
      // Replaying onboarding is recoverable; a splash screen that never lifts is not.
      expect(getOnboardingSnapshot()).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('could not read the completion marker'),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('notifies subscribers on completion and on reset, and stops after unsubscribe', async () => {
    const storage = countingKv();
    await primeOnboardingState(storage);

    let notifications = 0;
    const unsubscribe = subscribeOnboarding(() => {
      notifications += 1;
    });

    await completeOnboarding(
      { sourceIds: ['s1'], digestTime: '07:30', digestEnabled: false },
      storage,
    );
    expect(notifications).toBe(1);
    expect(getOnboardingSnapshot()).not.toBeNull();

    await resetOnboarding(storage);
    expect(notifications).toBe(2);
    expect(getOnboardingSnapshot()).toBeNull();

    unsubscribe();
    await completeOnboarding(
      { sourceIds: ['s1'], digestTime: '07:30', digestEnabled: false },
      storage,
    );
    expect(notifications).toBe(2);
  });

  it('does not notify when the value has not moved', async () => {
    const storage = countingKv();
    await primeOnboardingState(storage);
    let notifications = 0;
    const unsubscribe = subscribeOnboarding(() => {
      notifications += 1;
    });
    // Already null; resetting again must not wake every subscriber.
    await resetOnboarding(storage);
    expect(notifications).toBe(0);
    unsubscribe();
  });

  it('refuses to publish for a completion that was refused', async () => {
    const storage = countingKv();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await primeOnboardingState(storage);
      const result = await completeOnboarding(
        { sourceIds: [], digestTime: '07:30', digestEnabled: false },
        storage,
      );
      expect(result).toEqual({ ok: false, reason: 'no_sources' });
      expect(getOnboardingSnapshot()).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('useOnboardingState', () => {
  it('is not ready until the first read resolves, then reports incomplete', async () => {
    const { result } = renderHook(() => useOnboardingState());

    // The launch gate stays closed on the first frame: `undefined`, not `false`.
    expect(result.current).toEqual({ isReady: false, completed: false });

    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.completed).toBe(false);
  });

  it('flips to completed without a remount', async () => {
    const { result } = renderHook(() => useOnboardingState());
    await waitFor(() => expect(result.current.isReady).toBe(true));
    expect(result.current.completed).toBe(false);

    await act(async () => {
      await completeOnboarding({ sourceIds: ['s1'], digestTime: '07:30', digestEnabled: false });
    });

    // This is the fix: the same mounted hook instance now says true. Before
    // fix-006 it stayed false until the app was killed and relaunched.
    expect(result.current.completed).toBe(true);
    expect(result.current.isReady).toBe(true);
  });

  it('flips every mounted subscriber, not just the one that triggered it', async () => {
    const first = renderHook(() => useOnboardingState());
    const second = renderHook(() => useOnboardingState());
    await waitFor(() => expect(first.result.current.isReady).toBe(true));
    await waitFor(() => expect(second.result.current.isReady).toBe(true));

    await act(async () => {
      await completeOnboarding({ sourceIds: ['s1'], digestTime: '07:30', digestEnabled: false });
    });

    expect(first.result.current.completed).toBe(true);
    expect(second.result.current.completed).toBe(true);
  });

  it('follows a reset back to incomplete', async () => {
    await completeOnboarding({ sourceIds: ['s1'], digestTime: '07:30', digestEnabled: false });
    const { result } = renderHook(() => useOnboardingState());
    await waitFor(() => expect(result.current.completed).toBe(true));

    await act(async () => {
      await resetOnboarding();
    });
    expect(result.current.completed).toBe(false);
    expect(result.current.isReady).toBe(true);
  });
});
