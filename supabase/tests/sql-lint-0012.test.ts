/**
 * Offline verification of `202608210012_digest_candidates.sql`.
 *
 * This migration is the first thing in the project that spends money without a
 * human asking for it: it enqueues enrichment jobs on a schedule. Three
 * properties therefore get pinned rather than trusted —
 *
 *   1. the anti-join, without which every prepare re-enqueues the whole window
 *      and `on conflict do nothing` becomes the only thing standing between the
 *      project and a duplicate-call bill;
 *   2. the per-source cap and the overall cap, which ARE the daily spend bound;
 *   3. the window derivation, which must be character-for-character the one
 *      0010's digest functions use — an article enqueued from a window the
 *      finalizer does not share is a call whose result can never appear in a
 *      digest.
 *
 * STATIC only. No database exists in this task, so nothing here proves Postgres
 * accepts the SQL, that the CTE plans the way it reads, or that the counts come
 * back right.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const FILE = '202608210012_digest_candidates.sql';

const bytes = readFileSync(join(MIGRATIONS_DIR, FILE));
const raw = bytes.toString('utf8');

/** Strip `--` comments so prose is never scanned as code. */
function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const at = line.indexOf('--');
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

const sql = stripComments(raw);
const collapsed = sql.replace(/\s+/g, ' ');

const SIGNATURE = '(date, text, text, integer, integer)';

describe('202608210012: hygiene', () => {
  it('exists, is UTF-8, has no BOM, no CRLF and one trailing newline', () => {
    expect(existsSync(join(MIGRATIONS_DIR, FILE))).toBe(true);
    expect(raw).not.toContain('�');
    expect(Buffer.from(raw, 'utf8').equals(bytes)).toBe(true);
    expect(raw.charCodeAt(0)).not.toBe(0xfeff);
    expect(raw).not.toContain('\r');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.endsWith('\n\n')).toBe(false);
  });

  it('contains no backslash', () => {
    expect(raw.includes('\\')).toBe(false);
  });

  it('is additive: it drops nothing, replaces nothing and truncates nothing', () => {
    expect(sql.toLowerCase()).not.toMatch(/\bdrop\s+(function|table|view|index|schema)\b/);
    expect(sql.toLowerCase()).not.toMatch(/\btruncate\b/);
    // Two brand-new functions. Nothing existing is re-created, so rolling back
    // means not applying it, never restoring a previous body.
    expect(sql.toLowerCase()).not.toContain('create or replace');
  });

  it('creates exactly the implementation and its transport shim', () => {
    const created = sql.match(/create\s+function\s+[a-z_.]+/gi) ?? [];
    expect(created).toHaveLength(2);
    expect(created[0]).toContain('aigundem.internal_enqueue_digest_candidates');
    expect(created[1]).toContain('public.aigundem_internal_enqueue_digest_candidates');
    // No table, view or type in `public` — another app lives there.
    expect(sql.toLowerCase()).not.toMatch(/create\s+(table|view|type|index)\s/);
  });

  it('reloads the PostgREST schema cache', () => {
    expect(sql.toLowerCase()).toContain("notify pgrst, 'reload schema'");
  });
});

describe('202608210012: the security shape every internal function carries', () => {
  it('is SECURITY DEFINER with an empty search_path, twice', () => {
    expect(collapsed.match(/security definer/g)).toHaveLength(2);
    expect(collapsed.match(/set search_path = ''/g)).toHaveLength(2);
  });

  it('schema-qualifies every object it touches', () => {
    for (const ref of [
      'aigundem.articles a',
      'aigundem.sources s',
      'aigundem.article_summaries m',
      'private.ai_jobs',
    ]) {
      expect({ ref, present: collapsed.includes(ref) }).toEqual({ ref, present: true });
    }
    // With search_path = '' an unqualified name cannot resolve at all, so this
    // is a correctness check as much as a security one.
    expect(collapsed).not.toMatch(/\bfrom\s+articles\b/);
    expect(collapsed).not.toMatch(/\bjoin\s+sources\b/);
  });

  it('uses no dynamic SQL', () => {
    // `grant execute on function` legitimately contains the word; only a
    // dynamic EXECUTE is a finding.
    expect(collapsed.toLowerCase()).not.toMatch(/\bexecute\s+(format|'|"|\$|v_|p_)/);
    expect(collapsed.toLowerCase()).not.toContain('quote_ident');
    expect(collapsed.toLowerCase()).not.toContain('quote_literal');
  });

  it('validates every argument', () => {
    for (const guard of [
      'date out of range',
      'invalid model',
      'invalid prompt_version',
      'per_source must be between 1 and 5',
      'limit must be between 1 and 50',
    ]) {
      expect({ guard, present: collapsed.includes(guard) }).toEqual({ guard, present: true });
    }
    expect(collapsed).toContain("errcode = '22023'");
  });

  it('carries the variable_conflict pragma that 0009 had to add', () => {
    expect(sql).toContain('#variable_conflict use_column');
  });

  it('revokes from public/anon/authenticated and grants to service_role only', () => {
    for (const fn of [
      'aigundem.internal_enqueue_digest_candidates',
      'public.aigundem_internal_enqueue_digest_candidates',
    ]) {
      expect(collapsed).toContain(
        `revoke all on function ${fn}${SIGNATURE} from public, anon, authenticated`,
      );
      expect(collapsed).toContain(`grant execute on function ${fn}${SIGNATURE} to service_role`);
    }
    expect(collapsed).not.toMatch(/grant[^;]*to[^;]*\b(anon|authenticated)\b/);
  });
});

describe('202608210012: the candidate set', () => {
  it('selects only active sources, inside the window, with a body', () => {
    expect(collapsed).toContain("s.status = 'active'");
    expect(collapsed).toContain('a.published_at >= v_start');
    expect(collapsed).toContain('a.published_at < v_end');
    // fix-003: a body-less item cannot be summarised, so enqueueing one buys a
    // guaranteed `no_content` refusal.
    expect(collapsed).toContain('a.content_text is not null');
    expect(collapsed).toContain("btrim(a.content_text) <> ''");
  });

  it('anti-joins on the FULL summary cache key, not just the article', () => {
    // Dropping any one of these four turns the function into either a re-enqueue
    // of the whole window every night, or a permanent skip of articles whose
    // body changed.
    const antiJoin = /not exists \(([^)]*?)\)/.exec(collapsed.replace(/\s+/g, ' '));
    expect(antiJoin).not.toBeNull();
    const body = antiJoin?.[1] ?? '';
    expect(body).toContain('aigundem.article_summaries m');
    expect(body).toContain('m.article_id = a.id');
    expect(body).toContain('m.content_hash = a.content_hash');
    expect(body).toContain('m.prompt_version = p_prompt_version');
    expect(body).toContain('m.model = p_model');
  });

  it('ranks newest-first within each source and caps at p_per_source', () => {
    expect(collapsed).toContain('partition by p.source_id');
    expect(collapsed).toContain('order by p.published_at desc, p.article_id desc');
    expect(collapsed).toContain('r.source_rank <= p_per_source');
  });

  it('caps the run overall, deterministically', () => {
    // `limit` without a total order would pick an arbitrary subset on a tie —
    // arXiv stamps a whole batch with the same minute.
    expect(collapsed).toContain('order by r.published_at desc, r.article_id desc limit p_limit');
  });

  it('derives the window exactly the way 0010 does', () => {
    const zeroTen = stripComments(
      readFileSync(join(MIGRATIONS_DIR, '202608210010_rev003_blockers.sql'), 'utf8'),
    ).replace(/\s+/g, ' ');

    for (const clause of [
      "v_end := (v_date + time '05:00') at time zone 'Europe/Istanbul';",
      "v_start := v_end - interval '24 hours';",
      "v_date := coalesce(p_date, (now() at time zone 'Europe/Istanbul')::date);",
    ]) {
      const needle = clause.replace(/\s+/g, ' ');
      expect({ clause, inThis: collapsed.includes(needle) }).toEqual({ clause, inThis: true });
      expect({ clause, in0010: zeroTen.includes(needle) }).toEqual({ clause, in0010: true });
    }
  });
});

describe('202608210012: the insert', () => {
  it('inserts into private.ai_jobs on 0004 cache key with do nothing', () => {
    expect(collapsed).toContain(
      'insert into private.ai_jobs (article_id, content_hash, prompt_version, model)',
    );
    // The same unique index request-enrichment relies on. `do nothing` is what
    // makes a second prepare on the same day free, and what stops a job that
    // already failed from being resurrected.
    expect(collapsed).toContain(
      'on conflict (article_id, content_hash, prompt_version, model) do nothing',
    );
    expect(collapsed).not.toContain('do update');
  });

  it('charges no rate limit: this is the system spending its own budget', () => {
    // Charging would need a subject, and any subject invented here belongs to
    // some real device whose 30/day would silently shrink.
    expect(collapsed).not.toContain('bump_rate_limit');
    expect(collapsed).not.toContain('rate_limit_buckets');
    expect(collapsed).not.toContain('p_subject');
  });

  it('counts candidates and inserts from ONE statement', () => {
    // A count-then-insert pair reads two snapshots under READ COMMITTED, and
    // `already = candidates - enqueued` would then be arithmetic on two
    // different worlds.
    expect(collapsed).toContain('select (select count(*) from picked), (select count(*) from ins)');
    expect(collapsed).toContain('into v_candidates, v_enqueued;');
    expect(collapsed).toContain('return query select v_enqueued, v_candidates - v_enqueued, v_candidates;');
  });

  it('returns the three counts the function advertises', () => {
    expect(collapsed.match(/returns table \( enqueued integer, already integer, candidates integer \)/g))
      .toHaveLength(2);
  });
});

describe('0012 and the TypeScript agree', () => {
  const digest = readFileSync(
    join(__dirname, '..', 'functions', '_shared', 'digest.ts'),
    'utf8',
  );

  it('uses the same RPC name and argument names', () => {
    // A typo here surfaces as a 404 on the live project, after a deploy.
    expect(digest).toContain("'internal_enqueue_digest_candidates'");
    for (const arg of ['p_date', 'p_model', 'p_prompt_version', 'p_per_source', 'p_limit']) {
      expect({ arg, inSql: collapsed.includes(arg) }).toEqual({ arg, inSql: true });
      expect({ arg, inTs: digest.includes(`${arg}:`) }).toEqual({ arg, inTs: true });
    }
  });

  it('agrees on the ranges the SQL will accept', () => {
    const enqueue = readFileSync(
      join(__dirname, '..', 'functions', '_shared', 'digest-enqueue.ts'),
      'utf8',
    );
    expect(enqueue).toContain('MAX_DIGEST_PER_SOURCE = 5');
    expect(enqueue).toContain('MAX_DIGEST_CANDIDATES = 50');
    expect(collapsed).toContain('p_per_source not between 1 and 5');
    expect(collapsed).toContain('p_limit not between 1 and 50');
  });
});
