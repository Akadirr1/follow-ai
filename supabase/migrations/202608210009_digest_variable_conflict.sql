-- 202608210009_digest_variable_conflict.sql
-- Forward fix for 0008 (coordinator, measured on the live project 2026-08-21):
--
--   ERROR 42702: column reference "digest_date" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--   ... on conflict (digest_date) do nothing
--
-- `returns table (digest_date date, status text, ...)` declares OUT variables
-- named exactly like the aigundem.digests columns, and PL/pgSQL refuses to
-- guess inside `on conflict (...)`. Applied migrations are immutable, so both
-- functions are re-created with `#variable_conflict use_column`: inside SQL
-- statements an unqualified name means the column. Every variable in these
-- bodies is v_-prefixed and every column reference is aliased, so nothing else
-- changes. Bodies are otherwise identical to 0008.

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

  insert into aigundem.digests (
    digest_date, timezone, status, window_start, window_end
  )
  values (v_date, 'Europe/Istanbul', 'preparing', v_start, v_end)
  on conflict (digest_date) do nothing;

  select d.id, d.status::text
    into v_id, v_status
    from aigundem.digests d
   where d.digest_date = v_date;

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
    select count(*) into v_items
      from aigundem.digest_items i
     where i.digest_id = v_id;
    return query select v_date, 'preparing'::text, v_items, 5 - v_candidates;
    return;
  end if;

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

-- Privileges are preserved across CREATE OR REPLACE; re-asserted for audit.
revoke all on function aigundem.internal_digest_prepare(date) from public, anon, authenticated;
revoke all on function aigundem.internal_digest_finalize(date) from public, anon, authenticated;
grant execute on function aigundem.internal_digest_prepare(date) to service_role;
grant execute on function aigundem.internal_digest_finalize(date) to service_role;
