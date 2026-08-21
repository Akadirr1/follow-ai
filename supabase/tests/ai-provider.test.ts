/**
 * Which provider answers, with which key, under which model string.
 *
 * The last of those is the one that can quietly break the product:
 * `request-enrichment` enqueues a job under a model string and
 * `process-enrichments` writes the summary under one. They are part of the same
 * cache key, so if they ever disagree the lookup misses forever and the client
 * polls a job that is already finished. Both call `resolveAiProvider`; this file
 * asserts that, behaviourally and in the source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ANTHROPIC_KEY_ENV,
  GEMINI_KEY_ENV,
  GEMINI_MODEL_ENV,
  GEMINI_SECRET_NAME,
  NVIDIA_KEY_ENV,
  NVIDIA_SECRET_NAME,
  PROVIDER_ORDER,
  resolveAiProvider,
  withFallback,
} from '../functions/_shared/ai-provider.ts';
import { GEMINI_DEFAULT_MODEL } from '../functions/_shared/providers/gemini.ts';
import { NVIDIA_DEFAULT_MODEL } from '../functions/_shared/providers/nvidia.ts';
import { DEFAULT_MODEL as ANTHROPIC_DEFAULT_MODEL } from '../functions/_shared/anthropic-config.ts';
import type { SummariseClient, SummariseOutcome } from '../functions/_shared/anthropic.ts';

const ARTICLE = {
  title: 'OpenAI ships a new model',
  sourceName: 'OpenAI Blog',
  language: 'en' as const,
  contentText: 'The company announced a model today.',
  contentQuality: 'full' as const,
};

const envOf = (vars: Record<string, string>) => ({
  get: (name: string) => vars[name],
});

const noVault = async () => null;

const vaultOf = (entries: Record<string, string>) => {
  const reads: string[] = [];
  return {
    reads,
    get: async (name: string) => {
      reads.push(name);
      return entries[name] ?? null;
    },
  };
};

const options = { fetchImpl: async () => new Response('{}') };

// ===========================================================================
// Key resolution
// ===========================================================================

describe('resolveAiProvider: where a key comes from', () => {
  it('prefers the environment over Vault, without a round trip', async () => {
    const vault = vaultOf({ [GEMINI_SECRET_NAME]: 'from-vault' });
    const resolved = await resolveAiProvider(
      envOf({ [GEMINI_KEY_ENV]: 'from-env' }),
      vault.get,
      options,
    );

    expect(resolved.provider).toBe('gemini');
    // An env var costs nothing and is how a deploy pins a key.
    expect(vault.reads).not.toContain(GEMINI_SECRET_NAME);
  });

  it('falls back to Vault, which is where the keys actually live', async () => {
    const vault = vaultOf({ [GEMINI_SECRET_NAME]: 'from-vault' });
    const resolved = await resolveAiProvider(envOf({}), vault.get, options);

    expect(resolved.provider).toBe('gemini');
    expect(vault.reads).toContain(GEMINI_SECRET_NAME);
  });

  it('treats an empty or whitespace value as no key at all', async () => {
    const vault = vaultOf({ [GEMINI_SECRET_NAME]: '   ' });
    const resolved = await resolveAiProvider(
      envOf({ [GEMINI_KEY_ENV]: '  ' }),
      vault.get,
      options,
    );
    expect(resolved.provider).toBeNull();
  });

  it('never asks Vault for the Anthropic key', async () => {
    // It is not stored there, and adding it to the allow-list would widen a
    // read-any-secret surface for nothing.
    const vault = vaultOf({});
    await resolveAiProvider(envOf({ [ANTHROPIC_KEY_ENV]: 'sk-test' }), vault.get, {
      ...options,
      createAnthropicClient: () => ({ summarise: async () => ({ ok: false, code: 'unknown', retryable: true }) }),
    });
    expect(vault.reads).not.toContain('aigundem_anthropic_api_key');
  });

  it('asks Vault at most once per name even when auto walks the whole order', async () => {
    const vault = vaultOf({ [NVIDIA_SECRET_NAME]: 'k' });
    await resolveAiProvider(envOf({}), vault.get, options);
    const gemini = vault.reads.filter((n) => n === GEMINI_SECRET_NAME);
    expect(gemini.length).toBeLessThanOrEqual(1);
  });

  it('treats a Vault failure as "no key" rather than an unhandled rejection', async () => {
    const resolved = await resolveAiProvider(
      envOf({}),
      async () => {
        throw new Error('connection reset');
      },
      options,
    );
    expect(resolved.provider).toBeNull();
  });

  it('returns no provider when nothing has a key anywhere', async () => {
    expect(await resolveAiProvider(envOf({}), noVault, options)).toEqual({ provider: null });
  });
});

// ===========================================================================
// Selection
// ===========================================================================

describe('resolveAiProvider: which provider', () => {
  it('walks gemini then nvidia then anthropic under auto', async () => {
    expect(PROVIDER_ORDER).toEqual(['gemini', 'nvidia', 'anthropic']);

    const both = await resolveAiProvider(
      envOf({ [GEMINI_KEY_ENV]: 'g', [NVIDIA_KEY_ENV]: 'n' }),
      noVault,
      options,
    );
    expect(both.provider).toBe('gemini');

    const onlyNvidia = await resolveAiProvider(envOf({ [NVIDIA_KEY_ENV]: 'n' }), noVault, options);
    expect(onlyNvidia.provider).toBe('nvidia');
  });

  it('honours an explicit choice exactly, and refuses rather than substituting', async () => {
    // Silently answering with a provider nobody asked for would put a model
    // string in the cache key that nobody chose.
    const resolved = await resolveAiProvider(
      envOf({ AI_PROVIDER: 'nvidia', [GEMINI_KEY_ENV]: 'g' }),
      noVault,
      options,
    );
    expect(resolved.provider).toBeNull();
  });

  it('uses the documented default model per provider', async () => {
    const gemini = await resolveAiProvider(envOf({ [GEMINI_KEY_ENV]: 'g' }), noVault, options);
    expect(gemini.provider !== null && gemini.model).toBe(GEMINI_DEFAULT_MODEL);
    expect(gemini.provider !== null && gemini.model).toBe('gemini-2.5-flash');

    const nvidia = await resolveAiProvider(envOf({ [NVIDIA_KEY_ENV]: 'n' }), noVault, options);
    expect(nvidia.provider !== null && nvidia.model).toBe(NVIDIA_DEFAULT_MODEL);
    expect(nvidia.provider !== null && nvidia.model).toBe('meta/llama-3.3-70b-instruct');
  });

  it('lets each model be overridden without touching code', async () => {
    const resolved = await resolveAiProvider(
      envOf({ [GEMINI_KEY_ENV]: 'g', [GEMINI_MODEL_ENV]: 'gemini-2.5-pro' }),
      noVault,
      options,
    );
    expect(resolved.provider !== null && resolved.model).toBe('gemini-2.5-pro');
  });

  it('offers anthropic only when the Deno boundary supplies its factory', async () => {
    // The SDK cannot be imported into a portable module, so without the factory
    // an Anthropic key resolves to nothing rather than to a broken client.
    const withoutFactory = await resolveAiProvider(
      envOf({ [ANTHROPIC_KEY_ENV]: 'sk-test' }),
      noVault,
      options,
    );
    expect(withoutFactory.provider).toBeNull();

    const withFactory = await resolveAiProvider(envOf({ [ANTHROPIC_KEY_ENV]: 'sk-test' }), noVault, {
      ...options,
      createAnthropicClient: () => ({
        summarise: async () => ({ ok: false, code: 'unknown', retryable: true }),
      }),
    });
    expect(withFactory.provider).toBe('anthropic');
    expect(withFactory.provider !== null && withFactory.model).toBe(ANTHROPIC_DEFAULT_MODEL);
  });
});

// ===========================================================================
// Fallback
// ===========================================================================

function client(outcomes: SummariseOutcome[]): SummariseClient & { calls: number } {
  let i = 0;
  const impl = {
    calls: 0,
    async summarise() {
      impl.calls += 1;
      return outcomes[Math.min(i++, outcomes.length - 1)];
    },
  };
  return impl;
}

const OK = (model: string): SummariseOutcome => ({
  ok: true,
  payload: { summary: ['bir', 'iki', 'üç'], translation: 'çeviri' },
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model,
});

describe('withFallback', () => {
  it('tries the secondary once when the primary fails retryably', async () => {
    // A 429 from Google's free tier is exactly the case a second key earns its
    // keep: waiting an hour to discover NVIDIA would have answered is the
    // wrong trade.
    const primary = client([{ ok: false, code: 'rate_limited', retryable: true }]);
    const secondary = client([OK('meta/llama-3.3-70b-instruct')]);

    const result = await withFallback(
      { provider: 'gemini', model: 'gemini-2.5-flash', client: primary },
      { provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', client: secondary },
    ).summarise({ article: ARTICLE });

    expect(result.ok).toBe(true);
    expect(result.ok && result.model).toBe('meta/llama-3.3-70b-instruct');
    expect(primary.calls).toBe(1);
    expect(secondary.calls).toBe(1);
  });

  it('does NOT fall back on a non-retryable failure', async () => {
    // refusal / auth / bad_request / schema_* mean the request or the article
    // is the problem; a second model gives the same answer at double the cost.
    for (const code of ['refusal', 'auth', 'bad_request', 'schema_not_json'] as const) {
      const primary = client([{ ok: false, code, retryable: false }]);
      const secondary = client([OK('meta/llama-3.3-70b-instruct')]);

      const result = await withFallback(
        { provider: 'gemini', model: 'gemini-2.5-flash', client: primary },
        { provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', client: secondary },
      ).summarise({ article: ARTICLE });

      expect({ code, ok: result.ok }).toEqual({ code, ok: false });
      expect({ code, calls: secondary.calls }).toEqual({ code, calls: 0 });
    }
  });

  it('never tries the secondary when the primary succeeds', async () => {
    const primary = client([OK('gemini-2.5-flash')]);
    const secondary = client([OK('meta/llama-3.3-70b-instruct')]);

    const result = await withFallback(
      { provider: 'gemini', model: 'gemini-2.5-flash', client: primary },
      { provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', client: secondary },
    ).summarise({ article: ARTICLE });

    expect(result.ok && result.model).toBe('gemini-2.5-flash');
    expect(secondary.calls).toBe(0);
  });

  it('reports the PRIMARY failure when both are down', async () => {
    // The primary's code drives the backoff, and a secondary that is also down
    // should not rewrite the diagnosis.
    const primary = client([{ ok: false, code: 'rate_limited', retryable: true, retryAfterSeconds: 30 }]);
    const secondary = client([{ ok: false, code: 'server_error', retryable: true }]);

    const result = await withFallback(
      { provider: 'gemini', model: 'gemini-2.5-flash', client: primary },
      { provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct', client: secondary },
    ).summarise({ article: ARTICLE });

    expect(result).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 30 });
  });

  it('is wired in automatically when a second key exists, and absent when it does not', async () => {
    const paired = await resolveAiProvider(
      envOf({ [GEMINI_KEY_ENV]: 'g', [NVIDIA_KEY_ENV]: 'n' }),
      noVault,
      options,
    );
    expect(paired.provider !== null && paired.fallback).toEqual({
      provider: 'nvidia',
      model: NVIDIA_DEFAULT_MODEL,
    });

    const alone = await resolveAiProvider(envOf({ [GEMINI_KEY_ENV]: 'g' }), noVault, options);
    expect(alone.provider !== null && alone.fallback).toBeUndefined();
  });
});

// ===========================================================================
// The cache key must not diverge
// ===========================================================================

describe('the two functions resolve the same model string', () => {
  const cases: Record<string, string>[] = [
    { [GEMINI_KEY_ENV]: 'g' },
    { [NVIDIA_KEY_ENV]: 'n' },
    { [GEMINI_KEY_ENV]: 'g', [NVIDIA_KEY_ENV]: 'n' },
    { AI_PROVIDER: 'nvidia', [NVIDIA_KEY_ENV]: 'n' },
    { [GEMINI_KEY_ENV]: 'g', [GEMINI_MODEL_ENV]: 'gemini-2.5-flash-lite' },
  ];

  it.each(cases)('agrees for %o', async (vars) => {
    // request-enrichment resolves with no Anthropic factory (it never calls a
    // provider); process-enrichments resolves with one. That difference must
    // not change the model string for any configuration either can serve.
    const asHandler = await resolveAiProvider(envOf(vars), noVault, options);
    const asWorker = await resolveAiProvider(envOf(vars), noVault, {
      ...options,
      createAnthropicClient: () => ({
        summarise: async () => ({ ok: false, code: 'unknown', retryable: true }),
      }),
    });

    expect(asHandler.provider).toBe(asWorker.provider);
    expect(asHandler.provider !== null && asHandler.model).toBe(
      asWorker.provider !== null && asWorker.model,
    );
  });

  /**
   * A source-level check, because the behavioural one above cannot see a
   * handler that resolves correctly and then passes something else along. This
   * is the exact regression the brief warns about: a hard-coded model in
   * `request-enrichment` would make every lookup a permanent miss.
   */
  it('request-enrichment feeds the resolver output into the cache key', () => {
    const source = readFileSync(
      join(__dirname, '..', 'functions', 'request-enrichment', 'index.ts'),
      'utf8',
    );

    expect(source).toContain('resolveAiProvider');
    expect(source).toContain('resolved.provider !== null ? resolved.model');
    expect(source).toContain('hasApiKey = resolved.provider !== null');
    // The old hard-coded pair is gone.
    expect(source).not.toContain("Deno.env.get('ANTHROPIC_MODEL')");
    expect(source).not.toContain("(Deno.env.get('ANTHROPIC_API_KEY') ?? '').trim() !== ''");
  });

  it('process-enrichments passes the resolver output as the job model', () => {
    const source = readFileSync(
      join(__dirname, '..', 'functions', 'process-enrichments', 'index.ts'),
      'utf8',
    );

    expect(source).toContain('resolveAiProvider');
    expect(source).toContain('client: resolved.client');
    expect(source).toContain('model: resolved.model');
    // `skipped: no_api_key` is now "no provider resolved", not "no Anthropic".
    expect(source).toContain('resolved.provider === null');
    expect(source).not.toContain('config.apiKey === null');
  });

  it('both read their keys through the same memoised Vault reader', () => {
    for (const fn of ['request-enrichment', 'process-enrichments']) {
      const source = readFileSync(join(__dirname, '..', 'functions', fn, 'index.ts'), 'utf8');
      expect({ fn, memoised: source.includes('function vaultReader(') }).toEqual({
        fn,
        memoised: true,
      });
      expect({ fn, cached: source.includes('cache.set(name, pending)') }).toEqual({
        fn,
        cached: true,
      });
    }
  });
});

// ===========================================================================
// No key value ever reaches a log, a file or an error
// ===========================================================================

describe('keys stay out of everything observable', () => {
  it('never puts a key in the URL or in a failure detail', async () => {
    // Built from fragments so the literal Google key prefix never appears in
    // this file: A4 greps the tree for it, and a test fixture that trips the
    // leak check is indistinguishable from a real leak.
    const secret = ['AI', 'za', 'Sy', 'TESTKEYNOTREAL', '0'.repeat(20)].join('');
    const seen: string[] = [];

    const resolved = await resolveAiProvider(envOf({ [GEMINI_KEY_ENV]: secret }), noVault, {
      fetchImpl: async (url) => {
        seen.push(url);
        return new Response(JSON.stringify({ error: 'bad key' }), { status: 401 });
      },
    });

    expect(resolved.provider).toBe('gemini');
    const outcome =
      resolved.provider !== null ? await resolved.client.summarise({ article: ARTICLE }) : null;

    expect(seen.every((url) => !url.includes(secret))).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(JSON.stringify(resolved.provider !== null ? { p: resolved.provider, m: resolved.model } : {}))
      .not.toContain(secret);
  });
});
