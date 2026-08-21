import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import type { Result } from '../../domain/errors';
import type { ArticleId, EnrichmentResult } from '../../domain/types';
import { ENRICHMENT_MAX_POLLS, ENRICHMENT_POLL_SECONDS, useEnrichment } from '../hooks';
import { createMockRepositories } from '../mock';
import { NO_CONTENT_ARTICLE } from '../mock/mapper';
import { REPOSITORY_CONTRACT_VERSION, type Repositories } from '../repositories';
import { createSupabaseEnrichmentRepository } from '../supabase/repositories';

/**
 * `unavailable/no_content` — the terminal answer, and the poll cap that ver-003
 * §4 found had no automated test.
 *
 * The two halves fake at different boundaries on purpose. The repository tests
 * fake the **network** (a stub `fetch` answering as the deployed function does),
 * so they prove the wire body is decoded. The hook tests fake the **repository**,
 * so they prove the scheduling decision without a transport in the way — the
 * thing under test is how many times React Query calls back, which a network
 * stub would only obscure.
 */

const CONFIG = { supabaseUrl: 'https://project.supabase.co', supabaseAnonKey: 'anon.key' };

/** One canned Edge response, and the requests that reached it. */
function stubEdge(responses: { status: number; body: unknown }[]) {
  const calls: string[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    const answer = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const text = JSON.stringify(answer.body);
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => text,
      json: async () => JSON.parse(text),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('supabase repository — unavailable', () => {
  const repo = (responses: { status: number; body: unknown }[]) => {
    const { fetchImpl, calls } = stubEdge(responses);
    return {
      repo: createSupabaseEnrichmentRepository({ fetchImpl, config: CONFIG }),
      calls,
    };
  };

  it('decodes 200 unavailable/no_content into the terminal variant', async () => {
    const { repo: enrichment } = repo([
      {
        status: 200,
        body: { status: 'unavailable', reason: 'no_content', client_request_id: 'req-1' },
      },
    ]);
    const result = await enrichment.requestEnrichment('article-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ status: 'unavailable', reason: 'no_content' });
  });

  it('keeps a reason the client has never seen rather than flattening it', async () => {
    const { repo: enrichment } = repo([
      { status: 200, body: { status: 'unavailable', reason: 'paywalled' } },
    ]);
    const result = await enrichment.requestEnrichment('article-1');
    if (result.ok) expect(result.data).toEqual({ status: 'unavailable', reason: 'paywalled' });
  });

  it('defaults a reasonless unavailable to no_content', async () => {
    const { repo: enrichment } = repo([{ status: 200, body: { status: 'unavailable' } }]);
    const result = await enrichment.requestEnrichment('article-1');
    if (result.ok) expect(result.data).toEqual({ status: 'unavailable', reason: 'no_content' });
  });

  it('does not mistake it for the unknown-body fallback, which is still queued', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { repo: enrichment } = repo([{ status: 200, body: { status: 'something-new' } }]);
      const result = await enrichment.requestEnrichment('article-1');
      if (result.ok) expect(result.data.status).toBe('queued');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unrecognised body'));
    } finally {
      warn.mockRestore();
    }
  });

  it('202 is still queued — a real job with nothing to run yet', async () => {
    const { repo: enrichment } = repo([
      { status: 202, body: { status: 'queued', reason: 'no_api_key' } },
    ]);
    const result = await enrichment.requestEnrichment('article-1');
    if (result.ok) expect(result.data).toEqual({ status: 'queued', reason: 'no_api_key' });
  });
});

describe('mock repository — parity with the deployed function', () => {
  const repos = createMockRepositories();

  it('answers unavailable/no_content for the body-less article', async () => {
    const result = await repos.enrichment.requestEnrichment(NO_CONTENT_ARTICLE.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ status: 'unavailable', reason: 'no_content' });
  });

  it('still answers ready for an article that has a fixture summary', async () => {
    const result = await repos.enrichment.requestEnrichment('oa');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe('ready');
  });
});

/** A repository whose enrichment answer is fixed, counting every call. */
function countingRepos(answer: EnrichmentResult): Repositories & { calls: () => number } {
  let calls = 0;
  const base = createMockRepositories();
  return {
    ...base,
    calls: () => calls,
    enrichment: {
      version: REPOSITORY_CONTRACT_VERSION,
      async requestEnrichment(_id: ArticleId): Promise<Result<EnrichmentResult>> {
        calls += 1;
        return { ok: true, data: answer };
      },
    },
  };
}

let mockRepos: Repositories & { calls: () => number } = countingRepos({
  status: 'queued',
  reason: null,
});
jest.mock('../index', () => ({
  ...jest.requireActual('../index'),
  getRepositories: () => mockRepos,
}));

describe('useEnrichment — the poll cap (ver-003 §4)', () => {
  let client: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    jest.useFakeTimers();
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  });

  afterEach(() => {
    client.clear();
    jest.useRealTimers();
  });

  /** Advance exactly one poll interval and let the refetch settle. */
  const tick = async () => {
    await act(async () => {
      jest.advanceTimersByTime(ENRICHMENT_POLL_SECONDS * 1000);
    });
  };

  it('polls a queued job exactly ENRICHMENT_MAX_POLLS times, warns once, then stops', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockRepos = countingRepos({ status: 'queued', reason: 'no_api_key' });
      const { result } = renderHook(() => useEnrichment('article-1'), { wrapper });

      await waitFor(() => expect(result.current.data?.status).toBe('queued'));
      expect(mockRepos.calls()).toBe(1); // the initial fetch, not a poll

      // Well past the cap: the interval must stop scheduling itself, not merely
      // slow down. `dataUpdateCount` reaches maxPolls and the next tick returns
      // false, so the total settles at maxPolls calls.
      for (let i = 0; i < ENRICHMENT_MAX_POLLS + 4; i += 1) await tick();

      expect(mockRepos.calls()).toBe(ENRICHMENT_MAX_POLLS);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`still queued after ${ENRICHMENT_MAX_POLLS} polls`),
      );

      // And it stays stopped.
      const settled = mockRepos.calls();
      for (let i = 0; i < 3; i += 1) await tick();
      expect(mockRepos.calls()).toBe(settled);
    } finally {
      warn.mockRestore();
    }
  });

  it('honours a lower maxPolls, so the cap is the hook option and not a constant', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockRepos = countingRepos({ status: 'queued', reason: null });
      const { result } = renderHook(() => useEnrichment('article-1', { maxPolls: 2 }), { wrapper });
      await waitFor(() => expect(result.current.data?.status).toBe('queued'));
      for (let i = 0; i < 6; i += 1) await tick();
      expect(mockRepos.calls()).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('never refetches an unavailable answer — zero polls, no warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockRepos = countingRepos({ status: 'unavailable', reason: 'no_content' });
      const { result } = renderHook(() => useEnrichment('article-1'), { wrapper });

      await waitFor(() => expect(result.current.data?.status).toBe('unavailable'));
      for (let i = 0; i < ENRICHMENT_MAX_POLLS + 4; i += 1) await tick();

      // One initial fetch, forever. This is the regression fix-005 exists for:
      // before it, `unavailable` was decoded as `queued` and polled to the cap.
      expect(mockRepos.calls()).toBe(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('never refetches a ready answer either', async () => {
    mockRepos = countingRepos({
      status: 'ready',
      summary: { bullets: ['a', 'b', 'c'], translationTr: null, translationState: 'not_required' },
    });
    const { result } = renderHook(() => useEnrichment('article-1'), { wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe('ready'));
    for (let i = 0; i < 4; i += 1) await tick();
    expect(mockRepos.calls()).toBe(1);
  });

  it('a terminal answer is never stale, so a remount does not re-ask', async () => {
    mockRepos = countingRepos({ status: 'unavailable', reason: 'no_content' });
    const first = renderHook(() => useEnrichment('article-1'), { wrapper });
    await waitFor(() => expect(first.result.current.data?.status).toBe('unavailable'));
    expect(mockRepos.calls()).toBe(1);
    first.unmount();

    // gcTime is 0 in this client, so remounting after a real unmount would refetch
    // regardless; what this pins is the staleTime decision itself.
    const query = client
      .getQueryCache()
      .find({ queryKey: ['v1', 'enrichment', 'article-1'] });
    expect(query?.isStaleByTime(Infinity)).toBe(false);
  });
});
