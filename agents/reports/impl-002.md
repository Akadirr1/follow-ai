# impl-002 — fix the two blocking findings from rev-001 (implementer)

Role: implementer. Task `task_ecdf16b3650e`, dispatch `ctx_92d3313da7fd`.
Spec: `agents/reports/impl-002.spec.md`. Findings: `agents/reports/rev-001.md` §B1/B2
and `agents/reports/ver-001.md` "A3 required-case map". Outcome: **succeeded**.

- Repo `C:\Users\Abdulkadir\OneDrive\follow-ai`, branch `main`, still unborn.
  Base = empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`.
- Nothing committed, staged (the one `git add -N` for the diffstat was undone with
  `git reset -q`), pushed, or given a remote.
- Three source files changed, all inside the allowed set. No refactors, no renames,
  no new source files, no N1/N2 work.

Both findings are correct as written. B1 is my own error from impl-001: I chose
`toLocaleLowerCase('tr')` deliberately and called it "Turkish-correct" in the
impl-001 report; it silently broke ASCII acronym matching, which the prototype
supports. The reviewer measured it and I reproduced it before editing (§1).

## 0. Diff scope

```
$ git add -N . && git diff --stat 4b825dc642cb6eb9a060e54bf8d69288fbee4904 -- \
    src/store/selectors.ts src/store/reducer.ts src/store/__tests__/store.test.ts
 src/store/__tests__/store.test.ts | 306 ++++++++++++++++++++++++++++++++++++++
 src/store/reducer.ts              | 145 ++++++++++++++++++
 src/store/selectors.ts            |  70 +++++++++
 3 files changed, 521 insertions(+)
$ git reset -q
```

(The base is the empty tree, so every line counts as an insertion; the per-file
hunks against the impl-001 working tree are in §2–§4.) File sizes after the change:
`store.test.ts` 306, `reducer.ts` 145, `selectors.ts` 70 lines — all under 500.

## 1. B1 reproduced before editing

```
$ node -e "..."   # hay = 'OpenAI Blog'
"ai"             tr-locale: false  plain: true
"openai"         tr-locale: false  plain: true
"ALPHAFOLD"      tr-locale: false  plain: false
"hugging face"   tr-locale: false  plain: false
"türkiye"        tr-locale: false  plain: false
folded tr: "openaı blog" | folded plain: "openai blog"
Türkiye tr: "türkiye" | plain: "türkiye"
```

Reading: against the source name `OpenAI Blog`, Turkish folding produces
`openaı blog`, so `ai` and `openai` miss; plain folding matches both. The last line
is the check that mattered for the fix's safety — `Türkiye` folds to the same
`türkiye` under either rule, so the existing category test could not regress.
(`ALPHAFOLD` / `hugging face` are false against this haystack under both rules
because they belong to other articles; they are asserted against theirs in the
suite.)

## 2. `src/store/selectors.ts` — B1

Before:

```ts
/** Live, case-insensitive match over title + source + category. */
export const selectResults = (state: State): Article[] => {
  const q = state.q.trim().toLocaleLowerCase('tr');
  if (!q) return [];
  return ARTICLES.filter((a) =>
    `${a.title} ${a.src} ${a.cat}`.toLocaleLowerCase('tr').includes(q),
  );
};
```

After:

```ts
/**
 * Live, case-insensitive match over title + source + category.
 *
 * Plain `toLowerCase()` on both sides, as the prototype does
 * (`design/AI Gündem - Prototip.dc.html:362-364`). Turkish-locale folding is wrong
 * here: it maps ASCII `I` to dotless `ı`, so `OpenAI Blog` becomes `openaı blog`
 * and the queries `ai` / `openai` stop matching it (rev-001 B1).
 */
export const selectResults = (state: State): Article[] => {
  const q = state.q.trim().toLowerCase();
  if (!q) return [];
  return ARTICLES.filter((a) =>
    `${a.title} ${a.src} ${a.cat}`.toLowerCase().includes(q),
  );
};
```

Behaviour is now identical to the prototype's `renderVals()` matcher. The comment
records why, so the next reader does not re-introduce locale folding as an
"improvement" — which is exactly how the bug arrived.

## 3. `src/store/reducer.ts` — B2

Before:

```ts
    case 'clearToast': {
      if (action.seq !== state.toastSeq) {
        // A newer toast replaced this one; its own timer owns the dismissal.
        return state;
      }
      return { ...state, toast: '' };
    }
```

After:

```ts
    case 'clearToast': {
      if (action.seq !== state.toastSeq) {
        // A newer toast replaced this one; its own timer owns the dismissal.
        console.warn(
          `[store] clearToast ignored: stale sequence ${action.seq}, current ${state.toastSeq}`,
        );
        return state;
      }
      return { ...state, toast: '' };
    }
```

This was the only swallowed transition in the reducer without a warning; it now
matches the other six guards (`setFilter`, `toggleSource`, `openArticle`,
`toggleSave`, `deleteSaved`, `pickTime`) and satisfies impl-001.spec.md:81-82.
The non-stale branch still clears without warning — asserted below.

## 4. `src/store/__tests__/store.test.ts` — three tests

**B1, in `describe('search matching')`, after the source-name test:**

```ts
  // rev-001 B1: Turkish-locale folding turned "OpenAI Blog" into "openaı blog",
  // so these two lowercase ASCII queries missed the article entirely.
  it('matches an ASCII acronym source name: openai returns exactly oa', () => {
    expect(ids(selectResults(run({ type: 'setQuery', q: 'openai' })))).toEqual(['oa']);
  });

  it('matches the bare query ai, which must include oa', () => {
    expect(ids(selectResults(run({ type: 'setQuery', q: 'ai' })))).toContain('oa');
  });
```

`openai` is asserted as an exact list (`['oa']`); `ai` uses `toContain` because it
is a substring of other article text, and pinning the full list would make the test
fail on unrelated copy edits rather than on the behaviour it guards.

**B2, replacing the stale-sequence test body in `describe('toasts')`:**

```ts
  it('only clears the toast the timer was started for, and warns when it swallows a stale one', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = run({ type: 'toast', text: TOASTS.saved });
      const second = reducer(first, { type: 'toast', text: TOASTS.deleted });
      const stale = reducer(second, { type: 'clearToast', seq: first.toastSeq });
      expect(stale.toast).toBe(TOASTS.deleted);
      // rev-001 B2: the swallowed transition must be visible in diagnostics.
      expect(warn).toHaveBeenCalledWith(
        `[store] clearToast ignored: stale sequence ${first.toastSeq}, current ${second.toastSeq}`,
      );

      warn.mockClear();
      expect(reducer(second, { type: 'clearToast', seq: second.toastSeq }).toast).toBe('');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
```

The spy is local to the test (this group has no `beforeEach` spy, unlike the
negative-case group) and restored in `finally`, so a failed expectation cannot leak
a mocked `console.warn` into later tests. The exact warning text is asserted, and
the `not.toHaveBeenCalled()` half pins that the *valid* dismissal stays silent — a
warn-on-every-clear implementation would fail this test.

**ver-001 gap, in `describe('negative cases warn instead of failing silently')`:**

```ts
  // ver-001: this guard existed but nothing exercised it. The cast is deliberate —
  // TypeScript rejects an unknown category, so only an untyped caller (a bad deep
  // link, JS interop) can reach the guard at runtime.
  it('setFilter with an unknown category warns and keeps the current filter', () => {
    const next = reducer(initialState, {
      type: 'setFilter',
      filter: 'Bilim',
    } as unknown as Action);
    expect(next).toBe(initialState);
    expect(next.filter).toBe('Tümü');
    expect(warn).toHaveBeenCalledWith(
      '[store] setFilter ignored: unknown category "Bilim"',
    );
  });
```

It uses the group's existing `warn` spy, asserts state identity (`toBe`), the
unchanged filter value, and the exact warning — the same shape as its five siblings.

## 5. Mutation check — the new tests can actually fail

A test that cannot fail is not evidence, so I re-introduced both defects (copies of
the fixed files were kept in the session scratchpad), ran the suite, and restored:

```
$ # selectors.ts back to toLocaleLowerCase('tr'); clearToast warn removed
$ npx jest --verbose
    × matches an ASCII acronym source name: openai returns exactly oa (2 ms)
    × matches the bare query ai, which must include oa (1 ms)
    × only clears the toast the timer was started for, and warns when it swallows a stale one (1 ms)
    √ setFilter with an unknown category warns and keeps the current filter
Tests:       3 failed, 32 passed, 35 total
```

Both B1 tests and the B2 test fail against the pre-fix code and pass against the
fix. The `setFilter` test passes in both runs — correctly so: it closes a coverage
gap in an already-correct guard, it is not a regression test. Files were restored
from the scratchpad copies and the suite re-run green before any acceptance run
below.

## 6. Acceptance

### A1 — `npx tsc --noEmit` exits 0

```
$ npx tsc --noEmit
A1 exit=0
```
(no output)

### A3 — `npx jest --verbose` exits 0, 35 tests

Total is **35** = the 32 from impl-001 + 3 added. Full verbose output; the three
new/changed tests are marked ►.

```
$ npx jest --verbose
PASS src/store/__tests__/store.test.ts
  initial state
    √ matches the prototype (2 ms)
  category filter
    √ Tümü shows every article whose source is on (1 ms)
    √ narrows the feed to the picked category
    √ leaves the feed empty when nothing matches
  source toggles
    √ removes the source's article from the feed and updates the active count (1 ms)
    √ combines with the category chip
    √ turning a source back on restores it
  save and unsave
    √ saves with the Kaydedildi toast (1 ms)
    √ unsaves with the Kayıt kaldırıldı toast
  delete from saved
    √ drops the article and toasts Kayıt silindi
    √ counts unread saved items
  mark read on open
    √ marks the article read when opened from the feed or saved list
    √ does not mark read when opened from search, as in the prototype
    √ resets the body segment back to Çeviri on every open (1 ms)
  search matching
    √ is empty until something is typed
    √ matches on title, case-insensitively
    √ matches on source name
►   √ matches an ASCII acronym source name: openai returns exactly oa
►   √ matches the bare query ai, which must include oa (1 ms)
    √ matches on category
    √ returns nothing for an unmatched query
    √ clears back to the recent-queries state
  digest time sheet
    √ Kaydet commits the pending pick and toasts (1 ms)
    √ Vazgeç discards the pending pick
    √ reopening reseeds the pending pick from the committed value
  translate toggle
    √ flips the setting
  toasts
    √ carries the prototype copy for source and theme taps
►   √ only clears the toast the timer was started for, and warns when it swallows a stale one (1 ms)
  negative cases warn instead of failing silently
    √ openArticle with an unknown id warns and does not throw or change state (1 ms)
    √ toggleSave with an unknown id warns and leaves the saved set alone
    √ deleteSaved for an article that is not saved warns
    √ toggleSource with an unknown key warns (1 ms)
►   √ setFilter with an unknown category warns and keeps the current filter
    √ pickTime outside the offered slots warns
    √ selectArticle warns and falls back for an unknown id

Test Suites: 1 passed, 1 total
Tests:       35 passed, 35 total
Snapshots:   0 total
Time:        1.111 s, estimated 3 s
Ran all test suites.
A3 jest exit=0
```

(► added by me for this report; jest prints no such marker.)

### A2 — `npx expo export --platform web` exits 0

```
$ rm -rf dist && npx expo export --platform web
/(tabs)/sources (20.7 kB)
/(tabs)/settings (20.7 kB)

Exported: dist
A2 export exit=0
```
Same 14 static routes as impl-001; `dist/` regenerated and gitignored.

### A6 — nothing outside the four allowed paths changed

```
$ git status --porcelain --untracked-files=all | awk '{print $1}' | sort | uniq -c
     95 ??
$ git ls-files --stage | wc -l
0
```

Everything is `??` and the index is provably empty (the `git add -N` from §0 was
undone with `git reset -q`). The count becomes 96 once this report file exists.
Two things the coordinator should read carefully:

1. **The count rose from 58 (impl-001) to 95, and none of the 37 new entries are
   mine.** They are `graphify-out/**` (33 files) plus `agents/reports/rev-001.md`,
   `rev-001.pack.md`, `ver-001.md`, `ver-001.spec.md`, `impl-002.spec.md`. Measured
   by mtime, all predate this dispatch:

   ```
   2026-08-21 00:05:08  graphify-out/manifest.json
   2026-08-21 00:19:32  agents/reports/rev-001.md
   2026-08-21 00:20:26  agents/reports/ver-001.md
   2026-08-21 00:21:07  agents/reports/impl-002.spec.md   ← my brief, dispatch start
   2026-08-21 00:22:42  src/store/__tests__/store.test.ts ← mine
   2026-08-21 00:23:21  src/store/selectors.ts            ← mine
   2026-08-21 00:23:21  src/store/reducer.ts              ← mine
   ```

2. **Positive check that only the allowed files were touched.** Every file under
   `app/`, `src/`, `agents/`, `assets/` and the repo root modified after the
   dispatch began:

   ```
   $ for d in app src agents assets; do find "$d" -newermt "2026-08-21 00:21:30" -type f; done
   src/store/reducer.ts
   src/store/selectors.ts
   src/store/__tests__/store.test.ts
   $ find . -maxdepth 1 -newermt "2026-08-21 00:21:30" -type f
   (nothing)
   ```

   Exactly the three allowed source files, plus this report written afterwards.
   `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/`, `.orchestrator/`, `design/**`,
   `package.json`, `app/**` and the rest of `src/**` are untouched.

## 7. Rollback

Revert the three hunks — the "Before" blocks in §2 and §3 are the exact previous
content, and the three test additions in §4 are removed wholesale (for B2, restore
the five-line body quoted in §4's "replacing" note, i.e. the version without the
spy). Concretely:

1. `src/store/selectors.ts`: replace the `selectResults` block with the "Before"
   block in §2 (drops the doc comment, restores `toLocaleLowerCase('tr')`).
2. `src/store/reducer.ts`: delete the three-line `console.warn(...)` call added in
   the `clearToast` stale branch (§3 "Before" is the exact prior text).
3. `src/store/__tests__/store.test.ts`: delete the two search tests and the
   `setFilter` test, and restore the stale-toast test to its unspied five-line form.

Then `npx jest` returns to 32 passing. Nothing else needs undoing: no dependency,
config, asset or generated file changed in this task. `dist/` was regenerated by
A2 and is gitignored; deleting it is optional.

## 8. What I did NOT verify

- **Nothing native, and nothing rendered.** No device, emulator, or `expo start`;
  no component, hook, or router test exists or was added (ver-001's "no component,
  hook, route, or render path is executed by any test" still stands). The search
  fix is verified at the selector level only — that a user typing `ai` in
  `app/search.tsx` now sees the OpenAI card is inference from `selectResults`
  being that screen's only filter, not a measurement.
- **The toast timer itself.** B2 fixes the reducer's diagnostics; the 2.2 s
  `StoreProvider` effect and its restart-on-replacement (ver-001 N2) are still
  unexecuted by tests.
- **Non-ASCII case folding generally.** The fix restores prototype parity, which
  means Turkish `I/İ/ı/i` queries fold by the ECMAScript default, not by Turkish
  rules — e.g. a query typed as `İLAÇ` folds to `i̇laç` and will not match `ilaç`.
  rev-001 B1 explicitly says a broader multilingual policy must be specified and
  tested separately; I did not do that here and no test asserts it either way.
  This is unchanged prototype behaviour, not a new defect, but it is a real limit.
- **N1 (duplicate detail routes) and N2 (toast timing)** were out of scope by the
  brief and were not touched or measured.
- The forbidden-path files' *contents* are unverified against a pre-implementation
  snapshot; as ver-001 noted, with no HEAD there is nothing to diff against. My
  evidence is the mtime scan in §6, which shows they were not written during this
  dispatch.
