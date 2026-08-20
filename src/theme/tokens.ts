/**
 * Compatibility shim. `colors` is now just the **dark** palette, so the screens P7
 * has not migrated yet (feed, digest, saved, sources, article, search, tab layout,
 * `AppIcon`, `Icons`) keep compiling and keep their current appearance.
 *
 * Do not add anything here. New code takes colours from `useTheme()`
 * (`src/theme/ThemeProvider.tsx`) and invariants from `src/theme/typography.ts`.
 * P7 deletes this file once the last screen is migrated.
 */
import { dark } from './palettes';

export const colors = dark;

export { fonts, mono, radius, TAB_BAR_SPACE, TOAST_MS } from './typography';
export type { Palette } from './palettes';
