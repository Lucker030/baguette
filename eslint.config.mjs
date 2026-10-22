import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

// The test suite here runs in the node environment and targets logic, so it
// structurally cannot catch React hook mistakes (missing effect deps, stale
// closures, conditional hooks). That is exactly the class of bug this config
// is here for — react-hooks' rules are the point, the rest is a light net.
export default tseslint.config(
  { ignores: ['out/**', 'release/**', 'node_modules/**', 'tools/node/**', 'build/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Main process + preload: Node globals, no DOM.
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts'],
    languageOptions: { globals: globals.node }
  },

  // Renderer: browser globals plus the hooks rules.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },

  // Tests get both, and may lean on `any` when faking IPC surfaces.
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/renderer/src/test-utils/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' }
  },

  {
    rules: {
      // Deliberate throughout this codebase: `catch {}` with a comment marks a
      // best-effort operation whose failure is genuinely not actionable.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  }
)
