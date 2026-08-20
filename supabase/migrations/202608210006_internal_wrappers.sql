-- 202608210006_internal_wrappers.sql
-- AI Gündem v1 — the service_role-only RPC surface that `sync-feeds` and
-- `add-source` call. Written by P3 at the coordinator's instruction, closing
-- the gap P2's report flagged.
--
-- WHY THIS EXISTS
-- PostgREST is exposed on 'public, aigundem' (migration 0001, addendum §B), so
-- `private.*` is unreachable from an Edge Function: supabase-js cannot address
-- an unexposed schema. Everything the ingestion path needs to write therefore
-- gets a SECURITY DEFINER wrapper in `aigundem`, EXECUTE-granted to
-- `service_role` alone. PostgREST advertises the names to `anon`; the missing
-- grant turns any such call into 42501.
--
-- Same safety rules as P2: `SET search_path = ''`, every object schema-
-- qualified, arguments validated, EXECUTE revoked from PUBLIC first. Nothing is
-- created in, or read from, `public`.

-- ===========================================================================
-- Compensating change: let `pending` sources be leased.
--
-- P2's private.lease_due_sources leases only `status = 'active'`. `add-source`
-- creates a source as `pending` on purpose — P2's RLS hides non-active sources
-- from clients, so a source with no articles yet must not appear in the shared
-- catalogue. With an active-only lease those rows would never be fetched and
-- would never become active: a source added by a user would stay invisible
-- forever.
--
-- Applied migrations are immutable, so this is the sanctioned fix: a forward
-- CREATE OR REPLACE with an identical signature. The `aigundem.internal_
-- lease_due_sources` wrapper and every grant from 0005 are untouched.
-- ===========================================================================
create or replace function private.lease_due_sources(n integer)
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
    where s.status in ('active', 'pending')
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
  'Leases up to n (clamped 1..20) due active OR pending sources with SKIP LOCKED. service_role only. Widened from active-only by migration 0006 so add-source rows can be validated.';

-- ===========================================================================
-- Lease one named source.
--
-- arch-001 §3 gives `sync-feeds` an optional `source_id`, which the lease-due
-- path cannot express: a named source is usually NOT due. This is the targeted
-- form, and it is what makes a remote smoke test of a single feed possible
-- without waiting 15 minutes for the schedule.
--
-- It still respects the lease, so a manual run cannot collide with a cron run,
-- and it still refuses a `failed` source — reviving one is a deliberate act,
-- not a side effect of a smoke test.
-- ===========================================================================
create function aigundem.internal_lease_source(p_source_id uuid)
returns setof aigundem.sources
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_source_id is null then
    raise exception 'lease_source: source id is required' using errcode = '22023';
  end if;

  return query
  with due as (
    select s.id
    from aigundem.sources s
    where s.id = p_source_id
      and s.status in ('active', 'pending', 'paused')
      and (s.lease_expires_at is null or s.lease_expires_at < now())
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

comment on function aigundem.internal_lease_source(uuid) is
  'Leases one named source regardless of next_fetch_at, for a manual or smoke run. service_role only.';

-- ===========================================================================
-- private.ingestion_runs lifecycle
-- ===========================================================================

create function aigundem.internal_start_ingestion_run(p_trigger_source text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_id uuid;
begin
  if p_trigger_source is null or p_trigger_source not in ('cron', 'manual') then
    raise exception 'start_ingestion_run: trigger must be cron or manual'
      using errcode = '22023';
  end if;

  insert into private.ingestion_runs (trigger_source, started_at)
  values (p_trigger_source, now())
  returning id into v_id;

  return v_id;
end;
$fn$;

create function aigundem.internal_finish_ingestion_run(
  p_run_id         uuid,
  p_sources_ok     integer,
  p_sources_failed integer,
  p_inserted       integer,
  p_updated        integer,
  p_unchanged      integer,
  p_error_summary  text
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_run_id is null then
    raise exception 'finish_ingestion_run: run id is required' using errcode = '22023';
  end if;

  update private.ingestion_runs r
     set finished_at    = now(),
         sources_ok     = greatest(coalesce(p_sources_ok, 0), 0),
         sources_failed = greatest(coalesce(p_sources_failed, 0), 0),
         inserted       = greatest(coalesce(p_inserted, 0), 0),
         updated        = greatest(coalesce(p_updated, 0), 0),
         unchanged      = greatest(coalesce(p_unchanged, 0), 0),
         error_summary  = left(p_error_summary, 4000)
   where r.id = p_run_id;
end;
$fn$;

-- ===========================================================================
-- Source fetch state
-- ===========================================================================

-- A source that fails this many consecutive times is parked as `failed` and
-- stops consuming lease slots until a human or a later task revives it.
create function aigundem.internal_update_source_fetch_state(
  p_source_id     uuid,
  p_ok            boolean,
  p_etag          text,
  p_last_modified text,
  p_next_fetch_at timestamptz,
  p_error_code    text
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_failure_limit constant integer := 10;
begin
  if p_source_id is null then
    raise exception 'update_source_fetch_state: source id is required'
      using errcode = '22023';
  end if;
  if p_next_fetch_at is null then
    raise exception 'update_source_fetch_state: next_fetch_at is required'
      using errcode = '22023';
  end if;

  update aigundem.sources s
     set last_fetched_at      = now(),
         last_success_at      = case when p_ok then now() else s.last_success_at end,
         etag                 = left(p_etag, 256),
         last_modified        = left(p_last_modified, 128),
         next_fetch_at        = p_next_fetch_at,
         consecutive_failures = case when p_ok then 0 else s.consecutive_failures + 1 end,
         last_error_code      = case when p_ok then null else left(p_error_code, 128) end,
         last_error_at        = case when p_ok then s.last_error_at else now() end,
         -- A successful fetch promotes a `pending` source to `active`, which is
         -- what makes it visible to clients under P2's RLS.
         status = case
                    when p_ok then 'active'::aigundem.source_status
                    when s.consecutive_failures + 1 >= v_failure_limit
                      then 'failed'::aigundem.source_status
                    else s.status
                  end,
         lease_expires_at     = null
   where s.id = p_source_id;
end;
$fn$;

-- ===========================================================================
-- Article batch upsert
--
-- One JSONB array in, one row of counts out. Each item is wrapped in its own
-- BEGIN/EXCEPTION block, which in plpgsql is a subtransaction: a malformed item
-- rolls back only itself, and the rest of the batch still commits. That is the
-- arch-001 §2 requirement "one malformed source/item cannot roll back other
-- sources/items", enforced here rather than hoped for in TypeScript.
--
-- Hashes arrive as 64-char hex and are decoded to bytea, because JSON has no
-- byte type.
-- ===========================================================================
create function aigundem.internal_upsert_articles(
  p_source_id uuid,
  p_articles  jsonb
)
returns table (
  inserted    integer,
  updated     integer,
  unchanged   integer,
  failed      integer,
  error_codes text[]
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_item          jsonb;
  v_existing_id   uuid;
  v_existing_hash bytea;
  v_content_hash  bytea;
  v_inserted      integer := 0;
  v_updated       integer := 0;
  v_unchanged     integer := 0;
  v_failed        integer := 0;
  v_errors        text[] := array[]::text[];
begin
  if p_source_id is null then
    raise exception 'upsert_articles: source id is required' using errcode = '22023';
  end if;
  if p_articles is null or jsonb_typeof(p_articles) <> 'array' then
    raise exception 'upsert_articles: articles must be a JSON array'
      using errcode = '22023';
  end if;
  if jsonb_array_length(p_articles) > 500 then
    raise exception 'upsert_articles: batch too large' using errcode = '22023';
  end if;

  for v_item in select e.value from jsonb_array_elements(p_articles) as e loop
    begin
      v_content_hash := decode(v_item ->> 'content_hash', 'hex');

      select a.id, a.content_hash
        into v_existing_id, v_existing_hash
        from aigundem.articles a
       where a.source_id = p_source_id
         and a.external_id = v_item ->> 'external_id';

      if v_existing_id is null then
        insert into aigundem.articles (
          source_id, external_id, canonical_url, url_hash, title, author,
          category, published_at, fetched_at, language, content_text,
          content_quality, content_hash, excerpt
        )
        values (
          p_source_id,
          v_item ->> 'external_id',
          v_item ->> 'canonical_url',
          decode(v_item ->> 'url_hash', 'hex'),
          v_item ->> 'title',
          v_item ->> 'author',
          (v_item ->> 'category')::aigundem.category,
          (v_item ->> 'published_at')::timestamptz,
          now(),
          (v_item ->> 'language')::aigundem.article_language,
          v_item ->> 'content_text',
          (v_item ->> 'content_quality')::aigundem.content_quality,
          v_content_hash,
          v_item ->> 'excerpt'
        );
        v_inserted := v_inserted + 1;

      elsif v_existing_hash = v_content_hash then
        -- Same content: no write, so no summary invalidation and no AI job.
        v_unchanged := v_unchanged + 1;

      else
        update aigundem.articles a
           set canonical_url   = v_item ->> 'canonical_url',
               url_hash        = decode(v_item ->> 'url_hash', 'hex'),
               title           = v_item ->> 'title',
               author          = v_item ->> 'author',
               published_at    = (v_item ->> 'published_at')::timestamptz,
               fetched_at      = now(),
               language        = (v_item ->> 'language')::aigundem.article_language,
               content_text    = v_item ->> 'content_text',
               content_quality = (v_item ->> 'content_quality')::aigundem.content_quality,
               content_hash    = v_content_hash,
               excerpt         = v_item ->> 'excerpt'
         where a.id = v_existing_id;
        v_updated := v_updated + 1;
      end if;

    exception
      when others then
        v_failed := v_failed + 1;
        -- SQLSTATE only. The message could quote the article body, and
        -- arch-001 §3 keeps article text out of responses and logs alike.
        if coalesce(array_length(v_errors, 1), 0) < 5
           and not (sqlstate = any (v_errors)) then
          v_errors := v_errors || sqlstate;
        end if;
    end;
  end loop;

  return query select v_inserted, v_updated, v_unchanged, v_failed, v_errors;
end;
$fn$;

-- ===========================================================================
-- Source upsert for `add-source`
--
-- Returns the row plus whether this call created it, so the function can answer
-- 201 or 200 without a second round trip and without a read-then-write race.
-- New sources start `pending`: P2's RLS shows clients only `active` sources, so
-- a source with no articles yet stays out of the shared catalogue until
-- `sync-feeds` succeeds against it once.
-- ===========================================================================
create function aigundem.internal_upsert_source(
  p_slug          text,
  p_name          text,
  p_feed_url      text,
  p_feed_url_hash text,
  p_site_url      text,
  p_language      text,
  p_category      text
)
returns table (
  id         uuid,
  slug       text,
  name       text,
  feed_url   text,
  site_url   text,
  language   text,
  category   text,
  status     text,
  is_default boolean,
  created    boolean
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_id      uuid;
  v_hash    bytea;
  v_created boolean := false;
begin
  if p_feed_url_hash is null or p_feed_url_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'upsert_source: feed_url_hash must be 64 lowercase hex characters'
      using errcode = '22023';
  end if;
  if p_feed_url is null or p_feed_url !~ '^https://' then
    raise exception 'upsert_source: feed_url must be https' using errcode = '22023';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'upsert_source: invalid slug' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) = 0 then
    raise exception 'upsert_source: name is required' using errcode = '22023';
  end if;

  v_hash := decode(p_feed_url_hash, 'hex');

  insert into aigundem.sources (
    slug, name, feed_url, feed_url_hash, site_url,
    language, category, is_default, status, next_fetch_at
  )
  values (
    p_slug,
    left(btrim(p_name), 200),
    p_feed_url,
    v_hash,
    p_site_url,
    p_language::aigundem.language_code,
    p_category::aigundem.category,
    false,
    'pending',
    now()
  )
  on conflict (feed_url_hash) do nothing
  returning aigundem.sources.id into v_id;

  if v_id is null then
    -- Someone already added this exact feed; return theirs.
    select s.id into v_id
      from aigundem.sources s
     where s.feed_url_hash = v_hash;
  else
    v_created := true;
  end if;

  if v_id is null then
    raise exception 'upsert_source: could not resolve source' using errcode = '23505';
  end if;

  return query
    select s.id, s.slug, s.name, s.feed_url, s.site_url,
           s.language::text, s.category::text, s.status::text,
           s.is_default, v_created
      from aigundem.sources s
     where s.id = v_id;
end;
$fn$;

-- ===========================================================================
-- Privileges — EXECUTE is granted to PUBLIC by default, so revoke first.
-- ===========================================================================
revoke all on function aigundem.internal_lease_source(uuid) from public;
revoke all on function aigundem.internal_start_ingestion_run(text) from public;
revoke all on function aigundem.internal_finish_ingestion_run(uuid, integer, integer, integer, integer, integer, text) from public;
revoke all on function aigundem.internal_update_source_fetch_state(uuid, boolean, text, text, timestamptz, text) from public;
revoke all on function aigundem.internal_upsert_articles(uuid, jsonb) from public;
revoke all on function aigundem.internal_upsert_source(text, text, text, text, text, text, text) from public;

grant execute on function aigundem.internal_lease_source(uuid) to service_role;
grant execute on function aigundem.internal_start_ingestion_run(text) to service_role;
grant execute on function aigundem.internal_finish_ingestion_run(uuid, integer, integer, integer, integer, integer, text) to service_role;
grant execute on function aigundem.internal_update_source_fetch_state(uuid, boolean, text, text, timestamptz, text) to service_role;
grant execute on function aigundem.internal_upsert_articles(uuid, jsonb) to service_role;
grant execute on function aigundem.internal_upsert_source(text, text, text, text, text, text, text) to service_role;

comment on function aigundem.internal_start_ingestion_run(text) is
  'Opens a private.ingestion_runs row. service_role only.';
comment on function aigundem.internal_finish_ingestion_run(uuid, integer, integer, integer, integer, integer, text) is
  'Closes a private.ingestion_runs row with its counts. service_role only.';
comment on function aigundem.internal_update_source_fetch_state(uuid, boolean, text, text, timestamptz, text) is
  'Records fetch outcome, conditional-GET validators, backoff and status. service_role only.';
comment on function aigundem.internal_upsert_articles(uuid, jsonb) is
  'Upserts a batch of articles on (source_id, external_id), isolating each item. service_role only.';
comment on function aigundem.internal_upsert_source(text, text, text, text, text, text, text) is
  'Inserts a shared source or returns the existing one for the same feed_url_hash. service_role only.';


-- ===========================================================================
-- PUBLIC TRANSPORT SHIMS  (coordinator decision, addendum §C.1)
--
-- MEASURED: `alter role authenticator set pgrst.db_schemas` fails with 42501 on
-- hosted Supabase — `authenticator` is a reserved role and the exposed-schema
-- list is a Dashboard / Management API setting. So `aigundem` is NOT reachable
-- through PostgREST until a human adds it, and that blocks the Edge Functions
-- exactly as it blocked the client reads: the exposed-schema list is server
-- configuration, and `service_role` does not bypass it.
--
-- These shims are transport, not logic. Each validates that its required
-- arguments are present, then delegates to the `aigundem.internal_*` function
-- above, which holds the single implementation and the full argument
-- validation. When the human exposes `aigundem`, the functions switch back by
-- setting AIGUNDEM_RPC_SCHEMA=aigundem and clearing AIGUNDEM_RPC_PREFIX; these
-- shims can then be dropped by a later migration.
--
-- Scope discipline, matching the coordinator's read shims:
--   * every name is prefixed `aigundem_`, so nothing can collide with the
--     unrelated application already living in `public`;
--   * no table, view or type is created in `public` — functions only;
--   * SECURITY DEFINER, `set search_path = ''`, every object schema-qualified,
--     NO dynamic SQL anywhere;
--   * EXECUTE revoked from public, anon and authenticated, granted to
--     `service_role` alone. PostgREST advertises these names to `anon`;
--     without the grant every such call is 42501.
--   * owned by the role applying the migration (postgres), as 0001-0005 are.
--     No explicit ALTER ... OWNER TO: a no-op as postgres, and a hard failure
--     as anyone else.
--
-- Columns are spelled out as plain `text`/`uuid` rather than
-- `setof aigundem.sources`, because PostgREST cannot introspect a composite
-- type in a schema it does not expose — which is the whole reason these exist.
-- ===========================================================================

create function public.aigundem_internal_lease_due_sources(n integer)
returns table (
  id                   uuid,
  slug                 text,
  name                 text,
  feed_url             text,
  site_url             text,
  language             text,
  category             text,
  status               text,
  etag                 text,
  last_modified        text,
  next_fetch_at        timestamptz,
  consecutive_failures integer
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return query
    select s.id, s.slug, s.name, s.feed_url, s.site_url,
           s.language::text, s.category::text, s.status::text,
           s.etag, s.last_modified, s.next_fetch_at, s.consecutive_failures
      from aigundem.internal_lease_due_sources(n) s;
end;
$fn$;

create function public.aigundem_internal_lease_source(p_source_id uuid)
returns table (
  id                   uuid,
  slug                 text,
  name                 text,
  feed_url             text,
  site_url             text,
  language             text,
  category             text,
  status               text,
  etag                 text,
  last_modified        text,
  next_fetch_at        timestamptz,
  consecutive_failures integer
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_source_id is null then
    raise exception 'lease_source: source id is required' using errcode = '22023';
  end if;

  return query
    select s.id, s.slug, s.name, s.feed_url, s.site_url,
           s.language::text, s.category::text, s.status::text,
           s.etag, s.last_modified, s.next_fetch_at, s.consecutive_failures
      from aigundem.internal_lease_source(p_source_id) s;
end;
$fn$;

create function public.aigundem_internal_start_ingestion_run(p_trigger_source text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_trigger_source is null then
    raise exception 'start_ingestion_run: trigger is required' using errcode = '22023';
  end if;

  return aigundem.internal_start_ingestion_run(p_trigger_source);
end;
$fn$;

create function public.aigundem_internal_finish_ingestion_run(
  p_run_id         uuid,
  p_sources_ok     integer,
  p_sources_failed integer,
  p_inserted       integer,
  p_updated        integer,
  p_unchanged      integer,
  p_error_summary  text
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_run_id is null then
    raise exception 'finish_ingestion_run: run id is required' using errcode = '22023';
  end if;

  perform aigundem.internal_finish_ingestion_run(
    p_run_id, p_sources_ok, p_sources_failed,
    p_inserted, p_updated, p_unchanged, p_error_summary
  );
end;
$fn$;

create function public.aigundem_internal_update_source_fetch_state(
  p_source_id     uuid,
  p_ok            boolean,
  p_etag          text,
  p_last_modified text,
  p_next_fetch_at timestamptz,
  p_error_code    text
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_source_id is null then
    raise exception 'update_source_fetch_state: source id is required'
      using errcode = '22023';
  end if;
  if p_ok is null then
    raise exception 'update_source_fetch_state: ok is required' using errcode = '22023';
  end if;
  if p_next_fetch_at is null then
    raise exception 'update_source_fetch_state: next_fetch_at is required'
      using errcode = '22023';
  end if;

  perform aigundem.internal_update_source_fetch_state(
    p_source_id, p_ok, p_etag, p_last_modified, p_next_fetch_at, p_error_code
  );
end;
$fn$;

create function public.aigundem_internal_upsert_articles(
  p_source_id uuid,
  p_articles  jsonb
)
returns table (
  inserted    integer,
  updated     integer,
  unchanged   integer,
  failed      integer,
  error_codes text[]
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_source_id is null then
    raise exception 'upsert_articles: source id is required' using errcode = '22023';
  end if;
  if p_articles is null then
    raise exception 'upsert_articles: articles are required' using errcode = '22023';
  end if;

  return query
    select r.inserted, r.updated, r.unchanged, r.failed, r.error_codes
      from aigundem.internal_upsert_articles(p_source_id, p_articles) r;
end;
$fn$;

create function public.aigundem_internal_bump_rate_limit(
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
begin
  if p_subject is null or p_action is null
     or p_window_start is null or p_limit is null then
    raise exception 'bump_rate_limit: all arguments are required'
      using errcode = '22023';
  end if;

  return aigundem.internal_bump_rate_limit(
    p_subject, p_action, p_window_start, p_limit
  );
end;
$fn$;

create function public.aigundem_internal_upsert_source(
  p_slug          text,
  p_name          text,
  p_feed_url      text,
  p_feed_url_hash text,
  p_site_url      text,
  p_language      text,
  p_category      text
)
returns table (
  id         uuid,
  slug       text,
  name       text,
  feed_url   text,
  site_url   text,
  language   text,
  category   text,
  status     text,
  is_default boolean,
  created    boolean
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_slug is null or p_name is null
     or p_feed_url is null or p_feed_url_hash is null then
    raise exception 'upsert_source: slug, name, feed_url and feed_url_hash are required'
      using errcode = '22023';
  end if;

  return query
    select r.id, r.slug, r.name, r.feed_url, r.site_url,
           r.language, r.category, r.status, r.is_default, r.created
      from aigundem.internal_upsert_source(
        p_slug, p_name, p_feed_url, p_feed_url_hash,
        p_site_url, p_language, p_category
      ) r;
end;
$fn$;

-- Privileges for the transport shims: closed to every client role.
revoke all on function public.aigundem_internal_lease_due_sources(integer) from public, anon, authenticated;
revoke all on function public.aigundem_internal_lease_source(uuid) from public, anon, authenticated;
revoke all on function public.aigundem_internal_start_ingestion_run(text) from public, anon, authenticated;
revoke all on function public.aigundem_internal_finish_ingestion_run(uuid, integer, integer, integer, integer, integer, text) from public, anon, authenticated;
revoke all on function public.aigundem_internal_update_source_fetch_state(uuid, boolean, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.aigundem_internal_upsert_articles(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.aigundem_internal_bump_rate_limit(text, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.aigundem_internal_upsert_source(text, text, text, text, text, text, text) from public, anon, authenticated;

grant execute on function public.aigundem_internal_lease_due_sources(integer) to service_role;
grant execute on function public.aigundem_internal_lease_source(uuid) to service_role;
grant execute on function public.aigundem_internal_start_ingestion_run(text) to service_role;
grant execute on function public.aigundem_internal_finish_ingestion_run(uuid, integer, integer, integer, integer, integer, text) to service_role;
grant execute on function public.aigundem_internal_update_source_fetch_state(uuid, boolean, text, text, timestamptz, text) to service_role;
grant execute on function public.aigundem_internal_upsert_articles(uuid, jsonb) to service_role;
grant execute on function public.aigundem_internal_bump_rate_limit(text, text, timestamptz, integer) to service_role;
grant execute on function public.aigundem_internal_upsert_source(text, text, text, text, text, text, text) to service_role;

comment on function public.aigundem_internal_lease_due_sources(integer) is
  'TEMPORARY transport shim for aigundem.internal_lease_due_sources. service_role only. Remove once aigundem is a PostgREST-exposed schema.';
comment on function public.aigundem_internal_lease_source(uuid) is
  'TEMPORARY transport shim for aigundem.internal_lease_source. service_role only.';
comment on function public.aigundem_internal_start_ingestion_run(text) is
  'TEMPORARY transport shim for aigundem.internal_start_ingestion_run. service_role only.';
comment on function public.aigundem_internal_finish_ingestion_run(uuid, integer, integer, integer, integer, integer, text) is
  'TEMPORARY transport shim for aigundem.internal_finish_ingestion_run. service_role only.';
comment on function public.aigundem_internal_update_source_fetch_state(uuid, boolean, text, text, timestamptz, text) is
  'TEMPORARY transport shim for aigundem.internal_update_source_fetch_state. service_role only.';
comment on function public.aigundem_internal_upsert_articles(uuid, jsonb) is
  'TEMPORARY transport shim for aigundem.internal_upsert_articles. service_role only.';
comment on function public.aigundem_internal_bump_rate_limit(text, text, timestamptz, integer) is
  'TEMPORARY transport shim for aigundem.internal_bump_rate_limit. service_role only.';
comment on function public.aigundem_internal_upsert_source(text, text, text, text, text, text, text) is
  'TEMPORARY transport shim for aigundem.internal_upsert_source. service_role only.';

notify pgrst, 'reload schema';
