/**
 * Google Gemini (AI Studio) via the REST `generateContent` endpoint.
 *
 * Portable: Web APIs only, no Deno globals, no SDK. `fetch` is injected, so the
 * request shape and every failure branch run under Jest with no network and no
 * key.
 *
 * Shape measured by the coordinator on 2026-08-21 against `gemini-2.5-flash`:
 * a schema'd call answered correctly and spent 42 thinking tokens by default,
 * which is why `thinkingBudget` defaults to 0 here — the task is "summarise
 * this article into three bullets", and paying for reasoning tokens on every
 * article is a cost with no visible return.
 *
 * The key travels in the `x-goog-api-key` header and NEVER in the URL: query
 * strings end up in proxy logs, error messages and browser history in a way
 * headers do not.
 */

import {
  MAX_TOKENS_DEFAULT,
  MAX_ARTICLE_CHARS_DEFAULT,
} from '../anthropic-config.ts';
import type { SummariseClient, SummariseInput, SummariseOutcome, TokenUsage } from '../anthropic.ts';
import { buildArticleBlock, SYSTEM_PROMPT_V1 } from '../prompt.ts';
import { parseAndValidate } from '../schemas.ts';
import { classifyProviderStatus, postJson, PROVIDER_TIMEOUT_MS, type FetchImpl } from './http.ts';

export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
export const GEMINI_API_KEY_HEADER = 'x-goog-api-key';

/**
 * Gemini's `responseSchema` is an OpenAPI 3.0 subset, not JSON Schema:
 * uppercase type names, `nullable: true` in place of a `["string","null"]`
 * union, and no `additionalProperties`.
 *
 * `minItems`/`maxItems` are DELIBERATELY ABSENT. The coordinator measured that
 * the subset does not guarantee them, and an unsupported key here would be a
 * 400 on every single call — a fatal risk in exchange for a constraint that
 * buys nothing, because `parseAndValidate` re-checks the exact bullet count
 * anyway and the system prompt already says "tam olarak üç". The count lives in
 * the description instead, which the subset does support.
 */
export const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description:
        'Exactly three Turkish bullet points, most important first, each at most 500 characters.',
    },
    translation: {
      type: 'STRING',
      nullable: true,
      description:
        'Full Turkish translation of the article body, or null when the article is already Turkish.',
    },
  },
  required: ['summary', 'translation'],
} as const;

export type GeminiConfig = {
  apiKey: string;
  model?: string;
  fetchImpl: FetchImpl;
  timeoutMs?: number;
  /**
   * `0` disables reasoning tokens. `null` omits the field entirely, which is
   * what a model that rejects the parameter needs.
   */
  thinkingBudget?: number | null;
  now?: () => number;
};

export type GeminiRequestBody = {
  contents: Array<{ parts: Array<{ text: string }> }>;
  systemInstruction: { parts: Array<{ text: string }> };
  generationConfig: {
    responseMimeType: 'application/json';
    responseSchema: unknown;
    maxOutputTokens: number;
    temperature: number;
    thinkingConfig?: { thinkingBudget: number };
  };
};

export type BuiltGeminiRequest = {
  url: string;
  headers: Record<string, string>;
  body: GeminiRequestBody;
};

/** Build the request. Pure: no key handling beyond placing it in the header. */
export function buildGeminiRequest(
  input: SummariseInput,
  config: GeminiConfig,
): BuiltGeminiRequest {
  const model = config.model ?? GEMINI_DEFAULT_MODEL;
  const block = buildArticleBlock(
    input.article,
    input.maxArticleChars ?? MAX_ARTICLE_CHARS_DEFAULT,
  );

  const body: GeminiRequestBody = {
    // The stable system text is its own field, so the volatile article can
    // never be mistaken for instructions — the same separation the Anthropic
    // request relies on.
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT_V1 }] },
    contents: [{ parts: [{ text: block.text }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: GEMINI_RESPONSE_SCHEMA,
      maxOutputTokens: input.maxTokens ?? MAX_TOKENS_DEFAULT,
      // Deterministic: two runs over the same article should not produce two
      // different summaries, and creativity is not what this task wants.
      temperature: 0,
    },
  };

  const budget = config.thinkingBudget === undefined ? 0 : config.thinkingBudget;
  if (budget !== null) {
    body.generationConfig.thinkingConfig = { thinkingBudget: budget };
  }

  return {
    url: `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
    headers: { [GEMINI_API_KEY_HEADER]: config.apiKey },
    body,
  };
}

/** The parts of a `generateContent` response this code reads. */
export type GeminiResponseLike = {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string }> };
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
};

export function readGeminiUsage(response: GeminiResponseLike): TokenUsage {
  const usage = response.usageMetadata ?? {};
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    // Thinking tokens are billed as output, so folding them in makes the number
    // a cost figure rather than a partial one. With thinkingBudget 0 it is
    // normally zero anyway.
    outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    cacheReadTokens: usage.cachedContentTokenCount ?? 0,
    cacheWriteTokens: 0,
  };
}

/** Terminal reasons Gemini gives for refusing to answer. */
const REFUSAL_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
]);

/**
 * Turn a 200 response into a validated payload or a failure.
 *
 * `MAX_TOKENS` maps to `output_truncated`, which the worker retries exactly
 * once with the escalated ceiling and then fails — the same rule Claude gets,
 * because a truncation retried at the same ceiling truncates again.
 */
export function interpretGeminiResponse(
  raw: unknown,
  articleLanguage: SummariseInput['article']['language'],
  fallbackModel: string,
): SummariseOutcome {
  const response = (raw ?? {}) as GeminiResponseLike;
  const usage = readGeminiUsage(response);
  const model = response.modelVersion ?? fallbackModel;

  const blocked = response.promptFeedback?.blockReason;
  if (blocked) {
    return { ok: false, code: 'refusal', retryable: false, detail: `prompt=${blocked}`.slice(0, 60) };
  }

  const candidate = response.candidates?.[0];
  if (!candidate) {
    // No candidate and no block reason: nothing to read and nothing to explain.
    return { ok: false, code: 'refusal', retryable: false, detail: 'no_candidates' };
  }

  const finish = candidate.finishReason;
  if (finish === 'MAX_TOKENS') {
    return { ok: false, code: 'output_truncated', retryable: true };
  }
  if (finish && REFUSAL_REASONS.has(finish)) {
    return { ok: false, code: 'refusal', retryable: false, detail: finish.slice(0, 40) };
  }
  if (finish && finish !== 'STOP') {
    return { ok: false, code: 'unexpected_stop', retryable: false, detail: finish.slice(0, 40) };
  }

  const text = candidate.content?.parts?.find((part) => typeof part.text === 'string')?.text;
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, code: 'no_text_block', retryable: false };
  }

  const validated = parseAndValidate(text, articleLanguage);
  if (!validated.ok) {
    // A schema-constrained request that produced the wrong shape will produce
    // it again; retrying is a paid no-op.
    return {
      ok: false,
      code: `schema_${validated.violation}`,
      retryable: false,
      detail: validated.detail,
    };
  }

  return { ok: true, payload: validated.value, usage, model };
}

/** The real Gemini client. Failures are values, never throws. */
export function createGeminiClient(config: GeminiConfig): SummariseClient {
  const model = config.model ?? GEMINI_DEFAULT_MODEL;

  return {
    async summarise(input: SummariseInput): Promise<SummariseOutcome> {
      const { url, headers, body } = buildGeminiRequest(input, config);

      const response = await postJson(url, headers, body, {
        fetchImpl: config.fetchImpl,
        timeoutMs: config.timeoutMs ?? PROVIDER_TIMEOUT_MS,
        now: config.now,
      });

      if (!response.ok) return response;
      return interpretGeminiResponse(response.json, input.article.language, model);
    },
  };
}

export { classifyProviderStatus as classifyGeminiStatus };
