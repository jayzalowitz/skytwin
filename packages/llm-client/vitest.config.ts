import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // See the root vitest.config.ts: a package-local config replaces the root
    // one instead of merging, and Vitest 4 no longer excludes dist by default.
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
