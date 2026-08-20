-- 202608210007_public_read_shims_catalog.sql
-- AI Gündem v1 — TEMPORARY client read shims in `public` for the source
-- catalogue and digests (complements 0006, same reason: schema `aigundem` is not
-- exposed to PostgREST until the human adds it in the Dashboard).
--
-- Measured 2026-08-21 by P6 with the anon key: /rest/v1/sources → 404 PGRST205,
-- Accept-Profile: aigundem → 406 PGRST106. These views are security_invoker, so
-- the caller's RLS (active sources only; ready digests only) still applies.

create view public.aigundem_sources_v1
with (security_invoker = true) as
select
  id, slug, name, feed_url, site_url, language, category, is_default, status,
  last_success_at, created_at, updated_at
from aigundem.sources;

create view public.aigundem_digests_v1
with (security_invoker = true) as
select id, digest_date, timezone, status, headline, window_start, window_end,
       generated_at, created_at, updated_at
from aigundem.digests;

create view public.aigundem_digest_items_v1
with (security_invoker = true) as
select digest_id, position, article_id, blurb_tr, created_at
from aigundem.digest_items;

comment on view public.aigundem_sources_v1 is
  'TEMPORARY shim over aigundem.sources (RLS: active only) until schema aigundem is exposed to PostgREST.';
comment on view public.aigundem_digests_v1 is
  'TEMPORARY shim over aigundem.digests (RLS: ready only) until schema aigundem is exposed to PostgREST.';
comment on view public.aigundem_digest_items_v1 is
  'TEMPORARY shim over aigundem.digest_items (RLS: parent ready) until schema aigundem is exposed to PostgREST.';

revoke all on public.aigundem_sources_v1, public.aigundem_digests_v1, public.aigundem_digest_items_v1 from public;
grant select on public.aigundem_sources_v1, public.aigundem_digests_v1, public.aigundem_digest_items_v1
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
