import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { FlatList } from 'react-native';

import { err, ok } from '../domain/errors';
import type { Article, Page } from '../domain/types';
import { resetNavigationGuard } from '../navigation/openArticle';
import { KV_KEYS, kv } from '../storage/kv';
import { setSaved } from '../user-state/store';
import {
  fakeRepositories,
  makeArticle,
  makeSource,
  page,
  renderScreen,
  type FakeRepoOverrides,
} from './harness';

/**
 * Screen tests over fake repositories: each one states what the data layer
 * returns and asserts what the user sees. These carry the behaviour the deleted
 * store tests used to assert (filters, save/read, search, segment rule), now at
 * the level that actually ships.
 */

const mockPushes: string[] = [];
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: (href: string) => mockPushes.push(href),
    back: jest.fn(),
    replace: jest.fn(),
  }),
  useLocalSearchParams: () => ({ id: 'a1' }),
  Stack: () => null,
  Tabs: () => null,
}));

let mockRepos = fakeRepositories();
jest.mock('../data-access/index', () => ({
  ...jest.requireActual('../data-access/index'),
  getRepositories: () => mockRepos,
}));

const mockOpenUrl = jest.fn().mockResolvedValue(true);
jest.mock('expo-linking', () => ({ openURL: (url: string) => mockOpenUrl(url) }));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0', sdkVersion: '54.0.0' } },
}));

const setRepos = (over: FakeRepoOverrides) => {
  mockRepos = fakeRepositories(over);
};

// Imported after the mocks so the screens pick them up.
import FeedScreen from '../../app/(tabs)/index';
import ArticleScreen from '../../app/article/[id]';
import SearchScreen from '../../app/search';
import DigestScreen from '../../app/(tabs)/digest';
import SourcesScreen from '../../app/(tabs)/sources';
import SavedScreen from '../../app/(tabs)/saved';

/**
 * The user-state hooks write through the module-level `kv` singleton (P6 owns
 * them and P7 must not change their signature), so device state is reset here
 * rather than injected.
 */
beforeEach(async () => {
  mockPushes.length = 0;
  mockOpenUrl.mockClear();
  resetNavigationGuard();
  mockRepos = fakeRepositories();
  for (const key of [
    KV_KEYS.savedArticles,
    KV_KEYS.readArticles,
    KV_KEYS.enabledSourceIds,
    KV_KEYS.settings,
    KV_KEYS.recentSearches,
  ]) {
    await kv.removeItem(key);
  }
});

describe('Feed', () => {
  it('shows the loading state, then the articles', async () => {
    let resolve: ((value: unknown) => void) | null = null;
    setRepos({
      listArticles: () =>
        new Promise((r) => {
          resolve = r as (value: unknown) => void;
        }) as Promise<never>,
    });
    renderScreen(<FeedScreen />);
    expect(screen.getByLabelText('Yükleniyor…')).toBeTruthy();

    await act(async () => {
      resolve?.(ok(page([makeArticle({ id: 'oa', title: 'GPT-5.2 tanıtıldı' })])));
    });
    expect(await screen.findByText('GPT-5.2 tanıtıldı')).toBeTruthy();
  });

  it('drops the unseen count once an article has been opened', async () => {
    setRepos({
      listArticles: async () =>
        ok(
          page([
            makeArticle({ id: 'oa', title: 'Birinci haber' }),
            makeArticle({ id: 'an', title: 'İkinci haber' }),
          ]),
        ),
    });
    renderScreen(<FeedScreen />);
    expect(await screen.findByText('Birinci haber')).toBeTruthy();
    expect(screen.getByText('2 yeni')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Birinci haber'));
    });

    // `openArticle` routes *and* marks read; the header is the visible proof that
    // the read set was persisted and re-read, not just that a route fired.
    expect(mockPushes).toContain('/article/oa');
    await waitFor(() => expect(screen.getByText('1 yeni')).toBeTruthy());
    expect(screen.queryByText('2 yeni')).toBeNull();
  });

  it('shows the prototype empty state when the filter matches nothing', async () => {
    setRepos({ listArticles: async () => ok(page([])) });
    renderScreen(<FeedScreen />);
    expect(await screen.findByText('Bu filtrede haber yok')).toBeTruthy();
    expect(screen.getByText('Kategoriyi değiştir veya kaynaklarını kontrol et.')).toBeTruthy();
  });

  it('shows a typed error when there is nothing cached', async () => {
    // A non-retryable code so the hook's retry policy stops immediately: the
    // assertion is about the error copy, not about retry timing.
    setRepos({
      listArticles: async () =>
        err<Page<Article>>('not_implemented', 'not wired', { retryable: false }),
    });
    renderScreen(<FeedScreen />);
    expect(await screen.findByText('Bu özellik henüz hazır değil.')).toBeTruthy();
    // No retry offered for something a retry cannot fix.
    expect(screen.queryByText('Tekrar dene')).toBeNull();
  });

  it('passes the selected category to the repository', async () => {
    const seen: unknown[] = [];
    setRepos({
      listArticles: async (params) => {
        seen.push(params);
        return ok(page([makeArticle()]));
      },
    });
    renderScreen(<FeedScreen />);
    await screen.findByText('GPT-5.2 tanıtıldı');

    await act(async () => {
      fireEvent.press(screen.getByText('Araştırma'));
    });
    await waitFor(() =>
      expect(seen.some((p) => (p as { category?: string })?.category === 'Araştırma')).toBe(true),
    );
  });

  it('walks a second page with the cursor the first page returned', async () => {
    const first = makeArticle({ id: 'p1', title: 'Birinci sayfa' });
    const second = makeArticle({ id: 'p2', title: 'İkinci sayfa' });
    const cursors: unknown[] = [];
    setRepos({
      listArticles: async (params) => {
        const cursor = (params as { cursor?: unknown })?.cursor ?? null;
        cursors.push(cursor);
        return ok(cursor ? page([second]) : page([first], 'p1'));
      },
    });
    renderScreen(<FeedScreen />);
    await screen.findByText('Birinci sayfa');

    await act(async () => {
      fireEvent.press(screen.getByText('Daha fazla'));
    });
    expect(await screen.findByText('İkinci sayfa')).toBeTruthy();
    // The second call carried a cursor rather than starting again from the top.
    expect(cursors[0]).toBeNull();
    expect(cursors[1]).toMatchObject({ id: 'p1' });
  });

  it('one tap pushes one route, and a double tap still pushes one', async () => {
    setRepos({ listArticles: async () => ok(page([makeArticle({ id: 'oa' })])) });
    renderScreen(<FeedScreen />);
    const card = await screen.findByLabelText('GPT-5.2 tanıtıldı');

    await act(async () => {
      fireEvent.press(card);
      fireEvent.press(card);
    });
    expect(mockPushes).toEqual(['/article/oa']);
  });
});

describe('Feed — offline stale', () => {
  it('keeps cached rows on screen and says the data is stale', async () => {
    // The first fetch succeeds and fills the list; the pull-to-refresh fails.
    let call = 0;
    setRepos({
      listArticles: async () => {
        call += 1;
        return call === 1
          ? ok(page([makeArticle({ id: 'oa', title: 'Önbellekteki haber' })]))
          // retryable:false so the hook's retry policy settles the query at once;
          // the banner condition under test is isError + cached rows, not retries.
          : err<Page<Article>>('network', 'offline', { retryable: false });
      },
    });
    const view = renderScreen(<FeedScreen />);
    await screen.findByText('Önbellekteki haber');

    const list = view.UNSAFE_getByType(FlatList);
    await act(async () => {
      await (list.props.refreshControl as { props: { onRefresh: () => void } }).props.onRefresh();
    });

    // Stale rows stay visible, and the staleness is stated rather than silent.
    expect(screen.getByText('Önbellekteki haber')).toBeTruthy();
    expect(await screen.findByText(/Çevrimdışı/)).toBeTruthy();
    expect(call).toBeGreaterThan(1);
  });
});

describe('Article', () => {
  it('renders the three summary bullets when the summary is ready', async () => {
    setRepos({ getArticle: async () => ok(makeArticle({ id: 'a1' })) });
    renderScreen(<ArticleScreen />);
    expect(await screen.findByText('bir')).toBeTruthy();
    expect(screen.getByText('AI TR ÖZET')).toBeTruthy();
    expect(screen.getByText('3 madde')).toBeTruthy();
  });

  it('shows "Özet hazırlanıyor" while the summary is pending, body still readable', async () => {
    setRepos({
      getArticle: async () =>
        ok(
          makeArticle({
            id: 'a1',
            summary: { bullets: ['', '', ''], translationTr: null, translationState: 'pending' },
          }),
        ),
      requestEnrichment: async () => ok({ status: 'queued', reason: 'no_api_key' }),
    });
    renderScreen(<ArticleScreen />);
    expect(await screen.findByText('Özet hazırlanıyor')).toBeTruthy();
    // addendum §E: the article itself stays readable.
    expect(screen.getByText('OpenAI announced GPT-5.2…')).toBeTruthy();
  });

  it('says the summary cannot be produced when the server answers unavailable', async () => {
    // fix-005: an excerpt-only article. The server has already looked; waiting
    // changes nothing, so the card must not spin.
    setRepos({
      getArticle: async () =>
        ok(makeArticle({ id: 'a1', bodyOriginal: '', summary: undefined })),
      requestEnrichment: async () => ok({ status: 'unavailable', reason: 'no_content' }),
    });
    renderScreen(<ArticleScreen />);

    expect(
      await screen.findByText('Bu haber için özet üretilemiyor; kaynağa git.'),
    ).toBeTruthy();
    expect(screen.queryByText('Özet hazırlanıyor')).toBeNull();
    // No bullet count and no Claude credit: there is nothing to count or credit.
    expect(screen.queryByText('3 madde')).toBeNull();
    expect(screen.queryByText('Claude ile çevrildi ve özetlendi')).toBeNull();

    // The action the copy points at still works.
    await act(async () => {
      fireEvent.press(screen.getByText('Kaynağa git '));
    });
    expect(mockOpenUrl).toHaveBeenCalledWith('https://openai.com/news/gpt-5-2');
  });

  it('prefers a summary the feed row already carried over a later unavailable', async () => {
    setRepos({
      getArticle: async () => ok(makeArticle({ id: 'a1' })),
      requestEnrichment: async () => ok({ status: 'unavailable', reason: 'no_content' }),
    });
    renderScreen(<ArticleScreen />);
    expect(await screen.findByText('bir')).toBeTruthy();
    expect(screen.queryByText('Bu haber için özet üretilemiyor; kaynağa git.')).toBeNull();
  });

  it('hides the Orijinal/Çeviri segment for a Turkish source', async () => {
    setRepos({
      getArticle: async () =>
        ok(
          makeArticle({
            id: 'a1',
            language: 'tr',
            sourceName: 'Webrazzi',
            bodyOriginal: 'TÜBİTAK destekli konsorsiyum…',
            summary: {
              bullets: ['bir', 'iki', 'üç'],
              translationTr: null,
              translationState: 'not_required',
            },
          }),
        ),
    });
    renderScreen(<ArticleScreen />);
    await screen.findByText('bir');
    expect(screen.queryByText('Orijinal')).toBeNull();
    expect(screen.queryByText('Çeviri')).toBeNull();
    expect(screen.queryByText('EN→TR')).toBeNull();
  });

  it('shows the segment for an English source and switches the body', async () => {
    setRepos({ getArticle: async () => ok(makeArticle({ id: 'a1' })) });
    renderScreen(<ArticleScreen />);
    await screen.findByText('bir');

    expect(screen.getByText('Çeviri · Türkçe')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('Orijinal'));
    });
    expect(screen.getByText('Orijinal · English')).toBeTruthy();
    expect(screen.getByText('OpenAI announced GPT-5.2…')).toBeTruthy();
  });

  it('opens the canonical URL instead of toasting', async () => {
    setRepos({ getArticle: async () => ok(makeArticle({ id: 'a1' })) });
    renderScreen(<ArticleScreen />);
    await screen.findByText('bir');

    await act(async () => {
      fireEvent.press(screen.getByText('Kaynağa git '));
    });
    expect(mockOpenUrl).toHaveBeenCalledWith('https://openai.com/news/gpt-5-2');
    expect(screen.queryByText('Kaynak tarayıcıda açılır')).toBeNull();
  });

  it('saves the article, toasts, and flips the bookmark control', async () => {
    setRepos({ getArticle: async () => ok(makeArticle({ id: 'a1' })) });
    renderScreen(<ArticleScreen />);
    await screen.findByText('bir');

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Kaydet'));
    });
    expect(await screen.findByText('Kaydedildi')).toBeTruthy();
    // The control now offers the opposite action, which is the user-visible
    // proof that the save landed.
    expect(await screen.findByLabelText('Kaydı kaldır')).toBeTruthy();
  });
});

describe('Search', () => {
  it('finds the OpenAI article by acronym after the debounce', async () => {
    setRepos({
      searchArticles: async ({ query }) =>
        ok(
          query.trim().toLowerCase() === 'openai' || query.trim().toLowerCase() === 'ai'
            ? page([makeArticle({ id: 'oa', sourceName: 'OpenAI Blog', title: 'GPT-5.2 tanıtıldı' })])
            : page([]),
        ),
    });
    renderScreen(<SearchScreen />);
    fireEvent.changeText(screen.getByLabelText('AI gündeminde ara'), 'openai');
    expect(await screen.findByText('GPT-5.2 tanıtıldı', {}, { timeout: 3000 })).toBeTruthy();
  });

  it('shows the no-result state with the prototype copy', async () => {
    setRepos({ searchArticles: async () => ok(page([])) });
    renderScreen(<SearchScreen />);
    fireEvent.changeText(screen.getByLabelText('AI gündeminde ara'), 'zzzz');
    expect(await screen.findByText('Sonuç bulunamadı', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText('Farklı bir anahtar kelime dene.')).toBeTruthy();
  });

  it('shows the recent-search prompt with an empty query', () => {
    renderScreen(<SearchScreen />);
    expect(screen.getByText('SON ARAMALAR')).toBeTruthy();
    expect(screen.getByText('Aramak için yaz — başlık, kaynak veya kategori.')).toBeTruthy();
  });
});

describe('Digest', () => {
  it('shows the preparing state when no digest is ready', async () => {
    setRepos({ getLatestDigest: async () => ok({ status: 'preparing' }) });
    renderScreen(<DigestScreen />);
    expect(await screen.findByText('Digest hazırlanıyor')).toBeTruthy();
  });

  it('renders a ready digest with its items', async () => {
    setRepos({
      getLatestDigest: async () =>
        ok({
          status: 'ready',
          digest: {
            id: 'd1',
            date: '2026-08-20',
            preparedAt: '2026-08-20T03:50:00.000Z',
            items: [
              {
                position: 1,
                articleId: 'oa',
                title: 'GPT-5.2 tanıtıldı',
                blurb: 'API fiyatı yarıya indi.',
                sourceName: 'OpenAI Blog',
                category: 'Modeller',
              },
            ],
          },
        }),
    });
    renderScreen(<DigestScreen />);
    expect(await screen.findByText('Bugünün AI Gündemi')).toBeTruthy();
    expect(screen.getByText('20 AĞUSTOS 2026 · PERŞEMBE')).toBeTruthy();
    expect(screen.getByText('GPT-5.2 tanıtıldı')).toBeTruthy();
    expect(screen.getByText('1 haber · ~3 dk')).toBeTruthy();
  });
});

describe('Sources', () => {
  it('lists the catalog and reflects a toggle in the active count', async () => {
    setRepos({
      listSources: async () =>
        ok([
          makeSource({ id: 's1', name: 'OpenAI Blog' }),
          makeSource({ id: 's2', name: 'Webrazzi AI', tile: 'WZ', language: 'tr' }),
        ]),
    });
    renderScreen(<SourcesScreen />);
    expect(await screen.findByText('OpenAI Blog')).toBeTruthy();
    expect(screen.getByText('2 aktif')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByLabelText('OpenAI Blog'));
    });
    expect(await screen.findByText('1 aktif')).toBeTruthy();
  });

  it('opens the add-source sheet and shows the typed error in Turkish', async () => {
    setRepos({
      listSources: async () => ok([makeSource()]),
      addSourceByUrl: async () => err('duplicate_source', 'already there'),
    });
    renderScreen(<SourcesScreen />);
    await screen.findByText('OpenAI Blog');

    await act(async () => {
      fireEvent.press(screen.getByText('Yeni kaynak ekle (RSS / URL)'));
    });
    fireEvent.changeText(screen.getByLabelText('Kaynak adresi'), 'https://example.com/feed.xml');
    await act(async () => {
      fireEvent.press(screen.getByText('Ekle'));
    });
    expect(await screen.findByText('Bu kaynak zaten ekli.')).toBeTruthy();
  });

  it('sends the picked category and language to the repository', async () => {
    const calls: unknown[] = [];
    setRepos({
      listSources: async () => ok([makeSource()]),
      addSourceByUrl: async (url, options) => {
        calls.push({ url, options });
        return ok(makeSource({ id: 'new' }));
      },
    });
    renderScreen(<SourcesScreen />);
    await screen.findByText('OpenAI Blog');

    await act(async () => {
      fireEvent.press(screen.getByText('Yeni kaynak ekle (RSS / URL)'));
    });
    fireEvent.changeText(screen.getByLabelText('Kaynak adresi'), 'https://example.com/feed.xml');
    await act(async () => {
      fireEvent.press(screen.getByText('Türkiye'));
      fireEvent.press(screen.getByText('Türkçe'));
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Ekle'));
    });
    expect(calls[0]).toEqual({
      url: 'https://example.com/feed.xml',
      options: { category: 'Türkiye', language: 'tr' },
    });
  });
});

describe('Saved', () => {
  it('is empty with the prototype copy when nothing is saved', async () => {
    setRepos({ listArticles: async () => ok(page([makeArticle({ id: 'oa' })])) });
    renderScreen(<SavedScreen />);
    expect(await screen.findByText('Kaydedilen haber yok')).toBeTruthy();
    expect(screen.getByText('Detaydaki bookmark simgesine dokunarak kaydet.')).toBeTruthy();
  });

  it('lists a saved article and removes it with a toast', async () => {
    await setSaved('oa', true);
    setRepos({
      listArticles: async () => ok(page([makeArticle({ id: 'oa', title: 'Kaydedilmiş haber' })])),
    });
    renderScreen(<SavedScreen />);
    expect(await screen.findByText('Kaydedilmiş haber')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByLabelText('OpenAI Blog kaydını sil'));
    });
    expect(await screen.findByText('Kayıt silindi')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Kaydedilmiş haber')).toBeNull());
  });
});
