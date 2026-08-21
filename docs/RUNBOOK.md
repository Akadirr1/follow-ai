# AI Gündem — kısa çalıştırma rehberi (2026-08-21)

## Backend (Supabase `eglxzbsrewbleqlstefd`)
Her şey canlı; elle yapılacak rutin iş yok.

- **Otomatik akış (UTC):** ingest `*/15` → özetleme worker'ı `*/2` → digest
  prepare `02:45` (günün adaylarını kuyruğa alır) → finalize `03:30/40/50`
  (5 öğe olunca `ready`). İstanbul 06:30–06:50'de digest hazır olur.
- **Model sağlayıcısı:** `AI_PROVIDER=auto` → Gemini `gemini-2.5-flash`
  (birincil), NVIDIA `meta/llama-3.3-70b-instruct` (yedek). Anahtarlar Vault'ta:
  `aigundem_gemini_api_key`, `aigundem_nvidia_api_key`. Anahtar yenilemek:
  ```sql
  select vault.update_secret(id, '<yeni>') from vault.secrets where name = 'aigundem_gemini_api_key';
  ```
- **Günlük harcama sınırı:** `AI_DAILY_CAP=200` (Edge env; yoksa varsayılan).
  Digest ön-özetleme ≈ 12 çağrı/gün + kullanıcı istekleri (cihaz başına 30/gün).
- **Sağlık kontrolü (SQL Editor):**
  ```sql
  select jobid, jobname, active from cron.job;                       -- 4 iş aktif olmalı
  select * from cron.job_run_details order by start_time desc limit 10;
  select status, count(*) from private.ai_jobs group by 1;            -- failed birikiyorsa bak
  select digest_date, status, generated_at from aigundem.digests order by 1 desc limit 3;
  ```
- **Elle tetikleme** (header `X-Internal-Secret` = Vault `aigundem_automations_secret`):
  `POST /functions/v1/sync-feeds`, `/process-enrichments {"max_jobs":3}`,
  `/build-digest {"phase":"prepare"|"finalize"}`.
- **Kapatma/rollback:** `select cron.alter_job(<id>, active := false)`;
  fonksiyonların eski sürümü Dashboard → Edge Functions → Versions. Migration'lar
  ek; geri alma = önceki gövdeyi yeniden uygulamak (0010 → 0009'a, 0008'e değil).
- **Kod değiştirince deploy:** `npx esbuild supabase/functions/<fn>/index.ts
  --bundle --format=esm --platform=neutral --minify --external:@supabase/supabase-js
  --external:@anthropic-ai/sdk` çıktısını Dashboard'dan (veya MCP ile) `index.js`
  olarak yükle; `deno.json` import map'iyle birlikte. `_shared/**` değişirse
  **beş fonksiyonu birden** yeniden deploy et. Yeni SQL = yeni migration dosyası
  (`supabase/migrations/2026082100NN_*.sql`), önce migration sonra deploy.
- **Sonraki sertleştirme:** Dashboard → API → `aigundem` şemasını expose et,
  sonra `public.aigundem_*` shim'lerini kaldır.

## Mobil (Expo SDK 54, `app/` + `src/`)
- **Kurulum:** `npm install` → `npm run setup:env` (yalnızca
  `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`,
  `EXPO_PUBLIC_DATA_MODE` sorar; model anahtarı **girme**, sunucudadır).
- **Geliştirme:** `npx expo start` (varsayılan `mock` veri; canlı veri için
  `EXPO_PUBLIC_DATA_MODE=supabase`). Release build'de varsayılan `supabase`.
- **Cihazda çalıştırma:** `npx expo run:android` / `npx expo run:ios`
  (expo-notifications ve expo-sqlite native modül ister; Expo Go yetmez).
- **Kapı:** değişiklikten sonra `npm run check:release` (typecheck, 1052 test,
  env kontrolü, bundle'da sır taraması ×2). Yeşil değilse push etme.
- **Cihazda doğrulanacaklar (henüz yapılmadı):** splash/tema kalıcılığı
  (light/dark/system, yeniden başlatma), onboarding → bildirim izni →
  günlük bildirim (saat seçimi, DST, yeniden başlatma) → bildirime tıklayınca
  Digest sekmesi; makale ekranı (Özet/Orijinal/Çeviri, "Kaynağa git");
  kaynak ekleme modal'ı; pull-to-refresh ve sonsuz kaydırma; çevrimdışı son
  feed.
- **İkonlar:** `AppIcon` yer tutucu; mağaza build'inden önce PNG'leri
  `assets/`'e koy (5 değişim noktası `src/components/AppIcon.tsx`).
- **Yayın:** `eas build -p android|ios` (EAS hesabı + `EXPO_TOKEN`), sonra
  `eas submit`.

## Bilinen borçlar
Jest paralel koşuda bir worker'ı force-exit ediyor (`--runInBand` bazen takılır);
`sources.tsx` aynı kaynağı tekrar eklerken "zaten ekli" demiyor; rev-003 N2
(istek gövdesi byte sınırı) ve N6 (migration prefix çakışması,
`supabase/config.toml` yok). Ayrıntı: `agents/reports/handoff-2026-08-21.md`.
