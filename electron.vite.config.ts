import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// This machine's user profile path contains CJK characters. We launch the
// toolchain with the Windows 8.3 SHORT (ASCII) working directory to dodge the
// Node module-load crash (a long CJK `root` crashes Vite with 0xC0000005), so
// `root` stays short here. But Vite/Rollup by default realpath-canonicalizes
// file ids, which expands the short path back to the long CJK form; a short
// `root` vs a long html id then makes Rollup emit a corrupted "../../.."
// relative name and abort. `resolve.preserveSymlinks: true` (set per-config
// below) skips that realpath step so ids stay short and match `root`.
const root = process.cwd()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: {
      // Keep short (ASCII) ids — do not realpath back to the long CJK path.
      preserveSymlinks: true,
      alias: {
        '@renderer': resolve(root, 'src/renderer/src'),
        '@shared': resolve(root, 'src/shared')
      }
    },
    server: {
      fs: {
        allow: [resolve(root)]
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') }
      }
    }
  }
})
