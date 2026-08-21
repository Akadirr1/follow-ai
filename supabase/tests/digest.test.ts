/**
 * The digest: window arithmetic, request validation, and the ranking algorithm.
 *
 * The ranker tested here is `_shared/digest.ts` — the TypeScript specification.
 * The ranker that RUNS is the SQL in migration 0008, which has to be, so that
 * selection and insertion share one transaction. `sql-lint-p5.test.ts` pins the
 * SQL's ordering clauses against this; genuine equivalence needs a database and
 * is listed as NOT VERIFIED in agents/reports/p5.md.
 */
import {
  blurbFor,
  createDigestDb,
  DIGEST_ITEM_COUNT,
  DIGEST_WINDOW_END_LOCAL_HOUR,
  digestWindow,
  DigestDateError,
  headlineFor,
  isDigestDate,
  ISTANBUL_UTC_OFFSET_HOURS,
  istanbulDateFor,
  MAX_BLURB_CHARS,
  parseDigestRequest,
  planDigest,
  rankDigestCandidates,
  type DigestCandidate,
} from '../functions/_shared/digest.ts';

function candidate(
  articleId: string,
  sourceId: string,
  publishedAt: string,
  summary: string[] = ['bir', 'iki', 'üç'],
): DigestCandidate {
  return { articleId, sourceId, publishedAt, summary };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

describe('digestWindow', () => {
  it('closes at 05:00 Istanbul on the digest date and opens 24 hours earlier', () => {
    // 05:00 Istanbul is 02:00 UTC.
    expect(digestWindow('2026-08-21')).toEqual({
      windowStart: '2026-08-20T02:00:00.000Z',
      windowEnd: '2026-08-21T02:00:00.000Z',
    });
  });

  it('is exactly 24 hours wide for every date it accepts', () => {
    for (const date of ['2026-01-01', '2026-02-28', '2026-03-29', '2026-10-25', '2026-12-31']) {
      const { windowStart, windowEnd } = digestWindow(date);
      expect({ date, hours: (Date.parse(windowEnd) - Date.parse(windowStart)) / 3600000 }).toEqual(
        { date, hours: 24 },
      );
    }
  });

  it('has no DST seam, because Istanbul has been permanently UTC+3 since 2016', () => {
    // The old EU transition dates: the last Sunday in March and October. A
    // timezone with DST would make one of these windows 23 or 25 hours.
    for (const date of ['2026-03-28', '2026-03-29', '2026-03-30', '2026-10-24', '2026-10-25', '2026-10-26']) {
      const { windowStart, windowEnd } = digestWindow(date);
      expect({ date, hours: (Date.parse(windowEnd) - Date.parse(windowStart)) / 3600000 }).toEqual(
        { date, hours: 24 },
      );
      // And the UTC offset of the boundary is the same constant all year.
      const endHourUtc = new Date(windowEnd).getUTCHours();
      expect({ date, endHourUtc }).toEqual({
        date,
        endHourUtc: DIGEST_WINDOW_END_LOCAL_HOUR - ISTANBUL_UTC_OFFSET_HOURS,
      });
    }
  });

  it('pins the offset constant, the one thing that breaks if Türkiye reinstates DST', () => {
    expect(ISTANBUL_UTC_OFFSET_HOURS).toBe(3);
    expect(DIGEST_WINDOW_END_LOCAL_HOUR).toBe(5);
  });

  it('makes consecutive days abut exactly, with no gap and no overlap', () => {
    const first = digestWindow('2026-08-20');
    const second = digestWindow('2026-08-21');
    expect(first.windowEnd).toBe(second.windowStart);
  });

  it('crosses month and year boundaries correctly', () => {
    expect(digestWindow('2026-03-01').windowStart).toBe('2026-02-28T02:00:00.000Z');
    expect(digestWindow('2027-01-01').windowStart).toBe('2026-12-31T02:00:00.000Z');
  });

  it('refuses anything that is not a real YYYY-MM-DD date', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '21-08-2026', '2026-8-1', 'today', '']) {
      expect(() => digestWindow(bad)).toThrow(DigestDateError);
      expect(isDigestDate(bad)).toBe(false);
    }
    expect(isDigestDate('2026-08-21')).toBe(true);
  });
});

describe('istanbulDateFor', () => {
  it('rolls over at Istanbul midnight, not UTC midnight', () => {
    // 21:00 UTC is already midnight in Istanbul.
    expect(istanbulDateFor(new Date('2026-08-20T20:59:59Z'))).toBe('2026-08-20');
    expect(istanbulDateFor(new Date('2026-08-20T21:00:00Z'))).toBe('2026-08-21');
  });

  it('gives the date the cron firings actually mean', () => {
    // prepare at 02:45 UTC and the finalize retries at 03:30/40/50 UTC must all
    // resolve to the same Istanbul day, or the retries would build a different
    // digest from the one prepare created.
    const dates = ['02:45', '03:30', '03:40', '03:50'].map((hhmm) =>
      istanbulDateFor(new Date(`2026-08-21T${hhmm}:00Z`)),
    );
    expect(new Set(dates).size).toBe(1);
    expect(dates[0]).toBe('2026-08-21');
  });
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

describe('parseDigestRequest', () => {
  it('accepts both phases, with and without a date', () => {
    expect(parseDigestRequest({ phase: 'prepare' })).toEqual({
      ok: true,
      value: { digestDate: null, phase: 'prepare' },
    });
    expect(parseDigestRequest({ phase: 'finalize', digest_date: '2026-08-21' })).toEqual({
      ok: true,
      value: { digestDate: '2026-08-21', phase: 'finalize' },
    });
    // An explicit null date means the same as omitting it.
    expect(parseDigestRequest({ phase: 'prepare', digest_date: null })).toMatchObject({
      ok: true,
    });
  });

  it('requires a phase and rejects anything else', () => {
    expect(parseDigestRequest({})).toEqual({ ok: false, reason: 'phase_missing' });
    expect(parseDigestRequest({ phase: null })).toEqual({ ok: false, reason: 'phase_missing' });
    for (const phase of ['PREPARE', 'build', '', 1, true, {}]) {
      expect(parseDigestRequest({ phase })).toEqual({ ok: false, reason: 'phase_invalid' });
    }
  });

  it('rejects a malformed or impossible date', () => {
    for (const digest_date of ['2026-02-30', 'yesterday', '2026/08/21', 20260821]) {
      expect(parseDigestRequest({ phase: 'prepare', digest_date })).toEqual({
        ok: false,
        reason: 'date_invalid',
      });
    }
  });
});

describe('headlineFor', () => {
  it('is the Turkish headline arch-001 specifies', () => {
    expect(headlineFor('2026-08-21')).toBe('Bugünün AI Gündemi · 2026-08-21');
  });
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

describe('rankDigestCandidates', () => {
  it('takes one article per source before taking a second from any source', () => {
    // Source a published four times; b and c once each.
    const candidates = [
      candidate('a4', 'a', '2026-08-20T20:00:00Z'),
      candidate('a3', 'a', '2026-08-20T19:00:00Z'),
      candidate('a2', 'a', '2026-08-20T18:00:00Z'),
      candidate('a1', 'a', '2026-08-20T17:00:00Z'),
      candidate('b1', 'b', '2026-08-20T16:00:00Z'),
      candidate('c1', 'c', '2026-08-20T15:00:00Z'),
    ];

    const ranked = rankDigestCandidates(candidates);

    // Every source's newest first (newest of those first), then round two.
    expect(ranked.map((r) => r.articleId)).toEqual(['a4', 'b1', 'c1', 'a3', 'a2']);
    expect(ranked.map((r) => r.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it('gives five different sources five different slots', () => {
    const candidates = ['a', 'b', 'c', 'd', 'e'].map((s, i) =>
      candidate(`${s}1`, s, `2026-08-20T1${5 + i}:00:00Z`),
    );
    const ranked = rankDigestCandidates(candidates);
    expect(new Set(ranked.map((r) => r.sourceId)).size).toBe(5);
    // Newest first among the round-one picks.
    expect(ranked.map((r) => r.articleId)).toEqual(['e1', 'd1', 'c1', 'b1', 'a1']);
  });

  it('still fills five slots when only one source published', () => {
    // "max one per source FIRST, then fill" — not "at most one per source".
    const candidates = Array.from({ length: 7 }, (_, i) =>
      candidate(`a${i}`, 'a', `2026-08-20T1${i}:00:00Z`),
    );
    const ranked = rankDigestCandidates(candidates);
    expect(ranked).toHaveLength(5);
    expect(ranked.map((r) => r.articleId)).toEqual(['a6', 'a5', 'a4', 'a3', 'a2']);
  });

  it('is deterministic: identical input gives an identical result', () => {
    const candidates = [
      candidate('x', 'a', '2026-08-20T20:00:00Z'),
      candidate('y', 'b', '2026-08-20T19:00:00Z'),
      candidate('z', 'c', '2026-08-20T18:00:00Z'),
      candidate('w', 'a', '2026-08-20T17:00:00Z'),
      candidate('v', 'b', '2026-08-20T16:00:00Z'),
      candidate('u', 'c', '2026-08-20T15:00:00Z'),
    ];
    const first = rankDigestCandidates(candidates);
    for (let i = 0; i < 10; i += 1) {
      expect(rankDigestCandidates(candidates)).toEqual(first);
    }
  });

  it('is independent of input order', () => {
    const candidates = [
      candidate('a1', 'a', '2026-08-20T20:00:00Z'),
      candidate('b1', 'b', '2026-08-20T19:00:00Z'),
      candidate('c1', 'c', '2026-08-20T18:00:00Z'),
      candidate('a2', 'a', '2026-08-20T17:00:00Z'),
      candidate('b2', 'b', '2026-08-20T16:00:00Z'),
    ];
    const forwards = rankDigestCandidates(candidates);
    const backwards = rankDigestCandidates([...candidates].reverse());
    const shuffled = rankDigestCandidates([candidates[3], candidates[0], candidates[4], candidates[2], candidates[1]]);
    expect(backwards).toEqual(forwards);
    expect(shuffled).toEqual(forwards);
  });

  it('breaks a published_at tie by id, so a batch stamped to the minute is stable', () => {
    // arXiv stamps a whole batch with the same timestamp; without a tiebreak the
    // order would depend on whatever the planner returned that day.
    const sameInstant = '2026-08-20T18:00:00Z';
    const candidates = [
      candidate('aaa', 'a', sameInstant),
      candidate('bbb', 'b', sameInstant),
      candidate('ccc', 'c', sameInstant),
      candidate('ddd', 'd', sameInstant),
      candidate('eee', 'e', sameInstant),
    ];
    const ranked = rankDigestCandidates(candidates);
    // Descending id, matching the SQL's `order by ... id desc`.
    expect(ranked.map((r) => r.articleId)).toEqual(['eee', 'ddd', 'ccc', 'bbb', 'aaa']);
    expect(rankDigestCandidates([...candidates].reverse())).toEqual(ranked);
  });

  it('never repeats an article', () => {
    const candidates = Array.from({ length: 12 }, (_, i) =>
      candidate(`id${i}`, `s${i % 3}`, `2026-08-20T${10 + i}:00:00Z`),
    );
    const ranked = rankDigestCandidates(candidates);
    expect(new Set(ranked.map((r) => r.articleId)).size).toBe(ranked.length);
  });

  it('numbers positions 1..5 with no gaps', () => {
    const candidates = Array.from({ length: 9 }, (_, i) =>
      candidate(`id${i}`, `s${i % 4}`, `2026-08-20T${10 + i}:00:00Z`),
    );
    expect(rankDigestCandidates(candidates).map((r) => r.position)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('blurbFor', () => {
  it('is the first summary bullet — no Claude call in the digest path', () => {
    expect(blurbFor(candidate('a', 'b', '2026-08-20T10:00:00Z', ['ilk madde', 'iki', 'üç']))).toBe(
      'ilk madde',
    );
  });

  it('trims and caps at the column width', () => {
    expect(blurbFor(candidate('a', 'b', '2026-08-20T10:00:00Z', ['  boşluklu  ']))).toBe(
      'boşluklu',
    );
    const long = blurbFor(candidate('a', 'b', '2026-08-20T10:00:00Z', ['x'.repeat(900)]));
    expect(long.length).toBe(MAX_BLURB_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });

  it('survives a summary with no bullets rather than throwing', () => {
    expect(blurbFor(candidate('a', 'b', '2026-08-20T10:00:00Z', []))).toBe('');
  });
});

// ---------------------------------------------------------------------------
// All five or none
// ---------------------------------------------------------------------------

describe('planDigest', () => {
  it('stays preparing and writes nothing when fewer than five are enriched', () => {
    for (let n = 0; n < DIGEST_ITEM_COUNT; n += 1) {
      const candidates = Array.from({ length: n }, (_, i) =>
        candidate(`id${i}`, `s${i}`, `2026-08-20T1${i}:00:00Z`),
      );
      expect(planDigest(candidates)).toEqual({
        status: 'preparing',
        items: [],
        missing: DIGEST_ITEM_COUNT - n,
      });
    }
  });

  it('becomes ready at exactly five', () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      candidate(`id${i}`, `s${i}`, `2026-08-20T1${i}:00:00Z`),
    );
    const plan = planDigest(candidates);
    expect(plan.status).toBe('ready');
    expect(plan.missing).toBe(0);
    expect(plan.items).toHaveLength(5);
  });

  it('takes only the top five when more are available', () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      candidate(`id${i}`, `s${i % 6}`, `2026-08-20T${(10 + i) % 24}:00:00Z`),
    );
    expect(planDigest(candidates).items).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// RPC adapter — the names migration 0008 must expose
// ---------------------------------------------------------------------------

describe('createDigestDb', () => {
  function fakeClient(data: unknown = [{ digest_date: '2026-08-21', status: 'preparing', item_count: 0, missing: 5 }]) {
    const calls: { fn: string; args: unknown }[] = [];
    return {
      calls,
      client: {
        rpc(fn: string, args?: Record<string, unknown>) {
          calls.push({ fn, args });
          return Promise.resolve({ data, error: null });
        },
      },
    };
  }

  it('routes through the public transport shims by default prefix', async () => {
    const { client, calls } = fakeClient();
    const db = createDigestDb(client, { rpcPrefix: 'aigundem_' });

    await db.prepare('2026-08-21');
    await db.finalize(null);

    expect(calls.map((c) => c.fn)).toEqual([
      'aigundem_internal_digest_prepare',
      'aigundem_internal_digest_finalize',
    ]);
    expect(calls[0].args).toEqual({ p_date: '2026-08-21' });
    // A null date is passed through so Postgres resolves the Istanbul day.
    expect(calls[1].args).toEqual({ p_date: null });
  });

  it('calls the aigundem names once the schema is exposed', async () => {
    const { client, calls } = fakeClient();
    await createDigestDb(client).prepare('2026-08-21');
    expect(calls[0].fn).toBe('internal_digest_prepare');
  });

  it('reads the Vault secret through the allow-listed wrapper', async () => {
    const { client, calls } = fakeClient('a-secret-value');
    const value = await createDigestDb(client, { rpcPrefix: 'aigundem_' }).getSetting(
      'aigundem_automations_secret',
    );
    expect(calls[0]).toEqual({
      fn: 'aigundem_internal_get_setting',
      args: { p_name: 'aigundem_automations_secret' },
    });
    expect(value).toBe('a-secret-value');
  });

  it('reports a missing secret as null rather than an empty string', async () => {
    const { client } = fakeClient(null);
    expect(await createDigestDb(client).getSetting('aigundem_automations_secret')).toBeNull();
    const empty = fakeClient('');
    expect(await createDigestDb(empty.client).getSetting('aigundem_automations_secret')).toBeNull();
  });

  it('accepts a single row as well as a one-row array', async () => {
    const single = fakeClient({ digest_date: '2026-08-21', status: 'ready', item_count: 5, missing: 0 });
    expect(await createDigestDb(single.client).finalize(null)).toMatchObject({ status: 'ready' });
  });

  it('turns a database error into an error that does not echo the message', async () => {
    const db = createDigestDb({
      rpc: () =>
        Promise.resolve({
          data: null,
          error: { message: 'row (secret-article-body) violates constraint' },
        }),
    });
    await expect(db.prepare(null)).rejects.toThrow(/Database call .* failed/);
    await expect(db.prepare(null)).rejects.not.toThrow(/secret-article-body/);
  });
});
