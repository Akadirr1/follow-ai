/**
 * Two independent suites:
 *
 *  - `store`: the app's reducer, selectors and data-access seam. Runs under the
 *    `jest-expo` preset, which installs the React Native environment.
 *
 *  - `sql`: everything under `supabase/` — the migration lint and the Edge
 *    Function `_shared` modules. Runs on PLAIN NODE, deliberately NOT under
 *    `jest-expo`.
 *
 *    That is not a style preference. The `jest-expo` preset replaces `URL` and
 *    `TextDecoder` with React Native's polyfills, which do not lowercase hosts
 *    and support only UTF-8. The Edge Functions run on Deno, whose Web APIs
 *    behave like Node's, so testing them under the RN polyfills produced
 *    confident passes for behaviour the real runtime does not have — and
 *    confident failures for behaviour it does. `testEnvironment: 'node'` alone
 *    is not enough; the preset's setup files install the polyfills regardless.
 */
const babelTransform = [
  'babel-jest',
  { presets: ['babel-preset-expo'], caller: { name: 'node', platform: 'node' } },
];

module.exports = {
  projects: [
    {
      displayName: 'store',
      preset: 'jest-expo',
      testMatch: ['**/src/**/__tests__/**/*.test.ts?(x)'],
    },
    {
      displayName: 'sql',
      testEnvironment: 'node',
      testMatch: ['**/supabase/tests/**/*.test.ts'],
      transform: { '^.+\\.[jt]sx?$': babelTransform },
    },
  ],
};
