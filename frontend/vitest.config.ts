/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'src/wasm/**'],
    css: false,
    // Mock Tauri APIs that are unavailable in test env
    alias: {
      '@tauri-apps/api/core': path.resolve(__dirname, 'src/test/mocks/tauri-core.ts'),
      '@tauri-apps/api/event': path.resolve(__dirname, 'src/test/mocks/tauri-event.ts'),
      '@tauri-apps/api': path.resolve(__dirname, 'src/test/mocks/tauri-api.ts'),
      '@tauri-apps/plugin-clipboard-manager': path.resolve(__dirname, 'src/test/mocks/tauri-clipboard.ts'),
      '@tauri-apps/plugin-dialog': path.resolve(__dirname, 'src/test/mocks/tauri-dialog.ts'),
      '@tauri-apps/plugin-fs': path.resolve(__dirname, 'src/test/mocks/tauri-fs.ts'),
      '@tauri-apps/plugin-process': path.resolve(__dirname, 'src/test/mocks/tauri-process.ts'),
      '@/': path.resolve(__dirname, './src/'),
      'react-i18next': path.resolve(__dirname, './src/vendor/kkterm/shims/react-i18next.ts'),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tauri-apps/api/core': path.resolve(__dirname, 'src/test/mocks/tauri-core.ts'),
      '@tauri-apps/api/event': path.resolve(__dirname, 'src/test/mocks/tauri-event.ts'),
      '@tauri-apps/api': path.resolve(__dirname, 'src/test/mocks/tauri-api.ts'),
      'react-i18next': path.resolve(__dirname, './src/vendor/kkterm/shims/react-i18next.ts'),
    },
  },
})
