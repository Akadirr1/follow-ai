# arch-001 — Production v1 architecture for AI Gündem

**Status:** proposed · **Date:** 2026-08-21 · **Project:** Supabase
`eglxzbsrewbleqlstefd` (`eu-west-1`, Postgres 17) · **Scope:** architecture only.

Evidence labels: **measured** means supplied by the brief/current graph or checked
against primary documentation; **inferred** means a design decision or static
consequence; **needs measurement** names the observation required. Unless a target
design statement says otherwise, it is an **inferred design decision**, not a claim
about the current repository or restored Supabase project.

## 1. Target architecture — one page

```text
Expo SDK 54 app
  routes/components ── ephemeral UiStore (no durable entities)
          │
          ├── repositories ── TanStack Query ── Supabase JS + anonymous JWT
          │                         │
          │                         └── persisted cache/mutations
          │                              (expo-sqlite native; web adapter for export)
          ├── ThemeProvider ── local preference + system color scheme
          └── NotificationService ── one local daily schedule
                                      (no push token, no background fetch)
                                  │
Supabase boundary                 ▼
  Auth: anonymous user UUID (later linkable)
  PostgREST/RPC: shared feed reads + own user-state reads/writes under RLS
  Edge Functions: feed/network parsing, URL validation, Claude, digest orchestration
  Postgres: canonical articles, shared summaries/translations, user state, job/cache
  pg_cron + pg_net + Vault: ingestion, AI queue, morning digest
```

- **Measured decision:** only Supabase URL and publishable key enter the app;
  `ANTHROPIC_API_KEY`, service/secret keys, and cron credentials stay server-side.
- **Inferred boundary:** the client reads shared content directly under RLS and calls
  Edge Functions only for privileged/costly transitions. This is smaller than an API
  facade over every read and preserves Supabase pagination/caching.
- **Inferred boundary:** all seven defaults and user-added feeds are public HTTPS
  resources, deduplicated into one shared source catalog. Private/authenticated feeds,
  cookies, custom headers, intranet URLs, and per-user private articles are forbidden
  in v1; otherwise “articles/summaries are shared” would leak private content.
- **Inferred digest scope:** one global Turkish digest for the Istanbul editorial day,
  drawn from the seven default sources. It is not per-user or custom-source-specific;
  that smaller shared artifact satisfies the singular morning-digest decision without
  one Claude pipeline per anonymous device.
- **Inferred compatibility seam:** `FeedRepository` has `mock` and `supabase`
  implementations selected by non-secret `EXPO_PUBLIC_DATA_MODE=mock|supabase`.
  Mock remains the default until schema/functions are verified; screens never import
  `src/data/*.ts` or Supabase directly.

Ownership is singular: Postgres owns durable truth; TanStack Query owns server-state
lifecycle; SQLite owns the last usable local snapshot and paused mutations; route or
component state owns transient controls; `NotificationService` alone owns OS schedules.

## 2. Postgres schema, migrations, indexes, and RLS

### Migration files (in this order)

1. `supabase/migrations/202608210001_extensions_and_types.sql`
2. `supabase/migrations/202608210002_content.sql`
3. `supabase/migrations/202608210003_user_state.sql`
4. `supabase/migrations/202608210004_jobs_and_rpc.sql`
5. `supabase/migrations/202608210005_rls_and_grants.sql`
6. `supabase/migrations/202608210006_seed_default_sources.sql`
7. `supabase/migrations/202608210007_cron.sql`

Applied migrations are immutable. Corrections use a later compensating migration;
`db reset` is local-only and is forbidden against the linked production project.

### Tables and keys

| Table | Core columns and constraints | Required indexes |
|---|---|---|
| `sources` | `id uuid PK`, `slug text`, `name`, `feed_url`, `feed_url_hash bytea UNIQUE`, `site_url`, `language check(en,tr)`, `category` restricted to the existing five non-`Tümü` values, `is_default bool`, `status check(pending,active,paused,failed)`, `etag`, `last_modified`, `next_fetch_at`, `last_fetched_at`, failure counters/timestamps | unique `slug` for defaults; `(status,next_fetch_at)`; GIN name `search_tsv` |
| `articles` | `id uuid PK`, `source_id FK`, `external_id text`, `canonical_url`, `url_hash bytea`, `title`, `author`, `category` inherited from source, `published_at`, `fetched_at`, `language check(en,tr,und)`, `content_text`, `content_quality check(full,excerpt)`, `content_hash bytea`, `excerpt`, timestamps | unique `(source_id,external_id)`; unique `url_hash`; `(published_at DESC,id DESC)`; `(source_id,published_at DESC,id DESC)`; GIN title/category `search_tsv` using `simple` config |
| `article_summaries` | `article_id PK/FK`, `content_hash`, `prompt_version`, `model`, `summary_tr text[] check(cardinality=3)`, `translation_tr text NULL`, `translation_state check(ready,not_required)`, `generated_at`; Turkish rows require `translation_tr IS NULL/not_required` | cache lookup `(article_id,content_hash,prompt_version,model)` |
| `user_sources` | `(user_id,source_id) PK`, `enabled`, timestamps; `user_id -> auth.users`, `source_id -> sources` | partial `(user_id,source_id) WHERE enabled` |
| `user_article_state` | `(user_id,article_id) PK`, nullable `saved_at`, nullable `read_at`, `updated_at`; delete row when both states are null | partial `(user_id,saved_at DESC) WHERE saved_at IS NOT NULL`; partial unread/saved index |
| `user_settings` | `user_id PK`, `theme check(dark,light,system)`, `auto_translate`, `digest_enabled`, `digest_time time` restricted to five slots, `timezone` IANA text, `onboarding_completed_at`, timestamps | PK only |
| `digests` | `id uuid PK`, `digest_date date UNIQUE`, `timezone='Europe/Istanbul'`, `status check(preparing,ready,failed)`, `headline`, window timestamps, generated timestamp | unique date; `(status,digest_date DESC)` |
| `digest_items` | `(digest_id,position) PK`, `article_id FK`, `blurb_tr`, check position 1–5, unique `(digest_id,article_id)` | `article_id` |
| internal job/audit tables | `ai_jobs` unique `(article_id,content_hash,prompt_version,model)` with status/attempt/lease; `ingestion_runs`; `rate_limit_buckets(subject,action,window_start,count)` | AI `(status,available_at)`; runs by start; rate-limit composite PK |

`feed_articles_v1` is a `security_invoker=true` view joining active sources,
articles, and only summaries whose `content_hash` still matches the article. Feed pagination is keyset `(published_at,id)`, never
offset. `search_articles_v1(q,source_ids,limit)` uses `websearch_to_tsquery('simple',
q)` and the GIN index; shared content means source IDs are preference filtering, not
an authorization boundary.

Feed ingestion canonicalizes URLs, caps stored URL length, hashes the normalized URL,
and upserts on `(source_id,external_id)`. A changed `content_hash` invalidates the
current summary by cache-key mismatch and enqueues a new job; unchanged items do not
re-call Claude. One malformed source/item cannot roll back other sources/items.

### RLS and grants

**Measured:** Supabase anonymous sign-in users assume Postgres role `authenticated`,
carry a unique `auth.uid()`, and can later link an identity. Policies therefore use
ownership, not `is_anonymous`, so an upgraded identity retains rows.

- Enable RLS on every exposed `public` table. Grant `authenticated` SELECT only on
  `sources`, `articles`, `article_summaries`, ready `digests`/`digest_items`, and the
  versioned view/RPC. Give `anon` no table access; the publishable key alone is not a
  device identity.
- Shared-table SELECT policies: active default sources plus custom sources present in
  the caller's `user_sources`; shared articles/summaries; and only digests whose parent
  is `ready`. There are no client INSERT, UPDATE, or DELETE policies for shared content.
- For `user_sources`, `user_article_state`, and `user_settings`, every SELECT/INSERT/
  UPDATE/DELETE policy is `TO authenticated USING ((select auth.uid())=user_id)
  WITH CHECK ((select auth.uid())=user_id)`. Subscription insert also requires an
  existing active source. Client mutations use explicit desired values, not toggles.
- Internal job/rate/audit tables live in schema `private`, are not API-exposed, and
  have all public/anon/authenticated privileges revoked. Narrow `SECURITY DEFINER`
  RPCs schema-qualify every object, set `search_path=''`, validate arguments, and are
  executable only by `service_role`, except `complete_onboarding(uuid[],text)` which
  is granted to authenticated users and derives its user ID from `auth.uid()`.
- Edge user endpoints verify the user JWT, derive the subject server-side, and use an
  RLS-scoped client for user rows. Admin clients are limited to the exact shared/job
  operation; no user-supplied `user_id` is accepted.

RLS tests must create two anonymous JWT identities and prove cross-user SELECT/INSERT/
UPDATE/DELETE fail, shared SELECT succeeds, direct shared writes fail, internal tables
are inaccessible, and security-definer RPCs cannot be used to widen ownership.

### pg_cron lifecycle

`202608210007_cron.sql` enables `pg_cron`/`pg_net` and creates idempotently named jobs:

- `ai-gundem-ingest`: `*/15 * * * *` → `sync-feeds` with bounded source count.
- `ai-gundem-ai-worker`: `*/2 * * * *` → `process-enrichments` with max three jobs.
- `ai-gundem-digest-prepare`: `45 2 * * *` UTC (05:45 Istanbul) → prepare candidates.
- `ai-gundem-digest-finalize`: `30,40,50 3 * * *` UTC → idempotent finalize/retry,
  leaving at least ten minutes before the earliest 07:00 Istanbul notification.

Project URL and a named `automations` secret key are inserted into Vault by an
authorized setup step, never as migration literals. Each function records request/run
IDs and bounded error details; cron run history plus application run tables are the
operational signal. **Needs measurement:** restore the project, confirm extensions,
timezone interpretation, Vault key mode, job duration, and that the first complete
digest is ready before 06:50 Europe/Istanbul.

## 3. Edge Function contracts

All endpoints accept/return JSON UTF-8, reject unknown top-level fields, cap body size,
use `request_id` UUIDs, and return errors as
`{error:{code,message,retryable,request_id},retry_after_seconds?}`. Logs never contain
article bodies, tokens, keys, or full user URLs. Internal calls authenticate with the
named secret/service role; user calls require an anonymous session JWT.

| Function | Trigger/auth | Request → success | Idempotency/cache/rate |
|---|---|---|---|
| `sync-feeds` | cron/manual; internal secret only | `{source_id?:uuid,max_sources?:1..20}` → `{run_id,sources_ok,sources_failed,inserted,updated,unchanged}` | leases due sources with `SKIP LOCKED`; ETag/Last-Modified; article unique keys; no device rate, max concurrency 4 and 20 sources/run |
| `add-source` | client HTTP; user JWT | `{url,category,language:'en'|'tr',client_request_id}` → `201 {source,subscription}` or `200` existing; category is one of the existing five and feed supplies the display name | request UUID + normalized URL hash; inferred initial limit 5 attempts/device/24h; timeout 8s, response ≤1 MiB |
| `request-enrichment` | client HTTP; user JWT | `{article_id,client_request_id}` → `200 {status:'ready',summary}` or `202 {status:'queued',poll_after_seconds}` | summary cache key; one job per cache key; 120 cached checks/hour and 30 new misses/device/24h (tunable) |
| `process-enrichments` | cron/manual; internal secret only | `{max_jobs?:1..3}` → counts `{ready,retried,failed}` | leased job; max attempts/backoff; unique cache key prevents duplicate Claude calls; global daily cap must be configured before production |
| `build-digest` | cron/manual; internal secret only | `{digest_date?:YYYY-MM-DD,phase:'prepare'|'finalize'}` → `{date,status,item_count,missing_enrichments}` | unique digest date; deterministic rank and positions; finalize is no-op once ready |

`add-source` permits only public `https:` URLs, default/443 port, no credentials or
fragment, at most three manual redirects, and revalidates every redirect. It rejects IP
literals and DNS answers in loopback, private, link-local, carrier-grade NAT,
documentation, multicast, reserved, and IPv6 local ranges; it applies DNS resolution
before fetch, fixed time/byte limits, XML content checks, and no cookies/custom headers.
For a public page URL it may discover one RSS/Atom `<link rel="alternate">`, then
validates that target identically. DNS rebinding remains a residual risk; fetch-time
destination enforcement must be tested, and private/authenticated feeds stay forbidden.

`sync-feeds` parses RSS/Atom with a pinned library, sanitizes HTML, and uses feed content
when full. If only an excerpt exists, a separately guarded public article fetch may
extract reader text; `content_quality` remains `excerpt` if it cannot. Claude is never
asked to pretend an excerpt is a full translation.

`process-enrichments` uses pinned `npm:@anthropic-ai/sdk`, model
`Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-opus-5'`, and structured JSON schema via
`output_config.format` for exactly `{summary:[string,string,string],translation:string|null}`.
The stable system prompt is first and marked `cache_control`; adaptive thinking gets no
`budget_tokens`. Article text is length-limited untrusted data in a delimited user block,
with instructions to ignore embedded commands and no tools/URL access. English/unknown
content receives Turkish summary + translation; Turkish receives summary and
`translation=null/not_required`. SDK/network/schema failures use bounded retry with
jitter; auth/validation/content failures do not retry.

Candidate source endpoints — all **needs measurement** before seeding (GET/redirect,
valid RSS/Atom, language, newest item/date/count, full-text availability, GUID stability,
ETag behavior, terms/robots):

| Source | Candidate |
|---|---|
| OpenAI Blog | `https://openai.com/news/rss.xml` |
| Anthropic | `https://www.anthropic.com/news/rss.xml`; fallback discovery from `https://www.anthropic.com/news` (no third-party feed without approval) |
| Google DeepMind | `https://deepmind.google/blog/rss.xml` |
| Hugging Face | `https://huggingface.co/blog/feed.xml` (measure GUID-as-link compatibility) |
| arXiv cs.AI | `https://export.arxiv.org/rss/cs.AI` |
| TechCrunch AI | `https://techcrunch.com/category/artificial-intelligence/feed/` |
| Webrazzi AI | `https://webrazzi.com/kategori/yapay-zeka/feed/`; fallback `https://webrazzi.com/feed/` with measured AI filtering |

If an official/first-party endpoint cannot satisfy the contract, the validator task
must escalate; it must not silently add scraping or a community mirror.

## 4. Client architecture and current-store migration

### Data and persistence

- Use `@tanstack/react-query`, `@tanstack/react-query-persist-client`, and the async
  storage persister. Queries own feed/pages/article/summary/digest/source/settings;
  explicit idempotent mutations own saved/read/source/settings transitions.
- Native storage is `expo-sqlite` (SDK-54 compatible version) via
  `expo-sqlite/kv-store` for Supabase session, query cache, theme, notification ID, and
  cache buster. It is Expo-supported, restart-persistent, and supplies an AsyncStorage-
  compatible API without another store. MMKV adds a native dependency for speed not
  measured as necessary; AsyncStorage cannot also support later relational/offline
  inspection. Web uses a separate localStorage/in-memory adapter because Expo SQLite
  web is alpha and must not endanger static export.
- `PersistQueryClientProvider` restores before fetching, persists only versioned safe
  query keys, retains the last 200 articles/details plus latest digest for seven days,
  and resumes paused **set-value** mutations after auth/network recovery. Cache buster
  includes schema/app version; logout/identity replacement clears user-scoped keys.
  Those size/age defaults are inferred and need device storage/startup measurement.
- Supabase client persists the anonymous session in the same adapter, disables URL
  session detection, and starts/stops token auto-refresh with React Native `AppState`.
  Offline return renders cache immediately; stale/error state is visible. First-ever
  offline launch can show bundled onboarding/default sources but cannot claim a real
  feed until identity/network exists.

Repository contracts are versioned (`FeedRepository`, `UserStateRepository`,
`DigestRepository`) and return domain DTOs, not Supabase rows. Screens use query hooks;
only `supabaseRepository` knows table/RPC/Edge names. Pagination ordering is stable,
mutations include a client UUID, and all retries set desired state (`saved=true`), never
repeat a toggle.

### Exact disposition of current store contract

| Current field/action | Disposition and new owner |
|---|---|
| `filter` / `setFilter` | **rename** `feedFilter` / `setFeedFilter`; ephemeral `UiStore`, session-only |
| `saved`, `read` | **delete** maps; TanStack queries over `user_article_state`, persisted/optimistic |
| `toggleSave`, `deleteSaved` | **replace** with idempotent `setSaved(articleId,boolean,mutationId)` |
| `openArticle{id,markRead}` | **delete**; route ID owns selection, guarded navigation helper prevents double-push, explicit `markRead(articleId,true)` mutation |
| `srcOn`, `toggleSource` | **delete/replace** with `user_sources` query and `setSourceEnabled(id,boolean,mutationId)` |
| `artId` | **delete**; expo-router `[id]` is sole owner |
| `seg`, `setSeg` | **delete globally**; article route-local `articleSegment`, reset to `tr` on route ID; TR source hides/disables translation segment |
| `sheet,tmpTime`, open/close/pick/save actions | **delete globally**; `DigestTimeSheet` owns open + draft, settings mutation commits validated slot |
| `digestTime` | **delete**; `user_settings` query + persisted notification preference |
| `q`, `setQuery`, `clearQuery` | **delete globally**; search route-local state; recent searches persist separately |
| `translate`, `toggleTranslate` | **delete/replace** with `auto_translate` query and explicit `setAutoTranslate(boolean)` |
| `toast`,`toastSeq`,`toast`,`clearToast` | **replace** by local `{id,text}` plus `showToast`/`dismissToast(id)`; no durable persistence |

`TOASTS.theme` is deleted. Theme choices perform real state changes through
`ThemeProvider`: `dark`, `light`, or `system`; `system` resolves with `useColorScheme`.
Split `src/theme/tokens.ts` into semantic `palettes.ts` (existing dark + exact light
palette `#F4F6FB/#0F1B33/#FFFFFF/#D8E0F0/#E7EEFB/#2563EB`) and invariant typography/
spacing. Set app user interface style to automatic; status/navigation surfaces consume
resolved theme. Load the local preference before first painted app frame, apply locally
immediately, then sync `user_settings`.

### Notifications and onboarding lifecycle

`NotificationService` uses `expo-notifications`; no push token/server push/background
fetch. First enable creates the Android channel before permission, requests permission
only after an explanatory UI, and handles iOS authorized/provisional/ephemeral/denied
states. Denial preserves digest time but leaves `digest_enabled=false` and offers OS
settings guidance.

To change time, validate one of 07:00/07:30/08:00/08:30/09:00, schedule the new repeating
local calendar notification first, persist its identifier/time, then cancel the old ID.
On launch/foreground/timezone change, reconcile `getAllScheduledNotificationsAsync()` to
exactly one owned schedule. If new scheduling fails, keep the old schedule and surface an
error; DB sync does not claim notifications are enabled until local scheduling succeeds.

**Measured platform constraint:** Android 12+ exact alarms need
`SCHEDULE_EXACT_ALARM`; Android 13 permission prompting depends on a channel. **Needs
measurement:** real devices across Android 12–14 and iOS, reboot, timezone/DST change,
battery optimization, denied/provisional permission, and store-review justification.

Root bootstrap order is: local theme/cache → Supabase session restore or online
`signInAnonymously()` → Query restore → onboarding guard → tabs. `/onboarding` shows the
seven verified defaults, requires at least one selection, and calls atomic
`complete_onboarding`; only success sets completion and enters tabs. Back/restart cannot
bypass incomplete onboarding. Anonymous auth should use CAPTCHA/Turnstile if a viable
mobile flow is measured; per-device limits alone are bypassable by creating identities.

## 5. Implementer task DAG (10 bounded tasks)

Every task must leave `npm run typecheck`, `npm test -- --runInBand`, and
`npx expo export --platform web` green. No task commits/deploys/links a project without
separate authorization. “Rollback” means revert only its allowed files; an applied DB
change gets a forward compensating migration.

| ID / size / deps | Goal; allowed paths (≤12 files); forbidden; measurable acceptance; rollback |
|---|---|
| P1 seam / M / — | Add domain DTOs, repository interfaces, env validation, mock adapter and `EXPO_PUBLIC_DATA_MODE` defaulting mock. Allow `src/data-access/**`, `src/config/**`, `.env.example`, `scripts/setup-env.ps1`, package files/tests. Forbid screens/backend/secrets. Acceptance: common three commands + adapter contract tests; bundle scan has no secret names/values. Rollback seam/package additions. |
| P2 DB / L / — | Create migrations 001–005 + pgTAP RLS tests. Allow `supabase/config.toml`, five migrations, `supabase/tests/database/**`. Forbid app/functions/seed/cron/deploy. Acceptance with Docker: `npx supabase@2.115.0 db reset`, `db lint`, `test db`, then common commands; two-user isolation suite passes. Rollback un-applied files or compensating migration. |
| P3 feeds / L / P2 | Measure seven candidates first; only then create seed migration 006 and implement shared URL safety/parser plus `sync-feeds` and `add-source`. Allow migration 006, those two function dirs, `_shared/{auth,error,url-safety,feed}.ts`, function tests/deno config (≤12). Forbid Claude/client/other migrations. Acceptance: measured source matrix, fixtures RSS+Atom, redirects/size/timeouts/dedupe, SSRF matrix, partial-source failure; local `functions serve` smoke; common commands. Rollback un-applied seed/functions; disable cron if later wired. |
| P4 AI / L / P2 | Implement `request-enrichment`, `process-enrichments`, prompt/schema/SDK adapter and job tests. Allow two dirs + `_shared/{anthropic,prompt,schemas,rate-limit,error}.ts` and tests/config. Forbid client key/raw Anthropic fetch/digest/screens. Acceptance: mocked SDK validates 3 bullets, TR no-translation, cache/idempotency/concurrency/retry/rate/cap/prompt-injection; local serve; common commands. Rollback functions and disable worker invocation. |
| P5 digest+cron / M / P3,P4 | Implement prepare/finalize, migration 007, run observability. Allow `build-digest/**`, migration 007, digest tests, at most one shared ranker. Forbid client/personalization/secrets in SQL. Acceptance: local DB time-controlled test creates one 5-item digest, retries no-op, missing AI stays preparing; inspect `cron.job`; common commands. Rollback unschedule named jobs then compensating migration/function removal. |
| P6 client data / L / P1,P2 | Add Supabase anonymous auth, Query provider, SQLite/native + web persistence adapters, supabase repositories behind mock flag. Allow `src/data-access/**`, `src/providers/**`, `src/storage/**`, `app/_layout.tsx`, package/app config (≤12 logical files). Forbid screens/theme/notifications/service keys. Acceptance: auth/session/cache hydration, offline cached feed, paused idempotent mutation tests; both data modes compile/export; common commands. Rollback provider wiring/deps, mock stays runnable. |
| P7 screen migration / L / P3,P4,P6 | Move feed/article/search/saved/sources to hooks and fix double-push; retain mock adapter. Allow those five screens, `ArticleCard`, selectors/tests, up to four hooks. Forbid settings/theme/notification/backend. Acceptance: render/route tests for loading/empty/error/offline, pagination, `ai/openai` search, save/read/source mutation, TR segment rule, one Back after double tap; common commands. Rollback screens/hooks to mock consumers. |
| P8 themes / M / P1 | Add palettes/ThemeProvider and wire root/settings plus shared components in a bounded first pass. Allow theme files, provider, root, settings, `Toast`, `Toggle`, `ArticleCard`, tests/app config (≤12). Forbid data/backend. Acceptance: exact light tokens, dark parity, system change test, restart persistence, no `TOASTS.theme`, dark/light screenshots at 390×844; common commands. Rollback provider/palette changes to dark tokens. |
| P9 onboarding+notifications / L / P5,P6,P8 | Add onboarding guard/source selection, settings/digest integration, local notification service/config. Allow onboarding routes, root guard, settings/digest/sheet, notification/storage service, config/package/tests (≤12). Forbid push tokens/background fetch/server scheduling. Acceptance: permission state tests, save-vs-cancel, schedule-new-before-cancel-old, reconciliation, onboarding atomic/restart/one-source minimum; native device matrix is required before release; common commands. Rollback route/service/config and cancel owned schedules in dev build. |
| P10 integration gate / M / P5,P7,P8,P9 | Add cross-layer render/route/offline/RLS contract tests, verify env/bundle, switch production builds to Supabase only after authorized remote smoke; mock remains dev/test. Allow test/config/adapter-selection files only (≤12). Forbid feature additions/schema edits/deploy without approval. Acceptance: common commands, local Supabase suite, all Edge contract smokes, secret scan, 390×844 matrix, one iOS + Android run; remote smoke separately authorized. Rollback production flag, leaving mock mode. |

**Measured environment:** Windows 11 has Node 24/npm 11/EAS, no installed Supabase CLI
or Deno, and unknown Docker status; the restoring hosted project is treated as empty
until measured otherwise. Preferred local loop is Docker Desktop +
`npx supabase@2.115.0 start`; the CLI runs the Edge runtime, so standalone Deno is
optional for serve but needed for direct `deno fmt/lint/test`. Without Docker
and Deno, pure adapters can be tested in Node, but SQL/RLS/function integration must be
deferred to an explicitly authorized remote deploy-and-test; absence of local errors is
not backend evidence.

## 6. Contracts touched and forbidden implementation moves

| Contract dimension | New contract |
|---|---|
| Names/types | Versioned DTOs/repositories; UUID entity IDs; ISO timestamps; cursor is opaque `{published_at,id}`; summary exactly 3 strings; translation nullable only for TR |
| Timing | Feed stale-while-revalidate from SQLite; ingestion 15 min; toast 2.2 s UI-only; digest ready target 06:50 Istanbul; local notification at selected local wall time |
| Ordering | Feed `(published_at DESC,id DESC)`; digest positions 1–5; restore theme/session/cache before route guard; explicit mutation IDs make retries order-safe |
| Lifecycle | Anonymous session persists until identity link/loss; cache is versioned/cleared on identity change; AI jobs leased/retried; notification schedule reconciled on launch/foreground/timezone change |
| Ownership | Postgres durable truth; Edge external fetch/Claude/admin writes; Query server state; SQLite snapshot; router selected article; components transient drafts; OS notification service schedules |

Forbidden: any Anthropic/service/secret key or `EXPO_PUBLIC_` secret; direct client
Anthropic/RSS/article fetch; client writes to shared tables; schema edits outside named
migrations; user ID accepted from a body; unbounded query/fetch/body/prompt/retry; raw
article content in logs; toggle semantics across retryable network boundaries; private
or credentialed feed URLs; automatic scraping/third-party feeds when validation fails;
background fetch or remote push in v1; destructive linked `db reset`; deploy, secret
creation, app signing, store submission, commit, or push without separate authority.

## 7. Risks and needs measurement

1. **Feed viability/content rights (highest delivery risk):** execute the candidate
   matrix before P3; Anthropic/Webrazzi and full-text availability may force a product/
   licensing decision rather than a parser change.
2. **Claude cost/latency:** measure input/output/cache tokens and p50/p95 per article,
   daily new articles, cache-hit rate, digest demand, and retry rate; set a global daily
   cap/budget alert before enabling cron. Device identity limits are Sybil-bypassable.
3. **Edge cold starts/time limits:** measure p50/p95, queue lease expiry and batch=1–3;
   keep ingestion/AI/digest resumable and never require one long invocation.
4. **RLS:** pgTAP two-user/adversarial RPC tests plus an authorized remote test on the
   restored project; verify grants/views, not merely policy presence.
5. **Notifications:** Android 12 exact-alarm permission/policy, Android 13 channel +
   runtime permission, OEM battery behavior, reboot, timezone/DST, iOS provisional/
   denied states; confirm whether store reviewers accept exact-alarm justification.
6. **Anonymous auth:** enable abuse protection/CAPTCHA only after measuring mobile UX;
   define cleanup/retention for abandoned anonymous users. Uninstall/session loss loses
   identity until accounts are offered.
7. **Offline/cache:** measure SQLite size, hydration time, seven-day/200-article limits,
   mutation replay conflicts, and web fallback. Never label a stale digest “today”
   without comparing `digest_date`.
8. **App review/privacy:** document anonymous identifier, content fetch, local
   notifications, retention/deletion and third-party Claude processing; no background
   fetch entitlement is needed in v1, and adding it later requires a new review.
9. **Morning readiness:** pg_cron/pg_net/Vault behavior and Istanbul-day cutoff on the
   restored project; alert when ready-by-06:50 SLO misses because local notification can
   fire even while the server is unavailable.

## 8. Alternatives rejected

| Alternative | Why rejected for v1; what the chosen larger piece solves |
|---|---|
| Keep one Context reducer for everything | Conflates server cache, durable device state, UI drafts and retryable mutations; cannot give bounded offline/revalidation semantics. UiStore remains only for transient UI. |
| Custom fetch/cache without TanStack Query | Fewer dependencies, but reimplements cancellation, stale state, dedupe, retries, invalidation and persisted paused mutations. |
| AsyncStorage only | Smallest key/value option, but duplicates storage once offline feed inspection/migrations grow; SQLite KV gives the same adapter plus a migration path. |
| MMKV | Faster sync KV, but speed is unmeasured and it adds native dependency complexity while not solving relational/offline needs. |
| Edge API facade for all reads | Hides PostgREST but adds code/cold starts and duplicates RLS; privileged/costly transitions alone need functions. |
| Client RSS or Claude | Exposes CORS/SSRF/parser variance or the Anthropic key and prevents shared caching/rate control. Forbidden by decisions. |
| Per-user/private custom feed pipeline | Preserves source privacy but conflicts with shared articles/summaries and multiplies storage/Claude work. v1 accepts public feeds only. |
| Personalized server digest/push | Requires per-user jobs/tokens/background delivery; global digest + local schedule is the decided smaller system. |
| Background fetch to refresh before alert | OS-unreliable, adds entitlements/review burden, and contradicts the local-notification decision. App refreshes on foreground. |
| Third-party RSS mirrors/scraping fallback | May restore coverage, but changes trust, reliability, and rights contracts. Validation failure escalates instead. |

## Primary measured references

- Supabase anonymous users and abuse warning: <https://supabase.com/docs/guides/auth/auth-anonymous>
- RLS roles/policies: <https://supabase.com/docs/guides/database/postgres/row-level-security>
- Securing user vs service Edge calls: <https://supabase.com/docs/guides/functions/auth>
- Cron + pg_net + Vault: <https://supabase.com/docs/guides/functions/schedule-functions>
- Expo SQLite/KV persistence: <https://docs.expo.dev/versions/v54.0.0/sdk/sqlite/>
- Expo notification permissions/exact alarms: <https://docs.expo.dev/versions/v54.0.0/sdk/notifications/>
- TanStack persisted query/mutation lifecycle: <https://tanstack.com/query/latest/docs/framework/react/plugins/persistQueryClient>
