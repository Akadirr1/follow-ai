import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { StyleSheet, useColorScheme } from 'react-native';

import { KV_KEYS, kv, type KvStore } from '../storage/kv';
import { palettes, type ColorScheme, type Palette } from './palettes';

/**
 * Theme ownership. The *preference* is what the user picked (`dark` | `light` |
 * `system`); the *scheme* is what that resolves to right now. Only `system`
 * consults the OS, and it re-resolves whenever `useColorScheme()` changes, so an
 * OS switch repaints without a restart.
 *
 * The preference is read from storage before the first painted frame — the root
 * layout holds the blank canvas until `isReady` (arch-001 §4: "Load the local
 * preference before first painted app frame").
 */

export type ThemePreference = 'dark' | 'light' | 'system';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['dark', 'light', 'system'];

/** Falls back to dark, which is the product's primary theme, not an arbitrary default. */
export const DEFAULT_PREFERENCE: ThemePreference = 'dark';
export const FALLBACK_SCHEME: ColorScheme = 'dark';

export const isThemePreference = (value: unknown): value is ThemePreference =>
  typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);

/** `system` with no OS answer yet resolves to dark rather than flashing light. */
export const resolveScheme = (
  preference: ThemePreference,
  systemScheme: ColorScheme | null | undefined,
): ColorScheme => (preference === 'system' ? (systemScheme ?? FALLBACK_SCHEME) : preference);

export type ThemeValue = {
  palette: Palette;
  scheme: ColorScheme;
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
  /** False until the stored preference has been read. */
  isReady: boolean;
};

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({
  children,
  storage = kv,
}: {
  children: ReactNode;
  /** Injectable so tests can drive the round-trip without a native module. */
  storage?: KvStore;
}) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>(DEFAULT_PREFERENCE);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await storage.getItem(KV_KEYS.themePreference);
      if (cancelled) return;
      if (stored !== null && !isThemePreference(stored)) {
        // A value we did not write, or one from a future version.
        console.warn(
          `[theme] stored preference "${stored}" is not one of ${THEME_PREFERENCES.join(
            ' | ',
          )}; using "${DEFAULT_PREFERENCE}".`,
        );
      }
      if (isThemePreference(stored)) setPreferenceState(stored);
      setIsReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [storage]);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      if (!isThemePreference(next)) {
        console.warn(`[theme] setPreference ignored: "${next}" is not a valid preference.`);
        return;
      }
      // Apply locally first; persistence must never delay the repaint.
      setPreferenceState(next);
      void storage.setItem(KV_KEYS.themePreference, next);
    },
    [storage],
  );

  const scheme = resolveScheme(preference, systemScheme);

  const value = useMemo<ThemeValue>(
    () => ({
      palette: palettes[scheme],
      scheme,
      preference,
      setPreference,
      isReady,
    }),
    [scheme, preference, setPreference, isReady],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}

/** Just the preference and its setter, for the Settings control. */
export function useThemePreference(): {
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
} {
  const { preference, setPreference } = useTheme();
  return { preference, setPreference };
}

type NamedStyles = Record<string, object>;

/**
 * Build a StyleSheet from the active palette, rebuilt only when the palette
 * changes. Components keep their styles in one place instead of scattering inline
 * colour objects through the tree.
 */
export function useThemedStyles<T extends NamedStyles>(factory: (palette: Palette) => T): T {
  const { palette } = useTheme();
  return useMemo(() => StyleSheet.create(factory(palette)), [factory, palette]);
}
