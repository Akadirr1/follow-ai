/**
 * Which model provider answers, and with what key (addendum §H).
 *
 * Portable: Web APIs only, no Deno globals, no SDK. Both the environment and
 * the Vault reader are injected, so every branch runs under Jest with no
 * network and no key.
 *
 * WHY THIS EXISTS: there is no Anthropic key and there will not be one. The
 * human has a Google AI Studio key and an NVIDIA NIM key, already in Vault as
 * `aigundem_gemini_api_key` and `aigundem_nvidia_api_key`. The enrichment
 * pipeline does not care which model wrote the three bullets, so the provider
 * became configuration rather than a rewrite: same prompt, same validator, same
 * failure codes, same rows.
 *
 * THE ONE INVARIANT THAT MATTERS: `request-enrichment` and
 * `process-enrichments` must resolve the SAME model string. The summary cache
 * key is `(article_id, content_hash, prompt_version, model)`; if the handler
 * enqueued `gemini-2.5-flash` and the worker wrote `claude-opus-5`, every
 * lookup would miss forever and the client would poll a job that is already
 * done. Both call `resolveAiProvider`, and a test asserts they agree.
 */

import type { SummariseClient, SummariseInput, SummariseOutcome } from './anthropic.ts';
import { DEFAULT_MODEL as ANTHROPIC_DEFAULT_MODEL } from './anthropic-config.ts';
import {
  createGeminiClient,
  GEMINI_DEFAULT_MODEL,
  type GeminiConfig,
} from './providers/gemini.ts';
import {
  createNvidiaClient,
  NVIDIA_DEFAULT_MODEL,
  type NvidiaConfig,
} from './providers/nvidia.ts';
import type { FetchImpl } from './providers/http.ts';
import type { SecretEnv } from './secret.ts';

export type AiProviderName = 'gemini' | 'nvidia' | 'anthropic';

/**
 * Preference order for `auto`, and the order a fallback is picked in.
 *
 * Gemini first because `gemini-2.5-flash` is the cheapest of the three per
 * article and answered a schema'd call correctly when measured. NVIDIA second
 * because it is OpenAI-compatible and the 70B model is a genuine substitute.
 * Anthropic last because no key for it exists.
 */
export const PROVIDER_ORDER: readonly AiProviderName[] = ['gemini', 'nvidia', 'anthropic'];

export const AI_PROVIDER_ENV = 'AI_PROVIDER';

/** Vault entry names. The values never appear in code, logs or files. */
export const GEMINI_SECRET_NAME = 'aigundem_gemini_api_key';
export const NVIDIA_SECRET_NAME = 'aigundem_nvidia_api_key';

export const GEMINI_KEY_ENV = 'GEMINI_API_KEY';
export const NVIDIA_KEY_ENV = 'NVIDIA_API_KEY';
export const ANTHROPIC_KEY_ENV = 'ANTHROPIC_API_KEY';

export const GEMINI_MODEL_ENV = 'GEMINI_MODEL';
export const NVIDIA_MODEL_ENV = 'NVIDIA_MODEL';
export const ANTHROPIC_MODEL_ENV = 'ANTHROPIC_MODEL';

export const GEMINI_THINKING_BUDGET_ENV = 'GEMINI_THINKING_BUDGET';

/** Reads one allow-listed Vault secret by name; null when absent. */
export type GetSetting = (name: string) => Promise<string | null>;

export type ResolvedAiProvider = {
  provider: AiProviderName;
  /** Goes into the job row and the cache key. */
  model: string;
  client: SummariseClient;
  /** Present when a second provider has a key. */
  fallback?: { provider: AiProviderName; model: string };
};

export type AiProviderResolution = ResolvedAiProvider | { provider: null };

export type ResolveOptions = {
  fetchImpl: FetchImpl;
  timeoutMs?: number;
  now?: () => number;
  /**
   * Anthropic needs its SDK, which cannot be imported here without dragging a
   * npm specifier into a module Jest has to load. The Deno boundary passes a
   * factory; leaving it out simply makes `anthropic` unavailable, which is the
   * correct behaviour everywhere except inside `process-enrichments`.
   */
  createAnthropicClient?: (model: string) => SummariseClient;
};

function readEnv(env: SecretEnv, name: string): string | null {
  const value = (env.get(name) ?? '').trim();
  return value === '' ? null : value;
}

/**
 * Environment first, Vault second — the same precedence `secret.ts` uses.
 *
 * An env var wins because it costs no round trip and is how a deploy pins a
 * key; Vault is where the keys actually live today, because no Edge secret
 * could be set for this project.
 */
async function resolveKey(
  env: SecretEnv,
  getSetting: GetSetting,
  envName: string,
  secretName: string | null,
): Promise<string | null> {
  const fromEnv = readEnv(env, envName);
  if (fromEnv !== null) return fromEnv;
  if (secretName === null) return null;

  try {
    const fromVault = (await getSetting(secretName)) ?? '';
    return fromVault.trim() === '' ? null : fromVault.trim();
  } catch {
    // A Vault hiccup means "no key", never an unhandled rejection that could
    // surface as a different failure.
    return null;
  }
}

function parseProviderName(raw: string | null): AiProviderName | 'auto' {
  if (raw === 'gemini' || raw === 'nvidia' || raw === 'anthropic') return raw;
  return 'auto';
}

function modelFor(env: SecretEnv, provider: AiProviderName): string {
  switch (provider) {
    case 'gemini':
      return readEnv(env, GEMINI_MODEL_ENV) ?? GEMINI_DEFAULT_MODEL;
    case 'nvidia':
      return readEnv(env, NVIDIA_MODEL_ENV) ?? NVIDIA_DEFAULT_MODEL;
    case 'anthropic':
      return readEnv(env, ANTHROPIC_MODEL_ENV) ?? ANTHROPIC_DEFAULT_MODEL;
  }
}

/**
 * `0` disables Gemini's reasoning tokens and is the default: summarising an
 * article into three bullets does not need them, and the coordinator measured
 * flash spending 42 of them per call by default. A negative value means
 * "omit the field", for a model that rejects it.
 */
function thinkingBudgetFor(env: SecretEnv): number | null {
  const raw = readEnv(env, GEMINI_THINKING_BUDGET_ENV);
  if (raw === null) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return 0;
  return parsed < 0 ? null : parsed;
}

function buildClient(
  provider: AiProviderName,
  model: string,
  apiKey: string,
  options: ResolveOptions,
  env: SecretEnv,
): SummariseClient | null {
  switch (provider) {
    case 'gemini': {
      const config: GeminiConfig = {
        apiKey,
        model,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        thinkingBudget: thinkingBudgetFor(env),
        now: options.now,
      };
      return createGeminiClient(config);
    }
    case 'nvidia': {
      const config: NvidiaConfig = {
        apiKey,
        model,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        now: options.now,
      };
      return createNvidiaClient(config);
    }
    case 'anthropic':
      return options.createAnthropicClient ? options.createAnthropicClient(model) : null;
  }
}

type Candidate = { provider: AiProviderName; model: string; client: SummariseClient };

/**
 * Resolve the provider that will answer, and the one that covers for it.
 *
 * Returns `{provider: null}` when no key resolves anywhere — the caller turns
 * that into `skipped: 'no_api_key'`, exactly as the Anthropic-only version did.
 */
export async function resolveAiProvider(
  env: SecretEnv,
  getSetting: GetSetting,
  options: ResolveOptions,
): Promise<AiProviderResolution> {
  const requested = parseProviderName(readEnv(env, AI_PROVIDER_ENV));

  // Vault is asked at most once per name per resolution, even when `auto` walks
  // the whole order.
  const cache = new Map<string, Promise<string | null>>();
  const keyFor = (provider: AiProviderName): Promise<string | null> => {
    const cached = cache.get(provider);
    if (cached) return cached;
    const pending =
      provider === 'gemini'
        ? resolveKey(env, getSetting, GEMINI_KEY_ENV, GEMINI_SECRET_NAME)
        : provider === 'nvidia'
          ? resolveKey(env, getSetting, NVIDIA_KEY_ENV, NVIDIA_SECRET_NAME)
          : // Anthropic stays env-only: its key is not in Vault and adding it to
            // the allow-list would widen a read-any-secret surface for nothing.
            resolveKey(env, getSetting, ANTHROPIC_KEY_ENV, null);
    cache.set(provider, pending);
    return pending;
  };

  const candidateFor = async (provider: AiProviderName): Promise<Candidate | null> => {
    const apiKey = await keyFor(provider);
    if (apiKey === null) return null;
    const model = modelFor(env, provider);
    const client = buildClient(provider, model, apiKey, options, env);
    return client === null ? null : { provider, model, client };
  };

  // An explicit choice is honoured exactly: if that provider has no key, the
  // answer is "no provider", not "something else". Silently answering with a
  // different model than the operator asked for would put a model string in the
  // cache key that nobody chose.
  const order: readonly AiProviderName[] =
    requested === 'auto' ? PROVIDER_ORDER : [requested];

  let primary: Candidate | null = null;
  for (const provider of order) {
    primary = await candidateFor(provider);
    if (primary) break;
  }
  if (!primary) return { provider: null };

  // The fallback is the next provider in the fixed order that has a key,
  // whether or not the primary was explicit — "a second provider has a key" is
  // the whole condition. Removing the second key is how you opt out.
  let fallback: Candidate | null = null;
  for (const provider of PROVIDER_ORDER) {
    if (provider === primary.provider) continue;
    fallback = await candidateFor(provider);
    if (fallback) break;
  }

  if (!fallback) {
    return { provider: primary.provider, model: primary.model, client: primary.client };
  }

  return {
    provider: primary.provider,
    model: primary.model,
    client: withFallback(primary, fallback),
    fallback: { provider: fallback.provider, model: fallback.model },
  };
}

/**
 * Try the primary; on a RETRYABLE failure, try the secondary once.
 *
 * Inside the same job, before backoff: a 429 from Google's free tier is exactly
 * the case where a second provider earns its keep, and waiting an hour to
 * discover NVIDIA would have answered immediately is the wrong trade.
 *
 * A non-retryable failure is NOT retried elsewhere. `refusal`, `auth`,
 * `bad_request` and every `schema_*` mean the request or the article is the
 * problem, and asking a different model produces the same answer at double the
 * cost — except `refusal`, where a second opinion on a safety stop is a
 * deliberate policy choice nobody has made.
 *
 * The successful outcome carries the SECONDARY's model, which the worker logs
 * as `usedModel`. It is not what lands in the row: the row keeps the job's
 * model so the cache key stays the one `request-enrichment` looks up.
 */
export function withFallback(primary: Candidate, secondary: Candidate): SummariseClient {
  return {
    async summarise(input: SummariseInput): Promise<SummariseOutcome> {
      const first = await primary.client.summarise(input);
      if (first.ok || !first.retryable) return first;

      const second = await secondary.client.summarise(input);
      if (second.ok) return second;

      // Both failed. Report the PRIMARY's failure: it is the provider the
      // operator chose, its code drives the backoff, and a secondary that is
      // also down should not rewrite the diagnosis.
      return first;
    },
  };
}
