import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    passWithNoTests: true,
    // A package-local config REPLACES the root vitest.config.ts rather than
    // merging with it, so the dist exclusion has to be repeated here. Current
    // Vitest defaults do not exclude `dist`, which otherwise makes this package
    // run every suite twice — once from src/, once from the stale compiled copy
    // in dist/. See the root vitest.config.ts for the full note.
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
