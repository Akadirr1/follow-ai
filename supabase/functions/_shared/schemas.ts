/**
 * The enrichment payload: its JSON schema (sent to Claude) and its runtime
 * validator (applied to whatever comes back).
 *
 * Portable: Web APIs only, no Deno globals, no SDK import. Unit-tested from
 * Node via Jest.
 *
 * Both halves exist on purpose. `output_config.format` constrains generation,
 * but the row still has to satisfy P2's CHECK constraints — exactly three
 * bullets of 1–500 characters, and `translation_tr IS NULL` precisely when
 * `translation_state = 'not_required'`. A constraint violation surfaces as an
 * opaque database error inside a SECURITY DEFINER function; validating here
 * turns it into a named, non-retryable job failure instead.
 *
 * The schema also cannot express the rule that matters most: translation is
 * null *because the article is Turkish*. That is a fact about the input, not
 * about the output shape, so only the validator can check it.
 */

/** `aigundem.articles.language`. */
export type ArticleLanguage = 'en' | 'tr' | 'und';

/** `aigundem.article_summaries.translation_state`. */
export type TranslationState = 'ready' | 'not_required';

export const SUMMARY_BULLET_COUNT = 3;
export const SUMMARY_BULLET_MAX = 500;
/** `article_summaries_translation_shape` caps the stored translation. */
export const TRANSLATION_MAX = 200000;

export type EnrichmentPayload = {
  summary: [string, string, string];
  translation: string | null;
};

/**
 * The schema sent as `output_config.format.schema`.
 *
 * `additionalProperties: false` plus a complete `required` list is what makes
 * the constraint strict; without both, extra keys are permitted and the
 * validator below would be doing all the work.
 *
 * Bounds are stated here as well as in the validator so the model is told the
 * limits rather than being corrected after the fact — a 501-character bullet
 * costs a whole retry.
 */
export const ENRICHMENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'translation'],
  properties: {
    summary: {
      type: 'array',
      minItems: SUMMARY_BULLET_COUNT,
      maxItems: SUMMARY_BULLET_COUNT,
      items: { type: 'string', minLength: 1, maxLength: SUMMARY_BULLET_MAX },
      description:
        'Exactly three Turkish bullet points summarising the article, most important first.',
    },
    translation: {
      type: ['string', 'null'],
      maxLength: TRANSLATION_MAX,
      description:
        'Full Turkish translation of the article body, or null when the article is already Turkish.',
    },
  },
} as const;

export type SchemaViolation =
  | 'not_json'
  | 'not_object'
  | 'summary_not_array'
  | 'summary_wrong_length'
  | 'summary_item_not_string'
  | 'summary_item_empty'
  | 'summary_item_too_long'
  | 'translation_wrong_type'
  | 'translation_too_long'
  | 'translation_missing_for_foreign_article'
  | 'translation_present_for_turkish_article';

export type ValidationResult =
  | { ok: true; value: EnrichmentPayload }
  | { ok: false; violation: SchemaViolation; detail?: string };

/**
 * Validate a parsed payload against the row constraints.
 *
 * `articleLanguage` decides the translation rule: a Turkish article must come
 * back with `translation: null` (stored as `translation_state =
 * 'not_required'`), anything else must carry a translation. P2 enforces the
 * same invariant with a row trigger, so a payload that fails here would be
 * rejected by the database anyway — just later, and less legibly.
 *
 * Bullets are trimmed before measuring: a model that indents its output should
 * not fail a length check, but a bullet that is only whitespace is empty.
 */
export function validateEnrichment(
  raw: unknown,
  articleLanguage: ArticleLanguage,
): ValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, violation: 'not_object' };
  }

  const candidate = raw as Record<string, unknown>;

  if (!Array.isArray(candidate.summary)) {
    return { ok: false, violation: 'summary_not_array' };
  }
  if (candidate.summary.length !== SUMMARY_BULLET_COUNT) {
    return {
      ok: false,
      violation: 'summary_wrong_length',
      detail: String(candidate.summary.length),
    };
  }

  const bullets: string[] = [];
  for (const item of candidate.summary) {
    if (typeof item !== 'string') {
      return { ok: false, violation: 'summary_item_not_string' };
    }
    const trimmed = item.trim();
    if (trimmed === '') {
      return { ok: false, violation: 'summary_item_empty' };
    }
    if (trimmed.length > SUMMARY_BULLET_MAX) {
      return {
        ok: false,
        violation: 'summary_item_too_long',
        detail: String(trimmed.length),
      };
    }
    bullets.push(trimmed);
  }

  const translationRaw = candidate.translation;
  if (translationRaw !== null && typeof translationRaw !== 'string') {
    return { ok: false, violation: 'translation_wrong_type' };
  }

  let translation: string | null = null;
  if (typeof translationRaw === 'string') {
    const trimmed = translationRaw.trim();
    // An empty-string translation is the model's way of saying "none"; treat it
    // as null so the language rule below gives the accurate error.
    translation = trimmed === '' ? null : trimmed;
    if (translation !== null && translation.length > TRANSLATION_MAX) {
      return {
        ok: false,
        violation: 'translation_too_long',
        detail: String(translation.length),
      };
    }
  }

  if (articleLanguage === 'tr' && translation !== null) {
    return { ok: false, violation: 'translation_present_for_turkish_article' };
  }
  if (articleLanguage !== 'tr' && translation === null) {
    return { ok: false, violation: 'translation_missing_for_foreign_article' };
  }

  return {
    ok: true,
    value: {
      summary: [bullets[0], bullets[1], bullets[2]],
      translation,
    },
  };
}

/** The `translation_state` that goes with an article's language. */
export function translationStateFor(language: ArticleLanguage): TranslationState {
  return language === 'tr' ? 'not_required' : 'ready';
}

/** Parse then validate. Malformed JSON is a distinct, non-retryable violation. */
export function parseAndValidate(
  text: string,
  articleLanguage: ArticleLanguage,
): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, violation: 'not_json' };
  }
  return validateEnrichment(parsed, articleLanguage);
}
