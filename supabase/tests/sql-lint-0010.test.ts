/**
 * Offline verification of `202608210010_rev003_blockers.sql`.
 *
 * Same rule set the other migration lints apply, plus one assertion per rev-003
 * finding this migration closes — B1, B4, N1, N5 — so a later edit cannot
 * quietly undo a fix that has an incident behind it.
 *
 * STATIC only. No database exists in this task, so nothing here proves Postgres
 * accepts the SQL, that `for update` actually serialises two finalizers, or
 * that `get diagnostics` reports what the insert wrote. Those are the
 * coordinator's remote apply and smoke; agents/reports/fix-004.md lists them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const FILE = '202608210010_rev003_blockers.sql';

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
// Scanner (strips `--` comments everywhere, dollar-quoted bodies included).
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

const fn = (name: string): string => {
  const found = functions.find((f) => f.includes(`function ${name}(`));
  if (!found) throw new Error(`function not found in 0010: ${name}`);
  return found;
};

/** Brand-new in this migration. */
const NEW_FUNCTIONS = [
  'aigundem.internal_release_ai_job_unattempted',
  'aigundem.internal_enqueue_ai_job_charged',
  'public.aigundem_internal_release_ai_job_unattempted',
  'public.aigundem_internal_enqueue_ai_job_charged',
];

/** Re-created because applied migrations are immutable. */
const REPLACED_FUNCTIONS = [
  'aigundem.internal_update_source_fetch_state',
  'aigundem.internal_digest_prepare',
  'aigundem.internal_digest_finalize',
];

// ---------------------------------------------------------------------------

describe('202608210010: hygiene', () => {
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

  it('drops no object and truncates nothing', () => {
    // Additive by construction: create-or-replace only, so a revert is
    // re-applying the previous body rather than undoing a write.
    expect(sql.toLowerCase()).not.toMatch(/\bdrop\s+(function|table|view|index|schema)\b/);
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
      expect(stmt).toMatch(/^(create|comment|grant|revoke|notify)\b/i);
    }
  });

  it('reloads the PostgREST schema cache', () => {
    expect(sql.toLowerCase()).toContain("notify pgrst, 'reload schema'");
  });
});

describe('202608210010: the shared safety rules', () => {
  it('creates exactly the four new functions and re-creates the three others', () => {
    const created = functions
      .map((s) => /function\s+([a-z_]+\.[a-z_0-9]+)\s*\(/i.exec(s)?.[1])
      .filter((n): n is string => Boolean(n))
      .sort();
    expect(created).toEqual([...NEW_FUNCTIONS, ...REPLACED_FUNCTIONS].sort());
  });

  it('makes every function SECURITY DEFINER with an empty search_path', () => {
    for (const name of [...NEW_FUNCTIONS, ...REPLACED_FUNCTIONS]) {
      const body = fn(name);
      expect({ name, definer: body.toLowerCase().includes('security definer') }).toEqual({
        name,
        definer: true,
      });
      expect({ name, pinned: body.toLowerCase().includes("set search_path = ''") }).toEqual({
        name,
        pinned: true,
      });
    }
  });

  it('uses no dynamic SQL anywhere', () => {
    for (const body of functions) {
      expect(body.toLowerCase()).not.toMatch(/\bexecute\s+(format|'|"|\$|v_|p_)/);
      expect(body.toLowerCase()).not.toContain('quote_ident');
      expect(body.toLowerCase()).not.toContain('quote_literal');
    }
  });

  it('validates its arguments instead of trusting the caller', () => {
    for (const name of [...NEW_FUNCTIONS, ...REPLACED_FUNCTIONS]) {
      expect({ name, raises: fn(name).toLowerCase().includes('raise exception') }).toEqual({
        name,
        raises: true,
      });
    }
  });

  /**
   * The 42702 that 0009 had to fix: `returns table (status text, ...)` declares
   * OUT variables named like the columns, and PL/pgSQL refuses to guess inside
   * `on conflict (...)`. Every function here with a colliding OUT name carries
   * the pragma.
   */
  it('pins #variable_conflict use_column wherever an OUT name shadows a column', () => {
    for (const name of [
      'aigundem.internal_enqueue_ai_job_charged',
      'aigundem.internal_digest_prepare',
      'aigundem.internal_digest_finalize',
    ]) {
      expect({ name, pragma: fn(name).includes('#variable_conflict use_column') }).toEqual({
        name,
        pragma: true,
      });
    }
  });

  it('revokes from public/anon/authenticated and grants only to service_role', () => {
    const revokes = statements.filter((s) => /^revoke\b/i.test(s)).map((s) => s.toLowerCase());
    const grants = statements.filter((s) => /^grant\b/i.test(s)).map((s) => s.toLowerCase());

    for (const name of [...NEW_FUNCTIONS, ...REPLACED_FUNCTIONS]) {
      expect({
        name,
        revoked: revokes.some((r) => r.includes(name) && r.includes('from public, anon, authenticated')),
      }).toEqual({ name, revoked: true });
      expect({
        name,
        granted: grants.some((g) => g.includes(name) && g.endsWith('to service_role')),
      }).toEqual({ name, granted: true });
    }
    // Privileges survive CREATE OR REPLACE; re-asserting them keeps the current
    // state readable from this file alone.
    expect(grants).toHaveLength(NEW_FUNCTIONS.length + REPLACED_FUNCTIONS.length);
    for (const grant of grants) {
      expect(grant).not.toMatch(/\bto\b[^;]*\b(anon|authenticated)\b/);
    }
  });

  it('keeps each transport shim a delegate, not a second implementation', () => {
    for (const shim of NEW_FUNCTIONS.filter((n) => n.startsWith('public.'))) {
      const local = shim.replace('public.aigundem_', 'aigundem.');
      expect(fn(shim)).toContain(local);
    }
  });
});

// ---------------------------------------------------------------------------
// B1
// ---------------------------------------------------------------------------

describe('rev-003 B1: releasing a deferral gives the attempt back', () => {
  const body = () => fn('aigundem.internal_release_ai_job_unattempted');

  it('decrements the attempt by exactly one and floors it at zero', () => {
    // Leasing incremented it; this is the inverse. The floor exists because
    // P2's ai_jobs_attempts_non_negative would reject a negative row.
    expect(body()).toContain('attempt_count = greatest(j.attempt_count - 1, 0)');
  });

  it('is lease-token guarded, so a stale worker cannot rewind another owner', () => {
    expect(body()).toContain('j.lease_token = p_lease_token');
    expect(body()).toContain("j.status = 'leased'");
  });

  it('returns the job to the queue with the deferral reason, not as failed', () => {
    expect(body()).toContain("status = 'queued'");
    expect(body()).toContain('available_at = p_available_at');
    expect(body()).toContain('left(p_error_code, 128)');
    expect(body()).not.toContain("status = 'failed'");
  });

  it('reports whether it actually moved a row', () => {
    expect(body()).toContain('get diagnostics v_rows = row_count');
    expect(body()).toContain('return v_rows > 0;');
  });
});

// ---------------------------------------------------------------------------
// N1
// ---------------------------------------------------------------------------

describe('rev-003 N1: polling an existing job is free', () => {
  const body = () => fn('aigundem.internal_enqueue_ai_job_charged');

  it('decides newness with the insert itself, not a prior select', () => {
    // A select-then-insert would race; the unique index is the arbiter.
    expect(body()).toContain(
      'on conflict (article_id, content_hash, prompt_version, model) do nothing returning id into v_id',
    );
  });

  it('charges only after a genuine insert', () => {
    const text = body();
    expect(text.indexOf('on conflict (article_id, content_hash, prompt_version, model)'))
      .toBeLessThan(text.indexOf('private.bump_rate_limit'));
    expect(text).toContain('if v_id is null then');
  });

  it('returns the existing job uncharged', () => {
    // charged = false, allowed = true on the conflict branch.
    expect(body()).toContain('select j.id, j.status::text, false, false, true');
  });

  it('undoes its own insert when the budget is spent', () => {
    const text = body();
    expect(text).toContain('if not v_allowed then');
    expect(text).toContain('delete from private.ai_jobs j where j.id = v_id');
    // …and reports it, so no job exists for an over-budget caller.
    expect(text).toContain('select null::uuid, null::text, false, true, false');
  });
});

// ---------------------------------------------------------------------------
// N5
// ---------------------------------------------------------------------------

describe('rev-003 N5: the source-state definer rejects a null boolean', () => {
  it('validates p_ok alongside the other arguments', () => {
    const body = fn('aigundem.internal_update_source_fetch_state');
    expect(body).toContain('if p_ok is null then');
    expect(body).toContain('if p_source_id is null then');
    expect(body).toContain('if p_next_fetch_at is null then');
  });

  it('is otherwise the 0006 body, unchanged', () => {
    // A silent behaviour change smuggled into a null-check fix would be worse
    // than the null check is worth.
    const body = fn('aigundem.internal_update_source_fetch_state');
    expect(body).toContain("when p_ok then 'active'::aigundem.source_status");
    expect(body).toContain('v_failure_limit constant integer := 10');
    expect(body).toContain('consecutive_failures = case when p_ok then 0 else s.consecutive_failures + 1 end');
  });
});

// ---------------------------------------------------------------------------
// B4
// ---------------------------------------------------------------------------

describe('rev-003 B4: digest finalize is five-or-none under concurrency', () => {
  const body = () => fn('aigundem.internal_digest_finalize');

  it('locks the digest row before deciding anything', () => {
    // Serialises finalizers for this date: the second waits, then sees the
    // first one's committed `ready` and no-ops.
    const text = body();
    expect(text).toContain('where d.digest_date = v_date for update');
    expect(text.indexOf('for update')).toBeLessThan(text.indexOf('insert into aigundem.digest_items'));
  });

  it('has NO pre-count left to race against the insert', () => {
    // The old body counted candidates in one statement and inserted in another;
    // under READ COMMITTED those are different snapshots. The seam is gone, not
    // narrowed — finalize counts nothing before it writes.
    const text = body();
    expect(text).not.toContain('into v_candidates');
    expect(text).not.toContain('v_candidates < 5');
  });

  it('decides from what the single insert actually wrote', () => {
    const text = body();
    expect(text).toContain('get diagnostics v_inserted = row_count');
    expect(text.indexOf('insert into aigundem.digest_items'))
      .toBeLessThan(text.indexOf('get diagnostics v_inserted = row_count'));
  });

  it('writes ready only for exactly five', () => {
    const text = body();
    expect(text).toContain('if v_inserted = 5 then');
    // `set status = 'ready'`, not the `v_status = 'ready'` idempotence check.
    // There is exactly one write, and it sits inside the guard.
    expect((text.match(/set status = 'ready'/g) ?? [])).toHaveLength(1);
    expect(text.indexOf('if v_inserted = 5 then')).toBeLessThan(
      text.indexOf("set status = 'ready'"),
    );
  });

  it('deletes the partial rows and stays preparing otherwise', () => {
    const text = body();
    expect(text).toContain("return query select v_date, 'preparing'::text, 0, 5 - v_inserted");
    // Two deletes: the defensive pre-clean, and the partial-set rollback.
    expect((text.match(/delete from aigundem\.digest_items/g) ?? [])).toHaveLength(2);
  });

  it('reports a meaningful missing count for the client', () => {
    expect(body()).toContain('5 - v_inserted');
  });

  it('still selects candidates the way the ranker specifies', () => {
    // B4 changes the transaction shape, not the ranking.
    const text = body();
    expect(text).toContain(
      'row_number() over ( partition by c.source_id order by c.published_at desc, c.article_id desc ) as source_rank',
    );
    expect(text).toContain(
      'row_number() over ( order by p.source_rank asc, p.published_at desc, p.article_id desc ) as slot',
    );
    expect(text).toContain('where o.slot <= 5');
    expect(text).toContain('and m.content_hash = a.content_hash');
  });

  it('leaves prepare advisory: it writes no items and decides nothing', () => {
    const prepare = fn('aigundem.internal_digest_prepare');
    expect(prepare).not.toContain('insert into aigundem.digest_items');
    expect(prepare).not.toContain("status = 'ready'");
    expect(prepare).toContain('greatest(0, 5 - v_candidates)');
  });
});

// ---------------------------------------------------------------------------
// The migration and the TypeScript agree
// ---------------------------------------------------------------------------

describe('0010 and the adapter agree on every RPC name', () => {
  it('exposes both new RPCs under both routings', () => {
    const adapter = readFileSync(
      join(__dirname, '..', 'functions', '_shared', 'enrichment-db.ts'),
      'utf8',
    );
    for (const name of ['internal_release_ai_job_unattempted', 'internal_enqueue_ai_job_charged']) {
      expect({ name, inAdapter: adapter.includes(`'${name}'`) }).toEqual({ name, inAdapter: true });
      expect({ name, inSql: sql.includes(`aigundem.${name}(`) }).toEqual({ name, inSql: true });
      expect({ name, shimmed: sql.includes(`public.aigundem_${name}(`) }).toEqual({
        name,
        shimmed: true,
      });
    }
  });

  it('uses the p_-prefixed argument names the adapter sends', () => {
    const adapter = readFileSync(
      join(__dirname, '..', 'functions', '_shared', 'enrichment-db.ts'),
      'utf8',
    );
    for (const arg of ['p_job_id', 'p_lease_token', 'p_available_at', 'p_error_code']) {
      expect({ arg, inAdapter: adapter.includes(arg) }).toEqual({ arg, inAdapter: true });
      expect({ arg, inSql: sql.includes(arg) }).toEqual({ arg, inSql: true });
    }
    for (const arg of ['p_subject', 'p_action', 'p_window_start', 'p_limit']) {
      expect({ arg, inAdapter: adapter.includes(arg) }).toEqual({ arg, inAdapter: true });
      expect({ arg, inSql: sql.includes(arg) }).toEqual({ arg, inSql: true });
    }
  });
});
