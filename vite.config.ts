import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  build: {
    manifest: 'manifest.json',
    rollupOptions: {
      input: ['/client-entry.tsx'],
    },
  },
});
