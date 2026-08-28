import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Vitest 4 dropped the `dist` glob from its built-in `exclude` defaults —
    // v3 shipped it, v4's defaults are only node_modules and .git. 34 packages
    // here compile their `__tests__/` directory into `dist/`, so after the
    // upgrade each of those suites ran TWICE: once from `src/*.test.ts` and
    // once from the stale compiled `dist/*.test.js`.
    //
    // That doubled CI wall time and double-reported every failure while
    // attributing half of them to a build artifact — a large part of why the
    // real assertion failure that took `main` red stayed buried in the log.
    //
    // NOTE: a package-local vitest.config.ts REPLACES this file rather than
    // merging with it, so any package that needs its own config must repeat
    // this exclusion. See the "Build gotcha" section of CLAUDE.md.
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
