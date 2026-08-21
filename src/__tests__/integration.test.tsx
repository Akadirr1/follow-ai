import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createClient } from '@supabase/supabase-js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';
import { FlatList } from 'react-native';

import { addSourceErrorTr } from '../components/AddSourceSheet';
import { ToastProvider } from '../components/ToastProvider';
import { createMockRepositories } from '../data-access/mock';
import { REPOSITORY_CONTRACT_VERSION, type Repositories } from '../data-access/repositories';
import {
  createSupabaseDigestRepository,
  createSupabaseEnrichmentRepository,
  createSupabaseFeedRepository,
  createSupabaseSourceRepository,
} from '../data-access/supabase/repositories';
import { clientRequestId } from '../data-access/supabase/edge';
import { defaultDataModeFor, resolveEnv } from '../config/env';
import { KV_KEYS, createNativeStore, kv } from '../storage/kv';
import { QueryProvider } from '../providers/QueryProvider';
import { ThemeProvider } from '../theme/ThemeProvider';
import { createNotificationService } from '../notifications/NotificationService';
import { completeOnboarding, isOnboardingComplete } from '../user-state/onboarding';
import { fakeKv } from './harness';

/**
 * P10 integration gate — the layers wired together.
 *
 * Every other suite fakes at the repository boundary. These tests fake one level
 * **lower**: the supabase-mode cases build a real `@supabase/supabase-js` client
 * whose `fetch` is a stub PostgREST, so a request travels screen → hook →
 * repository → query builder → HTTP and the assertions can read the URL that
 * was actually produced. That is the seam nothing else covers: a wrong table
 * name, a dropped filter or a broken keyset would pass every other test in the
 * repo and fail here.
 */

/** The server's validator, copied from `supabase/functions/_shared/rate-limit.ts`. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SUPABASE_URL = 'https://project.supabase.co';
const ANON_KEY = 'anon.jwt.for.tests';

const mockPushes: string[] = [];
jest.mock('expo-router', () => {
  const Stack = () => null;
  Stack.Screen = () => null;
  Stack.Protected = () => null;
  return {
    useRouter: () => ({
      push: (href: string) => mockPushes.push(href),
      replace: (href: string) => mockPushes.push(`replace:${href}`),
      back: jest.fn(),
    }),
    useLocalSearchParams: () => ({ id: 'article-1' }),
    Stack,
  };
});

let mockRepos: Repositories = createMockRepositories();
jest.mock('../data-access/index', () => ({
  ...jest.requireActual('../data-access/index'),
  getRepositories: () => mockRepos,
}));

jest.mock('expo-linking', () => ({ openURL: jest.fn().mockResolvedValue(true) }));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0', sdkVersion: '54.0.0' } },
}));
jest.mock('../notifications/useNotificationDeepLink', () => ({
  useNotificationDeepLink: () => undefined,
}));

import FeedScreen from '../../app/(tabs)/index';
import ArticleScreen from '../../app/article/[id]';
import SearchScreen from '../../app/search';

/** One row of `public.aigundem_feed_articles_v1`, as PostgREST would return it. */
const feedRow = (over: Record<string, unknown> = {}) => ({
  article_id: 'article-1',
  source_id: 'source-1',
  source_slug: 'openai-blog',
  source_name: 'OpenAI Blog',
  source_site_url: 'https://openai.com/news',
  category: 'Modeller',
  title: 'GPT-5.2 tanıtıldı',
  canonical_url: 'https://openai.com/news/gpt-5-2',
  published_at: '2026-08-21T06:00:00.000Z',
  language: 'en',
  excerpt: 'excerpt',
  content_text: 'OpenAI announced GPT-5.2…',
  summary_tr: ['bir', 'iki', 'üç'],
  translation_tr: 'OpenAI, GPT-5.2 ile…',
  translation_state: 'ready',
  summary_ready: true,
  ...over,
});

type Recorded = { url: string; method: string; body: string | null };

/**
 * A stub PostgREST/Edge endpoint. `handler` receives the request the real
 * supabase-js client produced, so tests assert on the URL rather than on a
 * builder call we faked ourselves.
 */
function stubNetwork(handler: (request: Recorded) => { status?: number; body: unknown }) {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? String(init.body) : null,
    };
    requests.push(request);
    const { status = 200, body } = handler(request);
    const text = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map([['content-type', 'application/json']]),
      text: async () => text,
      json: async () => JSON.parse(text),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

/** The real repositories, over a real supabase-js client, over a stub network. */
function supabaseRepositories(fetchImpl: typeof fetch): Repositories {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchImpl },
  });
  return {
    version: REPOSITORY_CONTRACT_VERSION,
    mode: 'supabase',
    feed: createSupabaseFeedRepository(client),
    sources: createSupabaseSourceRepository(client, {
      fetchImpl,
      config: { supabaseUrl: SUPABASE_URL, supabaseAnonKey: ANON_KEY },
    }),
    digest: createSupabaseDigestRepository(client),
    enrichment: createSupabaseEnrichmentRepository({
      fetchImpl,
      config: { supabaseUrl: SUPABASE_URL, supabaseAnonKey: ANON_KEY },
    }),
  };
}

let queryClient: QueryClient;

function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider storage={fakeKv()}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

const renderApp = (ui: React.ReactElement) =>
  render(ui, { wrapper: ({ children }) => <Providers>{children}</Providers> });

beforeEach(async () => {
  mockPushes.length = 0;
  mockRepos = createMockRepositories();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: 0, staleTime: 0 } },
  });
  for (const key of Object.values(KV_KEYS)) await kv.removeItem(key);
  await kv.removeItem('v1:aigundem.user.onboarding_completed_at');
});

afterEach(() => queryClient.clear());

describe('supabase mode: screen → hook → repository → PostgREST', () => {
  it('renders the feed from a PostgREST response, and asks for the right view', async () => {
    const net = stubNetwork(() => ({ body: [feedRow()] }));
    mockRepos = supabaseRepositories(net.fetchImpl);

    renderApp(<FeedScreen />);
    expect(await screen.findByText('GPT-5.2 tanıtıldı')).toBeTruthy();
    // The DTO mapping ran end to end: the ISO instant became a Turkish label.
    expect(screen.getByText(/saat önce|dün|az önce|\d+ dakika önce/)).toBeTruthy();

    const request = net.requests.at(-1);
    expect(request?.url).toContain('/rest/v1/aigundem_feed_articles_v1');
    expect(decodeURIComponent(request?.url ?? '')).toContain('order=published_at.desc');
    expect(decodeURIComponent(request?.url ?? '')).toContain('article_id.desc');
    // limit + 1: how `hasMore` is known without a count query.
    expect(request?.url).toContain('limit=21');
  });

  it('carries the category filter into the query string', async () => {
    const net = stubNetwork(() => ({ body: [] }));
    mockRepos = supabaseRepositories(net.fetchImpl);

    renderApp(<FeedScreen />);
    await screen.findByText('Bu filtrede haber yok');

    await act(async () => {
      fireEvent.press(screen.getByText('Araştırma'));
    });
    await waitFor(() =>
      expect(
        net.requests.some((r) => decodeURIComponent(r.url).includes('category=eq.Araştırma')),
      ).toBe(true),
    );
  });

  it('pages with a keyset cursor rather than an offset', async () => {
    // `hasMore` is "the view returned limit + 1 rows", so a full page is needed
    // for the load-more control to appear at all.
    const firstPage = Array.from({ length: 21 }, (_, i) =>
      feedRow({
        article_id: `a${i + 1}`,
        title: `Haber ${i + 1}`,
        published_at: new Date(Date.parse('2026-08-21T09:00:00.000Z') - i * 60_000).toISOString(),
      }),
    );
    const nextPage = [
      feedRow({ article_id: 'a99', title: 'İkinci sayfa', published_at: '2026-08-21T07:00:00.000Z' }),
    ];

    let call = 0;
    const net = stubNetwork(() => {
      call += 1;
      return { body: call === 1 ? firstPage : nextPage };
    });
    mockRepos = supabaseRepositories(net.fetchImpl);

    const view = renderApp(<FeedScreen />);
    await screen.findByText('Haber 1');

    const list = view.UNSAFE_getByType(FlatList);
    await act(async () => {
      fireEvent.press(screen.getByText('Daha fazla'));
    });
    // The 22nd row is outside FlatList's initial render window, so the proof that
    // the page arrived is the list's data, not a rendered node.
    await waitFor(() =>
      expect((list.props.data as { id: string }[]).some((a) => a.id === 'a99')).toBe(true),
    );

    const paged = decodeURIComponent(net.requests.at(-1)?.url ?? '');
    // The keyset predicate, not `offset=`.
    expect(paged).toContain('published_at.lt.');
    expect(paged).not.toContain('offset=');
  });

  it('searches through the RPC, not a like filter', async () => {
    const net = stubNetwork((request) => {
      if (request.url.includes('/rpc/aigundem_search_articles_v1')) {
        return { body: [feedRow({ title: 'OpenAI arama sonucu' })] };
      }
      return { body: [] };
    });
    mockRepos = supabaseRepositories(net.fetchImpl);

    renderApp(<SearchScreen />);
    fireEvent.changeText(screen.getByLabelText('AI gündeminde ara'), 'openai');

    expect(await screen.findByText('OpenAI arama sonucu', {}, { timeout: 3000 })).toBeTruthy();
    const rpc = net.requests.find((r) => r.url.includes('/rpc/aigundem_search_articles_v1'));
    expect(rpc?.method).toBe('POST');
    expect(JSON.parse(rpc?.body ?? '{}')).toEqual({ q: 'openai', source_ids: null, lim: 20 });
  });

  it('maps a PostgREST error to the Turkish error state', async () => {
    const net = stubNetwork(() => ({
      status: 400,
      body: { code: 'PGRST205', message: 'not in schema cache' },
    }));
    mockRepos = supabaseRepositories(net.fetchImpl);

    renderApp(<FeedScreen />);
    expect(await screen.findByText('Bu özellik henüz hazır değil.')).toBeTruthy();
  });
});

describe('mock mode: the same screens over the fixtures', () => {
  it('renders the prototype articles with no network at all', async () => {
    const net = stubNetwork(() => ({ body: [] }));
    mockRepos = createMockRepositories();

    renderApp(<FeedScreen />);
    expect(await screen.findByText('GPT-5.2 tanıtıldı: iki kat bağlam penceresi, yarı fiyat')).toBeTruthy();
    // The point of mock mode: nothing was requested.
    expect(net.requests).toEqual([]);
  });

  it('search still finds the OpenAI article by acronym', async () => {
    mockRepos = createMockRepositories();
    renderApp(<SearchScreen />);
    fireEvent.changeText(screen.getByLabelText('AI gündeminde ara'), 'openai');
    expect(
      await screen.findByText(/GPT-5.2 tanıtıldı/, {}, { timeout: 3000 }),
    ).toBeTruthy();
  });
});

describe('offline: cached feed survives a network failure', () => {
  it('keeps the rows from the successful fetch and marks them stale', async () => {
    let call = 0;
    const net = stubNetwork(() => {
      call += 1;
      if (call === 1) return { body: [feedRow({ title: 'Önbellekteki haber' })] };
      // 500, deliberately not 503/520: postgrest-js retries *those two itself*
      // with 1s/2s/4s backoff before the repository ever sees a failure, which
      // would make this test sleep ~7s per React Query attempt. Noted in p10.md.
      return { status: 500, body: { code: 'PGRST000', message: 'upstream down' } };
    });
    mockRepos = supabaseRepositories(net.fetchImpl);

    const view = renderApp(<FeedScreen />);
    await screen.findByText('Önbellekteki haber');

    const list = view.UNSAFE_getByType(FlatList);
    await act(async () => {
      (list.props.refreshControl as { props: { onRefresh: () => void } }).props.onRefresh();
    });

    // Cached rows stay on screen; the staleness is stated, not silent.
    expect(screen.getByText('Önbellekteki haber')).toBeTruthy();
    expect(await screen.findByText(/Çevrimdışı/, {}, { timeout: 3000 })).toBeTruthy();
    // P10 N2, fixed in fix-005: the read path used to cost 1 success + 1 attempt +
    // 2 React Query retries = 4 repository calls, each of which is itself up to
    // four postgrest-js attempts over ~7 s. Retrying is now left to the one layer
    // that already does it, so a failed refetch is a single call.
    expect(call).toBe(2);
  });

  it('restores yesterday’s rows from the persisted cache on a cold start', async () => {
    // The strong form of "offline": a *new* QueryClient, so the rows can only
    // have come back through the real persister and the kv adapter.
    const storage = fakeKv();
    let call = 0;
    const net = stubNetwork(() => {
      call += 1;
      if (call === 1) return { body: [feedRow({ title: 'Dünkü haber' })] };
      return { status: 500, body: { code: 'PGRST000', message: 'upstream down' } };
    });
    mockRepos = supabaseRepositories(net.fetchImpl);

    const mount = () =>
      render(
        <ThemeProvider storage={fakeKv()}>
          <QueryProvider storage={storage}>
            <ToastProvider>
              <FeedScreen />
            </ToastProvider>
          </QueryProvider>
        </ThemeProvider>,
      );

    const first = mount();
    await screen.findByText('Dünkü haber');
    // The persister throttles writes, so wait for the blob rather than assume it.
    await waitFor(() => expect(storage.data.has(KV_KEYS.queryCache)).toBe(true), {
      timeout: 5000,
    });
    first.unmount();

    const second = mount();
    // Nothing was requested at all in the second run: the restored rows are still
    // inside the 5-minute stale time, so a cold launch renders from disk and does
    // not touch the network. The 500 branch above exists to prove that.
    expect(await screen.findByText('Dünkü haber', {}, { timeout: 5000 })).toBeTruthy();
    expect(call).toBe(1);
    second.unmount();
  }, 20000);
});

describe('enrichment: pending → ready', () => {
  it('shows "Özet hazırlanıyor" for a queued job, then the bullets once it is ready', async () => {
    let enrichmentCalls = 0;
    const net = stubNetwork((request) => {
      if (request.url.includes('/functions/v1/request-enrichment')) {
        enrichmentCalls += 1;
        return enrichmentCalls === 1
          ? { status: 202, body: { status: 'queued', reason: 'no_api_key', poll_after_seconds: 5 } }
          : {
              status: 200,
              body: {
                status: 'ready',
                summary: {
                  bullets: ['ilk madde', 'ikinci madde', 'üçüncü madde'],
                  translation_tr: 'Türkçe gövde',
                  translation_state: 'ready',
                },
              },
            };
      }
      // The article itself has no summary yet — exactly the no-API-key state.
      return {
        body: [feedRow({ summary_ready: false, summary_tr: null, translation_tr: null })],
      };
    });
    mockRepos = supabaseRepositories(net.fetchImpl);

    renderApp(<ArticleScreen />);
    expect(await screen.findByText('Özet hazırlanıyor')).toBeTruthy();
    // addendum §E: the article stays readable while the summary is queued.
    expect(screen.getByText('OpenAI announced GPT-5.2…')).toBeTruthy();

    // The poll firing is React Query's timer (P6 code); what this asserts is the
    // transition — the second call returns ready and the screen swaps.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['v1', 'enrichment', 'article-1'] });
    });

    expect(await screen.findByText('ilk madde')).toBeTruthy();
    expect(screen.getByText('3 madde')).toBeTruthy();
    expect(screen.queryByText('Özet hazırlanıyor')).toBeNull();

    const edge = net.requests.find((r) => r.url.includes('/functions/v1/request-enrichment'));
    expect(JSON.parse(edge?.body ?? '{}').article_id).toBe('article-1');
    // NB: against the *real* function this call is currently rejected before it
    // reaches any of this — see B1 above. The stub answers the documented
    // contract, which is what this test is for.
  });
});

describe('add-source: the Edge contract as the server actually answers it', () => {
  const call = async (envelope: { status: number; code: string; message: string }) => {
    const net = stubNetwork(() => ({
      status: envelope.status,
      body: {
        error: { code: envelope.code, message: envelope.message, retryable: envelope.status >= 500 },
      },
    }));
    const repos = supabaseRepositories(net.fetchImpl);
    const result = await repos.sources.addSourceByUrl('https://example.com/page.html', {
      category: 'Modeller',
      language: 'en',
    });
    return { result, net };
  };

  it('posts the url, the category and an idempotency key', async () => {
    const { net } = await call({ status: 400, code: 'bad_request', message: 'no' });
    const request = net.requests.find((r) => r.url.includes('/functions/v1/add-source'));
    expect(request?.method).toBe('POST');
    const body = JSON.parse(request?.body ?? '{}');
    expect(body.url).toBe('https://example.com/page.html');
    expect(body.category).toBe('Modeller');
    expect(typeof body.client_request_id).toBe('string');
  });

  it('client_request_id is the uuid v4 the server demands (P10 B1, fixed in fix-005)', async () => {
    // Both handlers run `isUuidV4` on this field and answer 400 bad_request
    // otherwise, so a "unique enough" id fails every Edge write in supabase mode
    // while every curl smoke passes. These two lines were inverted while the
    // defect stood; they are the regression guard now.
    expect(UUID_V4.test(clientRequestId())).toBe(true);
    expect(clientRequestId()).not.toBe(clientRequestId());
  });

  it('maps the SSRF rejection to a typed error the sheet can phrase', async () => {
    const { result } = await call({
      status: 400,
      code: 'unsafe_url',
      message: 'host resolves to a private range',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.retryable).toBe(false);
      expect(addSourceErrorTr(result.error)).toBe('Geçerli bir adres gir (https:// ile başlamalı).');
    }
  });

  it('rate limiting keeps its own code and stays retryable', async () => {
    const { result } = await call({ status: 429, code: 'rate_limited', message: 'slow down' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rate_limited');
      expect(addSourceErrorTr(result.error)).toBe(
        'Çok fazla deneme yaptın. Biraz sonra tekrar dene.',
      );
    }
  });

  it('tells a not-a-feed URL what is actually wrong (P10 N1, fixed in fix-005)', async () => {
    // The server answers `parse_failed`; before fix-005 the client's CODE_MAP knew
    // only `not_a_feed`, so a perfectly valid https URL with no feed behind it was
    // told to start with https://.
    const { result } = await call({ status: 422, code: 'parse_failed', message: 'not a feed' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsupported_source');
      expect(result.error.details).toMatchObject({ serverCode: 'parse_failed', status: 422 });
      expect(addSourceErrorTr(result.error)).toBe(
        'Bu adreste okunabilir bir RSS/Atom akışı bulunamadı.',
      );
    }
  });

  it.each(['not_a_feed', 'no_feed_discovered', 'empty_feed'])(
    'gives %s the same no-feed sentence',
    async (code) => {
      const { result } = await call({ status: 422, code, message: 'nothing here' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(addSourceErrorTr(result.error)).toBe(
          'Bu adreste okunabilir bir RSS/Atom akışı bulunamadı.',
        );
      }
    },
  );
});

describe('onboarding guard + notification scheduling', () => {
  it('completes onboarding and then schedules exactly one reminder', async () => {
    expect(await isOnboardingComplete()).toBe(false);

    const completion = await completeOnboarding({
      sourceIds: ['source-1'],
      digestTime: '07:30',
      digestEnabled: true,
    });
    expect(completion.ok).toBe(true);
    expect(await isOnboardingComplete()).toBe(true);

    // The service, driven by the same persisted choice the screen wrote.
    const scheduled: { identifier: string; content?: { data?: Record<string, unknown> } }[] = [];
    let nextId = 1;
    let storedId: string | null = null;
    const service = createNotificationService({
      platform: { os: 'android' },
      api: {
        async setNotificationChannelAsync() {
          return null;
        },
        async getPermissionsAsync() {
          return { status: 'granted', granted: true };
        },
        async requestPermissionsAsync() {
          return { status: 'granted', granted: true };
        },
        async scheduleNotificationAsync(request) {
          const identifier = `sched-${nextId++}`;
          scheduled.push({ identifier, content: { data: request.content.data } });
          return identifier;
        },
        async cancelScheduledNotificationAsync(identifier) {
          const at = scheduled.findIndex((s) => s.identifier === identifier);
          if (at >= 0) scheduled.splice(at, 1);
        },
        async getAllScheduledNotificationsAsync() {
          return [...scheduled];
        },
      },
      store: {
        getNotificationId: async () => storedId,
        setNotificationId: async (id) => {
          storedId = id;
        },
        getPermissionStatus: async () => 'granted',
        setPermissionStatus: async () => undefined,
      },
    });

    const enabled = await service.enableDigest('07:30');
    expect(enabled).toMatchObject({ ok: true, status: 'scheduled' });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].content?.data).toMatchObject({ url: '/(tabs)/digest' });

    // Reconciliation on a later launch keeps it at exactly one.
    const again = await service.reconcile({ enabled: true, time: '07:30' });
    expect(again).toEqual({ action: 'none', owned: 1 });
    expect(scheduled).toHaveLength(1);
  });
});

describe('theme persistence through the real adapter shape', () => {
  it('round-trips a preference through the module shape expo-sqlite actually exports', async () => {
    // `{ default, Storage }`, not the namespace — the rev-002 B1 defect.
    const data = new Map<string, string>();
    const instance = {
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
    const store = createNativeStore(
      () => ({ __esModule: true, AsyncStorage: instance, Storage: instance, default: instance }),
      () => {
        throw new Error('must not fall back to memory');
      },
    );

    const rendered = render(
      <ThemeProvider storage={store}>
        <React.Fragment />
      </ThemeProvider>,
    );
    await act(async () => undefined);
    rendered.unmount();

    await store.setItem(KV_KEYS.themePreference, 'light');
    expect(data.get(KV_KEYS.themePreference)).toBe('light');

    // A fresh provider over the same store reads the persisted choice back.
    let observed: string | null = null;
    const Probe = () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { useTheme } = require('../theme/ThemeProvider');
      const theme = useTheme();
      if (theme.isReady) observed = theme.preference;
      return null;
    };
    const second = render(
      <ThemeProvider storage={store}>
        <Probe />
      </ThemeProvider>,
    );
    await waitFor(() => expect(observed).toBe('light'));
    second.unmount();
  });
});

describe('production data mode default', () => {
  it('is supabase for a release build and mock for dev/test', () => {
    expect(defaultDataModeFor(false)).toBe('supabase');
    expect(defaultDataModeFor(true)).toBe('mock');
  });

  it('an unset mode follows the build type', () => {
    const raw = { dataMode: undefined, supabaseUrl: 'u', supabaseAnonKey: 'k' };
    expect(resolveEnv(raw, { defaultMode: 'supabase' }).dataMode).toBe('supabase');
    expect(resolveEnv(raw, { defaultMode: 'mock' }).dataMode).toBe('mock');
  });

  it('a production build with no credentials falls back to mock rather than looping', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const resolved = resolveEnv(
        { dataMode: undefined, supabaseUrl: undefined, supabaseAnonKey: undefined },
        { defaultMode: 'supabase' },
      );
      expect(resolved.dataMode).toBe('mock');
      expect(resolved.supabaseUrl).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to "mock"'));
    } finally {
      warn.mockRestore();
    }
  });

  it('an explicit mode always wins over the build default', () => {
    expect(
      resolveEnv(
        { dataMode: 'mock', supabaseUrl: 'u', supabaseAnonKey: 'k' },
        { defaultMode: 'supabase' },
      ).dataMode,
    ).toBe('mock');
  });
});
