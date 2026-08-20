import type { Filter } from '../data/articles';

export type Seg = 'tr' | 'en';

/**
 * Mirrors the prototype's single `state` object, minus `tab`/`view`: navigation is
 * expo-router's job here, so the store keeps only data the screens share.
 */
export type State = {
  filter: Filter;
  saved: Record<string, boolean>;
  read: Record<string, boolean>;
  srcOn: Record<string, boolean>;
  /** Article the detail screen is showing; kept so `seg` resets with it. */
  artId: string;
  seg: Seg;
  sheet: boolean;
  digestTime: string;
  /** Pending pick inside the digest sheet — discarded by Vazgeç. */
  tmpTime: string;
  q: string;
  translate: boolean;
  toast: string;
  /** Bumped on every toast so a new one restarts the 2.2 s timer. */
  toastSeq: number;
};

export type Action =
  | { type: 'setFilter'; filter: Filter }
  | { type: 'toggleSource'; key: string }
  | { type: 'openArticle'; id: string; markRead: boolean }
  | { type: 'toggleSave'; id: string }
  | { type: 'deleteSaved'; id: string }
  | { type: 'setSeg'; seg: Seg }
  | { type: 'setQuery'; q: string }
  | { type: 'clearQuery' }
  | { type: 'toggleTranslate' }
  | { type: 'openSheet' }
  | { type: 'closeSheet' }
  | { type: 'pickTime'; time: string }
  | { type: 'saveTime' }
  | { type: 'toast'; text: string }
  | { type: 'clearToast'; seq: number };

/** Turkish toast copy, verbatim from the prototype. */
export const TOASTS = {
  saved: 'Kaydedildi',
  unsaved: 'Kayıt kaldırıldı',
  deleted: 'Kayıt silindi',
  digestTime: 'Digest saati güncellendi',
  openSource: 'Kaynak tarayıcıda açılır',
  theme: 'Prototipte koyu tema sabit — light tema panoda',
} as const;

export const DIGEST_TIMES = ['07:00', '07:30', '08:00', '08:30', '09:00'] as const;

export const RECENT_QUERIES = ['gpt-5.2', 'türkçe llm', 'alphafold'] as const;
