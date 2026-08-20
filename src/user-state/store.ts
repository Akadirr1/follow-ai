import { KV_KEYS, kv, type KvStore } from '../storage/kv';

/**
 * Device-local user state. v1 creates no Supabase users (addendum §A), so
 * everything personal — which sources are on, what is saved or read, the digest
 * hour, recent searches — lives here and is never sent anywhere. There is no
 * server round-trip in this file by design.
 *
 * Values are JSON under `v1:` keys (see `KV_KEYS`). A blob that does not parse,
 * or parses to the wrong shape, is replaced by the default **with a warning**
 * rather than crashing the screen that asked for it.
 */

export type SavedEntry = { articleId: string; savedAt: string };
export type ReadEntry = { articleId: string; readAt: string };

export type UserSettings = {
  autoTranslate: boolean;
  digestTime: string;
  digestEnabled: boolean;
};

export const DEFAULT_SETTINGS: UserSettings = {
  autoTranslate: true,
  digestTime: '08:00',
  digestEnabled: true,
};

export const MAX_RECENT_SEARCHES = 10;

async function readJson<T>(
  storage: KvStore,
  key: string,
  fallback: T,
  validate: (value: unknown) => value is T,
): Promise<T> {
  const raw = await storage.getItem(key);
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!validate(parsed)) {
      console.warn(`[user-state] "${key}" holds an unexpected shape; using the default.`);
      return fallback;
    }
    return parsed;
  } catch (error) {
    console.warn(`[user-state] "${key}" is not valid JSON; using the default:`, error);
    return fallback;
  }
}

const writeJson = (storage: KvStore, key: string, value: unknown): Promise<void> =>
  storage.setItem(key, JSON.stringify(value));

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

const isSavedList = (value: unknown): value is SavedEntry[] =>
  Array.isArray(value) &&
  value.every(
    (v) =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as SavedEntry).articleId === 'string' &&
      typeof (v as SavedEntry).savedAt === 'string',
  );

const isReadList = (value: unknown): value is ReadEntry[] =>
  Array.isArray(value) &&
  value.every(
    (v) =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as ReadEntry).articleId === 'string' &&
      typeof (v as ReadEntry).readAt === 'string',
  );

const isSettings = (value: unknown): value is UserSettings =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as UserSettings).autoTranslate === 'boolean' &&
  typeof (value as UserSettings).digestTime === 'string' &&
  typeof (value as UserSettings).digestEnabled === 'boolean';

/**
 * Enabled sources. `null` means "never chosen" — the caller seeds it from the
 * catalog's defaults on first run, which is the only place a default can be known.
 */
export async function getEnabledSourceIds(storage: KvStore = kv): Promise<string[] | null> {
  const raw = await storage.getItem(KV_KEYS.enabledSourceIds);
  if (raw === null) return null;
  return readJson(storage, KV_KEYS.enabledSourceIds, [], isStringArray);
}

export const setEnabledSourceIds = (ids: string[], storage: KvStore = kv): Promise<void> =>
  writeJson(storage, KV_KEYS.enabledSourceIds, [...new Set(ids)]);

/** First run: adopt the catalog defaults and remember them. */
export async function ensureEnabledSourceIds(
  defaultIds: string[],
  storage: KvStore = kv,
): Promise<string[]> {
  const existing = await getEnabledSourceIds(storage);
  if (existing !== null) return existing;
  await setEnabledSourceIds(defaultIds, storage);
  return [...new Set(defaultIds)];
}

export async function setSourceEnabled(
  sourceId: string,
  enabled: boolean,
  storage: KvStore = kv,
): Promise<string[]> {
  const current = (await getEnabledSourceIds(storage)) ?? [];
  const next = enabled
    ? [...new Set([...current, sourceId])]
    : current.filter((id) => id !== sourceId);
  await setEnabledSourceIds(next, storage);
  return next;
}

export const getSaved = (storage: KvStore = kv): Promise<SavedEntry[]> =>
  readJson(storage, KV_KEYS.savedArticles, [], isSavedList);

/**
 * Idempotent by design: the caller states the desired value rather than toggling,
 * so a retry over a flaky link cannot flip it back (arch-001 §4).
 */
export async function setSaved(
  articleId: string,
  saved: boolean,
  storage: KvStore = kv,
  now: () => string = () => new Date().toISOString(),
): Promise<SavedEntry[]> {
  const current = await getSaved(storage);
  const without = current.filter((entry) => entry.articleId !== articleId);
  const next = saved ? [{ articleId, savedAt: now() }, ...without] : without;
  await writeJson(storage, KV_KEYS.savedArticles, next);
  return next;
}

export const getRead = (storage: KvStore = kv): Promise<ReadEntry[]> =>
  readJson(storage, KV_KEYS.readArticles, [], isReadList);

export async function setRead(
  articleId: string,
  read: boolean,
  storage: KvStore = kv,
  now: () => string = () => new Date().toISOString(),
): Promise<ReadEntry[]> {
  const current = await getRead(storage);
  const without = current.filter((entry) => entry.articleId !== articleId);
  const next = read ? [{ articleId, readAt: now() }, ...without] : without;
  await writeJson(storage, KV_KEYS.readArticles, next);
  return next;
}

export const getSettings = (storage: KvStore = kv): Promise<UserSettings> =>
  readJson(storage, KV_KEYS.settings, DEFAULT_SETTINGS, isSettings);

export async function updateSettings(
  patch: Partial<UserSettings>,
  storage: KvStore = kv,
): Promise<UserSettings> {
  const next = { ...(await getSettings(storage)), ...patch };
  await writeJson(storage, KV_KEYS.settings, next);
  return next;
}

export const getRecentSearches = (storage: KvStore = kv): Promise<string[]> =>
  readJson(storage, KV_KEYS.recentSearches, [], isStringArray);

/** Most recent first, de-duplicated case-insensitively, capped. */
export async function pushRecentSearch(query: string, storage: KvStore = kv): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return getRecentSearches(storage);
  const current = await getRecentSearches(storage);
  const next = [trimmed, ...current.filter((q) => q.toLowerCase() !== trimmed.toLowerCase())].slice(
    0,
    MAX_RECENT_SEARCHES,
  );
  await writeJson(storage, KV_KEYS.recentSearches, next);
  return next;
}

export const clearRecentSearches = (storage: KvStore = kv): Promise<void> =>
  writeJson(storage, KV_KEYS.recentSearches, []);

export async function isOnboardingDone(storage: KvStore = kv): Promise<boolean> {
  return (await storage.getItem(KV_KEYS.onboardingDone)) === 'true';
}

export const setOnboardingDone = (done: boolean, storage: KvStore = kv): Promise<void> =>
  storage.setItem(KV_KEYS.onboardingDone, done ? 'true' : 'false');
