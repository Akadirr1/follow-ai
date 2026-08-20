import React from 'react';
import * as RN from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { KV_KEYS, type KvStore } from '../../storage/kv';
import { dark, light } from '../palettes';
import {
  DEFAULT_PREFERENCE,
  isThemePreference,
  resolveScheme,
  ThemeProvider,
  useTheme,
  type ThemePreference,
  type ThemeValue,
} from '../ThemeProvider';

/** In-memory stand-in for `expo-sqlite/kv-store` — no native module in Jest. */
function fakeKv(initial?: Record<string, string>): KvStore & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    data,
    async getItem(key) {
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    },
  };
}

/** Renders the provider and hands the latest context value back to the test. */
async function renderTheme(storage: KvStore) {
  let latest: ThemeValue | null = null;
  function Probe() {
    latest = useTheme();
    return null;
  }
  // A fresh element each time: React bails out of `update()` when handed the
  // referentially identical element, which would hide a re-render.
  const element = () => (
    <ThemeProvider storage={storage}>
      <Probe />
    </ThemeProvider>
  );
  let tree: ReactTestRenderer | null = null;
  await act(async () => {
    tree = TestRenderer.create(element());
  });
  return {
    get value(): ThemeValue {
      if (!latest) throw new Error('provider did not render');
      return latest;
    },
    /** Re-render the same tree — what an OS colour-scheme change causes. */
    rerender: async () => {
      await act(async () => {
        tree?.update(element());
      });
    },
    unmount: () => tree?.unmount(),
  };
}

describe('resolveScheme', () => {
  it('ignores the OS for an explicit preference', () => {
    expect(resolveScheme('dark', 'light')).toBe('dark');
    expect(resolveScheme('light', 'dark')).toBe('light');
  });

  it('follows the OS for system', () => {
    expect(resolveScheme('system', 'light')).toBe('light');
    expect(resolveScheme('system', 'dark')).toBe('dark');
  });

  it('falls back to dark when the OS reports nothing', () => {
    expect(resolveScheme('system', null)).toBe('dark');
    expect(resolveScheme('system', undefined)).toBe('dark');
  });
});

describe('isThemePreference', () => {
  it.each(['dark', 'light', 'system'])('accepts %p', (value) => {
    expect(isThemePreference(value)).toBe(true);
  });

  it.each(['Koyu', '', 'auto', null, 7, undefined])('rejects %p', (value) => {
    expect(isThemePreference(value)).toBe(false);
  });
});

describe('ThemeProvider', () => {
  let useColorScheme: jest.SpyInstance;

  beforeEach(() => {
    useColorScheme = jest.spyOn(RN, 'useColorScheme').mockReturnValue('dark');
  });

  afterEach(() => {
    useColorScheme.mockRestore();
  });

  it('starts on the dark default and reports ready after reading storage', async () => {
    const rendered = await renderTheme(fakeKv());
    expect(rendered.value.preference).toBe(DEFAULT_PREFERENCE);
    expect(rendered.value.scheme).toBe('dark');
    expect(rendered.value.palette).toBe(dark);
    expect(rendered.value.isReady).toBe(true);
    rendered.unmount();
  });

  it('restores a stored preference before the first ready frame', async () => {
    const rendered = await renderTheme(fakeKv({ [KV_KEYS.themePreference]: 'light' }));
    expect(rendered.value.preference).toBe('light');
    expect(rendered.value.scheme).toBe('light');
    expect(rendered.value.palette).toBe(light);
    rendered.unmount();
  });

  it('round-trips a preference through the kv adapter', async () => {
    const storage = fakeKv();
    const first = await renderTheme(storage);

    await act(async () => {
      first.value.setPreference('light');
    });
    expect(first.value.preference).toBe('light');
    expect(first.value.palette).toBe(light);
    expect(storage.data.get(KV_KEYS.themePreference)).toBe('light');
    first.unmount();

    // A fresh provider over the same storage sees the persisted choice.
    const second = await renderTheme(storage);
    expect(second.value.preference).toBe('light');
    second.unmount();
  });

  it('resolves system through useColorScheme and re-resolves when the OS changes', async () => {
    useColorScheme.mockReturnValue('light');
    const rendered = await renderTheme(fakeKv({ [KV_KEYS.themePreference]: 'system' }));
    expect(rendered.value.preference).toBe('system');
    expect(rendered.value.scheme).toBe('light');
    expect(rendered.value.palette).toBe(light);

    // The OS flips to dark. `useColorScheme` re-renders the tree in a real app;
    // here the re-render is explicit, and the preference must survive it.
    useColorScheme.mockReturnValue('dark');
    await rendered.rerender();
    expect(rendered.value.preference).toBe('system');
    expect(rendered.value.scheme).toBe('dark');
    expect(rendered.value.palette).toBe(dark);
    rendered.unmount();
  });

  it('warns and keeps the default when storage holds a value we did not write', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rendered = await renderTheme(fakeKv({ [KV_KEYS.themePreference]: 'sepia' }));
      expect(rendered.value.preference).toBe(DEFAULT_PREFERENCE);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sepia'));
      rendered.unmount();
    } finally {
      warn.mockRestore();
    }
  });

  it('warns and ignores an invalid setPreference instead of blanking the palette', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = fakeKv();
      const rendered = await renderTheme(storage);
      await act(async () => {
        rendered.value.setPreference('neon' as ThemePreference);
      });
      expect(rendered.value.preference).toBe(DEFAULT_PREFERENCE);
      expect(storage.data.has(KV_KEYS.themePreference)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('neon'));
      rendered.unmount();
    } finally {
      warn.mockRestore();
    }
  });

  it('throws a clear error when useTheme is used outside the provider', () => {
    function Orphan() {
      useTheme();
      return null;
    }
    // React 19 does not rethrow render errors out of create(), so an error
    // boundary catches it — which is also how a real app would see it.
    const caught: Error[] = [];
    class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch(error: Error) {
        caught.push(error);
      }
      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Held on an object so TypeScript does not narrow it to `null` across the
      // act() callback.
      const holder: { tree: ReactTestRenderer | null } = { tree: null };
      TestRenderer.act(() => {
        holder.tree = TestRenderer.create(
          <Boundary>
            <Orphan />
          </Boundary>,
        );
      });
      holder.tree?.unmount();
    } finally {
      error.mockRestore();
    }

    expect(caught).toHaveLength(1);
    expect(caught[0].message).toBe('useTheme must be used inside <ThemeProvider>');
  });
});
