import { useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { KV_KEYS, type KvStore } from '../../storage/kv';
import { QueryProvider } from '../QueryProvider';

/**
 * Restore-before-fetch (ver-003 §4 gap).
 *
 * `QueryProvider.test.ts` already proves the blob round-trips through the
 * persister. What it cannot show is the ordering the offline promise depends on:
 * that a launch renders the persisted rows **before** the network is asked, so a
 * cold start on a train shows yesterday's feed instead of a spinner.
 *
 * The boundary faked here is the query function itself — a spy. Nothing else is
 * stubbed: the real `QueryProvider`, the real persister, and a kv store backed by
 * a Map. So "the spy had not been called yet" is a statement about the provider's
 * own ordering, not about a mock's.
 */

function fakeKv(): KvStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}

const KEY = ['v1', 'feed', 'restore-test'] as const;

function Probe({ queryFn }: { queryFn: () => Promise<string> }) {
  const query = useQuery({ queryKey: KEY, queryFn });
  return <Text>{query.data ?? 'yok'}</Text>;
}

const mount = (storage: KvStore, queryFn: () => Promise<string>) =>
  render(
    <QueryProvider storage={storage}>
      <Probe queryFn={queryFn} />
    </QueryProvider>,
  );

describe('QueryProvider — restore before fetch', () => {
  it('renders the persisted value without asking the network for it', async () => {
    const storage = fakeKv();

    // First launch: one successful fetch, which the persister writes out.
    const firstFetch = jest.fn().mockResolvedValue('dünkü içerik');
    const first = mount(storage, firstFetch);
    expect(await screen.findByText('dünkü içerik')).toBeTruthy();
    await waitFor(() => expect(storage.data.has(KV_KEYS.queryCache)).toBe(true), {
      timeout: 5000,
    });
    first.unmount();

    // Second launch: a brand-new QueryClient (QueryProvider builds its own), and
    // a spy that would resolve to something else if it were ever called.
    const secondFetch = jest.fn().mockResolvedValue('yeni içerik');
    const second = mount(storage, secondFetch);

    const restored = await screen.findByText('dünkü içerik', {}, { timeout: 5000 });
    expect(restored).toBeTruthy();
    // The ordering claim: the persisted value was on screen and the query
    // function had not run. `createQueryClient`'s five-minute stale time means it
    // does not run afterwards either.
    expect(secondFetch).not.toHaveBeenCalled();
    expect(screen.queryByText('yeni içerik')).toBeNull();
    second.unmount();
  }, 20000);

  it('shows the empty state rather than stale data when nothing was persisted', async () => {
    const storage = fakeKv();
    // Held on an object: assigning to a bare `let` inside the executor leaves
    // TypeScript narrowing it to `null` at the call site below.
    const pending: { release: ((value: string) => void) | null } = { release: null };
    const queryFn = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          pending.release = resolve;
        }),
    );

    const view = mount(storage, queryFn);
    // Nothing to restore: the provider does not invent a value while fetching.
    expect(await screen.findByText('yok')).toBeTruthy();
    await waitFor(() => expect(queryFn).toHaveBeenCalled());
    pending.release?.('taze içerik');
    expect(await screen.findByText('taze içerik')).toBeTruthy();
    view.unmount();
  }, 20000);
});
