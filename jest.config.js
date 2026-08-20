/** Store unit tests only — no renderer, the reducer and selectors are pure. */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/src/**/__tests__/**/*.test.ts?(x)'],
};
