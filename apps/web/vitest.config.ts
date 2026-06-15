import { defineConfig } from 'vitest/config';

/**
 * Two test families share this package:
 *  - `public/js/**` — the dashboard's browser ESM modules. Written for a Node
 *    env + the minimal DOM stubs in `test/setup.ts` (#499/#511).
 *  - `src/**` — accessibility tests (#402) that mount markup into a real DOM
 *    (jsdom) before handing it to axe-core.
 * `environmentMatchGlobs` gives each family the environment it was written for,
 * so neither breaks the other. `passWithNoTests` keeps the script green if a
 * family is ever moved out.
 */
export default defineConfig({
  test: {
    environmentMatchGlobs: [
      ['public/js/**', 'node'],
      ['src/**', 'jsdom'],
    ],
    include: ['public/js/**/*.test.{js,ts}', 'src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    passWithNoTests: true,
  },
});
