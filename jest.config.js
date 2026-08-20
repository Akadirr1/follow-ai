/**
 * Two independent suites:
 *  - `store`: the reducer and selectors — pure, no renderer.
 *  - `sql`:   offline static verification of supabase/migrations/** — plain
 *             Node, no database (see supabase/tests/sql-lint.test.ts).
 * They are separate projects so the SQL lint cannot slow or perturb the store
 * suite, and so the SQL lint runs in a plain node environment.
 */
module.exports = {
  projects: [
    {
      displayName: 'store',
      preset: 'jest-expo',
      testMatch: ['**/src/**/__tests__/**/*.test.ts?(x)'],
    },
    {
      displayName: 'sql',
      preset: 'jest-expo',
      testEnvironment: 'node',
      testMatch: ['**/supabase/tests/**/*.test.ts'],
    },
  ],
};
