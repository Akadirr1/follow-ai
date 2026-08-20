import { KV_KEYS, type KvStore } from '../../storage/kv';
import {
  DEFAULT_SETTINGS,
  MAX_RECENT_SEARCHES,
  clearRecentSearches,
  ensureEnabledSourceIds,
  getEnabledSourceIds,
  getRead,
  getRecentSearches,
  getSaved,
  getSettings,
  isOnboardingDone,
  pushRecentSearch,
  setOnboardingDone,
  setRead,
  setSaved,
  setSourceEnabled,
  updateSettings,
} from '../store';

/**
 * Device-local user state. Everything here is storage round-trips: there is no
 * server involved by design (addendum §A), so the tests assert exactly what lands
 * in the kv store and what comes back out of a corrupted one.
 */

function fakeKv(initial: Record<string, string> = {}): KvStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
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

describe('enabled sources', () => {
  it('reports null before a first run rather than an empty list', async () => {
    expect(await getEnabledSourceIds(fakeKv())).toBeNull();
  });

  it('adopts the catalog defaults on first run and remembers them', async () => {
    const storage = fakeKv();
    const first = await ensureEnabledSourceIds(['a', 'b'], storage);
    expect(first).toEqual(['a', 'b']);
    expect(JSON.parse(storage.data.get(KV_KEYS.enabledSourceIds) as string)).toEqual(['a', 'b']);

    // Second run must not re-adopt defaults over the user's own choice.
    await setSourceEnabled('a', false, storage);
    expect(await ensureEnabledSourceIds(['a', 'b'], storage)).toEqual(['b']);
  });

  it('toggles one source without disturbing the others', async () => {
    const storage = fakeKv();
    await ensureEnabledSourceIds(['a', 'b', 'c'], storage);
    expect(await setSourceEnabled('b', false, storage)).toEqual(['a', 'c']);
    expect(await setSourceEnabled('b', true, storage)).toEqual(['a', 'c', 'b']);
  });

  it('is idempotent: enabling twice does not duplicate', async () => {
    const storage = fakeKv();
    await setSourceEnabled('a', true, storage);
    expect(await setSourceEnabled('a', true, storage)).toEqual(['a']);
  });
});

describe('saved and read articles', () => {
  const now = () => '2026-08-21T00:00:00.000Z';

  it('saves with a timestamp, most recent first', async () => {
    const storage = fakeKv();
    await setSaved('a1', true, storage, now);
    const saved = await setSaved('a2', true, storage, now);
    expect(saved.map((entry) => entry.articleId)).toEqual(['a2', 'a1']);
    expect(saved[0].savedAt).toBe(now());
  });

  it('unsaves by desired value, not by toggle, so a retry is safe', async () => {
    const storage = fakeKv();
    await setSaved('a1', true, storage, now);
    expect(await setSaved('a1', false, storage, now)).toEqual([]);
    expect(await setSaved('a1', false, storage, now)).toEqual([]);
  });

  it('marks read and round-trips through storage', async () => {
    const storage = fakeKv();
    await setRead('a1', true, storage, now);
    expect((await getRead(storage)).map((entry) => entry.articleId)).toEqual(['a1']);
    await setRead('a1', false, storage, now);
    expect(await getRead(storage)).toEqual([]);
  });

  it('returns the default and warns when the blob is not JSON', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = fakeKv({ [KV_KEYS.savedArticles]: '{not json' });
      expect(await getSaved(storage)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('returns the default and warns when the blob is the wrong shape', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = fakeKv({ [KV_KEYS.readArticles]: '[{"nope":1}]' });
      expect(await getRead(storage)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unexpected shape'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('settings', () => {
  it('starts at the prototype defaults', async () => {
    expect(await getSettings(fakeKv())).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.digestTime).toBe('08:00');
    expect(DEFAULT_SETTINGS.autoTranslate).toBe(true);
  });

  it('patches one field and leaves the rest alone', async () => {
    const storage = fakeKv();
    const next = await updateSettings({ digestTime: '09:00' }, storage);
    expect(next).toEqual({ ...DEFAULT_SETTINGS, digestTime: '09:00' });
    expect(await getSettings(storage)).toEqual(next);
  });
});

describe('recent searches', () => {
  it('keeps the newest first and de-duplicates case-insensitively', async () => {
    const storage = fakeKv();
    await pushRecentSearch('openai', storage);
    await pushRecentSearch('türkçe llm', storage);
    expect(await pushRecentSearch('OpenAI', storage)).toEqual(['OpenAI', 'türkçe llm']);
  });

  it('ignores a blank query', async () => {
    const storage = fakeKv();
    expect(await pushRecentSearch('   ', storage)).toEqual([]);
  });

  it(`caps the list at ${MAX_RECENT_SEARCHES}`, async () => {
    const storage = fakeKv();
    for (let i = 0; i < MAX_RECENT_SEARCHES + 5; i += 1) {
      await pushRecentSearch(`q${i}`, storage);
    }
    const recent = await getRecentSearches(storage);
    expect(recent).toHaveLength(MAX_RECENT_SEARCHES);
    expect(recent[0]).toBe(`q${MAX_RECENT_SEARCHES + 4}`);
  });

  it('clears', async () => {
    const storage = fakeKv();
    await pushRecentSearch('x', storage);
    await clearRecentSearches(storage);
    expect(await getRecentSearches(storage)).toEqual([]);
  });
});

describe('onboarding flag', () => {
  it('defaults to false and round-trips', async () => {
    const storage = fakeKv();
    expect(await isOnboardingDone(storage)).toBe(false);
    await setOnboardingDone(true, storage);
    expect(await isOnboardingDone(storage)).toBe(true);
  });
});

describe('key schema', () => {
  it('versions every key P6 owns, so a shape change can be ignored rather than mis-parsed', () => {
    for (const key of [
      KV_KEYS.deviceId,
      KV_KEYS.enabledSourceIds,
      KV_KEYS.savedArticles,
      KV_KEYS.readArticles,
      KV_KEYS.settings,
      KV_KEYS.recentSearches,
      KV_KEYS.onboardingDone,
      KV_KEYS.queryCache,
    ]) {
      expect(key.startsWith('v1:')).toBe(true);
    }
  });
});
