/**
 * Feed fixtures.
 *
 * PROVENANCE — read this before trusting a passing test.
 *
 * These documents are HAND-WRITTEN from the item shapes the coordinator
 * measured on 2026-08-21 (`agents/reports/facts-2026-08-21.md`, "Feed item
 * shapes"), not copies of the real responses. This task has no network, and the
 * coordinator's ~1 MB of real samples live in their scratchpad, outside this
 * checkout. So each fixture reproduces the *documented* tag set of one real
 * feed:
 *
 *   openai      guid, link, pubDate, description, category      → excerpt
 *   deepmind    guid, link, pubDate, description                → excerpt
 *   huggingface guid (== link), link, pubDate — NO BODY AT ALL   → excerpt
 *   arxiv       guid, link, pubDate, description, dc:creator     → excerpt
 *   techcrunch  guid, link, pubDate, description, dc:creator     → excerpt
 *   webrazzi    guid, link, pubDate, content:encoded, dc:creator → FULL
 *
 * CORRECTION (fix-003, measured 2026-08-21 09:35): the original shape table
 * credited Hugging Face with a `<description>`. The live feed has none — its
 * items are `<title>`, `<link>`, `<guid>`, `<pubDate>` and nothing else, all
 * 845 of them — which is why the first sync-feeds run ingested 0 HF articles.
 * The fixture below now matches what the feed actually serves.
 *
 * WHAT THAT MEANS: these prove the parser handles the documented shapes. They
 * do NOT prove it handles the real bytes — real feeds carry namespaces,
 * CDATA quirks and entity soup no hand-written fixture anticipates. Parsing the
 * six live feeds is listed as NOT VERIFIED in agents/reports/p3.md and belongs
 * to the coordinator's remote smoke.
 */

export const RSS_OPENAI = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>OpenAI Blog</title>
    <link>https://openai.com/news</link>
    <description>News from OpenAI</description>
    <item>
      <title>Introducing a new model</title>
      <link>https://openai.com/index/introducing-a-new-model/</link>
      <guid isPermaLink="false">openai-0001</guid>
      <pubDate>Wed, 20 Aug 2026 15:04:05 GMT</pubDate>
      <category>Research</category>
      <description>&lt;p&gt;A short teaser about the &amp;quot;new&amp;quot; model.&lt;/p&gt;</description>
    </item>
    <item>
      <title>Safety update</title>
      <link>https://openai.com/index/safety-update/?utm_source=rss&amp;utm_medium=feed</link>
      <guid isPermaLink="false">openai-0002</guid>
      <pubDate>Tue, 19 Aug 2026 09:00:00 +0000</pubDate>
      <description><![CDATA[<p>Teaser with <b>markup</b> &amp; an ampersand.</p>]]></description>
    </item>
  </channel>
</rss>
`;

export const RSS_WEBRAZZI = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Webrazzi Yapay Zeka</title>
    <link>https://webrazzi.com/kategori/yapay-zeka/</link>
    <item>
      <title>Türkiye'de yapay zekâ yatırımları</title>
      <link>https://webrazzi.com/2026/08/20/yapay-zeka-yatirimlari/</link>
      <guid isPermaLink="false">https://webrazzi.com/?p=99001</guid>
      <pubDate>Thu, 20 Aug 2026 07:30:00 +0300</pubDate>
      <dc:creator><![CDATA[Webrazzi Ekibi]]></dc:creator>
      <description><![CDATA[Kısa özet.]]></description>
      <content:encoded><![CDATA[<p>Tam metin burada. Ç, ğ, ı, İ, ö, ş, ü karakterleri korunmalı.</p><p>İkinci paragraf.</p>]]></content:encoded>
    </item>
  </channel>
</rss>
`;

export const RSS_ARXIV = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel>
    <title>cs.AI updates on arXiv.org</title>
    <link>https://arxiv.org/list/cs.AI/recent</link>
    <item>
      <title>A paper about agents</title>
      <link>https://arxiv.org/abs/2608.01234</link>
      <guid isPermaLink="false">oai:arXiv.org:2608.01234v1</guid>
      <pubDate>Thu, 21 Aug 2026 00:00:00 -0400</pubDate>
      <dc:creator>Ada Lovelace, Alan Turing</dc:creator>
      <category>cs.AI</category>
      <description>arXiv:2608.01234v1 Announce Type: new Abstract: We study agents.</description>
    </item>
  </channel>
</rss>
`;

/** Hugging Face uses the article URL as the GUID (facts-2026-08-21). */
export const RSS_HUGGINGFACE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Hugging Face Blog</title>
    <link>https://huggingface.co/blog</link>
    <item>
      <title>Open weights, open questions</title>
      <link>https://huggingface.co/blog/open-weights</link>
      <guid>https://huggingface.co/blog/open-weights</guid>
      <pubDate>Mon, 18 Aug 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Fine-tuning on a budget</title>
      <link>https://huggingface.co/blog/cheap-finetune</link>
      <guid>https://huggingface.co/blog/cheap-finetune</guid>
      <pubDate>Sun, 17 Aug 2026 09:30:00 GMT</pubDate>
    </item>
  </channel>
</rss>
`;

export const ATOM_GENERIC = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>An Atom Feed</title>
  <link rel="self" href="https://example.org/feed.xml"/>
  <link rel="alternate" type="text/html" href="https://example.org/"/>
  <updated>2026-08-20T10:00:00Z</updated>
  <entry>
    <title>Atom entry with content</title>
    <id>tag:example.org,2026:entry-1</id>
    <link rel="alternate" type="text/html" href="https://example.org/posts/one"/>
    <published>2026-08-20T10:00:00Z</published>
    <updated>2026-08-20T11:00:00Z</updated>
    <author><name>Grace Hopper</name></author>
    <summary>Short summary.</summary>
    <content type="html">&lt;p&gt;Full Atom content body.&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Atom entry, summary only</title>
    <id>tag:example.org,2026:entry-2</id>
    <link rel="alternate" href="/posts/two"/>
    <updated>2026-08-19T08:30:00Z</updated>
    <summary>Only a summary here.</summary>
  </entry>
</feed>
`;

/** Every item is broken in a different way; the feed itself is still a feed. */
export const RSS_MALFORMED_ITEMS = `<rss version="2.0"><channel>
  <title>Broken</title>
  <item><link>https://example.org/a</link><pubDate>Wed, 20 Aug 2026 00:00:00 GMT</pubDate><description>no title</description></item>
  <item><title>No link</title><pubDate>Wed, 20 Aug 2026 00:00:00 GMT</pubDate><description>x</description></item>
  <item><title>Bad date</title><link>https://example.org/c</link><pubDate>not a date at all</pubDate><description>x</description></item>
  <item><title>Future</title><link>https://example.org/d</link><pubDate>Fri, 01 Jan 2100 00:00:00 GMT</pubDate><description>x</description></item>
  <item><title>No content</title><link>https://example.org/e</link><pubDate>Wed, 20 Aug 2026 00:00:00 GMT</pubDate></item>
  <item><title>Good one</title><link>https://example.org/f</link><pubDate>Wed, 20 Aug 2026 00:00:00 GMT</pubDate><description>fine</description></item>
</channel></rss>
`;

/** Unescaped ampersand, mismatched close tag, stray DOCTYPE. */
export const RSS_TOLERANCE = `<!DOCTYPE rss [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<rss version="2.0"><channel>
  <title>Tolerant</title>
  <item>
    <title>Fish & chips <em>tonight</title>
    <link>https://example.org/fish</link>
    <pubDate>Wed, 20 Aug 2026 00:00:00 GMT</pubDate>
    <description>Body with &unknownentity; and &#233; and &#x2014; kept sane.</description>
  </item>
</channel></rss>
`;

export const HTML_WITH_FEED_LINK = `<!doctype html>
<html><head>
  <title>Some Blog</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
  <link rel="alternate" type="application/atom+xml" title="Atom" href="https://example.org/atom.xml">
</head><body><h1>Hello</h1></body></html>
`;

export const HTML_WITHOUT_FEED_LINK = `<!doctype html>
<html><head><title>No feed here</title></head><body>Nothing.</body></html>
`;

export const NOT_XML_AT_ALL = 'this is plain text, not a feed at all';

/**
 * A `<description>` that survives HTML stripping as nothing at all: an image,
 * a comment, a stray tag. Distinct from Hugging Face's shape, where the element
 * is absent entirely — both are kept, neither is skipped.
 */
export const RSS_BODY_STRIPS_TO_NOTHING = `<rss version="2.0"><channel>
  <title>Stripped</title>
  <item>
    <title>Only an image</title>
    <link>https://example.org/img-only</link>
    <pubDate>Wed, 20 Aug 2026 00:00:00 GMT</pubDate>
    <description>&lt;img src="x.png"&gt;&lt;!-- nothing else --&gt;</description>
  </item>
</channel></rss>
`;

/** Atom's equivalent: an entry with neither `<content>` nor `<summary>`. */
export const ATOM_CONTENTLESS = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Headlines only</title>
  <link rel="alternate" type="text/html" href="https://example.org/"/>
  <entry>
    <title>An entry with no body</title>
    <id>tag:example.org,2026:bare-1</id>
    <link rel="alternate" type="text/html" href="https://example.org/bare"/>
    <published>2026-08-20T10:00:00Z</published>
  </entry>
</feed>
`;
