import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'

// Read version from Cargo.toml at build time
const cargoToml = fs.readFileSync(path.resolve(__dirname, '../src-tauri/Cargo.toml'), 'utf-8');
const versionMatch = cargoToml.match(/^version\s*=\s*"(.+)"/m);
const appVersion = versionMatch ? versionMatch[1] : '0.0.0';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'react-i18next': path.resolve(__dirname, './src/vendor/kkterm/shims/react-i18next.ts'),
    },
  },
})
