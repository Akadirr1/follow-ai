-- 202608210001_extensions_and_types.sql
-- AI Gündem v1 — schemas, extensions, shared domains and the updated_at helper.
--
-- Scope rules for every migration in this series (arch-001 §2, addendum §B):
--   * All content objects live in schema `aigundem`; internal job/rate/audit
--     objects live in schema `private`.
--   * Nothing is created in, moved to, or dropped from `public`. `public` holds
--     an unrelated application and is out of scope.
--   * Applied migrations are immutable; corrections ship as later migrations.

create schema if not exists aigundem;
create schema if not exists private;

-- pgcrypto is already installed on this project (facts-2026-08-21); the guard
-- keeps the migration replayable on a fresh project. Supabase keeps extensions
-- in the `extensions` schema.
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Domains
--
-- arch-001 §2 specifies these value sets as CHECK constraints. They are shared
-- by several tables, so they are declared once as domains: the constraint text
-- lives in exactly one place and every column that uses the domain inherits it.
-- ---------------------------------------------------------------------------

-- Source/feed language. Articles may additionally be 'und' (undetermined).
create domain aigundem.language_code as text
  constraint language_code_check check (value in ('en', 'tr'));

create domain aigundem.article_language as text
  constraint article_language_check check (value in ('en', 'tr', 'und'));

-- The five existing non-`Tümü` categories of the shipped UI. `Tümü` is a client
-- side filter, never a stored value.
create domain aigundem.category as text
  constraint category_check check (
    value in ('Modeller', 'Araştırma', 'Ürün', 'Açık Kaynak', 'Türkiye')
  );

create domain aigundem.source_status as text
  constraint source_status_check check (
    value in ('pending', 'active', 'paused', 'failed')
  );

create domain aigundem.content_quality as text
  constraint content_quality_check check (value in ('full', 'excerpt'));

-- 'ready'        → translation_tr holds a Turkish translation of a non-TR article
-- 'not_required' → article is already Turkish; translation_tr is NULL
create domain aigundem.translation_state as text
  constraint translation_state_check check (value in ('ready', 'not_required'));

create domain aigundem.digest_status as text
  constraint digest_status_check check (
    value in ('preparing', 'ready', 'failed')
  );

create domain private.job_status as text
  constraint job_status_check check (
    value in ('queued', 'leased', 'ready', 'failed')
  );

-- ---------------------------------------------------------------------------
-- Shared trigger helper
--
-- Lives in `private` so it is never reachable through PostgREST. Trigger
-- functions are not exposed by PostgREST in any case; the placement is
-- defence in depth. EXECUTE on trigger functions is checked when the trigger is
-- created, not when it fires, so the revokes in migration 0005 do not disarm it.
-- ---------------------------------------------------------------------------

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function private.set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at. Internal; not an API surface.';

-- ---------------------------------------------------------------------------
-- Exposing `aigundem` to PostgREST (addendum §B) — NOT done here.
--
-- Measured 2026-08-21 while applying this migration on the hosted project:
--   ALTER ROLE authenticator SET pgrst.db_schemas ...  → 42501
--   "authenticator" is a reserved role, only superusers can modify it
-- On hosted Supabase the exposed-schemas list is a Dashboard / Management API
-- setting. Until the human sets it (Project Settings → API → Exposed schemas:
-- add `aigundem`), client reads use the namespaced shims in
-- 202608210006_public_read_shims.sql and Edge Functions reach `aigundem` and
-- `private` directly over SUPABASE_DB_URL (no PostgREST).
-- ---------------------------------------------------------------------------
