# impl-002 — Fix the two blocking review findings from rev-001 (implementer)

**Role:** implementer. Read `agents/implementer.md`. You are a worker: no graph
queries, no spawning, no `.orchestrator/`, no task-status updates. This is a fix
cycle on your own impl-001 work; the findings come from an independent reviewer
(`agents/reports/rev-001.md`) and verifier (`agents/reports/ver-001.md`). Read
both reports' sections B1, B2 and "A3 required-case map" before editing.

## Repository / base
`C:\Users\Abdulkadir\OneDrive\follow-ai`, branch `main`, still unborn; base = empty
tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`. Do not commit, stage (other than
`git add -N` for a diffstat, then `git reset -q`), push, or add a remote.

## Allowed paths — exactly these four
- `src/store/selectors.ts`
- `src/store/reducer.ts`
- `src/store/__tests__/store.test.ts`
- `agents/reports/impl-002.md` (your report)

Everything else is forbidden. If a fix genuinely needs another file, stop and send
an `escalation` — do not widen.

## Changes

**B1 — search case folding (rev-001 B1, measured).** `src/store/selectors.ts:27-32`
uses `toLocaleLowerCase('tr')` on query and corpus; Turkish casing folds ASCII `I`
to dotless `ı`, so `ai` / `openai` no longer match `OpenAI Blog`. Restore the
prototype's behaviour: plain `toLowerCase()` on both sides (design file lines
362–364). Add selector tests asserting that `openai` returns exactly `['oa']` and
that `ai` includes `oa`. Keep the existing `ALPHAFOLD` / `hugging face` / `türkiye`
tests passing.

**B2 — stale toast guard must warn (rev-001 B2; ver-001 inspection finding).**
`src/store/reducer.ts:128-131` returns unchanged state for a stale `clearToast`
sequence without `console.warn`, violating the brief rule that every swallowed
state warns. Add a `console.warn` naming the stale and current sequence numbers
before returning, and assert that warning in the existing stale-sequence test
(`store.test.ts` ≈210–215), the same way the other negative cases assert theirs.

**Gap — invalid `setFilter` guard untested (ver-001).** `reducer.ts` has a
warn-and-return guard for an unknown category; no test exercises it. Add one
negative test in the existing "negative cases warn" group.

Do not touch anything else: no refactors, no renames, no new files, no N1/N2 work
(those are recorded as debt and need measurement, not code).

## Acceptance (run each, paste command + output)
- **A1** `npx tsc --noEmit` exits 0.
- **A3** `npx jest --verbose` exits 0; test count is 32 + the tests you added
  (state the new total); the three new/changed tests are named in the output.
- **A2** `npx expo export --platform web` exits 0 (selectors changed; re-prove the
  bundle).
- **A6** `git status --porcelain --untracked-files=all` shows nothing outside the
  four allowed paths changed relative to impl-001 (all still `??`, index empty).

## Report — `agents/reports/impl-002.md`
Exact diff of the three source files (`git diff --no-index` against a copy is not
needed — paste the changed hunks), each criterion with output, and rollback (the
three files' previous content is in the current working tree before you edit; say
how to restore — e.g. paste the original hunks).

## Reporting
Send `worker_done` with `--outcome succeeded|failed`, `--report-path
agents/reports/impl-002.md`, `--files-modified` listing the three files, body ≤ 10
lines.
