import { Platform } from 'react-native';

/**
 * Tiny string key/value store — the one place the app touches device storage.
 *
 * Native uses `expo-sqlite/kv-store`: it is Expo-supported, survives restart, and
 * gives an AsyncStorage-shaped API without adding a second storage dependency
 * (arch-001 §4). Web uses `localStorage`, because Expo SQLite on web is alpha and
 * must not endanger `expo export --platform web`; anything without either falls
 * back to an in-memory map so a read never throws — it just does not persist, and
 * says so once.
 *
 * P6/P9 extend this with the device id, query cache and notification id. Keep the
 * surface at get/set/remove: a wider API here would leak storage details upward.
 */

export type KvStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

const memory = new Map<string, string>();
let warnedMemoryFallback = false;

export const memoryStore: KvStore = {
  async getItem(key) {
    return memory.get(key) ?? null;
  },
  async setItem(key, value) {
    memory.set(key, value);
  },
  async removeItem(key) {
    memory.delete(key);
  },
};

function warnMemoryFallback(reason: string): void {
  // Once per process: a silent in-memory store looks exactly like a working one
  // until the app restarts and the user's choice is gone.
  if (warnedMemoryFallback) return;
  warnedMemoryFallback = true;
  console.warn(`[kv] falling back to in-memory storage (${reason}); values will not persist.`);
}

/** Test seam: lets a test observe the one-time warning more than once per run. */
export function resetKvWarningForTests(): void {
  warnedMemoryFallback = false;
}

/**
 * Duck-type check for an AsyncStorage-shaped object. Used on the native module's
 * export because the failure it guards against is silent: calling a missing
 * method throws a `TypeError` that the per-call `catch` would turn into "read
 * failed", i.e. an app that looks like it persists and does not (rev-002 B1).
 */
export function isKvLike(value: unknown): value is KvStore {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<KvStore>;
  return (
    typeof candidate.getItem === 'function' &&
    typeof candidate.setItem === 'function' &&
    typeof candidate.removeItem === 'function'
  );
}

/**
 * `expo-sqlite/kv-store` exports the *instance* — `export default AsyncStorage`
 * and `export const Storage = AsyncStorage` (verified in
 * `node_modules/expo-sqlite/build/Storage.js:396-401`). The module namespace has
 * no `getItem` of its own, so it must be unwrapped before use.
 */
export function resolveNativeStore(module: unknown): KvStore | null {
  if (isKvLike(module)) return module; // a namespace that is itself the store
  if (typeof module === 'object' && module !== null) {
    const namespace = module as { default?: unknown; Storage?: unknown };
    const exported = namespace.default ?? namespace.Storage;
    if (isKvLike(exported)) return exported;
  }
  return null;
}

/** Wrap a raw store so one failing call cannot take a screen down with it. */
function guarded(store: KvStore, label: string): KvStore {
  return {
    async getItem(key) {
      try {
        return await store.getItem(key);
      } catch (error) {
        console.warn(`[kv] ${label} read failed for "${key}":`, error);
        return null;
      }
    },
    async setItem(key, value) {
      try {
        await store.setItem(key, value);
      } catch (error) {
        console.warn(`[kv] ${label} write failed for "${key}":`, error);
      }
    },
    async removeItem(key) {
      try {
        await store.removeItem(key);
      } catch (error) {
        console.warn(`[kv] ${label} remove failed for "${key}":`, error);
      }
    },
  };
}

export function createWebStore(
  localStorageImpl?: Storage | null,
  onFallback: (reason: string) => void = warnMemoryFallback,
): KvStore {
  const ls =
    localStorageImpl !== undefined
      ? localStorageImpl
      : typeof globalThis !== 'undefined' && 'localStorage' in globalThis
        ? (globalThis as unknown as { localStorage: Storage }).localStorage
        : null;

  if (!ls) {
    onFallback('no localStorage on this web runtime');
    return memoryStore;
  }

  /**
   * Safari private mode and blocked third-party storage let `localStorage` exist
   * and then throw on use. After the first such failure this adapter switches to
   * the memory store for the rest of the session (rev-002 N3): warning on every
   * call while silently dropping state is worse than losing persistence loudly
   * once and keeping the session coherent.
   */
  let degraded = false;
  const degrade = (operation: string, error: unknown): void => {
    if (degraded) return;
    degraded = true;
    onFallback(`localStorage ${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
  };

  return {
    async getItem(key) {
      if (degraded) return memoryStore.getItem(key);
      try {
        return ls.getItem(key);
      } catch (error) {
        degrade('read', error);
        return memoryStore.getItem(key);
      }
    },
    async setItem(key, value) {
      if (degraded) return memoryStore.setItem(key, value);
      try {
        ls.setItem(key, value);
      } catch (error) {
        degrade('write', error);
        await memoryStore.setItem(key, value);
      }
    },
    async removeItem(key) {
      if (degraded) return memoryStore.removeItem(key);
      try {
        ls.removeItem(key);
      } catch (error) {
        degrade('remove', error);
        await memoryStore.removeItem(key);
      }
    },
  };
}

/**
 * The real `require`, kept in a private function referenced only from the native
 * branch below. It must NOT live inside an exported function: exporting it puts
 * `expo-sqlite`'s web SQLite worker into the web module graph, and that worker
 * imports a `.wasm` file Metro cannot resolve — measured, it fails
 * `expo export --platform web` outright.
 */
function loadNativeModule(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-sqlite/kv-store');
}

export function createNativeStore(
  loadModule: () => unknown,
  onFallback: (reason: string) => void = warnMemoryFallback,
): KvStore {
  let module: unknown;
  try {
    module = loadModule();
  } catch (error) {
    onFallback(`expo-sqlite/kv-store unavailable: ${String(error)}`);
    return memoryStore;
  }

  const store = resolveNativeStore(module);
  if (!store) {
    onFallback('expo-sqlite/kv-store exported no getItem/setItem/removeItem');
    return memoryStore;
  }
  return guarded(store, 'kv-store');
}

export const kv: KvStore =
  Platform.OS === 'web' ? createWebStore() : createNativeStore(loadNativeModule);

/**
 * Storage keys owned by the app. Adding one here keeps them greppable in one place.
 *
 * Everything P6 added carries a `v1:` prefix: the values are JSON whose shape is
 * tied to the repository contract version, so a future shape change writes under
 * `v2:` and leaves the old blob to be ignored rather than mis-parsed.
 */
export const KV_KEYS = {
  themePreference: 'aigundem.theme-preference',

  /** uuid v4, generated once per install (addendum §A: identity is device-local). */
  deviceId: 'v1:aigundem.device_id',

  /** Device-local user state — none of this is ever sent to Supabase. */
  enabledSourceIds: 'v1:aigundem.user.enabled_sources',
  savedArticles: 'v1:aigundem.user.saved',
  readArticles: 'v1:aigundem.user.read',
  settings: 'v1:aigundem.user.settings',
  recentSearches: 'v1:aigundem.user.recent_searches',
  onboardingDone: 'v1:aigundem.user.onboarding_done',

  /** TanStack Query's persisted cache blob. */
  queryCache: 'v1:aigundem.query-cache',
} as const;
