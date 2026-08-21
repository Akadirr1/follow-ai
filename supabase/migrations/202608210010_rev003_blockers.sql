-- 202608210010_rev003_blockers.sql
-- Forward fix for the SQL half of rev-003 (B1, B4, N1, N5).
--
-- Applied migrations are immutable, so everything here is `create or replace`
-- of an existing function or a brand-new one. Nothing is dropped and no data is
-- touched: reverting means re-applying the previous body, not undoing a write.
--
-- Same rules as 0006/0007/0008: every function is SECURITY DEFINER with
-- `set search_path = ''`, every object reference is schema-qualified, there is
-- no dynamic SQL, arguments are validated, and each `aigundem.internal_*`
-- implementation gets a `public.aigundem_internal_*` transport shim because
-- PostgREST exposes `public` only (addendum §C.1). EXECUTE is revoked from
-- public/anon/authenticated and granted to `service_role` alone.
--
-- `#variable_conflict use_column` appears on every function whose OUT parameter
-- names collide with column names — the 42702 that 0009 had to fix. Any
-- function below with a `status` or `digest_date` OUT parameter carries it.

-- ===========================================================================
-- B1 — releasing a lease taken for a deferral must not spend an attempt
--
-- `private.lease_ai_jobs` (0004) increments `attempt_count` as part of leasing,
-- because leasing is what a Claude call used to imply. The daily-cap path does
-- NOT call Claude: it leases, discovers the budget is spent, and puts the job
-- back. Routing that through the ordinary retry RPC left the increment in
-- place, so every capped worker firing cost three jobs an attempt each. Jobs at
-- four attempts came back queued at five, `private.lease_ai_jobs` requires
-- `attempt_count < max_attempts`, and they were stranded — never summarised,
-- never failed, invisible.
--
-- This is the explicit inverse transition: it gives the attempt back, and only
-- while the caller still holds the lease.
-- ===========================================================================

create function aigundem.internal_release_ai_job_unattempted(
  p_job_id       uuid,
  p_lease_token  uuid,
  p_available_at timestamptz,
  p_error_code   text default 'daily_cap'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_rows integer := 0;
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'release_ai_job_unattempted: job id and lease token are required'
      using errcode = '22023';
  end if;
  if p_available_at is null then
    raise exception 'release_ai_job_unattempted: available_at is required'
      using errcode = '22023';
  end if;

  update private.ai_jobs j
     set status          = 'queued',
         available_at    = p_available_at,
         leased_until     = null,
         lease_token      = null,
         last_error_code  = left(p_error_code, 128),
         -- Exactly one attempt back, and never below zero: two releases against
         -- the same lease cannot happen (the token is cleared by the first),
         -- but a job that somehow reached 0 must not go negative and violate
         -- P2's ai_jobs_attempts_non_negative check.
         attempt_count    = greatest(j.attempt_count - 1, 0),
         updated_at       = now()
   where j.id = p_job_id
     and j.lease_token = p_lease_token
     and j.status = 'leased';

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$fn$;

comment on function aigundem.internal_release_ai_job_unattempted(uuid, uuid, timestamptz, text) is
  'Returns a leased job to the queue and gives back the attempt leasing consumed. Lease-token guarded. service_role only.';

-- ===========================================================================
-- N1 — polling an existing job must not spend the daily miss budget
--
-- `request-enrichment` charged the 30/day device budget and only then ran the
-- idempotent enqueue, so a client following the `poll_after_seconds` it was
-- handed spent quota on a job that already existed. At the 300-second no-key
-- interval that exhausts a day in 2.5 hours.
--
-- Charging and creating are now one statement sequence in one function body,
-- which is one transaction:
--
--   1. INSERT ... ON CONFLICT DO NOTHING RETURNING id — this, not a prior
--      SELECT, is what decides "genuinely new", and it decides it atomically.
--   2. Nothing inserted  -> the job already existed: return it, charged = false.
--   3. Something inserted -> charge. If the charge denies, DELETE the row we
--      just inserted and report allowed = false.
--
-- Step 3 is why the insert can come first: the row is invisible to every other
-- transaction until commit, so removing it again costs nothing and leaves no
-- window in which an over-budget request created work.
-- ===========================================================================

create function aigundem.internal_enqueue_ai_job_charged(
  p_article_id     uuid,
  p_content_hash   text,
  p_prompt_version text,
  p_model          text,
  p_subject        text,
  p_action         text,
  p_window_start   timestamptz,
  p_limit          integer
)
returns table (
  job_id  uuid,
  status  text,
  created boolean,
  charged boolean,
  allowed boolean
)
language plpgsql
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
declare
  v_hash    bytea;
  v_id      uuid;
  v_allowed boolean;
begin
  if p_article_id is null then
    raise exception 'enqueue_ai_job_charged: article id is required' using errcode = '22023';
  end if;
  if p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'enqueue_ai_job_charged: content_hash must be 64 lowercase hex characters'
      using errcode = '22023';
  end if;
  if p_prompt_version is null or char_length(p_prompt_version) not between 1 and 64 then
    raise exception 'enqueue_ai_job_charged: invalid prompt_version' using errcode = '22023';
  end if;
  if p_model is null or char_length(p_model) not between 1 and 128 then
    raise exception 'enqueue_ai_job_charged: invalid model' using errcode = '22023';
  end if;
  if p_subject is null or p_action is null or p_window_start is null or p_limit is null then
    raise exception 'enqueue_ai_job_charged: rate-limit arguments are required'
      using errcode = '22023';
  end if;

  v_hash := decode(p_content_hash, 'hex');

  insert into private.ai_jobs (article_id, content_hash, prompt_version, model)
  values (p_article_id, v_hash, p_prompt_version, p_model)
  on conflict (article_id, content_hash, prompt_version, model) do nothing
  returning id into v_id;

  if v_id is null then
    -- The job already existed. Polling is free.
    return query
      select j.id, j.status::text, false, false, true
        from private.ai_jobs j
       where j.article_id = p_article_id
         and j.content_hash = v_hash
         and j.prompt_version = p_prompt_version
         and j.model = p_model;
    return;
  end if;

  -- Genuinely new, so it costs the caller one of their daily misses.
  v_allowed := private.bump_rate_limit(p_subject, p_action, p_window_start, p_limit);

  if not v_allowed then
    -- Over budget: undo the job we just created. Invisible to everyone else
    -- until this transaction commits, so nothing observed it.
    delete from private.ai_jobs j where j.id = v_id;
    return query select null::uuid, null::text, false, true, false;
    return;
  end if;

  return query
    select j.id, j.status::text, true, true, true
      from private.ai_jobs j
     where j.id = v_id;
end;
$fn$;

comment on function aigundem.internal_enqueue_ai_job_charged(uuid, text, text, text, text, text, timestamptz, integer) is
  'Atomically returns an existing enrichment job uncharged, or charges the caller and creates a new one. service_role only.';

-- ===========================================================================
-- N5 — the source-state definer accepted p_ok = NULL
--
-- Re-created verbatim from 0006 with one extra guard. With a NULL boolean every
-- `case when p_ok then … else … end` silently took the else branch, so a NULL
-- looked like a failure in some columns and left others untouched — an
-- inconsistent row from an argument the function never agreed to accept. The
-- public shim already rejects NULL, so this is latent until `aigundem` is
-- exposed directly or another service caller appears; it is closed now, before
-- that happens.
-- ===========================================================================

create or replace function aigundem.internal_update_source_fetch_state(
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
  if p_ok is null then
    raise exception 'update_source_fetch_state: ok is required'
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
-- B4 — digest finalize must be five-or-none, under concurrency
--
-- The old body counted eligible articles in one statement, inserted in a later
-- one, and marked `ready` unconditionally. Under READ COMMITTED those two
-- statements see different snapshots: if ingestion changed an article's
-- `content_hash`, or a source left `active`, between the count and the insert,
-- fewer than five rows landed and the digest was still published. RLS exposes a
-- `ready` digest, so that is a durable, client-visible wrong answer. Two
-- simultaneous first finalizers could also race into the same delete/insert.
--
-- Both are closed by removing the seam rather than narrowing it:
--
--   * `select … for update` on the digest row serialises finalizers for this
--     date — the second waits, then sees `ready` and no-ops;
--   * there is NO pre-count any more. The single INSERT ... SELECT is the one
--     and only observation of the candidate set, and `get diagnostics
--     row_count` reports exactly what it wrote;
--   * `ready` is set only when that count is exactly 5. Otherwise the partial
--     rows are deleted and the digest stays `preparing`.
--
-- `missing` therefore reports 5 - what was actually insertable, which is the
-- number the client needs, not an estimate taken from a different snapshot.
-- ===========================================================================

create or replace function aigundem.internal_digest_prepare(p_date date default null)
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
#variable_conflict use_column
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

  select count(*) into v_items
    from aigundem.digest_items i
   where i.digest_id = v_id;

  -- Advisory only: prepare writes no items, so this count is a readiness
  -- report, not a decision. Finalize decides from its own insert.
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

  return query select v_date, v_status, v_items, greatest(0, 5 - v_candidates);
end;
$fn$;

create or replace function aigundem.internal_digest_finalize(p_date date default null)
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
#variable_conflict use_column
declare
  v_date     date;
  v_start    timestamptz;
  v_end      timestamptz;
  v_id       uuid;
  v_status   text;
  v_inserted integer := 0;
begin
  v_date := coalesce(p_date, (now() at time zone 'Europe/Istanbul')::date);

  if v_date < date '2026-01-01' or v_date > (now() at time zone 'Europe/Istanbul')::date + 1 then
    raise exception 'digest_finalize: date out of range' using errcode = '22023';
  end if;

  v_end := (v_date + time '05:00') at time zone 'Europe/Istanbul';
  v_start := v_end - interval '24 hours';

  -- Finalize works standalone: a manual call does not require prepare first.
  insert into aigundem.digests (
    digest_date, timezone, status, window_start, window_end
  )
  values (v_date, 'Europe/Istanbul', 'preparing', v_start, v_end)
  on conflict (digest_date) do nothing;

  -- Serialise finalizers for this date. A second caller blocks here, and when
  -- it proceeds it sees the first one's committed `ready` and no-ops instead of
  -- racing into the same delete/insert.
  select d.id, d.status::text
    into v_id, v_status
    from aigundem.digests d
   where d.digest_date = v_date
     for update;

  if v_status = 'ready' then
    select count(*) into v_inserted
      from aigundem.digest_items i
     where i.digest_id = v_id;
    return query select v_date, v_status, v_inserted, 0;
    return;
  end if;

  -- A digest that is not ready holds no items; this is defensive against a
  -- partial write from an interrupted earlier attempt.
  delete from aigundem.digest_items i where i.digest_id = v_id;

  -- THE single observation of the candidate set. Everything below decides from
  -- what this statement actually wrote.
  insert into aigundem.digest_items (digest_id, position, article_id, blurb_tr)
  with candidates as (
    select a.id           as article_id,
           a.source_id    as source_id,
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

  get diagnostics v_inserted = row_count;

  -- The only place `ready` is written, and it is written only for exactly five.
  if v_inserted = 5 then
    update aigundem.digests d
       set status       = 'ready',
           headline     = 'Bugünün AI Gündemi · ' || to_char(v_date, 'YYYY-MM-DD'),
           generated_at = now()
     where d.id = v_id;

    return query select v_date, 'ready'::text, v_inserted, 0;
    return;
  end if;

  -- Five or none. Remove whatever partial set landed and stay `preparing`; the
  -- 30/40/50 retries will try again against a later snapshot.
  delete from aigundem.digest_items i where i.digest_id = v_id;
  return query select v_date, 'preparing'::text, 0, 5 - v_inserted;
end;
$fn$;

-- ===========================================================================
-- Transport shims for the two new functions
-- ===========================================================================

create function public.aigundem_internal_release_ai_job_unattempted(
  p_job_id       uuid,
  p_lease_token  uuid,
  p_available_at timestamptz,
  p_error_code   text default 'daily_cap'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_job_id is null or p_lease_token is null or p_available_at is null then
    raise exception 'release_ai_job_unattempted: job id, lease token and available_at are required'
      using errcode = '22023';
  end if;

  return aigundem.internal_release_ai_job_unattempted(
    p_job_id, p_lease_token, p_available_at, p_error_code
  );
end;
$fn$;

create function public.aigundem_internal_enqueue_ai_job_charged(
  p_article_id     uuid,
  p_content_hash   text,
  p_prompt_version text,
  p_model          text,
  p_subject        text,
  p_action         text,
  p_window_start   timestamptz,
  p_limit          integer
)
returns table (
  job_id  uuid,
  status  text,
  created boolean,
  charged boolean,
  allowed boolean
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_article_id is null or p_content_hash is null
     or p_prompt_version is null or p_model is null
     or p_subject is null or p_action is null
     or p_window_start is null or p_limit is null then
    raise exception 'enqueue_ai_job_charged: all arguments are required'
      using errcode = '22023';
  end if;

  return query
    select r.job_id, r.status, r.created, r.charged, r.allowed
      from aigundem.internal_enqueue_ai_job_charged(
        p_article_id, p_content_hash, p_prompt_version, p_model,
        p_subject, p_action, p_window_start, p_limit
      ) r;
end;
$fn$;

comment on function public.aigundem_internal_release_ai_job_unattempted(uuid, uuid, timestamptz, text) is
  'TEMPORARY transport shim for aigundem.internal_release_ai_job_unattempted. service_role only.';
comment on function public.aigundem_internal_enqueue_ai_job_charged(uuid, text, text, text, text, text, timestamptz, integer) is
  'TEMPORARY transport shim for aigundem.internal_enqueue_ai_job_charged. service_role only.';

-- ===========================================================================
-- Privileges
--
-- New functions need the full revoke/grant. The re-created ones keep their
-- privileges across CREATE OR REPLACE; theirs are re-asserted exactly as 0009
-- does, so an audit can read the current state from this file alone.
-- ===========================================================================
revoke all on function aigundem.internal_release_ai_job_unattempted(uuid, uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function aigundem.internal_enqueue_ai_job_charged(uuid, text, text, text, text, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.aigundem_internal_release_ai_job_unattempted(uuid, uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.aigundem_internal_enqueue_ai_job_charged(uuid, text, text, text, text, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function aigundem.internal_update_source_fetch_state(uuid, boolean, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function aigundem.internal_digest_prepare(date) from public, anon, authenticated;
revoke all on function aigundem.internal_digest_finalize(date) from public, anon, authenticated;

grant execute on function aigundem.internal_release_ai_job_unattempted(uuid, uuid, timestamptz, text) to service_role;
grant execute on function aigundem.internal_enqueue_ai_job_charged(uuid, text, text, text, text, text, timestamptz, integer) to service_role;
grant execute on function public.aigundem_internal_release_ai_job_unattempted(uuid, uuid, timestamptz, text) to service_role;
grant execute on function public.aigundem_internal_enqueue_ai_job_charged(uuid, text, text, text, text, text, timestamptz, integer) to service_role;
grant execute on function aigundem.internal_update_source_fetch_state(uuid, boolean, text, text, timestamptz, text) to service_role;
grant execute on function aigundem.internal_digest_prepare(date) to service_role;
grant execute on function aigundem.internal_digest_finalize(date) to service_role;

notify pgrst, 'reload schema';
