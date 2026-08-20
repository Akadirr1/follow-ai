/**
 * Maps the prototype fixtures in `src/data/*.ts` (read-only here) onto the domain
 * DTOs. This is the whole reason the mock adapter can stand in for Supabase: the
 * shapes the seam promises are produced once, here, and nothing downstream ever
 * sees `{k, tile, src, time, cat, sum, body, en}` again.
 */
import { ARTICLES, type Article as MockArticle } from '../../data/articles';
import { DIGEST } from '../../data/digest';
import { SOURCES } from '../../data/sources';
import type {
  Article,
  ArticleSummary,
  Cursor,
  Digest,
  DigestItem,
  Language,
  Source,
} from '../../domain/types';

/**
 * The prototype's editorial "now": its digest is dated 20 August 2026 and the
 * detail card is stamped 09:41 Istanbul (UTC+3). Relative labels like
 * "2 saat önce" are resolved against this fixed instant so ids, ordering and
 * cursors are identical on every run — a `Date.now()` anchor would make
 * pagination tests depend on the clock.
 */
export const MOCK_NOW_ISO = '2026-08-20T06:41:00.000Z';
const MOCK_NOW_MS = Date.parse(MOCK_NOW_ISO);

/** Measured 2026-08-21 (`agents/reports/facts-2026-08-21.md`). */
const FEED_URLS: Record<string, string> = {
  oa: 'https://openai.com/news/rss.xml',
  gd: 'https://deepmind.google/blog/rss.xml',
  hf: 'https://huggingface.co/blog/feed.xml',
  ax: 'https://rss.arxiv.org/rss/cs.AI',
  tc: 'https://techcrunch.com/category/artificial-intelligence/feed/',
  wz: 'https://webrazzi.com/kategori/yapay-zeka/feed/',
};

const SITE_URLS: Record<string, string> = {
  oa: 'https://openai.com/news',
  an: 'https://www.anthropic.com/news',
  gd: 'https://deepmind.google/discover/blog',
  hf: 'https://huggingface.co/blog',
  ax: 'https://arxiv.org/list/cs.AI/recent',
  tc: 'https://techcrunch.com/category/artificial-intelligence/',
  wz: 'https://webrazzi.com/kategori/yapay-zeka/',
};

/** `meta` reads "Kategori · EN" / "Kategori · TR" in the prototype fixture. */
function parseSourceMeta(meta: string): { category: string; language: Language } {
  const [category, lang] = meta.split('·').map((part) => part.trim());
  if (!category || !lang) {
    console.warn(`[mock] source meta "${meta}" is not "Kategori · XX"; defaulting to en.`);
    return { category: category ?? '', language: 'en' };
  }
  return { category, language: lang.toLowerCase() === 'tr' ? 'tr' : 'en' };
}

/**
 * Turns "2 saat önce" / "dün" into an offset in hours. An unrecognised label is a
 * fixture problem, not a user input, so it warns and falls back to one week back —
 * far enough to sort last without colliding with a real entry.
 */
export function hoursAgoFromLabel(label: string): number {
  const hours = /^(\d+)\s*saat önce$/.exec(label.trim());
  if (hours) return Number(hours[1]);
  if (label.trim() === 'dün') return 24;
  console.warn(`[mock] unrecognised time label "${label}"; treating it as 7 days old.`);
  return 24 * 7;
}

const isoFromLabel = (label: string): string =>
  new Date(MOCK_NOW_MS - hoursAgoFromLabel(label) * 3_600_000).toISOString();

/**
 * Exactly three bullets is a contract (arch-001 §6). A fixture that breaks it is
 * padded rather than dropped, so the seam never hands a caller a short tuple, and
 * it warns because a silently padded summary would ship as real Claude output.
 */
function toBullets(id: string, sum: readonly string[]): [string, string, string] {
  if (sum.length !== 3) {
    console.warn(
      `[mock] article "${id}" has ${sum.length} summary bullets, expected 3; padding.`,
    );
  }
  return [sum[0] ?? '', sum[1] ?? '', sum[2] ?? ''];
}

function toSummary(article: MockArticle, language: Language): ArticleSummary {
  // A Turkish source needs no translation; an English one already has its Turkish
  // rendering in the fixture's `body` field.
  return language === 'tr'
    ? {
        bullets: toBullets(article.id, article.sum),
        translationTr: null,
        translationState: 'not_required',
      }
    : {
        bullets: toBullets(article.id, article.sum),
        translationTr: article.body,
        translationState: 'ready',
      };
}

export function toSourceDto(mock: (typeof SOURCES)[number]): Source {
  const { category, language } = parseSourceMeta(mock.meta);
  const feedUrl = FEED_URLS[mock.k] ?? null;
  return {
    id: mock.k,
    name: mock.name,
    feedUrl,
    siteUrl: SITE_URLS[mock.k] ?? null,
    category,
    language,
    tile: mock.tile,
    // Anthropic publishes no feed (measured 2026-08-21), so it is neither a
    // default nor active — addendum §D ships six defaults. Its prototype article
    // stays in the fixture, which is the same shape as a source deactivated after
    // its articles were ingested.
    isDefault: feedUrl !== null,
    isActive: feedUrl !== null,
  };
}

export const mockSources = (): Source[] => SOURCES.map(toSourceDto);

export function toArticleDto(mock: MockArticle): Article {
  const source = SOURCES.find((s) => s.k === mock.id);
  if (!source) {
    console.warn(
      `[mock] article "${mock.id}" has no matching source in SOURCES; using its own labels.`,
    );
  }
  const language: Language = source ? parseSourceMeta(source.meta).language : 'en';
  return {
    id: mock.id,
    sourceId: source?.k ?? mock.id,
    sourceName: mock.src,
    tile: mock.tile,
    title: mock.title,
    url: SITE_URLS[mock.id] ?? '',
    publishedAt: isoFromLabel(mock.time),
    category: mock.cat,
    language,
    // The original is always the source-language text: English for EN sources,
    // the Turkish `body` for the Turkish one.
    bodyOriginal: language === 'tr' ? mock.body : mock.en,
    summary: toSummary(mock, language),
  };
}

/** Newest first, id descending as the tie-break — the contract's sort order. */
export const compareArticles = (a: Article, b: Article): number =>
  a.publishedAt === b.publishedAt
    ? b.id.localeCompare(a.id)
    : a.publishedAt < b.publishedAt
      ? 1
      : -1;

export const mockArticles = (): Article[] => ARTICLES.map(toArticleDto).sort(compareArticles);

export const cursorOf = (article: Article): Cursor => ({
  publishedAt: article.publishedAt,
  id: article.id,
});

/** True when `article` sorts strictly after `cursor` in `(publishedAt, id)` DESC. */
export const isAfterCursor = (article: Article, cursor: Cursor): boolean =>
  article.publishedAt < cursor.publishedAt ||
  (article.publishedAt === cursor.publishedAt && article.id < cursor.id);

/**
 * The prototype's digest is five hand-written entries whose titles differ from the
 * articles and whose fourth entry (TechCrunch AI) has no article at all. A real
 * digest item always points at an article, so the mock builds items from the
 * articles and reuses a prototype blurb when one matches by source name.
 */
export function mockDigest(articles: Article[]): Digest {
  const items: DigestItem[] = articles.slice(0, 5).map((article, index) => {
    const entry = DIGEST.find((d) => d.meta.split('·')[0].trim() === article.sourceName);
    return {
      position: index + 1,
      articleId: article.id,
      title: entry?.title ?? article.title,
      blurb: entry?.line ?? article.summary?.bullets[0] ?? '',
      sourceName: article.sourceName,
      category: article.category,
    };
  });

  const unmatched = DIGEST.filter(
    (d) => !articles.some((a) => a.sourceName === d.meta.split('·')[0].trim()),
  );
  if (unmatched.length > 0) {
    console.warn(
      `[mock] digest entries with no article were dropped: ${unmatched
        .map((d) => d.meta)
        .join(', ')}`,
    );
  }

  return {
    id: 'digest-2026-08-20',
    date: '2026-08-20',
    preparedAt: MOCK_NOW_ISO,
    items,
  };
}
