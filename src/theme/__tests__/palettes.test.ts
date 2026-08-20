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
