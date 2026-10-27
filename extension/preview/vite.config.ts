// `pnpm preview`: the real popup in a browser tab, with wxt/browser swapped for
// the fake background in fake-browser.ts. Not part of the extension build.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('.'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { 'wxt/browser': here('./fake-browser.ts') } },
  server: { port: 5179, strictPort: true, open: true },
  clearScreen: false,
});
