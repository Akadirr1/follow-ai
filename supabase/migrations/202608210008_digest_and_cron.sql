-- 202608210008_digest_and_cron.sql
-- AI Gündem v1 — the daily digest wrappers, the Vault-backed internal secret,
-- and the four scheduled jobs (created DISABLED).
--
-- Same shape and rules as P3's 0006 and P4's 0007: an `aigundem.internal_*`
-- implementation plus a `public.aigundem_internal_*` transport shim, because
-- PostgREST exposes `public` only until a human adds `aigundem` under Project
-- Settings → API → Exposed schemas (addendum §C.1). Every function is SECURITY
-- DEFINER with `set search_path = ''`, every object reference is schema-
-- qualified, there is no dynamic SQL, arguments are validated, EXECUTE is
-- revoked from public/anon/authenticated and granted to `service_role` alone.
-- No table, view or type is created in `public`.
--
-- NO CLAUDE IS INVOLVED IN THE DIGEST PATH. A blurb is the first bullet of a
-- summary `process-enrichments` already stored. That is what makes a digest
-- buildable with no Anthropic key in existence: five enriched articles in the
-- window complete it, fewer leave it `preparing` (addendum §E).

-- ===========================================================================
-- The internal automations secret
--
-- The secret cannot be set as an Edge Function environment variable tonight —
-- no CLI token, and the MCP has no secrets tool — so `AUTOMATIONS_SECRET` is
-- absent from Deno.env. The value is in Supabase Vault as
-- `aigundem_automations_secret`, which is also what the cron jobs below read
-- for their `X-Internal-Secret` header. Vault is therefore the source of truth
-- and this wrapper is how a function reaches it.
--
-- The allow-list is the whole point of the argument check: without it this is a
-- read-any-secret primitive, and a single future mistake in who may EXECUTE it
-- would expose every secret the project holds rather than this one.
-- ===========================================================================

create function aigundem.internal_get_setting(p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_value text;
begin
  if p_name is null or p_name not in ('aigundem_automations_secret') then
    raise exception 'get_setting: name is not on the allow-list'
      using errcode = '22023';
  end if;

  select v.decrypted_secret
    into v_value
    from vault.decrypted_secrets v
   where v.name = p_name;

  return v_value;
end;
$fn$;

comment on function aigundem.internal_get_setting(text) is
  'Reads one allow-listed Vault secret by name. service_role only.';

-- ===========================================================================
-- Digest: prepare
--
-- Creates (or returns) the `preparing` row for an Istanbul day and reports how
-- many enriched candidates its window currently holds, so a smoke run says
-- plainly whether finalize can succeed yet.
--
-- THE WINDOW IS DERIVED FROM THE DATE, NEVER FROM `now()` — apart from
-- defaulting the date itself. A retry at 03:50 UTC, a manual call, and a
-- backfill for last Tuesday all compute the same window, which is what makes
-- finalize idempotent.
--
-- It closes at 05:00 Istanbul on the digest's own date and opens 24 hours
-- earlier. 05:00 rather than midnight because the sources are mostly American:
-- OpenAI, Anthropic and DeepMind publish in US business hours, which is
-- Istanbul evening and night. A midnight boundary would push a story posted at
-- 01:00 Istanbul into the next day's digest, a full day late. 05:00 is also 45
-- minutes before the prepare job runs, so the window is always closed.
-- ===========================================================================

create function aigundem.internal_digest_prepare(p_date date default null)
returns table (
  digest_date date,
  status      text,
  item_count  integer,
  missing     integer
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_date       date;
  v_start      timestamptz;
  v_end        timestamptz;
  v_id         uuid;
  v_status     text;
  v_items      integer;
  v_candidates integer;
begin
  -- Postgres owns the timezone arithmetic: it has real tz data, so a future
  -- reinstatement of Turkish DST would be handled here without a code change.
  v_date := coalesce(p_date, (now() at time zone 'Europe/Istanbul')::date);

  if v_date < date '2026-01-01' or v_date > (now() at time zone 'Europe/Istanbul')::date + 1 then
    raise exception 'digest_prepare: date out of range' using errcode = '22023';
  end if;

  v_end := (v_date + time '05:00') at time zone 'Europe/Istanbul';
  v_start := v_end - interval '24 hours';

  insert into aigundem.digests (
    digest_date, timezone, status, window_start, window_end
  )
  values (v_date, 'Europe/Istanbul', 'preparing', v_start, v_end)
  on conflict (digest_date) do nothing;

  select d.id, d.status::text
    into v_id, v_status
    from aigundem.digests d
   where d.digest_date = v_date;

  select count(*)
    into v_items
    from aigundem.digest_items i
   where i.digest_id = v_id;

  select count(*)
    into v_candidates
    from aigundem.articles a
    join aigundem.sources s
      on s.id = a.source_id
     and s.status = 'active'
    join aigundem.article_summaries m
      on m.article_id = a.id
     and m.content_hash = a.content_hash
   where a.published_at >= v_start
     and a.published_at < v_end;

  return query
    select v_date,
           v_status,
           v_items,
           greatest(0, 5 - v_candidates);
end;
$fn$;

comment on function aigundem.internal_digest_prepare(date) is
  'Creates or returns the preparing digest for an Istanbul day and counts enriched candidates in its window. service_role only.';

-- ===========================================================================
-- Digest: finalize
--
-- THE RANKING. Candidates are articles in the window, from an active source,
-- carrying a summary whose `content_hash` still matches the article — a stale
-- summary simply does not join, so a rewritten article is not eligible until it
-- is re-enriched.
--
-- They are ordered by (per-source recency rank, published_at desc, id desc).
-- The effect is round-robin by source: every source's newest article first
-- (newest of those first), then every source's second-newest, and so on. Five
-- different sources give five different sources; a day when only two sources
-- published still fills five slots instead of returning two. That is "max one
-- per source first, then fill", generalised so it keeps working at two passes
-- or four.
--
-- The order is TOTAL, which is what makes it deterministic. `published_at` ties
-- — arXiv stamps a whole batch with the same minute — so the article id breaks
-- them, and ids are unique. Same data, same five items, same positions, every
-- run. `supabase/functions/_shared/digest.ts` mirrors this algorithm in
-- TypeScript and is what the Jest tests exercise; the clauses below are pinned
-- by `supabase/tests/sql-lint-p5.test.ts` so the two cannot drift silently.
--
-- ALL FIVE OR NONE: items are written only when the window holds five
-- candidates, so `digest_items` is never partially populated. A digest that is
-- already `ready` is left completely alone.
-- ===========================================================================

create function aigundem.internal_digest_finalize(p_date date default null)
returns table (
  digest_date date,
  status      text,
  item_count  integer,
  missing     integer
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_date       date;
  v_start      timestamptz;
  v_end        timestamptz;
  v_id         uuid;
  v_status     text;
  v_items      integer;
  v_candidates integer;
begin
  v_date := coalesce(p_date, (now() at time zone 'Europe/Istanbul')::date);

  if v_date < date '2026-01-01' or v_date > (now() at time zone 'Europe/Istanbul')::date + 1 then
    raise exception 'digest_finalize: date out of range' using errcode = '22023';
  end if;

  v_end := (v_date + time '05:00') at time zone 'Europe/Istanbul';
  v_start := v_end - interval '24 hours';

  -- Finalize works standalone: a manual call does not require prepare to have
  -- run first, which is what a smoke test wants.
  insert into aigundem.digests (
    digest_date, timezone, status, window_start, window_end
  )
  values (v_date, 'Europe/Istanbul', 'preparing', v_start, v_end)
  on conflict (digest_date) do nothing;

  select d.id, d.status::text
    into v_id, v_status
    from aigundem.digests d
   where d.digest_date = v_date;

  -- Idempotent: the 30/40/50 retries must not rewrite a digest that is done.
  if v_status = 'ready' then
    select count(*) into v_items
      from aigundem.digest_items i
     where i.digest_id = v_id;
    return query select v_date, v_status, v_items, 0;
    return;
  end if;

  select count(*)
    into v_candidates
    from aigundem.articles a
    join aigundem.sources s
      on s.id = a.source_id
     and s.status = 'active'
    join aigundem.article_summaries m
      on m.article_id = a.id
     and m.content_hash = a.content_hash
   where a.published_at >= v_start
     and a.published_at < v_end;

  if v_candidates < 5 then
    -- Not enough enriched articles yet. Nothing is written and nothing is
    -- invented; the client keeps showing "Digest hazırlanıyor" (addendum §E).
    select count(*) into v_items
      from aigundem.digest_items i
     where i.digest_id = v_id;
    return query select v_date, 'preparing'::text, v_items, 5 - v_candidates;
    return;
  end if;

  -- Defensive: a digest that is not `ready` should hold no items, but a partial
  -- write from an interrupted earlier attempt must not survive into the result.
  delete from aigundem.digest_items i where i.digest_id = v_id;

  insert into aigundem.digest_items (digest_id, position, article_id, blurb_tr)
  with candidates as (
    select a.id          as article_id,
           a.source_id   as source_id,
           a.published_at as published_at,
           m.summary_tr[1] as blurb
      from aigundem.articles a
      join aigundem.sources s
        on s.id = a.source_id
       and s.status = 'active'
      join aigundem.article_summaries m
        on m.article_id = a.id
       and m.content_hash = a.content_hash
     where a.published_at >= v_start
       and a.published_at < v_end
  ),
  per_source as (
    select c.article_id,
           c.source_id,
           c.published_at,
           c.blurb,
           row_number() over (
             partition by c.source_id
             order by c.published_at desc, c.article_id desc
           ) as source_rank
      from candidates c
  ),
  ordered as (
    select p.article_id,
           p.blurb,
           row_number() over (
             order by p.source_rank asc, p.published_at desc, p.article_id desc
           ) as slot
      from per_source p
  )
  select v_id, o.slot::smallint, o.article_id, left(btrim(o.blurb), 600)
    from ordered o
   where o.slot <= 5;

  update aigundem.digests d
     set status       = 'ready',
         headline     = 'Bugünün AI Gündemi · ' || to_char(v_date, 'YYYY-MM-DD'),
         generated_at = now()
   where d.id = v_id;

  select count(*) into v_items
    from aigundem.digest_items i
   where i.digest_id = v_id;

  return query select v_date, 'ready'::text, v_items, 0;
end;
$fn$;

comment on function aigundem.internal_digest_finalize(date) is
  'Deterministically ranks five enriched articles into digest_items and marks the digest ready. No-op once ready. service_role only.';

-- ===========================================================================
-- Transport shims
-- ===========================================================================

create function public.aigundem_internal_get_setting(p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_name is null then
    raise exception 'get_setting: name is required' using errcode = '22023';
  end if;

  return aigundem.internal_get_setting(p_name);
end;
$fn$;

create function public.aigundem_internal_digest_prepare(p_date date default null)
returns table (
  digest_date date,
  status      text,
  item_count  integer,
  missing     integer
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return query
    select r.digest_date, r.status, r.item_count, r.missing
      from aigundem.internal_digest_prepare(p_date) r;
end;
$fn$;

create function public.aigundem_internal_digest_finalize(p_date date default null)
returns table (
  digest_date date,
  status      text,
  item_count  integer,
  missing     integer
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return query
    select r.digest_date, r.status, r.item_count, r.missing
      from aigundem.internal_digest_finalize(p_date) r;
end;
$fn$;

comment on function public.aigundem_internal_get_setting(text) is
  'TEMPORARY transport shim for aigundem.internal_get_setting. service_role only.';
comment on function public.aigundem_internal_digest_prepare(date) is
  'TEMPORARY transport shim for aigundem.internal_digest_prepare. service_role only.';
comment on function public.aigundem_internal_digest_finalize(date) is
  'TEMPORARY transport shim for aigundem.internal_digest_finalize. service_role only.';

-- ===========================================================================
-- Privileges — EXECUTE is granted to PUBLIC by default, so revoke first.
-- ===========================================================================
revoke all on function aigundem.internal_get_setting(text) from public, anon, authenticated;
revoke all on function aigundem.internal_digest_prepare(date) from public, anon, authenticated;
revoke all on function aigundem.internal_digest_finalize(date) from public, anon, authenticated;
revoke all on function public.aigundem_internal_get_setting(text) from public, anon, authenticated;
revoke all on function public.aigundem_internal_digest_prepare(date) from public, anon, authenticated;
revoke all on function public.aigundem_internal_digest_finalize(date) from public, anon, authenticated;

grant execute on function aigundem.internal_get_setting(text) to service_role;
grant execute on function aigundem.internal_digest_prepare(date) to service_role;
grant execute on function aigundem.internal_digest_finalize(date) to service_role;
grant execute on function public.aigundem_internal_get_setting(text) to service_role;
grant execute on function public.aigundem_internal_digest_prepare(date) to service_role;
grant execute on function public.aigundem_internal_digest_finalize(date) to service_role;

-- ===========================================================================
-- Scheduling
--
-- The four jobs from arch-001 §2, CREATED DISABLED. The coordinator enables
-- them one at a time after each function's remote smoke passes — an enabled
-- `ai-gundem-ai-worker` on a project whose Claude path has never run would
-- march the whole backlog through its retry budget unattended.
--
--   ai-gundem-ingest          */15 * * * *      → sync-feeds
--   ai-gundem-ai-worker       */2 * * * *       → process-enrichments
--   ai-gundem-digest-prepare  45 2 * * *  UTC   → build-digest, phase prepare
--   ai-gundem-digest-finalize 30,40,50 3 * * *  → build-digest, phase finalize
--
-- All schedules are UTC: 02:45 UTC is 05:45 Istanbul, 45 minutes after the
-- digest window closes; the finalize retries at 03:30/03:40/03:50 UTC leave
-- more than three hours before the earliest 07:00 Istanbul notification.
--
-- The `X-Internal-Secret` header is read from Vault INSIDE each job body, so it
-- is fetched at execution time and never stored in the job definition. The
-- function URL prefers a database setting and falls back to the project's
-- literal URL, so a branch or a restored project can override it without
-- editing an applied migration.
--
-- Idempotent: each job is unscheduled if it already exists, then rescheduled.
-- ===========================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $cron$
declare
  v_id bigint;
begin
  if exists (select 1 from cron.job j where j.jobname = 'ai-gundem-ingest') then
    perform cron.unschedule('ai-gundem-ingest');
  end if;
  v_id := cron.schedule('ai-gundem-ingest', '*/15 * * * *', $job$
    select net.http_post(
      url := coalesce(
               current_setting('app.settings.functions_url', true),
               'https://eglxzbsrewbleqlstefd.supabase.co/functions/v1'
             ) || '/sync-feeds',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Internal-Secret', (
          select v.decrypted_secret
            from vault.decrypted_secrets v
           where v.name = 'aigundem_automations_secret'
        )
      ),
      body := jsonb_build_object('max_sources', 10),
      timeout_milliseconds := 55000
    );
  $job$);
  perform cron.alter_job(v_id, active := false);

  if exists (select 1 from cron.job j where j.jobname = 'ai-gundem-ai-worker') then
    perform cron.unschedule('ai-gundem-ai-worker');
  end if;
  v_id := cron.schedule('ai-gundem-ai-worker', '*/2 * * * *', $job$
    select net.http_post(
      url := coalesce(
               current_setting('app.settings.functions_url', true),
               'https://eglxzbsrewbleqlstefd.supabase.co/functions/v1'
             ) || '/process-enrichments',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Internal-Secret', (
          select v.decrypted_secret
            from vault.decrypted_secrets v
           where v.name = 'aigundem_automations_secret'
        )
      ),
      body := jsonb_build_object('max_jobs', 3),
      timeout_milliseconds := 55000
    );
  $job$);
  perform cron.alter_job(v_id, active := false);

  if exists (select 1 from cron.job j where j.jobname = 'ai-gundem-digest-prepare') then
    perform cron.unschedule('ai-gundem-digest-prepare');
  end if;
  v_id := cron.schedule('ai-gundem-digest-prepare', '45 2 * * *', $job$
    select net.http_post(
      url := coalesce(
               current_setting('app.settings.functions_url', true),
               'https://eglxzbsrewbleqlstefd.supabase.co/functions/v1'
             ) || '/build-digest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Internal-Secret', (
          select v.decrypted_secret
            from vault.decrypted_secrets v
           where v.name = 'aigundem_automations_secret'
        )
      ),
      body := jsonb_build_object('phase', 'prepare'),
      timeout_milliseconds := 55000
    );
  $job$);
  perform cron.alter_job(v_id, active := false);

  if exists (select 1 from cron.job j where j.jobname = 'ai-gundem-digest-finalize') then
    perform cron.unschedule('ai-gundem-digest-finalize');
  end if;
  v_id := cron.schedule('ai-gundem-digest-finalize', '30,40,50 3 * * *', $job$
    select net.http_post(
      url := coalesce(
               current_setting('app.settings.functions_url', true),
               'https://eglxzbsrewbleqlstefd.supabase.co/functions/v1'
             ) || '/build-digest',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Internal-Secret', (
          select v.decrypted_secret
            from vault.decrypted_secrets v
           where v.name = 'aigundem_automations_secret'
        )
      ),
      body := jsonb_build_object('phase', 'finalize'),
      timeout_milliseconds := 55000
    );
  $job$);
  perform cron.alter_job(v_id, active := false);
end;
$cron$;

notify pgrst, 'reload schema';
