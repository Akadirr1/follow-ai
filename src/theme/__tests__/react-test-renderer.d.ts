/**
 * Minimal ambient types for `react-test-renderer`, which ships no declarations.
 *
 * Declared locally rather than adding `@types/react-test-renderer`: P8's brief only
 * allows a dependency change for `expo-sqlite`, and this covers exactly the surface
 * `ThemeProvider.test.tsx` uses. Delete it if a typed renderer is adopted later.
 */
declare module 'react-test-renderer' {
  import type { ReactElement } from 'react';

  export type ReactTestRenderer = {
    update(element: ReactElement): void;
    unmount(): void;
    toJSON(): unknown;
  };

  export type TestRendererOptions = {
    createNodeMock?: (element: ReactElement) => unknown;
    onUncaughtError?: (error: unknown) => void;
  };

  export function create(
    element: ReactElement,
    options?: TestRendererOptions,
  ): ReactTestRenderer;

  export function act(callback: () => void | Promise<void>): Promise<void> & { then?: never };

  const TestRenderer: {
    create: typeof create;
    act: typeof act;
  };
  export default TestRenderer;
}
