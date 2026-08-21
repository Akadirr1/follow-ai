/**
 * The Claude adapter: builds the request, interprets the response, classifies
 * every failure.
 *
 * Portable: Web APIs only, no Deno globals, and — deliberately — **no import of
 * `@anthropic-ai/sdk`**. The SDK is instantiated in `anthropic-deno.ts`, which
 * is the only file that cannot run under Jest. Everything decidable without a
 * live API lives here and is unit-tested with a fake client.
 *
 * API shape verified against the Claude API reference for `claude-opus-5`:
 *   - structured output is `output_config.format`, NOT the deprecated
 *     top-level `output_format`;
 *   - adaptive thinking is the default, so `thinking` is omitted entirely;
 *   - `budget_tokens` and `temperature` are REMOVED on this model — sending
 *     either returns 400, which is why neither appears anywhere in this repo;
 *   - `stop_details` is populated only when `stop_reason === 'refusal'`.
 */

import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  Effort,
  MAX_ARTICLE_CHARS_DEFAULT,
  MAX_TOKENS_DEFAULT,
} from './anthropic-config.ts';
import {
  ArticleBlock,
  ArticleForPrompt,
  buildArticleBlock,
  PROMPT_VERSION,
  SYSTEM_PROMPT_V1,
} from './prompt.ts';
import {
  ArticleLanguage,
  ENRICHMENT_JSON_SCHEMA,
  EnrichmentPayload,
  parseAndValidate,
  SchemaViolation,
} from './schemas.ts';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export type EnrichmentInput = {
  article: ArticleForPrompt;
  model?: string;
  maxTokens?: number;
  effort?: Effort;
  maxArticleChars?: number;
};

/**
 * Exactly the object handed to `client.messages.create()`.
 *
 * Typed structurally rather than with `Anthropic.MessageCreateParams` so this
 * module stays SDK-free; the glue passes it straight through, so a shape error
 * surfaces at the glue's compile step.
 */
export type ClaudeRequest = {
  model: string;
  max_tokens: number;
  system: Array<{
    type: 'text';
    text: string;
    cache_control?: { type: 'ephemeral' };
  }>;
  messages: Array<{ role: 'user'; content: string }>;
  output_config: {
    effort: Effort;
    format: { type: 'json_schema'; schema: unknown };
  };
};

export type BuiltRequest = {
  request: ClaudeRequest;
  block: ArticleBlock;
  promptVersion: string;
};

/**
 * Build the request.
 *
 * Order is load-bearing for caching: the stable system text is first and
 * carries the `cache_control` marker; the volatile article is in the user turn
 * after it. (As `prompt.ts` notes, v1's system text is below the ~1024-token
 * minimum cacheable prefix, so the marker is inert today — correct placement
 * that starts paying off if the prompt grows, not a saving to count on.)
 */
export function buildClaudeRequest(input: EnrichmentInput): BuiltRequest {
  const block = buildArticleBlock(
    input.article,
    input.maxArticleChars ?? MAX_ARTICLE_CHARS_DEFAULT,
  );

  return {
    promptVersion: PROMPT_VERSION,
    block,
    request: {
      model: input.model ?? DEFAULT_MODEL,
      max_tokens: input.maxTokens ?? MAX_TOKENS_DEFAULT,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT_V1,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: block.text }],
      output_config: {
        effort: input.effort ?? DEFAULT_EFFORT,
        format: { type: 'json_schema', schema: ENRICHMENT_JSON_SCHEMA },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** The parts of an SDK `Message` this code reads. */
export type ClaudeMessageLike = {
  model?: string;
  stop_reason?: string | null;
  stop_details?: { type?: string; category?: string | null } | null;
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Short, stable, non-sensitive codes. They are written to
 * `private.ai_jobs.last_error_code`, which P2 caps at 128 characters, and they
 * are the only failure detail that leaves this module — never the model's text,
 * never the article.
 */
export type EnrichmentFailureCode =
  | 'no_api_key'
  | 'rate_limited'
  | 'connection'
  | 'timeout'
  | 'server_error'
  | 'overloaded'
  | 'auth'
  | 'permission'
  | 'bad_request'
  | 'not_found'
  | 'refusal'
  | 'output_truncated'
  | 'unexpected_stop'
  | 'no_text_block'
  | 'unknown'
  | `schema_${SchemaViolation}`;

export type ClaudeOutcome =
  | {
      ok: true;
      payload: EnrichmentPayload;
      usage: TokenUsage;
      model: string | null;
    }
  | {
      ok: false;
      code: EnrichmentFailureCode;
      retryable: boolean;
      /** Bounded, non-sensitive. Safe to log and to store. */
      detail?: string;
    };

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function readUsage(message: ClaudeMessageLike): TokenUsage {
  const usage = message.usage ?? {};
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Map a `stop_reason` to an outcome, or `null` when the turn ended normally.
 *
 * `max_tokens` is retryable, but only because the caller escalates the ceiling
 * before retrying — see `MAX_TOKENS_ESCALATED`. Retrying a truncation at the
 * same ceiling truncates again; the worker enforces the one-escalation rule.
 *
 * `tool_use` and `pause_turn` cannot legitimately occur: this request declares
 * no tools. If one appears, something about the request changed, and retrying
 * will not fix it.
 */
export function classifyStopReason(
  stopReason: string | null | undefined,
  stopCategory?: string | null,
): { code: EnrichmentFailureCode; retryable: boolean; detail?: string } | null {
  switch (stopReason) {
    case 'end_turn':
    case null:
    case undefined:
      return null;
    case 'max_tokens':
      return { code: 'output_truncated', retryable: true };
    case 'refusal':
      return {
        code: 'refusal',
        retryable: false,
        detail: stopCategory ? `category=${stopCategory}` : undefined,
      };
    case 'stop_sequence':
    case 'tool_use':
    case 'pause_turn':
      return { code: 'unexpected_stop', retryable: false, detail: stopReason };
    default:
      return {
        code: 'unexpected_stop',
        retryable: false,
        detail: String(stopReason).slice(0, 40),
      };
  }
}

/** Turn a successful HTTP response into a validated payload or a failure. */
export function interpretClaudeResponse(
  message: ClaudeMessageLike,
  articleLanguage: ArticleLanguage,
): ClaudeOutcome {
  const usage = readUsage(message);

  // stop_details is populated only for refusals; guard before reading it.
  const stopped = classifyStopReason(
    message.stop_reason,
    message.stop_details?.category ?? null,
  );
  if (stopped) return { ok: false, ...stopped };

  const textBlock = (message.content ?? []).find(
    (block) => block.type === 'text' && typeof block.text === 'string',
  );
  if (!textBlock || typeof textBlock.text !== 'string') {
    return { ok: false, code: 'no_text_block', retryable: false };
  }

  const validated = parseAndValidate(textBlock.text, articleLanguage);
  if (!validated.ok) {
    return {
      ok: false,
      // A schema violation from a schema-constrained request means the request
      // or the article is wrong, not the network. Retrying it unchanged is a
      // paid no-op.
      code: `schema_${validated.violation}`,
      retryable: false,
      detail: validated.detail,
    };
  }

  return {
    ok: true,
    payload: validated.value,
    usage,
    model: message.model ?? null,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The fields SDK error classes expose that this code needs. */
export type ClaudeErrorLike = {
  name?: string;
  status?: number;
  message?: string;
};

/**
 * Classify a thrown SDK error.
 *
 * Keyed on the SDK's class `name` first and the HTTP `status` second, rather
 * than `instanceof`, so the policy stays in this SDK-free module and is
 * exhaustively testable. `anthropic-deno.ts` hands the raw error straight here.
 *
 * The split follows the SDK's own semantics: 408/409/429/5xx and connection
 * failures are transient; 400/401/403/404 mean the request itself is wrong and
 * will be just as wrong on the next attempt.
 */
export function classifyClaudeError(error: unknown): {
  code: EnrichmentFailureCode;
  retryable: boolean;
  detail?: string;
} {
  const err = (error ?? {}) as ClaudeErrorLike;
  const name = typeof err.name === 'string' ? err.name : '';
  const status = typeof err.status === 'number' ? err.status : undefined;

  switch (name) {
    case 'RateLimitError':
      return { code: 'rate_limited', retryable: true };
    case 'APIConnectionError':
    case 'APIConnectionTimeoutError':
      return {
        code: name === 'APIConnectionTimeoutError' ? 'timeout' : 'connection',
        retryable: true,
      };
    case 'InternalServerError':
      return { code: 'server_error', retryable: true };
    case 'AuthenticationError':
      return { code: 'auth', retryable: false };
    case 'PermissionDeniedError':
      return { code: 'permission', retryable: false };
    case 'BadRequestError':
    case 'UnprocessableEntityError':
      return { code: 'bad_request', retryable: false };
    case 'NotFoundError':
      return { code: 'not_found', retryable: false };
    default:
      break;
  }

  if (status !== undefined) {
    if (status === 401) return { code: 'auth', retryable: false };
    if (status === 403) return { code: 'permission', retryable: false };
    if (status === 404) return { code: 'not_found', retryable: false };
    if (status === 408) return { code: 'timeout', retryable: true };
    if (status === 429) return { code: 'rate_limited', retryable: true };
    if (status === 529) return { code: 'overloaded', retryable: true };
    if (status >= 500) return { code: 'server_error', retryable: true };
    if (status >= 400) return { code: 'bad_request', retryable: false };
  }

  // An unrecognised throwable is treated as transient: a permanent fault will
  // still exhaust max_attempts and land as `failed`, whereas calling a
  // transient fault permanent loses the article for good.
  return {
    code: 'unknown',
    retryable: true,
    detail: name ? name.slice(0, 40) : undefined,
  };
}

// ---------------------------------------------------------------------------
// The client seam
// ---------------------------------------------------------------------------

/**
 * What the worker depends on. `anthropic-deno.ts` provides the real
 * implementation; every test provides a fake.
 *
 * There is no key in v1 (facts-2026-08-21), so the real implementation has
 * never run. The fake is not a convenience — it is the only implementation this
 * task can execute.
 */
export interface ClaudeClient {
  summarise(input: EnrichmentInput): Promise<ClaudeOutcome>;
}

/** The client used when ANTHROPIC_API_KEY is unset (addendum §E). */
export const NO_KEY_CLIENT: ClaudeClient = {
  summarise(): Promise<ClaudeOutcome> {
    return Promise.resolve({
      ok: false,
      code: 'no_api_key',
      // Retryable in the sense that a key may appear later; the worker never
      // gets this far without a key, so it is belt and braces.
      retryable: true,
    });
  },
};
