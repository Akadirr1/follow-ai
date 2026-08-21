import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react-native';
import React, { type ReactElement, type ReactNode } from 'react';

import { ToastProvider } from '../components/ToastProvider';
import { err, ok, type Result } from '../domain/errors';
import type { Article, DigestSnapshot, EnrichmentResult, Page, Source } from '../domain/types';
import type { KvStore } from '../storage/kv';
import { ThemeProvider } from '../theme/ThemeProvider';
import type { Repositories } from '../data-access/repositories';
import { cursorOf } from '../data-access/cursor';

/**
 * Shared scaffolding for screen tests. Not a test file itself — Jest's
 * `testMatch` only collects `*.test.ts(x)`.
 *
 * Screens are rendered inside the real providers over **fake repositories**, so
 * a test states what the data layer returns and asserts what the user sees.
 */

export function fakeKv(initial: Record<string, string> = {}): KvStore & { data: Map<string, string> } {
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

let articleSeq = 0;

export function makeArticle(over: Partial<Article> = {}): Article {
  articleSeq += 1;
  return {
    id: `a${articleSeq}`,
    sourceId: 's1',
    sourceName: 'OpenAI Blog',
    tile: 'OA',
    title: 'GPT-5.2 tanıtıldı',
    url: 'https://openai.com/news/gpt-5-2',
    publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    category: 'Modeller',
    language: 'en',
    bodyOriginal: 'OpenAI announced GPT-5.2…',
    summary: {
      bullets: ['bir', 'iki', 'üç'],
      translationTr: 'OpenAI, GPT-5.2 ile…',
      translationState: 'ready',
    },
    ...over,
  };
}

export function makeSource(over: Partial<Source> = {}): Source {
  return {
    id: 's1',
    name: 'OpenAI Blog',
    feedUrl: 'https://openai.com/news/rss.xml',
    siteUrl: 'https://openai.com/news',
    category: 'Modeller',
    language: 'en',
    tile: 'OA',
    isDefault: true,
    isActive: true,
    ...over,
  };
}

export const page = (items: Article[], nextId?: string): Page<Article> => ({
  items,
  nextCursor: nextId ? cursorOf(items[items.length - 1].publishedAt, nextId) : null,
  hasMore: Boolean(nextId),
});

export type FakeRepoOverrides = {
  listArticles?: (params?: unknown) => Promise<Result<Page<Article>>>;
  getArticle?: (id: string) => Promise<Result<Article>>;
  searchArticles?: (params: { query: string }) => Promise<Result<Page<Article>>>;
  listSources?: () => Promise<Result<Source[]>>;
  addSourceByUrl?: (url: string, options?: unknown) => Promise<Result<Source>>;
  getLatestDigest?: () => Promise<Result<DigestSnapshot>>;
  requestEnrichment?: (id: string) => Promise<Result<EnrichmentResult>>;
};

/** A repository set whose every method is overridable per test. */
export function fakeRepositories(over: FakeRepoOverrides = {}): Repositories {
  const empty = page([]);
  return {
    version: 1,
    mode: 'mock',
    feed: {
      version: 1,
      listArticles: over.listArticles ?? (async () => ok(empty)),
      getArticle:
        over.getArticle ?? (async () => err<Article>('not_found', 'No article with that id.')),
      searchArticles: over.searchArticles ?? (async () => ok(empty)),
    },
    sources: {
      version: 1,
      listSources: over.listSources ?? (async () => ok([])),
      addSourceByUrl:
        over.addSourceByUrl ?? (async () => err<Source>('not_implemented', 'not wired')),
    },
    digest: {
      version: 1,
      getLatestDigest: over.getLatestDigest ?? (async () => ok({ status: 'preparing' })),
    },
    enrichment: {
      version: 1,
      requestEnrichment:
        over.requestEnrichment ?? (async () => ok({ status: 'queued', reason: 'no_api_key' })),
    },
  } as Repositories;
}

function Providers({ children, storage }: { children: ReactNode; storage: KvStore }) {
  // Retries off and no cache reuse: a test asserts one outcome, not a retry loop.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return (
    <ThemeProvider storage={storage}>
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export function renderScreen(
  ui: ReactElement,
  options: { storage?: KvStore } & Omit<RenderOptions, 'wrapper'> = {},
) {
  const storage = options.storage ?? fakeKv();
  return render(ui, {
    wrapper: ({ children }) => <Providers storage={storage}>{children}</Providers>,
    ...options,
  });
}
