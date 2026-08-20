import type {
  Article,
  ArticleSummary,
  Digest,
  DigestItem,
  Language,
  Source,
  TranslationState,
} from '../../domain/types';

/**
 * Row → DTO. The only file that knows the shape of `public.aigundem_feed_articles_v1`;
 * everything above the seam sees domain types (arch-001 §4: "return domain DTOs,
 * not Supabase rows").
 */

/** Columns of `aigundem.feed_articles_v1` (migration 0004). */
export type FeedArticleRow = {
  article_id: string;
  source_id: string;
  source_slug: string;
  source_name: string;
  source_site_url: string | null;
  category: string;
  title: string;
  author: string | null;
  canonical_url: string;
  published_at: string;
  fetched_at: string;
  language: string;
  excerpt: string | null;
  content_text: string | null;
  content_quality: string | null;
  summary_tr: string[] | null;
  translation_tr: string | null;
  translation_state: string | null;
  summary_model: string | null;
  summary_generated_at: string | null;
  summary_ready: boolean;
};

/** The subset of the columns the DTO needs — what `select=` asks for. */
export const FEED_COLUMNS = [
  'article_id',
  'source_id',
  'source_slug',
  'source_name',
  'source_site_url',
  'category',
  'title',
  'canonical_url',
  'published_at',
  'language',
  'excerpt',
  'content_text',
  'summary_tr',
  'translation_tr',
  'translation_state',
  'summary_ready',
].join(',');

const toLanguage = (value: string | null | undefined, context: string): Language => {
  if (value === 'tr' || value === 'en') return value;
  console.warn(`[mapper] ${context}: unexpected language "${value}"; treating it as en.`);
  return 'en';
};

/**
 * Exactly three bullets is a contract (arch-001 §6) and the DB enforces
 * `cardinality(summary_tr) = 3`. A row that still breaks it is padded rather than
 * dropped, so the seam never hands back a short tuple, and it warns because a
 * padded summary would otherwise ship looking like real Claude output.
 */
function toBullets(articleId: string, bullets: string[]): [string, string, string] {
  if (bullets.length !== 3) {
    console.warn(
      `[mapper] article ${articleId}: summary_tr has ${bullets.length} bullets, expected 3; padding.`,
    );
  }
  return [bullets[0] ?? '', bullets[1] ?? '', bullets[2] ?? ''];
}

/**
 * Summary state, including the case P6 exists to handle: with
 * no Anthropic key configured the enrichment job stays queued, the summary join finds
 * nothing, and `summary_ready` is false. That is `pending` — a first-class state
 * (addendum §E), not an error and not an absent summary.
 */
export function toSummary(row: FeedArticleRow): ArticleSummary | undefined {
  const language = toLanguage(row.language, `article ${row.article_id}`);

  if (!row.summary_ready || !row.summary_tr) {
    return {
      bullets: ['', '', ''],
      translationTr: null,
      translationState: 'pending',
    };
  }

  // A Turkish article is never translated; the DB trigger enforces the same rule.
  const state: TranslationState =
    language === 'tr'
      ? 'not_required'
      : row.translation_state === 'not_required'
        ? 'not_required'
        : 'ready';

  return {
    bullets: toBullets(row.article_id, row.summary_tr),
    translationTr: state === 'not_required' ? null : row.translation_tr,
    translationState: state,
  };
}

/** Two-letter badge; the DB has no such column, so it comes from the slug. */
export const tileFromSlug = (slug: string, name: string): string =>
  (slug || name).replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '??';

export function toArticle(row: FeedArticleRow): Article {
  const language = toLanguage(row.language, `article ${row.article_id}`);
  return {
    id: row.article_id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    tile: tileFromSlug(row.source_slug, row.source_name),
    title: row.title,
    url: row.canonical_url,
    publishedAt: row.published_at,
    category: row.category,
    language,
    // `content_text` is the full article, `excerpt` the lede; the detail screen
    // wants the fullest text available and falls back rather than showing blank.
    bodyOriginal: row.content_text ?? row.excerpt ?? '',
    summary: toSummary(row),
  };
}

/** Columns of `aigundem.sources` the catalog needs. */
export type SourceRow = {
  id: string;
  slug: string;
  name: string;
  feed_url: string;
  site_url: string | null;
  language: string;
  category: string;
  is_default: boolean;
  status: string;
};

export function toSource(row: SourceRow): Source {
  return {
    id: row.id,
    name: row.name,
    feedUrl: row.feed_url,
    siteUrl: row.site_url,
    category: row.category,
    language: toLanguage(row.language, `source ${row.id}`),
    tile: tileFromSlug(row.slug, row.name),
    isDefault: row.is_default,
    isActive: row.status === 'active',
  };
}

/** Columns of `public.aigundem_digest_items_v1` (migration 0007). */
export type DigestItemRow = {
  digest_id: string;
  position: number;
  article_id: string;
  blurb_tr: string;
  created_at: string;
};

/** Columns of `public.aigundem_digests_v1` (migration 0007). */
export type DigestRow = {
  id: string;
  digest_date: string;
  timezone: string;
  status: string;
  headline: string | null;
  window_start: string | null;
  window_end: string | null;
  generated_at: string | null;
};

/** What an item needs from its article — the item view carries only the blurb. */
export type DigestArticleFacts = { title: string; sourceName: string; category: string };

/**
 * The item view holds `article_id` and `blurb_tr` and nothing else, so the title,
 * source and category come from the feed view keyed by article id. An item whose
 * article is no longer readable (its source was deactivated) keeps its position
 * with empty labels and warns, rather than silently renumbering the digest.
 */
export function toDigest(
  row: DigestRow,
  items: DigestItemRow[],
  facts: Map<string, DigestArticleFacts>,
): Digest {
  const mapped: DigestItem[] = items
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((item) => {
      const fact = facts.get(item.article_id);
      if (!fact) {
        console.warn(
          `[mapper] digest ${row.id} item ${item.position}: article ${item.article_id} is not in the feed view.`,
        );
      }
      return {
        position: item.position,
        articleId: item.article_id,
        title: fact?.title ?? '',
        blurb: item.blurb_tr,
        sourceName: fact?.sourceName ?? '',
        category: fact?.category ?? '',
      };
    });

  return {
    id: row.id,
    date: row.digest_date,
    preparedAt: row.generated_at ?? row.digest_date,
    items: mapped,
  };
}
