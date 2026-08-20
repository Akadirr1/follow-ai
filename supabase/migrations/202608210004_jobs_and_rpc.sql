-- 202608210004_jobs_and_rpc.sql
-- AI Gündem v1 — internal job/rate/audit tables (schema `private`), digest
-- tables, the versioned feed view, the client search RPC and the internal
-- leasing/rate-limit RPCs. arch-001 §2 and §3. No `public` objects.
--
-- Reachability note (coordinator, P3/P4): PostgREST exposes `public, aigundem`
-- only (migration 0001, addendum §B), so an Edge Function cannot call anything
-- in `private` through supabase-js. Each internal helper therefore has a thin
-- `aigundem.internal_*` wrapper that is EXECUTE-granted to `service_role` alone
-- (migration 0005). The wrappers are the callable surface; the `private.*`
-- functions hold the implementation. See agents/reports/p2.md.

-- ===========================================================================
-- Internal tables — schema `private`, never API-exposed.
-- ===========================================================================

-- One row per (article, content_hash, prompt_version, model) enrichment unit.
create table private.ai_jobs (
  id              uuid primary key default gen_random_uuid(),
  article_id      uuid not null references aigundem.articles (id) on delete cascade,
  content_hash    bytea not null,
  prompt_version  text not null,
  model           text not null,
  status          private.job_status not null default 'queued',
  attempt_count   integer not null default 0,
  max_attempts    integer not null default 5,
  -- Backoff: a retried job is not eligible until available_at.
  available_at    timestamptz not null default now(),
  -- Lease held by one process; expires so a crashed worker cannot strand a job.
  leased_until    timestamptz,
  lease_token     uuid,
  last_error_code text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint ai_jobs_content_hash_sha256 check (octet_length(content_hash) = 32),
  constraint ai_jobs_prompt_version_length check (char_length(prompt_version) between 1 and 64),
  constraint ai_jobs_model_length check (char_length(model) between 1 and 128),
  constraint ai_jobs_attempts_non_negative check (attempt_count >= 0),
  constraint ai_jobs_max_attempts_range check (max_attempts between 1 and 20),
  constraint ai_jobs_last_error_code_length check (last_error_code is null or char_length(last_error_code) <= 128)
);

-- The cache key: guarantees one Claude call per distinct enrichment unit.
create unique index ai_jobs_cache_key
  on private.ai_jobs (article_id, content_hash, prompt_version, model);

-- Drives private.lease_ai_jobs().
create index ai_jobs_status_available_at_idx
  on private.ai_jobs (status, available_at);

create trigger ai_jobs_set_updated_at
  before update on private.ai_jobs
  for each row execute function private.set_updated_at();

-- One row per sync-feeds invocation (arch-001 §3 response shape).
create table private.ingestion_runs (
  id             uuid primary key default gen_random_uuid(),
  trigger_source text not null default 'cron',
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  sources_ok     integer not null default 0,
  sources_failed integer not null default 0,
  inserted       integer not null default 0,
  updated        integer not null default 0,
  unchanged      integer not null default 0,
  -- Bounded error detail only: never article bodies, tokens, keys or full URLs.
  error_summary  text,

  constraint ingestion_runs_trigger_source check (trigger_source in ('cron', 'manual')),
  constraint ingestion_runs_counts_non_negative check (
    sources_ok >= 0 and sources_failed >= 0
    and inserted >= 0 and updated >= 0 and unchanged >= 0
  ),
  constraint ingestion_runs_error_summary_length check (
    error_summary is null or char_length(error_summary) <= 4000
  ),
  constraint ingestion_runs_window check (finished_at is null or finished_at >= started_at)
);

create index ingestion_runs_started_at_idx
  on private.ingestion_runs (started_at desc);

-- Fixed-window counters keyed by (subject, action, window_start).
-- `subject` is the validated X-Device-Id uuid (addendum §A), never a user id.
create table private.rate_limit_buckets (
  subject      text not null,
  action       text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  updated_at   timestamptz not null default now(),

  primary key (subject, action, window_start),
  constraint rate_limit_buckets_subject_length check (char_length(subject) between 1 and 128),
  constraint rate_limit_buckets_action_length check (char_length(action) between 1 and 64),
  constraint rate_limit_buckets_count_non_negative check (count >= 0)
);

-- Lets a maintenance job prune expired windows cheaply.
create index rate_limit_buckets_window_start_idx
  on private.rate_limit_buckets (window_start);

-- ===========================================================================
-- Digest tables — schema `aigundem`, read-only for clients.
-- ===========================================================================

create table aigundem.digests (
  id           uuid primary key default gen_random_uuid(),
  digest_date  date not null,
  timezone     text not null default 'Europe/Istanbul',
  status       aigundem.digest_status not null default 'preparing',
  headline     text,
  window_start timestamptz not null,
  window_end   timestamptz not null,
  generated_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- v1 has exactly one global digest per Istanbul day (arch-001 §2).
  constraint digests_timezone_check check (timezone = 'Europe/Istanbul'),
  constraint digests_headline_length check (headline is null or char_length(headline) between 1 and 300),
  constraint digests_window_order check (window_end > window_start),
  -- A ready digest is complete: it has a headline and a generation timestamp.
  constraint digests_ready_is_complete check (
    status <> 'ready' or (headline is not null and generated_at is not null)
  )
);

create unique index digests_digest_date_key
  on aigundem.digests (digest_date);

create index digests_status_digest_date_idx
  on aigundem.digests (status, digest_date desc);

create trigger digests_set_updated_at
  before update on aigundem.digests
  for each row execute function private.set_updated_at();

comment on table aigundem.digests is
  'One global daily digest per Europe/Istanbul day. Readable by anon/authenticated only when status = ready.';

create table aigundem.digest_items (
  digest_id  uuid not null references aigundem.digests (id) on delete cascade,
  position   smallint not null,
  article_id uuid not null references aigundem.articles (id) on delete cascade,
  blurb_tr   text not null,
  created_at timestamptz not null default now(),

  primary key (digest_id, position),
  constraint digest_items_position_range check ("position" between 1 and 5),
  constraint digest_items_blurb_length check (char_length(blurb_tr) between 1 and 600)
);

-- The same article may not appear twice in one digest.
create unique index digest_items_digest_article_key
  on aigundem.digest_items (digest_id, article_id);

create index digest_items_article_id_idx
  on aigundem.digest_items (article_id);

comment on table aigundem.digest_items is
  'Positions 1-5 of a digest. Readable by anon/authenticated only when the parent digest is ready.';

-- ===========================================================================
-- aigundem.feed_articles_v1 — the versioned client read surface.
--
-- security_invoker = true: the caller's RLS on sources/articles/summaries
-- applies, so the view cannot widen access. Summaries are joined only while
-- their content_hash still matches the article; a stale summary reads as
-- absent (summary_ready = false), which is exactly the "Özet hazırlanıyor"
-- state in addendum §E.
--
-- Feed pagination is keyset on (published_at, id) DESC, never OFFSET.
-- ===========================================================================
create view aigundem.feed_articles_v1
with (security_invoker = true) as
select
  a.id                    as article_id,
  a.source_id,
  s.slug                  as source_slug,
  s.name                  as source_name,
  s.site_url              as source_site_url,
  a.category,
  a.title,
  a.author,
  a.canonical_url,
  a.published_at,
  a.fetched_at,
  a.language,
  a.excerpt,
  a.content_text,
  a.content_quality,
  sm.summary_tr,
  sm.translation_tr,
  sm.translation_state,
  sm.model                as summary_model,
  sm.generated_at         as summary_generated_at,
  (sm.article_id is not null) as summary_ready
from aigundem.articles a
join aigundem.sources s
  on s.id = a.source_id
 and s.status = 'active'
left join aigundem.article_summaries sm
  on sm.article_id = a.id
 and sm.content_hash = a.content_hash;

comment on view aigundem.feed_articles_v1 is
  'Versioned feed read surface: active sources joined to articles and their non-stale summaries. security_invoker; RLS of the base tables applies.';

-- ===========================================================================
-- aigundem.search_articles_v1 — client-callable search.
--
-- SECURITY INVOKER (the default) on purpose: search must not widen what the
-- caller may read. Uses websearch_to_tsquery('simple', ...) against the GIN
-- index on aigundem.articles.search_tsv (migration 0002).
-- `source_ids` is preference filtering, not an authorization boundary.
-- ===========================================================================
create function aigundem.search_articles_v1(
  q          text,
  source_ids uuid[] default null,
  lim        integer default 20
)
returns setof aigundem.feed_articles_v1
language sql
stable
set search_path = ''
as $fn$
  select f.*
  from aigundem.feed_articles_v1 f
  join aigundem.articles a on a.id = f.article_id
  where q is not null
    and btrim(q) <> ''
    and char_length(q) <= 200
    and a.search_tsv @@ websearch_to_tsquery('simple', btrim(q))
    and (
      source_ids is null
      or cardinality(source_ids) = 0
      or f.source_id = any (source_ids)
    )
  order by f.published_at desc, f.article_id desc
  limit least(greatest(coalesce(lim, 20), 1), 50);
$fn$;

comment on function aigundem.search_articles_v1(text, uuid[], integer) is
  'Full-text search over readable articles. Blank/oversized q returns no rows; lim is clamped to 1..50.';

-- ===========================================================================
-- Internal RPCs — schema `private`, SECURITY DEFINER, search_path = ''.
-- Every referenced object is schema-qualified. EXECUTE is revoked from
-- public/anon/authenticated in migration 0005 and granted to service_role only.
-- ===========================================================================

-- Atomically lease up to n due sources for one sync-feeds run.
-- FOR UPDATE SKIP LOCKED plus a lease timestamp make concurrent runs disjoint.
create function private.lease_due_sources(n integer)
returns setof aigundem.sources
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_n integer := least(greatest(coalesce(n, 5), 1), 20);
begin
  return query
  with due as (
    select s.id
    from aigundem.sources s
    where s.status = 'active'
      and s.next_fetch_at <= now()
      and (s.lease_expires_at is null or s.lease_expires_at < now())
    order by s.next_fetch_at asc
    limit v_n
    for update skip locked
  )
  update aigundem.sources t
     set lease_expires_at = now() + interval '5 minutes',
         updated_at = now()
    from due
   where t.id = due.id
  returning t.*;
end;
$fn$;

comment on function private.lease_due_sources(integer) is
  'Leases up to n (clamped 1..20) due active sources with SKIP LOCKED. service_role only.';

-- Atomically lease up to n enrichment jobs for one process-enrichments run.
create function private.lease_ai_jobs(n integer)
returns setof private.ai_jobs
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_n integer := least(greatest(coalesce(n, 1), 1), 3);
begin
  return query
  with due as (
    select j.id
    from private.ai_jobs j
    where j.status in ('queued', 'leased')
      and j.available_at <= now()
      and (j.leased_until is null or j.leased_until < now())
      and j.attempt_count < j.max_attempts
    order by j.available_at asc
    limit v_n
    for update skip locked
  )
  update private.ai_jobs t
     set status = 'leased',
         attempt_count = t.attempt_count + 1,
         leased_until = now() + interval '5 minutes',
         lease_token = pg_catalog.gen_random_uuid(),
         updated_at = now()
    from due
   where t.id = due.id
  returning t.*;
end;
$fn$;

comment on function private.lease_ai_jobs(integer) is
  'Leases up to n (clamped 1..3) due AI jobs with SKIP LOCKED, incrementing attempt_count. service_role only.';

-- Fixed-window rate limit. Increments the bucket and returns whether the call
-- that caused the increment is still within p_limit.
-- Parameter names are p_-prefixed because `limit` is a reserved word; the
-- PostgREST wrapper in this migration keeps the same names.
create function private.bump_rate_limit(
  p_subject      text,
  p_action       text,
  p_window_start timestamptz,
  p_limit        integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_count integer;
begin
  if p_subject is null or btrim(p_subject) = '' or char_length(p_subject) > 128 then
    raise exception 'bump_rate_limit: invalid subject' using errcode = '22023';
  end if;
  if p_action is null or btrim(p_action) = '' or char_length(p_action) > 64 then
    raise exception 'bump_rate_limit: invalid action' using errcode = '22023';
  end if;
  if p_window_start is null then
    raise exception 'bump_rate_limit: window_start is required' using errcode = '22023';
  end if;
  if p_window_start > now() + interval '1 minute' then
    raise exception 'bump_rate_limit: window_start is in the future' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100000 then
    raise exception 'bump_rate_limit: invalid limit' using errcode = '22023';
  end if;

  insert into private.rate_limit_buckets as b (subject, action, window_start, count, updated_at)
  values (btrim(p_subject), btrim(p_action), p_window_start, 1, now())
  on conflict (subject, action, window_start)
  do update set count = b.count + 1, updated_at = now()
  returning b.count into v_count;

  return v_count <= p_limit;
end;
$fn$;

comment on function private.bump_rate_limit(text, text, timestamptz, integer) is
  'Increments a fixed-window counter and returns true while the window is within p_limit. service_role only.';

-- ===========================================================================
-- PostgREST-callable wrappers.
--
-- `private` is not an exposed schema, so these are how sync-feeds /
-- process-enrichments / add-source / request-enrichment reach the helpers:
--   supabase.schema('aigundem').rpc('internal_lease_due_sources', { n: 5 })
-- with the service_role key. EXECUTE is granted to service_role only (0005);
-- anon and authenticated get 42501 even though PostgREST advertises the names.
-- ===========================================================================

create function aigundem.internal_lease_due_sources(n integer)
returns setof aigundem.sources
language sql
security definer
set search_path = ''
as $fn$
  select * from private.lease_due_sources(n);
$fn$;

-- Columns are spelled out rather than `setof private.ai_jobs` so PostgREST
-- never has to introspect a composite type in an unexposed schema, and so the
-- `status` domain crosses the API boundary as plain text.
create function aigundem.internal_lease_ai_jobs(n integer)
returns table (
  id              uuid,
  article_id      uuid,
  content_hash    bytea,
  prompt_version  text,
  model           text,
  status          text,
  attempt_count   integer,
  max_attempts    integer,
  available_at    timestamptz,
  leased_until    timestamptz,
  lease_token     uuid,
  last_error_code text,
  created_at      timestamptz,
  updated_at      timestamptz
)
language sql
security definer
set search_path = ''
as $fn$
  select
    j.id,
    j.article_id,
    j.content_hash,
    j.prompt_version,
    j.model,
    j.status::text,
    j.attempt_count,
    j.max_attempts,
    j.available_at,
    j.leased_until,
    j.lease_token,
    j.last_error_code,
    j.created_at,
    j.updated_at
  from private.lease_ai_jobs(n) j;
$fn$;

create function aigundem.internal_bump_rate_limit(
  p_subject      text,
  p_action       text,
  p_window_start timestamptz,
  p_limit        integer
)
returns boolean
language sql
security definer
set search_path = ''
as $fn$
  select private.bump_rate_limit(p_subject, p_action, p_window_start, p_limit);
$fn$;

comment on function aigundem.internal_lease_due_sources(integer) is
  'service_role-only PostgREST wrapper for private.lease_due_sources.';
comment on function aigundem.internal_lease_ai_jobs(integer) is
  'service_role-only PostgREST wrapper for private.lease_ai_jobs.';
comment on function aigundem.internal_bump_rate_limit(text, text, timestamptz, integer) is
  'service_role-only PostgREST wrapper for private.bump_rate_limit.';
