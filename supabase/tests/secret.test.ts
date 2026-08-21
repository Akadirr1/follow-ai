/**
 * Resolving the internal automations secret, and failing closed when it is
 * absent.
 *
 * The secret is not in `Deno.env` on this project — no Edge secret could be set
 * — so Vault is the source of truth and the environment is the fallback. Both
 * paths are injected here; nothing touches a real environment or database.
 */
import { AppError } from '../functions/_shared/error.ts';
import {
  AUTOMATIONS_SECRET_ENV,
  AUTOMATIONS_SECRET_NAME,
  createInternalSecretResolver,
  MIN_SECRET_LENGTH,
  requireResolvedInternalSecret,
  resolveInternalSecret,
} from '../functions/_shared/secret.ts';

const SECRET = 'a-sufficiently-long-automations-secret';
const envWith = (value?: string) => ({
  get: (name: string) => (name === AUTOMATIONS_SECRET_ENV ? value : undefined),
});
const headersWith = (value?: string) =>
  new Headers(value === undefined ? {} : { 'x-internal-secret': value });

describe('resolveInternalSecret', () => {
  it('prefers the environment when it is set, without touching the database', async () => {
    let rpcCalls = 0;
    const value = await resolveInternalSecret(envWith(SECRET), async () => {
      rpcCalls += 1;
      return 'from-vault';
    });
    expect(value).toBe(SECRET);
    expect(rpcCalls).toBe(0);
  });

  it('falls back to Vault when the environment has nothing', async () => {
    expect(await resolveInternalSecret(envWith(undefined), async () => SECRET)).toBe(SECRET);
    // An empty or whitespace env var is "unset", not "set to nothing".
    expect(await resolveInternalSecret(envWith(''), async () => SECRET)).toBe(SECRET);
    expect(await resolveInternalSecret(envWith('   '), async () => SECRET)).toBe(SECRET);
  });

  it('trims what it returns from either source', async () => {
    expect(await resolveInternalSecret(envWith(`  ${SECRET}  `), async () => null)).toBe(SECRET);
    expect(await resolveInternalSecret(envWith(undefined), async () => `\n${SECRET}\n`)).toBe(
      SECRET,
    );
  });

  it('returns null when neither source has it', async () => {
    expect(await resolveInternalSecret(envWith(undefined), async () => null)).toBeNull();
    expect(await resolveInternalSecret(envWith(undefined), async () => '')).toBeNull();
    expect(await resolveInternalSecret(envWith(undefined), async () => '   ')).toBeNull();
  });

  it('turns a Vault lookup failure into null rather than an unhandled rejection', async () => {
    // A database hiccup must fail closed as "not configured", never escape as a
    // different status or crash the isolate.
    const value = await resolveInternalSecret(envWith(undefined), async () => {
      throw new Error('connection reset');
    });
    expect(value).toBeNull();
  });

  it('names the Vault entry the cron jobs read', () => {
    expect(AUTOMATIONS_SECRET_NAME).toBe('aigundem_automations_secret');
    expect(AUTOMATIONS_SECRET_ENV).toBe('AUTOMATIONS_SECRET');
  });
});

describe('createInternalSecretResolver', () => {
  it('resolves once per request, not once per call', async () => {
    let rpcCalls = 0;
    const resolve = createInternalSecretResolver(envWith(undefined), async () => {
      rpcCalls += 1;
      return SECRET;
    });

    expect(await Promise.all([resolve(), resolve(), resolve()])).toEqual([
      SECRET,
      SECRET,
      SECRET,
    ]);
    expect(rpcCalls).toBe(1);
  });

  it('gives a fresh resolver a fresh lookup, so a rotated secret is picked up', async () => {
    // Deliberately NOT a module-level cache: an Edge isolate is reused across
    // requests and would keep serving the old value until it recycled.
    let current = SECRET;
    const make = () => createInternalSecretResolver(envWith(undefined), async () => current);

    expect(await make()()).toBe(SECRET);
    current = 'a-rotated-automations-secret';
    expect(await make()()).toBe('a-rotated-automations-secret');
  });
});

describe('requireResolvedInternalSecret', () => {
  const resolver = (value: string | null, onCall?: () => void) => async () => {
    onCall?.();
    return value;
  };

  it('accepts a caller presenting the right secret', async () => {
    await expect(
      requireResolvedInternalSecret(headersWith(SECRET), resolver(SECRET)),
    ).resolves.toBeUndefined();
  });

  it('rejects a missing header WITHOUT looking the secret up', async () => {
    // Otherwise anyone who finds the URL can force a Vault round trip per
    // request — a free amplifier.
    for (const headers of [headersWith(undefined), headersWith(''), headersWith('   ')]) {
      let looked = 0;
      await expect(
        requireResolvedInternalSecret(headers, resolver(SECRET, () => { looked += 1; })),
      ).rejects.toMatchObject({ code: 'unauthorized' });
      expect(looked).toBe(0);
    }
  });

  it('rejects a wrong secret as unauthorized', async () => {
    await expect(
      requireResolvedInternalSecret(headersWith('wrong-but-long-enough-value'), resolver(SECRET)),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('fails closed when the secret cannot be resolved at all', async () => {
    // Not "let everyone in": an unresolvable secret is a configuration error.
    await expect(
      requireResolvedInternalSecret(headersWith(SECRET), resolver(null)),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('refuses to treat a too-short value as a secret', async () => {
    const short = 'x'.repeat(MIN_SECRET_LENGTH - 1);
    await expect(
      requireResolvedInternalSecret(headersWith(short), resolver(short)),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('throws AppError, so the handler renders the standard envelope', async () => {
    await expect(
      requireResolvedInternalSecret(headersWith(undefined), resolver(SECRET)),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('never puts the expected secret into the error it throws', async () => {
    try {
      await requireResolvedInternalSecret(headersWith('wrong-but-long-enough-value'), resolver(SECRET));
      throw new Error('should have rejected');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(SECRET);
    }
  });
});
