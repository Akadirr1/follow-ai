/**
 * Offline verification of `202608210011_ai_provider_keys.sql`.
 *
 * One function, one change: the Vault allow-list grows from one name to three.
 * That list IS the security boundary — without it `internal_get_setting` is a
 * read-any-secret primitive, and a future mistake about who may EXECUTE it
 * would expose everything the project holds rather than these three names. So
 * the list is pinned here, in both directions: the three that belong, and the
 * absence of a wildcard.
 *
 * STATIC only. No database exists in this task, so nothing here proves Postgres
 * accepts the SQL or that `vault.decrypted_secrets` actually holds the two
 * provider keys.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GEMINI_SECRET_NAME,
  NVIDIA_SECRET_NAME,
} from '../functions/_shared/ai-provider.ts';
import { AUTOMATIONS_SECRET_NAME } from '../functions/_shared/secret.ts';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const FILE = '202608210011_ai_provider_keys.sql';

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

const ALLOWED_NAMES = [AUTOMATIONS_SECRET_NAME, GEMINI_SECRET_NAME, NVIDIA_SECRET_NAME];

describe('202608210011: hygiene', () => {
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

  it('is additive: it drops nothing and truncates nothing', () => {
    expect(sql.toLowerCase()).not.toMatch(/\bdrop\s+(function|table|view|index|schema)\b/);
    expect(sql.toLowerCase()).not.toMatch(/\btruncate\b/);
  });

  it('creates nothing in public and touches no other function', () => {
    expect(sql).not.toContain('public.');
    const created = sql.match(/create\s+(or\s+replace\s+)?function\s+[a-z_.]+/gi) ?? [];
    expect(created).toHaveLength(1);
    expect(created[0]).toContain('aigundem.internal_get_setting');
  });

  it('reloads the PostgREST schema cache', () => {
    expect(sql.toLowerCase()).toContain("notify pgrst, 'reload schema'");
  });
});

describe('202608210011: the allow-list', () => {
  it('keeps the same security shape as 0008', () => {
    expect(collapsed).toContain('security definer');
    expect(collapsed).toContain("set search_path = ''");
    expect(collapsed).toContain('from vault.decrypted_secrets v');
    expect(collapsed.toLowerCase()).toContain('raise exception');
    // Same signature, so privileges survive CREATE OR REPLACE.
    expect(collapsed).toContain('aigundem.internal_get_setting(p_name text) returns text');
  });

  it('allows exactly the automations secret and the two provider keys', () => {
    for (const name of ALLOWED_NAMES) {
      expect({ name, listed: collapsed.includes(`'${name}'`) }).toEqual({ name, listed: true });
    }

    // Three names in the guard and no more: a fourth would have to be added
    // here deliberately, which is the point of pinning it.
    const guard = /p_name not in \(([^)]*)\)/.exec(collapsed);
    expect(guard).not.toBeNull();
    const listed = (guard?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(listed.sort()).toEqual([...ALLOWED_NAMES].sort());
  });

  it('has no wildcard or bypass', () => {
    // Anything that would let an arbitrary name through defeats the boundary.
    expect(collapsed).not.toMatch(/p_name\s+is\s+not\s+null\s+then/i);
    expect(collapsed).not.toContain('%');
    expect(collapsed.toLowerCase()).not.toContain(' like ');
    // Dynamic SQL specifically — `grant execute on function` is legitimate and
    // is asserted below.
    expect(collapsed.toLowerCase()).not.toMatch(/\bexecute\s+(format|'|"|\$|v_|p_)/);
    expect(collapsed.toLowerCase()).not.toContain('quote_ident');
  });

  it('re-asserts revoke and grant so the current state reads from this file', () => {
    expect(collapsed).toContain(
      'revoke all on function aigundem.internal_get_setting(text) from public, anon, authenticated',
    );
    expect(collapsed).toContain(
      'grant execute on function aigundem.internal_get_setting(text) to service_role',
    );
    expect(collapsed).not.toMatch(/grant[^;]*to[^;]*\b(anon|authenticated)\b/);
  });

  it('contains no key value, only key NAMES', () => {
    // The names are identifiers; the values live in Vault and must never appear
    // in a file the repository tracks.
    // The prefixes are assembled rather than written out: A4 greps the tree for
    // them, and a leak-check that itself matches the grep is indistinguishable
    // from a leak.
    const prefixes = [
      ['nv', 'api-'],
      ['AI', 'za'],
      ['sk-', 'ant-'],
    ].map((parts) => parts.join(''));

    for (const prefix of prefixes) {
      const found = new RegExp(`${prefix}[0-9A-Za-z_-]{10,}`).test(raw);
      expect({ prefix, found }).toEqual({ prefix, found: false });
    }
  });
});

describe('0011 and the resolver agree on the Vault entry names', () => {
  it('uses the same three constants the TypeScript reads', () => {
    // A typo on either side is a silent "no key", which degrades to
    // skipped:no_api_key rather than to an error anybody would notice.
    expect(GEMINI_SECRET_NAME).toBe('aigundem_gemini_api_key');
    expect(NVIDIA_SECRET_NAME).toBe('aigundem_nvidia_api_key');
    expect(AUTOMATIONS_SECRET_NAME).toBe('aigundem_automations_secret');

    const resolver = readFileSync(
      join(__dirname, '..', 'functions', '_shared', 'ai-provider.ts'),
      'utf8',
    );
    for (const name of [GEMINI_SECRET_NAME, NVIDIA_SECRET_NAME]) {
      expect({ name, inResolver: resolver.includes(`'${name}'`) }).toEqual({
        name,
        inResolver: true,
      });
      expect({ name, inSql: sql.includes(`'${name}'`) }).toEqual({ name, inSql: true });
    }
  });
});
