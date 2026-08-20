-- supabase/tests/rls-probes.sql
-- AI Gündem v1 — remote RLS/grant probes for the COORDINATOR to run against the
-- hosted project AFTER migrations 202608210001..0005 have been applied.
--
-- Written by the P2 implementer, who has no database access. Nothing here was
-- executed: every expectation below is a prediction until the coordinator runs
-- it and reads the output.
--
-- How to run (Supabase MCP `execute_sql`, or psql as the `postgres` role):
--   * SECTION 1 is the authoritative form required by the brief: plain
--     statements grouped into BEGIN/ROLLBACK blocks, each annotated with its
--     expectation. Run one block per call — a statement that fails aborts its
--     transaction, so later statements in the same block would report
--     "current transaction is aborted" instead of their own result.
--   * SECTION 2 is a convenience: one self-contained script that runs every
--     probe, traps the errors, and returns a PASS/FAIL table in a single call.
--     Prefer it for the first sweep; fall back to SECTION 1 to investigate a
--     FAIL row.
--
-- Everything runs inside a transaction that is ROLLED BACK. No probe leaves a
-- row behind, and nothing touches the `public` schema or the unrelated
-- application that lives there.

-- ===========================================================================
-- SECTION 1 — explicit probes
-- ===========================================================================

-- 1.1  anon may read the shared tables. EXPECT: all five counts return.
begin;
  set local role anon;
  select count(*) as sources_visible_to_anon      from aigundem.sources;             -- EXPECT: ok
  select count(*) as articles_visible_to_anon     from aigundem.articles;            -- EXPECT: ok
  select count(*) as summaries_visible_to_anon    from aigundem.article_summaries;   -- EXPECT: ok
  select count(*) as digests_visible_to_anon      from aigundem.digests;             -- EXPECT: ok (ready only)
  select count(*) as digest_items_visible_to_anon from aigundem.digest_items;        -- EXPECT: ok (ready parents only)
  select count(*) as feed_rows_visible_to_anon    from aigundem.feed_articles_v1;    -- EXPECT: ok
  select count(*) as search_rows                  from aigundem.search_articles_v1('openai'); -- EXPECT: ok
rollback;

-- 1.2  The row filters actually filter. Run as postgres (no role switch) and
--      compare against 1.1. EXPECT: anon counts <= total counts, and
--      non-active sources / non-ready digests are exactly the difference.
begin;
  select
    (select count(*) from aigundem.sources)                          as sources_total,
    (select count(*) from aigundem.sources where status = 'active')  as sources_active,
    (select count(*) from aigundem.digests)                          as digests_total,
    (select count(*) from aigundem.digests where status = 'ready')   as digests_ready;
rollback;

-- 1.3  anon may not write shared content. One block per statement: each is
--      expected to fail with 42501 (insufficient_privilege).
begin;
  set local role anon;
  insert into aigundem.sources (slug, name, feed_url, feed_url_hash, language, category)
  values ('rls-probe', 'RLS Probe', 'https://example.com/feed.xml',
          decode(repeat('ab', 32), 'hex'), 'en', 'Modeller');            -- EXPECT: ERROR 42501
rollback;

begin;
  set local role anon;
  update aigundem.sources set status = 'active';                        -- EXPECT: ERROR 42501
rollback;

begin;
  set local role anon;
  delete from aigundem.articles;                                        -- EXPECT: ERROR 42501
rollback;

begin;
  set local role anon;
  insert into aigundem.article_summaries
    (article_id, content_hash, prompt_version, model, summary_tr, translation_state)
  values (gen_random_uuid(), decode(repeat('ab', 32), 'hex'), 'v1', 'claude-opus-5',
          array['a', 'b', 'c'], 'not_required');                        -- EXPECT: ERROR 42501
rollback;

begin;
  set local role anon;
  insert into aigundem.digests (digest_date, window_start, window_end)
  values (current_date, now() - interval '1 day', now());               -- EXPECT: ERROR 42501
rollback;

begin;
  set local role anon;
  insert into aigundem.digest_items (digest_id, position, article_id, blurb_tr)
  values (gen_random_uuid(), 1, gen_random_uuid(), 'probe');            -- EXPECT: ERROR 42501
rollback;

-- 1.4  The `private` schema is unreachable for clients. EXPECT: ERROR 42501
--      (or 3F000 "schema private does not exist" if USAGE is what bites first).
begin;
  set local role anon;
  select * from private.ai_jobs;                                        -- EXPECT: ERROR
rollback;

begin;
  set local role anon;
  select * from private.ingestion_runs;                                 -- EXPECT: ERROR
rollback;

begin;
  set local role anon;
  select * from private.rate_limit_buckets;                             -- EXPECT: ERROR
rollback;

begin;
  set local role anon;
  select * from private.lease_due_sources(1);                           -- EXPECT: ERROR
rollback;

begin;
  set local role anon;
  select private.bump_rate_limit('probe', 'probe', now(), 1);           -- EXPECT: ERROR
rollback;

-- 1.5  The service_role-only wrappers in the exposed schema are still closed to
--      anon even though PostgREST advertises them. EXPECT: ERROR 42501.
begin;
  set local role anon;
  select * from aigundem.internal_lease_due_sources(1);                 -- EXPECT: ERROR 42501
rollback;

begin;
  set local role anon;
  select * from aigundem.internal_lease_ai_jobs(1);                     -- EXPECT: ERROR 42501
rollback;

begin;
  set local role anon;
  select aigundem.internal_bump_rate_limit('probe', 'probe', now(), 1); -- EXPECT: ERROR 42501
rollback;

-- 1.6  `authenticated` sees exactly what `anon` sees and writes nothing.
begin;
  set local role authenticated;
  select count(*) as feed_rows_visible_to_authenticated
    from aigundem.feed_articles_v1;                                     -- EXPECT: ok
rollback;

begin;
  set local role authenticated;
  insert into aigundem.articles
    (source_id, external_id, canonical_url, url_hash, title, category,
     published_at, content_hash)
  values (gen_random_uuid(), 'probe', 'https://example.com/a',
          decode(repeat('cd', 32), 'hex'), 'probe', 'Modeller', now(),
          decode(repeat('ef', 32), 'hex'));                             -- EXPECT: ERROR 42501
rollback;

reset role;

-- 1.7  Structural assertions (run as postgres). EXPECT the stated values.
--      a) RLS is enabled on every aigundem and private table.
select n.nspname, c.relname, c.relrowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('aigundem', 'private') and c.relkind = 'r'
order by 1, 2;                                    -- EXPECT: relrowsecurity = true for all 8

--      b) Only SELECT policies exist, only for anon/authenticated.
select schemaname, tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'aigundem'
order by tablename, policyname;                   -- EXPECT: 5 rows, cmd = SELECT

--      c) The feed view is security_invoker.
select c.relname, c.reloptions
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'aigundem' and c.relkind = 'v'; -- EXPECT: {security_invoker=true}

--      d) No write privilege reaches anon or authenticated anywhere.
select table_schema, table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema in ('aigundem', 'private')
  and grantee in ('anon', 'authenticated')
  and privilege_type <> 'SELECT'
order by 1, 2, 3;                                 -- EXPECT: 0 rows

--      e) Every SECURITY DEFINER function pins an empty search_path.
select n.nspname, p.proname, p.prosecdef, p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('aigundem', 'private')
order by 1, 2;                                    -- EXPECT: proconfig contains search_path=

--      f) PostgREST sees the new schema.
select rolname, rolconfig
from pg_roles
where rolname = 'authenticator';                  -- EXPECT: pgrst.db_schemas=public, aigundem

--      g) Nothing was created in `public`.
select count(*) as objects_created_in_public_today
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('sources', 'articles', 'article_summaries',
                    'digests', 'digest_items', 'ai_jobs',
                    'ingestion_runs', 'rate_limit_buckets'); -- EXPECT: 0

-- ===========================================================================
-- SECTION 2 — one-call automated sweep (same probes, PASS/FAIL table)
-- Run the whole section as a single statement batch; it rolls itself back.
-- ===========================================================================

begin;

create temporary table rls_probe_results (
  n           integer,
  probe       text,
  expectation text,
  outcome     text,
  detail      text
) on commit drop;

do $probe$
declare
  r record;
  v_ok boolean;
  v_detail text;
begin
  for r in
    select * from (values
      ( 1, 'anon', 'allow', 'anon select aigundem.sources',
           'select count(*) from aigundem.sources'),
      ( 2, 'anon', 'allow', 'anon select aigundem.articles',
           'select count(*) from aigundem.articles'),
      ( 3, 'anon', 'allow', 'anon select aigundem.article_summaries',
           'select count(*) from aigundem.article_summaries'),
      ( 4, 'anon', 'allow', 'anon select aigundem.digests',
           'select count(*) from aigundem.digests'),
      ( 5, 'anon', 'allow', 'anon select aigundem.digest_items',
           'select count(*) from aigundem.digest_items'),
      ( 6, 'anon', 'allow', 'anon select aigundem.feed_articles_v1',
           'select count(*) from aigundem.feed_articles_v1'),
      ( 7, 'anon', 'allow', 'anon call aigundem.search_articles_v1',
           'select count(*) from aigundem.search_articles_v1(''openai'')'),
      ( 8, 'anon', 'deny', 'anon insert aigundem.sources',
           'insert into aigundem.sources (slug, name, feed_url, feed_url_hash, language, category) values (''rls-probe'', ''RLS Probe'', ''https://example.com/feed.xml'', decode(repeat(''ab'', 32), ''hex''), ''en'', ''Modeller'')'),
      ( 9, 'anon', 'deny', 'anon update aigundem.sources',
           'update aigundem.sources set status = ''active'''),
      (10, 'anon', 'deny', 'anon delete aigundem.articles',
           'delete from aigundem.articles'),
      (11, 'anon', 'deny', 'anon insert aigundem.article_summaries',
           'insert into aigundem.article_summaries (article_id, content_hash, prompt_version, model, summary_tr, translation_state) values (gen_random_uuid(), decode(repeat(''ab'', 32), ''hex''), ''v1'', ''m'', array[''a'',''b'',''c''], ''not_required'')'),
      (12, 'anon', 'deny', 'anon insert aigundem.digests',
           'insert into aigundem.digests (digest_date, window_start, window_end) values (current_date, now() - interval ''1 day'', now())'),
      (13, 'anon', 'deny', 'anon insert aigundem.digest_items',
           'insert into aigundem.digest_items (digest_id, position, article_id, blurb_tr) values (gen_random_uuid(), 1, gen_random_uuid(), ''probe'')'),
      (14, 'anon', 'deny', 'anon select private.ai_jobs',
           'select count(*) from private.ai_jobs'),
      (15, 'anon', 'deny', 'anon select private.ingestion_runs',
           'select count(*) from private.ingestion_runs'),
      (16, 'anon', 'deny', 'anon select private.rate_limit_buckets',
           'select count(*) from private.rate_limit_buckets'),
      (17, 'anon', 'deny', 'anon call private.lease_due_sources',
           'select count(*) from private.lease_due_sources(1)'),
      (18, 'anon', 'deny', 'anon call private.bump_rate_limit',
           'select private.bump_rate_limit(''probe'', ''probe'', now(), 1)'),
      (19, 'anon', 'deny', 'anon call aigundem.internal_lease_due_sources',
           'select count(*) from aigundem.internal_lease_due_sources(1)'),
      (20, 'anon', 'deny', 'anon call aigundem.internal_lease_ai_jobs',
           'select count(*) from aigundem.internal_lease_ai_jobs(1)'),
      (21, 'anon', 'deny', 'anon call aigundem.internal_bump_rate_limit',
           'select aigundem.internal_bump_rate_limit(''probe'', ''probe'', now(), 1)'),
      (22, 'authenticated', 'allow', 'authenticated select aigundem.feed_articles_v1',
           'select count(*) from aigundem.feed_articles_v1'),
      (23, 'authenticated', 'deny', 'authenticated insert aigundem.articles',
           'insert into aigundem.articles (source_id, external_id, canonical_url, url_hash, title, category, published_at, content_hash) values (gen_random_uuid(), ''probe'', ''https://example.com/a'', decode(repeat(''cd'', 32), ''hex''), ''probe'', ''Modeller'', now(), decode(repeat(''ef'', 32), ''hex''))'),
      (24, 'authenticated', 'deny', 'authenticated select private.ai_jobs',
           'select count(*) from private.ai_jobs')
    ) as t(n, probe_role, expectation, probe_name, probe_sql)
    order by 1
  loop
    begin
      execute 'set local role ' || quote_ident(r.probe_role);
      execute r.probe_sql;
      v_ok := true;
      v_detail := 'statement executed';
    exception
      when others then
        v_ok := false;
        v_detail := sqlstate || ' ' || left(sqlerrm, 160);
    end;

    execute 'reset role';

    insert into rls_probe_results (n, probe, expectation, outcome, detail)
    values (
      r.n,
      r.probe_name,
      r.expectation,
      case when (r.expectation = 'allow') = v_ok then 'PASS' else 'FAIL' end,
      v_detail
    );
  end loop;
end;
$probe$;

reset role;

select * from rls_probe_results order by n;

-- Summary line: the only acceptable result is failures = 0.
select
  count(*) filter (where outcome = 'PASS') as passes,
  count(*) filter (where outcome = 'FAIL') as failures
from rls_probe_results;

rollback;
