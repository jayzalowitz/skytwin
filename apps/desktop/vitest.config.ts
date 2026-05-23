import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    // Don't recurse into the packaged .app bundle. `pnpm deploy` ships
    // src/ inside <bundle>/Contents/Resources/embedded/api/src/, and
    // vitest's default discovery would pick up every test file there
    // (without their workspace mocks) and fail the whole suite.
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-electron/**'],
    // Alias 'electron' to our stub so tests that import tray.ts do not
    // crash on nativeImage.createFromDataURL (which only exists inside a
    // real Electron process). headless.ts has no Electron imports and does
    // not need this alias.
    //
    // Use fileURLToPath rather than `new URL(...).pathname` — the latter
    // produces paths like `/C:/Users/...` on Windows, which fail to resolve.
    alias: {
      electron: fileURLToPath(new URL('./src/__mocks__/electron.ts', import.meta.url)),
    },
  },
});
