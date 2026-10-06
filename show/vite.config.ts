import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The console. server.js runs this in middleware mode, so `npm start` serves
// it with no build step and edits reload live.
export default defineConfig({
  root: here('./web'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': here('./web/src'),
      '@engine': here('./lib'),
    },
  },
  server: { fs: { allow: [here('.')] } },
  build: { outDir: here('./web/dist'), emptyOutDir: true },
});
