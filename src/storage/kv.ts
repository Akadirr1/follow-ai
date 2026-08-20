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

const memoryStore: KvStore = {
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

function createWebStore(): KvStore {
  const ls: Storage | null =
    typeof globalThis !== 'undefined' && 'localStorage' in globalThis
      ? (globalThis as unknown as { localStorage: Storage }).localStorage
      : null;

  if (!ls) {
    warnMemoryFallback('no localStorage on this web runtime');
    return memoryStore;
  }

  return {
    async getItem(key) {
      try {
        return ls.getItem(key);
      } catch (error) {
        // Safari private mode and blocked third-party storage both throw here.
        console.warn(`[kv] localStorage read failed for "${key}":`, error);
        return null;
      }
    },
    async setItem(key, value) {
      try {
        ls.setItem(key, value);
      } catch (error) {
        console.warn(`[kv] localStorage write failed for "${key}":`, error);
      }
    },
    async removeItem(key) {
      try {
        ls.removeItem(key);
      } catch (error) {
        console.warn(`[kv] localStorage remove failed for "${key}":`, error);
      }
    },
  };
}

function createNativeStore(): KvStore {
  try {
    // Required lazily so the web bundle never resolves the native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Store = require('expo-sqlite/kv-store') as {
      getItem(key: string): Promise<string | null>;
      setItem(key: string, value: string): Promise<void>;
      removeItem(key: string): Promise<void>;
    };
    return {
      async getItem(key) {
        try {
          return await Store.getItem(key);
        } catch (error) {
          console.warn(`[kv] kv-store read failed for "${key}":`, error);
          return null;
        }
      },
      async setItem(key, value) {
        try {
          await Store.setItem(key, value);
        } catch (error) {
          console.warn(`[kv] kv-store write failed for "${key}":`, error);
        }
      },
      async removeItem(key) {
        try {
          await Store.removeItem(key);
        } catch (error) {
          console.warn(`[kv] kv-store remove failed for "${key}":`, error);
        }
      },
    };
  } catch (error) {
    warnMemoryFallback(`expo-sqlite/kv-store unavailable: ${String(error)}`);
    return memoryStore;
  }
}

export const kv: KvStore = Platform.OS === 'web' ? createWebStore() : createNativeStore();

/** Storage keys owned by the app. Adding one here keeps them greppable in one place. */
export const KV_KEYS = {
  themePreference: 'aigundem.theme-preference',
} as const;
