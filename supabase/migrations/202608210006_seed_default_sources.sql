-- 202608210006_seed_default_sources.sql
-- AI Gündem v1 — the six default sources.
--
-- SIX, not seven: Anthropic has no first-party feed. Every candidate endpoint
-- returned 404 or 403 and /news advertises no <link rel="alternate">
-- (facts-2026-08-21). arch-001 §3 forbids scraping and third-party mirrors, so
-- the tile disappears from the defaults until a real feed exists. Addendum §D.
--
-- URLs are the ones actually probed on 2026-08-21, not the ones arch-001
-- guessed: arXiv is `rss.arxiv.org`, which answered 200 with 267 items, rather
-- than `export.arxiv.org`.
--
-- Categories and languages are transcribed from the shipped prototype's
-- `srcMeta` (src/data/sources.ts), so the seeded catalogue matches the UI the
-- user already sees.
--
-- `feed_url_hash` is the SHA-256 of the exact `feed_url` literal beside it,
-- computed offline and embedded as hex rather than derived with
-- `extensions.digest(...)`: the literal cannot drift with pgcrypto's install
-- schema, and `supabase/tests/seed-and-lint.test.ts` recomputes all six from
-- the same canonicaliser `add-source` uses, so SQL and TypeScript are held to
-- one value.
--
-- Idempotent: re-applying updates the non-key fields of the six default rows
-- and touches nothing else. It never resets `status`, `etag`, `next_fetch_at`
-- or the failure counters — those are ingestion state, and clobbering them
-- would make every re-apply re-fetch everything.

insert into aigundem.sources (
  slug, name, feed_url, feed_url_hash, site_url,
  language, category, is_default, status, next_fetch_at
)
values
  (
    'openai-blog',
    'OpenAI Blog',
    'https://openai.com/news/rss.xml',
    decode('bea4293d5eddcb343872252dab501a1fe4ada764a587b1a658125cfe2fb143dc', 'hex'),
    'https://openai.com/news',
    'en', 'Modeller', true, 'active', now()
  ),
  (
    'google-deepmind',
    'Google DeepMind',
    'https://deepmind.google/blog/rss.xml',
    decode('9c92f29eb29326b99ea4da7c4b4bc957a7fe574ec861bfa64cd03db529f99c7f', 'hex'),
    'https://deepmind.google/blog',
    'en', 'Araştırma', true, 'active', now()
  ),
  (
    'hugging-face',
    'Hugging Face',
    'https://huggingface.co/blog/feed.xml',
    decode('61d3148bc0572cab03be2891aea9f44f55d5a61b12bc771c10b86c89ad4e385b', 'hex'),
    'https://huggingface.co/blog',
    'en', 'Açık Kaynak', true, 'active', now()
  ),
  (
    'arxiv-cs-ai',
    'arXiv cs.AI',
    'https://rss.arxiv.org/rss/cs.AI',
    decode('4317c649bc1b9ce76549094d93eb31ad1739349f28298b7cd3c3e3f4c0374c06', 'hex'),
    'https://arxiv.org/list/cs.AI/recent',
    'en', 'Araştırma', true, 'active', now()
  ),
  (
    'techcrunch-ai',
    'TechCrunch AI',
    'https://techcrunch.com/category/artificial-intelligence/feed/',
    decode('0e9770270556fa3fb07953ee3b1130a4fa7d7e4a34f0ea3c5e97daf2bffb976b', 'hex'),
    'https://techcrunch.com/category/artificial-intelligence/',
    'en', 'Ürün', true, 'active', now()
  ),
  (
    'webrazzi-ai',
    'Webrazzi AI',
    'https://webrazzi.com/kategori/yapay-zeka/feed/',
    decode('52c2e3f4d2089c4508cf2b4f9d72a07e19c35f887d997ade4fd535b6576031d4', 'hex'),
    'https://webrazzi.com/kategori/yapay-zeka/',
    'tr', 'Türkiye', true, 'active', now()
  )
on conflict (slug) where is_default do update
   set name          = excluded.name,
       feed_url      = excluded.feed_url,
       feed_url_hash = excluded.feed_url_hash,
       site_url      = excluded.site_url,
       language      = excluded.language,
       category      = excluded.category,
       is_default    = true;

-- The conflict target is the PARTIAL unique index P2 created
-- (`sources_default_slug_key ON aigundem.sources (slug) WHERE is_default`), so
-- the predicate is required for index inference. A user-added source that
-- happens to share a slug is not a default and is therefore not touched here.

comment on column aigundem.sources.is_default is
  'True for the six sources seeded by migration 202608210006. Only these carry a unique slug.';
