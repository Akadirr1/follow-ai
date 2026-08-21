-- 202608210012_digest_candidates.sql
-- P12 — the digest enqueues its own candidates at prepare time.
--
-- WHY THIS EXISTS. Until now `request-enrichment` was the ONLY caller of
-- `internal_enqueue_ai_job*`: a summary existed because a human opened an
-- article. `internal_digest_prepare` (0008/0010) only counts what is already
-- enriched. Measured on 2026-08-21, today's Istanbul window held 122 enrichable
-- articles and zero summaries nobody had asked for, so `digest_finalize`
-- returned `preparing / missing 5` and would keep returning it unless five
-- different users happened to open five articles from five different sources
-- before the 03:30 UTC finalize. A daily product cannot depend on that
-- coincidence.
--
-- This function is the system asking for its own enrichments. It selects the
-- same candidate population `internal_digest_finalize` will rank, minus the
-- ones already summarised, and enqueues them.
--
-- IT DOES NOT CHARGE A RATE LIMIT. `internal_enqueue_ai_job_charged` (0010)
-- exists because a *device* spending the system's money needs a budget. Here
-- the system is spending its own, on its own schedule, so there is no subject
-- to charge and inventing one would corrupt some device's 30/day. The bound is
-- p_per_source x active sources, capped by p_limit, and capped again by the
-- worker's global AI_DAILY_CAP.
--
-- Same rules as 0006/0007/0008/0010: SECURITY DEFINER, `set search_path = ''`,
-- every reference schema-qualified, no dynamic SQL, arguments validated,
-- EXECUTE revoked from public/anon/authenticated and granted to `service_role`
-- alone, plus a `public.aigundem_internal_*` transport shim because PostgREST
-- exposes `public` only (addendum C.1). Nothing is dropped; this migration is
-- purely additive.

-- ===========================================================================
-- Enqueue the day's enrichment candidates
--
-- THE WINDOW IS DERIVED FROM THE DATE, exactly as 0010's two digest functions
-- derive it: `v_end = (date + 05:00) Europe/Istanbul`, opening 24 hours
-- earlier. It has to be the same derivation and not merely a similar one — an
-- article enqueued from a window the finalizer does not share is a call whose
-- result can never appear in a digest.
--
-- ONE STATEMENT decides everything. The candidate set, the per-source ranking,
-- the overall cap and the insert are a single data-modifying CTE, so
-- `candidates` and `enqueued` are counted from the same snapshot and `already`
-- (= candidates - enqueued) cannot drift the way a count-then-insert pair can
-- under READ COMMITTED.
-- ===========================================================================

create function aigundem.internal_enqueue_digest_candidates(
  p_date           date,
  p_model          text,
  p_prompt_version text,
  p_per_source     integer default 2,
  p_limit          integer default 15
)
returns table (
  enqueued   integer,
  already    integer,
  candidates integer
)
language plpgsql
security definer
set search_path = ''
as $fn$
-- The OUT names are plain words a future column could easily also be called;
-- `use_column` is the pragma 0009 had to add after a 42702 took the live
-- project down, and it is cheaper to carry than to diagnose.
#variable_conflict use_column
declare
  v_date       date;
  v_start      timestamptz;
  v_end        timestamptz;
  v_candidates integer := 0;
  v_enqueued   integer := 0;
begin
  v_date := coalesce(p_date, (now() at time zone 'Europe/Istanbul')::date);

  -- The same range 0010's digest functions accept: nothing from before the
  -- project existed, nothing beyond tomorrow's Istanbul date.
  if v_date < date '2026-01-01' or v_date > (now() at time zone 'Europe/Istanbul')::date + 1 then
    raise exception 'enqueue_digest_candidates: date out of range' using errcode = '22023';
  end if;
  if p_model is null or char_length(p_model) not between 1 and 128 then
    raise exception 'enqueue_digest_candidates: invalid model' using errcode = '22023';
  end if;
  if p_prompt_version is null or char_length(p_prompt_version) not between 1 and 64 then
    raise exception 'enqueue_digest_candidates: invalid prompt_version' using errcode = '22023';
  end if;
  -- Bounded on purpose: these two numbers ARE the daily spend, so a typo in a
  -- deploy variable must fail loudly rather than enqueue ten thousand calls.
  if p_per_source is null or p_per_source not between 1 and 5 then
    raise exception 'enqueue_digest_candidates: per_source must be between 1 and 5'
      using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception 'enqueue_digest_candidates: limit must be between 1 and 50'
      using errcode = '22023';
  end if;

  v_end := (v_date + time '05:00') at time zone 'Europe/Istanbul';
  v_start := v_end - interval '24 hours';

  with pool as (
    select a.id           as article_id,
           a.source_id    as source_id,
           a.published_at as published_at,
           a.content_hash as content_hash
      from aigundem.articles a
      join aigundem.sources s
        on s.id = a.source_id
       and s.status = 'active'
     where a.published_at >= v_start
       and a.published_at < v_end
       -- fix-003: a body-less item (the Hugging Face feed carries only a title
       -- and a link) cannot be summarised, so enqueueing one would buy a
       -- guaranteed `no_content` refusal.
       and a.content_text is not null
       and btrim(a.content_text) <> ''
       -- The anti-join that makes this idempotent and cheap: an article already
       -- summarised under THIS (content_hash, prompt_version, model) needs
       -- nothing. A different model or a re-ingested body is a different
       -- enrichment unit and correctly comes back as a candidate.
       and not exists (
         select 1
           from aigundem.article_summaries m
          where m.article_id = a.id
            and m.content_hash = a.content_hash
            and m.prompt_version = p_prompt_version
            and m.model = p_model
       )
  ),
  ranked as (
    select p.article_id,
           p.source_id,
           p.published_at,
           p.content_hash,
           row_number() over (
             partition by p.source_id
             order by p.published_at desc, p.article_id desc
           ) as source_rank
      from pool p
  ),
  -- Per-source first, so one prolific feed cannot spend the whole budget and
  -- leave the digest holding five items from one source — which finalize's
  -- round-robin ranking would refuse to build anyway.
  picked as (
    select r.article_id,
           r.content_hash
      from ranked r
     where r.source_rank <= p_per_source
     order by r.published_at desc, r.article_id desc
     limit p_limit
  ),
  ins as (
    insert into private.ai_jobs (article_id, content_hash, prompt_version, model)
    select k.article_id, k.content_hash, p_prompt_version, p_model
      from picked k
    -- The same unique key (0004's ai_jobs_cache_key) request-enrichment relies
    -- on. A job already queued, leased, ready or failed is left exactly as it
    -- is: this must never resurrect a job that gave up.
    on conflict (article_id, content_hash, prompt_version, model) do nothing
    returning 1
  )
  select (select count(*) from picked), (select count(*) from ins)
    into v_candidates, v_enqueued;

  return query select v_enqueued, v_candidates - v_enqueued, v_candidates;
end;
$fn$;

comment on function aigundem.internal_enqueue_digest_candidates(date, text, text, integer, integer) is
  'Enqueues un-summarised articles from the digest window for enrichment, per-source capped. No rate-limit charge. service_role only.';

-- ===========================================================================
-- Transport shim (addendum C.1)
-- ===========================================================================

create function public.aigundem_internal_enqueue_digest_candidates(
  p_date           date,
  p_model          text,
  p_prompt_version text,
  p_per_source     integer default 2,
  p_limit          integer default 15
)
returns table (
  enqueued   integer,
  already    integer,
  candidates integer
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_model is null or p_prompt_version is null
     or p_per_source is null or p_limit is null then
    raise exception 'enqueue_digest_candidates: model, prompt_version, per_source and limit are required'
      using errcode = '22023';
  end if;

  return query
    select r.enqueued, r.already, r.candidates
      from aigundem.internal_enqueue_digest_candidates(
        p_date, p_model, p_prompt_version, p_per_source, p_limit
      ) r;
end;
$fn$;

comment on function public.aigundem_internal_enqueue_digest_candidates(date, text, text, integer, integer) is
  'TEMPORARY transport shim for aigundem.internal_enqueue_digest_candidates. service_role only.';

-- ===========================================================================
-- Privileges — EXECUTE is granted to PUBLIC by default, so revoke first.
-- ===========================================================================
revoke all on function aigundem.internal_enqueue_digest_candidates(date, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.aigundem_internal_enqueue_digest_candidates(date, text, text, integer, integer) from public, anon, authenticated;

grant execute on function aigundem.internal_enqueue_digest_candidates(date, text, text, integer, integer) to service_role;
grant execute on function public.aigundem_internal_enqueue_digest_candidates(date, text, text, integer, integer) to service_role;

notify pgrst, 'reload schema';
