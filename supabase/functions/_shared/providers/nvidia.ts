/**
 * NVIDIA NIM via its OpenAI-compatible chat-completions endpoint.
 *
 * Portable: Web APIs only, no Deno globals, no SDK. `fetch` is injected, so the
 * request shape and every failure branch run under Jest with no network and no
 * key.
 *
 * Shape measured by the coordinator on 2026-08-21 against
 * `meta/llama-3.3-70b-instruct`, which answered correctly in JSON mode.
 *
 * NOTE ON JSON MODE: `response_format: {type:'json_object'}` requires the word
 * "JSON" to appear in the prompt — OpenAI's rule, which NIM inherits. Our
 * system prompt already says it in the ÇIKTI section, and a test pins that so a
 * future prompt edit cannot silently break every NVIDIA call.
 *
 * Unlike Gemini there is no server-side schema here, only "valid JSON". That is
 * fine and does not weaken anything: `parseAndValidate` was always the
 * authority on shape, and it is the same validator for all three providers.
 */

import {
  MAX_TOKENS_DEFAULT,
  MAX_ARTICLE_CHARS_DEFAULT,
} from '../anthropic-config.ts';
import type { SummariseClient, SummariseInput, SummariseOutcome, TokenUsage } from '../anthropic.ts';
import { buildArticleBlock, SYSTEM_PROMPT_V1 } from '../prompt.ts';
import { parseAndValidate } from '../schemas.ts';
import { classifyProviderStatus, postJson, PROVIDER_TIMEOUT_MS, type FetchImpl } from './http.ts';

export const NVIDIA_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';
export const NVIDIA_DEFAULT_MODEL = 'meta/llama-3.3-70b-instruct';

export type NvidiaConfig = {
  apiKey: string;
  model?: string;
  fetchImpl: FetchImpl;
  timeoutMs?: number;
  now?: () => number;
};

export type NvidiaRequestBody = {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  response_format: { type: 'json_object' };
  max_tokens: number;
  temperature: number;
};

export type BuiltNvidiaRequest = {
  url: string;
  headers: Record<string, string>;
  body: NvidiaRequestBody;
};

export function buildNvidiaRequest(
  input: SummariseInput,
  config: NvidiaConfig,
): BuiltNvidiaRequest {
  const model = config.model ?? NVIDIA_DEFAULT_MODEL;
  const block = buildArticleBlock(
    input.article,
    input.maxArticleChars ?? MAX_ARTICLE_CHARS_DEFAULT,
  );

  return {
    url: NVIDIA_ENDPOINT,
    headers: { authorization: `Bearer ${config.apiKey}` },
    body: {
      model,
      // System first, article second — the untrusted block is never the turn
      // that carries instructions.
      messages: [
        { role: 'system', content: SYSTEM_PROMPT_V1 },
        { role: 'user', content: block.text },
      ],
      response_format: { type: 'json_object' },
      max_tokens: input.maxTokens ?? MAX_TOKENS_DEFAULT,
      // Deterministic, for the same reason as Gemini.
      temperature: 0,
    },
  };
}

/** The parts of a chat-completions response this code reads. */
export type NvidiaResponseLike = {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

export function readNvidiaUsage(response: NvidiaResponseLike): TokenUsage {
  const usage = response.usage ?? {};
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    // No prompt cache on this endpoint; reported as zero rather than guessed.
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** Terminal reasons an OpenAI-compatible endpoint gives for declining. */
const REFUSAL_REASONS = new Set(['content_filter', 'refusal']);

export function interpretNvidiaResponse(
  raw: unknown,
  articleLanguage: SummariseInput['article']['language'],
  fallbackModel: string,
): SummariseOutcome {
  const response = (raw ?? {}) as NvidiaResponseLike;
  const usage = readNvidiaUsage(response);
  const model = response.model ?? fallbackModel;

  const choice = response.choices?.[0];
  if (!choice) {
    return { ok: false, code: 'refusal', retryable: false, detail: 'no_choices' };
  }

  const finish = choice.finish_reason;
  if (finish === 'length') {
    // Same treatment as Claude's max_tokens: one escalated retry, then failed.
    return { ok: false, code: 'output_truncated', retryable: true };
  }
  if (finish && REFUSAL_REASONS.has(finish)) {
    return { ok: false, code: 'refusal', retryable: false, detail: finish.slice(0, 40) };
  }
  if (finish && finish !== 'stop') {
    return { ok: false, code: 'unexpected_stop', retryable: false, detail: finish.slice(0, 40) };
  }

  const text = choice.message?.content;
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, code: 'no_text_block', retryable: false };
  }

  const validated = parseAndValidate(text, articleLanguage);
  if (!validated.ok) {
    return {
      ok: false,
      code: `schema_${validated.violation}`,
      retryable: false,
      detail: validated.detail,
    };
  }

  return { ok: true, payload: validated.value, usage, model };
}

/** The real NVIDIA client. Failures are values, never throws. */
export function createNvidiaClient(config: NvidiaConfig): SummariseClient {
  const model = config.model ?? NVIDIA_DEFAULT_MODEL;

  return {
    async summarise(input: SummariseInput): Promise<SummariseOutcome> {
      const { url, headers, body } = buildNvidiaRequest(input, config);

      const response = await postJson(url, headers, body, {
        fetchImpl: config.fetchImpl,
        timeoutMs: config.timeoutMs ?? PROVIDER_TIMEOUT_MS,
        now: config.now,
      });

      if (!response.ok) return response;
      return interpretNvidiaResponse(response.json, input.article.language, model);
    },
  };
}

export { classifyProviderStatus as classifyNvidiaStatus };
