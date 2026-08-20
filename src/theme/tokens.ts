import { Platform } from 'react-native';

/**
 * Single source of colour/typography truth, transcribed from the inline styles in
 * `design/AI Gündem - Prototip.dc.html`. Dark theme only — v1 ships no light theme
 * (AGENTS.md invariant 4).
 */
export const colors = {
  canvas: '#070C16',
  appBg: '#0B1220',
  card: '#15233B',
  tile: '#1E3358',
  switchOff: '#1B2B47',
  inputBg: '#0E1930',
  accent: '#2563EB',
  accentPressed: '#1D4FD8',
  accentText: '#60A5FA',
  lightAccent: '#93C5FD',
  paleChip: '#BAE6FD',
  text: '#E5EAF2',
  danger: '#E5484D',
  white: '#fff',

  border: 'rgba(37,99,235,.18)',
  borderStrong: 'rgba(96,165,250,.28)',
  borderChip: 'rgba(37,99,235,.4)',
  borderControl: 'rgba(37,99,235,.35)',
  borderSeg: 'rgba(37,99,235,.25)',
  borderRow: 'rgba(37,99,235,.14)',
  borderDetailCard: 'rgba(37,99,235,.35)',
  borderBookmark: 'rgba(37,99,235,.45)',
  borderSheet: 'rgba(96,165,250,.25)',
  borderToast: 'rgba(96,165,250,.4)',
  borderDashed: 'rgba(37,99,235,.5)',
  tabBarBorder: 'rgba(37,99,235,.28)',

  accentSoft: 'rgba(96,165,250,.14)',
  accentSheetPick: 'rgba(37,99,235,.22)',
  tabBarBg: 'rgba(11,18,32,.94)',
  scrim: 'rgba(4,8,16,.62)',

  textStrong: 'rgba(229,234,242,.92)',
  textBody: 'rgba(229,234,242,.8)',
  text75: 'rgba(229,234,242,.75)',
  text6: 'rgba(229,234,242,.6)',
  text55: 'rgba(229,234,242,.55)',
  text5: 'rgba(229,234,242,.5)',
  text45: 'rgba(229,234,242,.45)',
  text4: 'rgba(229,234,242,.4)',
  text32: 'rgba(229,234,242,.32)',
  text25: 'rgba(229,234,242,.25)',

  tabInactive: 'rgba(229,234,242,.5)',
} as const;

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
