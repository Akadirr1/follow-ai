import { dark, light, palettes, type Palette } from '../palettes';

describe('palettes', () => {
  it('dark and light have identical key sets', () => {
    const darkKeys = Object.keys(dark).sort();
    const lightKeys = Object.keys(light).sort();
    expect(lightKeys).toEqual(darkKeys);
    // A slot added to one palette and forgotten in the other would render as
    // `undefined` — a transparent surface — rather than failing loudly.
    expect(darkKeys.length).toBeGreaterThan(30);
  });

  it('every slot in both palettes is a non-empty colour string', () => {
    for (const [name, palette] of Object.entries(palettes)) {
      for (const [slot, value] of Object.entries(palette)) {
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
        expect(`${name}.${slot}=${value}`).toMatch(/=(#[0-9A-Fa-f]{3,8}|rgba?\()/);
      }
    }
  });

  it('keeps the dark values impl-001 transcribed from the prototype', () => {
    expect(dark.appBg).toBe('#0B1220');
    expect(dark.card).toBe('#15233B');
    expect(dark.text).toBe('#E5EAF2');
    expect(dark.tile).toBe('#1E3358');
    expect(dark.accentText).toBe('#60A5FA');
  });

  it('uses the exact light tokens from the design board', () => {
    expect(light.appBg).toBe('#F4F6FB');
    expect(light.text).toBe('#0F1B33');
    expect(light.card).toBe('#FFFFFF');
    expect(light.tile).toBe('#E7EEFB');
    expect(light.accent).toBe('#2563EB');
    // The board's own note: "Primary/Accent aynı kalır".
    expect(light.accent).toBe(dark.accent);
    expect(light.accentPressed).toBe(dark.accentPressed);
  });

  it('builds each theme text ramp on that theme own text colour', () => {
    const ramp: (keyof Palette)[] = [
      'textStrong',
      'textBody',
      'text75',
      'text6',
      'text55',
      'text5',
      'text45',
      'text4',
      'text32',
      'text25',
      'tabInactive',
    ];
    for (const slot of ramp) {
      expect(dark[slot]).toMatch(/^rgba\(229,234,242,/);
      expect(light[slot]).toMatch(/^rgba\(15,27,51,/);
    }
  });

  it('inverts the toast surface in both themes so it never matches the page', () => {
    expect(dark.toastBg).not.toBe(dark.appBg);
    expect(light.toastBg).not.toBe(light.appBg);
    // Light toast is dark-on-light, so its text is not the page text colour.
    expect(light.toastText).not.toBe(light.text);
  });

  it('exposes both schemes through the palettes map', () => {
    expect(palettes.dark).toBe(dark);
    expect(palettes.light).toBe(light);
  });
});

/**
 * WCAG 2.x relative luminance and contrast ratio. Written out rather than pulled
 * from a package because the palette must not gain a dependency, and because the
 * formula is short enough that reading it is cheaper than trusting one.
 */
const relativeLuminance = (hex: string): number => {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const channels = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

export const contrastRatio = (a: string, b: string): number => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('light theme contrast (rev-002 N4)', () => {
  it('reproduces the reviewer measurement that rejected #DC2626', () => {
    // 4.466:1 on the page ground — under the 4.5:1 AA threshold for normal text.
    expect(contrastRatio('#DC2626', light.appBg)).toBeCloseTo(4.466, 2);
  });

  it('meets AA for normal text on both light surfaces', () => {
    expect(contrastRatio(light.danger, light.appBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.danger, light.card)).toBeGreaterThanOrEqual(4.5);
    // The chosen value, recorded so a future edit has to restate it deliberately.
    expect(light.danger).toBe('#B91C1C');
    expect(contrastRatio(light.danger, light.appBg)).toBeCloseTo(5.984, 2);
    expect(contrastRatio(light.danger, light.card)).toBeCloseTo(6.47, 2);
  });

  it('keeps the dark danger readable on the dark surfaces', () => {
    expect(contrastRatio(dark.danger, dark.appBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.danger, dark.card)).toBeGreaterThanOrEqual(3);
  });

  it('confirms the toast and body text the reviewer measured as passing', () => {
    expect(contrastRatio(light.toastText, light.toastBg)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(light.text, light.appBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.text, dark.appBg)).toBeGreaterThanOrEqual(4.5);
  });
});
