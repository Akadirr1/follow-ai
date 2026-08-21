/**
 * The digest's prepare phase after P12: create the day's row, then enqueue the
 * enrichments the day will need.
 *
 * The population that actually gets selected is the SQL in migration 0012 —
 * `sql-lint-0012.test.ts` pins its shape, and genuine behaviour needs a
 * database, which this task does not have. What runs here is the orchestration:
 * WHICH model string the jobs are enqueued under, WHETHER the enqueue happens
 * at all, and what a failure of it does to the digest.
 *
 * The model string is the part worth a test. It is half the summary cache key
 * `(article_id, content_hash, prompt_version, model)`. If prepare enqueues
 * `claude-opus-5` while `process-enrichments` resolves `gemini-2.5-flash`, the
 * worker never sees the job, the digest never fills, and nothing anywhere
 * reports an error.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createDigestDb,
  DigestDbError,
  type DigestCandidatesRow,
  type DigestResultRow,
} from '../functions/_shared/digest.ts';
import {
  DEFAULT_DIGEST_CANDIDATES,
  DEFAULT_DIGEST_PER_SOURCE,
  DIGEST_CANDIDATES_ENV,
  DIGEST_PER_SOURCE_ENV,
  MAX_DIGEST_CANDIDATES,
  MAX_DIGEST_PER_SOURCE,
  MIN_DIGEST_CANDIDATES,
  MIN_DIGEST_PER_SOURCE,
  readDigestLimits,
  runDigestPrepare,
  type DigestPrepareDeps,
  type ProviderChoice,
} from '../functions/_shared/digest-enqueue.ts';

const ROW: DigestResultRow = {
  digest_date: '2026-08-21',
  status: 'preparing',
  item_count: 0,
  missing: 5,
};

const COUNTS: DigestCandidatesRow = { enqueued: 9, already: 3, candidates: 12 };

type EnqueueArgs = Parameters<DigestPrepareDeps['db']['enqueueCandidates']>[0];

function deps(
  overrides: {
    choice?: ProviderChoice;
    counts?: DigestCandidatesRow;
    enqueueError?: unknown;
    prepareError?: unknown;
    perSource?: number;
    limit?: number;
  } = {},
): { deps: DigestPrepareDeps; calls: EnqueueArgs[]; prepared: (string | null)[] } {
  const calls: EnqueueArgs[] = [];
  const prepared: (string | null)[] = [];

  return {
    calls,
    prepared,
    deps: {
      db: {
        async prepare(date) {
          prepared.push(date);
          if (overrides.prepareError) throw overrides.prepareError;
          return ROW;
        },
        async enqueueCandidates(input) {
          calls.push(input);
          if (overrides.enqueueError) throw overrides.enqueueError;
          return overrides.counts ?? COUNTS;
        },
      },
      resolveProvider: async () =>
        overrides.choice ?? { provider: 'gemini', model: 'gemini-2.5-flash' },
      promptVersion: 'v1',
      limits: {
        perSource: overrides.perSource ?? DEFAULT_DIGEST_PER_SOURCE,
        limit: overrides.limit ?? DEFAULT_DIGEST_CANDIDATES,
      },
    },
  };
}

describe('readDigestLimits', () => {
  const env = (values: Record<string, string>) => ({
    get: (name: string) => values[name],
  });

  it('defaults to two per source and fifteen overall', () => {
    expect(readDigestLimits(env({}))).toEqual({
      perSource: DEFAULT_DIGEST_PER_SOURCE,
      limit: DEFAULT_DIGEST_CANDIDATES,
    });
  });

  it('reads both knobs', () => {
    expect(
      readDigestLimits(env({ [DIGEST_PER_SOURCE_ENV]: '3', [DIGEST_CANDIDATES_ENV]: '20' })),
    ).toEqual({ perSource: 3, limit: 20 });
  });

  it.each([
    ['blank', '', DEFAULT_DIGEST_CANDIDATES],
    ['whitespace', '   ', DEFAULT_DIGEST_CANDIDATES],
    ['not a number', 'many', DEFAULT_DIGEST_CANDIDATES],
    ['not finite', 'Infinity', DEFAULT_DIGEST_CANDIDATES],
  ])('falls back to the default when %s', (_label, raw, expected) => {
    expect(readDigestLimits(env({ [DIGEST_CANDIDATES_ENV]: raw })).limit).toBe(expected);
  });

  it('truncates a fractional value rather than sending Postgres a float', () => {
    expect(readDigestLimits(env({ [DIGEST_CANDIDATES_ENV]: '12.9' })).limit).toBe(12);
  });

  it('CLAMPS instead of rejecting, so a typo cannot take the daily digest down', () => {
    // Migration 0012 raises on an out-of-range argument. Passing the typo
    // straight through would make prepare throw and the day's digest row would
    // never be created — a deploy variable must not be able to do that.
    const high = readDigestLimits(
      env({ [DIGEST_PER_SOURCE_ENV]: '500', [DIGEST_CANDIDATES_ENV]: '5000' }),
    );
    expect(high).toEqual({ perSource: MAX_DIGEST_PER_SOURCE, limit: MAX_DIGEST_CANDIDATES });

    const low = readDigestLimits(
      env({ [DIGEST_PER_SOURCE_ENV]: '-4', [DIGEST_CANDIDATES_ENV]: '-1' }),
    );
    expect(low).toEqual({ perSource: MIN_DIGEST_PER_SOURCE, limit: MIN_DIGEST_CANDIDATES });
  });

  it('treats 0 as the floor, NOT as an off switch', () => {
    // Documented explicitly because it is the value a reader would reach for
    // first when trying to disable pre-enrichment. It does not disable it.
    expect(readDigestLimits(env({ [DIGEST_CANDIDATES_ENV]: '0' })).limit).toBe(
      MIN_DIGEST_CANDIDATES,
    );
  });

  it('stays inside the range migration 0012 accepts, for every input', () => {
    for (const raw of ['0', '1', '2', '5', '6', '50', '51', '999', '-1']) {
      const { perSource, limit } = readDigestLimits(
        env({ [DIGEST_PER_SOURCE_ENV]: raw, [DIGEST_CANDIDATES_ENV]: raw }),
      );
      expect({ raw, ok: perSource >= 1 && perSource <= 5 && limit >= 1 && limit <= 50 }).toEqual({
        raw,
        ok: true,
      });
    }
  });
});

describe('runDigestPrepare: the resolved model is what gets enqueued', () => {
  it('enqueues under the resolver model, prompt version and limits', async () => {
    const { deps: d, calls, prepared } = deps({ perSource: 3, limit: 20 });

    const result = await runDigestPrepare(d, '2026-08-21');

    expect(prepared).toEqual(['2026-08-21']);
    expect(calls).toEqual([
      {
        date: '2026-08-21',
        model: 'gemini-2.5-flash',
        promptVersion: 'v1',
        perSource: 3,
        limit: 20,
      },
    ]);
    expect(result.row).toEqual(ROW);
    expect(result.enqueue).toEqual({
      ...COUNTS,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    });
    expect(result.enqueue.reason).toBeUndefined();
  });

  it.each([
    ['gemini', 'gemini-2.5-flash'],
    ['nvidia', 'meta/llama-3.3-70b-instruct'],
    ['anthropic', 'claude-opus-5'],
  ])('never substitutes a model of its own: %s', async (provider, model) => {
    const { deps: d, calls } = deps({ choice: { provider, model } });

    const result = await runDigestPrepare(d, null);

    expect(calls[0].model).toBe(model);
    expect(result.enqueue.model).toBe(model);
    expect(result.enqueue.provider).toBe(provider);
  });

  it('passes a null date straight through, so Postgres owns "today"', async () => {
    const { deps: d, calls, prepared } = deps();

    await runDigestPrepare(d, null);

    // Both calls must agree, or the row is created for one day and the
    // candidates enqueued for another.
    expect(prepared).toEqual([null]);
    expect(calls[0].date).toBeNull();
  });

  it('reports already > 0 on a second run without enqueueing twice', async () => {
    const { deps: d } = deps({ counts: { enqueued: 0, already: 12, candidates: 12 } });

    const result = await runDigestPrepare(d, '2026-08-21');

    expect(result.enqueue).toMatchObject({ enqueued: 0, already: 12, candidates: 12 });
  });
});

describe('runDigestPrepare: pre-enrichment is an optimisation, not a precondition', () => {
  it('skips the enqueue entirely when no provider resolves', async () => {
    const { deps: d, calls } = deps({ choice: { provider: null } });

    const result = await runDigestPrepare(d, '2026-08-21');

    // Not "enqueued zero" — never asked. The worker would answer
    // `skipped: no_api_key` for anything queued, and there is no model string
    // to queue it under in the first place.
    expect(calls).toEqual([]);
    expect(result.enqueue).toEqual({
      enqueued: 0,
      already: 0,
      candidates: 0,
      provider: null,
      model: null,
      reason: 'no_provider',
    });
    // The digest row still exists. That is the part that must always happen.
    expect(result.row).toEqual(ROW);
  });

  it('absorbs a wrapper failure, so deploying before 0012 is applied is merely ineffective', async () => {
    const { deps: d } = deps({ enqueueError: new DigestDbError('Candidate enqueue failed.') });

    const result = await runDigestPrepare(d, '2026-08-21');

    expect(result.row).toEqual(ROW);
    expect(result.enqueue).toEqual({
      enqueued: 0,
      already: 0,
      candidates: 0,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      reason: 'enqueue_failed',
    });
  });

  it('does NOT absorb an unexpected error, which would hide a real bug', async () => {
    const boom = new TypeError('undefined is not a function');
    const { deps: d } = deps({ enqueueError: boom });

    await expect(runDigestPrepare(d, '2026-08-21')).rejects.toBe(boom);
  });

  it('propagates a prepare failure: there is no digest to report on', async () => {
    const { deps: d, calls } = deps({
      prepareError: new DigestDbError('Digest wrapper call failed.'),
    });

    await expect(runDigestPrepare(d, '2026-08-21')).rejects.toBeInstanceOf(DigestDbError);
    expect(calls).toEqual([]);
  });
});

describe('createDigestDb.enqueueCandidates', () => {
  function fakeClient(response: { data: unknown; error: { message: string } | null }) {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    return {
      calls,
      client: {
        rpc(fn: string, args?: Record<string, unknown>) {
          calls.push({ fn, args: args ?? {} });
          return Promise.resolve(response);
        },
      },
    };
  }

  it('calls the prefixed wrapper with the 0012 argument names', async () => {
    const { client, calls } = fakeClient({ data: [COUNTS], error: null });
    const db = createDigestDb(client, { rpcPrefix: 'aigundem_' });

    const row = await db.enqueueCandidates({
      date: '2026-08-21',
      model: 'gemini-2.5-flash',
      promptVersion: 'v1',
      perSource: 2,
      limit: 15,
    });

    expect(calls).toEqual([
      {
        fn: 'aigundem_internal_enqueue_digest_candidates',
        args: {
          p_date: '2026-08-21',
          p_model: 'gemini-2.5-flash',
          p_prompt_version: 'v1',
          p_per_source: 2,
          p_limit: 15,
        },
      },
    ]);
    expect(row).toEqual(COUNTS);
  });

  it('unwraps a single-object response as well as an array', async () => {
    const { client } = fakeClient({ data: COUNTS, error: null });
    const db = createDigestDb(client);

    await expect(
      db.enqueueCandidates({
        date: null,
        model: 'm',
        promptVersion: 'v1',
        perSource: 1,
        limit: 1,
      }),
    ).resolves.toEqual(COUNTS);
  });

  it('raises DigestDbError without quoting the database message', async () => {
    const { client } = fakeClient({
      data: null,
      // A Postgres error can quote a row; it must not reach a caller.
      error: { message: 'duplicate key value violates ... (title=Secret headline)' },
    });
    const db = createDigestDb(client, { rpcPrefix: 'aigundem_' });

    await expect(
      db.enqueueCandidates({
        date: null,
        model: 'm',
        promptVersion: 'v1',
        perSource: 1,
        limit: 1,
      }),
    ).rejects.toThrow(/^Database call aigundem_internal_enqueue_digest_candidates failed\.$/);
  });

  it('raises rather than inventing zeroes when the wrapper returns no row', async () => {
    const { client } = fakeClient({ data: [], error: null });
    const db = createDigestDb(client);

    await expect(
      db.enqueueCandidates({
        date: null,
        model: 'm',
        promptVersion: 'v1',
        perSource: 1,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(DigestDbError);
  });
});

describe('build-digest wires prepare through the resolver', () => {
  const source = readFileSync(
    join(__dirname, '..', 'functions', 'build-digest', 'index.ts'),
    'utf8',
  );

  it('resolves the provider instead of naming a model', () => {
    expect(source).toContain('resolveAiProvider(');
    expect(source).toContain('runDigestPrepare(');
    expect(source).toContain('promptVersion: PROMPT_VERSION');
    // The failure this guards against is silent: a hard-coded model string
    // enqueues jobs the worker will happily run and write under a key nothing
    // looks up again.
    expect(source).not.toMatch(/model:\s*'[^']+'/);
    expect(source).not.toContain('DEFAULT_MODEL');
  });

  it('leaves finalize alone', () => {
    expect(source).toContain('db.finalize(digestDate)');
    // One call site, and it is in the prepare branch.
    expect(source.match(/runDigestPrepare\(/g)).toHaveLength(1);
    expect(source.indexOf("phase === 'prepare'")).toBeLessThan(source.indexOf('runDigestPrepare('));
    expect(source.indexOf('runDigestPrepare(')).toBeLessThan(source.indexOf('db.finalize('));
  });

  it('reads both knobs from the environment', () => {
    expect(source).toContain('readDigestLimits(');
  });
});
