import { act, fireEvent, screen } from '@testing-library/react-native';
import { Stack } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import React from 'react';
import { Pressable, Text } from 'react-native';

import { KV_KEYS, kv } from '../storage/kv';
import {
  P9_KEYS,
  completeOnboarding,
  resetOnboardingStateForTests,
} from '../user-state/onboarding';

/**
 * fix-006 — the route-level test ver-004 §4 said was missing.
 *
 * Everything else in the repo tests the onboarding *screen* with the navigator
 * faked, which is precisely why this shipped broken: with `useRouter` mocked, a
 * `router.replace('/(tabs)')` into a route that does not exist looks like a pass.
 *
 * So this file fakes **nothing about routing**. It mounts the real
 * `app/_layout.tsx` — the real `<Stack>`, the real `<Stack.Protected>`, the real
 * `useOnboardingState` — inside `renderRouter`, and drives it through a real
 * `completeOnboarding()`. Only the leaf screens are stubs, because what is under
 * test is which of them the navigator will mount.
 */

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

jest.mock('../notifications/useNotificationDeepLink', () => ({
  useNotificationDeepLink: () => undefined,
}));

// The layout is imported after its mocks so it picks them up.
import RootLayout from '../../app/_layout';

/** Stands in for `app/onboarding.tsx`: one button that finishes onboarding. */
function OnboardingStub() {
  return (
    <>
      <Text>ONBOARDING</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void completeOnboarding({
            sourceIds: ['s1'],
            digestTime: '07:30',
            digestEnabled: false,
          });
        }}
      >
        <Text>Başla</Text>
      </Pressable>
    </>
  );
}

const routes = {
  _layout: () => <RootLayout />,
  onboarding: OnboardingStub,
  '(tabs)/_layout': () => <Stack screenOptions={{ headerShown: false }} />,
  '(tabs)/index': () => <Text>FEED</Text>,
  'article/[id]': () => <Text>ARTICLE</Text>,
  search: () => <Text>SEARCH</Text>,
};

/** Let the kv reads (theme, onboarding prime) and navigation state settle. */
const settle = async () => {
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
  await act(async () => undefined);
};

beforeEach(async () => {
  resetOnboardingStateForTests();
  for (const key of [P9_KEYS.onboardingCompletedAt, KV_KEYS.enabledSourceIds, KV_KEYS.settings]) {
    await kv.removeItem(key);
  }
});

afterEach(() => {
  resetOnboardingStateForTests();
});

describe('root guard — routing', () => {
  it('mounts only onboarding on a device that has not completed it', async () => {
    const view = renderRouter(routes, { initialUrl: '/onboarding' });
    await settle();

    expect(screen.getByText('ONBOARDING')).toBeTruthy();
    expect(screen.queryByText('FEED')).toBeNull();
    expect(view.getPathname()).toBe('/onboarding');
  });

  it('swaps to the tabs when completion publishes, with no unhandled action', async () => {
    // The bug's signature was a console error from React Navigation, so both
    // channels are watched for the whole interaction rather than asserted after.
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const view = renderRouter(routes, { initialUrl: '/onboarding' });
      await settle();
      expect(view.getPathname()).toBe('/onboarding');

      await act(async () => {
        fireEvent.press(screen.getByText('Başla'));
      });
      await settle();

      // The whole fix in one assertion: nobody navigated, and the navigator is
      // on the tabs because `(tabs)` became the first available route the moment
      // the guard flipped.
      expect(view.getPathname()).toBe('/');
      expect(screen.getByText('FEED')).toBeTruthy();
      expect(screen.queryByText('ONBOARDING')).toBeNull();

      const said = [...error.mock.calls, ...warn.mock.calls]
        .map((args) => args.map(String).join(' '))
        .join('\n');
      expect(said).not.toMatch(/was not handled by any navigator/);
      expect(said).not.toMatch(/Do you have a route named/);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('keeps the marker, so the next launch starts on the tabs', async () => {
    await completeOnboarding({ sourceIds: ['s1'], digestTime: '07:30', digestEnabled: false });
    // A cold start: the snapshot is dropped and re-read from storage.
    resetOnboardingStateForTests();

    const view = renderRouter(routes, { initialUrl: '/' });
    await settle();

    expect(view.getPathname()).toBe('/');
    expect(screen.getByText('FEED')).toBeTruthy();
    expect(screen.queryByText('ONBOARDING')).toBeNull();
  });
});
