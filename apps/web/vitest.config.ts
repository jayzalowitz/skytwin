import { defineConfig } from 'vitest/config';

/**
 * Two test families share this package:
 *  - `public/js/**` — the dashboard's browser ESM modules. Written for a Node
 *    env + the minimal DOM stubs in `test/setup.ts` (#499/#511).
 *  - `src/**` — accessibility tests (#402) that mount markup into a real DOM
 *    (jsdom) before handing it to axe-core.
 * Vitest 4 removed `environmentMatchGlobs`, so model the split as explicit
 * projects. The root `passWithNoTests` keeps the script green if tests are ever
 * moved out; Vitest 4 intentionally excludes that option from project configs.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'public-js',
          environment: 'node',
          include: ['public/js/**/*.test.{js,ts}'],
          setupFiles: ['./test/setup.ts'],
        },
      },
      {
        test: {
          name: 'a11y',
          environment: 'jsdom',
          include: ['src/**/*.test.ts'],
          setupFiles: ['./test/setup.ts'],
        },
      },
    ],
    passWithNoTests: true,
  },
});
