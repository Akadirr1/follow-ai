/**
 * Offline verification of `202608210007_internal_wrappers_ai.sql`.
 *
 * Same rule set P2 and P3 apply to their own migrations, extended for this one:
 * every function service_role-only, `search_path` pinned, no dynamic SQL, and
 * no table/view/type created in `public`.
 *
 * STATIC only. No database exists in this task, so nothing here proves Postgres
 * accepts the SQL or that the job state machine behaves — that is the
 * coordinator's remote apply and smoke.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROMPT_VERSION } from '../functions/_shared/prompt.ts';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const FILE = '202608210007_internal_wrappers_ai.sql';

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
// Scanner. Strips `--` comments everywhere, including inside dollar-quoted
// bodies, so prose is never scanned as code (the trap P3's copy documents).
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

const bytes = readFileSync(join(MIGRATIONS_DIR, FILE));
const raw = bytes.toString('utf8');
const sql = stripComments(raw);
const statements = splitStatements(sql);
const functions = statements.filter((s) => /^create\s+(or\s+replace\s+)?function\b/i.test(s));

/** The seven implementations this task adds in `aigundem`. */
const IMPLEMENTATIONS = [
  'aigundem.internal_complete_enrichment',
  'aigundem.internal_enqueue_ai_job',
  'aigundem.internal_fail_ai_job',
  'aigundem.internal_find_article_for_enrichment',
  'aigundem.internal_find_summary',
  'aigundem.internal_lease_enrichment_jobs',
  'aigundem.internal_retry_ai_job',
];

/** One transport shim each, per addendum §C.1. */
const SHIMS = IMPLEMENTATIONS.map((name) =>
  name.replace('aigundem.internal_', 'public.aigundem_internal_'),
);

// ---------------------------------------------------------------------------

describe('202608210007_internal_wrappers_ai.sql: hygiene', () => {
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

  it('drops and truncates nothing', () => {
    expect(sql.toLowerCase()).not.toMatch(/\bdrop\b/);
    expect(sql.toLowerCase()).not.toMatch(/\btruncate\b/);
  });

  it('never mentions the other application living in public', () => {
    const lower = sql.toLowerCase();
    for (const table of OTHER_APP_TABLES) {
      expect(lower).not.toMatch(new RegExp(`\\b${table}\\b`));
    }
    expect(lower).not.toMatch(/(^|[^._a-z])users\b/);
  });

  it('creates no table, view, type or index in public', () => {
    for (const stmt of statements) {
      expect(stmt.toLowerCase()).not.toMatch(
        /^create\s+(or\s+replace\s+)?(table|view|materialized\s+view|type|domain|index|unique\s+index|sequence|trigger)\s+(if\s+not\s+exists\s+)?public\./,
      );
    }
  });

  it('names no public object outside the approved aigundem_internal_ prefix', () => {
    for (const reference of sql.match(/public\.[a-z_][a-z_0-9]*/gi) ?? []) {
      expect({ reference, allowed: /^public\.aigundem_internal_/i.test(reference) }).toEqual({
        reference,
        allowed: true,
      });
    }
  });

  it('every statement starts with a known top-level keyword', () => {
    expect(statements.length).toBeGreaterThan(0);
    for (const stmt of statements) {
      expect(stmt).toMatch(/^(create|alter|comment|grant|revoke|notify)\b/i);
    }
  });

  it('has balanced parentheses in every statement', () => {
    for (const stmt of statements) {
      const scrubbed = stmt
        .replace(/\$([A-Za-z_][A-Za-z_0-9]*)?\$[\s\S]*?\$\1?\$/g, '$$$$')
        .replace(/'(?:[^']|'')*'/g, "''");
      const open = (scrubbed.match(/\(/g) ?? []).length;
      const close = (scrubbed.match(/\)/g) ?? []).length;
      expect({ stmt: stmt.slice(0, 60), open, close }).toEqual({
        stmt: stmt.slice(0, 60),
        open: close,
        close,
      });
    }
  });

  /**
   * `202608210007` is also the prefix of the coordinator's
   * `public_read_shims_catalog` migration, and `0006` already carries three
   * files. Recorded rather than renamed: the coordinator applies migrations by
   * name via `apply_migration`, where a shared version prefix is harmless;
   * `supabase db push` would collide. Addendum §C.1 puts P5's cron at 0008.
   */
  it('records the shared version prefix', () => {
    expect(FILE.startsWith('202608210007_')).toBe(true);
    expect(existsSync(join(MIGRATIONS_DIR, '202608210007_public_read_shims_catalog.sql'))).toBe(
      true,
    );
  });
});

describe('202608210007_internal_wrappers_ai.sql: functions', () => {
  it('creates exactly the seven helpers and their seven shims', () => {
    const created = functions
      .map((s) => /function\s+([a-z_]+\.[a-z_0-9]+)\s*\(/i.exec(s)?.[1])
      .filter((n): n is string => Boolean(n))
      .sort();
    expect(created).toEqual([...IMPLEMENTATIONS, ...SHIMS].sort());
  });

  it('makes every function SECURITY DEFINER with an empty search_path', () => {
    expect(functions).toHaveLength(IMPLEMENTATIONS.length + SHIMS.length);
    for (const fn of functions) {
      expect(fn.toLowerCase()).toContain('security definer');
      expect(fn.toLowerCase()).toContain("set search_path = ''");
    }
  });

  it('schema-qualifies every object reference, since nothing resolves implicitly', () => {
    for (const fn of functions) {
      for (const bare of [
        / from (?!aigundem\.|private\.|pg_catalog\.|\()/i,
        / into (?!aigundem\.|private\.|v_)/i,
        // `set` and `skip` exclude ON CONFLICT DO UPDATE SET and
        // FOR UPDATE SKIP LOCKED, neither of which names a table.
        / update (?!aigundem\.|private\.|set\b|skip\b)/i,
      ]) {
        expect({ fn: fn.slice(0, 62), match: bare.exec(fn)?.[0] ?? null }).toEqual({
          fn: fn.slice(0, 62),
          match: null,
        });
      }
    }
  });

  it('uses no dynamic SQL anywhere', () => {
    for (const fn of functions) {
      expect(fn.toLowerCase()).not.toMatch(/\bexecute\s+(format|'|"|\$|v_|p_)/);
      expect(fn.toLowerCase()).not.toContain('quote_ident');
      expect(fn.toLowerCase()).not.toContain('quote_literal');
    }
  });

  it('validates its arguments instead of trusting the caller', () => {
    for (const name of IMPLEMENTATIONS) {
      const fn = functions.find((f) => f.includes(`function ${name}(`))!;
      expect({ name, raises: fn.toLowerCase().includes('raise exception') }).toEqual({
        name,
        raises: true,
      });
    }
    // Anything carrying a hash checks it is really 64 hex characters.
    for (const name of [
      'aigundem.internal_find_summary',
      'aigundem.internal_enqueue_ai_job',
      'aigundem.internal_complete_enrichment',
    ]) {
      const fn = functions.find((f) => f.includes(`function ${name}(`))!;
      expect(fn).toContain('[0-9a-f]{64}');
    }
  });

  it('reuses P2 leasing rather than reimplementing SKIP LOCKED', () => {
    const lease = functions.find((f) =>
      f.includes('function aigundem.internal_lease_enrichment_jobs('),
    )!;
    expect(lease).toContain('private.lease_ai_jobs(n)');
    expect(lease.toLowerCase()).not.toContain('skip locked');
  });

  it('guards every write-back with the lease token — two workers, one write', () => {
    for (const name of [
      'aigundem.internal_complete_enrichment',
      'aigundem.internal_retry_ai_job',
      'aigundem.internal_fail_ai_job',
    ]) {
      const fn = functions.find((f) => f.includes(`function ${name}(`))!;
      expect(fn).toContain('j.lease_token = p_lease_token');
      expect(fn).toContain("j.status = 'leased'");
    }
  });

  it('closes the job and writes the summary in one transaction', () => {
    const complete = functions.find((f) =>
      f.includes('function aigundem.internal_complete_enrichment('),
    )!;
    // Claim first: no valid lease means no row updated and nothing written.
    expect(complete.indexOf('update private.ai_jobs')).toBeLessThan(
      complete.indexOf('insert into aigundem.article_summaries'),
    );
    expect(complete).toContain('if v_article_id is null then return false;');
    expect(complete.toLowerCase()).toContain('on conflict (article_id) do update');
  });

  it('assigns ROW_COUNT to an integer, not a boolean', () => {
    // GET DIAGNOSTICS ... = ROW_COUNT into a boolean is a 42804 at runtime.
    for (const fn of functions.filter((f) => f.toLowerCase().includes('get diagnostics'))) {
      expect(fn).toMatch(/v_rows\s+integer/);
      expect(fn).toContain('get diagnostics v_rows = row_count');
      expect(fn).toContain('return v_rows > 0;');
    }
  });

  it('never revives a failed job on enqueue', () => {
    const enqueue = functions.find((f) =>
      f.includes('function aigundem.internal_enqueue_ai_job('),
    )!;
    expect(enqueue.toLowerCase()).toContain('on conflict (article_id, content_hash, prompt_version, model) do nothing');
    // No status is written back on the conflict path.
    expect(enqueue.toLowerCase()).not.toMatch(/set\s+status\s*=/);
  });

  it('keeps each transport shim a delegate, not a second implementation', () => {
    for (const shim of SHIMS) {
      const local = shim.replace('public.aigundem_', 'aigundem.');
      const fn = functions.find((f) => f.includes(`function ${shim}(`))!;
      expect({ shim, defined: Boolean(fn) }).toEqual({ shim, defined: true });
      expect(fn).toContain(local);
      expect(fn.toLowerCase()).not.toMatch(/\b(insert into|delete from)\b/);
      expect(fn.toLowerCase()).not.toMatch(/update (aigundem|private)\./);
    }
  });
});

describe('202608210007_internal_wrappers_ai.sql: privileges', () => {
  const revokes = statements.filter((s) => /^revoke\b/i.test(s)).map((s) => s.toLowerCase());
  const grants = statements.filter((s) => /^grant\b/i.test(s)).map((s) => s.toLowerCase());

  it('revokes from public, anon and authenticated, then grants to service_role only', () => {
    for (const name of [...IMPLEMENTATIONS, ...SHIMS]) {
      expect({ name, revoked: revokes.some((r) => r.includes(name) && r.includes('from public, anon, authenticated')) })
        .toEqual({ name, revoked: true });
      expect({ name, granted: grants.some((g) => g.includes(name) && g.endsWith('to service_role')) })
        .toEqual({ name, granted: true });
    }
    expect(grants).toHaveLength(IMPLEMENTATIONS.length + SHIMS.length);
  });

  it('grants nothing to a client role', () => {
    for (const grant of grants) {
      expect(grant).not.toMatch(/\bto\b[^;]*\b(anon|authenticated)\b/);
    }
  });

  it('reloads the PostgREST schema cache so the new RPCs are callable at once', () => {
    expect(sql.toLowerCase()).toContain("notify pgrst, 'reload schema'");
  });
});

describe('the migration and the TypeScript agree', () => {
  it('exposes every RPC name the enrichment gateway calls', () => {
    // If these ever diverge the function 404s at runtime, remotely, after a
    // deploy — the most expensive place to find a typo.
    const called = [
      'internal_find_summary',
      'internal_find_article_for_enrichment',
      'internal_enqueue_ai_job',
      'internal_lease_enrichment_jobs',
      'internal_complete_enrichment',
      'internal_retry_ai_job',
      'internal_fail_ai_job',
    ];
    const gateway = readFileSync(
      join(__dirname, '..', 'functions', '_shared', 'enrichment-db.ts'),
      'utf8',
    );
    for (const name of called) {
      expect({ name, inGateway: gateway.includes(`'${name}'`) }).toEqual({ name, inGateway: true });
      expect({ name, inSql: sql.includes(`aigundem.${name}(`) }).toEqual({ name, inSql: true });
      expect({ name, shimmed: sql.includes(`public.aigundem_${name}(`) }).toEqual({
        name,
        shimmed: true,
      });
    }
  });

  it('reuses the rate-limit wrapper P2/P3 already published instead of adding another', () => {
    const gateway = readFileSync(
      join(__dirname, '..', 'functions', '_shared', 'enrichment-db.ts'),
      'utf8',
    );
    expect(gateway).toContain("'internal_bump_rate_limit'");
    expect(sql).not.toContain('internal_bump_rate_limit');
  });

  it('keeps the prompt version inside the column width P2 allows', () => {
    expect(PROMPT_VERSION.length).toBeGreaterThanOrEqual(1);
    expect(PROMPT_VERSION.length).toBeLessThanOrEqual(64);
  });
});
