-- 202608210006_public_read_shims.sql
-- AI Gündem v1 — TEMPORARY client read shims in `public`.
--
-- Why (measured 2026-08-21 by the coordinator while applying 0001):
--   `alter role authenticator set pgrst.db_schemas` → 42501, reserved role.
-- On hosted Supabase the PostgREST exposed-schemas list is a Dashboard /
-- Management API setting, so `aigundem` is not reachable through supabase-js
-- until the human adds it (Project Settings → API → Exposed schemas).
--
-- These two objects are namespaced `aigundem_*`, are the ONLY AI Gündem objects
-- in `public`, never touch the unrelated tables that already live there, and
-- widen nothing: the view is security_invoker and the function is security
-- invoker, so the caller's grants and RLS on the `aigundem` base tables apply.
-- Once `aigundem` is exposed, clients switch to `.schema('aigundem')` and a
-- later migration drops both shims.

create view public.aigundem_feed_articles_v1
with (security_invoker = true) as
select * from aigundem.feed_articles_v1;

comment on view public.aigundem_feed_articles_v1 is
  'TEMPORARY shim over aigundem.feed_articles_v1 until schema aigundem is exposed to PostgREST. security_invoker.';

create function public.aigundem_search_articles_v1(
  q          text,
  source_ids uuid[] default null,
  lim        integer default 20
)
returns setof public.aigundem_feed_articles_v1
language sql
stable
set search_path = ''
as $fn$
  select * from aigundem.search_articles_v1(q, source_ids, lim);
$fn$;

comment on function public.aigundem_search_articles_v1(text, uuid[], integer) is
  'TEMPORARY shim over aigundem.search_articles_v1 until schema aigundem is exposed to PostgREST.';

revoke all on public.aigundem_feed_articles_v1 from public;
grant select on public.aigundem_feed_articles_v1 to anon, authenticated, service_role;

revoke all on function public.aigundem_search_articles_v1(text, uuid[], integer) from public;
grant execute on function public.aigundem_search_articles_v1(text, uuid[], integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
