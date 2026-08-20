import { Platform } from 'react-native';

/**
 * Theme-invariant design values, split out of the old `tokens.ts`. Type, radii and
 * timings do not change between dark and light, so they are plain constants rather
 * than palette slots — a component that only needs these does not need `useTheme()`.
 */

/** Inter faces loaded via `@expo-google-fonts/inter`; see `app/_layout.tsx`. */
export const fonts = {
  r: 'Inter_400Regular',
  m: 'Inter_500Medium',
  sb: 'Inter_600SemiBold',
  b: 'Inter_700Bold',
  xb: 'Inter_800ExtraBold',
} as const;

export const mono = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'ui-monospace, Menlo, monospace',
}) as string;

export const radius = {
  card: 16,
  tile: 11,
  control: 13,
  seg: 12,
  pill: 999,
  sheet: 24,
} as const;

/** Space the fixed tab bar occupies, matching the prototype's 110px bottom padding. */
export const TAB_BAR_SPACE = 110;
/** Toast lifetime in ms — prototype `toastMsg` uses 2200. */
export const TOAST_MS = 2200;
