import {
  createNativeStore,
  createWebStore,
  isKvLike,
  memoryStore,
  resolveNativeStore,
} from '../kv';

/**
 * The kv adapter's two failure modes, both of which used to lose data silently
 * (rev-002 B1 and N3). The native tests use the **real** export shape of
 * `expo-sqlite/kv-store` rather than a hand-shaped fake, because the previous
 * tests passed against a fake while the production path called the module
 * namespace and never reached a store at all.
 */

/** The store instance a `SQLiteStorage` behaves like, backed by a Map. */
function fakeSqliteStorage() {
  const data = new Map<string, string>();
  return {
    data,
    async getItem(key: string) {
      return data.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      data.set(key, value);
    },
    async removeItem(key: string) {
      data.delete(key);
    },
  };
}

/**
 * The module namespace `require('expo-sqlite/kv-store')` actually produces:
 * `export const AsyncStorage = new SQLiteStorage(...)`, `export default
 * AsyncStorage`, `export const Storage = AsyncStorage` — verified in
 * `node_modules/expo-sqlite/build/Storage.js:396-401`. Note the namespace itself
 * has no `getItem`.
 */
function realShapedModule(instance: ReturnType<typeof fakeSqliteStorage>) {
  return {
    __esModule: true,
    SQLiteStorage: class {},
    AsyncStorage: instance,
    Storage: instance,
    default: instance,
  };
}

describe('isKvLike', () => {
  it('accepts an object with all three methods', () => {
    expect(isKvLike(fakeSqliteStorage())).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'store'],
    ['a namespace with no methods', { SQLiteStorage: class {} }],
    ['a partial store', { getItem: () => null, setItem: () => undefined }],
  ])('rejects %s', (_label, value) => {
    expect(isKvLike(value)).toBe(false);
  });
});

describe('resolveNativeStore', () => {
  it('unwraps the instance from the real {default, Storage} export shape', () => {
    const instance = fakeSqliteStorage();
    expect(resolveNativeStore(realShapedModule(instance))).toBe(instance);
  });

  it('prefers default, and falls back to Storage when default is absent', () => {
    const instance = fakeSqliteStorage();
    expect(resolveNativeStore({ Storage: instance })).toBe(instance);
  });

  it('accepts a namespace that is itself the store', () => {
    const instance = fakeSqliteStorage();
    expect(resolveNativeStore(instance)).toBe(instance);
  });

  it('returns null when nothing on the module is store-shaped', () => {
    // This is the exact rev-002 B1 defect: the namespace alone has no getItem.
    expect(resolveNativeStore({ __esModule: true, SQLiteStorage: class {} })).toBeNull();
  });
});

describe('native store over the real export shape', () => {
  it('reads and writes reach the exported instance, not the namespace', async () => {
    const instance = fakeSqliteStorage();
    const fallbacks: string[] = [];
    const store = createNativeStore(() => realShapedModule(instance), (reason) =>
      fallbacks.push(reason),
    );

    await store.setItem('aigundem.theme-preference', 'light');
    expect(instance.data.get('aigundem.theme-preference')).toBe('light');
    expect(await store.getItem('aigundem.theme-preference')).toBe('light');

    await store.removeItem('aigundem.theme-preference');
    expect(instance.data.has('aigundem.theme-preference')).toBe(false);

    // The whole point: no fallback was needed.
    expect(fallbacks).toEqual([]);
  });

  it('falls back with a named warning when the module exports no store', async () => {
    const fallbacks: string[] = [];
    const store = createNativeStore(
      () => ({ __esModule: true, SQLiteStorage: class {} }),
      (reason) => fallbacks.push(reason),
    );
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toContain('getItem/setItem/removeItem');
    // Still usable for the session, just not persistent.
    await store.setItem('k', 'v');
    expect(await store.getItem('k')).toBe('v');
  });

  it('falls back when the module cannot be required at all', () => {
    const fallbacks: string[] = [];
    createNativeStore(
      () => {
        throw new Error('Cannot find module');
      },
      (reason) => fallbacks.push(reason),
    );
    expect(fallbacks[0]).toContain('unavailable');
  });

  it('survives a throwing method without taking the caller down', async () => {
    const instance = {
      getItem: async () => {
        throw new Error('db locked');
      },
      setItem: async () => {
        throw new Error('db locked');
      },
      removeItem: async () => {
        throw new Error('db locked');
      },
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = createNativeStore(() => ({ default: instance }), () => {});
      expect(await store.getItem('k')).toBeNull();
      await expect(store.setItem('k', 'v')).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('kv-store read failed'), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });
});

describe('web store', () => {
  /** A `localStorage` that works until told to throw. */
  function fakeLocalStorage() {
    const data = new Map<string, string>();
    let throwing = false;
    return {
      breakIt: () => {
        throwing = true;
      },
      data,
      impl: {
        getItem(key: string) {
          if (throwing) throw new Error('SecurityError: storage is blocked');
          return data.get(key) ?? null;
        },
        setItem(key: string, value: string) {
          if (throwing) throw new Error('QuotaExceededError');
          data.set(key, value);
        },
        removeItem(key: string) {
          if (throwing) throw new Error('SecurityError: storage is blocked');
          data.delete(key);
        },
      } as unknown as Storage,
    };
  }

  it('round-trips through localStorage while it works', async () => {
    const ls = fakeLocalStorage();
    const store = createWebStore(ls.impl, () => {});
    await store.setItem('k', 'v');
    expect(ls.data.get('k')).toBe('v');
    expect(await store.getItem('k')).toBe('v');
  });

  it('switches to memory after the first failure, warning once', async () => {
    const ls = fakeLocalStorage();
    const fallbacks: string[] = [];
    const store = createWebStore(ls.impl, (reason) => fallbacks.push(reason));

    await store.setItem('before', 'ok');
    ls.breakIt();

    // The failing write is not dropped — it lands in memory instead (rev-002 N3).
    await store.setItem('after', 'still-here');
    expect(await store.getItem('after')).toBe('still-here');

    // Subsequent calls go straight to memory without touching localStorage again.
    await store.setItem('later', 'also-here');
    expect(await store.getItem('later')).toBe('also-here');

    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toContain('localStorage write failed');
  });

  it('degrades on a failing read too', async () => {
    const ls = fakeLocalStorage();
    const fallbacks: string[] = [];
    const store = createWebStore(ls.impl, (reason) => fallbacks.push(reason));
    ls.breakIt();

    expect(await store.getItem('missing')).toBeNull();
    expect(fallbacks[0]).toContain('localStorage read failed');
    await store.setItem('k', 'v');
    expect(await store.getItem('k')).toBe('v');
    expect(ls.data.has('k')).toBe(false);
  });

  it('uses memory when there is no localStorage at all', async () => {
    const fallbacks: string[] = [];
    const store = createWebStore(null, (reason) => fallbacks.push(reason));
    expect(fallbacks[0]).toContain('no localStorage');
    expect(store).toBe(memoryStore);
  });
});
