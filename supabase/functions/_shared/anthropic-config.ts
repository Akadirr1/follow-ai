/**
 * Claude request tuning constants.
 *
 * Portable: Web APIs only, no Deno globals, no SDK import. Its own module so
 * `prompt.ts` and `anthropic.ts` can share the input cap without importing each
 * other.
 *
 * Every value here is a cost or correctness lever, and every one is overridable
 * from the environment at the Deno boundary — so the coordinator can retune a
 * live function without a code change (see `anthropic-deno.ts`).
 */

/** arch-001 §3: the default model, overridable with ANTHROPIC_MODEL. */
export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Input cap for the article body (~12k characters, per the brief).
 *
 * Bounds the cost of a single enrichment regardless of what a feed publishes.
 * At roughly 3–4 characters per token this is ~3–4k input tokens.
 */
export const MAX_ARTICLE_CHARS_DEFAULT = 12000;

/**
 * Output ceiling.
 *
 * NOT the 4096 the brief names, and the difference is deliberate. The response
 * carries three bullets AND a full Turkish translation of an article body that
 * may be the whole 12k-character cap. Turkish is morphologically dense and
 * tokenises less efficiently than English, so a 12k-character article can
 * translate to well over 4k output tokens — at 4096 a long article truncates,
 * `stop_reason` comes back `max_tokens`, and the payload fails schema
 * validation because the JSON is cut mid-string.
 *
 * That failure mode is worse than it looks: a truncation retried unchanged
 * truncates again, forever, burning budget on every attempt. So the ceiling
 * starts high enough for the common case, and `MAX_TOKENS_ESCALATED` gives a
 * truncated job exactly one retry with more room before it is failed as
 * `output_truncated`. See `classifyStopReason`.
 */
export const MAX_TOKENS_DEFAULT = 8192;
export const MAX_TOKENS_ESCALATED = 16384;

/**
 * `output_config.effort`.
 *
 * The API default is `high`. Summarising a news article into three bullets and
 * translating it is not an intelligence-sensitive task, and arch-001 §7 risk 2
 * names Claude spend as a top risk with no key and no measured cost yet.
 * `medium` is the cheaper default; ANTHROPIC_EFFORT restores `high` (or any
 * other level) without a redeploy.
 */
export const DEFAULT_EFFORT = 'medium';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Global daily Claude call cap (arch-001 §7 risk 2: "a global daily cap must be
 * configured before production"). Counted in `private.rate_limit_buckets` under
 * subject `global`, so it holds across function instances rather than per
 * process. Overridable with AI_DAILY_CAP.
 */
export const AI_DAILY_CAP_DEFAULT = 200;

/** Retry ceiling for a leased job before it is marked `failed`. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** How long a client should wait before polling a queued enrichment again. */
export const POLL_AFTER_SECONDS = 30;
/** …and when there is no API key at all, so nothing will happen soon. */
export const POLL_AFTER_SECONDS_NO_KEY = 300;
