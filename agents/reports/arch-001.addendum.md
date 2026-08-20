# arch-001 addendum — coordinator reconciliation against measured facts (2026-08-21)

`arch-001.md` was written before three facts were measured (see
`facts-2026-08-21.md`). This addendum is **authoritative where it conflicts** with
arch-001; everything else in arch-001 stands. Each change is the *smaller* system,
per `agents/architect.md`.

## A. No anonymous auth in v1 → user state is device-local
**Measured:** Supabase anonymous sign-in is a Dashboard toggle; it cannot be enabled
from this machine tonight and the human is asleep.
**Change:** v1 does not create Supabase users. Identity is a device UUID generated
once and stored in `expo-sqlite/kv-store` (`device_id`). All *user* state — enabled
sources, saved/read flags, theme, auto-translate, digest time/enabled, onboarding
done, recent searches — lives on-device only (SQLite KV / persisted TanStack cache).
**Dropped from v1 migrations:** `user_sources`, `user_article_state`,
`user_settings`, `complete_onboarding()` RPC and their RLS. Keep their design in
arch-001 §2 as the v1.1 "accounts" plan; do not create them now.
**Consequence:** shared tables are readable by the **`anon`** role (the content is
public by construction). Grant `anon` and `authenticated` SELECT on
`aigundem.sources` (active), `aigundem.articles`, `aigundem.article_summaries`,
ready `aigundem.digests`/`digest_items`, the versioned view and search RPC. No
client writes anywhere; no `private.*` access.
**Custom sources:** `add-source` still creates the *shared* source row (public feeds
only, same SSRF rules); the device's subscription to it is local. Rate limiting uses
`X-Device-Id` (uuid v4, validated) in `private.rate_limit_buckets`.

## B. Schema isolation → `aigundem` + `private`, never `public`
**Measured:** `public` holds another app's 9 tables (RLS disabled, 0 rows). They are
out of scope and must not be touched, listed, or fixed by any task.
**Change:** all content tables, view and RPC live in schema **`aigundem`**; internal
job/rate/audit tables in schema **`private`**. Expose `aigundem` to PostgREST in the
migration: `ALTER ROLE authenticator SET pgrst.db_schemas = 'public, aigundem';`
followed by `NOTIFY pgrst, 'reload config';` (keep `public` listed so the other app
keeps working). Client queries pass `.schema('aigundem')`. Edge Functions use
schema-qualified names. Migration file names keep arch-001's numbering.

## C. Deploy path → coordinator via Supabase MCP; tests in Node
**Measured:** no Supabase CLI token, Docker daemon off, no Deno.
**Change:** migrations are plain SQL files under `supabase/migrations/`; the
coordinator applies them in order with `apply_migration` and deploys functions with
`deploy_edge_function` (file sets: `index.ts`, `deno.json`, `_shared/*`). Implementers
never deploy. Pure logic (URL safety, feed parsing, dedupe, prompt building, JSON
schema validation, rate-limit math) lives in `supabase/functions/_shared/*.ts`
written in portable TypeScript (no `Deno.*` globals; Web APIs only) and is
unit-tested with Jest from the repo root (add a second Jest project or a
`testMatch` entry — implementer's choice, must not slow the store suite). Deno-only
glue (`Deno.serve`, `Deno.env`) stays in each function's `index.ts` and is exercised
by the coordinator's **remote smoke** after deploy (`curl` against the deployed
function) and by the verifier. RLS is verified remotely by the coordinator/verifier
with `execute_sql` using `set local role anon;` probes — not pgTAP/Docker.
Cron jobs are created by migration 007 but **left unscheduled/disabled** until the
coordinator's remote smoke of `sync-feeds` passes; enabling is a coordinator step.

### C.1 Database access from Edge Functions (decided 2026-08-21 ~04:15, supersedes interim notes)
**Measured:** `ALTER ROLE authenticator` is superuser-only on hosted Supabase
(42501), so schema `aigundem` is **not** exposed to PostgREST until the human sets
it in the Dashboard. PostgREST exposure is server config; `service_role` does not
bypass it.
**Decision:** Edge Functions keep using `supabase-js` with the service-role key,
but every DB access goes through namespaced objects in `public`:
- reads: the `public.aigundem_*_v1` security-invoker shims (0006, 0007);
- writes/leases/rate-limits: `public.aigundem_internal_*` SECURITY DEFINER
  wrappers (`set search_path = ''`, schema-qualified, argument-validated,
  EXECUTE to `service_role` only, revoked from public/anon/authenticated) —
  P3 owns `202608210006_internal_wrappers.sql`; P4/P5 add the wrappers they
  need in their own migrations following the same rules.
Routing is env-configurable (`AIGUNDEM_RPC_SCHEMA`/`AIGUNDEM_RPC_PREFIX`, default
`public` + `aigundem_`) so that, once the human exposes `aigundem`, the switch
is configuration, not code. Migration numbering: three files share prefix
`202608210006` (shims, internal wrappers, seed) and `0007` is the catalog shims;
**P5 cron is `202608210008`**. Migrations are applied by the coordinator by name.

## D. Anthropic has no first-party feed → 6 default sources in v1
**Measured:** all Anthropic feed candidates 404/403; `/news` advertises no feed.
**Change (arch-001 §3 rule applied):** no scraping, no mirror. Seed migration 006
ships **six** defaults with the measured URLs (facts file). UI counts become dynamic
("N kaynak"); the Anthropic tile disappears from defaults. Re-add when a first-party
feed exists or the human approves an HTML-listing source type.

## E. No Anthropic key until after v1 → pending states are first-class
`process-enrichments` returns immediately with `{skipped:'no_api_key'}` when
`ANTHROPIC_API_KEY` is unset and logs one warning per run; jobs stay `queued`.
`request-enrichment` returns `202 {status:'queued', reason:'no_api_key'}`. Client
renders "Özet hazırlanıyor" with the article body/excerpt still readable and the
Orijinal/Çeviri segment disabled until `translation_state=ready`. Digest `finalize`
stays `preparing` when blurbs are missing; Digest tab shows "Digest hazırlanıyor".
Claude path is tested only with a fake client; live Claude = **not verified** in v1.

## F. Keys
Client uses the project URL and the **legacy `anon` JWT** (not `sb_publishable_…`)
because Edge Functions with `verify_jwt=true` require a JWT bearer. Both are public
by design. They are non-secret config: `EXPO_PUBLIC_SUPABASE_URL`,
`EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_DATA_MODE=mock|supabase`.
`scripts/setup-env.ps1` gains these three (non-secret, plain prompts with defaults).

## G. Task DAG — unchanged order, adjusted content
P1 seam · P2 DB (schemas `aigundem`/`private`, no user tables, anon SELECT) · P3
feeds (6 sources, measured URLs, portable `_shared` + Jest) · P4 AI (fake client,
no-key path) · P5 digest+cron (jobs created disabled) · P6 client data (device id,
SQLite KV, Query persistence, **no auth**) · P7 screens · P8 themes · P9
onboarding+notifications · P10 integration gate. Two lanes run in parallel: client
(P1→P8→P6→P7→P9) and server (P2→P3→P4→P5); P10 joins them. Coordinator deploy +
remote smoke steps sit after P2, P3, P4, P5.
