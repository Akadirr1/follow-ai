# p10-smoke — live release smoke checklist

Run by the **coordinator**, against the real project, in this order. Everything
here is read-only except §3 (`add-source` writes one row) and §4 (automation
triggers). No step deploys anything.

Nothing in this file contains a secret. Set the two public values once:

```bash
export SUPABASE_URL=$(grep '^EXPO_PUBLIC_SUPABASE_URL=' .env | cut -d= -f2-)
export ANON=$(grep '^EXPO_PUBLIC_SUPABASE_ANON_KEY=' .env | cut -d= -f2-)
export DEVICE=$(node -e "console.log(crypto.randomUUID())")   # uuid v4, required
export REQ_ID='node -e "console.log(crypto.randomUUID())"'    # a fresh one per call
```

`X-Internal-Secret` (§4) is **not** in `.env`. It lives in Supabase Vault as
`aigundem_automations_secret`; paste it into `$INTERNAL` for §4 and do not echo it.

> **Read §6 before starting.** One blocking defect (B1) makes §2 and §3 fail
> *from the app* even though the curl commands there succeed. That difference is
> the point of those steps.

---

## 1. Read path — PostgREST, anon key only

### 1.1 Feed view is populated

```bash
curl -s "$SUPABASE_URL/rest/v1/aigundem_feed_articles_v1?select=article_id,title,source_name,published_at,summary_ready&order=published_at.desc&limit=3" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
```

**Expect:** a JSON array of 3 objects, newest first, each with a non-null
`title` and `source_name`. As of 2026-08-21 the view holds **334 rows** and
`summary_ready` is `false` on all of them — the documented no-API-key state
(addendum §E), not a failure.

**Fails if:** `[]` (ingestion has not run — go to §4.1), or a body with
`"code":"PGRST205"` (the view is missing; the app then shows "Bu özellik henüz
hazır değil.").

### 1.2 Keyset paging matches what the app sends

```bash
curl -s "$SUPABASE_URL/rest/v1/aigundem_feed_articles_v1?select=article_id,published_at&order=published_at.desc,article_id.desc&limit=21" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" | head -c 200
```

**Expect:** 21 rows. The app asks for `limit + 1` to learn `hasMore` without a
count query, and both `order` terms must be accepted — a 400 here means the view
lost `article_id` and paging will loop.

### 1.3 Sources catalog

```bash
curl -s "$SUPABASE_URL/rest/v1/aigundem_sources_v1?select=id,slug,name,is_default,status&status=eq.active&order=is_default.desc,name.asc" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
```

**Expect:** 7 or more active sources, defaults first. Onboarding enables every
one of these, so an empty array makes onboarding un-completable.

### 1.4 Search RPC — the exact body the app posts

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/aigundem_search_articles_v1" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "Content-Type: application/json" \
  -d '{"q":"openai","source_ids":null,"lim":20}'
```

**Expect:** a non-empty array (TechCrunch AI / OpenAI Blog rows). The parameter
names are part of the contract: `q`, `source_ids`, `lim`.

### 1.5 Digest view

```bash
curl -s "$SUPABASE_URL/rest/v1/aigundem_digests_v1?select=id,digest_date,status&status=eq.ready&order=digest_date.desc&limit=1" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
```

**Expect today:** `[]` — no digest has reached `ready`. The app renders the
"hazırlanıyor" state for this, which is correct behaviour, not an error.

### 1.6 The private schema is still private

```bash
curl -s "$SUPABASE_URL/rest/v1/articles?select=id&limit=1" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "Accept-Profile: aigundem"
```

**Expect:** HTTP 406 with `"code":"PGRST106"` and the message that only
`public, graphql_public` are exposed.

**This must stay a 406.** If it ever returns rows, the anon key can read the
base tables and the release stops there.

---

## 2. Write path — request-enrichment

```bash
ARTICLE=$(curl -s "$SUPABASE_URL/rest/v1/aigundem_feed_articles_v1?select=article_id&limit=1" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))[0].article_id")

curl -s -i -X POST "$SUPABASE_URL/functions/v1/request-enrichment" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "X-Device-Id: $DEVICE" -H "Content-Type: application/json" \
  -d "{\"article_id\":\"$ARTICLE\",\"client_request_id\":\"$(eval $REQ_ID)\"}"
```

**Expect:** `202` with
`{"status":"queued","poll_after_seconds":<n>,"reason":"no_api_key"}`. The job is
enqueued for real; it runs the moment a key exists.

**After `ANTHROPIC_API_KEY` is set** (release step R2): the same call returns 202
without `reason`, and once `process-enrichments` has run, a repeat returns
`200 {"status":"ready","summary":{"bullets":[3 items],"translation_tr":…}}`.

**Fails with** `400 {"error":{"code":"bad_request","message":"client_request_id
must be a uuid v4."}}` if the id is not a uuid — which is what the app sends
today. See §6.

---

## 3. Write path — add-source: one happy case, one rejection

### 3.1 Happy path

```bash
curl -s -i -X POST "$SUPABASE_URL/functions/v1/add-source" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "X-Device-Id: $DEVICE" -H "Content-Type: application/json" \
  -d "{\"url\":\"https://simonwillison.net/atom/everything/\",\"category\":\"Araştırma\",\"language\":\"en\",\"client_request_id\":\"$(eval $REQ_ID)\"}"
```

**Expect:** `201` with `{"source":{…,"slug":…,"status":"active"},"client_request_id":…}`.
Re-running with a fresh `client_request_id` returns **200** with the same source —
an existing feed is idempotent, not an error.

### 3.2 SSRF rejection — the guard must hold

```bash
for U in "http://169.254.169.254/latest/meta-data/" "http://127.0.0.1:54321/" "http://[::1]/feed.xml"; do
  curl -s -o /dev/null -w "$U -> %{http_code}\n" -X POST "$SUPABASE_URL/functions/v1/add-source" \
    -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
    -H "X-Device-Id: $DEVICE" -H "Content-Type: application/json" \
    -d "{\"url\":\"$U\",\"category\":\"Modeller\",\"language\":\"en\",\"client_request_id\":\"$(eval $REQ_ID)\"}"
done
```

**Expect:** `400` for all three, with `{"error":{"code":"unsafe_url","retryable":false,…}}`.

**Fails if:** any returns 201, or 502 `fetch_failed` — a 502 means the guard let
the request leave the function and the network refused it, which is a hole, not a
pass.

### 3.3 Missing device header

```bash
curl -s -i -X POST "$SUPABASE_URL/functions/v1/add-source" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "Content-Type: application/json" -d '{"url":"https://example.com/feed.xml"}'
```

**Expect:** `400`, `X-Device-Id must be a uuid v4.` The rate-limit subject is
mandatory; there is no anonymous fallback.

---

## 4. Automation — internal secret; cron stays off

`X-Internal-Secret` only. The anon key is irrelevant to these three.

### 4.1 sync-feeds (ingestion)

```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/sync-feeds" \
  -H "X-Internal-Secret: $INTERNAL" -H "Content-Type: application/json" -d '{}'
```

**Expect:** `{"sources_ok":N,"sources_failed":0,"articles_inserted":M,…}`.
Last manual run (2026-08-21): **7 ok, 0 failed, 334 inserted, 5.4 s**. Hugging
Face returning 0 items is the known fix-003 case.

### 4.2 build-digest (prepare)

```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/build-digest" \
  -H "X-Internal-Secret: $INTERNAL" -H "Content-Type: application/json" \
  -d '{"phase":"prepare"}'
```

**Expect today:** `{"date":"…","status":"preparing","item_count":0,"missing_enrichments":N}`
— fewer than five enriched articles exist, so the digest refuses to invent one
(addendum §E). After R2 and a `process-enrichments` run, the same call reaches
`"status":"ready"` with `item_count >= 5`.

### 4.3 No secret means no work

```bash
curl -s -i -X POST "$SUPABASE_URL/functions/v1/sync-feeds" -d '{}'
```

**Expect:** 401/403 with a body that does not reveal whether the secret exists.

### 4.4 Cron is disabled — confirm, do not enable

```sql
select jobname, schedule, active from cron.job where jobname like 'ai-gundem-%';
```

**Expect:** four `ai-gundem-*` jobs, all `active = false`.

**Leave them false.** Per `agents/reports/facts-2026-08-21.md`, cron stays
disabled until **fix-003 is redeployed and the Hugging Face re-run passes**.
Enabling them earlier schedules a known-failing ingestion every 15 minutes.

---

## 5. App — both data modes

### 5.1 Mock mode (no credentials needed)

```bash
EXPO_PUBLIC_DATA_MODE=mock npx expo start --clear
```

**Expect:** onboarding → feed with the prototype articles; search finds
"GPT-5.2"; the digest tab renders; the theme choice survives a reload. No
requests to `*.supabase.co` in the network debugger.

### 5.2 Supabase mode

```bash
EXPO_PUBLIC_DATA_MODE=supabase npx expo start --clear
```

**`--clear` is not optional.** Metro caches the transform in which
`EXPO_PUBLIC_*` was inlined; without it, a build made before the values existed
falls back to mock and looks like a working app running on prototype data.
(Measured during P10: `url: 0 | key: 0 | view: 1` before `--clear`,
`url: 1 | key: 1 | view: 1` after.)

**Expect:** the feed shows the same rows as §1.1; an article opens with its
original text and "Özet hazırlanıyor"; pull-to-refresh works; with the network
off the feed still renders, above a "Çevrimdışı — son güncelleme …" banner.

**Known today:** "Kaynak ekle" and every summary request fail — §6, B1.

### 5.3 Release gate

```bash
npm run check:release
```

**Expect:** exit 0. It runs typecheck, the full suite, `check-env`, and the
bundle scan in **both** modes — the supabase pass asserts the project URL and the
anon JWT are inlined and that the only embedded JWT role is `anon`; the mock pass
asserts neither is present.

---

## 6. What blocks the release

**B1 (blocking).** `clientRequestId()` in `src/data-access/supabase/edge.ts`
mints `${Date.now().toString(36)}-${random}`, but `add-source` and
`request-enrichment` both reject anything that is not a uuid v4 with `400
bad_request`. Every add-source and every summary request from the app fails; the
curl steps in §2 and §3 pass because they generate real uuids. The one-line fix
is in `agents/reports/p10.md`. §2 and §3 cannot pass *from the app* until it
lands.

**R1.** Nothing new gets exposed: the `aigundem` schema stays unexposed (§1.6).

**R2.** `ANTHROPIC_API_KEY` must be set as an Edge secret before any summary or a
`ready` digest is possible. Never as `EXPO_PUBLIC_*` — `check-env` fails the
build if anyone tries.

**R3.** Cron stays disabled until fix-003 ships (§4.4).
