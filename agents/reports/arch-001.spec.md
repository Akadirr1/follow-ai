# arch-001 — Production v1 architecture for AI Gündem (architect)

**Role:** architect. Read `agents/architect.md` first. You design boundaries; you do
not implement. You are a worker: no spawning, no graph queries (the coordinator
has put the structural facts below), no `.orchestrator/`, no task-status updates.
The only repo file you may write is `agents/reports/arch-001.md`.

## What is being asked
Turn the current mock-data prototype app into a **production-ready v1** of AI
Gündem, and decompose that into bounded implementer tasks. The human has made the
product decisions; you make the technical ones and name the contracts.

## Decisions already made (AGENTS.md invariants — do not reopen)
1. Expo SDK 54 / React Native, expo-router, TypeScript strict. Exact pins:
   expo 54.0.37, RN 0.81.5, react 19.1.0, expo-router 6.0.24.
2. Turkish UI; foreign articles get EN→TR translation with an Orijinal/Çeviri
   toggle. Turkish sources are **not** translated ("Türkiye · TR · Çeviri yok"
   on the board) but still summarised.
3. Summaries/translations are produced by Claude, **server-side only**.
4. Light + system theme are now in scope (dark stays primary). Light palette on
   the board, section "04 — LIGHT TEMA": bg `#F4F6FB`, text `#0F1B33`, card
   `#FFFFFF`, border `#D8E0F0`, soft `#E7EEFB`, accent `#2563EB`.
5. **Backend = Supabase**, project ref `eglxzbsrewbleqlstefd` (eu-west-1,
   Postgres 17). Edge Functions (Deno/TS) hold the Anthropic key; Postgres caches
   articles + summaries; pg_cron builds the morning digest. Project is being
   restored from a paused state right now; assume an **empty** schema and no
   functions unless your report says otherwise.
6. No login in v1: **Supabase anonymous sign-in** as the device identity,
   upgradeable later.
7. Digest is delivered by a **local scheduled notification** at the user's
   chosen hour (07:00–09:00 slots); no server push.
8. `ANTHROPIC_API_KEY` never ships in the bundle (no `EXPO_PUBLIC_`); only
   Supabase URL + publishable key are client-side. Local secrets come from
   `scripts/setup-env.ps1` → `.env`.
9. v1 scope (all four required): real RSS for the 7 sources + user-added
   RSS/URL; Claude TR 3-bullet summary + EN→TR translation, cached; light/system
   theme + on-device persistence + offline last feed; daily digest + notification
   permission flow + first-run source-selection onboarding.

## Current code (structural facts from the coordinator's graph, 480 nodes)
- Store core: `src/store/types.ts` (State/Action — pasted below) ← `reducer.ts`
  ← `StoreProvider.tsx` (context + useReducer). `selectors.ts` is imported by 6
  of 7 screens; `StoreProvider` by all screens + `Toast` + `DigestTimeSheet`.
- Screens: `app/(tabs)/{index,digest,saved,sources,settings}.tsx`,
  `app/article/[id].tsx`, `app/search.tsx`; root `app/_layout.tsx` mounts
  `StoreProvider` + `Toast` + Inter fonts.
- Mock data: `src/data/{articles,sources,digest}.ts`. Tokens:
  `src/theme/tokens.ts` (dark only). Components: `src/components/*`.
- Tests: 35 pure reducer/selector tests; **no render/route tests**.
- Reports worth reading: `agents/reports/impl-001.md` (§3 store rationale, §5
  decisions, §6 icon placeholders), `agents/reports/rev-001.md` (N1 double-push,
  N2 coverage gap).

```ts
// src/store/types.ts (current contract)
export type State = { filter; saved: Record<string,boolean>; read; srcOn; artId;
  seg: 'tr'|'en'; sheet; digestTime; tmpTime; q; translate; toast; toastSeq };
export type Action = setFilter | toggleSource | openArticle{id,markRead} | toggleSave
  | deleteSaved | setSeg | setQuery | clearQuery | toggleTranslate | openSheet
  | closeSheet | pickTime | saveTime | toast | clearToast{seq};
```

## Environment facts
- Windows 11 dev machine. `node` 24, `npm` 11, `eas` CLI on PATH. **No**
  `supabase` CLI installed (`npx supabase@2.115.0` is available), **no** `deno`,
  Docker status unknown — say what local Edge Function development needs and
  what can be deferred to deploy-and-test-remote.
- The 7 sources from the prototype: OpenAI Blog, Anthropic, Google DeepMind,
  Hugging Face, arXiv cs.AI, TechCrunch AI, Webrazzi AI (TR). Real feed URLs
  are **not known** — propose candidates and mark them "needs measurement"
  (reachable, valid RSS/Atom, item count) for the implementer to verify first.
- Claude API facts (coordinator-verified): default model `claude-opus-5`
  (`ANTHROPIC_MODEL`); use the official TypeScript SDK `@anthropic-ai/sdk`
  (npm: specifier in Deno) rather than raw fetch; structured output via
  `output_config.format` for the {summary[3], translation} JSON; adaptive
  thinking is the default — never send `budget_tokens`; put the stable system
  prompt first and mark it `cache_control` so repeated summaries hit the prompt
  cache; article text is **untrusted input** to the prompt.

## What your report must contain (`agents/reports/arch-001.md`)
1. **Target architecture** in one page: client ↔ Supabase boundaries, what runs
   where, and why each piece is the smallest thing that meets the decisions.
2. **Postgres schema** (tables, keys, indexes) + **RLS** for anonymous users
   (a device sees its own saved/read/sources/settings; articles and summaries
   are shared read-only), + pg_cron job for the digest. Name the migration files.
3. **Edge Function contracts**: name, trigger (HTTP/cron), auth (anon JWT vs
   service role), request/response shapes, idempotency, caching, rate limits per
   device, error model. At minimum: feed ingestion, summarise/translate, digest
   build, add-source validation (with SSRF/URL-scheme rules).
4. **Client architecture**: data layer (server-state vs local-state; name the
   library or justify none), persistence (expo-sqlite vs MMKV vs AsyncStorage —
   pick one with reasons), offline last-feed, theme system (dark/light/system
   with the token file split), notifications (`expo-notifications` scheduling,
   permission flow), onboarding route, and **exactly what happens to the current
   store contract** (keep / rename / delete per field and action; `TOASTS.theme`
   must go).
5. **Task DAG for implementers** — each task bounded: goal, allowed paths,
   forbidden paths, dependencies, measurable acceptance (commands), size
   (S/M/L), rollback. Order them so `tsc`, `jest`, and `expo export --platform
   web` stay green after every task, and so the app remains runnable with mock
   data until the server pieces land (feature flag or adapter seam). Aim for
   6–10 tasks; none should touch more than ~12 files.
6. **Contracts touched** (names, types, timing, ordering, lifecycle, ownership)
   and **what is forbidden** for implementers (e.g. no key in bundle, no
   `EXPO_PUBLIC_` secrets, no schema change outside migrations).
7. **Risks + needs-measurement list**: feed URL viability, Claude cost per
   article and per day, Edge Function cold starts, notification reliability on
   Android (exact alarms), RLS correctness, Apple/Google review items
   (anonymous auth, background fetch).
8. **Alternatives rejected** and why, in one table.

Prefer the smallest change that resolves the problem; when you propose a larger
one, say what the smaller one fails to solve. Mark every claim **measured /
inferred / needs measurement**. Keep the report under ~400 lines; link to files
rather than pasting them.

## Reporting
Write `agents/reports/arch-001.md`, then send `worker_done` from your own
terminal with `--outcome succeeded|failed`, `--report-path
agents/reports/arch-001.md`, body ≤ 10 lines: the architecture in two sentences,
the task count, and the single biggest risk.
