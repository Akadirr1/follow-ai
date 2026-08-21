import { cursorOf, decodeCursor, encodeCursor, isAfterCursor } from '../cursor';
import { toSourceDto, mockSources } from '../mock/mapper';
import { createMockRepositories } from '../mock';
import { SOURCES } from '../../data/sources';

/**
 * The two contract findings from rev-002.
 *
 * N1: `Source.feedUrl` is nullable, matching what the mapper has always produced
 * and what `p1.md` documents. N2: a `Cursor` can only come from `cursorOf` or
 * `decodeCursor`; a hand-built `{publishedAt, id}` no longer type-checks, which is
 * a compile-time guarantee the runtime tests below complement.
 */

describe('Source.feedUrl is nullable (N1)', () => {
  it('gives Anthropic a null feed URL rather than a fabricated one', () => {
    const anthropic = SOURCES.find((s) => s.k === 'an');
    if (!anthropic) throw new Error('fixture changed: no Anthropic source');
    const dto = toSourceDto(anthropic);
    expect(dto.feedUrl).toBeNull();
    // A source with no feed cannot be ingested, so it is neither default nor active.
    expect(dto.isDefault).toBe(false);
    expect(dto.isActive).toBe(false);
  });

  it('gives every measured source a real https feed URL', () => {
    for (const dto of mockSources().filter((s) => s.isActive)) {
      expect(dto.feedUrl).toMatch(/^https:\/\//);
    }
  });

  it('keeps the null source out of listSources, so consumers see only feeds', async () => {
    const result = await createMockRepositories().sources.listSources();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((s) => s.id)).not.toContain('an');
    expect(result.data.every((s) => s.feedUrl !== null)).toBe(true);
  });
});

describe('cursor opacity (N2)', () => {
  it('round-trips through the adapter-owned encode/decode', () => {
    const cursor = cursorOf('2026-08-20T06:41:00.000Z', 'abc');
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects a decoded payload that is not a cursor', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const forged = Buffer.from(JSON.stringify({ p: 1, i: 2 }), 'utf8').toString('base64');
      expect(decodeCursor(forged)).toBeNull();
      const empty = Buffer.from(JSON.stringify({ p: '', i: '' }), 'utf8').toString('base64');
      expect(decodeCursor(empty)).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('orders strictly by (publishedAt, id) descending', () => {
    const cursor = cursorOf('2026-08-20T09:00:00.000Z', 'b');
    // Older instant: after the cursor.
    expect(isAfterCursor({ publishedAt: '2026-08-20T08:00:00.000Z', id: 'z' }, cursor)).toBe(true);
    // Same instant, lower id: after.
    expect(isAfterCursor({ publishedAt: '2026-08-20T09:00:00.000Z', id: 'a' }, cursor)).toBe(true);
    // The cursor row itself: not after, so a page never repeats its last item.
    expect(isAfterCursor({ publishedAt: '2026-08-20T09:00:00.000Z', id: 'b' }, cursor)).toBe(false);
    // Newer instant: before the cursor.
    expect(isAfterCursor({ publishedAt: '2026-08-20T10:00:00.000Z', id: 'a' }, cursor)).toBe(false);
  });

  it('is the single factory both adapters use, so paging stays continuous', async () => {
    const repos = createMockRepositories();
    const first = await repos.feed.listArticles({ limit: 2 });
    if (!first.ok || !first.data.nextCursor) throw new Error('expected a first page with a cursor');

    // The cursor a page hands back is accepted by the next call unchanged, and
    // survives the serialisation a persisted query cache would apply.
    const roundTripped = decodeCursor(encodeCursor(first.data.nextCursor));
    expect(roundTripped).toEqual(first.data.nextCursor);

    const second = await repos.feed.listArticles({ limit: 2, cursor: roundTripped });
    if (!second.ok) throw new Error('expected a second page');
    const firstIds = first.data.items.map((a) => a.id);
    const secondIds = second.data.items.map((a) => a.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });
});
