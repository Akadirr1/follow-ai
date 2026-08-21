/**
 * Offline verification of `202608210008_digest_and_cron.sql`.
 *
 * Same rule set P2/P3/P4 apply to their own migrations, plus what is specific
 * here: the four cron jobs must be created DISABLED, the secret must be read
 * from Vault at job-execution time rather than baked into a job definition, and
 * the SQL ranking clauses must match the TypeScript specification in
 * `_shared/digest.ts`.
 *
 * STATIC only. No database exists in this task, so nothing here proves Postgres
 * accepts the SQL, that pg_cron and pg_net are installable, or that the ranking
 * behaves — that is the coordinator's remote apply and smoke.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DIGEST_ITEM_COUNT,
  DIGEST_WINDOW_END_LOCAL_HOUR,
  headlineFor,
} from '../functions/_shared/digest.ts';
import { AUTOMATIONS_SECRET_NAME } from '../functions/_shared/secret.ts';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const FILE = '202608210008_digest_and_cron.sql';

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
// Scanner (strips `--` comments everywhere, bodies included).
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
const doBlocks = statements.filter((s) => /^do\b/i.test(s));

const IMPLEMENTATIONS = [
  'aigundem.internal_digest_finalize',
  'aigundem.internal_digest_prepare',
  'aigundem.internal_get_setting',
];
const SHIMS = IMPLEMENTATIONS.map((n) =>
  n.replace('aigundem.internal_', 'public.aigundem_internal_'),
);

/** The four jobs from arch-001 §2, with the schedules it fixes. */
const CRON_JOBS: [string, string, string][] = [
  ['ai-gundem-ingest', '*/15 * * * *', '/sync-feeds'],
  ['ai-gundem-ai-worker', '*/2 * * * *', '/process-enrichments'],
  ['ai-gundem-digest-prepare', '45 2 * * *', '/build-digest'],
  ['ai-gundem-digest-finalize', '30,40,50 3 * * *', '/build-digest'],
];

// ---------------------------------------------------------------------------

describe('202608210008: hygiene', () => {
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
      expect(stmt).toMatch(/^(create|alter|comment|grant|revoke|notify|do)\b/i);
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
});

describe('202608210008: functions', () => {
  it('creates exactly the three helpers and their three shims', () => {
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

  it('uses no dynamic SQL anywhere', () => {
    for (const stmt of [...functions, ...doBlocks]) {
      expect(stmt.toLowerCase()).not.toMatch(/\bexecute\s+(format|'|"|\$|v_|p_)/);
      expect(stmt.toLowerCase()).not.toContain('quote_ident');
      expect(stmt.toLowerCase()).not.toContain('quote_literal');
    }
  });

  it('schema-qualifies every table reference, allowing only CTE names', () => {
    // Nothing resolves implicitly under an empty search_path. `vault` is the
    // secret store; the rest are CTEs defined in the same statement.
    const allowed = /^(aigundem\.|private\.|vault\.|pg_catalog\.|candidates\b|per_source\b|ordered\b|\()/;
    for (const fn of functions) {
      for (const match of fn.match(/ from [a-z_.(]+/gi) ?? []) {
        const target = match.slice(6);
        expect({ fn: fn.slice(0, 58), target, ok: allowed.test(target) }).toEqual({
          fn: fn.slice(0, 58),
          target,
          ok: true,
        });
      }
      for (const match of fn.match(/ join [a-z_.(]+/gi) ?? []) {
        const target = match.slice(6);
        expect({ fn: fn.slice(0, 58), target, ok: allowed.test(target) }).toEqual({
          fn: fn.slice(0, 58),
          target,
          ok: true,
        });
      }
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
  });

  it('allow-lists the one secret name it may read, and reads it from Vault', () => {
    const fn = functions.find((f) => f.includes('function aigundem.internal_get_setting('))!;
    // Without the allow-list this is a read-any-secret primitive.
    expect(fn).toContain(`p_name not in ('${AUTOMATIONS_SECRET_NAME}')`);
    expect(fn).toContain('from vault.decrypted_secrets v');
    expect(fn.toLowerCase()).toContain('raise exception');
  });

  it('revokes from public/anon/authenticated and grants to service_role alone', () => {
    const revokes = statements.filter((s) => /^revoke\b/i.test(s)).map((s) => s.toLowerCase());
    const grants = statements.filter((s) => /^grant\b/i.test(s)).map((s) => s.toLowerCase());

    for (const name of [...IMPLEMENTATIONS, ...SHIMS]) {
      expect({ name, revoked: revokes.some((r) => r.includes(name) && r.includes('from public, anon, authenticated')) })
        .toEqual({ name, revoked: true });
      expect({ name, granted: grants.some((g) => g.includes(name) && g.endsWith('to service_role')) })
        .toEqual({ name, granted: true });
    }
    expect(grants).toHaveLength(IMPLEMENTATIONS.length + SHIMS.length);
    for (const grant of grants) {
      expect(grant).not.toMatch(/\bto\b[^;]*\b(anon|authenticated)\b/);
    }
  });

  it('keeps each transport shim a delegate, not a second implementation', () => {
    for (const shim of SHIMS) {
      const local = shim.replace('public.aigundem_', 'aigundem.');
      const fn = functions.find((f) => f.includes(`function ${shim}(`))!;
      expect(fn).toContain(local);
      expect(fn.toLowerCase()).not.toMatch(/\b(insert into|delete from)\b/);
    }
  });
});

describe('202608210008: the digest window and ranking', () => {
  const prepare = () => functions.find((f) => f.includes('function aigundem.internal_digest_prepare('))!;
  const finalize = () => functions.find((f) => f.includes('function aigundem.internal_digest_finalize('))!;

  it('derives the window from the DATE, at the hour the specification names', () => {
    for (const fn of [prepare(), finalize()]) {
      expect(fn).toContain(
        `(v_date + time '0${DIGEST_WINDOW_END_LOCAL_HOUR}:00') at time zone 'Europe/Istanbul'`,
      );
      expect(fn).toContain("v_start := v_end - interval '24 hours'");
      // The only use of now() is defaulting the date, never bounding the window.
      expect(fn).toContain("coalesce(p_date, (now() at time zone 'Europe/Istanbul')::date)");
    }
  });

  it('counts only enriched articles from active sources whose summary is current', () => {
    for (const fn of [prepare(), finalize()]) {
      expect(fn).toContain("join aigundem.sources s on s.id = a.source_id and s.status = 'active'");
      // A stale summary simply does not join, so a rewritten article is not
      // eligible until it is re-enriched.
      expect(fn).toContain('and m.content_hash = a.content_hash');
      expect(fn).toContain('where a.published_at >= v_start and a.published_at < v_end');
    }
  });

  it('pins the ranking clauses against the TypeScript specification', () => {
    const fn = finalize();
    // Round-robin by source: per-source recency rank first, then recency, then
    // the id tiebreak that makes the order total.
    expect(fn).toContain(
      'row_number() over ( partition by c.source_id order by c.published_at desc, c.article_id desc ) as source_rank',
    );
    expect(fn).toContain(
      'row_number() over ( order by p.source_rank asc, p.published_at desc, p.article_id desc ) as slot',
    );
    expect(fn).toContain(`where o.slot <= ${DIGEST_ITEM_COUNT}`);
  });

  it('takes the blurb from the first summary bullet — no Claude in this path', () => {
    // Postgres arrays are 1-indexed; the TypeScript mirror reads summary[0].
    expect(finalize()).toContain('m.summary_tr[1] as blurb');
    expect(sql.toLowerCase()).not.toContain('anthropic');
    expect(sql.toLowerCase()).not.toContain('claude');
  });

  it('writes all five or none', () => {
    const fn = finalize();
    expect(fn).toContain(`if v_candidates < ${DIGEST_ITEM_COUNT} then`);
    // The early return happens before the insert, so digest_items is never
    // partially populated.
    expect(fn.indexOf(`if v_candidates < ${DIGEST_ITEM_COUNT} then`)).toBeLessThan(
      fn.indexOf('insert into aigundem.digest_items'),
    );
  });

  it('is idempotent: a ready digest is returned untouched', () => {
    const fn = finalize();
    expect(fn).toContain("if v_status = 'ready' then");
    // The ready check precedes every write.
    expect(fn.indexOf("if v_status = 'ready' then")).toBeLessThan(
      fn.indexOf('insert into aigundem.digest_items'),
    );
    expect(fn.indexOf("if v_status = 'ready' then")).toBeLessThan(
      fn.indexOf('update aigundem.digests'),
    );
  });

  it('marks a completed digest ready with the headline the specification gives', () => {
    const fn = finalize();
    expect(fn).toContain("status = 'ready'");
    expect(fn).toContain("generated_at = now()");
    // P2's digests_ready_is_complete CHECK requires both.
    const prefix = headlineFor('').replace(/\s+$/, '');
    expect(fn).toContain(prefix);
    expect(fn).toContain("to_char(v_date, 'YYYY-MM-DD')");
  });

  it('lets finalize run without prepare, so a smoke test is one call', () => {
    expect(finalize()).toContain('insert into aigundem.digests');
    expect(finalize()).toContain('on conflict (digest_date) do nothing');
  });
});

describe('202608210008: cron', () => {
  const cronBlock = () => doBlocks.find((b) => b.includes('cron.schedule'))!;

  it('enables pg_cron and pg_net idempotently', () => {
    expect(sql.toLowerCase()).toContain('create extension if not exists pg_cron');
    expect(sql.toLowerCase()).toContain('create extension if not exists pg_net');
  });

  it('creates all four jobs from arch-001 with their exact schedules', () => {
    const block = cronBlock();
    for (const [name, schedule, path] of CRON_JOBS) {
      expect({ name, scheduled: block.includes(`cron.schedule('${name}', '${schedule}'`) }).toEqual(
        { name, scheduled: true },
      );
      expect({ name, targets: block.includes(`|| '${path}'`) }).toEqual({ name, targets: true });
    }
  });

  /**
   * The acceptance criterion. An enabled `ai-gundem-ai-worker` on a project
   * whose Claude path has never run would march the whole backlog through its
   * retry budget unattended; the coordinator enables each job after its own
   * remote smoke.
   */
  it('creates every job DISABLED and never enables one', () => {
    const block = cronBlock();
    expect((block.match(/active := false/g) ?? [])).toHaveLength(CRON_JOBS.length);
    expect(raw).not.toMatch(/active\s*(:=|=>)\s*true/i);
    expect(raw.toLowerCase()).not.toContain('active := true');
  });

  it('unschedules an existing job before rescheduling it', () => {
    const block = cronBlock();
    for (const [name] of CRON_JOBS) {
      expect({ name, guarded: block.includes(`from cron.job j where j.jobname = '${name}'`) }).toEqual(
        { name, guarded: true },
      );
      expect({ name, unscheduled: block.includes(`cron.unschedule('${name}')`) }).toEqual({
        name,
        unscheduled: true,
      });
    }
  });

  it('reads the secret from Vault inside each job, never baking it into the definition', () => {
    const block = cronBlock();
    const reads = block.match(
      new RegExp(`from vault.decrypted_secrets v where v.name = '${AUTOMATIONS_SECRET_NAME}'`, 'g'),
    );
    // Once per job: evaluated when the job runs, so a rotated secret is picked
    // up without rescheduling anything.
    expect(reads).toHaveLength(CRON_JOBS.length);
    expect(block).toContain("'X-Internal-Secret'");
    // Nothing that looks like a literal secret value.
    expect(block).not.toMatch(/X-Internal-Secret',\s*'[^']{8,}'/);
  });

  it('builds the function URL from a setting with a project fallback', () => {
    const block = cronBlock();
    const settings = block.match(/current_setting\('app.settings.functions_url', true\)/g);
    expect(settings).toHaveLength(CRON_JOBS.length);
    const fallbacks = block.match(
      /'https:\/\/eglxzbsrewbleqlstefd.supabase.co\/functions\/v1'/g,
    );
    expect(fallbacks).toHaveLength(CRON_JOBS.length);
  });

  it('posts through pg_net with a bounded timeout', () => {
    const block = cronBlock();
    expect((block.match(/net.http_post\(/g) ?? [])).toHaveLength(CRON_JOBS.length);
    expect((block.match(/timeout_milliseconds := \d+/g) ?? [])).toHaveLength(CRON_JOBS.length);
  });

  it('sends each function the request body it validates', () => {
    const block = cronBlock();
    expect(block).toContain("jsonb_build_object('max_sources', 10)");
    expect(block).toContain("jsonb_build_object('max_jobs', 3)");
    expect(block).toContain("jsonb_build_object('phase', 'prepare')");
    expect(block).toContain("jsonb_build_object('phase', 'finalize')");
  });

  it('leaves the digest ready well before the 07:00 Istanbul notification', () => {
    // 03:50 UTC is 06:50 Istanbul: the last finalize retry still has ten
    // minutes of margin (arch-001 §2).
    const [, finalizeSchedule] = CRON_JOBS[3];
    const lastMinuteUtc = finalizeSchedule.split(' ')[0].split(',').map(Number).pop()!;
    const hourUtc = Number(finalizeSchedule.split(' ')[1]);
    const istanbulMinutes = (hourUtc + 3) * 60 + lastMinuteUtc;
    expect(istanbulMinutes).toBeLessThanOrEqual(7 * 60 - 10);
  });
});

describe('the migration and the TypeScript agree', () => {
  it('exposes every RPC name the digest adapter calls', () => {
    const adapter = readFileSync(
      join(__dirname, '..', 'functions', '_shared', 'digest.ts'),
      'utf8',
    );
    for (const name of ['internal_digest_prepare', 'internal_digest_finalize', 'internal_get_setting']) {
      expect({ name, inAdapter: adapter.includes(`'${name}'`) }).toEqual({ name, inAdapter: true });
      expect({ name, inSql: sql.includes(`aigundem.${name}(`) }).toEqual({ name, inSql: true });
      expect({ name, shimmed: sql.includes(`public.aigundem_${name}(`) }).toEqual({
        name,
        shimmed: true,
      });
    }
  });

  it('uses the same Vault entry name in the cron jobs and in the resolver', () => {
    expect(sql).toContain(AUTOMATIONS_SECRET_NAME);
    const secretModule = readFileSync(
      join(__dirname, '..', 'functions', '_shared', 'secret.ts'),
      'utf8',
    );
    expect(secretModule).toContain(`'${AUTOMATIONS_SECRET_NAME}'`);
  });
});
