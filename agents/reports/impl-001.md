# impl-001 — AI Gündem prototype as an Expo SDK 54 app (mock data)

Role: implementer. Task `task_891a829c6938`, dispatch `ctx_10fadccfe7cf`.
Spec: `agents/reports/impl-001.spec.md`. Outcome: **succeeded**.

- Repo: `C:\Users\Abdulkadir\OneDrive\follow-ai`, branch `main`, still **unborn**.
- Base ref: empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`.
- Nothing was committed, staged permanently, pushed, or given a remote. No network
  calls from the app, no credentials, no Claude API calls.

## 1. Escalation resolved before any code was written

`npx create-expo-app@latest aigundem --template blank-typescript` resolved to
**SDK 57** (`expo ~57.0.15`, `react-native 0.86.2`, `react 19.2.3`,
`typescript ~6.0.3`), not the SDK 54 the brief and AGENTS.md invariant 1 require.
Per the brief I stopped and asked instead of hand-downgrading. The coordinator chose
option A: re-scaffold from the pinned SDK-54 template.

That SDK-57 scaffold was **discarded** (deleted in the scratchpad, never copied into
the repo). The app was re-created with:

```
npx create-expo-app@latest aigundem --template expo-template-blank-typescript@sdk-54
```

which resolved to `expo ~54.0.36`, `expo-status-bar ~3.0.9`, `react 19.1.0`,
`react-native 0.81.5`, `@types/react ~19.1.0`, `typescript ~5.9.2`. The template's
`package.json`, `tsconfig.json`, `app.json` and `assets/` were copied to the repo
root (the scaffold's own `.git/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`, `LICENSE`
and `.gitignore` were not). Installed versions actually pinned in `package.json`:

| package | pinned | package | pinned |
|---|---|---|---|
| expo | 54.0.37 | react | 19.1.0 |
| expo-router | 6.0.24 | react-dom | 19.1.0 |
| expo-font | 14.0.12 | react-native | 0.81.5 |
| expo-constants | 18.0.14 | react-native-safe-area-context | 5.6.2 |
| expo-linking | 8.0.12 | react-native-screens | 4.16.0 |
| expo-splash-screen | 31.0.13 | react-native-svg | 15.12.1 |
| expo-status-bar | 3.0.9 | react-native-web | 0.21.2 |
| @expo/metro-runtime | 6.1.2 | @expo-google-fonts/inter | 0.4.2 |
| jest 29.7.0 · jest-expo 54.0.18 · babel-preset-expo 54.0.12 · typescript 5.9.3 · @types/jest 29.5.14 · @types/react 19.1.17 · react-test-renderer 19.1.0 | | | |

Every version is exact (no `^`/`~`) as the brief's "pin versions" requires.
Everything except `@expo-google-fonts/inter`, `jest*`, `@types/*`,
`react-test-renderer` and `babel-preset-expo` was resolved by `npx expo install`,
i.e. by the SDK's own version map.

Two install facts worth recording:
- `@expo-google-fonts/inter` first failed with `ERESOLVE`: a transitive
  `react-dom@19.2.8` had been hoisted, which demands `react ^19.2.8` against SDK
  54's pinned `react 19.1.0`. Fixed by `npx expo install react-dom react-native-web
  @expo/metro-runtime` (SDK-54 pins `react-dom 19.1.0`), not by `--force`/
  `--legacy-peer-deps`.
- `babel-preset-expo` and `expo-splash-screen` are not root dependencies of the
  SDK-54 blank template but are required once `babel.config.js` and the splash
  plugin exist; both were added at the SDK-54 version (`54.0.12` / `31.0.13`).

## 2. Files created (diff scope)

`git add -N . && git diff --stat 4b825dc642cb6eb9a060e54bf8d69288fbee4904`
(scoped to exclude the pre-existing untracked `design/`, `agents/`, `AGENTS.md`,
`CLAUDE.md`, `.claude/`, `.codex/`):

```
 .gitignore                         |    25 +     (appended only — see §5/A6)
 app.json                           |    43 +
 app/(tabs)/_layout.tsx             |    69 +
 app/(tabs)/digest.tsx              |   115 +
 app/(tabs)/index.tsx               |   128 +
 app/(tabs)/saved.tsx               |   159 +
 app/(tabs)/settings.tsx            |   185 +
 app/(tabs)/sources.tsx             |    98 +
 app/_layout.tsx                    |    66 +
 app/article/[id].tsx               |   262 +
 app/search.tsx                     |   172 +
 assets/adaptive-icon.png           |   Bin 0 -> 17547 bytes
 assets/favicon.png                 |   Bin 0 -> 1466 bytes
 assets/icon.png                    |   Bin 0 -> 22380 bytes
 assets/splash-icon.png             |   Bin 0 -> 17547 bytes
 babel.config.js                    |     4 +
 jest.config.js                     |     5 +
 package-lock.json                  | 14182 +
 package.json                       |    41 +
 src/components/AppIcon.tsx         |    39 +
 src/components/ArticleCard.tsx     |    87 +
 src/components/DigestTimeSheet.tsx |   140 +
 src/components/EmptyState.tsx      |    50 +
 src/components/Icons.tsx           |   235 +
 src/components/Toast.tsx           |    52 +
 src/components/Toggle.tsx          |    67 +
 src/data/articles.ts               |   118 +
 src/data/digest.ts                 |    43 +
 src/data/sources.ts                |    12 +
 src/store/StoreProvider.tsx        |    62 +
 src/store/__tests__/store.test.ts  |   269 +
 src/store/reducer.ts               |   142 +
 src/store/selectors.ts             |    63 +
 src/store/types.ts                 |    57 +
 src/theme/tokens.ts                |    83 +
 tsconfig.json                      |    13 +
 36 files changed, 17086 insertions(+)
```

Plus this report, `agents/reports/impl-001.md`. Largest source file is 269 lines,
so the "under 500 lines" rule holds everywhere. No documentation files were created.

**The index was left as it was found.** `git add -N .` marks *every* untracked file
intent-to-add, including the forbidden-path files, which turned them from `??` to
` A ` in `git status`. That is an index change I caused, so after taking the diffstat
I ran `git rm -r --cached . -q` (index only, working tree untouched). All 57 paths
are `??` again, exactly as at session start.

## 3. Store: React context + `useReducer` (and why)

One in-memory store in `src/store/` — no zustand. Reasons, in order of weight:

1. The prototype is literally one `state` object mutated through `setState`. A single
   reducer is a 1:1 transcription; introducing a store library would introduce an
   abstraction the source of truth does not have.
2. The reducer and selectors are plain pure functions, so `src/store/__tests__`
   imports them directly — A3 needs no renderer, no `@testing-library/react-native`,
   no provider harness. (Relevant: `@testing-library/react-native` could not be
   installed under SDK 54's peer graph in the same pass as the fonts package.)
3. Zero added runtime dependency in an app whose next tasks (RSS, Claude calls) will
   add real ones.

Nothing is persisted: reload resets to `initialState`, as the prototype does.

State shape mirrors `state = {...}` minus `tab`/`view`, which expo-router owns:
`filter, saved, read, srcOn, artId, seg, sheet, digestTime, tmpTime, q, translate,
toast, toastSeq`. Initial values are the prototype's verbatim: saved `gd`+`hf`,
read `oa`, `srcOn.tc=false` (others true), `digestTime '08:00'`, `translate true`,
filter `'Tümü'`.

`toastSeq` is the one addition. The prototype uses a `clearTimeout`-on-`this._tt`
handle; in React that maps to a timer keyed on the toast identity, so a replacement
toast restarts the 2.2 s clock instead of inheriting the previous one's remainder.
`clearToast` carries the sequence it was scheduled for and no-ops if a newer toast
has arrived.

Routes: `app/(tabs)/{index,digest,saved,sources,settings}.tsx` (default tab = feed),
plus stack routes `app/article/[id].tsx` and `app/search.tsx`.

## 4. Acceptance criteria

### A1 — `npx tsc --noEmit` exits 0

```
$ npx tsc --noEmit
exit=0
```
(no output). Run twice: before and after `expo export` generated
`.expo/types/**` for `experiments.typedRoutes`, so typed routes do not break it.

### A2 — `npx expo export --platform web` exits 0 and produces `dist/`

```
$ rm -rf dist && npx expo export --platform web
Web Bundled 12024ms node_modules\expo-router\entry.js (773 modules)
λ Bundled 12031ms node_modules\expo-router\node\render.js (782 modules)

› web bundles (1):
_expo/static/js/web/entry-8da5bfe840c0ddb50f9f0103b6ec8c96.js (1.17 MB)

› Static routes (14):
/ (index) · /digest · /saved · /sources · /settings · /search
/article/[id] · /(tabs) · /(tabs)/digest · /(tabs)/saved · /(tabs)/sources
/(tabs)/settings · /_sitemap · /+not-found     (20.7 kB each)

Exported: dist
export exit=0
```
`dist/` contains `_expo/`, `index.html`, `(tabs)/`, `article/`, `search.html`,
`settings.html`, `sources.html`, `saved.html`, `digest.html`, `_sitemap.html`,
`+not-found.html`. `dist/` is gitignored.

### A3 — `npx jest` exits 0, store unit tests

```
$ npx jest
Test Suites: 1 passed, 1 total
Tests:       32 passed, 32 total
Snapshots:   0 total
Time:        0.515 s, estimated 3 s
exit=0
```

Coverage of the required cases, all in `src/store/__tests__/store.test.ts`:

| required case | tests |
|---|---|
| category filter | `Tümü` shows all on-sources; `Araştırma` narrows to `gd`; empty result |
| source toggle filtering | removes the article + decrements active count; combines with the chip; toggling back restores |
| save / unsave | `Kaydedildi` / `Kayıt kaldırıldı` toasts and the saved list |
| delete from saved | `Kayıt silindi`; unread count follows |
| mark-read on open | marks read from feed/saved; **does not** from search; `seg` resets to `tr` |
| search matching | title (`ALPHAFOLD`, upper-case), source (`hugging face`), category (`türkiye`), no-match, clear |
| digest time save-vs-cancel | Kaydet commits + toasts; Vazgeç discards and does not toast; reopening reseeds `tmpTime` |
| negative cases | 6 tests: unknown article id on `openArticle` (does not throw, state identical, exact warn asserted), unknown id on `toggleSave`, `deleteSaved` of an unsaved id, unknown source key, out-of-range `pickTime`, `selectArticle` fallback |

### A4 — `npx expo-doctor`

```
$ npx expo-doctor
Running 18 checks on your project...
18/18 checks passed. No issues detected!
doctor exit=0
```
No warnings to paste — the run produced none. (`npm audit` separately reports 18
advisories in the transitive dev tree; expo-doctor does not flag them and I changed
no dependency to chase them.)

### A5 — screens/overlays with the prototype's Turkish strings

All screens and overlays exist: feed (+ chips, empty state), digest, saved
(+ empty state), sources, settings (+ digest-time bottom sheet), detail, search
(recent / results / no-results), five-tab bar, toast.

Mechanical parity check (script kept out of the repo, in the session scratchpad):

```
checked strings: 82
missing in app source: none
not found verbatim in prototype: none

data literals checked: 72
data literals not found verbatim in prototype: none
```

The first pass takes 82 user-visible literals named by the brief (screen titles,
empty states, section labels, settings rows, segment labels, CTA, search copy, all
six toasts, all six chips, the five digest slots) and asserts each appears **both**
in `app/**` + `src/**` and verbatim in the prototype HTML. The second pass extracts
every string literal from `src/data/*.ts` (comments stripped) and asserts each one
occurs verbatim in the prototype's script block — that is the field-level check on
the 5 articles (`id/tile/src/time/cat/title/sum[]/body/en`), the 7 `srcMeta` rows
and the static digest entries.

I also ran the exported bundle and clicked through it (see §6) — not required by A5,
but it is what turns "the strings are in the source" into "the strings render".

### A6 — nothing under the forbidden paths

```
$ git status --porcelain --untracked-files=all | awk '{print $1}' | sort | uniq -c
     57 ??
```

Every path is untracked; nothing is staged or modified. The forbidden paths
(`AGENTS.md`, `CLAUDE.md`, `agents/**`, `.claude/`, `.codex/`, `.orchestrator/`,
`design/**`) appear in that listing only as the `??` entries that were **already**
there at session start — the same 21 lines the first `git status` of this session
printed, unchanged. `.orchestrator/` is gitignored and untouched. The only
forbidden-path file I wrote is the one the brief allows: `agents/reports/impl-001.md`.

`.gitignore` was **appended to only** — its single pre-existing line
`/.orchestrator/` is intact at the top, followed by a marked block
`# --- Expo app (impl-001) ---` with the SDK-54 template's ignores.

## 5. Decisions where the prototype was ambiguous

1. **Search results do not mark an article read.** The prototype's `feedItems[].open`
   and `savedItems[].open` set `read[id]=true`; `results[].open` deliberately does
   not. I kept that asymmetry rather than "fixing" it, and made it explicit:
   `openArticle` takes a `markRead` flag, set at the three call sites, with a test
   pinning both branches. If the reviewer decides it was a prototype bug, it is a
   one-word change at `app/search.tsx`.
2. **Unknown article id.** The prototype silently falls back
   (`arts.find(...) || arts[2]`). Silence is forbidden here, so `selectArticle`
   keeps the fallback but `console.warn`s, and `openArticle` refuses the unknown id
   outright with a warn. Both are tested.
3. **Trash must not also open the detail.** The prototype uses `_suppressOpen` with
   a 50 ms window because DOM clicks bubble. React Native's nested `Pressable` does
   not bubble, but `react-native-web`'s does, so I kept the same 50 ms guard in
   `app/(tabs)/saved.tsx` — and it warns when it actually swallows an open, so the
   guard cannot hide a real bug. Verified in the browser: deleting left the URL on
   `/saved`.
4. **Tabs vs. `view` state.** The prototype keeps `tab`/`view` in the same state
   object. Here expo-router owns navigation and they are gone from the store; `artId`
   stays because `seg` resets with it.
5. **Digest screen is static.** Its five entries have different titles from the feed
   articles (e.g. entry 04 "AB Yapay Zekâ Yasası'nda ikinci faz" has no feed article
   at all). I transcribed them as data in `src/data/digest.ts` rather than deriving
   them from `ARTICLES`, because deriving would silently change the copy. Only the
   `Hazır · {digestTime}` badge is live.
6. **"Digest bildirimi" switch** is hard-on with no handler in the prototype; the
   `Toggle` component renders without a `Pressable` when no `onToggle` is passed, so
   it is visibly decorative rather than fake-interactive.
7. **Theme segment**: only "Açık" and "Sistem" toast; "Koyu" is inert (already
   active), matching the prototype's markup.
8. **Search case-folding** uses `toLocaleLowerCase('tr')` on both sides. Plain
   `toLowerCase()` maps `I`→`i` rather than `ı`, which would mismatch Turkish
   titles; the prototype's JS runs in a browser default locale, so this is a
   deliberate, Turkish-correct deviation.
9. **Fonts**: Inter via `@expo-google-fonts/inter` + `useFonts`. The app renders a
   blank canvas until the faces load; if loading fails it renders anyway with the
   system fallback and `console.warn`s, because falling back silently would hide a
   visible regression. Monospace labels use `Platform.select` (`Menlo` / `monospace`
   / `ui-monospace, Menlo, monospace`).
10. **Colour tokens** live only in `src/theme/tokens.ts`, including the alpha text
    ramp the prototype uses inline (`rgba(229,234,242,.92/.8/.75/.6/.55/.5/.45/.4)`)
    and the border set. No screen hard-codes a hex except two `pressed` hover
    colours transcribed from `style-hover`.

## 6. Icon placeholders — the spots to swap later

`uploads/ikon1.png` / `ikon3.png` were unrecoverable (truncated on import, AGENTS.md
"Known failure pattern"). `src/components/AppIcon.tsx` draws a rounded square,
`#1E3358` background, `#93C5FD` "AG" text, at the prototype's size/radius. It is used
in exactly **five** places — swap this one component, or these five call sites:

| where | file | prototype source | size |
|---|---|---|---|
| Feed header, left of "AI Gündem" | `app/(tabs)/index.tsx` | `ikon3.png` | 34 px, r9 |
| Digest header, top-right | `app/(tabs)/digest.tsx` | `ikon1.png` | 56 px, r14 |
| Feed empty state ("Bu filtrede haber yok") | `src/components/EmptyState.tsx` via `app/(tabs)/index.tsx` | `ikon1.png` | 90 px, r21 |
| Saved empty state ("Kaydedilen haber yok") | `src/components/EmptyState.tsx` via `app/(tabs)/saved.tsx` | `ikon1.png` | 96 px, r22 |
| Search no-results ("Sonuç bulunamadı") | `src/components/EmptyState.tsx` via `app/search.tsx` | `ikon1.png` | 84 px, r19 |

(Five call sites, three of them through `EmptyState`.) The prototype also draws
`ikon3.png` at 26 px in the *page chrome around* the phone frame — that chrome is not
part of the app and was not reproduced. `assets/icon.png`, `adaptive-icon.png`,
`splash-icon.png`, `favicon.png` are still the **create-expo-app defaults**; they are
launcher/splash assets, not in-app UI, and need the same swap.

## 7. What I verified beyond the criteria, and how

I served the A2 `dist/` bundle over `http://localhost:8099` from a local static
server (session scratchpad, not in the repo; stopped afterwards) and drove it in
Chrome. Confirmed working, with screenshots taken at each step:

- feed: 5 cards, chips, `12 yeni`, tab bar, Inter type, dark palette;
- card → `/article/oa`: category + `EN→TR` pills, `AI TR ÖZET` card with 3 bullets
  and the `3 madde` pill, `Claude ile çevrildi ve özetlendi · 09:41`, `Kaynağa git`;
- segment: `Orijinal` swapped body to the English text and the label to
  `Orijinal · English`;
- bookmark: filled/unfilled, toast `Kayıt kaldırıldı` rendered above the CTA;
- saved: `2 kayıt · 2 okunmadı`, unread dots; trash deleted the item, count became
  `1 kayıt · 1 okunmadı`, and the URL stayed `/saved` (no navigation);
- sources: `7 kaynak · 6 aktif`, TechCrunch AI off and dimmed, dashed add row;
- settings: all four sections; `Digest saati` opened the sheet (scrim, 5 slots,
  selected slot larger); picking `09:00` + `Kaydet` closed it and the badge became
  `09:00`;
- digest: badge followed to `Hazır · 09:00`, all five entries;
- search: `SON ARAMALAR` with the three recent queries, tapping `alphafold` filtered
  live to the DeepMind card, and `alphafoldZZZ` gave `Sonuç bulunamadı`.

Console check is weak evidence and I am labelling it as such: the console reader was
attached after the page had already loaded and returned no messages, so it covers the
interactions above but not page load. Absence of an error signal here is not evidence
of health.

## 8. What I did NOT verify

- **Native.** The app has never run on a device, simulator or emulator, and
  `npx expo start` was never launched. Everything above is a web-bundle observation.
  Per AGENTS.md, `expo export --platform web` proves the bundle compiles and says
  nothing about native behaviour. Specifically unverified on native: the `Modal`
  bottom sheet's animation and back-button handling, safe-area insets on a notched
  device, the tab bar's real height/inset, `react-native-svg` rendering, Inter
  loading through `expo-font` on iOS/Android, and the toast's z-order above a
  presented `Modal`.
- **Visual fidelity to the 390×844 frame.** I inspected in a desktop viewport, so
  line breaks, card proportions and the chip row's horizontal scroll were not judged
  at phone width. Nothing was pixel-compared against the prototype.
- **Accessibility** beyond adding roles/labels: no screen-reader pass, no contrast
  audit, no dynamic-type check.
- **The five `assets/*.png`** are template defaults; I did not check how they look as
  a launcher icon or splash.
- **Android/iOS prebuild** (`/ios`, `/android` are gitignored and were never
  generated), EAS, and anything requiring credentials.
- `npm audit`'s 18 advisories were not investigated; no dependency was changed for
  them.

## 9. Rollback

The repository is unborn and nothing is staged, so rollback is deleting the created
files:

```
git clean -fdx -e design -e agents -e .claude -e .codex -e AGENTS.md -e CLAUDE.md -e .gitignore
```

**I did not run this.** Note it also removes `node_modules/` and `dist/`, and it does
**not** revert `.gitignore` — the appended block under
`# --- Expo app (impl-001) ---` must be removed by hand (the original file was the
single line `/.orchestrator/`).
