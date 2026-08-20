/**
 * Offline verification of the AI Gündem migrations 202608210001..0005.
 *
 * There is no database in this environment (no Supabase CLI token, no Docker,
 * no Deno — facts-2026-08-21), and the P2 implementer is not allowed to deploy.
 * This suite is therefore a *static* check: it proves the migration files say
 * what the architecture says they must say. It cannot prove Postgres accepts
 * them, that the policies behave as intended, or that PostgREST picks them up.
 * Those are covered by supabase/tests/rls-probes.sql, which the coordinator runs
 * remotely after applying the migrations.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/** The five files this task owns. 006+ belong to other tasks and are not linted. */
const MIGRATION_FILES = [
  '202608210001_extensions_and_types.sql',
  '202608210002_content.sql',
  '202608210003_user_state.sql',
  '202608210004_jobs_and_rpc.sql',
  '202608210005_rls_and_grants.sql',
] as const;

/** Shared content tables that clients may read. */
const SHARED_TABLES = [
  'aigundem.sources',
  'aigundem.articles',
  'aigundem.article_summaries',
  'aigundem.digests',
  'aigundem.digest_items',
] as const;

/** Internal tables that no client role may reach. */
const PRIVATE_TABLES = [
  'private.ai_jobs',
  'private.ingestion_runs',
  'private.rate_limit_buckets',
] as const;

/** The unrelated application that already occupies `public` (facts-2026-08-21). */
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

const CLIENT_ROLES = ['anon', 'authenticated'] as const;

// ---------------------------------------------------------------------------
// Minimal SQL scanner: enough to strip comments and split statements without
// being fooled by string literals or dollar-quoted function bodies.
// ---------------------------------------------------------------------------

const DOLLAR_TAG = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/;

/** Remove line and block comments without being fooled by literals. */
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
        if (source.slice(i, i + 2) === '/*') {
          depth += 1;
          i += 2;
        } else if (source.slice(i, i + 2) === '*/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }

    if (source[i] === "'") {
      out += "'";
      i += 1;
      while (i < source.length) {
        if (source[i] === "'") {
          if (source[i + 1] === "'") {
            out += "''";
            i += 2;
            continue;
          }
          out += "'";
          i += 1;
          break;
        }
        out += source[i];
        i += 1;
      }
      continue;
    }

    const tag = DOLLAR_TAG.exec(source.slice(i));
    if (tag) {
      const marker = tag[0];
      const end = source.indexOf(marker, i + marker.length);
      const stop = end === -1 ? source.length : end + marker.length;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }

    out += source[i];
    i += 1;
  }
  return out;
}

/** Split already-comment-stripped SQL on top-level semicolons. */
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
          if (sql[i + 1] === "'") {
            current += "''";
            i += 2;
            continue;
          }
          current += "'";
          i += 1;
          break;
        }
        current += sql[i];
        i += 1;
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

    if (sql[i] === ';') {
      statements.push(current);
      current = '';
      i += 1;
      continue;
    }

    current += sql[i];
    i += 1;
  }
  if (current.trim() !== '') statements.push(current);
  return statements
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Load everything once.
// ---------------------------------------------------------------------------

type Migration = {
  file: string;
  raw: string;
  bytes: Buffer;
  sql: string;
  statements: string[];
};

const migrations: Migration[] = MIGRATION_FILES.map((file) => {
  const path = join(MIGRATIONS_DIR, file);
  const bytes = readFileSync(path);
  const raw = bytes.toString('utf8');
  const sql = stripComments(raw);
  return { file, raw, bytes, sql, statements: splitStatements(sql) };
});

const allStatements = migrations.flatMap((m) => m.statements);
/** Every statement, comment-free, whitespace-collapsed and lowercased. */
const allSqlLower = allStatements.join(';\n').toLowerCase();

// ---------------------------------------------------------------------------
// (a) File hygiene and forbidden content.
// ---------------------------------------------------------------------------

describe('migration files: hygiene', () => {
  it('contains exactly the five files this task owns, in order', () => {
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of MIGRATION_FILES) {
      expect(onDisk).toContain(file);
    }
    // Numbering is stable and sorted: applying them alphabetically is applying
    // them in the intended order.
    expect([...MIGRATION_FILES].sort()).toEqual([...MIGRATION_FILES]);
  });

  it.each(MIGRATION_FILES)('%s exists and is non-empty', (file) => {
    const path = join(MIGRATIONS_DIR, file);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).byteLength).toBeGreaterThan(0);
  });

  it.each(MIGRATION_FILES)('%s is valid UTF-8 with no BOM', (file) => {
    const m = migrations.find((x) => x.file === file)!;
    // A lossy decode would introduce U+FFFD and change the byte length on
    // re-encode; both are caught here. The Turkish category values make this a
    // real risk on Windows.
    expect(m.raw).not.toContain('�');
    expect(Buffer.from(m.raw, 'utf8').equals(m.bytes)).toBe(true);
    expect(m.raw.charCodeAt(0)).not.toBe(0xfeff);
  });

  it.each(MIGRATION_FILES)('%s ends with exactly one LF and has no CRLF', (file) => {
    const m = migrations.find((x) => x.file === file)!;
    expect(m.raw.endsWith('\n')).toBe(true);
    expect(m.raw.endsWith('\n\n')).toBe(false);
    expect(m.raw).not.toContain('\r');
  });

  it.each(MIGRATION_FILES)('%s contains no backslash (no Windows paths, no stray escapes)', (file) => {
    const m = migrations.find((x) => x.file === file)!;
    expect(m.raw.includes('\\')).toBe(false);
  });

  it.each(MIGRATION_FILES)('%s creates nothing in and references nothing from public', (file) => {
    const m = migrations.find((x) => x.file === file)!;
    // `public` may appear as a grantee role name ("revoke ... from public"),
    // never as a schema qualifier.
    expect(m.sql.toLowerCase()).not.toContain('public.');
    for (const stmt of m.statements) {
      expect(stmt.toLowerCase()).not.toMatch(
        /\b(create|alter)\s+(table|view|materialized\s+view|function|index|sequence|type|domain)\s+(if\s+not\s+exists\s+)?public\b/,
      );
    }
  });

  it.each(MIGRATION_FILES)('%s drops and truncates nothing', (file) => {
    const m = migrations.find((x) => x.file === file)!;
    expect(m.sql.toLowerCase()).not.toMatch(/\bdrop\b/);
    expect(m.sql.toLowerCase()).not.toMatch(/\btruncate\b/);
  });

  it.each(MIGRATION_FILES)('%s never mentions the other application on this project', (file) => {
    const m = migrations.find((x) => x.file === file)!;
    const lower = m.sql.toLowerCase();
    for (const table of OTHER_APP_TABLES) {
      expect(lower).not.toMatch(new RegExp(`\\b${table}\\b`));
    }
    // Bare `users` would be public.users; `auth.users` is not referenced in v1.
    expect(lower).not.toMatch(/(^|[^._a-z])users\b/);
    expect(lower).not.toContain('auth.users');
  });

  it.each(MIGRATION_FILES)('%s splits into statements that all start with a known keyword', (file) => {
    // No SQL parser is available offline (no network, no dev dependency added),
    // so this is a shape check, not a parse: it catches a missing semicolon, an
    // unterminated dollar-quoted body and a stray fragment, nothing more.
    const m = migrations.find((x) => x.file === file)!;
    expect(m.statements.length).toBeGreaterThan(0);
    const TOP_LEVEL =
      /^(create|alter|comment|grant|revoke|notify|do|set|insert|update|select)\b/i;
    for (const stmt of m.statements) {
      expect(stmt).toMatch(TOP_LEVEL);
    }
  });

  it.each(MIGRATION_FILES)('%s has balanced parentheses and dollar quotes', (file) => {
    const m = migrations.find((x) => x.file === file)!;
    for (const stmt of m.statements) {
      // Count only outside string literals and dollar-quoted bodies.
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
    const dollarMarkers = (m.raw.match(/\$[A-Za-z_][A-Za-z_0-9]*\$/g) ?? []).length;
    expect(dollarMarkers % 2).toBe(0);
  });

  it('creates every object inside aigundem or private', () => {
    for (const stmt of allStatements) {
      const lower = stmt.toLowerCase();
      const created = /^create\s+(or\s+replace\s+)?(table|view|function|domain)\s+(if\s+not\s+exists\s+)?([a-z_][a-z_0-9]*)\./.exec(
        lower,
      );
      if (created) {
        expect(['aigundem', 'private']).toContain(created[4]);
      }
      const indexed = /^create\s+(unique\s+)?index\s+.*?\son\s+([a-z_][a-z_0-9]*)\./.exec(lower);
      if (indexed) {
        expect(['aigundem', 'private']).toContain(indexed[2]);
      }
      const triggered = /^create\s+trigger\s+.*?\son\s+([a-z_][a-z_0-9]*)\./.exec(lower);
      if (triggered) {
        expect(['aigundem', 'private']).toContain(triggered[1]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Schema and PostgREST exposure.
// ---------------------------------------------------------------------------

describe('migration 0001: schemas and PostgREST exposure', () => {
  const first = migrations[0];

  it('creates both schemas idempotently', () => {
    expect(first.sql.toLowerCase()).toContain('create schema if not exists aigundem');
    expect(first.sql.toLowerCase()).toContain('create schema if not exists private');
  });

  it('exposes aigundem to PostgREST without hiding public from the other app', () => {
    const stmt = first.statements.find((s) =>
      s.toLowerCase().includes('pgrst.db_schemas'),
    );
    expect(stmt).toBeDefined();
    expect(stmt!.toLowerCase()).toContain('alter role authenticator set');
    expect(stmt!).toContain("'public, aigundem'");
    expect(first.sql.toLowerCase()).toContain("notify pgrst, 'reload config'");
  });

  it('declares the five shipped categories exactly once, as a domain', () => {
    const domain = first.statements.find((s) =>
      s.toLowerCase().startsWith('create domain aigundem.category'),
    );
    expect(domain).toBeDefined();
    for (const value of ['Modeller', 'Araştırma', 'Ürün', 'Açık Kaynak', 'Türkiye']) {
      expect(domain!).toContain(`'${value}'`);
    }
    // `Tümü` is a client-side filter, never a stored value.
    expect(domain!).not.toContain('Tümü');
  });

  it('constrains language, content quality, translation and status value sets', () => {
    const domains = first.statements
      .filter((s) => s.toLowerCase().startsWith('create domain'))
      .join('\n');
    expect(domains).toContain("value in ('en', 'tr')");
    expect(domains).toContain("value in ('en', 'tr', 'und')");
    expect(domains).toContain("value in ('full', 'excerpt')");
    expect(domains).toContain("value in ('ready', 'not_required')");
    expect(domains).toContain("value in ('pending', 'active', 'paused', 'failed')");
    expect(domains).toContain("value in ('preparing', 'ready', 'failed')");
  });
});

// ---------------------------------------------------------------------------
// (b) Tables, keys and the policy/grant matrix.
// ---------------------------------------------------------------------------

const createTableStatements = allStatements.filter((s) =>
  /^create\s+table\b/i.test(s),
);

function createdTableName(stmt: string): string {
  const m = /^create\s+table\s+(if\s+not\s+exists\s+)?([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*)/i.exec(
    stmt,
  );
  return m ? m[2].toLowerCase() : '';
}

const createdTables = createTableStatements.map(createdTableName);

describe('tables and keys', () => {
  it('creates exactly the tables the architecture calls for, and no user tables', () => {
    expect(createdTables.sort()).toEqual(
      [...SHARED_TABLES, ...PRIVATE_TABLES].map((t) => t.toLowerCase()).sort(),
    );
    // Addendum §A: v1 stores no user state in Postgres.
    for (const dropped of ['user_sources', 'user_article_state', 'user_settings']) {
      expect(allSqlLower).not.toMatch(new RegExp(`create\\s+table\\s+\\S*${dropped}\\b`));
    }
  });

  it('gives every content table its required unique keys and indexes', () => {
    const indexes = allStatements.filter((s) => /^create\s+(unique\s+)?index\b/i.test(s));
    const has = (needle: string) =>
      indexes.some((s) => s.toLowerCase().replace(/\s+/g, ' ').includes(needle));

    // sources
    expect(has('unique index sources_feed_url_hash_key on aigundem.sources (feed_url_hash)')).toBe(true);
    expect(has('on aigundem.sources (slug) where is_default')).toBe(true);
    expect(has('on aigundem.sources (status, next_fetch_at)')).toBe(true);
    // articles
    expect(has('unique index articles_source_external_id_key on aigundem.articles (source_id, external_id)')).toBe(true);
    expect(has('unique index articles_url_hash_key on aigundem.articles (url_hash)')).toBe(true);
    expect(has('on aigundem.articles (published_at desc, id desc)')).toBe(true);
    expect(has('on aigundem.articles (source_id, published_at desc, id desc)')).toBe(true);
    expect(has('on aigundem.articles using gin (search_tsv)')).toBe(true);
    // summaries cache key
    expect(has('on aigundem.article_summaries (article_id, content_hash, prompt_version, model)')).toBe(true);
    // digests
    expect(has('unique index digests_digest_date_key on aigundem.digests (digest_date)')).toBe(true);
    expect(has('on aigundem.digests (status, digest_date desc)')).toBe(true);
    expect(has('unique index digest_items_digest_article_key on aigundem.digest_items (digest_id, article_id)')).toBe(true);
    expect(has('on aigundem.digest_items (article_id)')).toBe(true);
    // internal
    expect(has('unique index ai_jobs_cache_key on private.ai_jobs (article_id, content_hash, prompt_version, model)')).toBe(true);
    expect(has('on private.ai_jobs (status, available_at)')).toBe(true);
    expect(has('on private.ingestion_runs (started_at desc)')).toBe(true);
  });

  it('enforces the summary shape: exactly three bullets and a coherent translation state', () => {
    const summaries = createTableStatements.find(
      (s) => createdTableName(s) === 'aigundem.article_summaries',
    )!;
    expect(summaries.toLowerCase()).toContain('cardinality(summary_tr) = 3');
    expect(summaries.toLowerCase()).toContain("translation_state = 'not_required' and translation_tr is null");
  });

  it('keeps updated_at honest with a trigger on every table that has the column', () => {
    for (const stmt of createTableStatements) {
      if (!/\bupdated_at\b/i.test(stmt)) continue;
      const table = createdTableName(stmt);
      if (table === 'private.rate_limit_buckets') continue; // written only by bump_rate_limit
      expect(allSqlLower).toMatch(
        new RegExp(`create trigger \\S+ before update on ${table.replace('.', '\\.')}`),
      );
    }
  });

  it('bounds every free-text column that a feed can fill', () => {
    for (const stmt of createTableStatements) {
      const table = createdTableName(stmt);
      if (!['aigundem.sources', 'aigundem.articles'].includes(table)) continue;
      expect(stmt.toLowerCase()).toContain('char_length');
    }
  });
});

// ---------------------------------------------------------------------------
// Row level security, policies and grants.
// ---------------------------------------------------------------------------

type Policy = { name: string; table: string; cmd: string; roles: string[] };

function parsePolicies(): Policy[] {
  return allStatements
    .filter((s) => /^create\s+policy\b/i.test(s))
    .map((s) => {
      const head =
        /^create\s+policy\s+([a-z_][a-z_0-9]*)\s+on\s+([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*)\s+for\s+(select|insert|update|delete|all)\s+to\s+([^)]*?)\s+(using|with\s+check)\b/i.exec(
          s,
        );
      if (!head) throw new Error(`unparsable policy statement: ${s.slice(0, 120)}`);
      return {
        name: head[1].toLowerCase(),
        table: head[2].toLowerCase(),
        cmd: head[3].toLowerCase(),
        roles: head[4].split(',').map((r) => r.trim().toLowerCase()),
      };
    });
}

const policies = parsePolicies();

describe('row level security', () => {
  it('enables RLS on every table it creates', () => {
    for (const table of createdTables) {
      expect(allSqlLower).toContain(`alter table ${table} enable row level security`);
    }
  });

  it('gives each shared table exactly one SELECT policy for anon and authenticated', () => {
    for (const table of SHARED_TABLES) {
      const forTable = policies.filter((p) => p.table === table);
      expect(forTable).toHaveLength(1);
      expect(forTable[0].cmd).toBe('select');
      expect(forTable[0].roles.sort()).toEqual([...CLIENT_ROLES].sort());
    }
  });

  it('defines no INSERT, UPDATE, DELETE or ALL policy anywhere', () => {
    expect(policies.filter((p) => p.cmd !== 'select')).toEqual([]);
    expect(allSqlLower).not.toContain('with check');
  });

  it('defines no policy at all on the private tables', () => {
    for (const table of PRIVATE_TABLES) {
      expect(policies.filter((p) => p.table === table)).toEqual([]);
    }
  });

  it('restricts sources to active and digests to ready', () => {
    const byTable = (t: string) => policies.find((p) => p.table === t)!;
    const sources = allStatements.find((s) => s.includes('on aigundem.sources for select'))!;
    expect(sources.toLowerCase()).toContain("using (status = 'active')");
    const digests = allStatements.find((s) => s.includes('on aigundem.digests for select'))!;
    expect(digests.toLowerCase()).toContain("using (status = 'ready')");
    const items = allStatements.find((s) => s.includes('on aigundem.digest_items for select'))!;
    expect(items.toLowerCase()).toContain("d.status = 'ready'");
    expect(byTable('aigundem.articles').cmd).toBe('select');
  });

  it('keeps the feed view security_invoker so it cannot widen access', () => {
    expect(allSqlLower).toContain('with (security_invoker = true)');
    expect(allSqlLower).toContain('set (security_invoker = true)');
  });
});

type Grant = { privileges: string[]; target: string; grantees: string[] };

function parseGrants(): Grant[] {
  return allStatements
    .filter((s) => /^grant\b/i.test(s))
    .map((s) => {
      const m = /^grant\s+(.+?)\s+on\s+(.+?)\s+to\s+(.+)$/i.exec(s);
      if (!m) throw new Error(`unparsable grant: ${s.slice(0, 120)}`);
      return {
        privileges: m[1].split(',').map((p) => p.trim().toLowerCase()),
        target: m[2].trim().toLowerCase(),
        grantees: m[3].split(',').map((g) => g.trim().toLowerCase()),
      };
    });
}

const grants = parseGrants();

describe('grants', () => {
  it('gives anon and authenticated SELECT on each readable target and nothing else', () => {
    const readable = [...SHARED_TABLES, 'aigundem.feed_articles_v1'];
    for (const target of readable) {
      const g = grants.find(
        (x) => x.target === target && x.grantees.includes('anon'),
      );
      expect(g).toBeDefined();
      expect(g!.privileges).toEqual(['select']);
      expect(g!.grantees).toContain('authenticated');
    }

    for (const g of grants) {
      const touchesClient = g.grantees.some((r) => (CLIENT_ROLES as readonly string[]).includes(r));
      if (!touchesClient) continue;
      for (const privilege of g.privileges) {
        // usage (schema) and execute (the search RPC) are the only non-select
        // privileges a client role may hold.
        expect(['select', 'usage', 'execute']).toContain(privilege);
      }
      expect(['insert', 'update', 'delete', 'all', 'all privileges', 'truncate']).not.toContain(
        g.privileges.join(' '),
      );
    }
  });

  it('never grants a client role anything inside private', () => {
    for (const g of grants) {
      if (!g.grantees.some((r) => (CLIENT_ROLES as readonly string[]).includes(r))) continue;
      expect(g.target).not.toContain('private');
    }
  });

  it('grants schema usage on aigundem to the client roles', () => {
    const usage = grants.find((g) => g.target === 'schema aigundem');
    expect(usage).toBeDefined();
    expect(usage!.privileges).toEqual(['usage']);
    for (const role of CLIENT_ROLES) expect(usage!.grantees).toContain(role);
  });

  it('revokes everything from public, anon and authenticated before granting', () => {
    const revokes = allStatements.filter((s) => /^revoke\b/i.test(s)).map((s) => s.toLowerCase());
    const required = [
      'revoke all on all tables in schema aigundem from public',
      'revoke all on all tables in schema aigundem from anon, authenticated',
      'revoke all on all tables in schema private from public',
      'revoke all on all tables in schema private from anon, authenticated',
      'revoke all on all functions in schema aigundem from public',
      'revoke all on all functions in schema private from public',
      'revoke all on schema private from anon, authenticated',
    ];
    for (const needle of required) expect(revokes).toContain(needle);
  });

  it('exposes exactly one function to client roles: the search RPC', () => {
    const clientExecutes = grants.filter(
      (g) =>
        g.privileges.includes('execute') &&
        g.grantees.some((r) => (CLIENT_ROLES as readonly string[]).includes(r)),
    );
    expect(clientExecutes).toHaveLength(1);
    expect(clientExecutes[0].target).toBe(
      'function aigundem.search_articles_v1(text, uuid[], integer)',
    );
  });

  it('reserves every internal helper for service_role', () => {
    const internals = [
      'function private.lease_due_sources(integer)',
      'function private.lease_ai_jobs(integer)',
      'function private.bump_rate_limit(text, text, timestamptz, integer)',
      'function aigundem.internal_lease_due_sources(integer)',
      'function aigundem.internal_lease_ai_jobs(integer)',
      'function aigundem.internal_bump_rate_limit(text, text, timestamptz, integer)',
    ];
    for (const target of internals) {
      const g = grants.find((x) => x.target === target);
      expect(g).toBeDefined();
      expect(g!.privileges).toEqual(['execute']);
      expect(g!.grantees).toEqual(['service_role']);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Functions.
// ---------------------------------------------------------------------------

const functionStatements = allStatements.filter((s) =>
  /^create\s+(or\s+replace\s+)?function\b/i.test(s),
);

describe('functions', () => {
  it('pins an empty search_path on every function, definer or not', () => {
    expect(functionStatements.length).toBeGreaterThan(0);
    for (const stmt of functionStatements) {
      expect(stmt.toLowerCase()).toContain("set search_path = ''");
    }
  });

  it('marks every SECURITY DEFINER function and schema-qualifies its body', () => {
    const definers = functionStatements.filter((s) => /security\s+definer/i.test(s));
    // The three private helpers plus their three PostgREST wrappers.
    expect(definers).toHaveLength(6);
    for (const stmt of definers) {
      expect(stmt.toLowerCase()).toContain("set search_path = ''");
      // With an empty search_path nothing resolves implicitly: every table and
      // function reference must carry a schema.
      for (const bare of [
        / from (?!aigundem\.|private\.|pg_catalog\.|information_schema\.|due\b|\()/i,
        / join (?!aigundem\.|private\.|pg_catalog\.)/i,
        / into (?!aigundem\.|private\.|pg_catalog\.|v_)/i,
      ]) {
        expect(stmt).not.toMatch(bare);
      }
    }
  });

  it('validates arguments in the rate-limit helper', () => {
    const bump = functionStatements.find((s) => s.includes('private.bump_rate_limit'))!;
    expect(bump.toLowerCase()).toContain('raise exception');
    expect(bump.toLowerCase()).toContain('invalid subject');
    expect(bump.toLowerCase()).toContain('invalid limit');
  });

  it('leases with SKIP LOCKED and a bounded batch size', () => {
    const sources = functionStatements.find((s) => s.includes('private.lease_due_sources'))!;
    const jobs = functionStatements.find((s) => s.includes('private.lease_ai_jobs'))!;
    for (const fn of [sources, jobs]) {
      expect(fn.toLowerCase()).toContain('for update skip locked');
      expect(fn.toLowerCase()).toMatch(/least\(greatest\(coalesce\(n, \d+\), 1\), \d+\)/);
    }
  });

  it('keeps the client search RPC on websearch_to_tsquery, invoker rights and a clamped limit', () => {
    const search = functionStatements.find((s) =>
      s.includes('aigundem.search_articles_v1'),
    )!;
    expect(search.toLowerCase()).toContain("websearch_to_tsquery('simple'");
    expect(search.toLowerCase()).not.toMatch(/security\s+definer/);
    expect(search.toLowerCase()).toContain('stable');
    expect(search.toLowerCase()).toContain('limit least(greatest(coalesce(lim, 20), 1), 50)');
  });
});

// ---------------------------------------------------------------------------
// The remote probe script the coordinator runs after applying the migrations.
// ---------------------------------------------------------------------------

describe('supabase/tests/rls-probes.sql', () => {
  const probesPath = join(__dirname, 'rls-probes.sql');
  const probes = existsSync(probesPath) ? readFileSync(probesPath, 'utf8') : '';

  it('exists and ends with a newline', () => {
    expect(existsSync(probesPath)).toBe(true);
    expect(probes.endsWith('\n')).toBe(true);
  });

  it('probes read access, write denial and private isolation for every table', () => {
    for (const table of SHARED_TABLES) {
      expect(probes).toContain(`from ${table}`);
    }
    for (const table of PRIVATE_TABLES) {
      expect(probes).toContain(table);
    }
    expect(probes).toContain('set local role anon');
    expect(probes).toContain('set local role authenticated');
    expect(probes.toLowerCase()).toContain('reset role');
    expect(probes.toLowerCase()).toContain('insert into aigundem.sources');
  });

  it('leaves no data behind: every probe block rolls back', () => {
    const begins = (probes.match(/^begin;/gm) ?? []).length;
    const rollbacks = (probes.match(/^\s*rollback;/gm) ?? []).length;
    expect(begins).toBeGreaterThan(0);
    expect(rollbacks).toBe(begins);
    expect(probes.toLowerCase()).not.toMatch(/^\s*commit;/m);
  });
});
