/**
 * Semantic colour palettes. Every slot is a *role*, not a shade: a component asks
 * for `card` or `textBody`, never for "#15233B", so the same component renders in
 * both themes without knowing which one is active.
 *
 * `dark` keeps the exact values impl-001 transcribed from
 * `design/AI Gündem - Prototip.dc.html`. `light` uses the board's measured light
 * tokens (`design/AI Gündem - Tasarım Panosu.dc.html`, section "04 · LIGHT TEMA":
 * bg `#F4F6FB`, surface `#FFFFFF`, text `#0F1B33`, frame border `#D8E0F0`, soft
 * `#E7EEFB`, accent `#2563EB`) and derives the rest by the rules noted per slot —
 * every derived value is listed in `agents/reports/p8.md`.
 *
 * The board's own rule, quoted: "Primary/Accent aynı kalır" — the accent and
 * everything built from it stay identical across themes.
 */

export type ColorScheme = 'dark' | 'light';

export type Palette = {
  /** Page ground behind the app frame. */
  canvas: string;
  /** The app's own background. */
  appBg: string;
  /** Raised surface: cards, groups, sheets. */
  card: string;
  /** Small filled square behind a source badge. */
  tile: string;
  /** Switch track when off. */
  switchOff: string;
  /** Text input and segmented-control track. */
  inputBg: string;

  accent: string;
  accentPressed: string;
  /** Accent as *text/icon* on the app background. */
  accentText: string;
  /** Lighter accent for badge glyphs. */
  lightAccent: string;
  /** Pale accent chip (digest "01", "3 madde"). */
  paleChip: string;
  /** Text drawn on top of `accent`/`paleChip`. */
  onAccent: string;
  /** Knob and other always-white surfaces. */
  white: string;

  text: string;
  danger: string;

  border: string;
  borderStrong: string;
  borderChip: string;
  borderControl: string;
  borderSeg: string;
  borderRow: string;
  borderDetailCard: string;
  borderBookmark: string;
  borderSheet: string;
  borderToast: string;
  borderDashed: string;
  tabBarBorder: string;

  accentSoft: string;
  accentSheetPick: string;
  tabBarBg: string;
  scrim: string;

  /** Floating toast is an inverted surface in both themes. */
  toastBg: string;
  toastText: string;

  textStrong: string;
  textBody: string;
  text75: string;
  text6: string;
  text55: string;
  text5: string;
  text45: string;
  text4: string;
  text32: string;
  text25: string;

  tabInactive: string;
};

/** Dark — unchanged from `src/theme/tokens.ts` as impl-001 shipped it. */
export const dark: Palette = {
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
  onAccent: '#fff',
  white: '#fff',

  text: '#E5EAF2',
  danger: '#E5484D',

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

  toastBg: '#1E3358',
  toastText: '#E5EAF2',

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
};

/**
 * Light. Slots marked BOARD are read straight off "04 · LIGHT TEMA"; slots marked
 * DERIVED are not drawn anywhere in that section and follow the stated rule. The
 * text alpha ramp is the board's own `rgba(15,27,51,·)` sequence.
 */
export const light: Palette = {
  canvas: '#E9EDF6', // DERIVED: appBg one step darker, keeping the frame recessed.
  appBg: '#F4F6FB', // BOARD
  card: '#FFFFFF', // BOARD
  tile: '#E7EEFB', // BOARD (source badge fill)
  switchOff: '#D8E0F0', // DERIVED: the board's own neutral (#D8E0F0) as the off track.
  inputBg: '#F4F6FB', // BOARD (segmented-control track on a white card)

  accent: '#2563EB', // BOARD ("Primary/Accent aynı kalır")
  accentPressed: '#1D4FD8', // DERIVED: accent is theme-invariant, so its pressed shade is too.
  accentText: '#2563EB', // BOARD (accent-as-text is #2563EB on light, not #60A5FA)
  lightAccent: '#2563EB', // BOARD (badge glyph "OA" is #2563EB on the light tile)
  paleChip: '#BAE6FD', // BOARD (unchanged; still carries #0B1220 text)
  onAccent: '#fff', // BOARD
  white: '#fff', // invariant

  text: '#0F1B33', // BOARD
  danger: '#DC2626', // DERIVED: #E5484D reads ~3.7:1 on #FFFFFF; #DC2626 is the same hue at ~4.8:1.

  border: 'rgba(37,99,235,.13)', // BOARD (card border)
  borderStrong: 'rgba(37,99,235,.2)', // BOARD (tile border)
  borderChip: 'rgba(37,99,235,.35)', // BOARD (category pill)
  borderControl: 'rgba(37,99,235,.3)', // BOARD (44px icon button)
  borderSeg: 'rgba(37,99,235,.2)', // BOARD (segmented control)
  borderRow: 'rgba(37,99,235,.1)', // BOARD (row divider)
  borderDetailCard: 'rgba(37,99,235,.3)', // BOARD (summary card)
  borderBookmark: 'rgba(37,99,235,.35)', // BOARD
  borderSheet: 'rgba(37,99,235,.2)', // DERIVED: no light sheet on the board; matches borderSeg.
  borderToast: 'rgba(15,27,51,.5)', // DERIVED: see toastBg — the toast is an inverted surface.
  borderDashed: 'rgba(37,99,235,.4)', // DERIVED: dark's .5 dashed rule is heavy on white; .4 matches the board's chip weight.
  tabBarBorder: 'rgba(37,99,235,.15)', // BOARD

  accentSoft: 'rgba(37,99,235,.08)', // BOARD (digest badge, bookmark fill)
  accentSheetPick: 'rgba(37,99,235,.12)', // DERIVED: no light sheet; sits in the board's .08–.13 tint band.
  tabBarBg: 'rgba(255,255,255,.96)', // BOARD
  scrim: 'rgba(15,27,51,.35)', // DERIVED: text colour at .35 — dark's near-black .62 would read as a blackout on a light UI.

  toastBg: '#0F1B33', // DERIVED: inverted surface (text colour), the usual snackbar treatment.
  toastText: '#FFFFFF', // DERIVED: on-inverted-surface text.

  textStrong: 'rgba(15,27,51,.92)', // ramp
  textBody: 'rgba(15,27,51,.8)', // ramp
  text75: 'rgba(15,27,51,.75)', // BOARD (chip label)
  text6: 'rgba(15,27,51,.6)', // BOARD (secondary — the board names "ikincil %60")
  text55: 'rgba(15,27,51,.55)', // BOARD
  text5: 'rgba(15,27,51,.5)', // BOARD
  text45: 'rgba(15,27,51,.45)', // BOARD (section label)
  text4: 'rgba(15,27,51,.4)', // BOARD (chevron)
  text32: 'rgba(15,27,51,.32)', // ramp
  text25: 'rgba(15,27,51,.25)', // ramp (sheet grabber)

  tabInactive: 'rgba(15,27,51,.5)', // BOARD
};

export const palettes: Record<ColorScheme, Palette> = { dark, light };
