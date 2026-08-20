import { ARTICLES } from '../../data/articles';
import { initialState, reducer } from '../reducer';
import {
  selectActiveSourceCount,
  selectArticle,
  selectBody,
  selectFeed,
  selectResults,
  selectSaved,
  selectUnreadSavedCount,
} from '../selectors';
import { TOASTS, type Action, type State } from '../types';

/** Fold a list of actions over the initial state. */
const run = (...actions: Action[]): State =>
  actions.reduce<State>((s, a) => reducer(s, a), initialState);

const ids = (list: { id: string }[]) => list.map((a) => a.id);

describe('initial state', () => {
  it('matches the prototype', () => {
    expect(initialState.filter).toBe('Tümü');
    expect(initialState.saved).toEqual({ gd: true, hf: true });
    expect(initialState.read).toEqual({ oa: true });
    expect(initialState.srcOn.tc).toBe(false);
    expect(initialState.digestTime).toBe('08:00');
    expect(initialState.translate).toBe(true);
    expect(ARTICLES).toHaveLength(5);
  });
});

describe('category filter', () => {
  it('Tümü shows every article whose source is on', () => {
    expect(ids(selectFeed(initialState))).toEqual(['oa', 'an', 'gd', 'hf', 'wz']);
  });

  it('narrows the feed to the picked category', () => {
    const state = run({ type: 'setFilter', filter: 'Araştırma' });
    expect(ids(selectFeed(state))).toEqual(['gd']);
  });

  it('leaves the feed empty when nothing matches', () => {
    const state = run(
      { type: 'setFilter', filter: 'Türkiye' },
      { type: 'toggleSource', key: 'wz' },
    );
    expect(selectFeed(state)).toHaveLength(0);
  });
});

describe('source toggles', () => {
  it('removes the source\'s article from the feed and updates the active count', () => {
    expect(selectActiveSourceCount(initialState)).toBe(6);
    const state = run({ type: 'toggleSource', key: 'oa' });
    expect(ids(selectFeed(state))).toEqual(['an', 'gd', 'hf', 'wz']);
    expect(selectActiveSourceCount(state)).toBe(5);
  });

  it('combines with the category chip', () => {
    const state = run(
      { type: 'setFilter', filter: 'Modeller' },
      { type: 'toggleSource', key: 'oa' },
    );
    expect(selectFeed(state)).toHaveLength(0);
  });

  it('turning a source back on restores it', () => {
    const state = run(
      { type: 'toggleSource', key: 'tc' },
      { type: 'toggleSource', key: 'tc' },
    );
    expect(state.srcOn.tc).toBe(false);
    expect(selectActiveSourceCount(state)).toBe(6);
  });
});

describe('save and unsave', () => {
  it('saves with the Kaydedildi toast', () => {
    const state = run({ type: 'toggleSave', id: 'oa' });
    expect(state.saved.oa).toBe(true);
    expect(state.toast).toBe(TOASTS.saved);
    expect(ids(selectSaved(state))).toEqual(['oa', 'gd', 'hf']);
  });

  it('unsaves with the Kayıt kaldırıldı toast', () => {
    const state = run({ type: 'toggleSave', id: 'gd' });
    expect(state.saved.gd).toBeUndefined();
    expect(state.toast).toBe(TOASTS.unsaved);
    expect(ids(selectSaved(state))).toEqual(['hf']);
  });
});

describe('delete from saved', () => {
  it('drops the article and toasts Kayıt silindi', () => {
    const state = run({ type: 'deleteSaved', id: 'hf' });
    expect(ids(selectSaved(state))).toEqual(['gd']);
    expect(state.toast).toBe(TOASTS.deleted);
  });

  it('counts unread saved items', () => {
    expect(selectUnreadSavedCount(initialState)).toBe(2);
    const state = run({ type: 'openArticle', id: 'gd', markRead: true });
    expect(selectUnreadSavedCount(state)).toBe(1);
  });
});

describe('mark read on open', () => {
  it('marks the article read when opened from the feed or saved list', () => {
    const state = run({ type: 'openArticle', id: 'an', markRead: true });
    expect(state.read.an).toBe(true);
    expect(state.artId).toBe('an');
    expect(state.seg).toBe('tr');
  });

  it('does not mark read when opened from search, as in the prototype', () => {
    const state = run({ type: 'openArticle', id: 'an', markRead: false });
    expect(state.read.an).toBeUndefined();
    expect(state.artId).toBe('an');
  });

  it('resets the body segment back to Çeviri on every open', () => {
    const state = run(
      { type: 'setSeg', seg: 'en' },
      { type: 'openArticle', id: 'wz', markRead: true },
    );
    expect(state.seg).toBe('tr');
    expect(selectBody(selectArticle('wz'), state.seg).label).toBe('Çeviri · Türkçe');
    expect(selectBody(selectArticle('wz'), 'en').label).toBe('Orijinal · English');
  });
});

describe('search matching', () => {
  it('is empty until something is typed', () => {
    expect(selectResults(initialState)).toHaveLength(0);
  });

  it('matches on title, case-insensitively', () => {
    expect(ids(selectResults(run({ type: 'setQuery', q: 'ALPHAFOLD' })))).toEqual(['gd']);
  });

  it('matches on source name', () => {
    expect(ids(selectResults(run({ type: 'setQuery', q: 'hugging face' })))).toEqual(['hf']);
  });

  // rev-001 B1: Turkish-locale folding turned "OpenAI Blog" into "openaı blog",
  // so these two lowercase ASCII queries missed the article entirely.
  it('matches an ASCII acronym source name: openai returns exactly oa', () => {
    expect(ids(selectResults(run({ type: 'setQuery', q: 'openai' })))).toEqual(['oa']);
  });

  it('matches the bare query ai, which must include oa', () => {
    expect(ids(selectResults(run({ type: 'setQuery', q: 'ai' })))).toContain('oa');
  });

  it('matches on category', () => {
    expect(ids(selectResults(run({ type: 'setQuery', q: 'türkiye' })))).toEqual(['wz']);
  });

  it('returns nothing for an unmatched query', () => {
    expect(selectResults(run({ type: 'setQuery', q: 'zzzz' }))).toHaveLength(0);
  });

  it('clears back to the recent-queries state', () => {
    const state = run({ type: 'setQuery', q: 'gpt-5.2' }, { type: 'clearQuery' });
    expect(state.q).toBe('');
    expect(selectResults(state)).toHaveLength(0);
  });
});

describe('digest time sheet', () => {
  it('Kaydet commits the pending pick and toasts', () => {
    const state = run(
      { type: 'openSheet' },
      { type: 'pickTime', time: '09:00' },
      { type: 'saveTime' },
    );
    expect(state.digestTime).toBe('09:00');
    expect(state.sheet).toBe(false);
    expect(state.toast).toBe(TOASTS.digestTime);
  });

  it('Vazgeç discards the pending pick', () => {
    const state = run(
      { type: 'openSheet' },
      { type: 'pickTime', time: '07:00' },
      { type: 'closeSheet' },
    );
    expect(state.digestTime).toBe('08:00');
    expect(state.sheet).toBe(false);
    expect(state.toast).toBe('');
  });

  it('reopening reseeds the pending pick from the committed value', () => {
    const state = run(
      { type: 'openSheet' },
      { type: 'pickTime', time: '07:30' },
      { type: 'closeSheet' },
      { type: 'openSheet' },
    );
    expect(state.tmpTime).toBe('08:00');
  });
});

describe('translate toggle', () => {
  it('flips the setting', () => {
    expect(run({ type: 'toggleTranslate' }).translate).toBe(false);
  });
});

describe('toasts', () => {
  it('carries the prototype copy for source and theme taps', () => {
    expect(run({ type: 'toast', text: TOASTS.openSource }).toast).toBe(
      'Kaynak tarayıcıda açılır',
    );
    expect(run({ type: 'toast', text: TOASTS.theme }).toast).toBe(
      'Prototipte koyu tema sabit — light tema panoda',
    );
  });

  it('only clears the toast the timer was started for, and warns when it swallows a stale one', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = run({ type: 'toast', text: TOASTS.saved });
      const second = reducer(first, { type: 'toast', text: TOASTS.deleted });
      const stale = reducer(second, { type: 'clearToast', seq: first.toastSeq });
      expect(stale.toast).toBe(TOASTS.deleted);
      // rev-001 B2: the swallowed transition must be visible in diagnostics.
      expect(warn).toHaveBeenCalledWith(
        `[store] clearToast ignored: stale sequence ${first.toastSeq}, current ${second.toastSeq}`,
      );

      warn.mockClear();
      expect(reducer(second, { type: 'clearToast', seq: second.toastSeq }).toast).toBe('');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('negative cases warn instead of failing silently', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('openArticle with an unknown id warns and does not throw or change state', () => {
    let next: State | undefined;
    expect(() => {
      next = reducer(initialState, { type: 'openArticle', id: 'nope', markRead: true });
    }).not.toThrow();
    expect(next).toBe(initialState);
    expect(warn).toHaveBeenCalledWith(
      '[store] openArticle ignored: unknown article "nope"',
    );
  });

  it('toggleSave with an unknown id warns and leaves the saved set alone', () => {
    const next = reducer(initialState, { type: 'toggleSave', id: 'nope' });
    expect(next.saved).toEqual(initialState.saved);
    expect(warn).toHaveBeenCalled();
  });

  it('deleteSaved for an article that is not saved warns', () => {
    const next = reducer(initialState, { type: 'deleteSaved', id: 'oa' });
    expect(next).toBe(initialState);
    expect(warn).toHaveBeenCalledWith('[store] deleteSaved ignored: "oa" is not saved');
  });

  it('toggleSource with an unknown key warns', () => {
    const next = reducer(initialState, { type: 'toggleSource', key: 'nope' });
    expect(next).toBe(initialState);
    expect(warn).toHaveBeenCalled();
  });

  // ver-001: this guard existed but nothing exercised it. The cast is deliberate —
  // TypeScript rejects an unknown category, so only an untyped caller (a bad deep
  // link, JS interop) can reach the guard at runtime.
  it('setFilter with an unknown category warns and keeps the current filter', () => {
    const next = reducer(initialState, {
      type: 'setFilter',
      filter: 'Bilim',
    } as unknown as Action);
    expect(next).toBe(initialState);
    expect(next.filter).toBe('Tümü');
    expect(warn).toHaveBeenCalledWith(
      '[store] setFilter ignored: unknown category "Bilim"',
    );
  });

  it('pickTime outside the offered slots warns', () => {
    const next = reducer(initialState, { type: 'pickTime', time: '23:45' });
    expect(next.tmpTime).toBe('08:00');
    expect(warn).toHaveBeenCalled();
  });

  it('selectArticle warns and falls back for an unknown id', () => {
    expect(selectArticle('nope').id).toBe('gd');
    expect(warn).toHaveBeenCalled();
  });
});
