# follow-ai — shared agent instructions

<!-- Every agent working in this repository loads this file. Keep only what is
     true for all of them. Role doctrine lives in agents/<role>.md, coordination
     machinery in agents/core.md, launch config in agents/roles.toml. -->

follow-ai is the repository for **AI Gündem**, a Turkish-language mobile app
(Expo SDK 54 / React Native) that aggregates AI news from RSS/URL sources into
a filtered feed, builds a daily digest at a user-chosen hour, lets the user save
articles, and shows each article with a Claude-generated Turkish summary and an
EN→TR translation toggle. Everything known about the product comes from the
Claude Design prototype imported on 2026-08-20 from claude.ai/design project
`0b8a1fad-c720-4c9e-b000-4f4898431d39` ("Mobile app icon design"). As of
2026-08-20 the repository holds no application code; the first implementation
task is the prototype itself with mock data.

## Where truth lives

| Source | Path | Holds |
|---|---|---|
| Design prototype | `design/AI Gündem - Prototip.dc.html` (runtime: `design/support.js`) | screens, interactions, mock content, colours, and the product decisions made so far; the state machine and data live in the `<script data-dc-script>` block at the bottom |
| Worker reports | `agents/reports/<task_id>.md` | evidence produced per task (implementer, reviewer, test-verifier) |
| Coordinator state | `.orchestrator/journal.md` (gitignored) + Orca run/task database | mechanical checkpoints and the coordinator's reasoning at task boundaries |
| Code | repository root (planned Expo app) — **none yet** | the code itself |
| Decisions and rationale | no vault yet — see `agents/orchestrator.md` | — |

Start here: this file, then `design/AI Gündem - Prototip.dc.html` (read the
script block at the end first; the markup follows from it).

## Invariant boundaries

<!-- Only decisions with a traceable source. Nobody may add one from inference. -->

1. **Target is an Expo SDK 54 / React Native mobile app.** Source: the
   prototype's Settings › Hakkında › Sürüm row reads `1.0.0 · Expo SDK 54`; the
   prototype is a 390×844 iOS frame with an iOS status bar. Confirmed by the
   human on 2026-08-21 ("sdk54 kalsın") when `create-expo-app@latest` resolved
   to SDK 57 — do not upgrade without a new decision.
2. **UI language is Turkish; foreign content is auto-translated EN→TR with the
   original one tap away.** Source: every prototype string; Settings › ÇEVİRİ
   "Otomatik çeviri — Yabancı içerik Türkçeye çevrilir"; the detail screen's
   Orijinal / Çeviri segmented control.
3. **Summaries and translations are produced by Claude.** Source: detail card
   footer "Claude ile çevrildi ve özetlendi".
4. ~~v1 ships the dark theme only.~~ **Retired 2026-08-21 by the human**
   ("sınırlandırılmış tema özellikleri … bunlardan kurtulalım"). Light and
   system themes are in scope; the light palette is on the design board
   (`design/AI Gündem - Tasarım Panosu.dc.html`, section "04 — LIGHT TEMA":
   bg `#F4F6FB`, text `#0F1B33`, card `#FFFFFF`, border `#D8E0F0`, soft
   `#E7EEFB`, accent `#2563EB` unchanged). Dark remains the primary theme per
   the board header ("Dark theme birincil").
5. **Backend is Supabase** — the existing project `eglxzbsrewbleqlstefd`
   ("Akadirr1's Project", eu-west-1, Postgres 17). Edge Functions hold the
   Anthropic key and do the Claude calls and RSS fetching; Postgres caches
   articles/summaries; pg_cron builds the morning digest. Source: human decision
   2026-08-21 (chosen over Expo API Routes and Cloudflare Workers).
6. **No login in v1: anonymous device identity** (Supabase anonymous
   sign-in), upgradeable to email/Apple/Google later. Source: human decision
   2026-08-21.
7. **Digest reaches the user by a local scheduled notification** at the chosen
   hour; no server push in v1. Source: human decision 2026-08-21.
8. **The Anthropic API key never ships in the app bundle** (no `EXPO_PUBLIC_`
   prefix); only Supabase's URL and publishable (anon) key are client-side.
   Source: `scripts/setup-env.ps1` header and the human's acceptance of it,
   2026-08-21.
9. **Production v1 scope (all four, human-confirmed 2026-08-21):** real RSS for
   the 7 sources + user-added RSS/URL sources; Claude TR summary (3 bullets) +
   EN→TR translation, produced server-side and cached; light/system theme +
   on-device persistence + offline last feed; daily digest + notification
   permission flow + first-run source-selection onboarding.

Still not decided (do not invent): app-store accounts and release process,
payment/quota limits for Claude usage, analytics/crash reporting.

## Known failure pattern

None recorded yet — nothing has bitten twice. Add it here the first time it
does, concretely enough to be recognised.

**Rule that follows from it:** —

## Measurement discipline

- Do not write a conclusion you have not measured. If it is inference, label it
  "inference".
- Absence of an error signal is not evidence of health.
- State you did not just re-read is not evidence.
- `agents/checkpoint.sh` reports `uncommitted: N` from `git status --porcelain`,
  which collapses untracked directories to one line. Measured 2026-08-20: it
  said 6 while 19 files were untracked. Count with
  `git status --porcelain --untracked-files=all`.
- `checkpoint.sh` prints `open tasks: none` whenever
  `orca orchestration task-list` fails (e.g. no Run bound). That line is not
  evidence that no tasks exist.
- The DesignSync `get_file` call caps at 256 KiB and truncates larger binaries
  silently. Measured 2026-08-20: `uploads/ikon1.png` and `ikon3.png` both came
  back as exactly 196,608 bytes with no `IEND`. The SVG inside their C2PA block
  is the generator's badge, not the app icon.
- `npx expo export --platform web` succeeding proves the bundle compiles; it
  says nothing about native behaviour. Native claims are "not verified" until
  run on a device or emulator.
- `agentkit preflight` is **not read-only on Windows**: when it cannot find a
  codex trust record it appends `[projects."C:\…"]` to `~/.codex/config.toml`,
  which is invalid TOML (the backslash-`U` reads as a unicode escape) and makes
  codex refuse to start machine-wide. Measured 2026-08-21 00:09; fixed by
  deleting the section (a correct single-quoted entry already existed). Codex
  under Orca reads `%APPDATA%\orca\codex-runtime-home\home\config.toml`, which
  Orca syncs from `~/.codex/config.toml`; preflight only inspects the latter,
  so "trust state unknown for codex" is a false alarm here.
- A `worker-start` that fails at `agent_readiness` with an empty pane read is
  not diagnosable from Orca; build the pane by hand with `terminal split
  --command` and read the CLI's own error (that is how the TOML defect was
  found).
- `worker-release` reports `releaseState: retained` on this machine and leaves
  the pane open; treat retained panes as settled and idle, not as live workers.

## Practical traps

```bash
# main is unborn until the first commit: `git rev-parse HEAD` fails.
# Diff the working tree against the empty tree instead:
git add -N . && git diff --stat 4b825dc642cb6eb9a060e54bf8d69288fbee4904

# agentkit is not on PATH on this machine
../agentic-kit/bin/agentkit doctor

# Orca task commands need a bound Run first
orca orchestration run-list --json
```

## Authority

Stop and ask when the next step needs credentials (an Anthropic API key, Expo/EAS
or app-store accounts), a policy change, deployment, publishing, or anything
irreversible. Staging, committing, and pushing are separate decisions, each
scoped to exactly what a human named. First commit `f5127e3` (2026-08-21) was
human-authorized. Remote `origin` = `git@github.com:Akadirr1/follow-ai.git`
(added 2026-08-21 on the human's instruction). For the production-v1 epic the
human gave a **standing authorization (2026-08-21)** to commit and push to
`main` after each independently verified wave; the coordinator records every
commit in `.orchestrator/journal.md`. Outside that epic, pushes are again
per-request. No Anthropic API key exists yet: the Claude path must degrade to a
"summary pending" state, and live Claude behaviour stays **not verified** until
the human sets the Supabase secret. Secrets live only in `.env` (gitignored), filled with
`npm run setup:env`; never give an API key an `EXPO_PUBLIC_` prefix.
