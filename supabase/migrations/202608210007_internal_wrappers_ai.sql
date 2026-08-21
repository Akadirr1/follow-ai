-- 202608210007_internal_wrappers_ai.sql
-- AI Gündem v1 — the service_role-only RPC surface for `request-enrichment`
-- and `process-enrichments`.
--
-- Same shape and same rules as P3's 202608210006_internal_wrappers.sql:
-- an `aigundem.internal_*` implementation plus a `public.aigundem_internal_*`
-- transport shim, because PostgREST exposes `public` only until a human adds
-- `aigundem` under Project Settings → API → Exposed schemas (addendum §C.1;
-- `alter role authenticator` returns 42501 on hosted Supabase).
--
-- Every function here is SECURITY DEFINER with `set search_path = ''`, every
-- object reference is schema-qualified, there is NO dynamic SQL, arguments are
-- validated, EXECUTE is revoked from public/anon/authenticated and granted to
-- `service_role` alone. No table, view or type is created in `public`.
--
-- Leasing itself is NOT reimplemented: `internal_lease_enrichment_jobs` calls
-- P2's `private.lease_ai_jobs(n)`, which holds the SKIP LOCKED logic, the
-- attempt increment and the lease token. This migration only joins the article
-- the job is about, so the worker needs one round trip instead of N+1.
--
-- Hashes cross the API boundary as 64-character lowercase hex and are decoded
-- to `bytea` here, because JSON has no byte type.

-- ===========================================================================
-- Reads
-- ===========================================================================

-- What `request-enrichment` needs to compute the cache key, and what the worker
-- needs to build a prompt. `content_hash` is returned as hex so the caller can
-- pass it straight back.
create function aigundem.internal_find_article_for_enrichment(p_article_id uuid)
returns table (
  article_id      uuid,
  content_hash    text,
  title           text,
  language        text,
  content_text    text,
  content_quality text,
  source_name     text
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_article_id is null then
    raise exception 'find_article_for_enrichment: article id is required'
      using errcode = '22023';
  end if;

  return query
    select a.id,
           encode(a.content_hash, 'hex'),
           a.title,
           a.language::text,
           -- An excerpt-quality article has no full body; fall back to the
           -- excerpt so a summary is still possible. The prompt is told which
           -- it received and must not pretend otherwise (arch-001 §3).
           coalesce(nullif(a.content_text, ''), a.excerpt, ''),
           a.content_quality::text,
           s.name
      from aigundem.articles a
      join aigundem.sources s on s.id = a.source_id
     where a.id = p_article_id;
end;
$fn$;

-- The summary cache lookup: the exact key
-- (article_id, content_hash, prompt_version, model). A row whose content_hash
-- no longer matches the article is stale by construction and simply does not
-- match, so there is no invalidation step anywhere in this system.
create function aigundem.internal_find_summary(
  p_article_id     uuid,
  p_content_hash   text,
  p_prompt_version text,
  p_model          text
)
returns table (
  article_id        uuid,
  content_hash      text,
  prompt_version    text,
  model             text,
  summary_tr        text[],
  translation_tr    text,
  translation_state text
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_article_id is null then
    raise exception 'find_summary: article id is required' using errcode = '22023';
  end if;
  if p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'find_summary: content_hash must be 64 lowercase hex characters'
      using errcode = '22023';
  end if;
  if p_prompt_version is null or p_model is null then
    raise exception 'find_summary: prompt_version and model are required'
      using errcode = '22023';
  end if;

  return query
    select m.article_id,
           encode(m.content_hash, 'hex'),
           m.prompt_version,
           m.model,
           m.summary_tr,
           m.translation_tr,
           m.translation_state::text
      from aigundem.article_summaries m
     where m.article_id = p_article_id
       and m.content_hash = decode(p_content_hash, 'hex')
       and m.prompt_version = p_prompt_version
       and m.model = p_model;
end;
$fn$;

-- ===========================================================================
-- Job lifecycle
-- ===========================================================================

-- Idempotent enqueue on P2's unique cache key.
--
-- Deliberately NOT a revival: an existing job is returned exactly as it stands,
-- `failed` included, and `created` is false. Reviving a failed job whenever a
-- user taps again would let one permanently-broken article consume Claude
-- budget without limit. Requeuing a failed job is an operator action.
create function aigundem.internal_enqueue_ai_job(
  p_article_id     uuid,
  p_content_hash   text,
  p_prompt_version text,
  p_model          text
)
returns table (
  job_id  uuid,
  status  text,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_hash    bytea;
  v_id      uuid;
  v_created boolean := false;
begin
  if p_article_id is null then
    raise exception 'enqueue_ai_job: article id is required' using errcode = '22023';
  end if;
  if p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'enqueue_ai_job: content_hash must be 64 lowercase hex characters'
      using errcode = '22023';
  end if;
  if p_prompt_version is null or char_length(p_prompt_version) not between 1 and 64 then
    raise exception 'enqueue_ai_job: invalid prompt_version' using errcode = '22023';
  end if;
  if p_model is null or char_length(p_model) not between 1 and 128 then
    raise exception 'enqueue_ai_job: invalid model' using errcode = '22023';
  end if;

  v_hash := decode(p_content_hash, 'hex');

  insert into private.ai_jobs (article_id, content_hash, prompt_version, model)
  values (p_article_id, v_hash, p_prompt_version, p_model)
  on conflict (article_id, content_hash, prompt_version, model) do nothing
  returning id into v_id;

  if v_id is null then
    select j.id into v_id
      from private.ai_jobs j
     where j.article_id = p_article_id
       and j.content_hash = v_hash
       and j.prompt_version = p_prompt_version
       and j.model = p_model;
  else
    v_created := true;
  end if;

  if v_id is null then
    raise exception 'enqueue_ai_job: could not resolve job' using errcode = '23505';
  end if;

  return query
    select j.id, j.status::text, v_created
      from private.ai_jobs j
     where j.id = v_id;
end;
$fn$;

-- Lease up to n due jobs and hand back the article each one is about.
--
-- `private.lease_ai_jobs` (P2) does the leasing: SKIP LOCKED, status = leased,
-- attempt_count + 1, a fresh lease_token and a 5-minute expiry. It clamps n to
-- 1..3, which is exactly the `max_jobs` bound arch-001 §3 gives this function.
create function aigundem.internal_lease_enrichment_jobs(n integer)
returns table (
  job_id          uuid,
  lease_token     uuid,
  article_id      uuid,
  content_hash    text,
  prompt_version  text,
  model           text,
  attempt_count   integer,
  max_attempts    integer,
  last_error_code text,
  title           text,
  language        text,
  content_text    text,
  content_quality text,
  source_name     text
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  -- The UPPER bound is P2's business: `private.lease_ai_jobs` clamps to 1..3,
  -- which is the `max_jobs` bound arch-001 §3 gives this function. A
  -- non-positive n, though, is a caller bug rather than an over-ask, and
  -- silently returning nothing would look like an empty queue.
  if n is not null and n < 1 then
    raise exception 'lease_enrichment_jobs: n must be positive' using errcode = '22023';
  end if;

  return query
    select j.id,
           j.lease_token,
           j.article_id,
           encode(j.content_hash, 'hex'),
           j.prompt_version,
           j.model,
           j.attempt_count,
           j.max_attempts,
           j.last_error_code,
           a.title,
           a.language::text,
           coalesce(nullif(a.content_text, ''), a.excerpt, ''),
           a.content_quality::text,
           s.name
      from private.lease_ai_jobs(n) j
      join aigundem.articles a on a.id = j.article_id
      join aigundem.sources s on s.id = a.source_id;
end;
$fn$;

-- Write the summary and close the job in ONE statement pair, guarded by the
-- lease token.
--
-- Atomicity is the point. If the summary were written by one call and the job
-- closed by another, a crash between them would leave a `leased` job whose work
-- is already done — and the next worker would pay Claude again for a summary
-- that already exists. Here both happen in the same transaction or neither
-- does.
--
-- Returns false when the lease no longer matches: the worker took too long, its
-- lease expired, and another worker owns the job. That worker's result stands;
-- this one's is discarded. Two workers, one write.
create function aigundem.internal_complete_enrichment(
  p_job_id            uuid,
  p_lease_token       uuid,
  p_content_hash      text,
  p_prompt_version    text,
  p_model             text,
  p_summary_tr        text[],
  p_translation_tr    text,
  p_translation_state text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_article_id uuid;
  v_hash       bytea;
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'complete_enrichment: job id and lease token are required'
      using errcode = '22023';
  end if;
  if p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'complete_enrichment: content_hash must be 64 lowercase hex characters'
      using errcode = '22023';
  end if;
  if p_summary_tr is null or cardinality(p_summary_tr) <> 3 then
    raise exception 'complete_enrichment: summary must have exactly three bullets'
      using errcode = '22023';
  end if;
  if p_translation_state is null
     or p_translation_state not in ('ready', 'not_required') then
    raise exception 'complete_enrichment: invalid translation_state'
      using errcode = '22023';
  end if;

  v_hash := decode(p_content_hash, 'hex');

  -- Claim the job first. No row means no valid lease, so nothing is written.
  update private.ai_jobs j
     set status          = 'ready',
         leased_until    = null,
         lease_token     = null,
         last_error_code = null,
         updated_at      = now()
   where j.id = p_job_id
     and j.lease_token = p_lease_token
     and j.status = 'leased'
  returning j.article_id into v_article_id;

  if v_article_id is null then
    return false;
  end if;

  insert into aigundem.article_summaries (
    article_id, content_hash, prompt_version, model,
    summary_tr, translation_tr, translation_state, generated_at
  )
  values (
    v_article_id, v_hash, p_prompt_version, p_model,
    p_summary_tr, p_translation_tr,
    p_translation_state::aigundem.translation_state, now()
  )
  on conflict (article_id) do update
     set content_hash      = excluded.content_hash,
         prompt_version    = excluded.prompt_version,
         model             = excluded.model,
         summary_tr        = excluded.summary_tr,
         translation_tr    = excluded.translation_tr,
         translation_state = excluded.translation_state,
         generated_at      = excluded.generated_at;

  return true;
end;
$fn$;

-- Put a job back with a backoff. `available_at` is computed by the worker so
-- the jitter is testable there; this only records it.
create function aigundem.internal_retry_ai_job(
  p_job_id       uuid,
  p_lease_token  uuid,
  p_available_at timestamptz,
  p_error_code   text
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
    raise exception 'retry_ai_job: job id and lease token are required'
      using errcode = '22023';
  end if;
  if p_available_at is null then
    raise exception 'retry_ai_job: available_at is required' using errcode = '22023';
  end if;

  update private.ai_jobs j
     set status          = 'queued',
         available_at    = p_available_at,
         leased_until    = null,
         lease_token     = null,
         last_error_code = left(p_error_code, 128),
         updated_at      = now()
   where j.id = p_job_id
     and j.lease_token = p_lease_token
     and j.status = 'leased';

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$fn$;

-- Give up on a job. Terminal: nothing leases a `failed` job again, and
-- `internal_enqueue_ai_job` will not revive it.
create function aigundem.internal_fail_ai_job(
  p_job_id      uuid,
  p_lease_token uuid,
  p_error_code  text
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
    raise exception 'fail_ai_job: job id and lease token are required'
      using errcode = '22023';
  end if;

  update private.ai_jobs j
     set status          = 'failed',
         leased_until    = null,
         lease_token     = null,
         last_error_code = left(p_error_code, 128),
         updated_at      = now()
   where j.id = p_job_id
     and j.lease_token = p_lease_token
     and j.status = 'leased';

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$fn$;

comment on function aigundem.internal_find_article_for_enrichment(uuid) is
  'Article fields needed to build an enrichment prompt and its cache key. service_role only.';
comment on function aigundem.internal_find_summary(uuid, text, text, text) is
  'Exact-cache-key summary lookup. A stale content_hash simply does not match. service_role only.';
comment on function aigundem.internal_enqueue_ai_job(uuid, text, text, text) is
  'Idempotent enqueue on the unique cache key. Never revives a failed job. service_role only.';
comment on function aigundem.internal_lease_enrichment_jobs(integer) is
  'Leases 1..3 due jobs via private.lease_ai_jobs and joins the article. service_role only.';
comment on function aigundem.internal_complete_enrichment(uuid, uuid, text, text, text, text[], text, text) is
  'Atomically closes a leased job and writes its summary. False when the lease was lost. service_role only.';
comment on function aigundem.internal_retry_ai_job(uuid, uuid, timestamptz, text) is
  'Requeues a leased job with a backoff. False when the lease was lost. service_role only.';
comment on function aigundem.internal_fail_ai_job(uuid, uuid, text) is
  'Marks a leased job failed, terminally. False when the lease was lost. service_role only.';

-- ===========================================================================
-- PUBLIC TRANSPORT SHIMS
--
-- Same rationale, rules and naming as P3's shims: `aigundem` is not a
-- PostgREST-exposed schema, so an Edge Function cannot address it. Each shim
-- validates its required arguments and delegates; the implementation and the
-- full validation stay in `aigundem` above. PostgREST advertises these names to
-- `anon`, and the missing grant makes every such call 42501.
--
-- Columns are spelled out as plain types rather than composites from
-- `aigundem`, because PostgREST cannot introspect a type in a schema it does
-- not expose — which is the reason these exist at all.
-- ===========================================================================

create function public.aigundem_internal_find_article_for_enrichment(p_article_id uuid)
returns table (
  article_id      uuid,
  content_hash    text,
  title           text,
  language        text,
  content_text    text,
  content_quality text,
  source_name     text
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_article_id is null then
    raise exception 'find_article_for_enrichment: article id is required'
      using errcode = '22023';
  end if;

  return query
    select r.article_id, r.content_hash, r.title, r.language,
           r.content_text, r.content_quality, r.source_name
      from aigundem.internal_find_article_for_enrichment(p_article_id) r;
end;
$fn$;

create function public.aigundem_internal_find_summary(
  p_article_id     uuid,
  p_content_hash   text,
  p_prompt_version text,
  p_model          text
)
returns table (
  article_id        uuid,
  content_hash      text,
  prompt_version    text,
  model             text,
  summary_tr        text[],
  translation_tr    text,
  translation_state text
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_article_id is null or p_content_hash is null
     or p_prompt_version is null or p_model is null then
    raise exception 'find_summary: all arguments are required' using errcode = '22023';
  end if;

  return query
    select r.article_id, r.content_hash, r.prompt_version, r.model,
           r.summary_tr, r.translation_tr, r.translation_state
      from aigundem.internal_find_summary(
        p_article_id, p_content_hash, p_prompt_version, p_model
      ) r;
end;
$fn$;

create function public.aigundem_internal_enqueue_ai_job(
  p_article_id     uuid,
  p_content_hash   text,
  p_prompt_version text,
  p_model          text
)
returns table (
  job_id  uuid,
  status  text,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_article_id is null or p_content_hash is null
     or p_prompt_version is null or p_model is null then
    raise exception 'enqueue_ai_job: all arguments are required' using errcode = '22023';
  end if;

  return query
    select r.job_id, r.status, r.created
      from aigundem.internal_enqueue_ai_job(
        p_article_id, p_content_hash, p_prompt_version, p_model
      ) r;
end;
$fn$;

create function public.aigundem_internal_lease_enrichment_jobs(n integer)
returns table (
  job_id          uuid,
  lease_token     uuid,
  article_id      uuid,
  content_hash    text,
  prompt_version  text,
  model           text,
  attempt_count   integer,
  max_attempts    integer,
  last_error_code text,
  title           text,
  language        text,
  content_text    text,
  content_quality text,
  source_name     text
)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return query
    select r.job_id, r.lease_token, r.article_id, r.content_hash,
           r.prompt_version, r.model, r.attempt_count, r.max_attempts,
           r.last_error_code, r.title, r.language, r.content_text,
           r.content_quality, r.source_name
      from aigundem.internal_lease_enrichment_jobs(n) r;
end;
$fn$;

create function public.aigundem_internal_complete_enrichment(
  p_job_id            uuid,
  p_lease_token       uuid,
  p_content_hash      text,
  p_prompt_version    text,
  p_model             text,
  p_summary_tr        text[],
  p_translation_tr    text,
  p_translation_state text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_job_id is null or p_lease_token is null or p_content_hash is null
     or p_prompt_version is null or p_model is null
     or p_summary_tr is null or p_translation_state is null then
    raise exception 'complete_enrichment: required arguments are missing'
      using errcode = '22023';
  end if;

  return aigundem.internal_complete_enrichment(
    p_job_id, p_lease_token, p_content_hash, p_prompt_version,
    p_model, p_summary_tr, p_translation_tr, p_translation_state
  );
end;
$fn$;

create function public.aigundem_internal_retry_ai_job(
  p_job_id       uuid,
  p_lease_token  uuid,
  p_available_at timestamptz,
  p_error_code   text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_job_id is null or p_lease_token is null or p_available_at is null then
    raise exception 'retry_ai_job: job id, lease token and available_at are required'
      using errcode = '22023';
  end if;

  return aigundem.internal_retry_ai_job(
    p_job_id, p_lease_token, p_available_at, p_error_code
  );
end;
$fn$;

create function public.aigundem_internal_fail_ai_job(
  p_job_id      uuid,
  p_lease_token uuid,
  p_error_code  text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'fail_ai_job: job id and lease token are required'
      using errcode = '22023';
  end if;

  return aigundem.internal_fail_ai_job(p_job_id, p_lease_token, p_error_code);
end;
$fn$;

-- ===========================================================================
-- Privileges — EXECUTE is granted to PUBLIC by default, so revoke first.
-- ===========================================================================
revoke all on function aigundem.internal_find_article_for_enrichment(uuid) from public, anon, authenticated;
revoke all on function aigundem.internal_find_summary(uuid, text, text, text) from public, anon, authenticated;
revoke all on function aigundem.internal_enqueue_ai_job(uuid, text, text, text) from public, anon, authenticated;
revoke all on function aigundem.internal_lease_enrichment_jobs(integer) from public, anon, authenticated;
revoke all on function aigundem.internal_complete_enrichment(uuid, uuid, text, text, text, text[], text, text) from public, anon, authenticated;
revoke all on function aigundem.internal_retry_ai_job(uuid, uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function aigundem.internal_fail_ai_job(uuid, uuid, text) from public, anon, authenticated;

revoke all on function public.aigundem_internal_find_article_for_enrichment(uuid) from public, anon, authenticated;
revoke all on function public.aigundem_internal_find_summary(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.aigundem_internal_enqueue_ai_job(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.aigundem_internal_lease_enrichment_jobs(integer) from public, anon, authenticated;
revoke all on function public.aigundem_internal_complete_enrichment(uuid, uuid, text, text, text, text[], text, text) from public, anon, authenticated;
revoke all on function public.aigundem_internal_retry_ai_job(uuid, uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.aigundem_internal_fail_ai_job(uuid, uuid, text) from public, anon, authenticated;

grant execute on function aigundem.internal_find_article_for_enrichment(uuid) to service_role;
grant execute on function aigundem.internal_find_summary(uuid, text, text, text) to service_role;
grant execute on function aigundem.internal_enqueue_ai_job(uuid, text, text, text) to service_role;
grant execute on function aigundem.internal_lease_enrichment_jobs(integer) to service_role;
grant execute on function aigundem.internal_complete_enrichment(uuid, uuid, text, text, text, text[], text, text) to service_role;
grant execute on function aigundem.internal_retry_ai_job(uuid, uuid, timestamptz, text) to service_role;
grant execute on function aigundem.internal_fail_ai_job(uuid, uuid, text) to service_role;

grant execute on function public.aigundem_internal_find_article_for_enrichment(uuid) to service_role;
grant execute on function public.aigundem_internal_find_summary(uuid, text, text, text) to service_role;
grant execute on function public.aigundem_internal_enqueue_ai_job(uuid, text, text, text) to service_role;
grant execute on function public.aigundem_internal_lease_enrichment_jobs(integer) to service_role;
grant execute on function public.aigundem_internal_complete_enrichment(uuid, uuid, text, text, text, text[], text, text) to service_role;
grant execute on function public.aigundem_internal_retry_ai_job(uuid, uuid, timestamptz, text) to service_role;
grant execute on function public.aigundem_internal_fail_ai_job(uuid, uuid, text) to service_role;

comment on function public.aigundem_internal_find_article_for_enrichment(uuid) is
  'TEMPORARY transport shim for aigundem.internal_find_article_for_enrichment. service_role only.';
comment on function public.aigundem_internal_find_summary(uuid, text, text, text) is
  'TEMPORARY transport shim for aigundem.internal_find_summary. service_role only.';
comment on function public.aigundem_internal_enqueue_ai_job(uuid, text, text, text) is
  'TEMPORARY transport shim for aigundem.internal_enqueue_ai_job. service_role only.';
comment on function public.aigundem_internal_lease_enrichment_jobs(integer) is
  'TEMPORARY transport shim for aigundem.internal_lease_enrichment_jobs. service_role only.';
comment on function public.aigundem_internal_complete_enrichment(uuid, uuid, text, text, text, text[], text, text) is
  'TEMPORARY transport shim for aigundem.internal_complete_enrichment. service_role only.';
comment on function public.aigundem_internal_retry_ai_job(uuid, uuid, timestamptz, text) is
  'TEMPORARY transport shim for aigundem.internal_retry_ai_job. service_role only.';
comment on function public.aigundem_internal_fail_ai_job(uuid, uuid, text) is
  'TEMPORARY transport shim for aigundem.internal_fail_ai_job. service_role only.';

notify pgrst, 'reload schema';
