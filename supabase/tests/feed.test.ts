/**
 * RSS/Atom parsing, HTML-to-text, dates and feed discovery.
 *
 * Fixture provenance is documented in `fixtures/feeds.ts`: these are
 * hand-written from measured item SHAPES, not captured bytes.
 */
import {
  discoverFeedLinks,
  htmlToText,
  makeExcerpt,
  parseFeed,
  parseFeedDate,
} from '../functions/_shared/feed.ts';
import { decodeEntities, findFirst, parseXml } from '../functions/_shared/xml.ts';
import {
  ATOM_CONTENTLESS,
  ATOM_GENERIC,
  HTML_WITHOUT_FEED_LINK,
  HTML_WITH_FEED_LINK,
  NOT_XML_AT_ALL,
  RSS_ARXIV,
  RSS_BODY_STRIPS_TO_NOTHING,
  RSS_HUGGINGFACE,
  RSS_MALFORMED_ITEMS,
  RSS_OPENAI,
  RSS_TOLERANCE,
  RSS_WEBRAZZI,
} from './fixtures/feeds.ts';

/** Fixed clock: the fixtures are dated August 2026. */
const NOW = new Date('2026-08-21T12:00:00Z');

describe('parseXml', () => {
  it('never interprets a DOCTYPE, so no external entity can be resolved', () => {
    const doc = parseXml(RSS_TOLERANCE);
    const serialised = JSON.stringify(doc);
    expect(serialised).not.toContain('etc/passwd');
    expect(serialised).not.toContain('ENTITY');
    expect(findFirst(doc, 'rss')).not.toBeNull();
  });

  it('survives an unescaped ampersand and a mismatched close tag', () => {
    const feed = parseFeed(RSS_TOLERANCE, 'https://example.org/feed.xml', { now: NOW });
    expect(feed).not.toBeNull();
    expect(feed!.items).toHaveLength(1);
    expect(feed!.items[0].title).toContain('Fish & chips');
  });

  it('reads CDATA verbatim without decoding entities inside it', () => {
    const doc = parseXml('<a><![CDATA[raw &amp; text]]></a>');
    expect(findFirst(doc, 'a')!.text).toBe('raw &amp; text');
  });

  it('keeps namespace prefixes and exposes the local name', () => {
    const doc = parseXml('<item><content:encoded>x</content:encoded></item>');
    const node = findFirst(doc, 'content:encoded')!;
    expect(node.name).toBe('content:encoded');
    expect(node.local).toBe('encoded');
  });

  it('bounds the node count instead of throwing on a huge document', () => {
    const huge = `<rss>${'<item><title>t</title></item>'.repeat(200)}</rss>`;
    const doc = parseXml(huge, { maxNodes: 10 });
    expect(JSON.stringify(doc).length).toBeLessThan(5000);
  });
});

describe('decodeEntities', () => {
  it('decodes named, decimal and hex references', () => {
    expect(decodeEntities('a &amp; b')).toBe('a & b');
    expect(decodeEntities('&#233;')).toBe('é');
    expect(decodeEntities('&#x2014;')).toBe('—');
    expect(decodeEntities('&hellip;')).toBe('…');
  });

  it('leaves an unknown entity alone rather than dropping characters', () => {
    expect(decodeEntities('&unknownentity;')).toBe('&unknownentity;');
  });

  it('decodes once, so &amp;lt; becomes &lt; and not <', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });

  it('refuses surrogate halves and out-of-range code points', () => {
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');
    expect(decodeEntities('&#x110000;')).toBe('&#x110000;');
  });
});

describe('parseFeed: RSS', () => {
  it('parses the OpenAI shape as excerpt-quality items', () => {
    const feed = parseFeed(RSS_OPENAI, 'https://openai.com/news/rss.xml', { now: NOW })!;
    expect(feed.kind).toBe('rss');
    expect(feed.title).toBe('OpenAI Blog');
    expect(feed.items).toHaveLength(2);

    const [first, second] = feed.items;
    expect(first.externalId).toBe('openai-0001');
    expect(first.canonicalUrl).toBe('https://openai.com/index/introducing-a-new-model/');
    expect(first.title).toBe('Introducing a new model');
    expect(first.publishedAt).toBe('2026-08-20T15:04:05.000Z');
    expect(first.quality).toBe('excerpt');
    // Escaped markup is decoded, then stripped to text.
    expect(first.contentText).toBe('A short teaser about the "new" model.');

    // Tracking parameters are removed by canonicalisation, so two spellings of
    // the same article share one url_hash.
    expect(second.canonicalUrl).toBe('https://openai.com/index/safety-update/');
    expect(second.contentText).toBe('Teaser with markup & an ampersand.');
  });

  it('treats content:encoded as full quality and keeps Turkish characters', () => {
    const feed = parseFeed(RSS_WEBRAZZI, 'https://webrazzi.com/kategori/yapay-zeka/feed/', {
      now: NOW,
    })!;
    const item = feed.items[0];
    expect(item.quality).toBe('full');
    expect(item.author).toBe('Webrazzi Ekibi');
    expect(item.contentText).toContain('Ç, ğ, ı, İ, ö, ş, ü');
    expect(item.contentText).toContain('İkinci paragraf.');
    // The excerpt still comes from <description>, not the full body.
    expect(item.excerpt).toBe('Kısa özet.');
    expect(item.publishedAt).toBe('2026-08-20T04:30:00.000Z');
  });

  it('reads dc:creator and a negative offset (arXiv shape)', () => {
    const feed = parseFeed(RSS_ARXIV, 'https://rss.arxiv.org/rss/cs.AI', { now: NOW })!;
    const item = feed.items[0];
    expect(item.author).toBe('Ada Lovelace, Alan Turing');
    expect(item.externalId).toBe('oai:arXiv.org:2608.01234v1');
    expect(item.publishedAt).toBe('2026-08-21T04:00:00.000Z');
    expect(item.quality).toBe('excerpt');
  });

  it('accepts a GUID that is the article URL (Hugging Face shape)', () => {
    const feed = parseFeed(RSS_HUGGINGFACE, 'https://huggingface.co/blog/feed.xml', {
      now: NOW,
    })!;
    const item = feed.items[0];
    expect(item.externalId).toBe('https://huggingface.co/blog/open-weights');
    expect(item.canonicalUrl).toBe('https://huggingface.co/blog/open-weights');
  });

  /**
   * fix-003. The live Hugging Face feed publishes title, link, guid and pubDate
   * and nothing else — 845 items, every one of them — so the old "skip anything
   * without a body" rule silently ingested zero articles from a seeded default
   * source. The catalogue promised a source that never showed anything.
   */
  it('keeps every item of a headlines-only feed instead of ingesting nothing', () => {
    const feed = parseFeed(RSS_HUGGINGFACE, 'https://huggingface.co/blog/feed.xml', {
      now: NOW,
    })!;

    expect(feed.items).toHaveLength(2);
    expect(feed.contentless).toBe(2);
    // Nothing was dropped: a missing body is not a defect in the item.
    expect(Object.values(feed.skipped).reduce((a, b) => a + b, 0)).toBe(0);

    for (const item of feed.items) {
      expect(item.contentText).toBe('');
      expect(item.excerpt).toBe('');
      // An empty body can never be 'full'.
      expect(item.quality).toBe('excerpt');
      // The parts that make the card renderable are all present.
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.canonicalUrl.startsWith('https://')).toBe(true);
      expect(Number.isNaN(Date.parse(item.publishedAt))).toBe(false);
    }
  });

  it('keeps an item whose body exists but strips to nothing', () => {
    // Distinct from the Hugging Face shape: here the element is present and
    // survives HTML stripping as an empty string. Both are kept.
    const feed = parseFeed(RSS_BODY_STRIPS_TO_NOTHING, 'https://example.org/feed.xml', {
      now: NOW,
    })!;
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].contentText).toBe('');
    expect(feed.items[0].quality).toBe('excerpt');
    expect(feed.contentless).toBe(1);
  });

  it('keeps a bodyless Atom entry too', () => {
    const feed = parseFeed(ATOM_CONTENTLESS, 'https://example.org/feed.xml', { now: NOW })!;
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      title: 'An entry with no body',
      contentText: '',
      excerpt: '',
      quality: 'excerpt',
    });
    expect(feed.contentless).toBe(1);
  });

  it('still counts a feed whose items all have bodies as contentless: 0', () => {
    expect(parseFeed(RSS_OPENAI, 'https://openai.com/news/rss.xml', { now: NOW })!.contentless)
      .toBe(0);
    expect(parseFeed(ATOM_GENERIC, 'https://example.org/feed.xml', { now: NOW })!.contentless)
      .toBe(0);
  });
});

describe('parseFeed: Atom', () => {
  it('prefers <content> over <summary> and resolves relative links', () => {
    const feed = parseFeed(ATOM_GENERIC, 'https://example.org/feed.xml', { now: NOW })!;
    expect(feed.kind).toBe('atom');
    expect(feed.items).toHaveLength(2);

    const [withContent, summaryOnly] = feed.items;
    expect(withContent.quality).toBe('full');
    expect(withContent.contentText).toBe('Full Atom content body.');
    expect(withContent.author).toBe('Grace Hopper');
    expect(withContent.externalId).toBe('tag:example.org,2026:entry-1');
    expect(withContent.publishedAt).toBe('2026-08-20T10:00:00.000Z');

    expect(summaryOnly.quality).toBe('excerpt');
    // href="/posts/two" resolved against the feed URL.
    expect(summaryOnly.canonicalUrl).toBe('https://example.org/posts/two');
    // No <published>: falls back to <updated>.
    expect(summaryOnly.publishedAt).toBe('2026-08-19T08:30:00.000Z');
  });
});

describe('parseFeed: failure isolation', () => {
  it('drops only the broken items and reports why', () => {
    const feed = parseFeed(RSS_MALFORMED_ITEMS, 'https://example.org/feed.xml', {
      now: NOW,
    })!;
    // "No content" is now KEPT (fix-003): a headline and a link are still a
    // usable entry, and dropping them cost Hugging Face all 845 of its items.
    // Only title, link and date are load-bearing.
    expect(feed.items.map((i) => i.title)).toEqual(['No content', 'Good one']);
    expect(feed.skipped).toEqual({
      no_title: 1,
      no_link: 1,
      no_date: 2, // unparseable, and a date a century in the future
      unparseable_link: 0,
      item_cap: 0,
    });
    expect(feed.contentless).toBe(1);
  });

  it('caps the number of items it will take from one run', () => {
    const many = `<rss><channel><title>t</title>${'<item><title>x</title><link>https://example.org/a</link><pubDate>Wed, 20 Aug 2026 00:00:00 GMT</pubDate><description>d</description></item>'.repeat(
      20,
    )}</channel></rss>`;
    const feed = parseFeed(many, 'https://example.org/feed.xml', {
      now: NOW,
      maxItems: 5,
    })!;
    expect(feed.items).toHaveLength(5);
    expect(feed.skipped.item_cap).toBe(15);
  });

  it('returns null only when the document is not a feed', () => {
    expect(parseFeed(NOT_XML_AT_ALL, 'https://example.org/x', { now: NOW })).toBeNull();
    expect(parseFeed(HTML_WITHOUT_FEED_LINK, 'https://example.org/x', { now: NOW })).toBeNull();
    expect(parseFeed('', 'https://example.org/x', { now: NOW })).toBeNull();
  });
});

describe('parseFeedDate', () => {
  it('parses RFC 822 and ISO 8601', () => {
    expect(parseFeedDate('Wed, 20 Aug 2026 15:04:05 GMT', NOW)).toBe('2026-08-20T15:04:05.000Z');
    expect(parseFeedDate('Thu, 20 Aug 2026 07:30:00 +0300', NOW)).toBe('2026-08-20T04:30:00.000Z');
    expect(parseFeedDate('2026-08-20T10:00:00Z', NOW)).toBe('2026-08-20T10:00:00.000Z');
  });

  it('handles timezone abbreviations that Date.parse alone may reject', () => {
    expect(parseFeedDate('Wed, 20 Aug 2026 10:00:00 EST', NOW)).toBe('2026-08-20T15:00:00.000Z');
  });

  it('rejects rather than inventing a timestamp', () => {
    expect(parseFeedDate('', NOW)).toBeNull();
    expect(parseFeedDate('sometime last week', NOW)).toBeNull();
    expect(parseFeedDate('1970-01-01T00:00:00Z', NOW)).toBeNull();
    expect(parseFeedDate('2100-01-01T00:00:00Z', NOW)).toBeNull();
  });

  it('tolerates a feed running up to two days ahead of our clock', () => {
    expect(parseFeedDate('2026-08-22T12:00:00Z', NOW)).toBe('2026-08-22T12:00:00.000Z');
    expect(parseFeedDate('2026-08-24T12:00:00Z', NOW)).toBeNull();
  });
});

describe('htmlToText', () => {
  it('removes script and style content, not just their tags', () => {
    const text = htmlToText('<p>Hi</p><script>alert("x")</script><style>p{}</style>');
    expect(text).toBe('Hi');
    expect(text).not.toContain('alert');
  });

  it('keeps paragraph structure and collapses whitespace', () => {
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\nTwo');
    expect(htmlToText('a<br>b')).toBe('a\nb');
    expect(htmlToText('<ul><li>x</li><li>y</li></ul>')).toBe('x\ny');
    expect(htmlToText('  lots    of \n\n\n space ')).toBe('lots of\nspace');
  });

  it('leaves no markup behind for anything downstream to render', () => {
    const text = htmlToText('<a href="https://x/"><img src=y onerror=alert(1)>link</a>');
    expect(text).not.toContain('<');
    expect(text).not.toContain('onerror');
  });
});

describe('makeExcerpt', () => {
  it('cuts on a word boundary and marks the truncation', () => {
    const excerpt = makeExcerpt('one two three four five six seven', 20);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(21);
    expect(excerpt).not.toContain('  ');
  });

  it('leaves a short text untouched', () => {
    expect(makeExcerpt('short', 100)).toBe('short');
  });
});

describe('discoverFeedLinks', () => {
  it('finds advertised feeds and absolutises them', () => {
    expect(discoverFeedLinks(HTML_WITH_FEED_LINK, 'https://example.org/blog/')).toEqual([
      'https://example.org/feed.xml',
      'https://example.org/atom.xml',
    ]);
  });

  it('ignores stylesheets and pages with no feed', () => {
    expect(discoverFeedLinks(HTML_WITHOUT_FEED_LINK, 'https://example.org/')).toEqual([]);
    expect(
      discoverFeedLinks('<link rel="stylesheet" href="/a.css">', 'https://example.org/'),
    ).toEqual([]);
  });
});
