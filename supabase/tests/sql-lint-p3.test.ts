/**
 * Offline verification of the two migrations this task adds:
 *   202608210006_internal_wrappers.sql
 *   202608210006_seed_default_sources.sql
 *
 * Same discipline as P2's `sql-lint.test.ts`, which lints only the five files
 * it owns and is left untouched here. The scanner is duplicated rather than
 * shared because this task may only ADD files under `supabase/tests/`; folding
 * both copies into one `sql-scan.ts` is a worthwhile follow-up.
 *
 * One difference from P2's copy: `stripComments` here also strips `--` comments
 * INSIDE dollar-quoted function bodies. P2's copy keeps those bodies verbatim,
 * so prose in a body reaches the code checks — which is how "arch-001 §3
 * forbids from leaving the database" got read as an unqualified `FROM`. The
 * split on `;` still treats a dollar-quoted body as opaque, which is what that
 * part is for.
 *
 * This is a STATIC check. No database exists in this task, so nothing below
 * proves Postgres accepts the SQL, that the wrappers behave, or that the seed
 * lands six rows. Those belong to the coordinator's remote apply and smoke.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalizeUrl } from '../functions/_shared/url.ts';
import { urlHashHex } from '../functions/_shared/hash.ts';
import { CATEGORIES } from '../functions/_shared/supabase-admin.ts';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const WRAPPERS = '202608210006_internal_wrappers.sql';
const SEED = '202608210006_seed_default_sources.sql';
const FILES = [WRAPPERS, SEED] as const;

const OTHER_APP_TABLES = [
  'barbers',
  'barber_services',
  'barber_schedule',
  'barber_holidays',
  'bookings',
  'cancellations',
  'jwt_sessions',
  'audit_log',
] as const;

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const DOLLAR_TAG = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/;

function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const pair = source.slice(i, i + 2);
    if (pair === '--') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (pair === '/*') {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source.slice(i, i + 2) === '/*') { depth += 1; i += 2; }
        else if (source.slice(i, i + 2) === '*/') { depth -= 1; i += 2; }
        else i += 1;
      }
      continue;
    }
    if (source[i] === "'") {
      out += "'";
      i += 1;
      while (i < source.length) {
        if (source[i] === "'") {
          if (source[i + 1] === "'") { out += "''"; i += 2; continue; }
          out += "'"; i += 1; break;
        }
        out += source[i]; i += 1;
      }
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      current += "'";
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { current += "''"; i += 2; continue; }
          current += "'"; i += 1; break;
        }
        current += sql[i]; i += 1;
      }
      continue;
    }
    const tag = DOLLAR_TAG.exec(sql.slice(i));
    if (tag) {
      const marker = tag[0];
      const end = sql.indexOf(marker, i + marker.length);
      const stop = end === -1 ? sql.length : end + marker.length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (sql[i] === ';') { statements.push(current); current = ''; i += 1; continue; }
    current += sql[i];
    i += 1;
  }
  if (current.trim() !== '') statements.push(current);
  return statements.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s !== '');
}

type Migration = { file: string; raw: string; bytes: Buffer; sql: string; statements: string[] };

const migrations: Migration[] = FILES.map((file) => {
  const bytes = readFileSync(join(MIGRATIONS_DIR, file));
  const raw = bytes.toString('utf8');
  const sql = stripComments(raw);
  return { file, raw, bytes, sql, statements: splitStatements(sql) };
});

const byFile = (file: string) => migrations.find((m) => m.file === file)!;

// ---------------------------------------------------------------------------
// Shared hygiene (the rules P2's lint applies to migrations 0001-0005)
// ---------------------------------------------------------------------------

describe('migrations 0006: hygiene', () => {
  it.each(FILES)('%s exists, is UTF-8, has no BOM and no CRLF', (file) => {
    expect(existsSync(join(MIGRATIONS_DIR, file))).toBe(true);
    const m = byFile(file);
    expect(m.raw).not.toContain('�');
    expect(Buffer.from(m.raw, 'utf8').equals(m.bytes)).toBe(true);
    expect(m.raw.charCodeAt(0)).not.toBe(0xfeff);
    expect(m.raw).not.toContain('\r');
    expect(m.raw.endsWith('\n')).toBe(true);
    expect(m.raw.endsWith('\n\n')).toBe(false);
  });

  it.each(FILES)('%s contains no backslash', (file) => {
    expect(byFile(file).raw.includes('\\')).toBe(false);
  });

  /**
   * The seed touches `public` not at all. The wrappers file does — but only
   * through the `public.aigundem_internal_*` FUNCTIONS the coordinator approved
   * (addendum §C.1) as a transport shim while `aigundem` is unexposed. No
   * table, view, type or index may appear in `public`: that is where the
   * unrelated application lives.
   */
  it('the seed creates nothing in and reads nothing from public', () => {
    expect(byFile(SEED).sql.toLowerCase()).not.toContain('public.');
  });

  it.each(FILES)('%s creates no table, view, type or index in public', (file) => {
    for (const stmt of byFile(file).statements) {
      expect(stmt.toLowerCase()).not.toMatch(
        /^create\s+(or\s+replace\s+)?(table|view|materialized\s+view|type|domain|index|unique\s+index|sequence|trigger)\s+(if\s+not\s+exists\s+)?public\./,
      );
    }
  });

  it.each(FILES)('%s only ever names public objects it is allowed to', (file) => {
    const references = byFile(file).sql.match(/public\.[a-z_][a-z_0-9]*/gi) ?? [];
    for (const reference of references) {
      expect({ file, reference, allowed: /^public\.aigundem_internal_/i.test(reference) }).toEqual(
        { file, reference, allowed: true },
      );
    }
  });

  it.each(FILES)('%s drops and truncates nothing', (file) => {
    const sql = byFile(file).sql.toLowerCase();
    expect(sql).not.toMatch(/\bdrop\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
  });

  it.each(FILES)('%s never mentions the other application on this project', (file) => {
    const sql = byFile(file).sql.toLowerCase();
    for (const table of OTHER_APP_TABLES) {
      expect(sql).not.toMatch(new RegExp(`\\b${table}\\b`));
    }
    expect(sql).not.toMatch(/(^|[^._a-z])users\b/);
  });

  it.each(FILES)('%s splits into statements that all start with a known keyword', (file) => {
    const m = byFile(file);
    expect(m.statements.length).toBeGreaterThan(0);
    for (const stmt of m.statements) {
      expect(stmt).toMatch(/^(create|alter|comment|grant|revoke|notify|insert|do|set)\b/i);
    }
  });

  /**
   * Both files carry the version prefix 202608210006. The brief pinned the seed
   * filename and the coordinator pinned the wrappers filename, so this is
   * recorded rather than silently renamed: `supabase db push` derives one
   * version per file and would collide. Applying them with explicit names via
   * the MCP `apply_migration` is unaffected. Alphabetical order puts the
   * wrappers first, which is also the safe order.
   */
  it('documents the shared version prefix and the resulting apply order', () => {
    expect(WRAPPERS.slice(0, 12)).toBe(SEED.slice(0, 12));
    expect([...FILES].sort()).toEqual([WRAPPERS, SEED]);
  });
});

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

describe('202608210006_internal_wrappers.sql', () => {
  const m = byFile(WRAPPERS);
  const functions = m.statements.filter((s) =>
    /^create\s+(or\s+replace\s+)?function\b/i.test(s),
  );

  /** Every write the two Edge Functions perform, and nothing else. */
  const IMPLEMENTATIONS = [
    'aigundem.internal_finish_ingestion_run',
    'aigundem.internal_lease_source',
    'aigundem.internal_start_ingestion_run',
    'aigundem.internal_update_source_fetch_state',
    'aigundem.internal_upsert_articles',
    'aigundem.internal_upsert_source',
    'private.lease_due_sources',
  ];

  /**
   * The transport shims (addendum §C.1). One per call the gateway makes —
   * including `lease_due_sources` and `bump_rate_limit`, whose implementations
   * P2 already created in `aigundem`, so they appear here only as shims.
   */
  const SHIMS = [
    'public.aigundem_internal_bump_rate_limit',
    'public.aigundem_internal_finish_ingestion_run',
    'public.aigundem_internal_lease_due_sources',
    'public.aigundem_internal_lease_source',
    'public.aigundem_internal_start_ingestion_run',
    'public.aigundem_internal_update_source_fetch_state',
    'public.aigundem_internal_upsert_articles',
    'public.aigundem_internal_upsert_source',
  ];

  it('creates every helper the two functions call, and nothing more', () => {
    const created = functions
      .map((s) => /function\s+([a-z_]+\.[a-z_0-9]+)\s*\(/i.exec(s)?.[1])
      .filter((n): n is string => Boolean(n))
      .sort();
    expect(created).toEqual([...IMPLEMENTATIONS, ...SHIMS].sort());
  });

  it('makes every function SECURITY DEFINER with an empty search_path', () => {
    expect(functions.length).toBe(IMPLEMENTATIONS.length + SHIMS.length);
    for (const fn of functions) {
      expect(fn.toLowerCase()).toContain('security definer');
      expect(fn.toLowerCase()).toContain("set search_path = ''");
    }
  });

  it('uses no dynamic SQL anywhere', () => {
    for (const fn of functions) {
      expect(fn.toLowerCase()).not.toMatch(/\bexecute\s+(format|'|"|\$|v_|p_)/);
      expect(fn.toLowerCase()).not.toContain('quote_ident');
      expect(fn.toLowerCase()).not.toContain('quote_literal');
    }
  });

  it('keeps each transport shim a delegate, not a second implementation', () => {
    for (const shim of SHIMS) {
      const local = shim.replace('public.aigundem_', 'aigundem.');
      const fn = functions.find((f) => f.includes(`function ${shim}(`))!;
      expect({ shim, defined: Boolean(fn) }).toEqual({ shim, defined: true });
      // The body calls the aigundem implementation and does nothing else:
      // no table of its own is read or written.
      expect(fn).toContain(local);
      expect(fn.toLowerCase()).not.toMatch(/\b(insert into|update aigundem\.|delete from)\b/);
    }
  });

  it('schema-qualifies every object reference, since nothing resolves implicitly', () => {
    for (const fn of functions) {
      for (const bare of [
        / from (?!aigundem\.|private\.|pg_catalog\.|due\b|jsonb_array_elements\b|\()/i,
        / into (?!aigundem\.|private\.|v_)/i,
        // `set` and `skip` exclude `ON CONFLICT DO UPDATE SET` and
        // `FOR UPDATE SKIP LOCKED`, neither of which names a table.
        / update (?!aigundem\.|private\.|set\b|skip\b)/i,
      ]) {
        expect({ fn: fn.slice(0, 60), match: bare.exec(fn)?.[0] ?? null }).toEqual({
          fn: fn.slice(0, 60),
          match: null,
        });
      }
    }
  });

  it('validates its arguments instead of trusting the caller', () => {
    for (const name of [
      'internal_lease_source',
      'internal_start_ingestion_run',
      'internal_finish_ingestion_run',
      'internal_update_source_fetch_state',
      'internal_upsert_articles',
      'internal_upsert_source',
    ]) {
      const fn = functions.find((f) => f.includes(name))!;
      expect({ name, raises: fn.toLowerCase().includes('raise exception') }).toEqual({
        name,
        raises: true,
      });
    }
  });

  it('isolates each article so one bad item cannot roll back the batch', () => {
    const upsert = functions.find((f) => f.includes('internal_upsert_articles'))!;
    // A BEGIN/EXCEPTION block inside the loop is a plpgsql subtransaction.
    expect(upsert.toLowerCase()).toContain('exception when others then');
    expect(upsert.toLowerCase()).toContain('v_failed := v_failed + 1');
    // Only the SQLSTATE is kept: sqlerrm could quote the article body.
    expect(upsert.toLowerCase()).toContain('v_errors || sqlstate');
    expect(upsert.toLowerCase()).not.toContain('sqlerrm');
  });

  it('bounds the batch it will accept', () => {
    const upsert = functions.find((f) => f.includes('internal_upsert_articles'))!;
    expect(upsert.toLowerCase()).toContain('jsonb_array_length(p_articles) > 500');
  });

  it('widens the lease to pending sources, or add-source rows stay invisible forever', () => {
    const lease = functions.find((f) => f.includes('private.lease_due_sources'))!;
    expect(lease.toLowerCase()).toContain("s.status in ('active', 'pending')");
    expect(lease.toLowerCase()).toContain('for update skip locked');
    // Signature unchanged, so P2's wrapper and grants keep working.
    expect(lease.toLowerCase()).toContain('create or replace function private.lease_due_sources(n integer)');
    expect(lease.toLowerCase()).toContain('returns setof aigundem.sources');
  });

  it('promotes a pending source only after a successful fetch', () => {
    const state = functions.find((f) => f.includes('internal_update_source_fetch_state'))!;
    expect(state.toLowerCase()).toContain("when p_ok then 'active'::aigundem.source_status");
    expect(state.toLowerCase()).toContain("then 'failed'::aigundem.source_status");
  });

  it('revokes EXECUTE from PUBLIC and grants it to service_role alone', () => {
    const revokes = m.statements.filter((s) => /^revoke\b/i.test(s)).map((s) => s.toLowerCase());
    const grants = m.statements.filter((s) => /^grant\b/i.test(s)).map((s) => s.toLowerCase());

    const newFunctions = [
      'aigundem.internal_lease_source',
      'aigundem.internal_start_ingestion_run',
      'aigundem.internal_finish_ingestion_run',
      'aigundem.internal_update_source_fetch_state',
      'aigundem.internal_upsert_articles',
      'aigundem.internal_upsert_source',
      ...SHIMS,
    ];
    for (const name of newFunctions) {
      expect({ name, revoked: revokes.some((r) => r.includes(name) && r.includes('from public')) })
        .toEqual({ name, revoked: true });
      expect({ name, granted: grants.some((g) => g.includes(name) && g.endsWith('to service_role')) })
        .toEqual({ name, granted: true });
    }
    // Nothing here is EXECUTE-able by a client role: every grant ends at
    // service_role, and the shims additionally revoke anon/authenticated
    // explicitly because PostgREST advertises them in `public`.
    for (const grant of grants) {
      expect(grant).not.toMatch(/\bto\b[^;]*\b(anon|authenticated)\b/);
    }
    for (const shim of SHIMS) {
      expect(
        revokes.some((r) => r.includes(shim) && r.includes('anon, authenticated')),
      ).toBe(true);
    }
    expect(grants).toHaveLength(newFunctions.length);
  });

  it('reloads the PostgREST schema cache so the new RPCs are callable at once', () => {
    expect(m.sql.toLowerCase()).toContain("notify pgrst, 'reload schema'");
  });
});

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/** The six defaults, as the seed must state them. */
const EXPECTED_SEED = [
  ['openai-blog', 'OpenAI Blog', 'https://openai.com/news/rss.xml', 'en', 'Modeller'],
  ['google-deepmind', 'Google DeepMind', 'https://deepmind.google/blog/rss.xml', 'en', 'Araştırma'],
  ['hugging-face', 'Hugging Face', 'https://huggingface.co/blog/feed.xml', 'en', 'Açık Kaynak'],
  ['arxiv-cs-ai', 'arXiv cs.AI', 'https://rss.arxiv.org/rss/cs.AI', 'en', 'Araştırma'],
  [
    'techcrunch-ai',
    'TechCrunch AI',
    'https://techcrunch.com/category/artificial-intelligence/feed/',
    'en',
    'Ürün',
  ],
  ['webrazzi-ai', 'Webrazzi AI', 'https://webrazzi.com/kategori/yapay-zeka/feed/', 'tr', 'Türkiye'],
] as const;

describe('202608210006_seed_default_sources.sql', () => {
  const m = byFile(SEED);
  const insert = m.statements.find((s) => /^insert\s+into\s+aigundem\.sources\b/i.test(s))!;

  it('is one INSERT into aigundem.sources', () => {
    expect(insert).toBeDefined();
    expect(m.statements.filter((s) => /^insert\b/i.test(s))).toHaveLength(1);
  });

  it('seeds exactly six sources', () => {
    const hashes = insert.match(/decode\('[0-9a-f]{64}', 'hex'\)/g) ?? [];
    expect(hashes).toHaveLength(6);
    expect(new Set(hashes).size).toBe(6);
  });

  it('names each source with its measured URL, language and category', () => {
    for (const [slug, name, feedUrl, language, category] of EXPECTED_SEED) {
      expect(insert).toContain(`'${slug}'`);
      expect(insert).toContain(`'${name}'`);
      expect(insert).toContain(`'${feedUrl}'`);
      void language;
      void category;
    }
    // Turkish is Webrazzi's alone.
    expect((insert.match(/'tr', 'Türkiye'/g) ?? [])).toHaveLength(1);
    expect((insert.match(/'en', /g) ?? [])).toHaveLength(5);
  });

  it('uses only the five real categories', () => {
    for (const [, , , , category] of EXPECTED_SEED) {
      expect(CATEGORIES).toContain(category);
    }
    expect(insert).not.toContain('Tümü');
  });

  it('ships NO Anthropic row: it has no first-party feed (addendum D)', () => {
    const sql = m.raw.toLowerCase();
    expect(m.sql.toLowerCase()).not.toContain('anthropic');
    // The reason is recorded in the file's comments, not just absent.
    expect(sql).toContain('anthropic has no first-party feed');
  });

  it('marks every seeded row default and active', () => {
    expect((insert.match(/true, 'active', now\(\)/g) ?? [])).toHaveLength(6);
  });

  it('is idempotent on the partial unique index P2 created', () => {
    const lower = insert.toLowerCase();
    expect(lower).toContain('on conflict (slug) where is_default do update');
    // Ingestion state must survive a re-apply, or every re-run re-fetches all.
    for (const column of ['status', 'etag', 'next_fetch_at', 'consecutive_failures']) {
      expect(lower).not.toMatch(new RegExp(`set[\\s\\S]*\\b${column}\\s*=\\s*excluded`));
    }
    for (const column of ['name', 'feed_url', 'feed_url_hash', 'site_url', 'language', 'category']) {
      expect(lower).toContain(`${column} = excluded.${column}`);
    }
  });

  /**
   * The cross-writer check. `feed_url_hash` is a UNIQUE column and the only key
   * that stops `add-source` creating a duplicate row for an already-seeded
   * feed. SQL states it as a hex literal; TypeScript derives it from the same
   * URL at runtime. If the two ever disagree the duplicate appears silently, so
   * they are compared here rather than trusted.
   */
  it('embeds hashes that match what add-source computes for the same URL', async () => {
    for (const [slug, , feedUrl] of EXPECTED_SEED) {
      // The seeded URL must already be canonical, or the two writers key on
      // different strings.
      expect({ slug, canonical: canonicalizeUrl(feedUrl) }).toEqual({ slug, canonical: feedUrl });

      const expected = await urlHashHex(feedUrl);
      expect(expected).toMatch(/^[0-9a-f]{64}$/);
      expect({ slug, present: insert.includes(`decode('${expected}', 'hex')`) }).toEqual({
        slug,
        present: true,
      });
    }
  });
});
