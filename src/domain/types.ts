/**
 * Domain DTOs — the only shapes that cross the data-access seam.
 *
 * Repositories return these, never Supabase rows and never the prototype's
 * `src/data/*.ts` shapes. Timestamps are ISO-8601 UTC (arch-001 §6); ordering is
 * `(publishedAt DESC, id DESC)`; a summary carries exactly three bullets and a
 * translation that is null only for Turkish-language articles.
 */

/** ISO-8601 UTC instant, e.g. `2026-08-20T06:41:00.000Z`. */
export type Iso = string;

export type SourceId = string;
export type ArticleId = string;
export type DigestId = string;

/** Content language of a source or article. v1 ships Turkish and English only. */
export type Language = 'tr' | 'en';

/**
 * A feed the app reads. `tile` is the two-letter badge the UI draws; it is part of
 * the catalog rather than a UI constant so a custom source can carry one too.
 */
export type Source = {
  id: SourceId;
  name: string;
  /**
   * Feed URL (RSS/Atom). Public HTTPS only — arch-001 §1.
   *
   * Null when the publisher has no first-party feed: Anthropic is the measured
   * case (2026-08-21), and such a source is inactive and not a default. Making
   * this nullable matches what the mock mapper already produces and what `p1.md`
   * documents (rev-002 N1); a consumer that needs a URL must check.
   */
  feedUrl: string | null;
  /** Human-facing site, when known. */
  siteUrl: string | null;
  category: string;
  language: Language;
  tile: string;
  /** Shipped with the app (seed migration 006) rather than added by a device. */
  isDefault: boolean;
  /** Inactive sources stay in the catalog but are not ingested or listed. */
  isActive: boolean;
};

export type TranslationState = 'ready' | 'not_required' | 'pending';

/**
 * Claude output for one article. `bullets` is exactly three strings (arch-001 §6).
 * `translationTr` is null when `translationState` is `not_required` (the article is
 * already Turkish) or `pending` (no summary yet — addendum §E).
 */
export type ArticleSummary = {
  bullets: [string, string, string];
  translationTr: string | null;
  translationState: TranslationState;
};

/**
 * One article. `bodyOriginal` is always the source-language text; the Turkish
 * rendering, when it exists, lives in `summary.translationTr`. That split is what
 * the detail screen's Orijinal / Çeviri segment reads, and it keeps "which text is
 * the original" answerable without inspecting the language field twice.
 */
export type Article = {
  id: ArticleId;
  sourceId: SourceId;
  sourceName: string;
  tile: string;
  title: string;
  url: string;
  publishedAt: Iso;
  category: string;
  language: Language;
  bodyOriginal: string;
  /** Absent until enrichment has run — see `EnrichmentRepository`. */
  summary?: ArticleSummary;
};

export type DigestItem = {
  /** 1–5, in reading order (arch-001 §6). */
  position: number;
  articleId: ArticleId;
  title: string;
  /** One-line Turkish blurb written for the digest, not the article summary. */
  blurb: string;
  sourceName: string;
  category: string;
};

export type Digest = {
  id: DigestId;
  /** Istanbul editorial day, `YYYY-MM-DD`. */
  date: string;
  preparedAt: Iso;
  items: DigestItem[];
};

/**
 * Latest digest, or the fact that today's is still being built. `preparing` is a
 * first-class state, not an error: with no Anthropic key the digest legitimately
 * never finalises (addendum §E) and the Digest tab shows "Digest hazırlanıyor".
 */
export type DigestSnapshot =
  | { status: 'ready'; digest: Digest }
  | { status: 'preparing' };

declare const cursorBrand: unique symbol;

/**
 * Opaque pagination cursor over `(publishedAt DESC, id DESC)`.
 *
 * The brand is **required**, so `{publishedAt, id}` alone does not satisfy the
 * type (rev-002 N2): a cursor can only come from a `Page` this layer produced or
 * from `decodeCursor`, which validates. The fields stay readable for debugging.
 */
export type Cursor = {
  readonly publishedAt: Iso;
  readonly id: string;
  readonly [cursorBrand]: true;
};

export type Page<T> = {
  items: T[];
  /** Pass back as `cursor` to fetch the next page; null at the end of the list. */
  nextCursor: Cursor | null;
  hasMore: boolean;
};

/**
 * Enrichment outcome. `queued` is normal while no API key exists (addendum §E).
 *
 * `unavailable` is **terminal**: the server has looked and there is nothing to
 * summarise — an excerpt-only feed item with no body (`reason: 'no_content'`).
 * Polling it is wasted work and, worse, shows "Özet hazırlanıyor" forever, so it
 * is a separate variant rather than a flavour of `queued`.
 */
export type EnrichmentResult =
  | { status: 'ready'; summary: ArticleSummary }
  | { status: 'queued'; reason: string | null }
  | { status: 'unavailable'; reason: 'no_content' | string };
