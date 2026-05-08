import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Alias 'electron' to our stub so tests that import tray.ts do not
    // crash on nativeImage.createFromDataURL (which only exists inside a
    // real Electron process). headless.ts has no Electron imports and does
    // not need this alias.
    alias: {
      electron: new URL('./src/__mocks__/electron.ts', import.meta.url).pathname,
    },
  },
});
