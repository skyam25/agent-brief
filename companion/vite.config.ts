import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { excalidrawFonts } from './scripts/excalidraw-assets.ts';

const outDir = resolve(import.meta.dirname, 'out/renderer');

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react(), excalidrawFonts(outDir)],
  build: {
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  server: { port: 5199, strictPort: false },
});
