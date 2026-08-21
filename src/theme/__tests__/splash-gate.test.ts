import { isAppReady } from '../../../app/_layout';

/**
 * The launch gate from `app/_layout.tsx` (rev-002 B2).
 *
 * `app/_layout.tsx` pulls in expo-router, the font package and the splash module,
 * so those are mocked to the smallest surface that lets the module load; the
 * assertion is on `isAppReady`, which is pure. The visual consequence — that no
 * dark React frame precedes a light first paint — is a device measurement and is
 * recorded as not verified in `agents/reports/fix-002.md`.
 */

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn().mockResolvedValue(true),
  hideAsync: jest.fn().mockResolvedValue(true),
}));
jest.mock('expo-router', () => {
  const Stack = () => null;
  Stack.Screen = () => null;
  Stack.Protected = () => null;
  return { Stack };
});
jest.mock('@expo-google-fonts/inter', () => ({
  useFonts: () => [false, null],
  Inter_400Regular: 'Inter_400Regular',
  Inter_500Medium: 'Inter_500Medium',
  Inter_600SemiBold: 'Inter_600SemiBold',
  Inter_700Bold: 'Inter_700Bold',
  Inter_800ExtraBold: 'Inter_800ExtraBold',
}));

describe('isAppReady', () => {
  it('is false while both fonts and the stored preference are still loading', () => {
    expect(isAppReady({ fontsLoaded: false, fontError: null, themeReady: false, onboardingReady: true })).toBe(false);
  });

  it('is false when fonts are loaded but the preference is not — the B2 defect', () => {
    // This is the state that used to paint a dark React frame over a light
    // preference. The gate now keeps the native splash up instead.
    expect(isAppReady({ fontsLoaded: true, fontError: null, themeReady: false, onboardingReady: true })).toBe(false);
  });

  it('is false when the preference is ready but fonts are not', () => {
    expect(isAppReady({ fontsLoaded: false, fontError: null, themeReady: true, onboardingReady: true })).toBe(false);
  });

  it('is true only when both are settled', () => {
    expect(isAppReady({ fontsLoaded: true, fontError: null, themeReady: true, onboardingReady: true })).toBe(true);
  });

  it('treats a font failure as settled rather than waiting forever', () => {
    // The app is usable in the system face; a permanent splash is not.
    expect(isAppReady({ fontsLoaded: false, fontError: new Error('nope'), themeReady: true, onboardingReady: true })).toBe(
      true,
    );
  });

  it('still waits for the preference even when fonts failed', () => {
    expect(isAppReady({ fontsLoaded: false, fontError: new Error('nope'), themeReady: false, onboardingReady: true })).toBe(
      false,
    );
  });

  it('ignores an undefined fontError, which is the loading state', () => {
    expect(
      isAppReady({
        fontsLoaded: false,
        fontError: undefined,
        themeReady: true,
        onboardingReady: true,
      }),
    ).toBe(false);
  });

  // P9 joined the onboarding read to the same gate: deciding which route to show
  // after the first paint would flash the tabs at a device that has never
  // completed onboarding.
  it('waits for the onboarding read even when fonts and theme are ready', () => {
    expect(
      isAppReady({
        fontsLoaded: true,
        fontError: null,
        themeReady: true,
        onboardingReady: false,
      }),
    ).toBe(false);
  });

  it('is true only when all three inputs have settled', () => {
    expect(
      isAppReady({
        fontsLoaded: true,
        fontError: null,
        themeReady: true,
        onboardingReady: true,
      }),
    ).toBe(true);
  });
});

describe('splash lifecycle', () => {
  it('prevents the automatic hide when the layout module is evaluated', () => {
    // Importing the module ran `preventAutoHideAsync()` at load time; without it
    // the splash would hide before the preference read finished.
    const splash = jest.requireMock('expo-splash-screen') as {
      preventAutoHideAsync: jest.Mock;
    };
    expect(splash.preventAutoHideAsync).toHaveBeenCalled();
  });
});
