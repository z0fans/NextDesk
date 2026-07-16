import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // These modules adapt wasm-bindgen, WebCodecs and browser audio APIs whose
    // runtime callback shapes are intentionally more dynamic than the app API.
    files: [
      'src/components/RdpManager.tsx',
      'src/lib/decode-worker.ts',
      'src/lib/rdp-audio.ts',
      'src/lib/rdp-logger.ts',
      'src/rdp/ironrdp-web-engine.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },
  {
    files: ['src/**/*.{test,spec}.{ts,tsx}', 'src/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Shadcn variants and the language context intentionally export helpers
    // beside components; this does not affect production refresh behavior.
    files: [
      'src/components/ui/button.tsx',
      'src/components/ui/badge.tsx',
      'src/i18n/LanguageProvider.tsx',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
