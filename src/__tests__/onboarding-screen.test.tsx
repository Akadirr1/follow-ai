import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { ok } from '../domain/errors';
import { KV_KEYS, kv } from '../storage/kv';
import {
  P9_KEYS,
  completeOnboarding,
  isOnboardingComplete,
  resetOnboarding,
} from '../user-state/onboarding';
import { fakeRepositories, makeSource, renderScreen, type FakeRepoOverrides } from './harness';

/**
 * The onboarding screen and the guard it feeds. The screen is rendered over fake
 * repositories; the guard itself is asserted through `isAppReady` + the
 * completion state, because `Stack.Protected` is expo-router's own machinery.
 */

const mockReplace = jest.fn();
jest.mock('expo-router', () => {
  const Stack = () => null;
  Stack.Screen = () => null;
  Stack.Protected = () => null;
  return {
    useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
    Stack,
  };
});

// `app/_layout.tsx` is imported for `isAppReady`; these are the modules it pulls
// in that cannot resolve under Jest (same set as the fix-002 splash-gate test).
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn().mockResolvedValue(true),
  hideAsync: jest.fn().mockResolvedValue(true),
}));
jest.mock('@expo-google-fonts/inter', () => ({
  useFonts: () => [false, null],
  Inter_400Regular: 'Inter_400Regular',
  Inter_500Medium: 'Inter_500Medium',
  Inter_600SemiBold: 'Inter_600SemiBold',
  Inter_700Bold: 'Inter_700Bold',
  Inter_800ExtraBold: 'Inter_800ExtraBold',
}));
jest.mock('../notifications/useNotificationDeepLink', () => ({
  useNotificationDeepLink: () => undefined,
}));

let mockRepos = fakeRepositories();
jest.mock('../data-access/index', () => ({
  ...jest.requireActual('../data-access/index'),
  getRepositories: () => mockRepos,
}));

/** The service is native-only; onboarding must work without it. */
const mockEnable = jest.fn().mockResolvedValue({ ok: false, status: 'unsupported' });
jest.mock('../notifications/useDigestNotifications', () => ({
  useDigestNotifications: () => ({
    permission: 'undetermined',
    canNotify: false,
    isReady: true,
    enable: mockEnable,
    disable: jest.fn(),
    refreshPermission: jest.fn(),
  }),
}));

import OnboardingScreen from '../../app/onboarding';
import { isAppReady } from '../../app/_layout';

const setRepos = (over: FakeRepoOverrides) => {
  mockRepos = fakeRepositories(over);
};

const catalog = [
  makeSource({ id: 's1', name: 'OpenAI Blog', tile: 'OA' }),
  makeSource({ id: 's2', name: 'Webrazzi AI', tile: 'WZ', language: 'tr', category: 'Türkiye' }),
];

beforeEach(async () => {
  mockReplace.mockClear();
  mockEnable.mockClear();
  mockRepos = fakeRepositories();
  for (const key of [KV_KEYS.enabledSourceIds, KV_KEYS.settings, P9_KEYS.onboardingCompletedAt]) {
    await kv.removeItem(key);
  }
});

describe('onboarding screen', () => {
  it('lists the catalog with every source on by default', async () => {
    setRepos({ listSources: async () => ok(catalog) });
    renderScreen(<OnboardingScreen />);

    expect(await screen.findByText('OpenAI Blog')).toBeTruthy();
    expect(screen.getByText('Webrazzi AI')).toBeTruthy();
    expect(screen.getByText('2 kaynak seçili')).toBeTruthy();
  });

  it('refuses to start with no sources and says why', async () => {
    setRepos({ listSources: async () => ok(catalog) });
    renderScreen(<OnboardingScreen />);
    await screen.findByText('OpenAI Blog');

    await act(async () => {
      fireEvent.press(screen.getByLabelText('OpenAI Blog'));
      fireEvent.press(screen.getByLabelText('Webrazzi AI'));
    });
    expect(screen.getByText('0 kaynak seçili')).toBeTruthy();
    // The requirement is stated immediately rather than only after a press the
    // disabled button would swallow.
    expect(screen.getByText('En az bir kaynak seç.')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText('Başla'));
    });
    // Nothing was persisted and the app was not entered.
    expect(await isOnboardingComplete()).toBe(false);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('persists the narrowed selection and the chosen slot, then enters the tabs', async () => {
    setRepos({ listSources: async () => ok(catalog) });
    renderScreen(<OnboardingScreen />);
    await screen.findByText('OpenAI Blog');

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Webrazzi AI')); // turn one off
      fireEvent.press(screen.getByText('07:30'));
    });
    expect(screen.getByText('1 kaynak seçili')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText('Başla'));
    });

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)'));
    expect(await isOnboardingComplete()).toBe(true);
    expect(JSON.parse((await kv.getItem(KV_KEYS.enabledSourceIds)) as string)).toEqual(['s1']);
    const settings = JSON.parse((await kv.getItem(KV_KEYS.settings)) as string) as {
      digestTime: string;
      digestEnabled: boolean;
    };
    expect(settings.digestTime).toBe('07:30');
    // The OS never granted anything here, so the reminder must not claim to be on.
    expect(settings.digestEnabled).toBe(false);
  });

  it('asks for permission only when the user presses the button', async () => {
    setRepos({ listSources: async () => ok(catalog) });
    renderScreen(<OnboardingScreen />);
    await screen.findByText('OpenAI Blog');

    // The explanatory copy is on screen before anything is requested.
    expect(
      screen.getByText(/Digest hazır olduğunda tek bir bildirim göndeririz/),
    ).toBeTruthy();
    expect(mockEnable).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(screen.getByText('Bildirimlere izin ver'));
    });
    expect(mockEnable).toHaveBeenCalledWith('08:00');
  });

  it('shows a loading state while the catalog is fetched', () => {
    setRepos({ listSources: () => new Promise(() => {}) as Promise<never> });
    renderScreen(<OnboardingScreen />);
    expect(screen.getByLabelText('Yükleniyor…')).toBeTruthy();
  });
});

describe('root guard', () => {
  it('holds the launch gate until the onboarding read has settled', () => {
    expect(
      isAppReady({ fontsLoaded: true, fontError: null, themeReady: true, onboardingReady: false }),
    ).toBe(false);
    expect(
      isAppReady({ fontsLoaded: true, fontError: null, themeReady: true, onboardingReady: true }),
    ).toBe(true);
  });

  it('reports incomplete until completion is persisted, and after a reset', async () => {
    expect(await isOnboardingComplete()).toBe(false);

    await completeOnboarding({ sourceIds: ['s1'], digestTime: '08:00', digestEnabled: false });
    expect(await isOnboardingComplete()).toBe(true);

    // A restart re-reads the same key, so the guard cannot be stepped around.
    await resetOnboarding();
    expect(await isOnboardingComplete()).toBe(false);
  });
});
