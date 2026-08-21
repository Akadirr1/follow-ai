/**
 * The ONLY file in `_shared/` that imports the Anthropic SDK or reads the
 * environment. Everything it does is instantiate a client and read config;
 * every decision lives in `anthropic.ts`, which is SDK-free and Jest-tested.
 *
 * That split is the whole key-optional design (addendum §E): with no
 * `ANTHROPIC_API_KEY` this module never constructs a client, and the worker
 * short-circuits before leasing anything. There is no key in v1, so the code
 * below has NEVER RUN — the fake client in the tests is the only implementation
 * of `ClaudeClient` this task can execute.
 *
 * `Deno.` appears here by design; `grep -rn "Deno\." _shared` is expected to
 * match this file and no other.
 */

import Anthropic from '@anthropic-ai/sdk';

import {
  buildClaudeRequest,
  ClaudeClient,
  ClaudeOutcome,
  classifyClaudeError,
  EnrichmentInput,
  interpretClaudeResponse,
} from './anthropic.ts';
import {
  AI_DAILY_CAP_DEFAULT,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  Effort,
  isEffort,
  MAX_ARTICLE_CHARS_DEFAULT,
  MAX_TOKENS_DEFAULT,
  MAX_TOKENS_ESCALATED,
} from './anthropic-config.ts';

export type AnthropicRuntimeConfig = {
  /** Null when the key is unset — the key-optional path (addendum §E). */
  apiKey: string | null;
  model: string;
  maxTokens: number;
  maxTokensEscalated: number;
  effort: Effort;
  maxArticleChars: number;
  dailyCap: number;
};

/**
 * Resolve configuration from the environment.
 *
 * Every knob has a default that works, so a deploy with none of these set is
 * correct rather than broken. They exist so the coordinator can retune cost and
 * output ceilings on a live function without a redeploy.
 */
export function readAnthropicConfig(): AnthropicRuntimeConfig {
  const apiKey = (Deno.env.get('ANTHROPIC_API_KEY') ?? '').trim();
  const effortRaw = Deno.env.get('ANTHROPIC_EFFORT');

  return {
    apiKey: apiKey === '' ? null : apiKey,
    model: (Deno.env.get('ANTHROPIC_MODEL') ?? '').trim() || DEFAULT_MODEL,
    maxTokens: readInt('ANTHROPIC_MAX_TOKENS', MAX_TOKENS_DEFAULT, 1024, 128000),
    maxTokensEscalated: readInt(
      'ANTHROPIC_MAX_TOKENS_ESCALATED',
      MAX_TOKENS_ESCALATED,
      1024,
      128000,
    ),
    effort: isEffort(effortRaw) ? effortRaw : DEFAULT_EFFORT,
    maxArticleChars: readInt(
      'ANTHROPIC_MAX_ARTICLE_CHARS',
      MAX_ARTICLE_CHARS_DEFAULT,
      500,
      100000,
    ),
    dailyCap: readInt('AI_DAILY_CAP', AI_DAILY_CAP_DEFAULT, 0, 100000),
  };
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/**
 * The real `ClaudeClient`.
 *
 * Failures are returned as values, never thrown: the worker counts outcomes per
 * job, and one article's refusal must not end a run. `classifyClaudeError`
 * reads the SDK error's class name and HTTP status — the SDK's typed errors
 * (`RateLimitError`, `APIConnectionError`, `AuthenticationError`,
 * `BadRequestError`, …) all carry both, so the mapping table stays in the
 * portable module where it can be tested exhaustively.
 */
export function createClaudeClient(config: AnthropicRuntimeConfig): ClaudeClient {
  if (config.apiKey === null) {
    throw new Error('createClaudeClient called without an API key.');
  }

  const anthropic = new Anthropic({ apiKey: config.apiKey });

  return {
    async summarise(input: EnrichmentInput): Promise<ClaudeOutcome> {
      const { request } = buildClaudeRequest(input);
      try {
        // `request` is typed structurally in the SDK-free module; the cast is
        // the single point where that structure meets the SDK's own params
        // type. Nothing is added or removed here — what the tests assert about
        // the request object is exactly what is sent.
        const message = await anthropic.messages.create(
          request as unknown as Anthropic.MessageCreateParamsNonStreaming,
        );
        return interpretClaudeResponse(message, input.article.language);
      } catch (error) {
        return { ok: false, ...classifyClaudeError(error) };
      }
    },
  };
}
