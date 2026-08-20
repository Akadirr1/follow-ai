-- 202608210002_content.sql
-- AI Gündem v1 — shared content tables: sources, articles, article_summaries.
-- arch-001 §2 "Tables and keys". No `public` objects. RLS and grants: 0005.

-- ---------------------------------------------------------------------------
-- aigundem.sources
-- ---------------------------------------------------------------------------
create table aigundem.sources (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text not null,
  name                  text not null,
  feed_url              text not null,
  -- sha256 of the normalized feed URL, computed by the ingestion function.
  feed_url_hash         bytea not null,
  site_url              text,
  language              aigundem.language_code not null,
  category              aigundem.category not null,
  is_default            boolean not null default false,
  status                aigundem.source_status not null default 'pending',
  -- HTTP conditional-request state (arch-001 §3 sync-feeds).
  etag                  text,
  last_modified         text,
  -- Scheduling / leasing state for private.lease_due_sources().
  next_fetch_at         timestamptz not null default now(),
  last_fetched_at       timestamptz,
  last_success_at       timestamptz,
  lease_expires_at      timestamptz,
  -- Failure counters (arch-001 §2 "failure counters/timestamps").
  consecutive_failures  integer not null default 0,
  last_error_code       text,
  last_error_at         timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  search_tsv            tsvector generated always as (
                          setweight(to_tsvector('simple', coalesce(name, '')), 'A')
                          || setweight(to_tsvector('simple', coalesce(category::text, '')), 'B')
                        ) stored,

  constraint sources_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint sources_slug_length check (char_length(slug) between 2 and 64),
  constraint sources_name_length check (char_length(name) between 1 and 200),
  -- Public https feeds only (arch-001 §3 add-source rules; the Edge Function
  -- performs the full SSRF check, this is the last line of defence).
  constraint sources_feed_url_https check (feed_url ~ '^https://'),
  constraint sources_feed_url_length check (char_length(feed_url) between 12 and 2048),
  constraint sources_site_url_https check (site_url is null or site_url ~ '^https://'),
  constraint sources_site_url_length check (site_url is null or char_length(site_url) <= 2048),
  constraint sources_feed_url_hash_sha256 check (octet_length(feed_url_hash) = 32),
  constraint sources_etag_length check (etag is null or char_length(etag) <= 256),
  constraint sources_last_modified_length check (last_modified is null or char_length(last_modified) <= 128),
  constraint sources_last_error_code_length check (last_error_code is null or char_length(last_error_code) <= 128),
  constraint sources_failures_non_negative check (consecutive_failures >= 0)
);

-- One row per distinct normalized feed URL: add-source upserts on this key.
create unique index sources_feed_url_hash_key
  on aigundem.sources (feed_url_hash);

-- Slugs are only guaranteed unique among the seeded defaults; user-created
-- sources derive a slug from the feed title and may collide.
create unique index sources_default_slug_key
  on aigundem.sources (slug)
  where is_default;

-- Drives private.lease_due_sources().
create index sources_status_next_fetch_at_idx
  on aigundem.sources (status, next_fetch_at);

create index sources_search_tsv_idx
  on aigundem.sources using gin (search_tsv);

create trigger sources_set_updated_at
  before update on aigundem.sources
  for each row execute function private.set_updated_at();

comment on table aigundem.sources is
  'Shared feed catalogue. Readable by anon/authenticated when status = active. No client writes; add-source (Edge, service_role) is the only writer.';

-- ---------------------------------------------------------------------------
-- aigundem.articles
-- ---------------------------------------------------------------------------
create table aigundem.articles (
  id               uuid primary key default gen_random_uuid(),
  source_id        uuid not null references aigundem.sources (id) on delete cascade,
  -- Feed GUID, or the canonical URL when the feed supplies no stable GUID.
  external_id      text not null,
  canonical_url    text not null,
  -- sha256 of the normalized canonical URL.
  url_hash         bytea not null,
  title            text not null,
  author           text,
  -- Inherited from the source at ingestion time; denormalized so feed queries
  -- and the search index never need the sources join.
  category         aigundem.category not null,
  published_at     timestamptz not null,
  fetched_at       timestamptz not null default now(),
  language         aigundem.article_language not null default 'und',
  content_text     text,
  content_quality  aigundem.content_quality not null default 'excerpt',
  -- sha256 over the normalized (title, content_text) pair. Changing it
  -- invalidates the cached summary by cache-key mismatch.
  content_hash     bytea not null,
  excerpt          text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  search_tsv       tsvector generated always as (
                     setweight(to_tsvector('simple', coalesce(title, '')), 'A')
                     || setweight(to_tsvector('simple', coalesce(excerpt, '')), 'B')
                     || setweight(to_tsvector('simple', coalesce(category::text, '')), 'C')
                   ) stored,

  constraint articles_external_id_length check (char_length(external_id) between 1 and 512),
  constraint articles_canonical_url_https check (canonical_url ~ '^https://'),
  constraint articles_canonical_url_length check (char_length(canonical_url) between 12 and 2048),
  constraint articles_url_hash_sha256 check (octet_length(url_hash) = 32),
  constraint articles_content_hash_sha256 check (octet_length(content_hash) = 32),
  constraint articles_title_length check (char_length(title) between 1 and 512),
  constraint articles_author_length check (author is null or char_length(author) <= 200),
  constraint articles_excerpt_length check (excerpt is null or char_length(excerpt) <= 4000),
  constraint articles_content_text_length check (content_text is null or char_length(content_text) <= 200000),
  -- content_quality = 'full' is a claim about content_text; it must exist.
  constraint articles_full_requires_text check (
    content_quality <> 'full' or (content_text is not null and char_length(content_text) > 0)
  )
);

-- Ingestion upserts on this key (arch-001 §2).
create unique index articles_source_external_id_key
  on aigundem.articles (source_id, external_id);

-- Cross-source deduplication of the same normalized URL.
create unique index articles_url_hash_key
  on aigundem.articles (url_hash);

-- Keyset pagination for the global feed: (published_at, id) DESC.
create index articles_published_at_id_idx
  on aigundem.articles (published_at desc, id desc);

-- Keyset pagination inside one source.
create index articles_source_published_at_id_idx
  on aigundem.articles (source_id, published_at desc, id desc);

-- Backs aigundem.search_articles_v1().
create index articles_search_tsv_idx
  on aigundem.articles using gin (search_tsv);

create trigger articles_set_updated_at
  before update on aigundem.articles
  for each row execute function private.set_updated_at();

comment on table aigundem.articles is
  'Shared article corpus. Readable by anon/authenticated. No client writes; sync-feeds (Edge, service_role) is the only writer.';

-- ---------------------------------------------------------------------------
-- aigundem.article_summaries
--
-- Cache key is (article_id, content_hash, prompt_version, model). A row whose
-- content_hash no longer matches its article is stale by definition and is
-- filtered out by aigundem.feed_articles_v1 (migration 0004).
-- ---------------------------------------------------------------------------
create table aigundem.article_summaries (
  article_id         uuid primary key references aigundem.articles (id) on delete cascade,
  content_hash       bytea not null,
  prompt_version     text not null,
  model              text not null,
  -- Exactly three Turkish bullet points.
  summary_tr         text[] not null,
  translation_tr     text,
  translation_state  aigundem.translation_state not null,
  generated_at       timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint article_summaries_content_hash_sha256 check (octet_length(content_hash) = 32),
  constraint article_summaries_prompt_version_length check (char_length(prompt_version) between 1 and 64),
  constraint article_summaries_model_length check (char_length(model) between 1 and 128),
  -- Written out per element: CHECK constraints may not contain subqueries, so
  -- unnest()/bool_and() is not available here.
  constraint article_summaries_summary_shape check (
    cardinality(summary_tr) = 3
    and summary_tr[1] is not null and char_length(summary_tr[1]) between 1 and 500
    and summary_tr[2] is not null and char_length(summary_tr[2]) between 1 and 500
    and summary_tr[3] is not null and char_length(summary_tr[3]) between 1 and 500
  ),
  -- 'ready' carries a translation; 'not_required' (Turkish source) carries none.
  constraint article_summaries_translation_shape check (
    (translation_state = 'ready'
      and translation_tr is not null
      and char_length(translation_tr) between 1 and 200000)
    or (translation_state = 'not_required' and translation_tr is null)
  )
);

-- The exact cache-key lookup performed by request-enrichment.
create index article_summaries_cache_key_idx
  on aigundem.article_summaries (article_id, content_hash, prompt_version, model);

create trigger article_summaries_set_updated_at
  before update on aigundem.article_summaries
  for each row execute function private.set_updated_at();

-- arch-001 §2: "Turkish rows require translation_tr IS NULL / not_required".
-- The article's language lives on another table, so this invariant cannot be a
-- CHECK constraint; it is enforced by a row trigger instead.
create or replace function private.enforce_summary_translation_state()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_language text;
begin
  select a.language into v_language
  from aigundem.articles a
  where a.id = new.article_id;

  if v_language = 'tr' and new.translation_state <> 'not_required' then
    raise exception
      'article % is Turkish; translation_state must be not_required', new.article_id
      using errcode = '23514';
  end if;

  return new;
end;
$fn$;

comment on function private.enforce_summary_translation_state() is
  'BEFORE INSERT/UPDATE trigger on aigundem.article_summaries. Internal; not an API surface.';

create trigger article_summaries_enforce_translation_state
  before insert or update on aigundem.article_summaries
  for each row execute function private.enforce_summary_translation_state();

comment on table aigundem.article_summaries is
  'Claude-generated Turkish summaries/translations. Readable by anon/authenticated. No client writes; process-enrichments (Edge, service_role) is the only writer.';
