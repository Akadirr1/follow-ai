import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '../src/components/ToastProvider';
import { QueryProvider } from '../src/providers/QueryProvider';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import { useNotificationDeepLink } from '../src/notifications/useNotificationDeepLink';
import {
  getOnboardingSnapshot,
  primeOnboardingState,
  subscribeOnboarding,
} from '../src/user-state/onboarding';

/**
 * Hold the native splash from the moment this module is evaluated. Everything
 * before `hideAsync()` is covered by the native splash image, so the first thing
 * the user sees painted by React is already in the right theme (rev-002 B2).
 *
 * It rejects if the splash has already auto-hidden — a race we cannot lose
 * anything to, so it is logged rather than thrown.
 */
SplashScreen.preventAutoHideAsync().catch((error: unknown) => {
  console.warn('[splash] preventAutoHideAsync failed; the splash may hide early:', error);
});

/**
 * The launch gate. Both inputs must be settled before the app may paint:
 *
 * - fonts, so no frame renders in the fallback face;
 * - the stored theme preference, so a user whose preference is light never sees
 *   a dark React frame first.
 *
 * A font *failure* still counts as settled: `ThemeProvider` falls back to the
 * system face and the app is usable, whereas waiting forever is not.
 */
export function isAppReady(input: {
  fontsLoaded: boolean;
  fontError: unknown;
  themeReady: boolean;
  onboardingReady: boolean;
}): boolean {
  const fontsSettled = input.fontsLoaded || input.fontError != null;
  return fontsSettled && input.themeReady && input.onboardingReady;
}

/**
 * Whether onboarding has been completed, as a tri-state: `undefined` while the kv
 * read is in flight. It joins the launch gate (P9) so the first painted frame is
 * already the right one — deciding after paint would flash the tabs at a user
 * who has never chosen a source.
 *
 * Subscribed rather than read once (fix-006). The previous version took a single
 * snapshot in a mount effect, so finishing onboarding could not flip the guard
 * below and `(tabs)` was never mounted for the screen that wanted to navigate
 * into it. `useSyncExternalStore` is the whole fix: the same store that persists
 * the marker publishes it, and every mounted subscriber flips together.
 *
 * The third argument matters for the web export: static rendering calls
 * `getServerSnapshot`, and without one React throws during SSR. Server-side the
 * answer is always "not read yet", which keeps the gate closed and renders
 * nothing — exactly what the effect-based version did on the server.
 */
export function useOnboardingState(): { completed: boolean; isReady: boolean } {
  const completedAt = useSyncExternalStore(
    subscribeOnboarding,
    getOnboardingSnapshot,
    getOnboardingSnapshot,
  );

  useEffect(() => {
    // Memoised inside the store, so N subscribers still make one read.
    void primeOnboardingState();
  }, []);

  return { completed: Boolean(completedAt), isReady: completedAt !== undefined };
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
  });

  useEffect(() => {
    if (fontError) {
      // Inter is the prototype's face; the system fallback keeps the app usable but
      // it is a visible regression, so it must not pass unnoticed.
      console.warn('[fonts] Inter failed to load, falling back to system:', fontError);
    }
  }, [fontError]);

  /**
   * `ThemeProvider` mounts immediately rather than behind the font gate, so the
   * preference read runs *in parallel* with font loading instead of starting
   * after it. Provider order is otherwise P6's: theme gate → query → toast → routes.
   */
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedApp fontsLoaded={fontsLoaded} fontError={fontError} />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function ThemedApp({ fontsLoaded, fontError }: { fontsLoaded: boolean; fontError: unknown }) {
  const { palette, scheme, isReady: themeReady } = useTheme();
  const onboarding = useOnboardingState();
  // Tapping the daily reminder lands on the Digest tab.
  useNotificationDeepLink();
  const ready = isAppReady({
    fontsLoaded,
    fontError,
    themeReady,
    onboardingReady: onboarding.isReady,
  });

  useEffect(() => {
    if (!ready) return;
    // Hide only once both inputs are settled; the first painted frame is already
    // in the resolved theme, so there is nothing to swap in front of the user.
    SplashScreen.hideAsync().catch((error: unknown) => {
      console.warn('[splash] hideAsync failed; the splash may stay up:', error);
    });
  }, [ready]);

  // Render nothing until ready: a placeholder `View` here would be exactly the
  // dark React frame this gate exists to prevent. The native splash covers it.
  if (!ready) return null;

  return (
    <QueryProvider>
      <ToastProvider>
        <View style={{ flex: 1, backgroundColor: palette.appBg }}>
          {/* Light content on a dark ground and vice versa. */}
          <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: palette.appBg },
              animation: 'slide_from_right',
            }}
          >
            {/*
              The guard is structural, not a redirect: an incomplete device has
              no `(tabs)` route to navigate to, so Back and a cold restart cannot
              step around onboarding (arch-001 §4).
            */}
            <Stack.Protected guard={!onboarding.completed}>
              <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
            </Stack.Protected>
            <Stack.Protected guard={onboarding.completed}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="article/[id]" />
              <Stack.Screen name="search" options={{ animation: 'fade' }} />
            </Stack.Protected>
          </Stack>
        </View>
      </ToastProvider>
    </QueryProvider>
  );
}
