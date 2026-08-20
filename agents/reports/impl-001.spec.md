# impl-001 — Implement the AI Gündem prototype as an Expo SDK 54 app (mock data)

**Role:** implementer. Read `agents/implementer.md` and `AGENTS.md` first. You are a
worker, not the orchestrator: do not run graph queries, do not spawn agents, do not
touch `.orchestrator/`, do not update task status.

## Problem
follow-ai has a finished interactive design prototype
(`design/AI Gündem - Prototip.dc.html`) and no application code. Implement the
prototype as an Expo SDK 54 React Native app using the prototype's own mock data, so
later tasks (real RSS, Claude summaries) have a UI to plug into.

## Desired outcome
`npx expo start` shows an app that reproduces every screen and interaction of the
prototype — dark theme only, Turkish strings verbatim.

## Safety class
Low. Local code only. No network calls, no credentials, no deployment.

## Repository / base / worktree
- Repo: `C:\Users\Abdulkadir\OneDrive\follow-ai`, branch `main` — **unborn, no commits**.
- Exact base ref: the empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`.
- Worktree: current (this checkout).
- **Do not** `git commit`, `git add` (except `git add -N` for diffing), push, or add a remote.

## Allowed paths
Files you create for the Expo app under the repo root: `app/`, `src/`, `assets/`,
`package.json`, `package-lock.json`, `tsconfig.json`, `app.json`, `babel.config.js`,
`jest.config.*`, `eas.json` (only if the template creates it), appended lines in
`.gitignore`, plus your report `agents/reports/impl-001.md`.

## Forbidden paths
`AGENTS.md`, `CLAUDE.md`, `agents/**` (except `agents/reports/impl-001.md`),
`.claude/`, `.codex/`, `.orchestrator/`, `design/**` (read-only evidence). Do not
edit existing `.gitignore` lines; append only. If you need anything outside the
allowed paths, send an `escalation` — do not widen scope.

## Spec source
`design/AI Gündem - Prototip.dc.html`. Read **lines 320–404 first**
(`class Component`: initial `state`, `arts()` mock data, `renderVals()` derived
state and handlers). Screens by line: feed 30–62, digest 63–96, saved 97–124,
sources 125–142, settings 143–204, detail 205–237, search 238–284, tab bar 285–293,
digest-time sheet 294–310, toast 311–313. Colours and typography are inline in the
markup. (`design/support.js` is the prototype runtime — you do not need it.)

## Constraints
- Expo **SDK 54**, TypeScript strict, `expo-router`. Five tabs — Feed, Digest,
  Kaydedilen, Kaynaklar, Ayarlar — plus stack routes for detail and search.
  Default tab: feed.
- Mock data = exactly the 5 articles in `arts()` and the 7 sources in `srcMeta`:
  same ids, titles, `sum` bullets, `body` (TR) and `en` bodies, times, categories.
  Initial state as in `state = {...}`: saved `gd`+`hf`, read `oa`, `srcOn.tc=false`
  (others true), `digestTime '08:00'`, `translate true`, filter `'Tümü'`.
- One in-memory store (React context+reducer or zustand — choose and say why). No
  persistence, no network, no Claude API calls.
- Toasts (~2.2 s, same text): `Kaydedildi`, `Kayıt kaldırıldı`, `Kayıt silindi`,
  `Digest saati güncellendi`, `Kaynak tarayıcıda açılır`,
  `Prototipte koyu tema sabit — light tema panoda`.
- Behaviours to match: chip filter (Tümü + 5 categories) combined with source
  toggles filters the feed; empty state when no items ("Bu filtrede haber yok");
  card → detail marks the article read; bookmark toggles save; Orijinal/Çeviri
  segment swaps body and label ("Orijinal · English" / "Çeviri · Türkçe"); saved
  list dims read items (opacity .62) with an unread dot, trash deletes with toast
  and must not also open the detail; sources screen shows "7 kaynak · N aktif";
  settings: translate toggle, digest-time bottom sheet (07:00, 07:30, 08:00, 08:30,
  09:00; Vazgeç discards, Kaydet applies + toast), theme taps only toast;
  search: recent queries `gpt-5.2` / `türkçe llm` / `alphafold`, live
  case-insensitive filtering on title+source+category, clear button, no-results
  state ("Sonuç bulunamadı"); "Kaynağa git" only toasts.
- Dark theme only. Tokens in one file: canvas `#070C16`, app bg `#0B1220`, card
  `#15233B`, tile `#1E3358`, inactive switch `#1B2B47`, input bg `#0E1930`, accent
  `#2563EB`, accent pressed `#1D4FD8`, accent text `#60A5FA`, light accent
  `#93C5FD`, pale chip `#BAE6FD`, text `#E5EAF2`, danger `#E5484D`, borders
  `rgba(37,99,235,.18)` / `rgba(96,165,250,.28)`.
- Font: Inter (via `@expo-google-fonts/inter` + `expo-font`) with system fallback;
  monospace labels use the platform monospace.
- Icons: the prototype's `uploads/ikon1.png` / `ikon3.png` were **not recoverable**
  (truncated on import). Use a placeholder component (rounded square, `#1E3358`
  bg, `#93C5FD` "AG" text) wherever the prototype shows them, and list those spots
  in your report so they can be swapped later.
- Every guard or early return that swallows a state (e.g. unknown article id) must
  `console.warn` — no silent failures.
- Files under 500 lines. No documentation files. Pin versions in `package.json`.
  Use `npx create-expo-app@latest` (state which template and which SDK it
  resolved to — it must be 54; if the template resolves to another SDK, stop and
  escalate rather than downgrading by hand).

## Acceptance criteria (run each; paste the command and its output)
- **A1** `npx tsc --noEmit` exits 0.
- **A2** `npx expo export --platform web` exits 0 and produces `dist/`.
- **A3** `npx jest` exits 0 with store unit tests covering: category filter, source
  toggle filtering, save/unsave, delete-from-saved, mark-read on open, search
  matching (case-insensitive over title/source/category), digest time
  save-vs-cancel, and at least one negative case (unknown article id warns and
  does not throw).
- **A4** `npx expo-doctor` reports no critical issues (paste warnings).
- **A5** All screens/overlays above exist with the prototype's Turkish strings
  (the reviewer will diff strings against the prototype).
- **A6** `git status --porcelain --untracked-files=all` shows nothing under the
  forbidden paths.

## Required evidence — `agents/reports/impl-001.md`
File list (`git add -N . && git diff --stat 4b825dc642cb6eb9a060e54bf8d69288fbee4904`),
each criterion with command + output, decisions made where the prototype was
ambiguous, what you did NOT verify (a native run on device/emulator is expected to
be unverified — say so explicitly), and the rollback.

## Rollback
Repo is unborn: rollback is deleting the created files, e.g.
`git clean -fdx -e design -e agents -e .claude -e .codex -e AGENTS.md -e CLAUDE.md -e .gitignore`
— list it in the report, do not run it.

## Reporting
Long output goes to the report file, not through messages. Send `worker_done` from
your own terminal with `--outcome succeeded` or `failed`,
`--report-path agents/reports/impl-001.md`, `--files-modified` summarised, and a
body of at most 10 lines.
