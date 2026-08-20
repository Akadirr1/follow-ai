/**
 * RSS 2.0 / RSS 1.0 (RDF) / Atom parsing, HTML-to-text, and feed discovery.
 *
 * Portable: no Deno globals, no dependencies. Built on `./xml.ts`, which explains
 * why the XML reader is hand-rolled.
 *
 * Everything here is synchronous and pure: same input, same output, no clock,
 * no network. Hashing (`content_hash`, `url_hash`) is async and therefore lives
 * in `hash.ts`, applied by `ingest.ts` — which keeps this module trivially
 * testable against fixtures.
 */

import { resolveFeedLink, tryCanonicalizeUrl } from './url.ts';
import {
  child,
  childText,
  children,
  decodeEntities,
  findFirst,
  parseXml,
  XmlNode,
} from './xml.ts';

export type FeedKind = 'rss' | 'rdf' | 'atom';

/** Matches `aigundem.articles.content_quality`. */
export type ContentQuality = 'full' | 'excerpt';

export type ParsedItem = {
  /** Feed GUID when stable, else the canonical URL. Maps to `external_id`. */
  externalId: string;
  canonicalUrl: string;
  title: string;
  author: string | null;
  /** ISO 8601 UTC. */
  publishedAt: string;
  contentText: string;
  excerpt: string;
  quality: ContentQuality;
};

export type SkipReason =
  | 'no_link'
  | 'unparseable_link'
  | 'no_title'
  | 'no_date'
  | 'no_content'
  | 'item_cap';

export type ParsedFeed = {
  kind: FeedKind;
  title: string;
  siteUrl: string | null;
  items: ParsedItem[];
  /** Per-reason counts of items that were dropped. Never fatal. */
  skipped: Record<SkipReason, number>;
};

export type ParseFeedOptions = {
  /** Newest N items kept per run. OpenAI's feed carries >1000. */
  maxItems?: number;
  /** Latest acceptable timestamp; guards against feeds dated in the future. */
  now?: Date;
};

export const DEFAULT_MAX_ITEMS = 100;
export const MAX_TITLE = 512;
export const MAX_AUTHOR = 200;
export const MAX_EXTERNAL_ID = 512;
export const MAX_EXCERPT = 1000;
export const MAX_CONTENT_TEXT = 100000;

/** Nothing published before this is plausible for an AI news feed. */
const EARLIEST_PLAUSIBLE = Date.parse('2000-01-01T00:00:00Z');
/** Clock skew tolerance for feeds that post-date their items. */
const FUTURE_TOLERANCE_MS = 48 * 60 * 60 * 1000;

function emptySkipped(): Record<SkipReason, number> {
  return {
    no_link: 0,
    unparseable_link: 0,
    no_title: 0,
    no_date: 0,
    no_content: 0,
    item_cap: 0,
  };
}

/**
 * Parse a feed document. Returns null only when the document is not a feed at
 * all; a feed whose items are all malformed returns an empty item list plus
 * skip counts, because one bad feed must not look like a network failure.
 */
export function parseFeed(
  xmlText: string,
  feedUrl: string,
  options: ParseFeedOptions = {},
): ParsedFeed | null {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const now = options.now ?? new Date();
  const doc = parseXml(xmlText);

  const rss = findFirst(doc, 'rss');
  const rdf = findFirst(doc, 'rdf');
  const atom = findFirst(doc, 'feed');

  if (rss) return parseRss(rss, feedUrl, maxItems, now, 'rss');
  if (rdf) return parseRss(rdf, feedUrl, maxItems, now, 'rdf');
  if (atom) return parseAtom(atom, feedUrl, maxItems, now);
  return null;
}

// ---------------------------------------------------------------------------
// RSS 2.0 and RSS 1.0 (RDF)
// ---------------------------------------------------------------------------

function parseRss(
  root: XmlNode,
  feedUrl: string,
  maxItems: number,
  now: Date,
  kind: FeedKind,
): ParsedFeed {
  const channel = child(root, 'channel') ?? root;
  // RSS 1.0 puts <item> as a sibling of <channel>, RSS 2.0 puts it inside.
  const rawItems = [...children(channel, 'item'), ...children(root, 'item')];

  const skipped = emptySkipped();
  const items: ParsedItem[] = [];

  for (const raw of rawItems) {
    if (items.length >= maxItems) {
      skipped.item_cap += 1;
      continue;
    }
    const item = mapRssItem(raw, feedUrl, now, skipped);
    if (item) items.push(item);
  }

  return {
    kind,
    title: clamp(childText(channel, 'title'), MAX_TITLE),
    siteUrl: tryCanonicalizeUrl(childText(channel, 'link')) ?? null,
    items,
    skipped,
  };
}

function mapRssItem(
  node: XmlNode,
  feedUrl: string,
  now: Date,
  skipped: Record<SkipReason, number>,
): ParsedItem | null {
  const title = clamp(childText(node, 'title'), MAX_TITLE);
  if (title === '') {
    skipped.no_title += 1;
    return null;
  }

  const rawLink = childText(node, 'link') || rssGuidAsLink(node) || atomLinkHref(node);
  if (rawLink === '') {
    skipped.no_link += 1;
    return null;
  }
  const canonicalUrl = resolveFeedLink(rawLink, feedUrl);
  if (!canonicalUrl) {
    skipped.unparseable_link += 1;
    return null;
  }

  const publishedAt = parseFeedDate(
    childText(node, 'pubdate') || childText(node, 'date') || childText(node, 'published'),
    now,
  );
  if (!publishedAt) {
    skipped.no_date += 1;
    return null;
  }

  // `content:encoded` is the full article; `description` is usually a teaser.
  // Of the six seeded feeds only Webrazzi ships content:encoded, so only
  // Webrazzi yields content_quality = 'full' (facts-2026-08-21).
  const encoded = childText(node, 'content:encoded', 'encoded');
  const description = childText(node, 'description', 'summary');
  const contentHtml = encoded !== '' ? encoded : description;
  const contentText = clamp(htmlToText(contentHtml), MAX_CONTENT_TEXT);
  if (contentText === '') {
    skipped.no_content += 1;
    return null;
  }

  const guid = childText(node, 'guid');
  const externalId = clamp(guid !== '' ? guid : canonicalUrl, MAX_EXTERNAL_ID);

  return {
    externalId,
    canonicalUrl,
    title,
    author: normaliseAuthor(
      childText(node, 'dc:creator', 'creator') || childText(node, 'author'),
    ),
    publishedAt,
    contentText,
    excerpt: makeExcerpt(htmlToText(description) || contentText),
    quality: encoded !== '' ? 'full' : 'excerpt',
  };
}

/** Some feeds (Hugging Face) use the article URL as the GUID. */
function rssGuidAsLink(node: XmlNode): string {
  const guid = childText(node, 'guid');
  return /^https?:\/\//i.test(guid) ? guid : '';
}

// ---------------------------------------------------------------------------
// Atom
// ---------------------------------------------------------------------------

function parseAtom(
  root: XmlNode,
  feedUrl: string,
  maxItems: number,
  now: Date,
): ParsedFeed {
  const skipped = emptySkipped();
  const items: ParsedItem[] = [];

  for (const raw of children(root, 'entry')) {
    if (items.length >= maxItems) {
      skipped.item_cap += 1;
      continue;
    }
    const item = mapAtomEntry(raw, feedUrl, now, skipped);
    if (item) items.push(item);
  }

  return {
    kind: 'atom',
    title: clamp(childText(root, 'title'), MAX_TITLE),
    siteUrl: tryCanonicalizeUrl(atomLinkHref(root)) ?? null,
    items,
    skipped,
  };
}

function mapAtomEntry(
  node: XmlNode,
  feedUrl: string,
  now: Date,
  skipped: Record<SkipReason, number>,
): ParsedItem | null {
  const title = clamp(childText(node, 'title'), MAX_TITLE);
  if (title === '') {
    skipped.no_title += 1;
    return null;
  }

  const rawLink = atomLinkHref(node);
  if (rawLink === '') {
    skipped.no_link += 1;
    return null;
  }
  const canonicalUrl = resolveFeedLink(rawLink, feedUrl);
  if (!canonicalUrl) {
    skipped.unparseable_link += 1;
    return null;
  }

  const publishedAt = parseFeedDate(
    childText(node, 'published') || childText(node, 'updated'),
    now,
  );
  if (!publishedAt) {
    skipped.no_date += 1;
    return null;
  }

  const contentNode = child(node, 'content');
  const contentRaw = contentNode ? contentNode.text.trim() : '';
  const summaryRaw = childText(node, 'summary');
  const contentHtml = contentRaw !== '' ? contentRaw : summaryRaw;
  const contentText = clamp(htmlToText(contentHtml), MAX_CONTENT_TEXT);
  if (contentText === '') {
    skipped.no_content += 1;
    return null;
  }

  const id = childText(node, 'id');
  const authorNode = child(node, 'author');
  const author = authorNode ? childText(authorNode, 'name') : '';

  return {
    externalId: clamp(id !== '' ? id : canonicalUrl, MAX_EXTERNAL_ID),
    canonicalUrl,
    title,
    author: normaliseAuthor(author),
    publishedAt,
    contentText,
    excerpt: makeExcerpt(htmlToText(summaryRaw) || contentText),
    quality: contentRaw !== '' ? 'full' : 'excerpt',
  };
}

/** `<link rel="alternate" href="…">`, falling back to the first `<link>`. */
function atomLinkHref(node: XmlNode): string {
  const links = children(node, 'link');
  if (links.length === 0) return '';
  const alternate = links.find(
    (l) =>
      (l.attrs.rel ?? 'alternate') === 'alternate' &&
      (l.attrs.type === undefined || l.attrs.type.includes('html')),
  );
  const chosen = alternate ?? links.find((l) => (l.attrs.rel ?? '') === '') ?? links[0];
  return (chosen.attrs.href ?? chosen.text ?? '').trim();
}

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

/**
 * HTML fragment to plain text. Not a sanitiser in the "safe to render" sense —
 * it removes markup entirely, which is stronger: no tag survives to be
 * rendered, so the stored `content_text` can never carry script or style.
 */
export function htmlToText(html: string): string {
  if (html === '') return '';
  let text = html;
  // Drop scripts and styles with their content, not just their tags.
  text = text.replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ');
  text = text.replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  // Preserve paragraph and line structure before stripping.
  text = text.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  text = text.replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, '\n');
  text = text.replace(/<\s*li\b[^>]*>/gi, '\n');
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/ /g, ' ');
  text = text.replace(/[ \t\f\v\r]+/g, ' ');
  text = text.replace(/\s*\n\s*/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** A card-sized teaser, cut on a word boundary. */
export function makeExcerpt(text: string, maxLength = MAX_EXCERPT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;
  const cut = flat.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function clamp(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
}

function normaliseAuthor(value: string): string | null {
  const trimmed = clamp(value, MAX_AUTHOR);
  return trimmed === '' ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Timezone abbreviations `Date.parse` rejects in some engines. */
const TZ_OFFSETS: Record<string, string> = {
  UT: '+0000',
  UTC: '+0000',
  GMT: '+0000',
  EST: '-0500',
  EDT: '-0400',
  CST: '-0600',
  CDT: '-0500',
  MST: '-0700',
  MDT: '-0600',
  PST: '-0800',
  PDT: '-0700',
};

/**
 * Parse an RSS (RFC 822) or Atom (ISO 8601) date into an ISO UTC string.
 *
 * Returns null when the value is missing, unparseable, absurdly old, or more
 * than two days in the future. The caller SKIPS such items rather than
 * substituting `now`: `published_at` drives the feed's sort order, so inventing
 * a timestamp would park a mystery item at the top of every user's feed.
 */
export function parseFeedDate(raw: string, now: Date = new Date()): string | null {
  const value = raw.trim();
  if (value === '') return null;

  let parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    const withOffset = value.replace(
      /\b(UT|UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b\s*$/,
      (abbr) => TZ_OFFSETS[abbr.toUpperCase()] ?? abbr,
    );
    parsed = Date.parse(withOffset);
  }
  if (Number.isNaN(parsed)) return null;
  if (parsed < EARLIEST_PLAUSIBLE) return null;
  if (parsed > now.getTime() + FUTURE_TOLERANCE_MS) return null;

  return new Date(parsed).toISOString();
}

// ---------------------------------------------------------------------------
// Feed discovery (`add-source` given an HTML page)
// ---------------------------------------------------------------------------

/**
 * Extract `<link rel="alternate" type="application/rss+xml" href="…">` targets
 * from an HTML page, absolutised against `baseUrl`.
 *
 * A regex, not a DOM parse: we need exactly one attribute triple out of a
 * `<head>`, and arch-001 §3 permits following at most one discovered feed,
 * which is then revalidated by the full URL-safety policy before any fetch.
 */
export function discoverFeedLinks(html: string, baseUrl: string): string[] {
  const found: string[] = [];
  const linkTag = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkTag.exec(html)) !== null && found.length < 5) {
    const tag = match[0];
    const rel = attr(tag, 'rel');
    if (!rel || !rel.toLowerCase().split(/\s+/).includes('alternate')) continue;
    const type = (attr(tag, 'type') ?? '').toLowerCase();
    if (!/(rss|atom)\+xml|application\/xml|text\/xml/.test(type)) continue;
    const href = attr(tag, 'href');
    if (!href) continue;
    const resolved = resolveFeedLink(decodeEntities(href), baseUrl);
    if (resolved && !found.includes(resolved)) found.push(resolved);
  }
  return found;
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}
