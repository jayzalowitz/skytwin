import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the web dashboard's browser ESM modules
 * (`public/js/**`). These modules are plain browser ES modules that
 * touch a handful of DOM globals (`document`, `localStorage`, `window`)
 * — `test/setup.ts` installs minimal stubs for the few APIs the pure
 * render/parse helpers use, so we can unit-test them in a Node
 * environment without pulling in a jsdom/happy-dom dependency the rest
 * of this repo doesn't use.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['public/js/**/*.test.{js,ts}'],
    setupFiles: ['./test/setup.ts'],
  },
});
