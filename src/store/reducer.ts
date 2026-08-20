import { ARTICLES, CATEGORIES } from '../data/articles';
import { SOURCES } from '../data/sources';
import { DIGEST_TIMES, TOASTS, type Action, type State } from './types';

/** Initial state, transcribed from the prototype's `state = {...}`. */
export const initialState: State = {
  filter: 'Tümü',
  saved: { gd: true, hf: true },
  read: { oa: true },
  srcOn: { oa: true, an: true, gd: true, hf: true, ax: true, tc: false, wz: true },
  artId: 'gd',
  seg: 'tr',
  sheet: false,
  digestTime: '08:00',
  tmpTime: '08:00',
  q: '',
  translate: true,
  toast: '',
  toastSeq: 0,
};

const knownArticle = (id: string) => ARTICLES.some((a) => a.id === id);
const knownSource = (key: string) => SOURCES.some((s) => s.k === key);

/** Every toast goes through here so the sequence number always advances with it. */
const withToast = (state: State, text: string): State => ({
  ...state,
  toast: text,
  toastSeq: state.toastSeq + 1,
});

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'setFilter': {
      if (!CATEGORIES.includes(action.filter)) {
        console.warn(`[store] setFilter ignored: unknown category "${action.filter}"`);
        return state;
      }
      return { ...state, filter: action.filter };
    }

    case 'toggleSource': {
      if (!knownSource(action.key)) {
        console.warn(`[store] toggleSource ignored: unknown source "${action.key}"`);
        return state;
      }
      return {
        ...state,
        srcOn: { ...state.srcOn, [action.key]: !state.srcOn[action.key] },
      };
    }

    case 'openArticle': {
      if (!knownArticle(action.id)) {
        console.warn(`[store] openArticle ignored: unknown article "${action.id}"`);
        return state;
      }
      return {
        ...state,
        artId: action.id,
        seg: 'tr',
        read: action.markRead ? { ...state.read, [action.id]: true } : state.read,
      };
    }

    case 'toggleSave': {
      if (!knownArticle(action.id)) {
        console.warn(`[store] toggleSave ignored: unknown article "${action.id}"`);
        return state;
      }
      const saved = { ...state.saved };
      if (saved[action.id]) {
        delete saved[action.id];
        return withToast({ ...state, saved }, TOASTS.unsaved);
      }
      saved[action.id] = true;
      return withToast({ ...state, saved }, TOASTS.saved);
    }

    case 'deleteSaved': {
      if (!state.saved[action.id]) {
        console.warn(`[store] deleteSaved ignored: "${action.id}" is not saved`);
        return state;
      }
      const saved = { ...state.saved };
      delete saved[action.id];
      return withToast({ ...state, saved }, TOASTS.deleted);
    }

    case 'setSeg':
      return { ...state, seg: action.seg };

    case 'setQuery':
      return { ...state, q: action.q };

    case 'clearQuery':
      return { ...state, q: '' };

    case 'toggleTranslate':
      return { ...state, translate: !state.translate };

    /** Opening the sheet seeds the pending pick from the committed value. */
    case 'openSheet':
      return { ...state, sheet: true, tmpTime: state.digestTime };

    /** Vazgeç: close without committing `tmpTime`. */
    case 'closeSheet':
      return { ...state, sheet: false };

    case 'pickTime': {
      if (!DIGEST_TIMES.includes(action.time as (typeof DIGEST_TIMES)[number])) {
        console.warn(`[store] pickTime ignored: "${action.time}" is not an offered slot`);
        return state;
      }
      return { ...state, tmpTime: action.time };
    }

    /** Kaydet: commit the pending pick and toast. */
    case 'saveTime':
      return withToast(
        { ...state, sheet: false, digestTime: state.tmpTime },
        TOASTS.digestTime,
      );

    case 'toast':
      return withToast(state, action.text);

    case 'clearToast': {
      if (action.seq !== state.toastSeq) {
        // A newer toast replaced this one; its own timer owns the dismissal.
        console.warn(
          `[store] clearToast ignored: stale sequence ${action.seq}, current ${state.toastSeq}`,
        );
        return state;
      }
      return { ...state, toast: '' };
    }

    default: {
      const never: never = action;
      console.warn('[store] unhandled action', never);
      return state;
    }
  }
}
