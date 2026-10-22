import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Kept separate from electron.vite.config.ts: that config is consumed by
// electron-vite's three-target build (main/preload/renderer) and has no notion
// of a test runner.
//
// Every test runs in the `node` environment — including renderer tests, which
// pull in DOM globals by importing src/renderer/src/test-utils/jsdom-env.ts.
// Vitest's own `jsdom` environment cannot be used here: it switches the module
// pipeline to the web transform, whose URL-shaped ids break against this
// project's deliberate 8.3 short-path root (see that file's comment and
// tools/README.md for the CJK background).
const root = process.cwd()

export default defineConfig({
  resolve: {
    // Same CJK short-path reason as electron.vite.config.ts — don't realpath
    // ids back into the long non-ASCII profile path, which Node cannot load
    // here (see tools/README.md).
    preserveSymlinks: true,
    alias: {
      '@renderer': resolve(root, 'src/renderer/src'),
      '@shared': resolve(root, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    restoreMocks: true
  }
})
