-- 202608210003_user_state.sql
-- AI Gündem v1 — intentionally creates no user-state tables.
--
-- arch-001 §2 originally placed `user_sources`, `user_article_state`,
-- `user_settings` and the `complete_onboarding()` RPC here. The coordinator's
-- addendum §A supersedes that for v1:
--
--   Supabase anonymous sign-in is a Dashboard toggle that could not be enabled,
--   so v1 creates no Supabase users at all. Identity is a device UUID stored in
--   `expo-sqlite/kv-store`, and ALL user state — enabled sources, saved/read
--   flags, theme, auto-translate, digest time/enabled, onboarding completion,
--   recent searches — lives on the device only. Nothing about a user is sent to
--   or stored in Postgres. Shared content tables are therefore readable by the
--   `anon` role and carry no ownership column and no per-user policies.
--
-- The v1.1 "accounts" design is preserved unchanged in arch-001 §2; when
-- anonymous (or real) auth is enabled, those tables arrive in a later
-- migration with `user_id -> auth.users` ownership policies. Applied migrations
-- are immutable, so this file stays in place to keep the 0001-0007 numbering
-- stable and to record why the gap exists.
--
-- The single statement below is documentation only: it creates no object and
-- changes no data, and it keeps this migration from being an empty script that
-- some appliers reject.

comment on schema aigundem is
  'AI Gündem shared content (sources, articles, summaries, digests). Read-only for anon/authenticated; all writes go through Edge Functions running as service_role. v1 stores no user state here — see migration 202608210003 and arch-001 addendum section A.';
