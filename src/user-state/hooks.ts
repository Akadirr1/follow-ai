import { useCallback, useEffect, useState } from 'react';

import {
  DEFAULT_SETTINGS,
  getRead,
  getRecentSearches,
  getSaved,
  getSettings,
  getEnabledSourceIds,
  pushRecentSearch,
  setRead,
  setSaved,
  setSourceEnabled,
  updateSettings,
  type ReadEntry,
  type SavedEntry,
  type UserSettings,
} from './store';

/**
 * Hooks over the device-local state. Each one applies the change to React state
 * first and writes to storage after, so the UI never waits on a disk round-trip;
 * a failed write warns inside `kv.ts` rather than silently diverging.
 *
 * These are deliberately not TanStack queries: there is no server, no staleness
 * and nothing to revalidate — modelling local state as server state would add a
 * cache layer over a value that is already the truth.
 */

function useLoaded<T>(load: () => Promise<T>, fallback: T) {
  const [value, setValue] = useState<T>(fallback);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    load().then((loaded) => {
      if (cancelled) return;
      setValue(loaded);
      setIsReady(true);
    });
    return () => {
      cancelled = true;
    };
    // `load` is a stable module function per hook below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [value, setValue, isReady] as const;
}

export function useSavedArticles() {
  const [saved, setSavedState, isReady] = useLoaded<SavedEntry[]>(getSaved, []);

  const setArticleSaved = useCallback(
    (articleId: string, next: boolean) => {
      setSavedState((current) => {
        const without = current.filter((entry) => entry.articleId !== articleId);
        return next ? [{ articleId, savedAt: new Date().toISOString() }, ...without] : without;
      });
      void setSaved(articleId, next);
    },
    [setSavedState],
  );

  return {
    saved,
    isReady,
    setArticleSaved,
    isSaved: useCallback(
      (articleId: string) => saved.some((entry) => entry.articleId === articleId),
      [saved],
    ),
  };
}

export function useReadArticles() {
  const [read, setReadState, isReady] = useLoaded<ReadEntry[]>(getRead, []);

  const markRead = useCallback(
    (articleId: string, next = true) => {
      setReadState((current) => {
        const without = current.filter((entry) => entry.articleId !== articleId);
        return next ? [{ articleId, readAt: new Date().toISOString() }, ...without] : without;
      });
      void setRead(articleId, next);
    },
    [setReadState],
  );

  return {
    read,
    isReady,
    markRead,
    isRead: useCallback(
      (articleId: string) => read.some((entry) => entry.articleId === articleId),
      [read],
    ),
  };
}

export function useEnabledSources() {
  const [enabled, setEnabledState, isReady] = useLoaded<string[] | null>(getEnabledSourceIds, null);

  const setEnabled = useCallback(
    (sourceId: string, next: boolean) => {
      setEnabledState((current) => {
        const list = current ?? [];
        return next ? [...new Set([...list, sourceId])] : list.filter((id) => id !== sourceId);
      });
      void setSourceEnabled(sourceId, next);
    },
    [setEnabledState],
  );

  return { enabledSourceIds: enabled, isReady, setEnabled };
}

export function useUserSettings() {
  const [settings, setSettingsState, isReady] = useLoaded<UserSettings>(
    getSettings,
    DEFAULT_SETTINGS,
  );

  const update = useCallback(
    (patch: Partial<UserSettings>) => {
      setSettingsState((current) => ({ ...current, ...patch }));
      void updateSettings(patch);
    },
    [setSettingsState],
  );

  return { settings, isReady, update };
}

export function useRecentSearches() {
  const [recent, setRecentState, isReady] = useLoaded<string[]>(getRecentSearches, []);

  const push = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (!trimmed) return;
      setRecentState((current) => [
        trimmed,
        ...current.filter((q) => q.toLowerCase() !== trimmed.toLowerCase()),
      ]);
      void pushRecentSearch(trimmed);
    },
    [setRecentState],
  );

  return { recentSearches: recent, isReady, pushRecentSearch: push };
}
