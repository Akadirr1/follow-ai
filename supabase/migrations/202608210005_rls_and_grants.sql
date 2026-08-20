-- 202608210005_rls_and_grants.sql
-- AI Gündem v1 — row level security, privileges and the client read surface.
--
-- Model (addendum §A): v1 has no Supabase users. Identity is a device UUID held
-- on the device; the shared content tables are public by construction and are
-- read by the `anon` role (and by `authenticated`, so an account-bearing v1.1
-- client keeps working without a policy rewrite). There are NO client INSERT,
-- UPDATE or DELETE policies anywhere: every write goes through an Edge Function
-- running as `service_role`.
--
-- `private` is never API-exposed: all privileges are revoked from public, anon
-- and authenticated, RLS is enabled with no policies, and only the
-- SECURITY DEFINER helpers (owned by postgres, the table owner) reach it.

-- ===========================================================================
-- Schema usage
-- ===========================================================================
grant usage on schema aigundem to anon, authenticated, service_role;

revoke all on schema private from public;
revoke all on schema private from anon, authenticated;
-- service_role needs USAGE to EXECUTE the helpers that live in `private`; it
-- still receives no table privileges there.
grant usage on schema private to service_role;

-- ===========================================================================
-- Table privileges — start from nothing, then grant exactly what is needed.
-- ===========================================================================
revoke all on all tables in schema aigundem from public;
revoke all on all tables in schema aigundem from anon, authenticated;
revoke all on all tables in schema private from public;
revoke all on all tables in schema private from anon, authenticated;

-- Clients read; they never write.
grant select on aigundem.sources             to anon, authenticated;
grant select on aigundem.articles            to anon, authenticated;
grant select on aigundem.article_summaries   to anon, authenticated;
grant select on aigundem.digests             to anon, authenticated;
grant select on aigundem.digest_items        to anon, authenticated;
grant select on aigundem.feed_articles_v1    to anon, authenticated;

-- Edge Functions (service_role) own every write to shared content.
grant select, insert, update, delete on aigundem.sources           to service_role;
grant select, insert, update, delete on aigundem.articles          to service_role;
grant select, insert, update, delete on aigundem.article_summaries to service_role;
grant select, insert, update, delete on aigundem.digests           to service_role;
grant select, insert, update, delete on aigundem.digest_items      to service_role;
grant select on aigundem.feed_articles_v1 to service_role;

-- Migrations 006+ must repeat this revoke/grant pair for any table they add:
-- new tables do not inherit these privileges.

-- ===========================================================================
-- Function privileges — EXECUTE is granted to PUBLIC by default, so revoke
-- first. anon/authenticated get exactly one function: the search RPC.
-- ===========================================================================
revoke all on all functions in schema aigundem from public;
revoke all on all functions in schema aigundem from anon, authenticated;
revoke all on all functions in schema private from public;
revoke all on all functions in schema private from anon, authenticated;

grant execute on function aigundem.search_articles_v1(text, uuid[], integer)
  to anon, authenticated, service_role;

-- Internal helpers: service_role only, in both schemas.
grant execute on function private.lease_due_sources(integer) to service_role;
grant execute on function private.lease_ai_jobs(integer) to service_role;
grant execute on function private.bump_rate_limit(text, text, timestamptz, integer) to service_role;

grant execute on function aigundem.internal_lease_due_sources(integer) to service_role;
grant execute on function aigundem.internal_lease_ai_jobs(integer) to service_role;
grant execute on function aigundem.internal_bump_rate_limit(text, text, timestamptz, integer) to service_role;

-- ===========================================================================
-- Row level security
-- ===========================================================================
alter table aigundem.sources           enable row level security;
alter table aigundem.articles          enable row level security;
alter table aigundem.article_summaries enable row level security;
alter table aigundem.digests           enable row level security;
alter table aigundem.digest_items      enable row level security;

-- Defence in depth: these carry no grants and no policies, so they are closed
-- to every role except their owner and the SECURITY DEFINER helpers.
alter table private.ai_jobs            enable row level security;
alter table private.ingestion_runs     enable row level security;
alter table private.rate_limit_buckets enable row level security;

-- The feed view must never widen access; re-assert the property set at
-- creation time so an audit can read it from this migration alone.
alter view aigundem.feed_articles_v1 set (security_invoker = true);

-- ===========================================================================
-- Policies — SELECT only, for anon and authenticated.
-- ===========================================================================

-- Only sources that are actually being ingested are visible. Pending, paused
-- and failed sources stay hidden until sync-feeds validates them.
create policy sources_select_active
  on aigundem.sources
  for select
  to anon, authenticated
  using (status = 'active');

-- Articles and summaries are shared content with no ownership dimension
-- (addendum §A). The client's read path is aigundem.feed_articles_v1, which
-- additionally restricts to active sources and non-stale summaries.
create policy articles_select_shared
  on aigundem.articles
  for select
  to anon, authenticated
  using (true);

create policy article_summaries_select_shared
  on aigundem.article_summaries
  for select
  to anon, authenticated
  using (true);

-- A digest is invisible while it is being prepared or after it failed, so the
-- client can never render a partial digest as "today's".
create policy digests_select_ready
  on aigundem.digests
  for select
  to anon, authenticated
  using (status = 'ready');

create policy digest_items_select_ready_digest
  on aigundem.digest_items
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from aigundem.digests d
      where d.id = digest_items.digest_id
        and d.status = 'ready'
    )
  );

-- No INSERT, UPDATE or DELETE policy exists on any aigundem table, and no
-- write privilege is granted to anon or authenticated. Both gates are closed:
-- a future policy added by mistake still cannot write without a GRANT.

-- Reload PostgREST's schema cache so the new view, RPC and privileges are
-- visible immediately after this migration is applied.
notify pgrst, 'reload schema';
