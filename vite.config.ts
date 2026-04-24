import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export const localBackendProxyPatterns = {
  api: '^/api(?:/|$)',
  ws: '^/ws(?:/|$)'
} as const;

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  server: {
    port: 5173,
    proxy: {
      [localBackendProxyPatterns.api]: {
        target: 'http://127.0.0.1:4318',
        changeOrigin: false
      },
      [localBackendProxyPatterns.ws]: {
        target: 'ws://127.0.0.1:4318',
        ws: true,
        changeOrigin: false
      }
    }
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true
  }
});
