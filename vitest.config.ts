import { configDefaults, defineConfig } from 'vitest/config';

// Vitest 4 removed the `dist` glob from its built-in `exclude` defaults —
// v3 and earlier shipped it, and v4's defaults are only node_modules + .git.
// Several packages here compile their `__tests__/` directory into `dist/`,
// so after the upgrade every such suite ran TWICE: once from the
// `src/*.test.ts` source and once from the stale compiled `dist/*.test.js`.
//
// That doubled CI wall time and, worse, double-reported every failure while
// attributing half of them to a build artifact — which is part of why the
// real assertion failure that took `main` red stayed buried in the log.
// Re-add the exclusion explicitly.
const EXCLUDE_COMPILED_TEST_COPIES = '**/dist/**';

export default defineConfig({
  test: {
    passWithNoTests: true,
    exclude: [...configDefaults.exclude, EXCLUDE_COMPILED_TEST_COPIES],
  },
});
