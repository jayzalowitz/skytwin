import { defineConfig } from 'vitest/config';

// The dashboard SPA under public/js is plain browser ESM (served statically,
// not TS-compiled). Its unit tests are written to run in a DOM-less node env:
// pure render helpers + storage-injectable wrappers, no jsdom dependency.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['public/js/**/*.test.js'],
    passWithNoTests: true,
  },
});
